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
  try { core.setMechanismSuppressed?.(kept.length > 0, duration); } catch (_) {}
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
  // BUILD152: same visual contract as the USD viewer.
  // Show Joints and Show Loops are dynamic LineSegments batches, not ArrowHelper
  // objects. This keeps URDF+ overlays visually identical to USD: thin teal joint
  // axes and amber loop/closure threads, with the same clipping/opacity behavior.
  let showAxes = false;
  let showLoops = false;
  const axisBatch = { line: null, joints: [], positions: null, scale: 1, baseOpacity: 0.95 };
  const loopBatch = { line: null, items: [], positions: null, baseOpacity: 0.95 };
  const loops = parseURDFLoopDescriptors(urdfText, robot);

  function effectiveOpacity() {
    const v = Number.isFinite(core?.__mechanismOpacity) ? core.__mechanismOpacity : 1;
    return Math.max(0, Math.min(1, v));
  }
  function disposeLine(line) {
    try { line?.geometry?.dispose?.(); } catch (_) {}
    try {
      const mat = line?.material;
      if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.());
      else mat?.dispose?.();
    } catch (_) {}
    try { line?.parent?.remove?.(line); } catch (_) {}
  }
  function setLineOpacity(line, baseOpacity = 0.95) {
    const mat = line?.material;
    const arr = Array.isArray(mat) ? mat : [mat];
    const op = Math.max(0, Math.min(1, baseOpacity * effectiveOpacity()));
    for (const m of arr) {
      if (!m) continue;
      m.opacity = op;
      m.transparent = true;
      m.depthWrite = false;
      m.depthTest = false;
      m.clippingPlanes = core?.__mechanismClipPlane ? [core.__mechanismClipPlane] : null;
      m.needsUpdate = true;
    }
  }
  function modelDim() {
    const b = fitSphereFromObject(robot);
    return Math.max(b?.maxDim || b?.radius || 1, 1e-6);
  }
  function decorationScale() {
    return Math.max(modelDim() * 0.16, 0.012);
  }
  function jointWorldAxis(j) {
    try {
      const a = (robot.getJointWorldAxis ? robot.getJointWorldAxis(j) : new THREE.Vector3(1,0,0)).clone().normalize();
      return a.lengthSq() > 1e-12 ? a : new THREE.Vector3(1,0,0);
    } catch (_) { return new THREE.Vector3(1,0,0); }
  }
  function jointWorldPivot(j) {
    try { return robot.getJointWorldPivot ? robot.getJointWorldPivot(j) : (j.getWorldPosition ? j.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3()); } catch (_) { return new THREE.Vector3(); }
  }
  function isDrawableJoint(j) {
    const t = String(j?.jointType || j?.type || j?.schema || '').toLowerCase();
    return t.includes('revolute') || t.includes('continuous') || t.includes('prismatic') || t.includes('floating') || t.includes('planar') || t.includes('hinge') || t.includes('slider');
  }
  function collectAxisJoints() {
    const vals = Object.values(robot?.joints || {}).filter(Boolean);
    const movable = vals.filter(isDrawableJoint);
    return movable.length ? movable : vals.filter(j => j && (j.parent || j.parentLink || j.child || j.childLink));
  }
  function loopEndpoints(lp) {
    if (lp?.joint) return { a: robot?.links?.[lp.joint.body0 || lp.joint.parent], b: robot?.links?.[lp.joint.body1 || lp.joint.child] };
    return { a: robot?.links?.[lp.a], b: robot?.links?.[lp.b] };
  }
  function rebuild() {
    disposeLine(axisBatch.line); axisBatch.line = null; axisBatch.joints = []; axisBatch.positions = null;
    disposeLine(loopBatch.line); loopBatch.line = null; loopBatch.items = []; loopBatch.positions = null;

    const axisJoints = collectAxisJoints();
    axisBatch.joints = axisJoints;
    axisBatch.scale = decorationScale();
    const axisGeom = new THREE.BufferGeometry();
    axisBatch.positions = new Float32Array(Math.max(1, axisJoints.length * 6));
    axisGeom.setAttribute('position', new THREE.BufferAttribute(axisBatch.positions, 3).setUsage(THREE.DynamicDrawUsage));
    axisGeom.setDrawRange(0, axisJoints.length * 2);
    const axisMat = new THREE.LineBasicMaterial({ color: 0x087ea4, transparent: true, opacity: 0.0, depthTest: false, depthWrite: false });
    const axisLine = new THREE.LineSegments(axisGeom, axisMat);
    axisLine.name = 'automind_joint_axes_batch';
    axisLine.renderOrder = 9998;
    axisLine.frustumCulled = false;
    axisLine.visible = !!showAxes && effectiveOpacity() > 0.001 && axisJoints.length > 0;
    core.scene.add(axisLine);
    axisBatch.line = axisLine;

    const loopItems = [];
    for (const lp of loops || []) loopItems.push({ kind: 'loop', ...lp });
    const modelLoopJoints = Array.isArray(robot?.loopJoints) ? robot.loopJoints : [];
    for (const j of modelLoopJoints) loopItems.push({ kind: 'loopJoint', joint: j });
    const implicit = Array.isArray(robot?.implicitCandidates) ? robot.implicitCandidates : [];
    for (const c of implicit) loopItems.push({ kind: 'implicit', candidate: c, a: c.body0 || c.link0 || c.a, b: c.body1 || c.link1 || c.b });

    loopBatch.items = loopItems;
    const loopGeom = new THREE.BufferGeometry();
    loopBatch.positions = new Float32Array(Math.max(1, loopItems.length * 6));
    loopGeom.setAttribute('position', new THREE.BufferAttribute(loopBatch.positions, 3).setUsage(THREE.DynamicDrawUsage));
    loopGeom.setDrawRange(0, loopItems.length * 2);
    const loopMat = new THREE.LineBasicMaterial({ color: 0xb7791f, transparent: true, opacity: 0.0, depthTest: false, depthWrite: false });
    const loopLine = new THREE.LineSegments(loopGeom, loopMat);
    loopLine.name = 'automind_loops_batch';
    loopLine.renderOrder = 9999;
    loopLine.frustumCulled = false;
    loopLine.visible = !!showLoops && effectiveOpacity() > 0.001 && loopItems.length > 0;
    core.scene.add(loopLine);
    loopBatch.line = loopLine;
    update();
  }
  function update() {
    if (axisBatch.line) {
      const visible = !!showAxes && effectiveOpacity() > 0.001 && axisBatch.joints.length > 0;
      axisBatch.line.visible = visible;
      setLineOpacity(axisBatch.line, axisBatch.baseOpacity);
      if (visible) {
        let k = 0;
        const p = new THREE.Vector3();
        const a = new THREE.Vector3();
        const s = axisBatch.scale || decorationScale();
        for (const j of axisBatch.joints) {
          p.copy(jointWorldPivot(j));
          a.copy(jointWorldAxis(j));
          axisBatch.positions[k++] = p.x - a.x * s; axisBatch.positions[k++] = p.y - a.y * s; axisBatch.positions[k++] = p.z - a.z * s;
          axisBatch.positions[k++] = p.x + a.x * s; axisBatch.positions[k++] = p.y + a.y * s; axisBatch.positions[k++] = p.z + a.z * s;
        }
        axisBatch.line.geometry.attributes.position.needsUpdate = true;
        axisBatch.line.geometry.computeBoundingSphere?.();
      }
    }
    if (loopBatch.line) {
      const visible = !!showLoops && effectiveOpacity() > 0.001 && loopBatch.items.length > 0;
      loopBatch.line.visible = visible;
      setLineOpacity(loopBatch.line, loopBatch.baseOpacity);
      if (visible) {
        let k = 0;
        const pa = new THREE.Vector3();
        const pb = new THREE.Vector3();
        for (const it of loopBatch.items) {
          let aObj = null, bObj = null;
          if (it.candidate) {
            aObj = robot?.links?.[it.candidate.body0 || it.candidate.link0 || it.candidate.a];
            bObj = robot?.links?.[it.candidate.body1 || it.candidate.link1 || it.candidate.b];
          } else {
            const ep = loopEndpoints(it);
            aObj = ep.a; bObj = ep.b;
          }
          if (!aObj || !bObj) { pa.set(0,0,0); pb.set(0,0,0); }
          else { aObj.getWorldPosition(pa); bObj.getWorldPosition(pb); }
          loopBatch.positions[k++] = pa.x; loopBatch.positions[k++] = pa.y; loopBatch.positions[k++] = pa.z;
          loopBatch.positions[k++] = pb.x; loopBatch.positions[k++] = pb.y; loopBatch.positions[k++] = pb.z;
        }
        loopBatch.line.geometry.attributes.position.needsUpdate = true;
        loopBatch.line.geometry.computeBoundingSphere?.();
      }
    }
  }
  function set({ jointAxes, loops: nextLoops } = {}) {
    if (typeof jointAxes === 'boolean') showAxes = jointAxes;
    if (typeof nextLoops === 'boolean') showLoops = nextLoops;
    rebuild();
  }
  function destroy() {
    disposeLine(axisBatch.line); axisBatch.line = null;
    disposeLine(loopBatch.line); loopBatch.line = null;
  }
  core.renderer.__automindUpdateMechanismDecorations = update;
  return { set, destroy, update };
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

  debugLog('render() init UNIFIED_URDFPLUS_BUILD151_FULL_EXTRAS_GRID_TWEEN_JOINTS', { selectMode, background, IA_Widgets });

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
  const robot = core.loadURDF(urdfContent, { loadMeshCb });
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
    setMechanismClippingPlane: (_plane) => {},
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

      const keys = Array.from(assetToMeshes.keys());
      await off.primeAll(keys);

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
  robot.traverse((o) => {
    if (o && o.isMesh && o.geometry) {
      const k =
        (o.userData &&
          (o.userData.__assetKey || o.userData.assetKey || o.userData.filename)) ||
        null;
      if (!k) return;
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
  try { core.setMechanismSuppressed?.(false, 620); } catch (_) {}
  const meshes = collectRobotMeshes(core.robot);
  animateMeshVisibility(core, meshes, true, 620, () => {
    try { core?.interaction?.clearHover?.(); core?.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  });
  viewIso(core, core.robot, 750);
}

/* ============= Offscreen thumbnails: componente + ISO robot ============= */

function buildOffscreenForThumbnails(core, assetToMeshes, theme) {
  // BUILD152: USD-style component preview renderer.
  // It does not clone the whole robot early.  It renders the actual meshes listed
  // in assetToMeshes into a WebGLRenderTarget using the existing renderer, waits
  // briefly for real texture maps to decode, and falls back to readable CAD
  // materials instead of returning a blank/white preview.
  const W = 320;
  const H = 320;
  const BG = (() => {
    const v = (theme && (theme.thumbBg ?? theme.bgCanvas ?? theme.background ?? theme.bg)) ?? 0xffffff;
    if (typeof v === 'number' && isFinite(v)) return v >>> 0;
    if (typeof v === 'string') {
      const s = v.trim();
      const hex = s.startsWith('#') ? s.slice(1) : s.startsWith('0x') ? s.slice(2) : s;
      if (/^[0-9a-fA-F]{6}$/.test(hex)) return parseInt(hex, 16) >>> 0;
    }
    return 0xffffff;
  })();
  const EDGE_COLOR = 0x8fa3ad;
  const cache = new Map();
  let isoCache = null;
  let disposed = false;
  let chain = Promise.resolve();
  let priming = null;
  const enqueue = (fn) => { chain = chain.then(fn, fn); return chain; };

  function textureLooksBroken(tex) {
    if (!tex) return false;
    const img = tex.image;
    if (!img) return true;
    if (img.data && img.width && img.height) return false;
    if (typeof HTMLImageElement !== 'undefined' && img instanceof HTMLImageElement) {
      return !(img.complete && img.naturalWidth > 0 && img.naturalHeight > 0);
    }
    if ('width' in img && 'height' in img) return !(Number(img.width) > 0 && Number(img.height) > 0);
    return false;
  }
  function hasLoadedImage(tex) { return !!tex && !textureLooksBroken(tex); }
  function materialHasAnyTexture(mat) {
    if (!mat) return false;
    return ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap'].some(k => !!mat[k]);
  }
  function texturesInMeshes(meshes) {
    const maps = [];
    const seen = new Set();
    for (const mesh of meshes || []) {
      const mats = materialList(mesh?.material);
      for (const mat of mats) {
        for (const k of ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap']) {
          const tex = mat?.[k];
          if (tex && !seen.has(tex)) { seen.add(tex); maps.push(tex); }
        }
      }
    }
    return maps;
  }
  async function waitForTextures(meshes, maxWaitMs = 1800) {
    const maps = texturesInMeshes(meshes);
    if (!maps.length) return { maps, loaded: true };
    const start = performance.now();
    while (performance.now() - start < maxWaitMs) {
      if (maps.every(hasLoadedImage)) return { maps, loaded: true };
      await new Promise(r => setTimeout(r, 70));
    }
    return { maps, loaded: maps.every(hasLoadedImage) };
  }
  function cloneMaterialForPreview(src, paletteIndex = 0) {
    const palette = [0xdfe8ea, 0xb9c7d6, 0x8ecae6, 0xcdb4db, 0xa7c957, 0xf6bd60, 0x90dbf4];
    if (src?.map && !textureLooksBroken(src.map)) {
      try { src.map.needsUpdate = true; } catch (_) {}
      const mat = new THREE.MeshBasicMaterial({
        map: src.map,
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: !!src.transparent || (Number(src.opacity) < 1),
        opacity: Number.isFinite(src.opacity) ? Math.max(src.opacity, 0.18) : 1,
        alphaTest: Number.isFinite(src.alphaTest) ? src.alphaTest : 0
      });
      mat.toneMapped = false;
      mat.needsUpdate = true;
      return mat;
    }
    let mat = null;
    if (src && typeof src.clone === 'function') mat = src.clone();
    else mat = new THREE.MeshStandardMaterial({ color: palette[paletteIndex % palette.length], roughness: 0.55, metalness: 0.04 });
    for (const k of ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap']) {
      if (mat[k] && textureLooksBroken(mat[k])) mat[k] = null;
    }
    mat.side = THREE.DoubleSide;
    if (!materialHasAnyTexture(mat)) {
      let c = mat.color;
      if (!c) mat.color = new THREE.Color(palette[paletteIndex % palette.length]);
      else {
        const white = c.r > 0.92 && c.g > 0.92 && c.b > 0.92;
        const black = c.r < 0.035 && c.g < 0.035 && c.b < 0.035;
        if (white || black) mat.color = new THREE.Color(palette[paletteIndex % palette.length]);
      }
    }
    if ('roughness' in mat) mat.roughness = Number.isFinite(mat.roughness) ? mat.roughness : 0.55;
    if ('metalness' in mat) mat.metalness = Number.isFinite(mat.metalness) ? mat.metalness : 0.04;
    mat.transparent = !!mat.transparent && Number(mat.opacity) < 0.999;
    if (Number(mat.opacity) <= 0.035) mat.opacity = 1;
    mat.depthWrite = true;
    mat.depthTest = true;
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
  function renderSceneToDataURL(scene, camera) {
    const renderer = core?.renderer;
    if (!renderer) return '';
    const oldTarget = renderer.getRenderTarget?.() || null;
    const oldViewport = renderer.getViewport ? renderer.getViewport(new THREE.Vector4()) : null;
    const oldScissor = renderer.getScissor ? renderer.getScissor(new THREE.Vector4()) : null;
    const oldScissorTest = renderer.getScissorTest ? renderer.getScissorTest() : false;
    const oldClear = renderer.getClearColor ? renderer.getClearColor(new THREE.Color()) : new THREE.Color(0xffffff);
    const oldAlpha = renderer.getClearAlpha ? renderer.getClearAlpha() : 1;
    const oldLocalClipping = renderer.localClippingEnabled;
    const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, stencilBuffer: false });
    const pixels = new Uint8Array(W * H * 4);
    try {
      renderer.localClippingEnabled = false;
      renderer.setRenderTarget(rt);
      renderer.setViewport(0, 0, W, H);
      renderer.setScissorTest(false);
      renderer.setClearColor(BG, 1);
      renderer.clear(true, true, true);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, pixels);
    } catch (e) {
      debugLog('[Thumbs BUILD152] render target failed', String(e));
      return '';
    } finally {
      try { renderer.setRenderTarget(oldTarget); } catch (_) {}
      try { if (oldViewport) renderer.setViewport(oldViewport); } catch (_) {}
      try { if (oldScissor) renderer.setScissor(oldScissor); } catch (_) {}
      try { renderer.setScissorTest(oldScissorTest); } catch (_) {}
      try { renderer.setClearColor(oldClear, oldAlpha); } catch (_) {}
      try { renderer.localClippingEnabled = oldLocalClipping; } catch (_) {}
      try { rt.dispose(); } catch (_) {}
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const imgData = ctx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4;
        const dst = y * W * 4;
        imgData.data.set(pixels.subarray(src, src + W * 4), dst);
      }
      ctx.putImageData(imgData, 0, 0);
      return canvas.toDataURL('image/png');
    } catch (e) {
      debugLog('[Thumbs BUILD152] canvas encode failed', String(e));
      return '';
    }
  }
  function allMeshesFromAssetMap() {
    const out = [];
    try { assetToMeshes?.forEach(arr => { for (const m of arr || []) if (m?.isMesh && m.geometry) out.push(m); }); } catch (_) {}
    if (!out.length) {
      try { core?.robot?.traverse?.(o => { if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) out.push(o); }); } catch (_) {}
    }
    return Array.from(new Set(out));
  }
  function buildPreviewScene(meshes) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BG);
    scene.add(new THREE.HemisphereLight(0xffffff, 0xcfe6e8, 2.4));
    scene.add(new THREE.AmbientLight(0xffffff, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(3, 4, 5); scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.75); fill.position.set(-4, -2, 3); scene.add(fill);
    const root = new THREE.Group();
    scene.add(root);

    for (const mesh of meshes || []) { try { mesh.updateMatrixWorld(true); } catch (_) {} }
    let i = 0;
    for (const mesh of meshes || []) {
      if (!mesh || !mesh.geometry) continue;
      const srcMats = materialList(mesh.material);
      const previewMat = Array.isArray(mesh.material) ? srcMats.map((m, mi) => cloneMaterialForPreview(m, i + mi)) : cloneMaterialForPreview(srcMats[0], i);
      const c = new THREE.Mesh(mesh.geometry, previewMat);
      c.matrixAutoUpdate = false;
      c.matrix.copy(mesh.matrixWorld);
      c.renderOrder = 1;
      root.add(c);
      try {
        const eg = new THREE.EdgesGeometry(mesh.geometry, 20);
        const em = new THREE.LineBasicMaterial({ color: EDGE_COLOR, transparent: true, opacity: 0.58 });
        const edges = new THREE.LineSegments(eg, em);
        edges.matrixAutoUpdate = false;
        edges.matrix.copy(mesh.matrixWorld);
        edges.renderOrder = 2;
        edges.userData.__ownedEdgeGeometry = true;
        root.add(edges);
      } catch (_) {}
      i++;
    }
    root.updateMatrixWorld(true);
    return { scene, root };
  }
  function cameraForRoot(root) {
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    root.position.sub(center);
    root.updateMatrixWorld(true);
    const camera = new THREE.PerspectiveCamera(35, W / H, Math.max(maxDim / 1000, 0.0001), Math.max(maxDim * 1000, 10));
    camera.position.set(maxDim * 1.9, maxDim * 1.35, maxDim * 1.9);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
    return camera;
  }
  async function renderMeshesToURL(meshes, cacheKey = '') {
    if (disposed) return '';
    const uniqueMeshes = Array.from(new Set((meshes || []).filter(m => m?.isMesh && m.geometry)));
    if (!uniqueMeshes.length) return '';
    const texStatus = await waitForTextures(uniqueMeshes);
    const { scene, root } = buildPreviewScene(uniqueMeshes);
    const cam = cameraForRoot(root);
    if (!cam) { disposePreview(root); return ''; }
    try {
      const url = renderSceneToDataURL(scene, cam);
      if (url && /^data:image\/png;base64,/i.test(url) && url.length > 64) {
        if (cacheKey && (!texStatus.maps.length || texStatus.loaded)) cache.set(cacheKey, url);
        else if (cacheKey) setTimeout(() => { try { cache.delete(cacheKey); } catch (_) {} }, 450);
        return url;
      }
      return '';
    } finally {
      disposePreview(root);
      try { scene.clear?.(); } catch (_) {}
    }
  }
  async function thumbnail(assetKey) {
    if (!assetKey || disposed) return null;
    if (cache.has(assetKey)) return cache.get(assetKey);
    return enqueue(async () => {
      if (cache.has(assetKey)) return cache.get(assetKey);
      let meshes = assetToMeshes?.get?.(assetKey) || [];
      if (!meshes.length) {
        const base = String(assetKey).split(/[\\/]/).pop().toLowerCase();
        try {
          assetToMeshes?.forEach((arr, key) => {
            if (meshes.length) return;
            const kb = String(key || '').split(/[\\/]/).pop().toLowerCase();
            if (String(key).toLowerCase() === String(assetKey).toLowerCase() || kb === base) meshes = arr || [];
          });
        } catch (_) {}
      }
      const url = await renderMeshesToURL(meshes, assetKey);
      return url || null;
    });
  }
  async function iso() {
    if (isoCache) return isoCache;
    return enqueue(async () => {
      if (isoCache) return isoCache;
      const url = await renderMeshesToURL(allMeshesFromAssetMap(), '__robot_iso__');
      if (url) isoCache = url;
      return isoCache || null;
    });
  }
  async function primeAll(assetKeys = []) {
    if (priming) return priming;
    priming = (async () => {
      try {
        await iso();
        for (const k of Array.from(assetKeys || [])) await thumbnail(k);
        debugLog('[Thumbs BUILD152] primeAll done', { wanted: Array.from(assetKeys || []).length, ok: cache.size });
      } finally {
        priming = null;
      }
    })();
    return priming;
  }
  function destroy() { disposed = true; cache.clear(); isoCache = null; }
  return { thumbnail, iso, primeAll, has: (k) => cache.has(k), destroy, _cache: cache };
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
