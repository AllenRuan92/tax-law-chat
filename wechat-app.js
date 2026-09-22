import { DEFAULT_AGENT, buildMessages } from './lib/chat.js';
import { renderMarkdown } from './lib/markdown.js';
import { initConversationManager } from './conversation-manager.js?v=20260922-wechat';
import { CHAT_ENDPOINT } from './wechat-config.js?v=20260922-wechat';

const $ = id => document.getElementById(id), ACCESS = 'tax-law-wechat.access';
let access = '', identity, manager, turns = [], active = null, ready = false, toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function readAccess() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('access')) {
    access = fragment.get('access');
    history.replaceState(null, '', location.pathname + location.search);
    try { sessionStorage.setItem(ACCESS, access); } catch { toast('此浏览器无法暂存入口，刷新后请重新从公众号进入。'); }
  } else try { access = sessionStorage.getItem(ACCESS) || ''; } catch {}
  try {
    if (!/^[\w-]+\.[\w-]+$/.test(access) || access.length > 1024) throw new Error();
    identity = JSON.parse(atob(access.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')));
    if (!/^[a-f0-9]{32}$/.test(identity.sub) || identity.aud !== 'wx6dde485592f7682e' || !Number.isSafeInteger(identity.exp)) throw new Error();
  } catch { access = ''; identity = null; try { sessionStorage.removeItem(ACCESS); } catch {} }
}
function connected() { return Boolean(access && identity?.exp > Date.now() / 1000); }
function refreshEntry() {
  const valid = connected();
  $('connection-label').textContent = valid ? '公众号入口' : '需要新入口';
  $('connection-status').classList.toggle('configured', valid);
  $('entry-notice').hidden = valid;
  $('entry-notice').textContent = '请回到「钻木者得火」公众号，发送任意文字，再点击回复中的专属链接。入口 24 小时有效；原有对话仍保存在此浏览器。';
  $('send-button').disabled = !valid || !ready || Boolean(active);
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
  if (!connected()) { refreshEntry(); toast('请从公众号获取新的专属入口。'); return; }
  const messages = buildMessages(turns, question), answer = { id: crypto.randomUUID(), role: 'assistant', content: '', status: 'pending' };
  const request = new AbortController(); active = request; busy(true);
  turns.push({ id: crypto.randomUUID(), role: 'user', content: question, status: 'complete' }, answer); $('question').value = ''; render(); void manager.save();
  $('scroll-area').scrollTop = $('scroll-area').scrollHeight;
  let timeout = false;
  const timer = setTimeout(() => { timeout = true; request.abort(); }, 175000);
  try {
    const response = await fetch(CHAT_ENDPOINT, { method: 'POST', redirect: 'error', signal: request.signal, headers: { Authorization: 'Bearer ' + access, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages }) });
    if (response.status === 401) { access = ''; try { sessionStorage.removeItem(ACCESS); } catch {} refreshEntry(); }
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
readAccess(); refreshEntry();
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
$('question').addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); void send(); } });
$('question').addEventListener('input', () => { if (ready) void manager.save(); });
$('stop-button').addEventListener('click', () => active?.abort());
document.querySelectorAll('[data-question]').forEach(button => button.addEventListener('click', () => { $('question').value = button.dataset.question; $('question').focus(); if (ready) void manager.save(); }));
manager = await initConversationManager({ namespace: 'tax-law-wechat.' + (identity?.sub || 'guest'),
  getState: () => ({ agent: DEFAULT_AGENT, turns, draft: $('question').value }),
  setState: row => { turns = row.turns; $('question').value = row.draft; render(); $('scroll-area').scrollTop = $('scroll-area').scrollHeight; },
  isBusy: () => Boolean(active), toast });
ready = true; busy(false);
setInterval(refreshEntry, 30000);
