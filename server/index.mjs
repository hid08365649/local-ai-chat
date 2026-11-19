import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateMessages } from './chat.mjs';
import { createDeepSeekProvider, ProviderError } from './providers/deepseek.mjs';
import { createConversationStore, isConversationId, newConversation } from './conversations.mjs';
import { createFileLogger } from './logger.mjs';
import { activeSummary, compactionState, contextUsage, contextWithSummary, generateSummary, replaceSummary, shouldAutoCompact, undoSummary, validateSettings } from './compaction.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(projectRoot, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

const publicRoot = path.join(projectRoot, 'public');
const port = Number(process.env.PORT || 4370);
const modelName = process.env.DEEPSEEK_MODEL || 'deepseek-flash';
const configuredContextWindow = Number(process.env.DEEPSEEK_CONTEXT_WINDOW_TOKENS);
const defaultContextWindow = Number.isSafeInteger(configuredContextWindow) && configuredContextWindow > 0
  ? configuredContextWindow
  : modelName === 'deepseek-flash' ? 1048576 : null;
const provider = createDeepSeekProvider({
  apiKey: process.env.DEEPSEEK_API_KEY,
  model: modelName,
  systemPrompt: process.env.SYSTEM_PROMPT || '',
});

const publicFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/stats.js', ['stats.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('body_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { status: 400 });
  }
}

export function createApp({
  modelProvider = provider,
  conversationStore = createConversationStore(path.join(projectRoot, 'data', 'conversations')),
  log = createFileLogger(path.join(projectRoot, 'logs')),
  contextWindowTokens = defaultContextWindow,
  systemPrompt = process.env.SYSTEM_PROMPT || '',
} = {}) {
  const busy = new Set();
  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    const url = new URL(request.url, 'http://127.0.0.1');

    if (request.method === 'GET' && publicFiles.has(url.pathname)) {
      const [filename, contentType] = publicFiles.get(url.pathname);
      try {
        const body = await readFile(path.join(publicRoot, filename));
        response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
        response.end(body);
      } catch {
        sendJson(response, 500, { error: 'page_unavailable', requestId });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/conversations') {
      try {
        sendJson(response, 200, { conversations: await conversationStore.list() });
      } catch {
        sendJson(response, 500, { error: '无法读取历史对话。', requestId });
      }
      return;
    }

    if (request.method === 'GET' && url.pathname === '/api/config') {
      sendJson(response, 200, {
        model: modelName,
        contextWindowTokens,
      });
      return;
    }

    const conversationId = url.pathname.match(/^\/api\/conversations\/([^/]+)$/)?.[1];
    if (request.method === 'GET' && conversationId) {
      try {
        const conversation = isConversationId(conversationId) && await conversationStore.get(conversationId);
        if (!conversation) {
          sendJson(response, 404, { error: '找不到这段对话。', requestId });
          return;
        }
        compactionState(conversation);
        sendJson(response, 200, { conversation, contextUsage: contextUsage(conversation, contextWindowTokens, systemPrompt) });
      } catch {
        sendJson(response, 500, { error: '无法读取历史对话。', requestId });
      }
      return;
    }

    const summaryRoute = url.pathname.match(/^\/api\/conversations\/([^/]+)\/(summary|summary\/settings|summary\/auto)$/);
    if (summaryRoute) {
      const [, id, action] = summaryRoute;
      if (!isConversationId(id)) {
        sendJson(response, 400, { error: '对话 ID 无效。', requestId });
        return;
      }
      if (busy.has(id)) {
        sendJson(response, 409, { error: '这段对话正在处理请求，请稍后重试。', requestId });
        return;
      }
      busy.add(id);
      let status = 200;
      let outcome = 'ok';
      let beforeEstimatedTokens = null;
      let afterEstimatedTokens = null;
      let autoCompacted = false;
      let autoDeferred = false;
      try {
        const conversation = await conversationStore.get(id);
        if (!conversation) {
          status = 404;
          sendJson(response, status, { error: '找不到这段对话。', requestId });
          return;
        }
        const state = compactionState(conversation);
        if (action === 'summary/settings' && request.method === 'PUT') {
          const value = await readJson(request);
          if (!validateSettings(value, contextWindowTokens)) {
            status = 400;
            sendJson(response, status, { error: '压缩设置无效。', requestId });
            return;
          }
          state.thresholdRatio = value.thresholdRatio;
          state.maxContextTokens = value.maxContextTokens;
          state.supplementalInstructions = value.supplementalInstructions.trim();
          state.retryAutoAfterMessageCount = null;
        } else if (action === 'summary/auto' && request.method === 'POST') {
          const before = contextUsage(conversation, contextWindowTokens, systemPrompt);
          beforeEstimatedTokens = before.estimatedTokens;
          if (shouldAutoCompact(conversation, before)) {
            autoCompacted = true;
            state.lastAutoAttemptMessageCount = conversation.messages.length;
            await conversationStore.save(conversation);
            await generateSummary(conversation, modelProvider, 'automatic', async (event) => {
              await conversationStore.save(conversation);
              await log({ event: 'summary_request', level: 'info', requestId, conversationId: id,
                outcome: 'automatic_batch', status: 200,
                inputTokens: event.usage?.inputTokens ?? null,
                outputTokens: event.usage?.outputTokens ?? null,
                cacheHitTokens: event.usage?.cachedTokens ?? null });
            });
            state.lastCompression = { beforeEstimatedTokens,
              afterEstimatedTokens: contextUsage(conversation, contextWindowTokens, systemPrompt).estimatedTokens,
              at: new Date().toISOString() };
          }
          autoDeferred = !autoCompacted && state.retryAutoAfterMessageCount > conversation.messages.length;
          if (!autoCompacted) outcome = autoDeferred ? 'deferred' : 'no_compaction_needed';
          afterEstimatedTokens = contextUsage(conversation, contextWindowTokens, systemPrompt).estimatedTokens;
          if (state.lastAutoAttemptMessageCount === conversation.messages.length) {
            state.retryAutoAfterMessageCount = contextUsage(conversation, contextWindowTokens, systemPrompt).overThreshold
              ? conversation.messages.length + 20 : null;
          }
        } else if (action === 'summary' && request.method === 'POST') {
          beforeEstimatedTokens = contextUsage(conversation, contextWindowTokens, systemPrompt).estimatedTokens;
          const version = await generateSummary(conversation, modelProvider, 'manual', async (event) => {
            await conversationStore.save(conversation);
            await log({ event: 'summary_request', level: 'info', requestId, conversationId: id,
              outcome: 'manual_batch', status: 200,
              inputTokens: event.usage?.inputTokens ?? null,
              outputTokens: event.usage?.outputTokens ?? null,
              cacheHitTokens: event.usage?.cachedTokens ?? null });
          });
          if (!version) {
            status = 409;
            sendJson(response, status, { error: '暂无可压缩的旧消息；需至少保留最近 20 条原文。', requestId });
            return;
          }
          afterEstimatedTokens = contextUsage(conversation, contextWindowTokens, systemPrompt).estimatedTokens;
          state.lastCompression = { beforeEstimatedTokens, afterEstimatedTokens, at: new Date().toISOString() };
          state.retryAutoAfterMessageCount = contextUsage(conversation, contextWindowTokens, systemPrompt).overThreshold
            ? conversation.messages.length + 20 : null;
        } else if (action === 'summary' && request.method === 'PUT') {
          const value = await readJson(request);
          if (!replaceSummary(conversation, value?.summary)) {
            status = 400;
            sendJson(response, status, { error: '请填写摘要，且长度不超过 20,000 字符。', requestId });
            return;
          }
          state.retryAutoAfterMessageCount = null;
        } else if (action === 'summary' && request.method === 'DELETE') {
          if (!undoSummary(conversation)) {
            status = 409;
            sendJson(response, status, { error: '当前没有可撤销的摘要。', requestId });
            return;
          }
          state.retryAutoAfterMessageCount = null;
        } else {
          status = 405;
          sendJson(response, status, { error: '不支持这项操作。', requestId });
          return;
        }
        conversation.updatedAt = new Date().toISOString();
        await conversationStore.save(conversation);
        sendJson(response, 200, { compaction: state, activeSummary: activeSummary(conversation),
          contextUsage: contextUsage(conversation, contextWindowTokens, systemPrompt),
          autoCompacted, autoDeferred, requestId });
      } catch (error) {
        status = error instanceof ProviderError ? error.status : Number.isInteger(error.status) ? error.status : 500;
        outcome = error instanceof ProviderError ? error.category : 'summary_error';
        sendJson(response, status, { error: '摘要操作失败；当前摘要与原文未更改。请稍后重试。', requestId });
      } finally {
        busy.delete(id);
        await log({ event: 'summary_action', level: status >= 500 ? 'error' : 'info', requestId,
          conversationId: id, outcome, status, durationMs: Date.now() - startedAt,
          beforeEstimatedTokens, afterEstimatedTokens });
      }
      return;
    }

    if (request.method !== 'POST' || url.pathname !== '/api/chat') {
      sendJson(response, 404, { error: 'not_found', requestId });
      return;
    }

    let status = 200;
    let outcome = 'ok';
    let cacheHitTokens = null;
    let inputTokens = null;
    let outputTokens = null;
    let lockedId = null;
    let loggedConversationId = null;
    let overflowBeforeEstimatedTokens = null;
    let overflowAfterEstimatedTokens = null;
    try {
      const body = await readJson(request);
      const checked = validateMessages([{ role: 'user', content: body?.message }]);
      if (!checked.ok) {
        status = 400;
        outcome = 'invalid_input';
        sendJson(response, status, { error: checked.error, requestId });
        return;
      }

      if (body.conversationId != null && !isConversationId(body.conversationId)) {
        status = 400;
        outcome = 'invalid_conversation_id';
        sendJson(response, status, { error: '对话 ID 无效。', requestId });
        return;
      }
      const conversation = body.conversationId
        ? await conversationStore.get(body.conversationId)
        : newConversation(checked.messages[0].content);
      if (!conversation) {
        status = 404;
        outcome = 'conversation_not_found';
        sendJson(response, status, { error: '找不到这段对话。', requestId });
        return;
      }
      if (busy.has(conversation.id)) {
        status = 409;
        outcome = 'conversation_busy';
        sendJson(response, status, { error: '这段对话正在回复，请稍后重试。', requestId });
        return;
      }
      busy.add(conversation.id);
      lockedId = conversation.id;
      loggedConversationId = conversation.id;

      const userMessage = checked.messages[0];
      const context = contextWithSummary(conversation, userMessage);
      let result;
      let rescuedOverflow = false;
      try {
        result = await modelProvider.reply(context.messages);
      } catch (error) {
        if (!(error instanceof ProviderError) || error.category !== 'provider_context_overflow') throw error;
        overflowBeforeEstimatedTokens = contextUsage(conversation, contextWindowTokens, systemPrompt).estimatedTokens;
        const version = await generateSummary(conversation, modelProvider, 'automatic', async (event) => {
          await conversationStore.save(conversation);
          await log({ event: 'summary_request', level: 'info', requestId, conversationId: conversation.id,
            outcome: 'overflow_batch', status: 200,
            inputTokens: event.usage?.inputTokens ?? null,
            outputTokens: event.usage?.outputTokens ?? null,
            cacheHitTokens: event.usage?.cachedTokens ?? null });
        });
        if (!version) throw error;
        overflowAfterEstimatedTokens = contextUsage(conversation, contextWindowTokens, systemPrompt).estimatedTokens;
        compactionState(conversation).lastCompression = {
          beforeEstimatedTokens: overflowBeforeEstimatedTokens,
          afterEstimatedTokens: overflowAfterEstimatedTokens,
          at: new Date().toISOString(),
        };
        await conversationStore.save(conversation);
        const retryContext = contextWithSummary(conversation, userMessage);
        result = await modelProvider.reply(retryContext.messages);
        rescuedOverflow = true;
        outcome = 'overflow_recovered';
        context.omittedMessages = retryContext.omittedMessages;
      }
      const reply = typeof result === 'string' ? result : result.text;
      const usage = result.usage ?? null;
      cacheHitTokens = usage?.cachedTokens ?? null;
      inputTokens = usage?.inputTokens ?? null;
      outputTokens = usage?.outputTokens ?? null;
      conversation.messages.push(userMessage, { role: 'assistant', content: reply, usage, requestId,
        omittedMessages: context.omittedMessages });
      if (rescuedOverflow) {
        const state = compactionState(conversation);
        state.lastAutoAttemptMessageCount = conversation.messages.length;
        state.retryAutoAfterMessageCount = contextUsage(conversation, contextWindowTokens, systemPrompt).overThreshold
          ? conversation.messages.length + 20 : null;
      }
      conversation.updatedAt = new Date().toISOString();
      await conversationStore.save(conversation);
      sendJson(response, status, { reply, conversationId: conversation.id, usage, requestId,
        omittedMessages: context.omittedMessages, compaction: compactionState(conversation),
        contextUsage: contextUsage(conversation, contextWindowTokens, systemPrompt) });
    } catch (error) {
      status = Number.isInteger(error.status) ? error.status : 500;
      outcome = error instanceof ProviderError ? error.category : 'internal_error';
      const message = error.message === 'summary_provider_unavailable' || error.message === 'summary_invalid_output'
        ? '摘要失败；请稍后重试。'
        : outcome === 'provider_context_overflow'
        ? '本次请求超过模型上下文容量，旧消息不足以继续压缩或重试后仍超限。请缩短消息或调整摘要。'
        : status === 503
        ? '后端尚未配置模型 API 密钥或模型名称。'
        : outcome === 'provider_http_401'
          ? 'DeepSeek 未接受这个 API key（HTTP 401）。请检查本机 .env 中的 key 是否完整、有效。'
          : outcome === 'provider_http_403'
            ? 'DeepSeek 拒绝了本次访问（HTTP 403）。请检查 API 项目权限和模型访问权限。'
        : status === 413
          ? '请求太大，请缩短对话后重试。'
          : status === 400
            ? '请求格式无效。'
            : '模型请求失败，请检查后端状态后重试。';
      sendJson(response, status, { error: message, requestId });
    } finally {
      if (lockedId) busy.delete(lockedId);
      await log({
        event: 'chat_request',
        level: status >= 500 ? 'error' : 'info',
        requestId,
        conversationId: loggedConversationId,
        outcome,
        status,
        durationMs: Date.now() - startedAt,
        inputTokens,
        outputTokens,
        cacheHitTokens,
        overflowBeforeEstimatedTokens,
        overflowAfterEstimatedTokens,
      });
    }
  });
}

const isEntrypoint = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isEntrypoint) {
  const server = createApp();
  server.listen(port, '127.0.0.1', () => {
    console.info(`AAA chat server listening at http://127.0.0.1:${port}`);
    if (!process.env.DEEPSEEK_API_KEY) {
      console.info('DeepSeek is not configured yet. Set DEEPSEEK_API_KEY before chatting.');
    }
  });
}
