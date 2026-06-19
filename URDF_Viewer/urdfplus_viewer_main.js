// /URDF_Viewer/urdfplus_viewer_main.js
// BUILD155_DIRECT_HTML_MECHANISM_BASE64_TEXTURES
// No usa iframe. Monta el HTML de referencia dentro del contenedor, ejecuta su
// mismo script interno como módulo directo y alimenta el modelo con File objects
// generados desde URDF_Zip/base64/assetDB. Esto conserva el armado del gripper
// que funciona en el HTML y corrige texturas locales por base64/dataURL.

export let Base64Images = [];

const BUILD = 'BUILD155_DIRECT_HTML_MECHANISM_BASE64_TEXTURES';
const STANDALONE_HTML = './URDFPlus_Viewer_Standalone_BUILD155.html';
const THREE_URL = 'https://unpkg.com/three@0.164.1/build/three.module.js';
const TRACKBALL_URL = 'https://unpkg.com/three@0.164.1/examples/jsm/controls/TrackballControls.js';
const COLLADA_URL = 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/ColladaLoader.js';
const STL_URL = 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/STLLoader.js';
const OBJ_URL = 'https://unpkg.com/three@0.164.1/examples/jsm/loaders/OBJLoader.js';
const JSZIP_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';

function debug(...args) {
  try {
    if (globalThis.AutoMindURDFPlusDebug || globalThis.AUTOMIND_DEBUG) console.log('[URDFPLUS_' + BUILD + ']', ...args);
  } catch (_) {}
}

function basename(path) {
  return String(path || 'asset.bin').replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'asset.bin';
}
function normalizePath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+/g, '/');
}
function ext(path) {
  const b = basename(path).toLowerCase();
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i + 1) : '';
}
function mimeFromName(name) {
  const e = ext(name);
  if (e === 'urdf' || e === 'xml') return 'application/xml';
  if (e === 'dae') return 'model/vnd.collada+xml';
  if (e === 'stl') return 'model/stl';
  if (e === 'obj' || e === 'mtl' || e === 'txt' || e === 'csv' || e === 'json' || e === 'usda') return 'text/plain';
  if (e === 'png') return 'image/png';
  if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
  if (e === 'webp') return 'image/webp';
  if (e === 'bmp') return 'image/bmp';
  if (e === 'gif') return 'image/gif';
  if (e === 'tga') return 'image/x-tga';
  if (e === 'zip') return 'application/zip';
  return 'application/octet-stream';
}
function stripDataPrefix(s) {
  return String(s || '').replace(/^data:[^,]*,/i, '');
}
function looksLikeRawText(name, value) {
  const e = ext(name);
  const s = String(value || '');
  if (/^(urdf|xml|dae|obj|mtl|txt|csv|json|usda)$/i.test(e)) {
    if (/^data:[^,]+,/i.test(s)) return false;
    if (/[<>{}\n\r]/.test(s.slice(0, 4096))) return true;
    if (/^\s*(solid\b|mtllib\b|o\s+|v\s+)/i.test(s.slice(0, 256))) return true;
  }
  return false;
}
function base64ToUint8Array(b64) {
  const clean = stripDataPrefix(b64).replace(/\s+/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function dataURLToBlob(dataURL, fallbackName) {
  const m = /^data:([^,]*),(.*)$/i.exec(String(dataURL || ''));
  if (!m) return new Blob([base64ToUint8Array(dataURL)], { type: mimeFromName(fallbackName) });
  const meta = m[1] || '';
  const payload = m[2] || '';
  const mime = (meta.split(';')[0] || mimeFromName(fallbackName)).trim();
  if (/;base64/i.test(meta)) return new Blob([base64ToUint8Array(payload)], { type: mime });
  return new Blob([decodeURIComponent(payload)], { type: mime });
}
function makeFile(path, value, explicitText = false) {
  const rel = normalizePath(path || 'asset.bin');
  const name = basename(rel);
  let blob;
  if (value instanceof File) {
    try { Object.defineProperty(value, 'relativePath', { value: rel, configurable: true }); } catch (_) { try { value.relativePath = rel; } catch (_) {} }
    try { Object.defineProperty(value, 'webkitRelativePath', { value: rel, configurable: true }); } catch (_) {}
    return value;
  }
  if (value instanceof Blob) blob = value;
  else if (/^data:[^,]+,/i.test(String(value || ''))) blob = dataURLToBlob(String(value), rel);
  else if (explicitText || looksLikeRawText(rel, value)) blob = new Blob([String(value || '')], { type: mimeFromName(rel) });
  else blob = new Blob([base64ToUint8Array(String(value || ''))], { type: mimeFromName(rel) });
  const f = new File([blob], name, { type: blob.type || mimeFromName(rel), lastModified: Date.now() });
  try { Object.defineProperty(f, 'relativePath', { value: rel, configurable: true }); } catch (_) { try { f.relativePath = rel; } catch (_) {} }
  try { Object.defineProperty(f, 'webkitRelativePath', { value: rel, configurable: true }); } catch (_) {}
  return f;
}
function pushAsset(files, path, value, explicitText = false) {
  if (!path || value == null || value === '') return;
  try { files.push(makeFile(path, value, explicitText)); }
  catch (err) { debug('asset skipped', path, err?.message || err); }
}
function collectFilesFromOptions(opts = {}) {
  const files = [];
  const zipValue = opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64 || opts.zipDataUrl || opts.zip || '';
  if (zipValue) pushAsset(files, opts.zipName || 'AutoMind_URDFPlus.zip', zipValue, false);

  const urdfText = String(opts.urdfContent || opts.urdfText || opts.robotXml || opts.xmlText || opts.urdf || '');
  if (urdfText) pushAsset(files, opts.urdfPath || opts.urdfFilename || opts.urdfName || 'URDF_Export/robot.urdf', urdfText, true);

  const dicts = [opts.assetDB, opts.meshDB, opts.textureDB, opts.assets, opts.filesDB, opts.fileDB];
  for (const db of dicts) {
    if (!db || typeof db !== 'object') continue;
    for (const [k, v] of Object.entries(db)) pushAsset(files, k, v, false);
  }

  const imageArrays = [opts.Base64Images, opts.base64Images, Base64Images].filter(Array.isArray);
  for (const arr of imageArrays) {
    for (const item of arr) {
      if (!item) continue;
      if (Array.isArray(item)) pushAsset(files, item[0] || item.name || 'image.png', item[1] || item.data || item.base64 || '', false);
      else if (typeof item === 'object') pushAsset(files, item.path || item.name || item.filename || item.fileName || 'image.png', item.dataURL || item.data || item.base64 || item.value || '', false);
    }
  }
  return files;
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (src === JSZIP_URL && globalThis.JSZip) return resolve(true);
    const existing = Array.from(document.scripts || []).find(s => s.src === src && s.dataset.automindLoaded === '1');
    if (existing) return resolve(true);
    const s = document.createElement('script');
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.onload = s.onerror = null;
      if (ok) { s.dataset.automindLoaded = '1'; resolve(true); }
      else { try { s.remove(); } catch (_) {} reject(err || new Error('Failed loading ' + src)); }
    };
    const timer = setTimeout(() => finish(false, new Error('Timeout loading ' + src)), 15000);
    s.src = src;
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onload = () => finish(true);
    s.onerror = () => finish(false, new Error('Failed loading ' + src));
    document.head.appendChild(s);
  });
}

function extractStandaloneParts(html) {
  const styleMatches = [...String(html).matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const bodyMatch = /<body[^>]*>([\s\S]*?)<script\s+type=["']module["'][^>]*>/i.exec(html);
  const scriptMatch = /<script\s+type=["']module["'][^>]*>([\s\S]*?)<\/script>\s*<\/body>/i.exec(html);
  if (!bodyMatch || !scriptMatch) throw new Error('Standalone HTML script/body not found');
  let css = styleMatches;
  // El HTML original está pensado para abrirse como página completa. En módulo
  // directo se monta dentro del contenedor, por eso el layout debe ser absolute.
  css = css.replace(/html,\s*body\s*\{[\s\S]*?\}/g, '');
  css = css.replace(/#app\s*\{\s*position:\s*fixed;/g, '#app { position: absolute;');
  css += `\n.automind-urdfplus-direct-root{position:relative;width:100%;height:100%;min-height:520px;overflow:hidden;background:#fff;}\n`;
  const body = bodyMatch[1];
  let script = scriptMatch[1];
  script = script
    .replace(/import\s+\*\s+as\s+THREE\s+from\s+['"]three['"]\s*;/, `import * as THREE from '${THREE_URL}';`)
    .replace(/import\s+\{\s*TrackballControls\s*\}\s+from\s+['"]three\/addons\/controls\/TrackballControls\.js['"]\s*;/, `import { TrackballControls } from '${TRACKBALL_URL}';`)
    .replace(/import\s+\{\s*ColladaLoader\s*\}\s+from\s+['"]three\/addons\/loaders\/ColladaLoader\.js['"]\s*;/, `import { ColladaLoader } from '${COLLADA_URL}';`)
    .replace(/import\s+\{\s*STLLoader\s*\}\s+from\s+['"]three\/addons\/loaders\/STLLoader\.js['"]\s*;/, `import { STLLoader } from '${STL_URL}';`)
    .replace(/import\s+\{\s*OBJLoader\s*\}\s+from\s+['"]three\/addons\/loaders\/OBJLoader\.js['"]\s*;/, `import { OBJLoader } from '${OBJ_URL}';`);
  script = script.replace(/renderLoop\(\);\s*$/m, `renderLoop();\n\n    try {\n      const key = globalThis.__AUTOMIND_URDFPLUS_DIRECT_MOUNT_KEY__;\n      if (key && typeof globalThis[key] === 'function') {\n        globalThis[key]({ handleFiles, state, els, scene, camera, renderer, controls, build: '${BUILD}' });\n      }\n    } catch (err) { console.error('[${BUILD}] mount callback failed', err); }\n`);
  return { css, body, script };
}

function createErrorBox(container, err) {
  try {
    const box = document.createElement('pre');
    box.textContent = 'AutoMind URDF+ ' + BUILD + ' error:\n' + (err?.stack || err?.message || String(err));
    Object.assign(box.style, {
      position: 'absolute', left: '12px', right: '12px', top: '12px', zIndex: 999999,
      color: '#7a1111', background: '#fff5f5', border: '1px solid #f3b3b3', borderRadius: '12px',
      padding: '12px', whiteSpace: 'pre-wrap', maxHeight: '45vh', overflow: 'auto',
      font: '12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
    });
    container?.appendChild?.(box);
  } catch (_) {}
}

export function render(opts = {}) {
  const container = opts.container;
  if (!container) throw new Error('[urdfplus_viewer_main] opts.container is required');
  container.innerHTML = '';
  container.classList?.add?.('automind-urdfplus-direct-root');
  try { container.style.position = container.style.position || 'relative'; } catch (_) {}
  try { container.style.overflow = 'hidden'; } catch (_) {}

  const mountKey = '__AUTOMIND_URDFPLUS_DIRECT_READY_' + Math.random().toString(36).slice(2);
  const ready = new Promise((resolve) => {
    globalThis.__AUTOMIND_URDFPLUS_DIRECT_MOUNT_KEY__ = mountKey;
    globalThis[mountKey] = resolve;
  });

  const api = {
    build: BUILD,
    ready,
    loadPromise: null,
    destroy() {
      try { delete globalThis[mountKey]; } catch (_) {}
      try { container.innerHTML = ''; } catch (_) {}
    }
  };

  api.loadPromise = (async () => {
    try {
      await loadScriptOnce(JSZIP_URL);
      const htmlURL = new URL(STANDALONE_HTML, import.meta.url);
      const html = await fetch(htmlURL, { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error('No pude cargar ' + htmlURL + ': HTTP ' + r.status);
        return r.text();
      });
      const { css, body, script } = extractStandaloneParts(html);
      const style = document.createElement('style');
      style.textContent = css;
      container.appendChild(style);
      const shell = document.createElement('div');
      shell.innerHTML = body;
      while (shell.firstChild) container.appendChild(shell.firstChild);

      const moduleScript = document.createElement('script');
      moduleScript.type = 'module';
      moduleScript.textContent = script;
      document.body.appendChild(moduleScript);

      const standalone = await ready;
      api.standalone = standalone;
      const files = collectFilesFromOptions(opts);
      debug('feeding files', files.map(f => ({ name: f.name, rel: f.relativePath || f.webkitRelativePath || f.name, type: f.type, size: f.size })));
      if (files.length) await standalone.handleFiles(files);
      return standalone;
    } catch (err) {
      createErrorBox(container, err);
      throw err;
    } finally {
      try { delete globalThis.__AUTOMIND_URDFPLUS_DIRECT_MOUNT_KEY__; } catch (_) {}
    }
  })();

  return api;
}

export default { render };
