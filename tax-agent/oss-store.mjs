import { createHash } from 'node:crypto';
import { articleDigest } from './chinatax.mjs';

const ID_RE = /^chinatax-[0-9]{4,16}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
function safe(id, hash = null) {
  if (!ID_RE.test(id) || (hash !== null && !HASH_RE.test(hash))) throw new Error('资料身份或版本校验值无效');
}

export class OssStore {
  constructor(client, prefix = 'tax-agent/v1/') { this.client = client; this.prefix = prefix; this.cachedIds = null; }
  key(value) { return this.prefix + value; }
  recordKey(id) { safe(id); return this.key(`records/${id}.json`); }
  decisionKey(id, hash) { safe(id, hash); return this.key(`decisions/${id}/${hash}.json`); }
  claimKey(id, hash) { safe(id, hash); return this.key(`publications/${id}/${hash}/claim.json`); }
  publicationStateKey(id, hash) { safe(id, hash); return this.key(`publications/${id}/${hash}/state.json`); }
  versionKey(id, hash, name) {
    safe(id, hash);
    if (!/^(source\.html|source\.txt|review\.md|metadata\.json|attachment-[1-9][0-9]*\.(pdf|docx?|xlsx?|zip))$/.test(name)) throw new Error('归档文件名无效');
    return this.key(`versions/${id}/${hash}/${name}`);
  }
  async load(id) {
    let record;
    try { record = JSON.parse((await this.client.get(this.recordKey(id))).content.toString('utf8')); }
    catch (error) { if (error.code === 'NoSuchKey' || error.status === 404) return null; throw error; }
    for (const version of record.versions) {
      if (version.status === 'pending_review') {
        try {
          const approval = JSON.parse((await this.client.get(this.decisionKey(id, version.hash))).content.toString('utf8'));
          if (approval.id !== id || approval.hash !== version.hash || !['approved', 'rejected'].includes(approval.status) || !approval.decision) throw new Error('云端审核决定格式无效');
          version.status = approval.status;
          version.decision = approval.decision;
        } catch (error) { if (error.code !== 'NoSuchKey' && error.status !== 404) throw error; }
      }
      if (['approved', 'publishing', 'indexing', 'reconcile_required', 'index_failed', 'indexed_needs_qa', 'published'].includes(version.status)) {
        try {
          const state = JSON.parse((await this.client.get(this.publicationStateKey(id, version.hash))).content.toString('utf8'));
          if (state.id !== id || state.hash !== version.hash || !['publishing', 'indexing', 'reconcile_required', 'index_failed', 'indexed_needs_qa', 'published'].includes(state.status)) throw new Error('云端发布状态格式无效');
          Object.assign(version, state);
        } catch (error) {
          if (error.code !== 'NoSuchKey' && error.status !== 404) throw error;
          // A claim without state means the publishing request may have reached Bailian.
          if (version.status === 'approved') {
            try { await this.client.get(this.claimKey(id, version.hash)); version.status = 'reconcile_required'; }
            catch (claimError) { if (claimError.code !== 'NoSuchKey' && claimError.status !== 404) throw claimError; }
          }
        }
      }
    }
    return record;
  }
  async savePublicationState(id, hash, version) {
    safe(id, hash);
    const fields = ['status', 'startedPublishAt', 'fileId', 'jobId', 'publishError', 'indexError', 'indexedAt'];
    const state = { id, hash };
    for (const field of fields) if (version[field] !== undefined) state[field] = version[field];
    if (!['publishing', 'indexing', 'reconcile_required', 'index_failed', 'indexed_needs_qa', 'published'].includes(state.status)) throw new Error('发布状态无效');
    await this.client.put(this.publicationStateKey(id, hash), Buffer.from(JSON.stringify(state, null, 2) + '\n'));
  }
  async writeDecision(id, hash, { status, decision }) {
    safe(id, hash);
    if (!['approved', 'rejected'].includes(status) || !decision) throw new Error('审核决定格式无效');
    const record = await this.load(id);
    const version = record?.versions.find(item => item.hash === hash);
    if (record?.currentHash !== hash || version?.status !== 'pending_review') throw new Error('云端当前版本已变化或已审核，请重新拉取');
    const body = { id, hash, status, decision };
    try { await this.client.put(this.decisionKey(id, hash), Buffer.from(JSON.stringify(body, null, 2) + '\n'), { headers: { 'x-oss-forbid-overwrite': 'true' } }); }
    catch (error) { if (error.status === 409 || error.code === 'FileAlreadyExists') throw new Error('云端版本已有审核决定，请重新拉取'); throw error; }
  }
  async claimPublish(id, hash) {
    const record = await this.load(id);
    const version = record?.versions.find(item => item.hash === hash);
    if (record?.currentHash !== hash || version?.status !== 'approved') throw new Error('云端当前版本未获批准或已变化');
    try { await this.client.put(this.claimKey(id, hash), Buffer.from(JSON.stringify({ id, hash, claimedAt: new Date().toISOString() }) + '\n'), { headers: { 'x-oss-forbid-overwrite': 'true' } }); }
    catch (error) { if (error.status === 409 || error.code === 'FileAlreadyExists') throw new Error('该版本已有发布尝试，须先对账，禁止重复上传'); throw error; }
  }
  async ids() {
    if (this.cachedIds) return this.cachedIds;
    let ids;
    try { ids = JSON.parse((await this.client.get(this.key('records/manifest.json'))).content.toString('utf8')).ids; }
    catch (error) { if (error.code === 'NoSuchKey' || error.status === 404) ids = []; else throw error; }
    if (!Array.isArray(ids) || ids.some(id => !ID_RE.test(id))) throw new Error('归档索引格式无效');
    this.cachedIds = ids;
    return ids;
  }
  async save(record) {
    await this.client.put(this.recordKey(record.id), Buffer.from(JSON.stringify(record, null, 2) + '\n'));
    const ids = await this.ids();
    if (!ids.includes(record.id)) {
      ids.push(record.id);
      await this.client.put(this.key('records/manifest.json'), Buffer.from(JSON.stringify({ ids }, null, 2) + '\n'));
    }
  }
  async list() {
    const rows = await Promise.all((await this.ids()).map(id => this.load(id)));
    if (rows.some(row => !row)) throw new Error('归档索引引用了不存在的资料');
    return rows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
  async saveVersion(record, article, card) {
    const attachments = article.attachments.map((item, index) => {
      const ext = /\.(pdf|docx?|xlsx?|zip)$/i.exec(new URL(item.url).pathname)?.[1]?.toLowerCase();
      if (!ext || !Buffer.isBuffer(item.bytes) || !HASH_RE.test(item.sha256)) throw new Error('附件未完整下载或未校验');
      return { label: item.label, url: item.url, sha256: item.sha256, bytes: item.bytes.length, file: `attachment-${index + 1}.${ext}` };
    });
    for (const [name, value] of [
      ['source.html', article.originalHtml], ['source.txt', article.text], ['review.md', card],
      ['metadata.json', JSON.stringify({ record, attachments }, null, 2) + '\n'],
      ...attachments.map((item, index) => [item.file, article.attachments[index].bytes]),
    ]) {
      const key = this.versionKey(record.id, article.articleHash, name);
      try { await this.client.put(key, Buffer.isBuffer(value) ? value : Buffer.from(value), { headers: { 'x-oss-forbid-overwrite': 'true' } }); }
      catch (error) { if (error.status !== 409 && error.code !== 'FileAlreadyExists') throw error; }
    }
  }
  async readVersion(id, hash, name) { return (await this.client.get(this.versionKey(id, hash, name))).content.toString('utf8'); }
  async verifyVersion(id, hash) {
    const meta = JSON.parse(await this.readVersion(id, hash, 'metadata.json'));
    const digest = articleDigest(await this.readVersion(id, hash, 'source.txt'), meta.record.source);
    for (const item of meta.attachments || []) {
      if (!HASH_RE.test(item.sha256)) throw new Error('附件台账格式无效');
      const bytes = (await this.client.get(this.versionKey(id, hash, item.file))).content;
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('附件内容校验失败');
      digest.update('\nattachment\n').update(item.url).update('\n').update(item.sha256);
    }
    if (digest.digest('hex') !== hash) throw new Error('原文版本校验失败');
    return meta;
  }
}
