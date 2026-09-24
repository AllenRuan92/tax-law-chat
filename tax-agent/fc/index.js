import OSS from 'ali-oss';
import { collect } from './monitor.mjs';
import { OssStore } from './oss-store.mjs';

export async function handler(_event, context) {
  const credentials = context?.credentials;
  const bucket = process.env.TAX_AGENT_BUCKET;
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials?.securityToken || !bucket) throw new Error('缺少函数临时凭证或私有存储配置');
  const client = new OSS({ region: 'oss-cn-beijing', internal: true, bucket, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, stsToken: credentials.securityToken, secure: true, timeout: 30_000 });
  const store = new OssStore(client);
  const report = await collect({ store, pages: 2, maxArticles: 20 });
  const started = report.startedAt.replaceAll(/[:.]/g, '-');
  await client.put(`tax-agent/v1/runs/${started}.json`, Buffer.from(JSON.stringify(report, null, 2) + '\n'));
  const records = await store.list();
  const pending = records.flatMap(record => record.versions.filter(v => v.hash === record.currentHash && v.status === 'pending_review').map(v => ({ id: record.id, title: record.source.title, url: record.source.url, hash: v.hash, kind: record.source.kind, issuedDate: record.source.issuedDate, changeOrigin: v.changeOrigin })));
  await client.put('tax-agent/v1/reports/latest.json', Buffer.from(JSON.stringify({ generatedAt: report.finishedAt, report, pending }, null, 2) + '\n'));
  // The timer only collects and archives. It has no Bailian key or publishing path.
  return { status: report.status, candidates: report.candidates, newVersions: report.newVersions, pending: pending.length, errors: report.errors.length };
}
