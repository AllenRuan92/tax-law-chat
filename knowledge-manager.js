import { createKnowledgeClient, docState, ingestionState, FILE_ACCEPT, sizeLabel, validateFile } from './lib/knowledge.js?v=20260922-history';
import { downloadBlob } from './conversation-manager.js?v=20260922-history';

const $ = id => document.getElementById(id);
const TASK_STORE = 'tax-law-chat.upload-tasks.v1';
const stages = { selected: '待上传', hashing: '校验文件', leasing: '申请上传', uploading: '传输中',
  registering: '登记文件', registered: '已登记，提交入库', indexing: '解析入库中', complete: '可检索',
  failed: '处理失败', stopped: '已停止' };
export function initKnowledgeManager({ getKey, openSettings, toast }) {
  let tasks = [], currentPage = 1, total = 0, timer, listBusy = false, uploading = false;
  let uploadController, selectedDoc = null, removing = false, stopped = false;
  const pendingRemovals = new Map();
  const downloads = new Map();
  const dialog = $('knowledge-dialog');
  try {
    const saved = JSON.parse(sessionStorage.getItem(TASK_STORE) || '[]');
    if (Array.isArray(saved)) tasks = saved.slice(-30).filter(t => t.jobId || t.fileId).map(t => ({ ...t,
      stage: t.jobId && t.stage !== 'complete' && t.stage !== 'failed' ? 'indexing' : t.stage === 'complete' ? 'complete' : 'failed',
      error: !t.jobId ? '上次操作已中断；文件可能已在数据中心，请刷新列表核对。' : t.error,
    }));
  } catch { /* Storage is optional. */ }
  const client = () => createKnowledgeClient(getKey());
  function saveTasks() {
    try { sessionStorage.setItem(TASK_STORE, JSON.stringify(tasks.filter(t => t.fileId || t.jobId).map(({ file, ...task }) => task))); }
    catch { /* Current in-memory task status remains usable. */ }
  }
  function errorMessage(message) { $('knowledge-error').textContent = message || ''; $('knowledge-error').hidden = !message; }
  function button(label, action, className = 'text-button') {
    const el = document.createElement('button'); el.type = 'button'; el.className = className; el.textContent = label;
    el.addEventListener('click', action); return el;
  }
  function renderTasks() {
    const list = $('upload-queue'); list.hidden = !tasks.length; list.replaceChildren();
    for (const task of tasks) {
      const li = document.createElement('li'); li.className = 'upload-task';
      const name = document.createElement('strong'); name.textContent = task.name;
      const detail = document.createElement('span'); detail.textContent = `${sizeLabel(task.size)} · ${stages[task.stage] || task.stage}${task.stage === 'uploading' ? ` ${task.progress || 0}%` : ''}`;
      detail.className = `upload-task-state ${task.stage}`;
      li.append(name, detail);
      if (task.error) { const error = document.createElement('p'); error.textContent = task.error; error.className = 'task-error'; li.append(error); }
      if (task.stage === 'selected') li.append(button('取消选择', () => { tasks = tasks.filter(t => t !== task); renderTasks(); }));
      if (task.fileId && !task.jobId && task.stage === 'failed') {
        li.append(button('重试入库（不重传）', () => void retryImport(task)));
      }
      list.append(li);
    }
    const selected = tasks.filter(t => t.stage === 'selected').length;
    $('start-upload').disabled = uploading || selected === 0;
    $('start-upload').textContent = uploading ? '正在上传…' : selected ? `上传 ${selected} 个文件` : '开始上传';
    $('stop-upload').hidden = !uploading;
    $('knowledge-files').disabled = uploading;
    $('drop-zone').classList.toggle('disabled', uploading);
    $('clear-upload-queue').hidden = !tasks.length || uploading || tasks.some(t => t.stage === 'indexing');
    const ready = tasks.filter(t => t.stage === 'complete').length;
    const pending = tasks.filter(t => t.stage === 'indexing').length;
    $('upload-summary').textContent = tasks.length ? `${ready} 个可检索${pending ? ` · ${pending} 个解析入库中` : ''}${selected ? ` · ${selected} 个待上传` : ''}` : '';
    saveTasks();
  }
  function selectFiles(files) {
    if (uploading) return toast('请等待当前上传结束。');
    const added = Array.from(files);
    if (added.length + tasks.filter(t => t.stage === 'selected').length > 10) return errorMessage('每批最多选择 10 个文件，请分批上传。');
    const errors = [];
    for (const file of added) {
      try {
        validateFile(file);
        if (tasks.some(t => t.name === file.name && t.size === file.size && ['selected', 'indexing'].includes(t.stage))) { errors.push(`${file.name}：已在任务中。`); continue; }
        tasks.push({ id: crypto.randomUUID(), name: file.name, size: file.size, stage: 'selected', file });
      } catch (error) { errors.push(`${file.name}：${error.message}`); }
    }
    // Retain in-progress work even when many files have been handled in this tab.
    if (tasks.length > 30) tasks = [...tasks.filter(t => !['complete', 'failed', 'stopped'].includes(t.stage)), ...tasks.filter(t => ['complete', 'failed', 'stopped'].includes(t.stage)).slice(-20)];
    errorMessage(errors.join('\n')); renderTasks(); $('knowledge-files').value = '';
  }
  async function startUpload() {
    if (uploading) return;
    if (!getKey()) return openSettings();
    uploading = true; stopped = false; errorMessage(''); renderTasks();
    const api = client();
    for (const task of tasks.filter(t => t.stage === 'selected')) {
      if (stopped) break;
      uploadController = new AbortController();
      try {
        await api.upload(task.file, {
          signal: uploadController.signal,
          onStage: (stage, ids = {}) => { Object.assign(task, { stage }, ids); renderTasks(); },
          onProgress: progress => { task.progress = progress; renderTasks(); },
        });
      } catch (error) {
        task.stage = stopped && !task.fileId ? 'stopped' : 'failed';
        task.error = error.message;
      } finally { delete task.file; renderTasks(); }
    }
    uploading = false; uploadController = null; renderTasks(); currentPage = 1;
    await refresh(); schedule();
    if (!dialog.open) toast('上传阶段已结束，可打开知识库管理查看入库状态。');
  }
  async function retryImport(task) {
    if (uploading || !getKey()) return;
    if (!confirm('文件已在百炼数据中心。确认已刷新列表且尚未入库后，重新提交入库任务？')) return;
    uploading = true; stopped = false; uploadController = new AbortController(); task.error = ''; task.stage = 'registered'; renderTasks();
    try { task.jobId = await client().ingest(task.fileId, uploadController.signal); task.stage = 'indexing'; }
    catch (error) { task.stage = 'failed'; task.error = error.message; }
    finally { uploading = false; uploadController = null; renderTasks(); await refresh(); schedule(); }
  }
  function renderDocuments(rows) {
    const list = $('documents-list'); list.replaceChildren();
    if (!rows.length) {
      const p = document.createElement('p'); p.className = 'documents-empty'; p.textContent = '这一页还没有文档。上传并完成解析后，资料会显示在这里。'; list.append(p);
    }
    for (const doc of rows) {
      const row = document.createElement('article'); row.className = 'document-row';
      const type = document.createElement('span'); type.className = 'document-type'; type.textContent = (doc.doc_type || '文档').toUpperCase();
      const body = document.createElement('div'); body.className = 'document-info';
      const name = document.createElement('strong'); name.textContent = doc.doc_name || doc.doc_id;
      const meta = document.createElement('p');
      const date = Number(doc.gmt_modified) > 0 ? new Date(Number(doc.gmt_modified)).toLocaleString('zh-CN') : '';
      meta.textContent = [sizeLabel(doc.size), date].filter(Boolean).join(' · ');
      body.append(name, meta);
      const removingAt = pendingRemovals.get(doc.doc_id);
      const state = removingAt ? { kind: 'pending', label: '移除同步中' } : docState(doc);
      const badge = document.createElement('span'); badge.className = `document-state ${state.kind}`; badge.textContent = state.label;
      if (state.kind === 'failed' && doc.message) { const reason = document.createElement('p'); reason.className = 'task-error'; reason.textContent = doc.message; body.append(reason); }
      const remove = button('移除', () => openRemove(doc), 'remove-document-button');
      remove.disabled = doc.canDelete === false || Boolean(removingAt) || uploading;
      remove.setAttribute('aria-label', `移除 ${doc.doc_name || doc.doc_id}`);
      const download = button(downloads.has(doc.doc_id) ? '取消下载' : '下载', () => void downloadDocument(doc), 'text-button download-document-button');
      download.disabled = Boolean(removingAt);
      download.setAttribute('aria-label', `${downloads.has(doc.doc_id) ? '取消下载' : '下载原文件'} ${doc.doc_name || doc.doc_id}`);
      const actions = document.createElement('div'); actions.className = 'document-actions'; actions.append(download, remove);
      row.append(type, body, badge, actions); list.append(row);
    }
    $('document-count').textContent = total;
    $('documents-page').textContent = `第 ${currentPage} / ${Math.max(1, Math.ceil(total / 20))} 页`;
    $('documents-prev').disabled = currentPage <= 1;
    $('documents-next').disabled = currentPage * 20 >= total;
  }
  async function downloadDocument(doc) {
    if (downloads.has(doc.doc_id)) { downloads.get(doc.doc_id).abort(); return; }
    if (downloads.size) return toast('请等待当前文件下载完成，或先取消下载。');
    const controller = new AbortController(); downloads.set(doc.doc_id, controller);
    errorMessage('');
    // Update only this row so a slow refresh cannot make the action appear idle.
    const update = () => {
      for (const row of $('documents-list').children) {
        const button = row.querySelector('.download-document-button');
        if (button?.getAttribute('aria-label')?.endsWith(` ${doc.doc_name || doc.doc_id}`)) {
          button.textContent = downloads.has(doc.doc_id) ? '取消下载' : '下载';
          button.setAttribute('aria-label', `${downloads.has(doc.doc_id) ? '取消下载' : '下载原文件'} ${doc.doc_name || doc.doc_id}`);
        }
      }
    };
    update();
    try {
      const result = await client().download(doc, controller.signal);
      downloadBlob(result.blob, result.name); toast('原文件已交给浏览器下载，请在下载列表中查看。');
    } catch (error) { errorMessage(error.message); }
    finally { downloads.delete(doc.doc_id); update(); }
  }
  async function refresh(quiet = false) {
    if (listBusy || !getKey()) return;
    listBusy = true; $('refresh-documents').disabled = true;
    try {
      const api = client();
      let result = await api.list(currentPage);
      if (!result.rows.length && currentPage > 1 && result.total <= (currentPage - 1) * 20) { currentPage = Math.max(1, Math.ceil(result.total / 20)); result = await api.list(currentPage); }
      total = result.total;
      for (const [id, since] of pendingRemovals) {
        if (Date.now() - since > 60000) pendingRemovals.delete(id);
      }
      renderDocuments(result.rows);
      // Only fetch status for a small, bounded number of active upload jobs.
      for (const task of tasks.filter(t => t.stage === 'indexing' && t.jobId).slice(0, 10)) {
        const status = await api.status(task.jobId);
        Object.assign(task, ingestionState(status));
      }
      renderTasks();
      $('documents-updated').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN')} · 面板打开时每 5 秒刷新`;
      if (!quiet) errorMessage('');
    } catch (error) { errorMessage(error.message); }
    finally { listBusy = false; $('refresh-documents').disabled = false; }
  }
  function schedule() {
    clearTimeout(timer);
    if (dialog.open) timer = setTimeout(async () => { if (!document.hidden) await refresh(true); schedule(); }, 5000);
  }
  async function open() {
    if (!getKey()) { toast('请先填写有知识库管理权限的 Key。'); openSettings(); return; }
    dialog.showModal(); renderTasks(); await refresh(); schedule();
  }
  function openRemove(doc) {
    if (uploading) return toast('请等当前上传结束后再移除文档。');
    selectedDoc = doc; $('remove-document-name').textContent = doc.doc_name || doc.doc_id;
    $('remove-document-check').checked = false; $('confirm-remove-document').disabled = true;
    $('remove-document-error').textContent = ''; $('remove-document-dialog').showModal();
  }
  async function confirmRemove() {
    if (removing || !selectedDoc || !$('remove-document-check').checked) return;
    removing = true; $('confirm-remove-document').disabled = true; $('cancel-remove-document').disabled = true;
    const doc = selectedDoc;
    try {
      await client().remove(doc.doc_id);
      pendingRemovals.set(doc.doc_id, Date.now());
      $('remove-document-dialog').close(); toast('已从本知识库移除；源文件仍保留在百炼数据中心。');
      await refresh(); schedule();
    } catch (error) { $('remove-document-error').textContent = error.message; }
    finally { removing = false; $('confirm-remove-document').disabled = !$('remove-document-check').checked; $('cancel-remove-document').disabled = false; }
  }
  $('knowledge-files').accept = FILE_ACCEPT;
  $('knowledge-files').addEventListener('change', event => selectFiles(event.target.files));
  $('drop-zone').addEventListener('dragover', event => { event.preventDefault(); $('drop-zone').classList.add('dragover'); });
  $('drop-zone').addEventListener('dragleave', () => $('drop-zone').classList.remove('dragover'));
  $('drop-zone').addEventListener('drop', event => { event.preventDefault(); $('drop-zone').classList.remove('dragover'); selectFiles(event.dataTransfer.files); });
  $('open-knowledge').addEventListener('click', () => void open());
  $('close-knowledge').addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { clearTimeout(timer); if (uploading) toast('上传仍在进行，请勿关闭或刷新整个页面。'); });
  $('start-upload').addEventListener('click', () => void startUpload());
  $('stop-upload').addEventListener('click', () => { stopped = true; uploadController?.abort(); });
  $('clear-upload-queue').addEventListener('click', () => { tasks = []; renderTasks(); });
  $('refresh-documents').addEventListener('click', () => void refresh());
  $('documents-prev').addEventListener('click', () => { if (currentPage > 1 && !listBusy) { currentPage--; void refresh(); } });
  $('documents-next').addEventListener('click', () => { if (currentPage * 20 < total && !listBusy) { currentPage++; void refresh(); } });
  $('remove-document-check').addEventListener('change', () => { $('confirm-remove-document').disabled = removing || !$('remove-document-check').checked; });
  $('cancel-remove-document').addEventListener('click', () => $('remove-document-dialog').close());
  $('confirm-remove-document').addEventListener('click', () => void confirmRemove());
  $('remove-document-dialog').addEventListener('cancel', event => { if (removing) event.preventDefault(); });
  window.addEventListener('beforeunload', event => { if (uploading) { event.preventDefault(); event.returnValue = ''; } });
  return { isBusy: () => uploading || removing || downloads.size > 0 };
}
