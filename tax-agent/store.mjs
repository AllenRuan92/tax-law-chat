import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { articleDigest } from './chinatax.mjs';

export const DEFAULT_ROOT = path.resolve('output/tax-agent');
const ID_RE = /^chinatax-[0-9]{4,16}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

export function safeId(id) {
  if (!ID_RE.test(id)) throw new Error('资料 ID 格式无效');
  return id;
}

async function writeAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, value, { flag: 'wx', mode: 0o600 });
  await fs.rename(temp, file);
}

export class LocalStore {
  constructor(root = DEFAULT_ROOT) { this.root = path.resolve(root); }
  recordPath(id) { return path.join(this.root, 'records', safeId(id) + '.json'); }
  versionDir(id, hash) {
    if (!HASH_RE.test(hash)) throw new Error('内容校验值格式无效');
    return path.join(this.root, 'versions', safeId(id), hash);
  }
  async load(id) {
    try { return JSON.parse(await fs.readFile(this.recordPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(record) { await writeAtomic(this.recordPath(record.id), JSON.stringify(record, null, 2) + '\n'); }
  async list() {
    let names;
    try { names = await fs.readdir(path.join(this.root, 'records')); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = await Promise.all(names.filter(name => /^chinatax-[0-9]+\.json$/.test(name)).map(name => this.load(name.slice(0, -5))));
    return records.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
  async saveVersion(record, article, card) {
    const dir = this.versionDir(record.id, article.articleHash);
    await fs.mkdir(dir, { recursive: true });
    const attachments = article.attachments.map((item, index) => {
      const ext = /\.(pdf|docx?|xlsx?|zip)$/i.exec(new URL(item.url).pathname)?.[1]?.toLowerCase();
      if (!ext || !Buffer.isBuffer(item.bytes) || !HASH_RE.test(item.sha256)) throw new Error('附件未完整下载或未校验');
      return { label: item.label, url: item.url, sha256: item.sha256, bytes: item.bytes.length, file: `attachment-${index + 1}.${ext}` };
    });
    // Once recorded, source snapshots are immutable; repeated scans may only refresh lastSeen in the record.
    for (const [name, content] of [
      ['source.html', article.originalHtml], ['source.txt', article.text],
      ['review.md', card], ['metadata.json', JSON.stringify({ record, attachments }, null, 2) + '\n'],
      ...attachments.map((item, index) => [item.file, article.attachments[index].bytes]),
    ]) {
      try { await fs.writeFile(path.join(dir, name), content, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    return dir;
  }
  async readVersion(id, hash, name) {
    if (!['source.txt', 'review.md', 'metadata.json'].includes(name)) throw new Error('不支持读取此文件');
    return fs.readFile(path.join(this.versionDir(id, hash), name), 'utf8');
  }
  async verifyVersion(id, hash) {
    const meta = JSON.parse(await this.readVersion(id, hash, 'metadata.json'));
    const digest = articleDigest(await this.readVersion(id, hash, 'source.txt'), meta.record.source);
    for (const item of meta.attachments || []) {
      if (!/^attachment-[1-9][0-9]*\.(pdf|docx?|xlsx?|zip)$/.test(item.file) || !HASH_RE.test(item.sha256)) throw new Error('附件台账格式无效');
      const bytes = await fs.readFile(path.join(this.versionDir(id, hash), item.file));
      if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error('附件内容校验失败');
      digest.update('\nattachment\n').update(item.url).update('\n').update(item.sha256);
    }
    if (digest.digest('hex') !== hash) throw new Error('原文版本校验失败');
    return meta;
  }
}
