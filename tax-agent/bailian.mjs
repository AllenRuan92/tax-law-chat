import { createHash } from 'node:crypto';
import { API_ORIGIN, CATEGORY_ID, KNOWLEDGE_ID, UPLOAD_HOST } from '../lib/knowledge.js';
import { ingestionState } from '../lib/knowledge.js';

const ROUTES = {
  lease: '/api/v1/connector/dash/applyFileUploadLease',
  register: '/api/v1/connector/dash/addFile',
  ingest: '/api/v1/indices/rag/index/job/create',
  status: '/api/v1/indices/rag/index_job/status',
};

export function createBailianPublisher(key, fetcher = fetch) {
  if (!key) throw new Error('缺少百炼管理 Key');
  async function request(route, body, query) {
    const url = new URL(ROUTES[route], API_ORIGIN);
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const res = await fetcher(url, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`百炼 ${route} HTTP ${res.status}`);
    const json = await res.json();
    if (json.success === false || json.status_code >= 400 || (json.code && !['200', 'success'].includes(String(json.code).toLowerCase()))) throw new Error(`百炼 ${route} 返回失败`);
    return json.data ?? json;
  }
  return {
    async lease(fileName, bytes) {
      const data = await request('lease', { category: CATEGORY_ID, fileName, sizeBytes: String(bytes.length), contentMd5: createHash('md5').update(bytes).digest('base64') });
      const url = new URL(data.param?.url);
      if (!data.leaseId || url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST || url.username || url.password || url.port || url.hash || (data.param.method && data.param.method !== 'PUT')) throw new Error('百炼上传地址或凭证无效');
      return { leaseId: data.leaseId, url: url.href, headers: data.param.headers || {} };
    },
    async put(lease, bytes) {
      const headers = Object.fromEntries(Object.entries(lease.headers).filter(([k]) => ['content-type', 'content-md5', 'x-bailian-extra'].includes(k.toLowerCase())));
      const res = await fetcher(lease.url, { method: 'PUT', headers, body: bytes, redirect: 'error', signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`源文件传输失败 HTTP ${res.status}`);
    },
    async register(leaseId, originalFileUrl) {
      const data = await request('register', { leaseId, category: CATEGORY_ID, parser: 'AUTO_SELECT', ...(originalFileUrl ? { originalFileUrl } : {}) });
      if (!data.fileId) throw new Error('百炼未确认文件登记');
      return data.fileId;
    },
    async ingest(fileId) {
      const data = await request('ingest', { indexId: KNOWLEDGE_ID, sourceType: 'DATA_CENTER_FILE', docIds: [fileId] });
      if (!data.ingestionId) throw new Error('百炼未确认入库任务');
      return data.ingestionId;
    },
    async status(jobId) {
      return request('status', undefined, { index_id: KNOWLEDGE_ID, job_id: jobId, page_num: 1, page_size: 100 });
    },
  };
}

export async function publicationPlan(store, id, hash) {
  const record = await store.load(id);
  if (!record || record.currentHash !== hash) throw new Error('云端当前版本已变化，请重新拉取');
  const version = record.versions.find(item => item.hash === hash);
  const reasons = [];
  if (version?.status !== 'approved') reasons.push('当前版本尚未批准');
  if (!version?.decision?.confirmedOriginal || version.decision.effect !== 'current' || !version.decision.applicableFrom || !version.decision.reviewer) reasons.push('缺少原文、效力或适用期间审核');
  const evidence = await store.verifyVersion(id, hash);
  if (evidence.attachments?.length) reasons.push('附件尚未转成可检索正文');
  if (record.versions.some(item => item.hash !== hash && ['published', 'indexed_needs_qa'].includes(item.status))) reasons.push('已有旧版正式索引，须先审核版本切换');
  return { id, hash, status: version?.status, title: record.source.title, attachments: evidence.attachments?.length || 0, fileName: `${id}-${hash.slice(0, 12)}.md`, canPublish: reasons.length === 0, reasons };
}

export async function publishApproved(store, id, { key, publisher = createBailianPublisher(key), now = () => new Date() } = {}) {
  const record = await store.load(id);
  if (!record) throw new Error('待发布资料不存在');
  const version = record.versions.find(v => v.hash === record.currentHash);
  if (!version || version.status !== 'approved') throw new Error('当前版本尚未通过审核');
  if (record.versions.some(v => v.hash !== version.hash && ['published', 'indexed_needs_qa'].includes(v.status))) throw new Error('旧版已在正式库，须先制定并审核版本切换方案');
  const decision = version.decision;
  if (!decision?.confirmedOriginal || decision?.effect !== 'current' || !decision.applicableFrom || !decision.reviewer) throw new Error('缺少原文、审核人或适用期间核验，不得发布');
  const evidence = await store.verifyVersion(id, version.hash);
  if (evidence.attachments?.length) throw new Error('附件内容尚未转成可检索正文，当前禁止发布附件型材料');
  const text = await store.readVersion(id, version.hash, 'source.txt');
  const content = `# ${record.source.title}\n\n资料类型：${record.source.kind === 'interpretation' ? '官方政策解读（非政策原文）' : '政策原文'}\n官方原文：${record.source.url}\n发文单位：${record.source.publisher}\n文号：${record.source.docNumber}\n成文日期：${record.source.issuedDate}\n施行日期：${decision.effectiveDate || '原文未明确，见效力核验说明'}\n适用起始日：${decision.applicableFrom}\n效力核验：${decision.effectNote}\n审核人：${decision.reviewer}\n审核时间：${decision.reviewedAt}\n\n## 原文\n\n${text}\n`;
  const bytes = Buffer.from(content);
  if (bytes.length > 10 * 1024 * 1024) throw new Error('文档超过百炼 Markdown 限制');
  const fileName = `${id}-${version.hash.slice(0, 12)}.md`;
  if (typeof store.claimPublish === 'function') await store.claimPublish(id, version.hash);
  const saveProgress = () => typeof store.savePublicationState === 'function' ? store.savePublicationState(id, version.hash, version) : store.save(record);
  try {
    version.status = 'publishing';
    version.startedPublishAt = now().toISOString();
    await saveProgress();
    const lease = await publisher.lease(fileName, bytes);
    await publisher.put(lease, bytes);
    const fileId = await publisher.register(lease.leaseId, record.source.url);
    version.fileId = fileId;
    await saveProgress();
    version.jobId = await publisher.ingest(fileId);
    version.status = 'indexing';
    await saveProgress();
    return { fileId, jobId: version.jobId, status: version.status };
  } catch (error) {
    version.status = 'reconcile_required';
    version.publishError = error.message;
    await saveProgress();
    throw new Error(`发布状态需核对：${error.message}`);
  }
}

export async function checkPublished(store, id, { publisher, now = () => new Date() } = {}) {
  const record = await store.load(id);
  const version = record?.versions.find(v => v.hash === record.currentHash);
  if (version?.status !== 'indexing' || !version.jobId) throw new Error('没有待检查的入库任务');
  const status = await publisher.status(version.jobId);
  const state = ingestionState(status);
  if (state.stage === 'failed') {
    version.status = 'index_failed';
    version.indexError = state.error;
    if (typeof store.savePublicationState === 'function') await store.savePublicationState(id, version.hash, version);
    else await store.save(record);
    return { status: version.status };
  }
  if (state.stage === 'complete') {
    version.status = 'indexed_needs_qa';
    version.indexedAt = now().toISOString();
    if (typeof store.savePublicationState === 'function') await store.savePublicationState(id, version.hash, version);
    else await store.save(record);
  }
  return { status: version.status };
}
