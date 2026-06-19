// /viewer/core/ViewerCore.js
// Three.js r132 compatible core for a URDF viewer
// Exports: createViewer({ container, background, pixelRatio })

/* global THREE, URDFLoader */

function assertThree() {
  if (typeof THREE === 'undefined') {
    throw new Error('[ViewerCore] THREE is not defined. Load three.js before ViewerCore.js');
  }
  if (typeof URDFLoader === 'undefined') {
    throw new Error('[ViewerCore] URDFLoader is not defined. Load urdf-loader UMD before ViewerCore.js');
  }
}

/** Minor math helpers */
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** Ensure meshes are double-sided and shadows off by default */
function applyDoubleSided(root) {
  root?.traverse?.(n => {
    if (n.isMesh && n.geometry) {
      if (Array.isArray(n.material)) n.material.forEach(m => (m.side = THREE.DoubleSide));
      else if (n.material) n.material.side = THREE.DoubleSide;
      n.castShadow = true;
      n.receiveShadow = true;
      n.geometry.computeVertexNormals?.();
    }
  });
}

/** Many URDF assets come Z-up; we rectify to Y-up (Three default) once. */
function rectifyUpForward(obj) {
  if (!obj || obj.userData.__rectified) return;
  obj.rotateX(-Math.PI / 2);
  obj.userData.__rectified = true;
  obj.updateMatrixWorld(true);
}

/** Compute a padded bounding box for an object */
function getObjectBounds(object, pad = 1.0) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).multiplyScalar(pad);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  return { box, center, size, maxDim };
}

/** Fit an object to the given camera+controls */
function fitAndCenter(camera, controls, object, pad = 1.08) {
  const b = getObjectBounds(object, pad);
  if (!b) return false;

  const { center, maxDim } = b;

  if (camera.isPerspectiveCamera) {
    // distance heuristic robust across FOVs
    const fov = (camera.fov || 60) * Math.PI / 180;
    const dist = maxDim / Math.tan(Math.max(1e-6, fov / 2));
    camera.near = Math.max(maxDim / 1000, 0.001);
    camera.far = Math.max(maxDim * 1500, 1500);
    camera.updateProjectionMatrix();
    // keep direction (if any); otherwise use iso-ish
    const dir = camera.position.clone().sub(controls.target || new THREE.Vector3()).normalize();
    if (!isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-10) {
      dir.set(1, 0.7, 1).normalize();
    }
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
  } else if (camera.isOrthographicCamera) {
    // set ortho frustum around object (and at least around grid size 10 => half 5)
    const aspect = Math.max(1e-6, (controls?.domElement?.clientWidth || 1) / (controls?.domElement?.clientHeight || 1));
    const minSpan = 5 * Math.SQRT2;
    const span = Math.max(maxDim, minSpan);
    camera.left = -span * aspect;
    camera.right = span * aspect;
    camera.top = span;
    camera.bottom = -span;
    camera.near = Math.max(maxDim / 1000, 0.001);
    camera.far = Math.max(maxDim * 1500, 1500);
    camera.updateProjectionMatrix();
    camera.position.copy(center.clone().add(new THREE.Vector3(maxDim, maxDim * 0.9, maxDim)));
  }

  controls.target.copy(center);
  controls.update();
  return true;
}

/** Build ground, grid, axes helpers (hidden by default) */
function buildHelpers() {
  const group = new THREE.Group();

  // Grid (teal-ish defaults; can be recolored by UI later)
  const grid = new THREE.GridHelper(10, 20, 0x0ea5a6, 0x14b8b9);
  grid.visible = false;
  group.add(grid);

  // Ground (only useful if shadows are enabled)
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.25 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
  groundMat.depthWrite = false; // IMPORTANT: prevents “cutting” artifacts with transparent modes + shadows
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.0001;
  ground.receiveShadow = false;
  ground.visible = false;
  group.add(ground);

  // Axes
  const axes = new THREE.AxesHelper(1);
  axes.visible = false;
  group.add(axes);

  return { group, grid, ground, axes };
}

/**
 * Minimal TrackballControls (UMD-friendly) to allow full 360° rotation in any direction,
 * while keeping the SAME “smooth” feel (inertia) for rotate + pan + zoom.
 * API surface used by this project:
 *  - controls.object
 *  - controls.domElement
 *  - controls.enabled
 *  - controls.target (THREE.Vector3)
 *  - controls.update()
 *  - controls.handleResize() (optional)
 */
class TrackballControls {
  constructor(object, domElement) {
    this.object = object;
    this.domElement = domElement;

    this.enabled = true;

    this.rotateSpeed = 4.0;
    this.zoomSpeed = 1.2;
    this.panSpeed = 0.8;

    // If false -> inertia after releasing pointer (smooth)
    this.staticMoving = false;
    this.dynamicDampingFactor = 0.15;

    this.target = new THREE.Vector3();

    this._state = 0; // 0 none, 1 rotate, 2 zoom, 3 pan
    this._rect = null;

    this._start = new THREE.Vector2();
    this._end = new THREE.Vector2();

    this._pointerId = null;

    // inertia (rotate + pan + zoom)
    this._lastAxis = new THREE.Vector3(1, 0, 0);
    this._lastAngle = 0;
    this._lastPan = new THREE.Vector3(0, 0, 0);
    this._lastDolly = 0;

    this._onContextMenu = (e) => e.preventDefault();

    this._onWheel = (e) => {
      if (!this.enabled) return;
      e.preventDefault();

      // FIX: wheel was inverted — invert delta so it matches the original feel
      const delta = -(e.deltaY || 0);

      this._dolly(delta);
      this.update();
    };

    this._onPointerDown = (e) => {
      if (!this.enabled) return;
      if (this._pointerId !== null) return;
      this._pointerId = e.pointerId;

      // match common CAD defaults: L=rotate, M=zoom, R=pan
      this._state = (e.button === 0) ? 1 : (e.button === 1) ? 2 : 3;

      this._start.set(e.clientX, e.clientY);
      this._end.copy(this._start);

      // stop inertia when user re-engages
      this._lastAngle = 0;
      this._lastPan.set(0, 0, 0);
      this._lastDolly = 0;

      try { this.domElement.setPointerCapture(e.pointerId); } catch (_) {}
      window.addEventListener('pointermove', this._onPointerMove, true);
      window.addEventListener('pointerup', this._onPointerUp, true);
    };

    this._onPointerMove = (e) => {
      if (!this.enabled) return;
      if (this._pointerId !== e.pointerId) return;

      this._end.set(e.clientX, e.clientY);

      if (this._state === 1) {
        this._rotate(this._start, this._end);
      } else if (this._state === 2) {
        const dy = (this._end.y - this._start.y);
        // Keep zoom drag consistent with wheel (up = zoom in)
        this._dolly(-dy * 4);
      } else if (this._state === 3) {
        this._pan(this._start, this._end);
      }

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

  handleResize() {
    this._rect = this.domElement.getBoundingClientRect();
  }

  update() {
    // apply inertia (smooth) after release — rotate + pan + zoom
    if (!this.staticMoving && this._state === 0) {

      // ROTATE inertia
      if (Math.abs(this._lastAngle) > 1e-6) {
        this._applyRotation(this._lastAxis, this._lastAngle);
        this._lastAngle *= (1.0 - this.dynamicDampingFactor);
        if (Math.abs(this._lastAngle) < 1e-6) this._lastAngle = 0;
      }

      // PAN inertia
      if (this._lastPan.lengthSq() > 1e-12) {
        this.object.position.add(this._lastPan);
        this.target.add(this._lastPan);

        this._lastPan.multiplyScalar(1.0 - this.dynamicDampingFactor);
        if (this._lastPan.lengthSq() < 1e-12) this._lastPan.set(0, 0, 0);
      }

      // ZOOM inertia
      if (Math.abs(this._lastDolly) > 1e-6) {
        this._dolly(this._lastDolly);
        this._lastDolly *= (1.0 - this.dynamicDampingFactor);
        if (Math.abs(this._lastDolly) < 1e-6) this._lastDolly = 0;
      }
    }

    this.object.lookAt(this.target);
  }

  _getRect() {
    if (!this._rect) this.handleResize();
    return this._rect;
  }

  _getNDC(clientX, clientY) {
    const r = this._getRect();
    const x = (clientX - r.left) / Math.max(1, r.width);
    const y = (clientY - r.top) / Math.max(1, r.height);
    return new THREE.Vector2(x * 2 - 1, -(y * 2 - 1));
  }

  _projectOnSphere(ndc) {
    const v = new THREE.Vector3(ndc.x, ndc.y, 0);
    const d2 = v.x * v.x + v.y * v.y;
    if (d2 <= 1.0) {
      v.z = Math.sqrt(1.0 - d2);
    } else {
      v.normalize();
      v.z = 0.0;
    }
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
    let angle = Math.acos(dot) * this.rotateSpeed;

    // dragging right should feel like model rotates “with” the drag (CAD-like)
    angle = -angle;

    // axis in world space
    const axisWorld = axisCam.clone().applyQuaternion(this.object.quaternion).normalize();

    this._applyRotation(axisWorld, angle);

    // inertia seed
    this._lastAxis.copy(axisWorld);
    this._lastAngle = angle;
  }

  _dolly(delta) {
    const zoomFactor = Math.pow(0.95, (delta * this.zoomSpeed) * 0.01);

    if (this.object.isPerspectiveCamera) {
      const eye = this.object.position.clone().sub(this.target);
      const newLen = Math.max(1e-6, eye.length() * zoomFactor);
      eye.setLength(newLen);
      this.object.position.copy(this.target.clone().add(eye));
    } else if (this.object.isOrthographicCamera) {
      this.object.zoom = Math.max(1e-3, this.object.zoom / zoomFactor);
      this.object.updateProjectionMatrix();
    }

    // inertia seed
    this._lastDolly = delta;
  }

  _pan(startPx, endPx) {
    const r = this._getRect();
    const dx = (endPx.x - startPx.x);
    const dy = (endPx.y - startPx.y);

    const h = Math.max(1, r.height);

    let scale = 1.0;
    if (this.object.isPerspectiveCamera) {
      const eye = this.object.position.clone().sub(this.target);
      const dist = eye.length();
      const fov = (this.object.fov || 60) * Math.PI / 180;
      const worldPerPixel = 2 * dist * Math.tan(fov / 2) / h;
      scale = worldPerPixel;
    } else if (this.object.isOrthographicCamera) {
      const worldPerPixel = (this.object.top - this.object.bottom) / h;
      scale = worldPerPixel;
    }

    const panX = -dx * scale * this.panSpeed;
    const panY = dy * scale * this.panSpeed;

    const te = this.object.matrix.elements;
    const xAxis = new THREE.Vector3(te[0], te[1], te[2]);
    const yAxis = new THREE.Vector3(te[4], te[5], te[6]);

    const pan = xAxis.multiplyScalar(panX).add(yAxis.multiplyScalar(panY));

    this.object.position.add(pan);
    this.target.add(pan);

    // inertia seed
    this._lastPan.copy(pan);
  }
}

export function createViewer({ container, background = 0xffffff, pixelRatio } = {}) {
  assertThree();

  const rootEl = container || document.body;
  if (getComputedStyle(rootEl).position === 'static') {
    rootEl.style.position = 'relative';
  }

  // Scene
  const scene = new THREE.Scene();
  if (background === null || typeof background === 'undefined') {
    scene.background = null;
  } else {
    scene.background = new THREE.Color(background);
  }

  // Cameras
  const aspect = Math.max(1e-6, (rootEl.clientWidth || 1) / (rootEl.clientHeight || 1));
  const persp = new THREE.PerspectiveCamera(75, aspect, 0.01, 10000);
  persp.position.set(0, 0, 3);

  const orthoSize = 2.5;
  const ortho = new THREE.OrthographicCamera(
    -orthoSize * aspect, orthoSize * aspect,
    orthoSize, -orthoSize,
    0.01, 10000
  );
  ortho.position.set(0, 0, 3);

  let camera = persp;

  // Renderer
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: false
  });
  renderer.setPixelRatio(pixelRatio || window.devicePixelRatio || 1);
  renderer.setSize(rootEl.clientWidth || 1, rootEl.clientHeight || 1);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.touchAction = 'none';
  rootEl.appendChild(renderer.domElement);

  // Shadows OFF by default
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  // Controls
  const controls = new TrackballControls(camera, renderer.domElement);
  controls.rotateSpeed = 4.0;
  controls.zoomSpeed = 1.4;
  controls.panSpeed = 0.8;
  controls.staticMoving = false;
  controls.dynamicDampingFactor = 0.15;

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0xcfeeee, 0.7);
  const dir = new THREE.DirectionalLight(0xffffff, 1.05);
  dir.position.set(3, 4, 2);
  dir.castShadow = false;
  dir.shadow.mapSize.set(2048, 2048);
  dir.shadow.camera.near = 0.1;
  dir.shadow.camera.far = 1000;
  scene.add(hemi);
  scene.add(dir);

  // Helpers
  const helpers = buildHelpers();
  scene.add(helpers.group);

  function sizeAxesHelper(maxDim, center) {
    helpers.axes.scale.setScalar(maxDim * 0.75);
    helpers.axes.position.copy(center || new THREE.Vector3());
  }

  // Handle resizes
  function onResize() {
    const w = rootEl.clientWidth || 1;
    const h = rootEl.clientHeight || 1;
    const asp = Math.max(1e-6, w / h);
    if (camera.isPerspectiveCamera) {
      camera.aspect = asp;
    } else {
      const size = Math.abs(camera.top) || orthoSize;
      camera.left = -size * asp;
      camera.right = size * asp;
      camera.top = size;
      camera.bottom = -size;
    }
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (controls && typeof controls.handleResize === 'function') controls.handleResize();
  }
  window.addEventListener('resize', onResize);

  // URDF loader & current robot
  const urdfLoader = new URDFLoader();
  let robotModel = null;

  /** Load URDF content (string) with an external loadMeshCb(path, manager, onComplete) */
  function loadURDF(urdfText, { loadMeshCb } = {}) {
    if (robotModel) {
      try { scene.remove(robotModel); } catch (_) {}
      robotModel = null;
    }
    if (!urdfText || typeof urdfText !== 'string') return null;

    if (typeof loadMeshCb === 'function') {
      urdfLoader.loadMeshCb = loadMeshCb;
    }

    let robot = null;
    try {
      robot = urdfLoader.parse(urdfText);
    } catch (e) {
      console.warn('[ViewerCore] URDF parse error:', e);
      return null;
    }

    if (robot && robot.isObject3D) {
      robotModel = robot;
      scene.add(robotModel);
      rectifyUpForward(robotModel);
      applyDoubleSided(robotModel);

      // First fit
      setTimeout(() => {
        if (!robotModel) return;
        const ok = fitAndCenter(camera, controls, robotModel, 1.06);
        if (ok) {
          const b = getObjectBounds(robotModel);
          if (b) sizeAxesHelper(b.maxDim, b.center);
        }
      }, 50);
    }
    return robotModel;
  }

  /** Switch projection mode (Perspective|Orthographic) while preserving view as much as possible */
  function setProjection(mode = 'Perspective') {
    const w = rootEl.clientWidth || 1, h = rootEl.clientHeight || 1;
    const asp = Math.max(1e-6, w / h);

    if (mode === 'Orthographic' && camera.isPerspectiveCamera) {
      const t = controls.target.clone();
      const v = camera.position.clone().sub(t);
      const dist = v.length();
      const dirN = v.clone().normalize();

      const b = robotModel ? getObjectBounds(robotModel, 1.0) : null;
      const minSpan = 5 * Math.SQRT2; // ensures grid size 10 never clips
      const span = Math.max(orthoSize, (b ? b.maxDim : 0), minSpan);

      ortho.left = -span * asp;
      ortho.right = span * asp;
      ortho.top = span;
      ortho.bottom = -span;
      ortho.near = Math.max(0.001, dist * 0.01);
      ortho.far = Math.max(1000, dist * 50);
      ortho.position.copy(t.clone().add(dirN.multiplyScalar(dist)));
      ortho.updateProjectionMatrix();

      controls.object = ortho;
      camera = ortho;
      controls.target.copy(t);
      controls.update();
    } else if (mode === 'Perspective' && camera.isOrthographicCamera) {
      const t = controls.target.clone();
      const v = camera.position.clone().sub(t);
      const dist = v.length();
      const dirN = v.clone().normalize();

      persp.aspect = asp;
      persp.near = Math.max(0.001, dist * 0.01);
      persp.far = Math.max(1000, dist * 50);
      persp.position.copy(t.clone().add(dirN.multiplyScalar(dist)));
      persp.updateProjectionMatrix();

      controls.object = persp;
      camera = persp;
      controls.target.copy(t);
      controls.update();
    }
  }

  /** Toggle helpers and shadows from upper layers (UI) */
  function setSceneToggles({ grid, ground, axes, shadows } = {}) {
    if (typeof grid === 'boolean') helpers.grid.visible = grid;
    if (typeof ground === 'boolean') helpers.ground.visible = ground;

    if (typeof axes === 'boolean') helpers.axes.visible = axes;

    if (typeof shadows === 'boolean') {
      renderer.shadowMap.enabled = !!shadows;
      dir.castShadow = !!shadows;
      if (robotModel) {
        robotModel.traverse(o => {
          if (o.isMesh && o.geometry) {
            o.castShadow = !!shadows;
            o.receiveShadow = !!shadows;
          }
        });
      }
    }
    // Resize axes to object
    if (helpers.axes.visible && robotModel) {
      const b = getObjectBounds(robotModel);
      if (b) sizeAxesHelper(b.maxDim, b.center);
    }
  }

  /** Set background (int color) or null for transparent */
  function setBackground(colorIntOrNull) {
    if (colorIntOrNull === null || typeof colorIntOrNull === 'undefined') {
      scene.background = null;
    } else {
      scene.background = new THREE.Color(colorIntOrNull);
    }
  }

  /** Allow upper layer to adjust pixel ratio (e.g., for performance) */
  function setPixelRatio(r) {
    const pr = Math.max(0.5, Math.min(3, r || window.devicePixelRatio || 1));
    renderer.setPixelRatio(pr);
    onResize();
  }

  // Animation loop
  let raf = null;
  let paused = false;
  function setPaused(v) { paused = !!v; }
  function animate() {
    raf = requestAnimationFrame(animate);
    controls.update();
    if (!paused) renderer.render(scene, camera);
  }
  animate();

  // Cleanup
  function destroy() {
    try { cancelAnimationFrame(raf); } catch (_) {}
    try { window.removeEventListener('resize', onResize); } catch (_) {}
    try {
      const el = renderer?.domElement;
      if (el && el.parentNode) el.parentNode.removeChild(el);
    } catch (_) {}
    try { renderer?.dispose?.(); } catch (_) {}
  }

  // Public facade
  return {
    // Core Three.js objects
    scene,
    get camera() { return camera; },
    renderer,
    controls,

    // Helpers group (in case UI needs references)
    helpers,

    // Current robot getter
    get robot() { return robotModel; },

    // APIs
    setPaused,
    loadURDF,
    fitAndCenter: (obj, pad) => fitAndCenter(camera, controls, obj || robotModel, pad),
    setProjection,
    setSceneToggles,
    setBackground,
    setPixelRatio,
    onResize,
    destroy
  };
}
