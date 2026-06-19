// /URDF_Viewer/urdfplus_viewer_main.js
// BUILD168: clean URDF+ viewer, exact-current-camera view tweens + uniform shadow/grid.
// AutoMind URDF+ viewer main entrypoint. Direct modular viewer, direct modular renderer, no legacy DOM adapter.
// Same modular architecture as AutoMindCloudExperimental viewer:
// Theme + ViewerCore + AssetDB + SelectionAndDrag + ToolsDock + ComponentsPanel.

import { THEME } from './Theme.js';
import { createViewer } from './core/ViewerCore.js';
import { attachInteraction } from './interaction/SelectionAndDrag.js';
import { createToolsDock } from './ui/ToolsDock.js';
import { createComponentsPanel } from './ui/ComponentsPanel.js';
import { loadURDFPlusModel } from './core/URDFPlusCore.js';

export let Base64Images = [];
const AUTOMIND_EMPTY_TEXTURE_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function debugLog(...args) {
  const enabled = !!(globalThis?.AutoMindURDFPlusDebug || globalThis?.AUTOMIND_DEBUG);
  try { window.URDFPLUS_DEBUG_LOGS = window.URDFPLUS_DEBUG_LOGS || []; window.URDFPLUS_DEBUG_LOGS.push(args); } catch (_) {}
  if (!enabled) return;
  try { console.log('[URDFPLUS_DEBUG]', ...args); } catch (_) {}
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
function tweenCamera(core, endPos, endTarget, duration = 750) {
  const cam = core.camera, ctrl = core.controls;
  // BUILD168: capture the REAL visible camera pose first, then begin the tween
  // on the first animation frame with u=0. No controls.update(), no fit(), no
  // target recalculation is allowed before this capture, otherwise the camera
  // appears to teleport once before the actual tween starts.
  cameraTweenToken++;
  if (cameraTweenRAF) { try { cancelAnimationFrame(cameraTweenRAF); } catch (_) {} cameraTweenRAF = 0; }
  stopControlsInertia(ctrl);
  const token = cameraTweenToken;
  const startPos = cam.position.clone();
  const startTarget = (ctrl?.target || new THREE.Vector3()).clone();
  const finalTarget = (endTarget || startTarget).clone();
  const finalPos = endPos.clone();
  const startS = offsetToSpherical(startPos.clone().sub(startTarget));
  const endS = offsetToSpherical(finalPos.clone().sub(finalTarget));
  const dAz = angleDeltaShortest(startS.az, endS.az);
  try { ctrl.enabled = false; } catch (_) {}
  cam.up.set(0, 1, 0);

  // Render/lock the exact start pose once so there is no pre-tween frame with a
  // stale TrackballControls target or residual inertia.
  cam.position.copy(startPos);
  if (ctrl?.target) ctrl.target.copy(startTarget);
  try { cam.lookAt(startTarget); } catch (_) {}
  try { core.renderer?.render?.(core.scene, cam); } catch (_) {}

  if (!duration || duration <= 0) {
    cam.position.copy(finalPos);
    if (ctrl?.target) ctrl.target.copy(finalTarget);
    try { ctrl?.update?.(); } catch (_) { try { cam.lookAt(finalTarget); } catch (__) {} }
    try { ctrl.enabled = true; } catch (_) {}
    return true;
  }

  let t0 = null;
  function step(now) {
    if (token !== cameraTweenToken) return;
    if (t0 == null) t0 = now; // first RAF is exactly u=0 from the captured pose
    const u = Math.min(1, (now - t0) / Math.max(1, duration));
    const k = easeInOutCubic(u);
    const target = startTarget.clone().lerp(finalTarget, k);
    const az = startS.az + dAz * k;
    const el = THREE.MathUtils.lerp(startS.el, endS.el, k);
    const r = THREE.MathUtils.lerp(startS.r, endS.r, k);
    const dir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    ).normalize();
    cam.position.copy(target).addScaledVector(dir, r);
    if (ctrl?.target) ctrl.target.copy(target);
    try { ctrl?.update?.(); } catch (_) { try { cam.lookAt(target); } catch (__) {} }
    try { core.renderer?.render?.(core.scene, cam); } catch (_) {}
    if (u < 1) cameraTweenRAF = requestAnimationFrame(step);
    else if (token === cameraTweenToken) {
      cameraTweenRAF = 0;
      stopControlsInertia(ctrl);
      try { ctrl.enabled = true; } catch (_) {}
    }
  }
  cameraTweenRAF = requestAnimationFrame(step);
  return true;
}
function viewPreset(core, kind = 'iso', object = core.robot, duration = 750) {
  if (!core || !object) return false;
  const box = objectBox(object);
  if (!box) return false;
  const target = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = size.length() * 0.5 * (1 / Math.sqrt(3));
  const cam = core.camera;
  updateCameraPlanesForBox(cam, size);

  const currentOffset = cam.position.clone().sub(core.controls?.target || target);
  const current = offsetToSpherical(currentOffset.lengthSq() > 1e-12 ? currentOffset : new THREE.Vector3(1, 0.7, 1));
  const topEps = 1e-3;
  let az = current.az;
  let el = current.el;
  if (kind === 'iso')   { az = Math.PI * 0.25; el = Math.PI * 0.20; }
  if (kind === 'top')   { az = Math.round(current.az / (Math.PI / 2)) * (Math.PI / 2); el = Math.PI / 2 - topEps; }
  if (kind === 'front') { az = Math.PI / 2; el = 0; }
  if (kind === 'right') { az = 0; el = 0; }

  let fitR = distanceToFitSphere(cam, radius, 3);
  fitR = THREE.MathUtils.clamp(fitR, 0.35, 1e4);
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  return tweenCamera(core, target.clone().add(dir.multiplyScalar(fitR)), target, duration);
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

function rememberMaterialBaseState(mat) {
  if (!mat) return;
  const ud = ensureMaterialUserData(mat);
  const op = Number.isFinite(mat.opacity) ? Math.max(0, mat.opacity) : 1;
  // The first stable material state is the canonical restoration state.
  // Never overwrite it with a mid-fade value from rapid panel clicks.
  if (!Number.isFinite(ud.__automindBaseOpacity)) ud.__automindBaseOpacity = op > 0 ? op : 1;
  if (typeof ud.__automindBaseTransparent !== 'boolean') ud.__automindBaseTransparent = !!mat.transparent;
  if (typeof ud.__automindBaseDepthWrite !== 'boolean') ud.__automindBaseDepthWrite = mat.depthWrite !== false;
  if (typeof ud.__automindBaseDepthTest !== 'boolean') ud.__automindBaseDepthTest = mat.depthTest !== false;
}

function cloneMaterialForVisibility(mat) {
  if (!mat || typeof mat.clone !== 'function') return mat;
  const cloned = mat.clone();
  cloned.userData = { ...(mat.userData || {}) };
  const ud = ensureMaterialUserData(cloned);
  const op = Number.isFinite(cloned.opacity) ? Math.max(0, cloned.opacity) : 1;
  if (!Number.isFinite(ud.__automindBaseOpacity)) ud.__automindBaseOpacity = op > 0 ? op : 1;
  if (typeof ud.__automindBaseTransparent !== 'boolean') ud.__automindBaseTransparent = !!cloned.transparent;
  if (typeof ud.__automindBaseDepthWrite !== 'boolean') ud.__automindBaseDepthWrite = cloned.depthWrite !== false;
  if (typeof ud.__automindBaseDepthTest !== 'boolean') ud.__automindBaseDepthTest = cloned.depthTest !== false;
  return cloned;
}

function ensureUniqueVisibilityMaterials(mesh) {
  if (!mesh || !mesh.material) return [];
  if (!mesh.userData.__automindVisibilityMaterialUnique) {
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(cloneMaterialForVisibility);
    else mesh.material = cloneMaterialForVisibility(mesh.material);
    mesh.userData.__automindVisibilityMaterialUnique = true;
  }
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
    mesh.userData.__automindVisibilitySerial = serial;
    mesh.userData.__automindVisibilityTarget = targetVisible;

    const mats = ensureUniqueVisibilityMaterials(mesh);
    const wasTargetVisible = mesh.userData.__automindVisibilityTarget !== false;
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
  const { center, size, radius, maxDim } = s;
  const cam = core.camera;

  // Component-panel focus must use the same Iso angle every time, but with a fit
  // distance computed from the selected part itself. A screw gets a close view;
  // a huge body gets a farther view. This avoids inheriting the previous zoom.
  updateCameraPlanesForBox(cam, size);
  const az = Math.PI * 0.25;
  const el = Math.PI * 0.20;
  const dir = new THREE.Vector3(
    Math.cos(el) * Math.cos(az),
    Math.sin(el),
    Math.cos(el) * Math.sin(az)
  ).normalize();

  let dist;
  if (cam.isOrthographicCamera) {
    dist = Math.max(radius * 5.0, maxDim * 4.0, 0.25);
  } else {
    dist = distanceToFitSphere(cam, radius, 2.65);
  }
  dist = THREE.MathUtils.clamp(dist, 0.05, 1e6);
  return tweenCamera(core, center.clone().add(dir.multiplyScalar(dist)), center, duration);
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
  // V11: merged with the original URDF thumbnail mechanism.
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
    mode: 'URDF+ BUILD162',
    selectMode,
    IA_Widgets,
    hasZip: !!(opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64),
    hasURDF: !!(opts.urdfContent || opts.urdfText || opts.robotXml),
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
      robot = await loadURDFPlusModel(opts);
      if (core.robot) {
        try { core.scene.remove(core.robot); } catch (_) {}
      }
      core.robot = robot;
      core.scene.add(robot);
      // BUILD164: viewport colors must match thumbnails. If any late-loaded DAE
      // material escaped the URDFPlusCore conversion, keep it opaque/unlit here.
      try {
        robot.traverse?.((o) => {
          if (!o?.isMesh || !o.material || o.userData?.__isHoverOverlay) return;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            if (!m) continue;
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
      try { core.refreshRobotContext?.(robot); } catch (_) {}
      assetToMeshes = robot.assetToMeshes || new Map();
      thumbs = buildThumbnailer(core, assetToMeshes);
      inter.setRobot(robot);
      robot.applyPose?.();
      core.fitAndCenter(robot, 1.08);
      try { core.setMechanismToggles?.({ jointAxes: false, loops: false }); } catch (_) {}
      setTimeout(() => { try { thumbs.primeAll(Array.from(assetToMeshes.keys())); } catch (_) {} }, 67);
      maybeSetupIA(app, assetToMeshes, thumbs);
      debugLog('URDF+ loaded BUILD161', {
        robot: robot.name,
        links: Object.keys(robot.links || {}).length,
        joints: Object.keys(robot.joints || {}).length,
        loops: (robot.loopJoints || []).length,
        couplings: (robot.couplings || []).length,
        components: assetToMeshes.size
      });
      return app;
    } catch (err) {
      debugLog('URDF+ load error', err?.stack || err?.message || String(err));
      const box = document.createElement('pre');
      box.textContent = 'AutoMind URDF+ load error:\n' + (err?.stack || err?.message || String(err));
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
    window.URDFPlusViewer = window.URDFPlusViewer || {};
    window.URDFPlusViewer.__app = app;
    window.AutoMindURDFPlusApp = app;
  }

  return Object.assign(app, {
    resize: core.resize,
    destroy() {
      try { comps?.destroy?.(); } catch (_) {}
      try { tools?.destroy?.(); } catch (_) {}
      try { inter?.destroy?.(); } catch (_) {}
      try { thumbs?.destroy?.(); } catch (_) {}
      try { robot?.assetResolver?.dispose?.(); } catch (_) {}
      try { core.destroy?.(); } catch (_) {}
    }
  });
}

export default { render };
