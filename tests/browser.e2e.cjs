// Isolated Chrome contexts only. No cloud writes; Q&A is mocked. Optional --download reads an existing original.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.TAX_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const site = 'https://allenruan92.github.io/tax-law-chat/';
const origin = 'https://llm-zc86z2f8ixro6odd.cn-beijing.maas.aliyuncs.com';
const agent = 'aid-c13de479d8944f12b3c45ef9a45af154';
const legacy = { agent, turns: [{ role: 'user', content: '旧记录：合伙基金税务', status: 'complete' }, { role: 'assistant', content: '旧回答须保留。', status: 'complete' }] };
const assets = new Set(['index.html', 'app.js', 'conversation-manager.js', 'knowledge-manager.js', 'review-manager.js', 'styles.css', 'favicon.svg', 'lib/chat.js', 'lib/conversations.js', 'lib/markdown.js', 'lib/knowledge.js', 'lib/review.js', 'lib/config.js', 'lib/md5.js']);
const out = path.join(root, 'output/playwright'); fs.mkdirSync(out, { recursive: true });
const errors = [], calls = [];
const say = step => console.log(JSON.stringify({ step }));
let browser, slowRelease;
const rows = page => page.evaluate(async () => (await (await import('./lib/conversations.js')).openConversationStore()).list());
const wait = async (fn, label) => { for (let i = 0; i < 80; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + label); };
const count = page => page.locator('.history-panel .history-item').count();
async function ready(page) { await page.waitForFunction(() => !document.querySelector('#send-button').disabled); }
async function openConversation(page, title) {
  await page.locator('.history-panel .history-open').filter({ hasText: title }).first().click();
  await wait(async () => (await page.locator('.history-panel .history-item.selected').innerText()).includes(title), 'switch ' + title);
}
async function send(page, text) {
  await page.locator('#question').fill(text); await page.locator('#send-button').click();
  await wait(async () => (await rows(page)).some(r => r.turns.some(t => t.content === '测试回答：' + text && t.status === 'complete')), 'answer saved');
}
async function context(options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
  if (!process.argv.includes('--live')) await ctx.route(site + '**', async route => {
    const relative = new URL(route.request().url()).pathname.slice('/tax-law-chat/'.length) || 'index.html';
    if (!assets.has(relative)) return route.abort();
    const contentType = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html';
    await route.fulfill({ status: 200, contentType, body: fs.readFileSync(path.join(root, relative)) });
  });
  await ctx.route(origin + '/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    if (pathname.endsWith('/knowledge/chat')) {
      const body = request.postDataJSON(), messages = body.input.messages;
      calls.push(messages); const question = messages.at(-1).content;
      if (question === '等待回答') await new Promise(resolve => { slowRelease = resolve; });
      const payload = { output: { choices: [{ message: { content: '测试回答：' + question, extra: { step: 'generating', step_change: 'generation_end' } }, finish_reason: 'stop' }] } };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: 'data: ' + JSON.stringify(payload) + '\n\ndata: [DONE]\n\n' }).catch(() => {});
    } else if (options.download && (pathname.endsWith('/index/files') || pathname.endsWith('/index/chunklist'))) await route.continue();
    else await route.abort();
  });
  ctx.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  if (options.seed) await ctx.addInitScript(({ legacy }) => {
    if (location.origin !== 'https://allenruan92.github.io' || sessionStorage.getItem('e2e-seeded')) return;
    sessionStorage.setItem('e2e-seeded', '1');
    sessionStorage.setItem('tax-law-chat.key', 'TEST-CONNECTION-KEY-NOT-IN-BACKUP');
    sessionStorage.setItem('tax-law-chat.v1', JSON.stringify(legacy));
  }, { legacy });
  return ctx;
}
(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const ctx = await context({ seed: true }); const page = await ctx.newPage();
  await page.goto(site, { waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await count(page), 1); assert.match(await page.locator('#messages').innerText(), /旧回答须保留/);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tax-law-chat.v1')), null);
  await page.reload({ waitUntil: 'networkidle' }); await ready(page); assert.equal(await count(page), 1);
  say('legacy-migration-once');
  await page.locator('#new-chat').click(); await wait(async () => await count(page) === 2, 'new chat');
  await send(page, '创投70%抵扣条件'); assert.equal(calls.at(-1).length, 1);
  await page.locator('#question').fill('保留这段草稿');
  await wait(async () => (await rows(page)).some(r => r.draft === '保留这段草稿'), 'draft saved');
  await openConversation(page, '旧记录');
  assert.equal(await page.locator('#question').inputValue(), '');
  await send(page, '继续旧话题'); assert.equal(calls.at(-1)[0].content, legacy.turns[0].content);
  assert.equal(calls.at(-1).some(m => m.content === '创投70%抵扣条件'), false);
  await openConversation(page, '创投70%'); assert.equal(await page.locator('#question').inputValue(), '保留这段草稿');
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await count(page), 2); assert.equal(await page.locator('#question').inputValue(), '保留这段草稿');
  say('new-switch-reload-draft-context-isolation');
  await page.locator('.history-panel .history-item.selected .history-edit').click();
  await page.locator('#conversation-name').fill('创投优惠专项'); await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await wait(async () => (await rows(page)).some(r => r.title === '创投优惠专项'), 'rename');
  const downloadEvent = page.waitForEvent('download'); await page.locator('.history-panel [data-export-history]').click();
  const exported = await downloadEvent; const backupPath = path.join(out, 'history-fixture-backup.json'); await exported.saveAs(backupPath);
  const backup = fs.readFileSync(backupPath, 'utf8'); assert.equal(JSON.parse(backup).conversations.length, 2);
  assert.equal(backup.includes('TEST-CONNECTION-KEY-NOT-IN-BACKUP'), false);
  assert.equal(JSON.stringify(await rows(page)).includes('TEST-CONNECTION-KEY-NOT-IN-BACKUP'), false);
  page.once('dialog', d => d.accept()); await page.locator('#history-file').setInputFiles(backupPath);
  await wait(async () => await count(page) === 4, 'additive import');
  await page.locator('#history-file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await wait(async () => (await page.locator('#toast').innerText()).includes('请选择本页导出'), 'invalid backup'); assert.equal(await count(page), 4);
  await page.locator('.history-panel .history-item.selected .history-edit').click();
  page.once('dialog', d => d.dismiss()); await page.locator('#delete-conversation').click(); assert.equal(await count(page), 4);
  page.once('dialog', d => d.accept()); await page.locator('#delete-conversation').click();
  await wait(async () => await count(page) === 3, 'confirmed deletion');
  say('rename-backup-no-key-import-validation-delete');
  // Share link changes application without deleting existing histories.
  await page.goto(site + '#access_key=TEST-SHARED-KEY&agent_id=aid-test-other', { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(new URL(page.url()).hash, ''); assert.equal(await count(page), 4);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tax-law-chat.key')), 'TEST-SHARED-KEY');
  await page.locator('#question').fill('另一应用草稿');
  await wait(async () => (await rows(page)).some(r => r.agent === 'aid-test-other' && r.draft), 'shared app');
  say('share-link-preserves-history');
  // Two tabs loaded at the same revision; stale edits must become a recovery copy.
  await openConversation(page, '旧记录');
  const conflictId = await page.evaluate(() => sessionStorage.getItem('tax-law-chat.active.v2'));
  const tab = await ctx.newPage(); await tab.goto(site, { waitUntil: 'networkidle' }); await ready(tab);
  await tab.evaluate(id => sessionStorage.setItem('tax-law-chat.active.v2', id), conflictId);
  await tab.reload({ waitUntil: 'networkidle' }); await ready(tab);
  await page.locator('#question').fill('标签页甲的草稿');
  await wait(async () => (await rows(page)).find(r => r.id === conflictId)?.draft === '标签页甲的草稿', 'first tab draft');
  await tab.locator('#question').fill('标签页乙的草稿');
  await wait(async () => (await rows(tab)).some(r => r.title.includes('恢复副本') && r.draft === '标签页乙的草稿'), 'stale revision recovery');
  assert.equal((await rows(page)).find(r => r.id === conflictId).draft, '标签页甲的草稿');
  await tab.close();
  say('two-tabs-conflict-preserves-both');
  await page.locator('#question').fill('等待回答'); await page.locator('#send-button').click();
  await page.locator('#stop-button').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#new-chat').isDisabled(), true);
  const titleBefore = await page.locator('#current-title').innerText();
  await page.locator('.history-panel .history-open').filter({ hasText: '创投优惠专项' }).first().click();
  assert.equal(await page.locator('#current-title').innerText(), titleBefore);
  await page.reload({ waitUntil: 'networkidle' }); slowRelease?.(); await ready(page);
  assert.equal(await page.locator('#messages .typing').count(), 0);
  assert.match(await page.locator('#messages').innerText(), /中断|未收到完整回答/);
  const interrupted = (await rows(page)).find(r => r.turns.some(t => t.content === '等待回答'));
  assert.notEqual(interrupted.turns.at(-1).status, 'complete');
  say('streaming-switch-blocked-and-interrupted-reload');
  await page.screenshot({ path: path.join(out, 'history-desktop.png'), fullPage: true });
  for (const width of [390, 320, 700]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page width ' + width);
    if (width <= 640) {
      await page.locator('#open-history').click();
      assert.ok(await page.evaluate(() => document.querySelector('#history-dialog').getBoundingClientRect().width <= innerWidth));
      await page.screenshot({ path: path.join(out, 'history-mobile-' + width + '.png'), fullPage: true });
      await page.locator('#close-history').click();
    }
  }
  say('responsive-390-320-700');
  // Direct storage checks exercise atomic migration and revision guards in real IndexedDB.
  const storageChecks = await page.evaluate(async () => {
    const lib = await import('./lib/conversations.js'), store = await lib.openConversationStore();
    const row = lib.newConversation(), saved = await store.save(row), next = await store.save(saved, saved.revision);
    let conflict = false; try { await store.save(saved, saved.revision); } catch (e) { conflict = e.name === 'HistoryConflict'; }
    await store.remove(row.id, next.revision);
    let deleted = false; try { await store.save(next, next.revision); } catch (e) { deleted = e.name === 'HistoryConflict'; }
    const [a, b] = await Promise.all([store.migrate('e2e-atomic', lib.newConversation()), store.migrate('e2e-atomic', lib.newConversation())]);
    return { conflict, deleted, deduplicated: a === b };
  });
  assert.deepEqual(storageChecks, { conflict: true, deleted: true, deduplicated: true });
  const isolated = await context(); const isolatedPage = await isolated.newPage();
  await isolatedPage.goto(site, { waitUntil: 'networkidle' }); await ready(isolatedPage); assert.equal(await count(isolatedPage), 1);
  assert.equal(await isolatedPage.locator('#connection-label').innerText(), '待配置');
  await isolatedPage.locator('#question').fill('关闭标签页后仍应保留');
  await wait(async () => (await rows(isolatedPage))[0]?.draft === '关闭标签页后仍应保留', 'close tab draft');
  await isolatedPage.evaluate(() => sessionStorage.setItem('tax-law-chat.key', 'TEST-TAB-ONLY-KEY'));
  await isolatedPage.close();
  const reopened = await isolated.newPage(); await reopened.goto(site, { waitUntil: 'networkidle' }); await ready(reopened);
  assert.equal(await reopened.locator('#question').inputValue(), '关闭标签页后仍应保留');
  assert.equal(await reopened.locator('#connection-label').innerText(), '待配置');
  // Simulate quota failure without corrupting the actual database, then test recovery after reload.
  await reopened.evaluate(() => {
    const original = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function(stores, mode, ...rest) {
      if (mode === 'readwrite') throw new DOMException('Simulated quota failure', 'QuotaExceededError');
      return original.call(this, stores, mode, ...rest);
    };
  });
  await reopened.locator('#question').fill('存储失败时保留这份草稿');
  await wait(async () => (await reopened.locator('.composer-area [data-history-status]').innerText()).includes('未能保存'), 'quota warning');
  const quotaBackup = reopened.waitForEvent('download'); await reopened.locator('.history-panel [data-export-history]').click();
  const recoveredPath = path.join(out, 'quota-fixture-backup.json'); await (await quotaBackup).saveAs(recoveredPath);
  assert.ok(fs.readFileSync(recoveredPath, 'utf8').includes('存储失败时保留这份草稿'));
  await reopened.reload({ waitUntil: 'networkidle' }); await ready(reopened);
  assert.equal(await reopened.locator('#question').inputValue(), '存储失败时保留这份草稿');
  assert.equal(await count(reopened), 2);
  say('closed-tab-history-persists-key-does-not-quota-backup-recovery');
  const fallback = await context(); await fallback.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  const fallbackPage = await fallback.newPage(); await fallbackPage.goto(site, { waitUntil: 'networkidle' }); await ready(fallbackPage);
  assert.match(await fallbackPage.locator('.composer-area [data-history-status]').innerText(), /不可用/);
  await fallbackPage.locator('#question').fill('临时记录'); await fallbackPage.locator('#new-chat').click();
  await wait(async () => await count(fallbackPage) === 2, 'fallback new conversation');
  say('indexeddb-atomicity-new-browser-isolation-storage-fallback');
  if (process.argv.includes('--download')) {
    const key = process.env.DASHSCOPE_API_KEY; assert.ok(key, 'DASHSCOPE_API_KEY must be available locally');
    const downloadContext = await context({ download: true });
    await downloadContext.addInitScript(key => { if (location.origin === 'https://allenruan92.github.io') sessionStorage.setItem('tax-law-chat.key', key); }, key);
    const downloadPage = await downloadContext.newPage();
    await downloadPage.goto(site, { waitUntil: 'networkidle' }); await ready(downloadPage);
    await downloadPage.locator('#open-knowledge').click();
    const row = downloadPage.locator('.document-row').filter({ hasText: '中国大陆一级市场股权投资税务知识要点_2026-09-21' });
    await row.waitFor({ timeout: 30000 });
    const finished = downloadPage.waitForEvent('download', { timeout: 45000 });
    await row.locator('.download-document-button').click(); const original = await finished;
    assert.equal(original.suggestedFilename(), '中国大陆一级市场股权投资税务知识要点_2026-09-21.md');
    const target = path.join(out, 'original-download.md'); await original.saveAs(target);
    assert.equal(fs.statSync(target).size, 10943);
    await downloadPage.screenshot({ path: path.join(out, 'download-desktop.png'), fullPage: true });
    await downloadPage.setViewportSize({ width: 390, height: 844 });
    await downloadPage.screenshot({ path: path.join(out, 'download-mobile.png'), fullPage: true });
    say('real-original-download-10943-bytes-no-cloud-writes');
  }
  assert.deepEqual(errors, []); say('ALL-PASSED');
})().catch(error => {
  let message = String(error.stack || error);
  if (process.env.DASHSCOPE_API_KEY) message = message.replaceAll(process.env.DASHSCOPE_API_KEY, '[KEY]');
  console.error(message.replace(/https:\/\/[^\s"'<>]+/g, '[URL]')); process.exitCode = 1;
}).finally(async () => { slowRelease?.(); await browser?.close(); });
