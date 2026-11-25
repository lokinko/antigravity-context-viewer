'use strict';
/**
 * Antigravity Context Meter CDP 免改盘本地桥接服务 (live-host.js)
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { connect, normalizeLoopbackOrigin } = require('./local-api');
const { collect, collectTurnState, collectDailyUsage, collectQuotaSummary, getSettings, saveSettings } = require('./meter-collector');
const { getStateDir } = require('./asar-engine');
const { getProjectVersion } = require('./meter-storage');

const PROJECT_VERSION = getProjectVersion('1.0.0');
const MAX_BODY_BYTES = 256 * 1024;
const ALLOWED_ROUTES = ['/runtime-info', '/scan', '/turn-state', '/daily-usage', '/quota', '/get-settings', '/save-settings', '/shutdown'];
const LIVE_HOST_STARTED_AT = Date.now();
const LIVE_CAPABILITIES = { scan: true, turnState: true, dailyUsage: true, quota: true, settings: true };

function timingSafeTokenEqual(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function createLiveRequestHandler({ api, secret, getAllowedOrigins = null, onShutdown = null, startedAt = LIVE_HOST_STARTED_AT }) {
  const resolveAllowedSet = () => {
    const set = new Set();
    const add = (raw) => {
      if (!raw || typeof raw !== 'string') return;
      const norm = normalizeLoopbackOrigin(raw.trim());
      if (norm) set.add(norm);
    };
    if (typeof getAllowedOrigins === 'function') {
      for (const o of (getAllowedOrigins() || [])) add(o);
    }
    if (Array.isArray(api?.origins)) {
      for (const o of api.origins) add(o);
    }
    if (api?.origin) add(api.origin);
    return set;
  };

  return async (req, res) => {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    const reqOrigin = normalizeLoopbackOrigin(rawOrigin) || '';
    const allowedSet = resolveAllowedSet();
    if (!reqOrigin || !allowedSet.has(reqOrigin)) {
      res.writeHead(403);
      res.end();
      return;
    }

    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'POST');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-AG-Context-Token');
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'POST' || !ALLOWED_ROUTES.includes(req.url) || !timingSafeTokenEqual(req.headers['x-ag-context-token'], secret)) {
      res.writeHead(403);
      res.end();
      return;
    }

    let body = '';
    let bodyLength = 0;
    let exceeded = false;
    req.on('data', chunk => {
      bodyLength += chunk.length;
      if (bodyLength > MAX_BODY_BYTES) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '请求体积超出限制' }));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on('end', async () => {
      if (exceeded) return;
      try {
        const parsed = body ? JSON.parse(body) : {};
        const targetOrigin = normalizeLoopbackOrigin(parsed?.origin) || reqOrigin;
        if (!allowedSet.has(targetOrigin)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: '非法请求来源' }));
          return;
        }

        let data;
        if (req.url === '/runtime-info') {
          data = {
            ok: true,
            backendVersion: PROJECT_VERSION,
            backendSource: 'live-host',
            pid: process.pid,
            startedAt,
            origins: Array.from(allowedSet),
            capabilities: { ...LIVE_CAPABILITIES }
          };
        } else if (req.url === '/scan') {
          data = await collect(targetOrigin, parsed.id, { force: parsed.force === true, supersedePrevious: true });
        } else if (req.url === '/turn-state') {
          data = await collectTurnState(targetOrigin, parsed.id);
        } else if (req.url === '/daily-usage') {
          data = await collectDailyUsage(targetOrigin, { force: parsed.force === true });
        } else if (req.url === '/quota') {
          data = await collectQuotaSummary(targetOrigin, { force: parsed.force === true });
        } else if (req.url === '/get-settings') {
          data = getSettings();
        } else if (req.url === '/save-settings') {
          data = saveSettings(parsed.payload || parsed);
        } else if (req.url === '/shutdown') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          if (typeof onShutdown === 'function') setTimeout(onShutdown, 30);
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err?.message || '处理请求失败' }));
      }
    });
  };
}

function isPidAlive(pid) {
  const numPid = Number(pid);
  if (!Number.isInteger(numPid) || numPid <= 0) return false;
  try {
    process.kill(numPid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

async function main() {
  const stateDir = getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const stampFile = process.env.AG_LIVE_STAMP_PATH
    ? path.resolve(process.env.AG_LIVE_STAMP_PATH)
    : path.join(stateDir, '.live-session.json');

  let envOrigins = [];
  if (process.env.AG_LIVE_ORIGINS) {
    try {
      const parsed = JSON.parse(process.env.AG_LIVE_ORIGINS);
      if (Array.isArray(parsed)) {
        envOrigins = parsed.map(o => normalizeLoopbackOrigin(o)).filter(Boolean);
      }
    } catch {}
  }

  let api = null;
  if (envOrigins.length > 0) {
    api = { origin: envOrigins[0], origins: envOrigins };
  } else {
    api = await connect();
  }

  const secret = crypto.randomBytes(32).toString('hex');
  const origins = Array.from(new Set([...(api.origins || []), api.origin, ...envOrigins].filter(Boolean)));
  let server = null;
  let parentWatcher = null;

  const cleanup = () => {
    if (parentWatcher) { clearInterval(parentWatcher); parentWatcher = null; }
    try {
      if (fs.existsSync(stampFile)) {
        const cur = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
        if (cur?.pid === process.pid) fs.unlinkSync(stampFile);
      }
    } catch {}
    if (server) {
      try { server.close(() => process.exit(0)); } catch { process.exit(0); }
      setTimeout(() => process.exit(0), 300).unref();
    } else {
      process.exit(0);
    }
  };

  server = http.createServer(createLiveRequestHandler({
    api,
    secret,
    getAllowedOrigins: () => origins,
    onShutdown: cleanup
  }));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  const info = {
    pid: process.pid,
    port,
    token: secret,
    origin: origins[0],
    origins,
    version: PROJECT_VERSION,
    backendSource: 'live-host',
    capabilities: { ...LIVE_CAPABILITIES },
    startedAt: new Date(LIVE_HOST_STARTED_AT).toISOString()
  };

  const tmpPath = `${stampFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
  fs.renameSync(tmpPath, stampFile);

  const watchPid = Number(process.env.AG_LIVE_HOST_PID || 0);
  if (Number.isInteger(watchPid) && watchPid > 0) {
    parentWatcher = setInterval(() => {
      if (!isPidAlive(watchPid)) cleanup();
    }, 3000);
    parentWatcher.unref();
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[live-host] 启动失败:', err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = {
  PROJECT_VERSION,
  ALLOWED_ROUTES,
  LIVE_CAPABILITIES,
  timingSafeTokenEqual,
  createLiveRequestHandler,
  isPidAlive
};
