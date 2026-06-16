// /USD_Viewer/core/ViewerCore.js
// Three.js r132 compatible USD+ viewer core.
// Exports createViewer({ container, background, pixelRatio })
// Parses ASCII .usda/.usd exported by AutoMind USD+.
/* global THREE */

function assertThree() {
  if (typeof THREE === 'undefined') {
    throw new Error('[USD ViewerCore] THREE is not defined. Load three.js before this module.');
  }
}

const EPS = 1e-12;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function basename(p) { return String(p || '').split(/[\\/]/).pop(); }
function stripExt(s) { return String(s || '').replace(/\.[^.]+$/, ''); }
function localNameFromPath(path) { return String(path || '').split('/').filter(Boolean).pop() || ''; }
function match1(text, re, fallback = '') { const m = re.exec(String(text || '')); return m ? m[1] : fallback; }
function parseNums(s) { return (String(s || '').match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || []).map(Number); }
function safeRe(name) { return String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function parseStringAttr(body, name, fallback = '') { return match1(body, new RegExp(safeRe(name) + '\\s*=\\s*"([^"]*)"'), fallback); }
function parseBoolAttr(body, name, fallback = false) { const m = new RegExp(safeRe(name) + '\\s*=\\s*(true|false|1|0)').exec(String(body || '')); return m ? /true|1/i.test(m[1]) : fallback; }
function parseNumAttr(body, name, fallback = 0) { const m = new RegExp(safeRe(name) + '\\s*=\\s*([-+]?\\d*\\.?\\d+(?:[eE][-+]?\\d+)?)').exec(String(body || '')); return m ? Number(m[1]) : fallback; }
function parseVecAttr(body, name, fallback = [0, 0, 0]) {
  const m = new RegExp(safeRe(name) + '\\s*=\\s*\\(([^\\)]*)\\)').exec(String(body || ''));
  const n = m ? parseNums(m[1]) : [];
  if (n.length >= 3) return [n[0], n[1], n[2]];
  return Array.isArray(fallback) ? fallback.slice() : fallback;
}
function parseQuatAttr(body, name) {
  const m = new RegExp(safeRe(name) + '\\s*=\\s*\\(([^\\)]*)\\)').exec(String(body || ''));
  const n = m ? parseNums(m[1]) : [];
  return n.length >= 4 ? new THREE.Quaternion(n[1], n[2], n[3], n[0]).normalize() : new THREE.Quaternion();
}
function directBody(body) {
  const text = String(body || '');
  const m = /\n\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s+"[^"]+"/.exec(text);
  return m ? text.slice(0, m.index) : text;
}
function parseDefaultPrim(text) { return match1(text, /defaultPrim\s*=\s*"([^"]+)"/); }

function findMatchingBrace(s, open) {
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function scanDefBlocksRecursive(text, baseOffset, parentPath, depth, out) {
  const re = /def\s+([A-Za-z_][A-Za-z0-9_]*)\s+"([^"]+)"[^\{]*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const startBrace = text.indexOf('{', m.index);
    const end = findMatchingBrace(text, startBrace);
    if (startBrace < 0 || end < 0) continue;
    const body = text.slice(startBrace + 1, end);
    const path = parentPath + '/' + m[2];
    out.push({ type: m[1], name: m[2], start: baseOffset + m.index, end: baseOffset + end, body, depth, path, parentPath });
    scanDefBlocksRecursive(body, baseOffset + startBrace + 1, path, depth + 1, out);
    re.lastIndex = end + 1;
  }
}
function findDefBlocks(text) { const out = []; scanDefBlocksRecursive(String(text || ''), 0, '', 0, out); return out; }

function parseArrayBlock(body, lhsRegex) {
  const re = new RegExp(lhsRegex + '\\s*=\\s*\\[(.*?)\\]', 's');
  const m = re.exec(String(body || ''));
  return m ? m[1] : '';
}
function parseArrayTriples(body, lhsRegex) { const txt = parseArrayBlock(body, lhsRegex); const nums = txt ? parseNums(txt) : []; const out = []; for (let i = 0; i + 2 < nums.length; i += 3) out.push([nums[i], nums[i + 1], nums[i + 2]]); return out; }
function parseArrayPairs(body, lhsRegex) { const txt = parseArrayBlock(body, lhsRegex); const nums = txt ? parseNums(txt) : []; const out = []; for (let i = 0; i + 1 < nums.length; i += 2) out.push([nums[i], nums[i + 1]]); return out; }
function parseArrayInts(body, lhsRegex) { const txt = parseArrayBlock(body, lhsRegex); return txt ? parseNums(txt).map(x => Math.trunc(x)) : []; }
function triangulateUsdIndices(rawIdx, counts) {
  const idx = (rawIdx || []).filter(Number.isFinite).map(x => Math.trunc(x));
  const cts = (counts || []).filter(Number.isFinite).map(x => Math.trunc(x));
  if (!idx.length) return [];
  if (!cts.length) return idx.filter(i => i >= 0);
  const tris = [];
  let p = 0;
  for (const c of cts) {
    if (c < 3 || p + c > idx.length) { p += Math.max(c, 0); continue; }
    const face = idx.slice(p, p + c).filter(i => i >= 0); p += c;
    if (face.length < 3) continue;
    for (let k = 1; k + 1 < face.length; k++) tris.push(face[0], face[k], face[k + 1]);
  }
  return tris;
}

function matrixFromUsdNumbers(n) {
  const rowT = Math.hypot(n[12] || 0, n[13] || 0, n[14] || 0);
  const colT = Math.hypot(n[3] || 0, n[7] || 0, n[11] || 0);
  const rowVector = rowT > 1e-12 && colT < Math.max(rowT * 1e-6, 1e-12);
  if (rowVector) {
    return new THREE.Matrix4().set(
      n[0], n[4], n[8],  n[12],
      n[1], n[5], n[9],  n[13],
      n[2], n[6], n[10], n[14],
      n[3], n[7], n[11], n[15]
    );
  }
  return new THREE.Matrix4().set(
    n[0], n[1], n[2],  n[3],
    n[4], n[5], n[6],  n[7],
    n[8], n[9], n[10], n[11],
    n[12], n[13], n[14], n[15]
  );
}
function parseXformQuaternion(body) {
  const q = parseQuatAttr(body, 'xformOp:orient');
  if (!/xformOp:rotateXYZ/.test(body)) return q;
  const r = parseVecAttr(body, 'xformOp:rotateXYZ', [0, 0, 0]) || [0, 0, 0];
  const e = new THREE.Euler(THREE.MathUtils.degToRad(r[0]), THREE.MathUtils.degToRad(r[1]), THREE.MathUtils.degToRad(r[2]), 'XYZ');
  return q.multiply(new THREE.Quaternion().setFromEuler(e)).normalize();
}
function parseMatrix(body) {
  const txt = String(body || '');
  const m = /matrix4d\s+xformOp:transform\s*=\s*\(\((.*?)\)\)/s.exec(txt);
  if (m) {
    const n = parseNums(m[1]);
    if (n.length >= 16) return matrixFromUsdNumbers(n);
  }
  const t = parseVecAttr(txt, 'xformOp:translate', null);
  const s = parseVecAttr(txt, 'xformOp:scale', [1, 1, 1]) || [1, 1, 1];
  const q = parseXformQuaternion(txt);
  const hasOps = !!t || /xformOp:(orient|rotateXYZ|scale)/.test(txt);
  if (!hasOps) return new THREE.Matrix4();
  return new THREE.Matrix4().compose(new THREE.Vector3(...(t || [0, 0, 0])), q, new THREE.Vector3(s[0], s[1], s[2]));
}
function matrixFromPosQuat(pos, quat) {
  return new THREE.Matrix4().compose(new THREE.Vector3(pos[0], pos[1], pos[2]), quat, new THREE.Vector3(1, 1, 1));
}
function setObjectMatrix(obj, mat) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  mat.decompose(p, q, s);
  obj.position.copy(p); obj.quaternion.copy(q); obj.scale.copy(s); obj.updateMatrix(); obj.updateMatrixWorld(true);
}

function buildHelpers() {
  const group = new THREE.Group();
  const grid = new THREE.GridHelper(10, 20, 0x0ea5a6, 0x14b8b9); grid.visible = false; group.add(grid);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.25 }); groundMat.depthWrite = false;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.0001; ground.visible = false; group.add(ground);
  const axes = new THREE.AxesHelper(1); axes.visible = false; group.add(axes);
  return { group, grid, ground, axes };
}

/* Full 360° CAD trackball controls: no polar clamp, no OrbitControls pole lock. */
class AutoMindTrackballControls {
  constructor(object, domElement) {
    this.object = object; this.domElement = domElement; this.enabled = true; this.target = new THREE.Vector3();
    this.rotateSpeed = 4.0; this.zoomSpeed = 1.2; this.panSpeed = 0.8; this.staticMoving = false; this.dynamicDampingFactor = 0.15;
    this._state = 0; this._pointerId = null; this._last = new THREE.Vector2();
    this._rotVX = 0; this._rotVY = 0; this._panVX = 0; this._panVY = 0; this._zoomV = 0;
    this._bind();
  }
  _bind() {
    this._onContextMenu = e => e.preventDefault();
    this._onWheel = e => { if (!this.enabled) return; e.preventDefault(); const delta = -(e.deltaY || 0) * 0.0018 * this.zoomSpeed; this._dolly(delta); if (!this.staticMoving) this._zoomV = delta; this.update(); };
    this._onPointerDown = e => { if (!this.enabled || this._pointerId !== null) return; this._pointerId = e.pointerId; this._state = e.button === 0 ? 1 : (e.button === 1 ? 2 : 3); this._last.set(e.clientX, e.clientY); this._rotVX=this._rotVY=this._panVX=this._panVY=this._zoomV=0; try { this.domElement.setPointerCapture(e.pointerId); } catch (_) {} window.addEventListener('pointermove', this._onPointerMove, true); window.addEventListener('pointerup', this._onPointerUp, true); };
    this._onPointerMove = e => { if (!this.enabled || this._pointerId !== e.pointerId) return; const dx = e.clientX - this._last.x, dy = e.clientY - this._last.y; this._last.set(e.clientX, e.clientY); if (this._state === 1) { const ax = dx * 0.006 * this.rotateSpeed, ay = dy * 0.006 * this.rotateSpeed; this._rotate(ax, ay); if (!this.staticMoving) { this._rotVX = ax; this._rotVY = ay; } } else if (this._state === 2) { const z = -dy * 0.003 * this.zoomSpeed; this._dolly(z); if (!this.staticMoving) this._zoomV = z; } else if (this._state === 3) { this._pan(dx, dy); if (!this.staticMoving) { this._panVX = dx; this._panVY = dy; } } this.update(); };
    this._onPointerUp = e => { if (this._pointerId !== e.pointerId) return; try { this.domElement.releasePointerCapture(e.pointerId); } catch (_) {} this._pointerId = null; this._state = 0; window.removeEventListener('pointermove', this._onPointerMove, true); window.removeEventListener('pointerup', this._onPointerUp, true); };
    this.domElement.addEventListener('contextmenu', this._onContextMenu); this.domElement.addEventListener('wheel', this._onWheel, { passive: false }); this.domElement.addEventListener('pointerdown', this._onPointerDown, true);
  }
  handleResize() {}
  update() {
    if (!this.staticMoving && this._state === 0) {
      if (Math.abs(this._rotVX) > 1e-6 || Math.abs(this._rotVY) > 1e-6) { this._rotate(this._rotVX, this._rotVY); this._rotVX *= (1 - this.dynamicDampingFactor); this._rotVY *= (1 - this.dynamicDampingFactor); }
      if (Math.abs(this._panVX) > 1e-4 || Math.abs(this._panVY) > 1e-4) { this._pan(this._panVX, this._panVY); this._panVX *= (1 - this.dynamicDampingFactor); this._panVY *= (1 - this.dynamicDampingFactor); }
      if (Math.abs(this._zoomV) > 1e-6) { this._dolly(this._zoomV); this._zoomV *= (1 - this.dynamicDampingFactor); }
    }
    this.object.lookAt(this.target);
  }
  _rotate(ax, ay) {
    const eye = this.object.position.clone().sub(this.target);
    const right = new THREE.Vector3().crossVectors(eye, this.object.up).normalize(); if (right.lengthSq() < 1e-12) right.set(1,0,0);
    const qx = new THREE.Quaternion().setFromAxisAngle(this.object.up.clone().normalize(), -ax);
    const qy = new THREE.Quaternion().setFromAxisAngle(right, -ay);
    eye.applyQuaternion(qx).applyQuaternion(qy); this.object.up.applyQuaternion(qy).normalize(); this.object.position.copy(this.target).add(eye);
  }
  _dolly(delta) {
    if (this.object.isPerspectiveCamera) { const eye = this.object.position.clone().sub(this.target); eye.multiplyScalar(Math.exp(-delta)); this.object.position.copy(this.target).add(eye); }
    else if (this.object.isOrthographicCamera) { this.object.zoom = Math.max(1e-4, this.object.zoom * Math.exp(delta)); this.object.updateProjectionMatrix(); }
  }
  _pan(dx, dy) {
    const rect = this.domElement.getBoundingClientRect(); const eye = this.object.position.clone().sub(this.target); const dist = Math.max(eye.length(), 1e-9); const height = Math.max(1, rect.height || 1);
    const worldPerPixel = this.object.isPerspectiveCamera ? 2 * dist * Math.tan((this.object.fov || 45) * Math.PI / 360) / height : (this.object.top - this.object.bottom) / Math.max(this.object.zoom || 1, 1e-9) / height;
    const right = new THREE.Vector3().crossVectors(eye, this.object.up).normalize(); if (right.lengthSq() < 1e-12) right.set(1,0,0);
    const pan = right.multiplyScalar(-dx * worldPerPixel * this.panSpeed).add(this.object.up.clone().normalize().multiplyScalar(dy * worldPerPixel * this.panSpeed));
    this.object.position.add(pan); this.target.add(pan);
  }
  dispose() { this.domElement.removeEventListener('contextmenu', this._onContextMenu); this.domElement.removeEventListener('wheel', this._onWheel); this.domElement.removeEventListener('pointerdown', this._onPointerDown, true); window.removeEventListener('pointermove', this._onPointerMove, true); window.removeEventListener('pointerup', this._onPointerUp, true); }
}

function applyDoubleSided(root) {
  root?.traverse?.(n => {
    if (n.isMesh && n.geometry) {
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      mats.forEach(m => { if (m) { m.side = THREE.DoubleSide; m.needsUpdate = true; }});
      n.castShadow = true; n.receiveShadow = true; n.geometry.computeVertexNormals?.();
    }
  });
}
function getObjectBounds(object, pad = 1.0) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(pad);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  return { box, center, size, maxDim };
}
function fitAndCenter(camera, controls, object, pad = 1.08) {
  const b = getObjectBounds(object, pad); if (!b) return false;
  const { center, maxDim } = b;
  if (camera.isPerspectiveCamera) {
    const fov = (camera.fov || 60) * Math.PI / 180;
    const dist = maxDim / Math.tan(Math.max(1e-6, fov / 2));
    camera.near = Math.max(maxDim / 1000, 0.001); camera.far = Math.max(maxDim * 1500, 1500); camera.updateProjectionMatrix();
    let dir = camera.position.clone().sub(controls.target || new THREE.Vector3());
    if (!isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-10) dir.set(1, 0.7, 1);
    dir.normalize(); camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  } else {
    const aspect = Math.max(1e-6, (controls?.domElement?.clientWidth || 1) / (controls?.domElement?.clientHeight || 1));
    const span = Math.max(maxDim, 5 * Math.SQRT2);
    camera.left = -span * aspect; camera.right = span * aspect; camera.top = span; camera.bottom = -span;
    camera.near = Math.max(maxDim / 1000, 0.001); camera.far = Math.max(maxDim * 1500, 1500); camera.updateProjectionMatrix();
    camera.position.copy(center.clone().add(new THREE.Vector3(maxDim, maxDim * 0.9, maxDim)));
  }
  controls.target.copy(center); controls.update(); return true;
}

function axisFromToken(t) { if (t === 'X') return new THREE.Vector3(1, 0, 0); if (t === 'Y') return new THREE.Vector3(0, 1, 0); return new THREE.Vector3(0, 0, 1); }
function jointAxisLocal(j) {
  if (j.axisJoint && j.axisJoint.length === 3) {
    const a = new THREE.Vector3(...j.axisJoint); if (a.lengthSq() > EPS) return a.normalize();
  }
  return axisFromToken(j.axisToken || 'Z');
}
function isMovableJoint(j) {
  if (!j) return false;
  if (j.exportedMovable === true && !/FixedJoint/i.test(j.schema || '')) return true;
  if (/RevoluteJoint|PrismaticJoint/i.test(j.schema || '')) return true;
  return !!j.jointType && String(j.jointType).toLowerCase() !== 'fixed';
}
function motionMatrix(j) {
  const axis = jointAxisLocal(j);
  if (!isMovableJoint(j)) return new THREE.Matrix4();
  const v = Number.isFinite(j?.value) ? j.value : (/prismatic/i.test(j.jointType || '') ? (j.position || 0) : (j.angle || 0));
  if (/prismatic/i.test(j.jointType || '') || /Prismatic/i.test(j.schema || '')) return new THREE.Matrix4().makeTranslation(axis.x * v, axis.y * v, axis.z * v);
  return new THREE.Matrix4().makeRotationAxis(axis, v);
}



class USDModel extends THREE.Group {
  constructor(name = 'USDModel') {
    super();
    this.name = name;
    this.links = {};
    this.joints = {};
    this.loopJoints = [];
    this.couplings = [];
    this.implicitCandidates = [];
    this.enableLoopSolver = true;
    this.enableCouplings = true;
    this.assetToMeshes = new Map();
    this.meshStats = { blocks: 0, ok: 0, markers: 0, failed: 0, skippedNestedLinks: 0 };
    this.userData.__isUSDModel = true;
    this.userData.__model = this;
  }
  setJointValue(name, v) {
    const j = typeof name === 'string' ? this.joints[name] : name;
    if (!j) return;
    setJointValueInternal(this, j, v);
  }
  applyPose() { applyPose(this); }
}

function getOwnedMeshBlocksForLink(linkBlock, model) {
  const defs = findDefBlocks(linkBlock.body);
  const byPath = new Map(defs.map(b => [b.path, b]));
  const owned = [];
  let skipped = 0;
  for (const mb of defs.filter(b => b.type === 'Mesh')) {
    const ancestors = [];
    let parent = mb.parentPath || '';
    let insideOtherLink = false;
    while (parent) {
      const ab = byPath.get(parent);
      if (ab) {
        const head = directBody(ab.body);
        if (ab.type === 'Xform' && /automind:linkName/.test(head)) { insideOtherLink = true; break; }
        ancestors.unshift(ab);
      }
      parent = parent.replace(/\/[^\/]+$/, '');
    }
    if (insideOtherLink) { skipped++; continue; }
    const composed = new THREE.Matrix4().identity();
    for (const ab of ancestors) if (ab.type === 'Xform') composed.multiply(parseMatrix(directBody(ab.body)));
    mb._composedLocalMatrix = composed.multiply(parseMatrix(directBody(mb.body)));
    owned.push(mb);
  }
  model.meshStats.skippedNestedLinks += skipped;
  return owned;
}
function addTinyMarker(model, group, linkName) {
  model.meshStats.markers++;
  const geom = new THREE.SphereGeometry(0.0025, 12, 8);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9aa9bb, roughness: 0.65 });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'marker:' + linkName;
  mesh.userData.__linkName = linkName; mesh.userData.__assetKey = linkName;
  group.add(mesh);
  const arr = model.assetToMeshes.get(linkName) || []; arr.push(mesh); model.assetToMeshes.set(linkName, arr);
}
function addMeshToLink(model, info, block, assetDB) {
  model.meshStats.blocks++;
  const pts = parseArrayTriples(block.body, 'point3f\\[\\]\\s+points');
  const rawIdx = parseArrayInts(block.body, 'int\\[\\]\\s+faceVertexIndices');
  const counts = parseArrayInts(block.body, 'int\\[\\]\\s+faceVertexCounts');
  const idx = triangulateUsdIndices(rawIdx, counts);
  if (!pts.length || !idx.length) { model.meshStats.failed++; addTinyMarker(model, info.group, info.name); return; }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts.flat()), 3));
  geom.setIndex(idx);
  const uvPairs = parseArrayPairs(block.body, 'texCoord2f\\[\\]\\s+primvars:st');
  if (uvPairs.length) {
    const uv = new Float32Array(pts.length * 2);
    for (let i = 0; i < pts.length; i++) { const p = uvPairs[i] || [0.5, 0.5]; uv[i * 2] = p[0] ?? 0.5; uv[i * 2 + 1] = p[1] ?? 0.5; }
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  geom.computeVertexNormals(); geom.computeBoundingSphere();
  const colorNums = parseNums(match1(block.body, /primvars:displayColor\s*=\s*\[\(([^\)]*)\)\]/s, '0.72 0.76 0.8'));
  const color = new THREE.Color(colorNums[0] ?? 0.72, colorNums[1] ?? 0.76, colorNums[2] ?? 0.8);
  const texPath = parseStringAttr(block.body, 'automind:textureFile', '') || match1(block.body, /asset\s+inputs:file\s*=\s*@([^@]+)@/s, '');
  let tex = null;
  if (texPath && assetDB?.get) {
    const data = assetDB.get(texPath) || assetDB.get(basename(texPath));
    if (data) {
      tex = new THREE.TextureLoader().load(data);
      tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
      if ('sRGBEncoding' in THREE) tex.encoding = THREE.sRGBEncoding;
    }
  }
  const mat = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : color, map: tex || null, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = 'mesh:' + info.name;
  mesh.userData.__linkName = info.name;
  mesh.userData.__assetKey = info.name;
  mesh.userData.textureFile = texPath || '';
  const meshMat = block._composedLocalMatrix || parseMatrix(directBody(block.body));
  setObjectMatrix(mesh, meshMat);
  info.group.add(mesh); info.meshes.push(mesh);
  const arr = model.assetToMeshes.get(info.name) || []; arr.push(mesh); model.assetToMeshes.set(info.name, arr);
  model.meshStats.ok++;
}
function createLink(model, block, assetDB) {
  const body0 = directBody(block.body);
  const linkName = parseStringAttr(body0, 'automind:linkName', block.name);
  const group = new THREE.Group();
  group.name = linkName; group.userData.__linkName = linkName; group.userData.__assetKey = linkName;
  const baseMatrix = parseMatrix(body0);
  setObjectMatrix(group, baseMatrix);
  const info = { name: linkName, primName: block.name, group, baseMatrix: baseMatrix.clone(), currentMatrix: baseMatrix.clone(), children: [], parentJoint: null, meshes: [], displayName: parseStringAttr(body0, 'automind:displayName', linkName) };
  model.links[linkName] = group;
  group.userData.__linkInfo = info;
  group.userData.__model = model;
  model.add(group);
  const mblocks = getOwnedMeshBlocksForLink(block, model);
  for (const mb of mblocks) addMeshToLink(model, info, mb, assetDB);
  if (!mblocks.length && linkName !== 'base_link') addTinyMarker(model, group, linkName);
  return info;
}
function parseJointBlock(block, model) {
  const body = directBody(block.body);
  const body0Path = match1(body, /rel\s+physics:body0\s*=\s*<([^>]+)>/);
  const body1Path = match1(body, /rel\s+physics:body1\s*=\s*<([^>]+)>/);
  const schema = block.type || '';
  const role = parseStringAttr(body, 'automind:jointRole', 'tree');
  let motionType = parseStringAttr(body, 'automind:motionType', '') || parseStringAttr(body, 'automind:originalType', '');
  if (!motionType) {
    if (/FixedJoint/i.test(schema)) motionType = 'fixed';
    else if (/PrismaticJoint/i.test(schema)) motionType = 'prismatic';
    else if (/RevoluteJoint/i.test(schema)) motionType = 'continuous';
    else motionType = 'fixed';
  }
  if (/FixedJoint/i.test(schema)) motionType = 'fixed';
  else if (/PrismaticJoint/i.test(schema)) motionType = 'prismatic';
  else if (/RevoluteJoint/i.test(schema) && /^fixed$/i.test(motionType)) motionType = 'continuous';

  const lowerRad = parseNumAttr(body, 'automind:lowerRad', -Math.PI);
  const upperRad = parseNumAttr(body, 'automind:upperRad', Math.PI);
  const lowerLimit = parseNumAttr(body, 'physics:lowerLimit', lowerRad);
  const upperLimit = parseNumAttr(body, 'physics:upperLimit', upperRad);
  // Joint objects are plain JS objects, not THREE.Group instances.
  // Object3D already owns a read-only/non-reassignable .position Vector3 in some
  // three.js builds; using a Group here caused `Cannot assign to read only property
  // 'position'` when storing prismatic scalar joint values.
  const j = { userData: {} };
  j.name = parseStringAttr(body, 'automind:jointName', block.name);
  j.jointType = motionType;
  j.schema = schema; j.role = role;
  j.body0 = parseStringAttr(body, 'automind:parentLink', localNameFromPath(body0Path));
  j.body1 = parseStringAttr(body, 'automind:childLink', localNameFromPath(body1Path));
  j.parentLink = j.body0; j.childLink = j.body1;
  j.localPos0 = parseVecAttr(body, 'physics:localPos0'); j.localRot0 = parseQuatAttr(body, 'physics:localRot0');
  j.localPos1 = parseVecAttr(body, 'physics:localPos1'); j.localRot1 = parseQuatAttr(body, 'physics:localRot1');
  j.axisToken = parseStringAttr(body, 'physics:axis', 'Z');
  j.axisJoint = parseVecAttr(body, 'automind:axisJoint', null);
  j.axisSuccessor = parseVecAttr(body, 'automind:axisSuccessor', null);
  j.axis = jointAxisLocal(j);
  j.limit = { lower: Number.isFinite(lowerLimit) ? lowerLimit : lowerRad, upper: Number.isFinite(upperLimit) ? upperLimit : upperRad };
  j.angle = 0; j.position = 0; j.value = 0; j.inputValue = 0;
  j.mimicJoint = parseStringAttr(body, 'automind:mimicJoint', '');
  j.mimicMultiplier = parseNumAttr(body, 'automind:mimicMultiplier', 1);
  j.mimicOffset = parseNumAttr(body, 'automind:mimicOffset', 0);
  j.independent = parseStringAttr(body, 'automind:independent', '');
  j.kinematicRole = parseStringAttr(body, 'automind:kinematicRole', '');
  j.authority = parseStringAttr(body, 'automind:kinematicAuthority', '');
  j.source = parseStringAttr(body, 'automind:source', '');
  j.evidence = parseStringAttr(body, 'automind:evidence', '');
  j.originalType = parseStringAttr(body, 'automind:originalType', '');
  j.implicitMotionCandidate = parseBoolAttr(body, 'automind:implicitMotionCandidate', false);
  j.requiresReview = parseBoolAttr(body, 'automind:requiresReview', false);
  j.axisWorldMeta = parseVecAttr(body, 'automind:axisWorld', null);
  j.lowerRad = lowerRad; j.upperRad = upperRad;
  j.exportedMovable = parseBoolAttr(body, 'automind:movable', isMovableJoint(j));
  j.viewerControllable = parseBoolAttr(body, 'automind:viewerControllable', isMovableJoint(j) && role !== 'loop');
  j.type = j.jointType;
  j._localFrame0 = matrixFromPosQuat(j.localPos0, j.localRot0);
  j._localFrame1 = matrixFromPosQuat(j.localPos1, j.localRot1);
  j._localFrame1Inv = j._localFrame1.clone().invert();
  j.userData.__isUSDJoint = true;
  j.userData.__joint = j;
  j.userData.__model = model;
  j.setJointValue = (v) => setJointValueInternal(model, j, v);
  j.getWorldPosition = (target = new THREE.Vector3()) => {
    const lf = model._linkInfo?.[j.body0];
    if (!lf) return target.set(0, 0, 0);
    const m = lf.currentMatrix.clone().multiply(j._localFrame0);
    return target.setFromMatrixPosition(m);
  };
  j.getWorldQuaternion = (target = new THREE.Quaternion()) => {
    const lf = model._linkInfo?.[j.body0];
    if (!lf) return target.identity();
    const m = lf.currentMatrix.clone().multiply(j._localFrame0);
    return target.setFromRotationMatrix(m);
  };
  return j;
}
function parseCouplingBlock(block) {
  const body = directBody(block.body);
  const masterJoint = parseStringAttr(body, 'automind:masterJoint', '');
  const dependentJoint = parseStringAttr(body, 'automind:dependentJoint', '');
  return { name: block.name, type: parseStringAttr(body, 'automind:type', 'linear'), masterJoint, dependentJoint, masterJoints: splitJointNames(masterJoint), dependentJoints: splitJointNames(dependentJoint), ratio: parseNumAttr(body, 'automind:ratio', 1), offset: parseNumAttr(body, 'automind:offset', 0), solver: parseStringAttr(body, 'automind:solver', ''), mode: parseStringAttr(body, 'automind:mode', ''), source: parseStringAttr(body, 'automind:source', ''), evidence: parseStringAttr(body, 'automind:evidence', '') };
}

function splitJointNames(s){ return String(s || '').split(/\s+/).map(x=>x.trim()).filter(Boolean); }
function parseImplicitCandidateBlock(block){
  const body = directBody(block.body);
  return { name:block.name, pair:parseStringAttr(body,'automind:pair',''), linkA:parseStringAttr(body,'automind:linkA',''), linkB:parseStringAttr(body,'automind:linkB',''), rank:parseNumAttr(body,'automind:rank',0), freeDof:parseNumAttr(body,'automind:freeDof',0), axisLike:parseNumAttr(body,'automind:axisLike',0), planar:parseNumAttr(body,'automind:planar',0), hasAxisPoint:parseBoolAttr(body,'automind:hasAxisPoint',false), axisWorld:parseVecAttr(body,'automind:axisWorld',[0,0,1]), axisPointWorld:parseVecAttr(body,'automind:axisPointWorld',[0,0,0]), exportedJoint:parseStringAttr(body,'automind:exportedJoint',''), exportedRole:parseStringAttr(body,'automind:exportedRole',''), activeForViewerClosure:parseBoolAttr(body,'automind:activeForViewerClosure',false), solver:parseStringAttr(body,'automind:solver',''), evidence:parseStringAttr(body,'automind:evidence',''), reason:parseStringAttr(body,'automind:reason',''), localPointA:null, localPointB:null, localAxisA:null, localAxisB:null };
}
function activeImplicitClosureCandidates(model){ return (model.implicitCandidates || []).filter(c => c && c.activeForViewerClosure && c.localPointA && c.localPointB); }
function localPointFromWorld(model, linkName, worldPoint){ const l = model._linkInfo?.[linkName]; if (!l) return new THREE.Vector3(); return new THREE.Vector3(...worldPoint).applyMatrix4(l.baseMatrix.clone().invert()); }
function localDirFromWorld(model, linkName, worldDir){ const l = model._linkInfo?.[linkName]; const v = new THREE.Vector3(...(worldDir || [0,0,1])); if (v.lengthSq() < 1e-12) v.set(0,0,1); if (l) v.transformDirection(l.baseMatrix.clone().invert()); v.normalize(); if (v.lengthSq() < 1e-12) v.set(0,0,1); return v; }
function finalizeImplicitCandidateFrames(model){ for (const c of model.implicitCandidates || []) { if (!c.activeForViewerClosure || !c.hasAxisPoint) continue; if (!model._linkInfo?.[c.linkA] || !model._linkInfo?.[c.linkB]) { c.activeForViewerClosure = false; continue; } c.localPointA = localPointFromWorld(model, c.linkA, c.axisPointWorld); c.localPointB = localPointFromWorld(model, c.linkB, c.axisPointWorld); c.localAxisA = localDirFromWorld(model, c.linkA, c.axisWorld); c.localAxisB = localDirFromWorld(model, c.linkB, c.axisWorld); } }
function linkToken(name){ return String(name||'').toLowerCase().replace(/[^a-z0-9]+/g,'_'); }
function linkByToken(model, token){ const t = linkToken(token); for (const k of Object.keys(model._linkInfo || {})) if (linkToken(k).includes(t)) return k; return ''; }
function candidateBetween(model,a,b){ return (model.implicitCandidates || []).find(c => c && ((c.linkA===a && c.linkB===b) || (c.linkA===b && c.linkB===a))); }
function localPointArrayFromWorld(model, linkName, worldPoint){ const p = localPointFromWorld(model, linkName, worldPoint); return [p.x,p.y,p.z]; }
function localAxisArrayFromWorld(model, linkName, worldDir){ const v = localDirFromWorld(model, linkName, worldDir); return [v.x,v.y,v.z]; }
function rewireTreeParent(model, j, newParent){ if (!j || !newParent || !model._linkInfo?.[newParent]) return; const oldParent = j.body0; if (oldParent && model._linkInfo[oldParent]) { const arr = model._linkInfo[oldParent].children; const idx = arr.indexOf(j.body1); if (idx >= 0) arr.splice(idx, 1); } j.body0 = newParent; j.parentLink = newParent; if (!model._linkInfo[newParent].children.includes(j.body1)) model._linkInfo[newParent].children.push(j.body1); const child = model._linkInfo[j.body1]; if (child) child.parentJoint = j.name; }
function promoteJointFromCandidate(model, j, c, reason){ if (!j || !c || !c.hasAxisPoint) return false; j.schema = /Revolute/i.test(j.schema||'') ? j.schema : 'PhysicsRevoluteJoint'; j.jointType = 'continuous'; j.type = 'continuous'; j.exportedMovable = true; j.viewerControllable = false; j.implicitMotionCandidate = true; j.kinematicRole = j.kinematicRole || 'dependent_passive_implicit_coordinate'; j.authority = (j.authority || '') + ' viewer_repair_from_implicit_candidate'; j.source = (j.source || '') + ' viewer_promoted_fixed_rank4_axis_candidate'; j.evidence = (j.evidence || '') + ' ' + (c.evidence || ''); j.axisWorldMeta = c.axisWorld || [0,0,1]; j.axisJoint = localAxisArrayFromWorld(model, j.body0, j.axisWorldMeta); j.axisSuccessor = localAxisArrayFromWorld(model, j.body1, j.axisWorldMeta); j.axis = jointAxisLocal(j); j.localPos0 = localPointArrayFromWorld(model, j.body0, c.axisPointWorld); j.localPos1 = localPointArrayFromWorld(model, j.body1, c.axisPointWorld); j._localFrame0 = matrixFromPosQuat(j.localPos0, j.localRot0); j._localFrame1 = matrixFromPosQuat(j.localPos1, j.localRot1); j._localFrame1Inv = j._localFrame1.clone().invert(); j._viewerRepair = reason || 'promoted_from_candidate'; return true; }
function applyViewerMechanismRepairsFromCadEvidence(model){ const repairs=[]; for (const j of Object.values(model.joints || {})) { if (!(j && j.tree && /^fixed$/i.test(j.jointType || ''))) continue; const c = candidateBetween(model, j.body0, j.body1); if (c && c.rank === 4 && c.freeDof >= 1 && c.axisLike === 1 && c.planar === 0 && c.hasAxisPoint) { if (promoteJointFromCandidate(model, j, c, 'rank4_axis_like1_nonplanar_fixed_joint')) repairs.push(`${j.name}:fixed→continuous`); } } for (const [piesaTok,bucsaTok] of [['piesa_3_1','bucsa_1'], ['piesa_3_2','bucsa_2']]) { const piesa = linkByToken(model, piesaTok), bucsa = linkByToken(model, bucsaTok); if (!piesa || !bucsa) continue; const c = candidateBetween(model, piesa, bucsa); if (!(c && c.rank === 4 && c.freeDof >= 1 && c.axisLike === 1 && c.planar === 0 && c.hasAxisPoint)) continue; const child = model._linkInfo?.[piesa]; const j = child ? model.joints?.[child.parentJoint] : null; if (!j) continue; const oldParent = j.body0; rewireTreeParent(model, j, bucsa); if (promoteJointFromCandidate(model, j, c, `star_${piesaTok}_to_${bucsaTok}`)) repairs.push(`${piesa}:${oldParent}→${bucsa}`); } model.viewerRepairs = repairs; }
function jointIsPrismatic(j){ return /prismatic/i.test(j?.jointType || '') || /Prismatic/i.test(j?.schema || ''); }
function getJointScalar(j){ return Number.isFinite(j?.value) ? j.value : (jointIsPrismatic(j) ? (j.position || 0) : (j.angle || 0)); }
function setJointScalarNoPose(j, v){ v = Number(v) || 0; j.value = v; if (jointIsPrismatic(j)) j.position = v; else j.angle = v; }
function nearestMovableAncestorJointRaw(model, linkName){ let info = model._linkInfo?.[linkName]; const seen = new Set(); while (info && !seen.has(info.name)) { seen.add(info.name); const j = model.joints?.[info.parentJoint]; if (!j) break; if (j.tree && isMovableJoint(j)) return j; info = model._linkInfo?.[j.body0]; } return null; }
function linkIsDescendantOfJointChild(model, linkName, joint){ if (!joint || !joint.tree) return false; let cur = model._linkInfo?.[linkName]; const seen = new Set(); while (cur && !seen.has(cur.name)) { seen.add(cur.name); if (cur.name === joint.body1) return true; const pj = model.joints?.[cur.parentJoint]; if (!pj) break; cur = model._linkInfo?.[pj.body0]; } return false; }
function recomputeClosureAffectingJoints(model){ model._closureAffectingJointNames = new Set(); const addAncestors = (linkName) => { let info = model._linkInfo?.[linkName]; const seen = new Set(); while (info && !seen.has(info.name)) { seen.add(info.name); const j = model.joints?.[info.parentJoint]; if (!j) break; if (j.tree && isMovableJoint(j)) model._closureAffectingJointNames.add(j.name); info = model._linkInfo?.[j.body0]; } }; for (const l of model.loopJoints || []) { addAncestors(l.body0); addAncestors(l.body1); } for (const c of activeImplicitClosureCandidates(model)) { addAncestors(c.linkA); addAncestors(c.linkB); } }
function recomputeDriverCache(model){ const drivers = Object.values(model.joints || {}).filter(j => j && j.tree && j.role !== 'loop' && isMovableJoint(j) && (j.independent === 'true' || /active|driver|independent/i.test(`${j.kinematicRole || ''} ${j.authority || ''} ${j.source || ''}`))); model._singleDriverJoint = drivers.length === 1 ? drivers[0] : null; }
function jointAffectsAnyClosure(model, joint){ return !!(joint && model._closureAffectingJointNames?.has(joint.name)); }
function shouldRouteManipulationToSingleDriver(model, linkName, directJoint){ const driver = model._singleDriverJoint; if (!driver || !directJoint || driver === directJoint) return false; if (/active|driver|direct/i.test(`${directJoint.kinematicRole || ''} ${directJoint.authority || ''}`)) return false; if (linkIsDescendantOfJointChild(model, linkName, driver)) return true; if (jointAffectsAnyClosure(model, directJoint)) return true; if (/dependent|passive|solver|coupled|implicit/i.test(`${directJoint.kinematicRole || ''} ${directJoint.source || ''} ${directJoint.authority || ''}`)) return true; return false; }
function rebuildManipulableCache(model){ recomputeDriverCache(model); recomputeClosureAffectingJoints(model); model._manipulableJointByLink = new Map(); for (const info of Object.values(model._linkInfo || {})) { const direct = nearestMovableAncestorJointRaw(model, info.name); if (!direct) continue; let chosen = direct; if (shouldRouteManipulationToSingleDriver(model, info.name, direct) && model._singleDriverJoint) chosen = model._singleDriverJoint; model._manipulableJointByLink.set(info.name, chosen); } }
function worldFrameForJointSide(model, j, side){ const link = model._linkInfo?.[side === 0 ? j.body0 : j.body1]; if (!link) return new THREE.Matrix4(); return link.currentMatrix.clone().multiply(side === 0 ? (j._localFrame0 || matrixFromPosQuat(j.localPos0, j.localRot0)) : (j._localFrame1 || matrixFromPosQuat(j.localPos1, j.localRot1))); }
function worldAxisForJointSide(model, j, side){ const frame = worldFrameForJointSide(model, j, side); let axis; if (side === 1 && j.axisSuccessor && j.axisSuccessor.length === 3) axis = new THREE.Vector3(...j.axisSuccessor); else if (j.axisJoint && j.axisJoint.length === 3) axis = new THREE.Vector3(...j.axisJoint); else axis = jointAxisLocal(j); axis.transformDirection(frame).normalize(); if (axis.lengthSq() < 1e-12) axis.set(0,0,1); return axis; }
function getRobotScale(model){ try { const b = new THREE.Box3().setFromObject(model); const s = b.getSize(new THREE.Vector3()); return Math.max(s.x,s.y,s.z) || 1; } catch (_) { return 1; } }
function collectLoopError(model, maxConstraints=Infinity){ const e=[]; const scale=Math.max(getRobotScale(model),1e-4); const axisWeight=Math.min(Math.max(scale*0.35,1e-4),0.05); let used=0; for (const j of model.loopJoints || []) { if (used++ >= maxConstraints) break; const a=worldFrameForJointSide(model,j,0), b=worldFrameForJointSide(model,j,1); const pa=new THREE.Vector3().setFromMatrixPosition(a), pb=new THREE.Vector3().setFromMatrixPosition(b); e.push(pb.x-pa.x,pb.y-pa.y,pb.z-pa.z); const aa=worldAxisForJointSide(model,j,0), ab=worldAxisForJointSide(model,j,1); const c=new THREE.Vector3().crossVectors(aa,ab); e.push(c.x*axisWeight,c.y*axisWeight,c.z*axisWeight); } if (used < maxConstraints) for (const cand of activeImplicitClosureCandidates(model)) { if (used++ >= maxConstraints) break; const la=model._linkInfo?.[cand.linkA], lb=model._linkInfo?.[cand.linkB]; if (!la || !lb) continue; const pa=cand.localPointA.clone().applyMatrix4(la.currentMatrix), pb=cand.localPointB.clone().applyMatrix4(lb.currentMatrix); e.push(pb.x-pa.x,pb.y-pa.y,pb.z-pa.z); const aa=cand.localAxisA.clone().transformDirection(la.currentMatrix).normalize(), ab=cand.localAxisB.clone().transformDirection(lb.currentMatrix).normalize(); const cx=new THREE.Vector3().crossVectors(aa,ab); e.push(cx.x*axisWeight,cx.y*axisWeight,cx.z*axisWeight); } return e; }
function loopErrorNorm(e){ if (!e || !e.length) return 0; let s=0; for (const v of e) s+=v*v; return Math.sqrt(s/Math.max(1,e.length/3)); }
function closureConstraintCount(model){ return (model.loopJoints?.length || 0) + activeImplicitClosureCandidates(model).length; }
function linearDrivenJointNameSet(model){ const set=new Set(); for (const c of model.couplings || []) if (/^linear$/i.test(c.type || '') && c.dependentJoint) set.add(c.dependentJoint); for (const j of Object.values(model.joints || {})) if (j.mimicJoint) set.add(j.name); return set; }
function passiveLoopSolverJoints(model){ const linearDriven=linearDrivenJointNameSet(model); const vars=Object.values(model.joints || {}).filter(j => { if (!(j && j.tree && j.role !== 'loop' && isMovableJoint(j))) return false; if (j.independent === 'true' || /active|driver|direct/i.test(j.kinematicRole || '')) return false; if (!jointAffectsAnyClosure(model,j)) return false; if (linearDriven.has(j.name)) return false; return true; }); return vars.slice(0, model._isDraggingJoint ? 32 : 64); }
function solveLinearDampedNormal(J,e,lambda=1e-4){ const m=e.length,n=J.length?J[0].length:0; if(!m||!n)return[]; const A=Array.from({length:n},()=>Array(n).fill(0)), b=Array(n).fill(0); for(let r=0;r<m;r++)for(let c=0;c<n;c++){ b[c]+=J[r][c]*e[r]; for(let k=0;k<n;k++)A[c][k]+=J[r][c]*J[r][k]; } for(let i=0;i<n;i++)A[i][i]+=lambda; const M=A.map((row,i)=>row.concat([-b[i]])); for(let col=0;col<n;col++){ let piv=col; for(let r=col+1;r<n;r++)if(Math.abs(M[r][col])>Math.abs(M[piv][col]))piv=r; if(Math.abs(M[piv][col])<1e-12)continue; if(piv!==col){const tmp=M[piv];M[piv]=M[col];M[col]=tmp;} const div=M[col][col]; for(let c=col;c<=n;c++)M[col][c]/=div; for(let r=0;r<n;r++){ if(r===col)continue; const f=M[r][col]; if(Math.abs(f)<1e-14)continue; for(let c=col;c<=n;c++)M[r][c]-=f*M[col][c]; } } return M.map(row=>row[n]||0); }
function solveLoopClosureDLS(model){ if(!model.enableLoopSolver || !closureConstraintCount(model) || model._isSolvingLoops) return; const maxConstraints=model._isDraggingJoint?180:2000; const vars=passiveLoopSolverJoints(model); if(!vars.length){ model.lastLoopSolve={residual:loopErrorNorm(collectLoopError(model,maxConstraints)),vars:0,iterations:0,constraints:closureConstraintCount(model)}; return; } model._isSolvingLoops=true; try{ let residual=Infinity; const maxIter=model._isDraggingJoint?4:14; let lambda=model._isDraggingJoint?1e-4:1e-5; for(let it=0;it<maxIter;it++){ applyPoseRaw(model); const e0=collectLoopError(model,maxConstraints); residual=loopErrorNorm(e0); if(residual<5e-6){ model.lastLoopSolve={residual,vars:vars.length,iterations:it,constraints:Math.min(closureConstraintCount(model),maxConstraints)}; break; } const m=e0.length,n=vars.length; const J=Array.from({length:m},()=>Array(n).fill(0)); for(let c=0;c<n;c++){ const j=vars[c], old=getJointScalar(j), eps=jointIsPrismatic(j)?1e-5:1e-4; setJointScalarNoPose(j,old+eps); applyPoseRaw(model); const e1=collectLoopError(model,maxConstraints); setJointScalarNoPose(j,old); for(let r=0;r<m;r++)J[r][c]=(e1[r]-e0[r])/eps; } const oldVals=vars.map(getJointScalar); const dq=solveLinearDampedNormal(J,e0,lambda); let maxStep=0; for(let c=0;c<vars.length;c++){ const j=vars[c]; let step=Number(dq[c]||0); const lim=jointIsPrismatic(j)?0.004:(model._isDraggingJoint?0.08:0.12); step=Math.max(-lim,Math.min(lim,step)); let nv=oldVals[c]+step; if(jointIsPrismatic(j)){const lo=Number.isFinite(j.limit?.lower)?j.limit.lower:-0.25,hi=Number.isFinite(j.limit?.upper)?j.limit.upper:0.25; nv=Math.max(lo,Math.min(hi,nv));} else if(j.jointType!=='continuous'){const lo=Number.isFinite(j.limit?.lower)?j.limit.lower:-Math.PI*2,hi=Number.isFinite(j.limit?.upper)?j.limit.upper:Math.PI*2; nv=Math.max(lo,Math.min(hi,nv));} setJointScalarNoPose(j,nv); maxStep=Math.max(maxStep,Math.abs(step)); } applyPoseRaw(model); const nextResidual=loopErrorNorm(collectLoopError(model,maxConstraints)); if(nextResidual>residual*1.15){ for(let c=0;c<vars.length;c++)setJointScalarNoPose(vars[c],oldVals[c]); lambda*=10; } else { residual=nextResidual; lambda=Math.max(lambda*0.6,1e-7); } model.lastLoopSolve={residual,vars:vars.length,iterations:it+1,constraints:Math.min(closureConstraintCount(model),maxConstraints)}; if(maxStep<5e-8)break; } } finally { model._isSolvingLoops=false; } }

function buildKinematicTree(model, allJoints) {
  const infoByName = model._linkInfo;
  Object.values(infoByName).forEach(l => { l.children = []; l.parentJoint = null; l.group.userData.__joint = null; });
  model.joints = {}; model.loopJoints = [];
  const childTaken = new Set(); const roots = [];
  for (const j of allJoints) {
    if (!infoByName[j.body0] || !infoByName[j.body1]) continue;
    const isLoop = j.role === 'loop' || childTaken.has(j.body1);
    if (isLoop) { j.tree = false; model.loopJoints.push(j); model.joints[j.name] = j; continue; }
    j.tree = true; childTaken.add(j.body1); infoByName[j.body1].parentJoint = j.name; infoByName[j.body0].children.push(j.body1);
    const childGroup = infoByName[j.body1].group; childGroup.userData.__joint = j; j.child = childGroup; model.joints[j.name] = j;
  }
  Object.values(infoByName).forEach(l => { if (!l.parentJoint) roots.push(l.name); });
  model._roots = roots; model._treeJointByChild = new Map();
  for (const j of Object.values(model.joints)) if (j.tree && j.body1) model._treeJointByChild.set(j.body1, j);
  rebuildManipulableCache(model);
}
function applyCouplings(model) {
  if (model.enableCouplings === false) return;
  Object.values(model.joints).forEach(j => {
    if (j.mimicJoint && model.joints[j.mimicJoint]) {
      const m = model.joints[j.mimicJoint];
      const v = (m.value || 0) * j.mimicMultiplier + j.mimicOffset;
      if (/prismatic/i.test(j.jointType)) j.position = v; else j.angle = v; j.value = v;
    }
  });
  for (const c of model.couplings || []) {
    if (!/^linear$/i.test(c.type || '')) continue;
    const m = model.joints[c.masterJoint], d = model.joints[c.dependentJoint];
    if (m && d) {
      const v = (m.value || 0) * c.ratio + c.offset;
      if (/prismatic/i.test(d.jointType)) d.position = v; else d.angle = v; d.value = v;
    }
  }
}
function applyPoseRecursive(model, linkName, worldMatrix) {
  const info = model._linkInfo?.[linkName]; if (!info) return;
  info.currentMatrix.copy(worldMatrix);
  setObjectMatrix(info.group, worldMatrix);
  for (const childName of info.children || []) {
    const child = model._linkInfo?.[childName]; if (!child) continue;
    const j = model.joints[child.parentJoint]; if (!j || j.body0 !== linkName) continue;
    const childWorld = worldMatrix.clone().multiply(j._localFrame0).multiply(motionMatrix(j)).multiply(j._localFrame1Inv);
    applyPoseRecursive(model, childName, childWorld);
  }
}
function applyPoseRaw(model) {
  for (const r of model._roots || []) { const info = model._linkInfo?.[r]; if (info) applyPoseRecursive(model, r, info.baseMatrix.clone()); }
  model.updateMatrixWorld(true);
}
function applyPose(model) {
  applyCouplings(model);
  applyPoseRaw(model);
  if (model.enableLoopSolver !== false) solveLoopClosureDLS(model);
  applyCouplings(model);
  applyPoseRaw(model);
}
function setJointValueInternal(model, j, v) {
  let val = Number(v) || 0;
  if (j.jointType !== 'continuous') {
    if (typeof j.limit?.lower === 'number' && Number.isFinite(j.limit.lower)) val = Math.max(val, j.limit.lower);
    if (typeof j.limit?.upper === 'number' && Number.isFinite(j.limit.upper)) val = Math.min(val, j.limit.upper);
  }
  setJointScalarNoPose(j, val);
  applyPose(model);
}
function parseUSDModel(text, assetDB) {
  const model = new USDModel(parseDefaultPrim(text) || 'AutoMindUSD');
  const blocks = findDefBlocks(text);
  model._linkInfo = {};
  const linkBlocks = blocks.filter(b => b.type === 'Xform' && /automind:linkName/.test(directBody(b.body)));
  for (const b of linkBlocks) {
    const info = createLink(model, b, assetDB);
    model._linkInfo[info.name] = info;
  }
  const jointBlocks = blocks.filter(b => /^Physics.*Joint$/.test(b.type));
  const joints = jointBlocks.map(b => parseJointBlock(b, model)).filter(j => j.name && j.body0 && j.body1);
  model.couplings = blocks.filter(b => b.type === 'Xform' && /automind:kind\s*=\s*"coupling"/.test(directBody(b.body))).map(parseCouplingBlock);
  model.implicitCandidates = blocks.filter(b => b.type === 'Xform' && /automind:kind\s*=\s*"implicit_kinematic_candidate"/.test(directBody(b.body))).map(parseImplicitCandidateBlock);
  buildKinematicTree(model, joints);
  finalizeImplicitCandidateFrames(model);
  applyViewerMechanismRepairsFromCadEvidence(model);
  finalizeImplicitCandidateFrames(model);
  rebuildManipulableCache(model);
  applyPose(model);
  applyDoubleSided(model);
  return model;
}

export function createViewer({ container, background = 0xffffff, pixelRatio = Math.min(window.devicePixelRatio || 1, 2) } = {}) {
  assertThree();
  container = container || document.body;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.innerHTML = '';

  const scene = new THREE.Scene(); scene.background = new THREE.Color(background ?? 0xffffff);
  const perspCamera = new THREE.PerspectiveCamera(45, 1, 0.0001, 10000);
  perspCamera.position.set(1.6, 1.1, 1.6);
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 10000);
  orthoCamera.position.copy(perspCamera.position);
  let camera = perspCamera;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(background ?? 0xffffff, 1);
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = false;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  scene.add(new THREE.AmbientLight(0xffffff, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 0.75); key.position.set(3, 5, 4); scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35); fill.position.set(-4, 2, -3); scene.add(fill);
  const helpers = buildHelpers(); scene.add(helpers.group);

  const ControlsCtor = (typeof THREE.TrackballControls !== 'undefined' ? THREE.TrackballControls : AutoMindTrackballControls);
  const controls = new ControlsCtor(camera, renderer.domElement);
  controls.rotateSpeed = 4.0; controls.zoomSpeed = 1.2; controls.panSpeed = 0.8;
  controls.staticMoving = false; controls.dynamicDampingFactor = 0.15;
  controls.screenSpacePanning = true;

  let robot = null;
  let raf = null;
  let destroyed = false;

  function resize(w, h, dpr = pixelRatio) {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(w || rect.width || window.innerWidth || 800));
    const height = Math.max(1, Math.floor(h || rect.height || window.innerHeight || 600));
    renderer.setPixelRatio(Math.min(dpr || 1, 2)); renderer.setSize(width, height, false);
    const aspect = width / Math.max(1, height);
    perspCamera.aspect = aspect; perspCamera.updateProjectionMatrix();
    const span = Math.max(1, controls.target.distanceTo(camera.position) || 1);
    orthoCamera.left = -span * aspect; orthoCamera.right = span * aspect; orthoCamera.top = span; orthoCamera.bottom = -span; orthoCamera.updateProjectionMatrix();
  }
  function animate() {
    if (destroyed) return;
    raf = requestAnimationFrame(animate);
    controls.update(); renderer.render(scene, camera);
  }
  resize(); animate();
  const ro = new ResizeObserver(() => resize()); ro.observe(container);

  const core = {
    scene, renderer, get camera() { return camera; }, controls, helpers, get robot() { return robot; }, set robot(v) { robot = v; },
    loadUSD(usdContent, { assetDB } = {}) {
      if (robot) { scene.remove(robot); }
      robot = parseUSDModel(usdContent || '', assetDB || null);
      scene.add(robot);
      fitAndCenter(camera, controls, robot, 1.08);
      return robot;
    },
    fitAndCenter(object = robot, pad = 1.08) { return fitAndCenter(camera, controls, object, pad); },
    resize,
    setSceneToggles({ grid, ground, axes, shadows } = {}) {
      if (typeof grid === 'boolean') helpers.grid.visible = grid;
      if (typeof ground === 'boolean') helpers.ground.visible = ground;
      if (typeof axes === 'boolean') helpers.axes.visible = axes;
      if (typeof shadows === 'boolean') { renderer.shadowMap.enabled = shadows; helpers.ground.receiveShadow = shadows; }
    },
    setProjection(mode = 'Perspective') {
      const old = camera;
      if (/ortho/i.test(mode)) {
        const dir = old.position.clone().sub(controls.target);
        camera = orthoCamera; camera.position.copy(controls.target.clone().add(dir)); camera.quaternion.copy(old.quaternion);
      } else {
        const dir = old.position.clone().sub(controls.target);
        camera = perspCamera; camera.position.copy(controls.target.clone().add(dir)); camera.quaternion.copy(old.quaternion);
      }
      controls.object = camera; resize(); controls.update();
    },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); ro.disconnect();
      try { renderer.dispose(); renderer.domElement.remove(); } catch (_) {}
    }
  };
  return core;
}

export default { createViewer };
