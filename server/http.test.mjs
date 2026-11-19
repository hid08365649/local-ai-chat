import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from './index.mjs';
import { createConversationStore } from './conversations.mjs';
import { createFileLogger } from './logger.mjs';
import { ProviderError } from './providers/deepseek.mjs';

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function stop(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test('saves and restores conversations and sends the saved context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-chat-test-'));
  const store = createConversationStore(path.join(directory, 'conversations'));
  const requests = [];
  const logs = [];
  const options = {
    conversationStore: store,
    contextWindowTokens: 1000,
    modelProvider: {
      reply: async (messages) => {
        requests.push(messages);
        return { text: '收到。', usage: { inputTokens: 120, outputTokens: 20, cachedTokens: 12 } };
      },
    },
    log: (event) => { logs.push(event); },
  };
  const server = createApp(options);
  try {
    const baseUrl = await start(server);
    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /历史对话/);
    assert.equal((await fetch(`${baseUrl}/stats.js`)).status, 200);
    const config = await (await fetch(`${baseUrl}/api/config`)).json();
    assert.equal(config.contextWindowTokens, 1000);

    const first = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '你好' }),
    });
    assert.equal(first.status, 200);
    const firstResult = await first.json();
    assert.equal(firstResult.reply, '收到。');
    assert.equal(firstResult.usage.cachedTokens, 12);

    const second = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: firstResult.conversationId, message: '继续' }),
    });
    assert.equal(second.status, 200);
    const secondResult = await second.json();
    assert.deepEqual(requests[1], [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '收到。' },
      { role: 'user', content: '继续' },
    ]);

    const list = await (await fetch(`${baseUrl}/api/conversations`)).json();
    assert.equal(list.conversations.length, 1);
    assert.equal(list.conversations[0].title, '你好');
    await stop(server);

    const restarted = createApp(options);
    try {
      const restartUrl = await start(restarted);
      const history = await (await fetch(`${restartUrl}/api/conversations/${firstResult.conversationId}`)).json();
      assert.equal(history.conversation.messages.length, 4);
      assert.equal(history.conversation.messages[3].content, '收到。');
      assert.deepEqual(history.conversation.messages[3].usage, { inputTokens: 120, outputTokens: 20, cachedTokens: 12 });
      assert.equal(history.conversation.messages[3].requestId, secondResult.requestId);
    } finally {
      await stop(restarted);
    }
    assert.equal(logs.length, 2);
    assert.equal(logs[0].cacheHitTokens, 12);
    assert.equal(logs[0].inputTokens, 120);
    assert.equal(logs[0].outputTokens, 20);
    assert.equal(JSON.stringify(logs).includes('你好'), false);
  } finally {
    if (server.listening) await stop(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid conversation IDs without calling the provider', async () => {
  let called = false;
  const server = createApp({
    modelProvider: { reply: async () => { called = true; } },
    log: () => {},
  });
  const baseUrl = await start(server);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: '../bad', message: '测试' }),
    });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    await stop(server);
  }
});

test('shows a useful message when DeepSeek rejects the API key', async () => {
  const server = createApp({
    modelProvider: { reply: async () => { throw new ProviderError('provider_http_401', 502); } },
    log: () => {},
  });
  const baseUrl = await start(server);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '测试' }),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /DeepSeek.*API key.*401/);
  } finally {
    await stop(server);
  }
});

test('writes daily JSONL request logs without conversation text', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aaa-log-test-'));
  try {
    const logger = createFileLogger(directory, () => {});
    await logger({ event: 'chat_request', level: 'info', status: 200, cacheHitTokens: 12 });
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);
    const entry = JSON.parse((await readFile(path.join(directory, files[0]), 'utf8')).trim());
    assert.equal(entry.cacheHitTokens, 12);
    assert.equal(entry.event, 'chat_request');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
