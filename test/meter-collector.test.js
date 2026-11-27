'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('os');
const path = require('path');

const { collect, collectTurnState, collectDailyUsage, collectQuotaSummary, getSettings, saveSettings, appendExternalUsageRecord, readExternalUsageLog, clearCachesForTest } = require('../meter-collector');
const { registerMeterIpcHandlers, buildCollectorOptions } = require('../meter-main');

describe('meter-collector', () => {
  let server;
  let origin;
  let tmpDir;
  let tokenVersion = 1;
  const cascadeId = '11111111-2222-3333-4444-555555555555';
  const cascadeId2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const now = new Date();
  const todayIso = now.toISOString();
  const yesterdayIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  beforeEach(async () => {
    clearCachesForTest();
    tokenVersion = 1;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-col-'));
    server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script>window.__APP_CONFIG__ = ${JSON.stringify({ csrfToken: 'tok-' + tokenVersion })};</script>`);
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/exa.language_server_pb.LanguageServerService/')) {
        const expected = 'tok-' + tokenVersion;
        if (req.headers['x-codeium-csrf-token'] !== expected) {
          res.writeHead(401);
          res.end('unauthorized');
          return;
        }
        const method = req.url.split('/').pop();
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (method === 'GetCascadeTrajectory') {
            const isSecond = parsed.cascadeId === cascadeId2;
            res.end(JSON.stringify({
              status: 'CASCADE_RUN_STATUS_IDLE',
              lastModifiedTime: todayIso,
              numTotalSteps: isSecond ? 2 : 3,
              numTotalGeneratorMetadata: isSecond ? 1 : 3,
              trajectory: {
                steps: isSecond
                  ? [
                    { userInput: { userResponse: 'Second conv' }, metadata: { createdAt: todayIso } },
                    { plannerResponse: { response: 'Reply 2' }, metadata: { createdAt: todayIso } }
                  ]
                  : [
                    { userInput: { userResponse: 'Explain context window' }, metadata: { createdAt: todayIso } },
                    { plannerResponse: { response: 'Sure, here is an overview.', thinking: 'thinking...' }, metadata: { createdAt: todayIso, completedAt: todayIso } }
                  ]
              }
            }));
          } else if (method === 'GetCascadeTrajectorySteps') {
            const offset = Number(parsed.stepOffset || 0);
            const all = parsed.cascadeId === cascadeId2
              ? [
                { userInput: { userResponse: 'Yesterday prompt' }, metadata: { createdAt: yesterdayIso } },
                { plannerResponse: { response: 'Yesterday reply' }, metadata: { createdAt: yesterdayIso } },
                { userInput: { userResponse: 'Today prompt' }, metadata: { createdAt: todayIso } },
                { plannerResponse: { response: 'Today reply' }, metadata: { createdAt: todayIso } }
              ]
              : [
                { userInput: { userResponse: 'Explain context window' }, metadata: { createdAt: todayIso } },
                { plannerResponse: { response: 'Sure, here is an overview.', thinking: 'thinking...' }, metadata: { createdAt: todayIso, completedAt: todayIso } },
                { plannerResponse: { response: 'Done.' }, metadata: { createdAt: todayIso, completedAt: todayIso } }
              ];
            res.end(JSON.stringify({ steps: all.slice(offset) }));
          } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            if (parsed.cascadeId === cascadeId2) {
              res.end(JSON.stringify({
                generatorMetadata: [
                  {
                    invocationId: 'conv2-call1-yesterday',
                    stepIndices: [1],
                    chatModel: {
                      modelDisplayName: 'Gemini Pro',
                      timeToFirstToken: '0.5s',
                      streamingDuration: '1.0s',
                      usage: { inputTokens: 2000, cacheReadTokens: 6000, outputTokens: 200 }
                    }
                  },
                  {
                    invocationId: 'conv2-call2-today',
                    stepIndices: [3],
                    chatModel: {
                      modelDisplayName: 'Gemini Pro',
                      timeToFirstToken: '0.4s',
                      streamingDuration: '0.8s',
                      usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 100 }
                    }
                  }
                ]
              }));
              return;
            }
            const allGm = [
              {
                invocationId: 'conv1-call1',
                stepIndices: [1],
                chatModel: {
                  modelDisplayName: 'Gemini Pro',
                  timeToFirstToken: '0.6s',
                  streamingDuration: '1.5s',
                  usage: { inputTokens: 1000, cacheReadTokens: 4000, outputTokens: 150 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } }
                }
              },
              {
                invocationId: 'conv1-call2',
                stepIndices: [2],
                chatModel: {
                  modelDisplayName: 'Gemini Pro',
                  timeToFirstToken: '0.4s',
                  streamingDuration: '1.0s',
                  usage: { inputTokens: 1000, cacheReadTokens: 9000, outputTokens: 100 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } }
                }
              },
              {
                invocationId: 'conv1-call3',
                stepIndices: [2],
                chatModel: {
                  modelDisplayName: 'Gemini Pro',
                  systemPrompt: 'You are helpful.',
                  tools: [{ name: 'read_file' }],
                  timeToFirstToken: '0.4s',
                  streamingDuration: '1.0s',
                  usage: { inputTokens: 500, cacheReadTokens: 4500, outputTokens: 50 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } }
                }
              }
            ];
            const off = Number(parsed.generatorMetadataOffset || 0);
            const limit = off === 0 ? 2 : 2;
            res.end(JSON.stringify({
              numTotalGeneratorMetadata: allGm.length,
              generatorMetadata: allGm.slice(off, off + limit)
            }));
          } else if (method === 'GetAllCascadeTrajectories') {
            res.end(JSON.stringify({
              trajectorySummaries: {
                [cascadeId]: { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 3, createdTime: todayIso, lastModifiedTime: todayIso },
                [cascadeId2]: { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 4, createdTime: yesterdayIso, lastModifiedTime: todayIso }
              }
            }));
          } else {
            res.end('{}');
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise(r => server.close(r));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('paginates all generator metadata and computes full sessionTotals', async () => {
    const res = await collect(origin, cascadeId, { force: true, stateDir: tmpDir });
    assert.equal(res.conversation, cascadeId);
    assert.equal(res.session.steps, 3);
    assert.equal(res.generatorCount, 3);
    assert.equal(res.recentCalls.length, 3);
    assert.equal(res.sessionTotals.callCount, 3);
    assert.equal(res.sessionTotals.totalInput, 20000);
    assert.equal(res.sessionTotals.totalOutput, 300);
    assert.equal(res.sessionTotals.totalTokens, 20300);
    assert.equal(res.sessionModels.length, 1);
    assert.equal(res.sessionModels[0].model, 'Gemini Pro');
    assert.equal(res.sessionModels[0].callCount, 3);
    assert.equal(res.latest.actual, 5050);
  });

  it('deduplicates repeated scans and attributes multi-day conversations by step timestamps', async () => {
    // Seed legacy v1 ledger to verify automatic v2 migration
    fs.writeFileSync(path.join(tmpDir, 'usage-ledger.json'), JSON.stringify({
      version: 1,
      syncedTrajectories: { [cascadeId2]: { stepCount: 4, updatedAt: todayIso } },
      calls: { stale: { date: todayIso.slice(0, 10), inputTokens: 999999, totalTokens: 999999 } }
    }));

    await collect(origin, cascadeId, { force: true, stateDir: tmpDir });
    await collect(origin, cascadeId, { force: true, stateDir: tmpDir });

    const daily = await collectDailyUsage(origin, { force: true, stateDir: tmpDir });
    assert.equal(daily.ok, true);
    assert.equal(daily.today.callCount, 4);
    assert.equal(daily.today.totalInput, 23000);
    assert.equal(daily.today.totalOutput, 400);
    assert.equal(daily.today.totalTokens, 23400);
    assert.equal(daily.days.length, 2);
    assert.equal(daily.allTimeTotals.totalTokens, 31600);
    assert.equal(daily.modelsByScope.today[0].model, 'Gemini Pro');
    assert.equal(daily.modelsByScope.all[0].totalTokens, 31600);
  });

  it('refreshes CSRF token automatically on 401 in collectTurnState', async () => {
    await collect(origin, cascadeId, { force: true, stateDir: tmpDir });
    tokenVersion = 2;
    const ts = await collectTurnState(origin, cascadeId);
    assert.equal(ts.latest.actual, 5050);
    assert.equal(ts.turnTiming.isRunning, false);
  });

  it('reads and persists settings in isolated stateDir', () => {
    const def = getSettings({ stateDir: tmpDir });
    assert.equal(def.settings.showSpeedInPill, true);
    assert.equal(def.settings.showCacheInPill, true);

    const saved = saveSettings({ showCacheInPill: false, customBudget: 128000 }, { stateDir: tmpDir });
    assert.equal(saved.ok, true);
    assert.equal(saved.settings.showCacheInPill, false);
    assert.equal(saved.settings.customBudget, 128000);

    const reloaded = getSettings({ stateDir: tmpDir });
    assert.equal(reloaded.settings.showCacheInPill, false);
    assert.equal(reloaded.settings.customBudget, 128000);
  });

  it('tracks external API calls from JSONL log and steps while JSONL takes precedence', async () => {
    const extRes = appendExternalUsageRecord({
      id: 'resp_ext_jsonl_1',
      source: 'codex-api',
      model: 'codex/gpt-6.2-sol',
      effort: 'high',
      timestamp: todayIso,
      inputTokens: 4000,
      cacheReadTokens: 6000,
      outputTokens: 800,
      thinkingTokens: 200,
      durationSec: 8.5,
      inputIncludesCache: false
    }, { stateDir: tmpDir });
    assert.equal(extRes.ok, true);
    const logEntries = readExternalUsageLog({ stateDir: tmpDir });
    assert.equal(logEntries.length, 1);
    assert.equal(logEntries[0].totalTokens, 10800);

    // Override conversation 1 response or just verify daily merge with JSONL + no host
    const dailyNoHost = await collectDailyUsage(null, { stateDir: tmpDir });
    assert.equal(dailyNoHost.today.totalTokens, 10800);
    assert.equal(dailyNoHost.modelsByScope.today[0].model, 'codex/gpt-6.2-sol');
    assert.equal(dailyNoHost.modelsByScope.today[0].isExternal, true);

    // Test JSONL overriding step-extracted record for same response_id, plus session merge
    const stepServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script>window.__APP_CONFIG__ = ${JSON.stringify({ csrfToken: 'tok-ext' })};</script>`);
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/exa.language_server_pb.LanguageServerService/')) {
        const method = req.url.split('/').pop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (method === 'GetAllCascadeTrajectories') {
          res.end(JSON.stringify({
            trajectorySummaries: {
              [cascadeId]: { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 2, createdTime: todayIso, lastModifiedTime: todayIso }
            }
          }));
        } else if (method === 'GetCascadeTrajectory') {
          res.end(JSON.stringify({
            status: 'CASCADE_RUN_STATUS_IDLE',
            lastModifiedTime: todayIso,
            numTotalSteps: 2,
            numTotalGeneratorMetadata: 1,
            trajectory: {
              steps: [
                { userInput: { userResponse: 'run codex' }, metadata: { createdAt: todayIso } },
                {
                  runCommand: {
                    output: '---\nresponse_id: resp_ext_jsonl_1\nmodel: codex/gpt-6.2-sol\neffort: high\nelapsed_s: 8.5\nusage: in=10000 out=800 reasoning=200\n' +
                            '\n---\nresponse_id: resp_ext_step_only\nmodel: codex/gpt-6.2-sol\neffort: high\nelapsed_s: 5.0\nusage: in=2000 out=500 reasoning=100\n'
                  },
                  metadata: { createdAt: todayIso }
                }
              ]
            }
          }));
        } else if (method === 'GetCascadeTrajectorySteps') {
          res.end(JSON.stringify({
            steps: [
              { userInput: { userResponse: 'run codex' }, metadata: { createdAt: todayIso } },
              {
                runCommand: {
                  output: '---\nresponse_id: resp_ext_jsonl_1\nmodel: codex/gpt-6.2-sol\neffort: high\nelapsed_s: 8.5\nusage: in=10000 out=800 reasoning=200\n' +
                          '\n---\nresponse_id: resp_ext_step_only\nmodel: codex/gpt-6.2-sol\neffort: high\nelapsed_s: 5.0\nusage: in=2000 out=500 reasoning=100\n'
                },
                metadata: { createdAt: todayIso }
              }
            ]
          }));
        } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
          res.end(JSON.stringify({
            numTotalGeneratorMetadata: 1,
            generatorMetadata: [
              {
                invocationId: 'native-1',
                stepIndices: [0],
                chatModel: {
                  modelDisplayName: 'Gemini Pro',
                  usage: { inputTokens: 1000, cacheReadTokens: 3000, outputTokens: 100 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } }
                }
              }
            ]
          }));
        } else {
          res.end('{}');
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => stepServer.listen(0, '127.0.0.1', r));
    const extOrigin = `http://127.0.0.1:${stepServer.address().port}`;
    try {
      const col = await collect(extOrigin, cascadeId, { force: true, stateDir: tmpDir });
      // Context window stays strictly on native Antigravity model (4100), not polluted by external calls
      assert.equal(col.latest.actual, 4100);
      // Session totals & models include native + both external calls (1 deduplicated via JSONL + 1 step-only)
      assert.equal(col.sessionTotals.callCount, 3);
      assert.equal(col.sessionTotals.totalTokens, 4100 + 10800 + 2500);
      const codexModel = col.sessionModels.find(m => m.model === 'codex/gpt-6.2-sol');
      assert.ok(codexModel);
      assert.equal(codexModel.isExternal, true);
      assert.equal(codexModel.callCount, 2);
      // JSONL cacheReadTokens=6000 must override step-only cacheReadTokens=0 for resp_ext_jsonl_1
      assert.equal(codexModel.cacheRead, 6000);

      const daily = await collectDailyUsage(extOrigin, { force: true, stateDir: tmpDir });
      const dailyCodex = daily.modelsByScope.today.find(m => m.model === 'codex/gpt-6.2-sol');
      assert.equal(dailyCodex.callCount, 2);
      assert.equal(dailyCodex.cacheRead, 6000);
    } finally {
      await new Promise(r => stepServer.close(r));
    }
  });

  it('short-circuits idle collectTurnState, incrementally reads JSONL, and incrementally fetches collect()', async () => {
    const rpcCounts = { GetAllCascadeTrajectories: 0, GetCascadeTrajectory: 0, GetCascadeTrajectorySteps: 0, GetCascadeTrajectoryGeneratorMetadata: 0 };
    let curSteps = [
      { userInput: { userResponse: 'step 0' }, metadata: { createdAt: todayIso } },
      { plannerResponse: { response: 'reply 1' }, metadata: { createdAt: todayIso } },
      { userInput: { userResponse: 'step 2' }, metadata: { createdAt: todayIso } },
      { plannerResponse: { response: 'reply 3' }, metadata: { createdAt: todayIso } }
    ];
    let curGm = [
      { invocationId: 'g0', stepIndices: [1], chatModel: { modelDisplayName: 'Gemini Pro', usage: { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 100 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } } } },
      { invocationId: 'g1', stepIndices: [3], chatModel: { modelDisplayName: 'Gemini Pro', usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 100 }, chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } } } }
    ];
    let curMod = '2026-11-25T10:00:00Z';
    const stepOffsetsSeen = [];

    const perfServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script>window.__APP_CONFIG__ = ${JSON.stringify({ csrfToken: 'tok-perf' })};</script>`);
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/exa.language_server_pb.LanguageServerService/')) {
        const method = req.url.split('/').pop();
        if (rpcCounts[method] !== undefined) rpcCounts[method]++;
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          const parsed = JSON.parse(body || '{}');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          if (method === 'GetAllCascadeTrajectories') {
            res.end(JSON.stringify({
              trajectorySummaries: {
                [cascadeId]: { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: curSteps.length, createdTime: todayIso, lastModifiedTime: curMod }
              }
            }));
          } else if (method === 'GetCascadeTrajectory') {
            if (Number(parsed.trajectoryVerbosity) === 0) {
              res.end(JSON.stringify({
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: curMod,
                numTotalSteps: curSteps.length,
                numTotalGeneratorMetadata: curGm.length
              }));
            } else {
              res.end(JSON.stringify({
                status: 'CASCADE_RUN_STATUS_IDLE',
                lastModifiedTime: curMod,
                numTotalSteps: curSteps.length,
                numTotalGeneratorMetadata: curGm.length,
                trajectory: { steps: curSteps, generatorMetadata: curGm }
              }));
            }
          } else if (method === 'GetCascadeTrajectorySteps') {
            const off = Number(parsed.stepOffset || 0);
            stepOffsetsSeen.push(off);
            res.end(JSON.stringify({ steps: curSteps.slice(off) }));
          } else if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
            const off = Number(parsed.generatorMetadataOffset || 0);
            res.end(JSON.stringify({ numTotalGeneratorMetadata: curGm.length, generatorMetadata: curGm.slice(off) }));
          } else {
            res.end('{}');
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => perfServer.listen(0, '127.0.0.1', r));
    const perfOrigin = `http://127.0.0.1:${perfServer.address().port}`;
    try {
      // 1. Cold vs cached collectTurnState short-circuit
      const ts1 = await collectTurnState(perfOrigin, cascadeId);
      assert.equal(ts1.stepCount, 4);
      assert.equal(ts1.lastModifiedTime, curMod);
      assert.equal(rpcCounts.GetCascadeTrajectorySteps, 1);
      assert.equal(rpcCounts.GetCascadeTrajectoryGeneratorMetadata, 1);

      const ts2 = await collectTurnState(perfOrigin, cascadeId);
      assert.equal(ts2.cached, true);
      assert.equal(rpcCounts.GetCascadeTrajectorySteps, 1);
      assert.equal(rpcCounts.GetCascadeTrajectoryGeneratorMetadata, 1);

      // 2. Cold collect + incremental collect when conversation grows by 1 step + 1 gm
      const c1 = await collect(perfOrigin, cascadeId, { force: true, stateDir: tmpDir });
      assert.equal(c1.sessionTotals.callCount, 2);
      assert.equal(c1.session.steps, 4);

      curSteps.push({ plannerResponse: { response: 'reply 4' }, metadata: { createdAt: todayIso } });
      curGm.push({ invocationId: 'g2', stepIndices: [4], chatModel: { modelDisplayName: 'Gemini Pro', usage: { inputTokens: 500, cacheReadTokens: 3000, outputTokens: 200 } } });
      curMod = '2026-11-25T10:01:00Z';

      // collectTurnState wakes up on changed stepCount/lastModifiedTime
      const ts3 = await collectTurnState(perfOrigin, cascadeId);
      assert.equal(ts3.cached, undefined);
      assert.equal(ts3.stepCount, 5);
      assert.equal(rpcCounts.GetCascadeTrajectorySteps, 2);

      stepOffsetsSeen.length = 0;
      const c2 = await collect(perfOrigin, cascadeId, { force: true, stateDir: tmpDir });
      assert.equal(c2.session.steps, 5);
      assert.equal(c2.sessionTotals.callCount, 3);
      assert.equal(c2.sessionTotals.totalTokens, 5200 + 3700);
      assert.equal(stepOffsetsSeen.includes(2), true);

      // 3. Incremental JSONL reading across appends
      appendExternalUsageRecord({ id: 'inc_1', model: 'codex/gpt-6.2-sol', inputTokens: 100, outputTokens: 50, timestamp: todayIso }, { stateDir: tmpDir });
      assert.equal(readExternalUsageLog({ stateDir: tmpDir }).length, 1);
      assert.equal(readExternalUsageLog({ stateDir: tmpDir }).length, 1);
      appendExternalUsageRecord({ id: 'inc_2', model: 'codex/gpt-6.2-sol', inputTokens: 200, outputTokens: 80, timestamp: todayIso }, { stateDir: tmpDir });
      const logs = readExternalUsageLog({ stateDir: tmpDir });
      assert.equal(logs.length, 2);
      assert.equal(logs[1].totalTokens, 280);
    } finally {
      await new Promise(r => perfServer.close(r));
    }
  });

  it('collects and caches 5h/weekly quota summary and persists showQuotaInPill setting', async () => {
    let quotaRpcCount = 0;
    const quotaServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<script>window.__APP_CONFIG__ = ${JSON.stringify({ csrfToken: 'tok-q' })};</script>`);
        return;
      }
      if (req.method === 'POST' && req.url.startsWith('/exa.language_server_pb.LanguageServerService/')) {
        const method = req.url.split('/').pop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (method === 'RetrieveUserQuotaSummary') {
          quotaRpcCount++;
          res.end(JSON.stringify({
            response: {
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.72, resetTime: new Date(Date.now() + 3600 * 1000).toISOString() },
                    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.45, resetTime: new Date(Date.now() + 1800 * 1000).toISOString() }
                  ]
                }
              ]
            }
          }));
        } else {
          res.end('{}');
        }
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise(r => quotaServer.listen(0, '127.0.0.1', r));
    const qOrigin = `http://127.0.0.1:${quotaServer.address().port}`;
    try {
      const q1 = await collectQuotaSummary(qOrigin);
      assert.equal(q1.ok, true);
      assert.equal(q1.groups[0].fiveHour.remainingPct, 45);
      assert.equal(q1.groups[0].weekly.remainingPct, 72);
      assert.equal(quotaRpcCount, 1);

      const q2 = await collectQuotaSummary(qOrigin);
      assert.equal(q2.groups[0].fiveHour.remainingPct, 45);
      assert.equal(quotaRpcCount, 1);

      const q3 = await collectQuotaSummary(qOrigin, { force: true });
      assert.equal(q3.ok, true);
      assert.equal(quotaRpcCount, 2);

      const s1 = getSettings({ stateDir: tmpDir });
      assert.equal(s1.settings.showQuotaInPill, true);
      const s2 = saveSettings({ showQuotaInPill: false }, { stateDir: tmpDir });
      assert.equal(s2.settings.showQuotaInPill, false);
    } finally {
      await new Promise(r => quotaServer.close(r));
    }
  });

  it('routes SSH remote sessions via sessionFetch, isolates per-host caches, and merges into unified daily ledger', async () => {
    const remoteCascadeId = '99999999-8888-7777-6666-555555555555';
    let remoteToken = 'remote-tok-1';
    let sessionFetchCalls = 0;

    const makeJsonRes = (data, status = 200) => {
      const bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
      return {
        status,
        headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(Buffer.byteLength(bodyStr, 'utf8')) : null) },
        text: async () => bodyStr
      };
    };

    const remoteSessionFetch = async (url, init = {}) => {
      sessionFetchCalls++;
      if (url.endsWith('/')) {
        return makeJsonRes(`<script>window.__APP_CONFIG__ = ${JSON.stringify({ csrfToken: null, appVersion: '2.35.2' })};</script>`);
      }
      if (init.headers?.['x-codeium-csrf-token'] !== remoteToken) {
        return makeJsonRes('unauthorized', 401);
      }
      const method = url.split('/').pop();
      const parsed = JSON.parse(init.body || '{}');
      if (method === 'GetCascadeTrajectory') {
        assert.equal(parsed.cascadeId, remoteCascadeId);
        return makeJsonRes({
          status: 'CASCADE_RUN_STATUS_IDLE',
          lastModifiedTime: todayIso,
          numTotalSteps: 2,
          numTotalGeneratorMetadata: 1,
          trajectory: {
            steps: [
              { userInput: { userResponse: 'Remote SSH prompt' }, metadata: { createdAt: todayIso } },
              { plannerResponse: { response: 'Remote reply' }, metadata: { createdAt: todayIso, completedAt: todayIso } }
            ],
            generatorMetadata: [
              {
                invocationId: 'remote-call-1',
                stepIndices: [1],
                chatModel: {
                  modelDisplayName: 'Claude Opus 4.5 (Remote)',
                  timeToFirstToken: '0.3s',
                  streamingDuration: '1.2s',
                  usage: { inputTokens: 1500, cacheReadTokens: 8000, outputTokens: 250 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
                }
              }
            ]
          }
        });
      }
      if (method === 'GetAllCascadeTrajectories') {
        return makeJsonRes({
          trajectorySummaries: {
            [remoteCascadeId]: { status: 'CASCADE_RUN_STATUS_IDLE', stepCount: 2, createdTime: todayIso, lastModifiedTime: todayIso }
          }
        });
      }
      if (method === 'GetCascadeTrajectorySteps') {
        return makeJsonRes({
          steps: [
            { userInput: { userResponse: 'Remote SSH prompt' }, metadata: { createdAt: todayIso } },
            { plannerResponse: { response: 'Remote reply' }, metadata: { createdAt: todayIso, completedAt: todayIso } }
          ]
        });
      }
      if (method === 'GetCascadeTrajectoryGeneratorMetadata') {
        return makeJsonRes({
          numTotalGeneratorMetadata: 1,
          generatorMetadata: [
            {
              invocationId: 'remote-call-1',
              stepIndices: [1],
              chatModel: {
                modelDisplayName: 'Claude Opus 4.5 (Remote)',
                timeToFirstToken: '0.3s',
                streamingDuration: '1.2s',
                usage: { inputTokens: 1500, cacheReadTokens: 8000, outputTokens: 250 },
                chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 200000 } }
              }
            }
          ]
        });
      }
      if (method === 'RetrieveUserQuotaSummary') {
        return makeJsonRes({
          response: {
            groups: [
              {
                displayName: 'Claude / GPT',
                buckets: [
                  { bucketId: 'cg-5h', window: '5h', remainingFraction: 0.6, resetTime: new Date(Date.now() + 1800 * 1000).toISOString() },
                  { bucketId: 'cg-weekly', window: 'weekly', remainingFraction: 0.85, resetTime: new Date(Date.now() + 7200 * 1000).toISOString() }
                ]
              }
            ]
          }
        });
      }
      return makeJsonRes({});
    };

    const remoteOpts = {
      force: true,
      stateDir: tmpDir,
      isRemote: true,
      originScopeKey: 'ssh:gpu-box-1',
      sessionFetch: remoteSessionFetch,
      resolveRendererCsrfToken: async () => remoteToken,
      remoteTokenRetryMs: 0
    };

    // Use exact same origin string as local server to verify isolation + unified ledger merge
    const localRes = await collect(origin, cascadeId, { force: true, stateDir: tmpDir });
    const remoteRes = await collect(origin, remoteCascadeId, remoteOpts);
    assert.equal(localRes.sessionTotals.totalTokens, 20300);
    assert.equal(remoteRes.conversation, remoteCascadeId);
    assert.equal(remoteRes.sessionTotals.callCount, 1);
    assert.equal(remoteRes.sessionTotals.totalTokens, 9750);
    assert.equal(remoteRes.latest.actual, 9750);
    assert.ok(sessionFetchCalls > 0);

    // 401 refresh re-reads renderer token on remote
    remoteToken = 'remote-tok-2';
    const remoteTs = await collectTurnState(origin, remoteCascadeId, remoteOpts);
    assert.equal(remoteTs.latest.actual, 9750);

    const remoteQuota = await collectQuotaSummary(origin, remoteOpts);
    assert.equal(remoteQuota.groups[0].fiveHour.remainingPct, 60);
    assert.equal(remoteQuota.groups[0].weekly.remainingPct, 85);

    // Daily usage collects from remote AND includes previously synced local + remote conversations in unified ledger
    const unifiedDaily = await collectDailyUsage(origin, remoteOpts);
    assert.equal(unifiedDaily.today.totalTokens, 20300 + 9750);
    assert.equal(unifiedDaily.today.callCount, 4);
    assert.ok(unifiedDaily.modelsByScope.today.some(m => m.model === 'Gemini Pro'));
    assert.ok(unifiedDaily.modelsByScope.today.some(m => m.model === 'Claude Opus 4.5 (Remote)'));

    // Re-scanning local daily usage also preserves remote entry without conflict
    const localDaily = await collectDailyUsage(origin, { force: true, stateDir: tmpDir });
    assert.equal(localDaily.today.totalTokens, 20300 + 3100 + 9750);
  });

  it('maps SSH tunnel proxy errors cleanly and blocks local fallback for remote sessions', async () => {
    await assert.rejects(
      () => collect(origin, cascadeId, { isRemote: true, originScopeKey: 'ssh:no-fetch', stateDir: tmpDir }),
      /SSH 远端会话网络通道不可用/
    );

    await assert.rejects(
      () => collect(origin, cascadeId, {
        isRemote: true,
        originScopeKey: 'ssh:dropped',
        sessionFetch: async () => { throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); },
        remoteTokenRetryMs: 0,
        stateDir: tmpDir
      }),
      /SSH 远端连接暂时不可用（ERR_PROXY_CONNECTION_FAILED）/
    );
  });

  it('detects remote Electron sessions in meter-main IPC handlers', async () => {
    const handlers = new Map();
    const fakeIpcMain = {
      handle: (ch, fn) => handlers.set(ch, fn),
      removeHandler: (ch) => handlers.delete(ch)
    };
    const defaultSes = { name: 'default' };
    const sshSes = {
      name: 'persist:ssh-host1',
      fetch: async (url, init) => {
        assert.equal(init.headers['x-codeium-csrf-token'], 'ssh-page-tok');
        assert.ok(url.endsWith('/RetrieveUserQuotaSummary'));
        return {
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            response: {
              groups: [{
                displayName: 'Gemini',
                buckets: [{ window: '5h', remainingFraction: 0.9, resetTime: new Date(Date.now() + 60000).toISOString() }]
              }]
            }
          })
        };
      }
    };

    registerMeterIpcHandlers(fakeIpcMain, {
      defaultSession: defaultSes,
      resolveRemoteBackend: (sender) => (sender?.id === 42 ? { kind: 'ssh', hostId: 'gpu-box', label: 'gpu-box' } : null)
    });

    const remoteEvent = {
      senderFrame: { url: 'https://127.0.0.1:34217/' },
      sender: {
        id: 42,
        session: sshSes,
        isDestroyed: () => false,
        executeJavaScript: async () => 'ssh-page-tok'
      }
    };
    const localEvent = {
      senderFrame: { url: 'https://127.0.0.1:52621/' },
      sender: {
        id: 7,
        session: defaultSes,
        isDestroyed: () => false,
        executeJavaScript: async () => 'local-tok'
      }
    };

    const rtRemote = await handlers.get('context-meter:runtime-info')(remoteEvent);
    assert.equal(rtRemote.isRemote, true);
    assert.equal(rtRemote.remoteHost, 'gpu-box');

    const rtLocal = await handlers.get('context-meter:runtime-info')(localEvent);
    assert.equal(rtLocal.isRemote, false);
    assert.equal(rtLocal.remoteHost, null);

    const { opts: localOpts } = buildCollectorOptions(localEvent, {}, { defaultSession: defaultSes, resolveRemoteBackend: () => null });
    assert.equal(localOpts.isRemote, undefined);
    assert.equal(typeof localOpts.sessionFetch, 'undefined');

    const quotaRes = await handlers.get('context-meter:quota')(remoteEvent, true);
    assert.equal(quotaRes.ok, true);
    assert.equal(quotaRes.groups[0].fiveHour.remainingPct, 90);
  });
});
