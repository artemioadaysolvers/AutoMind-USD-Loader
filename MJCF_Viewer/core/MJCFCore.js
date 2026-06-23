// /XML_Viewer/core/MJCFCore.js
// AutoMind BUILD220 MJCF loader.
// - Awaited OBJ/PNG material loading (no white first frame)
// - Explicit MJCF equality/joint ratios and physical equality/connect closures
// - Loop anchors in both local body frames for exact site-pair residual rendering and DLS closure
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
  const out = new Set([
    f,
    base,
    `assets/${base}`,
    `meshes/${base}`,
    `mesh/${base}`,
    `textures/${base}`,
    `texture/${base}`,
    `images/${base}`,
    `materials/${base}`
  ]);
  if (d) {
    out.add(`${d}/${f}`); out.add(`${d}/${base}`);
    out.add(`${d}/assets/${base}`); out.add(`${d}/meshes/${base}`); out.add(`${d}/mesh/${base}`);
    out.add(`${d}/textures/${base}`); out.add(`${d}/texture/${base}`);
    out.add(`${d}/images/${base}`); out.add(`${d}/materials/${base}`);
    const parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    if (parent) {
      out.add(`${parent}/${base}`);
      out.add(`${parent}/textures/${base}`); out.add(`${parent}/texture/${base}`);
      out.add(`${parent}/images/${base}`); out.add(`${parent}/materials/${base}`);
    }
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
function inspectFlatTextureColor(image) {
  // Tiny CAD colour swatches are common in the exported MJCF package. When a
  // texture is uniformly coloured, use that exact colour as an unlit material
  // fallback. This bypasses GPU texture-sampling failures without changing
  // genuinely detailed textures.
  try {
    const w = Number(image?.naturalWidth || image?.width || 0);
    const h = Number(image?.naturalHeight || image?.height || 0);
    if (!w || !h || w > 128 || h > 128) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0, w, h);
    const sample = (x, y) => Array.from(ctx.getImageData(Math.max(0, Math.min(w - 1, x)), Math.max(0, Math.min(h - 1, y)), 1, 1).data);
    const pts = [sample(0,0), sample(w-1,0), sample(0,h-1), sample(w-1,h-1), sample((w/2)|0,(h/2)|0)];
    const base = pts[0];
    for (const px of pts) for (let i = 0; i < 4; i++) if (Math.abs(px[i] - base[i]) > 2) return null;
    return [base[0] / 255, base[1] / 255, base[2] / 255, base[3] / 255];
  } catch (_) { return null; }
}

function texturePixelStats(drawable) {
  // Canvas-backed textures avoid the intermittent data-URL ImageTexture upload
  // failure that Chromium/Colab can render as a completely black OBJ.
  try {
    const w = Number(drawable?.naturalWidth || drawable?.width || 0);
    const h = Number(drawable?.naturalHeight || drawable?.height || 0);
    if (!w || !h) return null;
    const sw = Math.max(1, Math.min(64, w));
    const sh = Math.max(1, Math.min(64, h));
    const canvas = document.createElement('canvas'); canvas.width = sw; canvas.height = sh;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(drawable, 0, 0, sw, sh);
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let r = 0, g = 0, b = 0, a = 0, visible = 0, dark = 0, count = 0;
    for (let i = 0; i + 3 < data.length; i += 4) {
      const aa = data[i + 3] / 255;
      const rr = data[i] / 255, gg = data[i + 1] / 255, bb = data[i + 2] / 255;
      r += rr; g += gg; b += bb; a += aa; count++;
      if (aa > 0.05) {
        visible++;
        if ((0.2126 * rr + 0.7152 * gg + 0.0722 * bb) < 0.018) dark++;
      }
    }
    if (!count) return null;
    return {
      mean: [r / count, g / count, b / count, a / count],
      alphaCoverage: visible / count,
      darkCoverage: visible ? dark / visible : 0,
      width: w,
      height: h,
    };
  } catch (_) { return null; }
}

async function textureFromDataUrl(dataUrl, { flipY = true } = {}) {
  if (!dataUrl) return null;
  return await new Promise((resolve) => {
    const image = new Image();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (!ok) { resolve(null); return; }
      try {
        const w = Number(image.naturalWidth || image.width || 0);
        const h = Number(image.naturalHeight || image.height || 0);
        if (!w || !h) { resolve(null); return; }

        // Build a CanvasTexture rather than a plain Texture(image). This forces a
        // decoded RGBA source before the first renderer frame, preventing the
        // black-silhouette race seen in Colab's WebGL iframe.
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) { resolve(null); return; }
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(image, 0, 0, w, h);
        const tex = new THREE.CanvasTexture(canvas);
        const flatColor = inspectFlatTextureColor(canvas);
        const stats = texturePixelStats(canvas);
        tex.userData = tex.userData || {};
        if (flatColor) tex.userData.__automindFlatTextureColor = flatColor;
        if (stats) tex.userData.__automindTextureStats = stats;
        tex.userData.__automindCanvasBacked = true;
        tex.flipY = !!flipY;
        tex.premultiplyAlpha = false;
        tex.unpackAlignment = 4;
        // Disabling mipmaps avoids incomplete-texture black output for some
        // CAD exports with uncommon dimensions or alpha PNGs.
        tex.generateMipmaps = false;
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = THREE.ClampToEdgeWrapping;
        tex.wrapT = THREE.ClampToEdgeWrapping;
        if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
        else if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
        tex.needsUpdate = true;
        resolve(tex);
      } catch (_) { resolve(null); }
    };
    image.onload = () => finish(true);
    image.onerror = () => finish(false);
    image.decoding = 'sync';
    image.src = dataUrl;
    try {
      if (image.decode) image.decode().then(() => finish(true)).catch(() => {});
    } catch (_) {}
  });
}

function colorIsAlmostBlack(color, threshold = 0.018) {
  return !!(color && color.r <= threshold && color.g <= threshold && color.b <= threshold);
}

function cloneColorFromRgba(rgba) {
  return new THREE.Color(rgba?.[0] ?? 0.78, rgba?.[1] ?? 0.82, rgba?.[2] ?? 0.86);
}

function textureRepeatFromDef(def) {
  const v = Array.isArray(def?.texrepeat) ? def.texrepeat : [1, 1];
  const x = Number.isFinite(v[0]) && v[0] !== 0 ? Math.abs(v[0]) : 1;
  const y = Number.isFinite(v[1]) && v[1] !== 0 ? Math.abs(v[1]) : 1;
  return [x, y];
}

function configureTextureForMaterial(tex, def) {
  if (!tex) return tex;
  const [rx, ry] = textureRepeatFromDef(def);
  if (Math.abs(rx - 1) > EPS || Math.abs(ry - 1) > EPS) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(rx, ry);
  }
  tex.needsUpdate = true;
  return tex;
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
async function makeMaterial(def, assetDB, geomNode = null) {
  // A texture referenced by an MTL is the diffuse appearance itself.  Do not
  // multiply it by MTL Kd: CAD exporters frequently leave Kd at 0 0 0 while
  // the actual colour is stored only in map_Kd. Multiplying map * black was
  // the direct cause of the black silhouettes in the Colab viewer.
  const geomRgba = geomNode?.getAttribute?.('rgba');
  const rgba = geomRgba
    ? colorFromRgba(geomRgba, [0.78, 0.82, 0.86, 1])
    : colorFromRgba(def?.rgba, [0.78, 0.82, 0.86, 1]);
  const requestedTexture = String(def?.texture || '').trim();
  const candidates = Array.from(new Set([
    ...(def?.textureCandidates || []),
    ...(requestedTexture ? assetCandidates(requestedTexture, def?.texturedir || '') : [])
  ]));
  const texData = requestedTexture ? assetDataUrl(assetDB, candidates) : '';
  const map = texData ? await textureFromDataUrl(texData, { flipY: def?.flipY !== false }) : null;
  const forceVisible = !!window.AutoMindMJCFForceVisibleMaterials;

  let mat;
  if (map) {
    configureTextureForMaterial(map, def);
    const stats = map.userData?.__automindTextureStats || null;
    const rgbaColor = new THREE.Color(rgba[0], rgba[1], rgba[2]);
    const rgbaLuma = 0.2126 * rgbaColor.r + 0.7152 * rgbaColor.g + 0.0722 * rgbaColor.b;
    const textureLooksBlack = !!stats && stats.alphaCoverage > 0.20 && stats.darkCoverage > 0.985;

    // A genuinely broken/empty bitmap must not hide the mechanism.  Use Kd
    // when useful; otherwise use a neutral inspection colour only when the
    // caller explicitly asked for visible materials.
    const useEmergencyFallback = textureLooksBlack && (rgbaLuma > 0.035 || forceVisible);
    const emergencyColor = rgbaLuma > 0.12 ? rgbaColor : new THREE.Color(0xb8c8cf);
    const alpha = Math.max(0, Math.min(1, Number(rgba[3] ?? 1)));

    mat = new THREE.MeshBasicMaterial({
      // White is intentional: in Three.js the sampled diffuse map is multiplied
      // by material.color.  Kd=0 must never turn a valid map_Kd black.
      color: useEmergencyFallback ? emergencyColor : new THREE.Color(0xffffff),
      map: useEmergencyFallback ? null : map,
      transparent: alpha < 0.999,
      opacity: alpha,
      side: THREE.DoubleSide,
      depthWrite: alpha >= 0.999,
      depthTest: true
    });
    mat.userData = {
      ...(mat.userData || {}),
      __automindTextureRequested: requestedTexture,
      __automindTextureResolved: true,
      __automindViewportNoFog: true,
      __automindTextureStats: stats || null,
      __automindTextureBlackFallback: useEmergencyFallback,
      __automindSourceRgba: rgba.slice(),
      __automindMtlDiffuseMap: !useEmergencyFallback
    };
  } else {
    const fallbackColor = cloneColorFromRgba(rgba);
    // If neither a bitmap nor a useful Kd colour exists, use a neutral visible
    // inspection colour in force-visible mode. This affects only missing maps.
    const luma = 0.2126 * fallbackColor.r + 0.7152 * fallbackColor.g + 0.0722 * fallbackColor.b;
    if (requestedTexture && forceVisible && (colorIsAlmostBlack(fallbackColor) || luma < 0.12)) {
      fallbackColor.setHex(0xb8c8cf);
    }
    mat = requestedTexture
      ? new THREE.MeshBasicMaterial({
          color: fallbackColor,
          transparent: rgba[3] < 0.999,
          opacity: rgba[3],
          side: THREE.DoubleSide,
          depthWrite: rgba[3] >= 0.999,
          depthTest: true
        })
      : new THREE.MeshStandardMaterial({
          color: fallbackColor,
          roughness: 0.58,
          metalness: 0.06,
          transparent: rgba[3] < 0.999,
          opacity: rgba[3],
          side: THREE.DoubleSide,
          depthWrite: rgba[3] >= 0.999,
          depthTest: true
        });
    mat.userData = {
      ...(mat.userData || {}),
      __automindTextureRequested: requestedTexture,
      __automindTextureResolved: false,
      __automindTextureCandidates: candidates.slice(),
      __automindSourceRgba: rgba.slice(),
      __automindViewportNoFog: !!requestedTexture
    };
  }

  if ('toneMapped' in mat) mat.toneMapped = false;
  if ('blending' in mat) mat.blending = THREE.NormalBlending;
  if ('premultipliedAlpha' in mat) mat.premultipliedAlpha = false;
  stampMaterialTextureState(mat);
  mat.needsUpdate = true;
  return mat;
}
function geometryUsesRepeatedUVs(geometry) {
  const uv = geometry?.attributes?.uv;
  if (!uv?.array || !Number.isFinite(uv.count) || uv.count < 1) return false;
  const a = uv.array;
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (let i = 0; i + 1 < a.length; i += uv.itemSize || 2) {
    const u = Number(a[i]), v = Number(a[i + 1]);
    if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
    minU = Math.min(minU, u); minV = Math.min(minV, v);
    maxU = Math.max(maxU, u); maxV = Math.max(maxV, v);
  }
  return minU < -EPS || minV < -EPS || maxU > 1 + EPS || maxV > 1 + EPS;
}

function configureMaterialForGeometry(mat, geometry) {
  if (!mat?.map) return;
  // CAD OBJ files occasionally use tiled UVs. ClampToEdge samples the texture's
  // black border for every coordinate outside [0,1], creating the exact black
  // component symptom reported in the MJCF viewer. Preserve regular atlas maps,
  // but enable repeat only for geometry that demonstrably needs it.
  if (geometryUsesRepeatedUVs(geometry)) {
    mat.map.wrapS = THREE.RepeatWrapping;
    mat.map.wrapT = THREE.RepeatWrapping;
    mat.map.needsUpdate = true;
    mat.userData = mat.userData || {};
    mat.userData.__automindRepeatUVs = true;
  }
}

function applyMaterial(root, material, linkName, assetKey, assetToMeshes) {
  root.traverse(o => {
    if (!o?.isMesh) return;
    const m = material?.clone ? material.clone() : material;
    // Three r132 normally copies map in Material.clone(), but set it explicitly
    // because it is critical for CAD colour swatches transported as PNG textures.
    if (material?.map) m.map = material.map;
    if (material?.color && m?.color?.copy) m.color.copy(material.color);
    configureMaterialForGeometry(m, o.geometry);
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
    // MJCF sites are first-class kinematic anchors. Equality/connect can refer
    // to site1/site2 (MuJoCo 3.2+), so they cannot be treated as invisible
    // decoration or discarded after mesh loading.
    this.sites = {};
    this.loopRevoluteGroups = [];
    this._linkInfo = {
      __world__: { name: '__world__', group: this, currentMatrix: new THREE.Matrix4(), isWorld: true }
    };
    this.joints = {};
    this.loopJoints = [];
    this.couplings = [];
    // Presentation-only catalog built strictly from the parsed MJCF XML.
    // It does not participate in the solver and is consumed by the 3D
    // CouplingOverlay in ViewerCore.
    this.overlayCouplings = [];
    this.tendons = {};
    this.solverHints = [];
    this.assetToMeshes = new Map();
    this.parentJointByLink = new Map();
    this.jointChainByLink = new Map();
    // Structural ancestry is separate from the joint map: many CAD parts are
    // fixed visual children of a moving body. Keeping that relation lets a
    // click on a pin, mesh or rigid sub-part route to the nearest real joint.
    this.parentLinkByLink = new Map();
    this.manipulableJointByLink = new Map();
    this._poseVersion = 0;
    // MuJoCo-style generalized-coordinate state. The scene hierarchy only
    // presents this state after a complete forward/constraint transaction.
    this.qpos = [];
    this._poseTransactionDepth = 0;
    this._lastStableSnapshot = [];
    this._lastPoseDiagnostics = null;
    this._allJoints = [];
    this._lastCommandJoint = null;
    this.isDraggingJoint = false;
    this.activeJointForDrag = null;
    this.isSolvingLoops = false;
    this.pinnedSolverJointName = '';
    this.lastLoopSolve = null;
    this.closureAffectingJointNames = new Set();
    this.userData.__model = this;
    this.userData.__isMJCFModel = true;
  }

  _setJointScalar(j, value) {
    if (!j || !j.movable) return;
    const v = clamp(Number(value) || 0, j.lower, j.upper);
    j.value = v;
    if (Number.isInteger(j.qposIndex) && j.qposIndex >= 0) this.qpos[j.qposIndex] = v;
    if (/slide/i.test(j.type)) {
      j.position = v;
      j.motionGroup.position.copy(j.axis.clone().multiplyScalar(v));
      j.motionGroup.quaternion.identity();
    } else if (/hinge/i.test(j.type)) {
      j.angle = v;
      j.motionGroup.position.set(0, 0, 0);
      j.motionGroup.quaternion.setFromAxisAngle(j.axis, v);
    }
    j.motionGroup.updateMatrix();
    // Three.js does not guarantee that a manually updated local matrix marks all
    // descendants dirty in every embedding (notably iframe + proxy render paths).
    // The closed-chain solver and the visible proxy must observe the same pose in
    // the same frame, even when a lower/passive link is dragged.
    j.motionGroup.matrixWorldNeedsUpdate = true;
  }

  _applyCouplings() {
    // Apply equality/joint relations repeatedly. A short fixed-point pass supports
    // chains of dependent joints without allowing the DLS solver to fight them.
    for (let pass = 0; pass < 8; pass++) {
      for (const c of this.couplings || []) {
        if (!/^linear$/i.test(c?.type || 'linear')) continue;
        const dst = this.joints[c.dependentJoint];
        const src = this.joints[c.masterJoint];
        if (!dst || !src || dst === src) continue;
        this._setJointScalar(dst, (c.offset || 0) + (c.ratio || 0) * (src.value || 0));
      }
    }
  }

  _refreshLinkMatrices() {
    // `group` is the post-joint link frame (never the static body reference).
    // Force both upward and downward propagation before sampling any site, loop
    // anchor, selection pivot or presentation proxy. This is essential when the
    // user drags a lower/passive member instead of the top-level motor.
    try {
      if (typeof this.updateWorldMatrix === 'function') this.updateWorldMatrix(true, true);
      else this.updateMatrixWorld(true);
    } catch (_) {
      this.updateMatrixWorld(true);
    }
    for (const info of Object.values(this._linkInfo || {})) {
      if (info?.group) info.currentMatrix.copy(info.group.matrixWorld);
    }
    this.userData.__automindKinematicFrameVersion = (Number(this.userData.__automindKinematicFrameVersion) || 0) + 1;
  }

  _modelScale() {
    if (Number.isFinite(this._closureScale) && this._closureScale > EPS) return this._closureScale;
    const box = new THREE.Box3().setFromObject(this);
    const size = new THREE.Vector3();
    box.getSize(size);
    const d = Math.max(size.x, size.y, size.z, 1e-3);
    this._closureScale = d;
    return d;
  }

  _activeSolverLoops() {
    return (this.loopJoints || []).filter(loop => {
      if (!loop || loop.active === false || loop.solve === false) return false;
      if (!this._linkInfo?.[loop.body0] || !this._linkInfo?.[loop.body1]) return false;
      // A direct tree joint already carries this pair. Treat duplicate equality
      // declarations only as diagnostics/decoration, never as a second hard loop.
      const duplicateTreeJoint = (this._allJoints || []).some(j => j && j.tree &&
        ((j.body0 === loop.body0 && j.body1 === loop.body1) || (j.body0 === loop.body1 && j.body1 === loop.body0)));
      return !duplicateTreeJoint;
    });
  }

  _frameForLoopSide(loop, side) {
    const info = this._linkInfo?.[side === 0 ? loop.body0 : loop.body1];
    if (!info) return new THREE.Matrix4();
    const local = side === 0 ? loop.localFrame0 : loop.localFrame1;
    if (local?.isMatrix4) return info.currentMatrix.clone().multiply(local);
    const pos = side === 0 ? loop.localPos0 : loop.localPos1;
    const quat = side === 0 ? loop.localQuat0 : loop.localQuat1;
    const m = new THREE.Matrix4().identity();
    if (pos || quat) {
      const p = new THREE.Vector3(...(pos || [0, 0, 0]));
      const q = new THREE.Quaternion(...(quat || [0, 0, 0, 1]));
      if (q.lengthSq() < EPS) q.identity(); else q.normalize();
      m.compose(p, q, new THREE.Vector3(1, 1, 1));
    }
    return info.currentMatrix.clone().multiply(m);
  }

  _loopResidual(maxConstraints = Infinity) {
    this._refreshLinkMatrices();
    const e = [];
    const scale = this._modelScale();
    const axisWeight = Math.min(Math.max(scale * 0.35, 1e-4), 0.05);
    const weight = this.isDraggingJoint ? 0.72 : 0.82;
    let count = 0;
    for (const loop of this._activeSolverLoops()) {
      if (count++ >= maxConstraints) break;
      const a = this._frameForLoopSide(loop, 0);
      const b = this._frameForLoopSide(loop, 1);
      const pa = new THREE.Vector3().setFromMatrixPosition(a);
      const pb = new THREE.Vector3().setFromMatrixPosition(b);
      e.push((pb.x - pa.x) * weight, (pb.y - pa.y) * weight, (pb.z - pa.z) * weight);

      // MJCF connect closes a point. For this CAD-derived gripper that point is
      // a revolute pin: adding a light axis-alignment residual removes the
      // rotational nullspace of the custom kinematic viewer while still allowing
      // free rotation about the pin axis. This mirrors the USD/URDF+ pin-axis
      // closure logic rather than turning the connect into a weld.
      if (/^connect$/i.test(loop.type || '') && !loop.sitePair) {
        const axisA = new THREE.Vector3(0, 0, 1).transformDirection(a).normalize();
        const axisB = new THREE.Vector3(0, 0, 1).transformDirection(b).normalize();
        if (axisA.lengthSq() > EPS && axisB.lengthSq() > EPS) {
          if (axisA.dot(axisB) < 0) axisB.negate();
          const cross = new THREE.Vector3().crossVectors(axisA, axisB);
          const arm = Math.max(scale * 0.075, 1e-5) * weight;
          e.push(cross.x * arm, cross.y * arm, cross.z * arm);
        }
      }

      // equality/weld constrains the full relative pose.
      if (/^weld$/i.test(loop.type || '')) {
        const torqueScale = Number.isFinite(loop.torquescale) ? Math.max(0, loop.torquescale) : 1;
        if (torqueScale > EPS) {
          const qa = new THREE.Quaternion().setFromRotationMatrix(a).normalize();
          const qb = new THREE.Quaternion().setFromRotationMatrix(b).normalize();
          const qerr = qa.clone().invert().multiply(qb).normalize();
          if (qerr.w < 0) qerr.set(-qerr.x, -qerr.y, -qerr.z, -qerr.w);
          const angularWeight = axisWeight * torqueScale;
          e.push(2 * qerr.x * angularWeight * weight, 2 * qerr.y * angularWeight * weight, 2 * qerr.z * angularWeight * weight);
        }
      }
    }
    return e;
  }

  _loopErrorNorm(e) {
    if (!e?.length) return 0;
    let s = 0;
    for (const v of e) s += v * v;
    return Math.sqrt(s / Math.max(1, e.length / 3));
  }

  _jointAffectsLink(joint, linkName) {
    let cur = linkName;
    let guard = 0;
    const visited = new Set();
    while (cur && cur !== '__world__' && guard++ < 256 && !visited.has(cur)) {
      visited.add(cur);
      const chain = this.jointChainByLink.get(cur) || [this.parentJointByLink.get(cur)].filter(Boolean);
      if (chain.some(p => p === joint || p?.name === joint?.name)) return true;
      // Fixed bodies have no parentJointByLink entry. Continue through their
      // structural parent instead of treating them as a kinematic dead end.
      const next = chain[0]?.parent || this.parentLinkByLink?.get(cur) || '';
      if (!next || next === cur) break;
      cur = next;
    }
    return false;
  }

  _rebuildClosureCaches() {
    this.closureAffectingJointNames = new Set();
    for (const loop of this._activeSolverLoops()) {
      for (const j of this._allJoints || []) {
        if (!j?.movable || !j.tree || j.role === 'loop') continue;
        if (this._jointAffectsLink(j, loop.body0) || this._jointAffectsLink(j, loop.body1)) {
          this.closureAffectingJointNames.add(j.name);
        }
      }
    }
    this.manipulableJointByLink = new Map();
  }

  _passiveLoopSolverJoints(changedJoint = null) {
    const limit = this.isDraggingJoint ? 16 : 24;
    const out = (this._allJoints || []).filter(j => {
      if (!j?.movable || !j.tree || j.role === 'loop' || j.dependent) return false;
      // An actuated joint is a driver. It must never be moved by the closure
      // solver, otherwise the solver can undo the user's motor command instead
      // of moving the passive four-bar members.
      if (j.actuator) return false;
      if (changedJoint && j.name === changedJoint.name) return false;
      if (this.pinnedSolverJointName && j.name === this.pinnedSolverJointName) return false;
      if (this.activeJointForDrag && j.name === this.activeJointForDrag.name) return false;
      return this.closureAffectingJointNames?.has(j.name);
    });
    return out.slice(0, limit);
  }

  _solveLoopClosures(changedJoint = null) {
    // MuJoCo-inspired position stage: qpos -> forward kinematics -> projection.
    // The browser only receives the final committed state, never an intermediate
    // trial configuration where a closed linkage looks disconnected.
    const loops = this._activeSolverLoops();
    if (!loops.length || this.isSolvingLoops) return;
    if (!this.closureAffectingJointNames?.size) this._rebuildClosureCaches();
    const variables = this._passiveLoopSolverJoints(changedJoint);
    const maxConstraints = this.isDraggingJoint ? 768 : 2400;
    const tolerance = Math.max(this._modelScale() * 1.25e-4, this.isDraggingJoint ? 2.5e-5 : 8e-6);
    if (!variables.length) {
      const residual = this._loopErrorNorm(this._loopResidual(maxConstraints));
      this.lastLoopSolve = { residual, vars: 0, iterations: 0, constraints: loops.length, converged: residual <= tolerance };
      return;
    }
    this.isSolvingLoops = true;
    try {
      const maxIter = this.isDraggingJoint ? 24 : 48;
      let lambda = this.isDraggingJoint ? 2e-5 : 3e-7;
      let residual = Infinity;
      let converged = false;
      // Keeps redundant passive DOFs close to the incoming pose rather than
      // allowing unrelated pieces to wander to a different assembly branch.
      const reference = variables.map(j => j.value || 0);
      for (let iter = 0; iter < maxIter; iter++) {
        this._applyCouplings();
        const e0 = this._loopResidual(maxConstraints);
        residual = this._loopErrorNorm(e0);
        if (!e0.length || residual <= tolerance) {
          converged = true;
          this.lastLoopSolve = { residual, vars: variables.length, iterations: iter, constraints: loops.length, converged: true };
          break;
        }
        const m=e0.length, n=variables.length;
        const J=Array.from({length:m},()=>Array(n).fill(0));
        for (let c=0;c<n;c++) {
          const j=variables[c], old=j.value||0;
          const eps=/slide/i.test(j.type||'')?2e-5:2e-5;
          this._setJointScalar(j,old+eps); this._applyCouplings();
          const ep=this._loopResidual(maxConstraints);
          this._setJointScalar(j,old-eps); this._applyCouplings();
          const em=this._loopResidual(maxConstraints);
          this._setJointScalar(j,old); this._applyCouplings();
          for (let r=0;r<m;r++) J[r][c]=((ep[r]??e0[r])-(em[r]??e0[r]))/(2*eps);
        }
        const A=Array.from({length:n},()=>Array(n).fill(0));
        const rhs=Array(n).fill(0);
        for (let i=0;i<n;i++) {
          for (let r=0;r<m;r++) rhs[i]-=J[r][i]*e0[r];
          for (let k=0;k<n;k++) {
            let sum=0; for (let r=0;r<m;r++) sum+=J[r][i]*J[r][k];
            A[i][k]=sum;
          }
          const poseReg=this.isDraggingJoint?8e-7:1e-7;
          A[i][i]+=lambda+poseReg;
          rhs[i]+=poseReg*(reference[i]-(variables[i].value||0));
        }
        let dq=solveDense(A,rhs);
        if (!dq || dq.some(v=>!Number.isFinite(v))) { lambda*=10; continue; }
        const maxStep=this.isDraggingJoint?0.14:0.28;
        const maxAbs=Math.max(0,...dq.map(v=>Math.abs(v)));
        if (maxAbs>maxStep) dq=dq.map(v=>v*(maxStep/maxAbs));
        const oldValues=variables.map(j=>j.value||0);
        let accepted=false;
        for (const alpha of [1,0.65,0.4,0.25,0.125,0.0625]) {
          for (let i=0;i<n;i++) this._setJointScalar(variables[i],oldValues[i]+alpha*dq[i]);
          this._applyCouplings();
          const trial=this._loopErrorNorm(this._loopResidual(maxConstraints));
          if (Number.isFinite(trial) && trial+Math.max(1e-12,residual*1e-6)<residual) {
            residual=trial; lambda=Math.max(lambda*0.35,1e-10); accepted=true; break;
          }
        }
        if (!accepted) {
          for (let i=0;i<n;i++) this._setJointScalar(variables[i],oldValues[i]);
          this._applyCouplings(); lambda*=8;
          if (lambda>1e9) break;
        }
        this.lastLoopSolve={residual,vars:variables.length,iterations:iter+1,constraints:loops.length,converged:residual<=tolerance};
      }
      // Always publish the current solve result. Keeping an older residual here
      // would make drag feasibility decisions use stale data after a rejected DLS step.
      this.lastLoopSolve={
        residual,
        vars:variables.length,
        iterations:Number(this.lastLoopSolve?.iterations) || maxIter,
        constraints:loops.length,
        converged:residual<=tolerance || converged
      };
    } finally {
      this.isSolvingLoops=false;
      this._refreshLinkMatrices();
    }
  }

  _snapshotMovableJointValues() {
    return (this._allJoints || []).filter(j => j?.movable && j.tree && j.role !== 'loop').map(j => [j, j.value || 0]);
  }

  _restoreMovableJointValues(snapshot) {
    for (const [j, value] of snapshot || []) this._setJointScalar(j, value);
    this._applyCouplings();
  }

  _dragFeasibleResidualLimit(baseResidual) {
    // Reject visibly open linkages. Infeasible pointer motion is projected to
    // the nearest valid pose instead of allowing a detached assembly to render.
    const baseline = Number.isFinite(baseResidual) ? baseResidual : 0;
    return Math.max(this._modelScale() * 4e-4, 3e-5, baseline * 1.35 + 1e-7);
  }

  _attemptConstrainedDragValue(joint, value, baseSnapshot) {
    this._restoreMovableJointValues(baseSnapshot);
    this._setJointScalar(joint, value);
    this.applyPose(joint);
    const residual = this.lastLoopSolve?.residual ?? this._loopErrorNorm(this._loopResidual());
    return { residual, value: joint.value || 0, snapshot: this._snapshotMovableJointValues() };
  }

  _applyConstrainedJointDrag(joint, targetValue) {
    if (!joint) return false;
    const startValue = joint.value || 0;
    const baseSnapshot = this._snapshotMovableJointValues();
    const baseResidual = this.lastLoopSolve?.residual ?? this._loopErrorNorm(this._loopResidual());
    const limit = this._dragFeasibleResidualLimit(baseResidual);
    const direct = this._attemptConstrainedDragValue(joint, targetValue, baseSnapshot);
    if (!this._activeSolverLoops().length || direct.residual <= limit) {
      this._restoreMovableJointValues(direct.snapshot);
      this.applyPose(joint);
      return true;
    }

    let lo = 0;
    let hi = 1;
    let best = null;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) * 0.5;
      const trial = this._attemptConstrainedDragValue(joint, startValue + (targetValue - startValue) * mid, baseSnapshot);
      if (trial.residual <= limit) { best = trial; lo = mid; }
      else hi = mid;
    }
    if (best) this._restoreMovableJointValues(best.snapshot);
    else this._restoreMovableJointValues(baseSnapshot);
    this.applyPose(joint);
    return !!best;
  }

  _incomingCouplingForJoint(joint) {
    if (!joint) return null;
    return (this.couplings || []).find(c => c && c.dependentJoint === joint.name) || null;
  }

  _resolveCommandJoint(joint, requestedValue) {
    // A MuJoCo equality/joint relation makes the dependent coordinate derived,
    // not independently editable. Resolve a request made on that visible part
    // back through its coupling chain to the upstream driver. This preserves the
    // selected joint's pivot for pointer dragging while still updating every
    // downstream gear, linkage and closed-loop member coherently.
    let current = joint;
    let value = Number(requestedValue) || 0;
    const seen = new Set();
    while (current?.dependent) {
      if (seen.has(current.name)) return null;
      seen.add(current.name);
      const coupling = this._incomingCouplingForJoint(current);
      const ratio = Number(coupling?.ratio);
      if (!coupling || !Number.isFinite(ratio) || Math.abs(ratio) < EPS) return null;
      value = (value - (Number(coupling.offset) || 0)) / ratio;
      current = this.joints?.[coupling.masterJoint] || null;
    }
    if (!current?.movable || current.role === 'loop') return null;
    return { joint: current, value: clamp(value, current.lower, current.upper) };
  }

  _isUserCommandableJoint(joint) {
    return !!this._resolveCommandJoint(joint, Number(joint?.value) || 0);
  }

  setJointValue(name, value) {
    const requested = typeof name === 'string' ? this.joints[name] : name;
    if (!requested || !requested.movable || requested.role === 'loop') return false;
    const resolved = this._resolveCommandJoint(requested, value);
    if (!resolved) return false;
    const commandJoint = resolved.joint;
    this._lastCommandJoint = commandJoint;
    if (this.isDraggingJoint && !this.isSolvingLoops) {
      // Keep activeJointForDrag as the visible joint selected by the user. The
      // solver receives the true upstream command joint and moves every passive
      // member needed to keep all equality/connect closures satisfied.
      this.activeJointForDrag = this.activeJointForDrag || requested;
      return this._applyConstrainedJointDrag(commandJoint, resolved.value);
    }
    this._setJointScalar(commandJoint, resolved.value);
    this.applyPose(commandJoint);
    return true;
  }

  applyPose(changedJoint = this._lastCommandJoint || null) {
    // One settled position transaction, analogous to MuJoCo's forward-position
    // stage: propagate qpos, project constraints, propagate final qpos, commit.
    this._poseTransactionDepth++;
    try {
      this._applyCouplings();
      this._refreshLinkMatrices();
      this._solveLoopClosures(changedJoint);
      this._applyCouplings();
      this._refreshLinkMatrices();
      this._lastStableSnapshot=this._snapshotMovableJointValues();
      this._lastPoseDiagnostics={
        residual:Number(this.lastLoopSolve?.residual)||0,
        converged:this.lastLoopSolve?.converged!==false,
        joint:changedJoint?.name||''
      };
    } finally {
      this._poseTransactionDepth=Math.max(0,this._poseTransactionDepth-1);
      if (!this._poseTransactionDepth) {
        this._poseVersion=(Number(this._poseVersion)||0)+1;
        this.userData.__automindPoseVersion=this._poseVersion;
        this.userData.__automindPoseDiagnostics=this._lastPoseDiagnostics;
        try { this.dispatchEvent?.({type:'posechange',model:this,joint:changedJoint||null,diagnostics:this._lastPoseDiagnostics}); } catch (_) {}
      }
    }
  }

  getManipulableJointForLinkName(linkName) {
    if (this.manipulableJointByLink.has(linkName)) return this.manipulableJointByLink.get(linkName);
    let cur = linkName;
    let guard = 0;
    const visited = new Set();
    while (cur && cur !== '__world__' && guard++ < 128 && !visited.has(cur)) {
      visited.add(cur);
      const chain = this.jointChainByLink.get(cur) || [this.parentJointByLink.get(cur)].filter(Boolean);
      // Preserve the local physical pivot whenever the selected component owns
      // a movable coordinate, even when that coordinate is equality-driven.
      for (const j of chain) {
        if (j?.movable && this._isUserCommandableJoint(j)) {
          this.manipulableJointByLink.set(linkName, j);
          return j;
        }
      }
      // Fixed pins/visual children inherit the nearest movable ancestor.
      const next = chain[0]?.parent || this.parentLinkByLink?.get(cur) || '';
      if (!next || next === cur) break;
      cur = next;
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
    if (j?.pivotGroup) {
      const q = new THREE.Quaternion();
      j.pivotGroup.getWorldQuaternion(q);
      axis.applyQuaternion(q);
    }
    return axis.normalize();
  }

  beginInteractiveDrag(joint = null) {
    this.isDraggingJoint = true;
    this.activeJointForDrag = joint || this.activeJointForDrag || null;
    this._lastCommandJoint = joint || this._lastCommandJoint;
  }

  endInteractiveDrag(joint = null) {
    this.pinnedSolverJointName = (joint || this.activeJointForDrag || null)?.name || '';
    this.activeJointForDrag = null;
    this.isDraggingJoint = false;
    this.applyPose(joint || this._lastCommandJoint || null);
    this.pinnedSolverJointName = '';
  }
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
      textures.set(name, {
        name,
        file,
        candidates: assetCandidates(file || name, texturedir),
        flipY: String(n.getAttribute('flipY') || '').trim().toLowerCase() !== 'false'
      });
    } else if (tag === 'material') {
      materials.set(name, {
        name,
        rgba: colorFromRgba(n.getAttribute('rgba')),
        texture: n.getAttribute('texture') || '',
        texrepeat: parseNums(n.getAttribute('texrepeat'), 2, 1),
        texturedir
      });
    }
  }
  for (const mat of materials.values()) {
    const tex = textures.get(mat.texture);
    mat.textureCandidates = tex?.candidates || (mat.texture ? assetCandidates(mat.texture, texturedir) : []);
    mat.flipY = tex?.flipY !== false;
  }
  return { meshes, textures, materials };
}
function isCollisionOnlyGeom(node) {
  const className = String(node?.getAttribute?.('class') || '').trim().toLowerCase();
  const name = String(node?.getAttribute?.('name') || '').trim().toLowerCase();
  const group = Number(node?.getAttribute?.('group'));
  // MJCF defaults are inherited by MuJoCo at compile time, but this lightweight
  // viewer parses the XML directly. Therefore class="collision" does NOT expose
  // group="3" on the raw node. Render only the visual copy: otherwise the
  // duplicate collision mesh sits exactly over the textured mesh and its missing
  // material appears as a black silhouette.
  return className.split(/\s+/).includes('collision') ||
    /^collision(?:[_:.-]|$)/.test(name) ||
    (group === 3 && /collision/.test(name));
}

async function addGeom(node, content, model, assets, raw, db, linkName) {
  if (isCollisionOnlyGeom(node)) return;
  const type = String(node.getAttribute('type') || 'sphere').toLowerCase();
  const materialName = node.getAttribute('material') || '';
  const material = await makeMaterial(assets.materials.get(materialName) || null, db, node);
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
    applyMaterial(root, material, linkName, meshDef.file || assetKey, model.assetToMeshes);
  } else {
    const mesh = primitiveMesh(node, material);
    mesh.userData.__linkName = linkName;
    mesh.userData.__assetKey = assetKey;
    visual.add(mesh);
    const arr = model.assetToMeshes.get(assetKey) || []; arr.push(mesh); model.assetToMeshes.set(assetKey, arr);
  }
}
function registerSite(model, node, bodyName) {
  const name = node.getAttribute('name') || `site_${Object.keys(model.sites || {}).length}`;
  // MJCF quaternions are w x y z; THREE uses x y z w.
  const p = parseVec(node.getAttribute('pos'), [0, 0, 0]);
  const qwxyz = parseQuat(node.getAttribute('quat'));
  const qxyzw = [qwxyz[1], qwxyz[2], qwxyz[3], qwxyz[0]];
  const localFrame = frameMatrix(p, qxyzw);
  model.sites[name] = {
    name,
    body: bodyName || '__world__',
    pos: p.slice(),
    quat: qxyzw.slice(),
    localFrame,
    type: String(node.getAttribute('type') || 'sphere').toLowerCase(),
    group: Number.isFinite(Number(node.getAttribute('group'))) ? Number(node.getAttribute('group')) : 0,
  };
  return model.sites[name];
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
    // qposIndex mirrors MuJoCo's generalized coordinate storage.
    qposIndex: model.qpos.length,
    directUserControl: true, independent: true
  };
  model.joints[name] = joint; model._allJoints.push(joint);
  model.qpos.push(0);
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
  // Record rigid-body ancestry independently from articulated joints. A body
  // without a <joint> is still attached to its parent and must remain
  // manipulable/closure-relevant through that parent.
  model.parentLinkByLink?.set(name, parentName || '__world__');
  // IMPORTANT: `bodyPose` is only the body's reference transform. A movable
  // body's actual link frame lives *after* its joint pivot/motion/inverse chain.
  // USD/URDF+ store currentMatrix after joint motion; keeping `bodyPose` here
  // left every MJCF solver frame frozen at q=0 while the meshes moved below it.
  // That was the root cause of the long orange residual lines and disconnected
  // closed-chain motion. `group` is reassigned to the post-joint frame below.
  const linkInfo = { name, group: bodyPose, renderGroup: bodyPose, currentMatrix: new THREE.Matrix4() };
  model._linkInfo[name] = linkInfo;

  let content = bodyPose;
  const bodyJoints = [];
  const jointNodes = Array.from(node.children || []).filter(n => ['joint', 'freejoint'].includes(localName(n)));
  for (const jn of jointNodes) {
    const r = registerJoint(model, jn, parentName, content);
    content = r.contentParent;
    bodyJoints.push(r.joint);
  }
  if (bodyJoints.length) {
    for (const joint of bodyJoints) {
      joint.child = name;
      joint.body1 = name;
    }
    // MJCF allows several scalar joints on one body. Preserve their complete
    // chain so closed-loop DLS can use every DOF rather than only the first one.
    model.jointChainByLink.set(name, bodyJoints);
    model.parentJointByLink.set(name, bodyJoints[0]);
  }
  // `content` is now the coordinate frame after all joint transforms. Use it
  // exclusively for solver/link matrices, while `model.links[name]` remains
  // `bodyPose` for selection and visual grouping.
  linkInfo.group = content;
  linkInfo.kinematicGroup = content;
  // Sites use this post-joint body coordinate frame. They may be invisible in
  // the XML, but equality/connect resolves them as real local kinematic frames.
  for (const site of childrenByName(node, 'site')) registerSite(model, site, name);
  for (const g of childrenByName(node, 'geom')) await addGeom(g, content, model, assets, raw, db, name);
  for (const child of childrenByName(node, 'body')) await parseBody(child, content, model, assets, raw, db, name, serial);
  return bodyPose;
}
function parseTendons(root, model) {
  const tendonRoot = firstChild(root, 'tendon');
  for (const n of Array.from(tendonRoot?.children || [])) {
    const kind = localName(n);
    const name = n.getAttribute('name') || `tendon_${Object.keys(model.tendons || {}).length}`;
    const joints = [];
    const sites = [];
    for (const child of Array.from(n.children || [])) {
      const childKind = localName(child);
      if (childKind === 'joint') {
        const joint = child.getAttribute('joint') || '';
        if (joint) joints.push({ name: joint, coef: numAttr(child, 'coef', 1) });
      } else if (childKind === 'site') {
        const site = child.getAttribute('site') || '';
        if (site) sites.push(site);
      }
    }
    const record = { name, kind, joints, sites, source: `tendon/${kind}` };
    model.tendons[name] = record;
    // A fixed tendon with multiple joints is an explicit linear coordinate
    // relationship in XML. A spatial tendon is rendered only as its authored
    // site route, never inferred from meshes or names.
    if (kind === 'fixed' && joints.length >= 2) {
      model.overlayCouplings.push({ ...record, kind: 'fixed_tendon', explicit: true });
    } else if (kind === 'spatial' && sites.length >= 2) {
      model.overlayCouplings.push({ ...record, kind: 'spatial_tendon', explicit: true });
    }
  }
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
      const c = { name: n.getAttribute('name') || `coupling_${model.couplings.length}`, type: 'linear', dependentJoint, masterJoint, offset: p[0] || 0, ratio: p[1] || 0, polycoef: p.slice(), source: 'equality/joint' };
      // Preserve the authored polynomial for visualization even when the lightweight
      // interaction solver uses its linear term only.
      model.overlayCouplings.push({
        name: c.name,
        kind: 'equality_joint',
        source: 'equality/joint',
        dependentJoint,
        masterJoint,
        polycoef: p.slice(),
        explicit: true
      });
      if (!valid) { model.solverHints.push({ ...c, reason: 'MJCF equality/joint references a non-exportable or multi-joint solver hint.' }); continue; }
      model.couplings.push(c);
      model.joints[dependentJoint].dependent = true;
      model.joints[dependentJoint].directUserControl = false;
      continue;
    }

    if (tag === 'tendon') {
      const tendon1 = n.getAttribute('tendon1') || '';
      const tendon2 = n.getAttribute('tendon2') || '';
      const p = parseNums(n.getAttribute('polycoef'), 5, 0);
      model.overlayCouplings.push({
        name: n.getAttribute('name') || `tendon_coupling_${model.overlayCouplings.length}`,
        kind: 'equality_tendon',
        source: 'equality/tendon',
        tendon1,
        tendon2,
        polycoef: p.slice(),
        explicit: true
      });
      continue;
    }

    if (tag !== 'connect' && tag !== 'weld') continue;
    const name = n.getAttribute('name') || `loop_${model.loopJoints.length}`;
    const site1Name = n.getAttribute('site1') || '';
    const site2Name = n.getAttribute('site2') || '';

    // MuJoCo 3.2+ supports equality/connect and equality/weld through pairs of
    // named sites. This is the syntax used by the physical closed-chain pivots
    // in the gripper. The previous viewer read only body1/body2/anchor, silently
    // skipped these constraints, and therefore broke an otherwise valid model.
    if (site1Name || site2Name) {
      const s0 = model.sites?.[site1Name];
      const s1 = model.sites?.[site2Name];
      if (!site1Name || !site2Name || !s0 || !s1) {
        model.solverHints.push({ name, type: tag, site1: site1Name, site2: site2Name, reason: 'MJCF equality site pair could not be resolved.' });
        continue;
      }
      const body0 = s0.body || '__world__';
      const body1 = s1.body || '__world__';
      if (!model._linkInfo[body0] || !model._linkInfo[body1] || !isPhysicalConnect(body0, body1, name)) continue;
      const relpose = parseNums(n.getAttribute('relpose'), 7, 0);
      const relposeQuat = relpose.slice(3, 7);
      model.loopJoints.push({
        name,
        type: tag,
        role: 'loop',
        tree: false,
        drawable: true,
        active: boolAttr(n, 'active', true),
        predecessor: body0,
        successor: body1,
        parent: body0,
        child: body1,
        body0,
        body1,
        source: 'site_pair',
        sitePair: true,
        site1: site1Name,
        site2: site2Name,
        anchor: [0, 0, 0],
        hasAnchor: false,
        relpose,
        hasRelpose: Math.hypot(...relposeQuat) > EPS,
        torquescale: numAttr(n, 'torquescale', 1),
        localPos0: null,
        localPos1: null,
        localQuat0: null,
        localQuat1: null,
        localFrame0: s0.localFrame.clone(),
        localFrame1: s1.localFrame.clone(),
        hasSuccessorOrigin: true
      });
      continue;
    }

    // Legacy/body-anchor form. An omitted body2 refers to the MuJoCo world body.
    const body0 = n.getAttribute('body1') || '';
    const body1 = n.getAttribute('body2') || '__world__';
    if (!model._linkInfo[body0] || !model._linkInfo[body1] || !isPhysicalConnect(body0, body1, name)) continue;

    const anchor = parseVec(n.getAttribute('anchor'), [0, 0, 0]);
    const relpose = parseNums(n.getAttribute('relpose'), 7, 0);
    const relposeQuat = relpose.slice(3, 7);
    const relposeQuatNorm = Math.hypot(...relposeQuat);
    model.loopJoints.push({
      name,
      type: tag,
      role: 'loop',
      tree: false,
      drawable: true,
      active: boolAttr(n, 'active', true),
      predecessor: body0,
      successor: body1,
      parent: body0,
      child: body1,
      body0,
      body1,
      source: 'body_anchor',
      sitePair: false,
      anchor,
      hasAnchor: n.hasAttribute('anchor'),
      relpose,
      hasRelpose: relposeQuatNorm > EPS,
      torquescale: numAttr(n, 'torquescale', 1),
      localPos0: null,
      localPos1: null,
      localQuat0: null,
      localQuat1: null,
      localFrame0: null,
      localFrame1: null,
      hasSuccessorOrigin: true
    });
  }
}

function frameMatrix(pos = [0, 0, 0], quat = [0, 0, 0, 1]) {
  const p = new THREE.Vector3(pos[0] || 0, pos[1] || 0, pos[2] || 0);
  const q = new THREE.Quaternion(quat[0] || 0, quat[1] || 0, quat[2] || 0, quat[3] ?? 1);
  if (q.lengthSq() < EPS) q.identity(); else q.normalize();
  return new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1));
}

function chooseConnectAnchorLocalFrame(model, loop, bodyA) {
  // Standard MJCF semantics: equality/connect anchor is body1-local. Some early
  // AutoMind BUILD170 exports accidentally wrote the CAD/world pivot directly
  // into anchor. Detect only the unmistakable case where treating it as local
  // throws the point well outside the whole assembled model while using it as a
  // world point lies inside the model. This preserves normal MJCF files and lets
  // legacy exports display correctly in the viewer.
  const authored = new THREE.Vector3(...(loop.anchor || [0, 0, 0]));
  const localFrame = frameMatrix([authored.x, authored.y, authored.z], [0, 0, 0, 1]);
  const worldAsLocal = bodyA.currentMatrix.clone().multiply(localFrame);
  const pAsLocal = new THREE.Vector3().setFromMatrixPosition(worldAsLocal);
  const pAsWorld = authored.clone();
  const bounds = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3(); bounds.getSize(size);
  const span = Math.max(size.x, size.y, size.z, 1e-4);
  const padded = bounds.clone().expandByScalar(Math.max(0.002, span * 0.20));
  const looksLegacyWorld = Number.isFinite(pAsWorld.x) && padded.containsPoint(pAsWorld) && !padded.containsPoint(pAsLocal);
  if (looksLegacyWorld) {
    const local = pAsWorld.applyMatrix4(bodyA.currentMatrix.clone().invert());
    loop.anchorFrame = 'legacy_world_corrected_for_viewer';
    loop.authoredAnchor = loop.anchor.slice();
    return frameMatrix([local.x, local.y, local.z], [0, 0, 0, 1]);
  }
  loop.anchorFrame = 'body1_local';
  return localFrame;
}

function storeLoopFrame(loop, side, matrix) {
  const p = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  matrix.decompose(p, q, scale);
  if (side === 0) {
    loop.localPos0 = [p.x, p.y, p.z];
    loop.localQuat0 = [q.x, q.y, q.z, q.w];
    loop.localFrame0 = matrix.clone();
  } else {
    loop.localPos1 = [p.x, p.y, p.z];
    loop.localQuat1 = [q.x, q.y, q.z, q.w];
    loop.localFrame1 = matrix.clone();
  }
}

function rebuildLoopRevoluteGroups(model) {
  const buckets = new Map();
  for (const loop of model.loopJoints || []) {
    if (!loop?.sitePair || !/^connect$/i.test(loop.type || '') || !loop.body0 || !loop.body1) continue;
    const key = [loop.body0, loop.body1].sort().join('\u0000');
    const list = buckets.get(key) || [];
    list.push(loop);
    buckets.set(key, list);
  }
  const groups = [];
  for (const constraints of buckets.values()) {
    if (constraints.length < 2) continue;
    const primary = constraints[0];
    const p0 = new THREE.Vector3().setFromMatrixPosition(primary.localFrame0 || new THREE.Matrix4());
    let secondary = null;
    let best = 0;
    for (let i = 1; i < constraints.length; i++) {
      const candidate = constraints[i];
      const p = new THREE.Vector3().setFromMatrixPosition(candidate.localFrame0 || new THREE.Matrix4());
      const d2 = p.distanceToSquared(p0);
      if (d2 > best) { best = d2; secondary = candidate; }
    }
    if (!secondary || best < 1e-16) continue;
    const p1 = new THREE.Vector3().setFromMatrixPosition(secondary.localFrame0 || new THREE.Matrix4());
    const q0 = new THREE.Vector3().setFromMatrixPosition(primary.localFrame1 || new THREE.Matrix4());
    const q1 = new THREE.Vector3().setFromMatrixPosition(secondary.localFrame1 || new THREE.Matrix4());
    const axis0 = p1.sub(p0).normalize();
    const axis1 = q1.sub(q0).normalize();
    if (axis0.lengthSq() < EPS || axis1.lengthSq() < EPS) continue;
    const group = {
      name: `revolute_loop:${primary.body0}<->${primary.body1}`,
      kind: 'revolute_loop',
      body0: primary.body0,
      body1: primary.body1,
      primary,
      secondary,
      constraints: constraints.slice(),
      axisLocal0: [axis0.x, axis0.y, axis0.z],
      axisLocal1: [axis1.x, axis1.y, axis1.z],
      drawable: true,
      active: constraints.some(c => c.active !== false),
    };
    for (const c of constraints) c.revoluteGroup = group.name;
    groups.push(group);
  }
  model.loopRevoluteGroups = groups;
}

function finalizeLoopAnchors(model) {
  model._refreshLinkMatrices();
  for (const loop of model.loopJoints || []) {
    const a = model._linkInfo?.[loop.body0];
    const b = model._linkInfo?.[loop.body1];
    if (!a || !b) continue;
    const invA = a.currentMatrix.clone().invert();
    const invB = b.currentMatrix.clone().invert();

    // Site-pair equalities already carry exact local frames. Do not derive a
    // fake anchor from body transforms: it would throw away the XML's loop data.
    if (loop.sitePair && loop.localFrame0 && loop.localFrame1) continue;

    if (/^connect$/i.test(loop.type || '')) {
      // equality/connect: anchor is authored in body1/body0's local frame. The
      // compiler derives body2's anchor from qpos0; reproduce that derivation.
      const localA = chooseConnectAnchorLocalFrame(model, loop, a);
      const worldAnchor = a.currentMatrix.clone().multiply(localA);
      const localB = invB.multiply(worldAnchor);
      storeLoopFrame(loop, 0, localA);
      storeLoopFrame(loop, 1, localB);
      continue;
    }

    // equality/weld: a zero relpose quaternion means "use the reference pose".
    // With explicit relpose, its position is the anchor in body1/body0 and its
    // quaternion is body2's orientation relative to body1. The anchor attribute
    // remains local to body2/body1.
    let localA;
    let localB;
    if (loop.hasRelpose) {
      const qWxyz = loop.relpose.slice(3, 7);
      const q = [qWxyz[1], qWxyz[2], qWxyz[3], qWxyz[0]];
      localA = frameMatrix(loop.relpose.slice(0, 3), q);
      localB = frameMatrix(loop.anchor, [0, 0, 0, 1]);
    } else {
      localB = frameMatrix(loop.anchor, [0, 0, 0, 1]);
      const worldAnchor = b.currentMatrix.clone().multiply(localB);
      const posA = invA.multiply(worldAnchor);
      // Align the body frames at the imported reference pose while retaining the
      // correct weld point. This is the same default-reference policy as MuJoCo.
      const qA = new THREE.Quaternion().setFromRotationMatrix(a.currentMatrix).invert();
      const qB = new THREE.Quaternion().setFromRotationMatrix(b.currentMatrix);
      const relative = qA.multiply(qB).normalize();
      const p = new THREE.Vector3();
      const ignoredQ = new THREE.Quaternion();
      const ignoredS = new THREE.Vector3();
      posA.decompose(p, ignoredQ, ignoredS);
      localA = frameMatrix([p.x, p.y, p.z], [relative.x, relative.y, relative.z, relative.w]);
    }
    storeLoopFrame(loop, 0, localA);
    storeLoopFrame(loop, 1, localB);
  }
  rebuildLoopRevoluteGroups(model);
  model._rebuildClosureCaches?.();
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
  model.userData.__automindBuild = 'MJCF BUILD220 — qpos transaction, closure projection and contextual axis validation';
  const assets = parseAssets(root, raw, db, meshdir, texturedir);
  const worldbody = firstChild(root, 'worldbody');
  if (!worldbody) throw new Error('MJCF has no <worldbody>.');
  const serial = { value: 0 };
  for (const body of childrenByName(worldbody, 'body')) await parseBody(body, model, model, assets, raw, db, '', serial);
  for (const site of childrenByName(worldbody, 'site')) registerSite(model, site, '__world__');
  for (const geom of childrenByName(worldbody, 'geom')) await addGeom(geom, model, model, assets, raw, db, 'world');
  parseTendons(root, model);
  parseEquality(root, model);
  finalizeLoopAnchors(model);
  parseActuators(root, model);
  model.applyPose();
  try {
    const report = { meshes: 0, textured: 0, canvasBacked: 0, blackFallbacks: 0, directMtlMaps: 0, unresolved: [], noUv: 0 };
    model.traverse?.((o) => {
      if (!o?.isMesh) return;
      report.meshes++;
      if (!o.geometry?.attributes?.uv) report.noUv++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        if (m.map) { report.textured++; if (m.map.userData?.__automindCanvasBacked) report.canvasBacked++; }
        if (m.userData?.__automindTextureBlackFallback) report.blackFallbacks++;
        if (m.userData?.__automindMtlDiffuseMap) report.directMtlMaps++;
        if (m.userData?.__automindTextureRequested && !m.userData?.__automindTextureResolved) report.unresolved.push(m.userData.__automindTextureRequested);
      }
    });
    window.AutoMindMJCFTextureReport = report;
    console.info('[AutoMind MJCF] Estado final de materiales:', report);
  } catch (_) {}
  await sleep(0);
  return model;
}

export default { loadMJCFModel, buildMJCFAssetDBFromOptions };
