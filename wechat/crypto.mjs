import { createHash, createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const signature = (...parts) => createHash('sha1').update(parts.map(String).sort().join('')).digest('hex');
export const cdata = text => '<![CDATA[' + String(text).replaceAll(']]>', ']]]]><![CDATA[>') + ']]>';
export function verifySignature(actual, ...parts) {
  if (!equal(actual, signature(...parts))) throw new Error('Invalid signature');
}
export function parseXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 65536 || /<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw new Error('Invalid XML');
  const data = new XMLParser({ parseTagValue: false, trimValues: false, ignoreAttributes: false, processEntities: true }).parse(xml);
  if (!data.xml || typeof data.xml !== 'object' || Array.isArray(data.xml)) throw new Error('Invalid root');
  // Callbacks are flat; duplicate fields or nested/attributed values are rejected.
  for (const value of Object.values(data.xml)) if (typeof value !== 'string') throw new Error('Invalid field');
  return data.xml;
}
function aesKey(value) {
  if (!/^[A-Za-z0-9+/]{43}$/.test(value || '')) throw new Error('Invalid AES key');
  return Buffer.from(value + '=', 'base64');
}
export function encrypt(xml, encodingKey, appId, random = randomBytes(16)) {
  const key = aesKey(encodingKey), message = Buffer.from(xml), size = Buffer.alloc(4);
  size.writeUInt32BE(message.length);
  const raw = Buffer.concat([random, size, message, Buffer.from(appId)]), padding = 32 - raw.length % 32;
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16)); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(Buffer.concat([raw, Buffer.alloc(padding, padding)])), cipher.final()]).toString('base64');
}
export function decrypt(encrypted, encodingKey, appId) {
  if (typeof encrypted !== 'string' || encrypted.length > 90000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted)) throw new Error('Invalid ciphertext');
  const key = aesKey(encodingKey), decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16)); decipher.setAutoPadding(false);
  const raw = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const pad = raw.at(-1);
  if (!pad || pad > 32 || raw.length < 32 || !raw.subarray(-pad).every(v => v === pad)) throw new Error('Invalid padding');
  const end = raw.length - pad, length = raw.readUInt32BE(16);
  if (20 + length > end || !equal(raw.subarray(20 + length, end).toString(), appId)) throw new Error('Invalid recipient');
  return raw.subarray(20, 20 + length).toString('utf8');
}
export function mintAccess(openId, secret, appId, now = Date.now()) {
  const subject = createHmac('sha256', secret).update('subject:' + openId).digest('hex').slice(0, 32);
  const payload = Buffer.from(JSON.stringify({ v: 1, sub: subject, aud: appId, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 86400 })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function verifyAccess(token, secret, appId, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 1024 || !/^[\w-]+\.[\w-]+$/.test(token)) throw new Error('Invalid access');
  const [payload, mac] = token.split('.');
  if (!equal(mac, createHmac('sha256', secret).update(payload).digest('base64url'))) throw new Error('Invalid access');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (data.v !== 1 || data.aud !== appId || !/^[a-f0-9]{32}$/.test(data.sub) || !Number.isSafeInteger(data.iat) || !Number.isSafeInteger(data.exp) || data.iat > now / 1000 + 60 || data.exp <= now / 1000 || data.exp - data.iat !== 86400) throw new Error('Expired access');
  return data;
}
