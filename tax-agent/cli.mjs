import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect } from './monitor.mjs';
import { LocalStore, safeId } from './store.mjs';
import { checkPublished, createBailianPublisher, publishApproved } from './bailian.mjs';
import { writeReviewReport } from './report.mjs';
import { decideVersion } from './review-decision.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const store = new LocalStore(path.join(root, 'output/tax-agent'));
const [action, ...args] = process.argv.slice(2);
const option = (name, defaultValue) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : defaultValue; };
const usage = '用法：node tax-agent/cli.mjs collect [--pages 1] [--max 10] | report | list | show ID | approve ID --hash SHA256 --reviewer 姓名 --applicable-from YYYY-MM-DD [--effective YYYY-MM-DD] --note 核验依据 --confirmed-original | reject ID --hash SHA256 --reviewer 姓名 --note 原因 | publish ID | check ID';

async function main() {
  if (action === 'collect') {
    const pages = Number(option('--pages', '2'));
    const maxArticles = Number(option('--max', '20'));
    const report = await collect({ store, pages, maxArticles });
    const file = path.join(store.root, 'runs', `${report.startedAt.replaceAll(/[:.]/g, '-')}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const review = await writeReviewReport(store, report);
    console.log(JSON.stringify({ report: file, review, ...report }, null, 2));
    if (report.status !== 'complete') process.exitCode = 2;
    return;
  }
  if (action === 'report') { console.log(await writeReviewReport(store)); return; }
  if (action === 'list') {
    const rows = await store.list();
    console.table(rows.map(r => ({ id: r.id, title: r.source.title, version: r.currentHash.slice(0, 12), status: r.versions.at(-1).status, issued: r.source.issuedDate })));
    return;
  }
  if (['show', 'approve', 'reject', 'publish', 'check'].includes(action)) {
    const id = safeId(args[0]);
    const record = await store.load(id);
    if (!record) throw new Error('资料 ID 未收录');
    const version = record.versions.find(v => v.hash === record.currentHash);
    if (action === 'show') {
      console.log(JSON.stringify({ record, files: store.versionDir(id, version.hash) }, null, 2));
      return;
    }
    if (action === 'approve' || action === 'reject') {
      const result = await decideVersion(store, id, { action, hash: option('--hash', ''), reviewer: option('--reviewer', ''), note: option('--note', ''), applicableFrom: option('--applicable-from', ''), effectiveDate: option('--effective', ''), confirmedOriginal: args.includes('--confirmed-original') });
      console.log(`${id}：${result.status}`);
      return;
    }
    const key = process.env.DASHSCOPE_API_KEY;
    const publisher = createBailianPublisher(key);
    const result = action === 'publish' ? await publishApproved(store, id, { publisher }) : await checkPublished(store, id, { publisher });
    console.log(JSON.stringify(result));
    return;
  }
  throw new Error(usage);
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
