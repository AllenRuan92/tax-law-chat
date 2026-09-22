import { randomBytes } from 'node:crypto';
import { signature, verifySignature, parseXml, cdata, encrypt, decrypt, mintAccess, verifyAccess } from './crypto.mjs';
import { DEFAULT_AGENT, ENDPOINT, eventMeaning, readSSE } from '../lib/chat.js';

const ORIGIN = 'https://allenruan92.github.io';
const CHAT_PAGE = ORIGIN + '/tax-law-chat/wechat.html';
export const APP_ID = 'wx6dde485592f7682e';
const json = (code, message, headers = {}, extra = {}) => reply(code, JSON.stringify({ ...(message ? { message } : {}), ...extra }), headers, 'application/json; charset=utf-8');
function reply(statusCode, body, headers = {}, type = 'text/plain; charset=utf-8') {
  return { statusCode, body, isBase64Encoded: false, headers: { ...headers, 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } };
}
export function validMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 21 || messages.length % 2 !== 1) return false;
  let total = 0;
  return messages.every((m, i) => m && Object.keys(m).length === 2 && m.role === (i % 2 ? 'assistant' : 'user') && typeof m.content === 'string' && m.content.trim() && m.content.length <= (i % 2 ? 24000 : 6000) && (total += m.content.length) <= 24000);
}
export function createHandler({ env = process.env, fetcher = globalThis.fetch, now = Date.now } = {}) {
  // Public POC is an explicit deployment choice, not an accidentally missing credential.
  // There is intentionally no application-level rate limiter in this version.
  return async event => {
    let request;
    try {
      if ((Buffer.isBuffer(event) || typeof event === 'string') && Buffer.byteLength(event) > 250000) return json(413, '请求过大。');
      request = Buffer.isBuffer(event) || typeof event === 'string' ? JSON.parse(event.toString()) : event;
      if (!request || typeof request !== 'object') throw new Error();
    } catch { return json(400, '请求无效。'); }
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const method = request.requestContext?.http?.method;
    const path = request.rawPath || request.requestContext?.http?.path;
    if (path === '/wechat/callback') {
      if (!/^[a-zA-Z0-9]{3,32}$/.test(env.WECHAT_TOKEN || '') || !/^[\w+/]{43}$/.test(env.WECHAT_AES_KEY || '') || (env.SESSION_SIGNING_KEY || '').length < 32) return json(503, '消息回调尚未配置。');
      try {
        const query = request.queryParameters || request.queryStringParameters || Object.fromEntries(new URLSearchParams(request.rawQueryString || ''));
        const { timestamp, nonce } = query;
        if (!/^\d{10}$/.test(timestamp || '') || Math.abs(now() / 1000 - Number(timestamp)) > 600 || typeof nonce !== 'string' || !/^[\w-]{1,128}$/.test(nonce)) throw new Error();
        if (method === 'GET') {
          if (typeof query.echostr !== 'string' || query.echostr.length > 2048) throw new Error();
          if (query.encrypt_type === 'aes') {
            verifySignature(query.msg_signature, env.WECHAT_TOKEN, timestamp, nonce, query.echostr);
            return reply(200, decrypt(query.echostr, env.WECHAT_AES_KEY, APP_ID));
          }
          verifySignature(query.signature, env.WECHAT_TOKEN, timestamp, nonce);
          return reply(200, query.echostr);
        }
        if (method !== 'POST') return reply(405, 'Method not allowed');
        if (query.encrypt_type !== 'aes' || typeof request.body !== 'string' || request.body.length > 180000) throw new Error();
        const outer = parseXml(Buffer.from(request.body, request.isBase64Encoded ? 'base64' : 'utf8').toString());
        verifySignature(query.msg_signature, env.WECHAT_TOKEN, timestamp, nonce, outer.Encrypt);
        const message = parseXml(decrypt(outer.Encrypt, env.WECHAT_AES_KEY, APP_ID));
        if (!message.FromUserName || message.FromUserName.length > 128 || !message.ToUserName || message.ToUserName.length > 128) throw new Error();
        if (message.MsgType === 'event' && message.Event !== 'subscribe') return reply(200, 'success');
        const publicChat = env.PUBLIC_CHAT === 'true';
        const link = publicChat ? CHAT_PAGE : CHAT_PAGE + '#access=' + mintAccess(message.FromUserName, env.SESSION_SIGNING_KEY, APP_ID, now());
        const entryNote = publicChat ? '公开试用，无需登录或填写密钥。固定入口不设到期时间。' : '无需填写密钥。入口 24 小时有效；过期后请重新发送消息获取入口，请勿转发专属链接。';
        const content = `欢迎来到税务案头。\n\n<a href="${link}">点这里开始税务问答</a>\n\n可连续追问。${entryNote}\n回答仅供研究参考，请核对现行法规。`;
        const xml = `<xml><ToUserName>${cdata(message.FromUserName)}</ToUserName><FromUserName>${cdata(message.ToUserName)}</FromUserName><CreateTime>${Math.floor(now() / 1000)}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content>${cdata(content)}</Content></xml>`;
        const encrypted = encrypt(xml, env.WECHAT_AES_KEY, APP_ID), stamp = String(Math.floor(now() / 1000)), salt = randomBytes(12).toString('hex');
        return reply(200, `<xml><Encrypt>${cdata(encrypted)}</Encrypt><MsgSignature>${cdata(signature(env.WECHAT_TOKEN, stamp, salt, encrypted))}</MsgSignature><TimeStamp>${stamp}</TimeStamp><Nonce>${cdata(salt)}</Nonce></xml>`, {}, 'application/xml; charset=utf-8');
      } catch { return reply(403, 'Invalid callback'); }
    }
    if (path !== '/chat') return json(404, '接口不存在。');
    const cors = { vary: 'Origin' };
    if (headers.origin !== ORIGIN) return json(403, '来源不在允许列表。', cors);
    cors['access-control-allow-origin'] = ORIGIN;
    if (method === 'OPTIONS') {
      const wanted = String(headers['access-control-request-headers'] || '').toLowerCase().split(',').map(v => v.trim()).filter(Boolean);
      if (headers['access-control-request-method'] !== 'POST' || wanted.some(h => !['authorization', 'content-type'].includes(h))) return json(403, '不支持的请求。', cors);
      return reply(204, '', { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600' });
    }
    if (method !== 'POST') return json(405, '仅支持 POST。', cors);
    if (env.PUBLIC_CHAT !== 'true') {
      if ((env.SESSION_SIGNING_KEY || '').length < 32) return json(503, '问答访问模式尚未配置。', cors);
      try { verifyAccess(/^Bearer ([\w.-]+)$/.exec(headers.authorization || '')?.[1], env.SESSION_SIGNING_KEY, APP_ID, now()); }
      catch { return json(401, '当前服务未开放公开试用，请联系管理员。', cors); }
    }
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || '')) return json(415, '仅接受 JSON。', cors);
    let messages;
    try {
      if (typeof request.body !== 'string' || request.body.length > 140000) throw new Error();
      const body = Buffer.from(request.body, request.isBase64Encoded ? 'base64' : 'utf8');
      if (body.length > 100000) throw new Error();
      const input = JSON.parse(body.toString());
      if (Object.keys(input).length !== 1 || !validMessages(input.messages)) throw new Error();
      messages = input.messages.map(({ role, content }) => ({ role, content }));
    } catch { return json(400, '问题或上下文过长，请缩短问题或新建对话。', cors); }
    if (!env.DASHSCOPE_API_KEY) return json(503, '问答服务尚未配置。', cors);
    try {
      const response = await fetcher(ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(150000),
        headers: { Authorization: `Bearer ${env.DASHSCOPE_API_KEY}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ input: { messages }, parameters: { agent_options: { agent_id: DEFAULT_AGENT } }, stream: true }) });
      if (!response.ok) { await response.body?.cancel(); return json(response.status === 429 ? 429 : 502, '知识库服务暂时繁忙，请稍后重试。', cors); }
      let answer = '', complete = false;
      await readSSE(response.body, event => {
        const meaning = eventMeaning(event);
        if (meaning.text) answer += meaning.text;
        if (answer.length > 100000 || answer.includes(env.DASHSCOPE_API_KEY)) throw new Error('Invalid output');
        if (meaning.done) complete = true;
      });
      if (!complete || !answer.trim()) throw new Error('Incomplete output');
      return json(200, null, cors, { answer });
    } catch { return json(502, '未收到完整回答，请稍后重试。', cors); }
  };
}
const handle = createHandler();
export async function handler(event) {
  const response = await handle(event);
  // fcapp.run injects these headers; duplicates make browsers reject valid responses.
  response.headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !name.startsWith('access-control-')));
  return response;
}
