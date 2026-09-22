// Node Playwright fallback: Python Playwright is unavailable in this workspace.
// Isolated Chrome only. Default questions are mocked; --real performs one billable Q&A.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require(process.env.TAX_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), site = 'https://allenruan92.github.io/tax-law-chat/', pageUrl = site + 'wechat.html';
const endpoint = 'https://tax-lawchat-bot-kycjexvvew.cn-beijing.fcapp.run/chat';
const assets = new Set(['wechat.html', 'wechat-app.js', 'wechat.css', 'wechat-config.js', 'styles.css', 'favicon.svg', 'conversation-manager.js', 'lib/chat.js', 'lib/conversations.js', 'lib/markdown.js', 'lib/wechat-entry.js']);
const out = path.join(root, 'output/playwright'); fs.mkdirSync(out, { recursive: true });
const errors = [], calls = []; let browser, unblock;
const token = (sub = 'a'.repeat(32), exp = Math.floor(Date.now() / 1000) + 3600) => Buffer.from(JSON.stringify({ sub, aud: 'wx6dde485592f7682e', exp })).toString('base64url') + '.TEST-SIGNATURE';
const wait = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + label); };
const ready = page => page.waitForFunction(() => !document.querySelector('#new-chat').disabled);
const rows = page => page.evaluate(async () => (await (await import('./lib/conversations.js')).openConversationStore(indexedDB, localStorage.getItem('tax-law-wechat.history-namespace') + '.history.v2')).list());
async function context(real = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
  if (!process.argv.includes('--live')) await ctx.route(site + '**', async route => {
    const relative = new URL(route.request().url()).pathname.slice('/tax-law-chat/'.length);
    if (!assets.has(relative)) return route.abort();
    await route.fulfill({ status: 200, contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html', body: fs.readFileSync(path.join(root, relative)) });
  });
  if (!real) await ctx.route(endpoint, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': 'https://allenruan92.github.io', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST' } });
    assert.equal(route.request().headers().authorization, undefined, 'Browser must not send a key or token');
    const messages = route.request().postDataJSON().messages; calls.push(messages);
    const question = messages.at(-1).content;
    if (question === '等待中') await new Promise(resolve => unblock = resolve);
    await route.fulfill({ status: question === '服务暂不可用' ? 503 : 200, contentType: 'application/json', body: JSON.stringify(question === '服务暂不可用' ? { message: '问答服务暂时不可用，请稍后重试。' } : { answer: '测试回答：' + question + '\n\n**依据**：请核对法规原文。' }) }).catch(() => {});
  });
  ctx.on('page', page => page.on('pageerror', e => errors.push(e.message)));
  return ctx;
}
async function send(page, question) {
  await page.locator('#question').fill(question); await page.locator('#send-button').click();
  await wait(async () => (await rows(page)).some(row => row.turns.some(t => t.content.startsWith('测试回答：' + question) && t.status === 'complete')), 'answer saved');
}
(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const ctx = await context(), page = await ctx.newPage();
  await page.goto(pageUrl, { waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await page.locator('#send-button').isDisabled(), false);
  assert.equal(await page.locator('#entry-notice').isHidden(), true);
  assert.equal(await page.locator('#connection-label').innerText(), '公开试用');
  assert.equal(await page.locator('#api-key,#open-settings,#open-knowledge').count(), 0);
  await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(new URL(page.url()).hash, ''); assert.equal(await page.locator('#send-button').isDisabled(), false);
  await page.screenshot({ path: path.join(out, 'wechat-welcome-desktop.png'), fullPage: true });
  await send(page, '公司制基金的纳税主体'); await send(page, '那合伙制呢？'); assert.equal(calls.at(-1).length, 3);
  await page.locator('#new-chat').click(); await send(page, '新话题'); assert.equal(calls.at(-1).length, 1);
  assert.equal(await page.locator('.history-panel .history-item').count(), 2);
  await page.locator('.history-panel .history-open').filter({ hasText: '公司制基金' }).click();
  await wait(async () => (await page.locator('#messages').innerText()).includes('那合伙制呢'), 'history switched');
  assert.match(await page.locator('#messages').innerText(), /那合伙制呢/);
  await page.reload({ waitUntil: 'networkidle' }); await ready(page); assert.match(await page.locator('#messages').innerText(), /那合伙制呢/);
  // Existing administration history remains a distinct database, even in the same browser.
  const admin = await page.evaluate(async () => (await (await import('./lib/conversations.js')).openConversationStore()).list()); assert.equal(admin.length, 0);
  const download = page.waitForEvent('download'); await page.locator('.history-panel [data-export-history]').click();
  const backupPath = path.join(out, 'wechat-backup.json'); await (await download).saveAs(backupPath);
  const backup = fs.readFileSync(backupPath, 'utf8'); assert.ok(!backup.includes(token())); assert.ok(!backup.includes('TEST-SIGNATURE')); assert.equal(JSON.parse(backup).conversations.length, 2);
  await page.screenshot({ path: path.join(out, 'wechat-chat-desktop.png'), fullPage: true });
  for (const width of [390, 320, 700]) {
    await page.setViewportSize({ width, height: 844 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'width ' + width);
    if (width <= 640) { await page.locator('#open-history').click(); await page.screenshot({ path: path.join(out, 'wechat-history-' + width + '.png'), fullPage: true }); await page.locator('#close-history').click(); }
  }
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(out, 'wechat-chat-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#question').fill('等待中'); await page.locator('#send-button').click(); await page.locator('#stop-button').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#new-chat').isDisabled(), true); await page.locator('#stop-button').click(); unblock?.();
  await wait(async () => !await page.locator('#new-chat').isDisabled(), 'stop'); await send(page, '停止后的追问'); assert.equal(calls.at(-1).some(m => m.content === '等待中'), false);
  await page.goto(pageUrl + '#access=' + token('b'.repeat(32)), { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await page.locator('.history-panel .history-item').count(), 2);
  await page.goto(pageUrl + '#access=' + token('a'.repeat(32), Math.floor(Date.now() / 1000) - 1), { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await page.locator('#send-button').isDisabled(), false); assert.equal(await page.locator('.history-panel .history-item').count(), 2);
  await send(page, '旧入口过期后仍能提问');
  await page.locator('#question').fill('服务暂不可用'); await page.locator('#send-button').click();
  await page.getByText('问答服务暂时不可用，请稍后重试。', { exact: true }).waitFor();
  assert.equal(await page.locator('#entry-notice').isHidden(), true);
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tax-law-wechat.access')), null);
  // Closing the tab does not create a new history partition or require authentication.
  await page.close(); const reopened = await ctx.newPage(); await reopened.goto(pageUrl, { waitUntil: 'networkidle' }); await ready(reopened);
  assert.equal(await reopened.locator('.history-panel .history-item').count(), 2); await send(reopened, '重新打开固定入口');
  // A different browser has independent local records, without a separate visitor token.
  const isolated = await context(), p2 = await isolated.newPage(); await p2.goto(pageUrl, { waitUntil: 'networkidle' }); await ready(p2);
  assert.equal(await p2.locator('.history-panel .history-item').count(), 1); assert.equal(await p2.locator('#messages').isHidden(), true);
  // Seed one legacy partition; a new direct-entry tab discovers and continues it.
  await p2.evaluate(async () => {
    const lib = await import('./lib/conversations.js'), store = await lib.openConversationStore(indexedDB, 'tax-law-wechat.' + 'c'.repeat(32) + '.history.v2');
    await store.save({ ...lib.newConversation(), turns: [{ id: crypto.randomUUID(), role: 'user', content: '旧版对话不能丢', status: 'complete' }, { id: crypto.randomUUID(), role: 'assistant', content: '旧版回答', status: 'complete' }] });
    localStorage.removeItem('tax-law-wechat.history-namespace');
  });
  await p2.close(); const legacyPage = await isolated.newPage(); await legacyPage.goto(pageUrl, { waitUntil: 'networkidle' }); await ready(legacyPage);
  assert.match(await legacyPage.locator('#messages').innerText(), /旧版对话不能丢/); await send(legacyPage, '继续旧版对话'); assert.equal(calls.at(-1)[0].content, '旧版对话不能丢');
  const unavailable = await context(); await unavailable.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  const fallback = await unavailable.newPage(); await fallback.goto(pageUrl, { waitUntil: 'networkidle' }); await ready(fallback);
  assert.equal(await fallback.locator('#send-button').isDisabled(), false);
  if (process.argv.includes('--real')) {
    const live = await context(true), p = await live.newPage();
    const realRequests = []; p.on('request', r => { if (r.url() === endpoint && r.method() === 'POST') realRequests.push(r); });
    await p.goto(pageUrl, { waitUntil: 'networkidle' }); await ready(p);
    await p.locator('#question').fill('公司制基金与合伙制基金的所得税纳税主体有什么区别？请简要回答并说明资料依据。');
    await p.locator('#send-button').click();
    await p.waitForFunction(() => [...document.querySelectorAll('.message-status')].some(n => n.textContent.includes('回答完成')), null, { timeout: 175000 });
    assert.equal(new URL(p.url()).hash, '');
    assert.equal(realRequests.length, 1); assert.equal(realRequests[0].headers().authorization, undefined);
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: path.join(out, 'wechat-real-mobile.png'), fullPage: true });
    console.log('Fresh browser -> permanent URL -> anonymous CORS -> real Bailian answer passed.');
  }
  assert.deepEqual(errors, []);
  console.log('Public POC browser checks passed: direct entry, no expiry, legacy history, browser isolation, backup, cancellation, mobile, no credentials.');
})().catch(e => { console.error(String(e.message).replace(/https:\/\/[^\s"'<>]+/g, '[URL]')); process.exitCode = 1; }).finally(async () => { unblock?.(); await browser?.close(); });
