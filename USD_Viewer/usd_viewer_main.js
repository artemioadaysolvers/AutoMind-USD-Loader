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
function viewIso(core, object = core.robot, duration = 750) {
  // Same final pose math as ToolsDock Iso button.
  if (!core || !object) return false;
  const cam = core.camera, ctrl = core.controls;
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return false;
  const target = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = size.length() * 0.5 * (1 / Math.sqrt(3));
  const az = Math.PI * 0.25;
  const el = Math.PI * 0.20;
  function distanceToFitSphere(cam, radius, pad = 3) {
    const r = Math.max(1e-6, radius) * pad;
    if (cam.isOrthographicCamera) return THREE.MathUtils.clamp(r * 2.0, 0.35, 1e4);
    const vFov = THREE.MathUtils.degToRad(cam.fov || 45);
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * (cam.aspect || 1));
    const dV = r / Math.tan(vFov * 0.5);
    const dH = r / Math.tan(hFov * 0.5);
    return Math.max(dV, dH);
  }
  let fitR = distanceToFitSphere(cam, radius, 3);
  fitR = THREE.MathUtils.clamp(fitR, 0.35, 1e4);
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  const endPos = target.clone().add(dir.multiplyScalar(fitR));
  if (cam.isPerspectiveCamera) {
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    cam.near = Math.max(maxDim / 1000, 0.001);
    cam.far = Math.max(maxDim * 1500, 1500);
    cam.updateProjectionMatrix();
  }
  const startPos = cam.position.clone();
  const startTarget = ctrl.target.clone();
  if (!duration || duration <= 0) {
    cam.position.copy(endPos);
    ctrl.target.copy(target);
    ctrl.update();
    return true;
  }
  const t0 = performance.now();
  const ease = t => 1 - Math.pow(1 - t, 3);
  function step() {
    const u = Math.min(1, (performance.now() - t0) / duration);
    const k = ease(u);
    cam.position.lerpVectors(startPos, endPos, k);
    ctrl.target.lerpVectors(startTarget, target, k);
    ctrl.update();
    if (u < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
  return true;
}
function showAll(core) {
  if (!core.robot) return;
  core.robot.traverse(o => { if (o.isMesh && o.geometry) o.visible = true; });
  viewIso(core, core.robot, 320);
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
  // AutoMind USD thumbnailer with real USD materials/textures.
  // It keeps texture maps when present, waits briefly for dataURL textures to decode,
  // and adds a subtle edge overlay so white Technic pieces do not disappear on white UI.
  const cache = new Map();
  const W = 320, H = 240;
  const BG_COLOR = 0xf3f8f9;
  const EDGE_COLOR = 0x0b3b3c;

  function materialList(mat) {
    if (!mat) return [];
    return Array.isArray(mat) ? mat.filter(Boolean) : [mat];
  }
  function hasLoadedImage(tex) {
    const img = tex?.image;
    return !!(img && ((typeof img.width === 'number' && img.width > 0) || img.complete === true));
  }
  async function waitForTextures(meshes, timeoutMs = 3000) {
    const maps = [];
    for (const mesh of meshes || []) {
      for (const m of materialList(mesh?.material)) {
        if (m?.map && !hasLoadedImage(m.map)) maps.push(m.map);
      }
    }
    if (!maps.length) return;
    const t0 = performance.now();
    await new Promise(resolve => {
      const tick = () => {
        if (maps.every(hasLoadedImage) || performance.now() - t0 > timeoutMs) resolve();
        else setTimeout(tick, 25);
      };
      tick();
    });
  }
  function cloneMaterialForPreview(src) {
    let mat;
    if (src && typeof src.clone === 'function') mat = src.clone();
    else mat = new THREE.MeshStandardMaterial({ color: 0xdfe8ea, roughness: 0.55, metalness: 0.04 });
    mat.side = THREE.DoubleSide;
    if (mat.map) {
      mat.map.needsUpdate = true;
      mat.color = new THREE.Color(0xffffff);
    } else if (mat.color) {
      // Keep original material color; edge overlay gives contrast for white parts.
    }
    mat.roughness = Number.isFinite(mat.roughness) ? mat.roughness : 0.55;
    mat.metalness = Number.isFinite(mat.metalness) ? mat.metalness : 0.04;
    mat.needsUpdate = true;
    return mat;
  }
  function disposePreview(root) {
    root?.traverse?.((o) => {
      if (o?.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m?.dispose?.()); // disposes cloned material only, not shared textures
      }
      if (o?.isLineSegments && o.material) o.material.dispose?.();
      if (o?.userData?.__ownedEdgeGeometry) o.geometry?.dispose?.();
    });
  }

  async function thumbnail(assetKey) {
    if (cache.has(assetKey)) return cache.get(assetKey);
    const meshes = assetToMeshes.get(assetKey) || [];
    if (!meshes.length) return '';
    await waitForTextures(meshes);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfe6e8, 2.4));
    scene.add(new THREE.AmbientLight(0xffffff, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(3, 4, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.75); fill.position.set(-4, -2, 3); scene.add(fill);

    const root = new THREE.Group();
    scene.add(root);
    for (const mesh of meshes) {
      if (!mesh || !mesh.geometry) continue;
      const srcMats = materialList(mesh.material);
      const previewMat = Array.isArray(mesh.material)
        ? srcMats.map(cloneMaterialForPreview)
        : cloneMaterialForPreview(srcMats[0]);
      const c = new THREE.Mesh(mesh.geometry, previewMat);
      c.matrixAutoUpdate = false;
      c.matrix.copy(mesh.matrixWorld);
      c.renderOrder = 1;
      root.add(c);
      try {
        const eg = new THREE.EdgesGeometry(mesh.geometry, 20);
        const em = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.40 });
        const edges = new THREE.LineSegments(eg, em);
        edges.matrixAutoUpdate = false;
        edges.matrix.copy(mesh.matrixWorld);
        edges.renderOrder = 2;
        edges.userData.__ownedEdgeGeometry = true;
        root.add(edges);
      } catch (_) {}
    }

    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return '';
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    root.position.sub(center);
    root.updateMatrixWorld(true);

    const camera = new THREE.PerspectiveCamera(35, W / H, Math.max(maxDim / 1000, 0.0001), Math.max(maxDim * 1000, 10));
    camera.position.set(maxDim * 1.9, maxDim * 1.35, maxDim * 1.9);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();

    const renderer = core.renderer;
    const oldTarget = renderer.getRenderTarget();
    const oldSize = renderer.getSize(new THREE.Vector2());
    const oldPixelRatio = renderer.getPixelRatio();
    const oldClearColor = renderer.getClearColor(new THREE.Color()).clone();
    const oldClearAlpha = renderer.getClearAlpha?.() ?? 1;
    const rt = new THREE.WebGLRenderTarget(W, H, { samples: 0 });
    try {
      renderer.setPixelRatio(1);
      renderer.setSize(W, H, false);
      renderer.setClearColor(BG_COLOR, 1);
      renderer.setRenderTarget(rt);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      const buffer = new Uint8Array(W * H * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, buffer);
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4;
        const dst = y * W * 4;
        img.data.set(buffer.subarray(src, src + W * 4), dst);
      }
      ctx.putImageData(img, 0, 0);
      const url = canvas.toDataURL('image/png');
      cache.set(assetKey, url);
      return url;
    } catch (e) {
      debugLog('[thumb] failed', assetKey, String(e));
      return '';
    } finally {
      renderer.setRenderTarget(oldTarget);
      renderer.setPixelRatio(oldPixelRatio);
      renderer.setSize(oldSize.x, oldSize.y, false);
      renderer.setClearColor(oldClearColor, oldClearAlpha);
      rt.dispose();
      disposePreview(root);
      core.resize?.();
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
    viewIso: () => viewIso(core, core.robot, 320),
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
