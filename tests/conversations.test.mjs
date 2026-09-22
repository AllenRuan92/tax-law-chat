import test from 'node:test';
import assert from 'node:assert/strict';
import { newConversation, cleanConversation, normalizeTurns, conversationTitle, exportConversations, parseBackup,
  memoryConversationStore, HistoryConflict } from '../lib/conversations.js';

test('new conversations are independent, titles use the first question', () => {
  const one = newConversation(), two = newConversation();
  assert.notEqual(one.id, two.id); one.turns.push({ role: 'user', content: '基金\n如何纳税？' });
  assert.equal(two.turns.length, 0); assert.equal(conversationTitle(one), '基金 如何纳税？');
  one.title = '专项研究'; assert.equal(conversationTitle(one), '专项研究');
});
test('backups whitelist fields, do not contain connection Key and import additively', () => {
  const row = { ...newConversation(), key: 'SECRET-MARKER', apiKey: 'SECRET-MARKER', draft: '未发送草稿',
    turns: [{ role: 'assistant', content: '<img src=x onerror=alert(1)>', status: 'pending', extra: { key: 'SECRET-MARKER' } }] };
  const text = exportConversations([row]);
  assert.equal(text.includes('SECRET-MARKER'), false);
  const [imported] = parseBackup(text);
  assert.notEqual(imported.id, row.id); assert.equal(imported.draft, '未发送草稿');
  assert.equal(imported.turns[0].status, 'stopped');
  assert.notEqual(parseBackup(text)[0].id, imported.id);
});
test('invalid backup fails completely; unsupported roles and oversized data rejected', () => {
  for (const text of ['bad json', '{}', JSON.stringify({ format: 'wrong', version: 1, conversations: [] }),
    JSON.stringify({ format: 'tax-law-chat-conversations', version: 1, conversations: [newConversation(), { turns: [{ role: 'system', content: 'bad' }] }] })]) assert.throws(() => parseBackup(text));
  assert.throws(() => parseBackup(' '.repeat(20 * 1024 * 1024 + 1)), /20 MB/);
});
test('restoration stops partial turns; does not silently cap history at 80 messages', () => {
  const row = newConversation(); row.turns = Array.from({ length: 100 }, () => ({ role: 'user', content: '记录', status: 'complete' }));
  assert.equal(cleanConversation(row).turns.length, 100);
  assert.equal(normalizeTurns([{ role: 'assistant', content: '部分', status: 'pending' }], true)[0].status, 'stopped');
});
test('fallback store saves independently and checks revisions', async () => {
  const store = memoryConversationStore(), row = newConversation();
  const saved = await store.save(row); assert.equal(saved.revision, 1);
  await assert.rejects(store.save(row, 0), HistoryConflict);
  saved.turns.push({ role: 'user', content: 'test' });
  assert.equal((await store.get(row.id)).turns.length, 0);
  await store.remove(row.id); assert.equal((await store.list()).length, 0);
  await assert.rejects(store.save(saved, 1), HistoryConflict);
});
