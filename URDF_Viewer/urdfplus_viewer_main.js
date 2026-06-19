const BUILD_NAME = 'BUILD155_DynamicImportSafeUnifiedURDFPlus';
const LEGACY_ENTRY = './legacy/urdf_viewer_main.js';
const URDF_LOADER_URLS = [
  'https://cdn.jsdelivr.net/npm/urdf-loader@0.12.6/umd/URDFLoader.js',
  'https://cdn.jsdelivr.net/npm/urdf-loader@0.13.0/umd/URDFLoader.js'
];
let legacyModulePromise = null;
function safeString(value) { return value == null ? '' : String(value); }
function getUrdfText(opts) { return safeString(opts.urdfContent || opts.urdfText || opts.robotXml || opts.xmlText || opts.urdf || ''); }
function getMeshDatabase(opts) { return opts.meshDB || opts.assetDB || opts.textureDB || opts.assets || opts.filesDB || {}; }
function addClassicScript(src, timeoutMs) {
  return new Promise(function(resolve, reject) {
    if (typeof document === 'undefined') { reject(new Error('document is not available')); return; }
    try {
      var scripts = Array.from(document.scripts || []);
      for (var i = 0; i < scripts.length; i++) {
        if (scripts[i].src === src || scripts[i].getAttribute('src') === src) {
          if (globalThis.URDFLoader || scripts[i].dataset.automindLoaded === '1') { resolve(true); return; }
        }
      }
      var script = document.createElement('script');
      var finished = false;
      var timer = setTimeout(function() { finish(false, new Error('Timeout loading ' + src)); }, timeoutMs || 18000);
      function finish(ok, err) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        script.onload = null;
        script.onerror = null;
        if (ok) { script.dataset.automindLoaded = '1'; resolve(true); }
        else { try { script.remove(); } catch (e) {} reject(err || new Error('Failed to load ' + src)); }
      }
      script.src = src;
      script.async = true;
      script.onload = function() { finish(true); };
      script.onerror = function() { finish(false, new Error('Failed to load ' + src)); };
      document.head.appendChild(script);
    } catch (e) { reject(e); }
  });
}
async function ensureUrdfLoader() {
  if (globalThis.URDFLoader) return true;
  var errors = [];
  for (var i = 0; i < URDF_LOADER_URLS.length; i++) {
    var src = URDF_LOADER_URLS[i];
    try {
      await addClassicScript(src, 18000);
      if (globalThis.URDFLoader) return true;
      errors.push(src + ' loaded but URDFLoader was not defined');
    } catch (e) { errors.push((e && e.message) ? e.message : String(e)); }
  }
  throw new Error('No pude cargar URDFLoader desde jsDelivr:\n' + errors.join('\n'));
}
function normalizeOptions(opts) {
  opts = opts || {};
  var urdfContent = getUrdfText(opts);
  var meshDB = getMeshDatabase(opts);
  var out = Object.assign({}, opts);
  out.urdfContent = urdfContent;
  out.urdfText = urdfContent;
  out.robotXml = urdfContent;
  out.meshDB = meshDB;
  out.assetDB = meshDB;
  out.modelFormat = 'URDF+';
  out.isURDFPlus = true;
  out.unifiedURDFPlusPipeline = true;
  out.disableStandardPlusBranching = true;
  out.build = BUILD_NAME;
  return out;
}
function installErrorBox(container, err) {
  try {
    if (!container || typeof document === 'undefined') return;
    var box = document.createElement('pre');
    box.textContent = (err && (err.stack || err.message)) ? (err.stack || err.message) : String(err);
    Object.assign(box.style, {
      position: 'absolute', left: '12px', right: '12px', top: '12px', zIndex: '999999',
      color: '#7a1111', background: '#fff5f5', border: '1px solid #f3b3b3', borderRadius: '12px',
      padding: '12px', whiteSpace: 'pre-wrap', maxHeight: '45vh', overflow: 'auto', fontFamily: 'ui-monospace,Consolas,monospace', fontSize: '12px'
    });
    container.appendChild(box);
  } catch (e) {}
}
function installLoadingBox(container) {
  try {
    if (!container || typeof document === 'undefined') return null;
    var msg = document.createElement('div');
    msg.dataset.automindUnifiedLoading = '1';
    msg.textContent = 'Cargando AutoMind URDF+ unified pipeline...';
    Object.assign(msg.style, {
      position: 'absolute', left: '14px', top: '14px', zIndex: '99999', padding: '8px 10px',
      borderRadius: '10px', fontFamily: 'Inter,Arial,sans-serif', fontSize: '12px', color: '#0b3b3c',
      background: 'rgba(255,255,255,0.92)', border: '1px solid rgba(14,165,166,0.28)', pointerEvents: 'none'
    });
    container.appendChild(msg);
    return msg;
  } catch (e) { return null; }
}
function removeLoadingBox(container, msg) {
  try { if (msg && msg.parentNode) msg.parentNode.removeChild(msg); } catch (e) {}
  try { var q = container && container.querySelector ? container.querySelector('[data-automind-unified-loading="1"]') : null; if (q) q.remove(); } catch (e) {}
}
async function importLegacyModule() {
  if (!legacyModulePromise) legacyModulePromise = import(LEGACY_ENTRY + '?automind_build=' + encodeURIComponent(BUILD_NAME));
  return legacyModulePromise;
}
function renderUnifiedAsyncFacade(opts) {
  opts = opts || {};
  var realApp = null;
  var destroyed = false;
  var container = opts.container;
  var loadingBox = installLoadingBox(container);
  var facade = {
    ready: null,
    get robot() { return realApp && realApp.robot ? realApp.robot : null; },
    get scene() { return realApp && realApp.scene ? realApp.scene : null; },
    get camera() { return realApp && realApp.camera ? realApp.camera : null; },
    get controls() { return realApp && realApp.controls ? realApp.controls : null; },
    get renderer() { return realApp && realApp.renderer ? realApp.renderer : null; },
    resize: function() { try { return realApp && realApp.resize ? realApp.resize.apply(realApp, arguments) : undefined; } catch (e) { return undefined; } },
    destroy: function() { destroyed = true; try { if (realApp && realApp.destroy) realApp.destroy(); } catch (e) {} }
  };
  facade.ready = (async function() {
    await ensureUrdfLoader();
    var mod = await importLegacyModule();
    var renderFn = mod && typeof mod.render === 'function' ? mod.render : null;
    if (!renderFn) throw new Error('El módulo legacy URDF+ cargó, pero no exporta render(opts).');
    if (destroyed) return null;
    removeLoadingBox(container, loadingBox);
    realApp = renderFn(normalizeOptions(opts));
    try { realApp.build = BUILD_NAME; } catch (e) {}
    return realApp;
  })().catch(function(err) {
    removeLoadingBox(container, loadingBox);
    installErrorBox(container, err);
    throw err;
  });
  return facade;
}
export function render(opts) { return renderUnifiedAsyncFacade(opts || {}); }
export default { render: render };
