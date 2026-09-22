import { DEFAULT_AGENT, buildMessages } from './lib/chat.js';
import { renderMarkdown } from './lib/markdown.js';
import { initConversationManager } from './conversation-manager.js?v=20260922-wechat';
import { CHAT_ENDPOINT } from './wechat-config.js?v=20260922-wechat';
import { HISTORY_PREFERENCE, chooseHistoryNamespace } from './lib/wechat-entry.js?v=20260922-public';

const $ = id => document.getElementById(id), ACCESS = 'tax-law-wechat.access';
let manager, turns = [], active = null, ready = false, toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
async function historyNamespace() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let legacy = fragment.get('access'), saved, databases = [];
  if (fragment.has('access')) history.replaceState(null, '', location.pathname + location.search);
  try { legacy ||= sessionStorage.getItem(ACCESS); sessionStorage.removeItem(ACCESS); } catch {}
  try { saved = localStorage.getItem(HISTORY_PREFERENCE); } catch {}
  if (!saved && !legacy) try { databases = await indexedDB.databases(); } catch {}
  const selected = chooseHistoryNamespace({ saved, legacy, databases });
  try { localStorage.setItem(HISTORY_PREFERENCE, selected); } catch {}
  return selected;
}
function refreshEntry() {
  $('connection-label').textContent = '公开试用';
  $('connection-status').classList.add('configured');
  $('entry-notice').hidden = true;
  $('send-button').disabled = !ready || Boolean(active);
}
function render() {
  $('welcome').hidden = Boolean(turns.length); $('messages').hidden = !turns.length;
  $('messages').replaceChildren();
  for (const turn of turns) {
    const article = document.createElement('article'); article.className = 'message ' + turn.role + (turn.status === 'error' ? ' error' : '');
    const heading = document.createElement('div'); heading.className = 'message-heading';
    const avatar = document.createElement('span'); avatar.className = 'message-avatar'; avatar.textContent = turn.role === 'user' ? '你' : '税';
    heading.append(avatar, document.createTextNode(turn.role === 'user' ? '你的问题' : '税务案头'));
    const content = document.createElement('div'); content.className = 'message-content';
    if (turn.role === 'user') content.textContent = turn.content;
    else if (turn.content) renderMarkdown(content, turn.content);
    else if (turn.status === 'pending') { const typing = document.createElement('div'); typing.className = 'typing'; typing.setAttribute('aria-label', '正在等待回答'); typing.append(...Array.from({ length: 3 }, () => document.createElement('b'))); content.append(typing); }
    else content.textContent = '未收到完整回答。';
    article.append(heading, content);
    if (turn.role === 'assistant') {
      const status = document.createElement('div'); status.className = 'message-status'; status.setAttribute('role', 'status');
      const label = document.createElement('span'); label.textContent = turn.status === 'pending' ? '正在检索资料并生成回答，可能需要约一分钟…' : turn.status === 'complete' ? '回答完成 · 请核对原始法规' : turn.error || '上次回答已中断，请重新提问。'; status.append(label);
      if (turn.content) { const copy = document.createElement('button'); copy.textContent = '复制回答'; copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(turn.content); toast('回答已复制。'); } catch { toast('请长按回答文字手动复制。'); } }); status.append(copy); }
      if (['error', 'stopped'].includes(turn.status)) { const retry = document.createElement('button'); retry.textContent = '重新提问'; retry.addEventListener('click', () => { if (active) return; $('question').value = turns[turns.indexOf(turn) - 1]?.content || ''; $('question').focus(); void manager?.save(); }); status.append(retry); }
      article.append(status);
    }
    $('messages').append(article);
  }
}
function busy(value) {
  $('send-button').hidden = value; $('stop-button').hidden = !value; $('new-chat').disabled = value || !ready;
  $('messages').setAttribute('aria-busy', String(value));
  $('composer-hint').textContent = value ? '可继续输入下一问 · 停止等待不保证停止后端计费' : 'Enter 发送 · Shift + Enter 换行';
  refreshEntry();
}
async function send() {
  const question = $('question').value.trim();
  if (!ready || !question || active || manager.isChanging()) return;
  const messages = buildMessages(turns, question), answer = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'pending' };
  const request = new AbortController(); active = request; busy(true);
  turns.push({ id: crypto.randomUUID(), role: 'user', content: question, status: 'complete' }, answer); $('question').value = ''; render(); void manager.save();
  $('scroll-area').scrollTop = $('scroll-area').scrollHeight;
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; request.abort(); }, 175000);
  try {
    const response = await fetch(CHAT_ENDPOINT, { method: 'POST', redirect: 'error', signal: request.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.message || '服务暂时不可用，请稍后重试。');
    if (typeof result.answer !== 'string' || !result.answer.trim()) throw new Error('回答未完整生成，请重新提问。');
    answer.content = result.answer; answer.status = 'complete';
  } catch (error) {
    answer.status = request.signal.aborted && !timeout ? 'stopped' : 'error';
    answer.error = timeout ? '等待超时，请稍后重试。' : request.signal.aborted ? '已停止等待，未完成回答不进入后续上下文。' : error instanceof TypeError ? '连接未成功，请检查网络后重试。' : String(error.message).slice(0, 240);
  } finally {
    clearTimeout(timer); active = null; busy(false); render(); await manager.save();
  }
}
const namespace = await historyNamespace();
refreshEntry();
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } });
$('question').addEventListener('input', () => { if (ready) void manager.save(); });
$('stop-button').addEventListener('click', () => active?.abort());
document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => { $('question').value = button.dataset.question; $('question').focus(); if (ready) void manager.save(); }));
manager = await initConversationManager({ namespace,
  getState: () => ({ agent: DEFAULT_AGENT, turns, draft: $('question').value }),
  setState: row => { turns = row.turns; $('question').value = row.draft; render(); $('scroll-area').scrollTop = $('scroll-area').scrollHeight; },
  isBusy: () => Boolean(active), toast });
ready = true; busy(false);
