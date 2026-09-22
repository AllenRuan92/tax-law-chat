import test from 'node:test';
import assert from 'node:assert/strict';
import { originalDownload, createKnowledgeClient, UPLOAD_HOST, KNOWLEDGE_ID, PATHS, MAX_DOWNLOAD_BYTES } from '../lib/knowledge.js';
const doc = { doc_id: 'chosen', doc_name: '原始税法', doc_type: 'md', size: 4 };
const data = (url = `https://${UPLOAD_HOST}/original?signature=temporary`) => ({ nodes: [{ metadata: { doc_id: 'chosen', pipeline_id: KNOWLEDGE_ID, doc_url: url, file_path: 'https://wrong.example/parsed' } }] });
const response = value => new Response(JSON.stringify({ code: 'Success', data: value }));
test('original-file lookup checks identity and rejects parsed content and unsafe URLs', () => {
  assert.equal(originalDownload(data(), doc).name, '原始税法.md');
  assert.equal(originalDownload(data(), { ...doc, doc_name: '已带扩展.MD' }).name, '已带扩展.MD');
  assert.equal(originalDownload(data(), { ...doc, doc_name: '../CON' }).name.includes('/'), false);
  for (const url of ['javascript:alert(1)', 'https://evil.example/original', `http://${UPLOAD_HOST}/x`, `https://user@${UPLOAD_HOST}/x`, `https://${UPLOAD_HOST}:8443/x`]) assert.throws(() => originalDownload(data(url), doc));
  assert.throws(() => originalDownload(data(), { ...doc, doc_id: 'other' }));
  const parsed = data(); delete parsed.nodes[0].metadata.doc_url; assert.throws(() => originalDownload(parsed, doc));
  const other = data(); other.nodes[0].metadata.pipeline_id = 'another'; assert.throws(() => originalDownload(other, doc));
});
test('download fetches original bytes, never sends credentials to OSS', async () => {
  const calls = [], key = 'TEST-KEY';
  const client = createKnowledgeClient(key, async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response(data()) : new Response('test');
  });
  const result = await client.download(doc);
  assert.equal(await result.blob.text(), 'test'); assert.equal(result.name, '原始税法.md');
  assert.equal(new URL(calls[0].url).pathname, PATHS.chunks);
  assert.deepEqual(JSON.parse(calls[0].init.body), { indexId: KNOWLEDGE_ID, docId: 'chosen', pageNum: 1, pageSize: 1 });
  assert.equal(calls[1].init.headers, undefined); assert.equal(calls[1].init.credentials, 'omit');
  assert.equal(calls[1].init.redirect, 'error'); assert.equal(calls[1].init.referrerPolicy, 'no-referrer');
});
test('download refuses oversized, mismatched, missing, and expired originals', async () => {
  await assert.rejects(createKnowledgeClient('test', () => { throw new Error('no network'); }).download({ ...doc, size: MAX_DOWNLOAD_BYTES + 1 }), /150 MB/);
  for (const body of [new Response('a'), new Response('', { status: 403 }), new Response('test', { headers: { 'Content-Length': String(MAX_DOWNLOAD_BYTES + 1) } })]) {
    let count = 0;
    await assert.rejects(createKnowledgeClient('test', async () => ++count === 1 ? response(data()) : body).download(doc));
  }
});
