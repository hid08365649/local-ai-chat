import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './index.mjs';
import { createConversationStore, newConversation } from './conversations.mjs';
import { ProviderError } from './providers/deepseek.mjs';
import { activeSummary, compactionState, contextUsage, contextWithSummary, generateSummary, shouldAutoCompact, undoSummary } from './compaction.mjs';

function filledConversation() {
  const conversation = newConversation('first');
  for (let index = 0; index < 11; index++) {
    conversation.messages.push({ role: 'user', content: `问题${index}` });
    conversation.messages.push({ role: 'assistant', content: `回答${index}`,
      usage: { inputTokens: 13000, outputTokens: 10, cachedTokens: 0 } });
  }
  return conversation;
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function request(base, id, method, suffix, body) {
  const response = await fetch(`${base}/api/conversations/${id}/${suffix}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

test('summary versions keep a continuous original-message tail after undo', async () => {
  const conversation = filledConversation();
  const inputs = [];
  const provider = { summarize: async (input) => {
    inputs.push(input);
    return { text: `摘要${inputs.length}`, usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 } };
  } };
  const first = await generateSummary(conversation, provider);
  assert.equal(first.coveredMessageCount, 2);
  assert.equal(contextWithSummary(conversation, { role: 'user', content: '继续' }).messages[1].content, '问题1');
  conversation.messages.push({ role: 'user', content: '新问题' }, { role: 'assistant', content: '新回答' });
  const second = await generateSummary(conversation, provider);
  assert.equal(second.coveredMessageCount, 4);
  assert.equal(inputs[1].previousSummary, '摘要1');
  assert.equal(undoSummary(conversation), true);
  assert.equal(activeSummary(conversation).id, first.id);
  assert.equal(contextWithSummary(conversation, { role: 'user', content: '继续' }).messages[1].content, '问题1');
  assert.equal(compactionState(conversation).thresholdRatio, 0.7);
  assert.equal(compactionState(conversation).usageEvents.length, 2);
});

test('manual generate, edit, and undo persist versions and usage through HTTP', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-summary-test-'));
  const store = createConversationStore(path.join(directory, 'conversations'));
  const conversation = filledConversation();
  await store.save(conversation);
  const calls = [];
  const server = createApp({ conversationStore: store, log: () => {}, modelProvider: {
    summarize: async (input) => {
      calls.push(input);
      return { text: '当前目标：继续学习', usage: { inputTokens: 90, outputTokens: 15, cachedTokens: 30 } };
    },
    reply: async () => ({ text: '好', usage: { inputTokens: 10, outputTokens: 2, cachedTokens: 0 } }),
  } });
  try {
    const base = await start(server);
    const settings = await request(base, conversation.id, 'PUT', 'summary/settings', {
      thresholdRatio: 0.7, maxContextTokens: null, supplementalInstructions: '保留代码路径',
    });
    assert.equal(settings.status, 200);
    const generated = await request(base, conversation.id, 'POST', 'summary');
    assert.equal(generated.status, 200);
    assert.equal(generated.body.activeSummary.coveredMessageCount, 2);
    assert.equal(calls[0].supplementalInstructions, '保留代码路径');
    const edited = await request(base, conversation.id, 'PUT', 'summary', { summary: '手工修正' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.compaction.versions.length, 2);
    const undoneEdit = await request(base, conversation.id, 'DELETE', 'summary');
    assert.equal(undoneEdit.body.activeSummary.summary, '当前目标：继续学习');
    const undoneGenerated = await request(base, conversation.id, 'DELETE', 'summary');
    assert.equal(undoneGenerated.body.activeSummary, null);
    assert.equal(undoneGenerated.body.compaction.thresholdRatio, 0.7);
    assert.equal(undoneGenerated.body.compaction.usageEvents.length, 1);
    const saved = await store.get(conversation.id);
    assert.equal(saved.messages.length, 22);
    assert.equal(saved.compaction.versions.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('automatic compression runs after reply and only once for the same turn', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-auto-test-'));
  const store = createConversationStore(path.join(directory, 'conversations'));
  const conversation = filledConversation();
  compactionState(conversation).thresholdRatio = 0.1;
  compactionState(conversation).maxContextTokens = 1000;
  assert.equal(shouldAutoCompact(conversation, contextUsage(conversation, 1000)), true);
  await store.save(conversation);
  let sent;
  let summaryCalls = 0;
  const server = createApp({ conversationStore: store, contextWindowTokens: 1000, log: () => {}, modelProvider: {
    summarize: async () => {
      summaryCalls++;
      return { text: '前情摘要', usage: { inputTokens: 90, outputTokens: 15, cachedTokens: 30 } };
    },
    reply: async (messages) => {
      sent = messages;
      return { text: '继续', usage: { inputTokens: 100, outputTokens: 8, cachedTokens: 20 } };
    },
  } });
  try {
    const base = await start(server);
    const response = await fetch(`${base}/api/chat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, message: '下一步' }) });
    assert.equal(response.status, 200);
    assert.equal(sent[0].content, '问题0');
    assert.equal(sent.at(-1).content, '下一步');
    assert.equal(summaryCalls, 0);
    const replyBody = await response.json();
    assert.equal(replyBody.contextUsage.overThreshold, true);
    const compacted = await request(base, conversation.id, 'POST', 'summary/auto');
    assert.equal(compacted.status, 200);
    assert.equal(compacted.body.autoCompacted, true);
    assert.equal(summaryCalls, 1);
    const repeated = await request(base, conversation.id, 'POST', 'summary/auto');
    assert.equal(repeated.body.autoCompacted, false);
    assert.equal(summaryCalls, 1);
    const saved = await store.get(conversation.id);
    assert.equal(saved.compaction.versions[0].kind, 'automatic');
    assert.equal(saved.messages.length, 24);
    if (compacted.body.contextUsage.overThreshold) {
      saved.messages.push({ role: 'user', content: '新问题' }, { role: 'assistant', content: '新回答' });
      assert.equal(shouldAutoCompact(saved, contextUsage(saved, 1000)), false);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('a later failed summary batch preserves spent usage without replacing the active summary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-summary-failure-'));
  const store = createConversationStore(path.join(directory, 'conversations'));
  const conversation = filledConversation();
  conversation.messages.unshift(...Array.from({ length: 6 }, (_, index) => ({
    role: index % 2 ? 'assistant' : 'user', content: '长'.repeat(4000),
  })));
  await store.save(conversation);
  let calls = 0;
  const server = createApp({ conversationStore: store, log: () => {}, modelProvider: {
    summarize: async () => {
      calls++;
      if (calls === 2) throw new Error('simulated provider failure');
      return { text: '部分摘要', usage: { inputTokens: 500, outputTokens: 50, cachedTokens: 100 } };
    },
  } });
  try {
    const base = await start(server);
    const result = await request(base, conversation.id, 'POST', 'summary');
    assert.equal(result.status, 500);
    const saved = await store.get(conversation.id);
    assert.equal(saved.compaction.activeVersionId, null);
    assert.equal(saved.compaction.versions.length, 0);
    assert.equal(saved.compaction.usageEvents.length, 1);
    assert.equal(saved.compaction.usageEvents[0].usage.inputTokens, 500);
    assert.equal(saved.messages.length, 28);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('large recent messages can be summarized before the 20-message count limit', async () => {
  const conversation = newConversation('大消息');
  for (let index = 0; index < 10; index++) {
    conversation.messages.push({ role: 'user', content: '问'.repeat(4000) });
    conversation.messages.push({ role: 'assistant', content: '答'.repeat(4000) });
  }
  assert.equal(shouldAutoCompact(conversation, contextUsage(conversation, 1000)), true);
  const version = await generateSummary(conversation, { summarize: async () => ({
    text: '精简摘要', usage: { inputTokens: 100, outputTokens: 10, cachedTokens: 0 },
  }) });
  assert.equal(version.coveredMessageCount, 14);
  const context = contextWithSummary(conversation, { role: 'user', content: '继续' });
  assert.equal(context.omittedMessages, 0);
});

test('per-conversation threshold and capacity reject values beyond the model', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-settings-test-'));
  const store = createConversationStore(path.join(directory, 'conversations'));
  const conversation = filledConversation();
  await store.save(conversation);
  const server = createApp({ conversationStore: store, contextWindowTokens: 8000, log: () => {} });
  try {
    const base = await start(server);
    const valid = await request(base, conversation.id, 'PUT', 'summary/settings', {
      thresholdRatio: 0.1, maxContextTokens: 4000, supplementalInstructions: '',
    });
    assert.equal(valid.status, 200);
    assert.equal(valid.body.contextUsage.maxContextTokens, 4000);
    assert.equal(valid.body.contextUsage.thresholdTokens, 400);
    assert.equal((await request(base, conversation.id, 'PUT', 'summary/settings', {
      thresholdRatio: 0.09, maxContextTokens: 4000, supplementalInstructions: '',
    })).status, 400);
    assert.equal((await request(base, conversation.id, 'PUT', 'summary/settings', {
      thresholdRatio: 0.7, maxContextTokens: 9000, supplementalInstructions: '',
    })).status, 400);
    assert.equal((await store.get(conversation.id)).compaction.maxContextTokens, 4000);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('summary immediately updates the current context estimate without clearing usage', async () => {
  const conversation = filledConversation();
  conversation.messages[0].content = '旧内容'.repeat(1000);
  conversation.messages[1].content = '旧回答'.repeat(1000);
  const before = contextUsage(conversation, 10000);
  await generateSummary(conversation, { summarize: async () => ({
    text: '短摘要', usage: { inputTokens: 200, outputTokens: 20, cachedTokens: 10 },
  }) });
  const after = contextUsage(conversation, 10000);
  assert.ok(after.estimatedTokens < before.estimatedTokens);
  assert.ok(after.percent < before.percent);
  assert.equal(compactionState(conversation).usageEvents.length, 1);
});

test('a model context overflow compacts old text and retries once', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-overflow-test-'));
  const store = createConversationStore(path.join(directory, 'conversations'));
  const conversation = filledConversation();
  await store.save(conversation);
  const sent = [];
  const server = createApp({ conversationStore: store, contextWindowTokens: 1000, log: () => {}, modelProvider: {
    reply: async (messages) => {
      sent.push(messages);
      if (sent.length === 1) throw new ProviderError('provider_context_overflow', 413);
      return { text: '成功', usage: { inputTokens: 80, outputTokens: 10, cachedTokens: 0 } };
    },
    summarize: async () => ({ text: '已整理', usage: { inputTokens: 90, outputTokens: 12, cachedTokens: 0 } }),
  } });
  try {
    const base = await start(server);
    const response = await fetch(`${base}/api/chat`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: conversation.id, message: '继续' }) });
    assert.equal(response.status, 200);
    assert.equal(sent.length, 2);
    assert.match(sent[1][0].content, /已整理/);
    const saved = await store.get(conversation.id);
    assert.equal(saved.messages.at(-1).content, '成功');
    assert.equal(saved.compaction.versions.length, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});
