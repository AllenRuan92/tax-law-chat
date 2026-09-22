import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { APP_ID, createHandler, validMessages } from '../wechat/index.mjs';
import { encrypt, decrypt, signature, verifySignature, parseXml, cdata, mintAccess, verifyAccess } from '../wechat/crypto.mjs';

const time = 1800576000000, stamp = String(time / 1000);
const env = { WECHAT_TOKEN: 'TestOnlyToken0123456', WECHAT_AES_KEY: randomBytes(32).toString('base64').slice(0, 43), SESSION_SIGNING_KEY: 'test-secret-not-production-'.repeat(3), DASHSCOPE_API_KEY: 'TEST-PRIVATE-API-KEY' };
const origin = 'https://allenruan92.github.io';
const xml = '<xml><ToUserName><![CDATA[gh_example]]></ToUserName><FromUserName><![CDATA[test-openid]]></FromUserName><CreateTime>1800576000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[你好]]></Content><MsgId>9876543210987654321</MsgId></xml>';
function callback(source = xml) {
  const encrypted = encrypt(source, env.WECHAT_AES_KEY, APP_ID);
  return { rawPath: '/wechat/callback', requestContext: { http: { method: 'POST' } }, queryParameters: { encrypt_type: 'aes', timestamp: stamp, nonce: 'abc123', msg_signature: signature(env.WECHAT_TOKEN, stamp, 'abc123', encrypted) }, body: `<xml><Encrypt>${cdata(encrypted)}</Encrypt></xml>` };
}
const access = mintAccess('test-openid', env.SESSION_SIGNING_KEY, APP_ID, time);
const chat = (messages = [{ role: 'user', content: '什么是创投优惠？' }], token = access) => ({ rawPath: '/chat', requestContext: { http: { method: 'POST' } }, headers: { origin, authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ messages }) });
const sse = text => new Response(`data: ${JSON.stringify({ output: { choices: [{ message: { content: text, extra: { step: 'generating', step_change: 'generation_end' } } }] } })}\n\ndata: [DONE]\n\n`);

test('WeChat AES framing, 32-byte padding, UTF8 and recipient binding', () => {
  for (let n = 0; n < 65; n++) { const input = '中文测试' + 'x'.repeat(n); assert.equal(decrypt(encrypt(input, env.WECHAT_AES_KEY, APP_ID), env.WECHAT_AES_KEY, APP_ID), input); }
  assert.throws(() => decrypt(encrypt(xml, env.WECHAT_AES_KEY, APP_ID), env.WECHAT_AES_KEY, 'wx-foreign'));
  assert.throws(() => decrypt('invalid', env.WECHAT_AES_KEY, APP_ID));
  verifySignature(signature('t', '123', 'n'), 't', '123', 'n'); assert.throws(() => verifySignature('bad', 't', '123', 'n'));
});
test('AES matches the official WeChat Java SDK deterministic interoperability fixture', () => {
  // Public test vector: wximg.gtimg.com/shake_tv/mpwiki/cryptoDemo.zip,
  // Java/src/com/qq/weixin/mp/aes/WXBizMsgCryptTest.java (not live credentials).
  const key = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', appId = 'wxb11529c136998cb6';
  const ciphertext = 'jn1L23DB+6ELqJ+6bruv21Y6MD7KeIfP82D6gU39rmkgczbWwt5+3bnyg5K55bgVtVzd832WzZGMhkP72vVOfg==';
  assert.equal(encrypt('我是中文abcd123', key, appId, Buffer.from('aaaabbbbccccdddd')), ciphertext);
  assert.equal(decrypt(ciphertext, key, appId), '我是中文abcd123');
});
test('strict XML preserves 64-bit IDs, rejects DTD, duplicates and nested data', () => {
  assert.equal(parseXml(xml).MsgId, '9876543210987654321');
  assert.equal(parseXml(`<xml><Content>${cdata('a]]>b & 中文')}</Content></xml>`).Content, 'a]]>b & 中文');
  for (const bad of ['<!DOCTYPE xml [<!ENTITY x "hi">]><xml><a>&x;</a></xml>', '<xml><a>1</a><a>2</a></xml>', '<xml><a><b>x</b></a></xml>', 'x'.repeat(65537), '<xml>']) assert.throws(() => parseXml(bad));
});
test('signed entry is pseudonymous, expires and rejects tamper / different audience', () => {
  assert.equal(verifyAccess(access, env.SESSION_SIGNING_KEY, APP_ID, time).sub.length, 32);
  assert.ok(!Buffer.from(access.split('.')[0], 'base64url').toString().includes('test-openid'));
  assert.throws(() => verifyAccess(access, env.SESSION_SIGNING_KEY, APP_ID, time + 86400000));
  assert.throws(() => verifyAccess(access, env.SESSION_SIGNING_KEY, 'wx-other', time));
  assert.throws(() => verifyAccess(access.slice(0, -1) + (access.endsWith('a') ? 'b' : 'a'), env.SESSION_SIGNING_KEY, APP_ID, time));
});
test('verified encrypted callback yields encrypted personal link without upstream request', async () => {
  const handler = createHandler({ env, now: () => time, fetcher: () => { throw new Error('Callback must not call upstream'); } });
  const response = await handler(callback()); assert.equal(response.statusCode, 200);
  const outer = parseXml(response.body); verifySignature(outer.MsgSignature, env.WECHAT_TOKEN, outer.TimeStamp, outer.Nonce, outer.Encrypt);
  const plain = parseXml(decrypt(outer.Encrypt, env.WECHAT_AES_KEY, APP_ID));
  assert.equal(plain.ToUserName, 'test-openid'); assert.match(plain.Content, /wechat\.html#access=/);
  const token = /#access=([\w.-]+)/.exec(plain.Content)[1]; verifyAccess(token, env.SESSION_SIGNING_KEY, APP_ID, time);
  assert.ok(!response.body.includes(token)); assert.ok(!plain.Content.includes(env.DASHSCOPE_API_KEY));
  const get = { rawPath: '/wechat/callback', requestContext: { http: { method: 'GET' } }, queryParameters: { timestamp: stamp, nonce: 'abc', echostr: '123456', signature: signature(env.WECHAT_TOKEN, stamp, 'abc') } };
  assert.equal((await handler(get)).body, '123456');
  assert.equal((await handler(callback(xml.replace('<MsgType><![CDATA[text]]></MsgType>', '<MsgType><![CDATA[event]]></MsgType><Event><![CDATA[unsubscribe]]></Event>')))).body, 'success');
});
test('callback rejects wrong signature, stale timestamp, plaintext and foreign recipient', async () => {
  const handler = createHandler({ env, now: () => time });
  const wrong = callback(); wrong.queryParameters.msg_signature = '0'.repeat(40); assert.equal((await handler(wrong)).statusCode, 403);
  const stale = callback(); stale.queryParameters.timestamp = String(time / 1000 - 601); assert.equal((await handler(stale)).statusCode, 403);
  const plain = callback(); delete plain.queryParameters.encrypt_type; assert.equal((await handler(plain)).statusCode, 403);
  const foreign = callback(), value = encrypt(xml, env.WECHAT_AES_KEY, 'wx-other'); foreign.body = `<xml><Encrypt>${cdata(value)}</Encrypt></xml>`; foreign.queryParameters.msg_signature = signature(env.WECHAT_TOKEN, stamp, 'abc123', value); assert.equal((await handler(foreign)).statusCode, 403);
});
test('input context is bounded and alternating, excludes arbitrary roles and options', () => {
  assert.ok(validMessages([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'world' }, { role: 'user', content: 'followup' }]));
  for (const bad of [[], [{ role: 'system', content: 'x' }], [{ role: 'user', content: 'x', tool: {} }], [{ role: 'user', content: 'x'.repeat(6001) }], [{ role: 'user', content: '' }], [{ role: 'assistant', content: 'x' }], Array(23).fill({ role: 'user', content: 'x' })]) assert.ok(!validMessages(bad));
});
test('chat auth, CORS, path and validation prevent any upstream request', async () => {
  let calls = 0; const handler = createHandler({ env, now: () => time, fetcher: async () => { calls++; return sse('答'); } });
  assert.equal((await handler(chat(undefined, 'bad'))).statusCode, 401);
  assert.equal((await handler({ ...chat(), headers: { ...chat().headers, origin: 'https://evil.example' } })).statusCode, 403);
  assert.equal((await handler(chat([{ role: 'system', content: 'x' }]))).statusCode, 400);
  assert.equal((await handler({ ...chat(), rawPath: '/manage' })).statusCode, 404);
  const extra = chat(); extra.body = JSON.stringify({ messages: [{ role: 'user', content: 'x' }], agent_id: 'other' }); assert.equal((await handler(extra)).statusCode, 400);
  assert.equal((await handler({ ...chat(), requestContext: { http: { method: 'OPTIONS' } }, headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization,Content-Type' } })).statusCode, 204);
  assert.equal(calls, 0);
});
test('chat forwards only fixed app/context; aggregates SSE; errors and private output are redacted', async () => {
  const handler = createHandler({ env, now: () => time, fetcher: async (url, req) => {
    assert.match(url, /api\/v2\/apps\/knowledge\/chat$/); const body = JSON.parse(req.body); assert.equal(body.parameters.agent_options.agent_id, 'aid-c13de479d8944f12b3c45ef9a45af154'); assert.equal(req.headers.Authorization, 'Bearer ' + env.DASHSCOPE_API_KEY); return sse('税务回答');
  } });
  assert.equal(JSON.parse((await handler(chat())).body).answer, '税务回答');
  for (const fetcher of [async () => { throw new Error(env.DASHSCOPE_API_KEY); }, async () => sse(env.DASHSCOPE_API_KEY), async () => new Response('private ' + env.DASHSCOPE_API_KEY, { status: 500 }), async () => new Response('data: [DONE]\n\n')]) {
    const response = await createHandler({ env, now: () => time, fetcher })(chat()); assert.equal(response.statusCode, 502); assert.ok(!response.body.includes(env.DASHSCOPE_API_KEY));
  }
});
test('no application request-count limit; contexts still stay independent', async () => {
  const contexts = [], handler = createHandler({ env, now: () => time, fetcher: async (u, req) => { contexts.push(JSON.parse(req.body).input.messages); return sse('答'); } });
  for (let n = 0; n < 6; n++) assert.equal((await handler(chat())).statusCode, 200);
  assert.equal((await handler(chat())).statusCode, 200);
  const other = mintAccess('someone-else', env.SESSION_SIGNING_KEY, APP_ID, time);
  assert.equal((await handler(chat([{ role: 'user', content: '独立问题' }], other))).statusCode, 200); assert.deepEqual(contexts.at(-1), [{ role: 'user', content: '独立问题' }]);
});
test('public POC accepts missing, invalid and expired tokens without WeChat configuration', async () => {
  let calls = 0;
  const handler = createHandler({ env: { PUBLIC_CHAT: 'true', DASHSCOPE_API_KEY: env.DASHSCOPE_API_KEY }, now: () => time + 86400001, fetcher: async () => { calls++; return sse('公开问答'); } });
  const anonymous = chat(); delete anonymous.headers.authorization;
  for (const request of [anonymous, chat(undefined, 'invalid'), chat()]) assert.equal((await handler(request)).statusCode, 200);
  assert.equal(calls, 3);
  assert.equal((await handler({ ...anonymous, rawPath: '/wechat/callback' })).statusCode, 503);
  assert.equal((await handler({ ...anonymous, headers: { ...anonymous.headers, origin: 'https://other.example' } })).statusCode, 403);
  assert.equal((await handler({ ...anonymous, body: JSON.stringify({ messages: [{ role: 'system', content: 'x' }] }) })).statusCode, 400);
});
test('public POC must be explicitly enabled and never opens knowledge management', async () => {
  const anonymous = chat(); delete anonymous.headers.authorization;
  for (const flag of [undefined, 'false', 'TRUE', '1']) {
    const handler = createHandler({ env: { ...env, PUBLIC_CHAT: flag }, now: () => time });
    assert.equal((await handler(anonymous)).statusCode, 401);
  }
  const handler = createHandler({ env: { ...env, PUBLIC_CHAT: 'true' }, now: () => time });
  assert.equal((await handler({ ...anonymous, rawPath: '/manage' })).statusCode, 404);
  const noKey = createHandler({ env: { PUBLIC_CHAT: 'true' } });
  assert.equal((await noKey(anonymous)).statusCode, 503);
});
test('public callback returns only the fixed URL and retains encrypted callback validation', async () => {
  const handler = createHandler({ env: { ...env, PUBLIC_CHAT: 'true' }, now: () => time });
  const response = await handler(callback()), outer = parseXml(response.body);
  const content = parseXml(decrypt(outer.Encrypt, env.WECHAT_AES_KEY, APP_ID)).Content;
  assert.match(content, /href="https:\/\/allenruan92.github.io\/tax-law-chat\/wechat.html"/);
  assert.ok(!content.includes('#access=')); assert.ok(!content.includes('24 小时'));
  const invalid = callback(); invalid.queryParameters.msg_signature = 'bad';
  assert.equal((await handler(invalid)).statusCode, 403);
});
test('public POC has no application concurrency lock', async () => {
  let calls = 0, release; const gate = new Promise(resolve => release = resolve);
  const handler = createHandler({ env: { ...env, PUBLIC_CHAT: 'true' }, fetcher: async () => { calls++; await gate; return sse('并行答案'); } });
  const requests = Array.from({ length: 8 }, () => handler(chat(undefined, '')));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 8);
  release(); assert.ok((await Promise.all(requests)).every(response => response.statusCode === 200));
});
