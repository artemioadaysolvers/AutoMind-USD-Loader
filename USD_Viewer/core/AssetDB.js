// /USD_Viewer/core/AssetDB.js
// Aggressive normalized asset database for USD+ textures.

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml',
  usda: 'text/plain', usd: 'text/plain'
};

function cleanRaw(s) {
  let t = String(s || '').trim();
  if ((t.startsWith('@') && t.endsWith('@')) || (t.startsWith('"') && t.endsWith('"'))) t = t.slice(1, -1);
  try { t = decodeURIComponent(t); } catch (_) {}
  t = t.replace(/\\/g, '/').replace(/^file:\/\//i, '').replace(/^\.+\//, '').replace(/^\/+/,'');
  t = t.replace(/^package:\/\//i, '');
  return t;
}
export function normKey(s) { return cleanRaw(s).toLowerCase(); }
export function basenameNoQuery(p) { const q = cleanRaw(p).split('?')[0].split('#')[0]; return q.split('/').pop() || ''; }
export function extOf(p) { const q = basenameNoQuery(p); const i = q.lastIndexOf('.'); return i >= 0 ? q.slice(i + 1).toLowerCase() : ''; }
export function dropPackagePrefix(k) { return normKey(k).replace(/^package:\/\//i, ''); }

export function variantsFor(path) {
  const out = new Set();
  const raw0 = cleanRaw(path);
  if (!raw0) return [];
  const raws = [raw0, raw0.replace(/^\.\//,''), raw0.replace(/^\.\.\//,'')];
  for (const raw of raws) {
    const p = normKey(raw);
    const noPkg = p.replace(/^package:\/\//i, '');
    const base = basenameNoQuery(noPkg).toLowerCase();
    out.add(p); out.add(noPkg); out.add(base);
    const parts = noPkg.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(i).join('/'));
    for (let i = 0; i < parts.length; i++) out.add(parts.slice(i).join('/'));
    if (base) {
      out.add(base.replace(/%20/g, ' '));
      out.add(base.replace(/\s+/g, '_'));
      out.add(base.replace(/_/g, ' '));
    }
  }
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
  const originalKeys = new Map();
  Object.entries(assetDB || {}).forEach(([rawKey, rawVal]) => {
    if (!rawVal) return;
    const data = dataURLFor(rawKey, rawVal);
    for (const k of variantsFor(rawKey)) {
      if (!byKey[k]) byKey[k] = data;
      if (!originalKeys.has(k)) originalKeys.set(k, rawKey);
      const b = basenameNoQuery(k).toLowerCase();
      if (b) {
        const arr = byBase.get(b) || [];
        arr.push(k);
        byBase.set(b, Array.from(new Set(arr)));
      }
    }
  });
  return {
    byKey, byBase, originalKeys,
    has(path) { return !!this.get(path); },
    get(path) {
      for (const k of variantsFor(path)) if (byKey[k]) return byKey[k];
      const base = basenameNoQuery(path).toLowerCase();
      const arr = byBase.get(base) || [];
      for (const k of arr) if (byKey[k]) return byKey[k];
      // Last-resort fuzzy basename for exports with renamed texture paths.
      if (base) {
        const baseNoExt = base.replace(/\.[^.]+$/, '');
        for (const [b, arr2] of byBase.entries()) {
          const bNoExt = b.replace(/\.[^.]+$/, '');
          if (b === base || bNoExt === baseNoExt || b.includes(baseNoExt) || baseNoExt.includes(bNoExt)) {
            for (const k of arr2) if (byKey[k]) return byKey[k];
          }
        }
      }
      return undefined;
    },
    keys() { return Object.keys(byKey); }
  };
}
export default { buildAssetDB, normKey, variantsFor, dataURLFor, extOf, basenameNoQuery };
