import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CATEGORIES, fetchArticle, listCategory, makeReviewCard, parseArticle } from '../tax-agent/chinatax.mjs';
import { collect } from '../tax-agent/monitor.mjs';
import { LocalStore } from '../tax-agent/store.mjs';
import { OssStore } from '../tax-agent/oss-store.mjs';
import { checkPublished, publishApproved } from '../tax-agent/bailian.mjs';
import { decideVersion } from '../tax-agent/review-decision.mjs';

const id = 'chinatax-5251155';
const candidate = { id, title: '企业重组税务公告', url: 'https://fgk.chinatax.gov.cn/zcfgk/c100012/c5251155/content.html', category: '税务规范性文件', kind: 'policy', publisher: '国家税务总局', docNumber: '2026年第13号', issuedDate: '2026-07-08', relevance: { reason: '主题命中' } };
const articleHtml = `<div class="article"><div class="zs">注释</div><div class="arc_cont"><p>${'企业重组股权所得税条款。'.repeat(10)}</p><p>附件：<a href="./file.xls">表.xls</a></p></div><div class="bot-btns-box">【打印】【下载】</div></div>`;
const response = (body, type = 'text') => type === 'json' ? new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } }) : new Response(body);

test('正文提取排除隐藏注释、按钮和 HTML 注释，保留附件链接', () => {
  const parsed = parseArticle(articleHtml.replace('<div class="zs">', '<!-- template --> <div class="zs">'), candidate);
  assert.match(parsed.text, /企业重组股权所得税条款/);
  assert.doesNotMatch(parsed.text, /注释|打印|下载|template/);
  assert.equal(parsed.attachments.length, 1);
});

test('部门规章元数据和文字政策解读分别使用各自来源接口', async () => {
  const requested = [];
  const fetcher = async (url, options = {}) => {
    requested.push(String(url));
    if (String(url).includes('list_guizhang')) return response('<meta name="channelId" content="0ac34e96afbb4be28844f18eef412421">');
    if (String(url).includes('list_zcjd')) return response('<meta name="SiteIDCode" content="bm29000002">');
    if (String(url).includes('getFileListByCodeId')) {
      assert.match(String(options.body), /channelId=0ac34e96afbb4be28844f18eef412421/);
      return response({ code: 200, results: { data: { results: [{ title: candidate.title, url: candidate.url }] } } }, 'json');
    }
    if (String(url).includes('/search5/search/s')) return response({ searchResultAll: { total: 1, searchTotal: [{ title: '关于企业重组税务公告的解读', url: 'http://fgk.chinatax.gov.cn/zcfgk/c100015/c5251153/content.html', siteCode: 'bm29000002', xxgk_resolveType: '文字', cwrq: '2026-07-08 00:00:00', pubName: '国家税务总局' }] } }, 'json');
    throw new Error('unexpected URL');
  };
  const rules = await listCategory(CATEGORIES[2], { fetcher, pages: 1 });
  const explanations = await listCategory(CATEGORIES[3], { fetcher, pages: 1 });
  assert.equal(rules[0].id, id);
  assert.equal(explanations[0].kind, 'interpretation');
  assert.equal(explanations[0].issuedDate, '2026-07-08');
  assert.ok(requested.some(url => url.includes('/search5/search/s')));
});

test('附件变动产生新版本，保存的字节通过校验，重跑不重复入队', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tax-agent-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  let attachment = Buffer.from('first attachment');
  const fetcher = async url => {
    const target = String(url);
    if (target.includes('listflfg')) return response('<script>var channelId="0123456789abcdef0123456789abcdef"</script>');
    if (target.includes('getFileListByCodeId')) return response({ code: 200, results: { data: { results: [{ title: candidate.title, url: candidate.url, domainMetaList: [] }] } } }, 'json');
    if (target.endsWith('content.html')) return response(articleHtml);
    if (target.endsWith('file.xls')) return response(attachment);
    throw new Error('unexpected URL');
  };
  const category = CATEGORIES[0];
  const first = await collect({ store, fetcher, pages: 1, categories: [category] });
  assert.equal(first.newVersions, 1);
  let record = await store.load(id);
  const firstHash = record.currentHash;
  const meta = await store.verifyVersion(id, firstHash);
  assert.equal(meta.attachments[0].sha256, createHash('sha256').update(attachment).digest('hex'));
  const second = await collect({ store, fetcher, pages: 1, categories: [category] });
  assert.equal(second.unchanged, 1);
  attachment = Buffer.from('changed attachment');
  const third = await collect({ store, fetcher, pages: 1, categories: [category] });
  record = await store.load(id);
  assert.equal(third.newVersions, 1);
  assert.equal(record.versions.length, 2);
  assert.notEqual(record.currentHash, firstHash);
  const file = path.join(store.versionDir(id, record.currentHash), 'attachment-1.xls');
  await fs.writeFile(file, 'tampered');
  await assert.rejects(store.verifyVersion(id, record.currentHash), /附件内容校验失败/);
});

test('正文不变但官方效力元数据变化也进入复核', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tax-metadata-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  let effect = '全文有效';
  const fetcher = async url => {
    const target = String(url);
    if (target.includes('listflfg')) return response('<script>var channelId="0123456789abcdef0123456789abcdef"</script>');
    if (target.includes('getFileListByCodeId')) return response({ code: 200, results: { data: { results: [{ title: candidate.title, url: candidate.url, domainMetaList: [{ resultList: [{ key: 'aging', value: effect }] }] }] } } }, 'json');
    if (target.endsWith('content.html')) return response(articleHtml.replace('<p>附件：<a href="./file.xls">表.xls</a></p>', ''));
    throw new Error('unexpected URL');
  };
  const first = await collect({ store, fetcher, pages: 1, categories: [CATEGORIES[0]] });
  effect = '部分废止';
  const second = await collect({ store, fetcher, pages: 1, categories: [CATEGORIES[0]] });
  assert.equal(first.newVersions, 1);
  assert.equal(second.newVersions, 1);
  const record = await store.load(id);
  assert.equal(record.versions.length, 2);
  const card = await store.readVersion(id, record.currentHash, 'review.md');
  assert.match(card, /来源效力标注：全文有效 → 部分废止/);
  assert.match(card, /正文：提取文本无差异/);
});

test('版本对照只展示首处提取文本差异并提示核对完整原文', () => {
  const next = { ...candidate, sourceAging: '全文有效' };
  const article = { text: '第一条 不变\n第二条 新内容\n第三条 不变', articleHash: 'a'.repeat(64), attachments: [] };
  const previousArticle = { text: '第一条 不变\n第二条 旧内容\n第三条 不变', metadata: { record: { source: next }, attachments: [] } };
  const card = makeReviewCard(next, article, { previousArticle, previousHash: 'b'.repeat(64), changeOrigin: 'source_change_candidate' });
  assert.match(card, /首处差异从第 2 段开始/);
  assert.match(card, /旧：第二条 旧内容/);
  assert.match(card, /新：第二条 新内容/);
  assert.match(card, /须核对完整原文/);
});

test('未审核和含附件的材料不能上传；索引失败被记录', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tax-publish-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  const article = await fetchArticle(candidate, { fetcher: async url => String(url).endsWith('content.html') ? response(articleHtml) : response('an attachment') });
  const record = { id, source: candidate, currentHash: article.articleHash, firstSeen: '2026-09-24T00:00:00Z', lastSeen: '2026-09-24T00:00:00Z', versions: [{ hash: article.articleHash, status: 'pending_review' }] };
  await store.saveVersion(record, article, 'review');
  await store.save(record);
  const publisher = { lease: () => { throw new Error('must not upload'); } };
  await assert.rejects(publishApproved(store, id, { publisher }), /尚未通过审核/);
  record.versions[0].status = 'approved';
  record.versions[0].decision = { confirmedOriginal: true, effect: 'current', effectiveDate: '', applicableFrom: '2026-01-01', effectNote: '已核对官方原文及效力', reviewer: '审核人', reviewedAt: '2026-09-24T00:00:00Z' };
  await store.save(record);
  await assert.rejects(publishApproved(store, id, { publisher }), /附件内容尚未转成可检索正文/);
  record.versions[0].status = 'indexing'; record.versions[0].jobId = 'job-1';
  await store.save(record);
  assert.deepEqual(await checkPublished(store, id, { publisher: { status: async () => ({ ingestion_status: 'FAILED', rows: [] }) } }), { status: 'index_failed' });
});

test('审核通过的无附件原文只登记一次，并在索引完成后进入抽验状态', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tax-publish-ok-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new LocalStore(root);
  const cleanHtml = articleHtml.replace('<p>附件：<a href="./file.xls">表.xls</a></p>', '');
  const article = parseArticle(cleanHtml, candidate);
  const record = { id, source: candidate, currentHash: article.articleHash, firstSeen: '2026-09-24T00:00:00Z', lastSeen: '2026-09-24T00:00:00Z', versions: [{ hash: article.articleHash, status: 'approved', decision: { confirmedOriginal: true, effect: 'current', effectiveDate: '', applicableFrom: '2026-01-01', effectNote: '已核对官方原文及适用期间', reviewer: '审核人', reviewedAt: '2026-09-24T00:00:00Z' } }] };
  await store.saveVersion(record, article, 'review');
  await store.save(record);
  const calls = [];
  const publisher = {
    lease: async (name, bytes) => { calls.push(['lease', name, bytes.toString().includes('适用起始日：2026-01-01')]); return { leaseId: 'lease-1' }; },
    put: async () => calls.push(['put']),
    register: async () => { calls.push(['register']); return 'file-1'; },
    ingest: async () => { calls.push(['ingest']); return 'job-1'; },
    status: async () => ({ ingestion_status: 'FINISH', total_count: 1, rows: [{ code: 'FINISH' }] }),
  };
  assert.equal((await publishApproved(store, id, { publisher })).status, 'indexing');
  assert.deepEqual(calls.map(x => x[0]), ['lease', 'put', 'register', 'ingest']);
  assert.equal(calls[0][2], true);
  await assert.rejects(publishApproved(store, id, { publisher }), /尚未通过审核/);
  assert.equal((await checkPublished(store, id, { publisher })).status, 'indexed_needs_qa');
});

test('云端私有档案使用固定前缀并保持原始快照不可覆盖', async () => {
  const objects = new Map();
  const client = {
    async put(name, data, options) {
      if (options?.headers?.['x-oss-forbid-overwrite'] && objects.has(name)) throw Object.assign(new Error('exists'), { status: 409 });
      objects.set(name, Buffer.from(data));
    },
    async get(name) {
      if (!objects.has(name)) throw Object.assign(new Error('missing'), { status: 404 });
      return { content: objects.get(name) };
    },
    async list({ prefix }) { return { objects: [...objects.keys()].filter(x => x.startsWith(prefix)).map(name => ({ name })), isTruncated: false }; },
  };
  const store = new OssStore(client);
  const article = parseArticle(articleHtml.replace('<p>附件：<a href="./file.xls">表.xls</a></p>', ''), candidate);
  const record = { id, source: candidate, currentHash: article.articleHash, firstSeen: '2026-09-24T00:00:00Z', lastSeen: '2026-09-24T00:00:00Z', versions: [{ hash: article.articleHash, status: 'pending_review' }] };
  await store.saveVersion(record, article, 'first review');
  await store.save(record);
  await store.saveVersion(record, { ...article, originalHtml: 'changed source' }, 'changed review');
  assert.equal((await store.list()).length, 1);
  assert.equal((await store.verifyVersion(id, article.articleHash)).record.id, id);
  assert.equal((await store.readVersion(id, article.articleHash, 'review.md')), 'first review');
  assert.ok([...objects.keys()].every(x => x.startsWith('tax-agent/v1/')));
});

test('云端审核决定独立留痕，旧台账写入不能撤销批准，发布声明阻止重复入库', async () => {
  const objects = new Map();
  const client = {
    async put(name, data, options) {
      if (options?.headers?.['x-oss-forbid-overwrite'] && objects.has(name)) throw Object.assign(new Error('exists'), { status: 409 });
      objects.set(name, Buffer.from(data));
    },
    async get(name) {
      if (!objects.has(name)) throw Object.assign(new Error('missing'), { status: 404 });
      return { content: objects.get(name) };
    },
  };
  const store = new OssStore(client);
  const article = parseArticle(articleHtml.replace('<p>附件：<a href="./file.xls">表.xls</a></p>', ''), candidate);
  const record = { id, source: candidate, currentHash: article.articleHash, firstSeen: '2026-09-24T00:00:00Z', lastSeen: '2026-09-24T00:00:00Z', versions: [{ hash: article.articleHash, status: 'pending_review' }] };
  await store.saveVersion(record, article, 'review');
  await store.save(record);
  const result = await decideVersion(store, id, { action: 'approve', hash: article.articleHash, reviewer: '审核人', note: '已核对官方原文与现行效力依据', applicableFrom: '2026-01-01', confirmedOriginal: true });
  assert.equal(result.status, 'approved');
  await assert.rejects(decideVersion(store, id, { action: 'approve', hash: article.articleHash, reviewer: '审核人', note: '重复批准不应生效', applicableFrom: '2026-01-01', confirmedOriginal: true }), /不在待审核状态/);
  await store.save(record); // Simulate a stale collector write that still says pending_review.
  assert.equal((await store.load(id)).versions[0].status, 'approved');
  const publisher = { lease: async () => ({ leaseId: 'lease-1' }), put: async () => {}, register: async () => 'file-1', ingest: async () => 'job-1' };
  assert.equal((await publishApproved(store, id, { publisher })).status, 'indexing');
  assert.ok(objects.has(store.claimKey(id, article.articleHash)));
  assert.equal((await store.load(id)).versions[0].status, 'indexing');
  await store.save(record); // A concurrent collector write must not roll back publication progress.
  assert.equal((await store.load(id)).versions[0].status, 'indexing');
  await assert.rejects(store.claimPublish(id, article.articleHash), /未获批准或已变化/);
});
