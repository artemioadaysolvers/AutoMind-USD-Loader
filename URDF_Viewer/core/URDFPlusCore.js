// /URDF_Viewer/core/URDFPlusCore.js
// AutoMind URDF+ loader for the modular USD-style viewer shell. V5 texture/up-axis fixes.
// No iframe, no standalone HTML: it builds a THREE robot directly and exposes
// the same robot API expected by SelectionAndDrag, ToolsDock and ComponentsPanel.
/* global THREE */

const EPS = 1e-12;
const TEXT_EXT = /\.(urdf|xml|dae|obj|mtl|txt|json|csv)$/i;

function assertThree() {
  if (typeof THREE === 'undefined') throw new Error('[URDFPlusCore] THREE is not defined. Load three.js first.');
}
function basename(path) { return String(path || 'file').split(/[\\/]/).filter(Boolean).pop() || 'file'; }
function stripExt(path) { return basename(path).replace(/\.[^.]+$/, ''); }
function extname(path) { const b = basename(path); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i).toLowerCase() : ''; }
function cleanPath(path) {
  let s = String(path || '').trim();
  if ((s.startsWith('@') && s.endsWith('@')) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);
  try { s = decodeURIComponent(s); } catch (_) {}
  s = s.replace(/\\/g, '/').replace(/[?#].*$/, '');
  s = s.replace(/^data:model\//i, '').replace(/^file:\/+/i, '').replace(/^package:\/\//i, '').replace(/^[A-Za-z]:\//, '');
  s = s.replace(/^\.\//, '').replace(/^\/+/, '');
  return s;
}
function normKey(path) { return cleanPath(path).toLowerCase(); }
function variantsFor(path) {
  const raw = cleanPath(path);
  if (!raw) return [];
  const out = new Set();
  const add = (x) => {
    x = normKey(x);
    if (!x) return;
    out.add(x);
    out.add(x.replace(/^\.\//, ''));
    out.add(x.replace(/^\.\.\//, ''));
    const base = basename(x).toLowerCase();
    if (base) out.add(base);
    const parts = x.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) out.add(parts.slice(i).join('/'));
    if (base) {
      const stem = base.replace(/\.[^.]+$/, '');
      out.add(base.replace(/%20/g, ' '));
      out.add(base.replace(/\s+/g, '_'));
      out.add(base.replace(/_/g, ' '));
      out.add(stem);
      out.add(stem.replace(/[\s_\-]+/g, ''));
    }
  };
  add(raw);
  add(raw.replace(/^.*?urdf_export\//i, ''));
  add(raw.replace(/^.*?meshes\//i, 'meshes/'));
  add(raw.replace(/^.*?mesh\//i, 'mesh/'));
  add(raw.replace(/^.*?textures\//i, 'textures/'));
  add(raw.replace(/^.*?texture\//i, 'texture/'));
  return Array.from(out).filter(Boolean);
}
function mimeFromPath(path) {
  const e = extname(path);
  if (e === '.urdf' || e === '.xml') return 'application/xml';
  if (e === '.dae') return 'model/vnd.collada+xml';
  if (e === '.stl') return 'model/stl';
  if (e === '.obj' || e === '.mtl') return 'text/plain';
  if (e === '.png') return 'image/png';
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.bmp') return 'image/bmp';
  if (e === '.gif') return 'image/gif';
  if (e === '.tga') return 'image/x-tga';
  return 'application/octet-stream';
}
function dataURLFromValue(path, value) {
  if (value == null) return '';
  if (value instanceof Blob || value instanceof File) return '';
  let s = String(value);
  if (/^(data:|blob:|https?:\/\/)/i.test(s)) return s;
  const mime = mimeFromPath(path);
  if (TEXT_EXT.test(path) && /[<>{}\n\r]/.test(s.slice(0, 2048))) {
    return `data:${mime};charset=utf-8,${encodeURIComponent(s)}`;
  }
  return `data:${mime};base64,${s.replace(/\s+/g, '')}`;
}
function parseVec(s, fallback = [0, 0, 0]) {
  if (s == null || s === '') return Array.isArray(fallback) ? fallback.slice() : fallback;
  const nums = String(s).match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
  const out = Array.isArray(fallback) ? fallback.slice() : [0, 0, 0];
  for (let i = 0; i < Math.min(out.length, nums.length); i++) if (Number.isFinite(nums[i])) out[i] = nums[i];
  return out;
}
function parseNum(s, fallback = 0) { const n = Number(s); return Number.isFinite(n) ? n : fallback; }
function boolAttr(v, fallback = false) {
  if (v == null || v === '') return fallback;
  return /^(true|1|yes|si|sí)$/i.test(String(v));
}
function localName(node) { return (node?.localName || node?.nodeName || '').replace(/^.*:/, ''); }
function childrenByLocalName(node, name) { return Array.from(node?.children || []).filter(n => localName(n) === name); }
function childByLocalName(node, name) { return childrenByLocalName(node, name)[0] || null; }
function attrAny(node, names, fallback = '') {
  if (!node) return fallback;
  for (const name of names) {
    const v = node.getAttribute?.(name) ?? node.getAttributeNS?.('https://automind.dev/mechanism', name.replace(/^automind:/, ''));
    if (v != null && v !== '') return v;
  }
  return fallback;
}
function repairMissingUrdfPlusNamespace(text) {
  let s = String(text || '').replace(/^\uFEFF/, '');
  if (/<robot\b/i.test(s) && /automind:/i.test(s) && !/xmlns:automind=/i.test(s)) {
    s = s.replace(/<robot\b/i, '<robot xmlns:automind="https://automind.dev/mechanism"');
  }
  return s;
}
function applyOrigin(obj, origin = {}) {
  const xyz = origin.xyz || [0, 0, 0];
  const rpy = origin.rpy || [0, 0, 0];
  obj.position.set(xyz[0] || 0, xyz[1] || 0, xyz[2] || 0);
  obj.rotation.set(rpy[0] || 0, rpy[1] || 0, rpy[2] || 0, 'XYZ');
  obj.updateMatrix();
}
function parseOrigin(node) { return { xyz: parseVec(node?.getAttribute?.('xyz'), [0,0,0]), rpy: parseVec(node?.getAttribute?.('rpy'), [0,0,0]) }; }
function originMatrix(origin = {}) {
  const o = new THREE.Object3D();
  applyOrigin(o, origin);
  return o.matrix.clone();
}
function createDefaultMaterial(color = 0xdce7ea) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0.04, side: THREE.DoubleSide });
}
function setObjectUserDataRecursive(obj, linkName) {
  obj?.traverse?.((o) => {
    if (!o.userData) o.userData = {};
    o.userData.__linkName = linkName;
    o.userData.__assetKey = linkName;
    if (o.isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      if (!o.material) o.material = createDefaultMaterial();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.color && m.color.r > 0.96 && m.color.g > 0.96 && m.color.b > 0.96 && !m.map) m.color.setHex(0xe5ecef);
        m.side = THREE.DoubleSide;
        m.needsUpdate = true;
      }
    }
  });
}
function collectMeshes(obj) { const arr = []; obj?.traverse?.(o => { if (o?.isMesh && o.geometry) arr.push(o); }); return arr; }
function makeMissingMarker(label = '') {
  const g = new THREE.Group();
  g.name = 'missing:' + basename(label);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.025, 0.025, 0.025), new THREE.MeshStandardMaterial({ color: 0xff5b7f, roughness: 0.55 }));
  g.add(mesh);
  return g;
}

function sanitizeLoadedColladaObject(obj, fallbackMaterial = null) {
  // Remove camera/light junk from CAD DAE files and make sure failed texture
  // loads do not leave the model as an unreadable black silhouette.
  obj?.traverse?.((o) => {
    if (o.isCamera || o.isLight) {
      try { o.parent?.remove?.(o); } catch (_) {}
      return;
    }
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    if (!o.material) o.material = fallbackMaterial ? fallbackMaterial.clone() : createDefaultMaterial();
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      m.side = THREE.DoubleSide;
      if (m.map && !m.map.image && !m.map.source?.data) {
        // Keep material but do not let Three continuously try to upload an
        // undefined image.
        try { m.map.needsUpdate = false; } catch (_) {}
      }
      const c = m.color;
      if (c && !m.map && c.r < 0.025 && c.g < 0.025 && c.b < 0.025 && fallbackMaterial?.color) {
        c.copy(fallbackMaterial.color);
      }
      m.needsUpdate = true;
    }
  });
}

function extCompatible(recordExt, desiredExt) {
  if (!desiredExt) return true;
  if (!recordExt) return true;
  return String(recordExt).toLowerCase() === String(desiredExt).toLowerCase();
}
function isProbablyColladaTextUrl(url) {
  try {
    const s = String(url || '');
    if (!/^data:/i.test(s)) return true;
    const comma = s.indexOf(',');
    if (comma < 0) return false;
    let payload = s.slice(comma + 1);
    if (/;base64/i.test(s.slice(0, comma))) {
      try { payload = atob(payload.replace(/\s+/g, '')).slice(0, 256); } catch (_) { return false; }
    } else {
      try { payload = decodeURIComponent(payload).slice(0, 256); } catch (_) { payload = payload.slice(0, 256); }
    }
    return /^\s*</.test(payload);
  } catch (_) { return true; }
}

class URDFPlusAssetResolver {
  constructor(assetDB = {}) {
    this.byKey = new Map();
    this.byOriginal = new Map();
    this.objectUrls = [];
    this.loadingManager = new THREE.LoadingManager();
    this.loadingManager.setURLModifier((url) => this.resolve(url) || url);
    for (const [rawKey, rawVal] of Object.entries(assetDB || {})) this.add(rawKey, rawVal);
  }
  add(key, val) {
    if (!key || val == null) return;
    const data = dataURLFromValue(key, val);
    if (!data) return;
    const rec = { data, ext: extname(key), key: String(key || '') };
    for (const k of variantsFor(key)) {
      // Keep the first exact normalized key, but never let a .jpg stem overwrite a .dae stem.
      // The lookup checks extension compatibility, so basename/stem aliases are safe now.
      if (!this.byKey.has(k)) this.byKey.set(k, rec);
    }
    this.byOriginal.set(normKey(key), rec);
  }
  _lookup(path, desiredExt = '', opts = {}) {
    if (!path) return '';
    desiredExt = desiredExt || extname(path);
    const strict = opts.strict !== false;

    // 1) Exact normalized/suffix variants, with extension compatibility.
    for (const k of variantsFor(path)) {
      const rec = this.byKey.get(k);
      if (rec && extCompatible(rec.ext, desiredExt)) return rec.data;
    }

    // 2) Exact basename match only, still extension-safe.
    const base = basename(path).toLowerCase();
    if (base) {
      for (const [k, rec] of this.byKey.entries()) {
        if (basename(k).toLowerCase() === base && extCompatible(rec.ext, desiredExt)) return rec.data;
      }
    }

    // 3) Optional fuzzy match. Only use it for textures or extensionless names.
    // Never fuzzy-match CAD meshes across stems: that was the cause of duplicated/wrong DAE.
    const isImage = /\.(png|jpe?g|webp|bmp|gif|tga)$/i.test(desiredExt || base);
    if (!strict && (isImage || !desiredExt) && base) {
      const baseStem = base.replace(/\.[^.]+$/, '');
      const baseNorm = baseStem.replace(/[\s_\-]+/g, '');
      for (const [k, rec] of this.byKey.entries()) {
        if (!extCompatible(rec.ext, desiredExt)) continue;
        const b = basename(k).toLowerCase();
        const stem = b.replace(/\.[^.]+$/, '');
        const n = stem.replace(/[\s_\-]+/g, '');
        if (b === base || stem === baseStem || n === baseNorm) return rec.data;
      }
    }
    return '';
  }
  resolve(path) {
    if (!path) return '';
    const raw = String(path);

    // ColladaLoader resolves relative textures against data:model/vnd.collada+xml
    // as fake URLs such as data:model/base.jpg. They are not real data URLs.
    // Redirect those to the uploaded ZIP/assetDB, extension-safely.
    if (/^data:model\//i.test(raw)) {
      const tail = raw.replace(/^data:model\//i, '').replace(/[?#].*$/, '');
      const ext = extname(tail);
      return this._lookup(tail, ext, { strict: false }) || this._lookup(basename(tail), ext, { strict: false }) || '';
    }

    // Real data URLs are already usable.
    if (/^data:[^,]+,/i.test(raw)) return raw;

    // Blob/http URLs are usable, but if a loader produced a weird URL containing
    // a recognizable asset basename, allow a safe texture-only redirect.
    if (/^blob:/i.test(raw) || /^https?:\/\//i.test(raw)) {
      const base = basename(raw);
      const ext = extname(base);
      const byBase = this._lookup(base, ext, { strict: false });
      return byBase || raw;
    }

    const ext = extname(raw);
    return this._lookup(raw, ext, { strict: true });
  }
  debugLookup(path) {
    const ext = extname(path);
    const url = this.resolve(path);
    return { path, ext, resolved: !!url, urlPrefix: String(url || '').slice(0, 80) };
  }
  dispose() {
    for (const u of this.objectUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
    this.objectUrls.length = 0;
  }
}

const CLASSIC_LOADER_CDNS = {
  ColladaLoader: [
    'https://unpkg.com/three@0.132.2/examples/js/loaders/ColladaLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.132.2/examples/js/loaders/ColladaLoader.js'
  ],
  STLLoader: [
    'https://unpkg.com/three@0.132.2/examples/js/loaders/STLLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.132.2/examples/js/loaders/STLLoader.js'
  ],
  OBJLoader: [
    'https://unpkg.com/three@0.132.2/examples/js/loaders/OBJLoader.js',
    'https://cdn.jsdelivr.net/npm/three@0.132.2/examples/js/loaders/OBJLoader.js'
  ]
};

function loadClassicScriptOnce(src, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const existing = Array.from(document.scripts || []).find(s => s.src === src && s.dataset.automindLoaded === '1');
    if (existing) return resolve(true);
    const script = document.createElement('script');
    let done = false;
    const finish = (ok, err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      script.onload = script.onerror = null;
      if (ok) { script.dataset.automindLoaded = '1'; resolve(true); }
      else { try { script.remove(); } catch (_) {} reject(err || new Error('Failed to load ' + src)); }
    };
    const timer = setTimeout(() => finish(false, new Error('Timeout loading ' + src)), timeoutMs);
    script.src = src;
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.onload = () => finish(true);
    script.onerror = () => finish(false, new Error('Failed to load ' + src));
    document.head.appendChild(script);
  });
}

async function loadClassicGlobal(globalName, urls) {
  if (THREE && THREE[globalName]) return true;
  const errors = [];
  for (const src of urls || []) {
    try {
      await loadClassicScriptOnce(src);
      if (THREE && THREE[globalName]) return true;
      errors.push(src + ' loaded, but THREE.' + globalName + ' was not defined');
    } catch (e) {
      errors.push((e && e.message) || String(e));
    }
  }
  throw new Error('Could not load THREE.' + globalName + ' from CDN candidates:\n' + errors.join('\n'));
}

async function ensureClassicLoaderScripts() {
  assertThree();
  await loadClassicGlobal('ColladaLoader', CLASSIC_LOADER_CDNS.ColladaLoader);
  await loadClassicGlobal('STLLoader', CLASSIC_LOADER_CDNS.STLLoader);
  await loadClassicGlobal('OBJLoader', CLASSIC_LOADER_CDNS.OBJLoader);
}
function loaderLoad(loader, url) {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

function parseMaterialColor(visualNode, materialMap) {
  const matNode = childByLocalName(visualNode, 'material');
  if (!matNode) return null;
  const colorNode = childByLocalName(matNode, 'color');
  const colorStr = colorNode?.getAttribute?.('rgba');
  if (colorStr) return parseVec(colorStr, [0.82, 0.86, 0.88, 1]);
  const name = matNode.getAttribute?.('name');
  return name && materialMap.get(name) ? materialMap.get(name) : null;
}
function materialFromColor(rgba) {
  if (!rgba) return createDefaultMaterial();
  const mat = createDefaultMaterial(new THREE.Color(rgba[0] ?? 0.82, rgba[1] ?? 0.86, rgba[2] ?? 0.88));
  const a = Number(rgba[3]);
  if (Number.isFinite(a) && a < 1) { mat.transparent = true; mat.opacity = Math.max(0, Math.min(1, a)); mat.depthWrite = false; }
  return mat;
}

async function loadMeshObject(filename, resolver, fallbackMaterial) {
  const ext = extname(filename);
  const url = resolver.resolve(filename);
  if (!url) return makeMissingMarker(filename);
  await ensureClassicLoaderScripts();
  try {
    if (ext === '.dae') {
      const loader = new THREE.ColladaLoader(resolver.loadingManager);
      // URDF uses the same coordinate frame for joint origins and mesh visual
      // origins. Some legacy Three.js ColladaLoader builds auto-convert DAE
      // Z_UP/Y_UP per-file, which rotates each mesh independently while the URDF
      // kinematic tree stays unchanged. That visually "explodes" robots such as
      // ANYmal. Keep the DAE coordinates as exported; the viewer/camera handles
      // display orientation globally.
      try { if (loader.options) loader.options.convertUpAxis = false; } catch (_) {}
      if (!isProbablyColladaTextUrl(url)) {
        console.warn('[URDFPlusCore] skipped invalid Collada payload, not XML:', filename, resolver.debugLookup?.(filename));
        return makeMissingMarker(filename);
      }
      const collada = await loaderLoad(loader, url);
      const obj = collada && (collada.scene || collada);
      if (!obj || typeof obj.traverse !== 'function') {
        console.warn('[URDFPlusCore] ColladaLoader returned no scene:', filename, resolver.debugLookup?.(filename));
        return makeMissingMarker(filename);
      }
      sanitizeLoadedColladaObject(obj, fallbackMaterial);
      return obj;
    }
    if (ext === '.stl') {
      const loader = new THREE.STLLoader(resolver.loadingManager);
      const geom = await loaderLoad(loader, url);
      if (!geom.attributes.normal) geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, fallbackMaterial ? fallbackMaterial.clone() : createDefaultMaterial());
      const g = new THREE.Group(); g.name = stripExt(filename); g.add(mesh); return g;
    }
    if (ext === '.obj') {
      const loader = new THREE.OBJLoader(resolver.loadingManager);
      const obj = await loaderLoad(loader, url);
      obj.traverse(o => { if (o.isMesh && (!o.material || !o.material.color)) o.material = fallbackMaterial ? fallbackMaterial.clone() : createDefaultMaterial(); });
      return obj;
    }
    return makeMissingMarker(filename);
  } catch (e) {
    console.warn('[URDFPlusCore] mesh load failed', filename, e);
    return makeMissingMarker(filename);
  }
}

class URDFPlusModel extends THREE.Group {
  constructor(name = 'URDFPlusModel') {
    super();
    this.name = name;
    this.links = {};
    this.joints = {};
    this.loopJoints = [];
    this.couplings = [];
    this.implicitCandidates = [];
    this.assetToMeshes = new Map();
    this._linkInfo = {};
    this.parentJointByLink = new Map();
    this.manipulableJointByLink = new Map();
    this.isDraggingJoint = false;
    this.activeJointForDrag = null;
    this.userData.__isURDFPlusModel = true;
    this.userData.__model = this;
  }
  applyPose() { this.updateCurrentMatrices(); }
  updateCurrentMatrices() {
    this.updateMatrixWorld(true);
    for (const info of Object.values(this._linkInfo || {})) info.currentMatrix.copy(info.group.matrixWorld);
  }
  setJointValue(nameOrJoint, value) {
    const joint = typeof nameOrJoint === 'string' ? this.joints[nameOrJoint] : nameOrJoint;
    if (!joint || !joint.movable) return;
    let v = Number(value); if (!Number.isFinite(v)) v = 0;
    const lo = Number.isFinite(joint.lower) ? joint.lower : (/prismatic/i.test(joint.jointType) ? -1 : -Math.PI * 2);
    const hi = Number.isFinite(joint.upper) ? joint.upper : (/prismatic/i.test(joint.jointType) ? 1 : Math.PI * 2);
    v = Math.max(lo, Math.min(hi, v));
    this._setJointScalar(joint, v, true);
    this.applyPose();
  }
  _setJointScalar(joint, value, applyCouplings = true) {
    joint.value = value;
    if (/prismatic/i.test(joint.jointType)) joint.position = value;
    else joint.angle = value;
    applyJointMotion(joint);
    if (applyCouplings && !this.__applyingCouplings) {
      this.__applyingCouplings = true;
      try {
        for (const c of this.couplings || []) {
          if (!c.driver || c.driver !== joint.name || !c.dependent) continue;
          const dep = this.joints[c.dependent];
          if (!dep || !dep.movable) continue;
          this._setJointScalar(dep, (Number(c.multiplier) || 1) * value + (Number(c.offset) || 0), false);
        }
      } finally { this.__applyingCouplings = false; }
    }
  }
  getManipulableJointForLinkName(linkName) {
    if (this.manipulableJointByLink.has(linkName)) return this.manipulableJointByLink.get(linkName);
    let cur = linkName;
    while (cur) {
      const j = this.parentJointByLink.get(cur);
      if (!j) break;
      if (j.movable) { this.manipulableJointByLink.set(linkName, j); return j; }
      cur = j.parent;
    }
    return null;
  }
  getJointWorldPivot(joint) {
    const j = typeof joint === 'string' ? this.joints[joint] : joint;
    const p = new THREE.Vector3();
    j?.originGroup?.getWorldPosition?.(p);
    return p;
  }
  getJointWorldAxis(joint) {
    const j = typeof joint === 'string' ? this.joints[joint] : joint;
    const q = new THREE.Quaternion();
    j?.originGroup?.getWorldQuaternion?.(q);
    const a = (j?.axis || new THREE.Vector3(1,0,0)).clone().normalize().applyQuaternion(q).normalize();
    return a.lengthSq() > EPS ? a : new THREE.Vector3(1,0,0);
  }
  beginInteractiveDrag(joint = null) { this.isDraggingJoint = true; this.activeJointForDrag = joint || null; }
  endInteractiveDrag() { this.isDraggingJoint = false; this.activeJointForDrag = null; this.applyPose(); }
}

function isMovableType(type) { return /revolute|continuous|prismatic|hinge|slider/i.test(String(type || '')); }
function applyJointMotion(joint) {
  const g = joint.motionGroup;
  if (!g) return;
  g.position.set(0,0,0); g.quaternion.identity(); g.rotation.set(0,0,0); g.scale.set(1,1,1);
  const axis = joint.axis || new THREE.Vector3(1,0,0);
  if (/prismatic/i.test(joint.jointType)) g.position.copy(axis.clone().multiplyScalar(Number(joint.position) || 0));
  else if (joint.movable) g.quaternion.setFromAxisAngle(axis.clone().normalize(), Number(joint.angle) || 0);
  g.updateMatrix();
}
function parseJoint(jointNode, model) {
  const name = jointNode.getAttribute('name') || `joint_${Object.keys(model.joints).length}`;
  const type = jointNode.getAttribute('type') || attrAny(jointNode, ['automind:motion_type','motion_type'], 'fixed') || 'fixed';
  const parent = childByLocalName(jointNode, 'parent')?.getAttribute('link') || '';
  const child = childByLocalName(jointNode, 'child')?.getAttribute('link') || '';
  const axisNums = parseVec(childByLocalName(jointNode, 'axis')?.getAttribute('xyz'), [1,0,0]);
  const axis = new THREE.Vector3(axisNums[0] || 0, axisNums[1] || 0, axisNums[2] || 0);
  if (axis.lengthSq() < EPS) axis.set(1,0,0);
  axis.normalize();
  const limit = childByLocalName(jointNode, 'limit');
  const lower = type === 'continuous' ? -Math.PI * 2 : parseNum(limit?.getAttribute('lower'), isMovableType(type) ? (/prismatic/i.test(type) ? -1 : -Math.PI) : 0);
  const upper = type === 'continuous' ? Math.PI * 2 : parseNum(limit?.getAttribute('upper'), isMovableType(type) ? (/prismatic/i.test(type) ? 1 : Math.PI) : 0);
  const j = {
    name, parent, child, body0: parent, body1: child,
    jointType: type, type, schema: /prismatic/i.test(type) ? 'PrismaticJoint' : (isMovableType(type) ? 'RevoluteJoint' : 'FixedJoint'),
    role: attrAny(jointNode, ['role','automind:jointRole','jointRole'], 'tree'),
    tree: true, movable: isMovableType(type), exportedMovable: isMovableType(type),
    independent: boolAttr(attrAny(jointNode, ['independent','automind:independent'], ''), true),
    axis, axisJoint: [axis.x, axis.y, axis.z], axisToken: 'X',
    origin: parseOrigin(childByLocalName(jointNode, 'origin')),
    localPos0: [0,0,0], localPos1: [0,0,0],
    localRot0: new THREE.Quaternion(), localRot1: new THREE.Quaternion(),
    lower, upper, lowerRad: lower, upperRad: upper,
    angle: 0, position: 0, value: 0,
    userData: { __model: model }
  };
  j.localPos0 = j.origin.xyz.slice();
  j._localFrame0 = originMatrix(j.origin);
  j.setJointValue = (v) => model.setJointValue(j, v);
  return j;
}
function parseCouplings(robotNode) {
  const nodes = Array.from(robotNode?.children || []).filter(n => localName(n) === 'coupling');
  return nodes.map(n => {
    const driver = attrAny(n, ['joint','driver','master','source','independent','joint1','from'], '');
    const dependent = attrAny(n, ['dependent','slave','target','follower','joint2','to'], '');
    return {
      driver, dependent,
      multiplier: parseNum(attrAny(n, ['multiplier','ratio','scale','factor'], '1'), 1),
      offset: parseNum(attrAny(n, ['offset','bias'], '0'), 0)
    };
  }).filter(c => c.driver && c.dependent);
}
function parseLoopNodes(robotNode, model) {
  const out = [];
  const nodes = Array.from(robotNode?.children || []).filter(n => localName(n) === 'loop');
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const a = attrAny(n, ['parent','link_a','linkA','body0','from','link1'], '');
    const b = attrAny(n, ['child','link_b','linkB','body1','to','link2'], '');
    if (!a || !b || !model.links[a] || !model.links[b]) continue;
    out.push({ name: attrAny(n, ['name'], `loop_${i}`), role: 'loop', tree: false, body0: a, body1: b, localPos0: [0,0,0], localPos1: [0,0,0] });
  }
  return out;
}

function parseGlobalMaterials(robotNode) {
  const map = new Map();
  for (const m of Array.from(robotNode?.children || []).filter(n => localName(n) === 'material')) {
    const name = m.getAttribute('name');
    const colorNode = childByLocalName(m, 'color');
    if (name && colorNode?.getAttribute('rgba')) map.set(name, parseVec(colorNode.getAttribute('rgba'), [0.82,0.86,0.88,1]));
  }
  return map;
}
async function addVisualsToLink(linkNode, linkGroup, model, resolver, materialMap) {
  const linkName = linkGroup.userData.__linkName || linkGroup.name;
  const visuals = childrenByLocalName(linkNode, 'visual');
  for (const visual of visuals) {
    const vg = new THREE.Group();
    vg.name = 'visual:' + linkName;
    applyOrigin(vg, parseOrigin(childByLocalName(visual, 'origin')));
    const geom = childByLocalName(visual, 'geometry');
    const rgba = parseMaterialColor(visual, materialMap);
    const mat = materialFromColor(rgba);
    let obj = null;
    const mesh = geom ? childByLocalName(geom, 'mesh') : null;
    if (mesh) {
      const filename = mesh.getAttribute('filename') || mesh.getAttribute('url') || '';
      obj = await loadMeshObject(filename, resolver, mat);
      const sc = parseVec(mesh.getAttribute('scale'), [1,1,1]);
      obj.scale.multiply(new THREE.Vector3(sc[0] || 1, sc[1] || 1, sc[2] || 1));
    } else if (geom && childByLocalName(geom, 'box')) {
      const sz = parseVec(childByLocalName(geom, 'box').getAttribute('size'), [0.1,0.1,0.1]);
      obj = new THREE.Mesh(new THREE.BoxGeometry(sz[0], sz[1], sz[2]), mat);
    } else if (geom && childByLocalName(geom, 'cylinder')) {
      const c = childByLocalName(geom, 'cylinder');
      const radius = parseNum(c.getAttribute('radius'), 0.05), length = parseNum(c.getAttribute('length'), 0.1);
      obj = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, 32), mat);
      obj.rotation.x = Math.PI / 2;
    } else if (geom && childByLocalName(geom, 'sphere')) {
      const r = parseNum(childByLocalName(geom, 'sphere').getAttribute('radius'), 0.05);
      obj = new THREE.Mesh(new THREE.SphereGeometry(r, 32, 16), mat);
    }
    if (!obj) continue;
    setObjectUserDataRecursive(obj, linkName);
    vg.add(obj);
    linkGroup.add(vg);
    const arr = model.assetToMeshes.get(linkName) || [];
    arr.push(...collectMeshes(vg));
    model.assetToMeshes.set(linkName, arr);
  }
  if (!model.assetToMeshes.get(linkName)?.length) {
    const marker = makeMissingMarker(linkName);
    setObjectUserDataRecursive(marker, linkName);
    linkGroup.add(marker);
    model.assetToMeshes.set(linkName, collectMeshes(marker));
  }
}

async function getJSZipSafe() {
  if (window.JSZip) return window.JSZip;
  const esmCandidates = [
    'https://esm.sh/jszip@3.10.1',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm'
  ];
  for (const src of esmCandidates) {
    try {
      const mod = await import(src);
      const z = mod.default || mod.JSZip || window.JSZip;
      if (z) return z;
    } catch (_) {}
  }
  const classicCandidates = [
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js'
  ];
  const errors = [];
  for (const src of classicCandidates) {
    try {
      await loadClassicScriptOnce(src);
      if (window.JSZip) return window.JSZip;
      errors.push(src + ' loaded, but window.JSZip was not defined');
    } catch (e) {
      errors.push((e && e.message) || String(e));
    }
  }
  throw new Error('JSZip is not available from CDN candidates:\n' + errors.join('\n'));
}

async function zipBase64ToAssetDB(base64) {
  if (!base64) return {};
  let JSZip = await getJSZipSafe();
  const clean = String(base64).replace(/^data:[^,]+,/i, '').replace(/\s+/g, '');
  const bin = atob(clean);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  const zip = await JSZip.loadAsync(arr.buffer);
  const out = {};
  for (const zf of Object.values(zip.files || {})) {
    if (zf.dir) continue;
    const path = zf.name.replace(/^\/+/, '');
    if (TEXT_EXT.test(path)) out[path] = await zf.async('string');
    else {
      const bytes = await zf.async('uint8array');
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out[path] = btoa(s);
    }
  }
  return out;
}

function findURDFText(opts, assetDB) {
  const direct = opts.urdfContent || opts.urdfText || opts.robotXml || opts.xmlText || '';
  if (direct && /<robot\b/i.test(String(direct))) return String(direct);
  const wanted = opts.urdfPath || opts.urdfFilename || '';
  if (wanted) {
    for (const k of variantsFor(wanted)) {
      const v = assetDB[k] ?? assetDB[Object.keys(assetDB).find(x => normKey(x) === k)];
      if (v && /<robot\b/i.test(String(v))) return String(v);
    }
  }
  const entries = Object.entries(assetDB || {});
  const urdfs = entries.filter(([k, v]) => /\.(urdf|xml)$/i.test(k) && /<robot\b/i.test(String(v || '')));
  urdfs.sort((a, b) => {
    const sa = /standard_tree_backup/i.test(a[0]) ? 1 : 0;
    const sb = /standard_tree_backup/i.test(b[0]) ? 1 : 0;
    return sa - sb || String(a[0]).length - String(b[0]).length;
  });
  return urdfs[0]?.[1] || '';
}

export async function buildURDFAssetDBFromOptions(opts = {}) {
  const assetDB = { ...(opts.assetDB || {}), ...(opts.meshDB || {}), ...(opts.textureDB || {}), ...(opts.assets || {}), ...(opts.filesDB || {}) };
  const zip = opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64 || opts.zipDataUrl || '';
  if (zip && !Object.keys(assetDB).length) Object.assign(assetDB, await zipBase64ToAssetDB(zip));
  const urdf = opts.urdfContent || opts.urdfText || opts.robotXml || opts.xmlText;
  if (urdf) assetDB[opts.urdfPath || opts.urdfFilename || 'URDF_Export/robot.urdf'] = String(urdf);
  return assetDB;
}

export async function loadURDFPlusModel(opts = {}) {
  assertThree();
  await ensureClassicLoaderScripts();
  const assetDBRaw = await buildURDFAssetDBFromOptions(opts);
  const urdfText = findURDFText(opts, assetDBRaw);
  if (!urdfText) throw new Error('No URDF/XML robot text was provided. Pass urdfContent or assetDB/URDF_Zip containing a .urdf/.xml file.');
  const text = repairMissingUrdfPlusNamespace(urdfText);
  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const err = xml.querySelector('parsererror');
  if (err) throw new Error('Invalid URDF/XML: ' + err.textContent.slice(0, 300));
  const robotNode = xml.querySelector('robot');
  if (!robotNode) throw new Error('No <robot> root found in URDF/XML.');

  const resolver = new URDFPlusAssetResolver(assetDBRaw);
  const model = new URDFPlusModel(robotNode.getAttribute('name') || 'AutoMindURDFPlus');
  model.assetResolver = resolver;
  const materialMap = parseGlobalMaterials(robotNode);

  const linkNodes = Array.from(robotNode.children).filter(n => localName(n) === 'link');
  const linkNodeByName = new Map();
  for (const linkNode of linkNodes) {
    const name = linkNode.getAttribute('name');
    if (!name) continue;
    linkNodeByName.set(name, linkNode);
    const g = new THREE.Group();
    g.name = name;
    g.userData.__linkName = name;
    g.userData.__assetKey = name;
    g.userData.__model = model;
    model.links[name] = g;
    model._linkInfo[name] = { name, group: g, parentJoint: null, children: [], currentMatrix: new THREE.Matrix4() };
  }

  await Promise.all(Array.from(linkNodeByName.entries()).map(([name, node]) => addVisualsToLink(node, model.links[name], model, resolver, materialMap)));

  const childLinks = new Set();
  const joints = Array.from(robotNode.children).filter(n => localName(n) === 'joint').map(n => parseJoint(n, model)).filter(j => j.parent && j.child && model.links[j.parent] && model.links[j.child]);
  for (const joint of joints) {
    model.joints[joint.name] = joint;
    if (childLinks.has(joint.child)) {
      joint.role = 'loop'; joint.tree = false; joint.movable = false;
      model.loopJoints.push(joint);
      continue;
    }
    const parentGroup = model.links[joint.parent];
    const childGroup = model.links[joint.child];
    const originGroup = new THREE.Group();
    originGroup.name = 'joint_origin:' + joint.name;
    applyOrigin(originGroup, joint.origin);
    const motionGroup = new THREE.Group();
    motionGroup.name = 'joint_motion:' + joint.name;
    originGroup.add(motionGroup);
    motionGroup.add(childGroup);
    parentGroup.add(originGroup);
    originGroup.userData.__joint = joint;
    motionGroup.userData.__joint = joint;
    childGroup.userData.__joint = joint;
    joint.originGroup = originGroup;
    joint.motionGroup = motionGroup;
    model.parentJointByLink.set(joint.child, joint);
    model._linkInfo[joint.child].parentJoint = joint;
    model._linkInfo[joint.parent]?.children?.push(model._linkInfo[joint.child]);
    childLinks.add(joint.child);
    applyJointMotion(joint);
  }
  for (const [name, group] of Object.entries(model.links)) if (!childLinks.has(name)) model.add(group);

  model.couplings = parseCouplings(robotNode);
  model.loopJoints.push(...parseLoopNodes(robotNode, model));
  model.updateCurrentMatrices();
  return model;
}

export default { loadURDFPlusModel, buildURDFAssetDBFromOptions };
