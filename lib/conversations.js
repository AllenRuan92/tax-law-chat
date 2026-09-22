import { DEFAULT_AGENT } from './chat.js';

export const HISTORY_DB = 'tax-law-chat.history.v2';
export const BACKUP_FORMAT = 'tax-law-chat-conversations';
export const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const newId = () => crypto.randomUUID();
const validAgent = value => typeof value === 'string' && /^aid-[\w-]+$/.test(value);

export function normalizeTurns(turns, interrupted = false) {
  if (!Array.isArray(turns)) throw new Error('对话消息格式不正确。');
  const ids = new Set();
  return turns.map(turn => {
    if (!turn || !['user', 'assistant'].includes(turn.role) || typeof turn.content !== 'string') throw new Error('备份中有无效的消息。');
    const status = ['complete', 'pending', 'stopped', 'error'].includes(turn.status) ? turn.status : 'complete';
    const id = typeof turn.id === 'string' && turn.id.length <= 100 && turn.id && !ids.has(turn.id) ? turn.id : newId();
    ids.add(id);
    return { id, role: turn.role,
      content: turn.content, status: interrupted && status === 'pending' ? 'stopped' : status,
      ...(interrupted && status === 'pending' ? { error: '上次生成已中断，未完成的回答不会进入后续上下文。' }
        : typeof turn.error === 'string' ? { error: turn.error } : {}) };
  });
}
export function conversationTitle(conversation) {
  return conversation.title?.trim() || conversation.turns.find(t => t.role === 'user')?.content.replace(/\s+/g, ' ').trim().slice(0, 36) || '新对话';
}
export function newConversation(agent = DEFAULT_AGENT) {
  const now = Date.now();
  return { id: newId(), title: '', agent: validAgent(agent) ? agent : DEFAULT_AGENT, turns: [], draft: '', createdAt: now, updatedAt: now, revision: 0 };
}
export function cleanConversation(value, interrupted = false) {
  if (!value || !Array.isArray(value.turns) || value.turns.length > 10000) throw new Error('对话格式不正确或消息数量过多。');
  const now = Date.now();
  return { id: typeof value.id === 'string' && /^[\w-]{1,100}$/.test(value.id) ? value.id : newId(),
    title: typeof value.title === 'string' ? value.title.trim().slice(0, 80) : '',
    agent: validAgent(value.agent) ? value.agent : DEFAULT_AGENT,
    turns: normalizeTurns(value.turns, interrupted), draft: typeof value.draft === 'string' ? value.draft.slice(0, 6000) : '',
    createdAt: Number.isFinite(value.createdAt) && value.createdAt > 0 ? value.createdAt : now,
    updatedAt: Number.isFinite(value.updatedAt) && value.updatedAt > 0 ? value.updatedAt : now,
    revision: Number.isSafeInteger(value.revision) && value.revision >= 0 ? value.revision : 0 };
}
export function exportConversations(rows) {
  return JSON.stringify({ format: BACKUP_FORMAT, version: 1, exportedAt: new Date().toISOString(),
    conversations: rows.map(row => cleanConversation(row)) }, null, 2);
}
export function parseBackup(text) {
  if (new Blob([text]).size > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MB。');
  let input;
  try { input = JSON.parse(text); } catch { throw new Error('不是有效的 JSON 备份。'); }
  if (input?.format !== BACKUP_FORMAT || input.version !== 1 || !Array.isArray(input.conversations) || input.conversations.length > 2000) throw new Error('请选择本页导出的对话备份（最多 2,000 段）。');
  return input.conversations.map(row => ({ ...cleanConversation(row, true), id: newId(), revision: 0 }));
}
export class HistoryConflict extends Error {
  constructor() { super('这段对话已在另一标签页修改或删除。'); this.name = 'HistoryConflict'; }
}

export async function openConversationStore(idb = globalThis.indexedDB) {
  if (!idb) throw new Error('浏览器未提供本地数据库。');
  const db = await new Promise((resolve, reject) => {
    const request = idb.open(HISTORY_DB, 1);
    let stopped = false;
    const timer = setTimeout(() => { stopped = true; reject(new Error('本地数据库暂时被其他标签页占用。')); }, 8000);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('conversations', { keyPath: 'id' });
      db.createObjectStore('meta');
    };
    request.onerror = () => { clearTimeout(timer); reject(request.error); };
    request.onsuccess = () => { clearTimeout(timer); if (stopped) request.result.close(); else resolve(request.result); };
  });
  db.onversionchange = () => db.close();
  const transaction = (stores, mode, perform) => new Promise((resolve, reject) => {
    let tx, result, failure;
    try { tx = db.transaction(stores, mode); } catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(failure || tx.error || new Error('本地数据库操作失败。'));
    tx.onabort = () => reject(failure || tx.error || new Error('本地数据库操作中断。'));
    try { perform(tx, value => { result = value; }, error => { failure = error; tx.abort(); }); }
    catch (error) { failure = error; tx.abort(); }
  });
  return {
    durable: true,
    list: () => transaction(['conversations'], 'readonly', (tx, done) => {
      tx.objectStore('conversations').getAll().onsuccess = e => done(e.target.result.sort((a, b) => b.updatedAt - a.updatedAt));
    }),
    get: id => transaction(['conversations'], 'readonly', (tx, done) => { tx.objectStore('conversations').get(id).onsuccess = e => done(e.target.result); }),
    save: (input, expectedRevision = 0) => transaction(['conversations', 'meta'], 'readwrite', (tx, done, fail) => {
      const row = cleanConversation(input); const store = tx.objectStore('conversations');
      store.get(row.id).onsuccess = e => {
        const previous = e.target.result;
        if ((previous?.revision ?? 0) !== expectedRevision || (!previous && expectedRevision !== 0)) return fail(new HistoryConflict());
        row.revision = expectedRevision + 1;
        store.put(row); tx.objectStore('meta').put(row.id, 'lastActive'); done(row);
      };
    }),
    remove: (id, revision) => transaction(['conversations'], 'readwrite', (tx, done, fail) => {
      const store = tx.objectStore('conversations');
      store.get(id).onsuccess = e => {
        if (e.target.result && e.target.result.revision !== revision) return fail(new HistoryConflict());
        store.delete(id); done(true);
      };
    }),
    lastActive: () => transaction(['meta'], 'readonly', (tx, done) => { tx.objectStore('meta').get('lastActive').onsuccess = e => done(e.target.result); }),
    migrate: (token, input) => transaction(['conversations', 'meta'], 'readwrite', (tx, done) => {
      const meta = tx.objectStore('meta');
      meta.get('migration:' + token).onsuccess = e => {
        if (e.target.result) { done(e.target.result); return; }
        const row = cleanConversation(input, true); row.revision = 1;
        tx.objectStore('conversations').put(row); meta.put(row.id, 'migration:' + token); meta.put(row.id, 'lastActive'); done(row.id);
      };
    }),
    import: inputs => transaction(['conversations'], 'readwrite', (tx, done) => {
      const rows = inputs.map(input => ({ ...cleanConversation(input, true), id: newId(), revision: 1 }));
      for (const row of rows) tx.objectStore('conversations').add(row);
      done(rows);
    }),
  };
}

export function memoryConversationStore(seed) {
  let rows = seed ? seed.map(row => cleanConversation(row, true)) : [];
  if (!seed) try { rows = JSON.parse(sessionStorage.getItem('tax-law-chat.memory.v2') || '[]').map(row => cleanConversation(row, true)); } catch {}
  const persist = () => { try { sessionStorage.setItem('tax-law-chat.memory.v2', JSON.stringify(rows)); } catch {} };
  return { durable: false, list: async () => clone(rows).sort((a, b) => b.updatedAt - a.updatedAt), get: async id => clone(rows.find(r => r.id === id) || null),
    lastActive: async () => rows[0]?.id,
    save: async (row, revision = 0) => {
      const old = rows.find(r => r.id === row.id);
      if ((old?.revision ?? 0) !== revision) throw new HistoryConflict();
      const saved = { ...cleanConversation(row), revision: revision + 1 };
      rows = [saved, ...rows.filter(r => r.id !== row.id)]; persist(); return clone(saved);
    }, remove: async id => { rows = rows.filter(r => r.id !== id); persist(); },
    migrate: async (token, row) => { const old = rows.find(r => r.id === 'legacy-' + token); if (old) return old.id;
      const saved = { ...cleanConversation(row, true), id: 'legacy-' + token, revision: 1 }; rows.push(saved); persist(); return saved.id; },
    import: async inputs => { const added = inputs.map(r => ({ ...cleanConversation(r, true), id: newId(), revision: 1 })); rows.push(...added); persist(); return clone(added); },
  };
}
