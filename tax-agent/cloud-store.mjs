import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OSS from 'ali-oss';
import { OssStore } from './oss-store.mjs';

export const CLOUD_BUCKET = 'tax-law-agent-1555315958533569-cn-beijing';

export function createCloudStore(profileName = 'tax-fc-ak') {
  const file = path.join(os.homedir(), '.aliyun', 'config.json');
  let config;
  try { config = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('无法读取本机阿里云 CLI 配置；请先配置受限 RAM 身份'); }
  const profile = config.profiles?.find(item => item.name === profileName);
  if (profile?.mode !== 'AK' || !profile.access_key_id || !profile.access_key_secret) throw new Error('指定的阿里云 CLI 配置不是可用的 AK 身份');
  const client = new OSS({ region: 'oss-cn-beijing', bucket: CLOUD_BUCKET, accessKeyId: profile.access_key_id, accessKeySecret: profile.access_key_secret, secure: true, timeout: 30_000 });
  return new OssStore(client);
}
