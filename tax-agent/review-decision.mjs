import { safeId } from './store.mjs';

const validDate = value => /^20\d\d-\d\d-\d\d$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;

export async function decideVersion(store, id, { action, hash, reviewer, note, applicableFrom = '', effectiveDate = '', confirmedOriginal = false, now = () => new Date() }) {
  safeId(id);
  const record = await store.load(id);
  if (!record) throw new Error('资料 ID 未收录');
  const version = record.versions.find(item => item.hash === record.currentHash);
  if (!version || version.status !== 'pending_review') throw new Error('当前版本不在待审核状态');
  if (hash !== version.hash) throw new Error('审核校验值与当前原文版本不符');
  if (typeof reviewer !== 'string' || reviewer.trim().length < 2 || reviewer.trim().length > 80) throw new Error('请填写审核人');
  if (typeof note !== 'string' || note.trim().length < 8) throw new Error('请记录不少于 8 字的审核依据或退回原因');
  let decision;
  let status;
  if (action === 'approve') {
    if (!confirmedOriginal || !validDate(applicableFrom) || (effectiveDate && !validDate(effectiveDate))) throw new Error('核实原文并填写正确的适用起始日后方可批准；施行日不明确时可留空并在核验依据说明');
    status = 'approved';
    decision = { confirmedOriginal: true, effect: 'current', effectiveDate, applicableFrom, effectNote: note.trim(), reviewer: reviewer.trim(), reviewedAt: now().toISOString() };
  } else if (action === 'reject') {
    status = 'rejected';
    decision = { reason: note.trim(), reviewer: reviewer.trim(), reviewedAt: now().toISOString() };
  } else throw new Error('审核动作无效');
  await store.verifyVersion(id, hash);
  if (typeof store.writeDecision === 'function') await store.writeDecision(id, hash, { status, decision });
  else { version.status = status; version.decision = decision; await store.save(record); }
  return { id, hash, status, decision };
}
