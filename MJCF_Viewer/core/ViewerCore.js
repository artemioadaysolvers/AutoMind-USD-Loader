// /USD_Viewer/core/ViewerCore.js
import { THEME } from '../Theme.js';
// Three.js r132 compatible AutoMind viewer core (BUILD174 static grid + WebGL uniform safety).
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

function themeColorValue(value, fallback = 0xffffff) {
  if (typeof value === 'number' && Number.isFinite(value)) return value >>> 0;
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^#?[0-9a-fA-F]{6}$/.test(t)) return parseInt(t.replace('#', ''), 16) >>> 0;
    if (/^0x[0-9a-fA-F]{6}$/.test(t)) return parseInt(t.slice(2), 16) >>> 0;
  }
  return fallback >>> 0;
}
function themeVector3(arr, fallback = [0, 0, 0]) {
  const v = Array.isArray(arr) ? arr : fallback;
  return new THREE.Vector3(Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0);
}
function finiteNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function iterableUniformValue(v) {
  if (v == null) return null;
  if (ArrayBuffer.isView(v) || Array.isArray(v)) return v;
  try { if (typeof v[Symbol.iterator] === 'function') return v; } catch (_) {}
  if (v.isVector3 || (Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z))) {
    return new Float32Array([finiteNumber(v.x), finiteNumber(v.y), finiteNumber(v.z)]);
  }
  if (v.isColor || (Number.isFinite(v.r) && Number.isFinite(v.g) && Number.isFinite(v.b))) {
    return new Float32Array([finiteNumber(v.r), finiteNumber(v.g), finiteNumber(v.b)]);
  }
  // A malformed clipping or light object must never crash the entire WebGL frame.
  // Keep a valid vec3 fallback; all normal viewer values use the branches above.
  return new Float32Array([0, 0, 0]);
}

function installWebGLUniformSafety(renderer) {
  // Chromium WebGL2 throws when a third-party material accidentally sends a
  // Vector3/Color-like object to uniform3fv instead of a typed iterable.
  // Three r132 normally avoids this; this is a defensive compatibility layer for
  // Colab iframe contexts and cloned CAD/OBJ materials. It preserves valid arrays
  // verbatim and only normalizes malformed object values.
  const gl = renderer?.getContext?.();
  if (!gl || gl.__automindUniform3fvSafe) return;
  try {
    const original = gl.uniform3fv;
    if (typeof original !== 'function') return;
    gl.uniform3fv = function(location, value, ...tail) {
      let safe = value;
      try {
        const iterable = safe != null && (ArrayBuffer.isView(safe) || Array.isArray(safe) || typeof safe[Symbol.iterator] === 'function');
        if (!iterable) safe = iterableUniformValue(safe);
      } catch (_) { safe = iterableUniformValue(safe); }
      return original.call(this, location, safe, ...tail);
    };
    gl.__automindUniform3fvSafe = true;
  } catch (_) {
    // Some browser implementations expose a non-writable context method. In that
    // case the material sanitization path below still protects viewer-owned meshes.
  }
}

function sanitizeMaterialUniformState(mat) {
  if (!mat) return mat;
  try {
    if (mat.color && !mat.color.isColor) mat.color = new THREE.Color(mat.color);
    if (mat.emissive && !mat.emissive.isColor) mat.emissive = new THREE.Color(mat.emissive);
    if (mat.specular && !mat.specular.isColor) mat.specular = new THREE.Color(mat.specular);
    if (mat.normalScale && !mat.normalScale.isVector2) mat.normalScale = new THREE.Vector2(finiteNumber(mat.normalScale.x, 1), finiteNumber(mat.normalScale.y, 1));
    if (mat.clearcoatNormalScale && !mat.clearcoatNormalScale.isVector2) mat.clearcoatNormalScale = new THREE.Vector2(finiteNumber(mat.clearcoatNormalScale.x, 1), finiteNumber(mat.clearcoatNormalScale.y, 1));
    if (!Number.isFinite(mat.opacity)) mat.opacity = 1;
    if (mat.clippingPlanes && !Array.isArray(mat.clippingPlanes)) mat.clippingPlanes = null;
    mat.needsUpdate = true;
  } catch (_) {}
  return mat;
}

function sanitizeSceneMaterials(root) {
  root?.traverse?.((o) => {
    if (!o?.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(sanitizeMaterialUniformState);
  });
}

function installThemeLighting(scene) {
  const l = (THEME && THEME.lighting) || {};
  const ambCfg = l.ambient || { color: 0xffffff, intensity: 0.9 };
  const keyCfg = l.key || { color: 0xffffff, intensity: 0.75, position: [3, 5, 4] };
  const fillCfg = l.fill || { color: 0xffffff, intensity: 0.35, position: [-4, 2, -3] };

  const ambient = new THREE.AmbientLight(themeColorValue(ambCfg.color, 0xffffff), Number(ambCfg.intensity ?? 0.9));
  scene.add(ambient);

  const key = new THREE.DirectionalLight(themeColorValue(keyCfg.color, 0xffffff), Number(keyCfg.intensity ?? 0.75));
  key.position.copy(themeVector3(keyCfg.position, [3, 5, 4]));
  key.castShadow = true;
  scene.add(key);
  try {
    key.shadow.mapSize.width = 2048;
    key.shadow.mapSize.height = 2048;
    key.shadow.bias = -0.00015;
    key.shadow.normalBias = 0.02;
    scene.add(key.target);
  } catch (_) {}

  const fill = new THREE.DirectionalLight(themeColorValue(fillCfg.color, 0xffffff), Number(fillCfg.intensity ?? 0.35));
  fill.position.copy(themeVector3(fillCfg.position, [-4, 2, -3]));
  fill.castShadow = false;
  scene.add(fill);

  return { ambient, key, fill };
}


// BUILD134_PATCHED: mechanism policy copied from the good standalone USD_Viewer(4).html.
// The important part is not the UI, it is the interactive constrained drag:
// relaxed DLS, redundant-loop filtering, per-drag feasibility projection,
// and final pinning of the dragged joint so it does not snap back on release.
const PERF = {
  DLS_INTERACTIVE_MAX_ITER: 8,
  DLS_FINAL_MAX_ITER: 18,
  DLS_INTERACTIVE_MAX_VARS: 48,
  DLS_FINAL_MAX_VARS: 72,
  DLS_INTERACTIVE_MAX_CONSTRAINTS: 420,
  DLS_FINAL_MAX_CONSTRAINTS: 2000,
  DLS_INTERACTIVE_RELAXATION: 0.52,
  DLS_FINAL_RELAXATION: 0.72,
  DLS_INTERACTIVE_LAMBDA: 1.2e-2,
  DLS_FINAL_LAMBDA: 4e-3,
  DLS_INTERACTIVE_STOP_RESIDUAL: 2.5e-4,
  DLS_FINAL_STOP_RESIDUAL: 3.5e-5,
  DLS_IMPLICIT_WEIGHT_INTERACTIVE: 0.22,
  DLS_IMPLICIT_WEIGHT_FINAL: 0.45,
  DLS_EXPLICIT_LOOP_WEIGHT_INTERACTIVE: 0.72,
  DLS_EXPLICIT_LOOP_WEIGHT_FINAL: 0.82,
  DLS_DRAG_FEASIBLE_RESIDUAL: 1.5e-3,
  DLS_DRAG_FEASIBLE_RELATIVE: 2.75,
  DLS_DRAG_BINARY_STEPS: 8
};

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

function makeWorldGrid(size = 10, divisions = 200, visible = false) {
  // BUILD162: uniform finite CAD grid using the original teal grid color.
  // No special center axes, no edge pattern, no scaling artifacts.
  const safeSize = Math.max(1e-6, Number(size) || 10);
  let div = Math.max(8, Math.min(320, Math.floor(Number(divisions) || 80)));
  if (div % 2) div += 1;
  const half = safeSize * 0.5;
  const step = safeSize / div;
  const pts = [];
  for (let i = 0; i <= div; i++) {
    const v = -half + i * step;
    pts.push(-half, 0, v, half, 0, v);
    pts.push(v, 0, -half, v, 0, half);
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x14b8b9,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
    depthTest: true
  });
  const grid = new THREE.LineSegments(geom, mat);
  grid.name = 'AutoMindUniformGrid';
  grid.visible = !!visible;
  grid.frustumCulled = false;
  grid.renderOrder = -10;
  grid.userData.__gridSize = safeSize;
  grid.userData.__gridDivisions = div;
  return grid;
}

function disposeGrid(grid) {
  try { grid?.geometry?.dispose?.(); } catch (_) {}
  try {
    const mats = Array.isArray(grid?.material) ? grid.material : [grid?.material];
    mats.forEach(m => m?.dispose?.());
  } catch (_) {}
}
function niceGridCell(modelDim) {
  const raw = Math.max(Number(modelDim) || 1, 1e-6) / 24;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / p;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return Math.max(m * p, 1e-6);
}
function replaceGridIfNeeded(helpers, wantedSize, cellSize, center, floorY, force = false) {
  if (!helpers?.group) return;
  const size = Math.max(1e-6, Number(wantedSize) || 10);
  const cell = Math.max(1e-6, Number(cellSize) || (size / 200));
  let divisions = Math.max(16, Math.ceil(size / cell));
  if (divisions % 2) divisions += 1;
  divisions = Math.min(320, divisions);
  const oldSize = helpers.grid?.userData?.__gridSize || 0;
  const oldDiv = helpers.grid?.userData?.__gridDivisions || 0;
  const visible = !!helpers.grid?.visible;
  const mustReplace = force || !helpers.grid || size > oldSize * 1.18 || size < oldSize * 0.45 || Math.abs(divisions - oldDiv) > Math.max(12, oldDiv * 0.2);
  if (mustReplace) {
    const old = helpers.grid;
    const grid = makeWorldGrid(size, divisions, visible);
    if (old) helpers.group.remove(old);
    helpers.group.add(grid);
    disposeGrid(old);
    helpers.grid = grid;
    helpers.__gridWorldSize = size;
    helpers.__gridCellSize = cell;
  }
  try { helpers.grid.position.set(center.x, floorY, center.z); helpers.grid.frustumCulled = false; } catch (_) {}
}
function buildHelpers() {
  const group = new THREE.Group();
  // Real world-anchored grid. The helper is rebuilt with more divisions when the
  // camera sees a larger area, so the grid grows without scaling its cell spacing.
  // This prevents the visual bug where the model shrinks but the grid seems to keep
  // the same screen size, and it also prevents Orthographic half-grid clipping.
  const grid = makeWorldGrid(10, 200, false);
  group.add(grid);
  const groundMat = new THREE.ShadowMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.14,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.001;
  ground.visible = false;
  ground.frustumCulled = false;
  ground.receiveShadow = true;
  ground.castShadow = false;
  group.add(ground);
  const axes = new THREE.AxesHelper(1);
  axes.visible = false;
  axes.frustumCulled = false;
  group.add(axes);
  return { group, grid, ground, axes };
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
  // BUILD173: createViewer starts its animation loop before an MJCF/URDF/USD
  // object exists. THREE.Box3.setFromObject(null) throws inside Three.js when
  // it tries to read updateWorldMatrix. Bounds must therefore be a total,
  // non-throwing operation. We also avoid setFromObject recursion because a
  // partially-constructed loader tree can transiently contain null children.
  if (!object || typeof object !== 'object') return null;

  try { object.updateWorldMatrix?.(true, true); } catch (_) {}

  const box = new THREE.Box3();
  let hasGeometry = false;
  const seen = new Set();
  const stack = [object];

  while (stack.length) {
    const node = stack.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);

    try {
      if (node.isMesh || node.isLine || node.isPoints) {
        const geometry = node.geometry;
        if (geometry) {
          if (!geometry.boundingBox) geometry.computeBoundingBox?.();
          if (geometry.boundingBox && !geometry.boundingBox.isEmpty?.()) {
            const localBox = geometry.boundingBox.clone();
            localBox.applyMatrix4(node.matrixWorld);
            box.union(localBox);
            hasGeometry = true;
          }
        }
      }
    } catch (_) {
      // Ignore one incomplete visual node; other meshes still define the model.
    }

    const children = Array.isArray(node.children) ? node.children : [];
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (child && typeof child === 'object') stack.push(child);
    }
  }

  if (!hasGeometry || box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(Math.max(Number(pad) || 1, 1e-9));
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  return { box, center, size, maxDim };
}
function fitAndCenter(camera, controls, object, pad = 1.08) {
  const b = getObjectBounds(object, pad); if (!b) return false;
  const { center, maxDim } = b;
  if (camera.isPerspectiveCamera) {
    const fov = (camera.fov || 60) * Math.PI / 180;
    const dist = maxDim / Math.tan(Math.max(1e-6, fov / 2));
    camera.near = Math.max(maxDim / 1000, 0.001); camera.far = Math.max(maxDim * 100000, 10000000); camera.updateProjectionMatrix();
    let dir = camera.position.clone().sub(controls.target || new THREE.Vector3());
    if (!isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-10) dir.set(1, 0.7, 1);
    dir.normalize(); camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  } else {
    const aspect = Math.max(1e-6, (controls?.domElement?.clientWidth || 1) / (controls?.domElement?.clientHeight || 1));
    const span = Math.max(maxDim, 5 * Math.SQRT2);
    camera.left = -span * aspect; camera.right = span * aspect; camera.top = span; camera.bottom = -span;
    camera.near = Math.max(maxDim / 1000, 0.001); camera.far = Math.max(maxDim * 100000, 10000000); camera.updateProjectionMatrix();
    camera.position.copy(center.clone().add(new THREE.Vector3(maxDim, maxDim * 0.9, maxDim)));
  }
  controls.target.copy(center); controls.update(); return true;
}
function reasonableGridSpan(modelDim, cell) {
  const dim = Math.max(Number(modelDim) || 1, 1e-9);
  const c = Math.max(Number(cell) || niceGridCell(dim), 1e-9);
  // A finite CAD grid: large enough to give context around the model, but it never
  // expands just because the camera zooms out. This prevents the grid from turning
  // into an infinite sheet and keeps its size proportional to the CAD.
  return Math.max(dim * 8.0, c * 56.0);
}

function resizeSceneHelpersForObject(helpers, object) {
  // This runs once, immediately after a valid model has loaded. It deliberately
  // freezes the grid/ground transform in world coordinates. Never recalculate it
  // from posed joint bounds: an opening gripper changes its bounding box but must
  // not move, grow, or re-centre the CAD grid.
  if (!helpers || helpers.__gridFrozen || !object) return false;
  const b = getObjectBounds(object, 1.0);
  if (!b) return false;
  const center = b.center || b.box.getCenter(new THREE.Vector3());
  const floorY = Number.isFinite(b.box?.min?.y) ? b.box.min.y : 0;
  const modelDim = Math.max(b.maxDim || 1, 1e-9);
  const cell = niceGridCell(modelDim);
  const span = reasonableGridSpan(modelDim, cell);
  helpers.__gridCellSize = cell;
  helpers.__gridBaseCenter = center.clone();
  helpers.__gridBaseFloorY = floorY;
  helpers.__gridStatic = true;
  helpers.__gridStaticModelDim = modelDim;
  replaceGridIfNeeded(helpers, span, cell, center, floorY, true);
  try {
    helpers.grid.position.set(center.x, floorY, center.z);
    helpers.ground.scale.setScalar((span * 1.35) / 200);
    helpers.ground.position.set(center.x, floorY - modelDim * 1e-3, center.z);
    helpers.ground.frustumCulled = false;
  } catch (_) {}
  try { helpers.axes.scale.setScalar(Math.max(modelDim * 0.35, cell * 8)); helpers.axes.frustumCulled = false; } catch (_) {}
  // Freeze exact local/world transforms. From now on no camera operation or
  // articulated pose can recenter, rescale or translate the world reference.
  try {
    helpers.group.updateMatrixWorld(true);
    helpers.grid.updateMatrix(); helpers.grid.updateMatrixWorld(true);
    helpers.ground.updateMatrix(); helpers.ground.updateMatrixWorld(true);
    helpers.__gridFrozenMatrix = helpers.grid.matrix.clone();
    helpers.__gridFrozenWorldMatrix = helpers.grid.matrixWorld.clone();
    helpers.__groundFrozenMatrix = helpers.ground.matrix.clone();
    helpers.__groundFrozenWorldMatrix = helpers.ground.matrixWorld.clone();
    helpers.grid.matrixAutoUpdate = false;
    helpers.ground.matrixAutoUpdate = false;
  } catch (_) {}
  helpers.__gridFrozen = true;
  helpers.__groundFrozen = true;
  return true;
}


function configureSceneShadowsForObject(root, helpers, keyLight) {
  if (!root || !helpers || !keyLight) return;
  const b = getObjectBounds(root, 1.05);
  if (!b) return;
  // Once a model is loaded, helpers use the original CAD frame rather than the
  // changing articulated bounds. Toggling shadows must not relocate the ground.
  const center = helpers.__gridFrozen && helpers.__gridBaseCenter
    ? helpers.__gridBaseCenter.clone()
    : (b.center || b.box.getCenter(new THREE.Vector3()));
  const dim = Math.max((helpers.__gridFrozen ? helpers.__gridStaticModelDim : b.maxDim) || 1, 1e-6);
  const floorY = helpers.__gridFrozen && Number.isFinite(helpers.__gridBaseFloorY)
    ? helpers.__gridBaseFloorY
    : (Number.isFinite(b.box?.min?.y) ? b.box.min.y : center.y - dim * 0.5);
  try {
    helpers.ground.position.set(center.x, floorY - dim * 1e-3, center.z);
    helpers.ground.scale.setScalar((Math.max(helpers.__gridWorldSize || dim * 8, dim * 4) * 1.35) / 200);
    helpers.ground.receiveShadow = true;
    helpers.ground.castShadow = false;
    const gmats = Array.isArray(helpers.ground.material) ? helpers.ground.material : [helpers.ground.material];
    gmats.forEach(m => { if (m) { m.needsUpdate = true; } });
  } catch (_) {}
  try {
    keyLight.target.position.copy(center);
    keyLight.position.copy(center.clone().add(new THREE.Vector3(dim * 2.1, dim * 3.0, dim * 2.4)));
    keyLight.updateMatrixWorld(true);
    keyLight.target.updateMatrixWorld(true);
    const cam = keyLight.shadow.camera;
    const gridSpan = Math.max(helpers.__gridWorldSize || dim * 8, dim * 8, 1.0);
    const r = Math.max(dim * 2.2, gridSpan * 0.75, 1.0);
    cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r;
    cam.near = 0.001;
    cam.far = Math.max(dim * 8.0, gridSpan * 4.0, 10.0);
    cam.updateProjectionMatrix();
  } catch (_) {}
  try {
    root.traverse(o => {
      if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) {
        o.castShadow = true;
        o.receiveShadow = true;
      }
    });
  } catch (_) {}
}

function keepOrthographicDepthSafe(camera, controls, helpers) {
  if (!camera?.isOrthographicCamera) return;
  // Use the immutable model span captured at load time. Do not reposition the
  // camera every frame from animated joint bounds; in orthographic view that made
  // the grid look as if it was reacting to gripper volume changes.
  const modelDim = Math.max(helpers?.__gridStaticModelDim || 1, 1e-9);
  const gridSize = Math.max(helpers?.__gridWorldSize || reasonableGridSpan(modelDim, helpers?.__gridCellSize), modelDim);
  const w = Math.abs((camera.right || 1) - (camera.left || -1)) / Math.max(camera.zoom || 1, 1e-6);
  const h = Math.abs((camera.top || 1) - (camera.bottom || -1)) / Math.max(camera.zoom || 1, 1e-6);
  const safe = Math.max(gridSize, w, h, 1) * 8;
  let changed = false;
  if (camera.near > -safe) { camera.near = -safe; changed = true; }
  if (camera.far < safe) { camera.far = safe; changed = true; }
  if (changed) camera.updateProjectionMatrix();
}

function keepGridInfiniteForView(helpers, camera, controls, object) {
  // BUILD174: a CAD grid is a fixed world reference, not a camera helper and not
  // an articulated-model helper. Its position, scale and matrix are assigned once
  // during refreshRobotContext() and are never readjusted in animation, resize,
  // zoom, selection or joint-motion code.
  if (!helpers?.grid) return;
  try {
    helpers.grid.frustumCulled = false;
    helpers.ground.frustumCulled = false;
    if (helpers.__gridFrozen && helpers.__gridFrozenMatrix) {
      helpers.grid.matrixAutoUpdate = false;
      helpers.grid.matrix.copy(helpers.__gridFrozenMatrix);
      helpers.grid.matrixWorld.copy(helpers.__gridFrozenWorldMatrix || helpers.__gridFrozenMatrix);
    }
    if (helpers.__groundFrozen && helpers.__groundFrozenMatrix) {
      helpers.ground.matrixAutoUpdate = false;
      helpers.ground.matrix.copy(helpers.__groundFrozenMatrix);
      helpers.ground.matrixWorld.copy(helpers.__groundFrozenWorldMatrix || helpers.__groundFrozenMatrix);
    }
  } catch (_) {}
}



/**
 * Minimal CAD TrackballControls.
 * - True 360° rotation, no OrbitControls polar clamp.
 * - Right button pans in CAD/object-follow direction: drag right => model moves right.
 * - Smooth inertia for rotate/pan/zoom.
 */
class TrackballControls {
  constructor(object, domElement) {
    this.object = object;
    this.domElement = domElement;
    this.enabled = true;
    this.rotateSpeed = 4.0;
    this.zoomSpeed = 1.2;
    this.panSpeed = 0.8;
    this.staticMoving = false;
    this.dynamicDampingFactor = 0.15;
    this.target = new THREE.Vector3();
    this._state = 0;
    this._rect = null;
    this._start = new THREE.Vector2();
    this._end = new THREE.Vector2();
    this._pointerId = null;
    this._lastAxis = new THREE.Vector3(1, 0, 0);
    this._lastAngle = 0;
    this._lastPan = new THREE.Vector3(0, 0, 0);
    this._lastDolly = 0;

    this._onContextMenu = (e) => e.preventDefault();
    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this._dolly(-(e.deltaY || 0));
      this.update();
    };
    this._onPointerDown = (e) => {
      if (!this.enabled) return;
      if (this._pointerId !== null) return;
      this._pointerId = e.pointerId;
      this._state = (e.button === 0) ? 1 : (e.button === 1) ? 2 : 3;
      this._start.set(e.clientX, e.clientY);
      this._end.copy(this._start);
      this._lastAngle = 0;
      this._lastPan.set(0, 0, 0);
      this._lastDolly = 0;
      try { this.domElement.setPointerCapture(e.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._onPointerMove, true);
      window.addEventListener('pointerup', this._onPointerUp, true);
    };
    this._onPointerMove = (e) => {
      if (!this.enabled || this._pointerId !== e.pointerId) return;
      this._end.set(e.clientX, e.clientY);
      if (this._state === 1) this._rotate(this._start, this._end);
      else if (this._state === 2) this._dolly(-(this._end.y - this._start.y) * 4);
      else if (this._state === 3) this._pan(this._start, this._end);
      this._start.copy(this._end);
      this.update();
    };
    this._onPointerUp = (e) => {
      if (this._pointerId !== e.pointerId) return;
      this._pointerId = null;
      this._state = 0;
      window.removeEventListener('pointermove', this._onPointerMove, true);
      window.removeEventListener('pointerup', this._onPointerUp, true);
      try { this.domElement.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    this.domElement.addEventListener('contextmenu', this._onContextMenu);
    this.domElement.addEventListener('wheel', this._onWheel, { passive: false });
    this.domElement.addEventListener('pointerdown', this._onPointerDown, true);
  }
  dispose() {
    this.domElement.removeEventListener('contextmenu', this._onContextMenu);
    this.domElement.removeEventListener('wheel', this._onWheel);
    this.domElement.removeEventListener('pointerdown', this._onPointerDown, true);
    window.removeEventListener('pointermove', this._onPointerMove, true);
    window.removeEventListener('pointerup', this._onPointerUp, true);
  }
  handleResize() { this._rect = this.domElement.getBoundingClientRect(); }
  update() {
    if (!this.staticMoving && this._state === 0) {
      if (Math.abs(this._lastAngle) > 1e-6) {
        this._applyRotation(this._lastAxis, this._lastAngle);
        this._lastAngle *= (1.0 - this.dynamicDampingFactor);
        if (Math.abs(this._lastAngle) < 1e-6) this._lastAngle = 0;
      }
      if (this._lastPan.lengthSq() > 1e-12) {
        this.object.position.add(this._lastPan);
        this.target.add(this._lastPan);
        this._lastPan.multiplyScalar(1.0 - this.dynamicDampingFactor);
        if (this._lastPan.lengthSq() < 1e-12) this._lastPan.set(0, 0, 0);
      }
      if (Math.abs(this._lastDolly) > 1e-6) {
        this._dolly(this._lastDolly);
        this._lastDolly *= (1.0 - this.dynamicDampingFactor);
        if (Math.abs(this._lastDolly) < 1e-6) this._lastDolly = 0;
      }
    }
    this.object.lookAt(this.target);
  }
  _getRect() { if (!this._rect) this.handleResize(); return this._rect; }
  _getNDC(clientX, clientY) {
    const r = this._getRect();
    const x = (clientX - r.left) / Math.max(1, r.width);
    const y = (clientY - r.top) / Math.max(1, r.height);
    return new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
  }
  _projectOnSphere(ndc) {
    const v = new THREE.Vector3(ndc.x, ndc.y, 0);
    const d2 = v.x * v.x + v.y * v.y;
    if (d2 <= 1.0) v.z = Math.sqrt(1.0 - d2);
    else { v.normalize(); v.z = 0.0; }
    return v;
  }
  _applyRotation(axisWorld, angle) {
    const q = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
    const eye = this.object.position.clone().sub(this.target);
    eye.applyQuaternion(q);
    this.object.up.applyQuaternion(q);
    this.object.position.copy(this.target.clone().add(eye));
  }
  _rotate(startPx, endPx) {
    const a = this._projectOnSphere(this._getNDC(startPx.x, startPx.y));
    const b = this._projectOnSphere(this._getNDC(endPx.x, endPx.y));
    const axisCam = new THREE.Vector3().crossVectors(a, b);
    const axisLen = axisCam.length();
    if (axisLen < 1e-8) return;
    axisCam.normalize();
    const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
    let angle = -Math.acos(dot) * this.rotateSpeed;
    const axisWorld = axisCam.clone().applyQuaternion(this.object.quaternion).normalize();
    this._applyRotation(axisWorld, angle);
    this._lastAxis.copy(axisWorld);
    this._lastAngle = angle;
  }
  _dolly(delta) {
    const zoomFactor = Math.pow(0.95, (delta * this.zoomSpeed) * 0.01);
    if (this.object.isPerspectiveCamera) {
      const eye = this.object.position.clone().sub(this.target);
      eye.setLength(Math.max(1e-6, eye.length() * zoomFactor));
      this.object.position.copy(this.target.clone().add(eye));
    } else if (this.object.isOrthographicCamera) {
      this.object.zoom = Math.max(1e-3, this.object.zoom / zoomFactor);
      this.object.updateProjectionMatrix();
    }
    this._lastDolly = delta;
  }
  _pan(startPx, endPx) {
    const r = this._getRect();
    const dx = endPx.x - startPx.x;
    const dy = endPx.y - startPx.y;
    const h = Math.max(1, r.height);
    let scale = 1.0;
    if (this.object.isPerspectiveCamera) {
      const eye = this.object.position.clone().sub(this.target);
      const dist = eye.length();
      const fov = (this.object.fov || 60) * Math.PI / 180;
      scale = 2 * dist * Math.tan(fov / 2) / h;
    } else if (this.object.isOrthographicCamera) {
      scale = (this.object.top - this.object.bottom) / (Math.max(this.object.zoom || 1, 1e-6) * h);
    }
    // Intentional CAD direction: drag right => visual model moves right.
    const panX = -dx * scale * this.panSpeed;
    const panY =  dy * scale * this.panSpeed;
    const te = this.object.matrix.elements;
    const xAxis = new THREE.Vector3(te[0], te[1], te[2]);
    const yAxis = new THREE.Vector3(te[4], te[5], te[6]);
    const pan = xAxis.multiplyScalar(panX).add(yAxis.multiplyScalar(panY));
    this.object.position.add(pan);
    this.target.add(pan);
    this._lastPan.copy(pan);
  }
}

function axisFromToken(t) { if (t === 'X') return new THREE.Vector3(1, 0, 0); if (t === 'Y') return new THREE.Vector3(0, 1, 0); return new THREE.Vector3(0, 0, 1); }
function jointAxisLocal(j) {
  if (j?.axisWorldMeta && j.axisWorldMeta.length === 3 && j.userData?.__model && j.body0) {
    const model = j.userData.__model;
    const parent = model._linkInfo?.[j.body0];
    const frame = (parent ? parent.currentMatrix.clone() : new THREE.Matrix4()).multiply(j._localFrame0 || matrixFromPosQuat(j.localPos0 || [0,0,0], j.localRot0 || new THREE.Quaternion()));
    const q = new THREE.Quaternion().setFromRotationMatrix(frame).invert();
    const a = new THREE.Vector3(...j.axisWorldMeta).applyQuaternion(q).normalize();
    if (a.lengthSq() > EPS) return a;
  }
  if (j.axisJoint && j.axisJoint.length === 3) {
    const a = new THREE.Vector3(...j.axisJoint); if (a.lengthSq() > EPS) return a.normalize();
  }
  return axisFromToken(j.axisToken || 'Z');
}
function isMovableJoint(j) { return isMovableFull(j); }
function motionMatrix(j) {
  const axis = jointAxisLocal(j);
  if (!isMovableJoint(j)) return new THREE.Matrix4();
  if (/prismatic/i.test(j.jointType)) return new THREE.Matrix4().makeTranslation(axis.x * j.position, axis.y * j.position, axis.z * j.position);
  return new THREE.Matrix4().makeRotationAxis(axis, j.angle);
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
    this.singleDriverJoint = null;
    this.closureAffectingJointNames = new Set();
    this.manipulableJointByLink = new Map();
    this.isDraggingJoint = false;
    this.isSolvingLoops = false;
    this.lastLoopSolve = null;
    this.activeJointForDrag = null;
    this.pinnedSolverJointName = '';
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
  getManipulableJointForLinkName(linkName) { return getManipulableJointForLinkName(this, linkName); }
  getJointWorldPivot(j) { return getJointWorldPivot(this, j); }
  getJointWorldAxis(j) { return getJointWorldAxis(this, j); }
  beginInteractiveDrag(joint = null) {
    this.isDraggingJoint = true;
    this.activeJointForDrag = joint || this.activeJointForDrag || null;
  }
  endInteractiveDrag(joint = null) {
    const pinned = (joint || this.activeJointForDrag || null)?.name || '';
    this.pinnedSolverJointName = pinned;
    this.activeJointForDrag = null;
    this.isDraggingJoint = false;
    solvePoseForCurrentValues(this, true);
    this.pinnedSolverJointName = '';
  }
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
    const materialBodies = [directBody(linkBlock.body)];
    for (const ab of ancestors) {
      if (ab.type === 'Xform') composed.multiply(parseMatrix(directBody(ab.body)));
      materialBodies.push(directBody(ab.body));
    }
    materialBodies.push(directBody(mb.body));
    mb._composedLocalMatrix = composed.multiply(parseMatrix(directBody(mb.body)));
    // Material bindings and texture hints are frequently authored on an ancestor
    // Xform (Visual/Geom/Part) instead of directly on the Mesh prim. Preserve an
    // effective body so materials/textures are inherited exactly in the viewer and
    // therefore also in component thumbnails.
    mb._effectiveMaterialBody = materialBodies.join('\n');
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
  const materialBody = block._effectiveMaterialBody || block.body;
  const colorNums0 = parseNums(match1(materialBody, /primvars:displayColor\s*=\s*\[\(([^\)]*)\)\]/s, '0.72 0.76 0.8'));
  const colorNums = findColorInMeshBody(materialBody, model, colorNums0);
  const color = new THREE.Color(colorNums[0] ?? 0.72, colorNums[1] ?? 0.76, colorNums[2] ?? 0.8);
  const texPath = findTexturePathInMeshBody(materialBody, model);
  const tex = textureFromAssetDB(assetDB, texPath, info.name);
  const mat = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : color, map: tex || null, roughness: 0.62, metalness: 0.05, side: THREE.DoubleSide });
  if (tex) { mat.needsUpdate = true; }
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
  j.schema = schema; j.role = role; j.type = motionType; j.originalType = parseStringAttr(body, 'automind:originalType', '');
  j.body0 = parseStringAttr(body, 'automind:parentLink', localNameFromPath(body0Path));
  j.body1 = parseStringAttr(body, 'automind:childLink', localNameFromPath(body1Path));
  j.parentLink = j.body0; j.childLink = j.body1;
  j.localPos0 = parseVecAttr(body, 'physics:localPos0'); j.localRot0 = parseQuatAttr(body, 'physics:localRot0');
  j.localPos1 = parseVecAttr(body, 'physics:localPos1'); j.localRot1 = parseQuatAttr(body, 'physics:localRot1');
  j.axisToken = parseStringAttr(body, 'physics:axis', 'Z');
  j.axisJoint = parseVecAttr(body, 'automind:axisJoint', null);
  j.axisSuccessor = parseVecAttr(body, 'automind:axisSuccessor', null);
  j.axisWorldMeta = parseVecAttr(body, 'automind:axisWorld', null);
  j.axis = jointAxisLocal(j);
  j.lowerRad = Number.isFinite(lowerRad) ? lowerRad : -Math.PI;
  j.upperRad = Number.isFinite(upperRad) ? upperRad : Math.PI;
  j.lowerLimit = Number.isFinite(lowerLimit) ? lowerLimit : j.lowerRad;
  j.upperLimit = Number.isFinite(upperLimit) ? upperLimit : j.upperRad;
  j.limit = { lower: j.lowerLimit, upper: j.upperLimit };
  j.angle = 0; j.position = 0; j.value = 0; j.inputValue = 0;
  j.mimicJoint = parseStringAttr(body, 'automind:mimicJoint', '');
  j.mimicMultiplier = parseNumAttr(body, 'automind:mimicMultiplier', 1);
  j.mimicOffset = parseNumAttr(body, 'automind:mimicOffset', 0);
  j.independent = parseStringAttr(body, 'automind:independent', '');
  j.authority = parseStringAttr(body, 'automind:kinematicAuthority', '');
  j.source = parseStringAttr(body, 'automind:source', '');
  j.evidence = parseStringAttr(body, 'automind:evidence', '');
  j.implicitMotionCandidate = parseBoolAttr(body, 'automind:implicitMotionCandidate', false);
  j.requiresReview = parseBoolAttr(body, 'automind:requiresReview', false);
  j.kinematicRole = parseStringAttr(body, 'automind:kinematicRole', '');
  j.exportedMovable = parseBoolAttr(body, 'automind:movable', isMovableJoint(j));
  j.viewerControllable = parseBoolAttr(body, 'automind:viewerControllable', isMovableJoint(j) && role !== 'loop');
  j._localFrame0 = matrixFromPosQuat(j.localPos0, j.localRot0);
  j._localFrame1 = matrixFromPosQuat(j.localPos1, j.localRot1);
  j._localFrame1Inv = j._localFrame1.clone().invert();
  j.userData.__isUSDJoint = true;
  j.userData.__joint = j;
  j.userData.__model = model;
  j.axis = jointAxisLocal(j);
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
  return {
    name: block.name,
    type: parseStringAttr(body, 'automind:type', 'linear'),
    masterJoint: parseStringAttr(body, 'automind:masterJoint', ''),
    dependentJoint: parseStringAttr(body, 'automind:dependentJoint', ''),
    ratio: parseNumAttr(body, 'automind:ratio', 1),
    offset: parseNumAttr(body, 'automind:offset', 0),
  };
}

function splitJointNames(s) { return String(s || '').split(/\s+/).map(x => x.trim()).filter(Boolean); }
function parseCouplingBlockFull(block) {
  const body = directBody(block.body);
  const c = parseCouplingBlock(block);
  c.masterJoints = splitJointNames(c.masterJoint);
  c.dependentJoints = splitJointNames(c.dependentJoint);
  c.masterLink = parseStringAttr(body, 'automind:masterLink', '');
  c.dependentLink = parseStringAttr(body, 'automind:dependentLink', '');
  c.solver = parseStringAttr(body, 'automind:solver', '');
  c.mode = parseStringAttr(body, 'automind:mode', '');
  c.source = parseStringAttr(body, 'automind:source', '');
  c.evidence = parseStringAttr(body, 'automind:evidence', '');
  return c;
}
function parseImplicitCandidateBlock(block) {
  const body = directBody(block.body);
  return {
    name: block.name,
    pair: parseStringAttr(body, 'automind:pair', ''),
    linkA: parseStringAttr(body, 'automind:linkA', ''),
    linkB: parseStringAttr(body, 'automind:linkB', ''),
    rank: parseNumAttr(body, 'automind:rank', 0),
    freeDof: parseNumAttr(body, 'automind:freeDof', 0),
    axisLike: parseNumAttr(body, 'automind:axisLike', 0),
    planar: parseNumAttr(body, 'automind:planar', 0),
    hasAxisPoint: parseBoolAttr(body, 'automind:hasAxisPoint', false),
    axisWorld: parseVecAttr(body, 'automind:axisWorld', [0,0,1]),
    axisPointWorld: parseVecAttr(body, 'automind:axisPointWorld', [0,0,0]),
    exportedJoint: parseStringAttr(body, 'automind:exportedJoint', ''),
    exportedRole: parseStringAttr(body, 'automind:exportedRole', ''),
    activeForViewerClosure: parseBoolAttr(body, 'automind:activeForViewerClosure', false),
    solver: parseStringAttr(body, 'automind:solver', ''),
    evidence: parseStringAttr(body, 'automind:evidence', ''),
    reason: parseStringAttr(body, 'automind:reason', ''),
    localPointA: null, localPointB: null, localAxisA: null, localAxisB: null,
  };
}
function buildMaterialMaps(blocks) {
  const texByPath = new Map(), colorByPath = new Map();
  const imgRe = /@([^@]+\.(?:png|jpg|jpeg|webp|gif|bmp|svg))@/ig;
  for (const b of blocks) {
    if (!/^(Material|Shader)$/.test(b.type)) continue;
    const body = String(b.body || '');
    let m = imgRe.exec(body);
    if (m) {
      const val = m[1];
      texByPath.set(b.path, val); texByPath.set('/' + b.name, val); texByPath.set(b.name, val);
    }
    const dc = parseVecAttr(body, 'inputs:diffuseColor', null) || parseVecAttr(body, 'primvars:displayColor', null);
    if (dc && dc.length >= 3) {
      colorByPath.set(b.path, dc); colorByPath.set('/' + b.name, dc); colorByPath.set(b.name, dc);
    }
  }
  // If Material contains nested Shader, parent body contains the asset path because findDefBlocks preserves nested body.
  for (const b of blocks.filter(x => x.type === 'Material')) {
    const body = String(b.body || '');
    imgRe.lastIndex = 0;
    const m = imgRe.exec(body);
    if (m) { texByPath.set(b.path, m[1]); texByPath.set('/' + b.name, m[1]); texByPath.set(b.name, m[1]); }
    const dc = parseVecAttr(body, 'inputs:diffuseColor', null) || parseVecAttr(body, 'primvars:displayColor', null);
    if (dc && dc.length >= 3) { colorByPath.set(b.path, dc); colorByPath.set('/' + b.name, dc); colorByPath.set(b.name, dc); }
  }
  return { texByPath, colorByPath };
}
function getPathMapValue(map, path) {
  if (!map || !path) return null;
  const raw = String(path || '');
  const base = basename(raw);
  const variants = [raw, '/' + raw.replace(/^\/+/, ''), base, '/' + base];
  for (const v of variants) {
    if (map.has(v)) return map.get(v);
  }
  const clean = raw.toLowerCase().replace(/^\/+/, '');
  const cleanBase = base.toLowerCase();
  for (const [k, v] of map.entries()) {
    const kk = String(k || '').toLowerCase().replace(/^\/+/, '');
    const kb = basename(kk).toLowerCase();
    if (kk === clean || kb === cleanBase || kk.endsWith('/' + clean) || clean.endsWith('/' + kk)) return v;
  }
  return null;
}
function materialBindingPath(body) {
  return match1(body, /rel\s+material:binding\s*=\s*<([^>]+)>/) || match1(body, /rel\s+material:binding\s*=\s*\[\s*<([^>]+)>/);
}
function findTexturePathInMeshBody(body, model) {
  const txt = String(body || '');
  let p = parseStringAttr(txt, 'automind:textureFile', '') || match1(txt, /asset\s+inputs:file\s*=\s*@([^@]+)@/s, '');
  if (p) return p;
  const bind = materialBindingPath(txt);
  if (bind) {
    p = getPathMapValue(model?._materialTextures, bind);
    if (p) return p;
  }
  p = match1(txt, /@([^@]+\.(?:png|jpg|jpeg|webp|gif|bmp|svg))@/is, '');
  return p || '';
}
function findColorInMeshBody(body, model, fallbackColorNums) {
  const bind = materialBindingPath(body);
  const c = bind ? getPathMapValue(model?._materialColors, bind) : null;
  if (c && c.length >= 3) return c;
  return fallbackColorNums;
}
function textureFromAssetDB(assetDB, texPath, meshName='') {
  if (!texPath || !assetDB?.get) return null;
  const tries = [texPath, basename(texPath), String(texPath).replace(/^\.\//,''), String(texPath).replace(/^\.\.\//,'')];
  let data = '';
  for (const t of tries) { data = assetDB.get(t); if (data) break; }
  if (!data) return null;
  const tex = new THREE.TextureLoader().load(data, () => { try { tex.needsUpdate = true; } catch (_) {} });
  tex.wrapS = THREE.ClampToEdgeWrapping; tex.wrapT = THREE.ClampToEdgeWrapping;
  if ('colorSpace' in tex && THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
  if ('encoding' in tex && THREE.sRGBEncoding) tex.encoding = THREE.sRGBEncoding;
  tex.name = basename(texPath) || meshName || 'usd_texture';
  tex.needsUpdate = true;
  return tex;
}
function buildKinematicTree(model, allJoints) {
  model._allJoints = allJoints || [];
  model.loopJoints = [];
  model.joints = {};
  const infoByName = model._linkInfo;
  Object.values(infoByName).forEach(l => { l.children = []; l.parentJoint = null; l.group.userData.__joint = null; });
  const childTaken = new Set();
  const roots = [];
  for (const j of allJoints) {
    if (!infoByName[j.body0] || !infoByName[j.body1]) continue;
    const isLoop = j.role === 'loop' || childTaken.has(j.body1);
    if (isLoop) { model.loopJoints.push(j); model.joints[j.name] = j; continue; }
    j.tree = true; childTaken.add(j.body1);
    infoByName[j.body1].parentJoint = j.name; infoByName[j.body0].children.push(j.body1);
    const childGroup = infoByName[j.body1].group;
    childGroup.userData.__joint = j;
    j.child = childGroup;
    model.joints[j.name] = j;
  }
  Object.values(infoByName).forEach(l => { if (!l.parentJoint) roots.push(l.name); });
  model._roots = roots;
}
function applyCouplings(model) {
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
function applyPoseRaw(model, updateWorld=true) {
  for (const r of model._roots || []) {
    const info = model._linkInfo?.[r]; if (info) applyPoseRecursive(model, r, info.baseMatrix.clone());
  }
  if (updateWorld) model.updateMatrixWorld(true);
}

function jointIsPrismatic(j){ return /prismatic/i.test(j?.jointType || j?.type || '') || /Prismatic/i.test(j?.schema || ''); }
function jointIsRevolute(j){ return /revolute|continuous|hinge/i.test(j?.jointType || j?.type || '') || /Revolute/i.test(j?.schema || ''); }
function isImplicitFreeDof(j){
  if (!j) return false;
  const src = `${j.source || ''} ${j.authority || ''} ${j.kinematicRole || ''}`;
  return !!(j.implicitMotionCandidate || /raw_free_dof\s*=\s*1|rank\s*=\s*5|unlocked\s+Insert|concentric shaft can spin/i.test(src));
}
function isImplicitMovable(j){ return !!(j && String(j.jointType || j.type || '').toLowerCase() === 'fixed' && j.tree && j.role !== 'root' && isImplicitFreeDof(j)); }
function isMovableFull(j){
  if (!j) return false;
  if (isImplicitMovable(j)) return true;
  if (j.exportedMovable === true && !/FixedJoint/i.test(j.schema || '')) return true;
  if (/RevoluteJoint|PrismaticJoint/i.test(j.schema || '')) return true;
  return !!(j.jointType && !/^fixed$/i.test(j.jointType) && !/FixedJoint/i.test(j.schema || ''));
}
function jointValue(j){ return Number(j?.value || 0); }
function setJointScalar(j, v) {
  const val = Number.isFinite(Number(v)) ? Number(v) : 0;
  j.value = val;
  if (jointIsPrismatic(j)) j.position = val; else j.angle = val;
}
function activeImplicitClosureCandidates(model){ return (model.implicitCandidates || []).filter(c => c && c.activeForViewerClosure && c.localPointA && c.localPointB); }
function treeJointBetweenLinks(model, a, b){
  if (!a || !b) return null;
  return (model._allJoints || []).find(j => j && j.tree && j.role !== 'loop' && ((j.body0 === a && j.body1 === b) || (j.body0 === b && j.body1 === a))) || null;
}
function loopIsSolverRelevant(model, j){
  if (!j || !model._linkInfo?.[j.body0] || !model._linkInfo?.[j.body1]) return false;
  // If this pair already has a tree joint, do not close it again as a hard loop.
  if (treeJointBetweenLinks(model, j.body0, j.body1)) return false;
  const txt = `${j.name || ''} ${j.source || ''} ${j.evidence || ''} ${j.authority || ''} ${j.kinematicRole || ''}`;
  if (/diagnostic_only|visual_fastener|requires_review\s*=\s*true/i.test(txt)) return false;
  return true;
}
function implicitCandidateIsSolverRelevant(model, c){
  if (!(c && c.activeForViewerClosure && c.localPointA && c.localPointB)) return false;
  if (!model._linkInfo?.[c.linkA] || !model._linkInfo?.[c.linkB]) return false;
  const tj = treeJointBetweenLinks(model, c.linkA, c.linkB);
  if (tj) return false;
  if (c.exportedJoint) {
    const ej = model.joints?.[c.exportedJoint];
    if (ej && ej.tree && ej.role !== 'loop') return false;
  }
  const txt = `${c.name || ''} ${c.reason || ''} ${c.evidence || ''} ${c.exportedRole || ''}`;
  if (/unlocked\s+Insert|axis_joint|joint_axis|spin|shaft\s+can\s+spin|hinge/i.test(txt)) return false;
  return true;
}
function activeSolverLoopJoints(model, max=Infinity){
  const arr = [];
  for (const j of model.loopJoints || []) {
    if (arr.length >= max) break;
    if (loopIsSolverRelevant(model, j)) arr.push(j);
  }
  return arr;
}
function activeSolverImplicitClosureCandidates(model, max=Infinity){
  const arr = [];
  for (const c of activeImplicitClosureCandidates(model)) {
    if (arr.length >= max) break;
    if (implicitCandidateIsSolverRelevant(model, c)) arr.push(c);
  }
  return arr;
}
function localPointFromWorld(model, linkName, worldPoint){
  const l = model._linkInfo?.[linkName]; if (!l) return new THREE.Vector3();
  return new THREE.Vector3(...worldPoint).applyMatrix4(l.baseMatrix.clone().invert());
}
function localDirFromWorld(model, linkName, worldDir){
  const l = model._linkInfo?.[linkName]; const v = new THREE.Vector3(...(worldDir || [0,0,1]));
  if (v.lengthSq() < EPS) v.set(0,0,1);
  if (l) v.transformDirection(l.baseMatrix.clone().invert());
  v.normalize(); if (v.lengthSq() < EPS) v.set(0,0,1); return v;
}
function finalizeImplicitCandidateFrames(model){
  for (const c of model.implicitCandidates || []) {
    if (!c.activeForViewerClosure || !c.hasAxisPoint) continue;
    if (!model._linkInfo?.[c.linkA] || !model._linkInfo?.[c.linkB]) { c.activeForViewerClosure = false; continue; }
    c.localPointA = localPointFromWorld(model, c.linkA, c.axisPointWorld);
    c.localPointB = localPointFromWorld(model, c.linkB, c.axisPointWorld);
    c.localAxisA = localDirFromWorld(model, c.linkA, c.axisWorld);
    c.localAxisB = localDirFromWorld(model, c.linkB, c.axisWorld);
  }
}
function linkToken(name){ return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_'); }
function linkByToken(model, token){ const t = linkToken(token); for (const k of Object.keys(model._linkInfo || {})) if (linkToken(k).includes(t)) return k; return ''; }
function candidateBetween(model, a,b){ return (model.implicitCandidates || []).find(c => c && ((c.linkA===a && c.linkB===b) || (c.linkA===b && c.linkB===a))); }
function localPointArrayFromWorld(model, linkName, worldPoint){ const p = localPointFromWorld(model, linkName, worldPoint); return [p.x,p.y,p.z]; }
function localAxisArrayFromWorld(model, linkName, worldDir){ const v = localDirFromWorld(model, linkName, worldDir); return [v.x,v.y,v.z]; }
function rewireTreeParent(model, j, newParent){
  if (!j || !newParent || !model._linkInfo?.[newParent]) return;
  const oldParent = j.body0;
  if (oldParent && model._linkInfo[oldParent]) {
    const arr = model._linkInfo[oldParent].children || [];
    const idx = arr.indexOf(j.body1); if (idx >= 0) arr.splice(idx,1);
  }
  j.body0 = j.parentLink = newParent;
  if (!model._linkInfo[newParent].children.includes(j.body1)) model._linkInfo[newParent].children.push(j.body1);
  const child = model._linkInfo[j.body1]; if (child) child.parentJoint = j.name;
}
function promoteJointFromCandidate(model, j, c, reason){
  if (!j || !c || !c.hasAxisPoint) return false;
  j.schema = /Revolute/i.test(j.schema || '') ? j.schema : 'PhysicsRevoluteJoint';
  j.jointType = j.type = 'continuous';
  j.exportedMovable = true; j.viewerControllable = false; j.implicitMotionCandidate = true;
  j.kinematicRole = j.kinematicRole || 'dependent_passive_implicit_coordinate';
  j.authority = (j.authority || '') + ' BUILD131_viewer_repair_from_implicit_candidate';
  j.source = (j.source || '') + ' BUILD131_viewer_promoted_fixed_rank4_axis_candidate';
  j.evidence = (j.evidence || '') + ' ' + (c.evidence || '');
  j.axisWorldMeta = c.axisWorld || [0,0,1];
  j.axisJoint = localAxisArrayFromWorld(model, j.body0, j.axisWorldMeta);
  j.axisSuccessor = localAxisArrayFromWorld(model, j.body1, j.axisWorldMeta);
  j.axis = jointAxisLocal(j);
  j.localPos0 = localPointArrayFromWorld(model, j.body0, c.axisPointWorld);
  j.localPos1 = localPointArrayFromWorld(model, j.body1, c.axisPointWorld);
  j._localFrame0 = matrixFromPosQuat(j.localPos0, j.localRot0);
  j._localFrame1 = matrixFromPosQuat(j.localPos1, j.localRot1);
  j._localFrame1Inv = j._localFrame1.clone().invert();
  j._viewerRepair = reason || 'promoted_from_candidate';
  c.exportedJoint = j.name; c.exportedRole = j.kinematicRole; c.exportedType = j.jointType;
  return true;
}
function applyViewerMechanismRepairsFromCadEvidence(model){
  const repairs = [];
  for (const j of model._allJoints || []) {
    if (!(j && j.tree && /^fixed$/i.test(j.jointType || j.type || ''))) continue;
    const c = candidateBetween(model, j.body0, j.body1);
    if (!c) continue;
    if (c.rank === 4 && c.freeDof >= 1 && c.axisLike === 1 && c.planar === 0 && c.hasAxisPoint) {
      if (promoteJointFromCandidate(model, j, c, 'rank4_axis_like1_nonplanar_fixed_joint')) repairs.push(`${j.name}:fixed→continuous`);
    }
  }
  // BUILD133: Inventor unlocked Insert must stay as a spin axis, not as a rigid lock.
  for (const j of model._allJoints || []) {
    if (!(j && j.tree && /^fixed$/i.test(j.jointType || j.type || ''))) continue;
    const c = candidateBetween(model, j.body0, j.body1);
    if (!c || !c.hasAxisPoint) continue;
    const txt = `${c.reason || ''} ${c.solver || ''} ${c.exportedRole || ''} ${j.source || ''} ${j.evidence || ''}`;
    const sameExport = !c.exportedJoint || c.exportedJoint === j.name;
    const unlockedInsertAxis = /unlocked\s+Insert|concentric\s+shaft\s+can\s+spin|shaft\s+can\s+spin|insert\s+desbloqueado/i.test(txt);
    if (sameExport && unlockedInsertAxis) {
      if (promoteJointFromCandidate(model, j, c, 'build133_unlocked_insert_axis_not_fixed')) {
        j.viewerControllable = true;
        j.independent = j.independent || 'false';
        j.kinematicRole = j.kinematicRole || 'local_unlocked_insert_axis';
        repairs.push(`${j.name}:unlockedInsert fixed→axis`);
      }
    }
  }

  for (const [piesaTok,bucsaTok] of [['piesa_3_1','bucsa_1'], ['piesa_3_2','bucsa_2']]) {
    const piesa = linkByToken(model, piesaTok), bucsa = linkByToken(model, bucsaTok);
    if (!piesa || !bucsa) continue;
    const c = candidateBetween(model, piesa, bucsa);
    if (!(c && c.rank === 4 && c.freeDof >= 1 && c.axisLike === 1 && c.planar === 0 && c.hasAxisPoint)) continue;
    const child = model._linkInfo[piesa];
    const j = child ? model.joints[child.parentJoint] : null;
    if (!j) continue;
    const oldParent = j.body0;
    rewireTreeParent(model, j, bucsa);
    if (promoteJointFromCandidate(model, j, c, `star_${piesaTok}_to_${bucsaTok}`)) repairs.push(`${piesa}:${oldParent}→${bucsa}`);
  }
  model.viewerRepairs = repairs;
  if (repairs.length) console.warn('BUILD131 viewer CAD repairs applied', repairs);
}
function recomputeDriverCache(model){
  const drivers = (model._allJoints || []).filter(j => j && j.tree && j.role !== 'loop' && isMovableFull(j) &&
    (j.independent === 'true' || /active|driver|independent/i.test(`${j.kinematicRole || ''} ${j.authority || ''} ${j.source || ''}`)));
  model.singleDriverJoint = drivers.length === 1 ? drivers[0] : null;
}
function recomputeClosureAffectingJoints(model){
  model.closureAffectingJointNames = new Set();
  const addAncestors = (linkName) => {
    let info = model._linkInfo?.[linkName]; const seen = new Set();
    while (info && !seen.has(info.name)) {
      seen.add(info.name);
      const j = model.joints?.[info.parentJoint];
      if (!j) break;
      if (j.tree && isMovableFull(j)) model.closureAffectingJointNames.add(j.name);
      info = model._linkInfo?.[j.body0];
    }
  };
  for (const l of activeSolverLoopJoints(model)) { addAncestors(l.body0); addAncestors(l.body1); }
  for (const c of activeSolverImplicitClosureCandidates(model)) { addAncestors(c.linkA); addAncestors(c.linkB); }
}
function closureConstraintCount(model){ return activeSolverLoopJoints(model).length + activeSolverImplicitClosureCandidates(model).length; }
function jointAffectsAnyClosure(model, joint){ return !!(joint && joint.tree && isMovableFull(joint) && joint.role !== 'loop' && model.closureAffectingJointNames?.has(joint.name)); }
function nearestMovableAncestorJointRaw(model, linkName){
  let info = model._linkInfo?.[linkName]; const visited = new Set();
  while (info && !visited.has(info.name)) {
    visited.add(info.name);
    const j = model.joints?.[info.parentJoint];
    if (j && j.tree && isMovableFull(j)) return j;
    if (!j) break;
    info = model._linkInfo?.[j.body0];
  }
  return null;
}

function shouldRouteManipulationToSingleDriver(model, linkName, directJoint){
  // BUILD134_HTML_MECHANISM: exact policy from the standalone USD_Viewer(4).html.
  // Do NOT redirect every link in a closed chain to a global single driver.
  // The clicked component must use its nearest local movable joint; the compliant
  // loop solver only adjusts passive closures. This prevents the viewer from
  // feeling "trancado" or from moving only one unrelated driver link.
  return false;
}
function getManipulableJointForLinkName(model, linkName){
  if (model.manipulableJointByLink?.has(linkName)) return model.manipulableJointByLink.get(linkName);
  const direct = nearestMovableAncestorJointRaw(model, linkName);
  if (!direct) return null;
  if (shouldRouteManipulationToSingleDriver(model, linkName, direct)) return model.singleDriverJoint || direct;
  return direct;
}
function rebuildManipulableCache(model){
  recomputeDriverCache(model); recomputeClosureAffectingJoints(model);
  model.manipulableJointByLink = new Map();
  for (const info of Object.values(model._linkInfo || {})) {
    const direct = nearestMovableAncestorJointRaw(model, info.name);
    if (!direct) continue;
    let chosen = direct;
    if (shouldRouteManipulationToSingleDriver(model, info.name, direct) && model.singleDriverJoint) chosen = model.singleDriverJoint;
    model.manipulableJointByLink.set(info.name, chosen);
  }
}
function getJointWorldPivot(model, j){
  const parent = model._linkInfo?.[j.body0]; if (!parent) return new THREE.Vector3();
  const m = parent.currentMatrix.clone().multiply(j._localFrame0 || matrixFromPosQuat(j.localPos0, j.localRot0));
  return new THREE.Vector3().setFromMatrixPosition(m);
}
function getJointWorldAxis(model, j){
  const parent = model._linkInfo?.[j.body0];
  const axis = jointAxisLocal(j).clone();
  if (parent) axis.transformDirection(parent.currentMatrix.clone().multiply(j._localFrame0 || matrixFromPosQuat(j.localPos0, j.localRot0))).normalize();
  if (axis.lengthSq() < EPS) axis.set(0,0,1);
  return axis.normalize();
}
function worldFrameForJointSide(model, j, side){
  const info = model._linkInfo?.[side === 0 ? j.body0 : j.body1];
  if (!info) return new THREE.Matrix4();
  return info.currentMatrix.clone().multiply(side === 0 ? (j._localFrame0 || matrixFromPosQuat(j.localPos0,j.localRot0)) : (j._localFrame1 || matrixFromPosQuat(j.localPos1,j.localRot1)));
}
function worldAxisForJointSide(model, j, side){
  const frame = worldFrameForJointSide(model, j, side);
  let axis;
  if (side === 1 && j.axisSuccessor && j.axisSuccessor.length === 3) axis = new THREE.Vector3(...j.axisSuccessor);
  else if (j.axisJoint && j.axisJoint.length === 3) axis = new THREE.Vector3(...j.axisJoint);
  else axis = jointAxisLocal(j);
  axis.transformDirection(frame).normalize(); if (axis.lengthSq() < EPS) axis.set(0,0,1); return axis;
}
function collectLoopError(model, maxConstraints=Infinity){
  const e = [];
  const scale = Math.max(getObjectBounds(model, 1)?.maxDim || 1, 1e-4);
  const axisWeight = Math.min(Math.max(scale * 0.35, 1e-4), 0.05);
  const loopWeight = model.isDraggingJoint ? PERF.DLS_EXPLICIT_LOOP_WEIGHT_INTERACTIVE : PERF.DLS_EXPLICIT_LOOP_WEIGHT_FINAL;
  const implicitWeight = model.isDraggingJoint ? PERF.DLS_IMPLICIT_WEIGHT_INTERACTIVE : PERF.DLS_IMPLICIT_WEIGHT_FINAL;
  let used = 0;
  for (const j of activeSolverLoopJoints(model, maxConstraints)) {
    if (used++ >= maxConstraints) break;
    const a = worldFrameForJointSide(model, j, 0), b = worldFrameForJointSide(model, j, 1);
    const pa = new THREE.Vector3().setFromMatrixPosition(a), pb = new THREE.Vector3().setFromMatrixPosition(b);
    e.push((pb.x - pa.x) * loopWeight, (pb.y - pa.y) * loopWeight, (pb.z - pa.z) * loopWeight);
    const aa = worldAxisForJointSide(model, j, 0), ab = worldAxisForJointSide(model, j, 1);
    const c = new THREE.Vector3().crossVectors(aa, ab);
    e.push(c.x * axisWeight * loopWeight, c.y * axisWeight * loopWeight, c.z * axisWeight * loopWeight);
  }
  if (used < maxConstraints) {
    for (const cand of activeSolverImplicitClosureCandidates(model, maxConstraints - used)) {
      if (used++ >= maxConstraints) break;
      const la = model._linkInfo?.[cand.linkA], lb = model._linkInfo?.[cand.linkB]; if (!la || !lb) continue;
      const pa = cand.localPointA.clone().applyMatrix4(la.currentMatrix), pb = cand.localPointB.clone().applyMatrix4(lb.currentMatrix);
      e.push((pb.x - pa.x) * implicitWeight, (pb.y - pa.y) * implicitWeight, (pb.z - pa.z) * implicitWeight);
      const aa = cand.localAxisA.clone().transformDirection(la.currentMatrix).normalize(), ab = cand.localAxisB.clone().transformDirection(lb.currentMatrix).normalize();
      const cx = new THREE.Vector3().crossVectors(aa, ab);
      e.push(cx.x * axisWeight * implicitWeight, cx.y * axisWeight * implicitWeight, cx.z * axisWeight * implicitWeight);
    }
  }
  return e;
}
function loopErrorNorm(e){ if (!e || !e.length) return 0; let s=0; for (const v of e) s += v*v; return Math.sqrt(s / Math.max(1, e.length/3)); }
function linearDrivenJointNameSet(model){ const set = new Set(); for (const c of model.couplings || []) if (/^linear$/i.test(c.type || '') && c.dependentJoint) set.add(c.dependentJoint); for (const j of model._allJoints || []) if (j.mimicJoint) set.add(j.name); return set; }
function solverHintDependentNameSet(model){ const set = new Set(); for (const c of model.couplings || []) { const text = `${c.type||''} ${c.solver||''} ${c.mode||''} ${c.source||''}`; if (!/closed_chain|loop|solver|gauss|pin_axis/i.test(text)) continue; for (const name of c.dependentJoints || []) { const j = model.joints?.[name]; if (j && j.tree && j.role !== 'loop') set.add(name); } } return set; }
function passiveLoopSolverJoints(model){
  const linearDriven = linearDrivenJointNameSet(model), hinted = solverHintDependentNameSet(model), hasHint = hinted.size > 0;
  const vars = (model._allJoints || []).filter(j => {
    if (!(j && j.tree && j.role !== 'loop' && isMovableFull(j))) return false;
    if (model.pinnedSolverJointName && j.name === model.pinnedSolverJointName) return false;
    if (model.activeJointForDrag && j.name === model.activeJointForDrag.name) return false;
    if (j.independent === 'true' || /active|driver|direct/i.test(j.kinematicRole || '')) return false;
    if (!jointAffectsAnyClosure(model, j)) return false;
    if (hasHint) return hinted.has(j.name);
    if (linearDriven.has(j.name)) return false;
    return true;
  });
  return vars.slice(0, model.isDraggingJoint ? PERF.DLS_INTERACTIVE_MAX_VARS : PERF.DLS_FINAL_MAX_VARS);
}
function solveLinearDampedNormal(J, e, lambda=1e-4){
  const m=e.length, n=J.length ? J[0].length : 0; if (!m || !n) return [];
  const A=Array.from({length:n},()=>Array(n).fill(0)), b=Array(n).fill(0);
  for(let r=0;r<m;r++) for(let c=0;c<n;c++){ b[c]+=J[r][c]*e[r]; for(let k=0;k<n;k++) A[c][k]+=J[r][c]*J[r][k]; }
  for(let i=0;i<n;i++) A[i][i]+=lambda;
  const M=A.map((row,i)=>row.concat([-b[i]]));
  for(let col=0; col<n; col++){
    let piv=col; for(let r=col+1;r<n;r++) if(Math.abs(M[r][col])>Math.abs(M[piv][col])) piv=r;
    if(Math.abs(M[piv][col])<1e-12) continue;
    if(piv!==col){ const tmp=M[piv]; M[piv]=M[col]; M[col]=tmp; }
    const div=M[col][col]; for(let c=col;c<=n;c++) M[col][c]/=div;
    for(let r=0;r<n;r++){ if(r===col) continue; const f=M[r][col]; if(Math.abs(f)<1e-14) continue; for(let c=col;c<=n;c++) M[r][c]-=f*M[col][c]; }
  }
  return M.map(row=>row[n] || 0);
}
function solveLoopClosureDLS(model){
  if (!closureConstraintCount(model)) return;
  const maxConstraints = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_MAX_CONSTRAINTS : PERF.DLS_FINAL_MAX_CONSTRAINTS;
  const vars = passiveLoopSolverJoints(model);
  if (!vars.length) { model.lastLoopSolve = { residual: loopErrorNorm(collectLoopError(model, maxConstraints)), vars:0, iterations:0, constraints:closureConstraintCount(model) }; return; }
  model.isSolvingLoops = true;
  try {
    let residual = Infinity;
    const maxIter = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_MAX_ITER : PERF.DLS_FINAL_MAX_ITER;
    let lambda = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_LAMBDA : PERF.DLS_FINAL_LAMBDA;
    const stopResidual = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_STOP_RESIDUAL : PERF.DLS_FINAL_STOP_RESIDUAL;
    const relaxation = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_RELAXATION : PERF.DLS_FINAL_RELAXATION;
    for (let it=0; it<maxIter; it++){
      applyPoseRaw(model, false);
      const e0 = collectLoopError(model, maxConstraints);
      residual = loopErrorNorm(e0);
      if (residual < stopResidual) { model.lastLoopSolve = { residual, vars:vars.length, iterations:it, constraints:Math.min(closureConstraintCount(model), maxConstraints) }; break; }
      const m=e0.length, n=vars.length; const J=Array.from({length:m},()=>Array(n).fill(0));
      for (let c=0;c<n;c++){
        const j=vars[c], old=jointValue(j), eps=jointIsPrismatic(j) ? 1e-5 : 1e-4;
        setJointScalar(j, old + eps); applyPoseRaw(model, false);
        const e1=collectLoopError(model, maxConstraints); setJointScalar(j, old);
        for(let r=0;r<m;r++) J[r][c]=(e1[r]-e0[r])/eps;
      }
      const oldVals=vars.map(j=>jointValue(j)); const dq=solveLinearDampedNormal(J,e0,lambda); let maxStep=0;
      for(let c=0;c<vars.length;c++){
        const j=vars[c]; let step=Number(dq[c] || 0) * relaxation;
        const lim=jointIsPrismatic(j) ? 0.004 : (model.isDraggingJoint ? 0.08 : 0.12);
        step=Math.max(-lim, Math.min(lim, step));
        let nv=oldVals[c]+step; if(Number.isFinite(j.lowerRad)&&Number.isFinite(j.upperRad)) nv=Math.max(j.lowerRad, Math.min(j.upperRad, nv));
        setJointScalar(j,nv); maxStep=Math.max(maxStep,Math.abs(step));
      }
      applyPoseRaw(model, false);
      const nextResidual=loopErrorNorm(collectLoopError(model, maxConstraints));
      if(nextResidual > residual*1.15){ for(let c=0;c<vars.length;c++) setJointScalar(vars[c], oldVals[c]); lambda*=10; }
      else { residual=nextResidual; lambda=Math.max(lambda*0.6,1e-7); }
      model.lastLoopSolve={ residual, vars:vars.length, iterations:it+1, constraints:Math.min(closureConstraintCount(model), maxConstraints) };
      if(maxStep < 5e-8) break;
    }
  } finally { model.isSolvingLoops = false; }
}


function solvePoseForCurrentValues(model, updateWorld=true) {
  applyCouplings(model);
  applyPoseRaw(model, false);
  if (!model.isSolvingLoops) solveLoopClosureDLS(model);
  applyCouplings(model);
  applyPoseRaw(model, updateWorld);
}
function applyPose(model) {
  solvePoseForCurrentValues(model, true);
}
function snapshotMovableJointValues(model){
  return (model._allJoints || []).filter(j => j && j.tree && j.role !== 'loop' && isMovableFull(j)).map(j => [j, jointValue(j)]);
}
function restoreMovableJointValues(snapshot){
  for (const [j, v] of snapshot || []) setJointScalar(j, v);
}
function dragFeasibleResidualLimit(baseResidual){
  const b = Number.isFinite(baseResidual) ? baseResidual : 0;
  return Math.max(PERF.DLS_DRAG_FEASIBLE_RESIDUAL, b * PERF.DLS_DRAG_FEASIBLE_RELATIVE);
}

function attemptConstrainedDragValue(model, joint, value, baseSnapshot){
  restoreMovableJointValues(baseSnapshot);
  // Match the HTML mechanism: clamp the tested value before solving so the
  // binary search never evaluates an impossible value outside joint limits.
  let v = Number(value); if (!Number.isFinite(v)) v = 0;
  const lo = Number.isFinite(joint.lowerRad) ? joint.lowerRad : (jointIsPrismatic(joint) ? -0.25 : -Math.PI * 2);
  const hi = Number.isFinite(joint.upperRad) ? joint.upperRad : (jointIsPrismatic(joint) ? 0.25 : Math.PI * 2);
  v = Math.max(lo, Math.min(hi, v));
  setJointScalar(joint, v);
  solvePoseForCurrentValues(model, true);
  const maxConstraints = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_MAX_CONSTRAINTS : PERF.DLS_FINAL_MAX_CONSTRAINTS;
  const residual = model.lastLoopSolve?.residual ?? loopErrorNorm(collectLoopError(model, maxConstraints));
  return { residual, value: jointValue(joint), snapshot: snapshotMovableJointValues(model) };
}

function applyConstrainedJointDrag(model, joint, targetValue){
  if (!joint) return false;
  const startValue = jointValue(joint);
  const baseSnapshot = snapshotMovableJointValues(model);
  const maxConstraints = model.isDraggingJoint ? PERF.DLS_INTERACTIVE_MAX_CONSTRAINTS : PERF.DLS_FINAL_MAX_CONSTRAINTS;
  const baseResidual = model.lastLoopSolve?.residual ?? loopErrorNorm(collectLoopError(model, maxConstraints));
  const residualLimit = dragFeasibleResidualLimit(baseResidual);

  // First try: accept the full mouse delta if the closed-chain projection can keep up.
  const direct = attemptConstrainedDragValue(model, joint, targetValue, baseSnapshot);
  if (!closureConstraintCount(model) || direct.residual <= residualLimit) {
    restoreMovableJointValues(direct.snapshot);
    solvePoseForCurrentValues(model, true);
    return true;
  }

  // Exact standalone HTML behavior: if the requested pose is impossible, do not
  // let the visual loop fly through space and snap back on pointerup. Search on
  // the fraction of the requested delta and keep the farthest feasible pose.
  let lo = 0.0, hi = 1.0;
  let best = null;
  for (let i = 0; i < PERF.DLS_DRAG_BINARY_STEPS; i++) {
    const mid = (lo + hi) * 0.5;
    const v = startValue + (targetValue - startValue) * mid;
    const trial = attemptConstrainedDragValue(model, joint, v, baseSnapshot);
    if (trial.residual <= residualLimit) { best = trial; lo = mid; }
    else hi = mid;
  }
  if (best) restoreMovableJointValues(best.snapshot);
  else {
    restoreMovableJointValues(baseSnapshot);
    setJointScalar(joint, startValue);
  }
  solvePoseForCurrentValues(model, true);
  return !!best;
}
function setJointValueInternal(model, j, v) {
  if (!isMovableFull(j) || j.role === 'loop') return;
  let val = Number(v); if (!Number.isFinite(val)) val = 0;
  const lo = Number.isFinite(j.lowerRad) ? j.lowerRad : (jointIsPrismatic(j) ? -0.25 : -Math.PI * 2);
  const hi = Number.isFinite(j.upperRad) ? j.upperRad : (jointIsPrismatic(j) ? 0.25 : Math.PI * 2);
  val = Math.max(lo, Math.min(hi, val));
  if (model.isDraggingJoint && !model.isSolvingLoops) {
    model.activeJointForDrag = model.activeJointForDrag || j;
    applyConstrainedJointDrag(model, j, val);
    return;
  }
  setJointScalar(j, val);
  applyPose(model);
}


function parseUSDModel(text, assetDB) {
  const model = new USDModel(parseDefaultPrim(text) || 'AutoMindUSD');
  const blocks = findDefBlocks(text);
  const materialMaps = buildMaterialMaps(blocks);
  model._materialTextures = materialMaps.texByPath;
  model._materialColors = materialMaps.colorByPath;
  model._linkInfo = {};
  const linkBlocks = blocks.filter(b => b.type === 'Xform' && /automind:linkName/.test(directBody(b.body)));
  for (const b of linkBlocks) {
    const info = createLink(model, b, assetDB);
    model._linkInfo[info.name] = info;
  }
  const jointBlocks = blocks.filter(b => /^Physics.*Joint$/.test(b.type));
  const joints = jointBlocks.map(b => parseJointBlock(b, model)).filter(j => j.name && j.body0 && j.body1);
  model.couplings = blocks.filter(b => b.type === 'Xform' && /automind:kind\s*=\s*"coupling"/.test(directBody(b.body))).map(parseCouplingBlockFull);
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

function disposeDecorationLine(line) {
  try { line?.geometry?.dispose?.(); } catch (_) {}
  const mat = line?.material;
  try { if (Array.isArray(mat)) mat.forEach(m => m?.dispose?.()); else mat?.dispose?.(); } catch (_) {}
  try { line?.parent?.remove?.(line); } catch (_) {}
}
function setLineMaterialOpacity(line, baseOpacity, opacityScale, clipPlane = null) {
  const mat = line?.material;
  const arr = Array.isArray(mat) ? mat : [mat];
  for (const m of arr) {
    if (!m) continue;
    const op = Math.max(0, Math.min(1, (Number(baseOpacity) || 0) * (Number(opacityScale) || 0)));
    m.opacity = op;
    m.transparent = true;
    m.depthWrite = false;
    m.clippingPlanes = clipPlane ? [clipPlane] : null;
    m.clipIntersection = false;
    m.needsUpdate = true;
  }
}
function effectiveMechanismOpacity(core) {
  if (!core) return 0;
  const base = Number.isFinite(core.__mechanismOpacity) ? core.__mechanismOpacity : 1;
  return Math.max(0, Math.min(1, base));
}
function getDecorationScale(model) {
  const b = model ? getObjectBounds(model, 1.0) : null;
  // Same line-segment mechanism idea as the standalone USD viewer, but larger so
  // the axes/loop threads remain visible even when the component meshes are tiny.
  return Math.max((b?.maxDim || 1) * 0.16, 0.012);
}
function buildMechanismDecorations(core) {
  const model = core?.robot;
  disposeDecorationLine(core.__jointAxisBatch?.line); core.__jointAxisBatch = null;
  disposeDecorationLine(core.__loopBatch?.line); core.__loopBatch = null;
  if (!model) return;

  const allTreeJoints = Object.values(model.joints || {}).filter(j => j && j.tree && j.body0 && j.body1);
  const movableAxisJoints = allTreeJoints.filter(j => isMovableJoint(j));
  const axisJoints = movableAxisJoints.length ? movableAxisJoints : allTreeJoints;
  const axisGeom = new THREE.BufferGeometry();
  const axisPositions = new Float32Array(Math.max(1, axisJoints.length * 6));
  axisGeom.setAttribute('position', new THREE.BufferAttribute(axisPositions, 3).setUsage(THREE.DynamicDrawUsage));
  axisGeom.setDrawRange(0, axisJoints.length * 2);
  const axisMat = new THREE.LineBasicMaterial({ color: 0x087ea4, transparent: true, opacity: 0.0, depthTest: false, depthWrite: false, clippingPlanes: core.__mechanismClipPlane ? [core.__mechanismClipPlane] : null });
  const axisLine = new THREE.LineSegments(axisGeom, axisMat);
  axisLine.name = 'automind_joint_axes_batch';
  axisLine.renderOrder = 9998;
  axisLine.frustumCulled = false;
  axisLine.visible = !!core.__showJointAxes && effectiveMechanismOpacity(core) > 0.001 && axisJoints.length > 0;
  core.scene.add(axisLine);
  core.__jointAxisBatch = { line: axisLine, joints: axisJoints, positions: axisPositions, scale: getDecorationScale(model), baseOpacity: 0.95 };

  const loopItems = [];
  for (const j of model.loopJoints || []) {
    // BUILD156: match the standalone HTML: fixed/rigid closure constraints are
    // still used by the solver, but only drawable loops are rendered. This avoids
    // wrong-looking spaghetti while keeping the mechanical closures active.
    if (j && j.drawable !== false) loopItems.push({ kind: 'loop', joint: j });
  }
  for (const c of activeImplicitClosureCandidates(model) || []) loopItems.push({ kind: 'implicit', candidate: c });
  const loopGeom = new THREE.BufferGeometry();
  const loopPositions = new Float32Array(Math.max(1, loopItems.length * 6));
  loopGeom.setAttribute('position', new THREE.BufferAttribute(loopPositions, 3).setUsage(THREE.DynamicDrawUsage));
  loopGeom.setDrawRange(0, loopItems.length * 2);
  const loopMat = new THREE.LineBasicMaterial({ color: 0xb7791f, transparent: true, opacity: 0.0, depthTest: false, depthWrite: false, clippingPlanes: core.__mechanismClipPlane ? [core.__mechanismClipPlane] : null });
  const loopLine = new THREE.LineSegments(loopGeom, loopMat);
  loopLine.name = 'automind_loops_batch';
  loopLine.renderOrder = 9999;
  loopLine.frustumCulled = false;
  loopLine.visible = !!core.__showLoops && effectiveMechanismOpacity(core) > 0.001 && loopItems.length > 0;
  core.scene.add(loopLine);
  core.__loopBatch = { line: loopLine, items: loopItems, positions: loopPositions, baseOpacity: 0.95 };
  updateMechanismDecorations(core);
}
function updateMechanismDecorations(core) {
  const model = core?.robot;
  if (!model) return;
  // Keep loop/joint decoration anchors in lockstep with the active kinematic
  // solver. MJCF models maintain authoritative currentMatrix values inside the
  // model itself, so refresh them here before drawing the orange closure lines.
  try { model._refreshLinkMatrices?.(); } catch (_) {}
  const axisBatch = core.__jointAxisBatch;
  if (axisBatch?.line) {
    const visible = !!core.__showJointAxes && effectiveMechanismOpacity(core) > 0.001 && axisBatch.joints.length > 0;
    axisBatch.line.visible = visible;
    setLineMaterialOpacity(axisBatch.line, axisBatch.baseOpacity ?? 0.95, effectiveMechanismOpacity(core), core.__mechanismClipPlane || null);
    if (visible) {
      const p = new THREE.Vector3();
      const a = new THREE.Vector3();
      let k = 0;
      for (const j of axisBatch.joints) {
        p.copy(model.getJointWorldPivot ? model.getJointWorldPivot(j) : getJointWorldPivot(model, j));
        a.copy(model.getJointWorldAxis ? model.getJointWorldAxis(j) : getJointWorldAxis(model, j));
        if (a.lengthSq() < EPS) a.set(0, 0, 1);
        const s = axisBatch.scale;
        axisBatch.positions[k++] = p.x - a.x * s; axisBatch.positions[k++] = p.y - a.y * s; axisBatch.positions[k++] = p.z - a.z * s;
        axisBatch.positions[k++] = p.x + a.x * s; axisBatch.positions[k++] = p.y + a.y * s; axisBatch.positions[k++] = p.z + a.z * s;
      }
      axisBatch.line.geometry.attributes.position.needsUpdate = true;
    }
  }
  const loopBatch = core.__loopBatch;
  if (loopBatch?.line) {
    const visible = !!core.__showLoops && effectiveMechanismOpacity(core) > 0.001 && loopBatch.items.length > 0;
    loopBatch.line.visible = visible;
    setLineMaterialOpacity(loopBatch.line, loopBatch.baseOpacity ?? 0.95, effectiveMechanismOpacity(core), core.__mechanismClipPlane || null);
    if (visible) {
      const p0 = new THREE.Vector3();
      const p1 = new THREE.Vector3();
      let k = 0;
      for (const item of loopBatch.items) {
        if (item.kind === 'implicit') {
          const c = item.candidate;
          const a = model._linkInfo?.[c.linkA], b = model._linkInfo?.[c.linkB];
          if (a && b && c.localPointA && c.localPointB) {
            p0.copy(c.localPointA).applyMatrix4(a.currentMatrix);
            p1.copy(c.localPointB).applyMatrix4(b.currentMatrix);
          } else { p0.set(0,0,0); p1.set(0,0,0); }
        } else {
          const j = item.joint;
          const a = model._linkInfo?.[j.body0], b = model._linkInfo?.[j.body1];
          if (a && b) {
            // Use the exact same frame reconstruction as the closed-loop solver
            // whenever the model exposes it. This gives MJCF the same parity as
            // the USD/URDF viewers: the orange loop visualization is drawn from
            // the solver anchors, not from an approximate decorative shortcut.
            if (typeof model._frameForLoopSide === 'function') {
              const fa = model._frameForLoopSide(j, 0);
              const fb = model._frameForLoopSide(j, 1);
              p0.setFromMatrixPosition(fa);
              p1.setFromMatrixPosition(fb);
            } else {
              p0.set(j.localPos0?.[0] || 0, j.localPos0?.[1] || 0, j.localPos0?.[2] || 0).applyMatrix4(a.currentMatrix);
              if (j.hasSuccessorOrigin) p1.set(j.localPos1?.[0] || 0, j.localPos1?.[1] || 0, j.localPos1?.[2] || 0).applyMatrix4(b.currentMatrix);
              else p1.setFromMatrixPosition(b.currentMatrix);
            }
            const scale = Math.max(getObjectBounds(model, 1)?.maxDim || 1, 1e-5);
            if (p0.distanceTo(p1) > scale * 3.5) { p0.set(0,0,0); p1.set(0,0,0); }
          } else { p0.set(0,0,0); p1.set(0,0,0); }
        }
        loopBatch.positions[k++] = p0.x; loopBatch.positions[k++] = p0.y; loopBatch.positions[k++] = p0.z;
        loopBatch.positions[k++] = p1.x; loopBatch.positions[k++] = p1.y; loopBatch.positions[k++] = p1.z;
      }
      loopBatch.line.geometry.attributes.position.needsUpdate = true;
    }
  }
}


export function createViewer({ container, background = 0xffffff, pixelRatio = Math.min(window.devicePixelRatio || 1, 2) } = {}) {
  assertThree();
  container = container || document.body;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.innerHTML = '';

  const scene = new THREE.Scene(); scene.background = new THREE.Color(background ?? 0xffffff); scene.fog = null;
  const perspCamera = new THREE.PerspectiveCamera(45, 1, 0.0001, 10000);
  perspCamera.position.set(1.6, 1.1, 1.6);
  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 10000);
  orthoCamera.position.copy(perspCamera.position);
  let camera = perspCamera;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
  installWebGLUniformSafety(renderer);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(background ?? 0xffffff, 1);
  renderer.outputEncoding = THREE.sRGBEncoding;
  try { renderer.outputColorSpace = THREE.SRGBColorSpace; } catch (_) {}
  try { renderer.toneMapping = THREE.NoToneMapping; renderer.toneMappingExposure = 1.0; } catch (_) {}
  renderer.shadowMap.enabled = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap || THREE.PCFShadowMap;
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'none';
  container.appendChild(renderer.domElement);

  // BUILD162/165: use ONLY THEME.lighting as the rendering environment.
  // Keep a local reference to the key light; ground/shadow toggles need it.
  const __themeLights = installThemeLighting(scene);
  const key = __themeLights?.key || null;
  const helpers = buildHelpers(); scene.add(helpers.group);

  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 4.0;
  controls.zoomSpeed = 1.25;
  controls.panSpeed = 0.8;
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.15;

  let robot = null;
  let raf = null;
  let destroyed = false;
  let core = null;

  function resize(w, h, dpr = pixelRatio) {
    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(w || rect.width || window.innerWidth || 800));
    const height = Math.max(1, Math.floor(h || rect.height || window.innerHeight || 600));
    renderer.setPixelRatio(Math.min(dpr || 1, 2)); renderer.setSize(width, height, false); controls.handleResize?.();
    const aspect = width / Math.max(1, height);
    perspCamera.aspect = aspect; perspCamera.updateProjectionMatrix();
    const robotBounds = robot ? getObjectBounds(robot, 1.0) : null;
    // BUILD173: resizing the browser must not derive scene framing from the
    // current articulated pose. Prefer the immutable span captured at load.
    const staticModelDim = Number(helpers.__gridStaticModelDim) || 0;
    const modelSpan = Math.max(staticModelDim || (robotBounds ? robotBounds.maxDim : 1), 1e-6) * 1.6;
    let halfH = Math.max(Math.abs((orthoCamera.top || 1) - (orthoCamera.bottom || -1)) * 0.5, modelSpan, 1e-6);
    // Preserve orthographic zoom while resizing; never derive ortho view size from
    // camera distance, because the camera may be moved far away only to avoid grid
    // near-plane clipping.
    if (!camera?.isOrthographicCamera && robotBounds) halfH = Math.max(halfH, modelSpan);
    orthoCamera.left = -halfH * aspect;
    orthoCamera.right = halfH * aspect;
    orthoCamera.top = halfH;
    orthoCamera.bottom = -halfH;
    orthoCamera.near = -Math.max((helpers.__gridWorldSize || 1) * 4, halfH * 100, 1000);
    orthoCamera.far = Math.max((helpers.__gridWorldSize || 1) * 4, halfH * 100, 1000);
    orthoCamera.updateProjectionMatrix();
    keepOrthographicDepthSafe(orthoCamera, controls, helpers, robot);
  }
  function animate() {
    if (destroyed) return;
    raf = requestAnimationFrame(animate);
    controls.update();
    keepGridInfiniteForView(helpers, camera, controls, robot);
    if (core) updateMechanismDecorations(core);
    if (robot) sanitizeSceneMaterials(robot);
    // AutoMind viewport bridge: modules may register a lightweight synchronization
    // hook for scene-level presentation proxies.  It runs immediately before the
    // visible renderer, after kinematics and controls have updated, but is not
    // invoked for thumbnail render targets (which use their own temporary scene).
    try { scene.userData?.__automindBeforeVisibleRender?.({ scene, renderer, camera, robot, core }); } catch (_) {}
    renderer.render(scene, camera);
  }
  resize(); animate();
  const ro = new ResizeObserver(() => resize()); ro.observe(container);

  core = {
    __showJointAxes: false,
    __showLoops: false,
    __mechanismOpacity: 1,
    __mechanismSuppressRAF: 0,
    __mechanismSuppressToken: 0,
    __mechanismClipPlane: null,
    scene, renderer, get camera() { return camera; }, controls, helpers, get robot() { return robot; }, set robot(v) { robot = v; },
    refreshRobotContext(object = robot) {
      if (!object) return false;
      resizeSceneHelpersForObject(helpers, object);
      configureSceneShadowsForObject(object, helpers, key);
      buildMechanismDecorations(core);
      keepGridInfiniteForView(helpers, camera, controls, object);
      return true;
    },
    loadUSD(usdContent, { assetDB } = {}) {
      if (robot) { scene.remove(robot); }
      robot = parseUSDModel(usdContent || '', assetDB || null);
      scene.add(robot);
      core.refreshRobotContext(robot);
      fitAndCenter(camera, controls, robot, 1.08);
      return robot;
    },
    fitAndCenter(object = robot, pad = 1.08) { return fitAndCenter(camera, controls, object, pad); },
    resize,
    setSceneToggles({ grid, ground, axes, shadows, jointAxes, loops } = {}) {
      if (typeof grid === 'boolean') helpers.grid.visible = grid;
      if (typeof ground === 'boolean') helpers.ground.visible = ground;
      if (typeof axes === 'boolean') helpers.axes.visible = axes;
      if (typeof shadows === 'boolean') {
        renderer.shadowMap.enabled = !!shadows;
        renderer.shadowMap.needsUpdate = true;
        if (key) key.castShadow = !!shadows;
        helpers.ground.receiveShadow = !!shadows;
        if (shadows && key) configureSceneShadowsForObject(robot, helpers, key);
        try { helpers.ground.material.needsUpdate = true; } catch (_) {}
      }
      if (typeof jointAxes === 'boolean' || typeof loops === 'boolean') core.setMechanismToggles({ jointAxes, loops });
      keepGridInfiniteForView(helpers, camera, controls, robot);
    },
    setMechanismToggles({ jointAxes, loops } = {}) {
      if (typeof jointAxes === 'boolean') core.__showJointAxes = jointAxes;
      if (typeof loops === 'boolean') core.__showLoops = loops;
      if (!core.__jointAxisBatch || !core.__loopBatch) buildMechanismDecorations(core);
      updateMechanismDecorations(core);
    },
    setMechanismClippingPlane(plane = null) {
      core.__mechanismClipPlane = plane || null;
      try { renderer.localClippingEnabled = !!(plane || renderer.localClippingEnabled); } catch (_) {}
      updateMechanismDecorations(core);
    },
    setMechanismSuppressed(suppressed = false, duration = 450) {
      const target = suppressed ? 0 : 1;
      const start = Number.isFinite(core.__mechanismOpacity) ? core.__mechanismOpacity : 1;
      const token = ++core.__mechanismSuppressToken;
      if (core.__mechanismSuppressRAF) { try { cancelAnimationFrame(core.__mechanismSuppressRAF); } catch (_) {} core.__mechanismSuppressRAF = 0; }
      if (!duration || duration <= 0 || Math.abs(start - target) < 1e-4) {
        core.__mechanismOpacity = target;
        updateMechanismDecorations(core);
        return;
      }
      const t0 = performance.now();
      const ease = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const step = (now) => {
        if (token !== core.__mechanismSuppressToken) return;
        const u = Math.min(1, (now - t0) / Math.max(1, duration));
        core.__mechanismOpacity = start + (target - start) * ease(u);
        updateMechanismDecorations(core);
        if (u < 1) core.__mechanismSuppressRAF = requestAnimationFrame(step);
        else core.__mechanismSuppressRAF = 0;
      };
      core.__mechanismSuppressRAF = requestAnimationFrame(step);
    },
    setProjection(mode = 'Perspective') {
      const old = camera;
      const target = controls.target.clone();
      let dir = old.position.clone().sub(target);
      if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-12) dir.set(1, 0.7, 1);
      const dirNorm = dir.clone().normalize();
      const aspect = Math.max(1e-6, (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1));
      const robotBounds = robot ? getObjectBounds(robot, 1.0) : null;
      const modelHalf = Math.max(robotBounds ? robotBounds.maxDim * 0.8 : 0.5, 1e-6);
      if (/ortho/i.test(mode)) {
        camera = orthoCamera;
        let halfH;
        if (old.isPerspectiveCamera) {
          const dist = Math.max(1e-6, dir.length());
          halfH = dist * Math.tan(THREE.MathUtils.degToRad(old.fov || 45) * 0.5);
        } else {
          halfH = Math.abs((old.top || 1) - (old.bottom || -1)) * 0.5 / Math.max(old.zoom || 1, 1e-6);
        }
        halfH = Math.max(halfH, modelHalf, 1e-6);
        camera.left = -halfH * aspect;
        camera.right = halfH * aspect;
        camera.top = halfH;
        camera.bottom = -halfH;
        camera.zoom = 1;
        camera.quaternion.copy(old.quaternion);
        const viewDiag = Math.sqrt(Math.pow(halfH * 2 * aspect, 2) + Math.pow(halfH * 2, 2));
        const safeDist = Math.max(dir.length(), viewDiag * 2.5, (helpers.__gridWorldSize || 0) * 2.0, 1.0);
        camera.position.copy(target.clone().add(dirNorm.multiplyScalar(safeDist)));
        camera.near = -safeDist * 4.0;
        camera.far = safeDist * 4.0;
        camera.updateProjectionMatrix();
        keepGridInfiniteForView(helpers, camera, controls, robot);
      } else {
        camera = perspCamera;
        camera.quaternion.copy(old.quaternion);
        let dist = dir.length();
        if (old.isOrthographicCamera) {
          const halfH = Math.abs((old.top || 1) - (old.bottom || -1)) * 0.5 / Math.max(old.zoom || 1, 1e-6);
          dist = halfH / Math.tan(THREE.MathUtils.degToRad(camera.fov || 45) * 0.5);
        }
        dist = Math.max(dist, modelHalf * 1.5, 1e-6);
        camera.position.copy(target.clone().add(dirNorm.multiplyScalar(dist)));
        camera.near = robotBounds ? Math.max(robotBounds.maxDim / 1000, 0.001) : 0.0001;
        camera.far = Math.max(dist + (helpers.__gridWorldSize || 1) * 3.0, robotBounds ? robotBounds.maxDim * 100000 : 0, 10000000);
        camera.updateProjectionMatrix();
      }
      controls.object = camera; resize(); keepGridInfiniteForView(helpers, camera, controls, robot); controls.update();
    },
    destroy() {
      destroyed = true; if (raf) cancelAnimationFrame(raf); ro.disconnect(); controls.dispose?.();
      disposeDecorationLine(core.__jointAxisBatch?.line); core.__jointAxisBatch = null;
      disposeDecorationLine(core.__loopBatch?.line); core.__loopBatch = null;
      try { renderer.dispose(); renderer.domElement.remove(); } catch (_) {}
    }
  };
  return core;
}

export default { createViewer };
