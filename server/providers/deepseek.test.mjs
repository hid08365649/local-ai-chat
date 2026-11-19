import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeepSeekProvider, ProviderError } from './deepseek.mjs';

test('sends a stateless Responses API request and extracts raw output items', async () => {
  let request;
  const provider = createDeepSeekProvider({
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: '你好。' }],
        }],
        usage: { input_tokens: 120, input_tokens_details: { cached_tokens: 64 }, output_tokens: 8 },
      }), { status: 200 });
    },
  });

  const answer = await provider.reply([{ role: 'user', content: '你好' }]);
  assert.deepEqual(answer, {
    text: '你好。',
    usage: { inputTokens: 120, cachedTokens: 64, outputTokens: 8 },
  });
  assert.equal(request.url, 'https://api.deepseek.com/responses');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.deepEqual(JSON.parse(request.options.body), {
    model: 'deepseek-flash',
    input: [{ role: 'user', content: '你好' }],
    store: false,
  });
});

test('adds an optional stable system prompt before conversation messages', async () => {
  let input;
  const provider = createDeepSeekProvider({
    apiKey: 'test-key',
    systemPrompt: '简洁回答。',
    fetchImpl: async (_, options) => {
      input = JSON.parse(options.body).input;
      return new Response(JSON.stringify({ output_text: '好。' }), { status: 200 });
    },
  });
  await provider.reply([{ role: 'user', content: '你好' }]);
  assert.deepEqual(input, [
    { role: 'system', content: '简洁回答。' },
    { role: 'user', content: '你好' },
  ]);
});

test('reports missing configuration without making a network request', async () => {
  let called = false;
  const provider = createDeepSeekProvider({ fetchImpl: async () => { called = true; } });
  await assert.rejects(provider.reply([{ role: 'user', content: '你好' }]), ProviderError);
  assert.equal(called, false);
});

test('does not include provider response details in surfaced errors', async () => {
  const provider = createDeepSeekProvider({
    apiKey: 'test-key',
    fetchImpl: async () => new Response('private provider detail', { status: 401 }),
  });
  await assert.rejects(provider.reply([{ role: 'user', content: '你好' }]), (error) => {
    assert.equal(error.category, 'provider_http_401');
    assert.equal(error.message.includes('private provider detail'), false);
    return true;
  });
});

test('identifies a context overflow without exposing provider details', async () => {
  const provider = createDeepSeekProvider({ apiKey: 'test-key', fetchImpl: async () =>
    new Response(JSON.stringify({ error: { message: 'Maximum context length exceeded: private detail' } }),
      { status: 400 }) });
  await assert.rejects(provider.reply([{ role: 'user', content: '你好' }]), (error) => {
    assert.equal(error.category, 'provider_context_overflow');
    assert.equal(error.message.includes('private detail'), false);
    return true;
  });
});

test('summary request uses its own instructions and does not inherit the chat system prompt', async () => {
  let input;
  const provider = createDeepSeekProvider({ apiKey: 'test-key', systemPrompt: '聊天专用规则',
    fetchImpl: async (_, options) => {
      input = JSON.parse(options.body).input;
      return new Response(JSON.stringify({ output_text: '摘要', usage: {
        input_tokens: 30, output_tokens: 6, input_tokens_details: { cached_tokens: 0 },
      } }), { status: 200 });
    },
  });
  const result = await provider.summarize({ previousSummary: '旧摘要',
    messages: [{ index: 4, role: 'user', content: '新决定' }], supplementalInstructions: '优先保留决定' });
  assert.equal(result.text, '摘要');
  assert.match(input[0].content, /区分已完成、计划/);
  assert.equal(input[0].content.includes('聊天专用规则'), false);
  assert.deepEqual(JSON.parse(input[1].content), { supplementalInstructions: '优先保留决定',
    previousSummary: '旧摘要', messages: [{ index: 4, role: 'user', content: '新决定' }] });
});
