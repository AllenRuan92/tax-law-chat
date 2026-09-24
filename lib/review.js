import { REVIEW_API_URL } from './config.js?v=20260924-review';

export function createReviewClient(key, fetcher = globalThis.fetch, endpoint = REVIEW_API_URL) {
  if (!key) throw new Error('请先填写百炼 API Key。');
  if (!endpoint) throw new Error('待审核服务尚未部署。');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') throw new Error('待审核服务地址必须使用 HTTPS。');
  async function request(operation, fields = {}) {
    let response;
    try {
      response = await fetcher(url, {
        method: 'POST', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation, ...fields }),
      });
    } catch { throw new Error('无法连接待审核服务，请稍后重试。'); }
    let data;
    try { data = await response.json(); }
    catch { throw new Error(`待审核服务返回无效内容（HTTP ${response.status}）。`); }
    if (!response.ok || data.success !== true) {
      const message = typeof data.message === 'string' && data.message.length < 300 ? data.message : `待审核服务请求失败（HTTP ${response.status}）。`;
      const error = new Error(message); error.status = response.status; throw error;
    }
    return data.data;
  }
  return { request };
}
