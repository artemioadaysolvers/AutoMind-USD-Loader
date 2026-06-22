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
  if (!robot || !j) return false;
  let ok = false;
  if (typeof j.setJointValue === 'function') { j.setJointValue(v); ok = true; }
  else if (typeof robot.setJointValue === 'function') ok = robot.setJointValue(j.name, v) !== false;
  robot.updateMatrixWorld?.(true);
  return ok;
}
function collectMeshesInLink(linkObj) {
  const out = [];
  linkObj?.traverse?.(o => { if (o?.isMesh && o.geometry && !o.userData.__isHoverOverlay) out.push(o); });
  return out;
}
function materialList(mat) {
  if (!mat) return [];
  return Array.isArray(mat) ? mat.filter(Boolean) : [mat];
}
function meshOpacityForPicking(mesh) {
  const mats = materialList(mesh?.material);
  if (!mats.length) return 1;
  let best = 0;
  for (const m of mats) {
    if (!m) continue;
    const op = Number.isFinite(m.opacity) ? m.opacity : 1;
    best = Math.max(best, op);
  }
  return best;
}
function meshPickableNow(mesh, plane) {
  if (!mesh || !mesh.isMesh || !mesh.geometry) return false;
  if (mesh.visible === false || mesh.userData?.__isHoverOverlay) return false;
  // Visibility transactions mark the logical final target immediately. During a
  // fade-out, the object may still be visually present for a few frames, but it
  // must already behave as non-pickable to avoid stale hover/click/drag states.
  if (mesh.userData?.__automindVisibilityTarget === false) return false;
  if (meshOpacityForPicking(mesh) <= 0.035) return false;
  return meshVisibleBySection(mesh, plane);
}
function linkPickableNow(link, plane) {
  return collectMeshesInLink(link).some(m => meshPickableNow(m, plane));
}
function computeUnionBox(meshes) {
  const box = new THREE.Box3(); let has = false; const tmp = new THREE.Box3();
  for (const m of meshes || []) { if (!m) continue; tmp.setFromObject(m); if (!has) { box.copy(tmp); has = true; } else box.union(tmp); }
  return has ? box : null;
}
function sectionKeepsPoint(point, plane, eps = 1e-7) {
  // Three.js material clipping keeps the positive side of a Plane and discards
  // fragments with negative signed distance. The raycaster does not know that,
  // so every hover/click/drag hit must pass this same half-space test manually.
  return !plane || !point || plane.distanceToPoint(point) >= -eps;
}
function boxHasAnyVisibleSideByPlane(box, plane, eps = 1e-7) {
  if (!box || !plane) return true;
  const min = box.min, max = box.max;
  const corners = [
    new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z), new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(max.x, max.y, max.z)
  ];
  return corners.some(c => sectionKeepsPoint(c, plane, eps));
}

const __sectionVertexTmp = new THREE.Vector3();
function meshHasKeptGeometryBySection(mesh, plane, eps = 1e-7) {
  if (!plane) return true;
  if (!mesh || !mesh.geometry) return false;
  const pos = mesh.geometry.attributes?.position;
  if (!pos || !pos.count) return meshVisibleBySectionBBox(mesh, plane, eps);
  // Do not rely only on Box3 corners: long/thin CAD parts can have a bounding box
  // crossing the section plane even when every real triangle is clipped away.
  // Sample actual vertices in world space. If at least one real vertex is on the
  // kept side, the body is partially visible and can still be selected; if all
  // vertices are on the clipped side, it is fully hidden and must be unpickable.
  const count = pos.count;
  const step = Math.max(1, Math.floor(count / 768));
  for (let i = 0; i < count; i += step) {
    __sectionVertexTmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    if (sectionKeepsPoint(__sectionVertexTmp, plane, eps)) return true;
  }
  // Always check the last vertex too, in case the sampling step skipped a tiny end.
  __sectionVertexTmp.fromBufferAttribute(pos, count - 1).applyMatrix4(mesh.matrixWorld);
  return sectionKeepsPoint(__sectionVertexTmp, plane, eps);
}
function meshVisibleBySectionBBox(mesh, plane, eps = 1e-7) {
  if (!plane) return true;
  const box = new THREE.Box3().setFromObject(mesh);
  if (box.isEmpty()) return false;
  return boxHasAnyVisibleSideByPlane(box, plane, eps);
}
function meshVisibleBySection(mesh, plane) {
  if (!plane) return true;
  mesh.updateMatrixWorld?.(true);
  return meshHasKeptGeometryBySection(mesh, plane);
}
function pointVisibleBySection(point, plane, eps = 1e-6) {
  return sectionKeepsPoint(point, plane, eps);
}
function findAncestorLink(o, linkSet) { while (o) { if (linkSet.has(o)) return o; o = o.parent; } return null; }
function buildHoverOverlay({ color = HOVER_COLOR, opacity = HOVER_OPACITY, getSectionPlane = null } = {}) {
  const overlays = [];
  function clear() {
    overlays.splice(0).forEach(o => {
      try { o.parent?.remove(o); o.material?.dispose?.(); } catch (_) {}
    });
  }
  function overlayFor(mesh) {
    if (!mesh?.isMesh || !mesh.geometry) return null;
    const mat = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: 1
    });
    const plane = typeof getSectionPlane === 'function' ? getSectionPlane() : null;
    if (plane) {
      mat.clippingPlanes = [plane];
      mat.clipIntersection = false;
      mat.needsUpdate = true;
    }
    const ov = new THREE.Mesh(mesh.geometry, mat);
    ov.renderOrder = 9999;
    ov.userData.__isHoverOverlay = true;
    return ov;
  }
  function showMesh(mesh) {
    const plane = typeof getSectionPlane === 'function' ? getSectionPlane() : null;
    if (!meshPickableNow(mesh, plane)) return;
    const ov = overlayFor(mesh);
    if (ov) { mesh.add(ov); overlays.push(ov); }
  }
  function showLink(link) {
    const plane = typeof getSectionPlane === 'function' ? getSectionPlane() : null;
    for (const m of collectMeshesInLink(link)) {
      if (meshPickableNow(m, plane)) showMesh(m);
    }
  }
  return { clear, showMesh, showLink };
}

export function attachInteraction({ scene, camera, renderer, controls, robot, selectMode = 'link', getSectionPlane = null, onSelectLink = null, onKinematicCommit = null }) {
  if (!scene || !camera || !renderer || !controls) throw new Error('[USD SelectionAndDrag] Missing core objects');
  let robotModel = robot || null;
  let linkSet = new Set(Object.values(robotModel?.links || {}));
  const getCamera = (typeof camera === 'function') ? camera : () => camera;
  const getPlane = (typeof getSectionPlane === 'function') ? getSectionPlane : () => null;
  const raycaster = new THREE.Raycaster();
  const pointerNdc = new THREE.Vector2();
  const hover = buildHoverOverlay({ getSectionPlane: getPlane });
  let lastHover = null;
  let selectedMeshes = [];
  let selectedLink = null;
  let selectionHelper = null;
  let isolated = false;
  let activeDrag = null;
  let pendingClickSelect = null;
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
    const plane = getPlane();
    const visibleMeshes = (selectedMeshes || []).filter(m => meshPickableNow(m, plane));
    const box = computeUnionBox(visibleMeshes);
    if (!box || !boxHasAnyVisibleSideByPlane(box, plane)) { h.visible = false; return; }
    h.box.copy(box); h.updateMatrixWorld(true); h.visible = true;
  }
  function setSelected(link, mesh = null) {
    selectedLink = link || null;
    if (selectMode === 'mesh' && mesh) selectedMeshes = [mesh];
    else selectedMeshes = link ? collectMeshesInLink(link) : [];
    refreshSelectionMarker();
  }
  function clearSelection() { selectedMeshes = []; selectedLink = null; if (selectionHelper) selectionHelper.visible = false; }
  function selectLink(linkOrName, { notify = true } = {}) {
    const link = typeof linkOrName === 'string' ? robotModel?.links?.[linkOrName] : linkOrName;
    if (!link) return false;
    setSelected(link);
    if (notify) {
      try { if (typeof onSelectLink === 'function') onSelectLink(link, { programmatic: true }); } catch (_) {}
    }
    return true;
  }
  function setPointerFromEvent(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    pointerNdc.y = -(((ev.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    raycaster.setFromCamera(pointerNdc, getCamera());
    return raycaster.ray.clone();
  }
  function linkNameFromObject(obj) {
    let o = obj;
    while (o) { if (o.userData?.__linkName) return o.userData.__linkName; o = o.parent; }
    return '';
  }
  function pickInfoFromPointer(ev) {
    const ray = setPointerFromEvent(ev);
    const plane = getPlane();
    const pickables = [];
    robotModel?.traverse?.(o => {
      if (meshPickableNow(o, plane)) pickables.push(o);
    });
    const hits = raycaster.intersectObjects(pickables, true);
    for (const hit of hits) {
      if (!pointVisibleBySection(hit.point, plane)) continue;
      const linkName = linkNameFromObject(hit.object);
      const link = linkName ? robotModel?.links?.[linkName] : findAncestorLink(hit.object, linkSet);
      if (link && linkPickableNow(link, plane) && meshPickableNow(hit.object, plane)) {
        return { link, linkName: linkName || link.userData?.__linkName || link.name, hit, ray };
      }
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
    dragTmp.copy(getCamera().position).sub(initialGrabPoint).normalize();
    if (Math.abs(dragTmp.dot(dragPlane.normal)) > 0.3) {
      dragPlane.projectPoint(startPoint, dragProjectedStart);
      dragPlane.projectPoint(endPoint, dragProjectedEnd);
      dragProjectedStart.sub(dragPivotWorld); dragProjectedEnd.sub(dragPivotWorld);
      if (dragProjectedStart.lengthSq() < 1e-12 || dragProjectedEnd.lengthSq() < 1e-12) return 0;
      dragTmp.crossVectors(dragProjectedStart, dragProjectedEnd);
      const direction = Math.sign(dragTmp.dot(dragPlane.normal)) || 1;
      return direction * dragProjectedEnd.angleTo(dragProjectedStart);
    }
    dragTmp.set(0,0,-1).transformDirection(getCamera().matrixWorld);
    dragTmp.cross(dragPlane.normal).normalize();
    dragTmp2.subVectors(endPoint, startPoint);
    return dragTmp.dot(dragTmp2) * 4.0;
  }
  function getPrismaticDragDelta(j, startPoint, endPoint) {
    dragAxisWorld.copy(getJointWorldAxis(j));
    dragTmp.subVectors(endPoint, startPoint);
    return dragTmp.dot(dragAxisWorld);
  }
  function rayPointOnPlane(ray, plane, fallbackDistance, fallback) {
    const out = new THREE.Vector3();
    if (ray && plane && ray.intersectPlane(plane, out)) return out;
    if (ray && Number.isFinite(fallbackDistance)) return ray.at(fallbackDistance, out);
    return fallback?.clone?.() || out;
  }
  function signedArcDelta(pivot, axis, previous, next) {
    const u = previous.clone().sub(pivot);
    const v = next.clone().sub(pivot);
    u.addScaledVector(axis, -u.dot(axis));
    v.addScaledVector(axis, -v.dot(axis));
    if (u.lengthSq() < 1e-12 || v.lengthSq() < 1e-12) return 0;
    u.normalize(); v.normalize();
    return Math.atan2(new THREE.Vector3().crossVectors(u, v).dot(axis), THREE.MathUtils.clamp(u.dot(v), -1, 1));
  }
  function startJointDrag(ev, pick) {
    if (!pick || ev.button !== 0) return false;
    const joint = getManipulableJointForLink(pick.link);
    if (!joint) return false;
    setSelected(pick.link, pick.hit?.object || null);
    // Capture the physical input plane once. Passive closure projection may move
    // the visible link, but pointer mapping cannot jump with its downstream frame.
    const pivot = getJointWorldPivot(joint).clone();
    const axis = getJointWorldAxis(joint).clone().normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(axis, pivot);
    const startPoint = rayPointOnPlane(pick.ray, plane, pick.hit.distance, pick.hit.point);
    activeDrag = {
      link: pick.link, linkName: pick.linkName, joint,
      type: isPrismatic(joint) ? 'prismatic' : 'revolute',
      hitDistance: pick.hit.distance, initialGrabPoint: pick.hit.point.clone(),
      inputPivot: pivot, inputAxis: axis, inputPlane: plane,
      lastInputPoint: startPoint.clone(),
      requestedInitialValue: getJointValue(joint), accumulatedDelta: 0,
      prevRay: pick.ray.clone()
    };
    robotModel?.beginInteractiveDrag?.(joint);
    controls.enabled = false;
    renderer.domElement.style.cursor = 'grabbing';
    try { renderer.domElement.setPointerCapture?.(ev.pointerId); } catch (_) {}
    return true;
  }

  function cancelActiveDrag(ev) {
    const d = activeDrag;
    if (!d) return;
    try { renderer.domElement.releasePointerCapture?.(ev?.pointerId); } catch (_) {}
    try { robotModel?.endInteractiveDrag?.(d.joint); } catch (_) {}
    activeDrag = null;
    pendingClickSelect = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = 'auto';
  }
  function updateJointDrag(ev) {
    const d = activeDrag; if (!d) return false;
    const planeNow = getPlane();
    if (d.link && !linkPickableNow(d.link, planeNow)) {
      cancelActiveDrag(ev);
      clearSelection(); hover.clear(); lastHover = null;
      return false;
    }
    if (pendingClickSelect) {
      const dx=Number(ev.clientX||0)-pendingClickSelect.x, dy=Number(ev.clientY||0)-pendingClickSelect.y;
      if ((dx*dx+dy*dy)>25) pendingClickSelect.moved=true;
    }
    const ray=setPointerFromEvent(ev);
    const nextPoint=rayPointOnPlane(ray,d.inputPlane,d.hitDistance,d.lastInputPoint);
    let delta = d.type==='prismatic'
      ? nextPoint.clone().sub(d.lastInputPoint).dot(d.inputAxis)
      : signedArcDelta(d.inputPivot,d.inputAxis,d.lastInputPoint,nextPoint);
    delta=clamp(delta, -(d.type==='prismatic'?0.02:0.16), d.type==='prismatic'?0.02:0.16);
    if (Number.isFinite(delta) && Math.abs(delta)>1e-9) {
      d.accumulatedDelta+=delta;
      const accepted=setJointValue(robotModel,d.joint,d.requestedInitialValue+d.accumulatedDelta);
      if (accepted) { try { if (typeof onKinematicCommit==='function') onKinematicCommit(robotModel,d.joint); } catch (_) {} }
    }
    d.lastInputPoint.copy(nextPoint); d.prevRay.copy(ray);
    refreshSelectionMarker();
    return true;
  }

  function endJointDrag(ev) {
    if (!activeDrag) return;
    try { renderer.domElement.releasePointerCapture?.(ev?.pointerId); } catch (_) {}
    const joint = activeDrag?.joint || null;
    const pending = pendingClickSelect;
    pendingClickSelect = null;
    robotModel?.endInteractiveDrag?.(joint);
    try { if (typeof onKinematicCommit === 'function') onKinematicCommit(robotModel, joint); } catch (_) {}
    activeDrag = null;
    controls.enabled = true;
    renderer.domElement.style.cursor = 'auto';
    refreshSelectionMarker();
    if (pending && !pending.moved) {
      try { if (typeof onSelectLink === 'function') onSelectLink(pending.link, pending.pick); } catch (_) {}
    }
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
    const planeNow = getPlane();
    if (lastHover && !linkPickableNow(lastHover, planeNow)) { hover.clear(); lastHover = null; renderer.domElement.style.cursor = 'auto'; }
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
    if (startJointDrag(ev, pick)) {
      pendingClickSelect = { link: pick.link, pick, x: Number(ev.clientX || 0), y: Number(ev.clientY || 0), moved: false };
      ev.preventDefault(); ev.stopPropagation();
    } else {
      pendingClickSelect = null;
      try { if (typeof onSelectLink === 'function') onSelectLink(pick.link, pick); } catch (_) {}
    }
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
    selectLink,
    clearHover() { hover.clear(); lastHover = null; },
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
