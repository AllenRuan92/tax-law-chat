import { md5Base64 } from './md5.js';
import { UPLOAD_PROXY_URL } from './config.js';

export const KNOWLEDGE_ID = 'uwohowhkia';
export const KNOWLEDGE_NAME = 'tax-law-poc';
export const CATEGORY_ID = 'cate_73e2dc904de24dfda66c07cdc7d58774_12140030';
export const API_ORIGIN = 'https://llm-zc86z2f8ixro6odd.cn-beijing.maas.aliyuncs.com';
export const UPLOAD_HOST = 'dashscope-file-datacenter-prod-01.oss-cn-beijing.aliyuncs.com';
export const PATHS = {
  list: '/api/v1/indices/rag/index/files',
  lease: '/api/v1/connector/dash/applyFileUploadLease',
  register: '/api/v1/connector/dash/addFile',
  ingest: '/api/v1/indices/rag/index/job/create',
  status: '/api/v1/indices/rag/index_job/status',
  remove: '/api/v1/indices/rag/index/delete_file',
  chunks: '/api/v1/indices/rag/index/chunklist',
};
const limits = { pdf: 150, doc: 150, docx: 150, ppt: 150, pptx: 150,
  md: 10, markdown: 10, txt: 10, html: 10, xls: 10, xlsx: 10,
  png: 20, jpg: 20, jpeg: 20, bmp: 20, gif: 20 };
export const FILE_ACCEPT = Object.keys(limits).map(ext => `.${ext}`).join(',');
export function validateFile(file) {
  const extension = file.name.split('.').pop().toLowerCase();
  if (!limits[extension] || !file.name.includes('.')) throw new Error('暂不支持此格式，请使用 PDF、Word、PPT、TXT、Markdown、HTML、Excel 或图片。');
  if (!file.size) throw new Error('不能上传空文件。');
  if (file.size > limits[extension] * 1024 * 1024) throw new Error(`此格式在网页中限 ${limits[extension]} MB。`);
  if (file.name.length > 200) throw new Error('文件名过长，请缩短至 200 个字符以内。');
  return extension;
}
export function sizeLabel(bytes) {
  if (!Number.isFinite(Number(bytes)) || Number(bytes) < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  return bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
export const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;
export function originalDownload(data, doc) {
  const metadata = data?.nodes?.find(node => node.metadata?.doc_id === doc.doc_id &&
    (!node.metadata.pipeline_id || node.metadata.pipeline_id === KNOWLEDGE_ID))?.metadata;
  if (!metadata?.doc_url) throw new Error('尚未取得原文件下载地址，请等待文档解析完成，或在百炼控制台核对源文件。');
  let url;
  try { url = new URL(metadata.doc_url); } catch { throw new Error('原文件下载地址无效。'); }
  if (url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST || url.username || url.password || url.port || url.hash) throw new Error('原文件下载域名不在允许列表，请联系维护者核对。');
  let name = String(doc.doc_name || metadata.doc_name || '知识库文件').replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 180) || '知识库文件';
  const extension = String(doc.doc_type || '').toLowerCase().replace(/^\./, '');
  if (/^[a-z0-9]{1,10}$/.test(extension) && !name.toLowerCase().endsWith('.' + extension)) name += '.' + extension;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = '_' + name;
  return { url: url.href, name };
}
export function docState(doc) {
  const code = String(doc.code || doc.status || '').toUpperCase();
  if (code === 'FINISH' || code === 'COMPLETED' || code === 'SUCCESS') return { kind: 'ready', label: '可检索' };
  if (/FAIL|ERROR/.test(code)) return { kind: 'failed', label: '处理失败' };
  if (/DELET/.test(code)) return { kind: 'pending', label: '移除中' };
  return { kind: 'pending', label: code.includes('PARSE') ? '解析中' : '处理中' };
}
export function ingestionState(status) {
  const rows = Array.isArray(status.rows) ? status.rows : [];
  const failed = rows.find(row => docState(row).kind === 'failed');
  if (failed || /FAIL|ERROR|CANCEL/.test(String(status.ingestion_status).toUpperCase())) {
    return { stage: 'failed', error: failed?.message || '百炼解析或索引构建失败，请检查文件内容。' };
  }
  // A completed job alone is not proof that its documents were indexed.
  if (rows.length && rows.length >= Number(status.total_count || rows.length) && rows.every(row => docState(row).kind === 'ready')) return { stage: 'complete' };
  return { stage: 'indexing' };
}
function checkResult(json) {
  const invalid = json?.success === false || json?.status_code >= 400 ||
    (json?.code !== undefined && !['200', 'success'].includes(String(json.code).toLowerCase()));
  if (invalid) throw new Error(json.message || json.error?.message || '百炼处理失败，请稍后重试。');
}
export function createKnowledgeClient(key, fetcher = globalThis.fetch, uploadProxyUrl = UPLOAD_PROXY_URL) {
  if (!key) throw new Error('请先填写百炼 API Key。');
  async function request(path, { body, query, signal, timeout = 60000 } = {}) {
    const operation = path === PATHS.lease ? 'lease' : path === PATHS.register ? 'register' : null;
    if (operation && !uploadProxyUrl) throw new Error('文件上传代理尚未部署，当前暂不能上传文件。');
    const url = operation ? new URL(uploadProxyUrl) : new URL(path, API_ORIGIN);
    if (operation && (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)) throw new Error('上传代理地址配置无效。');
    if (operation) body = { ...body, operation };
    if (query) Object.entries(query).forEach(([name, value]) => url.searchParams.set(name, value));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeout);
    try {
      const response = await fetcher(url.href, {
        method: body === undefined ? 'GET' : 'POST', signal: controller.signal, redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}：${[401, 403].includes(response.status) ? '请检查 Key 是否具有此工作空间的知识库管理权限。' : response.status === 429 ? '请求过于频繁，请稍后重试。' : '操作未成功，请刷新列表核对后再试。'}`);
      const json = await response.json(); checkResult(json); checkResult(json.data);
      return json.data ?? json;
    } catch (error) {
      if (timedOut) throw new Error('请求超时，结果可能尚未确认。请刷新列表核对，避免重复上传。');
      if (signal?.aborted) throw new Error('操作已停止；已上传的部分不会自动删除。');
      const message = error instanceof TypeError ? '无法连接百炼管理接口，请检查网络或跨域配置。' : error.message;
      throw new Error(String(message).replaceAll(key, '[Key 已隐藏]'));
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function list(page = 1, signal) {
    const data = await request(PATHS.list, { query: { index_id: KNOWLEDGE_ID, page_num: page, page_size: 20 }, signal });
    if (!Array.isArray(data.rows)) throw new Error('文件列表格式异常，请稍后重试。');
    return { rows: data.rows, total: Number(data.total_count ?? data.rows.length) };
  }
  async function ingest(fileId, signal) {
    const data = await request(PATHS.ingest, { body: { indexId: KNOWLEDGE_ID, sourceType: 'DATA_CENTER_FILE', docIds: [fileId] }, signal });
    if (!data.ingestionId) throw new Error('文件已登记，但未收到入库任务 ID。请刷新列表核对。');
    return data.ingestionId;
  }
  async function upload(file, { signal, onStage = () => {}, onProgress = () => {} } = {}) {
    validateFile(file);
    onStage('hashing');
    await new Promise(resolve => setTimeout(resolve, 0));
    const bytes = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    const digest = md5Base64(bytes);
    onStage('leasing');
    const lease = await request(PATHS.lease, { body: { category: CATEGORY_ID, fileName: file.name, sizeBytes: String(file.size), contentMd5: digest }, signal });
    if (!lease.leaseId || !lease.param?.url) throw new Error('未取得有效的上传凭证。');
    const url = new URL(lease.param.url);
    if (url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST || url.username || url.password || url.port) throw new Error('百炼返回了新的上传域名，本页尚未允许该地址；请联系维护者更新配置。');
    if (lease.param.method && lease.param.method !== 'PUT') throw new Error('上传凭证的方法不受支持。');
    onStage('uploading');
    await putFile(url.href, file, lease.param.headers || {}, signal, onProgress);
    onStage('registering');
    const registered = await request(PATHS.register, { body: { leaseId: lease.leaseId, category: CATEGORY_ID, parser: 'AUTO_SELECT' }, signal });
    if (!registered.fileId) throw new Error('未收到文件登记 ID。请先到百炼控制台核对，避免重复上传。');
    onStage('registered', { fileId: registered.fileId });
    const jobId = await ingest(registered.fileId, signal);
    onStage('indexing', { fileId: registered.fileId, jobId });
    return { fileId: registered.fileId, jobId };
  }
  async function status(jobId, signal) {
    return request(PATHS.status, { query: { index_id: KNOWLEDGE_ID, job_id: jobId, page_num: 1, page_size: 100 }, signal });
  }
  async function remove(docId, signal) {
    const result = await request(PATHS.remove, { body: { index_id: KNOWLEDGE_ID, doc_ids: [docId] }, signal });
    if (!Array.isArray(result.deleted) || !result.deleted.includes(docId)) throw new Error('百炼尚未确认移除该文档，请刷新列表核对。');
  }
  async function download(doc, signal) {
    if (!doc?.doc_id) throw new Error('缺少文件 ID，请刷新列表。');
    if (Number(doc.size) > MAX_DOWNLOAD_BYTES) throw new Error('本页下载限 150 MB，请在百炼控制台下载此文件。');
    let data;
    try { data = await request(PATHS.chunks, { body: { indexId: KNOWLEDGE_ID, docId: doc.doc_id, pageNum: 1, pageSize: 1 }, signal }); }
    catch (error) { if (signal?.aborted) throw new Error('下载已取消。'); throw error; }
    const original = originalDownload(data, doc);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, 180000);
    let reader;
    try {
      // Do not send the API Key, cookies or referrer to OSS; never follow redirects.
      const response = await fetcher(original.url, { signal: controller.signal, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`原文件下载失败（HTTP ${response.status}），请重试以获取新地址。`);
      if (Number(response.headers.get('Content-Length')) > MAX_DOWNLOAD_BYTES) throw new Error('文件超过本页 150 MB 下载上限。');
      if (!response.body) throw new Error('未收到原文件内容。');
      reader = response.body.getReader();
      const parts = []; let bytes = 0;
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_DOWNLOAD_BYTES) throw new Error('文件超过本页 150 MB 下载上限。');
        parts.push(value);
      }
      if (!bytes || (Number(doc.size) > 0 && bytes !== Number(doc.size))) throw new Error('下载内容大小与库内记录不一致，请重试或在控制台核对。');
      return { blob: new Blob(parts, { type: 'application/octet-stream' }), name: original.name };
    } catch (error) {
      if (controller.signal.aborted) throw new Error(signal?.aborted ? '下载已取消。' : '下载超时，请重试。');
      if (error instanceof TypeError) throw new Error('无法下载原文件，请检查网络或存储跨域设置。');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); await reader?.cancel().catch(() => {}); controller.abort(); }
  }
  return { list, upload, ingest, status, remove, download };
}

// Raw PUT, not multipart. Never forward the API Key to object storage.
function putFile(url, file, headers, signal, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener('abort', abort);
    xhr.open('PUT', url); xhr.timeout = 300000;
    Object.entries(headers).forEach(([name, value]) => {
      if (['content-type', 'content-md5', 'x-bailian-extra'].includes(name.toLowerCase())) xhr.setRequestHeader(name, value);
    });
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => { cleanup(); xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`文件传输失败（HTTP ${xhr.status}），请重新选择文件上传。`)); };
    xhr.onerror = () => { cleanup(); reject(new Error('文件传输失败，请检查网络及上传存储的跨域设置。')); };
    xhr.ontimeout = () => { cleanup(); reject(new Error('文件传输超过 5 分钟，请检查网络或缩小文件后重试。')); };
    xhr.onabort = () => { cleanup(); reject(new Error('已停止传输；已上传的数据不会自动清除。')); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { cleanup(); reject(new Error('上传已停止。')); return; }
    xhr.send(file);
  });
}
