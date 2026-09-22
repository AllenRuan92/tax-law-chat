import { DEFAULT_AGENT } from './lib/chat.js';
import { cleanConversation, conversationTitle, newConversation, openConversationStore,
  memoryConversationStore, HistoryConflict, exportConversations, parseBackup, MAX_BACKUP_BYTES } from './lib/conversations.js';

const ACTIVE = 'tax-law-chat.active.v2', RECOVERY = 'tax-law-chat.recovery.v2', LEGACY = 'tax-law-chat.v1';
const $ = id => document.getElementById(id);
const sessionGet = name => { try { return sessionStorage.getItem(name); } catch { return null; } };
const sessionSet = (name, value) => { try { value === null ? sessionStorage.removeItem(name) : sessionStorage.setItem(name, value); } catch {} };
const signature = row => JSON.stringify([row.agent, row.title, row.turns, row.draft]);

export async function initConversationManager({ getState, setState, isBusy, toast, importedAgent }) {
  let store, current, rows = [], queue = Promise.resolve(), editTarget, changing = false, warning = '', sequence = 0;
  let channel;
  try { channel = new BroadcastChannel('tax-law-chat.history'); } catch {}
  try { store = await openConversationStore(); rows = await store.list(); }
  catch { store = memoryConversationStore(); warning = '本地数据库不可用：记录暂存当前标签页，请及时导出备份。'; }
  function status() {
    for (const node of document.querySelectorAll('[data-history-status]')) {
      node.textContent = warning || '保存在此浏览器 · 不与同事或其他设备同步';
      node.classList.toggle('storage-warning', Boolean(warning));
    }
  }
  function enqueue(action) {
    const next = queue.then(action);
    queue = next.catch(() => {});
    return next;
  }
  function use(row) {
    current = cleanConversation(row, true);
    current.signature = signature(current);
    sessionSet(ACTIVE, current.id);
    setState(current);
  }
  function liveRow() { return cleanConversation({ ...current, ...getState() }); }
  async function refresh() {
    rows = await store.list(); render();
  }
  function render() {
    status();
    $('current-title').textContent = conversationTitle(current);
    $('current-title').title = conversationTitle(current);
    for (const container of document.querySelectorAll('[data-conversation-list]')) {
      container.replaceChildren();
      for (const row of rows) {
        const item = document.createElement('div'); item.className = 'history-item';
        const selected = row.id === current.id;
        item.classList.toggle('selected', selected);
        const open = document.createElement('button'); open.type = 'button'; open.className = 'history-open';
        const title = document.createElement('strong'); title.textContent = conversationTitle(row);
        const meta = document.createElement('span');
        meta.textContent = `${new Date(row.updatedAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })} · ${row.turns.filter(t => t.role === 'user').length} 个问题`;
        open.append(title, meta); open.title = title.textContent;
        if (selected) open.setAttribute('aria-current', 'true');
        open.addEventListener('click', () => void switchTo(row.id));
        const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'history-edit'; edit.textContent = '⋯';
        edit.setAttribute('aria-label', `管理对话：${title.textContent}`);
        edit.addEventListener('click', () => {
          if (blocked()) return;
          editTarget = row; $('conversation-name').value = conversationTitle(row);
          $('conversation-error').textContent = ''; $('conversation-dialog').showModal();
        });
        item.append(open, edit); container.append(item);
      }
    }
  }
  function blocked() {
    if (isBusy() || changing) { toast('请先等待当前回答完成，或停止生成。'); return true; }
    return false;
  }
  function save() {
    const entry = current, snapshot = liveRow(), ticket = ++sequence;
    // A tab-local recovery copy survives refresh even if an IndexedDB write is interrupted.
    if (signature(snapshot) !== entry.signature) sessionSet(RECOVERY, JSON.stringify(snapshot));
    return enqueue(async () => {
      if (signature(snapshot) === entry.signature) return true;
      let candidate = { ...snapshot, id: entry.id, title: entry.title, updatedAt: Date.now() };
      try {
        let saved;
        try { saved = await store.save(candidate, entry.revision); }
        catch (error) {
          if (!(error instanceof HistoryConflict)) throw error;
          candidate = { ...candidate, id: crypto.randomUUID(), revision: 0, title: conversationTitle(candidate).slice(0, 65) + '（恢复副本）' };
          saved = await store.save(candidate, 0);
          toast('另一标签页已修改或删除原对话，你在本页的内容已另存为恢复副本。');
        }
        Object.assign(entry, saved, { signature: signature(saved) });
        if (current === entry) sessionSet(ACTIVE, entry.id);
        if (ticket === sequence) sessionSet(RECOVERY, null);
        if (store.durable) warning = '';
        channel?.postMessage('updated'); await refresh(); return true;
      } catch {
        warning = '本次修改未能保存，可能空间不足。请先导出备份，再清理旧对话或检查浏览器设置。';
        status(); toast('聊天仍在本页，请及时导出备份，暂不要关闭页面。'); return false;
      }
    });
  }
  async function navigate(action, saveFirst = true) {
    if (blocked()) return false;
    changing = true;
    $('question').disabled = true;
    try {
      if (saveFirst) { if (!await save()) return false; } else await queue;
      await action(); await refresh(); return true;
    }
    catch { toast('无法读取或保存本地对话，请导出备份后重试。'); return false; }
    finally { changing = false; $('question').disabled = false; }
  }
  async function switchTo(id) {
    await navigate(async () => {
      const row = await store.get(id);
      if (!row) { toast('此对话已被另一标签页删除。'); return; }
      use(row); $('history-dialog').close();
    });
  }
  async function create(agent = getState().agent) {
    const created = await navigate(async () => {
      use(await store.save(newConversation(agent), 0)); channel?.postMessage('updated'); $('history-dialog').close();
    });
    if (created) $('question').focus();
    return created;
  }
  async function backup() {
    if (isBusy() || changing) { toast('请先结束当前回答，再备份对话。'); return; }
    await save();
    try {
      const all = await store.list(), live = liveRow();
      const at = all.findIndex(row => row.id === live.id);
      if (at < 0) all.unshift(live); else all[at] = live;
      downloadBlob(new Blob([exportConversations(all)], { type: 'application/json' }), `税务案头-全部对话-${new Date().toISOString().slice(0, 10)}.json`);
      toast('已导出全部对话备份；连接 Key 不在备份中。');
    } catch { toast('备份失败，请尝试导出当前对话，并检查浏览器设置。'); }
  }

  // Old single-tab conversations are migrated atomically and only removed after a durable commit.
  let initialId = sessionGet(ACTIVE);
  const temporary = sessionGet('tax-law-chat.memory.v2');
  if (store.durable && temporary) {
    try {
      for (const row of JSON.parse(temporary)) {
        const id = await store.migrate('temporary-' + row.id + '-' + row.revision, { ...row, id: crypto.randomUUID() });
        if (row.id === initialId) initialId = id;
      }
      sessionSet('tax-law-chat.memory.v2', null);
    } catch { warning = '临时记录尚未全部恢复，请保留当前标签页并导出备份。'; }
  }
  const legacy = sessionGet(LEGACY);
  if (legacy) {
    try {
      const old = JSON.parse(legacy);
      if (Array.isArray(old.turns) && old.turns.length) {
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([old.agent, old.turns])));
        const token = Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
        initialId = await store.migrate(token, { ...newConversation(old.agent), turns: old.turns });
      }
      if (store.durable) sessionSet(LEGACY, null);
    } catch { warning = '旧对话暂未迁移成功，原记录仍保留在此标签页；请勿清理站点数据。'; }
  }
  const recovery = sessionGet(RECOVERY);
  if (recovery) {
    try {
      const row = cleanConversation(JSON.parse(recovery), true), existing = await store.get(row.id);
      if (existing && signature(cleanConversation(existing, true)) === signature(row)) initialId = existing.id;
      else {
        // Keep both versions: a stale refresh must never overwrite another tab's work.
        const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(recovery));
        const token = 'recovery-' + Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
        initialId = await store.migrate(token, { ...row, id: crypto.randomUUID(), title: conversationTitle(row).slice(0, 65) + '（恢复副本）' });
      }
      if (store.durable) sessionSet(RECOVERY, null);
    } catch { warning = '有未恢复的对话，原记录仍保留在此标签页，请勿清理站点数据。'; }
  }
  rows = await store.list();
  const selectedId = initialId || await store.lastActive();
  const row = (selectedId ? await store.get(selectedId) : null) || rows[0];
  async function initialSave(agent) {
    try { return await store.save(newConversation(agent), 0); }
    catch {
      // Full/disabled site storage must not leave the entire UI stuck at startup.
      store = memoryConversationStore(rows);
      warning = '本地数据库无法写入：记录暂存当前标签页，请及时导出备份。';
      return store.save(newConversation(agent), 0);
    }
  }
  if (row) use(row); else use(await initialSave(importedAgent || DEFAULT_AGENT));
  if (importedAgent && importedAgent !== current.agent) use(await initialSave(importedAgent));
  await refresh();

  $('new-chat').addEventListener('click', () => void create());
  $('history-new').addEventListener('click', () => void create());
  $('open-history').addEventListener('click', () => { $('history-dialog').showModal(); void refresh(); });
  $('close-history').addEventListener('click', () => $('history-dialog').close());
  $('close-conversation').addEventListener('click', () => $('conversation-dialog').close());
  document.querySelectorAll('[data-export-history]').forEach(node => node.addEventListener('click', () => void backup()));
  document.querySelectorAll('[data-import-history]').forEach(node => node.addEventListener('click', () => { if (!blocked()) $('history-file').click(); }));
  $('history-file').addEventListener('change', async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file || blocked()) return;
    try {
      if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件不能超过 20 MB。');
      const imported = parseBackup(await file.text());
      if (!imported.length) return toast('这个备份没有对话。');
      if (!confirm(`导入 ${imported.length} 段对话？将作为新记录加入，不会覆盖已有对话。`)) return;
      await navigate(async () => {
        await store.import(imported); channel?.postMessage('updated'); toast(`已导入 ${imported.length} 段对话。`);
      });
    } catch (error) { toast(error.message); }
  });
  $('conversation-form').addEventListener('submit', async event => {
    event.preventDefault();
    const title = $('conversation-name').value.trim();
    if (!title) { $('conversation-error').textContent = '请输入对话名称。'; return; }
    const target = editTarget;
    await navigate(async () => {
      const row = target.id === current.id ? liveRow() : target;
      const saved = await store.save({ ...row, title, updatedAt: Date.now() }, row.revision);
      if (row.id === current.id) { current = saved; current.signature = signature(saved); }
      $('conversation-dialog').close(); channel?.postMessage('updated');
    }, target.id === current.id);
  });
  $('delete-conversation').addEventListener('click', async () => {
    const target = editTarget;
    if (blocked() || !confirm(`删除「${conversationTitle(target)}」？只删除此浏览器中的对话，不影响知识库。无法撤销，建议先备份。`)) return;
    await navigate(async () => {
      const isCurrent = current.id === target.id;
      await store.remove(target.id, isCurrent ? current.revision : target.revision);
      if (isCurrent) {
        const remaining = await store.list();
        use(remaining[0] || await store.save(newConversation(getState().agent), 0));
      }
      $('conversation-dialog').close(); channel?.postMessage('updated'); toast('已删除本机对话，知识库未受影响。');
    }, target.id === current.id);
  });
  const externalRefresh = () => { if (!changing) void refresh().catch(() => {}); };
  channel?.addEventListener('message', externalRefresh);
  window.addEventListener('focus', externalRefresh);
  window.addEventListener('pagehide', () => {
    const row = liveRow(); if (signature(row) !== current.signature) sessionSet(RECOVERY, JSON.stringify(row));
  });
  return { save, create, isChanging: () => changing };
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = name; link.hidden = true; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
