// Check staged bytes without ever printing credentials or matching content.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const config = JSON.parse(fs.readFileSync(new URL('../output/wechat/secrets.local.json', import.meta.url), 'utf8'));
const profile = JSON.parse(fs.readFileSync(path.join(process.env.USERPROFILE, '.aliyun/config.json'), 'utf8')).profiles.find(p => p.name === 'tax-fc-ak');
const secrets = [...Object.values(config), process.env.DASHSCOPE_API_KEY, profile?.access_key_id, profile?.access_key_secret].filter(v => typeof v === 'string' && v.length > 8);
if (secrets.length !== 6) throw new Error('Expected local secret sources missing');
const names = execFileSync('git', ['diff', '--cached', '--name-only', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const bad = [];
for (const name of names) {
  const content = execFileSync('git', ['show', ':' + name]);
  if (secrets.some(s => content.includes(Buffer.from(s))) || /(?:^|\/)(?:output|node_modules|\.env)(?:\/|$)|\.local\./.test(name)) bad.push(name);
}
console.log(JSON.stringify({ stagedFiles: names.length, secretsChecked: secrets.length, matchingFiles: bad }));
if (bad.length) process.exitCode = 1;
