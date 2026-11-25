'use strict';
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('os');
const path = require('path');

const { collect, collectTurnState, collectDailyUsage, getSettings, saveSettings, clearCachesForTest } = require('../meter-collector');

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
});
