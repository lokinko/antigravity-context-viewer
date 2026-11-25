'use strict';
/**
 * Antigravity Context Meter CLI (cli.js)
 * 支持命令：check / install / restore / live / watch / stop-watch / status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { findAsarPath, getStateDir } = require('./asar-engine');
const { discoverAntigravityCdp, createCdpClient, parseExplicitPort } = require('./local-api');
const { inspectMacAsarIntegrity } = require('./macos-binary-utils');
const { getProjectVersion } = require('./meter-storage');
const {
  install,
  tryHotInjectDetailed,
  probeLiveHostRuntimeInfo,
  shutdownLiveHostGracefully,
  extractAsarFile,
  getRendererBuildId,
  getHostCoreBuildId,
  getWatchBundleBuildId
} = require('./install');
const { restore, tryHotDispose } = require('./restore');
const { collect } = require('./meter-collector');

const DEFAULT_CDP_PORT = 58321;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function getWatchPidPath(stateDir = null) {
  return path.join(stateDir || getStateDir(), 'watch.pid');
}

function getWatchMetaPath(stateDir = null) {
  return path.join(stateDir || getStateDir(), 'watch.meta.json');
}

function readWatchPid(stateDir = null) {
  try {
    const p = getWatchPidPath(stateDir);
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8').trim();
    const pid = Number(raw);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function stopLiveBridge(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const liveSessionPath = path.join(stateDir, '.live-session.json');
  let stopped = false;
  let pid = null;
  if (fs.existsSync(liveSessionPath)) {
    try {
      const info = JSON.parse(fs.readFileSync(liveSessionPath, 'utf8'));
      pid = info?.pid || null;
      const res = await shutdownLiveHostGracefully(info);
      stopped = Boolean(res?.ok);
    } catch {}
    try { fs.unlinkSync(liveSessionPath); } catch {}
  }
  return { stopped, pid };
}

function resolveAntigravityHostTarget(customPath = null) {
  let asarPath = null;
  try { asarPath = findAsarPath(customPath); } catch {}
  if (!asarPath) return null;
  const resDir = path.dirname(asarPath);
  const appRoot = path.dirname(resDir);
  if (process.platform === 'win32') {
    for (const exe of ['Antigravity.exe', 'Antigravity IDE.exe']) {
      const cand = path.join(appRoot, exe);
      if (fs.existsSync(cand)) return { execPath: cand, asarPath };
    }
  } else if (process.platform === 'darwin') {
    const bundleRoot = path.dirname(path.dirname(resDir));
    const macExe = path.join(bundleRoot, 'Contents', 'MacOS', 'Electron');
    if (fs.existsSync(macExe)) return { execPath: macExe, bundlePath: bundleRoot, asarPath };
  } else {
    const linuxExe = path.join(appRoot, 'antigravity');
    if (fs.existsSync(linuxExe)) return { execPath: linuxExe, asarPath };
  }
  return { execPath: null, asarPath };
}

function isLoopbackPortFree(port) {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

async function pickAvailableCdpPort(preferredPort = null) {
  const explicit = parseExplicitPort(preferredPort);
  if (explicit) return explicit;
  for (const p of [58321, 58322, 58323, 58324, 58325]) {
    if (await isLoopbackPortFree(p)) return p;
  }
  return DEFAULT_CDP_PORT;
}

async function queryLiveWindow(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  try {
    const cdp = await discoverAntigravityCdp(options);
    const pages = Array.isArray(cdp.pages) ? cdp.pages : [];
    const origins = Array.from(new Set(pages.map(p => {
      try { return new URL(p.url).origin; } catch { return null; }
    }).filter(Boolean)));
    if (!pages.length) {
      return { running: true, cdpEnabled: true, pageFound: false, port: cdp.port, origins: [] };
    }
    const client = await createCdpClient(pages[0].webSocketDebuggerUrl, { timeoutMs: 4000 });
    try {
      const snap = await client.evaluateValue(`(() => {
        const m = window.__AGContextMeter || null;
        const live = window.__AGContextMeterLive || null;
        const hasIpc = Boolean(window.contextMeterAPI && typeof window.contextMeterAPI.scan === 'function');
        const routeMatch = (location.pathname + ' ' + location.hash).match(/[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}/i);
        return {
          active: Boolean(m && document.getElementById('ag-context-meter')),
          version: m?.version || null,
          buildId: m?.buildId || null,
          hasIpcBridge: hasIpc,
          liveBridgeAttached: live ? { port: live.port, version: live.version || null } : null,
          route: routeMatch ? routeMatch[0] : null
        };
      })()`, { timeoutMs: 4000 });
      return {
        running: true,
        cdpEnabled: true,
        pageFound: true,
        port: cdp.port,
        origin: origins[0] || null,
        origins,
        active: Boolean(snap?.active),
        version: snap?.version || null,
        buildId: snap?.buildId || null,
        hasIpcBridge: Boolean(snap?.hasIpcBridge),
        liveBridgeAttached: snap?.liveBridgeAttached || null,
        route: snap?.route || null
      };
    } finally {
      client.close();
    }
  } catch (err) {
    return {
      running: false,
      cdpEnabled: false,
      pageFound: false,
      error: err?.message || 'cdp_unavailable',
      stateDir
    };
  }
}

async function ensureLiveBridgeIfNeeded(liveSnapshot = null, options = {}) {
  const probeFn = typeof options._probeLiveHost === 'function' ? options._probeLiveHost : probeLiveHostRuntimeInfo;
  const live = liveSnapshot || await queryLiveWindow(options);
  if (!live.running || !live.pageFound) {
    return { needed: false, ready: false, reason: 'no_running_window', liveInfo: null, previousLiveInfo: null };
  }

  const currentPkgVersion = getProjectVersion('1.0.0');
  const stateDir = options.stateDir || getStateDir();
  const statePath = path.join(stateDir, '.live-session.json');

  let existingInfo = null;
  if (fs.existsSync(statePath)) {
    try { existingInfo = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  }

  const expectedOrigins = Array.isArray(live.origins) && live.origins.length
    ? live.origins
    : (live.origin ? [live.origin] : []);

  if (existingInfo && existingInfo.pid && isPidAlive(existingInfo.pid)) {
    const covered = new Set([...(Array.isArray(existingInfo.origins) ? existingInfo.origins : []), existingInfo.origin].filter(Boolean));
    const coversAll = expectedOrigins.every(o => covered.has(o));
    if (coversAll && existingInfo.version === currentPkgVersion) {
      const probe = await probeFn(existingInfo, expectedOrigins[0]);
      if (probe && probe.ok && probe.backendVersion === currentPkgVersion) {
        return {
          needed: true,
          ready: true,
          reused: true,
          backendSource: 'live-host',
          backendVersion: probe.backendVersion,
          liveInfo: { ...existingInfo, capabilities: probe.capabilities || existingInfo.capabilities },
          previousLiveInfo: null
        };
      }
    }
  }

  fs.mkdirSync(stateDir, { recursive: true });
  const stagingStamp = path.join(stateDir, `.live-session.staging.${process.pid}.${Date.now()}.json`);
  const childEnv = {
    ...process.env,
    ...(options.stateDir ? { AG_METER_STATE_DIR: stateDir } : {}),
    AG_LIVE_STAMP_PATH: stagingStamp,
    ...(expectedOrigins.length ? { AG_LIVE_ORIGINS: JSON.stringify(expectedOrigins) } : {})
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const hostScript = path.join(__dirname, 'live-host.js');
  const child = spawn(process.execPath, [hostScript], {
    cwd: __dirname,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv
  });
  child.unref();

  let newInfo = null;
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    await sleep(150);
    if (!fs.existsSync(stagingStamp)) continue;
    try {
      const cand = JSON.parse(fs.readFileSync(stagingStamp, 'utf8'));
      if (cand && cand.pid && cand.port && cand.token) {
        const probe = await probeFn(cand, cand.origin || expectedOrigins[0]);
        if (probe && probe.ok && probe.backendVersion === currentPkgVersion) {
          newInfo = {
            ...cand,
            version: probe.backendVersion,
            backendSource: 'live-host',
            capabilities: probe.capabilities || cand.capabilities || null,
            origins: probe.origins || cand.origins || expectedOrigins
          };
          break;
        }
      }
    } catch {}
  }
  try { if (fs.existsSync(stagingStamp)) fs.unlinkSync(stagingStamp); } catch {}

  if (!newInfo) {
    if (child.pid) { try { process.kill(child.pid); } catch {} }
    return { needed: true, ready: false, reason: 'live_host_probe_failed', liveInfo: null, previousLiveInfo: existingInfo };
  }

  const tmpMain = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpMain, JSON.stringify(newInfo, null, 2));
  fs.renameSync(tmpMain, statePath);

  return {
    needed: true,
    ready: true,
    reused: false,
    backendSource: 'live-host',
    backendVersion: newInfo.version,
    liveInfo: newInfo,
    previousLiveInfo: (existingInfo && existingInfo.pid && existingInfo.pid !== newInfo.pid) ? existingInfo : null
  };
}

async function launchHostWithCdp(target, port) {
  if (!target?.execPath) throw new Error('未能定位 Antigravity 可执行文件，请手动携带 --remote-debugging-port=' + port + ' 启动客户端。');
  const args = [`--remote-debugging-port=${port}`];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(target.execPath, args, { detached: true, stdio: 'ignore', windowsHide: false, env });
  child.unref();
}

async function cmdCheck(customPath, cdpOptions = {}) {
  let asarPath = null;
  let asarErr = null;
  try { asarPath = findAsarPath(customPath); } catch (e) { asarErr = e.message; }
  const macIntegrity = asarPath ? inspectMacAsarIntegrity(asarPath) : null;
  const live = await queryLiveWindow(cdpOptions);
  const out = {
    nodeVersion: process.version,
    platform: process.platform,
    projectVersion: getProjectVersion('1.0.0'),
    asarPath,
    asarError: asarErr,
    ...(macIntegrity?.isMacAppBundle ? { macAsarIntegrity: macIntegrity } : {}),
    cdpReady: Boolean(live.pageFound),
    cdpPort: live.port || null,
    stateDir: getStateDir()
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

async function cmdStatus(customPath, cdpOptions = {}) {
  const stateDir = getStateDir();
  const manifestPath = path.join(stateDir, 'installation.json');
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  let asarPath = customPath || manifest?.installed || null;
  if (!asarPath) { try { asarPath = findAsarPath(null); } catch {} }

  let asarPatched = false;
  let hostVersion = null;
  if (asarPath && fs.existsSync(asarPath)) {
    try {
      hostVersion = JSON.parse(extractAsarFile(asarPath, 'package.json').toString('utf8')).version || null;
      const utils = extractAsarFile(asarPath, 'dist/utils.js').toString('utf8');
      asarPatched = utils.includes('installContextMeter');
    } catch {}
  }

  const liveWindow = await queryLiveWindow(cdpOptions);
  let sessionSample = null;
  if (liveWindow.pageFound && liveWindow.origin && liveWindow.route) {
    try {
      sessionSample = await collect(liveWindow.origin, liveWindow.route, { force: false });
    } catch {}
  }

  const watchPid = readWatchPid(stateDir);
  const report = {
    projectVersion: getProjectVersion('1.0.0'),
    rendererBuildId: getRendererBuildId(),
    hostCoreBuildId: getHostCoreBuildId(),
    asarPath,
    hostVersion,
    asarPatched,
    watchActive: Boolean(watchPid && isPidAlive(watchPid)),
    watchPid: watchPid && isPidAlive(watchPid) ? watchPid : null,
    liveWindow,
    currentSession: sessionSample ? {
      conversation: sessionSample.conversation,
      model: sessionSample.latest?.model || null,
      used: sessionSample.latest?.used ?? null,
      budget: sessionSample.latest?.budget ?? null,
      percent: sessionSample.latest?.percent != null ? Number(sessionSample.latest.percent.toFixed(1)) : null,
      cacheHitRate: sessionSample.latest?.cacheHitRate ?? null,
      tps: sessionSample.latest?.speed?.displayTps ?? sessionSample.latest?.speed?.tps ?? null,
      ttft: sessionSample.latest?.speed?.ttft ?? null
    } : null
  };
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function runLiveCommand(cdpOptions = {}, customPath = null) {
  let live = await queryLiveWindow(cdpOptions);
  if (!live.pageFound && cdpOptions.relaunch) {
    const target = resolveAntigravityHostTarget(customPath);
    const port = await pickAvailableCdpPort(cdpOptions.port);
    await launchHostWithCdp(target, port);
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      live = await queryLiveWindow({ ...cdpOptions, port });
      if (live.pageFound) break;
    }
  }
  if (!live.pageFound) {
    throw new Error('未检测到开启 CDP 的 Antigravity 窗口。请带 `--remote-debugging-port=58321` 启动客户端，或附加 `--relaunch`。');
  }
  const bridgePrep = await ensureLiveBridgeIfNeeded(live, cdpOptions);
  if (!bridgePrep.ready) {
    throw new Error(`live-host 桥接服务启动失败 (${bridgePrep.reason})`);
  }
  const report = await tryHotInjectDetailed({
    ...cdpOptions,
    source: 'cli-live',
    liveInfo: bridgePrep.liveInfo,
    liveVerified: true,
    preferLiveHost: true
  });
  if (bridgePrep.previousLiveInfo) {
    await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
  }
  console.log(JSON.stringify(report, null, 2));
  return report;
}

async function runWatchDaemon(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });
  const pidPath = getWatchPidPath(stateDir);
  const metaPath = getWatchMetaPath(stateDir);
  const pollIntervalMs = Number(options.pollIntervalMs || 2500);
  const expectedVersion = getProjectVersion('1.0.0');

  const existingPid = readWatchPid(stateDir);
  if (existingPid && existingPid !== process.pid && isPidAlive(existingPid)) {
    try { process.kill(existingPid); await sleep(300); } catch {}
  }

  fs.writeFileSync(pidPath, String(process.pid), 'utf8');
  fs.writeFileSync(metaPath, JSON.stringify({
    pid: process.pid,
    version: expectedVersion,
    bundleBuildId: getWatchBundleBuildId(__dirname),
    startedAt: new Date().toISOString()
  }, null, 2), 'utf8');

  let stopping = false;
  const onStop = () => { stopping = true; };
  process.on('SIGINT', onStop);
  process.on('SIGTERM', onStop);

  let windowEverSeen = false;
  let misses = 0;

  try {
    if (options.relaunch) {
      const checkLive = await queryLiveWindow(options);
      if (!checkLive.pageFound) {
        const target = resolveAntigravityHostTarget(options.customPath);
        const port = await pickAvailableCdpPort(options.port);
        await launchHostWithCdp(target, port);
      }
    }

    while (!stopping) {
      const live = await queryLiveWindow(options);
      if (!live.pageFound) {
        if (windowEverSeen) {
          misses++;
          if (misses >= 6) break;
        }
        await sleep(pollIntervalMs);
        continue;
      }
      windowEverSeen = true;
      misses = 0;

      const needsInject = !live.active || live.version !== expectedVersion || !live.liveBridgeAttached;
      if (needsInject) {
        const bridgePrep = await ensureLiveBridgeIfNeeded(live, options);
        if (bridgePrep.ready) {
          await tryHotInjectDetailed({
            ...options,
            source: 'cli-watch',
            liveInfo: bridgePrep.liveInfo,
            liveVerified: true,
            preferLiveHost: true
          });
          if (bridgePrep.previousLiveInfo) {
            await shutdownLiveHostGracefully(bridgePrep.previousLiveInfo);
          }
        }
      }
      await sleep(pollIntervalMs);
    }
  } finally {
    process.off('SIGINT', onStop);
    process.off('SIGTERM', onStop);
    await stopLiveBridge({ stateDir });
    try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch {}
    try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
  }
}

async function stopWatchDaemon(options = {}) {
  const stateDir = options.stateDir || getStateDir();
  const pidPath = getWatchPidPath(stateDir);
  const metaPath = getWatchMetaPath(stateDir);
  const watchPid = readWatchPid(stateDir);
  let watchStopped = false;
  if (watchPid && isPidAlive(watchPid)) {
    try { process.kill(watchPid); watchStopped = true; } catch {}
  }
  try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch {}
  try { if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath); } catch {}
  const bridge = await stopLiveBridge({ stateDir });
  const res = { ok: true, watchStopped, watchPid: watchPid || null, liveBridgeStopped: bridge.stopped, liveBridgePid: bridge.pid };
  console.log(JSON.stringify(res, null, 2));
  return res;
}

function printUsage() {
  console.log(`Antigravity Context Meter CLI (v${getProjectVersion('1.0.0')})

用法:
  node cli.js check [--path <app.asar>] [--port <cdpPort>]     环境与 CDP 状态预检
  node cli.js install [--path <app.asar>] [--no-hot-inject]  ASAR 持久化注入 + 热生效
  node cli.js restore [--path <app.asar>] [--in-place]       无损还原原始 app.asar
  node cli.js live [--port <cdpPort>] [--relaunch]           CDP 免改盘单次热注入
  node cli.js watch [--port <cdpPort>] [--relaunch]          CDP 免改盘守护自动重挂
  node cli.js stop-watch                                     停止守护与 live-host 服务
  node cli.js status [--path <app.asar>] [--port <cdpPort>]  查看安装与当前会话监控状态`);
}

function parseCliArgs(args = []) {
  const list = Array.isArray(args) ? args : [];
  let command = 'help';
  const flags = { path: null, backup: null, port: null, relaunch: false, noHotInject: false, inPlace: false, force: false, forceMacAsar: false };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('-') && command === 'help') {
      command = a;
    } else if (a === '--path' && list[i + 1]) {
      flags.path = list[++i];
    } else if (a === '--backup' && list[i + 1]) {
      flags.backup = list[++i];
    } else if (a === '--port' && list[i + 1]) {
      flags.port = parseExplicitPort(list[++i]);
    } else if (a === '--relaunch') {
      flags.relaunch = true;
    } else if (a === '--no-hot-inject') {
      flags.noHotInject = true;
    } else if (a === '--in-place') {
      flags.inPlace = true;
    } else if (a === '--force') {
      flags.force = true;
    } else if (a === '--force-mac-asar') {
      flags.forceMacAsar = true;
    } else if (a === '-h' || a === '--help') {
      command = 'help';
    }
  }
  return { command, flags };
}

async function main() {
  const { command, flags } = parseCliArgs(process.argv.slice(2));
  if (command === 'check') {
    await cmdCheck(flags.path, { port: flags.port });
  } else if (command === 'install') {
    const res = await install({
      path: flags.path || undefined,
      backup: flags.backup || undefined,
      noHotInject: flags.noHotInject,
      allowIntegrityOverride: flags.forceMacAsar,
      hotInjectOptions: { port: flags.port }
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (command === 'restore') {
    const res = await restore({
      path: flags.path || undefined,
      inPlace: flags.inPlace,
      force: flags.force,
      allowIntegrityOverride: flags.forceMacAsar
    });
    console.log(JSON.stringify(res, null, 2));
  } else if (command === 'live') {
    await runLiveCommand({ port: flags.port, relaunch: flags.relaunch }, flags.path);
  } else if (command === 'watch') {
    await runWatchDaemon({ port: flags.port, relaunch: flags.relaunch, customPath: flags.path });
  } else if (command === 'stop-watch') {
    await stopWatchDaemon();
  } else if (command === 'status') {
    await cmdStatus(flags.path, { port: flags.port });
  } else {
    printUsage();
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('[Error]', err?.message || err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseCliArgs,
  cmdCheck,
  cmdStatus,
  queryLiveWindow,
  ensureLiveBridgeIfNeeded,
  runLiveCommand,
  runWatchDaemon,
  stopWatchDaemon,
  stopLiveBridge,
  readWatchPid,
  tryHotDispose
};
