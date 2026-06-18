// /URDF_Viewer/urdfplus_viewer_main.js
// AutoMind URDF+ modular adapter.
// It keeps the updated ZIP/package entrypoint style used by the USD viewer, but
// renders the URDF+ standalone viewer inside the supplied container and can inject
// URDF_Export files from drag/drop, raw URDF text, asset maps, or a base64 ZIP.

export let Base64Images = [];

function debugLog(...args) {
  try { console.log('[URDFPLUS_DEBUG]', ...args); } catch (_) {}
  try { window.URDFPLUS_DEBUG_LOGS = window.URDFPLUS_DEBUG_LOGS || []; window.URDFPLUS_DEBUG_LOGS.push(args); } catch (_) {}
}

function basename(path) {
  return String(path || 'file').split(/[\\/]/).filter(Boolean).pop() || 'file';
}
function extname(path) {
  const b = basename(path);
  const i = b.lastIndexOf('.');
  return i >= 0 ? b.slice(i).toLowerCase() : '';
}
function mimeFromPath(path) {
  const e = extname(path);
  if (e === '.urdf' || e === '.xml') return 'application/xml';
  if (e === '.dae') return 'model/vnd.collada+xml';
  if (e === '.stl') return 'model/stl';
  if (e === '.obj') return 'text/plain';
  if (e === '.mtl') return 'text/plain';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.bmp') return 'image/bmp';
  if (e === '.tga') return 'image/x-tga';
  return 'application/octet-stream';
}
function isTextPath(path) {
  return /\.(urdf|xml|obj|mtl|txt|json|csv|dae)$/i.test(String(path || ''));
}
function looksLikeDataUrl(v) { return /^data:[^,]+,/i.test(String(v || '')); }
function looksLikeBase64(v) {
  const s = String(v || '').trim();
  return s.length > 80 && /^[A-Za-z0-9+/=\r\n]+$/.test(s) && !/[<>{}\n]\s*<robot/i.test(s);
}
function textToDataUrl(text, mime = 'text/plain') {
  return `data:${mime};charset=utf-8,${encodeURIComponent(String(text ?? ''))}`;
}
function bytesToDataUrl(bytes, mime = 'application/octet-stream') {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const chunk = 0x8000;
  for (let i = 0; i < arr.length; i += chunk) {
    bin += String.fromCharCode(...arr.subarray(i, i + chunk));
  }
  return `data:${mime};base64,${btoa(bin)}`;
}
async function fileToPayload(file, fallbackPath = '') {
  const path = String(file?.webkitRelativePath || file?.relativePath || fallbackPath || file?.name || 'file');
  const name = basename(path);
  const mime = file?.type || mimeFromPath(path);
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error || new Error('FileReader failed'));
    r.onload = () => resolve(String(r.result || ''));
    r.readAsDataURL(file);
  });
  return { path, name, mime, dataUrl };
}
function mapEntries(obj) {
  if (!obj) return [];
  if (obj instanceof Map) return Array.from(obj.entries());
  if (Array.isArray(obj)) return obj;
  if (typeof obj === 'object') return Object.entries(obj);
  return [];
}
async function valueToPayload(path, value) {
  const name = basename(path);
  const mime = mimeFromPath(path);
  if (value instanceof File || value instanceof Blob) return fileToPayload(value, path);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { path, name, mime, dataUrl: bytesToDataUrl(bytes, mime) };
  }
  const s = String(value ?? '');
  if (looksLikeDataUrl(s)) return { path, name, mime, dataUrl: s };
  if (!isTextPath(path) && looksLikeBase64(s)) return { path, name, mime, dataUrl: `data:${mime};base64,${s.replace(/\s+/g, '')}` };
  return { path, name, mime, text: s };
}
function normalizeZipBase64(v) {
  if (!v) return '';
  let s = String(v).trim();
  if (!s) return '';
  const comma = s.indexOf(',');
  if (/^data:/i.test(s) && comma >= 0) s = s.slice(comma + 1);
  return s.replace(/\s+/g, '');
}
function base64ToArrayBuffer(base64) {
  const bin = atob(normalizeZipBase64(base64));
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr.buffer;
}
async function loadScript(src) {
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function getJSZip() {
  if (window.JSZip) return window.JSZip;
  try {
    const mod = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
    return mod.default || mod.JSZip || window.JSZip;
  } catch (e) {
    debugLog('ESM JSZip failed; trying classic script', String(e));
    await loadScript('https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js');
    if (!window.JSZip) throw new Error('JSZip is not available');
    return window.JSZip;
  }
}
async function zipToPayloadFiles(base64Zip) {
  const b64 = normalizeZipBase64(base64Zip);
  if (!b64) return [];
  const JSZip = await getJSZip();
  const zip = await JSZip.loadAsync(base64ToArrayBuffer(b64));
  const out = [];
  const files = Object.values(zip.files || {}).filter(f => !f.dir);
  for (const zf of files) {
    const path = zf.name.replace(/^\/+/, '');
    const mime = mimeFromPath(path);
    if (isTextPath(path)) {
      out.push({ path, name: basename(path), mime, text: await zf.async('string') });
    } else {
      const bytes = await zf.async('uint8array');
      out.push({ path, name: basename(path), mime, dataUrl: bytesToDataUrl(bytes, mime) });
    }
  }
  return out;
}
async function buildVirtualFiles(opts = {}) {
  const out = [];

  const files = Array.from(opts.files || opts.inputFiles || []);
  for (const file of files) out.push(await fileToPayload(file));

  const zipCandidate = opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64 || opts.zipDataUrl;
  if (zipCandidate) out.push(...await zipToPayloadFiles(zipCandidate));

  const urdfText = opts.urdfContent || opts.urdfText || opts.xmlText || opts.robotXml || '';
  if (urdfText) {
    const p = opts.urdfFilename || opts.urdfPath || 'URDF_Export/robot.urdf';
    out.push({ path: p, name: basename(p), mime: mimeFromPath(p), text: String(urdfText) });
  }

  const maps = [opts.assetDB, opts.meshDB, opts.textureDB, opts.assets, opts.filesDB];
  for (const m of maps) {
    for (const [k, v] of mapEntries(m)) {
      if (!k || v == null) continue;
      out.push(await valueToPayload(String(k), v));
    }
  }

  // Deduplicate by path, keeping the last value because explicit opts should win.
  const byPath = new Map();
  for (const f of out) byPath.set(String(f.path || f.name), f);
  return Array.from(byPath.values());
}
function makeRequestId() {
  return 'urdfplus_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
}
function waitForIframeReady(iframe, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; cleanup(); resolve(true); };
    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      iframe.removeEventListener('load', onLoad);
      clearTimeout(timer);
    };
    const onMessage = (event) => {
      if (event.source === iframe.contentWindow && event.data?.type === 'AUTOMIND_URDFPLUS_READY') finish();
    };
    const onLoad = () => setTimeout(finish, 350);
    const timer = setTimeout(finish, timeoutMs);
    window.addEventListener('message', onMessage);
    iframe.addEventListener('load', onLoad);
  });
}
function postFilesToIframe(iframe, files) {
  const requestId = makeRequestId();
  return new Promise((resolve, reject) => {
    if (!files || !files.length) { resolve({ ok: true, count: 0 }); return; }
    const cleanup = () => { window.removeEventListener('message', onMessage); clearTimeout(timer); };
    const onMessage = (event) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data || {};
      if (data.requestId !== requestId) return;
      if (data.type === 'AUTOMIND_URDFPLUS_LOADED') { cleanup(); resolve(data); }
      if (data.type === 'AUTOMIND_URDFPLUS_LOAD_ERROR') { cleanup(); reject(new Error(data.message || 'URDF+ load failed')); }
    };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Timed out loading URDF+ virtual files')); }, 45000);
    window.addEventListener('message', onMessage);
    iframe.contentWindow?.postMessage?.({ type: 'AUTOMIND_URDFPLUS_LOAD_FILES', requestId, files }, '*');
  });
}
async function loadStandaloneHtml(iframe) {
  const url = new URL('./urdfplus_standalone.html', import.meta.url).href;
  try {
    const html = await fetch(url, { cache: 'no-store' }).then(r => {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    });
    iframe.srcdoc = html;
  } catch (e) {
    debugLog('fetch standalone failed; falling back to iframe src', String(e));
    iframe.src = url;
  }
}

export function render(opts = {}) {
  const { container, background = '#ffffff' } = opts;
  if (!container) throw new Error('[urdfplus_viewer_main] opts.container is required');
  container.innerHTML = '';
  container.style.position = container.style.position || 'relative';
  container.style.overflow = 'hidden';
  container.style.background = background;

  const iframe = document.createElement('iframe');
  iframe.title = 'AutoMind URDF+ Viewer';
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';
  iframe.style.display = 'block';
  iframe.style.background = background;
  iframe.setAttribute('allow', 'fullscreen; clipboard-read; clipboard-write; web-share');
  container.appendChild(iframe);

  const app = {
    iframe,
    container,
    ready: null,
    async loadFiles(filesOrPayload = []) {
      const files = [];
      for (const item of Array.from(filesOrPayload || [])) {
        if (item instanceof File || item instanceof Blob) files.push(await fileToPayload(item));
        else if (item && typeof item === 'object' && (item.path || item.name)) files.push(item);
      }
      await waitForIframeReady(iframe);
      return postFilesToIframe(iframe, files);
    },
    async loadURDF(urdfText, assetDB = {}) {
      const files = await buildVirtualFiles({ urdfContent: urdfText, assetDB });
      await waitForIframeReady(iframe);
      return postFilesToIframe(iframe, files);
    },
    resize() {},
    destroy() { try { iframe.remove(); } catch (_) {} },
    collectAllThumbnails: async () => Base64Images,
  };

  app.ready = (async () => {
    debugLog('render init', { mode: 'URDF+', hasZip: !!(opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64) });
    await loadStandaloneHtml(iframe);
    await waitForIframeReady(iframe);
    const files = await buildVirtualFiles(opts);
    if (files.length) await postFilesToIframe(iframe, files);
    return app;
  })();

  if (typeof window !== 'undefined') {
    window.URDFPlusViewer = window.URDFPlusViewer || {};
    window.URDFPlusViewer.__app = app;
  }
  return app;
}

export default { render };
