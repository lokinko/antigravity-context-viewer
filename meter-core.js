'use strict';
/**
 * Antigravity Context Meter 核心引擎 (meter-core.js)
 * 专注：上下文窗口用量、生成速度与首字延迟 (TTFT)、缓存命中率、压缩回落识别。
 * 支持 Node CommonJS 导出与浏览器/Electron 全局对象 (__AGContextMeterCore)。
 */
(function (root) {
  function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function parseDurationSec(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      if (!s) return null;
      if (s.endsWith('ms')) {
        const ms = Number(s.slice(0, -2));
        return Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null;
      }
      if (s.endsWith('s')) {
        const sec = Number(s.slice(0, -1));
        return Number.isFinite(sec) && sec >= 0 ? sec : null;
      }
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    if (typeof value === 'object') {
      const sec = Number(value.seconds || 0);
      const nanos = Number(value.nanos || 0);
      if (Number.isFinite(sec) && Number.isFinite(nanos)) {
        const total = sec + nanos / 1e9;
        return total >= 0 ? total : null;
      }
    }
    return null;
  }

  function parseTimestampMs(val) {
    if (val === null || val === undefined || val === '') return null;
    if (typeof val === 'number') return Number.isFinite(val) && val > 0 ? val : null;
    const parsed = Date.parse(String(val));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function mergeTimeIntervals(intervals) {
    if (!Array.isArray(intervals) || intervals.length === 0) return 0;
    const valid = intervals
      .filter(iv => Array.isArray(iv) && Number.isFinite(iv[0]) && Number.isFinite(iv[1]) && iv[1] > iv[0])
      .sort((a, b) => a[0] - b[0]);
    if (!valid.length) return 0;
    let totalMs = 0;
    let curStart = valid[0][0];
    let curEnd = valid[0][1];
    for (let i = 1; i < valid.length; i++) {
      const [s, e] = valid[i];
      if (s <= curEnd) {
        if (e > curEnd) curEnd = e;
      } else {
        totalMs += curEnd - curStart;
        curStart = s;
        curEnd = e;
      }
    }
    totalMs += curEnd - curStart;
    return totalMs / 1000;
  }

  function empty() {
    return { chars: 0, bytes: 0, low: 0, high: 0 };
  }

  function add(a, b) {
    if (!a) a = empty();
    if (!b) return a;
    for (const k of ['chars', 'bytes', 'low', 'high']) {
      a[k] = (a[k] || 0) + (b[k] || 0);
    }
    return a;
  }

  function measure(text, outAcc = null) {
    const str = String(text || '');
    const len = str.length;
    let chars = 0, bytes = 0, cjk = 0;
    for (let i = 0; i < len; i++) {
      const c = str.charCodeAt(i);
      if (c <= 127) {
        chars++;
        bytes++;
      } else if (c <= 2047) {
        chars++;
        bytes += 2;
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          i++;
          chars++;
          bytes += 4;
          continue;
        }
        chars++;
        bytes += 3;
      } else {
        chars++;
        bytes += 3;
        if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
      }
    }
    if (outAcc) {
      outAcc.chars += chars;
      outAcc.bytes += bytes;
      outAcc.cjk += cjk;
      return outAcc;
    }
    const middle = (chars - cjk) / 4 + cjk * 1.2;
    return {
      chars,
      bytes,
      low: Math.ceil(middle * 0.7),
      high: Math.ceil(Math.max(middle * 1.6, bytes / 2))
    };
  }

  function sanitizePreviewText(rawText, maxLen = 80) {
    const clean = String(rawText || '').replace(/\s+/g, ' ').trim();
    if (!clean) return '';
    if (maxLen > 4 && clean.length > maxLen) return clean.slice(0, maxLen - 1) + '…';
    return clean;
  }

  function analyzeSteps(steps) {
    const list = Array.isArray(steps) ? steps : [];
    const groups = {
      user: empty(),
      assistant: empty(),
      thinking: empty(),
      tools: empty(),
      summaries: empty()
    };
    const skip = new Set([
      'metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState',
      'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage',
      'tokenUsage', 'mendelExperimentIds'
    ]);
    const toolAcc = { chars: 0, bytes: 0, cjk: 0 };

    function accumulateContent(value, acc) {
      if (typeof value === 'string') { measure(value, acc); return; }
      if (typeof value === 'number' || typeof value === 'boolean') { measure(String(value), acc); return; }
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (let idx = 0; idx < value.length; idx++) {
          if (idx > 0) { acc.chars += 1; acc.bytes += 1; }
          accumulateContent(value[idx], acc);
        }
        return;
      }
      const keys = Object.keys(value);
      let wrote = false;
      for (let idx = 0; idx < keys.length; idx++) {
        const key = keys[idx];
        if (skip.has(key)) continue;
        if (wrote) { acc.chars += 1; acc.bytes += 1; }
        wrote = true;
        measure(key, acc);
        acc.chars += 2;
        acc.bytes += 2;
        accumulateContent(value[key], acc);
      }
    }

    let userMessages = 0;
    let assistantMessages = 0;
    let latestStepError = null;
    let lastUserAt = -1;
    let lastAssistantAt = -1;
    let lastModelStepAt = -1;
    let checkpointCount = 0;
    let lastCheckpointIndex = -1;
    let lastCheckpointFailed = false;
    let postCheckpointText = empty();
    let firstUserTitle = '';

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!s || typeof s !== 'object') continue;
      if (s.userInput) {
        userMessages++;
        lastUserAt = i;
        const u = s.userInput;
        const uText = u.userResponse || (u.items || []).map(item => item?.text || '').join('\n');
        if (!firstUserTitle && uText) firstUserTitle = sanitizePreviewText(uText, 56);
        const uMeasured = measure(uText);
        add(groups.user, uMeasured);
        if (lastCheckpointIndex >= 0) add(postCheckpointText, uMeasured);
      } else if (s.plannerResponse) {
        assistantMessages++;
        lastAssistantAt = i;
        lastModelStepAt = i;
        const aRaw = s.plannerResponse.modifiedResponse || s.plannerResponse.response || '';
        const tRaw = s.plannerResponse.thinking || '';
        const aMeasured = measure(aRaw);
        const tMeasured = measure(tRaw);
        add(groups.assistant, aMeasured);
        add(groups.thinking, tMeasured);
        if (lastCheckpointIndex >= 0) {
          add(postCheckpointText, aMeasured);
          add(postCheckpointText, tMeasured);
        }
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = {
          index: i,
          text: e.modelErrorMessage || e.shortError || e.fullError || '',
          id: e.errorId || ''
        };
      } else if (s.checkpoint) {
        const cp = s.checkpoint;
        const rawStepStatus = String(s.status || s.metadata?.status || '').trim().toUpperCase();
        const isInProgress = Boolean(rawStepStatus && /(?:^|_)(?:RUNNING|PENDING|GENERATING|IN_PROGRESS|STREAMING|QUEUED)$/.test(rawStepStatus));
        const isFailed = Boolean(rawStepStatus && /(?:^|_)(?:ERROR|FAILED|CANCELED|CANCELLED|ABORTED)$/.test(rawStepStatus));
        const cpText = [cp.sessionSummary, cp.codeChangeSummary, cp.userIntent, cp.memorySummary]
          .filter(v => typeof v === 'string' && v.length > 0)
          .join('\n');
        const cpMeasured = measure(cpText);
        add(groups.summaries, cpMeasured);
        if (!isInProgress) {
          if (cp.modelSummarizationFailed === true || isFailed) {
            lastCheckpointFailed = true;
          } else {
            checkpointCount++;
            lastCheckpointIndex = i;
            lastCheckpointFailed = false;
            postCheckpointText = { ...cpMeasured };
          }
        }
      } else {
        toolAcc.chars = 0; toolAcc.bytes = 0; toolAcc.cjk = 0;
        const stepKeys = Object.keys(s);
        let wroteStep = false;
        for (let kIdx = 0; kIdx < stepKeys.length; kIdx++) {
          const k = stepKeys[kIdx];
          if (k === 'type' || k === 'status' || k === 'metadata' || k === 'error' || skip.has(k)) continue;
          if (wroteStep) { toolAcc.chars += 1; toolAcc.bytes += 1; }
          wroteStep = true;
          measure(k, toolAcc);
          toolAcc.chars += 2;
          toolAcc.bytes += 2;
          accumulateContent(s[k], toolAcc);
        }
        if (toolAcc.chars > 0 || toolAcc.bytes > 0) {
          lastModelStepAt = i;
          const middle = (toolAcc.chars - toolAcc.cjk) / 4 + toolAcc.cjk * 1.2;
          const toolMeasured = {
            chars: toolAcc.chars,
            bytes: toolAcc.bytes,
            low: Math.ceil(middle * 0.7),
            high: Math.ceil(Math.max(middle * 1.6, toolAcc.bytes / 2))
          };
          add(groups.tools, toolMeasured);
          if (lastCheckpointIndex >= 0) add(postCheckpointText, toolMeasured);
        }
      }
    }

    const total = Object.values(groups).reduce((acc, g) => add(acc, g), empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt, lastCheckpointIndex)
      ? latestStepError
      : null;
    const postCheckpoint = lastCheckpointIndex >= 0
      ? { checkpointIndex: lastCheckpointIndex, textTotal: postCheckpointText }
      : null;

    return {
      groups,
      total,
      steps: list.length,
      userMessages,
      assistantMessages,
      lastUserAt,
      lastAssistantAt,
      lastModelStepAt,
      checkpointCount,
      lastCheckpointIndex,
      lastCheckpointFailed,
      postCheckpoint,
      currentError,
      firstUserTitle
    };
  }

  function normalizeCallInputCacheTokens(rec) {
    if (!rec || typeof rec !== 'object') {
      return { hasInputCacheFields: false, uncachedInput: null, cacheRead: null, cacheWrite: null, totalInput: null, output: null, totalTokens: null };
    }
    const rawInp = rec.inputTokens ?? rec.input_tokens ?? rec.input;
    const rawCacheWrite = rec.cacheWrite ?? rec.cacheWriteTokens ?? rec.cacheCreationInputTokens ?? rec.cacheWriteInputTokens;
    const rawCap = rec.cacheReadTokens ?? rec.cacheTokens ?? rec.cache_read_tokens ?? rec.cached ?? rec.cache;
    const rawOut = rec.outputTokens ?? rec.output_tokens ?? rec.output;
    const explicitMissing = rec.hasInputCacheFields === false;

    const hasCacheWrite = !explicitMissing && rec.uncachedInput == null && rawCacheWrite !== undefined && rawCacheWrite !== null && Number.isFinite(Number(rawCacheWrite)) && Number(rawCacheWrite) > 0;
    const hasInp = !explicitMissing && ((rawInp !== undefined && rawInp !== null && Number.isFinite(Number(rawInp))) || hasCacheWrite);
    const hasCap = !explicitMissing && rawCap !== undefined && rawCap !== null && Number.isFinite(Number(rawCap));
    const hasOut = rawOut !== undefined && rawOut !== null && Number.isFinite(Number(rawOut));

    if (!hasInp && !hasCap) {
      const rawTot = rec.totalTokens ?? rec.total;
      const totVal = rawTot !== undefined && rawTot !== null && Number.isFinite(Number(rawTot)) ? Math.max(0, Number(rawTot)) : null;
      return {
        hasInputCacheFields: false,
        uncachedInput: null,
        cacheRead: null,
        cacheWrite: null,
        totalInput: null,
        output: hasOut ? Math.max(0, Number(rawOut)) : null,
        totalTokens: totVal
      };
    }

    const rawInpNum = (rawInp !== undefined && rawInp !== null && Number.isFinite(Number(rawInp))) ? Math.max(0, Number(rawInp)) : 0;
    const cacheWriteVal = hasCacheWrite ? Math.max(0, Number(rawCacheWrite)) : 0;
    const inpVal = rawInpNum + cacheWriteVal;
    const capVal = hasCap ? Math.max(0, Number(rawCap)) : 0;
    const outVal = hasOut ? Math.max(0, Number(rawOut)) : 0;

    let uncachedInput;
    let totalInput;
    if (rec.inputIncludesCache === true) {
      totalInput = Math.max(inpVal, capVal);
      uncachedInput = Math.max(0, totalInput - capVal);
    } else {
      uncachedInput = inpVal;
      totalInput = inpVal + capVal;
    }

    const rawTot = rec.totalTokens ?? rec.total;
    const computedTot = totalInput + outVal;
    const totalTokens = rawTot !== undefined && rawTot !== null && Number.isFinite(Number(rawTot)) && Number(rawTot) > 0
      ? Math.max(Number(rawTot), computedTot)
      : computedTot;

    return {
      hasInputCacheFields: true,
      uncachedInput,
      cacheRead: capVal,
      cacheWrite: cacheWriteVal,
      totalInput,
      output: hasOut ? outVal : null,
      totalTokens
    };
  }

  function computeCacheReadStats(rec) {
    const norm = normalizeCallInputCacheTokens(rec);
    if (!norm.hasInputCacheFields || norm.totalInput === null || norm.cacheRead === null) {
      return { ...norm, cacheReadRatio: null, cacheReadPct: null, cacheStatus: 'missing' };
    }
    if (norm.totalInput <= 0) {
      return { ...norm, cacheReadRatio: null, cacheReadPct: null, cacheStatus: 'zero_input' };
    }
    const ratio = Math.max(0, Math.min(1, norm.cacheRead / norm.totalInput));
    return {
      ...norm,
      cacheReadRatio: ratio,
      cacheReadPct: Number((ratio * 100).toFixed(1)),
      cacheStatus: norm.cacheRead > 0 ? 'hit' : 'zero_cache'
    };
  }

  function summarizeCacheReadStats(records = []) {
    const list = Array.isArray(records) ? records : [];
    let totalUncachedInput = 0;
    let totalCacheRead = 0;
    let totalCacheWrite = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let evaluatedRequestCount = 0;
    let cacheHitRequestCount = 0;
    let missingCount = 0;
    let zeroInputCount = 0;

    for (const r of list) {
      const st = computeCacheReadStats(r);
      if (st.output !== null) totalOutput += st.output;
      if (st.cacheStatus === 'missing') { missingCount++; continue; }
      if (st.cacheStatus === 'zero_input') { zeroInputCount++; continue; }
      evaluatedRequestCount++;
      totalUncachedInput += st.uncachedInput;
      totalCacheRead += st.cacheRead;
      totalCacheWrite += st.cacheWrite || 0;
      totalInput += st.totalInput;
      if (st.cacheStatus === 'hit') cacheHitRequestCount++;
    }

    const cacheReadRatio = totalInput > 0 ? Math.max(0, Math.min(1, totalCacheRead / totalInput)) : null;
    const cacheReadPct = cacheReadRatio !== null ? Number((cacheReadRatio * 100).toFixed(1)) : null;
    const requestHitRatio = evaluatedRequestCount > 0 ? cacheHitRequestCount / evaluatedRequestCount : null;
    const requestHitPct = requestHitRatio !== null ? Number((requestHitRatio * 100).toFixed(1)) : null;
    const cacheStatus = totalInput > 0
      ? (totalCacheRead > 0 ? 'hit' : 'zero_cache')
      : (missingCount > 0 && zeroInputCount === 0 ? 'missing' : (zeroInputCount > 0 ? 'zero_input' : 'missing'));

    return {
      totalUncachedInput,
      totalCacheRead,
      totalCacheWrite,
      totalInput,
      totalOutput,
      cacheReadRatio,
      cacheReadPct,
      cacheStatus,
      evaluatedRequestCount,
      cacheHitRequestCount,
      requestHitRatio,
      requestHitPct,
      missingCount,
      zeroInputCount
    };
  }

  function classifyRequestError(input) {
    const text = String(input || '').trim();
    if (!text) return { kind: 'none', serviceLimit: null };
    const lower = text.toLowerCase();
    const limitMatch = text.match(/(?:limit|maximum|max(?:imum)?\s*(?:context|tokens?)|exceeds?\s*(?:the\s*)?(?:limit|max(?:imum)?))\D*(\d[\d,]{3,})/i)
      || text.match(/(\d[\d,]{3,})\s*(?:tokens?\s*(?:limit|max|maximum)|max(?:imum)?\s*tokens?)/i);
    const serviceLimit = limitMatch ? Number(limitMatch[1].replace(/,/g, '')) : null;

    if (/context.*(?:length|window|limit|exceed|too\s*long)|prompt\s*is\s*too\s*long|maximum\s*context|token\s*limit\s*exceeded|input\s*is\s*too\s*long/i.test(lower)) {
      return { kind: 'context_overflow', serviceLimit: Number.isFinite(serviceLimit) ? serviceLimit : null };
    }
    if (/quota|resource_exhausted|insufficient.*quota|usage\s*limit/i.test(lower)) {
      return { kind: 'quota_exhausted', serviceLimit: null };
    }
    if (/rate\s*limit|too\s*many\s*requests|429/i.test(lower)) {
      return { kind: 'rate_limited', serviceLimit: null };
    }
    if (/unauth|401|403|invalid.*key|forbidden|permission/i.test(lower)) {
      return { kind: 'auth_error', serviceLimit: null };
    }
    if (/cancel|abort/i.test(lower)) {
      return { kind: 'canceled', serviceLimit: null };
    }
    if (/econn|etimedout|enotfound|network|socket|fetch\s*failed|timeout|502|503|504/i.test(lower)) {
      return { kind: 'network_error', serviceLimit: null };
    }
    return { kind: 'failed', serviceLimit: null };
  }

  function summarize(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '').trim();
    const model = String(m.modelDisplayName || m.responseModel || m.model || options.currentModel || '').trim();
    const modelRaw = String(m.model || m.modelOrAlias?.model || m.responseModel || m.modelDisplayName || options.currentModel || '').trim();

    const classification = error ? classifyRequestError(error) : { kind: 'none', serviceLimit: null };
    const exceeded = classification.kind === 'context_overflow';
    const network = classification.kind === 'network_error';
    const serviceLimit = classification.serviceLimit || null;

    const usage = lastRetry ? lastRetry.usage : m.usage;
    const input = num(usage?.inputTokens);
    const cacheWrite = num(usage?.cacheCreationInputTokens ?? usage?.cacheWriteTokens ?? usage?.cacheWriteInputTokens);
    const cached = num(usage?.cacheReadTokens);
    const output = num(usage?.outputTokens);
    const thinking = num(usage?.thinkingOutputTokens);
    const responseTokens = num(usage?.responseOutputTokens);
    const hasInput = (input || 0) + (cacheWrite || 0) + (cached || 0) > 0;

    const prevContext = options.previousValidContext || null;
    let actual = hasInput && !error ? (input || 0) + (cacheWrite || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const estimate = num(context?.estimatedTokensUsed) || prevContext?.estimate || null;
    const budget = num(context?.maxContextTokens) || prevContext?.budget || null;

    const MIN_SETTLED_STREAM_SEC = 0.45;
    const MIN_SETTLED_STREAM_TOKENS = 12;
    const ttft = parseDurationSec(m.timeToFirstToken);
    const streamingSec = parseDurationSec(m.streamingDuration);
    const duration = (ttft !== null && streamingSec !== null) ? (ttft + streamingSec) : (ttft ?? streamingSec ?? null);
    let tps = null;
    if (output && duration && duration > 0) {
      tps = Number((output / duration).toFixed(1));
    }
    let streamingTps = null;
    if (output && streamingSec && streamingSec > 0) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }
    const isSettledStream = Boolean(output && streamingSec !== null && (
      streamingSec >= MIN_SETTLED_STREAM_SEC || (streamingSec > 0.05 && output >= MIN_SETTLED_STREAM_TOKENS)
    ));
    const isWarming = Boolean(output && output > 0 && !isSettledStream && (
      streamingSec === null || streamingSec < MIN_SETTLED_STREAM_SEC
    ));
    const speedPhase = isWarming ? 'warming' : (isSettledStream || tps !== null ? 'settled' : 'idle');
    const speed = (tps !== null || duration !== null || output !== null || ttft !== null) ? {
      tps,
      streamingTps,
      streamSpeed: streamingTps,
      phase: speedPhase,
      isWarmingStream: isWarming,
      displayTps: speedPhase === 'warming' ? null : (streamingTps ?? tps ?? null),
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      ttftRatio: (ttft !== null && duration !== null && duration > 0)
        ? Number(Math.min(100, Math.max(0, (ttft / duration) * 100)).toFixed(1))
        : null,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      responseTokens: responseTokens ?? (output ?? 0)
    } : null;

    let status = 'pending';
    if (exceeded) status = 'exceeded';
    else if (network) status = 'network';
    else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
    else if (classification.kind === 'rate_limited') status = 'rate_limited';
    else if (classification.kind === 'auth_error') status = 'auth_error';
    else if (classification.kind === 'canceled') status = 'canceled';
    else if (error) status = 'failed';
    else if (actual !== null) status = 'reported';
    else if (estimate > 0) status = 'estimated';

    const usedVal = actual ?? (estimate > 0 ? estimate : null);
    const percentVal = usedVal !== null && budget > 0 && !exceeded ? (usedVal / budget * 100) : null;
    const remainingVal = usedVal !== null && budget > 0 ? Math.max(0, budget - usedVal) : null;

    const effectiveInputTotal = hasInput ? (input || 0) + (cacheWrite || 0) + (cached || 0) : (prevContext?.input || null);
    const effectiveCached = hasInput ? (cached || 0) : (prevContext?.cached || 0);
    const effectiveUncached = hasInput
      ? (input || 0) + (cacheWrite || 0)
      : (prevContext?.uncachedInput ?? (effectiveInputTotal != null ? Math.max(0, effectiveInputTotal - effectiveCached) : null));
    const rawInputOnly = hasInput ? (input || 0) : (prevContext?.rawInput ?? null);
    const cacheHit = hasInput
      ? computeCacheReadStats({ inputTokens: input || 0, cacheWriteTokens: cacheWrite || 0, cacheReadTokens: cached || 0 })
      : (prevContext?.cacheHitRate != null ? { cacheReadPct: prevContext.cacheHitRate } : { cacheReadPct: null });

    return {
      used: usedVal,
      actual,
      estimate: estimate > 0 ? estimate : null,
      budget: budget > 0 ? budget : null,
      remaining: remainingVal,
      serviceLimit,
      exceeded,
      network,
      error,
      errorClassification: classification,
      estimated: actual === null,
      input: effectiveInputTotal,
      rawInput: rawInputOnly,
      uncachedInput: effectiveUncached,
      cacheWrite: cacheWrite || 0,
      cached: effectiveCached,
      cacheHitRate: cacheHit.cacheReadPct,
      output: output ?? (prevContext?.output ?? null),
      thinking: thinking ?? (prevContext?.thinking ?? 0),
      responseTokens: responseTokens ?? (prevContext?.responseTokens ?? (output ?? null)),
      percent: percentVal,
      model,
      modelRaw,
      status,
      speed
    };
  }

  function extractGeneratorMaxStep(metadata) {
    if (!metadata || typeof metadata !== 'object') return -1;
    let maxStep = -1;
    if (Array.isArray(metadata.stepIndices)) {
      for (const raw of metadata.stepIndices) {
        const n = Number(raw);
        if (Number.isInteger(n) && n >= 0 && n > maxStep) maxStep = n;
      }
    }
    for (const cand of [metadata.stepIndex, metadata.step_index, metadata.chatModel?.chatStartMetadata?.startStepIndex]) {
      if (cand !== undefined && cand !== null && cand !== '') {
        const n = Number(cand);
        if (Number.isInteger(n) && n >= 0 && n > maxStep) maxStep = n;
      }
    }
    return maxStep;
  }

  function isCheckpointNewerThanGenerator(session, latestGeneratorMeta = null, summarizedLatest = null) {
    const cpIdx = Number.isInteger(session?.lastCheckpointIndex) ? session.lastCheckpointIndex : -1;
    if (cpIdx < 0) return false;
    if (!latestGeneratorMeta) return true;
    const genMaxStep = extractGeneratorMaxStep(latestGeneratorMeta);
    if (genMaxStep >= 0) {
      if (genMaxStep <= cpIdx) return true;
      const hasPostCompactOutcome = Boolean(
        summarizedLatest && (summarizedLatest.actual !== null || Boolean(summarizedLatest.error))
      );
      return !hasPostCompactOutcome;
    }
    const lastModelStep = Number.isInteger(session?.lastModelStepAt)
      ? session.lastModelStepAt
      : (Number.isInteger(session?.lastAssistantAt) ? session.lastAssistantAt : -1);
    return lastModelStep <= cpIdx;
  }

  function buildPostCompactSummary(options = {}) {
    const session = options.session || null;
    const prev = options.previousLatest || null;
    const activeRange = session?.postCompactActiveTotal || (session?.postCheckpoint?.textTotal
      ? add(add({ ...session.postCheckpoint.textTotal }, options.system || empty()), options.definitions || empty())
      : null);

    let localMidpoint = null;
    if (activeRange) {
      const mid = Math.round(((Number(activeRange.low) || 0) + (Number(activeRange.high) || 0)) / 2);
      localMidpoint = (activeRange.chars > 0 && mid <= 0) ? 1 : mid;
    }

    const budget = prev?.budget && prev.budget > 0 ? prev.budget : null;
    const percentVal = (localMidpoint !== null && budget) ? (localMidpoint / budget * 100) : null;
    const remainingVal = (localMidpoint !== null && budget) ? Math.max(0, budget - localMidpoint) : null;

    return {
      used: localMidpoint,
      actual: null,
      estimate: localMidpoint,
      budget,
      remaining: remainingVal,
      compacted: true,
      checkpointCount: Number(session?.checkpointCount || 1),
      serviceLimit: null,
      exceeded: false,
      network: false,
      error: '',
      errorClassification: { kind: 'none', serviceLimit: null },
      estimated: true,
      input: null,
      rawInput: null,
      uncachedInput: null,
      cacheWrite: 0,
      cached: 0,
      cacheHitRate: null,
      output: null,
      thinking: 0,
      responseTokens: null,
      percent: percentVal,
      model: prev?.model || '',
      modelRaw: prev?.modelRaw || '',
      status: 'compacted',
      speed: prev?.speed || null
    };
  }

  function parseGeneratorCall(row, cascadeId = null, idxFallback = 0, options = {}) {
    if (!row || typeof row !== 'object') return null;
    const cm = row.chatModel || {};
    const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length ? cm.retryInfos[cm.retryInfos.length - 1] : null;
    const u = lastRetry?.usage || cm.usage || {};
    const hasExplicitInput = u.inputTokens !== undefined || row.inputTokens !== undefined || row.input_tokens !== undefined;
    const hasExplicitCache = u.cacheReadTokens !== undefined || row.cacheTokens !== undefined || row.cacheReadTokens !== undefined || row.cache_read_tokens !== undefined;
    const hasExplicitCacheWrite = u.cacheCreationInputTokens !== undefined || u.cacheWriteTokens !== undefined || u.cacheWriteInputTokens !== undefined;
    const hasExplicitOutput = u.outputTokens !== undefined || row.outputTokens !== undefined || row.output_tokens !== undefined;
    const hasInputCacheFields = Boolean(hasExplicitInput || hasExplicitCache || hasExplicitCacheWrite);

    const model = String(cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '').trim();
    const input = hasExplicitInput ? (Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens) || 0) : 0;
    const cacheWrite = hasExplicitCacheWrite ? (Number(u.cacheCreationInputTokens ?? u.cacheWriteTokens ?? u.cacheWriteInputTokens) || 0) : 0;
    const cached = hasExplicitCache ? (Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens) || 0) : 0;
    const output = hasExplicitOutput ? (Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens) || 0) : 0;
    const thinking = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0) || 0;
    const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? Math.max(0, output - thinking)) || 0;
    const totalTokens = input + cacheWrite + cached + output;

    const rawStepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index;
    const parsedStepIdx = rawStepIdx !== undefined && rawStepIdx !== null && rawStepIdx !== '' ? Number(rawStepIdx) : NaN;
    const stepIndex = Number.isInteger(parsedStepIdx) && parsedStepIdx >= 0 ? parsedStepIdx : null;
    const callId = row.invocationId || row.callId || `${cascadeId || 'call'}#${stepIndex ?? idxFallback}`;

    const rawDateSource = row.createdAt || row.created_at || row.timestamp || cm.createdAt || cm.timestamp || row.date || options.fallbackDate || null;
    const timestampMs = parseTimestampMs(rawDateSource);
    const dateKey = (typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date.trim()))
      ? row.date.trim()
      : formatLocalDateKey(timestampMs ?? rawDateSource);

    const hasExplicitFinish = Boolean(
      row.status === 'final' || row.status === 'completed' || cm.finishReason || row.finishReason || row.done === true ||
      (cm.streamingDuration != null && cm.timeToFirstToken != null)
    );
    const status = hasExplicitFinish || (totalTokens > 0 && !row.isStreaming && row.status !== 'streaming') ? 'final' : 'streaming';
    const isEstimated = totalTokens === 0 || output === 0;

    const ttftSec = parseDurationSec(cm.timeToFirstToken) ?? (num(row.ttftSec) >= 0 ? num(row.ttftSec) : null);
    const streamingSec = parseDurationSec(cm.streamingDuration) ?? (num(row.streamingSec) >= 0 ? num(row.streamingSec) : null);
    const durationSec = (ttftSec !== null && streamingSec !== null)
      ? Number((ttftSec + streamingSec).toFixed(4))
      : (ttftSec !== null || streamingSec !== null ? (ttftSec ?? streamingSec) : (num(row.durationSec) > 0 ? num(row.durationSec) : null));

    const tps = (output > 0 && durationSec && durationSec > 0) ? Number((output / durationSec).toFixed(1)) : null;
    const streamingTps = (output > 0 && streamingSec && streamingSec > 0) ? Number((output / streamingSec).toFixed(1)) : null;

    const cacheStats = hasInputCacheFields
      ? computeCacheReadStats({ inputTokens: input, cacheWriteTokens: cacheWrite, cacheReadTokens: cached })
      : { cacheReadPct: null, totalInput: null, uncachedInput: null, cacheRead: null };

    return {
      callId,
      stepIndex,
      model,
      dateKey,
      timestampMs,
      status,
      isEstimated,
      hasInputCacheFields,
      inputTokens: input,
      cacheWriteTokens: cacheWrite,
      cacheReadTokens: cached,
      totalInput: cacheStats.totalInput,
      uncachedInput: cacheStats.uncachedInput,
      cacheReadPct: cacheStats.cacheReadPct,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      totalTokens,
      ttftSec: ttftSec !== null ? Number(ttftSec.toFixed(3)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(3)) : null,
      durationSec: durationSec !== null ? Number(durationSec.toFixed(3)) : null,
      tps,
      streamingTps
    };
  }

  function isValidSpeedSample(call) {
    if (!call || typeof call !== 'object') return false;
    if (call.status !== 'final' || call.isEstimated === true) return false;
    return Number.isFinite(Number(call.outputTokens)) && Number(call.outputTokens) > 0 &&
      Number.isFinite(Number(call.durationSec)) && Number(call.durationSec) > 0;
  }

  function summarizeSessionSpeed(sessionCalls) {
    const list = Array.isArray(sessionCalls) ? sessionCalls : [];
    let count = 0;
    let totalOutputTokens = 0;
    let totalDurationSec = 0;
    let streamCount = 0;
    let totalStreamTokens = 0;
    let totalStreamingSec = 0;
    const ttfts = [];

    for (const c of list) {
      if (!isValidSpeedSample(c)) continue;
      const out = Number(c.outputTokens);
      const dur = Number(c.durationSec);
      count++;
      totalOutputTokens += out;
      totalDurationSec += dur;
      if (c.ttftSec !== null && Number.isFinite(Number(c.ttftSec)) && Number(c.ttftSec) >= 0) {
        ttfts.push(Number(c.ttftSec));
      }
      let sSec = Number(c.streamingSec);
      const sTps = Number(c.streamingTps);
      if ((!Number.isFinite(sSec) || sSec < 0.05) && Number.isFinite(sTps) && sTps > 0) {
        sSec = out / sTps;
      }
      if (Number.isFinite(sSec) && sSec >= 0.05) {
        streamCount++;
        totalStreamTokens += out;
        totalStreamingSec += sSec;
      }
    }
    if (!count || totalDurationSec <= 0 || totalOutputTokens <= 0) return null;

    const avgOverallTps = Number((totalOutputTokens / totalDurationSec).toFixed(1));
    const avgStreamTps = (streamCount > 0 && totalStreamingSec >= 0.05 && totalStreamTokens > 0)
      ? Number((totalStreamTokens / totalStreamingSec).toFixed(1))
      : null;

    let medianTtftSec = null;
    if (ttfts.length > 0) {
      ttfts.sort((a, b) => a - b);
      const mid = Math.floor(ttfts.length / 2);
      medianTtftSec = Number((ttfts.length % 2 === 1 ? ttfts[mid] : (ttfts[mid - 1] + ttfts[mid]) / 2).toFixed(2));
    }

    return {
      avgTps: avgStreamTps ?? avgOverallTps,
      avgStreamTps,
      avgOverallTps,
      medianTtftSec,
      count,
      streamCount,
      totalOutputTokens,
      totalDurationSec: Number(totalDurationSec.toFixed(2)),
      totalStreamingSec: totalStreamingSec >= 0.05 ? Number(totalStreamingSec.toFixed(2)) : null
    };
  }

  function summarizeTurnTiming(options = {}) {
    const steps = Array.isArray(options.steps) ? options.steps : [];
    const baseStepOffset = Number.isInteger(Number(options.stepOffset)) && Number(options.stepOffset) >= 0 ? Number(options.stepOffset) : 0;
    const generatorMetadata = Array.isArray(options.generatorMetadata) ? options.generatorMetadata : [];
    const cascadeStatus = typeof options.cascadeStatus === 'string' && options.cascadeStatus.trim() ? options.cascadeStatus.trim() : null;
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();

    const getStepGlobalIndex = (s, localIdx) => {
      const rawIdx = s?.metadata?.sourceTrajectoryStepInfo?.stepIndex;
      if (rawIdx !== undefined && rawIdx !== null && rawIdx !== '' && Number.isInteger(Number(rawIdx)) && Number(rawIdx) >= 0) {
        return Number(rawIdx);
      }
      return baseStepOffset + localIdx;
    };

    const getGmStepIndices = (g) => {
      if (!g || typeof g !== 'object') return [];
      if (Array.isArray(g.stepIndices) && g.stepIndices.length > 0) {
        return g.stepIndices.map(Number).filter(n => Number.isFinite(n) && n >= 0);
      }
      const single = g.stepIndex ?? g.step_index;
      if (single !== undefined && single !== null && single !== '' && Number.isFinite(Number(single)) && Number(single) >= 0) {
        return [Number(single)];
      }
      return [];
    };

    let lastUserIdx = -1;
    let lastUserGlobalIdx = null;
    for (let i = 0; i < steps.length; i++) {
      if (steps[i]?.userInput) {
        lastUserIdx = i;
        lastUserGlobalIdx = getStepGlobalIndex(steps[i], i);
      }
    }

    const turnSteps = [];
    const turnStepGlobalIndices = [];
    if (lastUserIdx >= 0) {
      for (let i = lastUserIdx; i < steps.length; i++) {
        if (steps[i]) {
          turnSteps.push(steps[i]);
          turnStepGlobalIndices.push(getStepGlobalIndex(steps[i], i));
        }
      }
    }

    let turnStartMs = null;
    let lastActivityMs = null;
    let hasInFlightStep = false;
    for (const s of turnSteps) {
      const m = s?.metadata || {};
      const cMs = parseTimestampMs(m.createdAt);
      if (s.userInput && cMs !== null && (turnStartMs === null || cMs < turnStartMs)) turnStartMs = cMs;
      const transitions = Array.isArray(m.internalMetadata?.statusTransitions) ? m.internalMetadata.statusTransitions : [];
      const candidates = [m.createdAt, m.viewableAt, m.finishedGeneratingAt, m.startedAt, m.completedAt, ...transitions.map(t => t?.timestamp)];
      for (const rawTs of candidates) {
        const ts = parseTimestampMs(rawTs);
        if (ts !== null) {
          if (turnStartMs === null || ts < turnStartMs) turnStartMs = ts;
          if (lastActivityMs === null || ts > lastActivityMs) lastActivityMs = ts;
        }
      }
      const lastTrStatus = transitions.length ? String(transitions[transitions.length - 1]?.updatedStatus || '') : String(s.status || '');
      if (!s.userInput && !m.completedAt && /RUNNING|GENERATING|PENDING/i.test(lastTrStatus) && !/DONE|COMPLETED|ERROR|CANCELED|FAILED/i.test(lastTrStatus)) {
        hasInFlightStep = true;
      }
    }

    const tailGm = generatorMetadata.length ? generatorMetadata[generatorMetadata.length - 1] : null;
    const tailGmStreaming = Boolean(tailGm && (tailGm.isStreaming === true || tailGm.status === 'streaming'));
    const isRunning = cascadeStatus === 'CASCADE_RUN_STATUS_RUNNING'
      ? true
      : (cascadeStatus !== null ? false : Boolean(hasInFlightStep || tailGmStreaming));

    let turnGms = [];
    if (lastUserGlobalIdx !== null) {
      turnGms = generatorMetadata.filter(g => {
        const idxs = getGmStepIndices(g);
        return idxs.length > 0 && idxs.some(idx => idx >= lastUserGlobalIdx);
      });
    } else if (steps.length === 0 && tailGm) {
      turnGms = [tailGm];
    }

    let ttftSec = 0;
    let latestTtftSec = null;
    let streamingSec = 0;
    let llmDurationSec = 0;
    let outputTokens = 0;
    const settledGmStepSet = new Set();
    let maxSettledGmStepIdx = -1;

    for (const g of turnGms) {
      const cm = g?.chatModel || {};
      const lastRetry = (cm.retryInfos || []).at(-1);
      const usage = lastRetry ? lastRetry.usage : cm.usage;
      const tSec = parseDurationSec(cm.timeToFirstToken);
      const sSec = parseDurationSec(cm.streamingDuration);
      if (tSec !== null) {
        ttftSec += tSec;
        latestTtftSec = tSec;
        for (const idx of getGmStepIndices(g)) {
          settledGmStepSet.add(idx);
          if (idx > maxSettledGmStepIdx) maxSettledGmStepIdx = idx;
        }
      }
      if (sSec !== null) streamingSec += sSec;
      if (tSec !== null || sSec !== null) llmDurationSec += (tSec || 0) + (sSec || 0);
      outputTokens += num(usage?.outputTokens) || 0;
    }

    let activeToolStartMs = null;
    const toolIntervals = [];
    for (const s of turnSteps) {
      const m = s?.metadata || {};
      const transitions = Array.isArray(m.internalMetadata?.statusTransitions) ? m.internalMetadata.statusTransitions : [];
      const lastTrStatus = transitions.length ? String(transitions[transitions.length - 1]?.updatedStatus || '') : String(s.status || '');
      const runningTr = transitions.find(tr => /RUNNING/i.test(String(tr?.updatedStatus || '')) && tr?.timestamp);
      const doneTr = [...transitions].reverse().find(tr => /DONE|COMPLETED|ERROR|CANCELED|FAILED/i.test(String(tr?.updatedStatus || '')) && tr?.timestamp);
      const isToolStep = Boolean(m.toolCall) || (!s.userInput && !s.plannerResponse && !s.checkpoint && !s.errorMessage && (m.startedAt || runningTr || m.toolSource));
      if (!isToolStep) continue;
      const isTerminal = Boolean(m.completedAt || doneTr) || /DONE|COMPLETED|ERROR|CANCELED|FAILED/i.test(lastTrStatus);
      const stMs = parseTimestampMs(m.startedAt) ?? parseTimestampMs(runningTr?.timestamp) ?? null;
      const completedMs = parseTimestampMs(m.completedAt) ?? parseTimestampMs(doneTr?.timestamp);
      if (stMs !== null) {
        if (completedMs !== null && completedMs > stMs) toolIntervals.push([stMs, completedMs]);
        else if (completedMs === null && isRunning && !isTerminal) {
          activeToolStartMs = activeToolStartMs === null ? stMs : Math.min(activeToolStartMs, stMs);
          if (nowMs > stMs) toolIntervals.push([stMs, nowMs]);
        }
      }
    }
    const rawToolWallSec = mergeTimeIntervals(toolIntervals);

    let inFlightTtftAnchorMs = null;
    if (isRunning && activeToolStartMs === null && !tailGmStreaming && turnSteps.length > 0) {
      const lastIdx = turnSteps.length - 1;
      const lastStep = turnSteps[lastIdx];
      const lastGlobalIdx = turnStepGlobalIndices[lastIdx];
      const lm = lastStep?.metadata || {};
      if (lastStep?.plannerResponse) {
        if (!lm.viewableAt && !lm.finishedGeneratingAt && !lm.completedAt && !settledGmStepSet.has(lastGlobalIdx)) {
          inFlightTtftAnchorMs = parseTimestampMs(lm.createdAt) ?? lastActivityMs ?? turnStartMs;
        }
      } else if (lastStep?.userInput && turnGms.length === 0) {
        inFlightTtftAnchorMs = parseTimestampMs(lm.createdAt) ?? turnStartMs;
      } else if (lm.completedAt && maxSettledGmStepIdx >= 0 && lastGlobalIdx > maxSettledGmStepIdx) {
        inFlightTtftAnchorMs = parseTimestampMs(lm.completedAt) ?? lastActivityMs;
      }
    }

    const inFlightTtftSec = (inFlightTtftAnchorMs !== null && nowMs >= inFlightTtftAnchorMs)
      ? Number(((nowMs - inFlightTtftAnchorMs) / 1000).toFixed(2))
      : null;

    const minPhysicalWallSec = llmDurationSec + rawToolWallSec;
    let wallDurationSec = null;
    if (turnStartMs !== null) {
      if (isRunning) wallDurationSec = Math.max(minPhysicalWallSec, Math.max(0, (nowMs - turnStartMs) / 1000));
      else if (lastActivityMs !== null && lastActivityMs >= turnStartMs) wallDurationSec = Math.max(minPhysicalWallSec, (lastActivityMs - turnStartMs) / 1000);
    }
    if (wallDurationSec === null && minPhysicalWallSec > 0) wallDurationSec = minPhysicalWallSec;

    return {
      isRunning,
      inFlightTtftSec,
      llmCalls: turnGms.length,
      wallDurationSec: wallDurationSec !== null ? Number(wallDurationSec.toFixed(2)) : null,
      ttftSec: Number(ttftSec.toFixed(2)),
      latestTtftSec: latestTtftSec !== null ? Number(latestTtftSec.toFixed(2)) : null,
      streamingSec: Number(streamingSec.toFixed(2)),
      outputTokens
    };
  }

  function computeContextSegments(usage = {}, limitTokens = 0) {
    const cap = Number.isFinite(Number(limitTokens)) && Number(limitTokens) > 0 ? Number(limitTokens) : 0;
    const cacheWriteTokens = Math.max(0, Number(usage?.cacheWrite ?? usage?.cacheCreationInputTokens ?? 0) || 0);
    const cacheReadTokens = Math.max(0, Number(usage?.cached ?? usage?.cacheReadTokens ?? usage?.cacheTokens ?? 0) || 0);
    const rawInputTokens = Math.max(0, Number(usage?.rawInput ?? usage?.uncachedInput ?? usage?.inputTokens ?? 0) || 0);
    const outputTokens = Math.max(0, Number(usage?.output ?? usage?.outputTokens ?? 0) || 0);

    const sumSplit = rawInputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
    const explicitUsed = Number(usage?.actual ?? usage?.used ?? 0);
    const usedTokens = sumSplit > 0 ? sumSplit : (Number.isFinite(explicitUsed) && explicitUsed > 0 ? explicitUsed : 0);
    const hasSplit = sumSplit > 0;
    const effectiveUncached = hasSplit ? rawInputTokens : usedTokens;
    const remainingTokens = cap > 0 ? Math.max(0, cap - usedTokens) : 0;
    const denom = cap > 0 ? cap : (usedTokens > 0 ? usedTokens : 0);
    const toPct = (v) => denom > 0 ? Math.min(100, Math.max(0, Number(((v / denom) * 100).toFixed(1)))) : 0;
    const usedPct = cap > 0 ? Math.min(999, Number(((usedTokens / cap) * 100).toFixed(1))) : 0;
    const thresholdLevel = usedPct >= 85 ? 'critical' : (usedPct >= 65 ? 'warning' : 'normal');

    return {
      hasSplit,
      cacheReadTokens,
      uncachedInputTokens: effectiveUncached,
      cacheWriteTokens,
      outputTokens,
      usedTokens,
      limitTokens: cap,
      remainingTokens,
      cacheReadPct: toPct(cacheReadTokens),
      uncachedInputPct: toPct(effectiveUncached),
      cacheWritePct: toPct(cacheWriteTokens),
      outputPct: toPct(outputTokens),
      freePct: cap > 0 ? Math.max(0, Number((100 - Math.min(100, usedPct)).toFixed(1))) : 0,
      usedPct,
      thresholdLevel
    };
  }

  function formatLocalDateKey(dateOrMs) {
    if (dateOrMs === null || dateOrMs === undefined || dateOrMs === '') return null;
    if (typeof dateOrMs === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateOrMs.trim())) {
      return dateOrMs.trim();
    }
    const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function shiftLocalDateKey(dateKey, deltaDays) {
    const m = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + Number(deltaDays || 0));
    return formatLocalDateKey(d);
  }

  function summarizeSessionTotals(calls = []) {
    const list = Array.isArray(calls) ? calls : [];
    let uncachedInput = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let totalOutput = 0;
    let thinkingTokens = 0;
    let responseTokens = 0;
    let callCount = 0;

    for (const c of list) {
      if (!c || typeof c !== 'object') continue;
      const rawIn = Math.max(0, Number(c.inputTokens ?? c.rawInput ?? 0) || 0);
      const cw = Math.max(0, Number(c.cacheWriteTokens ?? c.cacheWrite ?? 0) || 0);
      const cr = Math.max(0, Number(c.cacheReadTokens ?? c.cacheRead ?? c.cached ?? 0) || 0);
      const out = Math.max(0, Number(c.outputTokens ?? c.output ?? 0) || 0);
      const think = Math.max(0, Number(c.thinkingTokens ?? c.thinking ?? 0) || 0);
      const resp = Math.max(0, Number(c.responseTokens ?? Math.max(0, out - think)) || 0);
      const tot = rawIn + cw + cr + out;
      if (tot <= 0 && c.hasInputCacheFields === false) continue;
      callCount++;
      uncachedInput += rawIn + cw;
      cacheWrite += cw;
      cacheRead += cr;
      totalOutput += out;
      thinkingTokens += think;
      responseTokens += resp;
    }

    const totalInput = uncachedInput + cacheRead;
    const totalTokens = totalInput + totalOutput;
    return {
      totalTokens,
      totalInput,
      uncachedInput,
      cacheRead,
      cacheWrite,
      totalOutput,
      thinkingTokens,
      responseTokens,
      callCount
    };
  }

  function emptyBucketTotals(date = null) {
    return {
      ...(date ? { date } : {}),
      totalTokens: 0,
      totalInput: 0,
      uncachedInput: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalOutput: 0,
      thinkingTokens: 0,
      callCount: 0,
      cacheReadPct: null
    };
  }

  function finalizeBucketTotals(bucket) {
    bucket.totalInput = bucket.uncachedInput + bucket.cacheRead;
    bucket.totalTokens = bucket.totalInput + bucket.totalOutput;
    bucket.cacheReadPct = bucket.totalInput > 0
      ? Number(((bucket.cacheRead / bucket.totalInput) * 100).toFixed(1))
      : null;
    return bucket;
  }

  function summarizeModelUsage(entries = []) {
    const list = Array.isArray(entries) ? entries : Object.values(entries || {});
    const map = new Map();
    let grandTotal = 0;

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rawIn = Math.max(0, Number(item.inputTokens ?? item.rawInput ?? 0) || 0);
      const cw = Math.max(0, Number(item.cacheWriteTokens ?? item.cacheWrite ?? 0) || 0);
      const cr = Math.max(0, Number(item.cacheReadTokens ?? item.cacheRead ?? item.cached ?? 0) || 0);
      const out = Math.max(0, Number(item.outputTokens ?? item.output ?? 0) || 0);
      const think = Math.max(0, Number(item.thinkingTokens ?? item.thinking ?? 0) || 0);
      const tot = rawIn + cw + cr + out;
      if (tot <= 0) continue;

      const modelName = String(item.model || '').trim() || '未知模型';
      let b = map.get(modelName);
      if (!b) {
        b = { model: modelName, ...emptyBucketTotals() };
        map.set(modelName, b);
      }
      b.uncachedInput += rawIn + cw;
      b.cacheWrite += cw;
      b.cacheRead += cr;
      b.totalOutput += out;
      b.thinkingTokens += think;
      b.callCount++;
      grandTotal += tot;
    }

    const outList = [];
    for (const b of map.values()) {
      finalizeBucketTotals(b);
      b.sharePct = grandTotal > 0 ? Number(((b.totalTokens / grandTotal) * 100).toFixed(1)) : 0;
      outList.push(b);
    }
    outList.sort((a, b) => (b.totalTokens - a.totalTokens) || (b.callCount - a.callCount));
    return outList;
  }

  function summarizeDailyUsage(ledgerEntries = [], options = {}) {
    const entries = Array.isArray(ledgerEntries) ? ledgerEntries : Object.values(ledgerEntries || {});
    const todayKey = (typeof options.todayKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(options.todayKey))
      ? options.todayKey
      : formatLocalDateKey(options.nowMs ?? Date.now());
    const min7Key = shiftLocalDateKey(todayKey, -6);
    const min30Key = shiftLocalDateKey(todayKey, -29);

    const dayMap = new Map();
    const allTime = emptyBucketTotals();
    const todayEntries = [];
    const last7Entries = [];
    const last30Entries = [];
    const allEntries = [];

    for (const item of entries) {
      if (!item || typeof item !== 'object') continue;
      const dateKey = formatLocalDateKey(item.date || item.dateKey || item.timestampMs);
      const rawIn = Math.max(0, Number(item.inputTokens ?? 0) || 0);
      const cw = Math.max(0, Number(item.cacheWriteTokens ?? item.cacheWrite ?? 0) || 0);
      const cr = Math.max(0, Number(item.cacheReadTokens ?? item.cacheRead ?? item.cached ?? 0) || 0);
      const out = Math.max(0, Number(item.outputTokens ?? 0) || 0);
      const think = Math.max(0, Number(item.thinkingTokens ?? 0) || 0);
      const tot = rawIn + cw + cr + out;
      if (tot <= 0) continue;

      allEntries.push(item);
      allTime.uncachedInput += rawIn + cw;
      allTime.cacheWrite += cw;
      allTime.cacheRead += cr;
      allTime.totalOutput += out;
      allTime.thinkingTokens += think;
      allTime.callCount++;

      if (!dateKey) continue;
      if (dateKey === todayKey) todayEntries.push(item);
      if (min7Key && dateKey >= min7Key && dateKey <= todayKey) last7Entries.push(item);
      if (min30Key && dateKey >= min30Key && dateKey <= todayKey) last30Entries.push(item);

      let b = dayMap.get(dateKey);
      if (!b) {
        b = emptyBucketTotals(dateKey);
        dayMap.set(dateKey, b);
      }
      b.uncachedInput += rawIn + cw;
      b.cacheWrite += cw;
      b.cacheRead += cr;
      b.totalOutput += out;
      b.thinkingTokens += think;
      b.callCount++;
    }

    finalizeBucketTotals(allTime);
    for (const b of dayMap.values()) finalizeBucketTotals(b);

    const buildWindow = (numDays) => {
      const series = [];
      const totals = emptyBucketTotals();
      for (let i = numDays - 1; i >= 0; i--) {
        const dk = shiftLocalDateKey(todayKey, -i);
        const existing = dk ? dayMap.get(dk) : null;
        const dayObj = existing ? { ...existing } : emptyBucketTotals(dk);
        series.push(dayObj);
        totals.uncachedInput += dayObj.uncachedInput;
        totals.cacheWrite += dayObj.cacheWrite;
        totals.cacheRead += dayObj.cacheRead;
        totals.totalOutput += dayObj.totalOutput;
        totals.thinkingTokens += dayObj.thinkingTokens;
        totals.callCount += dayObj.callCount;
      }
      finalizeBucketTotals(totals);
      return { series, totals };
    };

    const w7 = buildWindow(7);
    const w14 = buildWindow(14);
    const w30 = buildWindow(30);
    const today = dayMap.get(todayKey) ? { ...dayMap.get(todayKey) } : emptyBucketTotals(todayKey);
    const days = Array.from(dayMap.values()).sort((a, b) => b.date.localeCompare(a.date));

    return {
      todayKey,
      today,
      last7Days: w7.series,
      last7DaysTotals: w7.totals,
      last14Days: w14.series,
      last14DaysTotals: w14.totals,
      last30DaysTotals: w30.totals,
      allTimeTotals: allTime,
      modelsByScope: {
        today: summarizeModelUsage(todayEntries),
        last7d: summarizeModelUsage(last7Entries),
        last30d: summarizeModelUsage(last30Entries),
        all: summarizeModelUsage(allEntries)
      },
      days
    };
  }

  function formatTokens(n) {
    const v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    if (v >= 1000000) return (v / 1000000).toFixed(v >= 10000000 ? 1 : 2).replace(/\.0+$/, '') + 'M';
    if (v >= 1000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'K';
    return String(Math.round(v));
  }

  function formatDurationSec(sec) {
    const v = Number(sec);
    if (sec === null || sec === undefined || !Number.isFinite(v) || v < 0) return '—';
    if (v < 10) return v.toFixed(2).replace(/0$/, '') + 's';
    if (v < 60) return v.toFixed(1) + 's';
    const mins = Math.floor(v / 60);
    const rem = Math.round(v % 60);
    return `${mins}m ${rem}s`;
  }

  const exportsObj = {
    parseDurationSec,
    parseTimestampMs,
    mergeTimeIntervals,
    empty,
    add,
    measure,
    sanitizePreviewText,
    analyzeSteps,
    normalizeCallInputCacheTokens,
    computeCacheReadStats,
    summarizeCacheReadStats,
    classifyRequestError,
    summarize,
    extractGeneratorMaxStep,
    isCheckpointNewerThanGenerator,
    buildPostCompactSummary,
    parseGeneratorCall,
    isValidSpeedSample,
    summarizeSessionSpeed,
    summarizeTurnTiming,
    computeContextSegments,
    formatLocalDateKey,
    summarizeSessionTotals,
    summarizeModelUsage,
    summarizeDailyUsage,
    formatTokens,
    formatDurationSec
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exportsObj;
  }
  if (root && typeof root === 'object') {
    root.__AGContextMeterCore = exportsObj;
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
