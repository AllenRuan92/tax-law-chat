import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseHistoryNamespace, legacyHistoryNamespace } from '../lib/wechat-entry.js';
const subject = 'a'.repeat(32), old = 'tax-law-wechat.' + subject;
const token = Buffer.from(JSON.stringify({ aud: 'wx6dde485592f7682e', sub: subject, exp: 1 })).toString('base64url') + '.expired';
test('expired entry is only a history hint, never an access requirement', () => {
  assert.equal(legacyHistoryNamespace(token), old);
  assert.equal(chooseHistoryNamespace({ legacy: token }), old);
  assert.equal(chooseHistoryNamespace(), 'tax-law-wechat.guest');
  for (const value of ['bad', 'x'.repeat(2000), null]) assert.equal(legacyHistoryNamespace(value), null);
});
test('history preference survives renewals and continues a unique legacy database', () => {
  assert.equal(chooseHistoryNamespace({ saved: 'tax-law-wechat.guest', legacy: token }), 'tax-law-wechat.guest');
  assert.equal(chooseHistoryNamespace({ databases: [{ name: old + '.history.v2' }, { name: 'tax-law-chat.history.v2' }] }), old);
  assert.equal(chooseHistoryNamespace({ saved: 'tax-law-chat', databases: [] }), 'tax-law-wechat.guest');
  assert.equal(chooseHistoryNamespace({ databases: [{ name: old + '.history.v2' }, { name: 'tax-law-wechat.' + 'b'.repeat(32) + '.history.v2' }] }), 'tax-law-wechat.guest');
});
