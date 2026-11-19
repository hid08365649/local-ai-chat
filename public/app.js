import { cacheHitRate, summarizeUsage } from './stats.js';

const form = document.querySelector('#composer');
const input = document.querySelector('#message-input');
const sendButton = document.querySelector('#send-button');
const messagesElement = document.querySelector('#messages');
const welcome = document.querySelector('#welcome');
const notice = document.querySelector('#notice');
const conversation = document.querySelector('.conversation');
const historyList = document.querySelector('#conversation-list');
const newButton = document.querySelector('#new-conversation');
const sidebar = document.querySelector('#sidebar');
const sidebarBackdrop = document.querySelector('#sidebar-backdrop');
const sidebarOpen = document.querySelector('#open-sidebar');
const sidebarClose = document.querySelector('#close-sidebar');
const statsDialog = document.querySelector('#stats-dialog');
const contextRing = document.querySelector('#context-ring');
const contextPercent = document.querySelector('#context-percent');
const summaryPanel = document.querySelector('#summary-panel');
const usagePanel = document.querySelector('#usage-panel');
const undoDialog = document.querySelector('#undo-dialog');
const mobileLayout = window.matchMedia('(max-width: 720px)');

let currentId = null;
let messages = [];
let historyItems = [];
let contextWindowTokens = null;
let compaction = null;
let currentContextUsage = null;
let isBusy = false;

const tokenFormat = new Intl.NumberFormat('zh-CN');

function formatTokens(value) {
  return Number.isSafeInteger(value) && value >= 0 ? tokenFormat.format(value) : '—';
}

function formatPercent(value) {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value > 0 && value < 0.1) return '<0.1%';
  return `${value.toFixed(1)}%`;
}

function setBusy(value) {
  isBusy = value;
  input.disabled = value;
  sendButton.disabled = value;
  newButton.disabled = value;
  for (const button of historyList.querySelectorAll('button')) button.disabled = value;
  for (const control of summaryPanel.querySelectorAll('button, input, textarea')) control.disabled = value || !currentId;
  for (const control of usagePanel.querySelectorAll('button, input')) control.disabled = value || !currentId;
}

function activeSummary() {
  return compaction?.versions?.find((version) => version.id === compaction.activeVersionId) ?? null;
}

function selectContextTab(name) {
  const summary = name === 'summary';
  usagePanel.hidden = summary;
  summaryPanel.hidden = !summary;
  document.querySelector('#tab-usage').setAttribute('aria-selected', String(!summary));
  document.querySelector('#tab-summary').setAttribute('aria-selected', String(summary));
}

function openContext(name = 'usage') {
  selectContextTab(name);
  if (!statsDialog.open) statsDialog.showModal();
  statsDialog.scrollTop = 0;
}

function showSummaryNotice(message, error = false) {
  const element = document.querySelector('#summary-notice');
  element.textContent = message;
  element.style.color = error ? '#a1473d' : '#38675b';
  element.hidden = false;
}

function setSidebarOpen(open) {
  const visible = mobileLayout.matches && open;
  sidebar.classList.toggle('is-open', visible);
  sidebar.inert = mobileLayout.matches && !visible;
  sidebarBackdrop.hidden = !visible;
  sidebarOpen.setAttribute('aria-expanded', String(visible));
}

function showError(error) {
  notice.textContent = error instanceof TypeError
    ? '无法连接本机后端。确认服务窗口仍在运行后重试。'
    : error.message;
  notice.hidden = false;
}

async function readResponse(response) {
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败。');
  return result;
}

function usageText(usage) {
  if (!usage) return '本轮用量未记录';
  const rate = cacheHitRate(usage);
  return `本轮输入 ${formatTokens(usage.inputTokens)} · 输出 ${formatTokens(usage.outputTokens)} · 缓存命中 ${formatTokens(usage.cachedTokens)}${rate === null ? '' : `（${formatPercent(rate)}）`}`;
}

function addMessage(message, pending = false) {
  const element = document.createElement('div');
  element.className = `message ${message.role}${pending ? ' pending' : ''}`;
  const text = document.createElement('div');
  text.textContent = message.content;
  element.append(text);
  if (message.role === 'assistant') {
    const usage = document.createElement('div');
    usage.className = 'message-usage';
    usage.textContent = usageText(message.usage);
    element.append(usage);
  }
  messagesElement.append(element);
  conversation.scrollTop = conversation.scrollHeight;
  return element;
}

function renderStats() {
  const summary = summarizeUsage(messages, compaction);
  const percent = currentContextUsage?.percent ?? null;
  contextPercent.textContent = formatPercent(percent);
  contextRing.style.setProperty('--fill', `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%`);
  contextRing.parentElement.title = percent === null ? '暂无上下文占比' : `当前上下文估算占比 ${formatPercent(percent)}`;

  const coverage = summary.coverage;
  document.querySelector('#stats-coverage').textContent = summary.totalTurns
    ? `完整统计 ${summary.completeTurns}/${summary.totalTurns} 轮；合计仅包含有记录的用量。`
    : '尚无已记录的模型用量。';
  document.querySelector('#stats-context-percent').textContent = formatPercent(percent);
  document.querySelector('#stats-context-used').textContent = currentContextUsage
    ? `${formatTokens(currentContextUsage.estimatedTokens)} token` : '—';
  document.querySelector('#stats-context-limit').textContent = currentContextUsage?.maxContextTokens
    ? `${formatTokens(currentContextUsage.maxContextTokens)} token` : '未配置';
  document.querySelector('#stats-input').textContent = coverage.inputTokens || summary.summaryCoverage.inputTokens
    ? `${formatTokens(summary.allTotals.inputTokens)} token` : '—';
  document.querySelector('#stats-output').textContent = coverage.outputTokens || summary.summaryCoverage.outputTokens
    ? `${formatTokens(summary.allTotals.outputTokens)} token` : '—';
  document.querySelector('#stats-cached').textContent = coverage.cachedTokens || summary.summaryCoverage.cachedTokens
    ? `${formatTokens(summary.allTotals.cachedTokens)} token` : '—';
  document.querySelector('#stats-cache-rate').textContent = formatPercent(summary.allCacheRate);
  document.querySelector('#stats-summary-usage').textContent = summary.summaryEvents
    ? `${summary.summaryCoverage.inputTokens ? formatTokens(summary.summaryTotals.inputTokens) : '—'} / ${summary.summaryCoverage.outputTokens ? formatTokens(summary.summaryTotals.outputTokens) : '—'} token`
    : '尚无摘要请求';
  document.querySelector('#stats-context-note').textContent =
    `圆环按当前会发送的摘要与原文估算，不是 API 实际计费 token。模型容量：${contextWindowTokens ? `${formatTokens(contextWindowTokens)} token` : '未知'}。原文仍保存在本机。`;
  document.querySelector('#context-max-help').textContent = contextWindowTokens
    ? `留空时跟随模型容量（${formatTokens(contextWindowTokens)} token）。回复后达到阈值会自动压缩；本轮可能短暂超过目标容量，模型上限仍有效。`
    : '模型容量未知；可填写已确认的目标容量。回复后达到阈值会自动压缩。';
  document.querySelector('#summary-threshold').value = compaction?.thresholdRatio ?? 0.7;
  document.querySelector('#context-max').value = compaction?.maxContextTokens == null
    ? '' : compaction.maxContextTokens / 1000;
  for (const control of usagePanel.querySelectorAll('button, input')) control.disabled = isBusy || !currentId;
}

function renderSummary() {
  const version = activeSummary();
  document.querySelector('#summary-status').textContent = !currentId
    ? '发送第一条消息后，才能管理这段对话的摘要。'
    : version
      ? `当前摘要覆盖前 ${version.coveredMessageCount} 条消息；之后的原文会继续发给模型。`
      : '这段对话尚无摘要；达到阈值后会自动整理旧消息。';
  const last = compaction?.lastCompression;
  document.querySelector('#summary-last-compression').textContent = last
    ? `上次压缩前后估算：${formatTokens(last.beforeEstimatedTokens)} → ${formatTokens(last.afterEstimatedTokens)} token。${compaction.retryAutoAfterMessageCount > messages.length ? '上次压缩后仍达到阈值，请检查摘要或调整设置。' : ''}`
    : '';
  document.querySelector('#active-summary').hidden = !version;
  if (version) {
    document.querySelector('#summary-meta').textContent = `${new Date(version.createdAt).toLocaleString('zh-CN')} · 覆盖前 ${version.coveredMessageCount} 条消息`;
    document.querySelector('#summary-text').textContent = version.summary;
    document.querySelector('#summary-edit-text').value = version.summary;
  }
  document.querySelector('#summary-editor').hidden = true;
  document.querySelector('#summary-instructions').value = compaction?.supplementalInstructions ?? '';
  const list = document.querySelector('#summary-versions');
  list.replaceChildren();
  const versions = compaction?.versions ?? [];
  if (!versions.length) list.textContent = '尚无摘要版本。';
  for (const item of [...versions].reverse()) {
    const details = document.createElement('details');
    const heading = document.createElement('summary');
    const kind = item.kind === 'automatic' ? '自动生成' : item.kind === 'edited' ? '手动编辑' : '手动生成';
    heading.textContent = `${item.id === compaction.activeVersionId ? '当前 · ' : ''}${kind} · 前 ${item.coveredMessageCount} 条 · ${new Date(item.createdAt).toLocaleString('zh-CN')}`;
    const text = document.createElement('pre');
    text.textContent = item.summary;
    const usage = document.createElement('p');
    usage.textContent = item.usage ? `摘要请求：输入 ${formatTokens(item.usage.inputTokens)} · 输出 ${formatTokens(item.usage.outputTokens)} · 缓存命中 ${formatTokens(item.usage.cachedTokens)}` : '手动编辑，无模型请求';
    const instruction = document.createElement('p');
    instruction.textContent = `当时的补充要求：${item.supplementalInstructions || '无'}`;
    details.append(heading, text, usage, instruction);
    list.append(details);
  }
  for (const control of summaryPanel.querySelectorAll('button, input, textarea')) control.disabled = isBusy || !currentId;
}

function renderMessages() {
  messagesElement.replaceChildren();
  welcome.hidden = messages.length > 0;
  const cutoff = activeSummary()?.coveredMessageCount;
  for (const [index, message] of messages.entries()) {
    addMessage(message);
    if (index + 1 === cutoff) {
      const marker = document.createElement('div');
      marker.className = 'summary-boundary';
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `此前 ${cutoff} 条已归纳 · 查看摘要`;
      button.addEventListener('click', () => openContext('summary'));
      marker.append(button);
      messagesElement.append(marker);
    }
  }
  renderStats();
  renderSummary();
}

function renderHistory() {
  historyList.replaceChildren();
  if (!historyItems.length) {
    const empty = document.createElement('p');
    empty.className = 'history-empty';
    empty.textContent = '还没有保存的对话';
    historyList.append(empty);
    return;
  }
  const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  for (const item of historyItems) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'conversation-item';
    button.disabled = isBusy;
    if (item.id === currentId) button.setAttribute('aria-current', 'page');
    const title = document.createElement('span');
    title.className = 'conversation-title';
    title.textContent = item.title || '未命名对话';
    const date = document.createElement('span');
    date.className = 'conversation-date';
    const updated = new Date(item.updatedAt);
    date.textContent = Number.isNaN(updated.getTime()) ? '' : dateFormat.format(updated);
    button.append(title, date);
    button.addEventListener('click', () => switchConversation(item.id));
    historyList.append(button);
  }
}

async function loadList() {
  const result = await readResponse(await fetch('/api/conversations'));
  historyItems = result.conversations;
  renderHistory();
  return historyItems;
}

async function openConversation(id) {
  const result = await readResponse(await fetch(`/api/conversations/${encodeURIComponent(id)}`));
  currentId = result.conversation.id;
  messages = result.conversation.messages;
  compaction = result.conversation.compaction;
  currentContextUsage = result.contextUsage;
  renderHistory();
  renderMessages();
  const omitted = messages.at(-1)?.omittedMessages ?? 0;
  if (omitted) {
    notice.textContent = `最近一次回复未发送较早的 ${omitted} 条原文消息给模型；原文仍保存在本机。`;
    notice.hidden = false;
  }
}

async function switchConversation(id) {
  if (id === currentId) {
    setSidebarOpen(false);
    return;
  }
  setBusy(true);
  notice.hidden = true;
  try {
    await openConversation(id);
    setSidebarOpen(false);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

newButton.addEventListener('click', () => {
  currentId = null;
  messages = [];
  compaction = null;
  currentContextUsage = { estimatedTokens: 0, maxContextTokens: contextWindowTokens, percent: contextWindowTokens ? 0 : null };
  notice.hidden = true;
  renderHistory();
  renderMessages();
  setSidebarOpen(false);
  input.focus();
});

sidebarOpen.addEventListener('click', () => setSidebarOpen(true));
sidebarClose.addEventListener('click', () => setSidebarOpen(false));
sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
mobileLayout.addEventListener('change', () => setSidebarOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && sidebar.classList.contains('is-open')) setSidebarOpen(false);
});
document.querySelector('#open-stats').addEventListener('click', () => openContext('usage'));
document.querySelector('#close-stats').addEventListener('click', () => statsDialog.close());
document.querySelector('#tab-usage').addEventListener('click', () => selectContextTab('usage'));
document.querySelector('#tab-summary').addEventListener('click', () => selectContextTab('summary'));

async function requestSummaryAction(method, suffix, body) {
  const result = await readResponse(await fetch(`/api/conversations/${encodeURIComponent(currentId)}/${suffix}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  compaction = result.compaction;
  currentContextUsage = result.contextUsage;
  renderMessages();
  await loadList().catch(() => {});
  return result;
}

async function summaryRequest(method, suffix, body) {
  if (!currentId) return null;
  setBusy(true);
  document.querySelector('#summary-notice').hidden = true;
  try {
    return await requestSummaryAction(method, suffix, body);
  } catch (error) {
    showSummaryNotice(error.message, true);
    return null;
  } finally {
    setBusy(false);
  }
}

function usageSettingsValue() {
  const maxInput = document.querySelector('#context-max').value;
  return {
    thresholdRatio: Number(document.querySelector('#summary-threshold').value),
    maxContextTokens: maxInput === '' ? null : Math.round(Number(maxInput) * 1000),
    supplementalInstructions: compaction?.supplementalInstructions ?? '',
  };
}

function summarySettingsValue() {
  return {
    thresholdRatio: compaction?.thresholdRatio ?? 0.7,
    maxContextTokens: compaction?.maxContextTokens ?? null,
    supplementalInstructions: document.querySelector('#summary-instructions').value,
  };
}

document.querySelector('#usage-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await summaryRequest('PUT', 'summary/settings', usageSettingsValue());
  const notice = document.querySelector('#usage-settings-notice');
  notice.textContent = result ? '设置已保存；下一轮回复后按新阈值判断。' : '设置保存失败，请检查填写范围。';
  notice.hidden = false;
});

document.querySelector('#summary-settings').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await summaryRequest('PUT', 'summary/settings', summarySettingsValue());
  if (result) showSummaryNotice('设置已保存；只影响之后生成的摘要。');
});
document.querySelector('#generate-summary').addEventListener('click', async () => {
  const saved = await summaryRequest('PUT', 'summary/settings', summarySettingsValue());
  if (!saved) return;
  const result = await summaryRequest('POST', 'summary');
  if (result) showSummaryNotice('摘要已生成并保存为新版本。');
});
document.querySelector('#edit-summary').addEventListener('click', () => {
  document.querySelector('#summary-editor').hidden = false;
  document.querySelector('#summary-edit-text').focus();
});
document.querySelector('#cancel-summary-edit').addEventListener('click', () => {
  document.querySelector('#summary-editor').hidden = true;
});
document.querySelector('#summary-editor').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await summaryRequest('PUT', 'summary', { summary: document.querySelector('#summary-edit-text').value });
  if (result) showSummaryNotice('摘要已保存为新版本；覆盖范围未改变。');
});
document.querySelector('#undo-summary').addEventListener('click', () => undoDialog.showModal());
document.querySelector('#cancel-undo').addEventListener('click', () => undoDialog.close());
document.querySelector('#confirm-undo').addEventListener('click', async () => {
  undoDialog.close();
  const result = await summaryRequest('DELETE', 'summary');
  if (result) showSummaryNotice('已回到上一版摘要；下一轮回复后才会再次判断是否压缩。');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content || sendButton.disabled) return;

  notice.hidden = true;
  welcome.hidden = true;
  input.value = '';
  setBusy(true);
  const pendingMessage = addMessage({ role: 'user', content }, true);

  try {
    const result = await readResponse(await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: currentId, message: content }),
    }));
    pendingMessage.classList.remove('pending');
    currentId = result.conversationId;
    const reply = { role: 'assistant', content: result.reply, usage: result.usage, requestId: result.requestId };
    messages.push({ role: 'user', content }, reply);
    compaction = result.compaction;
    currentContextUsage = result.contextUsage;
    renderMessages();
    if (result.omittedMessages) {
      notice.textContent = `较早的 ${result.omittedMessages} 条原文消息未发给模型；原文仍保存在本机。`;
      notice.hidden = false;
    }
    try {
      await loadList();
    } catch {
      showError(new Error('回复已保存，但历史列表暂时无法刷新。刷新页面后可重试。'));
    }
    if (currentContextUsage?.overThreshold) {
      notice.textContent = '已回复，正在整理上下文…';
      notice.hidden = false;
      try {
        const compacted = await requestSummaryAction('POST', 'summary/auto');
        notice.textContent = compacted.autoDeferred
          ? '上次压缩后仍达到阈值，本轮暂不重复压缩；请在摘要管理中检查摘要或调整设置。'
          : !compacted.autoCompacted
          ? '当前没有足够的旧消息可整理；请调整阈值或目标容量，或继续对话。'
          : currentContextUsage?.overThreshold
            ? '压缩后仍达到阈值。请在摘要管理中查看摘要，或调高本窗口的阈值与目标容量。'
            : '上下文已自动压缩。';
      } catch (error) {
        notice.textContent = `回复已保存，但自动压缩失败：${error.message}`;
      }
    }
  } catch (error) {
    pendingMessage.remove();
    input.value = content;
    welcome.hidden = messages.length > 0;
    showError(error);
  } finally {
    setBusy(false);
    input.focus();
  }
});

setSidebarOpen(false);
setBusy(true);
try {
  const config = await readResponse(await fetch('/api/config'));
  contextWindowTokens = config.contextWindowTokens;
  currentContextUsage = { estimatedTokens: 0, maxContextTokens: contextWindowTokens,
    percent: contextWindowTokens ? 0 : null };
  document.querySelector('#model-label').textContent = config.model;
  renderStats();
  const conversations = await loadList();
  if (conversations.length) await openConversation(conversations[0].id);
  else renderSummary();
} catch (error) {
  showError(error);
} finally {
  setBusy(false);
}
