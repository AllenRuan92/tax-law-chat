'use strict';
const { createHash, timingSafeEqual } = require('node:crypto');

const ORIGIN = 'https://llm-zc86z2f8ixro6odd.cn-beijing.maas.aliyuncs.com';
const CATEGORY = 'cate_73e2dc904de24dfda66c07cdc7d58774_12140030';
const UPLOAD_HOST = 'dashscope-file-datacenter-prod-01.oss-cn-beijing.aliyuncs.com';
const ROUTES = { lease: '/api/v1/connector/dash/applyFileUploadLease', register: '/api/v1/connector/dash/addFile' };
const LIMITS = { pdf:150, doc:150, docx:150, ppt:150, pptx:150, txt:10, md:10, markdown:10, html:10, xls:10, xlsx:10, png:20, jpg:20, jpeg:20, bmp:20, gif:20 };
const MAX_BODY = 4096;

// The function accepts the user's existing Key, but stores only its SHA-256 digest.
// CORS is not authentication. No event, key, document metadata or lease URL is logged.
function createHandler({ env = process.env, fetcher = globalThis.fetch } = {}) {
  return async function handler(event) {
    let request;
    try {
      if (Buffer.isBuffer(event) || typeof event === 'string') {
        if (Buffer.byteLength(event) > 32768) throw new Error();
        request = JSON.parse(event.toString());
      } else request = event;
      if (!request || typeof request !== 'object') throw new Error();
    } catch { return reply(400, '请求格式无效。'); }
    const headers = Object.fromEntries(Object.entries(request.headers || {}).map(([k,v]) => [k.toLowerCase(), v]));
    const allowed = (env.ALLOWED_ORIGINS || 'https://allenruan92.github.io').split(',').map(s => s.trim()).filter(Boolean);
    const origin = headers.origin;
    // Keep response header names normalized.
    const cors = { 'vary': 'Origin' };
    if (!origin || !allowed.includes(origin)) return reply(403, '来源不在允许列表。', cors);
    Object.assign(cors, { 'access-control-allow-origin': origin });
    const method = request.requestContext?.http?.method;
    if (method === 'OPTIONS') {
      const requestedHeaders = String(headers['access-control-request-headers'] || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      if (headers['access-control-request-method'] !== 'POST' || requestedHeaders.some(h => !['authorization','content-type'].includes(h))) return reply(403, '不支持此跨域请求。', cors);
      return { statusCode: 204, headers: { ...cors, 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'Authorization, Content-Type', 'access-control-max-age': '600', 'cache-control': 'no-store' }, body: '', isBase64Encoded: false };
    }
    if (method !== 'POST') return reply(405, '仅支持 POST。', cors);
    const expected = env.API_KEY_SHA256 || '';
    if (!/^[a-f0-9]{64}$/i.test(expected)) return reply(503, '上传代理尚未配置鉴权。', cors);
    const match = /^Bearer ([A-Za-z0-9_.-]{8,4096})$/.exec(String(headers.authorization || ''));
    if (!match || !timingSafeEqual(createHash('sha256').update(match[1]).digest(), Buffer.from(expected, 'hex'))) return reply(401, '当前 Key 未获上传代理授权。', cors);
    if (!/^application\/json(?:\s*;|$)/i.test(String(headers['content-type'] || ''))) return reply(415, '仅接受 JSON 元数据。', cors);
    let input;
    try {
      if (typeof request.body !== 'string' || request.body.length > MAX_BODY * 2) throw new Error();
      const body = Buffer.from(request.body, request.isBase64Encoded ? 'base64' : 'utf8');
      if (body.length > MAX_BODY) return reply(413, '请求过大，请勿向代理上传文件内容。', cors);
      input = JSON.parse(body.toString('utf8'));
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
    } catch { return reply(400, 'JSON 请求无效。', cors); }
    let body;
    if (input.operation === 'lease') {
      const name = input.fileName;
      const size = Number(input.sizeBytes);
      const extension = typeof name === 'string' && name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      if (!name || name.length > 200 || /[\x00-\x1f/\\]/.test(name) || !LIMITS[extension] || !Number.isSafeInteger(size) || size <= 0 || size > LIMITS[extension] * 1024 ** 2 || !/^[A-Za-z0-9+/]{22}==$/.test(input.contentMd5 || '')) return reply(400, '文件名、格式、大小或校验值不符合要求。', cors);
      body = { category: CATEGORY, fileName: name, sizeBytes: String(size), contentMd5: input.contentMd5 };
    } else if (input.operation === 'register') {
      if (typeof input.leaseId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(input.leaseId)) return reply(400, '上传凭证 ID 无效。', cors);
      body = { category: CATEGORY, leaseId: input.leaseId, parser: 'AUTO_SELECT' };
    } else return reply(400, '此代理只支持申请上传与登记文件。', cors);
    try {
      const response = await fetcher(ORIGIN + ROUTES[input.operation], {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { Authorization: `Bearer ${match[1]}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!response.ok) return reply([401,403,429].includes(response.status) ? response.status : 502, '百炼未接受上传操作，请检查权限或稍后重试。', cors);
      const result = await response.json();
      const data = result.data ?? result;
      const invalid = value => value?.success === false || value?.status_code >= 400 || (value?.code !== undefined && !['200','success'].includes(String(value.code).toLowerCase()));
      if (invalid(result) || invalid(data)) return reply(502, '百炼未完成此操作，请在控制台核对文件状态。', cors);
      let output;
      if (input.operation === 'lease') {
        const url = new URL(data.param?.url);
        if (typeof data.leaseId !== 'string' || !/^[A-Za-z0-9_.-]{1,256}$/.test(data.leaseId) || url.protocol !== 'https:' || url.hostname !== UPLOAD_HOST || url.username || url.password || url.port || (data.param.method && data.param.method !== 'PUT')) throw new Error();
        output = { leaseId: data.leaseId, param: { url: url.href, method: 'PUT', headers: Object.fromEntries(Object.entries(data.param.headers || {}).filter(([k]) => ['content-type','content-md5','x-bailian-extra'].includes(k.toLowerCase()))) } };
      } else {
        if (typeof data.fileId !== 'string' || !data.fileId) throw new Error();
        output = { fileId: data.fileId };
      }
      return reply(200, null, cors, output);
    } catch { return reply(502, '百炼连接超时或返回格式异常，请先核对状态，避免重复上传。', cors); }
  };
}
function reply(statusCode, message, headers = {}, data) {
  return { statusCode, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(message ? { success: false, message } : { success: true, data }), isBase64Encoded: false };
}
exports.createHandler = createHandler;
const fcHandler = createHandler();
exports.handler = async event => {
  const result = await fcHandler(event);
  // The fcapp.run gateway injects CORS headers, even without corsConfig.
  // Emitting them here as well creates duplicate Allow-Origin values rejected by browsers.
  // Origin, preflight method/headers and Key are still validated inside the handler.
  result.headers = Object.fromEntries(Object.entries(result.headers).filter(([name]) => !name.startsWith('access-control-')));
  return result;
};
