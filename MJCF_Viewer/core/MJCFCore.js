// /XML_Viewer/core/MJCFCore.js
// AutoMind BUILD175 MJCF loader.
// - Awaited OBJ/PNG material loading (no white first frame)
// - Explicit MJCF equality/joint ratios and physical equality/connect closures
// - Loop anchors in both local body frames for Show Loops and DLS closure
// - Per-geom visual roots so explode never translates a whole kinematic subtree

/* global THREE */

import { buildAssetDB, variantsFor, basenameNoQuery } from './AssetDB.js';
import { buildURDFAssetDBFromOptions } from './URDFPlusCore.js';

const EPS = 1e-10;
const OBJ_LOADER_CDNS = [
  'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r132/examples/js/loaders/OBJLoader.js'
];

function assertThree() {
  if (typeof THREE === 'undefined') throw new Error('[MJCFCore] THREE is not defined. Load Three.js before rendering.');
}
function sleep(ms = 0) { return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0))); }
function localName(n) { return String(n?.localName || n?.nodeName || '').replace(/^.*:/, '').toLowerCase(); }
function childrenByName(node, name) { return Array.from(node?.children || []).filter(n => localName(n) === String(name).toLowerCase()); }
function firstChild(node, name) { return childrenByName(node, name)[0] || null; }
function parseNums(v, count = 0, fallback = 0) {
  const a = String(v || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  const out = [];
  const n = Math.max(count || a.length, 0);
  for (let i = 0; i < n; i++) out.push(Number.isFinite(a[i]) ? a[i] : fallback);
  return out;
}
function parseVec(v, fallback = [0, 0, 0]) {
  const a = parseNums(v, 3, 0);
  return a.length === 3 ? a : fallback.slice();
}
function parseQuat(v) {
  const q = parseNums(v, 4, 0);
  if (q.length !== 4) return [1, 0, 0, 0];
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > EPS ? q.map(x => x / n) : [1, 0, 0, 0];
}
function boolAttr(node, key, fallback = false) {
  const s = String(node?.getAttribute?.(key) || '').trim();
  if (!s) return fallback;
  return /^(1|true|yes|on)$/i.test(s);
}
function numAttr(node, key, fallback = 0) {
  const n = Number(node?.getAttribute?.(key));
  return Number.isFinite(n) ? n : fallback;
}
function colorFromRgba(v, fallback = [0.78, 0.82, 0.86, 1]) {
  const a = parseNums(v, 4, 1);
  return [a[0] ?? fallback[0], a[1] ?? fallback[1], a[2] ?? fallback[2], a[3] ?? fallback[3]];
}
function isCollisionGeom(node) {
  const name = String(node?.getAttribute?.('name') || '').trim();
  const cls = String(node?.getAttribute?.('class') || '').trim().toLowerCase();
  const groupText = String(node?.getAttribute?.('group') || '').trim();
  const group = Number(groupText);
  // AutoMind exports collision geoms through MJCF defaults, so the group=3
  // attribute is inherited by MuJoCo but absent from the literal XML geom.
  // The viewer must use the class/name contract as well and show only visuals.
  if (/(^|[_:\-])collision([_:\-]|$)|(^|[_:\-])collider([_:\-]|$)|contact/i.test(cls)) return true;
  if (/^(collision|collider|contact)[_:\-]/i.test(name)) return true;
  if (Number.isFinite(group) && group === 3) return true;
  return false;
}
function cleanPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/^\/+/, '');
}
function xmlTextFromValue(v) {
  if (v == null) return '';
  const s = String(v);
  if (/^data:[^,]+,/i.test(s)) {
    const comma = s.indexOf(',');
    const meta = s.slice(0, comma);
    const payload = s.slice(comma + 1);
    try {
      if (/;base64/i.test(meta)) return new TextDecoder().decode(Uint8Array.from(atob(payload), c => c.charCodeAt(0)));
      return decodeURIComponent(payload);
    } catch (_) { return ''; }
  }
  if (/<mujoco[\s>]/i.test(s)) return s;
  try { return atob(s.replace(/\s+/g, '')); } catch (_) { return ''; }
}
function assetText(raw, keys) {
  for (const k0 of keys || []) {
    for (const k of variantsFor(k0)) {
      for (const [actual, value] of Object.entries(raw || {})) {
        if (variantsFor(actual).includes(k)) {
          const t = xmlTextFromValue(value);
          if (t) return { key: actual, text: t };
        }
      }
    }
  }
  return { key: '', text: '' };
}
function assetDataUrl(db, keys) {
  for (const key of keys || []) {
    const hit = db.get(key);
    if (hit) return hit;
  }
  return '';
}
function assetCandidates(file, directory = '') {
  const f = cleanPath(file);
  const d = cleanPath(directory);
  const base = basenameNoQuery(f);
  const out = new Set([f, base, `assets/${base}`, `meshes/${base}`, `textures/${base}`]);
  if (d) {
    out.add(`${d}/${f}`); out.add(`${d}/${base}`);
    out.add(`${d}/assets/${base}`); out.add(`${d}/textures/${base}`);
  }
  return Array.from(out);
}
async function loadClassicScriptOnce(src, timeoutMs = 12000) {
  if (!src) throw new Error('Empty script source');
  if (document.querySelector(`script[data-automind-src="${src}"]`) && window.OBJLoader) return;
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true; s.dataset.automindSrc = src;
    const timer = setTimeout(() => reject(new Error('Timeout loading ' + src)), timeoutMs);
    s.onload = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); reject(new Error('Failed loading ' + src)); };
    document.head.appendChild(s);
  });
}
async function ensureObjLoader() {
  if (THREE.OBJLoader) return;
  let last = null;
  for (const src of OBJ_LOADER_CDNS) {
    try { await loadClassicScriptOnce(src); if (THREE.OBJLoader) return; }
    catch (e) { last = e; }
  }
  throw (last || new Error('OBJLoader unavailable'));
}
function setPose(group, node) {
  if (!group) return;
  const p = parseVec(node?.getAttribute?.('pos'), [0, 0, 0]);
  const q = parseQuat(node?.getAttribute?.('quat'));
  group.position.set(p[0], p[1], p[2]);
  group.quaternion.set(q[1], q[2], q[3], q[0]);
  group.updateMatrix();
}
async function textureFromDataUrl(dataUrl) {
  if (!dataUrl) return null;
  return await new Promise((resolve) => {
    const image = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok) { resolve(null); return; }
      const tex = new THREE.Texture(image);
      tex.flipY = false;
      if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
      tex.needsUpdate = true;
      resolve(tex);
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.src = dataUrl;
    try {
      if (image.decode) image.decode().then(() => finish(true)).catch(() => {});
    } catch (_) {}
  });
}
function stampMaterialTextureState(mat) {
  if (!mat) return mat;
  mat.userData = mat.userData || {};
  // Keep the original texture/color in userData. The component-isolation tween
  // later changes opacity and can clone a material in other viewer modes. These
  // references are the authoritative restoration state, never a white fallback.
  if (mat.map) mat.userData.__automindTextureMap = mat.map;
  if (mat.color?.clone && !mat.userData.__automindBaseColor) mat.userData.__automindBaseColor = mat.color.clone();
  mat.userData.__automindTextureLocked = !!mat.map;
  return mat;
}
async function makeMaterial(def, assetDB) {
  const rgba = colorFromRgba(def?.rgba, [0.78, 0.82, 0.86, 1]);
  // AutoMind OBJ meshes are CAD triangle exports and do not always carry a
  // valid normal stream. MeshStandardMaterial can therefore render them black
  // in WebGL/Colab even while textures are correct. MeshBasicMaterial gives a
  // deterministic CAD-color viewport and still supports map/alpha/wireframe.
  const mat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(rgba[0], rgba[1], rgba[2]),
    transparent: rgba[3] < 0.999, opacity: rgba[3], side: THREE.FrontSide
  });
  mat.userData = { ...(mat.userData || {}), __automindMJCFVisualUnlit: true };
  const tex = def?.texture ? assetDataUrl(assetDB, def.textureCandidates || []) : '';
  if (tex) {
    const map = await textureFromDataUrl(tex);
    if (map) {
      // MJCF material rgba is a multiplier. A CAD colour texture should not be
      // multiplied by the same colour again; let the texture drive diffuse colour.
      mat.color.setRGB(1, 1, 1);
      mat.map = map;
      // These exports are opaque colour PNGs. Keep alpha handling explicit so
      // a visibility tween never turns a textured part into a white fog layer.
      if (rgba[3] >= 0.999) { mat.transparent = false; mat.opacity = 1; mat.depthWrite = true; }
      map.needsUpdate = true;
    }
  }
  stampMaterialTextureState(mat);
  mat.needsUpdate = true;
  return mat;
}
function applyMaterial(root, material, linkName, assetKey, assetToMeshes) {
  root.traverse(o => {
    if (!o?.isMesh) return;
    const m = material?.clone ? material.clone() : material;
    // Three r132 normally copies map in Material.clone(), but set it explicitly
    // because it is critical for CAD colour swatches transported as PNG textures.
    if (material?.map) m.map = material.map;
    if (material?.color && m?.color?.copy) m.color.copy(material.color);
    stampMaterialTextureState(m);
    if (m?.map) { try { m.map.needsUpdate = true; } catch (_) {} }
    if (m) m.needsUpdate = true;
    o.material = m;
    o.castShadow = true; o.receiveShadow = true;
    o.userData.__linkName = linkName;
    o.userData.__assetKey = assetKey;
    const arr = assetToMeshes.get(assetKey) || [];
    arr.push(o); assetToMeshes.set(assetKey, arr);
  });
}
function primitiveMesh(node, material) {
  const type = String(node?.getAttribute?.('type') || 'sphere').toLowerCase();
  const s = parseVec(node?.getAttribute?.('size'), [0.05, 0.05, 0.05]);
  let geo = null;
  if (type === 'box') geo = new THREE.BoxGeometry(2 * s[0], 2 * s[1], 2 * s[2]);
  else if (type === 'cylinder') geo = new THREE.CylinderGeometry(s[0], s[0], 2 * (s[1] || s[0]), 24);
  else if (type === 'capsule' && THREE.CapsuleGeometry) geo = new THREE.CapsuleGeometry(s[0], Math.max(0, 2 * (s[1] || s[0]) - 2 * s[0]), 8, 20);
  else if (type === 'plane') geo = new THREE.PlaneGeometry(2 * s[0], 2 * s[1]);
  else geo = new THREE.SphereGeometry(s[0], 24, 16);
  return new THREE.Mesh(geo, material);
}
function isMovable(type) { return /^(hinge|slide|ball|free)$/i.test(String(type || '')); }
function clamp(v, lo, hi) {
  if (Number.isFinite(lo)) v = Math.max(lo, v);
  if (Number.isFinite(hi)) v = Math.min(hi, v);
  return v;
}
function isSingleToken(s) { return /^\S+$/.test(String(s || '').trim()); }
function isPhysicalConnect(body0, body1, name = '') {
  const a = String(body0 || '').toLowerCase();
  const b = String(body1 || '').toLowerCase();
  const n = String(name || '').toLowerCase();
  const gearA = a.includes('gear');
  const gearB = b.includes('gear');
  // Gear meshing is represented by equality/joint, not equality/connect. A
  // connect between gear bodies over-constrains a gripper and was an exporter bug.
  if (gearA && gearB) return false;
  if ((gearA && b.includes('base_gear')) || (gearB && a.includes('base_gear'))) return false;
  if (n.includes('gear') && (gearA || gearB)) return false;
  return true;
}
function solveDense(A, b) {
  const n = b.length;
  const M = A.map((r, i) => r.slice().concat([b[i]]));
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[pivot][c])) pivot = r;
    if (Math.abs(M[pivot][c]) < 1e-13) return null;
    if (pivot !== c) [M[pivot], M[c]] = [M[c], M[pivot]];
    const inv = 1 / M[c][c];
    for (let j = c; j <= n; j++) M[c][j] *= inv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c];
      if (!f) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map(r => r[n]);
}

class MJCFModel extends THREE.Group {
  constructor(name = 'AutoMindMJCF') {
    super();
    this.name = name;
    this.links = {};
    this._linkInfo = {};
    this.joints = {};
    this.loopJoints = [];
    this.couplings = [];
    this.solverHints = [];
    this.assetToMeshes = new Map();
    this.parentJointByLink = new Map();
    this.manipulableJointByLink = new Map();
    this._allJoints = [];
    this._lastCommandJoint = null;
    this.isDraggingJoint = false;
    this.activeJointForDrag = null;
  }
  _setJointScalar(j, value) {
    if (!j || !j.movable) return;
    j.value = clamp(Number(value) || 0, j.lower, j.upper);
    if (/slide/i.test(j.type)) {
      j.motionGroup.position.copy(j.axis.clone().multiplyScalar(j.value));
      j.motionGroup.quaternion.identity();
    } else if (/hinge/i.test(j.type)) {
      j.motionGroup.position.set(0, 0, 0);
      j.motionGroup.quaternion.setFromAxisAngle(j.axis, j.value);
    }
    j.motionGroup.updateMatrix();
  }
  _applyCouplings() {
    for (let pass = 0; pass < 4; pass++) {
      for (const c of this.couplings || []) {
        const dst = this.joints[c.dependentJoint], src = this.joints[c.masterJoint];
        if (!dst || !src) continue;
        this._setJointScalar(dst, (c.offset || 0) + (c.ratio || 0) * (src.value || 0));
      }
    }
  }
  _refreshLinkMatrices() {
    this.updateMatrixWorld(true);
    for (const info of Object.values(this._linkInfo || {})) {
      if (info?.group) info.currentMatrix.copy(info.group.matrixWorld);
    }
  }
  _loopResidual() {
    this._refreshLinkMatrices();
    const e = [];
    for (const loop of this.loopJoints || []) {
      const a = this._linkInfo?.[loop.body0], b = this._linkInfo?.[loop.body1];
      if (!a || !b || !loop.localPos0 || !loop.localPos1) continue;
      const p0 = new THREE.Vector3(loop.localPos0[0], loop.localPos0[1], loop.localPos0[2]).applyMatrix4(a.currentMatrix);
      const p1 = new THREE.Vector3(loop.localPos1[0], loop.localPos1[1], loop.localPos1[2]).applyMatrix4(b.currentMatrix);
      e.push(p0.x - p1.x, p0.y - p1.y, p0.z - p1.z);
    }
    return e;
  }
  _jointAffectsLink(joint, linkName) {
    let cur = linkName, guard = 0;
    while (cur && guard++ < 128) {
      const p = this.parentJointByLink.get(cur);
      if (!p) return false;
      if (p === joint) return true;
      cur = p.parent;
    }
    return false;
  }
  _solveLoopClosures() {
    if (!this.loopJoints?.length) return;
    const fixed = this.activeJointForDrag || this._lastCommandJoint || null;
    const variables = this._allJoints.filter(j => {
      if (!j?.movable || j.dependent || j === fixed) return false;
      return this.loopJoints.some(loop => this._jointAffectsLink(j, loop.body0) || this._jointAffectsLink(j, loop.body1));
    });
    if (!variables.length) return;
    const eps = 1e-5;
    const lambda = 1e-8;
    for (let iter = 0; iter < 18; iter++) {
      const e = this._loopResidual();
      if (!e.length) return;
      const norm = Math.sqrt(e.reduce((s, v) => s + v * v, 0));
      if (norm < 1e-7) return;
      const m = e.length, n = variables.length;
      const J = Array.from({ length: m }, () => Array(n).fill(0));
      for (let c = 0; c < n; c++) {
        const j = variables[c], q = j.value;
        this._setJointScalar(j, q + eps);
        this._applyCouplings();
        const ep = this._loopResidual();
        this._setJointScalar(j, q);
        this._applyCouplings();
        for (let r = 0; r < m; r++) J[r][c] = ((ep[r] ?? e[r]) - e[r]) / eps;
      }
      const A = Array.from({ length: n }, () => Array(n).fill(0));
      const rhs = Array(n).fill(0);
      for (let r = 0; r < m; r++) {
        for (let i = 0; i < n; i++) {
          rhs[i] -= J[r][i] * e[r];
          for (let j = 0; j < n; j++) A[i][j] += J[r][i] * J[r][j];
        }
      }
      for (let i = 0; i < n; i++) A[i][i] += lambda;
      const dx = solveDense(A, rhs);
      if (!dx) return;
      let maxStep = 0;
      for (let i = 0; i < n; i++) {
        const step = THREE.MathUtils.clamp(dx[i], -0.20, 0.20);
        maxStep = Math.max(maxStep, Math.abs(step));
        this._setJointScalar(variables[i], variables[i].value + step);
      }
      this._applyCouplings();
      if (maxStep < 1e-8) return;
    }
    this._refreshLinkMatrices();
  }
  setJointValue(name, value) {
    const j = typeof name === 'string' ? this.joints[name] : name;
    this._lastCommandJoint = j || null;
    this._setJointScalar(j, value);
    this.applyPose();
  }
  applyPose() {
    this._applyCouplings();
    this._solveLoopClosures();
    this._applyCouplings();
    this._refreshLinkMatrices();
  }
  getManipulableJointForLinkName(linkName) {
    if (this.manipulableJointByLink.has(linkName)) return this.manipulableJointByLink.get(linkName);
    let cur = linkName, guard = 0;
    while (cur && guard++ < 100) {
      const j = this.parentJointByLink.get(cur);
      if (!j) break;
      if (j.movable && !j.dependent) { this.manipulableJointByLink.set(linkName, j); return j; }
      cur = j.parent;
    }
    return null;
  }
  getJointWorldPivot(joint) {
    const j = typeof joint === 'string' ? this.joints[joint] : joint;
    const out = new THREE.Vector3();
    if (j?.pivotGroup) return j.pivotGroup.getWorldPosition(out);
    return out;
  }
  getJointWorldAxis(joint) {
    const j = typeof joint === 'string' ? this.joints[joint] : joint;
    const axis = j?.axis ? j.axis.clone() : new THREE.Vector3(0, 0, 1);
    if (j?.pivotGroup) { const q = new THREE.Quaternion(); j.pivotGroup.getWorldQuaternion(q); axis.applyQuaternion(q); }
    return axis.normalize();
  }
  beginInteractiveDrag(joint = null) { this.isDraggingJoint = true; this.activeJointForDrag = joint || null; this._lastCommandJoint = joint || this._lastCommandJoint; }
  endInteractiveDrag() { this.isDraggingJoint = false; this.activeJointForDrag = null; this.applyPose(); }
}

function findMJCFText(opts, raw) {
  const explicit = opts.mjcfContent || opts.mjcfText || opts.xmlContent || opts.xmlText || opts.robotXml || '';
  if (explicit && /<mujoco[\s>]/i.test(String(explicit))) return { key: opts.mjcfPath || 'model.xml', text: String(explicit) };
  const candidates = [];
  for (const [key, value] of Object.entries(raw || {})) {
    const t = xmlTextFromValue(value);
    if (!/<mujoco[\s>]/i.test(t)) continue;
    let score = 0;
    if (/\.xml$/i.test(key)) score += 100;
    if (/model|mjcf|robot/i.test(key)) score += 50;
    if (/assets\//i.test(key)) score -= 300;
    candidates.push({ key, text: t, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
  return candidates[0] || { key: '', text: '' };
}
function parseAssets(root, raw, db, meshdir, texturedir) {
  const meshes = new Map(), textures = new Map(), materials = new Map();
  const asset = firstChild(root, 'asset');
  for (const n of Array.from(asset?.children || [])) {
    const tag = localName(n), name = n.getAttribute('name') || '';
    if (!name) continue;
    if (tag === 'mesh') {
      const file = n.getAttribute('file') || '';
      meshes.set(name, { name, file, candidates: assetCandidates(file, meshdir) });
    } else if (tag === 'texture') {
      const file = n.getAttribute('file') || '';
      textures.set(name, { name, file, candidates: assetCandidates(file, texturedir) });
    } else if (tag === 'material') {
      materials.set(name, { name, rgba: colorFromRgba(n.getAttribute('rgba')), texture: n.getAttribute('texture') || '' });
    }
  }
  for (const mat of materials.values()) {
    const tex = textures.get(mat.texture);
    mat.textureCandidates = tex?.candidates || [];
  }
  return { meshes, textures, materials };
}
async function addGeom(node, content, model, assets, raw, db, linkName) {
  const type = String(node.getAttribute('type') || 'sphere').toLowerCase();
  // Render only visual geoms. Collision geoms are physical duplicates and must
  // never enter the scene graph, otherwise Ghost mode composites them into a
  // nearly black model and selection/explode sees duplicate parts.
  if (isCollisionGeom(node)) return;
  const materialName = node.getAttribute('material') || '';
  const material = await makeMaterial(assets.materials.get(materialName) || null, db);
  const assetKey = node.getAttribute('mesh') || node.getAttribute('name') || linkName;
  // One visual wrapper per geometry, positioned in body-local coordinates. It is
  // intentionally not the kinematic body: explode moves this wrapper only.
  const visual = new THREE.Group();
  visual.name = 'visual_root:' + (node.getAttribute('name') || assetKey);
  visual.userData.__automindExplodePart = true;
  visual.userData.__linkName = linkName;
  visual.userData.__assetKey = assetKey;
  setPose(visual, node);
  content.add(visual);
  model._visualRoots = model._visualRoots || [];
  model._visualRoots.push(visual);

  if (type === 'mesh') {
    const meshDef = assets.meshes.get(node.getAttribute('mesh') || '');
    if (!meshDef) { content.remove(visual); return; }
    const hit = assetText(raw, meshDef.candidates);
    if (!hit.text) { content.remove(visual); return; }
    await ensureObjLoader();
    let root = null;
    try { root = new THREE.OBJLoader().parse(hit.text); } catch (_) { root = null; }
    if (!root) { content.remove(visual); return; }
    visual.add(root);
    root.traverse(o => {
      if (!o?.isMesh || !o.geometry) return;
      // Some OBJ exporters omit normals. Compute them once at load time even
      // though the default material is unlit; this keeps a safe geometry state
      // for downstream optional materials and avoids black fallback shaders.
      try {
        if (!o.geometry.attributes?.normal) o.geometry.computeVertexNormals?.();
        o.geometry.normalizeNormals?.();
      } catch (_) {}
    });
    applyMaterial(root, material, linkName, meshDef.file || assetKey, model.assetToMeshes);
  } else {
    const mesh = primitiveMesh(node, material);
    mesh.userData.__linkName = linkName;
    mesh.userData.__assetKey = assetKey;
    visual.add(mesh);
    const arr = model.assetToMeshes.get(assetKey) || []; arr.push(mesh); model.assetToMeshes.set(assetKey, arr);
  }
}
function registerJoint(model, node, parentName, chainParent) {
  const name = node.getAttribute('name') || `joint_${Object.keys(model.joints).length}`;
  const type = String(node.getAttribute('type') || (localName(node) === 'freejoint' ? 'free' : 'hinge')).toLowerCase();
  const axisV = parseVec(node.getAttribute('axis'), [0, 0, 1]);
  const axis = new THREE.Vector3(axisV[0], axisV[1], axisV[2]).normalize();
  const range = parseNums(node.getAttribute('range'), 2, NaN);
  const limited = boolAttr(node, 'limited', type !== 'hinge');
  const pivot = new THREE.Group(); pivot.name = 'joint_pivot:' + name;
  const p = parseVec(node.getAttribute('pos'), [0, 0, 0]); pivot.position.set(p[0], p[1], p[2]);
  const motion = new THREE.Group(); motion.name = 'joint_motion:' + name;
  const inverse = new THREE.Group(); inverse.name = 'joint_inverse:' + name; inverse.position.set(-p[0], -p[1], -p[2]);
  chainParent.add(pivot); pivot.add(motion); motion.add(inverse);
  const joint = {
    name, type, jointType: type, schema: /slide/i.test(type) ? 'PrismaticJoint' : 'RevoluteJoint',
    parent: parentName, child: '', body0: parentName, body1: '', movable: isMovable(type) && (type === 'hinge' || type === 'slide'),
    tree: true, role: 'tree', axis, lower: limited ? range[0] : -Infinity, upper: limited ? range[1] : Infinity,
    value: 0, angle: 0, position: 0, pivotGroup: pivot, motionGroup: motion, originGroup: pivot,
    directUserControl: true, independent: true
  };
  model.joints[name] = joint; model._allJoints.push(joint);
  return { joint, contentParent: inverse };
}
async function parseBody(node, parentContent, model, assets, raw, db, parentName, serial) {
  const name = node.getAttribute('name') || `body_${serial.value++}`;
  const bodyPose = new THREE.Group();
  bodyPose.name = name;
  bodyPose.userData.__linkName = name;
  bodyPose.userData.__assetKey = name;
  setPose(bodyPose, node);
  parentContent.add(bodyPose);
  model.links[name] = bodyPose;
  model._linkInfo[name] = { name, group: bodyPose, currentMatrix: new THREE.Matrix4() };

  let content = bodyPose, primaryJoint = null;
  const jointNodes = Array.from(node.children || []).filter(n => ['joint', 'freejoint'].includes(localName(n)));
  for (const jn of jointNodes) {
    const r = registerJoint(model, jn, parentName, content);
    content = r.contentParent;
    if (!primaryJoint) primaryJoint = r.joint;
  }
  if (primaryJoint) {
    primaryJoint.child = name;
    primaryJoint.body1 = name;
    model.parentJointByLink.set(name, primaryJoint);
  }
  for (const g of childrenByName(node, 'geom')) await addGeom(g, content, model, assets, raw, db, name);
  for (const child of childrenByName(node, 'body')) await parseBody(child, content, model, assets, raw, db, name, serial);
  return bodyPose;
}
function parseEquality(root, model) {
  const e = firstChild(root, 'equality');
  for (const n of Array.from(e?.children || [])) {
    const tag = localName(n);
    if (tag === 'joint') {
      const dependentJoint = n.getAttribute('joint1') || '';
      const masterJoint = n.getAttribute('joint2') || '';
      const p = parseNums(n.getAttribute('polycoef'), 5, 0);
      const valid = isSingleToken(dependentJoint) && isSingleToken(masterJoint) && model.joints[dependentJoint] && model.joints[masterJoint];
      const c = { name: n.getAttribute('name') || `coupling_${model.couplings.length}`, type: 'linear', dependentJoint, masterJoint, offset: p[0] || 0, ratio: p[1] || 0 };
      if (!valid) { model.solverHints.push({ ...c, reason: 'MJCF equality/joint references a non-exportable or multi-joint solver hint.' }); continue; }
      model.couplings.push(c);
      model.joints[dependentJoint].dependent = true;
      model.joints[dependentJoint].directUserControl = false;
    } else if (tag === 'connect' || tag === 'weld') {
      const body0 = n.getAttribute('body1') || '';
      const body1 = n.getAttribute('body2') || '';
      const name = n.getAttribute('name') || `loop_${model.loopJoints.length}`;
      if (!model.links[body0] || !model.links[body1] || !isPhysicalConnect(body0, body1, name)) continue;
      const anchor = parseVec(n.getAttribute('anchor'), [0, 0, 0]);
      model.loopJoints.push({
        name, type: tag, role: 'loop', tree: false, drawable: true,
        predecessor: body0, successor: body1, parent: body0, child: body1,
        body0, body1, anchor, localPos0: null, localPos1: null, hasSuccessorOrigin: true
      });
    }
  }
}
function finalizeLoopAnchors(model) {
  model._refreshLinkMatrices();
  for (const loop of model.loopJoints || []) {
    const a = model._linkInfo?.[loop.body0], b = model._linkInfo?.[loop.body1];
    if (!a || !b) continue;
    const anchor = new THREE.Vector3(loop.anchor[0], loop.anchor[1], loop.anchor[2]);
    const invA = a.currentMatrix.clone().invert();
    const invB = b.currentMatrix.clone().invert();
    const pa = anchor.clone().applyMatrix4(invA);
    const pb = anchor.clone().applyMatrix4(invB);
    loop.localPos0 = [pa.x, pa.y, pa.z];
    loop.localPos1 = [pb.x, pb.y, pb.z];
  }
}
function parseActuators(root, model) {
  const a = firstChild(root, 'actuator');
  for (const n of Array.from(a?.children || [])) {
    const joint = n.getAttribute('joint') || '';
    const j = model.joints[joint];
    if (!j) continue;
    const range = parseNums(n.getAttribute('ctrlrange'), 2, NaN);
    if (Number.isFinite(range[0])) j.lower = range[0];
    if (Number.isFinite(range[1])) j.upper = range[1];
    j.actuator = { type: localName(n), name: n.getAttribute('name') || '', kp: numAttr(n, 'kp', 0) };
  }
}

export async function buildMJCFAssetDBFromOptions(opts = {}) {
  const mjcfZip = opts.MJCF_Zip || opts.mjcfZip || opts.mjcfZipBase64 || opts.xmlZip || opts.zipBase64 || opts.zipDataUrl || '';
  const xml = opts.mjcfContent || opts.mjcfText || opts.xmlContent || opts.xmlText || opts.robotXml || '';
  const normalized = { ...opts, URDF_Zip: mjcfZip, urdfContent: xml, urdfPath: opts.mjcfPath || opts.xmlPath || 'model.xml' };
  return buildURDFAssetDBFromOptions(normalized);
}
export async function loadMJCFModel(opts = {}) {
  assertThree();
  const raw = await buildMJCFAssetDBFromOptions(opts);
  const found = findMJCFText(opts, raw);
  if (!found.text) throw new Error('No MJCF <mujoco> XML was found. Pass mjcfContent/xmlContent or MJCF_Zip/assetDB.');
  const xml = new DOMParser().parseFromString(found.text, 'application/xml');
  const parseError = xml.querySelector('parsererror');
  if (parseError) throw new Error('Invalid MJCF XML: ' + parseError.textContent.slice(0, 300));
  const root = xml.querySelector('mujoco');
  if (!root) throw new Error('MJCF root must be <mujoco>.');
  const compiler = firstChild(root, 'compiler');
  const meshdir = compiler?.getAttribute('meshdir') || 'assets';
  const texturedir = compiler?.getAttribute('texturedir') || meshdir;
  const db = buildAssetDB(raw);
  const model = new MJCFModel(root.getAttribute('model') || 'AutoMindMJCF');
  model.assetDB = db; model.sourcePath = found.key;
  const assets = parseAssets(root, raw, db, meshdir, texturedir);
  const worldbody = firstChild(root, 'worldbody');
  if (!worldbody) throw new Error('MJCF has no <worldbody>.');
  const serial = { value: 0 };
  for (const body of childrenByName(worldbody, 'body')) await parseBody(body, model, model, assets, raw, db, '', serial);
  for (const geom of childrenByName(worldbody, 'geom')) await addGeom(geom, model, model, assets, raw, db, 'world');
  parseEquality(root, model);
  finalizeLoopAnchors(model);
  parseActuators(root, model);
  model.applyPose();
  await sleep(0);
  return model;
}

export default { loadMJCFModel, buildMJCFAssetDBFromOptions };
