import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LocalStore } from './store.mjs';
import { writeReviewReport } from './report.mjs';

export async function exportCloudReview(root) {
  const target = path.resolve(root);
  const cloud = JSON.parse(await fs.readFile(path.join(target, 'cloud-latest.json'), 'utf8'));
  if (!Array.isArray(cloud.pending) || !cloud.report || cloud.pending.length > 100) throw new Error('云端待审核清单格式异常');
  const store = new LocalStore(target);
  const records = await store.list();
  if (records.length !== cloud.pending.length) throw new Error('云端审核包资料数量不符');
  const expected = new Map(cloud.pending.map(item => [item.id, item.hash]));
  if (expected.size !== cloud.pending.length) throw new Error('云端待审核清单含重复资料');
  for (const record of records) {
    const hash = expected.get(record.id);
    const version = record.versions.find(item => item.hash === hash);
    if (!hash || record.currentHash !== hash || version?.status !== 'pending_review') throw new Error(`${record.id}：云端审核包版本状态不一致`);
    await store.verifyVersion(record.id, hash);
  }
  const file = await writeReviewReport(store, cloud.report);
  return { review: file, pending: records.length, collectionStatus: cloud.report.status };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  exportCloudReview(process.argv[2]).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; });
}
