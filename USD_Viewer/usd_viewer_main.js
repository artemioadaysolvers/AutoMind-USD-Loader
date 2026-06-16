// /USD_Viewer/usd_viewer_main.js
// AutoMind USD viewer main entrypoint.
// Same modular architecture as AutoMindCloudExperimental viewer:
// Theme + ViewerCore + AssetDB + SelectionAndDrag + ToolsDock + ComponentsPanel.

import { THEME } from './Theme.js';
import { createViewer } from './core/ViewerCore.js';
import { buildAssetDB } from './core/AssetDB.js';
import { attachInteraction } from './interaction/SelectionAndDrag.js';
import { createToolsDock } from './ui/ToolsDock.js';
import { createComponentsPanel } from './ui/ComponentsPanel.js';

export let Base64Images = [];

function debugLog(...args) {
  try { console.log('[USD_DEBUG]', ...args); } catch (_) {}
  try { window.USD_DEBUG_LOGS = window.USD_DEBUG_LOGS || []; window.USD_DEBUG_LOGS.push(args); } catch (_) {}
}

function splitName(key) {
  const clean = String(key || '').split('?')[0].split('#')[0];
  const base = clean.split('/').pop();
  const dot = base.lastIndexOf('.');
  return { base: dot >= 0 ? base.slice(0, dot) : base, ext: dot >= 0 ? base.slice(dot + 1).toLowerCase() : '' };
}
function listAssets(assetToMeshes) {
  const items = [];
  assetToMeshes.forEach((meshes, assetKey) => {
    if (!meshes || !meshes.length) return;
    const { base, ext } = splitName(assetKey);
    items.push({ assetKey, base, ext: ext || 'usd-link', count: meshes.length });
  });
  items.sort((a, b) => a.base.localeCompare(b.base, undefined, { numeric: true, sensitivity: 'base' }));
  return items;
}
function showAll(core) {
  if (!core.robot) return;
  core.robot.traverse(o => { if (o.isMesh && o.geometry) o.visible = true; });
}
function isolateAsset(core, assetToMeshes, assetKey) {
  if (!core.robot) return;
  const keep = new Set(assetToMeshes.get(assetKey) || []);
  core.robot.traverse(o => { if (o.isMesh && o.geometry) o.visible = keep.has(o); });
  const meshes = Array.from(keep);
  if (meshes.length) frameMeshes(core, meshes);
}
function frameMeshes(core, meshes) {
  const box = new THREE.Box3(); const tmp = new THREE.Box3(); let has = false;
  for (const m of meshes || []) { tmp.setFromObject(m); if (!has) { box.copy(tmp); has = true; } else box.union(tmp); }
  if (!has) return;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const cam = core.camera, ctrl = core.controls;
  if (cam.isPerspectiveCamera) {
    const fov = ((cam.fov || 60) * Math.PI) / 180;
    const dist = maxDim / Math.tan(Math.max(1e-6, fov / 2));
    cam.near = Math.max(maxDim / 1000, 0.001); cam.far = Math.max(maxDim * 1500, 1500); cam.updateProjectionMatrix();
    cam.position.copy(center.clone().add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(dist)));
  } else {
    cam.position.copy(center.clone().add(new THREE.Vector3(maxDim, maxDim * 0.9, maxDim)));
  }
  ctrl.target.copy(center); ctrl.update();
}

function buildThumbnailer(core, assetToMeshes) {
  const cache = new Map();
  const W = 320, H = 240;
  async function thumbnail(assetKey) {
    if (cache.has(assetKey)) return cache.get(assetKey);
    const meshes = assetToMeshes.get(assetKey) || [];
    if (!meshes.length) return '';
    const scene = new THREE.Scene(); scene.background = new THREE.Color(0xffffff);
    scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    const d = new THREE.DirectionalLight(0xffffff, 0.8); d.position.set(2, 3, 4); scene.add(d);
    const root = new THREE.Group(); scene.add(root);
    for (const mesh of meshes) {
      const c = mesh.clone(false);
      c.geometry = mesh.geometry;
      c.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone ? m.clone() : m) : (mesh.material?.clone ? mesh.material.clone() : mesh.material);
      const mats = Array.isArray(c.material) ? c.material : [c.material];
      for (const m of mats) {
        if (!m) continue;
        m.side = THREE.DoubleSide;
        if (!m.map && m.color) {
          const avg = (m.color.r + m.color.g + m.color.b) / 3;
          if (avg > 0.82) m.color.set(0x7aa7ad);
        }
        m.needsUpdate = true;
      }
      c.matrixAutoUpdate = false;
      c.matrix.copy(mesh.matrixWorld);
      root.add(c);
      try {
        const eg = new THREE.EdgesGeometry(mesh.geometry, 25);
        const el = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: 0x0b3b3c, transparent: true, opacity: 0.32 }));
        el.matrixAutoUpdate = false; el.matrix.copy(mesh.matrixWorld); root.add(el);
      } catch (_) {}
    }
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return '';
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    root.position.sub(center);
    const camera = new THREE.PerspectiveCamera(38, W / H, Math.max(maxDim / 1000, 0.0001), maxDim * 1000);
    camera.position.set(maxDim * 1.7, maxDim * 1.2, maxDim * 1.7);
    camera.lookAt(0, 0, 0);
    const oldTarget = core.renderer.getRenderTarget();
    const oldSize = core.renderer.getSize(new THREE.Vector2());
    const oldPixelRatio = core.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(W, H, { samples: 0 });
    try {
      core.renderer.setPixelRatio(1);
      core.renderer.setSize(W, H, false);
      core.renderer.setRenderTarget(rt);
      core.renderer.render(scene, camera);
      const buffer = new Uint8Array(W * H * 4);
      core.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buffer);
      const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d'); const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4; const dst = y * W * 4;
        img.data.set(buffer.subarray(src, src + W * 4), dst);
      }
      ctx.putImageData(img, 0, 0);
      const url = canvas.toDataURL('image/png'); cache.set(assetKey, url); return url;
    } catch (e) {
      debugLog('[thumb] failed', assetKey, String(e)); return '';
    } finally {
      core.renderer.setRenderTarget(oldTarget); core.renderer.setPixelRatio(oldPixelRatio); core.renderer.setSize(oldSize.x, oldSize.y, false); rt.dispose();
      root.traverse(o => { if (o.isMesh && o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach(m => m?.dispose?.()); } });
    }
  }
  async function primeAll(keys) { for (const k of keys || []) { try { await thumbnail(k); } catch (_) {} } }
  function destroy() { cache.clear(); }
  return { thumbnail, primeAll, destroy };
}

function maybeSetupIA(app, assetToMeshes, thumbs) {
  if (!app.IA_Widgets) return;
  setTimeout(async () => {
    try {
      const cb = window.google?.colab?.kernel?.invokeFunction;
      if (typeof cb !== 'function') { debugLog('[IA] Colab callback unavailable'); return; }
      const items = app.assets.list();
      const entries = [];
      // Full robot ISO as context.
      try {
        const iso = await captureRobotISO(app);
        if (iso) entries.push({ key: '__robot_iso__', name: 'robot_iso', index: -1, image_b64: iso.split(',')[1] || '' });
      } catch (_) {}
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const url = await thumbs.thumbnail(it.assetKey);
        const b64 = String(url || '').split(',')[1] || '';
        if (b64) entries.push({ key: it.assetKey, name: it.base || it.assetKey, index: i, image_b64: b64 });
      }
      const res = await cb('describe_component_images', [entries], {});
      app.componentDescriptions = parseCallbackResult(res);
      window.dispatchEvent(new Event('ia_descriptions_ready'));
      debugLog('[IA] descriptions ready', Object.keys(app.componentDescriptions || {}).length);
    } catch (e) { debugLog('[IA] error', String(e)); }
  }, 500);
}
function parseCallbackResult(res) {
  try {
    if (res && res.data && res.data['application/json']) return res.data['application/json'];
    if (res && typeof res === 'object' && !Array.isArray(res)) return res;
    if (typeof res === 'string') return JSON.parse(res);
  } catch (_) {}
  return {};
}
async function captureRobotISO(app) {
  // reuse first thumbnail-like render by rendering all robot meshes.
  const map = new Map();
  const arr = [];
  app.robot?.traverse?.(o => { if (o.isMesh && o.geometry) arr.push(o); });
  map.set('__robot_iso__', arr);
  const t = buildThumbnailer(app, map);
  const url = await t.thumbnail('__robot_iso__');
  t.destroy();
  return url;
}

export function render(opts = {}) {
  const {
    container,
    usdContent = '',
    usdText = '',
    assetDB = {},
    meshDB = {},
    textureDB = {},
    selectMode = 'link',
    background = (THEME.colors?.canvasBg ?? THEME.bgCanvas ?? 0xffffff),
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2),
    IA_Widgets = false,
  } = opts;

  if (!container) throw new Error('[usd_viewer_main] opts.container is required');
  debugLog('render init', { selectMode, IA_Widgets });

  const core = createViewer({ container, background, pixelRatio });
  const assets = buildAssetDB({ ...(meshDB || {}), ...(textureDB || {}), ...(assetDB || {}) });
  const robot = core.loadUSD(usdContent || usdText || '', { assetDB: assets });
  const assetToMeshes = robot.assetToMeshes || new Map();
  const thumbs = buildThumbnailer(core, assetToMeshes);
  const inter = attachInteraction({ scene: core.scene, camera: core.camera, renderer: core.renderer, controls: core.controls, robot, selectMode });

  const app = {
    scene: core.scene,
    renderer: core.renderer,
    controls: core.controls,
    helpers: core.helpers,
    get camera() { return core.camera; },
    get robot() { return robot; },
    resize: core.resize,
    fitAndCenter: (...args) => core.fitAndCenter(...args),
    setSceneToggles: (...args) => core.setSceneToggles(...args),
    setProjection: (...args) => core.setProjection(...args),
    IA_Widgets,
    componentDescriptions: {},
    assets: {
      list: () => listAssets(assetToMeshes),
      thumbnail: (assetKey) => thumbs.thumbnail(assetKey),
    },
    isolate: {
      asset: (assetKey) => isolateAsset(core, assetToMeshes, assetKey),
      clear: () => showAll(core),
    },
    showAll: () => showAll(core),
    getComponentDescription(assetKey, index) {
      const src = app.componentDescriptions || {};
      if (assetKey && src[assetKey]) return src[assetKey];
      const baseFull = (assetKey || '').split(/[\\/]/).pop();
      if (baseFull && src[baseFull]) return src[baseFull];
      const base = baseFull ? baseFull.split('.')[0] : '';
      if (base && src[base]) return src[base];
      if (Array.isArray(src) && typeof index === 'number') return src[index] || '';
      return '';
    },
    async collectAllThumbnails() {
      const items = app.assets.list(); Base64Images.length = 0;
      for (const it of items) {
        const url = await app.assets.thumbnail(it.assetKey);
        const b64 = String(url || '').split(',')[1] || '';
        if (b64) Base64Images.push(b64);
      }
      window.Base64Images = Base64Images;
      return Base64Images;
    },
  };

  const tools = createToolsDock(app, THEME);
  const comps = createComponentsPanel(app, THEME);
  app.openTools = (open = true) => tools.set?.(!!open);

  setTimeout(() => { try { thumbs.primeAll(Array.from(assetToMeshes.keys())); } catch (_) {} }, 100);
  maybeSetupIA(app, assetToMeshes, thumbs);

  if (typeof window !== 'undefined') {
    window.USDViewer = window.USDViewer || {}; window.USDViewer.__app = app;
  }

  return Object.assign(app, {
    resize: core.resize,
    destroy() {
      try { comps.destroy?.(); } catch (_) {}
      try { tools.destroy?.(); } catch (_) {}
      try { inter.destroy?.(); } catch (_) {}
      try { thumbs.destroy?.(); } catch (_) {}
      try { core.destroy?.(); } catch (_) {}
    }
  });
}

export default { render };
