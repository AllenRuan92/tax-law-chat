import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt, cdata, signature, verifySignature, parseXml, verifyAccess } from './crypto.mjs';
import { APP_ID } from './index.mjs';

// Synthetic incoming callback only: never sends a message to a real WeChat user.
export async function testEntry() {
  const out = new URL('../output/wechat/', import.meta.url);
  const env = JSON.parse(fs.readFileSync(new URL('secrets.local.json', out), 'utf8'));
  const deployment = JSON.parse(fs.readFileSync(new URL('deployment.json', out), 'utf8'));
  const stamp = String(Math.floor(Date.now() / 1000)), nonce = randomBytes(8).toString('hex');
  const challenge = new URL(deployment.callback);
  challenge.search = new URLSearchParams({ timestamp: stamp, nonce, echostr: 'poc-verification', signature: signature(env.WECHAT_TOKEN, stamp, nonce) });
  const verified = await fetch(challenge, { signal: AbortSignal.timeout(30000) });
  if (verified.status !== 200 || await verified.text() !== 'poc-verification') throw new Error('Verification challenge failed');
  const raw = `<xml><ToUserName><![CDATA[gh-poc-synthetic]]></ToUserName><FromUserName><![CDATA[poc-synthetic-${nonce}]]></FromUserName><CreateTime>${stamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[联调入口，不发送真实微信消息]]></Content><MsgId>9876543210987654321</MsgId></xml>`;
  const encrypted = encrypt(raw, env.WECHAT_AES_KEY, APP_ID);
  const callback = new URL(deployment.callback); callback.search = new URLSearchParams({ timestamp: stamp, nonce, encrypt_type: 'aes', msg_signature: signature(env.WECHAT_TOKEN, stamp, nonce, encrypted) });
  const start = Date.now();
  const response = await fetch(callback, { method: 'POST', headers: { 'Content-Type': 'text/xml' }, body: `<xml><Encrypt>${cdata(encrypted)}</Encrypt></xml>`, signal: AbortSignal.timeout(30000) });
  if (response.status !== 200) throw new Error('Encrypted callback failed, status ' + response.status);
  const outer = parseXml(await response.text()); verifySignature(outer.MsgSignature, env.WECHAT_TOKEN, outer.TimeStamp, outer.Nonce, outer.Encrypt);
  const content = parseXml(decrypt(outer.Encrypt, env.WECHAT_AES_KEY, APP_ID)).Content;
  const token = /#access=([\w.-]+)/.exec(content)?.[1];
  if (deployment.publicChat) {
    if (token || !content.includes('href="https://allenruan92.github.io/tax-law-chat/wechat.html"') || content.includes('24 小时')) throw new Error('Expected the fixed public entry');
  } else verifyAccess(token, env.SESSION_SIGNING_KEY, APP_ID);
  return { token, publicChat: deployment.publicChat === true, callbackMs: Date.now() - start, endpoint: deployment.chat };
}
async function main() {
  const entry = await testEntry();
  const headers = { Origin: 'https://allenruan92.github.io', 'Content-Type': 'application/json' };
  const body = JSON.stringify({ messages: [{ role: 'user', content: '请简要说明公司制基金与合伙制基金在所得税纳税主体上的区别，并列出资料依据。' }] });
  // Invalid input exercises the public path without incurring an extra model call.
  const denied = await fetch(entry.endpoint, { method: 'POST', headers, body: JSON.stringify({ messages: [] }), signal: AbortSignal.timeout(30000) });
  if (denied.status !== (entry.publicChat ? 400 : 401)) throw new Error('Unexpected input validation status');
  const preflight = await fetch(entry.endpoint, { method: 'OPTIONS', headers: { Origin: headers.Origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' }, signal: AbortSignal.timeout(30000) });
  if (preflight.status !== 204 || preflight.headers.get('access-control-allow-origin') !== headers.Origin) throw new Error('Preflight failed');
  const report = { verifiedAt: new Date().toISOString(), encryptedCallback: true, callbackMs: entry.callbackMs, publicChat: entry.publicChat, invalidInputRejected: true, cors: true };
  if (process.argv.includes('--chat')) {
    const response = await fetch(entry.endpoint, { method: 'POST', headers: { ...headers, ...(entry.publicChat ? {} : { Authorization: 'Bearer ' + entry.token }) }, body, signal: AbortSignal.timeout(175000) });
    if (response.status !== 200) throw new Error('Live chat failed, status ' + response.status);
    const result = await response.json();
    if (!result.answer || typeof result.answer !== 'string') throw new Error('Missing answer');
    report.answerCharacters = result.answer.length; report.liveChat = true;
  }
  fs.writeFileSync(new URL('../output/wechat/smoke-report.json', import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(e => { console.error(String(e.message).replace(/https:\/\/\S+/g, '[URL]')); process.exitCode = 1; });
