// /XML_Viewer/urdfplus_viewer_main.js
// BUILD211: texture-correct OBJ UVs + synchronized closed-chain viewport + static-grid previews.
// AutoMind MJCF viewer main entrypoint. BUILD184 viewport texture proxy.
// Same modular architecture as AutoMindCloudExperimental viewer:
// Theme + ViewerCore + AssetDB + SelectionAndDrag + ToolsDock + ComponentsPanel.

import { THEME } from './Theme.js';
import { createViewer } from './core/ViewerCore.js';
import { attachInteraction } from './interaction/SelectionAndDrag.js';
import { createToolsDock } from './ui/ToolsDock.js';
import { createComponentsPanel } from './ui/ComponentsPanel.js';
import { loadMJCFModel } from './core/MJCFCore.js';

export let Base64Images = [];
const AUTOMIND_EMPTY_TEXTURE_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function debugLog(...args) {
  const enabled = !!(globalThis?.AutoMindMJCFDebug || globalThis?.AUTOMIND_DEBUG);
  try { window.MJCF_DEBUG_LOGS = window.MJCF_DEBUG_LOGS || []; window.MJCF_DEBUG_LOGS.push(args); } catch (_) {}
  if (!enabled) return;
  try { console.log('[MJCF_DEBUG]', ...args); } catch (_) {}
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
function materialList(mat) {
  if (!mat) return [];
  return Array.isArray(mat) ? mat.filter(Boolean) : [mat];
}

// BUILD165: thumbnail waits are 3x faster than BUILD164 while preserving the serial queue.
function sleep(ms = 0) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => resolve())); }
async function waitFrames(n = 1) { for (let i = 0; i < Math.max(1, n|0); i++) await nextFrame(); }
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function objectBox(object) {
  const box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}
function distanceToFitSphere(cam, radius, pad = 3) {
  const r = Math.max(1e-6, radius) * pad;
  if (cam.isOrthographicCamera) return THREE.MathUtils.clamp(r * 2.0, 0.35, 1e4);
  const vFov = THREE.MathUtils.degToRad(cam.fov || 45);
  const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * (cam.aspect || 1));
  const dV = r / Math.tan(vFov * 0.5);
  const dH = r / Math.tan(hFov * 0.5);
  return Math.max(dV, dH);
}
function updateCameraPlanesForBox(cam, size) {
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  cam.near = cam.isOrthographicCamera ? -Math.max(maxDim * 100, 1000) : Math.max(maxDim / 1000, 0.001);
  cam.far = cam.isOrthographicCamera ? Math.max(maxDim * 100, 1000) : Math.max(maxDim * 5000, 5000);
  if (cam.isOrthographicCamera) {
    const aspect = Math.max(1e-6, cam.right && cam.top ? Math.abs((cam.right - cam.left) / (cam.top - cam.bottom)) : (cam.aspect || 1));
    const halfH = Math.max(maxDim * 1.75, 1e-6);
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.zoom = 1;
  }
  cam.updateProjectionMatrix();
}
let cameraTweenToken = 0;
let cameraTweenRAF = 0;

function stopControlsInertia(ctrl) {
  if (!ctrl) return;
  // TrackballControls keeps smooth inertia in private fields. If a view preset
  // starts while that inertia is still alive, the camera moves once before the
  // tween captures the real start pose. Freeze it first so Iso/Top/Front/Right
  // and Show all always start from the exact camera pose visible at click time.
  try { ctrl._state = 0; } catch (_) {}
  try { ctrl._lastAngle = 0; } catch (_) {}
  try { ctrl._lastPan?.set?.(0, 0, 0); } catch (_) {}
  try { ctrl._lastDolly = 0; } catch (_) {}
  try { ctrl._lastZoom = 0; } catch (_) {}
  try { ctrl._lastAxis?.set?.(1, 0, 0); } catch (_) {}
}

function angleDeltaShortest(a, b) {
  let d = (b - a + Math.PI) % (Math.PI * 2);
  if (d < 0) d += Math.PI * 2;
  return d - Math.PI;
}
function offsetToSpherical(v) {
  const r = Math.max(1e-9, v.length());
  return { r, az: Math.atan2(v.z, v.x), el: Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1)) };
}
function tweenCamera(core, endPos, endTarget = null, duration = 700, projectionTarget = null) {
  // Capture the exact visible camera pose at click time; component-panel focus
  // must never jump to a preset before the tween starts.
  const cam = core.camera, ctrl = core.controls;
  const token = ++cameraTweenToken;
  const p0 = cam.position.clone();
  const t0 = (ctrl?.target || new THREE.Vector3()).clone();
  const toPos = endPos.clone();
  const toTarget = endTarget ? endTarget.clone() : null;
  const ortho0 = cam.isOrthographicCamera ? { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far } : null;
  const tStart = performance.now();
  try { stopControlsInertia(ctrl); ctrl.enabled = false; } catch (_) {}
  cam.up.set(0, 1, 0);
  const moveTarget = (toTarget !== null);
  function step(t) {
    if (token !== cameraTweenToken) return;
    const u = Math.min(1, (t - tStart) / Math.max(1, duration));
    const e = easeInOutCubic(u);
    cam.position.lerpVectors(p0, toPos, e);
    if (moveTarget && ctrl?.target) ctrl.target.lerpVectors(t0, toTarget, e);
    if (ortho0 && projectionTarget) {
      cam.left = ortho0.left + (projectionTarget.left - ortho0.left) * e;
      cam.right = ortho0.right + (projectionTarget.right - ortho0.right) * e;
      cam.top = ortho0.top + (projectionTarget.top - ortho0.top) * e;
      cam.bottom = ortho0.bottom + (projectionTarget.bottom - ortho0.bottom) * e;
      cam.near = ortho0.near + (projectionTarget.near - ortho0.near) * e;
      cam.far = ortho0.far + (projectionTarget.far - ortho0.far) * e;
      cam.updateProjectionMatrix();
    }
    try { ctrl?.update?.(); } catch (_) { try { cam.lookAt(moveTarget ? toTarget : t0); } catch (__) {} }
    try { core.renderer?.render?.(core.scene, cam); } catch (_) {}
    if (u < 1) requestAnimationFrame(step);
    else if (token === cameraTweenToken) { try { ctrl.enabled = true; } catch (_) {} }
  }
  requestAnimationFrame(step);
  return true;
}function viewPreset(core, kind = 'iso', object = core.robot, duration = 750) {
  // BUILD169: exact USD viewer viewEndPose logic adapted to MJCF.
  if (!core || !object) return false;
  const cam = core.camera, ctrl = core.controls;
  const box = objectBox(object);
  const target = box ? box.getCenter(new THREE.Vector3()) : (ctrl?.target || new THREE.Vector3()).clone();
  const size = box ? box.getSize(new THREE.Vector3()) : new THREE.Vector3(1, 1, 1);
  const radius = box ? size.length() * 0.5 * (1 / Math.sqrt(3)) : 1;

  const curVec = cam.position.clone().sub(target);
  const len = Math.max(1e-9, curVec.length());
  const cur = { el: Math.asin(curVec.y / len), az: Math.atan2(curVec.z, curVec.x) };

  let az = cur.az, el = cur.el;
  const topEps = 1e-3;
  if (kind === 'iso')   { az = Math.PI * 0.25; el = Math.PI * 0.20; }
  if (kind === 'top')   { az = Math.round(cur.az / (Math.PI / 2)) * (Math.PI / 2); el = Math.PI / 2 - topEps; }
  if (kind === 'front') { az = Math.PI / 2; el = 0; }
  if (kind === 'right') { az = 0; el = 0; }

  let fitR = distanceToFitSphere(cam, radius, 3);
  fitR = THREE.MathUtils.clamp(fitR, 0.35, 1e4);

  if (cam.isOrthographicCamera) {
    const aspect = Math.max(1e-6, (core.renderer?.domElement?.clientWidth || 1) / (core.renderer?.domElement?.clientHeight || 1));
    const halfH = Math.max((radius || 1) * 2.85, 1e-6);
    cam.left = -halfH * aspect;
    cam.right = halfH * aspect;
    cam.top = halfH;
    cam.bottom = -halfH;
    cam.zoom = 1;
    const depth = Math.max((radius || 1) * 80, 1000);
    cam.near = -depth;
    cam.far = depth;
    cam.updateProjectionMatrix();
    fitR = Math.max((radius || 1) * 6, 1.0);
  }

  const dir = new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  ).normalize();

  const pos = target.clone().add(dir.multiplyScalar(fitR));
  return tweenCamera(core, pos, target, duration);
}
function viewIso(core, object = core.robot, duration = 750) {
  return viewPreset(core, 'iso', object, duration);
}
let visibilityTweenToken = 0;
let visibilityRAF = 0;
let visibilityActionSerial = 0;

function collectRobotMeshes(robot) {
  const meshes = [];
  robot?.traverse?.(o => {
    if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) meshes.push(o);
  });
  return meshes;
}

function collectMeshesInObject(object) {
  const meshes = [];
  object?.traverse?.(o => {
    if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) meshes.push(o);
  });
  return meshes;
}

function ensureMaterialUserData(mat) {
  if (!mat.userData) mat.userData = {};
  return mat.userData;
}

function repairTexturedMaterial(mat) {
  if (!mat) return mat;
  const ud = ensureMaterialUserData(mat);
  // The MJCF loader stamps this before a mesh ever enters the scene. Restore it
  // before every visibility/render-mode transition so material mutations can never
  // replace a valid PNG texture with the white default material.
  if (ud.__automindTextureMap) {
    mat.map = ud.__automindTextureMap;
    try {
      if ('colorSpace' in mat.map && THREE.SRGBColorSpace) mat.map.colorSpace = THREE.SRGBColorSpace;
      if ('encoding' in mat.map && THREE.sRGBEncoding) mat.map.encoding = THREE.sRGBEncoding;
      mat.map.needsUpdate = true;
    } catch (_) {}
  } else if (mat.map) {
    ud.__automindTextureMap = mat.map;
  }
  if (ud.__automindBaseColor && mat.color?.copy) mat.color.copy(ud.__automindBaseColor);
  else if (mat.color?.clone) ud.__automindBaseColor = mat.color.clone();
  return mat;
}



function viewportMaterialList(material) {
  return !material ? [] : (Array.isArray(material) ? material.filter(Boolean) : [material]);
}

function srgbToLinearChannel(value) {
  const c = Math.min(1, Math.max(0, Number(value) || 0));
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function textureWrapCoordinate(value, wrapMode) {
  let v = Number(value);
  if (!Number.isFinite(v)) return 0;
  if (wrapMode === THREE.RepeatWrapping) return v - Math.floor(v);
  if (wrapMode === THREE.MirroredRepeatWrapping) {
    const cell = Math.floor(v);
    const frac = v - cell;
    return Math.abs(cell) % 2 ? 1 - frac : frac;
  }
  return Math.min(1, Math.max(0, v));
}

function materialFallbackColor(material) {
  const mapStats = material?.map?.userData?.__automindTextureStats || material?.userData?.__automindTextureStats || null;
  const mean = Array.isArray(mapStats?.mean) ? mapStats.mean : null;
  let rgb = null;
  if (mean && mean.length >= 3 && mean.slice(0, 3).some(v => Number(v) > 0.035)) {
    rgb = mean.slice(0, 3);
  } else if (material?.color) {
    rgb = [material.color.r, material.color.g, material.color.b];
  } else {
    rgb = [0.72, 0.78, 0.81];
  }
  const color = new THREE.Color(
    srgbToLinearChannel(rgb[0]),
    srgbToLinearChannel(rgb[1]),
    srgbToLinearChannel(rgb[2])
  );
  if (color.r < 0.025 && color.g < 0.025 && color.b < 0.025) color.setHex(0x9fb6bf);
  return color;
}

function bakeTextureIntoVertexColors(sourceGeometry, texture) {
  // Chromium/Colab can sample CanvasTexture as black only in the visible default
  // framebuffer, while the same texture works in the thumbnail render target.
  // Baking each decoded texture into the geometry's UV vertices bypasses that GPU
  // sampling path entirely. It retains the visual paint/detail wherever the OBJ
  // has enough tessellation and always preserves the real part colours.
  try {
    if (!sourceGeometry?.attributes?.uv || !texture?.image) return null;
    const uv = sourceGeometry.attributes.uv;
    if (!uv?.count || uv.itemSize < 2) return null;

    const sourceImage = texture.image;
    const width = Number(sourceImage.naturalWidth || sourceImage.videoWidth || sourceImage.width || 0);
    const height = Number(sourceImage.naturalHeight || sourceImage.videoHeight || sourceImage.height || 0);
    if (!width || !height) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(sourceImage, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;

    const geometry = sourceGeometry.clone();
    const bakedUv = geometry.attributes.uv;
    const colors = new Float32Array(bakedUv.count * 3);
    const repeatX = Number.isFinite(texture.repeat?.x) ? texture.repeat.x : 1;
    const repeatY = Number.isFinite(texture.repeat?.y) ? texture.repeat.y : 1;
    const offsetX = Number.isFinite(texture.offset?.x) ? texture.offset.x : 0;
    const offsetY = Number.isFinite(texture.offset?.y) ? texture.offset.y : 0;
    const flipY = texture.flipY !== false;
    const fallback = materialFallbackColor({ map: texture });

    for (let i = 0; i < bakedUv.count; i++) {
      let u = bakedUv.getX(i) * repeatX + offsetX;
      let v = bakedUv.getY(i) * repeatY + offsetY;
      u = textureWrapCoordinate(u, texture.wrapS);
      v = textureWrapCoordinate(v, texture.wrapT);
      // Canvas memory starts at the top. Three's flipY=true maps v=0 to the
      // lower texture edge, so replicate that relationship on CPU.
      const sampleV = flipY ? (1 - v) : v;
      const x = Math.min(width - 1, Math.max(0, Math.floor(u * (width - 1))));
      const y = Math.min(height - 1, Math.max(0, Math.floor(sampleV * (height - 1))));
      const index = (y * width + x) * 4;
      const alpha = pixels[index + 3] / 255;
      const r = pixels[index] / 255;
      const g = pixels[index + 1] / 255;
      const b = pixels[index + 2] / 255;
      // Keep fully transparent texels from becoming black holes in an opaque
      // CAD mesh. The material alpha path still handles actual transparent maps.
      colors[i * 3] = alpha > 0.01 ? srgbToLinearChannel(r) : fallback.r;
      colors[i * 3 + 1] = alpha > 0.01 ? srgbToLinearChannel(g) : fallback.g;
      colors[i * 3 + 2] = alpha > 0.01 ? srgbToLinearChannel(b) : fallback.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.userData = { ...(geometry.userData || {}), __automindTextureVertexBaked: true };
    return geometry;
  } catch (error) {
    console.warn('[AutoMind MJCF] No se pudo hornear una textura a colores de vértice:', error);
    return null;
  }
}

function disposeViewportTextureProxy(core) {
  const old = core?.__automindViewportTextureProxy;
  if (!old) return;
  try { old.group?.parent?.remove(old.group); } catch (_) {}
  try {
    old.group?.traverse?.((o) => {
      if (!o?.isMesh) return;
      try { if (o.geometry?.userData?.__automindTextureVertexBaked) o.geometry.dispose?.(); } catch (_) {}
      if (!o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) { try { m?.dispose?.(); } catch (_) {} }
    });
  } catch (_) {}
  try {
    for (const record of old.records || []) {
      for (const state of record.sourceStates || []) {
        const mat = state.material;
        if (!mat) continue;
        mat.colorWrite = state.colorWrite;
        mat.depthWrite = state.depthWrite;
        mat.needsUpdate = true;
      }
      if (record.source) record.source.onBeforeRender = record.sourceOnBeforeRender || null;
    }
  } catch (_) {}
  try { if (core?.scene?.userData) delete core.scene.userData.__automindBeforeVisibleRender; } catch (_) {}
  try { delete core.__automindViewportTextureProxy; } catch (_) {}
}

function createViewportTextureProxy(core, robot, enabled = true, bakeVertexColors = true) {
  // This layer is deliberately independent of sampling a WebGL texture in the
  // visible framebuffer. In Colab, that exact path can turn every CanvasTexture
  // black despite valid thumbnails. The default uses UV->vertex-color baking.
  disposeViewportTextureProxy(core);
  if (!enabled || !core?.scene || !robot || !window.AutoMindMJCFViewportTextureProxy) return null;

  const group = new THREE.Group();
  group.name = 'AutoMind_MJCF_TextureViewportProxy';
  group.renderOrder = 0;
  group.matrixAutoUpdate = true;
  group.userData.__automindViewportTextureProxy = true;

  const records = [];
  let mappedProxyMeshes = 0;
  let vertexBakedProxyMeshes = 0;
  let fallbackColorProxyMeshes = 0;
  let suppressedSourceMeshes = 0;

  try { robot.updateMatrixWorld?.(true); } catch (_) {}
  robot.traverse?.((source) => {
    if (!source?.isMesh || !source.geometry || source.userData?.__isHoverOverlay) return;
    const sourceMats = viewportMaterialList(source.material);
    if (!sourceMats.length) return;

    const proxyGeometries = [];
    const proxyMats = sourceMats.map((src, materialIndex) => {
      const ud = src?.userData || {};
      const map = src?.map || ud.__automindTextureMap || null;
      let bakedGeometry = null;
      if (map) {
        mappedProxyMeshes++;
        if (bakeVertexColors) bakedGeometry = bakeTextureIntoVertexColors(source.geometry, map);
      }
      proxyGeometries[materialIndex] = bakedGeometry;
      if (bakedGeometry) {
        vertexBakedProxyMeshes++;
        const pm = new THREE.MeshBasicMaterial({
          color: new THREE.Color(0xffffff),
          vertexColors: true,
          side: (src && src.side != null) ? src.side : THREE.FrontSide,
          transparent: false,
          opacity: 1,
          depthWrite: true,
          depthTest: true,
          alphaTest: 0,
          wireframe: !!src?.wireframe,
        });
        pm.toneMapped = false;
        pm.userData = { ...(pm.userData || {}), __automindViewportProxyMaterial: true, __automindVertexBaked: true };
        pm.needsUpdate = true;
        return pm;
      }

      fallbackColorProxyMeshes++;
      const pm = new THREE.MeshBasicMaterial({
        color: materialFallbackColor(src),
        side: (src && src.side != null) ? src.side : THREE.FrontSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        depthTest: true,
        alphaTest: 0,
        wireframe: !!src?.wireframe,
      });
      pm.toneMapped = false;
      pm.userData = { ...(pm.userData || {}), __automindViewportProxyMaterial: true, __automindFallbackColor: true };
      pm.needsUpdate = true;
      return pm;
    });

    // A mesh normally has one material in this MJCF exporter. For grouped OBJ
    // meshes, use the first compatible baked geometry; material groups remain
    // intact because the clone preserves geometry.groups.
    const proxyGeometry = proxyGeometries.find(Boolean) || source.geometry.clone();
    if (!proxyGeometry.userData?.__automindTextureVertexBaked) {
      proxyGeometry.userData = { ...(proxyGeometry.userData || {}), __automindProxyGeometryClone: true };
    }
    const proxy = new THREE.Mesh(source.geometry.groups?.length && Array.isArray(source.material) ? proxyGeometry : proxyGeometry, Array.isArray(source.material) ? proxyMats : proxyMats[0]);
    proxy.name = 'viewport_texture_proxy:' + (source.name || source.userData?.__assetKey || 'mesh');
    proxy.matrixAutoUpdate = false;
    proxy.frustumCulled = false;
    proxy.renderOrder = Number.isFinite(source.renderOrder) ? source.renderOrder : 0;
    proxy.castShadow = false;
    proxy.receiveShadow = false;
    proxy.userData.__automindViewportProxy = true;
    proxy.userData.__automindProxySource = source;
    proxy.matrix.copy(source.matrixWorld);
    group.add(proxy);

    const sourceStates = [];
    for (const mat of sourceMats) {
      if (!mat) continue;
      sourceStates.push({ material: mat, colorWrite: mat.colorWrite !== false, depthWrite: mat.depthWrite !== false });
      mat.colorWrite = false;
      mat.depthWrite = false;
      mat.needsUpdate = true;
    }
    // Defensive: some UI transitions reapply material state. Guarantee that the
    // original textured OBJ cannot paint the black framebuffer path over proxy.
    const sourceOnBeforeRender = source.onBeforeRender;
    source.onBeforeRender = function(...args) {
      const mats = viewportMaterialList(this.material);
      for (const mat of mats) {
        if (!mat) continue;
        mat.colorWrite = false;
        mat.depthWrite = false;
        mat.needsUpdate = true;
      }
      if (typeof sourceOnBeforeRender === 'function') {
        try { sourceOnBeforeRender.apply(this, args); } catch (_) {}
      }
      for (const mat of mats) {
        if (!mat) continue;
        mat.colorWrite = false;
        mat.depthWrite = false;
      }
    };
    suppressedSourceMeshes++;
    records.push({ source, proxy, sourceStates, proxyMats, sourceOnBeforeRender });
  });

  if (!records.length) return null;
  core.scene.add(group);

  const sync = () => {
    try { robot.updateMatrixWorld?.(true); } catch (_) {}
    for (const record of records) {
      const source = record.source;
      const proxy = record.proxy;
      if (!source || !proxy) continue;
      proxy.visible = source.visible !== false && source.userData?.__automindVisibilityTarget !== false;
      proxy.matrix.copy(source.matrixWorld);
      proxy.matrixWorldNeedsUpdate = true;
      const sourceMats = viewportMaterialList(source.material);
      const proxyMats = viewportMaterialList(proxy.material);
      for (let i = 0; i < proxyMats.length; i++) {
        const src = sourceMats[i] || sourceMats[0];
        const pm = proxyMats[i];
        if (!pm || !src) continue;
        const isViewportBake = !!pm.userData?.__automindViewportProxyMaterial;
        if (isViewportBake) {
          pm.opacity = 1;
          pm.transparent = false;
          pm.depthWrite = true;
          pm.depthTest = true;
          pm.alphaTest = 0;
          pm.side = (src && src.side != null) ? src.side : THREE.FrontSide;
        } else {
          pm.opacity = Number.isFinite(src.opacity) ? src.opacity : 1;
          pm.transparent = !!src.transparent || pm.opacity < 0.999;
          pm.depthWrite = src.depthWrite !== false && pm.opacity >= 0.999;
          pm.depthTest = true;
          pm.alphaTest = Number.isFinite(src.alphaTest) ? src.alphaTest : 0;
          pm.side = (src && src.side != null) ? src.side : THREE.FrontSide;
        }
        pm.wireframe = !!src.wireframe;
        pm.toneMapped = false;
        pm.needsUpdate = true;
      }
    }
    try { group.updateMatrixWorld?.(true); } catch (_) {}
  };

  core.scene.userData = core.scene.userData || {};
  core.scene.userData.__automindBeforeVisibleRender = sync;
  sync();
  const report = {
    enabled: true,
    mode: bakeVertexColors ? 'uv_vertex_colors' : 'fallback_flat_colors',
    sourceMeshes: records.length,
    proxyMeshes: records.length,
    mappedProxyMeshes,
    vertexBakedProxyMeshes,
    fallbackColorProxyMeshes,
    suppressedSourceMeshes,
    note: 'Visible viewport avoids CanvasTexture sampling; maps are CPU-baked from decoded canvas pixels.'
  };
  core.__automindViewportTextureProxy = { group, records, sync, report };
  window.AutoMindMJCFViewportTextureProxyReport = report;
  console.info('[AutoMind MJCF] Puente de texturas del viewport:', report);
  return core.__automindViewportTextureProxy;
}

function rememberMaterialBaseState(mat) {
  if (!mat) return;
  const ud = ensureMaterialUserData(mat);
  repairTexturedMaterial(mat);
  const op = Number.isFinite(mat.opacity) ? Math.max(0, mat.opacity) : 1;
  // The first stable material state is the canonical restoration state.
  // Never overwrite it with a mid-fade value from rapid panel clicks.
  if (!Number.isFinite(ud.__automindBaseOpacity)) ud.__automindBaseOpacity = op > 0 ? op : 1;
  if (typeof ud.__automindBaseTransparent !== 'boolean') ud.__automindBaseTransparent = !!mat.transparent;
  if (typeof ud.__automindBaseDepthWrite !== 'boolean') ud.__automindBaseDepthWrite = mat.depthWrite !== false;
  if (typeof ud.__automindBaseDepthTest !== 'boolean') ud.__automindBaseDepthTest = mat.depthTest !== false;
}

function ensureUniqueVisibilityMaterials(mesh) {
  if (!mesh || !mesh.material) return [];
  // MJCFCore assigns a private material clone to every visual mesh at import time.
  // A second clone while isolating a component was the source of texture loss in
  // some Three r132/Colab paths, so preserve the existing textured material.
  mesh.userData.__automindVisibilityMaterialUnique = true;
  const mats = materialList(mesh.material);
  for (const mat of mats) rememberMaterialBaseState(mat);
  return mats;
}

function baseOpacityFor(mat) {
  // CAD/Inventor parts should be opaque in Solid mode. Some DAE materials arrive
  // with accidental alpha/transparency, which looks like a white fog layer on the
  // Colab canvas. Keep X-Ray/Ghost controlled by render mode, not by bad CAD alpha.
  if (!mat?.alphaMap && !(Number.isFinite(mat?.alphaTest) && mat.alphaTest > 0.001)) return 1;
  const ud = ensureMaterialUserData(mat);
  const base = Number.isFinite(ud.__automindBaseOpacity) ? ud.__automindBaseOpacity : 1;
  return Math.max(0, base);
}

function currentOpacityFor(mat) {
  return Number.isFinite(mat?.opacity) ? Math.max(0, mat.opacity) : 1;
}

function currentRenderModeFor(core) {
  const mode = String(core?.__currentRenderMode || 'Solid');
  if (/^x[- ]?ray$/i.test(mode)) return 'X-Ray';
  if (/^ghost$/i.test(mode)) return 'Ghost';
  if (/^wireframe$/i.test(mode)) return 'Wireframe';
  return 'Solid';
}

function renderModeVisibleOpacity(core, mat) {
  const mode = currentRenderModeFor(core);
  if (mode === 'X-Ray') return 0.35;
  if (mode === 'Ghost') return 0.70;
  return baseOpacityFor(mat);
}

function applyRenderModeMaterialState(core, mat) {
  if (!mat) return;
  repairTexturedMaterial(mat);
  const mode = currentRenderModeFor(core);
  const opacity = renderModeVisibleOpacity(core, mat);
  const hasAlpha = !!mat.alphaMap || (Number.isFinite(mat.alphaTest) && mat.alphaTest > 0.001);

  // BUILD161: hard anti-fog material contract.
  // Solid/Wireframe must be truly opaque. X-Ray/Ghost are the only modes allowed
  // to create transparency, so Show all cannot pass through a temporary ghost state.
  mat.wireframe = (mode === 'Wireframe');
  mat.depthTest = true;
  if ('toneMapped' in mat) mat.toneMapped = false;
  if ('blending' in mat) mat.blending = THREE.NormalBlending;
  if ('premultipliedAlpha' in mat) mat.premultipliedAlpha = false;
  if ('transmission' in mat) mat.transmission = 0;
  if ('clearcoat' in mat) mat.clearcoat = Math.min(Number(mat.clearcoat) || 0, 0.25);
  if ('envMapIntensity' in mat && Number.isFinite(mat.envMapIntensity)) mat.envMapIntensity = Math.min(mat.envMapIntensity, 0.45);
  if (mat.map && mat.color) {
    // BUILD163: preserve the DAE diffuse tint. Many CAD/Inventor exports store
    // the real paint color in material.diffuse and use a grayscale/light texture
    // only for shading/detail. Forcing color=white made red/black parts look
    // gray/washed out, like a fake fog layer.
    try { if (!mat.userData) mat.userData = {}; if (!mat.userData.__automindDiffusePreserved) mat.userData.__automindDiffusePreserved = mat.color.clone?.(); } catch (_) {}
  }

  if (mode === 'X-Ray' || mode === 'Ghost') {
    mat.transparent = true;
    mat.opacity = opacity;
    mat.depthWrite = false;
  } else {
    mat.transparent = hasAlpha ? ((typeof ensureMaterialUserData(mat).__automindBaseTransparent === 'boolean') ? ensureMaterialUserData(mat).__automindBaseTransparent : false) : false;
    mat.opacity = hasAlpha ? opacity : 1;
    mat.depthWrite = true;
  }
  mat.needsUpdate = true;
}

function restoreMeshToCurrentRenderMode(core, mesh, targetVisible = true) {
  if (!mesh || !mesh.isMesh || !mesh.geometry || mesh.userData?.__isHoverOverlay) return;
  const mats = ensureUniqueVisibilityMaterials(mesh);
  mesh.userData.__automindVisibilityTarget = !!targetVisible;
  mesh.visible = !!targetVisible;
  for (const mat of mats) {
    if (!mat) continue;
    if (targetVisible) applyRenderModeMaterialState(core, mat);
    else {
      mat.transparent = true;
      mat.opacity = 0;
      mat.depthWrite = false;
      mat.depthTest = true;
      mat.needsUpdate = true;
    }
  }
}

function restoreAllMeshesToCurrentRenderMode(core) {
  const meshes = collectRobotMeshes(core?.robot);
  visibilityTweenToken++;
  cancelVisibilityFrame();
  for (const mesh of meshes) restoreMeshToCurrentRenderMode(core, mesh, true);
  try { core?.renderer?.render?.(core.scene, core.camera); } catch (_) {}
}


function cancelVisibilityFrame() {
  if (visibilityRAF) {
    try { cancelAnimationFrame(visibilityRAF); } catch (_) {}
    visibilityRAF = 0;
  }
}

function finalizeVisibilityStates(core, states, finalVisibleMeshes, finalHiddenMeshes, token, after = null) {
  if (token !== visibilityTweenToken) return;

  for (const st of states || []) {
    const ud = ensureMaterialUserData(st.mat);
    if (st.targetVisible) {
      applyRenderModeMaterialState(core, st.mat);
    } else {
      st.mat.opacity = 0;
      st.mat.transparent = true;
      st.mat.depthWrite = false;
      st.mat.depthTest = (typeof ud.__automindBaseDepthTest === 'boolean') ? ud.__automindBaseDepthTest : true;
    }
    st.mat.needsUpdate = true;
  }

  for (const mesh of finalVisibleMeshes || []) {
    mesh.visible = true;
    mesh.userData.__automindVisibilityTarget = true;
  }
  for (const mesh of finalHiddenMeshes || []) {
    mesh.visible = false;
    mesh.userData.__automindVisibilityTarget = false;
  }

  try { after?.(); } catch (_) {}
  try { core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  try { core?.renderer?.render?.(core.scene, core.camera); } catch (_) {}
}

function normalizeMeshVisibilityHard(mesh, targetVisible) {
  if (!mesh || !mesh.isMesh || !mesh.geometry || mesh.userData?.__isHoverOverlay) return;
  const mats = ensureUniqueVisibilityMaterials(mesh);
  mesh.visible = !!targetVisible;
  mesh.userData.__automindVisibilityTarget = !!targetVisible;
  for (const mat of mats) {
    const ud = ensureMaterialUserData(mat);
    const targetOpacity = targetVisible ? renderModeVisibleOpacity(null, mat) : 0;
    if (targetVisible) {
      // Hard normalization is used mostly as a fallback/reset; preserve the
      // material's original solid/wireframe flags if no viewer core is available.
      mat.opacity = targetOpacity;
      mat.transparent = (typeof ud.__automindBaseTransparent === 'boolean') ? ud.__automindBaseTransparent : targetOpacity < 1;
      mat.depthWrite = (typeof ud.__automindBaseDepthWrite === 'boolean') ? ud.__automindBaseDepthWrite : true;
      mat.depthTest = (typeof ud.__automindBaseDepthTest === 'boolean') ? ud.__automindBaseDepthTest : true;
    } else {
      mat.opacity = 0;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.depthTest = (typeof ud.__automindBaseDepthTest === 'boolean') ? ud.__automindBaseDepthTest : true;
    }
    mat.needsUpdate = true;
  }
}

function animateMeshVisibility(core, meshes, shouldBeVisible, duration = 540, after = null) {
  // Transaction model: every user action declares the whole desired final state.
  // Old fades are cancelled immediately; unfinished mid-fade opacities are only used
  // as the new start value, never as the new canonical opacity. This prevents rapid
  // component clicks + Show all from leaving semi-hidden or logically stale meshes.
  const token = ++visibilityTweenToken;
  const serial = ++visibilityActionSerial;
  cancelVisibilityFrame();

  const states = [];
  const finalVisibleMeshes = new Set();
  const finalHiddenMeshes = new Set();
  const uniqueMeshes = Array.from(new Set((meshes || []).filter(m => m && m.isMesh && m.geometry && !m.userData?.__isHoverOverlay)));

  for (const mesh of uniqueMeshes) {
    const targetVisible = typeof shouldBeVisible === 'function' ? !!shouldBeVisible(mesh) : !!shouldBeVisible;
    const wasMeshVisible = mesh.visible !== false;
    const wasTargetVisible = mesh.userData.__automindVisibilityTarget !== false;
    mesh.userData.__automindVisibilitySerial = serial;
    mesh.userData.__automindVisibilityTarget = targetVisible;

    const mats = ensureUniqueVisibilityMaterials(mesh);
    const hasVisibleOpacity = mats.some(mat => currentOpacityFor(mat) > 0.02);

    if (targetVisible) {
      mesh.visible = true;
      finalVisibleMeshes.add(mesh);

      // BUILD166: Show all must not briefly put already-visible Solid/Wireframe
      // parts into a transparent/ghost-like intermediate state. Only meshes that
      // were actually hidden are faded in. Meshes already visible are immediately
      // normalized to the active render mode and skipped from the opacity tween.
      if (wasMeshVisible && wasTargetVisible && hasVisibleOpacity) {
        for (const mat of mats) {
          rememberMaterialBaseState(mat);
          applyRenderModeMaterialState(core, mat);
        }
        continue;
      }
    } else {
      // Keep it visible while fading out; only hide at transaction finalization.
      mesh.visible = true;
      finalHiddenMeshes.add(mesh);
    }

    for (const mat of mats) {
      if (!mat) continue;
      rememberMaterialBaseState(mat);
      const startOpacity = (wasMeshVisible && wasTargetVisible) ? currentOpacityFor(mat) : 0;
      const targetOpacity = targetVisible ? renderModeVisibleOpacity(core, mat) : 0;

      // Set render-mode geometry flags before starting the fade so hidden pieces
      // do not appear in the wrong mode while they are becoming visible.
      const mode = currentRenderModeFor(core);
      mat.wireframe = (mode === 'Wireframe');
      mat.depthTest = true;
      if ('toneMapped' in mat) mat.toneMapped = false;
      if ('blending' in mat) mat.blending = THREE.NormalBlending;
      if ('premultipliedAlpha' in mat) mat.premultipliedAlpha = false;
      mat.transparent = true;
      mat.depthWrite = false;
      mat.opacity = startOpacity;
      mat.needsUpdate = true;

      states.push({ mesh, mat, startOpacity, targetOpacity, targetVisible });
    }
  }

  if (!states.length || !duration || duration <= 0) {
    finalizeVisibilityStates(core, states, finalVisibleMeshes, finalHiddenMeshes, token, after);
    return;
  }

  const t0 = performance.now();
  function step(now) {
    if (token !== visibilityTweenToken) return;
    const u = Math.min(1, (now - t0) / Math.max(1, duration));
    const k = easeInOutCubic(u);

    for (const st of states) {
      if (st.mesh.userData.__automindVisibilitySerial !== serial) continue;
      st.mat.opacity = THREE.MathUtils.lerp(st.startOpacity, st.targetOpacity, k);
      st.mat.needsUpdate = true;
    }

    try { core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
    try { core?.renderer?.render?.(core.scene, core.camera); } catch (_) {}

    if (u < 1) {
      visibilityRAF = requestAnimationFrame(step);
      return;
    }

    visibilityRAF = 0;
    finalizeVisibilityStates(core, states, finalVisibleMeshes, finalHiddenMeshes, token, after);
  }
  visibilityRAF = requestAnimationFrame(step);
}

function showAll(core) {
  if (!core.robot) return;
  core.__componentViewFocusMeshes = null;
  core.__componentViewFocusObject = null;
  try { core.setMechanismSuppressed?.(false, 0); } catch (_) {}

  // BUILD166: Show all only fades meshes that were actually hidden; already
  // visible Solid/Wireframe meshes stay in the active render mode with no instant
  // transparent/ghost flash. Camera always travels smoothly to the same Iso view.
  const meshes = collectRobotMeshes(core.robot);
  animateMeshVisibility(core, meshes, true, 420, () => restoreAllMeshesToCurrentRenderMode(core));
  try { core?.interaction?.clearHover?.(); core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  viewPreset(core, 'iso', core.robot, 780);
}


function fitSphereFromMeshes(meshes) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let has = false;
  for (const m of meshes || []) {
    if (!m || !m.geometry || m.userData?.__isHoverOverlay) continue;
    tmp.setFromObject(m);
    if (tmp.isEmpty()) continue;
    if (!has) { box.copy(tmp); has = true; } else box.union(tmp);
  }
  if (!has) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-9);
  const radius = Math.max(size.length() * 0.5, maxDim * 0.5, 1e-6);
  return { center, size, radius, maxDim, box };
}

function fitSphereFromObject(object) {
  if (!object) return null;
  const box = objectBox(object);
  if (!box) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z, 1e-9);
  const radius = Math.max(size.length() * 0.5, maxDim * 0.5, 1e-6);
  return { center, size, radius, maxDim, box };
}

function currentViewFitSphere(core) {
  // If a component was selected through the Components panel, camera view buttons
  // should frame that isolated part. Once Show all is used, the focus is cleared
  // and view buttons frame the full model again.
  const focused = core?.__componentViewFocusMeshes;
  if (Array.isArray(focused) && focused.length) {
    const s = fitSphereFromMeshes(focused.filter(m => m && m.visible !== false));
    if (s) return s;
  }
  return fitSphereFromObject(core?.robot);
}

function frameMeshes(core, meshes, duration = 680) {
  const s = fitSphereFromMeshes(meshes);
  if (!s) return false;
  const { center, radius, maxDim } = s;
  const cam = core.camera;
  const az = Math.PI * 0.25;
  const el = Math.PI * 0.20;
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  let dist;
  let projectionTarget = null;
  if (cam.isOrthographicCamera) {
    dist = Math.max(radius * 5.0, maxDim * 4.0, 0.25);
    const aspect = Math.max(1e-6, (core.renderer?.domElement?.clientWidth || 1) / (core.renderer?.domElement?.clientHeight || 1));
    const halfH = Math.max(radius * 1.65, maxDim * 1.25, 0.05);
    projectionTarget = {
      left: -halfH * aspect, right: halfH * aspect, top: halfH, bottom: -halfH,
      near: Math.min(cam.near, -Math.max(1000, halfH * 100)),
      far: Math.max(cam.far, Math.max(1000, halfH * 100))
    };
  } else {
    dist = distanceToFitSphere(cam, radius, 2.65);
  }
  dist = THREE.MathUtils.clamp(dist, 0.05, 1e6);
  return tweenCamera(core, center.clone().add(dir.multiplyScalar(dist)), center, duration, projectionTarget);
}
function isolateMeshesSmooth(core, meshesToKeep, duration = 560) {
  if (!core.robot) return;
  const allMeshes = collectRobotMeshes(core.robot);
  const keep = new Set((meshesToKeep || []).filter(m => m && m.isMesh && m.geometry && !m.userData?.__isHoverOverlay));
  const kept = Array.from(keep);
  core.__componentViewFocusMeshes = kept.length ? kept : null;
  try { core.setMechanismSuppressed?.(kept.length > 0, duration); } catch (_) {}
  animateMeshVisibility(core, allMeshes, mesh => keep.has(mesh), duration, () => {
    try { core?.interaction?.clearHover?.(); core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  });
  if (kept.length) frameMeshes(core, kept, 820);
}

function isolateAsset(core, assetToMeshes, assetKey) {
  if (!core.robot) return;
  isolateMeshesSmooth(core, assetToMeshes.get(assetKey) || [], 560);
}

function isolateLink(core, linkObj) {
  if (!core.robot || !linkObj) return;
  isolateMeshesSmooth(core, collectMeshesInObject(linkObj), 560);
}

function buildThumbnailer(core, assetToMeshes) {
  // V11: merged with the original MJCF thumbnail mechanism.
  // Do NOT create a new WebGLRenderer per component. Reuse the visible viewer
  // renderer with a WebGLRenderTarget, so Colab/Chrome does not run out of WebGL
  // contexts and thumbnails do not fall back to the broken alt text.
  const cache = new Map();
  const W = 320, H = 240;
  const BG_COLOR = 0xf3f8f9;
  const EDGE_COLOR = 0x0b3b3c;

  function materialList(mat) { return !mat ? [] : (Array.isArray(mat) ? mat.filter(Boolean) : [mat]); }
  function hasLoadedImage(tex) {
    const img = tex?.image;
    return !!(img && (
      (typeof img.naturalWidth === 'number' && img.naturalWidth > 0) ||
      (typeof img.width === 'number' && img.width > 0) ||
      img.complete === true
    ));
  }
  function textureSource(tex) {
    const img = tex?.image;
    return String(img?.currentSrc || img?.src || tex?.source?.data?.src || '');
  }
  function textureLooksBroken(tex) {
    if (!tex) return false;
    const src = textureSource(tex);
    if (src && src === AUTOMIND_EMPTY_TEXTURE_URL) return true;
    // Keep valid base64/blob texture references even before decode completes; the
    // thumbnailer waits for them, and dropping them here made cards appear white.
    if (tex.isDataTexture || /^(data:image\/|blob:|https?:\/\/)/i.test(src)) return false;
    return !hasLoadedImage(tex);
  }
  function collectTextureMaps(meshes) {
    const maps = [];
    const seen = new Set();
    for (const mesh of meshes || []) {
      for (const m of materialList(mesh?.material)) {
        for (const k of ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap']) {
          const tex = m && m[k];
          if (tex && !seen.has(tex)) { seen.add(tex); maps.push(tex); }
        }
      }
    }
    return maps;
  }
  async function waitForTextures(meshes, timeoutMs = 2000) {
    const maps = collectTextureMaps(meshes).filter(t => t && !textureLooksBroken(t));
    if (!maps.length) return { maps, loaded: true };
    const t0 = performance.now();
    await Promise.all(maps.map(async (tex) => {
      const img = tex?.image;
      if (tex?.isDataTexture || hasLoadedImage(tex)) return;
      if (img && typeof img.decode === 'function') {
        try { await Promise.race([img.decode(), sleep(Math.min(140, timeoutMs))]); } catch (_) {}
      }
    }));
    await new Promise(resolve => {
      const tick = () => {
        if (maps.every(t => t.isDataTexture || hasLoadedImage(t)) || performance.now() - t0 > timeoutMs) resolve();
        else setTimeout(tick, 2);
      };
      tick();
    });
    for (const tex of maps) { try { tex.needsUpdate = true; } catch (_) {} }
    await waitFrames(1);
    await sleep(3);
    return { maps, loaded: maps.every(t => t.isDataTexture || hasLoadedImage(t)) };
  }
  function cloneMaterialForPreview(src) {
    // Preserve the exact texture object from the visible mesh. This mirrors the
    // USD viewer thumbnail path and avoids reconstructing/re-dropping dataURL maps.
    if (src?.map && !textureLooksBroken(src.map)) {
      try { src.map.needsUpdate = true; } catch (_) {}
      const mat = new THREE.MeshBasicMaterial({
        map: src.map,
        // Preserve CAD diffuse tint in thumbnails too. This keeps thumbnails and
        // viewport visually consistent with the older non-gray viewer.
        color: (src.color && typeof src.color.clone === 'function') ? src.color.clone() : new THREE.Color(0xffffff),
        side: THREE.DoubleSide,
        transparent: !!src.alphaMap || (Number.isFinite(src.alphaTest) && src.alphaTest > 0.001),
        opacity: 1,
        alphaTest: Number.isFinite(src.alphaTest) ? src.alphaTest : 0
      });
      mat.toneMapped = false;
      mat.needsUpdate = true;
      return mat;
    }
    let mat = null;
    if (src && typeof src.clone === 'function') mat = src.clone();
    else mat = new THREE.MeshStandardMaterial({ color: 0xdfe8ea, roughness: 0.55, metalness: 0.04 });
    for (const k of ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap']) {
      if (mat[k] && textureLooksBroken(mat[k])) mat[k] = null;
    }
    mat.side = THREE.DoubleSide;
    if (!mat.alphaMap && !(Number.isFinite(mat.alphaTest) && mat.alphaTest > 0.001)) {
      mat.transparent = false;
      mat.opacity = 1;
      mat.depthWrite = true;
    }
    try { if ('toneMapped' in mat) mat.toneMapped = false; } catch (_) {}
    if (mat.color) {
      const c = mat.color;
      if (c.r > 0.92 && c.g > 0.92 && c.b > 0.92 && !mat.map) mat.color = new THREE.Color(0xe1e8ea);
      if (c.r < 0.030 && c.g < 0.030 && c.b < 0.030 && !mat.map) mat.color = new THREE.Color(0xdfe8ea);
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
        mats.forEach((m) => m?.dispose?.());
      }
      if (o?.isLineSegments && o.material) o.material.dispose?.();
      if (o?.userData?.__ownedEdgeGeometry) o.geometry?.dispose?.();
    });
  }
  async function renderSceneToDataURL(scene, camera) {
    const renderer = core?.renderer;
    if (!renderer) return '';
    const oldTarget = renderer.getRenderTarget?.() || null;
    const oldViewport = renderer.getViewport ? renderer.getViewport(new THREE.Vector4()) : null;
    const oldScissor = renderer.getScissor ? renderer.getScissor(new THREE.Vector4()) : null;
    const oldScissorTest = renderer.getScissorTest ? renderer.getScissorTest() : false;
    const oldClear = renderer.getClearColor ? renderer.getClearColor(new THREE.Color()) : new THREE.Color(0xffffff);
    const oldAlpha = renderer.getClearAlpha ? renderer.getClearAlpha() : 1;
    const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, stencilBuffer: false });
    const pixels = new Uint8Array(W * H * 4);
    try {
      // BUILD158: give ImageTexture -> WebGLTexture upload enough time before
      // readRenderTargetPixels. Without this, Colab sometimes captures the
      // component between image decode and GPU upload, producing white thumbnails.
      await sleep(3);
      await waitFrames(1);
      renderer.setRenderTarget(rt);
      renderer.setViewport(0, 0, W, H);
      renderer.setScissorTest(false);
      renderer.setClearColor(BG_COLOR, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, pixels);
    } catch (e) {
      debugLog('[thumb] render target failed', String(e));
      return '';
    } finally {
      try { renderer.setRenderTarget(oldTarget); } catch (_) {}
      try { if (oldViewport) renderer.setViewport(oldViewport); } catch (_) {}
      try { if (oldScissor) renderer.setScissor(oldScissor); } catch (_) {}
      try { renderer.setScissorTest(oldScissorTest); } catch (_) {}
      try { renderer.setClearColor(oldClear, oldAlpha); } catch (_) {}
      try { rt.dispose(); } catch (_) {}
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4;
        const dst = y * W * 4;
        imgData.data.set(pixels.subarray(src, src + W * 4), dst);
      }
      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (e) {
      debugLog('[thumb] canvas encode failed', String(e));
      return '';
    }
  }

  async function renderThumbnailNow(assetKey) {
    if (cache.has(assetKey)) return cache.get(assetKey);
    const meshes = assetToMeshes.get(assetKey) || [];
    if (!meshes.length) return '';
    const texStatus = await waitForTextures(meshes);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG_COLOR);
    // BUILD162: thumbnails use ONLY THEME.lighting, same as the viewport.
    const l = THEME.lighting || {};
    const amb = l.ambient || { color: 0xffffff, intensity: 0.9 };
    const keyCfg = l.key || { color: 0xffffff, intensity: 0.75, position: [3, 5, 4] };
    const fillCfg = l.fill || { color: 0xffffff, intensity: 0.35, position: [-4, 2, -3] };
    scene.add(new THREE.AmbientLight(amb.color ?? 0xffffff, Number(amb.intensity ?? 0.9)));
    const key = new THREE.DirectionalLight(keyCfg.color ?? 0xffffff, Number(keyCfg.intensity ?? 0.75));
    key.position.set(...(Array.isArray(keyCfg.position) ? keyCfg.position : [3, 5, 4]));
    scene.add(key);
    const fill = new THREE.DirectionalLight(fillCfg.color ?? 0xffffff, Number(fillCfg.intensity ?? 0.35));
    fill.position.set(...(Array.isArray(fillCfg.position) ? fillCfg.position : [-4, 2, -3]));
    scene.add(fill);

    const root = new THREE.Group();
    scene.add(root);
    for (const mesh of meshes) { try { mesh.updateMatrixWorld(true); } catch (_) {} }
    for (const mesh of meshes) {
      if (!mesh || !mesh.geometry) continue;
      const srcMats = materialList(mesh.material);
      const previewMat = Array.isArray(mesh.material) ? srcMats.map(cloneMaterialForPreview) : cloneMaterialForPreview(srcMats[0]);
      const c = new THREE.Mesh(mesh.geometry, previewMat);
      c.matrixAutoUpdate = false;
      c.matrix.copy(mesh.matrixWorld);
      c.renderOrder = 1;
      root.add(c);
      try {
        const eg = new THREE.EdgesGeometry(mesh.geometry, 20);
        const em = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.68 });
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

    try {
      const url = await renderSceneToDataURL(scene, camera);
      if (typeof url === 'string' && /^data:image\/png;base64,/i.test(url) && url.length > 64) {
        if (!texStatus.maps.length || texStatus.loaded) cache.set(assetKey, url);
        else setTimeout(() => { try { cache.delete(assetKey); } catch (_) {} }, 30);
        return url;
      }
      return '';
    } catch (e) {
      debugLog('[thumb] failed', assetKey, String(e));
      return '';
    } finally {
      disposePreview(root);
    }
  }
  let thumbnailQueue = Promise.resolve();
  async function thumbnail(assetKey) {
    const job = () => renderThumbnailNow(assetKey);
    const p = thumbnailQueue.then(job, job);
    // Keep the queue alive even if one thumbnail fails.
    thumbnailQueue = p.catch(() => {});
    return p;
  }
  async function primeAll(keys) { for (const k of keys || []) { try { await thumbnail(k); await sleep(3); } catch (_) {} } }
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
    selectMode = 'link',
    background = (THEME.colors?.canvasBg ?? THEME.bgCanvas ?? 0xffffff),
    pixelRatio = Math.min(window.devicePixelRatio || 1, 2),
    IA_Widgets = false,
  } = opts;

  if (!container) throw new Error('[urdfplus_viewer_main] opts.container is required');
  debugLog('render init', {
    mode: 'MJCF BUILD187_UPSTREAM_PROPAGATION',
    selectMode,
    IA_Widgets,
    hasZip: !!(opts.MJCF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64),
    hasMJCF: !!(opts.urdfContent || opts.urdfText || opts.robotXml),
    assetCount: Object.keys(opts.assetDB || {}).length
  });

  const core = createViewer({ container, background, pixelRatio });
  let robot = null;
  let assetToMeshes = new Map();
  let thumbs = null;
  let tools = null;
  let comps = null;

  const inter = attachInteraction({
    scene: core.scene,
    camera: () => core.camera,
    renderer: core.renderer,
    controls: core.controls,
    robot: null,
    selectMode,
    getSectionPlane: () => app?.sectionPlane || null,
    onSelectLink: () => { try { app?.interaction?.refreshSelectionMarker?.(); } catch (_) {} }
  });
  core.interaction = inter;

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
    setMechanismToggles: (...args) => core.setMechanismToggles(...args),
    setMechanismClippingPlane: (...args) => core.setMechanismClippingPlane?.(...args),
    setMechanismSuppressed: (...args) => core.setMechanismSuppressed?.(...args),
    setProjection: (...args) => core.setProjection(...args),
    setRenderModeState: (mode) => { core.__currentRenderMode = String(mode || 'Solid'); },
    getCurrentRenderMode: () => core.__currentRenderMode || 'Solid',
    IA_Widgets,
    debug: !!opts.debug,
    options: opts,
    sectionPlane: null,
    getSectionPlane: () => app?.sectionPlane || null,
    interaction: inter,
    clearSelection: () => inter?.clearSelection?.(),
    selectAsset(assetKey) {
      const meshes = assetToMeshes?.get?.(assetKey) || [];
      for (const mesh of meshes) {
        let node = mesh;
        while (node && !node.userData?.__linkName) node = node.parent;
        const linkName = node?.userData?.__linkName || '';
        if (linkName && inter?.selectLink?.(linkName)) return true;
      }
      return false;
    },
    componentDescriptions: {},
    assets: {
      list: () => listAssets(assetToMeshes),
      thumbnail: (assetKey) => thumbs?.thumbnail(assetKey) || '',
    },
    isolate: {
      asset: (assetKey) => isolateAsset(core, assetToMeshes, assetKey),
      link: (linkObj) => isolateLink(core, linkObj),
      clear: () => showAll(core),
    },
    showAll: () => showAll(core),
    viewPreset: (kind = 'iso', duration = 780) => viewPreset(core, kind, core.robot, duration),
    viewIso: () => viewPreset(core, 'iso', core.robot, 780),
    getCurrentViewFitSphere: () => currentViewFitSphere(core),
    hasComponentViewFocus: () => Array.isArray(core.__componentViewFocusMeshes) && core.__componentViewFocusMeshes.length > 0,
    clearComponentViewFocus: () => { core.__componentViewFocusMeshes = null; },
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
      const items = app.assets.list();
      Base64Images.length = 0;
      for (const it of items) {
        const url = await app.assets.thumbnail(it.assetKey);
        const b64 = String(url || '').split(',')[1] || '';
        if (b64) Base64Images.push(b64);
        await sleep(3);
      }
      window.Base64Images = Base64Images;
      return Base64Images;
    },
  };

  tools = createToolsDock(app, THEME);
  comps = createComponentsPanel(app, THEME);
  app.openTools = (open = true) => tools.set?.(!!open);

  app.ready = (async () => {
    try {
      robot = await loadMJCFModel(opts);
      if (core.robot) {
        try { core.scene.remove(core.robot); } catch (_) {}
      }
      core.robot = robot;
      core.scene.add(robot);
      // BUILD164: viewport colors must match thumbnails. If any late-loaded DAE
      // material escaped the MJCFPlusCore conversion, keep it opaque/unlit here.
      try {
        robot.traverse?.((o) => {
          if (!o?.isMesh || !o.material || o.userData?.__isHoverOverlay) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m) continue;
            rememberMaterialBaseState(m);
            repairTexturedMaterial(m);
            // Reconstruct only malformed color/vector fields before Three uploads
            // standard material uniforms on the next frame.
            try {
              if (m.color && !m.color.isColor) m.color = new THREE.Color(m.color);
              if (m.emissive && !m.emissive.isColor) m.emissive = new THREE.Color(m.emissive);
              if (m.normalScale && !m.normalScale.isVector2) m.normalScale = new THREE.Vector2(1, 1);
              if (m.clearcoatNormalScale && !m.clearcoatNormalScale.isVector2) m.clearcoatNormalScale = new THREE.Vector2(1, 1);
            } catch (_) {}
            if ('toneMapped' in m) m.toneMapped = false;
            if (m.map) {
              try { if ('colorSpace' in m.map && THREE.SRGBColorSpace) m.map.colorSpace = THREE.SRGBColorSpace; } catch (_) {}
              try { if ('encoding' in m.map && THREE.sRGBEncoding) m.map.encoding = THREE.sRGBEncoding; } catch (_) {}
              try { m.map.needsUpdate = true; } catch (_) {}
            }
            if (!m.alphaMap && !(Number.isFinite(m.alphaTest) && m.alphaTest > 0.001)) { m.transparent = false; m.opacity = 1; m.depthWrite = true; }
            m.needsUpdate = true;
          }
        });
      } catch (_) {}
      // BUILD184: the card thumbnails prove that these maps decode correctly.
      // Route the visible viewport through the same MeshBasic+map presentation
      // path, without disabling the original kinematic/pickable meshes.
      try { createViewportTextureProxy(core, robot, opts.viewportTextureProxy !== false, opts.vertexColorTextureBake !== false); } catch (proxyError) {
        console.warn('[AutoMind MJCF] No se pudo activar el puente de texturas del viewport:', proxyError);
      }
      try { core.refreshRobotContext?.(robot); } catch (_) {}
      assetToMeshes = robot.assetToMeshes || new Map();
      thumbs = buildThumbnailer(core, assetToMeshes);
      inter.setRobot(robot);
      robot.applyPose?.();
      core.fitAndCenter(robot, 1.08);
      try { core.setMechanismToggles?.({ jointAxes: false, loops: false }); } catch (_) {}
      // Do not re-enter the visible WebGL renderer immediately after model load.
      // In Chromium/Colab that concurrent thumbnail warm-up can race the first
      // texture upload and leave standard-material uniforms in a bad state.
      // Thumbnails are generated lazily when IA Widgets explicitly need them, or
      // when callers opt in with eagerThumbnails: true.
      if (opts.eagerThumbnails === true) {
        setTimeout(() => { try { thumbs.primeAll(Array.from(assetToMeshes.keys())); } catch (_) {} }, 250);
      }
      maybeSetupIA(app, assetToMeshes, thumbs);
      debugLog('MJCF loaded BUILD211_LOOP_RENDER_AND_DOWNSTREAM_SYNC', {
        robot: robot.name,
        links: Object.keys(robot.links || {}).length,
        joints: Object.keys(robot.joints || {}).length,
        loops: (robot.loopJoints || []).length,
        couplings: (robot.couplings || []).length,
        components: assetToMeshes.size
      });
      return app;
    } catch (err) {
      debugLog('MJCF load error', err?.stack || err?.message || String(err));
      const box = document.createElement('pre');
      box.textContent = 'AutoMind MJCF load error:\n' + (err?.stack || err?.message || String(err));
      Object.assign(box.style, {
        position: 'absolute', left: '14px', top: '14px', right: '14px', zIndex: '999999',
        margin: '0', padding: '12px', maxHeight: '45%', overflow: 'auto', whiteSpace: 'pre-wrap',
        background: '#fff5f5', color: '#7a1111', border: '1px solid #f3b3b3', borderRadius: '12px',
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
      });
      container.appendChild(box);
      throw err;
    }
  })();

  if (typeof window !== 'undefined') {
    window.MJCFViewer = window.MJCFViewer || {};
    window.MJCFViewer.__app = app;
    window.MJCFViewer.__build = 'BUILD187_UPSTREAM_PROPAGATION';
    window.AutoMindMJCFApp = app;
  }

  return Object.assign(app, {
    resize: core.resize,
    destroy() {
      try { comps?.destroy?.(); } catch (_) {}
      try { tools?.destroy?.(); } catch (_) {}
      try { inter?.destroy?.(); } catch (_) {}
      try { thumbs?.destroy?.(); } catch (_) {}
      try { disposeViewportTextureProxy(core); } catch (_) {}
      try { robot?.assetResolver?.dispose?.(); } catch (_) {}
      try { core.destroy?.(); } catch (_) {}
    }
  });
}

export default { render };
