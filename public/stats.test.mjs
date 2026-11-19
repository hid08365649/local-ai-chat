import test from 'node:test';
import assert from 'node:assert/strict';
import { cacheHitRate, summarizeUsage } from './stats.js';

test('calculates per-turn and weighted conversation cache rates', () => {
  const messages = [
    { role: 'user', content: '一' },
    { role: 'assistant', content: '答', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 0 } },
    { role: 'user', content: '二' },
    { role: 'assistant', content: '答', usage: { inputTokens: 300, outputTokens: 30, cachedTokens: 180 } },
  ];
  const summary = summarizeUsage(messages);
  assert.equal(cacheHitRate(messages[3].usage), 60);
  assert.deepEqual(summary.totals, { inputTokens: 400, outputTokens: 50, cachedTokens: 180 });
  assert.equal(summary.cacheRate, 45);
  assert.equal(summary.latestWindowTokens, 330);
  assert.equal(summary.completeTurns, 2);
});

test('distinguishes missing historical usage from zero usage', () => {
  const summary = summarizeUsage([
    { role: 'assistant', content: '旧回复' },
    { role: 'assistant', content: '新回复', usage: { inputTokens: 100, outputTokens: 10, cachedTokens: null } },
  ]);
  assert.equal(summary.totalTurns, 2);
  assert.equal(summary.completeTurns, 0);
  assert.deepEqual(summary.coverage, { inputTokens: 1, outputTokens: 1, cachedTokens: 0, cacheRate: 0 });
  assert.equal(summary.cacheRate, null);
  assert.equal(cacheHitRate({ inputTokens: 100, cachedTokens: null }), null);
});

test('summary request usage remains in cumulative totals after a version is undone', () => {
  const summary = summarizeUsage([
    { role: 'assistant', content: '答', usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 50 } },
  ], { versions: [], activeVersionId: null, usageEvents: [
    { usage: { inputTokens: 40, outputTokens: 10, cachedTokens: 10 } },
  ] });
  assert.deepEqual(summary.allTotals, { inputTokens: 140, outputTokens: 30, cachedTokens: 60 });
  assert.equal(summary.allCacheRate, 60 / 140 * 100);
});
