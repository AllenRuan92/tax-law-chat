import { createCloudStore } from './cloud-store.mjs';
import { safeId } from './store.mjs';
import { decideVersion } from './review-decision.mjs';
import { checkPublished, createBailianPublisher, publicationPlan, publishApproved } from './bailian.mjs';

const [action, ...args] = process.argv.slice(2);
const option = (name, defaultValue = '') => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : defaultValue; };
const usage = '用法：node tax-agent/cloud-admin.mjs list | show ID | plan ID --hash SHA256 | approve ID --hash SHA256 --reviewer 姓名 --applicable-from YYYY-MM-DD [--effective YYYY-MM-DD] --note 核验依据 --confirmed-original | reject ID --hash SHA256 --reviewer 姓名 --note 原因 | publish ID --hash SHA256 | check ID --hash SHA256 [--profile tax-fc-ak]';

async function main() {
  const store = createCloudStore(option('--profile', 'tax-fc-ak'));
  if (action === 'list') {
    const records = await store.list();
    console.table(records.map(record => {
      const version = record.versions.find(item => item.hash === record.currentHash);
      return { id: record.id, title: record.source.title, hash: record.currentHash.slice(0, 12), status: version?.status, issued: record.source.issuedDate };
    }));
    return;
  }
  if (!['show', 'plan', 'approve', 'reject', 'publish', 'check'].includes(action)) throw new Error(usage);
  const id = safeId(args[0]);
  const record = await store.load(id);
  if (!record) throw new Error('云端没有这份资料');
  const version = record.versions.find(item => item.hash === record.currentHash);
  if (action === 'show') {
    const card = await store.readVersion(id, record.currentHash, 'review.md');
    console.log(JSON.stringify({ id, title: record.source.title, hash: record.currentHash, status: version?.status, source: record.source.url, decision: version?.decision || null }, null, 2));
    console.log(card);
    return;
  }
  const hash = option('--hash');
  if (hash !== record.currentHash) throw new Error('操作校验值与云端当前版本不符，请重新查看审核卡片');
  if (action === 'plan') {
    console.log(JSON.stringify(await publicationPlan(store, id, hash), null, 2));
    return;
  }
  if (action === 'approve' || action === 'reject') {
    const result = await decideVersion(store, id, { action, hash, reviewer: option('--reviewer'), note: option('--note'), applicableFrom: option('--applicable-from'), effectiveDate: option('--effective'), confirmedOriginal: args.includes('--confirmed-original') });
    console.log(JSON.stringify({ id: result.id, hash: result.hash, status: result.status, reviewedAt: result.decision.reviewedAt }));
    return;
  }
  const key = process.env.DASHSCOPE_API_KEY;
  const publisher = createBailianPublisher(key);
  const result = action === 'publish' ? await publishApproved(store, id, { publisher }) : await checkPublished(store, id, { publisher });
  console.log(JSON.stringify({ id, hash, ...result }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
