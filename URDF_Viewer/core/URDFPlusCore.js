// /URDF_Viewer/core/URDFPlusCore.js
// AutoMind URDF+ loader for the modular USD-style viewer shell. BUILD144: exact BUILD138 visual-tree/DAE policy + robust Collada blob-relative texture fallback for Colab; no npm examples redirect loop.
// Direct modular renderer without legacy DOM adapter: it builds a THREE robot directly and exposes
// the same robot API expected by SelectionAndDrag, ToolsDock and ComponentsPanel.
/* global THREE */

const EPS = 1e-12;
const TEXT_EXT = /\.(urdf|xml|dae|obj|mtl|txt|json|csv)$/i;
const TRANSPARENT_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

function isTextureLikePath(path) {
  return /\.(png|jpe?g|webp|bmp|gif|tga)(?:[?#].*)?$/i.test(String(path || ''));
}
function isRealExternalUrl(path) {
  return /^(blob:|https?:\/\/)/i.test(String(path || '')) || /^data:[^,]+,/i.test(String(path || ''));
}

function assertThree() {
  if (typeof THREE === 'undefined') throw new Error('[URDFPlusCore] THREE is not defined. Load three.js first.');
}
function basename(path) { return String(path || 'file').split(/[\\/]/).filter(Boolean).pop() || 'file'; }
function stripExt(path) { return basename(path).replace(/\.[^.]+$/, ''); }
function extname(path) { const b = basename(path); const i = b.lastIndexOf('.'); return i >= 0 ? b.slice(i).toLowerCase() : ''; }
function cleanPath(path) {
  let s = String(path || '').trim();
  if ((s.startsWith('@') && s.endsWith('@')) || (s.startsWith('"') && s.endsWith('"'))) s = s.slice(1, -1);

  // ColladaLoader can accidentally combine a data: DAE URL with a relative
  // texture path and produce strings such as "data:model/base.jpg". That is
  // not a valid data URL because it has no comma/payload, so normalize it back
  // to the intended relative path before asset lookup. Real data URLs are kept.
  if (/^data:/i.test(s) && !/^data:[^,]+,/i.test(s)) {
    s = s.replace(/^data:/i, '');
    s = s.replace(/^[a-z0-9.+-]+\//i, '');
  }

  try { s = decodeURIComponent(s); } catch (_) {}
  s = s.replace(/\\/g, '/').replace(/[?#].*$/, '');
  s = s.replace(/^file:\/+/i, '').replace(/^package:\/\//i, '').replace(/^[A-Za-z]:\//, '');
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

function valueLooksLikeText(path, value) {
  if (value == null) return false;
  const s = String(value || '');
  if (/^data:[^,]+,/i.test(s)) return true;
  if (!TEXT_EXT.test(path)) return false;
  return /[<>{}\n\r]/.test(s.slice(0, 4096)) || /^\s*(solid\b|mtllib\b|o\s+|v\s+)/i.test(s.slice(0, 256));
}
function decodeBase64ToText(b64) {
  const clean = String(b64 || '').replace(/\s+/g, '');
  try {
    const bin = atob(clean);
    let out = '';
    for (let i = 0; i < bin.length; i += 0x8000) {
      const chunk = bin.slice(i, i + 0x8000);
      const arr = new Uint8Array(chunk.length);
      for (let j = 0; j < chunk.length; j++) arr[j] = chunk.charCodeAt(j);
      out += new TextDecoder('utf-8').decode(arr, { stream: i + 0x8000 < bin.length });
    }
    return out;
  } catch (_) {
    return '';
  }
}
function rawTextFromValue(path, value) {
  if (value == null) return '';
  let s = String(value || '');
  const m = /^data:([^,]*),(.*)$/i.exec(s);
  if (m) {
    const meta = m[1] || '';
    const payload = m[2] || '';
    if (/;base64/i.test(meta)) return decodeBase64ToText(payload);
    try { return decodeURIComponent(payload); } catch (_) { return payload; }
  }
  if (TEXT_EXT.test(path) && /[<>{}\n\r]/.test(s.slice(0, 4096))) return s;
  if (TEXT_EXT.test(path)) {
    const decoded = decodeBase64ToText(s);
    if (decoded && /[<>{}\n\r]/.test(decoded.slice(0, 4096))) return decoded;
  }
  return s;
}
function parseVec(s, fallback = [0, 0, 0]) {
  // BUILD138/139: attributes such as automind:axis_world and automind:axis_joint
  // are optional. Some call sites intentionally pass fallback=null to preserve
  // "not provided". Never call .slice() unless the fallback is actually an array.
  if (s == null || s === '') return Array.isArray(fallback) ? fallback.slice() : fallback;
  const nums = String(s).match(/[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/g)?.map(Number) || [];
  if (!nums.length) return Array.isArray(fallback) ? fallback.slice() : fallback;
  const out = Array.isArray(fallback)
    ? fallback.slice()
    : Array.from({ length: Math.max(3, nums.length) }, (_, i) => (Number.isFinite(nums[i]) ? nums[i] : 0));
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

function parseViewerPolicyFromText(text) {
  const fallback = {
    visualTreeSource: 'auto',
    preferStandardBackup: true,
    directChildJointFirst: false,
    disableRuntimeAutodetect: false,
    disableCouplingRedirection: false,
    cadUpAxis: '+Z'
  };
  try {
    const xml = new DOMParser().parseFromString(repairMissingUrdfPlusNamespace(text), 'application/xml');
    if (xml.querySelector('parsererror')) return fallback;
    const robot = xml.querySelector('robot');
    const node = Array.from(robot?.children || []).find(n => localName(n) === 'viewer_policy');
    if (!node) return fallback;
    return {
      visualTreeSource: node.getAttribute('visual_tree_source') || fallback.visualTreeSource,
      preferStandardBackup: boolAttr(node.getAttribute('prefer_standard_backup'), fallback.preferStandardBackup),
      directChildJointFirst: boolAttr(node.getAttribute('direct_child_joint_first'), fallback.directChildJointFirst),
      disableRuntimeAutodetect: boolAttr(node.getAttribute('disable_runtime_autodetect'), fallback.disableRuntimeAutodetect),
      disableCouplingRedirection: boolAttr(node.getAttribute('disable_coupling_redirection'), fallback.disableCouplingRedirection),
      cadUpAxis: node.getAttribute('cad_up_axis') || fallback.cadUpAxis,
      q0AxisFrame: node.getAttribute('q0_axis_frame') || 'joint_origin_frame',
      loopAnchorPolicy: node.getAttribute('loop_anchor_policy') || 'use_successor_origin'
    };
  } catch (_) { return fallback; }
}



function isNativeJointType(type) {
  return /^(fixed|revolute|continuous|prismatic|floating|planar)$/i.test(String(type || ''));
}
function parseFloatOr(value, fallback = 0) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}
function attrNsOrPlain(node, local, fallback = '') {
  if (!node) return fallback;
  return node.getAttributeNS?.('https://automind.dev/mechanism', local)
    || node.getAttribute?.(`automind:${local}`)
    || node.getAttribute?.(local)
    || fallback;
}
function serializeNode(node) {
  try { return new XMLSerializer().serializeToString(node); } catch (_) { return ''; }
}
function splitAttr(s) {
  return String(s || '').split(/[;,\s]+/).map(x => x.trim()).filter(Boolean);
}
function parseUrdfPlusJointMetaNode(node) {
  const parentNode = childByLocalName(node, 'parent');
  const childNode = childByLocalName(node, 'child');
  const axisNode = childByLocalName(node, 'axis');
  const limitNode = childByLocalName(node, 'limit');
  const evidenceNode = childByLocalName(node, 'evidence');
  const type = node.getAttribute('type') || attrNsOrPlain(node, 'motion_type', '') || evidenceNode?.getAttribute('motion_type') || 'fixed';
  const lower = limitNode ? parseFloatOr(limitNode.getAttribute('lower'), -Math.PI) : -Math.PI;
  const upper = limitNode ? parseFloatOr(limitNode.getAttribute('upper'), Math.PI) : Math.PI;
  const movesSubtree = !/false/i.test(node.getAttribute('automind:moves_subtree') || attrNsOrPlain(node, 'moves_subtree', '') || evidenceNode?.getAttribute('moves_subtree') || 'true');
  const axisFromEvidence = parseVec(evidenceNode?.getAttribute('axis_joint') || attrNsOrPlain(node, 'axis_joint', ''), null);
  const axis = axisFromEvidence || parseVec(axisNode?.getAttribute('xyz'), [1, 0, 0]);
  return {
    name: node.getAttribute('name') || '',
    type,
    urdfPlusType: isNativeJointType(type) ? null : type,
    parent: parentNode?.getAttribute('link') || parentNode?.getAttribute('name') || '',
    child: childNode?.getAttribute('link') || childNode?.getAttribute('name') || '',
    independent: node.getAttribute('independent') || attrNsOrPlain(node, 'independent', '') || evidenceNode?.getAttribute('independent') || '',
    kinematicRole: attrNsOrPlain(node, 'kinematic_role', '') || evidenceNode?.getAttribute('kinematic_role') || '',
    kinematicAuthority: attrNsOrPlain(node, 'kinematic_authority', '') || evidenceNode?.getAttribute('kinematic_authority') || '',
    interactiveControl: attrNsOrPlain(node, 'interactive_control', '') || evidenceNode?.getAttribute('interactive_control') || '',
    nonDirectAnimationCandidate: boolAttr(attrNsOrPlain(node, 'non_direct_animation_candidate', '') || evidenceNode?.getAttribute('non_direct_animation_candidate'), false),
    directUserControl: !/false/i.test(attrNsOrPlain(node, 'direct_user_control', '') || evidenceNode?.getAttribute('direct_user_control') || 'true'),
    authoritativeKinematics: boolAttr(attrNsOrPlain(node, 'authoritative_kinematics', '') || evidenceNode?.getAttribute('authoritative_kinematics'), false),
    pivotMode: attrNsOrPlain(node, 'pivot_mode', '') || evidenceNode?.getAttribute('pivot_mode') || '',
    spinOnly: boolAttr(attrNsOrPlain(node, 'spin_only', '') || evidenceNode?.getAttribute('spin_only'), false),
    selfOnly: boolAttr(attrNsOrPlain(node, 'self_only', '') || evidenceNode?.getAttribute('self_only'), !movesSubtree),
    movesSubtree,
    axis,
    axisWorld: parseVec(evidenceNode?.getAttribute('axis_world') || attrNsOrPlain(node, 'axis_world', ''), null),
    axisJointEvidence: axisFromEvidence,
    origin: parseOrigin(childByLocalName(node, 'origin')),
    limit: { lower: Number.isFinite(lower) ? lower : -Math.PI, upper: Number.isFinite(upper) ? upper : Math.PI },
    rawNode: node
  };
}
function buildUrdfPlusJointMeta(jointNodes) {
  const byName = new Map();
  const byPair = new Map();
  const byChild = new Map();
  for (const node of jointNodes || []) {
    const meta = parseUrdfPlusJointMetaNode(node);
    if (!meta.name && !meta.child) continue;
    if (meta.name) byName.set(meta.name, meta);
    if (meta.parent && meta.child) byPair.set(`${meta.parent}|${meta.child}`, meta);
    if (meta.child && !byChild.has(meta.child)) byChild.set(meta.child, meta);
  }
  return { byName, byPair, byChild };
}
function mergeUrdfPlusMetaIntoJoint(joint, metaIndex) {
  if (!joint || !metaIndex) return joint;
  const meta = metaIndex.byName.get(joint.name) || metaIndex.byPair.get(`${joint.parent}|${joint.child}`) || metaIndex.byChild.get(joint.child);
  if (!meta) return joint;
  joint.urdfPlusName = meta.name || joint.name;
  joint.independent = meta.independent != null && meta.independent !== '' ? meta.independent : joint.independent;
  joint.urdfPlusType = meta.urdfPlusType || (isNativeJointType(meta.type) ? null : meta.type);
  joint.interactiveControl = meta.interactiveControl || joint.interactiveControl;
  joint.nonDirectAnimationCandidate = !!meta.nonDirectAnimationCandidate || !!joint.nonDirectAnimationCandidate;
  joint.directUserControl = meta.directUserControl !== false && joint.directUserControl !== false;
  joint.authoritativeKinematics = !!meta.authoritativeKinematics;
  joint.pivotMode = meta.pivotMode || joint.pivotMode;
  joint.spinOnly = !!meta.spinOnly || !!joint.spinOnly;
  joint.movesSubtree = meta.movesSubtree;
  joint.selfOnly = !!meta.selfOnly || meta.movesSubtree === false || !!joint.selfOnly;
  if (meta.limit) {
    joint.lower = meta.limit.lower;
    joint.upper = meta.limit.upper;
    joint.lowerRad = joint.lower;
    joint.upperRad = joint.upper;
  }
  const metaMovable = isMovableType(meta.type);
  if (metaMovable) {
    joint.jointType = meta.type;
    joint.type = meta.type;
    joint.schema = /prismatic/i.test(meta.type) ? 'PrismaticJoint' : 'RevoluteJoint';
    joint.movable = true;
    joint.exportedMovable = true;
  }
  // BUILD140: the reference HTML treats URDF+ authoritative axis/origin as the
  // source of truth when a visual-safe backup tree is used. Mirror that behavior here.
  if (meta.authoritativeKinematics || meta.axisJointEvidence || meta.axis) {
    const a = meta.axis || meta.axisJointEvidence;
    if (Array.isArray(a) && a.length >= 3) {
      const axis = new THREE.Vector3(Number(a[0]) || 0, Number(a[1]) || 0, Number(a[2]) || 0);
      if (axis.lengthSq() > EPS) {
        axis.normalize();
        joint.axis = axis;
        joint.axisJoint = [axis.x, axis.y, axis.z];
      }
    }
  }
  if (meta.authoritativeKinematics && meta.origin) {
    joint.origin = meta.origin;
    if (joint.originGroup) applyOrigin(joint.originGroup, joint.origin);
    joint._localFrame0 = originMatrix(joint.origin);
    joint.localPos0 = (joint.origin.xyz || [0,0,0]).slice();
  }
  joint.urdfPlusMeta = meta;
  return joint;
}

function computeVisualMeshBox(root) {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  let has = false;
  root?.traverse?.(o => {
    if (!o?.isMesh || !o.geometry || o.userData?.__isHoverOverlay) return;
    tmp.setFromObject(o);
    if (!Number.isFinite(tmp.min.x) || !Number.isFinite(tmp.max.x) || tmp.isEmpty()) return;
    if (!has) { box.copy(tmp); has = true; }
    else box.union(tmp);
  });
  return has ? box : null;
}
function autoNormalizeDisplayScale(model) {
  if (!model) return 1;
  model.scale.setScalar(1);
  model.updateWorldMatrix(true, true);
  const box = computeVisualMeshBox(model);
  if (!box) return 1;
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxDim) || maxDim <= 1e-12) return 1;
  let scale = 1;
  const target = 1.45;
  if (maxDim < 0.35) scale = target / maxDim;
  else if (maxDim > 8.0) scale = target / maxDim;
  scale = Math.max(0.001, Math.min(1000, scale));
  model.scale.setScalar(scale);
  model.userData.__automindDisplayScale = scale;
  model.updateWorldMatrix(true, true);
  return scale;
}
function installSelfOnlyJointVisualGroups(model) {
  if (!model?.joints || !model.links) return;
  for (const joint of Object.values(model.joints)) {
    if (!(joint.selfOnly || joint.movesSubtree === false)) continue;
    const childGroup = model.links[joint.child];
    if (!childGroup) continue;
    const ownVisuals = childGroup.children.filter(child => typeof child.name === 'string' && child.name.startsWith('visual:'));
    if (!ownVisuals.length) continue;
    const selfMotionGroup = new THREE.Group();
    selfMotionGroup.name = `joint_self_motion:${joint.name}`;
    selfMotionGroup.userData.__joint = joint;
    selfMotionGroup.userData.__linkName = joint.child;
    childGroup.add(selfMotionGroup);
    for (const visual of ownVisuals) selfMotionGroup.add(visual);
    joint.selfMotionGroup = selfMotionGroup;
    joint.motionGroup?.position?.set(0, 0, 0);
    joint.motionGroup?.quaternion?.identity?.();
    joint.motionGroup?.updateMatrix?.();
  }
}
function isVisualTreeSafeUrdf(text) {
  try {
    const xml = new DOMParser().parseFromString(repairMissingUrdfPlusNamespace(text), 'application/xml');
    if (xml.querySelector('parsererror')) return false;
    const robot = xml.querySelector('robot');
    if (!robot) return false;
    const childParents = new Map();
    const adjacency = new Map();
    const joints = Array.from(robot.children || []).filter(n => localName(n) === 'joint');
    for (const j of joints) {
      const p = childByLocalName(j, 'parent')?.getAttribute('link') || '';
      const c = childByLocalName(j, 'child')?.getAttribute('link') || '';
      if (!p || !c || p === c) return false;
      if (childParents.has(c) && childParents.get(c) !== p) return false;
      childParents.set(c, p);
      if (!adjacency.has(p)) adjacency.set(p, []);
      adjacency.get(p).push(c);
    }
    const visiting = new Set(), visited = new Set();
    const dfs = (n) => {
      if (visiting.has(n)) return false;
      if (visited.has(n)) return true;
      visiting.add(n);
      for (const c of adjacency.get(n) || []) if (!dfs(c)) return false;
      visiting.delete(n);
      visited.add(n);
      return true;
    };
    for (const n of adjacency.keys()) if (!dfs(n)) return false;
    return true;
  } catch (_) { return false; }
}

function listURDFEntries(assetDB = {}) {
  const seen = new Set();
  const out = [];
  for (const [k, v] of Object.entries(assetDB || {})) {
    const text = rawTextFromValue(k, v);
    if (!/\.(urdf|xml)$/i.test(k) || !/<robot\b/i.test(text)) continue;
    const sig = text.slice(0, 2048) + '::' + text.length;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push({ key: k, text });
  }
  return out;
}

function findVisualURDFForMain(mainText, assetDB = {}, opts = {}) {
  const policy = parseViewerPolicyFromText(mainText);
  const requireMain = policy.visualTreeSource === 'main_urdf_plus' || policy.preferStandardBackup === false || opts.preferStandardBackup === false;
  if (requireMain) return { text: mainText, key: opts.urdfPath || opts.urdfFilename || 'main', usedBackup: false, policy };

  const entries = listURDFEntries(assetDB);
  const backups = entries.filter(e => /standard[_\- ]?tree[_\- ]?backup/i.test(e.key));
  backups.sort((a, b) => String(a.key).length - String(b.key).length);

  const mainSafe = isVisualTreeSafeUrdf(mainText);
  // BUILD141: match the standalone BUILD138 HTML exactly. The visual-safe
  // backup is used ONLY when the main URDF+ tree is structurally unsafe, not
  // merely because a *_standard_tree_backup.urdf exists. The previous modular
  // build always preferred the backup whenever policy.preferStandardBackup was
  // not false; that is why some robots were assembled with stale visual poses.
  if (backups.length && opts.forceVisualBackup === true) {
    return { text: backups[0].text, key: backups[0].key, usedBackup: true, policy };
  }
  if (backups.length && !mainSafe && policy.preferStandardBackup !== false) {
    return { text: backups[0].text, key: backups[0].key, usedBackup: true, policy };
  }
  return { text: mainText, key: opts.urdfPath || opts.urdfFilename || 'main', usedBackup: false, policy };
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

class URDFPlusAssetResolver {
  constructor(assetDB = {}) {
    this.byKey = new Map();
    this.rawByKey = new Map();
    this.objectUrls = [];
    this.loadingManager = new THREE.LoadingManager();
    this.loadingManager.setURLModifier((url) => this.resolveForLoader(url));
    for (const [rawKey, rawVal] of Object.entries(assetDB || {})) this.add(rawKey, rawVal);
  }
  add(key, val) {
    if (!key || val == null) return;
    const data = dataURLFromValue(key, val);
    if (!data) return;
    for (const k of variantsFor(key)) {
      if (!this.byKey.has(k)) this.byKey.set(k, data);
      if (!this.rawByKey.has(k)) this.rawByKey.set(k, val);
    }
  }
  _lookupMap(map, path) {
    if (!path) return '';
    // Only pass through REAL URLs. A string like data:model/base.jpg is a
    // broken Collada relative URL, not an actual data URL, and must be resolved
    // through assetDB instead of being returned as-is.
    if (map === this.byKey && /^(blob:|https?:\/\/)/i.test(String(path))) return String(path);
    if (map === this.byKey && /^data:[^,]+,/i.test(String(path))) return String(path);
    for (const k of variantsFor(path)) {
      const v = map.get(k);
      if (v) return v;
    }
    const base = basename(path).toLowerCase();
    const baseNorm = base.replace(/\.[^.]+$/, '').replace(/[\s_\-]+/g, '');
    for (const [k, v] of map.entries()) {
      const b = basename(k).toLowerCase();
      const n = b.replace(/\.[^.]+$/, '').replace(/[\s_\-]+/g, '');
      if (b === base || n === baseNorm || (baseNorm && (n.includes(baseNorm) || baseNorm.includes(n)))) return v;
    }
    return '';
  }
  resolve(path) { return this._lookupMap(this.byKey, path); }
  objectURL(path) {
    const data = this.resolve(path);
    if (!data) return '';
    if (/^(blob:|https?:\/\/)/i.test(String(data))) return String(data);
    if (!/^data:/i.test(String(data))) return String(data);
    try {
      const m = /^data:([^,]*),(.*)$/i.exec(String(data));
      if (!m) return String(data);
      const meta = m[1] || 'application/octet-stream';
      const mime = (meta.split(';')[0] || 'application/octet-stream').trim();
      const payload = m[2] || '';
      let bytes;
      if (/;base64/i.test(meta)) {
        const bin = atob(payload.replace(/\s+/g, ''));
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } else {
        const text = decodeURIComponent(payload);
        bytes = new TextEncoder().encode(text);
      }
      const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
      this.objectUrls.push(url);
      return url;
    } catch (_) {
      return String(data);
    }
  }
  resolveForLoader(path) {
    const raw = String(path || '').trim();
    if (!raw) return TRANSPARENT_PNG_DATA_URL;

    // ColladaLoader may concatenate the DAE data/blob URL with relative image
    // paths. Normalize all of those back to the original basename/suffix before
    // giving up. This mirrors BUILD138 resolveLocalUrl().
    const clean = cleanPath(raw);
    const candidates = [
      raw,
      clean,
      basename(raw),
      basename(clean),
      clean.replace(/^.*?meshes\//i, 'meshes/'),
      clean.replace(/^.*?mesh\//i, 'mesh/'),
      clean.replace(/^.*?textures\//i, 'textures/'),
      clean.replace(/^.*?texture\//i, 'texture/'),
    ];
    for (const c of candidates) {
      const hit = this.resolve(c);
      if (hit) return hit;
    }

    // BUILD144: ColladaLoader can resolve a DAE Blob URL plus a relative
    // image into a fake URL like blob:https://colab.../base.jpg. That Blob does
    // not exist and generates noisy net::ERR_FILE_NOT_FOUND requests. If the
    // basename/suffix was not found in assetDB above, return an inline fallback
    // texture instead of allowing the browser to request the fake Blob path.
    const rawIsBlob = /^blob:/i.test(raw);
    const malformedDataRelative = /^data:/i.test(raw) && !/^data:[^,]+,/i.test(raw);
    const rawLooksLikeTexture = isTextureLikePath(raw) || isTextureLikePath(clean);
    if ((rawIsBlob && rawLooksLikeTexture) || (malformedDataRelative && rawLooksLikeTexture)) return TRANSPARENT_PNG_DATA_URL;

    // Real DAE/object Blob URLs and real external URLs must still pass through.
    if (isRealExternalUrl(raw)) return raw;
    if (/^file:/i.test(raw) || isTextureLikePath(raw) || /^data:/i.test(raw) || /^blob:/i.test(raw)) return TRANSPARENT_PNG_DATA_URL;
    return clean || raw;
  }
  getRaw(path) { return this._lookupMap(this.rawByKey, path); }
  getRawText(path) {
    const raw = this.getRaw(path);
    if (!raw) return '';
    return rawTextFromValue(path, raw);
  }
  dispose() {
    for (const u of this.objectUrls) { try { URL.revokeObjectURL(u); } catch (_) {} }
    this.objectUrls.length = 0;
  }
}

const CLASSIC_LOADER_CDNS = {
  ColladaLoader: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r132/examples/js/loaders/ColladaLoader.js'
  ],
  STLLoader: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r132/examples/js/loaders/STLLoader.js'
  ],
  OBJLoader: [
    'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r132/examples/js/loaders/OBJLoader.js'
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

function materialColorLooksBlack(m) {
  const c = m?.color;
  return !!(c && c.r <= 0.018 && c.g <= 0.018 && c.b <= 0.018);
}
function textureHasDecodedImage(tex) {
  const img = tex?.image;
  return !!(img && (
    (typeof img.naturalWidth === 'number' && img.naturalWidth > 0) ||
    (typeof img.width === 'number' && img.width > 0) ||
    (img.complete === true && ((img.naturalWidth || img.width || 0) > 0))
  ));
}
function textureSource(tex) {
  const img = tex?.image;
  return String(img?.currentSrc || img?.src || tex?.source?.data?.src || '');
}
function textureHasMissingFallbackSource(tex) {
  const src = textureSource(tex);
  return !!src && src === TRANSPARENT_PNG_DATA_URL;
}
function textureHasResolvableSource(tex) {
  const src = textureSource(tex);
  if (textureHasMissingFallbackSource(tex)) return false;
  return /^(data:image\/|blob:|https?:\/\/)/i.test(src);
}
function textureLooksBroken(tex) {
  if (!tex) return false;
  // BUILD144: if the URLModifier returned the inline fallback because a DAE
  // texture was missing, treat it as broken so dropBrokenTextureRefs() removes
  // the map and the black-material repair can make the CAD geometry visible.
  if (textureHasMissingFallbackSource(tex)) return true;
  // BUILD141: a just-created ImageTexture from a real data/blob URL can report
  // naturalWidth=0 before the browser finishes decoding. The BUILD138 HTML did
  // not delete those valid texture refs; deleting them here caused plain white
  // CAD materials even though the texture path was resolved correctly.
  if (tex.isDataTexture || textureHasResolvableSource(tex)) return false;
  return !textureHasDecodedImage(tex);
}
function materialHasUsefulTexture(m) {
  if (!m) return false;
  const slots = ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap'];
  return slots.some(k => m[k] && !textureLooksBroken(m[k]));
}
function dropBrokenTextureRefs(m) {
  if (!m) return false;
  let changed = false;
  for (const k of ['map','emissiveMap','aoMap','alphaMap','bumpMap','normalMap','roughnessMap','metalnessMap','specularMap']) {
    if (m[k] && textureLooksBroken(m[k])) {
      m[k] = null;
      changed = true;
    }
  }
  return changed;
}
function materialCloneOrDefault(mat, color = 0xdce7ea) {
  try { if (mat && typeof mat.clone === 'function') return mat.clone(); } catch (_) {}
  return createDefaultMaterial(color);
}
function sanitizeLoadedMeshMaterials(obj, fallbackMaterial = null) {
  // Some Inventor/Collada URDF exports arrive with completely black fallback
  // materials when textures/bindings are not resolved. That makes the whole robot
  // look like a flat silhouette on a white canvas. Do not alter valid textured
  // materials; only repair untextured pure-black/broken materials.
  const fbDark = materialColorLooksBlack(fallbackMaterial);
  const neutral = createDefaultMaterial(0xdce7ea);
  obj?.traverse?.((o) => {
    if (!o?.isMesh) return;
    let mats = Array.isArray(o.material) ? o.material : [o.material];
    let changed = false;
    mats = mats.map((m) => {
      if (!m) { changed = true; return materialCloneOrDefault(fallbackMaterial, 0xdce7ea); }
      if (dropBrokenTextureRefs(m)) changed = true;
      if (!materialHasUsefulTexture(m) && materialColorLooksBlack(m)) {
        changed = true;
        // Prefer the URDF <visual><material> color only if it is not also pure black.
        // Otherwise use a neutral CAD material so geometry remains visible.
        const repl = (!fbDark && fallbackMaterial) ? materialCloneOrDefault(fallbackMaterial, 0xdce7ea) : neutral.clone();
        repl.name = (m.name || o.name || 'automind_visible_fallback') + '_visible';
        return repl;
      }
      try {
        m.side = THREE.DoubleSide;
        if (m.color && m.color.r > 0.96 && m.color.g > 0.96 && m.color.b > 0.96 && !m.map) m.color.setHex(0xe5ecef);
        if (m.color && m.color.r < 0.018 && m.color.g < 0.018 && m.color.b < 0.018 && !materialHasUsefulTexture(m)) m.color.setHex(0xdce7ea);
        m.needsUpdate = true;
      } catch (_) {}
      return m;
    });
    if (changed) o.material = Array.isArray(o.material) ? mats : mats[0];
  });
  return obj;
}

function materialFromColor(rgba) {
  if (!rgba) return createDefaultMaterial();
  const mat = createDefaultMaterial(new THREE.Color(rgba[0] ?? 0.82, rgba[1] ?? 0.86, rgba[2] ?? 0.88));
  const a = Number(rgba[3]);
  if (Number.isFinite(a) && a < 1) { mat.transparent = true; mat.opacity = Math.max(0, Math.min(1, a)); mat.depthWrite = false; }
  return mat;
}

function waitForLoadingManager(manager, timeoutMs = 4500) {
  return new Promise((resolve) => {
    let started = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    const prevStart = manager.onStart;
    const prevLoad = manager.onLoad;
    const prevProgress = manager.onProgress;
    const prevError = manager.onError;
    manager.onStart = (url, loaded, total) => { started = true; try { prevStart?.(url, loaded, total); } catch (_) {} };
    manager.onProgress = (url, loaded, total) => {
      started = true;
      try { prevProgress?.(url, loaded, total); } catch (_) {}
      if (total > 0 && loaded >= total) setTimeout(finish, 0);
    };
    manager.onLoad = () => { try { prevLoad?.(); } catch (_) {} finish(); };
    manager.onError = (url) => { try { prevError?.(url); } catch (_) {} setTimeout(finish, 0); };
    setTimeout(() => { if (!started) finish(); }, 0);
  });
}

async function loadMeshObject(filename, resolver, fallbackMaterial) {
  const ext = extname(filename);
  const url = resolver.resolve(filename);
  if (!url) return makeMissingMarker(filename);
  await ensureClassicLoaderScripts();
  try {
    if (ext === '.dae') {
      // BUILD141: use the same loading path as the repaired reference HTML:
      // ColladaLoader.load(url) + LoadingManager URL rewrite. Do NOT manually
      // parse the DAE text and do NOT multiply by the <unit meter=...> value;
      // ColladaLoader already applies the asset unit. The previous modular build
      // double-scaled many Inventor/ROS Collada meshes and assembled robots with
      // tiny/scattered parts.
      const mgr = new THREE.LoadingManager();
      mgr.setURLModifier((u) => resolver.resolveForLoader(u));
      const loader = new THREE.ColladaLoader(mgr);
      const daeUrl = resolver.objectURL(filename) || url;
      const collada = await loaderLoad(loader, daeUrl);
      const obj = collada.scene || collada;
      await waitForLoadingManager(mgr, 5500);
      sanitizeLoadedMeshMaterials(obj, fallbackMaterial);
      setTimeout(() => { try { sanitizeLoadedMeshMaterials(obj, fallbackMaterial); } catch (_) {} }, 900);
      return obj;
    }
    if (ext === '.stl') {
      const loader = new THREE.STLLoader(resolver.loadingManager);
      let geom;
      const raw = resolver.getRaw(filename);
      if (raw) {
        const s = String(raw || '');
        if (/^data:/i.test(s) || /^(blob:|https?:\/\/)/i.test(s)) geom = await loaderLoad(loader, resolver.resolve(filename));
        else {
          const clean = s.replace(/\s+/g, '');
          try {
            const bin = atob(clean);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            geom = loader.parse(bytes.buffer);
          } catch (_) {
            geom = await loaderLoad(loader, resolver.resolve(filename));
          }
        }
      } else {
        geom = await loaderLoad(loader, url);
      }
      if (!geom.attributes.normal) geom.computeVertexNormals();
      const mesh = new THREE.Mesh(geom, fallbackMaterial ? fallbackMaterial.clone() : createDefaultMaterial());
      const g = new THREE.Group(); g.name = stripExt(filename); g.add(mesh); return g;
    }
    if (ext === '.obj') {
      const loader = new THREE.OBJLoader(resolver.loadingManager);
      const obj = await loaderLoad(loader, url);
      obj.traverse(o => { if (o.isMesh && (!o.material || !o.material.color)) o.material = fallbackMaterial ? fallbackMaterial.clone() : createDefaultMaterial(); });
      sanitizeLoadedMeshMaterials(obj, fallbackMaterial);
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
    const v = this._clampJointValue(joint, value);
    this._setJointScalar(joint, v, true);
    this.applyPose();
  }
  _clampJointValue(joint, value) {
    let v = Number(value); if (!Number.isFinite(v)) v = 0;
    const lo = Number.isFinite(joint.lower) ? joint.lower : (/prismatic/i.test(joint.jointType) ? -1 : -Math.PI * 2);
    const hi = Number.isFinite(joint.upper) ? joint.upper : (/prismatic/i.test(joint.jointType) ? 1 : Math.PI * 2);
    return Math.max(lo, Math.min(hi, v));
  }
  _setJointScalar(joint, value, applyCouplings = true) {
    value = this._clampJointValue(joint, value);
    joint.value = value;
    if (/prismatic/i.test(joint.jointType)) joint.position = value;
    else joint.angle = value;
    applyJointMotion(joint);
    if (applyCouplings && !this.__applyingCouplings) this._propagateCouplingsFrom(joint);
  }
  _propagateCouplingsFrom(masterJoint) {
    if (!masterJoint) return;
    this.__applyingCouplings = true;
    try {
      const queue = [masterJoint.name];
      const seen = new Set();
      while (queue.length) {
        const masterName = queue.shift();
        if (!masterName || seen.has(masterName)) continue;
        seen.add(masterName);
        const master = this.joints[masterName];
        if (!master) continue;
        for (const c of this.couplings || []) {
          const driver = c.driver || c.masterJoint || c.master || c.joint || '';
          const dependent = c.dependent || c.dependentJoint || c.slave || c.target || '';
          if (!driver || !dependent || driver !== masterName) continue;
          const dep = this.joints[dependent];
          if (!dep || !dep.movable) continue;
          const ratio = Number.isFinite(Number(c.multiplier)) ? Number(c.multiplier) : (Number.isFinite(Number(c.ratio)) ? Number(c.ratio) : 1);
          const offset = Number.isFinite(Number(c.offset)) ? Number(c.offset) : 0;
          this._setJointScalar(dep, (Number(master.value) || 0) * ratio + offset, false);
          queue.push(dep.name);
        }
      }
    } finally { this.__applyingCouplings = false; }
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
  const motionTarget = joint.selfMotionGroup || g;
  g.position.set(0,0,0); g.quaternion.identity(); g.rotation.set(0,0,0); g.scale.set(1,1,1);
  if (motionTarget !== g) {
    motionTarget.position.set(0,0,0); motionTarget.quaternion.identity(); motionTarget.rotation.set(0,0,0); motionTarget.scale.set(1,1,1);
  }
  const axis = (joint.axis || new THREE.Vector3(1,0,0)).clone().normalize();
  if (/prismatic/i.test(joint.jointType)) motionTarget.position.copy(axis.multiplyScalar(Number(joint.position) || 0));
  else if (joint.movable || joint.spinOnly || joint.selfOnly) motionTarget.quaternion.setFromAxisAngle(axis, Number(joint.angle ?? joint.value) || 0);
  g.updateMatrix();
  if (motionTarget !== g) motionTarget.updateMatrix();
}
function parseJoint(jointNode, model) {
  const name = jointNode.getAttribute('name') || `joint_${Object.keys(model.joints).length}`;
  const evidenceNode = childByLocalName(jointNode, 'evidence');
  const type = jointNode.getAttribute('type') || attrAny(jointNode, ['automind:motion_type','motion_type'], '') || evidenceNode?.getAttribute('motion_type') || 'fixed';
  const parent = childByLocalName(jointNode, 'parent')?.getAttribute('link') || childByLocalName(jointNode, 'parent')?.getAttribute('name') || '';
  const child = childByLocalName(jointNode, 'child')?.getAttribute('link') || childByLocalName(jointNode, 'child')?.getAttribute('name') || '';
  const axisEvidence = parseVec(evidenceNode?.getAttribute('axis_joint') || attrAny(jointNode, ['axis_joint','automind:axis_joint'], ''), null);
  const axisNums = axisEvidence || parseVec(childByLocalName(jointNode, 'axis')?.getAttribute('xyz'), [1,0,0]);
  const axis = new THREE.Vector3(axisNums[0] || 0, axisNums[1] || 0, axisNums[2] || 0);
  if (axis.lengthSq() < EPS) axis.set(1,0,0);
  axis.normalize();
  const limit = childByLocalName(jointNode, 'limit');
  const lower = type === 'continuous' ? -Math.PI * 2 : parseNum(limit?.getAttribute('lower'), isMovableType(type) ? (/prismatic/i.test(type) ? -1 : -Math.PI) : 0);
  const upper = type === 'continuous' ? Math.PI * 2 : parseNum(limit?.getAttribute('upper'), isMovableType(type) ? (/prismatic/i.test(type) ? 1 : Math.PI) : 0);
  const movesSubtree = !/false/i.test(attrNsOrPlain(jointNode, 'moves_subtree', '') || evidenceNode?.getAttribute('moves_subtree') || 'true');
  const j = {
    name, parent, child, body0: parent, body1: child,
    jointType: type, type, schema: /prismatic/i.test(type) ? 'PrismaticJoint' : (isMovableType(type) ? 'RevoluteJoint' : 'FixedJoint'),
    role: attrAny(jointNode, ['role','automind:jointRole','jointRole'], 'tree'),
    tree: true, movable: isMovableType(type), exportedMovable: isMovableType(type),
    independent: boolAttr(attrAny(jointNode, ['independent','automind:independent'], evidenceNode?.getAttribute('independent') || ''), true),
    interactiveControl: attrNsOrPlain(jointNode, 'interactive_control', '') || evidenceNode?.getAttribute('interactive_control') || '',
    nonDirectAnimationCandidate: boolAttr(attrNsOrPlain(jointNode, 'non_direct_animation_candidate', '') || evidenceNode?.getAttribute('non_direct_animation_candidate'), false),
    directUserControl: !/false/i.test(attrNsOrPlain(jointNode, 'direct_user_control', '') || evidenceNode?.getAttribute('direct_user_control') || 'true'),
    authoritativeKinematics: boolAttr(attrNsOrPlain(jointNode, 'authoritative_kinematics', '') || evidenceNode?.getAttribute('authoritative_kinematics'), false),
    pivotMode: attrNsOrPlain(jointNode, 'pivot_mode', '') || evidenceNode?.getAttribute('pivot_mode') || '',
    spinOnly: boolAttr(attrNsOrPlain(jointNode, 'spin_only', '') || evidenceNode?.getAttribute('spin_only'), false),
    movesSubtree,
    selfOnly: boolAttr(attrNsOrPlain(jointNode, 'self_only', '') || evidenceNode?.getAttribute('self_only'), !movesSubtree),
    axis, axisJoint: [axis.x, axis.y, axis.z], axisWorldMeta: parseVec(attrAny(jointNode, ['automind:axis_world','axis_world','automind:axisWorld','axisWorld'], evidenceNode?.getAttribute('axis_world') || ''), null), axisJointMeta: axisEvidence, axisToken: 'X',
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
  const out = nodes.map((n, idx) => {
    const ratioNode = childByLocalName(n, 'ratio');
    const offsetNode = childByLocalName(n, 'offset');
    const evidence = Array.from(n.getElementsByTagName?.('*') || []).find(x => localName(x) === 'evidence');
    const predecessor = childByLocalName(n, 'predecessor');
    const successor = childByLocalName(n, 'successor');
    const driver = evidence?.getAttribute('master_joint') || evidence?.getAttribute('master') || attrAny(n, ['joint','driver','master_joint','master','source','independent','joint1','from'], '') || predecessor?.getAttribute('joint') || predecessor?.getAttribute('name') || '';
    const dependent = evidence?.getAttribute('dependent_joint') || evidence?.getAttribute('dependent') || attrAny(n, ['dependent_joint','dependent','slave','target','follower','joint2','to'], '') || successor?.getAttribute('joint') || successor?.getAttribute('name') || '';
    const multiplier = parseNum(ratioNode?.getAttribute('value') || attrAny(n, ['multiplier','ratio','scale','factor'], '1'), 1);
    const offset = parseNum(offsetNode?.getAttribute('value') || attrAny(n, ['offset','bias'], '0'), 0);
    return { index: idx, name: n.getAttribute('name') || `coupling_${idx}`, driver, dependent, masterJoint: driver, dependentJoint: dependent, multiplier, ratio: multiplier, offset, raw: serializeNode(n) };
  }).filter(c => c.driver && c.dependent);
  const seen = new Set(out.map(c => `${c.driver}|${c.dependent}`.toLowerCase()));
  for (const jointNode of Array.from(robotNode?.children || []).filter(n => localName(n) === 'joint')) {
    const mimic = childByLocalName(jointNode, 'mimic');
    if (!mimic) continue;
    const dep = jointNode.getAttribute('name') || '';
    const master = mimic.getAttribute('joint') || '';
    if (!dep || !master) continue;
    const key = `${master}|${dep}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const multiplier = parseNum(mimic.getAttribute('multiplier'), 1);
    const offset = parseNum(mimic.getAttribute('offset'), 0);
    out.push({ index: out.length, name: `mimic_${master}_to_${dep}`, type: 'mimic', driver: master, dependent: dep, masterJoint: master, dependentJoint: dep, multiplier, ratio: multiplier, offset, raw: serializeNode(mimic) });
  }
  return out;
}
function parseLoopNodes(robotNode, model) {
  const out = [];
  const nodes = Array.from(robotNode?.children || []).filter(n => localName(n) === 'loop');
  const seen = new Set();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const predecessor = childByLocalName(n, 'predecessor');
    const successor = childByLocalName(n, 'successor');
    const predOrigin = childByLocalName(n, 'predecessor_origin') || childByLocalName(n, 'predecessorOrigin') || childByLocalName(n, 'origin');
    const succOrigin = childByLocalName(n, 'successor_origin') || childByLocalName(n, 'successorOrigin');
    const a = predecessor?.getAttribute('link') || predecessor?.getAttribute('name') || attrAny(n, ['parent','predecessor','link_a','linkA','body0','from','link1'], '');
    const b = successor?.getAttribute('link') || successor?.getAttribute('name') || attrAny(n, ['child','successor','link_b','linkB','body1','to','link2'], '');
    if (!a || !b || a === b || !model.links[a] || !model.links[b]) continue;
    const type = n.getAttribute('type') || 'fixed';
    const p0 = parseOrigin(predOrigin).xyz;
    const p1 = parseOrigin(succOrigin).xyz;
    const key = [a < b ? a : b, a < b ? b : a, type, p0.map(x => Number(x || 0).toPrecision(8)).join(','), p1.map(x => Number(x || 0).toPrecision(8)).join(',')].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      index: out.length, name: attrAny(n, ['name'], `loop_${i}`), role: 'loop', tree: false, type,
      body0: a, body1: b, predecessor: a, successor: b,
      localPos0: p0, localPos1: p1, origin: parseOrigin(predOrigin), successorOrigin: parseOrigin(succOrigin),
      involvedTreeJoints: splitAttr(n.getAttribute('involved_tree_joints') || n.getAttribute('involvedTreeJoints') || ''),
      raw: serializeNode(n)
    });
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
  // Critical Components Panel fix:
  // Empty URDF links are valid kinematic/reference frames, but they are not
  // visual components. The previous version fabricated a tiny cube marker for
  // every link without <visual> geometry; that polluted the component panel with
  // phantom cubes such as *_inertia, *_camera_parent and optical/color frames.
  // Keep the link group in the robot hierarchy, but only register it as a
  // selectable/listed component when real visual geometry or an actual missing
  // mesh marker from loadMeshObject() was added above.
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
    const byNorm = new Map(Object.keys(assetDB || {}).map(k => [normKey(k), k]));
    for (const k of variantsFor(wanted)) {
      const realKey = byNorm.get(k) || k;
      const v = assetDB[realKey];
      const text = rawTextFromValue(realKey, v);
      if (text && /<robot\b/i.test(text)) return text;
    }
  }
  const entries = Object.entries(assetDB || {});
  const urdfs = entries
    .map(([k, v]) => [k, rawTextFromValue(k, v)])
    .filter(([k, text]) => /\.(urdf|xml)$/i.test(k) && /<robot\b/i.test(String(text || '')));
  urdfs.sort((a, b) => {
    const sa = /standard_tree_backup/i.test(a[0]) ? 1 : 0;
    const sb = /standard_tree_backup/i.test(b[0]) ? 1 : 0;
    return sa - sb || String(a[0]).length - String(b[0]).length;
  });
  return urdfs[0]?.[1] || '';
}

export async function buildURDFAssetDBFromOptions(opts = {}) {
  // BUILD139: always merge the supplied URDF_Zip instead of ignoring it when
  // assetDB has a few metadata entries. Zip assets provide meshes/textures.
  const explicit = { ...(opts.assetDB || {}), ...(opts.meshDB || {}), ...(opts.textureDB || {}), ...(opts.assets || {}), ...(opts.filesDB || {}) };
  const zip = opts.URDF_Zip || opts.urdfZip || opts.urdfZipBase64 || opts.zipBase64 || opts.zipDataUrl || '';
  const assetDB = zip ? await zipBase64ToAssetDB(zip) : {};
  Object.assign(assetDB, explicit);
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

  const visualPick = findVisualURDFForMain(urdfText, assetDBRaw, opts);
  const text = repairMissingUrdfPlusNamespace(urdfText);
  const visualText = repairMissingUrdfPlusNamespace(visualPick.text || urdfText);

  const xml = new DOMParser().parseFromString(text, 'application/xml');
  const visualXml = new DOMParser().parseFromString(visualText, 'application/xml');
  const err = xml.querySelector('parsererror');
  const verr = visualXml.querySelector('parsererror');
  if (err) throw new Error('Invalid URDF/XML: ' + err.textContent.slice(0, 300));
  if (verr) throw new Error('Invalid visual URDF/XML: ' + verr.textContent.slice(0, 300));
  const robotNode = xml.querySelector('robot');
  const visualRobotNode = visualXml.querySelector('robot');
  if (!robotNode) throw new Error('No <robot> root found in URDF/XML.');
  if (!visualRobotNode) throw new Error('No <robot> root found in visual URDF/XML.');

  const resolver = new URDFPlusAssetResolver(assetDBRaw);
  const model = new URDFPlusModel(visualRobotNode.getAttribute('name') || robotNode.getAttribute('name') || 'AutoMindURDFPlus');
  model.assetResolver = resolver;
  model.userData.__visualTreeKey = visualPick.key;
  model.userData.__visualTreeUsedBackup = !!visualPick.usedBackup;
  model.userData.__mechanicalGraph = robotNode.getAttribute('name') || 'URDF+';
  model.viewerPolicy = visualPick.policy;
  const materialMap = parseGlobalMaterials(visualRobotNode);
  const mainMaterialMap = parseGlobalMaterials(robotNode);
  for (const [k, v] of mainMaterialMap.entries()) if (!materialMap.has(k)) materialMap.set(k, v);

  const linkNodes = Array.from(visualRobotNode.children).filter(n => localName(n) === 'link');
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
  const urdfPlusJointMeta = buildUrdfPlusJointMeta(Array.from(robotNode.children || []).filter(n => localName(n) === 'joint'));
  const joints = Array.from(visualRobotNode.children)
    .filter(n => localName(n) === 'joint')
    .map(n => mergeUrdfPlusMetaIntoJoint(parseJoint(n, model), urdfPlusJointMeta))
    .filter(j => j.parent && j.child && model.links[j.parent] && model.links[j.child]);
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

  installSelfOnlyJointVisualGroups(model);
  model.couplings = parseCouplings(robotNode);
  model.loopJoints.push(...parseLoopNodes(robotNode, model));
  autoNormalizeDisplayScale(model);
  model.updateCurrentMatrices();
  return model;
}

export default { loadURDFPlusModel, buildURDFAssetDBFromOptions };
