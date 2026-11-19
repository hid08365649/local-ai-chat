import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MESSAGES, validateMessages } from './chat.mjs';

test('accepts a conversation ending with a user message', () => {
  const messages = [
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好。' },
    { role: 'user', content: '还记得我刚才说什么吗？' },
  ];
  assert.deepEqual(validateMessages(messages), { ok: true, messages });
});

test('rejects unsupported roles, empty messages, and oversized history', () => {
  assert.equal(validateMessages([{ role: 'system', content: 'no' }]).ok, false);
  assert.equal(validateMessages([{ role: 'user', content: '  ' }]).ok, false);
  assert.equal(validateMessages(Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'x' }))).ok, false);
});

test('requires the newest message to be from the user', () => {
  assert.equal(validateMessages([
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '你好。' },
  ]).ok, false);
});
