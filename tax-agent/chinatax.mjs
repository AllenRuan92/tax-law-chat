import { createHash } from 'node:crypto';

export const BASE = 'https://fgk.chinatax.gov.cn';
const LIST_API = 'https://www.chinatax.gov.cn/getFileListByCodeId';
const SEARCH_API = 'https://www.chinatax.gov.cn/search5/search/s';
export const CATEGORIES = [
  { id: 'c102416', name: '财税文件' },
  { id: 'c100012', name: '税务规范性文件' },
  { id: 'c100011', name: '税务部门规章' },
  { id: 'c100015', name: '政策解读', kind: 'interpretation' },
];
const TAX_RE = /税|所得|增值|印花|优惠|征管|扣缴|递延/;
const EQUITY_RE = /股权|股份|创投|创业投资|私募|基金|合伙|投资|转让|减资|并购|重组|限售|股息|股利|红利|清算|出资|业绩报酬|资本利得/;
const ALERT_RE = /失效|废止|修订|修正|修改|延续|延期|到期|继续实施/;
const WORD_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
const VERSION_FIELDS = ['title', 'url', 'kind', 'docNumber', 'issuedDate', 'publisher', 'sourceLabels', 'sourceTaxPolicy', 'sourceEffectLevel', 'sourceAging'];

export function articleDigest(text, source) {
  const metadata = Object.fromEntries(VERSION_FIELDS.map(field => [field, source[field] || '']));
  return createHash('sha256').update(text).update('\nmetadata\n').update(JSON.stringify(metadata));
}

export function decodeHtml(value) {
  return String(value).replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z]+);/gi, (full, code) => {
    if (code.startsWith('#')) {
      const n = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : full;
    }
    return WORD_ENTITIES[code.toLowerCase()] ?? full;
  });
}

export function textFromHtml(fragment) {
  return decodeHtml(String(fragment)
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>|<\/(?:p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim());
}

export function sourceUrl(raw) {
  const url = new URL(String(raw));
  if (!['www.chinatax.gov.cn', 'fgk.chinatax.gov.cn'].includes(url.hostname) ||
      !['http:', 'https:'].includes(url.protocol) ||
      !/^\/zcfgk\/[a-z0-9/_.-]+$/i.test(url.pathname) || url.username || url.password || url.port) {
    throw new Error('官方来源地址不在允许范围');
  }
  return BASE + url.pathname;
}

export function relevance({ title = '', metadata = {} }) {
  const subject = `${title} ${metadata.labels || ''} ${metadata.taxpolicy || ''}`;
  if (/外籍个人.*股息红利|股息红利.*外籍个人/.test(title)) return { level: 'skip', reason: '首期暂不纳入外籍个人股息红利规则' };
  if (EQUITY_RE.test(subject) && TAX_RE.test(subject)) return { level: 'high', reason: '股权投资事项与税务主题同时命中' };
  if (ALERT_RE.test(title) && /目录/.test(title) && /税务规范性文件|税务部门规章/.test(title)) return { level: 'review', reason: '废止或修订目录，需核查是否影响基金相关规则' };
  if (EQUITY_RE.test(title)) return { level: 'review', reason: '股权投资事项，需判断税务关联' };
  return { level: 'skip', reason: '第一期业务主题未命中' };
}

function metadataOf(row) {
  const out = {};
  for (const group of row.domainMetaList || []) for (const item of group.resultList || []) {
    if (typeof item.key === 'string' && typeof item.value === 'string' && item.value.trim()) out[item.key] = item.value.trim();
  }
  return out;
}

export function normalizeCandidate(row, category) {
  const title = textFromHtml(row.titleHtml || row.title || '');
  const url = sourceUrl(row.url);
  const metadata = metadataOf(row);
  const pathId = /\/c(\d+)\/content\.html$/.exec(new URL(url).pathname)?.[1];
  if (!title || !pathId) throw new Error('来源列表缺少标题或文件身份');
  return {
    id: `chinatax-${pathId}`, title, url, category: category.name,
    kind: category.kind || 'policy', docNumber: metadata.writtentext || '',
    issuedDate: metadata.writtendate || '', publisher: metadata.writtendepartments || metadata.writtendepartment || '',
    sourceLabels: metadata.labels || '', sourceTaxPolicy: metadata.taxpolicy || '',
    sourceEffectLevel: metadata.effectlevel || '', sourceAging: metadata.aging || '',
    relevance: relevance({ title, metadata }),
  };
}

export function normalizeInterpretation(row, category) {
  if (row.siteCode !== 'bm29000002' || !String(row.xxgk_resolveType || '').includes('文字')) throw new Error('政策解读来源类型异常');
  const title = textFromHtml(row.title || '');
  const url = sourceUrl(row.url);
  const pathId = /\/c(\d+)\/content\.html$/.exec(new URL(url).pathname)?.[1];
  if (!title || !pathId) throw new Error('政策解读缺少标题或文件身份');
  const labels = String(row.xxgk_labels || '');
  return {
    id: `chinatax-${pathId}`, title, url, category: category.name, kind: 'interpretation',
    docNumber: '', issuedDate: String(row.cwrq || row.pubDate || '').slice(0, 10),
    publisher: String(row.pubName || ''), sourceLabels: labels, sourceTaxPolicy: String(row.xxgk_taxPolicy || ''),
    sourceEffectLevel: '政策解读（非规范性文件）', sourceAging: '',
    relevance: relevance({ title, metadata: { labels, taxpolicy: row.xxgk_taxPolicy || '' } }),
  };
}

export async function readLimited(url, { fetcher = fetch, method = 'GET', body, headers = {}, limit = 2_000_000 } = {}) {
  const res = await fetcher(url, { method, body, headers: { 'User-Agent': 'TaxLawKnowledgeMonitor/0.1 (+manual-review)', ...headers }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}：${new URL(url).hostname}`);
  if (Number(res.headers.get('content-length')) > limit) throw new Error('来源正文超过读取上限');
  const content = await res.text();
  if (Buffer.byteLength(content) > limit) throw new Error('来源正文超过读取上限');
  return content;
}

export async function readAttachment(url, { fetcher = fetch, limit = 10_000_000 } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['fgk.chinatax.gov.cn', 'www.chinatax.gov.cn'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.port || !/^\/zcfgk\/[a-z0-9/_.%~-]+$/i.test(parsed.pathname)) throw new Error('附件来源地址不在允许范围');
  const res = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(30_000), headers: { 'User-Agent': 'TaxLawKnowledgeMonitor/0.1 (+manual-review)' } });
  if (!res.ok) throw new Error(`附件 HTTP ${res.status}`);
  if (Number(res.headers.get('content-length')) > limit) throw new Error('附件超过读取上限');
  const bytes = Buffer.from(await res.arrayBuffer());
  if (!bytes.length || bytes.length > limit) throw new Error('附件为空或超过读取上限');
  return bytes;
}

export async function listCategory(category, { fetcher = fetch, pages = 2, pageSize = 10 } = {}) {
  if (!CATEGORIES.some(x => x.id === category.id)) throw new Error('未知来源栏目');
  if (!Number.isInteger(pages) || pages < 1 || pages > 5 || pageSize !== 10) throw new Error('来源页数超出限制');
  const pageUrl = `${BASE}/zcfgk/${category.id}/${category.kind === 'interpretation' ? 'list_zcjd.html' : category.id === 'c100011' ? 'list_guizhang.html' : 'listflfg.html'}`;
  const html = await readLimited(pageUrl, { fetcher });
  if (category.kind === 'interpretation') {
    if (!/<meta\s+name="SiteIDCode"\s+content="bm29000002"\s*\/?\s*>/i.test(html)) throw new Error(`${category.name}：页面身份变化，已停止采集`);
    const results = [];
    for (let page = 0; page < pages; page++) {
      const query = new URLSearchParams({ siteCode: 'bm29000002', searchWord: '', type: '1', xxgkResolveType: '文字', pageNum: String(page), pageSize: String(pageSize), cwrqStart: '', cwrqEnd: '', column: '政策解读', likeDoc: '0', wordPlace: '0', videoreSolveType: '' });
      const data = JSON.parse(await readLimited(`${SEARCH_API}?${query}`, { fetcher }));
      const result = data.searchResultAll;
      if (!Array.isArray(result?.searchTotal) || !Number.isFinite(Number(result.total))) throw new Error(`${category.name}：搜索接口格式变化，已停止采集`);
      results.push(...result.searchTotal.map(row => normalizeInterpretation(row, category)));
      if (result.searchTotal.length < pageSize) break;
    }
    return results;
  }
  const channelId = /var\s+channelId\s*=\s*["']([a-f0-9]{32})["']/.exec(html)?.[1] || /<meta\s+name=["']channelId["']\s+content=["']([a-f0-9]{32})["']/i.exec(html)?.[1];
  if (!channelId) throw new Error(`${category.name}：页面缺少栏目 ID，已停止采集`);
  const results = [];
  for (let page = 1; page <= pages; page++) {
    const data = JSON.parse(await readLimited(LIST_API, {
      fetcher, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body: new URLSearchParams({ codeId: '', channelId, page: String(page), size: String(pageSize) }),
    }));
    const payload = data.results?.data;
    if (data.code !== 200 || !Array.isArray(payload?.results)) throw new Error(`${category.name}：栏目接口格式变化，已停止采集`);
    results.push(...payload.results.map(row => normalizeCandidate(row, category)));
    if (payload.results.length < pageSize) break;
  }
  return results;
}

function bodyForClass(html, className) {
  const start = new RegExp(`<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`, 'i').exec(html);
  if (!start) throw new Error(`原文页面缺少 ${className} 容器`);
  const from = start.index + start[0].length;
  let depth = 1, match;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = from;
  while ((match = tags.exec(html))) {
    depth += /^<\/div/i.test(match[0]) ? -1 : 1;
    if (depth === 0) return html.slice(from, match.index);
  }
  throw new Error('原文正文容器未闭合');
}

export function articleBody(html) { return bodyForClass(html, 'article'); }

export function parseArticle(html, candidate) {
  const article = articleBody(html);
  const fragment = bodyForClass(article, 'arc_cont');
  const text = textFromHtml(fragment);
  if (text.length < 80 || text.length > 100_000) throw new Error('原文过短或过长，需人工核验');
  const attachments = [];
  for (const link of fragment.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label = textFromHtml(link[2]);
    let url;
    try { url = new URL(decodeHtml(link[1]), candidate.url); } catch { continue; }
    if (url.protocol === 'https:' && ['fgk.chinatax.gov.cn', 'www.chinatax.gov.cn'].includes(url.hostname) && /\.(pdf|docx?|xlsx?|zip)$/i.test(url.pathname)) attachments.push({ label, url: url.href });
  }
  return { text, attachments, articleHash: articleDigest(text, candidate).digest('hex'), originalHtml: html };
}

export async function fetchArticle(candidate, { fetcher = fetch } = {}) {
  const html = await readLimited(candidate.url, { fetcher });
  const article = parseArticle(html, candidate);
  if (article.attachments.length > 10) throw new Error('附件数量超过上限，需人工核查');
  const hash = articleDigest(article.text, candidate);
  let totalBytes = 0;
  for (const attachment of article.attachments) {
    attachment.bytes = await readAttachment(attachment.url, { fetcher });
    totalBytes += attachment.bytes.length;
    if (totalBytes > 20_000_000) throw new Error('附件合计超过上限，需人工核查');
    attachment.sha256 = createHash('sha256').update(attachment.bytes).digest('hex');
    hash.update('\nattachment\n').update(attachment.url).update('\n').update(attachment.sha256);
  }
  article.articleHash = hash.digest('hex');
  return article;
}

function changeEvidence(candidate, article, previousArticle) {
  if (!previousArticle) return '首次发现，无同页历史版本可比。';
  const oldSource = previousArticle.metadata?.record?.source || {};
  const labels = { title: '标题', url: '来源链接', kind: '资料类型', docNumber: '文号', issuedDate: '成文日期', publisher: '发文单位', sourceLabels: '来源标签', sourceTaxPolicy: '来源税收政策标签', sourceAging: '来源效力标注', sourceEffectLevel: '来源效力层级' };
  const lines = [];
  for (const [field, label] of Object.entries(labels)) {
    if ((oldSource[field] || '') !== (candidate[field] || '')) lines.push(`- ${label}：${oldSource[field] || '未提供'} → ${candidate[field] || '未提供'}`);
  }
  const oldLines = String(previousArticle.text || '').split('\n').map(x => x.trim()).filter(Boolean);
  const newLines = String(article.text || '').split('\n').map(x => x.trim()).filter(Boolean);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  if (start === oldLines.length && start === newLines.length) lines.push('- 正文：提取文本无差异。');
  else {
    let oldEnd = oldLines.length, newEnd = newLines.length;
    while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) { oldEnd--; newEnd--; }
    const excerpt = rows => rows.slice(0, 3).join(' ').slice(0, 600) || '（无）';
    lines.push(`- 正文：首处差异从第 ${start + 1} 段开始；旧段落 ${oldEnd - start} 个，新段落 ${newEnd - start} 个。以下仅为摘录，须核对完整原文。`,
      `  - 旧：${excerpt(oldLines.slice(start, oldEnd))}`, `  - 新：${excerpt(newLines.slice(start, newEnd))}`);
  }
  const oldAttachments = new Map((previousArticle.metadata?.attachments || []).map(x => [x.url, x.sha256]));
  const newAttachments = new Map(article.attachments.map(x => [x.url, x.sha256]));
  const added = [...newAttachments.keys()].filter(url => !oldAttachments.has(url)).length;
  const removed = [...oldAttachments.keys()].filter(url => !newAttachments.has(url)).length;
  const modified = [...newAttachments].filter(([url, hash]) => oldAttachments.has(url) && oldAttachments.get(url) !== hash).length;
  lines.push(`- 附件：新增 ${added}、移除 ${removed}、同链接内容变化 ${modified}。`);
  return lines.join('\n');
}

export function makeReviewCard(candidate, article, { observedAt = new Date().toISOString(), previousHash = '', changeOrigin = 'first_seen', previousArticle = null } = {}) {
  const body = article.text;
  const preview = body.slice(0, 3500) + (body.length > 3500 ? '\n\n[正文较长，请阅读同目录原文文件]' : '');
  return `# 待审核：${candidate.title}\n\n` +
    `- 官方来源：${candidate.url}\n- 来源栏目：${candidate.category}\n- 发文单位：${candidate.publisher || '未核实'}\n` +
    `- 文号：${candidate.docNumber || '未核实'}\n- 成文日期：${candidate.issuedDate || '未核实'}\n` +
    `- 来源效力标注：${candidate.sourceAging || '未提供'}（未经独立核验）\n- 效力状态：未核实（不得直接按现行规则发布）\n- 业务相关性：${candidate.relevance.reason}\n` +
    `- 本次发现：${observedAt}\n- 内容 SHA-256：${article.articleHash}\n` +
    `- 先前版本 SHA-256：${previousHash || '无'}\n- 版本来源：${changeOrigin === 'extractor_upgrade' ? '提取器升级；不能据此认定税法发生变化' : changeOrigin === 'source_change_candidate' ? '网页或附件内容差异；待人工判断是否属规则变化' : '首次发现'}\n- 附件数量：${article.attachments.length}\n\n` +
    `## 版本对照（自动提取，仅作审核线索）\n\n${changeEvidence(candidate, article, previousArticle)}\n\n` +
    `## 原文摘录（自动提取，未经核验）\n\n${preview}\n\n` +
    `## 审核要点\n\n- [ ] 核对原文、附件、施行日期与适用期间\n- [ ] 核对修订、失效或延期关系\n- [ ] 确定与一级市场投资的关联及适用主体\n- [ ] 明确可进入正式知识库的内容\n`;
}
