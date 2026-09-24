import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { reviewOperation, ReviewError } from '../tax-agent/review-api.mjs';
import { createReviewHandler } from '../tax-agent/review-fc/index.js';
import { createReviewClient } from '../lib/review.js';

const id = 'chinatax-5251155';
const hash = 'a'.repeat(64);
const key = 'test-only-existing-bailian-key';
const origin = 'https://allenruan92.github.io';
const env = { API_KEY_SHA256: createHash('sha256').update(key).digest('hex'), ALLOWED_ORIGINS: origin };

function fixture(attachments = []) {
  const record = {
    id, currentHash: hash, lastSeen: '2026-09-24T00:00:00Z',
    source: { title: '企业重组税务公告', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5251155/content.html', kind: 'policy', category: '税务规范性文件', publisher: '国家税务总局', docNumber: '2026年第13号', issuedDate: '2026-07-08', relevance: { level: 'high' } },
    versions: [{ hash, status: 'pending_review', discoveredAt: '2026-09-24T00:00:00Z', changeOrigin: 'first_seen' }],
  };
  const meta = { attachments };
  const store = {
    client: { get: async () => ({ content: Buffer.from(JSON.stringify({ generatedAt: '2026-09-24T00:01:00Z', report: { status: 'complete', errors: [] } })) }) },
    key: value => `tax-agent/v1/${value}`,
    versionKey: (givenId, givenHash, file) => `tax-agent/v1/versions/${givenId}/${givenHash}/${file}`,
    list: async () => [record], load: async () => record,
    readVersion: async (_id, _hash, file) => file === 'metadata.json' ? JSON.stringify(meta) : file === 'source.txt' ? '经核验的政策原文' : '首次发现，待核验效力',
    verifyVersion: async () => meta,
    writeDecision: async (_id, _hash, result) => Object.assign(record.versions[0], result),
    claimPublish: async () => { if (store.claimed) throw new Error('已有发布尝试'); store.claimed = true; },
    save: async () => {},
  };
  return { store, record };
}
const call = (store, input, extras = {}) => reviewOperation({ store, signer: async objectKey => `https://private.example/${objectKey}?signed=1`, key, ...extras }, input);

test('review API lists current private records, displays evidence and limits download names', async () => {
  const { store } = fixture([{ file: 'attachment-1.pdf', label: '附表', bytes: 42, sha256: 'b'.repeat(64) }]);
  const list = await call(store, { operation: 'list' });
  assert.equal(list.total, 1); assert.equal(list.rows[0].attachmentCount, 1); assert.equal(list.counts.pending_review, 1);
  const detail = await call(store, { operation: 'detail', id, hash });
  assert.equal(detail.text, '经核验的政策原文'); assert.equal(detail.attachments[0].file, 'attachment-1.pdf');
  assert.ok(!JSON.stringify(detail).includes('accessKeySecret'));
  const download = await call(store, { operation: 'download', id, hash, file: 'attachment-1.pdf' });
  assert.equal(download.expiresIn, 60);
  await assert.rejects(call(store, { operation: 'download', id, hash, file: 'attachment-2.pdf' }), /下载清单/);
  await assert.rejects(call(store, { operation: 'detail', id, hash: 'b'.repeat(64) }), error => error instanceof ReviewError && error.status === 409);
});

test('approval leaves material out of Bailian until a separate publish action; attachments block publish', async () => {
  const { store, record } = fixture([{ file: 'attachment-1.pdf', sha256: 'b'.repeat(64) }]);
  const decision = await call(store, { operation: 'decide', id, hash, action: 'approve', reviewer: '审核人员', note: '已核对官方原文及效力和适用期间', applicableFrom: '2026-07-08', confirmedOriginal: true });
  assert.equal(decision.status, 'approved');
  assert.equal(record.versions[0].fileId, undefined);
  const plan = await call(store, { operation: 'plan', id, hash });
  assert.equal(plan.canPublish, false); assert.match(plan.reasons.join(''), /附件/);
  await assert.rejects(call(store, { operation: 'publish', id, hash }), error => error instanceof ReviewError && error.status === 422);
  await assert.rejects(call(store, { operation: 'decide', id, hash, action: 'reject', reviewer: '审核人员', note: '退回原因达到八个字' }), /不在待审核/);
});

test('approved text-only material publishes once and checks indexing separately', async () => {
  const { store, record } = fixture();
  await call(store, { operation: 'decide', id, hash, action: 'approve', reviewer: '审核人员', note: '已核对官方原文及效力和适用期间', applicableFrom: '2026-07-08', confirmedOriginal: true });
  const publisher = { lease: async () => ({ leaseId: 'lease' }), put: async () => {}, register: async () => 'file-1', ingest: async () => 'job-1', status: async () => ({ data: { jobStatus: 'SUCCESS' } }) };
  const result = await call(store, { operation: 'publish', id, hash }, { publisherFactory: () => publisher });
  assert.equal(result.status, 'indexing'); assert.equal(record.versions[0].jobId, 'job-1'); assert.equal(store.claimed, true);
  await assert.rejects(call(store, { operation: 'publish', id, hash }, { publisherFactory: () => publisher }), /当前版本尚未批准/);
});

function event(input = { operation: 'list' }, headers = {}) {
  return { requestContext: { http: { method: 'POST' } }, headers: { Origin: origin, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input), isBase64Encoded: false };
}
test('review FC authenticates before private OSS access and rejects unsafe requests', async () => {
  const { store } = fixture(); let opens = 0;
  const handler = createReviewHandler({ env, runtimeFactory: () => { opens++; return { store, signer: () => 'https://private.example/signed' }; } });
  assert.equal((await handler(event(undefined, { Authorization: 'Bearer wrong-secret' }))).statusCode, 401);
  assert.equal((await handler(event(undefined, { Origin: 'https://evil.example' }))).statusCode, 403);
  assert.equal(opens, 0);
  assert.equal((await handler(event({ operation: 'detail', id: '../other', hash }))).statusCode, 400);
  assert.equal((await handler(event())).statusCode, 200);
  const preflight = event({}, { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' });
  preflight.requestContext.http.method = 'OPTIONS';
  assert.equal((await handler(preflight)).statusCode, 204);
});

test('browser review client sends Key only to fixed review API and reports server errors', async () => {
  let destination;
  const client = createReviewClient(key, async (url, options) => {
    destination = String(url); assert.equal(options.headers.Authorization, `Bearer ${key}`);
    return new Response(JSON.stringify({ success: true, data: { rows: [] } }), { headers: { 'content-type': 'application/json' } });
  }, 'https://review.example/');
  assert.deepEqual(await client.request('list'), { rows: [] }); assert.equal(destination, 'https://review.example/');
  assert.throws(() => createReviewClient(key, fetch, 'http://review.example/'), /HTTPS/);
  const failed = createReviewClient(key, async () => new Response(JSON.stringify({ success: false, message: '版本已变化' }), { status: 409 }), 'https://review.example/');
  await assert.rejects(failed.request('detail', { id, hash }), /版本已变化/);
});
