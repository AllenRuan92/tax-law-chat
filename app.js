import { DEFAULT_AGENT, ENDPOINT, buildMessages, eventMeaning, readSSE } from './lib/chat.js';
import { renderMarkdown } from './lib/markdown.js';
import { initKnowledgeManager } from './knowledge-manager.js?v=20260922-history';
import { initConversationManager } from './conversation-manager.js?v=20260922-history';

const $ = id => document.getElementById(id);
const KEY_STORE = 'tax-law-chat.key';
let key = '', agent = DEFAULT_AGENT, turns = [], active = null, toastTimer, conversationManager, importedAgent, historyReady = false;
const nodes = new Map();

function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4200);
}
function persist() {
  try {
    if (key) sessionStorage.setItem(KEY_STORE, key);
    else sessionStorage.removeItem(KEY_STORE);
  } catch { toast('浏览器无法保存本次会话，刷新后需重新配置。'); }
  return conversationManager?.save();
}
function restore() {
  try {
    key = sessionStorage.getItem(KEY_STORE) || '';
  } catch { /* An unreadable previous session must not block a new conversation. */ }
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('access_key')) {
    const imported = fragment.get('access_key').trim();
    // Remove credentials from the address bar before making any network request.
    history.replaceState(null, '', location.pathname + location.search);
    if (imported && imported.length < 4096 && !/\s/.test(imported)) {
      key = imported;
      const sharedAgent = fragment.get('agent_id');
      if (/^aid-[\w-]+$/.test(sharedAgent)) importedAgent = sharedAgent;
      persist();
      toast('连接信息已导入，可以开始提问。');
    } else toast('体验链接中的 Key 无效，请在连接设置中重新填写。');
  }
}
function updateConnection(verified = false) {
  $('connection-label').textContent = key ? (verified ? '已连通' : '已配置') : '待配置';
  $('connection-status').classList.toggle('configured', Boolean(key));
}
function openSettings() {
  $('api-key').value = key;
  $('agent-id').value = agent;
  $('settings-error').textContent = '';
  $('settings-dialog').showModal();
  if (!key) $('api-key').focus();
}
function setBusy(busy) {
  $('send-button').hidden = busy;
  $('stop-button').hidden = !busy;
  $('send-button').disabled = busy;
  $('new-chat').disabled = busy;
  $('composer-hint').textContent = busy ? '可继续输入下一问 · 点击停止可中断' : 'Enter 发送 · Shift + Enter 换行';
  $('messages').setAttribute('aria-busy', String(busy));
}
function scrollBottom(force = false) {
  const area = $('scroll-area');
  if (force || area.scrollHeight - area.scrollTop - area.clientHeight < 180) area.scrollTop = area.scrollHeight;
}
function addButton(parent, label, action) {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = label; button.addEventListener('click', action);
  parent.append(button);
}
async function copyText(value, success) {
  try { await navigator.clipboard.writeText(value); toast(success); }
  catch { window.prompt('浏览器不允许自动复制，请手动复制：', value); }
}
function paint(turn) {
  let parts = nodes.get(turn.id);
  if (!parts) {
    const article = document.createElement('article');
    const heading = document.createElement('div'); heading.className = 'message-heading';
    const avatar = document.createElement('span'); avatar.className = 'message-avatar';
    avatar.textContent = turn.role === 'user' ? '你' : '税';
    heading.append(avatar, document.createTextNode(turn.role === 'user' ? '你的问题' : '税务案头'));
    const content = document.createElement('div'); content.className = 'message-content';
    const status = document.createElement('div'); status.className = 'message-status';
    article.append(heading, content, status); $('messages').append(article);
    parts = { article, content, status }; nodes.set(turn.id, parts);
  }
  const { article, content, status } = parts;
  article.className = `message ${turn.role}${turn.status === 'error' ? ' error' : ''}`;
  if (turn.role === 'user') { content.textContent = turn.content; status.hidden = true; return; }
  if (turn.content) renderMarkdown(content, turn.content);
  else if (turn.status === 'pending') {
    const typing = document.createElement('div'); typing.className = 'typing';
    typing.setAttribute('aria-label', '正在等待回答');
    typing.append(...Array.from({ length: 3 }, () => document.createElement('b')));
    content.replaceChildren(typing);
  } else content.textContent = '未收到完整回答。';
  status.replaceChildren();
  const label = document.createElement('span');
  label.textContent = turn.status === 'pending' ? (turn.phase || '正在连接知识库')
    : turn.status === 'complete' ? '回答完成 · 请核对原始法规'
    : turn.error || '已停止生成，未完成的回答不会进入后续上下文。';
  status.append(label);
  if (turn.status !== 'pending') {
    if (turn.content) addButton(status, '复制回答', () => copyText(turn.content, '回答已复制。'));
    if (turn.status !== 'complete') addButton(status, '重新提问', () => {
      if (active) return toast('请先等待当前回答完成，或停止生成。');
      const index = turns.findIndex(t => t.id === turn.id);
      $('question').value = turns[index - 1]?.content || '';
      $('question').focus();
      toast('问题已放入输入框，可修改后发送。');
    });
  }
}
function renderAll() {
  nodes.clear(); $('messages').replaceChildren();
  $('welcome').hidden = Boolean(turns.length);
  $('messages').hidden = !turns.length;
  turns.forEach(paint);
  if (turns.length) scrollBottom(true);
  else $('scroll-area').scrollTop = 0;
}
function friendlyError(error, request) {
  if (request.timedOut) return '请求超过 180 秒，请稍后重试或缩短问题。';
  if (request.controller.signal.aborted) return '已停止生成；未完成的回答不会进入后续上下文。';
  if (error instanceof TypeError) return '连接未成功，请检查网络及百炼服务的跨域设置后重试。';
  const message = String(error.message || '请求失败，请稍后重试。');
  return key ? message.replaceAll(key, '[Key 已隐藏]') : message;
}
async function send() {
  const question = $('question').value.trim();
  if (!question || active || !historyReady || conversationManager.isChanging()) return;
  if (!key) { openSettings(); return; }
  const messages = buildMessages(turns, question);
  const user = { id: crypto.randomUUID(), role: 'user', content: question, status: 'complete' };
  const answer = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'pending' };
  turns.push(user, answer);
  $('question').value = '';
  $('welcome').hidden = true; $('messages').hidden = false;
  paint(user); paint(answer); scrollBottom(true); persist();
  const request = { controller: new AbortController(), timedOut: false };
  active = request; setBusy(true);
  let completed = false, paintTimer;
  const saveTimer = setInterval(persist, 2000);
  const timeout = setTimeout(() => { request.timedOut = true; request.controller.abort(); }, 180000);
  const schedulePaint = () => {
    if (paintTimer) return;
    paintTimer = setTimeout(() => { paintTimer = null; paint(answer); scrollBottom(); }, 70);
  };
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST', signal: request.controller.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ input: { messages }, parameters: { agent_options: { agent_id: agent } }, stream: true }),
    });
    if (!response.ok) {
      const advice = response.status === 401 || response.status === 403 ? '请检查 API Key、应用 ID 和工作空间权限。'
        : response.status === 429 ? '调用过于频繁或额度不足，请稍后重试并检查百炼额度。' : '请稍后重试并检查百炼应用是否已发布。';
      throw new Error(`百炼返回 HTTP ${response.status}。${advice}`);
    }
    await readSSE(response.body, event => {
      const meaning = eventMeaning(event);
      if (meaning.text) answer.content += meaning.text;
      if (meaning.phase) answer.phase = meaning.phase;
      if (meaning.usage) answer.usage = meaning.usage;
      if (meaning.done) completed = true;
      schedulePaint();
    });
    if (!completed || !answer.content.trim()) throw new Error('连接已结束，但回答未完整生成。请重新提问。');
    answer.status = 'complete'; updateConnection(true);
  } catch (error) {
    answer.status = request.controller.signal.aborted && !request.timedOut ? 'stopped' : 'error';
    answer.error = friendlyError(error, request);
    toast(answer.status === 'stopped' ? '已停止生成。' : '本次回答未完成，可点击「重新提问」。');
  } finally {
    clearTimeout(timeout); clearTimeout(paintTimer); clearInterval(saveTimer);
    active = null; setBusy(false); paint(answer); persist(); scrollBottom();
  }
}

$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
$('question').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); void send();
  }
});
$('stop-button').addEventListener('click', () => active?.controller.abort());
document.querySelectorAll('.suggestion').forEach(button => button.addEventListener('click', () => {
  $('question').value = button.dataset.question; $('question').focus(); void send();
}));
$('question').addEventListener('input', () => { if (historyReady) void persist(); });
['open-settings', 'connection-status'].forEach(id => $(id).addEventListener('click', openSettings));
$('close-settings').addEventListener('click', () => $('settings-dialog').close());
$('settings-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('settings-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!historyReady || conversationManager.isChanging()) return;
  if (active || knowledgeManager.isBusy()) { $('settings-error').textContent = '请先结束当前问答或文件操作，再修改连接设置。'; return; }
  const nextKey = $('api-key').value.trim(), nextAgent = $('agent-id').value.trim();
  if (!nextKey || /\s/.test(nextKey) || nextKey.length > 4096) { $('settings-error').textContent = '请填入有效的 API Key，不要包含空格或换行。'; return; }
  if (!/^aid-[\w-]+$/.test(nextAgent)) { $('settings-error').textContent = '请填写知识问答服务的应用 ID（aid- 开头）。'; return; }
  if (agent !== nextAgent && !await conversationManager.create(nextAgent)) return;
  key = nextKey; agent = nextAgent; persist(); updateConnection();
  $('settings-dialog').close(); toast('连接设置已保存，发送问题即可验证。'); $('question').focus();
});
$('forget-key').addEventListener('click', () => {
  if (active || knowledgeManager.isBusy()) { $('settings-error').textContent = '请先结束当前问答或文件操作，再清除 Key。'; return; }
  key = ''; persist(); updateConnection(); $('api-key').value = '';
  toast('当前标签页的 Key 已清除；已发出的体验链接仍可使用。');
});
$('share-link').addEventListener('click', () => {
  if (!key) { openSettings(); return; }
  const link = new URL(location.href); link.search = '';
  link.hash = new URLSearchParams({ access_key: key, agent_id: agent }).toString();
  void copyText(link.href, '体验链接已复制，含 Key，请仅发送给试用同事。');
});
$('export-chat').addEventListener('click', () => {
  if (!turns.length) return toast('还没有可以导出的对话。');
  const text = '# 税务案头 · 对话记录\n\n回答仅供测试，请核对有效法规。\n\n' + turns.map(t =>
    `## ${t.role === 'user' ? '问题' : '回答'}${t.role === 'assistant' && t.status !== 'complete' ? '（未完成）' : ''}\n\n${t.content}\n`
  ).join('\n');
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url;
  link.download = `税务问答-${new Date().toISOString().slice(0, 10)}.md`;
  link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
restore(); updateConnection(); renderAll();
const knowledgeManager = initKnowledgeManager({ getKey: () => key, openSettings, toast });
$('send-button').disabled = true; $('new-chat').disabled = true;
conversationManager = await initConversationManager({
  getState: () => ({ agent, turns, draft: $('question').value }),
  setState: row => { agent = row.agent; turns = row.turns; $('question').value = row.draft; renderAll(); updateConnection(); },
  isBusy: () => Boolean(active), toast, importedAgent,
});
historyReady = true; $('send-button').disabled = false; $('new-chat').disabled = false;
