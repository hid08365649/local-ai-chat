function isTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function cacheHitRate(usage) {
  if (!isTokenCount(usage?.inputTokens) || usage.inputTokens === 0 ||
      !isTokenCount(usage?.cachedTokens) || usage.cachedTokens > usage.inputTokens) return null;
  return usage.cachedTokens / usage.inputTokens * 100;
}

export function summarizeUsage(messages, compaction = null) {
  const replies = messages.filter((message) => message.role === 'assistant');
  const totals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const coverage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheRate: 0 };
  let completeTurns = 0;
  let rateInputTokens = 0;
  let rateCachedTokens = 0;

  for (const { usage } of replies) {
    for (const key of Object.keys(totals)) {
      if (isTokenCount(usage?.[key])) {
        totals[key] += usage[key];
        coverage[key]++;
      }
    }
    if (cacheHitRate(usage) !== null) {
      rateInputTokens += usage.inputTokens;
      rateCachedTokens += usage.cachedTokens;
      coverage.cacheRate++;
    }
    if (isTokenCount(usage?.inputTokens) && isTokenCount(usage?.outputTokens) &&
        isTokenCount(usage?.cachedTokens) && usage.cachedTokens <= usage.inputTokens) completeTurns++;
  }

  const latestUsage = replies.at(-1)?.usage ?? null;
  const latestWindowTokens = isTokenCount(latestUsage?.inputTokens) && isTokenCount(latestUsage?.outputTokens)
    ? latestUsage.inputTokens + latestUsage.outputTokens : null;

  const summaryEvents = compaction?.usageEvents ?? [];
  const summaryTotals = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  const summaryCoverage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const event of summaryEvents) {
    for (const key of Object.keys(summaryTotals)) {
      if (isTokenCount(event.usage?.[key])) {
        summaryTotals[key] += event.usage[key];
        summaryCoverage[key]++;
      }
    }
  }
  const allTotals = Object.fromEntries(Object.keys(totals).map((key) => [key, totals[key] + summaryTotals[key]]));
  let allRateInput = rateInputTokens;
  let allRateCached = rateCachedTokens;
  for (const event of summaryEvents) {
    if (cacheHitRate(event.usage) !== null) {
      allRateInput += event.usage.inputTokens;
      allRateCached += event.usage.cachedTokens;
    }
  }

  return {
    totalTurns: replies.length,
    completeTurns,
    totals,
    coverage,
    cacheRate: rateInputTokens > 0 ? rateCachedTokens / rateInputTokens * 100 : null,
    latestWindowTokens,
    summaryEvents: summaryEvents.length,
    summaryTotals,
    summaryCoverage,
    allTotals,
    allCacheRate: allRateInput > 0 ? allRateCached / allRateInput * 100 : null,
  };
}
