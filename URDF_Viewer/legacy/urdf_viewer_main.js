// /viewer/urdf_viewer_main.js
// Viewer moderno + thumbnails + IA opt-in con:
//  - Imagen ISO del robot completo (__robot_iso__)
//  - Nombres + orden de componentes 
//  - Reducción de thumbnails a ~5KB solo para IA
//  - Parser robusto para el dict que llega desde Colab

import { THEME } from './Theme.js';
import * as ViewerCore from './core/ViewerCore.js';
const createViewer =
  ViewerCore.createViewer ||
  ViewerCore.default ||
  (typeof window !== 'undefined' ? window.createViewer : null);
if (createViewer == null) {
  throw new Error(
    "ViewerCore: createViewer no encontrado. Revisa core/ViewerCore.js (export) o window.createViewer (UMD).",
  );
}

import { buildAssetDB, createLoadMeshCb } from './core/AssetDB.js';
import { attachInteraction } from './interaction/SelectionAndDrag.js';
import { createToolsDock } from './ui/ToolsDock.js';
import { createComponentsPanel } from './ui/ComponentsPanel.js';

export let Base64Images = [];

/* ========================= Debug helper ========================= */

function debugLog(...args) {
  try {
    console.log('[URDFPLUS_UNIFIED_DEBUG]', ...args);
  } catch (_) {}
  try {
    if (typeof window !== 'undefined') {
      window.URDF_DEBUG_LOGS = window.URDF_DEBUG_LOGS || [];
      window.URDF_DEBUG_LOGS.push(args);
    }
  } catch (_) {}
}



/* ======================= BUILD150 advanced UI state helpers ======================= */
function materialList(mat) {
  if (!mat) return [];
  return Array.isArray(mat) ? mat.filter(Boolean) : [mat];
}
function ensureMaterialUserData(mat) {
  if (!mat.userData) mat.userData = {};
  return mat.userData;
}
function rememberMaterialBaseState(mat) {
  if (!mat) return;
  const ud = ensureMaterialUserData(mat);
  const op = Number.isFinite(mat.opacity) ? Math.max(0, mat.opacity) : 1;
  if (!Number.isFinite(ud.__automindBaseOpacity)) ud.__automindBaseOpacity = op > 0 ? op : 1;
  if (typeof ud.__automindBaseTransparent !== 'boolean') ud.__automindBaseTransparent = !!mat.transparent;
  if (typeof ud.__automindBaseDepthWrite !== 'boolean') ud.__automindBaseDepthWrite = mat.depthWrite !== false;
  if (typeof ud.__automindBaseDepthTest !== 'boolean') ud.__automindBaseDepthTest = mat.depthTest !== false;
}
function cloneMaterialForVisibility(mat) {
  if (!mat || typeof mat.clone !== 'function') return mat;
  const cloned = mat.clone();
  cloned.userData = { ...(mat.userData || {}) };
  rememberMaterialBaseState(cloned);
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
  mats.forEach(rememberMaterialBaseState);
  return mats;
}
function currentRenderModeFor(core) {
  const mode = String(core?.__currentRenderMode || 'Solid');
  if (/^x[- ]?ray$/i.test(mode)) return 'X-Ray';
  if (/^ghost$/i.test(mode)) return 'Ghost';
  if (/^wireframe$/i.test(mode)) return 'Wireframe';
  return 'Solid';
}
function baseOpacityFor(mat) {
  const ud = ensureMaterialUserData(mat);
  return Math.max(0, Number.isFinite(ud.__automindBaseOpacity) ? ud.__automindBaseOpacity : 1);
}
function renderModeVisibleOpacity(core, mat) {
  const mode = currentRenderModeFor(core);
  if (mode === 'X-Ray') return 0.35;
  if (mode === 'Ghost') return 0.70;
  return baseOpacityFor(mat);
}
function applyRenderModeMaterialState(core, mat) {
  if (!mat) return;
  rememberMaterialBaseState(mat);
  const mode = currentRenderModeFor(core);
  const opacity = renderModeVisibleOpacity(core, mat);
  mat.wireframe = (mode === 'Wireframe');
  if (mode === 'X-Ray' || mode === 'Ghost') {
    mat.transparent = true;
    mat.opacity = opacity;
    mat.depthWrite = false;
    mat.depthTest = true;
  } else {
    const ud = ensureMaterialUserData(mat);
    mat.transparent = (typeof ud.__automindBaseTransparent === 'boolean') ? ud.__automindBaseTransparent : (opacity < 1);
    mat.opacity = opacity;
    mat.depthWrite = (typeof ud.__automindBaseDepthWrite === 'boolean') ? ud.__automindBaseDepthWrite : true;
    mat.depthTest = (typeof ud.__automindBaseDepthTest === 'boolean') ? ud.__automindBaseDepthTest : true;
  }
  mat.needsUpdate = true;
}
function applyRenderModeToMeshes(core, meshes) {
  for (const mesh of meshes || []) {
    for (const mat of ensureUniqueVisibilityMaterials(mesh)) applyRenderModeMaterialState(core, mat);
  }
}
function collectRobotMeshes(robot) {
  const meshes = [];
  robot?.traverse?.(o => { if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) meshes.push(o); });
  return meshes;
}
function collectMeshesInObject(object) {
  const meshes = [];
  object?.traverse?.(o => { if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) meshes.push(o); });
  return meshes;
}
function computeMeshesFitSphere(meshes) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let has = false;
  for (const m of meshes || []) {
    if (!m) continue;
    tmp.setFromObject(m);
    if (tmp.isEmpty()) continue;
    if (!has) { box.copy(tmp); has = true; } else box.union(tmp);
  }
  if (!has) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.length() * 0.5 * (1 / Math.sqrt(3)), 1e-9);
  return { center, size, radius, box };
}
function markMeshVisibility(mesh, visible) {
  if (!mesh) return;
  mesh.userData.__automindVisibilityTarget = !!visible;
  mesh.visible = !!visible;
}

// BUILD151: full advanced UI mechanics from USD/URDF+ shell.
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function objectBox(object) {
  const box = new THREE.Box3().setFromObject(object);
  return box.isEmpty() ? null : box;
}
function distanceToFitSphere(cam, radius, pad = 3) {
  const r = Math.max(1e-6, radius) * pad;
  if (cam.isOrthographicCamera) return THREE.MathUtils.clamp(r * 2.0, 0.35, 1e6);
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
function tweenCamera(core, endPos, endTarget, duration = 750) {
  const cam = core.camera, ctrl = core.controls;
  cameraTweenToken++;
  if (cameraTweenRAF) { try { cancelAnimationFrame(cameraTweenRAF); } catch (_) {} cameraTweenRAF = 0; }
  try { ctrl.enabled = true; } catch (_) {}
  const token = cameraTweenToken;
  const startPos = cam.position.clone();
  const startTarget = ctrl.target.clone();
  ctrl.enabled = false;
  cam.up.set(0, 1, 0);
  if (!duration || duration <= 0) {
    cam.position.copy(endPos); ctrl.target.copy(endTarget); ctrl.update(); ctrl.enabled = true; return true;
  }
  const t0 = performance.now();
  function step(now) {
    if (token !== cameraTweenToken) return;
    const u = Math.min(1, (now - t0) / duration);
    const k = easeInOutCubic(u);
    cam.position.lerpVectors(startPos, endPos, k);
    ctrl.target.lerpVectors(startTarget, endTarget, k);
    ctrl.update();
    try { core.renderer?.render?.(core.scene, cam); } catch (_) {}
    if (u < 1) cameraTweenRAF = requestAnimationFrame(step);
    else if (token === cameraTweenToken) { cameraTweenRAF = 0; ctrl.enabled = true; }
  }
  cameraTweenRAF = requestAnimationFrame(step);
  return true;
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
  const focused = core?.__componentViewFocusMeshes;
  if (Array.isArray(focused) && focused.length) {
    const s = fitSphereFromMeshes(focused.filter(m => m && m.visible !== false));
    if (s) return s;
  }
  return fitSphereFromObject(core?.robot);
}
function viewIso(core, object = core.robot, duration = 750) {
  if (!core || !object) return false;
  const s = currentViewFitSphere(core) || fitSphereFromObject(object);
  if (!s) return false;
  const { center, size, radius, maxDim } = s;
  const cam = core.camera;
  updateCameraPlanesForBox(cam, size);
  const az = Math.PI * 0.25;
  const el = Math.PI * 0.20;
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  let fitR = cam.isOrthographicCamera ? Math.max(radius * 5.0, maxDim * 4.0, 0.25) : distanceToFitSphere(cam, radius, 2.65);
  fitR = THREE.MathUtils.clamp(fitR, 0.05, 1e6);
  return tweenCamera(core, center.clone().add(dir.multiplyScalar(fitR)), center, duration);
}
function currentOpacityFor(mat) { return Number.isFinite(mat?.opacity) ? Math.max(0, mat.opacity) : 1; }
let visibilityTweenToken = 0;
let visibilityRAF = 0;
let visibilityActionSerial = 0;
function cancelVisibilityFrame() {
  if (visibilityRAF) { try { cancelAnimationFrame(visibilityRAF); } catch (_) {} visibilityRAF = 0; }
}
function forceMeshVisibilityState(core, mesh, targetVisible) {
  if (!mesh || !mesh.isMesh || !mesh.geometry || mesh.userData?.__isHoverOverlay) return;
  const mats = ensureUniqueVisibilityMaterials(mesh);
  mesh.visible = !!targetVisible;
  mesh.userData.__automindVisibilityTarget = !!targetVisible;
  for (const mat of mats) {
    const ud = ensureMaterialUserData(mat);
    const targetOpacity = targetVisible ? renderModeVisibleOpacity(core, mat) : 0;
    if (targetVisible) {
      mat.opacity = targetOpacity;
      mat.transparent = currentRenderModeFor(core) === 'X-Ray' || currentRenderModeFor(core) === 'Ghost' || targetOpacity < 1 || !!ud.__automindBaseTransparent;
      mat.depthWrite = (currentRenderModeFor(core) === 'X-Ray' || currentRenderModeFor(core) === 'Ghost') ? false : (typeof ud.__automindBaseDepthWrite === 'boolean' ? ud.__automindBaseDepthWrite : true);
      mat.depthTest = typeof ud.__automindBaseDepthTest === 'boolean' ? ud.__automindBaseDepthTest : true;
      mat.wireframe = currentRenderModeFor(core) === 'Wireframe';
    } else {
      mat.opacity = 0; mat.transparent = true; mat.depthWrite = false; mat.depthTest = true;
    }
    mat.needsUpdate = true;
  }
}
function finalizeVisibilityStates(core, states, finalVisibleMeshes, finalHiddenMeshes, token, after) {
  if (token !== visibilityTweenToken) return;
  finalVisibleMeshes.forEach(mesh => forceMeshVisibilityState(core, mesh, true));
  finalHiddenMeshes.forEach(mesh => forceMeshVisibilityState(core, mesh, false));
  try { core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  if (typeof after === 'function') { try { after(); } catch (_) {} }
}
function animateMeshVisibility(core, meshes, shouldBeVisible, duration = 540, after = null) {
  const token = ++visibilityTweenToken;
  const serial = ++visibilityActionSerial;
  cancelVisibilityFrame();
  const states = [];
  const finalVisibleMeshes = new Set();
  const finalHiddenMeshes = new Set();
  const uniqueMeshes = Array.from(new Set((meshes || []).filter(m => m && m.isMesh && m.geometry && !m.userData?.__isHoverOverlay)));
  for (const mesh of uniqueMeshes) {
    const targetVisible = typeof shouldBeVisible === 'function' ? !!shouldBeVisible(mesh) : !!shouldBeVisible;
    mesh.userData.__automindVisibilitySerial = serial;
    mesh.userData.__automindVisibilityTarget = targetVisible;
    const mats = ensureUniqueVisibilityMaterials(mesh);
    mesh.visible = true;
    if (targetVisible) finalVisibleMeshes.add(mesh); else finalHiddenMeshes.add(mesh);
    for (const mat of mats) {
      if (!mat) continue;
      rememberMaterialBaseState(mat);
      const startOpacity = mesh.visible === false ? 0 : currentOpacityFor(mat);
      const targetOpacity = targetVisible ? renderModeVisibleOpacity(core, mat) : 0;
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
    if (u < 1) { visibilityRAF = requestAnimationFrame(step); return; }
    visibilityRAF = 0;
    finalizeVisibilityStates(core, states, finalVisibleMeshes, finalHiddenMeshes, token, after);
  }
  visibilityRAF = requestAnimationFrame(step);
}
function frameMeshesTween(core, meshes, duration = 680) {
  const s = fitSphereFromMeshes(meshes);
  if (!s) return false;
  const { center, size, radius, maxDim } = s;
  const cam = core.camera;
  updateCameraPlanesForBox(cam, size);
  const az = Math.PI * 0.25;
  const el = Math.PI * 0.20;
  const dir = new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();
  let dist = cam.isOrthographicCamera ? Math.max(radius * 5.0, maxDim * 4.0, 0.25) : distanceToFitSphere(cam, radius, 2.65);
  dist = THREE.MathUtils.clamp(dist, 0.05, 1e6);
  return tweenCamera(core, center.clone().add(dir.multiplyScalar(dist)), center, duration);
}
function isolateMeshesSmooth(core, meshesToKeep, duration = 560) {
  if (!core.robot) return;
  const allMeshes = collectRobotMeshes(core.robot);
  const keep = new Set((meshesToKeep || []).filter(m => m && m.isMesh && m.geometry && !m.userData?.__isHoverOverlay));
  const kept = Array.from(keep);
  core.__componentViewFocusMeshes = kept.length ? kept : null;
  animateMeshVisibility(core, allMeshes, mesh => keep.has(mesh), duration, () => {
    try { core?.interaction?.clearHover?.(); core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  });
  if (kept.length) frameMeshesTween(core, kept, 680);
}
function installURDFLoaderMetadata(robot) {
  if (!robot) return;
  try {
    const linkByName = robot.links || {};
    Object.entries(linkByName).forEach(([name, link]) => { if (link) { link.userData ??= {}; link.userData.__linkName = name; } });
    const childJointMap = new Map();
    Object.entries(robot.joints || {}).forEach(([name, j]) => {
      if (!j) return;
      j.name ||= name;
      j.userData ??= {};
      j.userData.__isURDFJoint = true;
      let childName = j.childLink || j.child_link || j.childLinkName || (typeof j.child === 'string' ? j.child : '') || (j.child?.name || '');
      let childObj = (j.child && j.child.isObject3D) ? j.child : null;
      if (!childObj && childName && linkByName[childName]) childObj = linkByName[childName];
      if (!childObj) {
        for (const [ln, lobj] of Object.entries(linkByName)) {
          if (lobj && lobj.parent === j) { childObj = lobj; childName = ln; break; }
        }
      }
      if (childObj) {
        childObj.userData ??= {};
        childObj.userData.__linkName ||= childName || childObj.name;
        childObj.userData.__joint = j;
        childJointMap.set(childObj.userData.__linkName || childObj.name, j);
      }
      if (Array.isArray(j.axis)) j.axis = new THREE.Vector3(j.axis[0] || 0, j.axis[1] || 0, j.axis[2] || 0).normalize();
      if (!j.axis || !j.axis.isVector3) j.axis = new THREE.Vector3(1, 0, 0);
    });
    if (typeof robot.getManipulableJointForLinkName !== 'function') {
      robot.getManipulableJointForLinkName = (linkName) => childJointMap.get(linkName) || null;
    }
    if (typeof robot.getJointWorldPivot !== 'function') {
      robot.getJointWorldPivot = (j) => j?.getWorldPosition ? j.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    }
    if (typeof robot.getJointWorldAxis !== 'function') {
      robot.getJointWorldAxis = (j) => {
        const q = j?.getWorldQuaternion ? j.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        return (j?.axis || new THREE.Vector3(1,0,0)).clone().normalize().applyQuaternion(q).normalize();
      };
    }
  } catch (e) { debugLog('installURDFLoaderMetadata failed', String(e)); }
}

function mimeFromAssetName(name) {
  const n = String(name || '').toLowerCase().split('?')[0].split('#')[0];
  if (n.endsWith('.png')) return 'image/png';
  if (n.endsWith('.jpg') || n.endsWith('.jpeg')) return 'image/jpeg';
  if (n.endsWith('.webp')) return 'image/webp';
  if (n.endsWith('.gif')) return 'image/gif';
  if (n.endsWith('.bmp')) return 'image/bmp';
  if (n.endsWith('.svg')) return 'image/svg+xml';
  return 'image/png';
}
function assetValueToDataURL(assetDB, ref) {
  if (!assetDB || !ref) return '';
  let raw = '';
  try { raw = assetDB.get?.(ref) || ''; } catch (_) { raw = ''; }
  if (!raw) return '';
  raw = String(raw || '').trim();
  if (/^data:/i.test(raw)) return raw;
  return `data:${mimeFromAssetName(ref)};base64,${raw}`;
}
function rewriteURDFTextureFilenamesToDataURLs(urdfText, assetDB) {
  let text = String(urdfText || '');
  try {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.querySelector('parsererror')) return text;
    let changed = 0;
    const nodes = Array.from(xml.getElementsByTagName('*')).filter(n => (n.localName || n.nodeName).toLowerCase() === 'texture');
    for (const n of nodes) {
      const old = n.getAttribute('filename') || n.getAttribute('file') || n.getAttribute('name') || '';
      if (!old || /^data:/i.test(old)) continue;
      const data = assetValueToDataURL(assetDB, old);
      if (!data) continue;
      n.setAttribute('filename', data);
      changed++;
    }
    if (changed) {
      try { debugLog('[URDF texture inline] texture filename -> dataURL', changed); } catch (_) {}
      text = new XMLSerializer().serializeToString(xml);
    }
  } catch (_) {}
  return text;
}
function findAncestorLinkNameForMesh(mesh, robot) {
  let n = mesh;
  const links = robot?.links || {};
  const linkSet = new Set(Object.values(links));
  while (n) {
    if (n.userData?.__linkName) return n.userData.__linkName;
    if (linkSet.has(n)) {
      for (const [name, obj] of Object.entries(links)) if (obj === n) return name;
      return n.name || '';
    }
    n = n.parent;
  }
  return '';
}

function parseURDFLoopDescriptors(urdfText, robot) {
  const out = [];
  try {
    const xml = new DOMParser().parseFromString(String(urdfText || ''), 'application/xml');
    const nodes = Array.from(xml.getElementsByTagName('*')).filter(n => (n.localName || n.nodeName).toLowerCase() === 'loop');
    for (const n of nodes) {
      const a = n.getAttribute('predecessor') || n.getAttribute('body0') || n.getAttribute('link0') || n.getAttribute('parent') || n.getAttribute('link_a') || '';
      const b = n.getAttribute('successor') || n.getAttribute('body1') || n.getAttribute('link1') || n.getAttribute('child') || n.getAttribute('link_b') || '';
      if (a && b && robot?.links?.[a] && robot?.links?.[b]) out.push({ a, b });
    }
  } catch (_) {}
  return out;
}
function createMechanismDecorationController(core, robot, urdfText = '') {
  const group = new THREE.Group();
  group.name = 'automind_mechanism_decorations_batch';
  group.visible = true;
  core.scene.add(group);
  let showAxes = false;
  let showLoops = false;
  let clipPlane = null;
  let axisBatch = null;
  let loopBatch = null;
  const loops = parseURDFLoopDescriptors(urdfText, robot);

  function modelDim() {
    const b = fitSphereFromObject(robot);
    return Math.max(b?.maxDim || b?.radius || 1, 1e-6);
  }
  function decorationScale() { return Math.max(modelDim() * 0.16, 0.012); }
  function disposeLine(line) {
    try { line?.geometry?.dispose?.(); } catch (_) {}
    try { if (Array.isArray(line?.material)) line.material.forEach(m => m?.dispose?.()); else line?.material?.dispose?.(); } catch (_) {}
    try { line?.parent?.remove?.(line); } catch (_) {}
  }
  function jointWorldAxis(j) {
    try { return (robot.getJointWorldAxis ? robot.getJointWorldAxis(j) : new THREE.Vector3(1,0,0)).clone().normalize(); } catch (_) { return new THREE.Vector3(1,0,0); }
  }
  function jointWorldPivot(j) {
    try { return robot.getJointWorldPivot ? robot.getJointWorldPivot(j) : (j.getWorldPosition ? j.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()); } catch (_) { return new THREE.Vector3(); }
  }
  function isDrawableJoint(j) {
    const t = String(j?.jointType || j?.type || '').toLowerCase();
    return !!j && !t.includes('fixed') && (t.includes('revolute') || t.includes('continuous') || t.includes('prismatic') || t.includes('floating') || t.includes('planar'));
  }
  function makeLineSegments(name, color, count, renderOrder) {
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(Math.max(1, count * 6));
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setDrawRange(0, count * 2);
    const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false, clippingPlanes: clipPlane ? [clipPlane] : null });
    const line = new THREE.LineSegments(geom, mat);
    line.name = name;
    line.renderOrder = renderOrder;
    line.frustumCulled = false;
    group.add(line);
    return { line, positions };
  }
  function rebuild() {
    disposeLine(axisBatch?.line); axisBatch = null;
    disposeLine(loopBatch?.line); loopBatch = null;
    const joints = Object.values(robot?.joints || {}).filter(isDrawableJoint);
    const a = makeLineSegments('automind_joint_axes_batch', 0x087ea4, joints.length, 9998);
    axisBatch = { ...a, joints, scale: decorationScale() };
    const l = makeLineSegments('automind_loops_batch', 0xb7791f, loops.length, 9999);
    loopBatch = { ...l, loops };
    update();
  }
  function update() {
    if (!axisBatch || !loopBatch) rebuild();
    const effAxis = !!showAxes && axisBatch.joints.length > 0;
    const effLoops = !!showLoops && loopBatch.loops.length > 0;
    axisBatch.line.visible = effAxis;
    loopBatch.line.visible = effLoops;
    if (axisBatch.line.material) { axisBatch.line.material.opacity = effAxis ? 0.95 : 0.0; axisBatch.line.material.clippingPlanes = clipPlane ? [clipPlane] : null; axisBatch.line.material.needsUpdate = true; }
    if (loopBatch.line.material) { loopBatch.line.material.opacity = effLoops ? 0.95 : 0.0; loopBatch.line.material.clippingPlanes = clipPlane ? [clipPlane] : null; loopBatch.line.material.needsUpdate = true; }
    if (effAxis) {
      const p = new THREE.Vector3(), ax = new THREE.Vector3();
      let k = 0;
      const sc = decorationScale();
      axisBatch.scale = sc;
      for (const j of axisBatch.joints) {
        p.copy(jointWorldPivot(j));
        ax.copy(jointWorldAxis(j));
        if (ax.lengthSq() < 1e-12) ax.set(1,0,0);
        axisBatch.positions[k++] = p.x - ax.x * sc; axisBatch.positions[k++] = p.y - ax.y * sc; axisBatch.positions[k++] = p.z - ax.z * sc;
        axisBatch.positions[k++] = p.x + ax.x * sc; axisBatch.positions[k++] = p.y + ax.y * sc; axisBatch.positions[k++] = p.z + ax.z * sc;
      }
      axisBatch.line.geometry.attributes.position.needsUpdate = true;
      axisBatch.line.geometry.computeBoundingSphere?.();
    }
    if (effLoops) {
      let k = 0;
      const p0 = new THREE.Vector3(), p1 = new THREE.Vector3();
      for (const lp of loopBatch.loops) {
        const la = robot?.links?.[lp.a];
        const lb = robot?.links?.[lp.b];
        if (la) la.getWorldPosition(p0); else p0.set(0,0,0);
        if (lb) lb.getWorldPosition(p1); else p1.set(0,0,0);
        loopBatch.positions[k++] = p0.x; loopBatch.positions[k++] = p0.y; loopBatch.positions[k++] = p0.z;
        loopBatch.positions[k++] = p1.x; loopBatch.positions[k++] = p1.y; loopBatch.positions[k++] = p1.z;
      }
      loopBatch.line.geometry.attributes.position.needsUpdate = true;
      loopBatch.line.geometry.computeBoundingSphere?.();
    }
  }
  function set({ jointAxes, loops: nextLoops } = {}) {
    if (typeof jointAxes === 'boolean') showAxes = jointAxes;
    if (typeof nextLoops === 'boolean') showLoops = nextLoops;
    update();
  }
  function setClipPlane(plane) { clipPlane = plane || null; update(); }
  function destroy() { disposeLine(axisBatch?.line); disposeLine(loopBatch?.line); try { group.parent?.remove(group); } catch (_) {} }
  core.renderer.__automindUpdateMechanismDecorations = update;
  rebuild();
  return { set, setClipPlane, destroy, update };
}

/* ============================ Render ============================ */

export function render(opts = {}) {
  const {
    container,
    urdfContent = opts.urdfContent || opts.urdfText || opts.robotXml || '',
    meshDB = opts.meshDB || opts.assetDB || opts.textureDB || opts.assets || {},
    selectMode = 'link',
    background = (THEME.bgCanvas || THEME?.colors?.canvasBg || 0xffffff),
    clickAudioDataURL = null,
    IA_Widgets = false,
  } = opts;

  debugLog('render() init UNIFIED_URDFPLUS_BUILD152_TEXTURE_THUMBS_JOINT_SIM', { selectMode, background, IA_Widgets });

  // Wait until the URDF meshes stop arriving (assetToMeshes settles).
  function waitForAssetMapToSettle(assetToMeshes, maxWaitMs = 8000, quietMs = 350) {
    const start = performance.now();
    let lastCount = -1;
    let lastChange = performance.now();

    function countNow() {
      let n = 0;
      try {
        assetToMeshes.forEach((arr) => {
          n += arr && arr.length ? arr.length : 0;
        });
      } catch (_) {}
      return n;
    }

    return new Promise((resolve) => {
      function tick() {
        const now = performance.now();
        const c = countNow();
        if (c !== lastCount) {
          lastCount = c;
          lastChange = now;
        }

        const settled = now - lastChange >= quietMs;
        const timeout = now - start >= maxWaitMs;

        if (settled || timeout) resolve({ meshes: c, settled, timeout });
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  // 1) Core viewer
  const _createViewer =
    (ViewerCore &&
      (ViewerCore.createViewer ||
        (ViewerCore.default && ViewerCore.default.createViewer))) ||
    window.createViewer;
  if (typeof _createViewer !== 'function')
    throw new Error(
      '[urdf_viewer_main] createViewer not found (ESM export or UMD global).',
    );
  const core = _createViewer({ container, background });

  // 2) Asset DB
  const assetDB = buildAssetDB(meshDB);
  const assetToMeshes = new Map(); // assetKey -> Mesh[]

  const loadMeshCb = createLoadMeshCb(assetDB, {
    onMeshTag(obj, assetKey) {
      const list = assetToMeshes.get(assetKey) || [];
      obj.traverse((o) => {
        if (o && o.isMesh && o.geometry) list.push(o);
      });
      assetToMeshes.set(assetKey, list);

      obj.traverse((o) => {
        if (o && o.isMesh) {
          o.userData = o.userData || {};
          o.userData.__assetKey = assetKey;
        }
      });
    },
  });

  // 3) Cargar URDF
  // BUILD152: inline URDF material textures as data URLs before URDFLoader parses
  // the XML. This stops Colab from trying to fetch /meshes/*.png through its
  // runtime proxy and keeps mesh thumbnails/materials consistent with the main model.
  const urdfForLoader = rewriteURDFTextureFilenamesToDataURLs(urdfContent, assetDB);
  const robot = core.loadURDF(urdfForLoader, { loadMeshCb });
  installURDFLoaderMetadata(robot);
  try { core.refreshRobotContext?.(robot); } catch (_) {}
  debugLog('Robot loaded', { hasRobot: !!robot, joints: Object.keys(robot?.joints || {}).length, links: Object.keys(robot?.links || {}).length });

  if (robot && !assetToMeshes.size) {
    debugLog('assetToMeshes vacío, reconstruyendo desde userData');
    rebuildAssetMapFromRobot(robot, assetToMeshes);
  }

  debugLog('assetToMeshes keys', Array.from(assetToMeshes.keys()));

  // 4) Offscreen thumbnails (FIX: pasar assetToMeshes + THEME)
  const off = buildOffscreenForThumbnails(core, assetToMeshes, THEME);
  if (!off) debugLog('Offscreen thumbnails no disponible (no robot)');

  // 5) Interacción
  let app = null;
  const inter = attachInteraction({
    scene: core.scene,
    camera: () => core.camera,
    renderer: core.renderer,
    controls: core.controls,
    robot,
    selectMode,
    getSectionPlane: () => app?.sectionPlane || null,
    onSelectLink: (link) => { try { app.__selectedLink = link || null; } catch (_) {} }
  });

  // 6) Facade app para UI + IA
  app = {
    ...core,
    robot,
    IA_Widgets,
    assets: {
      list: () => listAssets(assetToMeshes),
      thumbnail: (assetKey) => off?.thumbnail(assetKey),
    },
    isolate: {
      asset: (assetKey) => isolateAsset(core, assetToMeshes, assetKey),
      link: (linkObj) => isolateLink(core, linkObj),
      clear: () => showAll(core),
    },
    showAll: () => showAll(core),
    interaction: inter,
    sectionPlane: null,
    getSectionPlane: () => app?.sectionPlane || null,
    setMechanismClippingPlane: (_plane) => { try { app.__mechanismDecorations?.setClipPlane?.(_plane); } catch (_) {} },
    setMechanismToggles: (_toggles = {}) => { try { app.__mechanismDecorations?.set?.(_toggles); } catch (_) {} },
    setRenderModeState(mode = 'Solid') {
      core.__currentRenderMode = mode || 'Solid';
      applyRenderModeToMeshes(core, collectRobotMeshes(robot));
    },
    getCurrentViewFitSphere() {
      return currentViewFitSphere(core);
    },
    viewIso: () => viewIso(core, core.robot, 750),

    openTools(open = true) {
      tools.set(!!open);
    },

    componentDescriptions: {},

    getComponentDescription(assetKey, index) {
      const src = app.componentDescriptions || {};
      if (!src) return '';

      if (assetKey && src[assetKey]) return src[assetKey];

      const baseFull = (assetKey || '').split(/[\\/]/).pop();
      if (baseFull && src[baseFull]) return src[baseFull];

      const base = baseFull ? baseFull.split('.')[0] : '';
      if (base && src[base]) return src[base];

      if (Array.isArray(src) && typeof index === 'number') {
        return src[index] || '';
      }
      return '';
    },

    async collectAllThumbnails() {
      const items = app.assets.list();
      Base64Images.length = 0;

      for (const it of items) {
        try {
          const url = await app.assets.thumbnail(it.assetKey);
          if (!url || typeof url !== 'string') continue;
          const base64 = url.split(',')[1] || '';
          if (base64) Base64Images.push(base64);
        } catch (e) {
          debugLog('collectAllThumbnails error', it.assetKey, String(e));
        }
      }

      if (typeof window !== 'undefined') {
        window.Base64Images = Base64Images;
      }

      debugLog('collectAllThumbnails done', { count: Base64Images.length });
      return Base64Images;
    },
  };

  try { core.interaction = inter; } catch (_) {}
  try { app.__mechanismDecorations = createMechanismDecorationController(core, robot, urdfContent); } catch (e) { debugLog('mechanism decorations unavailable', String(e)); }
  try {
    Object.defineProperty(app, 'camera', { configurable: true, get: () => core.camera });
    Object.defineProperty(app, 'robot', { configurable: true, get: () => core.robot || robot });
    Object.defineProperty(app, 'controls', { configurable: true, get: () => core.controls });
    Object.defineProperty(app, 'renderer', { configurable: true, get: () => core.renderer });
    Object.defineProperty(app, 'scene', { configurable: true, get: () => core.scene });
  } catch (_) {}

  // 7) UI
  const tools = createToolsDock(app, THEME);
  const comps = createComponentsPanel(app, THEME);

  // 9) Precompute ALL component thumbnails on start (single offscreen viewer),
  // then close the offscreen renderer to free GPU memory.
  (async () => {
    try {
      if (!off || typeof off.primeAll !== 'function') return;

      // Wait for URDF mesh loading to settle so the offscreen clone includes everything.
      const settle = await waitForAssetMapToSettle(assetToMeshes, 12000, 450);
      debugLog('[Thumbs] settle', settle);
      // Meshes can arrive after URDFLoader.parse() returns. Rebuild the map from
      // the now-complete robot and refresh the component panel so thumbnails are
      // generated after assets are actually present.
      try { rebuildAssetMapFromRobot(robot, assetToMeshes); } catch (_) {}
      const keys = Array.from(assetToMeshes.keys());
      await off.primeAll(keys);
      try { await comps?.refresh?.(); } catch (_) {}

      // If anything is listening (optional), notify thumbnails are ready.
      try {
        window.dispatchEvent(new Event('thumbnails_ready'));
      } catch (_) {}
    } catch (e) {
      debugLog('[Thumbs] auto prime error', String(e));
    }
  })();

  // 8) Click sound opcional
  if (clickAudioDataURL) {
    try {
      installClickSound(clickAudioDataURL);
    } catch (e) {
      debugLog('installClickSound error', String(e));
    }
  }

  // 9) IA opt-in
  if (IA_Widgets) {
    debugLog('[IA] IA_Widgets=true → bootstrap IA');
    bootstrapComponentDescriptions(app, assetToMeshes, off);
  } else {
    debugLog('[IA] IA_Widgets=false → sin IA');
  }

  // 10) Expose global
  if (typeof window !== 'undefined') {
    window.URDFViewer = window.URDFViewer || {};
    try {
      window.URDFViewer.__app = app;
    } catch (_) {}
  }

  const destroy = () => {
    try {
      comps.destroy();
    } catch (_) {}
    try {
      tools.destroy();
    } catch (_) {}
    try {
      inter.destroy();
    } catch (_) {}
    try {
      off?.destroy?.();
    } catch (_) {}
    try {
      core.destroy();
    } catch (_) {}
  };

  return { ...app, destroy };
}

/* ======================= Helpers: assets / isolate ======================= */

function rebuildAssetMapFromRobot(robot, assetToMeshes) {
  const tmp = new Map();
  robot?.traverse?.((o) => {
    if (o && o.isMesh && o.geometry) {
      let k = (o.userData && (o.userData.__assetKey || o.userData.assetKey || o.userData.filename)) || null;
      if (!k) k = findAncestorLinkNameForMesh(o, robot) || o.name || null;
      if (!k) return;
      o.userData = o.userData || {};
      o.userData.__assetKey = k;
      const arr = tmp.get(k) || [];
      arr.push(o);
      tmp.set(k, arr);
    }
  });
  tmp.forEach((arr, k) => {
    if (arr && arr.length) assetToMeshes.set(k, arr);
  });
}

function listAssets(assetToMeshes) {
  const items = [];
  assetToMeshes.forEach((meshes, assetKey) => {
    if (!meshes || meshes.length === 0) return;
    const { base, ext } = splitName(assetKey);
    items.push({ assetKey, base, ext, count: meshes.length });
  });
  items.sort((a, b) =>
    a.base.localeCompare(b.base, undefined, {
      numeric: true,
      sensitivity: 'base',
    }),
  );
  return items;
}

function splitName(key) {
  const clean = String(key || '').split('?')[0].split('#')[0];
  const base = clean.split('/').pop();
  const dot = base.lastIndexOf('.');
  return {
    base: dot >= 0 ? base.slice(0, dot) : base,
    ext: dot >= 0 ? base.slice(dot + 1).toLowerCase() : '',
  };
}

function isolateAsset(core, assetToMeshes, assetKey) {
  if (!core.robot) return;
  core.__activeAssetKey = assetKey || null;
  isolateMeshesSmooth(core, assetToMeshes.get(assetKey) || [], 560);
}
function isolateLink(core, linkObj) {
  if (!core.robot || !linkObj) return;
  core.__activeAssetKey = null;
  isolateMeshesSmooth(core, collectMeshesInObject(linkObj), 560);
}
function showAll(core) {
  if (!core.robot) return;
  core.__activeAssetKey = null;
  core.__componentViewFocusMeshes = null;
  const meshes = collectRobotMeshes(core.robot);
  animateMeshVisibility(core, meshes, true, 620, () => {
    try { core?.interaction?.clearHover?.(); core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  });
  viewIso(core, core.robot, 750);
}

/* ============= Offscreen thumbnails: componente + ISO robot ============= */

function buildOffscreenForThumbnails(core, assetToMeshes, theme) {
  // IMPORTANTE:
  // - NO creamos otro WebGLRenderer (evita “Too many active WebGL contexts”).
  // - Renderizamos a un WebGLRenderTarget usando el MISMO renderer del viewer.
  // - Pausamos el render loop del viewer mientras capturamos thumbnails (evita renders en blanco).
  // - NO hacemos dispose() de geometrías/texturas/materiales compartidos con el robot principal.
  const OFF_W = 320,
    OFF_H = 320;

  function toColorValue(v, fallback = 0xffffff) {
    if (typeof v === 'number' && isFinite(v)) return v >>> 0;
    if (typeof v === 'string') {
      const s = v.trim();
      // "#rrggbb" or "0xrrggbb" or "rrggbb"
      const hex = s.startsWith('#') ? s.slice(1) : s.startsWith('0x') ? s.slice(2) : s;
      if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16) >>> 0;
    }
    return fallback;
  }

  // ✅ FIX: usar Theme.js también para el fondo de thumbnails/ISO (blanco por defecto)
  const BG = toColorValue(
    (theme && (theme.thumbBg ?? theme.bgCanvas ?? theme.background ?? theme.bg)) ?? 0xffffff,
    0xffffff,
  );

  function normalizeAssetKey(s) {
    if (!s) return '';
    let t = String(s).trim();
    t = t.split('?')[0].split('#')[0];
    t = t.replace(/^package:\/\//i, '');
    t = t.replace(/\\/g, '/');
    return t.trim();
  }

  function variantsForKey(path) {
    const out = new Set();
    const raw = String(path || '');
    if (!raw) return [];
    const clean = normalizeAssetKey(raw);
    if (!clean) return [];
    const lower = clean.toLowerCase();

    const base = clean.split('/').pop();
    const baseLower = lower.split('/').pop();

    out.add(clean);
    out.add(lower);
    out.add(base);
    out.add(baseLower);

    // sin extensión
    const dot1 = base.lastIndexOf('.');
    if (dot1 > 0) out.add(base.slice(0, dot1));
    const dot2 = baseLower.lastIndexOf('.');
    if (dot2 > 0) out.add(baseLower.slice(0, dot2));

    // agrega subpaths
    const parts = lower.split('/');
    for (let i = 1; i < parts.length; i++) {
      const sub = parts.slice(i).join('/');
      out.add(sub);
      out.add(sub.split('/').pop());
    }

    return Array.from(out).filter(Boolean);
  }

  function getCloneMeshesForAssetKey(ses, assetKey) {
    const vars = variantsForKey(assetKey);
    for (const k of vars) {
      const list = ses.cloneMap.get(k);
      if (list && list.length) return list;
    }
    return null;
  }

  const thumbCache = new Map(); // assetKey -> dataURL
  let isoCache = null;

  let closed = false;
  let session = null;
  let priming = null;

  // Serializa renders para no pelear con el loop principal.
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    chain = chain.then(fn, fn);
    return chain;
  };

  function destroySession() {
    if (!session) return;
    try {
      session.rt && session.rt.dispose && session.rt.dispose();
    } catch (_) {}
    try {
      session.scene && session.scene.clear && session.scene.clear();
    } catch (_) {}
    session = null;
    closed = true;
  }

  async function ensureSession() {
    if (closed) return null;
    if (session) return session;
    if (!core || !core.renderer || !core.robot || typeof THREE === 'undefined') return null;

    const renderer = core.renderer;

    // Render target (no crea contexto WebGL nuevo)
    const rt = new THREE.WebGLRenderTarget(OFF_W, OFF_H, {
      depthBuffer: true,
      stencilBuffer: false,
    });

    // Canvas 2D auxiliar para convertir pixels -> PNG dataURL
    const canvas2d = document.createElement('canvas');
    canvas2d.width = OFF_W;
    canvas2d.height = OFF_H;
    const ctx2d = canvas2d.getContext('2d', { willReadFrequently: true });

    // Escena de thumbnails (clon del robot)
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);

    // Luces (también “ambient” desde Theme.js si existe)
    const ambI =
      (theme && (theme.thumbAmbientIntensity ?? theme.ambientIntensity)) ?? 0.95;
    const dirI =
      (theme && (theme.thumbDirIntensity ?? theme.dirIntensity)) ?? 0.9;

    const amb = new THREE.AmbientLight(0xffffff, ambI);
    const dir = new THREE.DirectionalLight(0xffffff, dirI);
    dir.position.set(3, 5, 4);
    scene.add(amb, dir);

    const camera = new THREE.PerspectiveCamera(40, OFF_W / OFF_H, 0.001, 2000);

    const robotClone = core.robot.clone(true);

    // 🔧 Ajustes “seguros” para que no quede invisible,
    // pero SIN sobreescribir color si ya tiene textura/map.
    robotClone.traverse((n) => {
      if (!n || !n.isMesh) return;

      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach((m) => {
        if (!m) return;

        // Evita invisibilidad por alpha/transparency raras
        if (m.opacity === 0) m.opacity = 1;
        if (m.transparent && m.opacity >= 0.999) m.transparent = false;

        // Evita backface culling (caras invertidas)
        m.side = THREE.DoubleSide;

        // Profundidad normal
        m.depthWrite = true;
        m.depthTest = true;

        // Solo si NO hay textura y el material no tiene color útil, damos un gris suave
        const hasMap = !!(m.map || m.emissiveMap || m.metalnessMap || m.roughnessMap);
        if (!hasMap && m.color && typeof m.color.getHex === 'function') {
          const c = m.color.getHex();
          if (c === 0x000000) m.color.setHex(0x999999);
        }

        m.needsUpdate = true;
      });
    });

    // Map keyVariant -> [meshes...]
    const cloneMap = new Map();
    robotClone.traverse((n) => {
      if (!n || !n.isMesh) return;
      n.castShadow = false;
      n.receiveShadow = false;

      const ud = n.userData || {};
      const keyRaw = ud.__assetKey || ud.assetKey || ud.filename || null;
      if (!keyRaw) return;

      const keys = variantsForKey(keyRaw);
      for (const key of keys) {
        if (!cloneMap.has(key)) cloneMap.set(key, []);
        cloneMap.get(key).push(n);
      }
    });
    scene.add(robotClone);

    session = {
      renderer,
      rt,
      canvas2d,
      ctx2d,
      scene,
      camera,
      robotClone,
      cloneMap,
      _tmpBox: new THREE.Box3(),
      _box: new THREE.Box3(),
      _center: new THREE.Vector3(),
      _size: new THREE.Vector3(),
    };

    debugLog('[Thumbs] Offscreen session created (shared renderer; theme BG applied)', {
      BG,
      ambI,
      dirI,
    });
    return session;
  }

  function setVisibleOnly(ses, assetKey) {
    // Oculta todo
    ses.robotClone.traverse((n) => {
      if (n && n.isMesh) n.visible = false;
    });

    // ISO / showAll
    if (!assetKey) {
      ses.robotClone.traverse((n) => {
        if (n && n.isMesh) n.visible = true;
      });
      return { usedFallback: false };
    }

    // lookup robusto
    const list = getCloneMeshesForAssetKey(ses, assetKey);
    if (!list || !list.length) {
      // fallback: mostrar todo
      ses.robotClone.traverse((n) => {
        if (n && n.isMesh) n.visible = true;
      });
      return { usedFallback: true };
    }

    list.forEach((m) => {
      if (m) m.visible = true;
    });
    return { usedFallback: false };
  }

  function computeVisibleBox(ses) {
    // Asegurar matrices world
    try {
      ses.robotClone.updateWorldMatrix(true, true);
    } catch (_) {}

    const box = ses._box;
    const tmp = ses._tmpBox;
    box.makeEmpty();

    let has = false;
    ses.robotClone.traverse((n) => {
      if (!n || !n.isMesh || !n.visible) return;
      tmp.setFromObject(n);
      if (tmp.isEmpty()) return;
      if (!has) {
        box.copy(tmp);
        has = true;
      } else box.union(tmp);
    });

    if (has) return box;

    // fallback final: box de todo el clon
    tmp.setFromObject(ses.robotClone);
    return tmp;
  }

  function fitCameraIso(ses, box) {
    const center = ses._center;
    const size = ses._size;
    box.getCenter(center);
    box.getSize(size);

    let maxDim = Math.max(size.x, size.y, size.z);
    if (!isFinite(maxDim) || maxDim <= 1e-6) maxDim = 1;

    // más cerca que antes (anti-"miniatura")
    const dir = new THREE.Vector3(1, 0.8, 1).normalize();
    const fov = (ses.camera.fov * Math.PI) / 180;
    const dist = (maxDim / Math.tan(Math.max(1e-6, fov / 2))) * 0.55;

    ses.camera.position.copy(center).addScaledVector(dir, dist);
    ses.camera.near = Math.max(0.001, dist / 100);
    ses.camera.far = dist * 200;
    ses.camera.updateProjectionMatrix();
    ses.camera.lookAt(center);
  }

  function renderToDataURL(ses) {
    const r = ses.renderer;

    // Guardar estado renderer
    const prevRT = r.getRenderTarget();
    const prevVp = r.getViewport(new THREE.Vector4());
    const prevSc = r.getScissor(new THREE.Vector4());
    const prevScTest = r.getScissorTest();
    const prevClearAlpha = r.getClearAlpha();
    const prevClearColor = r.getClearColor(new THREE.Color());

    try {
      r.setRenderTarget(ses.rt);
      r.setViewport(0, 0, OFF_W, OFF_H);
      r.setScissor(0, 0, OFF_W, OFF_H);
      r.setScissorTest(false);

      // ✅ FIX: limpiar con BG del Theme
      r.setClearColor(BG, 1);
      r.clear(true, true, true);
      r.render(ses.scene, ses.camera);

      const pixels = new Uint8Array(OFF_W * OFF_H * 4);
      r.readRenderTargetPixels(ses.rt, 0, 0, OFF_W, OFF_H, pixels);

      // Flip vertical para canvas
      const ctx = ses.ctx2d;
      const img = ctx.createImageData(OFF_W, OFF_H);
      for (let y = 0; y < OFF_H; y++) {
        const src = (OFF_H - 1 - y) * OFF_W * 4;
        const dst = y * OFF_W * 4;
        img.data.set(pixels.subarray(src, src + OFF_W * 4), dst);
      }
      ctx.putImageData(img, 0, 0);
      return ses.canvas2d.toDataURL('image/png');
    } catch (e) {
      debugLog('[Thumbs] renderToDataURL failed', e);
      return null;
    } finally {
      // Restaurar estado renderer
      r.setRenderTarget(prevRT);
      r.setViewport(prevVp.x, prevVp.y, prevVp.z, prevVp.w);
      r.setScissor(prevSc.x, prevSc.y, prevSc.z, prevSc.w);
      r.setScissorTest(prevScTest);
      r.setClearColor(prevClearColor, prevClearAlpha);
    }
  }

  function pauseLoop(on) {
    try {
      if (core && typeof core.setPaused === 'function') core.setPaused(!!on);
    } catch (_) {}
  }

  // Wait until the URDF meshes stop arriving (assetToMeshes settles).
  function waitForAssetMapToSettle_local(assetToMeshesLocal, maxWaitMs = 8000, quietMs = 350) {
    if (!assetToMeshesLocal) return Promise.resolve({ meshes: 0, settled: true, timeout: false });
    const start = performance.now();
    let lastCount = -1;
    let lastChange = performance.now();

    function countNow() {
      let n = 0;
      try {
        assetToMeshesLocal.forEach((arr) => {
          n += arr && arr.length ? arr.length : 0;
        });
      } catch (_) {}
      return n;
    }

    return new Promise((resolve) => {
      function tick() {
        const now = performance.now();
        const c = countNow();
        if (c !== lastCount) {
          lastCount = c;
          lastChange = now;
        }
        const settled = now - lastChange >= quietMs;
        const timeout = now - start >= maxWaitMs;
        if (settled || timeout) resolve({ meshes: c, settled, timeout });
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
  }

  async function _thumbNoPrime(assetKey) {
    if (!assetKey) return null;
    if (thumbCache.has(assetKey)) return thumbCache.get(assetKey);

    const ses = await ensureSession();
    if (!ses) return null;

    return enqueue(async () => {
      if (thumbCache.has(assetKey)) return thumbCache.get(assetKey);

      pauseLoop(true);
      try {
        const vis = setVisibleOnly(ses, assetKey);
        const box = computeVisibleBox(ses);
        fitCameraIso(ses, box);

        if (vis && vis.usedFallback) {
          debugLog('[Thumbs] key mismatch → fallback showAll', { assetKey });
        }

        const url = renderToDataURL(ses);
        if (url) thumbCache.set(assetKey, url);
        return url;
      } finally {
        pauseLoop(false);
      }
    });
  }

  async function _isoNoPrime() {
    if (isoCache) return isoCache;

    const ses = await ensureSession();
    if (!ses) return null;

    return enqueue(async () => {
      pauseLoop(true);
      try {
        if (isoCache) return isoCache;

        setVisibleOnly(ses, null);
        const box = computeVisibleBox(ses);
        fitCameraIso(ses, box);

        const url = renderToDataURL(ses);
        if (url) isoCache = url;
        return url;
      } finally {
        pauseLoop(false);
      }
    });
  }

  async function primeAll(assetKeys = []) {
    if (priming) return priming;

    priming = (async () => {
      try {
        // ✅ FIX: ahora sí tenemos assetToMeshes aquí
        if (assetToMeshes) await waitForAssetMapToSettle_local(assetToMeshes, 12000, 450);

        await _isoNoPrime();

        const keys = Array.isArray(assetKeys) ? assetKeys : [];
        for (const k of keys) {
          await _thumbNoPrime(k);
        }

        debugLog('[Thumbs] primeAll done', { wanted: keys.length, ok: thumbCache.size, BG });
      } finally {
        destroySession();
      }
    })();

    return priming;
  }

  async function thumbnail(assetKey) {
    if (!assetKey) return null;
    if (thumbCache.has(assetKey)) return thumbCache.get(assetKey);
    if (priming) {
      await priming;
      return thumbCache.get(assetKey) || null;
    }
    return _thumbNoPrime(assetKey);
  }

  async function iso() {
    if (isoCache) return isoCache;
    if (priming) {
      await priming;
      return isoCache || null;
    }
    return _isoNoPrime();
  }

  return {
    thumbnail,
    iso,
    primeAll,
    has: (k) => thumbCache.has(k),
    destroy: destroySession,
    _cache: thumbCache,
  };
}

/* ================= IA opt-in: describe_component_images ================= */

function bootstrapComponentDescriptions(app, assetToMeshes, off) {
  debugLog('[IA] bootstrapComponentDescriptions start');

  if (!off || typeof off.thumbnail !== 'function') {
    debugLog('[IA] Offscreen no disponible; cancelando IA');
    return;
  }

  const hasColab =
    typeof window !== 'undefined' &&
    window.google &&
    window.google.colab &&
    window.google.colab.kernel &&
    typeof window.google.colab.kernel.invokeFunction === 'function';

  debugLog('[IA] Colab bridge?', hasColab);
  if (!hasColab) return;

  const items = listAssets(assetToMeshes);
  debugLog('[IA] Componentes a describir', items.length);
  if (!items.length) return;

  (async () => {
    try {
      const entries = [];

      // 1) ISO del robot completo
      if (typeof off.iso === 'function') {
        try {
          const isoUrl = await off.iso();
          if (isoUrl) {
            const isoB64 = await makeApproxSizedBase64(isoUrl, 8);
            if (isoB64) {
              entries.push({
                key: '__robot_iso__',
                name: 'robot_iso',
                index: -1,
                image_b64: isoB64,
              });
              debugLog('[IA] __robot_iso__ agregado al payload IA');
            }
          }
        } catch (e) {
          debugLog('[IA] Error generando ISO robot', String(e));
        }
      }

      // 2) Componentes
      let idx = 0;
      for (const ent of items) {
        try {
          const url = await off.thumbnail(ent.assetKey);
          if (!url) continue;

          const b64 = await makeApproxSizedBase64(url, 5);
          if (!b64) continue;

          entries.push({
            key: ent.assetKey,
            name: ent.base,
            index: idx,
            image_b64: b64,
          });
          idx += 1;
        } catch (e) {
          debugLog('[IA] Error thumb IA', ent.assetKey, String(e));
        }
      }

      debugLog('[IA] entries generadas', entries.length);
      if (!entries.length) return;

      let res;
      try {
        res = await window.google.colab.kernel.invokeFunction(
          'describe_component_images',
          [entries],
          {},
        );
        debugLog('[IA] invokeFunction OK', res);
      } catch (e) {
        debugLog('[IA] invokeFunction error', String(e));
        return;
      }

      const map = extractDescMap(res);
      debugLog('[IA] parsed map', map);

      if (map && typeof map === 'object' && Object.keys(map).length) {
        applyIaDescriptionsToApp(app, map);
      } else {
        debugLog('[IA] Respuesta IA sin mapa utilizable');
      }
    } catch (err) {
      debugLog('[IA] Error en bootstrapComponentDescriptions', String(err));
    }
  })();
}

/* ====== extractDescMap / parseMaybePythonDict / applyIaDescriptions ===== */

function extractDescMap(res) {
  if (!res) return null;

  let data = res.data ?? res;

  // Caso Colab típico: data['application/json']
  if (
    data &&
    typeof data === 'object' &&
    data['application/json'] &&
    typeof data['application/json'] === 'object'
  ) {
    return data['application/json'];
  }

  // Caso actual: data['text/plain'] = "{'base.dae': '...'}"
  if (data && typeof data === 'object' && typeof data['text/plain'] === 'string') {
    const raw = data['text/plain'].trim();
    const parsed = parseMaybePythonDict(raw);
    if (parsed) return parsed;
  }

  // Si es string plano, intentar parsear igual
  if (typeof data === 'string') {
    const parsed = parseMaybePythonDict(data.trim());
    if (parsed) return parsed;
  }

  // Si ya es objeto razonable, úsalo
  if (
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    !(Object.keys(data).length === 1 && 'text/plain' in data)
  ) {
    return data;
  }

  // Array de objetos: tomar el primero
  if (Array.isArray(data) && data.length && typeof data[0] === 'object') {
    return data[0];
  }

  return null;
}

/**
 * ✅ Nueva versión robusta:
 *  - Soporta dict Python: {'base.dae': '...'}
 *  - Soporta JSON válido.
 *  - Fallback con Function(...) sólo en este contexto controlado.
 */
function parseMaybePythonDict(raw) {
  if (!raw) return null;
  raw = String(raw).trim();
  if (!raw.startsWith('{') || !raw.endsWith('}')) return null;

  // 1) Intento JSON directo
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j;
  } catch (_) {}

  // 2) Intento: reemplazar sintaxis Python -> JS y evaluar de forma controlada
  try {
    let expr = raw;

    // Normalizar booleanos / None
    expr = expr.replace(/\bNone\b/g, 'null');
    expr = expr.replace(/\bTrue\b/g, 'true');
    expr = expr.replace(/\bFalse\b/g, 'false');

    // Ejemplo: {'base.dae': 'texto'} es válido en new Function("return (...)").
    const obj = new Function('return (' + expr + ')')();
    if (obj && typeof obj === 'object') return obj;
  } catch (_) {}

  // 3) Fallback muy simple: intentar extraer pares 'k': 'v'
  try {
    const out = {};
    const inner = raw.slice(1, -1);
    const regex = /'([^']+)'\s*:\s*'([^']*)'/g;
    let m;
    while ((m = regex.exec(inner))) {
      const key = m[1];
      let val = m[2] || '';
      val = val.replace(/\\n/g, '\n');
      out[key] = val;
    }
    if (Object.keys(out).length) return out;
  } catch (_) {}

  return null;
}

function applyIaDescriptionsToApp(app, map) {
  if (!map || typeof map !== 'object') return;

  if (!app.componentDescriptions || typeof app.componentDescriptions !== 'object') {
    app.componentDescriptions = {};
  }

  const store = app.componentDescriptions;

  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'string' && v.trim()) {
      store[String(k).toLowerCase()] = v.trim();
    }
  }

  if (!app.__patchedGetComponentDescription) {
    const orig = app.getComponentDescription ? app.getComponentDescription.bind(app) : null;

    app.getComponentDescription = function (assetKey, index = 0) {
      const cd = app.componentDescriptions || {};
      const values = Object.values(cd);

      if (assetKey) {
        const key = String(assetKey).toLowerCase();
        if (cd[key]) return cd[key];

        const base = key.split(/[\\/]/).pop();
        if (cd[base]) return cd[base];

        for (const k of Object.keys(cd)) {
          if (k.endsWith('/' + base)) return cd[k];
        }
      }

      if (orig) {
        const fromOrig = orig(assetKey, index);
        if (fromOrig) return fromOrig;
      }

      return values[index] || values[0] || '';
    };

    app.__patchedGetComponentDescription = true;
  }

  const detail = { map: app.componentDescriptions };

  if (typeof app.emit === 'function') {
    try {
      app.emit('ia_descriptions_ready', detail);
    } catch (_) {}
  }

  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('ia_descriptions_ready', { detail }));
    }
  } catch (_) {}

  debugLog('[IA] Descripciones IA aplicadas; ia_descriptions_ready emitido', detail);
}

/* =================== Reducción thumbnails ~5KB =================== */

async function makeApproxSizedBase64(dataURL, targetKB = 5) {
  try {
    const maxBytes = targetKB * 1024;

    const resp = await fetch(dataURL);
    const blob = await resp.blob();

    const img = document.createElement('img');
    const u = URL.createObjectURL(blob);

    await new Promise((res, rej) => {
      img.onload = () => res();
      img.onerror = rej;
      img.src = u;
    });

    const ratio = Math.min(1, Math.max(0.05, maxBytes / (blob.size || maxBytes)));
    const scale = Math.sqrt(ratio);

    const w = Math.max(32, Math.floor(img.width * scale));
    const h = Math.max(32, Math.floor(img.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);

    URL.revokeObjectURL(u);

    const out = canvas.toDataURL('image/png');
    const b64 = out.split(',')[1] || '';
    if (!b64) return null;

    debugLog('[IA] makeApproxSizedBase64 bytes ~', Math.floor((b64.length * 3) / 4));
    return b64;
  } catch (e) {
    debugLog('[IA] makeApproxSizedBase64 error', String(e));
    return null;
  }
}

/* ================= Click sound + global hook ================= */

function installClickSound(dataURL) {
  if (!dataURL || typeof dataURL !== 'string') return;

  let ctx = null;
  let buf = null;

  async function ensure() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (!buf) {
      const resp = await fetch(dataURL);
      const arr = await resp.arrayBuffer();
      buf = await ctx.decodeAudioData(arr);
    }
  }

  function play() {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (ctx.state === 'suspended') ctx.resume();

    if (!buf) {
      ensure().then(play).catch(() => {});
      return;
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    try {
      src.start();
    } catch (_) {}
  }

  window.__urdf_click__ = play;
}

if (typeof window !== 'undefined') {
  window.URDFViewer = window.URDFViewer || {};
  window.URDFViewer.render = (opts) => {
    const app = render(opts);
    try {
      window.URDFViewer.__app = app;
    } catch (_) {}
    return app;
  };
}
