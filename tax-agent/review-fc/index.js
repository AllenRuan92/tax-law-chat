import { createHash, timingSafeEqual } from 'node:crypto';
import OSS from 'ali-oss';
import { OssStore } from '../oss-store.mjs';
import { ReviewError, reviewOperation } from '../review-api.mjs';

const REGION = 'oss-cn-beijing';
const MAX_BODY = 16 * 1024;

function reply(statusCode, message, data, headers = {}) {
  return {
    statusCode,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
    body: JSON.stringify(message ? { success: false, message } : { success: true, data }),
    isBase64Encoded: false,
  };
}

export function createRuntime(context, env = process.env) {
  const credentials = context?.credentials;
  const bucket = env.TAX_AGENT_BUCKET;
  if (!credentials?.accessKeyId || !credentials?.accessKeySecret || !credentials?.securityToken || !bucket) throw new Error('审核服务缺少私有存储临时凭证');
  const config = { region: REGION, bucket, accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret, stsToken: credentials.securityToken, secure: true, timeout: 30_000 };
  const store = new OssStore(new OSS({ ...config, internal: true }));
  const signerClient = new OSS({ ...config, internal: false });
  const signer = async (objectKey, file) => {
    const url = signerClient.signatureUrl(objectKey, { expires: 60, response: { 'content-disposition': `attachment; filename="${file}"` } });
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== `${bucket}.${REGION}.aliyuncs.com`) throw new Error('对象下载地址无效');
    return url;
  };
  return { store, signer };
}

export function createReviewHandler({ env = process.env, runtimeFactory = createRuntime, operation = reviewOperation } = {}) {
  return async (event, context) => {
    let request;
    try {
      request = Buffer.isBuffer(event) || typeof event === 'string' ? JSON.parse(String(event)) : event;
      if (!request || typeof request !== 'object') throw new Error();
    } catch { return reply(400, '请求格式无效'); }
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    const origin = String(headers.origin || '');
    const allowed = (env.ALLOWED_ORIGINS || 'https://allenruan92.github.io').split(',').map(item => item.trim()).filter(Boolean);
    const cors = { vary: 'Origin' };
    if (!origin || !allowed.includes(origin)) return reply(403, '来源不在允许列表', undefined, cors);
    cors['access-control-allow-origin'] = origin;
    const method = request.requestContext?.http?.method;
    if (method === 'OPTIONS') {
      const requestedHeaders = String(headers['access-control-request-headers'] || '').toLowerCase().split(',').map(item => item.trim()).filter(Boolean);
      if (String(headers['access-control-request-method'] || '').toUpperCase() !== 'POST' || requestedHeaders.some(item => !['authorization', 'content-type'].includes(item))) return reply(403, '不支持此跨域请求', undefined, cors);
      return { statusCode: 204, headers: { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600', 'cache-control': 'no-store' }, body: '', isBase64Encoded: false };
    }
    if (method !== 'POST') return reply(405, '仅支持 POST', undefined, cors);
    const expected = env.API_KEY_SHA256 || '';
    if (!/^[a-f0-9]{64}$/i.test(expected)) return reply(503, '审核服务尚未配置鉴权', undefined, cors);
    const match = /^Bearer ([A-Za-z0-9_.-]{8,4096})$/.exec(String(headers.authorization || ''));
    if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), Buffer.from(expected, 'hex'))) return reply(401, '当前 Key 未获审核权限', undefined, cors);
    if (!/^application\/json(?:\s*;|$)/i.test(String(headers['content-type'] || ''))) return reply(415, '仅接受 JSON 请求', undefined, cors);
    let input;
    try {
      if (typeof request.body !== 'string' || request.body.length > MAX_BODY * 2) throw new Error();
      const body = Buffer.from(request.body, request.isBase64Encoded ? 'base64' : 'utf8');
      if (body.length > MAX_BODY) return reply(413, '请求过大', undefined, cors);
      input = JSON.parse(body.toString('utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    } catch { return reply(400, 'JSON 请求无效', undefined, cors); }
    try {
      const runtime = runtimeFactory(context, env);
      const data = await operation({ ...runtime, key: match[1] }, input);
      return reply(200, null, data, cors);
    } catch (error) {
      if (error instanceof ReviewError) return reply(error.status, error.message, undefined, cors);
      if (/版本已变化|版本已有审核|已有发布尝试|不在待审核|未获批准/.test(error.message)) return reply(409, error.message, undefined, cors);
      if (/请填写|请记录|核实原文|审核动作无效/.test(error.message)) return reply(400, error.message, undefined, cors);
      if (/发布状态需核对/.test(error.message)) return reply(409, '发布状态需对账，请刷新后核对百炼和 OSS 台账', undefined, cors);
      return reply(502, '审核服务处理失败，请稍后刷新并核对状态', undefined, cors);
    }
  };
}

const serve = createReviewHandler();
export async function handler(event, context) {
  const result = await serve(event, context);
  // FC HTTP gateway adds its own CORS response headers.
  result.headers = Object.fromEntries(Object.entries(result.headers).filter(([name]) => !name.startsWith('access-control-')));
  return result;
}
