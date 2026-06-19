// /viewer/ui/ToolsDock.js / checkpoint
// Floating tools dock: render modes, explode (smoothed & robust), section plane (ROBOT ONLY), views, projection, scene toggles, snapshot.
/* global THREE */ 

export function createToolsDock(app, theme) {
  if (!app || !app.camera || !app.controls || !app.renderer)
    throw new Error('[ToolsDock] Missing app.camera/controls/renderer');

  // --- Normalize theme to flat keys (works with your Theme.js nested shape) ---
  if (theme && theme.colors) {
    theme.teal       ??= theme.colors.teal;
    theme.tealSoft   ??= theme.colors.tealSoft;
    theme.tealFaint  ??= theme.colors.tealFaint;
    theme.bgPanel    ??= theme.colors.panelBg;
    theme.bgCanvas   ??= theme.colors.canvasBg;
    theme.stroke     ??= theme.colors.stroke;
    theme.text       ??= theme.colors.text;
    theme.textMuted  ??= theme.colors.textMuted;
  }
  if (theme && theme.shadows) {
    theme.shadow ??= (theme.shadows.lg || theme.shadows.md || theme.shadows.sm);
  }

  // ============================================================
  // ✅ 50% UI SIZE SYSTEM (ONLY ADDITION)
  // Equivalent to:
  // :root { --tools-scale: 0.5; }
  // ============================================================
  try { document.documentElement.style.setProperty('--tools-scale', '0.5'); } catch (_) {}

  // ---------- DOM ----------
  const ui = {
    root: document.createElement('div'),
    dock: document.createElement('div'),
    header: document.createElement('div'),
    title: document.createElement('div'),
    fitBtn: document.createElement('button'),
    body: document.createElement('div'),
    toggleBtn: document.createElement('button')
  };

  // ---------- Helpers (with hover animations intact) ----------
  const mkButton = (label) => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      padding: '8px 12px',
      borderRadius: '12px',
      border: `1px solid ${theme.stroke}`,
      background: theme.bgPanel,
      color: theme.text,
      fontWeight: '700',
      cursor: 'pointer',
      pointerEvents: 'auto',
      boxShadow: theme.shadow,
      transition: 'transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease, border-color 120ms ease'
    });
    // Hover/active animations (KEEP)
    b.addEventListener('mouseenter', () => {
      b.style.transform = 'translateY(-1px) scale(1.02)';
      b.style.boxShadow = theme.shadow;
      b.style.background = theme.tealFaint;
      b.style.borderColor = theme.tealSoft ?? theme.teal;
    });
    b.addEventListener('mouseleave', () => {
      b.style.transform = 'none';
      b.style.boxShadow = theme.shadow;
      b.style.background = theme.bgPanel;
      b.style.borderColor = theme.stroke;
    });
    b.addEventListener('mousedown', () => {
      b.style.transform = 'translateY(0) scale(0.99)';
    });
    b.addEventListener('mouseup', () => {
      b.style.transform = 'translateY(-1px) scale(1.02)';
    });
    return b;
  };

  const mkRow = (label, child) => {
    const row = document.createElement('div');
    Object.assign(row.style, {
      display: 'grid',
      gridTemplateColumns: '120px 1fr',
      gap: '10px',
      alignItems: 'center',
      margin: '6px 0'
    });
    const l = document.createElement('div');
    l.textContent = label;
    Object.assign(l.style, { color: theme.textMuted, fontWeight: '700' });
    row.appendChild(l);
    row.appendChild(child);
    return row;
  };

  const mkSelect = (options, value) => {
    // Custom select so Section / Render Mode / Projection use the same polished UI
    // as the rest of the dock instead of the browser default dropdown.
    const root = document.createElement('div');
    const face = document.createElement('button');
    const label = document.createElement('span');
    const chevron = document.createElement('span');
    const menu = document.createElement('div');
    let current = value;
    let opened = false;

    root.tabIndex = 0;
    root.dataset.value = String(current || '');
    Object.assign(root.style, {
      position: 'relative',
      width: '100%',
      minWidth: '0',
      pointerEvents: 'auto',
      outline: 'none',
      zIndex: '1'
    });

    face.type = 'button';
    label.textContent = String(current || '');
    chevron.textContent = '▾';
    Object.assign(face.style, {
      width: '100%',
      minHeight: '34px',
      padding: '8px 10px',
      border: `1px solid ${theme.stroke}`,
      borderRadius: '10px',
      background: `linear-gradient(180deg, ${theme.bgPanel}, #f6fbfb)`,
      color: theme.text,
      fontWeight: '750',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '8px',
      boxShadow: '0 2px 8px rgba(0,0,0,0.04)',
      transition: 'transform 120ms ease, border-color 120ms ease, box-shadow 120ms ease, background-color 120ms ease'
    });
    Object.assign(label.style, {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap'
    });
    Object.assign(chevron.style, {
      color: theme.teal,
      fontWeight: '900',
      lineHeight: '1',
      transition: 'transform 160ms ease'
    });

    Object.assign(menu.style, {
      position: 'absolute',
      left: '0',
      right: '0',
      top: 'calc(100% + 6px)',
      padding: '6px',
      border: `1px solid ${theme.stroke}`,
      borderRadius: '12px',
      background: theme.bgPanel,
      boxShadow: theme.shadow,
      display: 'none',
      opacity: '0',
      transform: 'translateY(-4px) scale(0.98)',
      transformOrigin: 'top center',
      transition: 'opacity 140ms ease, transform 140ms ease',
      zIndex: '100000',
      maxHeight: '220px',
      overflowY: 'auto'
    });

    const optionButtons = [];
    function setOpen(next) {
      opened = !!next;
      root.style.zIndex = opened ? '100000' : '1';
      face.style.borderColor = opened ? theme.teal : theme.stroke;
      face.style.boxShadow = opened ? `0 0 0 3px ${theme.tealFaint}, ${theme.shadow}` : '0 2px 8px rgba(0,0,0,0.04)';
      chevron.style.transform = opened ? 'rotate(180deg)' : 'rotate(0deg)';
      if (opened) {
        menu.style.display = 'block';
        requestAnimationFrame(() => {
          menu.style.opacity = '1';
          menu.style.transform = 'translateY(0) scale(1)';
        });
      } else {
        menu.style.opacity = '0';
        menu.style.transform = 'translateY(-4px) scale(0.98)';
        setTimeout(() => { if (!opened) menu.style.display = 'none'; }, 150);
      }
    }
    function setValue(v, emit = true) {
      current = String(v);
      root.dataset.value = current;
      label.textContent = current;
      optionButtons.forEach(btn => {
        const active = btn.dataset.value === current;
        btn.style.background = active ? theme.tealFaint : 'transparent';
        btn.style.color = active ? theme.text : theme.text;
        btn.style.borderColor = active ? (theme.tealSoft ?? theme.teal) : 'transparent';
      });
      if (emit) root.dispatchEvent(new Event('change'));
    }

    options.forEach(o => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = String(o);
      btn.dataset.value = String(o);
      Object.assign(btn.style, {
        width: '100%',
        padding: '8px 9px',
        border: '1px solid transparent',
        borderRadius: '9px',
        background: 'transparent',
        color: theme.text,
        fontWeight: '700',
        textAlign: 'left',
        cursor: 'pointer',
        transition: 'background-color 120ms ease, border-color 120ms ease, transform 120ms ease'
      });
      btn.addEventListener('mouseenter', () => {
        btn.style.background = theme.tealFaint;
        btn.style.borderColor = theme.tealSoft ?? theme.teal;
        btn.style.transform = 'translateX(1px)';
      });
      btn.addEventListener('mouseleave', () => {
        const active = btn.dataset.value === current;
        btn.style.background = active ? theme.tealFaint : 'transparent';
        btn.style.borderColor = active ? (theme.tealSoft ?? theme.teal) : 'transparent';
        btn.style.transform = 'none';
      });
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setValue(o, true);
        setOpen(false);
      });
      optionButtons.push(btn);
      menu.appendChild(btn);
    });

    face.appendChild(label);
    face.appendChild(chevron);
    root.appendChild(face);
    root.appendChild(menu);

    face.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); setOpen(!opened); });
    face.addEventListener('mouseenter', () => { if (!opened) face.style.background = theme.tealFaint; });
    face.addEventListener('mouseleave', () => { if (!opened) face.style.background = `linear-gradient(180deg, ${theme.bgPanel}, #f6fbfb)`; });
    root.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') setOpen(false);
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); setOpen(!opened); }
      const idx = options.map(String).indexOf(current);
      if (ev.key === 'ArrowDown') { ev.preventDefault(); setValue(options[Math.min(options.length - 1, idx + 1)] ?? current, true); }
      if (ev.key === 'ArrowUp') { ev.preventDefault(); setValue(options[Math.max(0, idx - 1)] ?? current, true); }
    });
    document.addEventListener('pointerdown', (ev) => { if (opened && !root.contains(ev.target)) setOpen(false); }, true);
    Object.defineProperty(root, 'value', { get: () => current, set: (v) => setValue(v, false) });
    setValue(value, false);
    return root;
  };

  const mkSlider = (min, max, step, value) => {
    const s = document.createElement('input');
    s.type = 'range'; s.min = min; s.max = max; s.step = step; s.value = value;
    s.style.width = '100%';
    s.style.accentColor = theme.teal;
    return s;
  };

  const mkToggle = (label) => {
    const wrap = document.createElement('label');
    const cb = document.createElement('input'); cb.type = 'checkbox';
    const span = document.createElement('span'); span.textContent = label;
    Object.assign(wrap.style, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', pointerEvents: 'auto' });
    cb.style.accentColor = theme.teal;
    Object.assign(span.style, { fontWeight: '700', color: theme.text });
    wrap.appendChild(cb); wrap.appendChild(span);
    return { wrap, cb };
  };


  const mkToggleButton = (label, initial = false) => {
    const b = mkButton(label);
    b.style.padding = '8px';
    b.style.borderRadius = '10px';
    b.dataset.active = initial ? '1' : '0';
    const paint = () => {
      const on = b.dataset.active === '1';
      b.style.background = on ? theme.tealFaint : theme.bgPanel;
      b.style.borderColor = on ? (theme.tealSoft ?? theme.teal) : theme.stroke;
      b.style.color = on ? (theme.teal || theme.text) : theme.text;
      b.style.boxShadow = on ? '0 4px 14px rgba(8,126,164,0.16)' : theme.shadow;
    };
    b.setActive = (v) => { b.dataset.active = v ? '1' : '0'; paint(); };
    b.getActive = () => b.dataset.active === '1';
    b.addEventListener('mouseleave', paint);
    paint();
    return b;
  };

  // Root overlay
  Object.assign(ui.root.style, {
    position: 'absolute',
    left: '0', top: '0',
    width: '100%', height: '100%',
    pointerEvents: 'none',
    zIndex: '9999',
    fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial'
  });

  // Dock (✅ STEP-like placement: right:14px, top:54px)
  Object.assign(ui.dock.style, {
    position: 'absolute',
    right: '14px',
    top: '54px',
    width: '440px',
    background: theme.bgPanel,
    border: `1px solid ${theme.stroke}`,
    borderRadius: '18px',
    boxShadow: theme.shadow,
    pointerEvents: 'auto',
    overflow: 'hidden',
    display: 'none',

    // ✅ scale system
    transformOrigin: 'top right',
    transform: 'scale(var(--tools-scale))'
  });

  Object.assign(ui.header.style, {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderBottom: `1px solid ${theme.stroke}`,
    background: '#0ea5a6'
  });

  ui.title.textContent = 'Viewer Tools';
  Object.assign(ui.title.style, { fontWeight: '800', color: '#ffffff' });

  Object.assign(ui.body.style, { padding: '10px 12px' });

  // Floating toggle button (✅ STEP-like placement: right:14px, top:14px)
  ui.toggleBtn.textContent = 'Open Tools';
  Object.assign(ui.toggleBtn.style, {
    position: 'absolute',
    right: '14px',
    top: '14px',
    padding: '8px 12px',
    borderRadius: '12px',
    border: `1px solid ${theme.stroke}`,
    background: theme.bgPanel,
    color: theme.text,
    fontWeight: '700',
    boxShadow: theme.shadow,
    pointerEvents: 'auto',
    zIndex: '10000',
    transition: 'transform 120ms ease, box-shadow 120ms ease, background-color 120ms ease, border-color 120ms ease',

    // ✅ scale system
    transformOrigin: 'top right',
    transform: 'scale(var(--tools-scale))'
  });

  ui.toggleBtn.addEventListener('mouseenter', () => {
    // keep hover animation but preserve scale
    ui.toggleBtn.style.transform = 'translateY(-1px) scale(calc(var(--tools-scale) * 1.02))';
    ui.toggleBtn.style.background = theme.tealFaint;
    ui.toggleBtn.style.borderColor = theme.tealSoft ?? theme.teal;
  });
  ui.toggleBtn.addEventListener('mouseleave', () => {
    ui.toggleBtn.style.transform = 'scale(var(--tools-scale))';
    ui.toggleBtn.style.background = theme.bgPanel;
    ui.toggleBtn.style.borderColor = theme.stroke;
  });

  // Header button (Snapshot)
  ui.fitBtn = mkButton('Snapshot');
  Object.assign(ui.fitBtn.style, { padding: '6px 10px', borderRadius: '10px' });

  ui.header.appendChild(ui.title);
  ui.header.appendChild(ui.fitBtn);
  ui.dock.appendChild(ui.header);
  ui.dock.appendChild(ui.body);
  ui.root.appendChild(ui.dock);
  ui.root.appendChild(ui.toggleBtn);

  // Attach
  const host = (app?.renderer?.domElement?.parentElement) || document.body;
  host.appendChild(ui.root);

  // ---------- Controls ----------
  const renderModeSel = mkSelect(['Solid', 'Wireframe', 'X-Ray', 'Ghost'], 'Solid');

  // Explode (slider drives a smoothed spring tween; see ExplodeManager below)
  const explodeSlider = mkSlider(0, 1, 0.01, 0);

  // Section
  const axisSel = mkSelect(['X', 'Y', 'Z'], 'X');
  const secDist = mkSlider(-1, 1, 0.001, 0);
  const secEnable = mkToggle('Enable section');
  const secShowPlane = mkToggle('Show slice plane');

  // Views row (NO per-row Snapshot button)
  const rowCam = document.createElement('div');
  Object.assign(rowCam.style, { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '8px', margin: '8px 0' });
  const bIso = mkButton('Iso'), bTop = mkButton('Top'), bFront = mkButton('Front'), bRight = mkButton('Right');
  [bIso, bTop, bFront, bRight].forEach(b => { b.style.padding = '8px'; b.style.borderRadius = '10px'; });

  // Projection + Scene toggles
  const projSel = mkSelect(['Perspective', 'Orthographic'], 'Perspective');
  const togGrid = mkToggle('Grid');
  const togGround = mkToggle('Ground & shadows');
  const togAxes = mkToggle('XYZ axes');
  const togShowJoints = mkToggle('Show Joints');
  const togShowLoops = mkToggle('Show Loops');
  // Default OFF: mechanism overlays can be heavy/noisy on large assemblies.
  togShowJoints.cb.checked = false;
  togShowLoops.cb.checked = false;
  const mechRow = document.createElement('div');
  Object.assign(mechRow.style, {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '10px',
    alignItems: 'center',
    margin: '2px 0'
  });
  mechRow.appendChild(togShowJoints.wrap);
  mechRow.appendChild(togShowLoops.wrap);

  // Assemble rows
  ui.body.appendChild(mkRow('Render mode', renderModeSel));
  ui.body.appendChild(mkRow('Explode', explodeSlider));
  ui.body.appendChild(mkRow('Section axis', axisSel));
  ui.body.appendChild(mkRow('Section dist', secDist));
  ui.body.appendChild(mkRow('', secEnable.wrap));
  ui.body.appendChild(mkRow('', secShowPlane.wrap));
  ui.body.appendChild(mkRow('Views', rowCam));
  rowCam.appendChild(bIso); rowCam.appendChild(bTop); rowCam.appendChild(bFront); rowCam.appendChild(bRight);
  ui.body.appendChild(mkRow('Projection', projSel));
  ui.body.appendChild(mkRow('', togGrid.wrap));
  ui.body.appendChild(mkRow('', togGround.wrap));
  ui.body.appendChild(mkRow('', togAxes.wrap));
  ui.body.appendChild(mkRow('Mechanism', mechRow));

  // ---------- Logic ----------

  // ------------------ CONFIG ------------------
  // ✅ STEP behavior: hidden by translating to the right, then slide back to 0
  const CLOSED_TX = 560; // px, off-screen to the right
  let isOpen = false;

  // Prepare dock styles once
  Object.assign(ui.dock.style, {
    display: 'block',
    willChange: 'transform, opacity',
    transition: 'transform 260ms cubic-bezier(.2,.7,.2,1), opacity 200ms ease',
    // ✅ keep translateX + scale together
    transform: `translateX(${CLOSED_TX}px) scale(var(--tools-scale))`,
    opacity: '0',
    pointerEvents: 'none'
  });

  // ------------------ TWEEN LOGIC ------------------
  function set(open) {
    isOpen = open;

    if (open) {
      // OPEN tween
      ui.dock.style.opacity = '1';
      ui.dock.style.transform = `translateX(0) scale(var(--tools-scale))`;
      ui.dock.style.pointerEvents = 'auto';
      ui.toggleBtn.textContent = 'Close Tools';
      syncExplodeUI();
    } else {
      // CLOSE tween
      ui.dock.style.opacity = '0';
      ui.dock.style.transform = `translateX(${CLOSED_TX}px) scale(var(--tools-scale))`;
      ui.dock.style.pointerEvents = 'none';
      ui.toggleBtn.textContent = 'Open Tools';
    }
  }

  // Wrappers
  function openDock() { set(true); }
  function closeDock() { set(false); }

  // ------------------ EVENT ------------------
  ui.toggleBtn.addEventListener('click', () => set(!isOpen));

  // Snapshot (header only) — offscreen render target fallback (no preserveDrawingBuffer needed)
  ui.fitBtn.addEventListener('click', () => {
    const { renderer, scene, camera, composer } = app;

    const downloadURL = (url, isObjURL = false) => {
      const a = document.createElement('a');
      a.href = url;
      a.download = 'snapshot.png';
      document.body.appendChild(a);
      a.click();
      if (isObjURL) URL.revokeObjectURL(url);
      a.remove();
    };

    // fast path
    try {
      renderer.setRenderTarget(null);
      if (composer) composer.render(); else renderer.render(scene, camera);
      const url = renderer.domElement.toDataURL('image/png');
      downloadURL(url);
      return;
    } catch (e) {
      console.warn('[Snapshot] fast path failed, trying offscreen RT.', e);
    }

    // robust path
    try {
      const size = renderer.getSize(new THREE.Vector2());
      const dpr = renderer.getPixelRatio();
      const w = Math.max(1, Math.floor(size.x * dpr));
      const h = Math.max(1, Math.floor(size.y * dpr));

      const oldTarget = renderer.getRenderTarget();
      const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0 });
      renderer.setRenderTarget(rt);
      if (composer) composer.render(); else renderer.render(scene, camera);

      const buffer = new Uint8Array(w * h * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, w, h, buffer);

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.createImageData(w, h);

      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4;
        const dst = y * w * 4;
        imgData.data.set(buffer.subarray(src, src + w * 4), dst);
      }
      ctx.putImageData(imgData, 0, 0);

      canvas.toBlob((blob) => {
        if (!blob) {
          alert('Snapshot failed. Check CORS headers on textures/assets.');
          return;
        }
        downloadURL(URL.createObjectURL(blob), true);
      }, 'image/png');

      renderer.setRenderTarget(oldTarget);
      rt.dispose();
    } catch (e) {
      console.error('[Snapshot] offscreen capture failed:', e);
      alert('Snapshot error. Likely CORS-blocked textures. Ensure servers send Access-Control-Allow-Origin and loaders use crossOrigin="anonymous".');
    }
  });

  // Render mode
  renderModeSel.addEventListener('change', () => setRenderMode(renderModeSel.value));
  function setRenderMode(mode) {
    try { app.setRenderModeState?.(mode); } catch (_) { app.__currentRenderMode = mode || 'Solid'; }
    const root = app.robot || app.scene;
    if (!root) return;
    root.traverse(o => {
      if (o.isMesh && o.material && !o.userData?.__isHoverOverlay) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const logicallyHidden = o.visible === false || o.userData?.__automindVisibilityTarget === false;
        for (const m of mats) {
          if (!m) continue;
          m.wireframe = (mode === 'Wireframe');
          if ('toneMapped' in m) { try { m.toneMapped = false; } catch (_) {} }
          if ('blending' in m) { try { m.blending = THREE.NormalBlending; } catch (_) {} }
          if ('premultipliedAlpha' in m) { try { m.premultipliedAlpha = false; } catch (_) {} }
          if (m.map && m.color) {
            // BUILD163: do not wipe the DAE diffuse tint during render-mode changes.
            // Textured CAD parts often need material.color * texture to keep the
            // original red/black paint; forcing white made the scene look gray.
            try { if (!m.userData) m.userData = {}; if (!m.userData.__automindDiffusePreserved) m.userData.__automindDiffusePreserved = m.color.clone?.(); } catch (_) {}
          }
          if (logicallyHidden) {
            // Render-mode changes must not resurrect isolated/hidden parts.
            m.transparent = true; m.opacity = 0; m.depthWrite = false; m.depthTest = true;
          } else if (mode === 'X-Ray') {
            m.transparent = true; m.opacity = 0.35; m.depthWrite = false; m.depthTest = true;
          } else if (mode === 'Ghost') {
            m.transparent = true; m.opacity = 0.70; m.depthWrite = false; m.depthTest = true;
          } else {
            const hasAlpha = !!m.alphaMap || (Number.isFinite(m.alphaTest) && m.alphaTest > 0.001);
            m.transparent = hasAlpha ? !!m.transparent : false;
            m.opacity = 1.0; m.depthWrite = true; m.depthTest = true;
          }
          m.needsUpdate = true;
        }
      }
    });
    try { app.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  }

  // ============================================================
  // SECTION PLANE — ROBOT ONLY (FIX)
  // ============================================================
  let secEnabled = false, secPlaneVisible = false, secAxis = 'X';
  let sectionPlane = null, secVisual = null;

  // --- Helpers to apply clipping ONLY to robot meshes, without touching grid/ground/axes ---
  function traverseRobotMeshes(fn) {
    if (!app.robot) return;
    app.robot.traverse((o) => {
      if (!o || !o.isMesh || !o.geometry) return;
      if (o.userData && o.userData.__isHoverOverlay) return;
      fn(o);
    });
  }

  function setMaterialClipping(mat, plane) {
    if (!mat) return;
    mat.clippingPlanes = plane ? [plane] : null;
    // keep defaults sane
    mat.clipIntersection = false;
    mat.clipShadows = true;
    mat.needsUpdate = true;
  }

  // We avoid affecting shared materials by cloning robot materials once per mesh
  function ensureClippableMaterials(mesh) {
    if (!mesh || !mesh.material) return;
    if (mesh.userData && mesh.userData.__clipOriginalMaterial) return;

    const orig = mesh.material;
    mesh.userData ??= {};
    mesh.userData.__clipOriginalMaterial = orig;

    if (Array.isArray(orig)) {
      const clones = orig.map(m => (m && m.clone) ? m.clone() : m);
      mesh.userData.__clipClonedMaterial = clones;
    } else {
      mesh.userData.__clipClonedMaterial = (orig && orig.clone) ? orig.clone() : orig;
    }
  }

  function applyRobotOnlyClipping(plane) {
    // localClippingEnabled must be true for per-material clipping to work
    app.renderer.localClippingEnabled = true;

    // IMPORTANT: keep GLOBAL clipping planes empty so helpers are never clipped
    app.renderer.clippingPlanes = [];

    traverseRobotMeshes((mesh) => {
      ensureClippableMaterials(mesh);

      // switch robot mesh to its cloned materials (so shared materials won't affect helpers)
      if (mesh.userData && mesh.userData.__clipClonedMaterial) {
        mesh.material = mesh.userData.__clipClonedMaterial;
      }

      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const m of mats) setMaterialClipping(m, plane);
    });
  }

  function clearRobotOnlyClipping() {
    // restore original materials back to the robot meshes
    traverseRobotMeshes((mesh) => {
      if (mesh.userData && mesh.userData.__clipOriginalMaterial) {
        // clear clipping on cloned mats (optional, keeps state clean)
        const cm = mesh.userData.__clipClonedMaterial;
        const mats = Array.isArray(cm) ? cm : [cm];
        for (const m of mats) setMaterialClipping(m, null);

        mesh.material = mesh.userData.__clipOriginalMaterial;
      } else if (mesh.material) {
        // fallback: just clear clipping
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) setMaterialClipping(m, null);
      }
    });

    // disable clipping system
    app.renderer.clippingPlanes = [];
    app.renderer.localClippingEnabled = false;
  }

  function ensureSectionVisual() {
    if (secVisual) return secVisual;

    const THICK = 0.001;
    const geom = new THREE.BoxGeometry(1, 1, THICK);

    const makeMat = (side) => new THREE.MeshBasicMaterial({
      color: theme.teal,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      depthTest: true,
      toneMapped: false,
      premultipliedAlpha: true,
      side
    });

    const back = new THREE.Mesh(geom.clone(), makeMat(THREE.BackSide));
    const front = new THREE.Mesh(geom.clone(), makeMat(THREE.FrontSide));

    back.renderOrder = 9999;
    front.renderOrder = 10000;

    secVisual = new THREE.Group();
    secVisual.add(back, front);

    secVisual.visible = false;
    secVisual.renderOrder = 10000;
    secVisual.frustumCulled = false;

    app.scene.add(secVisual);
    return secVisual;
  }

  function refreshSectionVisual(maxDim, center) {
    if (!secVisual) return;
    const size = Math.max(1e-6, maxDim || 1);
    secVisual.scale.set(size * 1.2, size * 1.2, 1);
    if (center) secVisual.position.copy(center);
  }

  function updateSectionPlane() {
    // ALWAYS keep global clipping planes empty so grid/helpers are never clipped
    app.renderer.clippingPlanes = [];

    if (!secEnabled || !app.robot) {
      sectionPlane = null;
      try { app.sectionPlane = null; app.getSectionPlane = () => null; app.setMechanismClippingPlane?.(null); } catch (_) {}
      clearRobotOnlyClipping();
      if (secVisual) secVisual.visible = false;
      try { app.interaction?.clearHover?.(); app.interaction?.refreshSelectionMarker?.(); } catch (_) {}
      return;
    }

    const n = new THREE.Vector3(
      secAxis === 'X' ? 1 : 0,
      secAxis === 'Y' ? 1 : 0,
      secAxis === 'Z' ? 1 : 0
    );

    const box = new THREE.Box3().setFromObject(app.robot);
    if (box.isEmpty()) {
      sectionPlane = null;
      try { app.sectionPlane = null; app.getSectionPlane = () => null; app.setMechanismClippingPlane?.(null); } catch (_) {}
      clearRobotOnlyClipping();
      if (secVisual) secVisual.visible = false;
      try { app.interaction?.clearHover?.(); app.interaction?.refreshSelectionMarker?.(); } catch (_) {}
      return;
    }

    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const center = box.getCenter(new THREE.Vector3());

    const dist = (Number(secDist.value) || 0) * maxDim * 0.5;
    const plane = new THREE.Plane(n, -center.dot(n) - dist);

    sectionPlane = plane;
    try { app.sectionPlane = plane; app.getSectionPlane = () => sectionPlane; } catch (_) {}

    // ✅ APPLY CLIPPING TO ROBOT ONLY
    applyRobotOnlyClipping(plane);
    // Mechanism threads are helpers, not robot meshes, so they need their own
    // material clipping plane. This makes Show Joints/Show Loops get sliced by
    // the section plane exactly like the CAD geometry.
    try { app.setMechanismClippingPlane?.(plane); } catch (_) {}

    // Visual plane (never clipped because we do NOT use global clipping)
    ensureSectionVisual();
    refreshSectionVisual(maxDim, center);
    secVisual.visible = !!secPlaneVisible;

    // Orient the teal plane to match clipping plane normal
    const look = new THREE.Vector3().copy(n);
    const up = new THREE.Vector3(0, 1, 0);
    if (Math.abs(look.dot(up)) > 0.999) up.set(1, 0, 0);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(0, 0, 0), look, up);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    secVisual.setRotationFromQuaternion(q);
    const p0 = n.clone().multiplyScalar(-plane.constant);
    secVisual.position.copy(p0);

    // Clipping in Three.js happens in the material shader, but raycasting still
    // sees the original full geometry. Force interaction state to follow the
    // current section plane so hidden components are not hoverable/clickable.
    try { app.interaction?.clearHover?.(); app.interaction?.refreshSelectionMarker?.(); } catch (_) {}
  }

  axisSel.addEventListener('change', () => { secAxis = axisSel.value; updateSectionPlane(); });
  secDist.addEventListener('input', () => updateSectionPlane());
  secEnable.cb.addEventListener('change', () => { secEnabled = !!secEnable.cb.checked; updateSectionPlane(); });
  secShowPlane.cb.addEventListener('change', () => { secPlaneVisible = !!secShowPlane.cb.checked; updateSectionPlane(); });

  // ---------- Views (animated) ----------
  const easeInOutCubic = (t) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const dirFromAzEl = (az, el) => new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)).normalize();

  function currentAzEl(cam, target) {
    const v = cam.position.clone().sub(target);
    const len = Math.max(1e-9, v.length());
    return { el: Math.asin(v.y / len), az: Math.atan2(v.z, v.x), r: len };
  }

  let orbitTweenToken = 0;
  let orbitTweenRAF = 0;
  function angleDeltaShortest(a, b) {
    let d = (b - a + Math.PI) % (Math.PI * 2);
    if (d < 0) d += Math.PI * 2;
    return d - Math.PI;
  }
  function offsetToSpherical(v) {
    const r = Math.max(1e-9, v.length());
    return { r, az: Math.atan2(v.z, v.x), el: Math.asin(THREE.MathUtils.clamp(v.y / r, -1, 1)) };
  }
  function stopControlsInertia(ctrl) {
    if (!ctrl) return;
    try { ctrl._state = 0; } catch (_) {}
    try { ctrl._lastAngle = 0; } catch (_) {}
    try { ctrl._lastPan?.set?.(0, 0, 0); } catch (_) {}
    try { ctrl._lastDolly = 0; } catch (_) {}
    try { ctrl._lastZoom = 0; } catch (_) {}
    try { ctrl._lastAxis?.set?.(1, 0, 0); } catch (_) {}
  }

  function tweenOrbits(cam, ctrl, toPos, toTarget = null, ms = 700) {
    const token = ++orbitTweenToken;
    if (orbitTweenRAF) { try { cancelAnimationFrame(orbitTweenRAF); } catch (_) {} orbitTweenRAF = 0; }
    stopControlsInertia(ctrl);

    const startPos = cam.position.clone();
    const startTarget = ctrl.target.clone();
    const endTarget = (toTarget || startTarget).clone();
    const startS = offsetToSpherical(startPos.clone().sub(startTarget));
    const endS = offsetToSpherical(toPos.clone().sub(endTarget));
    const dAz = angleDeltaShortest(startS.az, endS.az);
    let tStart = null;

    ctrl.enabled = false;
    cam.up.set(0, 1, 0);
    cam.position.copy(startPos);
    ctrl.target.copy(startTarget);
    try { cam.lookAt(startTarget); } catch (_) {}
    try { app.renderer.render(app.scene, cam); } catch (_) {}

    function step(t) {
      if (token !== orbitTweenToken) return;
      if (tStart == null) tStart = t;
      const u = Math.min(1, (t - tStart) / Math.max(1, ms));
      const e = easeInOutCubic(u);

      const target = startTarget.clone().lerp(endTarget, e);
      const az = startS.az + dAz * e;
      const el = THREE.MathUtils.lerp(startS.el, endS.el, e);
      const r = THREE.MathUtils.lerp(startS.r, endS.r, e);
      const dir = new THREE.Vector3(
        Math.cos(el) * Math.cos(az),
        Math.sin(el),
        Math.cos(el) * Math.sin(az)
      ).normalize();

      cam.position.copy(target).addScaledVector(dir, r);
      ctrl.target.copy(target);
      ctrl.update();
      try { app.renderer.render(app.scene, cam); } catch (_) {}

      if (u < 1) orbitTweenRAF = requestAnimationFrame(step);
      else if (token === orbitTweenToken) { orbitTweenRAF = 0; stopControlsInertia(ctrl); ctrl.enabled = true; }
    }
    orbitTweenRAF = requestAnimationFrame(step);
  }

  // Store default distance once (at init)
  let DEFAULT_RADIUS = null;

  function initDefaultRadius(app_) {
    const cam = app_.camera, ctrl = app_.controls, t = ctrl.target.clone();
    const cur = currentAzEl(cam, t);
    DEFAULT_RADIUS = cur.r;
  }

  function getRobotFitSphere(app_) {
    const root = app_.robot || app_.scene;
    if (!root) return null;
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = size.length() * 0.5 * (1 / Math.sqrt(3));
    return { center, size, radius };
  }

  function distanceToFitSphere(cam, radius, pad = 3) {
    const r = Math.max(1e-6, radius) * pad;

    if (cam.isOrthographicCamera) {
      return THREE.MathUtils.clamp(r * 2.0, 0.25, 1e6);
    }

    const vFov = THREE.MathUtils.degToRad(cam.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov * 0.5) * (cam.aspect || 1));
    const dV = r / Math.tan(vFov * 0.5);
    const dH = r / Math.tan(hFov * 0.5);
    return Math.max(dV, dH);
  }

  const AUTO_RADIUS_MIN = 0.35;
  const AUTO_RADIUS_MAX = 1e4;

  function getActiveFitSphere(app_) {
    try {
      const focused = app_?.getCurrentViewFitSphere?.();
      if (focused && focused.center && focused.size && Number.isFinite(focused.radius)) return focused;
    } catch (_) {}
    return getRobotFitSphere(app_);
  }

  function viewEndPose(kind) {
    const cam = app.camera, ctrl = app.controls;
    const s = getActiveFitSphere(app);
    const target = s ? s.center.clone() : ctrl.target.clone();

    const curVec = cam.position.clone().sub(target);
    const len = Math.max(1e-9, curVec.length());
    const cur = { el: Math.asin(curVec.y / len), az: Math.atan2(curVec.z, curVec.x) };

    let az = cur.az, el = cur.el;
    const topEps = 1e-3;
    if (kind === 'iso') { az = Math.PI * 0.25; el = Math.PI * 0.20; }
    if (kind === 'top') { az = Math.round(cur.az / (Math.PI / 2)) * (Math.PI / 2); el = Math.PI / 2 - topEps; }
    if (kind === 'front') { az = Math.PI / 2; el = 0; }
    if (kind === 'right') { az = 0; el = 0; }

    let fitR = 4;
    if (s) {
      fitR = distanceToFitSphere(cam, s.radius, 3);
      fitR = THREE.MathUtils.clamp(fitR, AUTO_RADIUS_MIN, AUTO_RADIUS_MAX);
      if (cam.isOrthographicCamera) {
        const aspect = Math.max(1e-6, (app.renderer?.domElement?.clientWidth || 1) / (app.renderer?.domElement?.clientHeight || 1));
        const halfH = Math.max((s.radius || 1) * 2.85, 1e-6);
        cam.left = -halfH * aspect;
        cam.right = halfH * aspect;
        cam.top = halfH;
        cam.bottom = -halfH;
        cam.zoom = 1;
        const depth = Math.max((s.radius || 1) * 80, 1000);
        cam.near = -depth;
        cam.far = depth;
        cam.updateProjectionMatrix();
        fitR = Math.max((s.radius || 1) * 6, 1.0);
      }
    }

    const dir = new THREE.Vector3(
      Math.cos(el) * Math.cos(az),
      Math.sin(el),
      Math.cos(el) * Math.sin(az)
    ).normalize();

    const pos = target.clone().add(dir.multiplyScalar(fitR));
    return { pos, target };
  }

  const bIsoEl = rowCam.children[0], bTopEl = rowCam.children[1], bFrontEl = rowCam.children[2], bRightEl = rowCam.children[3];
  const to = (kind) => viewEndPose(kind);

  function runViewPreset(kind) {
    // URDF+ exposes the authoritative view tween, so Show all and Iso are bit-for-bit
    // the same final camera motion. Plain URDF keeps this ToolsDock fallback.
    if (typeof app.viewPreset === 'function') {
      try { if (app.viewPreset(kind, 780)) return; } catch (_) {}
    }
    const v = to(kind);
    tweenOrbits(app.camera, app.controls, v.pos, v.target, 780);
  }

  bIsoEl.addEventListener('click', () => runViewPreset('iso'));
  bTopEl.addEventListener('click', () => runViewPreset('top'));
  bFrontEl.addEventListener('click', () => runViewPreset('front'));
  bRightEl.addEventListener('click', () => runViewPreset('right'));

  // ---------- Projection ----------
  projSel.addEventListener('change', () => {
    const mode = projSel.value === 'Orthographic' ? 'Orthographic' : 'Perspective';
    try { app.setProjection?.(mode); } catch (_) {}
  });

  // ---------- Scene toggles ----------
  togGrid.cb.addEventListener('change', () => app.setSceneToggles?.({ grid: !!togGrid.cb.checked }));
  togGround.cb.addEventListener('change', () => app.setSceneToggles?.({ ground: !!togGround.cb.checked, shadows: !!togGround.cb.checked }));
  togAxes.cb.addEventListener('change', () => app.setSceneToggles?.({ axes: !!togAxes.cb.checked }));
  togShowJoints.cb.addEventListener('change', () => {
    app.setMechanismToggles?.({ jointAxes: !!togShowJoints.cb.checked });
  });
  togShowLoops.cb.addEventListener('change', () => {
    app.setMechanismToggles?.({ loops: !!togShowLoops.cb.checked });
  });
  // Apply initial checkbox state after the robot/decorations already exist.
  setTimeout(() => {
    try { app.setMechanismToggles?.({ jointAxes: !!togShowJoints.cb.checked, loops: !!togShowLoops.cb.checked }); } catch (_) {}
  }, 0);

  // ============================================================
  // EXPLODE MANAGER (kept as-is except a tiny bugfix: amount() must be inside manager)
  // ============================================================
  function makeExplodeManager() {
    const registry = [];
    const marker = new WeakSet();
    let maxDim = 1;
    let prepared = false;

    let current = 0;
    let target = 0;
    let vel = 0;
    let raf = null;
    let lastT = 0;
    const stiffness = 18;
    const damping = 2 * Math.sqrt(stiffness);

    let zeroSince = null;

    function amount() {
      return current;
    }

    function worldDirToParentLocal(parent, dirWorld) {
      const m = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      const n = new THREE.Matrix3().setFromMatrix4(m);
      return dirWorld.clone().applyMatrix3(n).normalize();
    }

    function chooseTopPartFor(mesh) {
      // BUILD157: URDF+ nests real component meshes under link -> visual:<link> -> DAE scene.
      // The old explode only moved direct children of app.robot, so a complete URDF+
      // tree often exploded as one rigid clump, or only partially. Prefer the nearest
      // visual root for URDF/URDF+ so each link's visible geometry separates cleanly,
      // while preserving the old direct-child behavior for the regular USD/URDF viewer.
      let n = mesh;
      let visualRoot = null;
      let assetRoot = null;
      let linkRoot = null;
      let directRobotChild = null;

      while (n && n !== app.robot) {
        const name = String(n.name || '');
        const ud = n.userData || {};

        if (marker.has(n)) return n;

        if (!visualRoot && /^visual:/i.test(name)) visualRoot = n;
        if (!assetRoot && !n.isMesh && (ud.__assetKey || ud.__assetName || ud.assetKey)) assetRoot = n;
        if (!linkRoot && !n.isMesh && ud.__linkName) linkRoot = n;
        if (n.parent === app.robot) directRobotChild = n;

        n = n.parent;
      }

      // Moving visualRoot avoids double-transforming descendant link frames in URDF+.
      // If there is no explicit visual group, fall back to the previous behavior.
      return visualRoot || assetRoot || directRobotChild || linkRoot || mesh.parent || mesh;
    }

    function computeBounds() {
      const box = new THREE.Box3().setFromObject(app.robot);
      if (box.isEmpty()) return null;
      return { center: box.getCenter(new THREE.Vector3()), size: box.getSize(new THREE.Vector3()) };
    }

    function prepare() {
      registry.length = 0;
      if (!app.robot) { prepared = false; return; }

      const R = computeBounds();
      if (!R) { prepared = false; return; }
      maxDim = Math.max(R.size.x, R.size.y, R.size.z) || 1;

      const parts = new Set();
      const seen = new WeakSet();
      app.robot.traverse((o) => {
        if (o.isMesh && o.geometry && o.visible && !o.userData.__isHoverOverlay) {
          const top = chooseTopPartFor(o);
          if (!seen.has(top)) { parts.add(top); seen.add(top); marker.add(top); }
        }
      });

      parts.forEach((node) => {
        const parent = node.parent || app.robot;
        const baseLocal = node.position.clone();

        const box = new THREE.Box3().setFromObject(node);
        if (box.isEmpty()) return;
        const cWorld = box.getCenter(new THREE.Vector3());
        const dirWorld = cWorld.sub(R.center).normalize();
        if (!isFinite(dirWorld.x + dirWorld.y + dirWorld.z)) return;

        const dirLocal = worldDirToParentLocal(parent, dirWorld);
        if (!isFinite(dirLocal.x + dirLocal.y + dirLocal.z) || dirLocal.lengthSq() < 1e-12) {
          dirLocal.set((Math.random() * 2 - 1), (Math.random() * 2 - 1), (Math.random() * 2 - 1)).normalize();
        }

        registry.push({ node, parent, baseLocal, dirLocal });
      });

      prepared = true;
      zeroSince = performance.now();
    }

    function applyAmount(a01) {
      if (!prepared) prepare();
      const f = Math.max(0, Math.min(1, a01 || 0));
      const maxOffset = maxDim * 0.82;

      for (const rec of registry) {
        const { node, baseLocal, dirLocal } = rec;
        node.position.copy(baseLocal).addScaledVector(dirLocal, f * maxOffset);
      }

      updateSectionPlane?.();
      try { app.interaction?.refreshSelectionMarker?.(); } catch (_) {}
      try { app.controls?.update?.(); app.renderer?.render?.(app.scene, app.camera); } catch (_) {}
    }

    function tickSpring(now) {
      if (!lastT) lastT = now;
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;

      const x = current, v = vel, xT = target;
      const a = stiffness * (xT - x) - damping * v;
      vel = v + a * dt;
      current = x + vel * dt;

      if (Math.abs(current - target) < 0.0005 && Math.abs(vel) < 0.0005) {
        current = target; vel = 0;
      }

      applyAmount(current);

      if (current === 0) {
        zeroSince ??= now;
        if (now - zeroSince > 300) {
          const keepTarget = target;
          prepare();
          applyAmount(current);
          target = keepTarget;
          zeroSince = now;
        }
      } else {
        zeroSince = null;
      }

      if (current !== target || vel !== 0) {
        raf = requestAnimationFrame(tickSpring);
      } else {
        raf = null;
      }
    }

    function setTarget(a01) {
      target = Math.max(0, Math.min(1, Number(a01) || 0));
      if (!prepared) prepare();
      if (!raf) { lastT = 0; raf = requestAnimationFrame(tickSpring); }
    }

    function immediate(a01) {
      target = current = Math.max(0, Math.min(1, Number(a01) || 0));
      vel = 0;
      if (!prepared) prepare();
      applyAmount(current);
    }

    function recalibrate() {
      prepare();
      applyAmount(current);
    }

    function destroy() {
      if (raf) cancelAnimationFrame(raf);
      raf = null;
    }

    return { prepare, setTarget, immediate, recalibrate, destroy, amount };
  }

  const explode = makeExplodeManager();
  try { app.explodeRecalibrate = () => explode.recalibrate(); } catch (_) {}

  explodeSlider.addEventListener('input', () => {
    explode.setTarget(Number(explodeSlider.value) || 0);
  });

  function syncExplodeUI() {
    try {
      const a = explode.amount();
      if (!Number.isNaN(a)) explodeSlider.value = String(Math.max(0, Math.min(1, a)));
    } catch { }
  }

  // Defaults
  togGrid.cb.checked = false;
  togGround.cb.checked = false;
  togAxes.cb.checked = false;

  // Start closed
  set(false);

  function onHotkeyH(e) {
    const tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.isComposing) return;

    if (e.key === 't' || e.key === 'T' || e.code === 'KeyT') {
      e.preventDefault();
      try { console.log('pressed t'); } catch { }
      set(!isOpen);
    }
  }
  document.addEventListener('keydown', onHotkeyH, true);

  // Public API
  function destroy() {
    try { ui.toggleBtn.remove(); } catch (_) { }
    try { ui.dock.remove(); } catch (_) { }
    try { ui.root.remove(); } catch (_) { }

    try {
      // ensure we restore robot materials and disable clipping
      clearRobotOnlyClipping();
      if (secVisual) app.scene.remove(secVisual);
    } catch (_) { }

    explode.destroy();
    document.removeEventListener('keydown', onHotkeyH, true);
  }

  return { open: openDock, close: closeDock, set, destroy };
}
