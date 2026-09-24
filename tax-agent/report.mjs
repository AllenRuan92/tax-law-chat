import fs from 'node:fs/promises';
import path from 'node:path';

export async function writeReviewReport(store, run = null) {
  const records = await store.list();
  const pending = records.filter(r => r.versions.some(v => v.hash === r.currentHash && v.status === 'pending_review'));
  pending.sort((a, b) => (b.source.relevance.level === 'high') - (a.source.relevance.level === 'high') || b.source.issuedDate.localeCompare(a.source.issuedDate));
  const lines = [
    '# 税务资料待审核清单', '',
    `生成时间：${new Date().toISOString()}`, '',
    `当前待审核：${pending.length} 份。原文、附件与版本台账只在本地私有目录；此清单不代表效力核验或正式入库。`, '',
  ];
  if (run) {
    lines.push(`最近采集：${run.status === 'complete' ? '完成' : '未完成'}；候选 ${run.candidates}，新增版本 ${run.newVersions}，其中提取器技术修订 ${run.technicalRevisions || 0}，未变 ${run.unchanged}。`, '');
    if (run.errors.length) lines.push('未完成事项：', '', ...run.errors.map(x => `- ${x}`), '');
  }
  for (const record of pending) {
    const version = record.versions.find(v => v.hash === record.currentHash);
    const meta = await store.verifyVersion(record.id, version.hash);
    const dir = path.relative(path.join(store.root, 'review'), store.versionDir(record.id, version.hash)).replaceAll('\\', '/');
    lines.push(`## ${record.source.title}`, '',
      `- 编号：${record.id}；校验值：\`${version.hash}\``,
      `- 优先级：${record.source.relevance.level === 'high' ? '业务主题命中' : '规则变动待排查'}；资料类型：${record.source.kind === 'interpretation' ? '官方解读' : '政策原文'}`,
      `- 来源：[官方页面](${record.source.url})；日期：${record.source.issuedDate || '未核实'}；文号：${record.source.docNumber || '无或未核实'}`,
      `- 附件：${meta.attachments.length} 个${meta.attachments.length ? '（入库前需解析并核对附件内容）' : ''}；版本原因：${version.changeOrigin === 'extractor_upgrade' ? '提取器技术修订，不等于法规变化' : version.changeOrigin === 'source_change_candidate' ? '原站内容差异待核查' : '首次发现'}`,
      `- [审核卡片](${dir}/review.md) · [原文摘录](${dir}/source.txt) · [元数据](${dir}/metadata.json)`, '');
  }
  const file = path.join(store.root, 'review', 'latest.md');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join('\n') + '\n', { mode: 0o600 });
  return file;
}
