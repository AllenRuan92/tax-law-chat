// Local history selection only. A legacy token is never used as authentication.
export const HISTORY_PREFERENCE = 'tax-law-wechat.history-namespace';
const validNamespace = value => typeof value === 'string' && /^tax-law-wechat\.(?:guest|[a-f0-9]{32})$/.test(value);
export function legacyHistoryNamespace(token) {
  try {
    if (typeof token !== 'string' || token.length > 1024 || !/^[\w-]+\.[\w-]+$/.test(token)) return null;
    const value = JSON.parse(atob(token.split('.')[0].replaceAll('-', '+').replaceAll('_', '/')));
    if (value.aud !== 'wx6dde485592f7682e' || !/^[a-f0-9]{32}$/.test(value.sub)) return null;
    return 'tax-law-wechat.' + value.sub;
  } catch { return null; }
}
export function chooseHistoryNamespace({ saved, legacy, databases = [] } = {}) {
  if (validNamespace(saved)) return saved;
  const previous = legacyHistoryNamespace(legacy);
  if (previous) return previous;
  // Continue a unique previous visitor partition after closing an old tab.
  // Never merge other users' partitions or touch the administration database.
  const older = [...new Set(databases.map(db => db.name?.replace(/\.history\.v2$/, '')).filter(name => validNamespace(name) && name !== 'tax-law-wechat.guest'))];
  return older.length === 1 ? older[0] : 'tax-law-wechat.guest';
}
