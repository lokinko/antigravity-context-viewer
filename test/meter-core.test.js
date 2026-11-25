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

  it('normalizes external JSONL usage and extracts deduplicated codex-api calls from steps', () => {
    const normCached = core.normalizeExternalUsageRecord({
      id: 'resp_cached_1',
      source: 'codex-api',
      model: 'codex/gpt-6.2-sol',
      effort: 'high',
      timestamp: '2026-11-25T12:00:00Z',
      inputTokens: 10000,
      cacheReadTokens: 4000,
      outputTokens: 1200,
      reasoningTokens: 300,
      durationSec: 12.5,
      inputIncludesCache: true
    });
    assert.equal(normCached.callId, 'ext:resp_cached_1');
    assert.equal(normCached.isExternal, true);
    assert.equal(normCached.uncachedInput, 6000);
    assert.equal(normCached.cacheReadTokens, 4000);
    assert.equal(normCached.totalInput, 10000);
    assert.equal(normCached.totalTokens, 11200);
    assert.equal(normCached.cacheReadPct, 40);

    const normUncached = core.normalizeExternalUsageRecord({
      callId: 'ext:resp_uncached_2',
      source: 'codex-api',
      model: 'codex/gpt-6.2-sol',
      inputTokens: 2000,
      cacheReadTokens: 3000,
      outputTokens: 500,
      inputIncludesCache: false
    });
    assert.equal(normUncached.totalInput, 5000);
    assert.equal(normUncached.uncachedInput, 2000);
    assert.equal(normUncached.totalTokens, 5500);

    const steps = [
      {
        runCommand: {
          commandLine: 'node codex_api.mjs --prompt hi',
          combinedOutput: {
            full: 'Answer line 1\n---\nresponse_id: resp_abc123456\nmodel: codex/gpt-6.2-sol\neffort: high\nelapsed_s: 15.2\nusage: in=12000 out=1500 reasoning=400\n'
          }
        },
        metadata: { createdAt: '2026-11-24T10:00:00Z' }
      },
      {
        // Echoed in a later plannerResponse on the next day: should deduplicate and keep earliest timestamp
        plannerResponse: {
          response: 'Result:\n---\nresponse_id: resp_abc123456\nmodel: codex/gpt-6.2-sol\neffort: high\nelapsed_s: 15.2\nusage: in=12000 out=1500 reasoning=400\n'
        },
        metadata: { createdAt: '2026-11-25T10:00:00Z' }
      },
      {
        // Diff content must be ignored to avoid malformed JSON-escaped diff noise
        codeAction: {
          unifiedDiff: '---\nresponse_id: resp_fake_diff_999\nmodel: codex/gpt-6.2-sol","type":"DIFF"\nusage: in=999999 out=999\n'
        },
        metadata: { createdAt: '2026-11-25T11:00:00Z' }
      }
    ];

    const extracted = core.extractExternalApiCallsFromSteps(steps);
    assert.equal(extracted.length, 1);
    assert.equal(extracted[0].callId, 'ext:resp_abc123456');
    assert.equal(extracted[0].model, 'codex/gpt-6.2-sol');
    assert.equal(extracted[0].dateKey, '2026-11-24');
    assert.equal(extracted[0].totalInput, 12000);
    assert.equal(extracted[0].outputTokens, 1500);
    assert.equal(extracted[0].thinkingTokens, 400);
    assert.equal(extracted[0].totalTokens, 13500);

    const models = core.summarizeModelUsage(extracted);
    assert.equal(models.length, 1);
    assert.equal(models[0].isExternal, true);
    assert.equal(models[0].source, 'codex-api');
  });

  it('parses 5h and weekly quota summary, matches model groups, and formats countdowns', () => {
    assert.equal(core.formatCountdownSec(null), '—');
    assert.equal(core.formatCountdownSec(45), '<1m');
    assert.equal(core.formatCountdownSec(1500), '25m');
    assert.equal(core.formatCountdownSec(9000), '2h 30m');
    assert.equal(core.formatCountdownSec(6 * 86400 + 3600), '6d 1h');

    const nowMs = Date.parse('2026-11-25T09:00:00Z');
    const parsed = core.parseQuotaSummary({
      response: {
        groups: [
          {
            displayName: 'Gemini Models',
            description: 'Gemini 4 Neon, Gemini 3.8 Flash',
            buckets: [
              { bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.6338, resetTime: '2026-12-01T09:00:00Z' },
              { bucketId: 'gemini-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 0.4905, resetTime: '2026-11-25T11:30:00Z' }
            ]
          },
          {
            displayName: 'Claude and GPT models',
            description: 'Claude Opus 5.5, Claude Sonnet 5.5',
            buckets: [
              { bucketId: '3p-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.5334, resetTime: '2026-12-01T10:00:00Z' },
              { bucketId: '3p-5h', displayName: 'Five Hour Limit Remaining', window: '5h', remainingFraction: 1, resetTime: '2026-11-25T14:00:00Z' }
            ]
          }
        ]
      }
    }, nowMs);

    assert.equal(parsed.groups.length, 2);
    assert.equal(parsed.groups[0].key, 'gemini');
    assert.equal(parsed.groups[0].fiveHour.remainingPct, 49);
    assert.equal(parsed.groups[0].fiveHour.resetInSec, 9000);
    assert.equal(parsed.groups[0].weekly.remainingPct, 63.4);
    assert.equal(parsed.groups[1].key, 'third_party');
    assert.equal(parsed.groups[1].fiveHour.remainingPct, 100);

    assert.equal(core.pickQuotaGroupForModel(parsed, 'Gemini 4 Neon (High)')?.key, 'gemini');
    assert.equal(core.pickQuotaGroupForModel(parsed, 'Claude Opus 5.5 (High)')?.key, 'third_party');
    assert.equal(core.pickQuotaGroupForModel(parsed, 'Unknown Model')?.key, 'gemini');
  });
});
