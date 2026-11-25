'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../meter-core');

describe('meter-core', () => {
  it('parses protobuf durations and timestamps cleanly', () => {
    assert.equal(core.parseDurationSec('1.25s'), 1.25);
    assert.equal(core.parseDurationSec('250ms'), 0.25);
    assert.equal(core.parseDurationSec({ seconds: 2, nanos: 500000000 }), 2.5);
    assert.equal(core.parseDurationSec(''), null);
    assert.equal(core.parseDurationSec(-1), null);
  });

  it('summarizes context usage, speed, TTFT, and cache hit rate', () => {
    const res = core.summarize({
      chatModel: {
        modelDisplayName: 'Gemini Pro',
        timeToFirstToken: '0.8s',
        streamingDuration: '2.0s',
        usage: {
          inputTokens: 2000,
          cacheCreationInputTokens: 500,
          cacheReadTokens: 7500,
          outputTokens: 200,
          thinkingOutputTokens: 50
        },
        chatStartMetadata: {
          contextWindowMetadata: {
            maxContextTokens: 100000,
            estimatedTokensUsed: 9800
          }
        }
      }
    });

    assert.equal(res.model, 'Gemini Pro');
    assert.equal(res.actual, 10200);
    assert.equal(res.used, 10200);
    assert.equal(res.budget, 100000);
    assert.equal(res.remaining, 89800);
    assert.equal(Number(res.percent.toFixed(1)), 10.2);
    assert.equal(res.cached, 7500);
    assert.equal(res.uncachedInput, 2500);
    assert.equal(res.cacheHitRate, 75);
    assert.equal(res.speed.ttft, 0.8);
    assert.equal(res.speed.streamingSec, 2);
    assert.equal(res.speed.streamingTps, 100);
    assert.equal(res.speed.displayTps, 100);
    assert.equal(res.speed.phase, 'settled');
  });

  it('handles warming stream phase without false settled speed', () => {
    const res = core.summarize({
      chatModel: {
        timeToFirstToken: '0.5s',
        streamingDuration: '0.1s',
        usage: { inputTokens: 1000, outputTokens: 4 }
      }
    });
    assert.equal(res.speed.phase, 'warming');
    assert.equal(res.speed.isWarmingStream, true);
    assert.equal(res.speed.displayTps, null);
  });

  it('never fabricates 0% cache hit when both input and cache fields are missing', () => {
    const missing = core.computeCacheReadStats({ outputTokens: 120 });
    assert.equal(missing.cacheStatus, 'missing');
    assert.equal(missing.cacheReadPct, null);

    const zeroCache = core.computeCacheReadStats({ inputTokens: 1000 });
    assert.equal(zeroCache.cacheStatus, 'zero_cache');
    assert.equal(zeroCache.cacheReadPct, 0);

    const summary = core.summarizeCacheReadStats([
      { inputTokens: 1000, cacheReadTokens: 3000 },
      { inputTokens: 2000, cacheReadTokens: 0 },
      { outputTokens: 50 }
    ]);
    assert.equal(summary.totalInput, 6000);
    assert.equal(summary.totalCacheRead, 3000);
    assert.equal(summary.cacheReadPct, 50);
    assert.equal(summary.evaluatedRequestCount, 2);
    assert.equal(summary.cacheHitRequestCount, 1);
  });

  it('computes session average speed from valid final calls', () => {
    const calls = [
      core.parseGeneratorCall({
        invocationId: 'c1',
        chatModel: {
          timeToFirstToken: '0.5s',
          streamingDuration: '2.0s',
          usage: { inputTokens: 500, cacheReadTokens: 1500, outputTokens: 100 }
        }
      }),
      core.parseGeneratorCall({
        invocationId: 'c2',
        chatModel: {
          timeToFirstToken: '1.5s',
          streamingDuration: '2.0s',
          usage: { inputTokens: 500, cacheReadTokens: 1500, outputTokens: 200 }
        }
      })
    ];
    const stats = core.summarizeSessionSpeed(calls);
    assert.equal(stats.count, 2);
    assert.equal(stats.avgStreamTps, 75);
    assert.equal(stats.avgTps, 75);
    assert.equal(stats.medianTtftSec, 1);
  });

  it('detects context overflow and post-compact summary', () => {
    const errRes = core.summarize({
      chatModel: {
        retryInfos: [{ error: 'Prompt is too long: exceeds maximum context limit 200,000 tokens' }]
      }
    });
    assert.equal(errRes.exceeded, true);
    assert.equal(errRes.status, 'exceeded');
    assert.equal(errRes.serviceLimit, 200000);

    const steps = [
      { userInput: { userResponse: 'hello world' } },
      { plannerResponse: { response: 'hi there' } },
      { checkpoint: { sessionSummary: 'short summary' } }
    ];
    const session = core.analyzeSteps(steps);
    assert.equal(session.lastCheckpointIndex, 2);
    assert.equal(core.isCheckpointNewerThanGenerator(session, { stepIndices: [1] }, null), true);
    const post = core.buildPostCompactSummary({
      session,
      previousLatest: { budget: 100000, model: 'Gemini Pro' }
    });
    assert.equal(post.compacted, true);
    assert.equal(post.status, 'compacted');
    assert.ok(post.used > 0 && post.used < 1000);
  });

  it('computes context bar segments accurately', () => {
    const seg = core.computeContextSegments({
      cached: 50000,
      rawInput: 10000,
      cacheWrite: 10000,
      output: 5000
    }, 100000);
    assert.equal(seg.cacheReadPct, 50);
    assert.equal(seg.uncachedInputPct, 10);
    assert.equal(seg.cacheWritePct, 10);
    assert.equal(seg.outputPct, 5);
    assert.equal(seg.freePct, 25);
    assert.equal(seg.thresholdLevel, 'warning');
  });

  it('summarizes session cumulative totals and daily usage with gap filling', () => {
    const dateKey = core.formatLocalDateKey(new Date(2026, 10, 25, 14, 0, 0));
    assert.equal(dateKey, '2026-11-25');

    const calls = [
      core.parseGeneratorCall({
        invocationId: 'c1',
        createdAt: '2026-11-25T10:00:00',
        chatModel: { modelDisplayName: 'Gemini 4 Neon', usage: { inputTokens: 1000, cacheCreationInputTokens: 200, cacheReadTokens: 3800, outputTokens: 500, thinkingOutputTokens: 100 } }
      }),
      core.parseGeneratorCall({
        invocationId: 'c2',
        createdAt: '2026-11-24T09:00:00',
        chatModel: { modelDisplayName: 'Claude Opus 5.5', usage: { inputTokens: 500, cacheReadTokens: 1500, outputTokens: 300 } }
      })
    ];

    const st = core.summarizeSessionTotals(calls);
    assert.equal(st.callCount, 2);
    assert.equal(st.uncachedInput, 1700);
    assert.equal(st.cacheRead, 5300);
    assert.equal(st.totalInput, 7000);
    assert.equal(st.totalOutput, 800);
    assert.equal(st.totalTokens, 7800);

    const byModel = core.summarizeModelUsage(calls);
    assert.equal(byModel.length, 2);
    assert.equal(byModel[0].model, 'Gemini 4 Neon');
    assert.equal(byModel[0].totalTokens, 5500);
    assert.equal(byModel[0].sharePct, 70.5);
    assert.equal(byModel[1].model, 'Claude Opus 5.5');
    assert.equal(byModel[1].totalTokens, 2300);

    const daily = core.summarizeDailyUsage(calls, { todayKey: '2026-11-25' });
    assert.equal(daily.today.totalTokens, 5500);
    assert.equal(daily.today.cacheReadPct, 76);
    assert.equal(daily.last7Days.length, 7);
    assert.equal(daily.last14Days.length, 14);
    assert.equal(daily.last7DaysTotals.totalTokens, 7800);
    assert.equal(daily.last30DaysTotals.totalTokens, 7800);
    assert.equal(daily.allTimeTotals.totalTokens, 7800);
    assert.equal(daily.modelsByScope.today.length, 1);
    assert.equal(daily.modelsByScope.all.length, 2);
    assert.equal(daily.days.length, 2);
  });
});
