import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { md5Base64 } from '../lib/md5.js';
import { API_ORIGIN, CATEGORY_ID, KNOWLEDGE_ID, UPLOAD_HOST, PATHS, createKnowledgeClient, validateFile, docState, ingestionState, sizeLabel } from '../lib/knowledge.js';

const key = 'test-only-key';
const proxy = 'https://tax-upload.example/';
const response = data => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const file = new File(['这是税务知识库的测试文档。'], '测试.txt', { type: 'text/plain' });

test('MD5 base64 matches Node crypto including padding boundaries and binary data', () => {
  const vectors = ['', 'a', 'abc', 'message digest', '中华人民共和国税法', ...[55, 56, 63, 64, 65, 127, 128].map(n => 'a'.repeat(n))];
  for (const data of [...vectors.map(s => Buffer.from(s)), randomBytes(1048577)]) {
    assert.equal(md5Base64(data), createHash('md5').update(data).digest('base64'));
  }
});

test('file validation enforces extension, limits, empty files and long names', () => {
  assert.equal(validateFile(file), 'txt');
  assert.equal(validateFile({ name: 'LAW.PDF', size: 150 * 1024 ** 2 }), 'pdf');
  for (const invalid of [{ name: 'x.csv', size: 5 }, { name: 'txt', size: 5 }, { name: 'x.pdf', size: 0 },
    { name: 'x.pdf', size: 150 * 1024 ** 2 + 1 }, { name: 'x.txt', size: 10 * 1024 ** 2 + 1 },
    { name: 'x.png', size: 20 * 1024 ** 2 + 1 }, { name: `${'a'.repeat(200)}.txt`, size: 10 }]) {
    assert.throws(() => validateFile(invalid));
  }
  assert.equal(sizeLabel(1024), '1.0 KB');
  assert.equal(sizeLabel(undefined), '—');
});

test('document and ingestion states do not mistake a completed failed job for success', () => {
  assert.equal(docState({ code: 'FINISH' }).kind, 'ready');
  assert.equal(docState({ status: 'PARSE_FAILED' }).kind, 'failed');
  assert.equal(docState({ code: 'PARSING' }).kind, 'pending');
  assert.equal(ingestionState({ ingestion_status: 'COMPLETED', rows: [{ code: 'PARSE_FAILED', message: 'bad' }] }).error, 'bad');
  assert.equal(ingestionState({ ingestion_status: 'FAILED', rows: [] }).stage, 'failed');
  assert.equal(ingestionState({ ingestion_status: 'COMPLETED', rows: [] }).stage, 'indexing');
  assert.equal(ingestionState({ ingestion_status: 'COMPLETED', rows: [{ code: 'PARSING' }] }).stage, 'indexing');
  assert.equal(ingestionState({ rows: [{ code: 'FINISH' }], total_count: 2 }).stage, 'indexing');
  assert.equal(ingestionState({ rows: [{ code: 'FINISH' }], total_count: 1 }).stage, 'complete');
});

test('list, ingest and status use the fixed workspace and exact API protocol', async () => {
  const seen = [];
  const api = createKnowledgeClient(key, async (url, init) => {
    seen.push({ url: new URL(url), ...init });
    if (url.includes(PATHS.list)) return response({ rows: [{ doc_id: 'doc' }], total_count: '21' });
    if (url.includes(PATHS.ingest)) return response({ ingestionId: 'job' });
    return response({ ingestion_status: 'COMPLETED', rows: [{ code: 'FINISH' }] });
  });
  assert.equal((await api.list(2)).total, 21);
  assert.equal(await api.ingest('file'), 'job');
  assert.equal((await api.status('job')).ingestion_status, 'COMPLETED');
  assert.equal(seen[0].url.searchParams.get('page_num'), '2');
  assert.equal(seen[0].url.searchParams.get('index_id'), KNOWLEDGE_ID);
  assert.equal(seen[2].url.searchParams.get('job_id'), 'job');
  assert.deepEqual(JSON.parse(seen[1].body), { indexId: KNOWLEDGE_ID, sourceType: 'DATA_CENTER_FILE', docIds: ['file'] });
  for (const request of seen) {
    assert.equal(request.url.origin, API_ORIGIN);
    assert.equal(request.headers.Authorization, `Bearer ${key}`);
  }
});

test('API errors, auth, bad data and key redaction', async () => {
  assert.throws(() => createKnowledgeClient(''), /Key/);
  await assert.rejects(createKnowledgeClient(key, async () => new Response('', { status: 403 })).list(), /管理权限/);
  await assert.rejects(createKnowledgeClient(key, async () => response({ success: false, message: 'denied' })).list(), /denied/);
  await assert.rejects(createKnowledgeClient(key, async () => response({ code: 'Invalid', message: `invalid ${key}` })).list(), error => !error.message.includes(key));
  await assert.rejects(createKnowledgeClient(key, async () => response({})).list(), /列表格式异常/);
  await assert.rejects(createKnowledgeClient(key, async () => response({})).ingest('file'), /未收到入库任务/);
  await assert.rejects(createKnowledgeClient(key, async () => { throw new TypeError('fetch failed'); }).list(), /跨域/);
});

test('remove only confirms the precise document returned by server', async () => {
  const api = createKnowledgeClient(key, async (url, init) => {
    assert.equal(new URL(url).pathname, PATHS.remove);
    assert.deepEqual(JSON.parse(init.body), { index_id: KNOWLEDGE_ID, doc_ids: ['chosen-doc'] });
    return response({ deleted: ['chosen-doc'] });
  });
  await api.remove('chosen-doc');
  await assert.rejects(createKnowledgeClient(key, async () => response({ deleted: ['other-doc'] })).remove('chosen-doc'), /尚未确认/);
});

test('upload uses base64 MD5, raw PUT, no API Key to OSS, then register and ingest', async () => {
  const OriginalXHR = globalThis.XMLHttpRequest;
  const transfers = [];
  globalThis.XMLHttpRequest = class {
    upload = {}; headers = {};
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    send(body) { transfers.push({ method: this.method, url: this.url, headers: this.headers, body }); this.status = 200; this.upload.onprogress({ lengthComputable: true, loaded: 1, total: 1 }); this.onload(); }
  };
  try {
    const calls = [], stages = [], progress = [];
    const api = createKnowledgeClient(key, async (url, init) => {
      const body = JSON.parse(init.body), path = body.operation === 'lease' ? PATHS.lease : body.operation === 'register' ? PATHS.register : new URL(url).pathname; calls.push({ path, body });
      assert.equal(url, body.operation ? proxy : API_ORIGIN + PATHS.ingest);
      if (path === PATHS.lease) return response({ leaseId: 'lease', param: { method: 'PUT', url: `https://${UPLOAD_HOST}/test?signature=fake`, headers: { 'Content-Type': 'text/plain', 'x-bailian-extra': 'value', Authorization: 'must-not-forward' } } });
      if (path === PATHS.register) return response({ fileId: 'file' });
      return response({ ingestionId: 'job' });
    }, proxy);
    assert.deepEqual(await api.upload(file, { onStage: s => stages.push(s), onProgress: p => progress.push(p) }), { fileId: 'file', jobId: 'job' });
    assert.deepEqual(stages, ['hashing', 'leasing', 'uploading', 'registering', 'registered', 'indexing']);
    assert.deepEqual(progress, [100]);
    assert.deepEqual(calls[0].body, { operation: 'lease', category: CATEGORY_ID, fileName: file.name, sizeBytes: String(file.size), contentMd5: createHash('md5').update(Buffer.from(await file.arrayBuffer())).digest('base64') });
    assert.deepEqual(calls[1].body, { operation: 'register', leaseId: 'lease', category: CATEGORY_ID, parser: 'AUTO_SELECT' });
    assert.equal(transfers[0].method, 'PUT');
    assert.equal(transfers[0].body, file);
    assert.equal(transfers[0].headers.Authorization, undefined);
    assert.equal(JSON.stringify(transfers).includes(key), false);
  } finally { globalThis.XMLHttpRequest = OriginalXHR; }
});

test('upload refuses unexpected destinations before sending any bytes', async () => {
  for (const url of ['https://evil.example/x', `http://${UPLOAD_HOST}/x`, `https://user:pass@${UPLOAD_HOST}/x`, `https://${UPLOAD_HOST}:8443/x`]) {
    const api = createKnowledgeClient(key, async () => response({ leaseId: 'lease', param: { url } }), proxy);
    await assert.rejects(api.upload(file), /新的上传域名/);
  }
});

test('upload fails closed while FC endpoint is missing or insecure', async () => {
  const fetcher = async () => { throw new Error('must not call network'); };
  await assert.rejects(createKnowledgeClient(key, fetcher, '').upload(file), /尚未部署/);
  await assert.rejects(createKnowledgeClient(key, fetcher, 'http://untrusted.example').upload(file), /地址配置无效/);
});
