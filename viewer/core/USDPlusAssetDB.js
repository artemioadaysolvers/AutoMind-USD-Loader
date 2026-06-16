// /viewer/core/USDPlusAssetDB.js
// Normalizes texture/assets for the USD+ iframe runtime.

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

export function normKey(s) {
  return String(s || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function basenameNoQuery(p) {
  return String(p || '').split('?')[0].split('#')[0].split('/').pop();
}

export function extOf(p) {
  const q = String(p || '').split('?')[0].split('#')[0];
  const i = q.lastIndexOf('.');
  return i >= 0 ? q.slice(i + 1).toLowerCase() : '';
}

export function dataURLFor(key, b64OrUrl) {
  const v = String(b64OrUrl || '');
  if (!v) return '';
  if (/^data:/i.test(v) || /^blob:/i.test(v) || /^https?:\/\//i.test(v)) return v;
  const mime = MIME[extOf(key)] || 'application/octet-stream';
  return `data:${mime};base64,${v}`;
}

export function variantsFor(path) {
  const out = new Set();
  const p = normKey(path);
  const noPkg = p.startsWith('package://') ? p.slice('package://'.length) : p;
  const base = basenameNoQuery(noPkg);
  out.add(p);
  out.add(noPkg);
  out.add(base);
  const parts = noPkg.split('/');
  for (let i = 1; i < parts.length; i++) out.add(parts.slice(i).join('/'));
  return Array.from(out).filter(Boolean);
}

export function buildUSDPlusAssetDataURLs(assetDB = {}) {
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(assetDB || {})) {
    if (!rawVal) continue;
    const dataUrl = dataURLFor(rawKey, rawVal);
    for (const k of variantsFor(rawKey)) {
      if (!out[k]) out[k] = dataUrl;
    }
  }
  return out;
}

export default { buildUSDPlusAssetDataURLs, dataURLFor, variantsFor, normKey };
