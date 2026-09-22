// Node Playwright fallback: Python Playwright is unavailable in this workspace.
// Isolated Chrome only. Default questions are mocked; --real performs one billable Q&A.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.TAX_PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..'), site = 'https://allenruan92.github.io/tax-law-chat/', pageUrl = site + 'wechat.html';
const endpoint = 'https://tax-lawchat-bot-kycjexvvew.cn-beijing.fcapp.run/chat';
const assets = new Set(['wechat.html', 'wechat-app.js', 'wechat.css', 'wechat-config.js', 'styles.css', 'favicon.svg', 'conversation-manager.js', 'lib/chat.js', 'lib/conversations.js', 'lib/markdown.js']);
const out = path.join(root, 'output/playwright'); fs.mkdirSync(out, { recursive: true });
const errors = [], calls = []; let browser, unblock;
const token = (sub = 'a'.repeat(32), exp = Math.floor(Date.now() / 1000) + 3600) => Buffer.from(JSON.stringify({ sub, aud: 'wx6dde485592f7682e', exp })).toString('base64url') + '.TEST-SIGNATURE';
const wait = async (fn, label) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('Timed out: ' + label); };
const ready = page => page.waitForFunction(() => !document.querySelector('#new-chat').disabled);
const rows = page => page.evaluate(async () => { const token = sessionStorage.getItem('tax-law-wechat.access'), sub = JSON.parse(atob(token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/'))).sub; return (await (await import('./lib/conversations.js')).openConversationStore(indexedDB, 'tax-law-wechat.' + sub + '.history.v2')).list(); });
async function context(real = false) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', acceptDownloads: true });
  if (!process.argv.includes('--live')) await ctx.route(site + '**', async route => {
    const relative = new URL(route.request().url()).pathname.slice('/tax-law-chat/'.length);
    if (!assets.has(relative)) return route.abort();
    await route.fulfill({ status: 200, contentType: relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html', body: fs.readFileSync(path.join(root, relative)) });
  });
  if (!real) await ctx.route(endpoint, async route => {
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': 'https://allenruan92.github.io', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'POST' } });
    const messages = route.request().postDataJSON().messages; calls.push(messages);
    const question = messages.at(-1).content;
    if (question === '等待中') await new Promise(resolve => unblock = resolve);
    await route.fulfill({ status: question === '入口失效' ? 401 : 200, contentType: 'application/json', body: JSON.stringify(question === '入口失效' ? { message: '请重新从公众号进入。' } : { answer: '测试回答：' + question + '\n\n**依据**：请核对法规原文。' }) }).catch(() => {});
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
  assert.equal(await page.locator('#send-button').isDisabled(), true);
  assert.match(await page.locator('#entry-notice').innerText(), /钻木者得火/);
  assert.equal(await page.locator('#api-key,#open-settings,#open-knowledge').count(), 0);
  await page.goto(pageUrl + '#access=' + token(), { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(new URL(page.url()).hash, ''); assert.equal(await page.locator('#send-button').isDisabled(), false);
  await page.screenshot({ path: path.join(out, 'wechat-welcome-desktop.png'), fullPage: true });
  await send(page, '公司制基金的纳税主体'); await send(page, '那合伙制呢？'); assert.equal(calls.at(-1).length, 3);
  await page.locator('#new-chat').click(); await send(page, '新话题'); assert.equal(calls.at(-1).length, 1);
  assert.equal(await page.locator('.history-panel .history-item').count(), 2);
  await page.locator('.history-panel .history-open').filter({ hasText: '公司制基金' }).click();
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
  assert.equal(await page.locator('.history-panel .history-item').count(), 1); assert.equal(await page.locator('#messages').isHidden(), true);
  await page.goto(pageUrl + '#access=' + token('a'.repeat(32), Math.floor(Date.now() / 1000) - 1), { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  assert.equal(await page.locator('#send-button').isDisabled(), true); assert.equal(await page.locator('.history-panel .history-item').count(), 2);
  await page.goto(pageUrl + '#access=' + token(), { waitUntil: 'networkidle' }); await page.reload({ waitUntil: 'networkidle' }); await ready(page);
  await page.locator('#question').fill('入口失效'); await page.locator('#send-button').click(); await page.locator('#entry-notice').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => sessionStorage.getItem('tax-law-wechat.access')), null);
  if (process.argv.includes('--real')) {
    const { testEntry } = await import(pathToFileURL(path.join(root, 'wechat/smoke.mjs')).href), entry = await testEntry();
    const live = await context(true), p = await live.newPage();
    await p.goto(pageUrl + '#access=' + entry.token, { waitUntil: 'networkidle' }); await ready(p);
    await p.locator('#question').fill('公司制基金与合伙制基金的所得税纳税主体有什么区别？请简要回答并说明资料依据。');
    await p.locator('#send-button').click();
    await p.waitForFunction(() => [...document.querySelectorAll('.message-status')].some(n => n.textContent.includes('回答完成')), null, { timeout: 175000 });
    assert.equal(new URL(p.url()).hash, '');
    await p.setViewportSize({ width: 390, height: 844 }); await p.screenshot({ path: path.join(out, 'wechat-real-mobile.png'), fullPage: true });
    console.log('Real encrypted callback -> browser CORS -> Bailian answer passed.');
  }
  assert.deepEqual(errors, []);
  console.log('WeChat browser checks passed: context, history, isolation, backup, expiry, cancellation, mobile, no key or management controls.');
})().catch(e => { console.error(String(e.message).replace(/https:\/\/[^\s"'<>]+/g, '[URL]')); process.exitCode = 1; }).finally(async () => { unblock?.(); await browser?.close(); });
