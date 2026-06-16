// /USD_Viewer/interaction/SelectionAndDrag.js
// USD+ BUILD131 movement adapter: hover, selection, exact joint drag routing and 360-camera friendly interaction.
/* global THREE */

const HOVER_COLOR = 0x0ea5a6;
const HOVER_OPACITY = 0.28;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function isMovable(j) {
  const t = String(j?.jointType || j?.type || '').toLowerCase();
  if (!j || !t) return false;
  if (j.exportedMovable === true && !/FixedJoint/i.test(j.schema || '')) return true;
  if (/revolute|continuous|hinge|prismatic/i.test(t)) return true;
  if (/RevoluteJoint|PrismaticJoint/i.test(j.schema || '')) return true;
  return false;
}
function isPrismatic(j) { return /prismatic/i.test(String(j?.jointType || j?.type || '')) || /Prismatic/i.test(j?.schema || ''); }
function getJointValue(j) { return Number(j?.value ?? (isPrismatic(j) ? j?.position : j?.angle) ?? 0) || 0; }
function setJointValue(robot, j, v) {
  if (!robot || !j) return;
  if (typeof j.setJointValue === 'function') j.setJointValue(v);
  else if (typeof robot.setJointValue === 'function') robot.setJointValue(j.name, v);
  robot.updateMatrixWorld?.(true);
}
function collectMeshesInLink(linkObj) {
  const out = [];
  linkObj?.traverse?.(o => { if (o?.isMesh && o.geometry && !o.userData.__isHoverOverlay) out.push(o); });
  return out;
}
function computeUnionBox(meshes) {
  const box = new THREE.Box3(); let has = false; const tmp = new THREE.Box3();
  for (const m of meshes || []) { if (!m) continue; tmp.setFromObject(m); if (!has) { box.copy(tmp); has = true; } else box.union(tmp); }
  return has ? box : null;
}
function findAncestorLink(o, linkSet) { while (o) { if (linkSet.has(o)) return o; o = o.parent; } return null; }
function buildHoverOverlay({ color = HOVER_COLOR, opacity = HOVER_OPACITY } = {}) {
  const overlays = [];
  function clear() { overlays.splice(0).forEach(o => { try { o.parent?.remove(o); o.material?.dispose?.(); } catch (_) {} }); }
  function overlayFor(mesh) {
    if (!mesh?.isMesh || !mesh.geometry) return null;
    const ov = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: 1 }));
    ov.renderOrder = 9999; ov.userData.__isHoverOverlay = true; return ov;
  }
  function showMesh(mesh) { const ov = overlayFor(mesh); if (ov) { mesh.add(ov); overlays.push(ov); } }
  function showLink(link) { for (const m of collectMeshesInLink(link)) showMesh(m); }
  return { clear, showMesh, showLink };
}

export function attachInteraction({ scene, camera, renderer, controls, robot, selectMode = 'link' }) {
  if (!scene || !camera || !renderer || !controls) throw new Error('[USD SelectionAndDrag] Missing core objects');
  let robotModel = robot || null;
  let linkSet = new Set(Object.values(robotModel?.links || {}));
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const hover = buildHoverOverlay();
  let lastHover = null;
  let selectedMeshes = [];
  let selectedLink = null;
  let selectionHelper = null;
  let isolated = false;
  let activeDrag = null;
  let lastHoverRaycastAt = 0;

  const dragPlane = new THREE.Plane();
  const dragAxisWorld = new THREE.Vector3();
  const dragPivotWorld = new THREE.Vector3();
  const dragPrevHit = new THREE.Vector3();
  const dragNewHit = new THREE.Vector3();
  const dragProjectedStart = new THREE.Vector3();
  const dragProjectedEnd = new THREE.Vector3();
  const dragTmp = new THREE.Vector3();
  const dragTmp2 = new THREE.Vector3();

  function setRobot(r) { robotModel = r; linkSet = new Set(Object.values(robotModel?.links || {})); clearSelection(); }
  function ensureSelectionHelper() {
    if (!selectionHelper) {
      selectionHelper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(-.5,-.5,-.5), new THREE.Vector3(.5,.5,.5)), new THREE.Color(HOVER_COLOR));
      selectionHelper.visible = false; selectionHelper.renderOrder = 10001; scene.add(selectionHelper);
    }
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
  function setPointerFromEvent(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointerNdc.y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    raycaster.setFromCamera(pointerNdc, camera);
    return raycaster.ray.clone();
  }
  function linkNameFromObject(obj) {
    let o = obj;
    while (o) { if (o.userData?.__linkName) return o.userData.__linkName; o = o.parent; }
    return '';
  }
  function pickInfoFromPointer(ev) {
    const ray = setPointerFromEvent(ev);
    const pickables = [];
    robotModel?.traverse?.(o => { if (o?.isMesh && o.geometry && o.visible !== false && !o.userData.__isHoverOverlay) pickables.push(o); });
    const hits = raycaster.intersectObjects(pickables, true);
    for (const hit of hits) {
      const linkName = linkNameFromObject(hit.object);
      const link = linkName ? robotModel?.links?.[linkName] : findAncestorLink(hit.object, linkSet);
      if (link) return { link, linkName: linkName || link.userData?.__linkName || link.name, hit, ray };
    }
    return null;
  }
  function getManipulableJointForLink(link) {
    if (!link || !robotModel) return null;
    const name = link.userData?.__linkName || link.name;
    if (typeof robotModel.getManipulableJointForLinkName === 'function') return robotModel.getManipulableJointForLinkName(name);
    let n = link;
    while (n) { const j = n.userData?.__joint; if (isMovable(j)) return j; n = n.parent; }
    return null;
  }
  function getJointWorldPivot(j) {
    if (robotModel?.getJointWorldPivot) return robotModel.getJointWorldPivot(j);
    return j?.getWorldPosition ? j.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
  }
  function getJointWorldAxis(j) {
    if (robotModel?.getJointWorldAxis) return robotModel.getJointWorldAxis(j);
    const q = j?.getWorldQuaternion ? j.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    return (j?.axis || new THREE.Vector3(1,0,0)).clone().normalize().applyQuaternion(q).normalize();
  }
  function getRevoluteDragDelta(j, startPoint, endPoint, initialGrabPoint) {
    dragAxisWorld.copy(getJointWorldAxis(j));
    dragPivotWorld.copy(getJointWorldPivot(j));
    dragPlane.setFromNormalAndCoplanarPoint(dragAxisWorld, dragPivotWorld);
    dragTmp.copy(camera.position).sub(initialGrabPoint).normalize();
    if (Math.abs(dragTmp.dot(dragPlane.normal)) > 0.3) {
      dragPlane.projectPoint(startPoint, dragProjectedStart);
      dragPlane.projectPoint(endPoint, dragProjectedEnd);
      dragProjectedStart.sub(dragPivotWorld); dragProjectedEnd.sub(dragPivotWorld);
      if (dragProjectedStart.lengthSq() < 1e-12 || dragProjectedEnd.lengthSq() < 1e-12) return 0;
      dragTmp.crossVectors(dragProjectedStart, dragProjectedEnd);
      const direction = Math.sign(dragTmp.dot(dragPlane.normal)) || 1;
      return direction * dragProjectedEnd.angleTo(dragProjectedStart);
    }
    dragTmp.set(0,0,-1).transformDirection(camera.matrixWorld);
    dragTmp.cross(dragPlane.normal).normalize();
    dragTmp2.subVectors(endPoint, startPoint);
    return dragTmp.dot(dragTmp2) * 4.0;
  }
  function getPrismaticDragDelta(j, startPoint, endPoint) {
    dragAxisWorld.copy(getJointWorldAxis(j));
    dragTmp.subVectors(endPoint, startPoint);
    return dragTmp.dot(dragAxisWorld);
  }
  function startJointDrag(ev, pick) {
    if (!pick || ev.button !== 0) return false;
    const joint = getManipulableJointForLink(pick.link);
    if (!joint) return false;
    setSelected(pick.link, pick.hit?.object || null);
    activeDrag = { link: pick.link, linkName: pick.linkName, joint, type: isPrismatic(joint) ? 'prismatic' : 'revolute', hitDistance: pick.hit.distance, initialGrabPoint: pick.hit.point.clone(), prevRay: pick.ray.clone() };
    robotModel?.beginInteractiveDrag?.();
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
    try { renderer.domElement.setPointerCapture?.(ev.pointerId); } catch (_) {}
    return true;
  }
  function updateJointDrag(ev) {
    const d = activeDrag; if (!d) return false;
    const ray = setPointerFromEvent(ev);
    d.prevRay.at(d.hitDistance, dragPrevHit);
    ray.at(d.hitDistance, dragNewHit);
    let delta = isPrismatic(d.joint) ? getPrismaticDragDelta(d.joint, dragPrevHit, dragNewHit) : getRevoluteDragDelta(d.joint, dragPrevHit, dragNewHit, d.initialGrabPoint);
    if (Number.isFinite(delta) && Math.abs(delta) > 1e-9) setJointValue(robotModel, d.joint, getJointValue(d.joint) + delta);
    d.prevRay.copy(ray);
    refreshSelectionMarker();
    return true;
  }
  function endJointDrag(ev) {
    if (!activeDrag) return;
    try { renderer.domElement.releasePointerCapture?.(ev?.pointerId); } catch (_) {}
    activeDrag = null;
    robotModel?.endInteractiveDrag?.();
    controls.enabled = true;
    renderer.domElement.style.cursor = 'auto';
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

  function onMove(ev) {
    if (activeDrag) { ev.preventDefault(); updateJointDrag(ev); return; }
    const now = performance.now();
    if (now - lastHoverRaycastAt < 34) return;
    lastHoverRaycastAt = now;
    const pick = pickInfoFromPointer(ev);
    const key = pick?.link || null;
    if (key !== lastHover) {
      hover.clear(); lastHover = key;
      if (pick?.link) hover.showLink(pick.link);
    }
    renderer.domElement.style.cursor = pick?.link ? (getManipulableJointForLink(pick.link) ? 'grab' : 'pointer') : 'auto';
  }
  function onDown(ev) {
    if (ev.button !== 0) return;
    renderer.domElement.focus?.();
    const pick = pickInfoFromPointer(ev);
    if (!pick) { clearSelection(); return; }
    setSelected(pick.link, pick.hit?.object || null);
    if (startJointDrag(ev, pick)) { ev.preventDefault(); ev.stopPropagation(); }
  }
  function onUp(ev) { if (activeDrag) { ev.preventDefault?.(); endJointDrag(ev); } }
  function onKey(ev) { if (String(ev.key || '').toLowerCase() === 'i') isolateSelected(); }

  renderer.domElement.tabIndex = 0;
  renderer.domElement.addEventListener('pointermove', onMove, { passive: false });
  renderer.domElement.addEventListener('pointerdown', onDown, { passive: false });
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);

  return {
    setRobot,
    get selectedLink() { return selectedLink; },
    clearSelection,
    refreshSelectionMarker,
    destroy() {
      hover.clear(); if (selectionHelper) scene.remove(selectionHelper);
      renderer.domElement.removeEventListener('pointermove', onMove);
      renderer.domElement.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('keydown', onKey, true);
    }
  };
}
export default { attachInteraction };
