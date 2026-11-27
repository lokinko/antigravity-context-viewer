'use strict';
/**
 * Antigravity Context Meter 数据采集器 (meter-collector.js)
 * 专注：通过本机 LanguageServerService RPC 拉取会话上下文、生成速度、TTFT、缓存命中与每日用量。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { getStateDir } = require('./asar-engine');
const { normalizeLoopbackOrigin, resolveOriginCsrfToken } = require('./local-api');
const { safeReadJsonSync, safeWriteJsonSync, getProjectVersion } = require('./meter-storage');
const {
  empty,
  add,
  measure,
  parseTimestampMs,
  analyzeSteps,
  summarize,
  summarizeTurnTiming,
  summarizeSessionSpeed,
  summarizeCacheReadStats,
  summarizeSessionTotals,
  summarizeModelUsage,
  summarizeDailyUsage,
  formatLocalDateKey,
  parseGeneratorCall,
  normalizeExternalUsageRecord,
  extractExternalApiCallsFromSteps,
  parseQuotaSummary,
  isCheckpointNewerThanGenerator,
  buildPostCompactSummary
} = require('./meter-core');

const PROJECT_VERSION = getProjectVersion('1.0.0');
const CONVERSATIONS_CACHE_MAX_ENTRIES = 32;
const TURN_STATE_CACHE_MAX_ENTRIES = 32;
const INCREMENTAL_COLLECT_MAX_ENTRIES = 3;
const CACHE_TTL_MS = 8000;
const QUOTA_TTL_MS = 60000;
const DAILY_SYNC_TTL_MS = 30000;
const LEDGER_WRITE_DEBOUNCE_MS = 400;
const conversations = new Map();
const csrfTokenByOrigin = new Map();
const latestCollectSeqByOrigin = new Map();
const _turnStateGmCountCache = new Map();
const _turnStateCache = new Map();
const _incrementalCollectCache = new Map();
const _extLogCache = new Map();
const _ledgerCache = new Map();
const _ledgerWriteTimers = new Map();
const _ledgerDirtyData = new Map();
const _quotaCache = new Map();
const _lastDailySyncAt = new Map();
let collectSeqCounter = 0;
let collectTaskSeq = 0;

const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: false });
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 20000;

function getOriginScopeKey(origin, options = {}) {
  return options?.originScopeKey ? `${String(options.originScopeKey)}|${origin}` : origin;
}

function setBoundedMap(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function createAbortError() {
  const err = new Error('请求已取消');
  err.name = 'AbortError';
  return err;
}

function sleepWithAbort(ms, signal = null) {
  if (!(ms > 0)) return Promise.resolve();
  if (signal?.aborted) return Promise.reject(createAbortError());
  return new Promise((resolve, reject) => {
    let timer = null;
    const onAbort = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      reject(createAbortError());
    };
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function mapRemoteTransportError(err, isRemote) {
  if (!isRemote || !err) return err;
  const msg = String(err?.message || err || '');
  const m = msg.match(/\b(ERR_PROXY_CONNECTION_FAILED|ERR_SOCKS_CONNECTION_FAILED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_CLOSED|ERR_BLOCKED_BY_CLIENT|ERR_TUNNEL_CONNECTION_FAILED)\b/);
  if (m) {
    return new Error(`SSH 远端连接暂时不可用（${m[1]}），请等待重连后重试`);
  }
  return err;
}

async function readSessionFetchText(res, isRemote) {
  const sizeErrMsg = isRemote ? 'SSH 远端响应过大，扫描中止' : '本地响应过大，扫描中止';
  const rawLen = typeof res.headers?.get === 'function' ? Number(res.headers.get('content-length')) : NaN;
  if (Number.isFinite(rawLen) && rawLen > MAX_RESPONSE_BYTES) {
    try { await res.body?.cancel?.(); } catch {}
    throw new Error(sizeErrMsg);
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
          totalBytes += buf.byteLength;
          if (totalBytes > MAX_RESPONSE_BYTES) {
            try { await reader.cancel(); } catch {}
            throw new Error(sizeErrMsg);
          }
          chunks.push(buf);
        }
      }
    } finally {
      try { reader.releaseLock?.(); } catch {}
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
  const text = typeof res.text === 'function' ? await res.text() : '';
  if (Buffer.byteLength(String(text || ''), 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error(sizeErrMsg);
  }
  return String(text || '');
}

async function requestViaSessionFetch(sessionFetch, url, method, body, token, signal = null, isRemote = false) {
  if (signal?.aborted) throw createAbortError();
  const timeoutCtrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutCtrl.abort();
  }, REQUEST_TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const onExtAbort = () => timeoutCtrl.abort();
  signal?.addEventListener?.('abort', onExtAbort, { once: true });

  try {
    const res = await sessionFetch(url, {
      method: method ? 'POST' : 'GET',
      headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {},
      ...(method ? { body: JSON.stringify(body) } : {}),
      signal: timeoutCtrl.signal,
      redirect: 'manual'
    });
    if (signal?.aborted) throw createAbortError();
    if (!res || typeof res.status !== 'number') {
      throw new Error(isRemote ? 'SSH 远端接口未返回有效响应' : '本机接口未返回有效响应');
    }
    if (res.status !== 200) {
      try { await res.body?.cancel?.(); } catch {}
      throw new Error(`${isRemote ? 'SSH 远端接口' : '本机接口'} HTTP ${res.status}`);
    }
    const text = await readSessionFetchText(res, isRemote);
    if (signal?.aborted) throw createAbortError();
    return method ? JSON.parse(text) : text;
  } catch (err) {
    if (signal?.aborted || (err?.name === 'AbortError' && !timedOut)) {
      throw createAbortError();
    }
    if (timedOut) {
      throw new Error(isRemote ? 'SSH 远端接口读取超时' : '本机接口读取超时');
    }
    throw mapRemoteTransportError(err, isRemote);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onExtAbort);
  }
}

function request(origin, method, body, token, signal = null, options = {}) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  const isRemote = options?.isRemote === true;
  if (isRemote && typeof options?.sessionFetch !== 'function') {
    return Promise.reject(new Error('SSH 远端会话网络通道不可用，请重试或重新连接 SSH'));
  }
  if (typeof options?.sessionFetch === 'function') {
    return requestViaSessionFetch(options.sessionFetch, url, method, body, token, signal, isRemote);
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }
    const isHttps = url.startsWith('https:');
    const transport = isHttps ? https : http;
    const req = transport.request(url, {
      agent: isHttps ? _httpsAgent : _httpAgent,
      rejectUnauthorized: false,
      method: method ? 'POST' : 'GET',
      headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {},
      ...(signal ? { signal } : {})
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('本地响应过大，扫描中止'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (signal?.aborted) {
          reject(createAbortError());
          return;
        }
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode !== 200) {
          reject(new Error(`本机接口 HTTP ${response.statusCode}`));
        } else {
          try {
            resolve(method ? JSON.parse(text) : text);
          } catch (e) {
            reject(e);
          }
        }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error('本机接口读取超时')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body) : undefined);
  });
}

async function resolveCollectCsrfToken(origin, signal = null, options = {}, isSuperseded = null) {
  const isRemote = options?.isRemote === true;
  const readRendererToken = typeof options?.resolveRendererCsrfToken === 'function' ? options.resolveRendererCsrfToken : null;

  if (isRemote && readRendererToken) {
    try {
      const rendererToken = String((await readRendererToken()) || '').trim();
      if (typeof isSuperseded === 'function' && isSuperseded()) return '';
      if (rendererToken) return rendererToken;
    } catch {}
  }

  let token = '';
  let hasConfig = false;
  let htmlFetchErr = null;
  try {
    const html = await request(origin, null, null, null, signal, options);
    if (typeof isSuperseded === 'function' && isSuperseded()) return '';
    const match = String(html || '').match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    if (match) {
      hasConfig = true;
      const parsed = JSON.parse(match[1]);
      token = typeof parsed?.csrfToken === 'string' ? parsed.csrfToken.trim() : '';
    }
  } catch (err) {
    if (err?.name === 'AbortError' || signal?.aborted) throw err;
    htmlFetchErr = err;
  }

  if (!token && isRemote && readRendererToken) {
    const retryMs = Number.isFinite(Number(options?.remoteTokenRetryMs)) ? Math.max(0, Number(options.remoteTokenRetryMs)) : 250;
    if (retryMs > 0) {
      await sleepWithAbort(retryMs, signal);
    }
    if (typeof isSuperseded === 'function' && isSuperseded()) return '';
    try {
      const retryToken = String((await readRendererToken()) || '').trim();
      if (typeof isSuperseded === 'function' && isSuperseded()) return '';
      if (retryToken) return retryToken;
    } catch {}
  }

  const canFallback = !htmlFetchErr || /HTTP 40[13]\b/.test(String(htmlFetchErr.message || ''));
  if (!token && !isRemote && canFallback) {
    try {
      const fallbackToken = resolveOriginCsrfToken(origin, options);
      if (fallbackToken) {
        token = fallbackToken;
        hasConfig = true;
      }
    } catch {}
  }

  if (!token && !isRemote && readRendererToken && canFallback) {
    try {
      const localRendererToken = String((await readRendererToken()) || '').trim();
      if (typeof isSuperseded === 'function' && isSuperseded()) return '';
      if (localRendererToken) {
        token = localRendererToken;
        hasConfig = true;
      }
    } catch {}
  }

  if (!token && htmlFetchErr) throw htmlFetchErr;
  if (!hasConfig) {
    throw new Error(isRemote ? 'SSH 远端连接信息尚未就绪，请稍后重试' : 'Antigravity 本地连接信息尚未就绪，请稍后重试');
  }
  if (!token) {
    throw new Error(isRemote ? 'SSH 远端鉴权信息尚未就绪，请稍后重试' : 'Antigravity 本地鉴权信息尚未就绪，请稍后重试');
  }
  return token;
}

function createOriginCaller(origin, signal = null, options = {}, isSuperseded = null) {
  const scopeKey = getOriginScopeKey(origin, options);
  const isRemote = options?.isRemote === true;
  return async (method, body) => {
    let token = csrfTokenByOrigin.get(scopeKey) || null;
    if (!token) {
      token = await resolveCollectCsrfToken(origin, signal, options, isSuperseded);
      if (typeof isSuperseded === 'function' && isSuperseded()) return null;
      csrfTokenByOrigin.set(scopeKey, token);
    }
    try {
      return await request(origin, method, body, token, signal, options);
    } catch (err) {
      if (err && /HTTP 40[13]/.test(String(err.message || '')) && !signal?.aborted) {
        csrfTokenByOrigin.delete(scopeKey);
        token = await resolveCollectCsrfToken(origin, signal, options, isSuperseded);
        if (typeof isSuperseded === 'function' && isSuperseded()) return null;
        csrfTokenByOrigin.set(scopeKey, token);
        return await request(origin, method, body, token, signal, options);
      }
      if (isRemote && err?.name !== 'AbortError' && !signal?.aborted) {
        csrfTokenByOrigin.delete(scopeKey);
      }
      throw err;
    }
  };
}

function resolveStepDate(stepDates, stepIndex, fallbackDate = null) {
  if (stepIndex !== null && stepIndex !== undefined && Number.isInteger(Number(stepIndex)) && Number(stepIndex) >= 0) {
    const idx = Number(stepIndex);
    if (stepDates instanceof Map) {
      if (stepDates.has(idx)) return stepDates.get(idx);
      for (let i = idx - 1; i >= 0; i--) {
        if (stepDates.has(i)) return stepDates.get(i);
      }
    } else if (Array.isArray(stepDates)) {
      if (stepDates[idx]?.metadata?.createdAt) return stepDates[idx].metadata.createdAt;
      for (let i = Math.min(idx - 1, stepDates.length - 1); i >= 0; i--) {
        if (stepDates[i]?.metadata?.createdAt) return stepDates[i].metadata.createdAt;
      }
    }
  }
  return fallbackDate;
}

async function fetchTrajectoryStepsMeta(call, cascadeId, expectedSteps = 0, fallbackDate = null) {
  const stepDates = new Map();
  const allSteps = [];
  let offset = 0;
  const limit = Number.isFinite(Number(expectedSteps)) && Number(expectedSteps) > 0 ? Number(expectedSteps) : Infinity;
  while (offset < limit) {
    const page = await call('GetCascadeTrajectorySteps', {
      cascadeId,
      stepOffset: offset,
      trajectoryVerbosity: 1
    });
    const list = Array.isArray(page?.steps) ? page.steps : [];
    if (!list.length) break;
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      allSteps.push(s);
      const rawIdx = s?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
      const gIdx = (rawIdx !== undefined && rawIdx !== null && rawIdx !== '' && Number.isInteger(Number(rawIdx)) && Number(rawIdx) >= 0)
        ? Number(rawIdx)
        : (offset + i);
      const ts = s?.metadata?.createdAt || s?.metadata?.internalMetadata?.statusTransitions?.[0]?.timestamp || null;
      if (ts) stepDates.set(gIdx, ts);
    }
    offset += list.length;
    if (limit === Infinity) break;
  }
  const externalCalls = extractExternalApiCallsFromSteps(allSteps, { fallbackDate });
  return { stepDates, externalCalls };
}

function getExternalUsageLogPath(options = {}) {
  const dir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  return path.join(dir, 'external-api-usage.jsonl');
}

function ingestExternalLogChunk(chunkText, prevRemainder, dedupMap, fallbackDate) {
  const combined = (prevRemainder || '') + chunkText;
  const endsWithNewline = combined.endsWith('\n') || combined.endsWith('\r');
  const lines = combined.split(/\r?\n/);
  const remainder = endsWithNewline ? '' : (lines.pop() || '');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const obj = JSON.parse(line);
      const rec = normalizeExternalUsageRecord(obj, { sourceType: 'jsonl', fallbackDate });
      if (rec) dedupMap.set(rec.callId, rec);
    } catch {}
  }
  return remainder;
}

function readExternalUsageLog(options = {}) {
  const logPath = getExternalUsageLogPath(options);
  try {
    let st;
    try {
      st = fs.statSync(logPath);
    } catch {
      _extLogCache.delete(logPath);
      return [];
    }
    const cached = _extLogCache.get(logPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.records;
    }

    if (cached && st.size > cached.offset) {
      const delta = st.size - cached.offset;
      const buf = Buffer.alloc(delta);
      let totalRead = 0;
      const fd = fs.openSync(logPath, 'r');
      try {
        while (totalRead < delta) {
          const n = fs.readSync(fd, buf, totalRead, delta - totalRead, cached.offset + totalRead);
          if (n <= 0) break;
          totalRead += n;
        }
      } finally {
        fs.closeSync(fd);
      }
      const chunkText = buf.subarray(0, totalRead).toString('utf8');
      cached.remainder = ingestExternalLogChunk(chunkText, cached.remainder, cached.dedupMap, options.fallbackDate);
      cached.records = Array.from(cached.dedupMap.values());
      cached.offset = cached.offset + totalRead;
      cached.size = st.size;
      cached.mtimeMs = st.mtimeMs;
      return cached.records;
    }

    const content = fs.readFileSync(logPath, 'utf8');
    if (!content) {
      const emptyEntry = { mtimeMs: st.mtimeMs, size: st.size, offset: st.size, remainder: '', dedupMap: new Map(), records: [] };
      _extLogCache.set(logPath, emptyEntry);
      return emptyEntry.records;
    }
    const dedupMap = new Map();
    const remainder = ingestExternalLogChunk(content, '', dedupMap, options.fallbackDate);
    const records = Array.from(dedupMap.values());
    _extLogCache.set(logPath, { mtimeMs: st.mtimeMs, size: st.size, offset: st.size, remainder, dedupMap, records });
    return records;
  } catch {
    return [];
  }
}

function appendExternalUsageRecord(record, options = {}) {
  const rec = normalizeExternalUsageRecord(record, {
    sourceType: 'jsonl',
    fallbackDate: options.fallbackDate
  });
  if (!rec) {
    return { ok: false, error: '无效的外部用量记录' };
  }
  const logPath = getExternalUsageLogPath(options);
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, JSON.stringify({
      id: rec.callId,
      source: rec.source,
      model: rec.model,
      effort: rec.effort,
      date: rec.dateKey,
      timestamp: rec.timestampMs ? new Date(rec.timestampMs).toISOString() : new Date().toISOString(),
      inputTokens: rec.uncachedInput,
      cacheReadTokens: rec.cacheReadTokens,
      cacheWriteTokens: rec.cacheWriteTokens,
      outputTokens: rec.outputTokens,
      thinkingTokens: rec.thinkingTokens,
      durationSec: rec.durationSec,
      inputIncludesCache: false
    }) + '\n', 'utf8');
    return { ok: true, record: rec, path: logPath };
  } catch (err) {
    return { ok: false, error: err?.message || '写入外部用量日志失败', path: logPath };
  }
}

function resolveLatestAndCalls(gmRows, id, session, options = {}) {
  const steps = Array.isArray(options.steps) ? options.steps : null;
  const fallbackDate = options.fallbackDate || null;
  const calls = [];
  for (let i = 0; i < gmRows.length; i++) {
    const row = gmRows[i];
    const rawIdx = row?.stepIndices?.[0] ?? row?.stepIndex ?? row?.step_index;
    const sIdx = (rawIdx !== undefined && rawIdx !== null && rawIdx !== '' && Number.isInteger(Number(rawIdx)) && Number(rawIdx) >= 0)
      ? Number(rawIdx)
      : null;
    const stepDate = resolveStepDate(steps, sIdx, fallbackDate);
    const c = parseGeneratorCall(row, id, i, { fallbackDate: stepDate });
    if (c) calls.push(c);
  }

  let latest = null;
  let latestModel = null;
  let latestGeneratorMeta = null;
  const reversed = gmRows.slice().reverse();
  for (const m of reversed) {
    latest = summarize(m);
    if (latest) {
      latestGeneratorMeta = m;
      latestModel = m.chatModel;
      break;
    }
  }

  let referenceLatest = latest ? { ...latest } : null;
  let referenceChatModel = latestModel;
  if (session && session.lastCheckpointIndex >= 0 && reversed.length > 1) {
    for (const m of reversed) {
      if (m === latestGeneratorMeta) continue;
      const cand = summarize(m);
      if (!cand) continue;
      if (referenceLatest && !referenceLatest.budget && cand.budget) referenceLatest.budget = cand.budget;
      if (m.chatModel && !referenceChatModel?.tools?.length && m.chatModel.tools?.length) {
        referenceChatModel = m.chatModel;
      }
      if (referenceLatest?.budget && referenceChatModel?.tools?.length) break;
    }
  }

  return { calls, latest, latestGeneratorMeta, latestModel, referenceLatest, referenceChatModel };
}

async function fetchAllGeneratorMetadata(call, cascadeId, totalExpected, initialRows = [], isSuperseded = null) {
  const rows = Array.isArray(initialRows) ? initialRows.slice() : [];
  if (totalExpected <= 0 && rows.length === 0) return rows;
  while (rows.length < totalExpected) {
    if (typeof isSuperseded === 'function' && isSuperseded()) return null;
    const prevLen = rows.length;
    const page = await call('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId,
      generatorMetadataOffset: prevLen,
      includeMessages: false
    });
    const batch = Array.isArray(page?.generatorMetadata) ? page.generatorMetadata : [];
    if (!batch.length) break;
    rows.push(...batch);
    if (rows.length <= prevLen) break;
  }
  return rows;
}

function getLedgerPath(options = {}) {
  const dir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  return path.join(dir, 'usage-ledger.json');
}

function shouldSkipAutoLedgerWrite(options = {}) {
  if (options.stateDir || process.env.AG_METER_STATE_DIR) return false;
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test');
}

const LEDGER_VERSION = 3;

function loadLedger(options = {}) {
  const p = getLedgerPath(options);
  const cached = _ledgerCache.get(p);
  if (cached?.dirty && Number(cached.data?.version) >= LEDGER_VERSION) {
    return { path: p, data: cached.data, migrated: false };
  }
  let st = null;
  try { st = fs.statSync(p); } catch {}
  if (st && cached && !cached.dirty && cached.mtimeMs === st.mtimeMs && cached.size === st.size && Number(cached.data?.version) >= LEDGER_VERSION) {
    return { path: p, data: cached.data, migrated: false };
  }
  const emptyLedger = { version: LEDGER_VERSION, syncedTrajectories: {}, calls: {} };
  const res = safeReadJsonSync(p, emptyLedger);
  const data = res?.data && typeof res.data === 'object' ? res.data : emptyLedger;
  if (!Number.isFinite(Number(data.version)) || Number(data.version) < LEDGER_VERSION) {
    return { path: p, data: emptyLedger, migrated: Boolean(res?.exists) };
  }
  if (!data.syncedTrajectories || typeof data.syncedTrajectories !== 'object') data.syncedTrajectories = {};
  if (!data.calls || typeof data.calls !== 'object') data.calls = {};
  _ledgerCache.set(p, { mtimeMs: st?.mtimeMs ?? -1, size: st?.size ?? -1, data, dirty: false });
  return { path: p, data, migrated: false };
}

function flushPendingLedgersSync() {
  for (const timer of _ledgerWriteTimers.values()) {
    try { clearTimeout(timer); } catch {}
  }
  _ledgerWriteTimers.clear();
  for (const [ledgerPath, data] of _ledgerDirtyData.entries()) {
    try {
      const res = safeWriteJsonSync(ledgerPath, data);
      if (res?.ok) {
        let st = null;
        try { st = fs.statSync(ledgerPath); } catch {}
        _ledgerCache.set(ledgerPath, { mtimeMs: st?.mtimeMs ?? -1, size: st?.size ?? -1, data, dirty: false });
      }
    } catch {}
  }
  _ledgerDirtyData.clear();
}

if (typeof process !== 'undefined' && typeof process.once === 'function') {
  process.once('beforeExit', flushPendingLedgersSync);
}

function persistLedger(ledgerPath, data, options = {}) {
  _ledgerCache.set(ledgerPath, { mtimeMs: -1, size: -1, data, dirty: true });
  const isSyncMode = options.syncWrite === true || Boolean(
    process.env.NODE_TEST_CONTEXT || process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test'
  );
  if (isSyncMode) {
    const prevTimer = _ledgerWriteTimers.get(ledgerPath);
    if (prevTimer) {
      try { clearTimeout(prevTimer); } catch {}
      _ledgerWriteTimers.delete(ledgerPath);
    }
    _ledgerDirtyData.delete(ledgerPath);
    const res = safeWriteJsonSync(ledgerPath, data);
    if (res?.ok) {
      let st = null;
      try { st = fs.statSync(ledgerPath); } catch {}
      _ledgerCache.set(ledgerPath, { mtimeMs: st?.mtimeMs ?? -1, size: st?.size ?? -1, data, dirty: false });
    }
    return;
  }

  _ledgerDirtyData.set(ledgerPath, data);
  const prevTimer = _ledgerWriteTimers.get(ledgerPath);
  if (prevTimer) {
    try { clearTimeout(prevTimer); } catch {}
  }
  const timer = setTimeout(async () => {
    _ledgerWriteTimers.delete(ledgerPath);
    const targetData = _ledgerDirtyData.get(ledgerPath);
    if (!targetData) return;
    const tmpPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(ledgerPath), { recursive: true });
      await fs.promises.writeFile(tmpPath, JSON.stringify(targetData), 'utf8');
      await fs.promises.rename(tmpPath, ledgerPath);
      if (_ledgerDirtyData.get(ledgerPath) === targetData) {
        _ledgerDirtyData.delete(ledgerPath);
        let st = null;
        try { st = await fs.promises.stat(ledgerPath); } catch {}
        _ledgerCache.set(ledgerPath, { mtimeMs: st?.mtimeMs ?? -1, size: st?.size ?? -1, data: targetData, dirty: false });
      }
    } catch {
      try { await fs.promises.rm(tmpPath, { force: true }); } catch {}
    }
  }, LEDGER_WRITE_DEBOUNCE_MS);
  if (typeof timer.unref === 'function') timer.unref();
  _ledgerWriteTimers.set(ledgerPath, timer);
}

function mergeCallsIntoLedger(ledgerData, calls = [], fallbackDate = null) {
  let changed = false;
  const fallbackKey = formatLocalDateKey(fallbackDate || Date.now());
  for (const c of calls) {
    if (!c || !c.callId) continue;
    const rawIn = Math.max(0, Number(c.inputTokens ?? 0) || 0);
    const cw = Math.max(0, Number(c.cacheWriteTokens ?? 0) || 0);
    const cr = Math.max(0, Number(c.cacheReadTokens ?? 0) || 0);
    const out = Math.max(0, Number(c.outputTokens ?? 0) || 0);
    const think = Math.max(0, Number(c.thinkingTokens ?? 0) || 0);
    const total = rawIn + cw + cr + out;
    if (total <= 0) continue;

    const existing = ledgerData.calls[c.callId];
    if (existing?.sourceType === 'jsonl' && c.sourceType === 'step') {
      continue;
    }
    const date = c.dateKey || existing?.date || fallbackKey;
    const next = {
      date,
      inputTokens: rawIn,
      cacheWriteTokens: cw,
      cacheReadTokens: cr,
      outputTokens: out,
      thinkingTokens: think,
      totalTokens: total,
      model: c.model || existing?.model || ''
    };
    if (c.isExternal || existing?.isExternal) {
      next.isExternal = true;
      next.source = c.source || existing?.source || 'external-api';
      next.sourceType = c.sourceType || existing?.sourceType || 'step';
    }
    if (
      !existing ||
      existing.date !== next.date ||
      existing.inputTokens !== next.inputTokens ||
      existing.cacheWriteTokens !== next.cacheWriteTokens ||
      existing.cacheReadTokens !== next.cacheReadTokens ||
      existing.outputTokens !== next.outputTokens ||
      existing.thinkingTokens !== next.thinkingTokens ||
      existing.model !== next.model ||
      Boolean(existing.isExternal) !== Boolean(next.isExternal) ||
      (existing.source || null) !== (next.source || null) ||
      (existing.sourceType || null) !== (next.sourceType || null)
    ) {
      ledgerData.calls[c.callId] = next;
      changed = true;
    }
  }
  return changed;
}

function recordCallsToLedger(calls = [], options = {}) {
  if (!Array.isArray(calls) || calls.length === 0) return { ok: true, changed: false };
  const { path: ledgerPath, data } = loadLedger(options);
  const changed = mergeCallsIntoLedger(data, calls, options.fallbackDate);
  if (changed) {
    persistLedger(ledgerPath, data, options);
  }
  return { ok: true, changed, path: ledgerPath };
}

async function collectDailyUsage(origin = null, options = {}) {
  const { path: ledgerPath, data: ledger, migrated } = loadLedger(options);
  const safeOrigin = origin ? normalizeLoopbackOrigin(origin) : null;
  const scopeKey = safeOrigin ? getOriginScopeKey(safeOrigin, options) : '';
  const syncKey = `${scopeKey}|${ledgerPath}`;
  const lastSync = _lastDailySyncAt.get(syncKey) || 0;
  const shouldSyncHost = Boolean(safeOrigin && (options.force === true || migrated || Date.now() - lastSync > DAILY_SYNC_TTL_MS));

  let ledgerChanged = Boolean(migrated);
  const jsonlExternalCalls = readExternalUsageLog(options);
  if (jsonlExternalCalls.length > 0 && mergeCallsIntoLedger(ledger, jsonlExternalCalls)) {
    ledgerChanged = true;
  }

  if (shouldSyncHost) {
    try {
      const call = createOriginCaller(safeOrigin, null, options, () => false);
      const all = await call('GetAllCascadeTrajectories', {});
      const summaries = all?.trajectorySummaries && typeof all.trajectorySummaries === 'object'
        ? all.trajectorySummaries
        : {};
      const entries = Object.entries(summaries)
        .filter(([cid]) => /^[a-f\d-]{36}$/i.test(cid))
        .sort((a, b) => (parseTimestampMs(b[1]?.lastModifiedTime || b[1]?.createdTime) || 0) - (parseTimestampMs(a[1]?.lastModifiedTime || a[1]?.createdTime) || 0))
        .slice(0, 50);

      for (const [cid, summary] of entries) {
        const stepCount = Number(summary?.stepCount ?? 0);
        const updatedAt = String(summary?.lastModifiedTime || summary?.createdTime || '');
        const prev = ledger.syncedTrajectories[cid];
        if (prev && prev.stepCount === stepCount && prev.updatedAt === updatedAt && options.force !== true) {
          continue;
        }
        try {
          const gmPage = await call('GetCascadeTrajectoryGeneratorMetadata', {
            cascadeId: cid,
            generatorMetadataOffset: 0,
            includeMessages: false
          });
          let gmRows = Array.isArray(gmPage?.generatorMetadata) ? gmPage.generatorMetadata.slice() : [];
          let totalGm = Number(gmPage?.numTotalGeneratorMetadata ?? gmRows.length);
          if (gmRows.length >= 100 && totalGm <= gmRows.length) {
            const head = await call('GetCascadeTrajectory', { cascadeId: cid, trajectoryVerbosity: 0 });
            totalGm = Number(head?.numTotalGeneratorMetadata ?? gmRows.length);
          }
          if (gmRows.length < totalGm) {
            const allRows = await fetchAllGeneratorMetadata(call, cid, totalGm, gmRows);
            if (allRows) gmRows = allRows;
          }

          const defaultDate = summary?.createdTime || updatedAt || new Date().toISOString();
          let stepDates = null;
          let stepExternalCalls = [];
          if (stepCount > 0) {
            try {
              const meta = await fetchTrajectoryStepsMeta(call, cid, stepCount, defaultDate);
              stepDates = meta.stepDates;
              stepExternalCalls = meta.externalCalls || [];
            } catch {}
          }

          const parsed = [];
          for (let i = 0; i < gmRows.length; i++) {
            const row = gmRows[i];
            const rawIdx = row?.stepIndices?.[0] ?? row?.stepIndex ?? row?.step_index;
            const sIdx = (rawIdx !== undefined && rawIdx !== null && rawIdx !== '' && Number.isInteger(Number(rawIdx)) && Number(rawIdx) >= 0)
              ? Number(rawIdx)
              : null;
            const callFallback = resolveStepDate(stepDates, sIdx, defaultDate);
            const c = parseGeneratorCall(row, cid, i, { fallbackDate: callFallback });
            if (c) parsed.push(c);
          }
          const combinedCalls = stepExternalCalls.length ? [...parsed, ...stepExternalCalls] : parsed;
          if (mergeCallsIntoLedger(ledger, combinedCalls, defaultDate)) ledgerChanged = true;
          ledger.syncedTrajectories[cid] = { stepCount, updatedAt };
          ledgerChanged = true;
        } catch {}
      }

      _lastDailySyncAt.set(syncKey, Date.now());
    } catch {}
  }

  if (ledgerChanged) {
    persistLedger(ledgerPath, ledger, options);
  }

  return {
    ok: true,
    version: PROJECT_VERSION,
    ...summarizeDailyUsage(Object.values(ledger.calls), options),
    syncedAt: Date.now()
  };
}

async function loadTrajectoryStepsAndGm(call, id, inc, force, isSuperseded) {
  if (inc && Array.isArray(inc.rawSteps) && Array.isArray(inc.rawGmRows)) {
    const head = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 0 });
    if (!head || isSuperseded()) return { aborted: true };
    const expSteps = Number(head.numTotalSteps ?? 0);
    const expGm = Number(head.numTotalGeneratorMetadata ?? 0);
    const headMod = head.lastModifiedTime || null;
    const headStatus = head.status || null;
    if (!force && expSteps === inc.rawSteps.length && expGm === inc.rawGmRows.length && headMod === inc.lastModifiedTime && headStatus === inc.cascadeStatus) {
      return { unchangedResult: inc.result };
    }
    if (inc.rawSteps.length > 0 && expSteps >= inc.rawSteps.length && expGm >= inc.rawGmRows.length) {
      const stepStart = Math.max(0, inc.rawSteps.length - 2);
      const gmStart = Math.max(0, inc.rawGmRows.length - 2);
      const tailSteps = [];
      let sCur = stepStart;
      while (sCur < expSteps) {
        if (isSuperseded()) return { aborted: true };
        const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: sCur, trajectoryVerbosity: 3 });
        const batch = Array.isArray(page?.steps) ? page.steps : [];
        if (!batch.length) break;
        tailSteps.push(...batch);
        sCur += batch.length;
      }
      const tailGm = [];
      let gmCur = gmStart;
      while (gmCur < expGm) {
        if (isSuperseded()) return { aborted: true };
        const gp = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: gmCur, includeMessages: false });
        const batch = Array.isArray(gp?.generatorMetadata) ? gp.generatorMetadata : [];
        if (!batch.length) break;
        tailGm.push(...batch);
        gmCur += batch.length;
      }
      if (!isSuperseded() && (stepStart + tailSteps.length) >= expSteps && (gmStart + tailGm.length) >= expGm) {
        return {
          full: head,
          steps: [...inc.rawSteps.slice(0, stepStart), ...tailSteps],
          gmRows: [...inc.rawGmRows.slice(0, gmStart), ...tailGm],
          totalGm: expGm
        };
      }
    }
  }

  const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
  if (!full || isSuperseded()) return { aborted: true };
  const trajectory = full.trajectory;
  if (!trajectory) throw new Error('未取得会话历史，无法统计');

  const steps = Array.isArray(trajectory.steps) ? trajectory.steps.slice() : [];
  const expected = Number(full.numTotalSteps ?? steps.length);
  while (steps.length < expected) {
    if (isSuperseded()) return { aborted: true };
    const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
    if (!page?.steps?.length) break;
    steps.push(...page.steps);
  }
  if (isSuperseded()) return { aborted: true };

  const totalGm = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
  const gmRows = await fetchAllGeneratorMetadata(
    call,
    id,
    totalGm,
    Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [],
    isSuperseded
  );
  if (gmRows === null || isSuperseded()) return { aborted: true };
  return { full, steps, gmRows, totalGm };
}

async function collect(origin, id, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin || !/^[a-f\d-]{36}$/i.test(String(id || ''))) {
    throw new Error('无效本机会话');
  }
  origin = safeOrigin;
  const scopeKey = getOriginScopeKey(origin, options);
  const key = `${scopeKey}/${id}`;
  const supersede = options.supersedePrevious === true;
  const mySeq = supersede ? (++collectSeqCounter) : 0;
  const abortController = supersede ? new AbortController() : null;
  if (supersede) {
    const prevLatest = latestCollectSeqByOrigin.get(scopeKey);
    if (prevLatest && prevLatest.id !== id && prevLatest.abortController) {
      try { prevLatest.abortController.abort(); } catch {}
    }
    latestCollectSeqByOrigin.set(scopeKey, { seq: mySeq, id, abortController });
  }
  const isSuperseded = () => {
    if (!supersede) return false;
    const latest = latestCollectSeqByOrigin.get(scopeKey);
    return Boolean((latest && latest.seq > mySeq && latest.id !== id) || abortController?.signal?.aborted);
  };

  const previous = conversations.get(key);
  if (previous?.pending && !options.force) return previous.pending;
  if (!options.force && previous?.result && Date.now() - previous.at < CACHE_TTL_MS) {
    return previous.result;
  }

  const taskSeq = ++collectTaskSeq;
  const task = (async () => {
    const signal = abortController?.signal || null;
    try {
      const call = createOriginCaller(origin, signal, options, isSuperseded);
      const inc = _incrementalCollectCache.get(key) || null;
      const loaded = await loadTrajectoryStepsAndGm(call, id, inc, options.force === true, isSuperseded);
      if (loaded.aborted || isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };
      if (loaded.unchangedResult) {
        setBoundedMap(conversations, key, { result: loaded.unchangedResult, at: Date.now(), taskSeq }, CONVERSATIONS_CACHE_MAX_ENTRIES);
        return loaded.unchangedResult;
      }

      const { full, steps, gmRows, totalGm } = loaded;
      const trajectory = full.trajectory || {};
      const session = analyzeSteps(steps);
      const title = String(full.title || trajectory.title || full.metadata?.title || trajectory.metadata?.title || session.firstUserTitle || inc?.title || '').trim();
      _turnStateGmCountCache.set(`${scopeKey}|${id.toLowerCase()}`, gmRows.length);

      const fallbackDate = full.lastModifiedTime || full.createdTime || trajectory.metadata?.createdAt || inc?.fallbackDate || new Date().toISOString();
      const resolved = resolveLatestAndCalls(gmRows, id, session, { steps, fallbackDate });
      let latest = resolved.latest;
      const systemSourceModel = resolved.referenceChatModel || resolved.latestModel;
      const system = systemSourceModel
        ? measure((systemSourceModel.promptSections || []).map(p => p.content || '').join('\n') || systemSourceModel.systemPrompt || '')
        : empty();
      const definitions = systemSourceModel ? measure(JSON.stringify(systemSourceModel.tools || [])) : empty();
      session.groups.system = system;
      session.groups.definitions = definitions;
      add(session.total, system);
      add(session.total, definitions);

      const postCompactActiveTotal = session.postCheckpoint
        ? add(add({ ...session.postCheckpoint.textTotal }, system), definitions)
        : null;

      if (!session.currentError && isCheckpointNewerThanGenerator(session, resolved.latestGeneratorMeta, latest)) {
        latest = buildPostCompactSummary({
          session: { ...session, postCompactActiveTotal },
          system,
          definitions,
          previousLatest: resolved.referenceLatest || latest
        });
      }

      if (session.currentError) {
        const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, {
          currentModel: latest?.model || resolved.latestModel?.modelDisplayName || resolved.latestModel?.model || '',
          previousValidContext: latest
        });
        if (fromStep?.error) {
          latest = {
            ...(latest || {}),
            error: fromStep.error,
            errorClassification: fromStep.errorClassification,
            exceeded: fromStep.exceeded,
            network: fromStep.network,
            serviceLimit: fromStep.serviceLimit || latest?.serviceLimit || null,
            status: fromStep.status,
            actual: fromStep.exceeded ? null : (latest?.actual ?? null),
            percent: fromStep.exceeded ? null : (latest?.percent ?? null),
            estimated: latest?.actual == null
          };
        }
      }

      const scannedAt = Date.now();
      const turnTiming = summarizeTurnTiming({
        steps,
        stepOffset: 0,
        generatorMetadata: gmRows,
        cascadeStatus: full.status || null,
        nowMs: scannedAt
      });

      const stepExternalCalls = extractExternalApiCallsFromSteps(steps, { fallbackDate });
      const jsonlById = stepExternalCalls.length
        ? new Map(readExternalUsageLog(options).map(r => [r.callId, r]))
        : null;
      const sessionExternalCalls = stepExternalCalls.map(sc => jsonlById?.get(sc.callId) || sc);
      const allSessionCalls = sessionExternalCalls.length ? [...resolved.calls, ...sessionExternalCalls] : resolved.calls;

      const sessionSpeed = summarizeSessionSpeed(resolved.calls);
      const sessionCache = summarizeCacheReadStats(resolved.calls);
      const sessionTotals = summarizeSessionTotals(allSessionCalls);
      const sessionModels = summarizeModelUsage(allSessionCalls);

      if (!shouldSkipAutoLedgerWrite(options)) {
        try {
          recordCallsToLedger(allSessionCalls, { stateDir: options.stateDir, fallbackDate });
        } catch {}
      }

      const result = {
        version: PROJECT_VERSION,
        conversation: id,
        title,
        cascadeStatus: full.status || null,
        lastModifiedTime: full.lastModifiedTime || null,
        latest,
        sessionSpeed,
        sessionCache,
        sessionTotals,
        sessionModels,
        recentCalls: resolved.calls.slice(-12).reverse(),
        turnTiming,
        generatorCount: totalGm,
        session: {
          groups: session.groups,
          total: session.total,
          steps: session.steps,
          userMessages: session.userMessages,
          assistantMessages: session.assistantMessages,
          checkpointCount: session.checkpointCount,
          postCompactActiveTotal
        },
        scannedAt
      };

      if (isSuperseded()) {
        const cur = conversations.get(key);
        if (!cur || !cur.taskSeq || cur.taskSeq <= taskSeq) conversations.delete(key);
        return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };
      }

      const curDone = conversations.get(key);
      if (!curDone || !curDone.taskSeq || curDone.taskSeq <= taskSeq) {
        setBoundedMap(conversations, key, { result, at: Date.now(), taskSeq }, CONVERSATIONS_CACHE_MAX_ENTRIES);
        setBoundedMap(_incrementalCollectCache, key, {
          rawSteps: steps,
          rawGmRows: gmRows,
          lastModifiedTime: full.lastModifiedTime || null,
          cascadeStatus: full.status || null,
          title,
          fallbackDate,
          result
        }, INCREMENTAL_COLLECT_MAX_ENTRIES);
      }
      return result;
    } catch (err) {
      if (isSuperseded() || (err && err.name === 'AbortError' && signal?.aborted)) {
        return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };
      }
      throw err;
    }
  })();

  setBoundedMap(conversations, key, { ...previous, pending: task, taskSeq }, CONVERSATIONS_CACHE_MAX_ENTRIES);
  try {
    return await task;
  } catch (e) {
    const curErr = conversations.get(key);
    if (!curErr || !curErr.taskSeq || curErr.taskSeq <= taskSeq) conversations.delete(key);
    throw e;
  }
}

async function collectTurnState(origin, id, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin || !/^[a-f\d-]{36}$/i.test(String(id || ''))) {
    throw new Error('无效本机会话');
  }
  origin = safeOrigin;
  const scopeKey = getOriginScopeKey(origin, options);
  const call = createOriginCaller(origin, null, options, () => false);
  const gmCacheKey = `${scopeKey}|${id.toLowerCase()}`;

  let summaryEntry = null;
  try {
    const allSummaries = await call('GetAllCascadeTrajectories', {});
    summaryEntry = allSummaries?.trajectorySummaries?.[id] || allSummaries?.trajectorySummaries?.[id.toLowerCase()] || null;
  } catch {}

  if (summaryEntry && Number.isFinite(Number(summaryEntry.stepCount))) {
    const summaryStatus = summaryEntry.status || null;
    const summarySteps = Math.max(0, Number(summaryEntry.stepCount));
    const summaryUpdatedAt = String(summaryEntry.lastModifiedTime || '');
    const isSummaryRunning = summaryStatus === 'CASCADE_RUN_STATUS_RUNNING';
    const cachedTs = _turnStateCache.get(gmCacheKey);
    if (
      cachedTs &&
      !isSummaryRunning &&
      options.force !== true &&
      cachedTs.cascadeStatus === summaryStatus &&
      cachedTs.stepCount === summarySteps &&
      cachedTs.lastModifiedTime === summaryUpdatedAt
    ) {
      return { ...cachedTs.result, scannedAt: Date.now(), cached: true };
    }
  }

  let cascadeStatus = null;
  let totalSteps = 0;
  let stepOffset = 0;
  let tailSteps = [];
  let tailGm = [];
  let lastModifiedTime = summaryEntry?.lastModifiedTime || null;
  const stepWindow = 80;

  if (summaryEntry && Number.isFinite(Number(summaryEntry.stepCount))) {
    cascadeStatus = summaryEntry.status || null;
    totalSteps = Math.max(0, Number(summaryEntry.stepCount));
    const hintUserStep = Number.isInteger(Number(summaryEntry.lastUserInputStepIndex)) && Number(summaryEntry.lastUserInputStepIndex) >= 0
      ? Number(summaryEntry.lastUserInputStepIndex)
      : null;
    stepOffset = Math.max(0, totalSteps - stepWindow);
    if (hintUserStep !== null && hintUserStep < stepOffset && (totalSteps - hintUserStep) <= 480) {
      stepOffset = hintUserStep;
    }
    const prevGmCount = _turnStateGmCountCache.get(gmCacheKey);
    const gmReqOffset = (Number.isInteger(prevGmCount) && prevGmCount > 30) ? Math.max(0, prevGmCount - 30) : 0;
    const [stepsPage, gmPage] = await Promise.all([
      totalSteps > 0 ? call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset, trajectoryVerbosity: 1 }) : Promise.resolve({ steps: [] }),
      totalSteps > 0 ? call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: gmReqOffset, includeMessages: false }) : Promise.resolve({ generatorMetadata: [] })
    ]);
    tailSteps = Array.isArray(stepsPage?.steps) ? stepsPage.steps : [];
    let fetchedGm = Array.isArray(gmPage?.generatorMetadata) ? gmPage.generatorMetadata : [];
    let effectiveOffset = gmReqOffset;
    const reportedTotalGm = Number(gmPage?.numTotalGeneratorMetadata ?? 0);
    if (reportedTotalGm > effectiveOffset + fetchedGm.length) {
      const targetStart = Math.max(0, reportedTotalGm - 30);
      const resumeOffset = effectiveOffset + fetchedGm.length;
      let curOffset = Math.max(targetStart, resumeOffset);
      const collectedTail = curOffset === resumeOffset ? fetchedGm.slice() : [];
      while (curOffset < reportedTotalGm) {
        const tailPage = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: curOffset, includeMessages: false });
        const batch = Array.isArray(tailPage?.generatorMetadata) ? tailPage.generatorMetadata : [];
        if (!batch.length) break;
        collectedTail.push(...batch);
        curOffset += batch.length;
      }
      if (collectedTail.length > 0) {
        fetchedGm = collectedTail.slice(-30);
        effectiveOffset = Math.max(0, curOffset - fetchedGm.length);
      }
    }
    _turnStateGmCountCache.set(gmCacheKey, effectiveOffset + fetchedGm.length);
    tailGm = fetchedGm.length > 30 ? fetchedGm.slice(-30) : fetchedGm;
  } else {
    const head = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 0 });
    cascadeStatus = head.status || null;
    if (!lastModifiedTime && head.lastModifiedTime) lastModifiedTime = head.lastModifiedTime;
    totalSteps = Number(head.numTotalSteps ?? head.trajectory?.steps?.length ?? 0);
    const totalGm = Number(head.numTotalGeneratorMetadata ?? head.trajectory?.generatorMetadata?.length ?? 0);
    stepOffset = Math.max(0, totalSteps - stepWindow);
    const [stepsPage, gmPage] = await Promise.all([
      totalSteps > 0 ? call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset, trajectoryVerbosity: 1 }) : Promise.resolve({ steps: [] }),
      totalGm > 0 ? call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: Math.max(0, totalGm - 30), includeMessages: false }) : Promise.resolve({ generatorMetadata: [] })
    ]);
    tailSteps = Array.isArray(stepsPage?.steps) ? stepsPage.steps : [];
    tailGm = Array.isArray(gmPage?.generatorMetadata) ? gmPage.generatorMetadata : [];
  }

  const nowMs = Date.now();
  const turnTiming = summarizeTurnTiming({
    steps: tailSteps,
    stepOffset,
    generatorMetadata: tailGm,
    cascadeStatus,
    nowMs
  });

  const resolved = resolveLatestAndCalls(tailGm, id, null);
  const result = {
    version: PROJECT_VERSION,
    conversation: id,
    cascadeStatus,
    stepCount: totalSteps,
    lastModifiedTime: lastModifiedTime || null,
    latest: resolved.latest,
    sessionSpeed: summarizeSessionSpeed(resolved.calls),
    sessionCache: summarizeCacheReadStats(resolved.calls),
    turnTiming,
    scannedAt: nowMs
  };
  setBoundedMap(_turnStateCache, gmCacheKey, {
    stepCount: totalSteps,
    lastModifiedTime: String(lastModifiedTime || ''),
    cascadeStatus,
    result
  }, TURN_STATE_CACHE_MAX_ENTRIES);
  return result;
}

async function collectQuotaSummary(origin, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin) {
    throw new Error('无效本机服务地址');
  }
  const scopeKey = getOriginScopeKey(safeOrigin, options);
  const cached = _quotaCache.get(scopeKey);
  if (options.force !== true && cached && (Date.now() - cached.at) < QUOTA_TTL_MS) {
    return cached.data;
  }
  const call = createOriginCaller(safeOrigin, null, options, () => false);
  const raw = await call('RetrieveUserQuotaSummary', {});
  const parsed = parseQuotaSummary(raw, Date.now());
  const result = {
    ok: true,
    version: PROJECT_VERSION,
    ...parsed
  };
  setBoundedMap(_quotaCache, scopeKey, { data: result, at: Date.now() }, 16);
  return result;
}

const DEFAULT_SETTINGS = {
  showSpeedInPill: true,
  showCacheInPill: true,
  showQuotaInPill: true,
  compactPill: false,
  customBudget: null
};

function getSettingsPath(options = {}) {
  const dir = options.stateDir ? path.resolve(String(options.stateDir)) : getStateDir();
  return path.join(dir, 'settings.json');
}

function normalizeSettings(raw = {}) {
  const budget = Number(raw.customBudget);
  return {
    showSpeedInPill: raw.showSpeedInPill !== false,
    showCacheInPill: raw.showCacheInPill !== false,
    showQuotaInPill: raw.showQuotaInPill !== false,
    compactPill: raw.compactPill === true,
    customBudget: Number.isFinite(budget) && budget >= 1000 ? Math.round(budget) : null
  };
}

function getSettings(options = {}) {
  const p = getSettingsPath(options);
  const res = safeReadJsonSync(p, { ...DEFAULT_SETTINGS });
  return { ok: true, settings: normalizeSettings(res.data || DEFAULT_SETTINGS), path: p };
}

function saveSettings(payload = {}, options = {}) {
  const p = getSettingsPath(options);
  const current = getSettings(options).settings;
  const merged = normalizeSettings({ ...current, ...(payload && typeof payload === 'object' ? payload : {}) });
  const writeRes = safeWriteJsonSync(p, merged);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || '保存设置失败', settings: current };
  }
  return { ok: true, settings: merged, path: p };
}

function clearCachesForTest() {
  conversations.clear();
  csrfTokenByOrigin.clear();
  latestCollectSeqByOrigin.clear();
  _turnStateGmCountCache.clear();
  _turnStateCache.clear();
  _incrementalCollectCache.clear();
  _extLogCache.clear();
  _ledgerCache.clear();
  _quotaCache.clear();
  for (const timer of _ledgerWriteTimers.values()) {
    try { clearTimeout(timer); } catch {}
  }
  _ledgerWriteTimers.clear();
  _ledgerDirtyData.clear();
  _lastDailySyncAt.clear();
}

module.exports = {
  PROJECT_VERSION,
  collect,
  collectTurnState,
  collectDailyUsage,
  collectQuotaSummary,
  recordCallsToLedger,
  getExternalUsageLogPath,
  readExternalUsageLog,
  appendExternalUsageRecord,
  flushPendingLedgersSync,
  getSettings,
  saveSettings,
  resolveCollectCsrfToken,
  clearCachesForTest
};
