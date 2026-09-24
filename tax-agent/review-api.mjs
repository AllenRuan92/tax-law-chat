import { safeId } from './store.mjs';
import { decideVersion } from './review-decision.mjs';
import { checkPublished, createBailianPublisher, publicationPlan, publishApproved } from './bailian.mjs';

const HASH = /^[a-f0-9]{64}$/;
const PUBLIC_FILES = new Set(['source.html', 'source.txt', 'review.md']);
const STATUS_ORDER = { pending_review: 0, approved: 1, publishing: 2, indexing: 2, reconcile_required: 2, index_failed: 2, indexed_needs_qa: 2, rejected: 3 };
const PRIORITY = { high: 0, medium: 1, low: 2, skip: 3 };

function current(record) { return record.versions.find(version => version.hash === record.currentHash); }
function assertHash(hash) { if (typeof hash !== 'string' || !HASH.test(hash)) throw new ReviewError(400, '版本校验值无效'); }
function assertId(id) { try { return safeId(id); } catch { throw new ReviewError(400, '资料 ID 无效'); } }
function checkCurrent(record, hash) {
  if (!record) throw new ReviewError(404, '资料不存在');
  if (record.currentHash !== hash) throw new ReviewError(409, '云端版本已变化，请刷新后重新审核');
  return current(record);
}
function summary(record) {
  const version = current(record);
  const source = record.source;
  return {
    id: record.id, title: source.title, docNumber: source.docNumber || '', publisher: source.publisher || '',
    issuedDate: source.issuedDate || '', kind: source.kind, category: source.category || '',
    priority: source.relevance?.level || 'low', status: version?.status || 'unknown',
    hash: record.currentHash, changeOrigin: version?.changeOrigin || '', discoveredAt: version?.discoveredAt || '',
    attachmentCount: version?.attachmentCount ?? null,
  };
}
async function latestRun(store) {
  try {
    const object = await store.client.get(store.key('reports/latest.json'));
    const data = JSON.parse(object.content.toString('utf8'));
    return { generatedAt: data.generatedAt || '', status: data.report?.status || 'unknown', errors: data.report?.errors || [], sourceResults: data.report?.sourceResults || [] };
  } catch (error) {
    if (error.code === 'NoSuchKey' || error.status === 404) return null;
    throw error;
  }
}
export class ReviewError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export async function reviewOperation({ store, signer, key, publisherFactory = createBailianPublisher }, input) {
  const operation = input?.operation;
  if (operation === 'list') {
    const page = input.page === undefined ? 1 : Number(input.page);
    if (!Number.isSafeInteger(page) || page < 1 || page > 10000) throw new ReviewError(400, '页码无效');
    const allowed = new Set(['all', 'pending_review', 'approved', 'processing', 'history']);
    const filter = input.status || 'pending_review';
    if (!allowed.has(filter)) throw new ReviewError(400, '状态筛选无效');
    const query = typeof input.query === 'string' ? input.query.trim() : '';
    if (query.length > 100 || (input.kind && !['policy', 'interpretation'].includes(input.kind)) || (input.priority && !['high', 'medium', 'low'].includes(input.priority))) throw new ReviewError(400, '筛选条件无效');
    const records = await store.list();
    let rows = await Promise.all(records.map(async record => {
      const row = summary(record);
      try {
        const meta = JSON.parse(await store.readVersion(record.id, record.currentHash, 'metadata.json'));
        row.attachmentCount = meta.attachments?.length || 0;
      } catch (error) {
        if (error.code !== 'NoSuchKey' && error.status !== 404) throw error;
      }
      return row;
    }));
    if (filter === 'processing') rows = rows.filter(row => ['publishing', 'indexing', 'reconcile_required', 'index_failed', 'indexed_needs_qa'].includes(row.status));
    else if (filter === 'history') rows = rows.filter(row => ['rejected', 'published', 'deferred_out_of_scope'].includes(row.status));
    else if (filter !== 'all') rows = rows.filter(row => row.status === filter);
    if (query) rows = rows.filter(row => `${row.title} ${row.docNumber}`.toLocaleLowerCase('zh-CN').includes(query.toLocaleLowerCase('zh-CN')));
    if (input.kind) rows = rows.filter(row => row.kind === input.kind);
    if (input.priority) rows = rows.filter(row => row.priority === input.priority);
    rows.sort((a, b) => (STATUS_ORDER[a.status] ?? 4) - (STATUS_ORDER[b.status] ?? 4) || (PRIORITY[a.priority] ?? 4) - (PRIORITY[b.priority] ?? 4) || b.issuedDate.localeCompare(a.issuedDate) || b.discoveredAt.localeCompare(a.discoveredAt));
    const counts = Object.fromEntries(['pending_review', 'approved', 'processing', 'history'].map(name => [name, 0]));
    for (const record of records) {
      const status = current(record)?.status;
      if (status in counts) counts[status]++;
      else if (['publishing', 'indexing', 'reconcile_required', 'index_failed', 'indexed_needs_qa'].includes(status)) counts.processing++;
      else counts.history++;
    }
    return { rows: rows.slice((page - 1) * 20, page * 20), total: rows.length, page, counts, run: await latestRun(store) };
  }
  const id = assertId(input?.id);
  assertHash(input?.hash);
  const record = await store.load(id);
  const version = checkCurrent(record, input.hash);
  if (operation === 'detail') {
    const meta = JSON.parse(await store.readVersion(id, input.hash, 'metadata.json'));
    const [fullText, fullCard] = await Promise.all([store.readVersion(id, input.hash, 'source.txt'), store.readVersion(id, input.hash, 'review.md')]);
    return {
      ...summary(record), source: {
        url: record.source.url, title: record.source.title, publisher: record.source.publisher,
        docNumber: record.source.docNumber, issuedDate: record.source.issuedDate,
        sourceLabels: record.source.sourceLabels || [], sourceTaxPolicy: record.source.sourceTaxPolicy || '',
      },
      decision: version?.decision || null,
      text: fullText.slice(0, 100_000), textTruncated: fullText.length > 100_000,
      card: fullCard.slice(0, 40_000), cardTruncated: fullCard.length > 40_000,
      attachments: (meta.attachments || []).map(item => ({ file: item.file, label: item.label, bytes: item.bytes, sha256: item.sha256 })),
    };
  }
  if (operation === 'download') {
    const file = input.file;
    const meta = JSON.parse(await store.readVersion(id, input.hash, 'metadata.json'));
    if (!PUBLIC_FILES.has(file) && !(meta.attachments || []).some(item => item.file === file)) throw new ReviewError(400, '文件不在当前版本的下载清单中');
    const objectKey = store.versionKey(id, input.hash, file);
    const url = await signer(objectKey, file);
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('签名下载地址无效');
    return { url, expiresIn: 60, file };
  }
  if (operation === 'decide') {
    if (!['approve', 'reject'].includes(input.action)) throw new ReviewError(400, '审核动作无效');
    if (version?.status !== 'pending_review') throw new ReviewError(409, '该版本已不在待审核状态，请刷新');
    const result = await decideVersion(store, id, {
      action: input.action, hash: input.hash, reviewer: input.reviewer, note: input.note,
      applicableFrom: input.applicableFrom, effectiveDate: input.effectiveDate,
      confirmedOriginal: input.confirmedOriginal === true,
    });
    return { id: result.id, hash: result.hash, status: result.status, reviewedAt: result.decision.reviewedAt };
  }
  if (operation === 'plan') return publicationPlan(store, id, input.hash);
  if (operation === 'publish') {
    const plan = await publicationPlan(store, id, input.hash);
    if (!plan.canPublish) throw new ReviewError(422, plan.reasons.join('；'));
    return publishApproved(store, id, { publisher: publisherFactory(key) });
  }
  if (operation === 'check') {
    if (version?.status === 'indexed_needs_qa' || version?.status === 'index_failed') return { status: version.status };
    if (version?.status !== 'indexing') throw new ReviewError(409, '当前没有待检查的入库任务');
    return checkPublished(store, id, { publisher: publisherFactory(key) });
  }
  throw new ReviewError(400, '操作无效');
}
