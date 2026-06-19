// /URDF_Viewer/urdfplus_viewer_main.js
// BUILD153: active entrypoint uses the exact standalone HTML joint/loop mechanism
// supplied in URDFPlus_Viewer_Standalone_BUILD153.html.  The previous unified
// URDFLoader path is still available with opts.forceLegacyURDFLoader=true.
import { render as renderLegacyURDF } from './legacy/urdf_viewer_main.js';

export let Base64Images = [];

function debug(...args) {
  try { if (globalThis.AutoMindURDFPlusDebug || globalThis.AUTOMIND_DEBUG) console.log('[URDFPLUS_BUILD153_STANDALONE]', ...args); } catch (_) {}
}

function urdfTextFromOpts(opts = {}) {
  return String(opts.urdfContent || opts.urdfText || opts.robotXml || opts.xmlText || opts.urdf || '');
}

function stripDataURLPrefix(s) {
  return String(s || '').replace(/^data:[^,]*,/i, '');
}

function basename(path) {
  return String(path || 'asset.bin').split(/[\\/]/).filter(Boolean).pop() || 'asset.bin';
}

function isDataURL(v) { return /^data:[^,]*,/i.test(String(v || '')); }
function looksRawText(name, value) {
  const ext = basename(name).split('.').pop().toLowerCase();
  if (/^(urdf|xml|dae|obj|mtl|txt|csv|json|usda)$/.test(ext)) return true;
  const s = String(value || '');
  return /[<>{}\n\r]/.test(s.slice(0, 2048)) || /^solid\b/i.test(s.slice(0, 64));
}

function addDescriptor(files, path, value, explicit = {}) {
  if (!path || value == null || value === '') return;
  const rel = String(path).replace(/\\/g, '/').replace(/^\.\//, '');
  const d = { path: rel, name: basename(rel), ...explicit };
  const s = String(value || '');
  if (isDataURL(s)) d.dataURL = s;
  else if (explicit.text != null || looksRawText(rel, s)) d.text = explicit.text != null ? String(explicit.text) : s;
  else d.base64 = stripDataURLPrefix(s);
  files.push(d);
}

function buildStandalonePayload(opts = {}) {
  const files = [];
  const zipValue = opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64 || opts.zip || '';
  if (zipValue) addDescriptor(files, opts.zipName || 'AutoMind_URDFPlus.zip', zipValue);

  const urdfContent = urdfTextFromOpts(opts);
  if (urdfContent) addDescriptor(files, opts.urdfName || 'robot.urdf', urdfContent, { text: urdfContent });

  const db = opts.meshDB || opts.assetDB || opts.textureDB || opts.assets || opts.filesDB || {};
  for (const [key, val] of Object.entries(db || {})) {
    if (val == null || val === '') continue;
    addDescriptor(files, key, val);
  }
  return { files };
}

function makeErrorBox(container, err) {
  try {
    const box = document.createElement('pre');
    box.textContent = 'AutoMind URDF+ BUILD153 error:\n' + (err?.stack || err?.message || String(err));
    Object.assign(box.style, {
      position:'absolute', left:'12px', right:'12px', top:'12px', zIndex:'999999',
      color:'#7a1111', background:'#fff5f5', border:'1px solid #f3b3b3', borderRadius:'12px',
      padding:'12px', whiteSpace:'pre-wrap', maxHeight:'45vh', overflow:'auto',
      font:'12px/1.4 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
    });
    container?.appendChild?.(box);
  } catch (_) {}
}

function waitForIframeReady(iframe, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; cleanup(); resolve(true); };
    const cleanup = () => { try { window.removeEventListener('message', onMsg, true); } catch (_) {} clearTimeout(timer); };
    const onMsg = (ev) => {
      if (ev.source === iframe.contentWindow && ev.data && ev.data.type === 'automind_urdfplus_ready') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    window.addEventListener('message', onMsg, true);
    iframe.addEventListener('load', () => setTimeout(finish, 80), { once: true });
  });
}

function waitForLoadedAck(iframe, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (msg = { ok: true }) => { if (done) return; done = true; cleanup(); resolve(msg); };
    const cleanup = () => { try { window.removeEventListener('message', onMsg, true); } catch (_) {} clearTimeout(timer); };
    const onMsg = (ev) => {
      if (ev.source === iframe.contentWindow && ev.data && ev.data.type === 'automind_urdfplus_loaded') finish(ev.data);
    };
    const timer = setTimeout(() => finish({ ok: true, timeout: true }), timeoutMs);
    window.addEventListener('message', onMsg, true);
  });
}

function renderStandalone(opts = {}) {
  const container = opts.container;
  if (!container) throw new Error('[urdfplus_viewer_main BUILD153] opts.container is required');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.innerHTML = '';

  const iframe = document.createElement('iframe');
  iframe.title = 'AutoMind URDF+ Viewer BUILD153';
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
  Object.assign(iframe.style, {
    position: 'absolute', inset: '0', width: '100%', height: '100%', border: '0',
    background: '#fff', display: 'block'
  });
  container.appendChild(iframe);

  let destroyed = false;
  const payload = buildStandalonePayload(opts);
  const ready = (async () => {
    try {
      const htmlURL = new URL('./URDFPlus_Viewer_Standalone_BUILD153.html', import.meta.url);
      const html = await fetch(htmlURL.toString(), { cache: 'no-store' }).then(r => {
        if (!r.ok) throw new Error('No pude cargar standalone HTML: ' + r.status + ' ' + r.statusText);
        return r.text();
      });
      if (destroyed) return null;
      iframe.srcdoc = html;
      await waitForIframeReady(iframe);
      if (destroyed) return null;
      if (payload.files.length) {
        const ackP = waitForLoadedAck(iframe);
        iframe.contentWindow?.postMessage?.({ type: 'automind_urdfplus_load_files', payload }, '*');
        const ack = await ackP;
        if (ack && ack.ok === false) throw new Error(ack.error || 'Standalone loader rejected payload');
      }
      debug('standalone loaded', { files: payload.files.length });
      return iframe.contentWindow?.AutoMindURDFPlusStandalone || null;
    } catch (err) {
      makeErrorBox(container, err);
      throw err;
    }
  })();

  const app = {
    build: 'BUILD153_EXACT_HTML_JOINTS_TWEEN_OVERLAYS',
    iframe,
    ready,
    get scene() { return iframe.contentWindow?.AutoMindURDFPlusStandalone?.state?.scene || null; },
    get robot() { return iframe.contentWindow?.AutoMindURDFPlusStandalone?.state?.robotGroup || null; },
    get camera() { return iframe.contentWindow?.AutoMindURDFPlusStandalone?.state?.camera || null; },
    resize() {},
    destroy() { destroyed = true; try { iframe.remove(); } catch (_) {} }
  };
  try { window.URDFPlusViewer = window.URDFPlusViewer || {}; window.URDFPlusViewer.__app = app; window.AutoMindURDFPlusApp = app; } catch (_) {}
  return app;
}

export function render(opts = {}) {
  if (opts.forceLegacyURDFLoader || opts.disableStandaloneHTMLMechanism) {
    return renderLegacyURDF(opts);
  }
  return renderStandalone(opts);
}

export default { render };
