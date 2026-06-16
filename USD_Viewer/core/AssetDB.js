// /USD_Viewer/core/AssetDB.js
// Asset database for USD+ viewer. Normalized keys + base64/dataURL lookup.

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  usda: 'text/plain',
  usd: 'text/plain'
};

export function normKey(s) {
  return String(s || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
}

export function basenameNoQuery(p) {
  const q = String(p || '').split('?')[0].split('#')[0];
  return q.split('/').pop();
}

export function extOf(p) {
  const q = String(p || '').split('?')[0].split('#')[0];
  const i = q.lastIndexOf('.');
  return i >= 0 ? q.slice(i + 1).toLowerCase() : '';
}

export function dropPackagePrefix(k) {
  const s = normKey(k);
  return s.startsWith('package://') ? s.slice('package://'.length) : s;
}

export function variantsFor(path) {
  const out = new Set();
  const raw = String(path || '').trim();
  if (!raw) return [];
  const p = normKey(raw);
  const noPkg = dropPackagePrefix(p);
  const base = basenameNoQuery(noPkg);
  out.add(p);
  out.add(noPkg);
  out.add(base);
  out.add(base?.replace(/^\.\//, ''));
  const parts = noPkg.split('/').filter(Boolean);
  for (let i = 1; i < parts.length; i++) out.add(parts.slice(i).join('/'));
  return Array.from(out).filter(Boolean);
}

export function dataURLFor(key, val) {
  const v = String(val || '');
  if (!v) return '';
  if (/^(data:|blob:|https?:\/\/)/i.test(v)) return v;
  const mime = MIME[extOf(key)] || 'application/octet-stream';
  return `data:${mime};base64,${v}`;
}

export function buildAssetDB(assetDB = {}) {
  const byKey = {};
  const byBase = new Map();

  Object.entries(assetDB || {}).forEach(([rawKey, rawVal]) => {
    if (!rawVal) return;
    const data = dataURLFor(rawKey, rawVal);
    for (const k of variantsFor(rawKey)) {
      if (!byKey[k]) byKey[k] = data;
      const b = basenameNoQuery(k);
      if (b) {
        const arr = byBase.get(b) || [];
        arr.push(k);
        byBase.set(b, Array.from(new Set(arr)));
      }
    }
  });

  return {
    byKey,
    byBase,
    has(path) { return !!this.get(path); },
    get(path) {
      for (const k of variantsFor(path)) {
        if (byKey[k]) return byKey[k];
      }
      const base = basenameNoQuery(normKey(path));
      const arr = byBase.get(base) || [];
      for (const k of arr) if (byKey[k]) return byKey[k];
      return undefined;
    },
    keys() { return Object.keys(byKey); }
  };
}

export default { buildAssetDB, normKey, variantsFor, dataURLFor, extOf, basenameNoQuery };
