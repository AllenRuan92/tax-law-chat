// Run --prepare first, package output/wechat/index.js, then pass --zip <absolute ZIP>.
// Secrets are generated/stored only in git-ignored output/wechat; never printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import SDK from '@alicloud/fc20230330';
import Core from '@alicloud/openapi-core';

const root = fileURLToPath(new URL('../', import.meta.url)), out = path.join(root, 'output/wechat');
const name = 'tax-law-wechat-bot', description = 'Tax law POC - public fixed-link chat and optional encrypted callback';
const legacyDescription = 'Tax law POC - encrypted WeChat entry and signed visitor chat only';
const configPath = path.join(out, 'secrets.local.json');
async function main() {
  fs.mkdirSync(out, { recursive: true });
  let secrets;
  if (fs.existsSync(configPath)) secrets = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  else {
    secrets = { WECHAT_TOKEN: randomBytes(16).toString('hex'), WECHAT_AES_KEY: randomBytes(32).toString('base64').slice(0, 43), SESSION_SIGNING_KEY: randomBytes(48).toString('hex') };
    fs.writeFileSync(configPath, JSON.stringify(secrets, null, 2), { mode: 0o600, flag: 'wx' });
  }
  if (Object.keys(secrets).sort().join(',') !== 'SESSION_SIGNING_KEY,WECHAT_AES_KEY,WECHAT_TOKEN' || !/^[a-f0-9]{32}$/.test(secrets.WECHAT_TOKEN) || !/^[A-Za-z0-9+/]{43}$/.test(secrets.WECHAT_AES_KEY) || !/^[a-f0-9]{96}$/.test(secrets.SESSION_SIGNING_KEY)) throw new Error('Invalid local setup');
  if (process.argv.includes('--prepare')) {
    await build({ entryPoints: [path.join(root, 'wechat/index.mjs')], outfile: path.join(out, 'index.js'), bundle: true, platform: 'node', target: 'node20', format: 'cjs', legalComments: 'none' });
    console.log('Prepared backend bundle and private local settings.'); return;
  }
  const zipArg = process.argv.indexOf('--zip'), zip = zipArg < 0 ? '' : process.argv[zipArg + 1];
  if (!zip || !path.isAbsolute(zip) || path.dirname(path.resolve(zip)) !== out || !zip.endsWith('.zip')) throw new Error('Explicit output/wechat ZIP required');
  const key = process.env.DASHSCOPE_API_KEY;
  const profile = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.aliyun/config.json'), 'utf8')).profiles.find(p => p.name === 'tax-fc-ak');
  if (!key || profile?.mode !== 'AK' || !profile.access_key_secret) throw new Error('Local credentials unavailable');
  const client = new SDK.default(new Core.$OpenApiUtil.Config({ accessKeyId: profile.access_key_id, accessKeySecret: profile.access_key_secret, endpoint: 'fcv3.cn-beijing.aliyuncs.com', regionId: 'cn-beijing', protocol: 'https', readTimeout: 60000, connectTimeout: 10000 }));
  let existing;
  try { existing = (await client.getFunction(name, new SDK.GetFunctionRequest({}))).body; } catch (e) { if (e.code !== 'FunctionNotFound') throw e; }
  if (existing && (!process.argv.includes('--resume') || ![description, legacyDescription].includes(existing.description) || existing.handler !== 'index.handler' || Object.keys(secrets).some(k => existing.environmentVariables?.[k] !== secrets[k]))) throw new Error('Existing resource mismatch or --resume missing');
  const publicChat = process.argv.includes('--public-chat') || existing?.environmentVariables?.PUBLIC_CHAT === 'true';
  const readConcurrency = async () => { try { return (await client.getConcurrencyConfig(name)).body?.reservedConcurrency; } catch (e) { if (e.statusCode === 404) return undefined; throw e; } };
  const oldConcurrency = existing ? await readConcurrency() : undefined;
  if (publicChat && oldConcurrency !== undefined && oldConcurrency !== 2) throw new Error('Concurrency differs from the known POC configuration');
  const code = new SDK.InputCodeLocation({ zipFile: fs.readFileSync(zip).toString('base64') });
  const environmentVariables = { ...existing?.environmentVariables, ...secrets, DASHSCOPE_API_KEY: key, PUBLIC_CHAT: String(publicChat) };
  if (existing) {
    await client.updateFunction(name, new SDK.UpdateFunctionRequest({ body: new SDK.UpdateFunctionInput({ code, environmentVariables, description }) }));
    console.log('Updated verified WeChat function.');
  } else {
    await client.createFunction(new SDK.CreateFunctionRequest({ body: new SDK.CreateFunctionInput({ functionName: name, description, runtime: 'nodejs20', handler: 'index.handler', code, environmentVariables, memorySize: 256, cpu: 0.1, timeout: 180, diskSize: 512, instanceConcurrency: 1, internetAccess: true, disableInjectCredentials: 'All' }) }));
    console.log('Created independent WeChat function.');
  }
  if (publicChat) {
    if (oldConcurrency !== undefined) await client.deleteConcurrencyConfig(name);
    if (await readConcurrency() !== undefined) throw new Error('Custom concurrency cap still present');
    console.log('Verified public POC mode and removal of the function-specific concurrency cap.');
  } else await client.putConcurrencyConfig(name, new SDK.PutConcurrencyConfigRequest({ body: new SDK.PutConcurrencyInput({ reservedConcurrency: 2 }) }));
  let trigger;
  try { trigger = (await client.getTrigger(name, 'wechat-web')).body; } catch (e) { if (e.code !== 'TriggerNotFound') throw e; }
  if (!trigger) trigger = (await client.createTrigger(name, new SDK.CreateTriggerRequest({ body: new SDK.CreateTriggerInput({ triggerName: 'wechat-web', triggerType: 'http', qualifier: 'LATEST', description: 'Encrypted official account callbacks; HMAC-authenticated visitor chat', triggerConfig: JSON.stringify({ authType: 'anonymous', disableURLInternet: false, methods: ['GET', 'POST', 'OPTIONS'] }) }) }))).body;
  const actual = JSON.parse(trigger.triggerConfig);
  if (actual.authType !== 'anonymous' || actual.disableURLInternet || actual.methods?.sort().join(',') !== 'GET,OPTIONS,POST') throw new Error('Unexpected trigger');
  const current = (await client.getFunction(name, new SDK.GetFunctionRequest({}))).body;
  if (Object.entries(environmentVariables).some(([k, v]) => current.environmentVariables?.[k] !== v)) throw new Error('Environment verification failed');
  const url = new URL(trigger.httpTrigger?.urlInternet);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.cn-beijing.fcapp.run')) throw new Error('Unexpected endpoint');
  const report = { name, url: url.origin, callback: url.origin + '/wechat/callback', chat: url.origin + '/chat', memorySize: current.memorySize, cpu: current.cpu, timeout: current.timeout, publicChat, reservedConcurrency: publicChat ? null : 2, verifiedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(out, 'deployment.json'), JSON.stringify(report, null, 2));
  const guidance = publicChat ? '当前已启用公开 POC。公众号菜单发送固定链接即可：\nhttps://allenruan92.github.io/tax-law-chat/wechat.html\n入口无到期时间，无需令牌、体验码或登录。\n不需要重新启用开发者消息推送，以下回调配置仅作为可选兼容功能保留。' : '启用消息推送后，给公众号发送任意文字取得专属链接。入口有效期 24 小时。';
  fs.writeFileSync(path.join(out, '公众号消息推送配置.local.txt'), `钻木者得火 · 消息推送配置（私密，勿上传 GitHub 或转发）\n\n${guidance}\n\nAppID：wx6dde485592f7682e\nURL：${report.callback}\nToken：${secrets.WECHAT_TOKEN}\nEncodingAESKey：${secrets.WECHAT_AES_KEY}\n消息加解密方式：安全模式\n消息格式：XML\n\n本方案不需要 AppSecret，无需设置服务器 IP 白名单。\nAPI Key 仅存于云函数环境变量，不在网页中。\n此文件与 secrets.local.json 仅保存在本地 output/wechat，已被 Git 忽略。\n`);
  console.log(JSON.stringify(report));
}
main().catch(e => { console.error(JSON.stringify({ error: 'WeChat deployment failed; secret details withheld', code: typeof e.code === 'string' ? e.code : undefined, status: e.statusCode })); process.exitCode = 1; });
