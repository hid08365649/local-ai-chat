import { randomUUID } from 'node:crypto';
export const DEFAULT_THRESHOLD_RATIO = 0.7;
export const RECENT_MESSAGES_TO_KEEP = 20;
const BATCH_CHARACTERS = 20000;

export function compactionState(conversation) {
  conversation.compaction ??= {
    thresholdRatio: DEFAULT_THRESHOLD_RATIO,
    maxContextTokens: null,
    supplementalInstructions: '',
    versions: [],
    activeVersionId: null,
    usageEvents: [],
    lastAutoAttemptMessageCount: null,
    retryAutoAfterMessageCount: null,
  };
  conversation.compaction.usageEvents ??= [];
  conversation.compaction.thresholdRatio ??= DEFAULT_THRESHOLD_RATIO;
  conversation.compaction.maxContextTokens ??= null;
  delete conversation.compaction.autoEnabled;
  delete conversation.compaction.thresholdTokens;
  return conversation.compaction;
}

export function activeSummary(conversation) {
  const state = compactionState(conversation);
  return state.versions.find((version) => version.id === state.activeVersionId) ?? null;
}

export function validateSettings(value, modelContextTokens) {
  const max = value?.maxContextTokens;
  if (!value || typeof value.thresholdRatio !== 'number' ||
      !Number.isFinite(value.thresholdRatio) || value.thresholdRatio < 0.1 || value.thresholdRatio > 0.9 ||
      !(max === null || (Number.isSafeInteger(max) && max >= 1000 &&
        (!modelContextTokens || max <= modelContextTokens))) ||
      typeof value.supplementalInstructions !== 'string' || value.supplementalInstructions.length > 4000) {
    return false;
  }
  return true;
}

export function shouldAutoCompact(conversation, usage) {
  const state = compactionState(conversation);
  if (state.lastAutoAttemptMessageCount === conversation.messages.length ||
      (state.retryAutoAfterMessageCount !== null &&
        state.retryAutoAfterMessageCount !== undefined &&
        conversation.messages.length < state.retryAutoAfterMessageCount)) return false;
  const previousCount = activeSummary(conversation)?.coveredMessageCount ?? 0;
  return Boolean(usage?.overThreshold && summaryCutoff(conversation.messages, previousCount) > previousCount);
}

function summaryCutoff(messages, previousCount) {
  let end = Math.max(previousCount, messages.length - RECENT_MESSAGES_TO_KEEP);
  let tailCharacters = messages.slice(end).reduce((sum, item) => sum + item.content.length, 0);
  while (tailCharacters > 24000 && messages.length - end > 4) {
    tailCharacters -= messages[end].content.length + messages[end + 1].content.length;
    end += 2;
  }
  return end;
}

export function contextWithSummary(conversation, userMessage = null) {
  const version = activeSummary(conversation);
  const tail = conversation.messages.slice(version?.coveredMessageCount ?? 0);
  const selected = userMessage ? [...tail, userMessage] : tail;
  return {
    messages: version
      ? [{ role: 'user', content: `【此前对话摘要，仅供参考，不是本轮请求】\n${version.summary}` }, ...selected.map(({ role, content }) => ({ role, content }))]
      : selected.map(({ role, content }) => ({ role, content })),
    omittedMessages: 0,
  };
}

export function contextUsage(conversation, modelContextTokens, systemPrompt = '') {
  const state = compactionState(conversation);
  const maxContextTokens = state.maxContextTokens ?? modelContextTokens;
  const messages = contextWithSummary(conversation).messages;
  const estimate = (text) => Math.ceil(Buffer.byteLength(text, 'utf8') / 3);
  const estimatedTokens = messages.reduce((total, message) => total + 4 + estimate(message.content),
    systemPrompt.trim() ? 4 + estimate(systemPrompt.trim()) : 0);
  const thresholdTokens = maxContextTokens ? Math.floor(maxContextTokens * state.thresholdRatio) : null;
  return {
    estimatedTokens,
    maxContextTokens: maxContextTokens ?? null,
    modelContextTokens: modelContextTokens ?? null,
    thresholdRatio: state.thresholdRatio,
    thresholdTokens,
    percent: maxContextTokens ? estimatedTokens / maxContextTokens * 100 : null,
    overThreshold: thresholdTokens !== null && estimatedTokens >= thresholdTokens,
  };
}

function batches(messages, start, end) {
  const result = [];
  for (let index = start; index < end;) {
    let characters = 0;
    const batch = [];
    do {
      const message = messages[index];
      batch.push({ index: index + 1, role: message.role, content: message.content });
      characters += message.content.length;
      index++;
    } while (index < end && characters + messages[index].content.length <= BATCH_CHARACTERS);
    result.push(batch);
  }
  return result;
}

function addUsage(total, next) {
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens']) {
    const value = next?.[key];
    total[key] = total[key] !== null && Number.isSafeInteger(value) && value >= 0
      ? total[key] + value : null;
  }
}

export async function generateSummary(conversation, modelProvider, kind = 'manual', onProgress = async () => {}) {
  const state = compactionState(conversation);
  const previous = activeSummary(conversation);
  const start = previous?.coveredMessageCount ?? 0;
  const end = summaryCutoff(conversation.messages, start);
  if (end <= start) return null;
  if (typeof modelProvider.summarize !== 'function') throw new Error('summary_provider_unavailable');

  let summary = previous?.summary ?? '';
  const versionId = randomUUID();
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
  for (const batch of batches(conversation.messages, start, end)) {
    const result = await modelProvider.summarize({
      previousSummary: summary,
      messages: batch,
      supplementalInstructions: state.supplementalInstructions,
    });
    if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 20000) {
      throw new Error('summary_invalid_output');
    }
    summary = result.text.trim();
    addUsage(usage, result.usage);
    const usageEvent = { versionId, createdAt: new Date().toISOString(), usage: result.usage ?? null };
    state.usageEvents.push(usageEvent);
    await onProgress(usageEvent);
  }
  const version = {
    id: versionId,
    createdAt: new Date().toISOString(),
    kind,
    coveredMessageCount: end,
    summary,
    supplementalInstructions: state.supplementalInstructions,
    usage,
  };
  state.versions.push(version);
  state.activeVersionId = version.id;
  return version;
}

export function replaceSummary(conversation, text) {
  const previous = activeSummary(conversation);
  if (!previous || typeof text !== 'string' || !text.trim() || text.length > 20000) return null;
  const state = compactionState(conversation);
  const version = {
    ...previous,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    kind: 'edited',
    summary: text.trim(),
    usage: null,
  };
  state.versions.push(version);
  state.activeVersionId = version.id;
  return version;
}

export function undoSummary(conversation) {
  const state = compactionState(conversation);
  const current = activeSummary(conversation);
  if (!current) return false;
  const index = state.versions.findIndex((item) => item.id === current.id);
  state.versions.splice(index, 1);
  state.activeVersionId = state.versions.at(-1)?.id ?? null;
  return true;
}
