// /URDF_Viewer/urdfplus_viewer_main.js
// BUILD149: UNIFIED URDF+ entrypoint. No standard-vs-plus split at runtime.
// A single URDF+ renderer accepts both ordinary URDF and URDF+ XML.  The visual
// assembly path is the old proven AutoMind AssetDB + URDFLoader pipeline, because
// that is the mechanism that correctly resolves package:// meshes, Collada DAE
// roots and texture subresources.  URDF+ metadata is kept in opts for the same
// viewer shell and future loop/coupling tools; unknown URDF+ XML tags are simply
// ignored by URDFLoader instead of breaking standard URDF loading.
import { render as renderUnifiedURDF } from './legacy/urdf_viewer_main.js';

const URDF_LOADER_CANDIDATES = [
  'https://cdn.jsdelivr.net/npm/urdf-loader@0.12.6/umd/URDFLoader.js',
  'https://cdn.jsdelivr.net/npm/urdf-loader@0.13.0/umd/URDFLoader.js'
];

function debug(...args) {
  try { if (globalThis.AutoMindURDFPlusDebug || globalThis.AUTOMIND_DEBUG) console.log('[URDFPLUS_BUILD149_UNIFIED]', ...args); } catch (_) {}
}

function urdfTextFromOpts(opts = {}) {
  return String(opts.urdfContent || opts.urdfText || opts.robotXml || opts.xmlText || opts.urdf || '');
}

function loadClassicScriptOnce(src, timeoutMs = 18000) {
  return new Promise((resolve, reject) => {
    try {
      const existing = Array.from(document.scripts || []).find(s => s.src === src && s.dataset.automindLoaded === '1');
      if (existing) return resolve(true);
      const script = document.createElement('script');
      let done = false;
      const finish = (ok, err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (ok) { script.dataset.automindLoaded = '1'; resolve(true); }
        else { try { script.remove(); } catch (_) {} reject(err || new Error('Failed to load ' + src)); }
      };
      const timer = setTimeout(() => finish(false, new Error('Timeout loading ' + src)), timeoutMs);
      script.src = src;
      script.async = true;
      // Keep this exactly like the old working bridge: no crossOrigin.  Colab has
      // blocked some jsDelivr loader scripts when crossOrigin="anonymous" is set.
      script.onload = () => finish(true);
      script.onerror = () => finish(false, new Error('Failed to load ' + src));
      document.head.appendChild(script);
    } catch (e) { reject(e); }
  });
}

async function ensureURDFLoader() {
  if (globalThis.URDFLoader) return true;
  const errors = [];
  for (const src of URDF_LOADER_CANDIDATES) {
    try {
      await loadClassicScriptOnce(src);
      if (globalThis.URDFLoader) return true;
      errors.push(src + ' loaded, but URDFLoader was not defined');
    } catch (e) {
      errors.push((e && e.message) || String(e));
    }
  }
  throw new Error('No pude cargar URDFLoader desde jsDelivr:\n' + errors.join('\n'));
}

function normalizeUnifiedOpts(opts = {}) {
  const urdfContent = urdfTextFromOpts(opts);
  const meshDB = opts.meshDB || opts.assetDB || opts.textureDB || opts.assets || opts.filesDB || {};
  return {
    ...opts,
    urdfContent,
    urdfText: urdfContent,
    robotXml: urdfContent,
    meshDB,
    assetDB: meshDB,
    modelFormat: 'URDF+',
    isURDFPlus: true,
    build: 'BUILD149_UnifiedURDFPlusLoader',
    unifiedURDFPlusPipeline: true,
    disableStandardPlusBranching: true
  };
}

function renderUnifiedAsyncFacade(opts = {}) {
  let realApp = null;
  let destroyed = false;
  const container = opts.container;
  if (container) {
    try {
      const msg = document.createElement('div');
      msg.dataset.automindUnifiedLoading = '1';
      msg.textContent = 'Cargando AutoMind URDF+ unified pipeline...';
      Object.assign(msg.style, {
        position: 'absolute', left: '14px', top: '14px', zIndex: '99999',
        padding: '8px 10px', borderRadius: '10px', fontFamily: 'Inter,Arial,sans-serif',
        fontSize: '12px', color: '#0b3b3c', background: 'rgba(255,255,255,0.92)',
        border: '1px solid rgba(14,165,166,0.28)', pointerEvents: 'none'
      });
      container.appendChild(msg);
    } catch (_) {}
  }

  const ready = (async () => {
    await ensureURDFLoader();
    if (destroyed) return null;
    try { container?.querySelector?.('[data-automind-unified-loading="1"]')?.remove?.(); } catch (_) {}
    const normalized = normalizeUnifiedOpts(opts);
    debug('using one unified URDF+ pipeline for URDF and URDF+', {
      hasURDF: /<robot\b/i.test(normalized.urdfContent || ''),
      hasPlusHints: /<(?:\w+:)?(?:loop|coupling|mechanical_graph|viewer_policy|viewer_hint|urdf_plus_contract)\b|automind:|urdf\+/i.test(normalized.urdfContent || ''),
      assetKeys: Object.keys(normalized.meshDB || {}).length
    });
    realApp = renderUnifiedURDF(normalized);
    try { realApp.build = 'BUILD149_UnifiedURDFPlusLoader'; } catch (_) {}
    return realApp;
  })().catch((err) => {
    try {
      if (container) {
        const box = document.createElement('pre');
        box.textContent = (err && (err.stack || err.message)) || String(err);
        Object.assign(box.style, { position:'absolute', left:'12px', right:'12px', top:'12px', zIndex:'999999', color:'#7a1111', background:'#fff5f5', border:'1px solid #f3b3b3', borderRadius:'12px', padding:'12px', whiteSpace:'pre-wrap', maxHeight:'45vh', overflow:'auto' });
        container.appendChild(box);
      }
    } catch (_) {}
    throw err;
  });

  return {
    ready,
    get robot() { return realApp?.robot || null; },
    get scene() { return realApp?.scene || null; },
    get camera() { return realApp?.camera || null; },
    get controls() { return realApp?.controls || null; },
    get renderer() { return realApp?.renderer || null; },
    resize(...args) { try { return realApp?.resize?.(...args); } catch (_) {} },
    destroy() { destroyed = true; try { realApp?.destroy?.(); } catch (_) {} }
  };
}

export function render(opts = {}) {
  return renderUnifiedAsyncFacade(opts);
}

export default { render };
