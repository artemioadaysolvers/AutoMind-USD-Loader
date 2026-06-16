// /USD_Viewer/interaction/SelectionAndDrag.js
// Hover + selection + USD joint dragging + 'i' isolate/restore.
/* global THREE */

const HOVER_COLOR = 0x0ea5a6;
const HOVER_OPACITY = 0.28;

function isMovable(j) {
  const t = String(j?.jointType || '').toLowerCase();
  return !!t && t !== 'fixed';
}
function isPrismatic(j) { return String(j?.jointType || '').toLowerCase() === 'prismatic'; }
function getJointValue(j) { return isPrismatic(j) ? (j.position || 0) : (j.angle || 0); }
function setJointValue(robot, j, v) {
  if (!robot || !j) return;
  if (typeof j.setJointValue === 'function') j.setJointValue(v);
  else if (typeof robot.setJointValue === 'function') robot.setJointValue(j.name, v);
  robot.updateMatrixWorld?.(true);
}
function collectMeshesInLink(linkObj) {
  const out = [];
  linkObj?.traverse?.(o => { if (o.isMesh && o.geometry && !o.userData.__isHoverOverlay) out.push(o); });
  return out;
}
function computeUnionBox(meshes) {
  const box = new THREE.Box3(); let has = false; const tmp = new THREE.Box3();
  for (const m of meshes || []) { tmp.setFromObject(m); if (!has) { box.copy(tmp); has = true; } else box.union(tmp); }
  return has ? box : null;
}
function findAncestorLink(o, linkSet) {
  while (o) { if (linkSet.has(o)) return o; o = o.parent; }
  return null;
}
function nearestMovableJointFromLink(link) {
  let n = link;
  while (n) {
    const j = n.userData?.__joint;
    if (isMovable(j)) return j;
    n = n.parent;
  }
  // USD links are flat under robot; use linkInfo parent chain if available.
  const model = link?.userData?.__model;
  const linkInfo = link?.userData?.__linkInfo;
  if (model && linkInfo && model._manipulableJointByLink?.has(linkInfo.name)) {
    const routed = model._manipulableJointByLink.get(linkInfo.name);
    if (isMovable(routed)) return routed;
  }
  if (model && linkInfo) {
    let info = linkInfo;
    const seen = new Set();
    while (info && !seen.has(info.name)) {
      seen.add(info.name);
      const pj = model.joints?.[info.parentJoint];
      if (!pj) break;
      if (isMovable(pj)) return pj;
      info = model._linkInfo?.[pj.body0];
    }
  }
  return null;
}
function buildHoverOverlay({ color = HOVER_COLOR, opacity = HOVER_OPACITY } = {}) {
  const overlays = [];
  function clear() { overlays.splice(0).forEach(o => { try { o.parent?.remove(o); o.material?.dispose?.(); } catch (_) {} }); }
  function overlayFor(mesh) {
    if (!mesh?.isMesh || !mesh.geometry) return null;
    const m = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: 1 }));
    m.renderOrder = 9999; m.userData.__isHoverOverlay = true; return m;
  }
  function showLink(link) { for (const mesh of collectMeshesInLink(link)) { const ov = overlayFor(mesh); if (ov) { mesh.add(ov); overlays.push(ov); } } }
  function showMesh(mesh) { const ov = overlayFor(mesh); if (ov) { mesh.add(ov); overlays.push(ov); } }
  return { clear, showLink, showMesh };
}

export function attachInteraction({ scene, camera, renderer, controls, robot, selectMode = 'link' }) {
  if (!scene || !camera || !renderer || !controls) throw new Error('[USD SelectionAndDrag] Missing required core objects');

  let robotModel = robot || null;
  let linkSet = new Set(Object.values(robotModel?.links || {}));
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hover = buildHoverOverlay();
  let lastHover = null;
  let selectedMeshes = [];
  let selectedLink = null;
  let selectionHelper = null;
  let isolated = false;
  let dragState = null;

  function setRobot(r) { robotModel = r; linkSet = new Set(Object.values(robotModel?.links || {})); clearSelection(); }
  function ensureSelectionHelper() {
    if (!selectionHelper) { selectionHelper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5), new THREE.Vector3(.5,.5,.5)), new THREE.Color(HOVER_COLOR)); selectionHelper.visible = false; selectionHelper.renderOrder = 10001; scene.add(selectionHelper); }
    return selectionHelper;
  }
  function refreshSelectionMarker() {
    const h = ensureSelectionHelper();
    const box = computeUnionBox(selectedMeshes);
    if (!box) { h.visible = false; return; }
    h.box.copy(box); h.updateMatrixWorld(true); h.visible = true;
  }
  function setSelected(link, mesh = null) {
    selectedLink = link || null;
    if (selectMode === 'mesh' && mesh) selectedMeshes = [mesh];
    else selectedMeshes = link ? collectMeshesInLink(link) : [];
    refreshSelectionMarker();
  }
  function clearSelection() { selectedMeshes = []; selectedLink = null; if (selectionHelper) selectionHelper.visible = false; }
  function pointerFromEvent(e) {
    const r = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1;
    pointer.y = -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1;
  }
  function meshHits(e) {
    pointerFromEvent(e); raycaster.setFromCamera(pointer, camera);
    const pickables = [];
    robotModel?.traverse?.(o => { if (o.isMesh && o.geometry && o.visible && !o.userData.__isHoverOverlay) pickables.push(o); });
    return raycaster.intersectObjects(pickables, true);
  }
  function firstLinkHit(e) {
    const hits = meshHits(e);
    if (!hits.length) return { link: null, mesh: null };
    const mesh = hits[0].object;
    const link = findAncestorLink(mesh, linkSet) || (mesh.userData.__linkName ? robotModel?.links?.[mesh.userData.__linkName] : null);
    return { link, mesh };
  }

  function startJointDrag(joint, ev) {
    if (!joint || !isMovable(joint)) return false;
    const originW = joint.getWorldPosition ? joint.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    const qWorld = joint.getWorldQuaternion ? joint.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    const axisW = (joint.axis || new THREE.Vector3(1,0,0)).clone().normalize().applyQuaternion(qWorld).normalize();
    const planeNormal = isPrismatic(joint) ? camera.getWorldDirection(new THREE.Vector3()).normalize() : axisW.clone();
    const dragPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeNormal, originW);
    raycaster.setFromCamera(pointer, camera);
    const p0 = new THREE.Vector3();
    let r0 = null, t0 = 0;
    if (raycaster.ray.intersectPlane(dragPlane, p0)) {
      r0 = p0.clone().sub(originW);
      t0 = p0.clone().sub(originW).dot(axisW);
      if (r0.lengthSq() > 1e-12) r0.normalize(); else r0 = null;
    }
    dragState = { joint, originW, axisW, dragPlane, r0, t0, value: getJointValue(joint), lastClientX: ev.clientX, lastClientY: ev.clientY };
    if (robotModel) robotModel._isDraggingJoint = true;
    controls.enabled = false; renderer.domElement.style.cursor = 'grabbing';
    try { renderer.domElement.setPointerCapture(ev.pointerId); } catch (_) {}
    return true;
  }
  function updateJointDrag(ev) {
    const ds = dragState; if (!ds) return;
    const fine = ev.shiftKey ? 0.35 : 1.0;
    pointerFromEvent(ev); raycaster.setFromCamera(pointer, camera);
    const dX = ev.clientX - (ds.lastClientX ?? ev.clientX);
    const dY = ev.clientY - (ds.lastClientY ?? ev.clientY);
    ds.lastClientX = ev.clientX; ds.lastClientY = ev.clientY;
    const hit = new THREE.Vector3();
    if (isPrismatic(ds.joint)) {
      let delta = 0;
      if (raycaster.ray.intersectPlane(ds.dragPlane, hit)) {
        const t1 = hit.clone().sub(ds.originW).dot(ds.axisW);
        delta = t1 - (ds.lastT ?? ds.t0 ?? t1); ds.lastT = t1;
      } else delta = -dY * 0.003;
      ds.value += delta * fine;
    } else {
      let delta = 0;
      if (raycaster.ray.intersectPlane(ds.dragPlane, hit)) {
        let r1 = hit.clone().sub(ds.originW);
        if (r1.lengthSq() >= 1e-12) {
          r1.normalize(); if (!ds.r0) ds.r0 = r1.clone();
          const cross = new THREE.Vector3().crossVectors(ds.r0, r1);
          delta = Math.atan2(cross.dot(ds.axisW), clamp(ds.r0.dot(r1), -1, 1));
          ds.r0.copy(r1);
        }
      }
      if (!delta) delta = (dX - dY) * 0.01;
      ds.value += delta * fine;
    }
    setJointValue(robotModel, ds.joint, ds.value);
    refreshSelectionMarker();
  }
  function endJointDrag(ev) {
    if (!dragState) return;
    try { renderer.domElement.releasePointerCapture(ev.pointerId); } catch (_) {}
    if (robotModel) robotModel._isDraggingJoint = false;
    dragState = null; controls.enabled = true; renderer.domElement.style.cursor = '';
    refreshSelectionMarker();
  }
  function isolateSelected() {
    if (!robotModel || !selectedLink) return;
    if (isolated) {
      robotModel.traverse(o => { if (o.isMesh && o.geometry) o.visible = true; }); isolated = false; refreshSelectionMarker(); return;
    }
    const keep = new Set(collectMeshesInLink(selectedLink));
    robotModel.traverse(o => { if (o.isMesh && o.geometry) o.visible = keep.has(o); });
    isolated = true; refreshSelectionMarker();
  }

  function onMove(e) {
    if (dragState) { updateJointDrag(e); return; }
    const { link, mesh } = firstLinkHit(e);
    const key = link || mesh;
    if (key !== lastHover) {
      hover.clear(); lastHover = key;
      if (link) hover.showLink(link); else if (mesh) hover.showMesh(mesh);
    }
    renderer.domElement.style.cursor = link ? (nearestMovableJointFromLink(link) ? 'grab' : 'pointer') : '';
  }
  function onDown(e) {
    if (e.button !== 0) return;
    const { link, mesh } = firstLinkHit(e);
    if (!link && !mesh) { clearSelection(); return; }
    setSelected(link, mesh);
    const j = link ? nearestMovableJointFromLink(link) : null;
    if (j) startJointDrag(j, e);
  }
  function onUp(e) { endJointDrag(e); }
  function onKey(e) { if (String(e.key || '').toLowerCase() === 'i') isolateSelected(); }

  renderer.domElement.addEventListener('pointermove', onMove, true);
  renderer.domElement.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);

  return {
    setRobot,
    get selectedLink() { return selectedLink; },
    clearSelection,
    refreshSelectionMarker,
    destroy() {
      hover.clear(); if (selectionHelper) scene.remove(selectionHelper);
      renderer.domElement.removeEventListener('pointermove', onMove, true);
      renderer.domElement.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    }
  };
}

export default { attachInteraction };
