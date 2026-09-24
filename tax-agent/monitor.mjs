import { CATEGORIES, listCategory, fetchArticle, makeReviewCard, relevance } from './chinatax.mjs';

export const EXTRACTOR_VERSION = 4;

export async function collect({ store, fetcher = fetch, pages = 2, maxArticles = 20, categories = CATEGORIES, now = () => new Date(), logger = () => {} } = {}) {
  if (!store) throw new Error('缺少资料台账');
  if (!Number.isInteger(maxArticles) || maxArticles < 1 || maxArticles > 50) throw new Error('正文数量超出限制');
  const run = { startedAt: now().toISOString(), sourceResults: [], candidates: 0, newVersions: 0, technicalRevisions: 0, unchanged: 0, deferredOutOfScope: 0, errors: [] };
  const seen = new Set();
  for (const category of categories) {
    let rows;
    try { rows = await listCategory(category, { fetcher, pages }); }
    catch (error) { run.sourceResults.push({ source: category.name, status: 'failed', error: error.message }); run.errors.push(`${category.name}：${error.message}`); continue; }
    run.sourceResults.push({ source: category.name, status: 'checked', count: rows.length });
    for (const item of rows) {
      if (item.relevance.level === 'skip' || seen.has(item.id)) continue;
      seen.add(item.id);
      run.candidates++;
      if (run.candidates > maxArticles) { run.errors.push('达到单次正文上限，余下候选尚未检查'); break; }
      try {
        const previous = await store.load(item.id);
        const article = await fetchArticle(item, { fetcher });
        const stamp = now().toISOString();
        if (previous?.currentHash === article.articleHash) {
          previous.lastSeen = stamp;
          const current = previous.versions.find(v => v.hash === previous.currentHash);
          if (current) current.extractorVersion = EXTRACTOR_VERSION;
          await store.save(previous);
          run.unchanged++;
          continue;
        }
        const priorVersion = previous?.versions.find(v => v.hash === previous.currentHash);
        const changeOrigin = previous && priorVersion?.extractorVersion !== EXTRACTOR_VERSION ? 'extractor_upgrade' : previous ? 'source_change_candidate' : 'first_seen';
        const revision = { hash: article.articleHash, discoveredAt: stamp, status: 'pending_review', priorHash: previous?.currentHash || '', extractorVersion: EXTRACTOR_VERSION, changeOrigin };
        const record = {
          id: item.id, source: item, currentHash: article.articleHash, firstSeen: previous?.firstSeen || stamp,
          lastSeen: stamp, versions: [...(previous?.versions || []), revision],
        };
        const previousArticle = previous ? {
          text: await store.readVersion(item.id, revision.priorHash, 'source.txt'),
          metadata: JSON.parse(await store.readVersion(item.id, revision.priorHash, 'metadata.json')),
        } : null;
        const card = makeReviewCard(item, article, { observedAt: stamp, previousHash: revision.priorHash, changeOrigin, previousArticle });
        await store.saveVersion(record, article, card);
        await store.save(record);
        run.newVersions++;
        if (changeOrigin === 'extractor_upgrade') run.technicalRevisions++;
        logger(`${item.id}：新增待审核版本`);
      } catch (error) { run.errors.push(`${item.id}：${error.message}`); }
    }
    if (run.candidates > maxArticles) break;
  }
  for (const record of await store.list()) {
    const current = record.versions.find(v => v.hash === record.currentHash);
    if (current?.status !== 'pending_review') continue;
    const fresh = relevance({ title: record.source.title, metadata: { labels: record.source.sourceLabels, taxpolicy: record.source.sourceTaxPolicy } });
    if (fresh.level !== 'skip') continue;
    current.status = 'deferred_out_of_scope';
    current.decision = { reason: fresh.reason, decidedAt: now().toISOString(), basis: 'first_phase_screening' };
    await store.save(record);
    run.deferredOutOfScope++;
  }
  run.finishedAt = now().toISOString();
  run.status = run.errors.length ? 'incomplete' : 'complete';
  return run;
}
