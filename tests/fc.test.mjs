import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler, handler as deployedHandler } from '../fc/code/index.js';

const key = 'test-only-existing-bailian-key';
const site = 'https://allenruan92.github.io';
const env = { API_KEY_SHA256: createHash('sha256').update(key).digest('hex') };
const lease = { operation:'lease', fileName:'税法测试.txt', sizeBytes:'10', contentMd5:'1B2M2Y8AsgTpgAmY7PhCfg==' };
function event(input = lease, headers = {}) {
  return { requestContext:{http:{method:'POST'}}, headers:{Origin:site, Authorization:`Bearer ${key}`, 'Content-Type':'application/json', ...headers}, body:JSON.stringify(input), isBase64Encoded:false };
}
const response = data => new Response(JSON.stringify({success:true,data}));
const noNetwork = async () => { throw new Error('unexpected upstream call'); };

test('FC gateway adapter avoids duplicate CORS headers while retaining Origin rejection', async () => {
  const request = event({}, {'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'});
  request.requestContext.http.method = 'OPTIONS';
  const response = await deployedHandler(request);
  assert.equal(response.statusCode, 204);
  assert.ok(Object.keys(response.headers).every(name => !name.startsWith('access-control-')));
  request.headers.Origin = 'https://other.github.io';
  assert.equal((await deployedHandler(request)).statusCode, 403);
});

test('FC preflight accepts only the specified site, method and headers', async () => {
  const handler = createHandler({env,fetcher:noNetwork});
  const request = event({}, {'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization, content-type'});
  request.requestContext.http.method = 'OPTIONS'; delete request.headers.Authorization;
  let result = await handler(request);
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers['access-control-allow-origin'], site);
  assert.ok(Object.keys(result.headers).every(name => name === name.toLowerCase()));
  request.headers.Origin = 'https://other.github.io';
  assert.equal((await handler(request)).statusCode, 403);
  request.headers.Origin = site; request.headers['Access-Control-Request-Headers'] = 'x-arbitrary-header';
  assert.equal((await handler(request)).statusCode, 403);
});

test('FC is closed without valid key hash, matching key and allowed Origin', async () => {
  const handler = createHandler({env,fetcher:noNetwork});
  assert.equal((await createHandler({env:{},fetcher:noNetwork})(event())).statusCode, 503);
  for (const Authorization of ['', 'Bearer wrong-secret', 'Basic abc']) assert.equal((await handler(event(lease,{Authorization}))).statusCode, 401);
  assert.equal((await handler(event(lease,{Origin:''}))).statusCode, 403);
  const request = event(); request.requestContext.http.method = 'GET';
  assert.equal((await handler(request)).statusCode, 405);
  assert.equal((await handler(event(lease,{'Content-Type':'text/plain'}))).statusCode, 415);
});

test('FC rejects arbitrary operations, invalid files, oversized bodies and invalid JSON', async () => {
  const handler = createHandler({env,fetcher:noNetwork});
  for (const input of [{operation:'delete'}, {...lease,fileName:'../x.txt'}, {...lease,fileName:'x.exe'}, {...lease,sizeBytes:'0'}, {...lease,sizeBytes:'10485761'}, {...lease,contentMd5:'not-md5'}, {operation:'register',leaseId:'../etc'}, null, []]) {
    assert.equal((await handler(event(input))).statusCode, 400);
  }
  const request = event(); request.body = 'invalid JSON';
  assert.equal((await handler(request)).statusCode, 400);
  request.body = ' '.repeat(5000);
  assert.equal((await handler(request)).statusCode, 413);
  assert.equal((await handler(Buffer.from('bad'))).statusCode, 400);
});

test('FC lease fixes the destination and category and returns only necessary upload headers', async () => {
  let calls = 0;
  const handler = createHandler({env,fetcher:async (url,init) => {
    calls++;
    assert.equal(url,'https://llm-zc86z2f8ixro6odd.cn-beijing.maas.aliyuncs.com/api/v1/connector/dash/applyFileUploadLease');
    assert.equal(init.redirect,'error');
    assert.equal(init.headers.Authorization,`Bearer ${key}`);
    assert.deepEqual(JSON.parse(init.body),{category:'cate_73e2dc904de24dfda66c07cdc7d58774_12140030',fileName:lease.fileName,sizeBytes:'10',contentMd5:lease.contentMd5});
    return response({leaseId:'lease-123',param:{url:'https://dashscope-file-datacenter-prod-01.oss-cn-beijing.aliyuncs.com/test?signature=fake',method:'PUT',headers:{'Content-Type':'text/plain',Authorization:'drop-me','x-bailian-extra':'extra'}}});
  }});
  const result = await handler(Buffer.from(JSON.stringify(event({...lease,url:'https://evil.example',category:'other-category'}))));
  assert.equal(result.statusCode,200); assert.equal(calls,1);
  assert.deepEqual(JSON.parse(result.body).data.param.headers,{'Content-Type':'text/plain','x-bailian-extra':'extra'});
  assert.equal(result.headers['cache-control'],'no-store');
  assert.equal(result.body.includes(key),false);
});

test('FC registration handles base64 HTTP events and enforces parser/category', async () => {
  const handler = createHandler({env,fetcher:async (url,init) => {
    assert.ok(url.endsWith('/addFile'));
    assert.deepEqual(JSON.parse(init.body),{category:'cate_73e2dc904de24dfda66c07cdc7d58774_12140030',leaseId:'lease-123.opaque',parser:'AUTO_SELECT'});
    return response({fileId:'file-123',internal:'must not expose'});
  }});
  const request = event({operation:'register',leaseId:'lease-123.opaque',parser:'other'});
  request.body = Buffer.from(request.body).toString('base64'); request.isBase64Encoded = true;
  const result = await handler(request);
  assert.equal(result.statusCode,200);
  assert.deepEqual(JSON.parse(result.body),{success:true,data:{fileId:'file-123'}});
});

test('FC does not expose upstream errors, credentials or unexpected signed URLs', async () => {
  for (const fetcher of [
    async () => { throw new Error(key); },
    async () => new Response(key,{status:500}),
    async () => response({success:false,message:key}),
    async () => response({leaseId:'x',param:{url:`https://evil.example/?secret=${key}`}}),
  ]) {
    const result = await createHandler({env,fetcher})(event());
    assert.equal(result.statusCode,502); assert.equal(result.body.includes(key),false);
  }
});
