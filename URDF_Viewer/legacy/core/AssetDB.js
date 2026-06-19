// /viewer/core/AssetDB.js
// Build a normalized in-memory asset DB and a URDFLoader-compatible loadMeshCb.
// Three r132 + urdf-loader 0.12.6
/* global THREE */ 

const ALLOWED_MESH_EXTS = new Set(['dae', 'stl', 'step', 'stp']);
const ALLOWED_TEX_EXTS  = new Set(['png', 'jpg', 'jpeg']);
const EXT_PRIORITY = { dae: 3, stl: 2, step: 1, stp: 1 };

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  stl: 'model/stl',                    // informative; we parse from bytes
  dae: 'model/vnd.collada+xml',
  step:'model/step',
  stp: 'model/step'
};

/* ---------- helpers ---------- */

function normKey(s) {
  return String(s || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .toLowerCase();
}

function dropPackagePrefix(k) {
  return k.startsWith('package://') ? k.slice('package://'.length) : k;
}

function basenameNoQuery(p) {
  const q = String(p || '').split('?')[0].split('#')[0];
  return q.split('/').pop();
}

function extOf(p) {
  const q = String(p || '').split('?')[0].split('#')[0];
  const i = q.lastIndexOf('.');
  return i >= 0 ? q.slice(i + 1).toLowerCase() : '';
}

function approxBytesFromB64(b64) {
  return Math.floor(String(b64 || '').length * 3 / 4);
}

function variantsFor(path) {
  const out = new Set();
  const p = normKey(path);
  const pkg = dropPackagePrefix(p);
  const base = basenameNoQuery(p);

  out.add(p);
  out.add(pkg);
  out.add(base);

  // también probamos sin el primer segmento (por si hay carpeta "meshes/")
  const parts = pkg.split('/');
  for (let i = 1; i < parts.length; i++) {
    out.add(parts.slice(i).join('/'));
  }
  return Array.from(out);
}


function isDataURL(v) {
  return /^data:[^,]*,/i.test(String(v || ''));
}
function dataUrlPayload(v) {
  const m = /^data:([^,]*),(.*)$/i.exec(String(v || ''));
  if (!m) return null;
  return { meta: m[1] || '', payload: m[2] || '' };
}
function dataURLFor(ext, value) {
  const s = String(value || '');
  if (/^data:[^,]*,/i.test(s)) return s;
  const mime = MIME[ext] || 'application/octet-stream';
  if ((ext === 'dae' || ext === 'obj' || ext === 'mtl') && /[<>{}\n\r]/.test(s.slice(0, 2048))) {
    return `data:${mime};charset=utf-8,${encodeURIComponent(s)}`;
  }
  return `data:${mime};base64,${s.replace(/\s+/g, '')}`;
}

const textDecoder = new TextDecoder();
function b64ToUint8(value) {
  const s0 = String(value || '');
  const dp = dataUrlPayload(s0);
  let b64 = s0;
  if (dp) {
    if (!/;base64/i.test(dp.meta)) {
      const txt = decodeURIComponent(dp.payload || '');
      return new TextEncoder().encode(txt);
    }
    b64 = dp.payload || '';
  }
  const bin = atob(String(b64 || '').replace(/\s+/g, ''));
  const len = bin.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64ToText(value) {
  const s0 = String(value || '');
  const dp = dataUrlPayload(s0);
  if (dp) {
    if (/;base64/i.test(dp.meta)) return textDecoder.decode(b64ToUint8(s0));
    try { return decodeURIComponent(dp.payload || ''); } catch (_) { return dp.payload || ''; }
  }
  if (/[<>{}\n\r]/.test(s0.slice(0, 4096))) return s0;
  return textDecoder.decode(b64ToUint8(s0));
}

/* ---------- public: buildAssetDB ---------- */

/**
 * Normaliza claves y crea índices de búsqueda.
 * @param {Object.<string,string>} meshDB  — mapa key(base/path) → base64
 * @returns {{
 *   byKey: Object.<string,string>,
 *   byBase: Map<string, string[]>,
 *   has(key: string): boolean,
 *   get(key: string): string|undefined,
 *   keys(): string[]
 * }}
 */
export function buildAssetDB(meshDB = {}) {
  const byKey = {};
  const byBase = new Map();

  // 1) Normaliza y duplica entradas útiles (sin package://)
  Object.keys(meshDB).forEach((rawKey) => {
    const b64 = normalizeBase64Value(meshDB[rawKey]);
    if (!b64) return;

    const k = normKey(rawKey);
    const kNoPkg = dropPackagePrefix(k);
    const base = basenameNoQuery(k);

    // Registra k
    if (!byKey[k]) byKey[k] = b64;

    // Registra variante sin package://
    if (kNoPkg !== k && !byKey[kNoPkg]) byKey[kNoPkg] = b64;

    // También permite lookup por basename (no exclusivo; puede haber duplicados)
    const arr = byBase.get(base) || [];
    arr.push(k);               // guardamos la key "completa" como referencia principal
    if (kNoPkg !== k) arr.push(kNoPkg);
    byBase.set(base, Array.from(new Set(arr)));
  });

  return {
    byKey,
    byBase,
    has(key) {
      const ks = variantsFor(key);
      return !!ks.find((k) => !!byKey[k]);
    },
    get(key) {
      const ks = variantsFor(key);
      for (const k of ks) {
        if (byKey[k]) return byKey[k];
      }
      // último recurso: basename
      const base = basenameNoQuery(key);
      const arr = byBase.get(base) || [];
      for (const k of arr) {
        if (byKey[k]) return byKey[k];
      }
      return undefined;
    },
    keys() { return Object.keys(byKey); }
  };
}

/* ---------- internal: choose best asset among candidates ---------- */

function pickBestKey(tryKeys, assetDB) {
  // Agrupa por basename y elige por prioridad de extensión y tamaño aprox
  const groups = new Map();
  for (const kk of tryKeys) {
    const k = normKey(kk);
    const b64 = assetDB.byKey[k];
    if (!b64) continue;
    const ext = extOf(k);
    if (!ALLOWED_MESH_EXTS.has(ext)) continue;
    const base = basenameNoQuery(k);
    const arr = groups.get(base) || [];
    arr.push({
      key: k,
      ext,
      prio: EXT_PRIORITY[ext] ?? 0,
      bytes: approxBytesFromB64(b64)
    });
    groups.set(base, arr);
  }
  // Devuelve el mejor del primer grupo con contenido
  for (const [, arr] of groups) {
    arr.sort((a, b) => (b.prio - a.prio) || (b.bytes - a.bytes));
    if (arr[0]) return arr[0].key;
  }
  return null;
}


function escapeRegExp(s) { return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function guessExtFromDataURL(dataUrl, fallback = '') {
  const m = /^data:([^;,]+)/i.exec(String(dataUrl || ''));
  const mime = (m && m[1] || '').toLowerCase();
  if (mime.includes('png')) return 'png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('bmp')) return 'bmp';
  if (mime.includes('gif')) return 'gif';
  return fallback || 'png';
}
function inlineColladaTextureRefs(daeText, assetDB) {
  let text = String(daeText || '');
  const refs = new Set();
  text.replace(/<init_from>\s*([^<]+?)\s*<\/init_from>/gi, (_m, ref) => { refs.add(String(ref || '').trim()); return _m; });
  text.replace(/(texture\s*=\s*["'])([^"']+)(["'])/gi, (_m, _a, ref) => { refs.add(String(ref || '').trim()); return _m; });
  let changed = 0;
  for (const ref of refs) {
    if (!ref || /^data:/i.test(ref)) continue;
    const raw = assetDB.get?.(ref);
    if (!raw) continue;
    const ext = extOf(ref) || guessExtFromDataURL(raw, 'png');
    const data = dataURLFor(ext, raw);
    if (!data || !/^data:/i.test(data)) continue;
    const escaped = escapeRegExp(ref);
    text = text.replace(new RegExp('(<init_from>\\s*)' + escaped + '(\\s*<\\/init_from>)', 'gi'), '$1' + data + '$2');
    text = text.replace(new RegExp('(texture\\s*=\\s*["\\'])' + escaped + '(["\\'])', 'gi'), '$1' + data + '$2');
    changed++;
  }
  return text;
}

/* ---------- public: createLoadMeshCb ---------- */

/**
 * Crea un callback compatible con URDFLoader.loadMeshCb(path, manager, onComplete)
 * que renderiza STL/DAE desde base64 + resuelve subrecursos embebidos (texturas).
 *
 * @param {*} assetDB - resultado de buildAssetDB()
 * @param {Object} [hooks]
 * @param {(meshOrGroup:THREE.Object3D, assetKey:string)=>void} [hooks.onMeshTag] - se llama tras crear el objeto
 * @returns {(path:string, manager:THREE.LoadingManager, onComplete:(obj:THREE.Object3D)=>void)=>void}
 */
export function createLoadMeshCb(assetDB, hooks = {}) {
  const daeCache = new Map();

  function tagAll(obj, key) {
    obj.userData.__assetKey = key;
    obj.traverse((o) => {
      if (o && o.isMesh && o.geometry) {
        o.userData.__assetKey = key;
        o.castShadow = true;
        o.receiveShadow = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const mat of mats) {
          if (!mat) continue;
          try {
            mat.side = THREE.DoubleSide;
            if (mat.map) {
              mat.map.colorSpace = THREE.SRGBColorSpace || mat.map.colorSpace;
              mat.map.needsUpdate = true;
            }
            if (mat.color && !mat.map) {
              const hex = mat.color.getHex?.();
              if (hex === 0xffffff) mat.color.setHex(0xe5ecef);
              if (hex === 0x000000) mat.color.setHex(0xdce7ea);
            }
            if ('roughness' in mat) mat.roughness = 0.62;
            if ('metalness' in mat) mat.metalness = 0.08;
            mat.needsUpdate = true;
          } catch (_) {}
        }
      }
    });
  }

  function makeEmpty() {
    return new THREE.Mesh(); // placeholder neutral
  }

  return function loadMeshCb(path, _manager, onComplete) {
    try {
      const tries = variantsFor(path);
      const bestKey = pickBestKey(tries, assetDB);
      if (!bestKey) {
        onComplete(makeEmpty());
        return;
      }

      const ext = extOf(bestKey);
      const b64 = assetDB.byKey[bestKey];
      if (!b64) {
        onComplete(makeEmpty());
        return;
      }

      // STEP/STP no se soporta en Three sin parser extra — devolvemos placeholder
      if (ext === 'step' || ext === 'stp') {
        onComplete(makeEmpty());
        return;
      }

      // STL binario
      if (ext === 'stl') {
        const bytes = b64ToUint8(b64);
        const loader = new THREE.STLLoader();
        const geom = loader.parse(bytes.buffer);
        geom.computeVertexNormals?.();
        const mesh = new THREE.Mesh(
          geom,
          new THREE.MeshStandardMaterial({
            color: 0x7fd4d4,
            roughness: 0.85,
            metalness: 0.12,
            side: THREE.DoubleSide
          })
        );
        tagAll(mesh, bestKey);
        hooks.onMeshTag?.(mesh, bestKey);
        onComplete(mesh);
        return;
      }

      // DAE texto + subrecursos
      if (ext === 'dae') {
        // Cache por key para reusar escenas clonadas
        if (daeCache.has(bestKey)) {
          const obj = daeCache.get(bestKey).clone(true);
          tagAll(obj, bestKey);
          hooks.onMeshTag?.(obj, bestKey);
          onComplete(obj);
          return;
        }

        const daeText = inlineColladaTextureRefs(b64ToText(b64), assetDB);

        // BUILD152: Collada image refs are rewritten to data:image/*;base64 URLs
        // before parsing. This prevents Colab/URDFLoader from requesting fake
        // blob:/meshes/*.png or localhost-proxy texture paths and makes thumbnails
        // capture the same material that the main viewer sees.

        // BUILD148: no aplicar escala manual por <unit meter>. ColladaLoader
        // ya interpreta unidades; aplicar otra escala desarma/achica modelos.

        // Manager que mapea URLs a data: desde assetDB (texturas, otras DAEs, etc.)
        // IMPORTANTE: esperamos a que terminen de cargar las texturas antes de llamar onComplete,
        // para que las capturas/thumbnails salgan con texturas (no en blanco).
        const mgr = new THREE.LoadingManager();

        let started = false;
        let finished = false;

        mgr.onStart = () => { started = true; };
        mgr.onLoad = () => {
          if (finished) return;
          finished = true;
        };

        mgr.setURLModifier((url) => {
          const v = variantsFor(url);             // prueba varias formas
          const k = v.find((x) => assetDB.byKey[x]);
          if (k) {
            const e = extOf(k);
            const b = assetDB.byKey[k];
            return dataURLFor(e, b);
          }
          const clean = String(url || '').split('?')[0].split('#')[0];
          if (/\.(png|jpe?g|webp|bmp|gif|tga)$/i.test(clean)) {
            return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';
          }
          return url; // fallback: deja URL original (por si acaso)
        });

        const loader = new THREE.ColladaLoader(mgr);
        const collada = loader.parse(daeText, '');
        const obj = (collada && collada.scene) ? collada.scene : new THREE.Object3D();
        try { obj.updateMatrixWorld(true); } catch (_) {}

        const finalize = () => {
          // Cachea el original y devuelve un clon para no compartir refs
          if (!daeCache.has(bestKey)) daeCache.set(bestKey, obj);
          const clone = obj.clone(true);
          tagAll(clone, bestKey);
          hooks.onMeshTag?.(clone, bestKey);
          onComplete(clone);
        };

        // Si ColladaLoader inició cargas (texturas), esperamos a onLoad.
        // Si no inició nada, finalizamos de inmediato.
        // Nota: onLoad podría no dispararse si no hubo ningún itemStart.
        Promise.resolve().then(() => {
          if (!started) {
            finalize();
            return;
          }
          if (finished) {
            finalize();
            return;
          }
          // Esperar a que el manager termine
          const prevOnLoad = mgr.onLoad;
          mgr.onLoad = () => {
            try { prevOnLoad?.(); } catch (_) {}
            finalize();
          };
        });

        return;
      }

      // Ext desconocido (o no permitido): placeholder
      onComplete(makeEmpty());
    } catch (_e) {
      try { onComplete(makeEmpty()); } catch (_ee) {}
    }
  };
}

/* ---------- (opcional) export ALLOWED sets if UI wants them ---------- */
export const ALLOWED_EXTS = {
  mesh: ALLOWED_MESH_EXTS,
  tex: ALLOWED_TEX_EXTS
};
