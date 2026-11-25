'use strict';
/**
 * Antigravity Context Meter 数据采集器 (meter-collector.js)
 * 专注：通过本机 LanguageServerService RPC 拉取会话上下文、生成速度、TTFT、缓存命中与每日用量。
 */

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
  isCheckpointNewerThanGenerator,
  buildPostCompactSummary
} = require('./meter-core');

const PROJECT_VERSION = getProjectVersion('1.0.0');
const CONVERSATIONS_CACHE_MAX_ENTRIES = 32;
const CACHE_TTL_MS = 8000;
const DAILY_SYNC_TTL_MS = 30000;
const conversations = new Map();
const csrfTokenByOrigin = new Map();
const latestCollectSeqByOrigin = new Map();
const _turnStateGmCountCache = new Map();
const _lastDailySyncAt = new Map();
let collectSeqCounter = 0;
let collectTaskSeq = 0;

const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8, rejectUnauthorized: false });
const _httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });

function setBoundedMap(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function request(origin, method, body, token, signal = null) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      reject(err);
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
        if (size > 96 * 1024 * 1024) {
          req.destroy(new Error('本地响应过大，扫描中止'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (signal?.aborted) {
          const err = new Error('请求已取消');
          err.name = 'AbortError';
          reject(err);
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
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body) : undefined);
  });
}

async function resolveCollectCsrfToken(origin, signal = null, options = {}, isSuperseded = null) {
  let token = '';
  let hasConfig = false;
  let htmlFetchErr = null;
  try {
    const html = await request(origin, null, null, null, signal);
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

  const canFallback = !htmlFetchErr || /HTTP 40[13]\b/.test(String(htmlFetchErr.message || ''));
  if (!token && canFallback) {
    try {
      const fallbackToken = resolveOriginCsrfToken(origin, options);
      if (fallbackToken) {
        token = fallbackToken;
        hasConfig = true;
      }
    } catch {}
  }

  if (!token && htmlFetchErr) throw htmlFetchErr;
  if (!hasConfig) throw new Error('Antigravity 本地连接信息尚未就绪，请稍后重试');
  if (!token) throw new Error('Antigravity 本地鉴权信息尚未就绪，请稍后重试');
  return token;
}

function createOriginCaller(origin, signal = null, options = {}, isSuperseded = null) {
  return async (method, body) => {
    let token = csrfTokenByOrigin.get(origin) || null;
    if (!token) {
      token = await resolveCollectCsrfToken(origin, signal, options, isSuperseded);
      if (typeof isSuperseded === 'function' && isSuperseded()) return null;
      csrfTokenByOrigin.set(origin, token);
    }
    try {
      return await request(origin, method, body, token, signal);
    } catch (err) {
      if (err && /HTTP 40[13]/.test(String(err.message || '')) && !signal?.aborted) {
        csrfTokenByOrigin.delete(origin);
        token = await resolveCollectCsrfToken(origin, signal, options, isSuperseded);
        if (typeof isSuperseded === 'function' && isSuperseded()) return null;
        csrfTokenByOrigin.set(origin, token);
        return await request(origin, method, body, token, signal);
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

async function fetchStepTimestampsMap(call, cascadeId, expectedSteps = 0) {
  const stepDates = new Map();
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
  return stepDates;
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

const LEDGER_VERSION = 2;

function loadLedger(options = {}) {
  const p = getLedgerPath(options);
  const emptyLedger = { version: LEDGER_VERSION, syncedTrajectories: {}, calls: {} };
  const res = safeReadJsonSync(p, emptyLedger);
  const data = res?.data && typeof res.data === 'object' ? res.data : emptyLedger;
  if (!Number.isFinite(Number(data.version)) || Number(data.version) < LEDGER_VERSION) {
    return { path: p, data: emptyLedger, migrated: Boolean(res?.exists) };
  }
  if (!data.syncedTrajectories || typeof data.syncedTrajectories !== 'object') data.syncedTrajectories = {};
  if (!data.calls || typeof data.calls !== 'object') data.calls = {};
  return { path: p, data, migrated: false };
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
    if (
      !existing ||
      existing.date !== next.date ||
      existing.inputTokens !== next.inputTokens ||
      existing.cacheWriteTokens !== next.cacheWriteTokens ||
      existing.cacheReadTokens !== next.cacheReadTokens ||
      existing.outputTokens !== next.outputTokens ||
      existing.thinkingTokens !== next.thinkingTokens ||
      existing.model !== next.model
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
    safeWriteJsonSync(ledgerPath, data);
  }
  return { ok: true, changed, path: ledgerPath };
}

async function collectDailyUsage(origin = null, options = {}) {
  const { path: ledgerPath, data: ledger, migrated } = loadLedger(options);
  const safeOrigin = origin ? normalizeLoopbackOrigin(origin) : null;
  const syncKey = `${safeOrigin || ''}|${ledgerPath}`;
  const lastSync = _lastDailySyncAt.get(syncKey) || 0;
  const shouldSyncHost = Boolean(safeOrigin && (options.force === true || migrated || Date.now() - lastSync > DAILY_SYNC_TTL_MS));

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

      let changed = Boolean(migrated);
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

          const createdKey = formatLocalDateKey(summary?.createdTime);
          const modifiedKey = formatLocalDateKey(summary?.lastModifiedTime);
          const isSingleDay = Boolean(createdKey && modifiedKey && createdKey === modifiedKey);
          let stepDates = null;
          if (!isSingleDay && gmRows.length > 0) {
            try {
              stepDates = await fetchStepTimestampsMap(call, cid, stepCount);
            } catch {}
          }

          const defaultDate = summary?.createdTime || updatedAt || new Date().toISOString();
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
          if (mergeCallsIntoLedger(ledger, parsed, defaultDate)) changed = true;
          ledger.syncedTrajectories[cid] = { stepCount, updatedAt };
          changed = true;
        } catch {}
      }

      if (changed) {
        safeWriteJsonSync(ledgerPath, ledger);
      }
      _lastDailySyncAt.set(syncKey, Date.now());
    } catch {}
  }

  return {
    ok: true,
    version: PROJECT_VERSION,
    ...summarizeDailyUsage(Object.values(ledger.calls), options),
    syncedAt: Date.now()
  };
}

async function collect(origin, id, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin || !/^[a-f\d-]{36}$/i.test(String(id || ''))) {
    throw new Error('无效本机会话');
  }
  origin = safeOrigin;
  const key = `${origin}/${id}`;
  const supersede = options.supersedePrevious === true;
  const mySeq = supersede ? (++collectSeqCounter) : 0;
  const abortController = supersede ? new AbortController() : null;
  if (supersede) {
    const prevLatest = latestCollectSeqByOrigin.get(origin);
    if (prevLatest && prevLatest.id !== id && prevLatest.abortController) {
      try { prevLatest.abortController.abort(); } catch {}
    }
    latestCollectSeqByOrigin.set(origin, { seq: mySeq, id, abortController });
  }
  const isSuperseded = () => {
    if (!supersede) return false;
    const latest = latestCollectSeqByOrigin.get(origin);
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
      const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
      if (!full || isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };
      const trajectory = full.trajectory;
      if (!trajectory) throw new Error('未取得会话历史，无法统计');

      const steps = Array.isArray(trajectory.steps) ? trajectory.steps.slice() : [];
      const expected = Number(full.numTotalSteps ?? steps.length);
      while (steps.length < expected) {
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };
        const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
        if (!page?.steps?.length) break;
        steps.push(...page.steps);
      }
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };

      const session = analyzeSteps(steps);
      const title = String(full.title || trajectory.title || full.metadata?.title || trajectory.metadata?.title || session.firstUserTitle || '').trim();

      const totalGm = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
      const gmRows = await fetchAllGeneratorMetadata(
        call,
        id,
        totalGm,
        Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [],
        isSuperseded
      );
      if (gmRows === null || isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now() };
      _turnStateGmCountCache.set(`${origin}|${id.toLowerCase()}`, gmRows.length);

      const fallbackDate = full.lastModifiedTime || full.createdTime || trajectory.metadata?.createdAt || new Date().toISOString();
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

      const sessionSpeed = summarizeSessionSpeed(resolved.calls);
      const sessionCache = summarizeCacheReadStats(resolved.calls);
      const sessionTotals = summarizeSessionTotals(resolved.calls);
      const sessionModels = summarizeModelUsage(resolved.calls);

      if (!shouldSkipAutoLedgerWrite(options)) {
        try {
          recordCallsToLedger(resolved.calls, { stateDir: options.stateDir, fallbackDate });
        } catch {}
      }

      const result = {
        version: PROJECT_VERSION,
        conversation: id,
        title,
        cascadeStatus: full.status || null,
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
  const call = createOriginCaller(origin, null, options, () => false);

  let summaryEntry = null;
  try {
    const allSummaries = await call('GetAllCascadeTrajectories', {});
    summaryEntry = allSummaries?.trajectorySummaries?.[id] || allSummaries?.trajectorySummaries?.[id.toLowerCase()] || null;
  } catch {}

  let cascadeStatus = null;
  let totalSteps = 0;
  let stepOffset = 0;
  let tailSteps = [];
  let tailGm = [];
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
    const gmCacheKey = `${origin}|${id.toLowerCase()}`;
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
  return {
    version: PROJECT_VERSION,
    conversation: id,
    cascadeStatus,
    latest: resolved.latest,
    sessionSpeed: summarizeSessionSpeed(resolved.calls),
    sessionCache: summarizeCacheReadStats(resolved.calls),
    turnTiming,
    scannedAt: nowMs
  };
}

const DEFAULT_SETTINGS = {
  showSpeedInPill: true,
  showCacheInPill: true,
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
  _lastDailySyncAt.clear();
}

module.exports = {
  PROJECT_VERSION,
  collect,
  collectTurnState,
  collectDailyUsage,
  recordCallsToLedger,
  getSettings,
  saveSettings,
  resolveCollectCsrfToken,
  clearCachesForTest
};
