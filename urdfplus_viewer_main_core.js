function assertThree() {
    if (typeof THREE === 'undefined') {
        throw new Error('[ViewerCore] THREE is not defined. Load three.js before ViewerCore.js');
    }
    if (typeof URDFLoader === 'undefined') {
        throw new Error('[ViewerCore] URDFLoader is not defined. Load urdf-loader UMD before ViewerCore.js');
    }
}
const clamp01 = (x) => Math.max(0, Math.min(1, x));
function applyDoubleSided(root) {
    root?.traverse?.(n => {
        if (n.isMesh && n.geometry) {
            if (Array.isArray(n.material))
                n.material.forEach(m => (m.side = THREE.DoubleSide));
            else if (n.material)
                n.material.side = THREE.DoubleSide;
            n.castShadow = true;
            n.receiveShadow = true;
            n.geometry.computeVertexNormals?.();
        }
    });
}
function rectifyUpForward(obj) {
    if (!obj || obj.userData.__rectified)
        return;
    obj.rotateX(-Math.PI / 2);
    obj.userData.__rectified = true;
    obj.updateMatrixWorld(true);
}
function getObjectBounds(object, pad = 1.0) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty())
        return null;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).multiplyScalar(pad);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    return { box, center, size, maxDim };
}
function makeWorldGrid(size = 10, divisions = 200, visible = false) {
    const safeSize = Math.max(1e-6, Number(size) || 10);
    let div = Math.max(10, Math.min(1800, Math.floor(Number(divisions) || 200)));
    if (div % 2)
        div += 1;
    const grid = new THREE.GridHelper(safeSize, div, 0x0ea5a6, 0x14b8b9);
    grid.visible = !!visible;
    grid.frustumCulled = false;
    grid.renderOrder = -10;
    const mats = Array.isArray(grid.material) ? grid.material : [grid.material];
    mats.forEach(m => {
        if (!m)
            return;
        m.transparent = true;
        m.opacity = 0.72;
        m.depthWrite = false;
        m.depthTest = true;
        m.needsUpdate = true;
    });
    grid.userData.__gridSize = safeSize;
    grid.userData.__gridDivisions = div;
    return grid;
}
function disposeGrid(grid) {
    try {
        grid?.geometry?.dispose?.();
    }
    catch (_) { }
    try {
        (Array.isArray(grid?.material) ? grid.material : [grid?.material]).forEach(m => m?.dispose?.());
    }
    catch (_) { }
}
function niceGridCell(modelDim) {
    const raw = Math.max(Number(modelDim) || 1, 1e-6) / 24;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return Math.max(m * p, 1e-6);
}
function reasonableGridSpan(modelDim, cell) {
    const dim = Math.max(Number(modelDim) || 1, 1e-9);
    const c = Math.max(Number(cell) || niceGridCell(dim), 1e-9);
    return Math.max(dim * 8.0, c * 56.0);
}
function replaceGridIfNeeded(helpers, wantedSize, cellSize, center, floorY, force = false) {
    if (!helpers?.group)
        return;
    const size = Math.max(1e-6, Number(wantedSize) || 10);
    const cell = Math.max(1e-6, Number(cellSize) || (size / 200));
    let divisions = Math.max(40, Math.ceil(size / cell));
    if (divisions % 2)
        divisions += 1;
    divisions = Math.min(1800, divisions);
    const oldSize = helpers.grid?.userData?.__gridSize || 0;
    const oldDiv = helpers.grid?.userData?.__gridDivisions || 0;
    const visible = !!helpers.grid?.visible;
    const mustReplace = force || !helpers.grid || size > oldSize * 1.18 || size < oldSize * 0.45 || Math.abs(divisions - oldDiv) > Math.max(12, oldDiv * 0.2);
    if (mustReplace) {
        const old = helpers.grid;
        const grid = makeWorldGrid(size, divisions, visible);
        if (old)
            helpers.group.remove(old);
        helpers.group.add(grid);
        disposeGrid(old);
        helpers.grid = grid;
        helpers.__gridWorldSize = size;
        helpers.__gridCellSize = cell;
    }
    try {
        helpers.grid.position.set(center.x, floorY, center.z);
        helpers.grid.frustumCulled = false;
    }
    catch (_) { }
}
function resizeSceneHelpersForObject(helpers, object) {
    const b = getObjectBounds(object, 1.0);
    if (!helpers || !b)
        return;
    const center = b.center || b.box.getCenter(new THREE.Vector3());
    const floorY = Number.isFinite(b.box?.min?.y) ? b.box.min.y : 0;
    const modelDim = Math.max(b.maxDim || 1, 1e-9);
    const cell = niceGridCell(modelDim);
    const span = reasonableGridSpan(modelDim, cell);
    helpers.__gridCellSize = cell;
    helpers.__gridBaseCenter = center.clone();
    helpers.__gridBaseFloorY = floorY;
    replaceGridIfNeeded(helpers, span, cell, center, floorY, true);
    try {
        helpers.ground.scale.setScalar(span / 200);
        helpers.ground.position.set(center.x, floorY - Math.max(modelDim, 1e-9) * 1e-4, center.z);
        helpers.ground.frustumCulled = false;
    }
    catch (_) { }
    try {
        helpers.axes.scale.setScalar(Math.max(modelDim * 0.35, cell * 8));
        helpers.axes.position.copy(center);
        helpers.axes.frustumCulled = false;
    }
    catch (_) { }
}
function configureSceneShadowsForObject(root, helpers, keyLight) {
    if (!root || !helpers || !keyLight)
        return;
    const b = getObjectBounds(root, 1.05);
    if (!b)
        return;
    const center = b.center || b.box.getCenter(new THREE.Vector3());
    const dim = Math.max(b.maxDim || 1, 1e-6);
    const floorY = Number.isFinite(b.box?.min?.y) ? b.box.min.y : center.y - dim * 0.5;
    try {
        helpers.ground.position.set(center.x, floorY - dim * 1e-4, center.z);
        helpers.ground.scale.setScalar(Math.max(helpers.__gridWorldSize || dim * 8, dim * 4) / 200);
        helpers.ground.receiveShadow = true;
        helpers.ground.castShadow = false;
        (Array.isArray(helpers.ground.material) ? helpers.ground.material : [helpers.ground.material]).forEach(m => { if (m)
            m.needsUpdate = true; });
    }
    catch (_) { }
    try {
        keyLight.target.position.copy(center);
        keyLight.position.copy(center.clone().add(new THREE.Vector3(dim * 2.1, dim * 3.0, dim * 2.4)));
        if (!keyLight.target.parent)
            keyLight.parent?.add?.(keyLight.target);
        keyLight.updateMatrixWorld(true);
        keyLight.target.updateMatrixWorld(true);
        const cam = keyLight.shadow.camera;
        const r = Math.max(dim * 2.2, 1.0);
        cam.left = -r;
        cam.right = r;
        cam.top = r;
        cam.bottom = -r;
        cam.near = 0.001;
        cam.far = Math.max(dim * 8.0, 10.0);
        cam.updateProjectionMatrix();
    }
    catch (_) { }
    try {
        root.traverse(o => { if (o?.isMesh && o.geometry && !o.userData?.__isHoverOverlay) {
            o.castShadow = true;
            o.receiveShadow = true;
        } });
    }
    catch (_) { }
}
function keepOrthographicDepthSafe(camera, controls, helpers, object) {
    if (!camera?.isOrthographicCamera || !controls?.target)
        return;
    const b = object ? getObjectBounds(object, 1.0) : null;
    const modelDim = Math.max(b?.maxDim || 1, 1e-9);
    const gridSize = Math.max(helpers?.__gridWorldSize || reasonableGridSpan(modelDim, helpers?.__gridCellSize), modelDim);
    const w = Math.abs((camera.right || 1) - (camera.left || -1)) / Math.max(camera.zoom || 1, 1e-6);
    const h = Math.abs((camera.top || 1) - (camera.bottom || -1)) / Math.max(camera.zoom || 1, 1e-6);
    const viewDiag = Math.sqrt(w * w + h * h);
    const span = Math.max(modelDim, gridSize, viewDiag, 1e-6);
    const target = controls.target;
    const dir = camera.position.clone().sub(target);
    if (!Number.isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-12)
        dir.set(1, 0.7, 1);
    dir.normalize();
    const safeDist = Math.max(span * 3.0, 1.0);
    camera.position.copy(target.clone().add(dir.multiplyScalar(safeDist)));
    camera.near = -safeDist * 4.0;
    camera.far = safeDist * 4.0;
    camera.updateProjectionMatrix();
}
function keepGridInfiniteForView(helpers, camera, controls, object) {
    if (!helpers?.grid)
        return;
    const b = object ? getObjectBounds(object, 1.0) : null;
    if (!b) {
        keepOrthographicDepthSafe(camera, controls, helpers, object);
        return;
    }
    const center = helpers.__gridBaseCenter || b.center || b.box.getCenter(new THREE.Vector3());
    const y = Number.isFinite(helpers.__gridBaseFloorY) ? helpers.__gridBaseFloorY : (Number.isFinite(b.box?.min?.y) ? b.box.min.y : 0);
    const modelDim = Math.max(b.maxDim || 1, 1e-9);
    const cell = helpers.__gridCellSize || niceGridCell(modelDim);
    const wanted = reasonableGridSpan(modelDim, cell);
    replaceGridIfNeeded(helpers, wanted, cell, center, y, false);
    try {
        helpers.grid.position.set(center.x, y, center.z);
        helpers.grid.frustumCulled = false;
    }
    catch (_) { }
    try {
        const gspan = helpers.__gridWorldSize || wanted;
        helpers.ground.scale.setScalar(gspan / 200);
        helpers.ground.position.set(center.x, y - Math.max(modelDim, 1e-9) * 1e-4, center.z);
        helpers.ground.frustumCulled = false;
    }
    catch (_) { }
    keepOrthographicDepthSafe(camera, controls, helpers, object);
}
function fitAndCenter(camera, controls, object, pad = 1.08) {
    const b = getObjectBounds(object, pad);
    if (!b)
        return false;
    const { center, maxDim } = b;
    if (camera.isPerspectiveCamera) {
        const fov = (camera.fov || 60) * Math.PI / 180;
        const dist = maxDim / Math.tan(Math.max(1e-6, fov / 2));
        camera.near = Math.max(maxDim / 1000, 0.001);
        camera.far = Math.max(maxDim * 1500, 1500);
        camera.updateProjectionMatrix();
        const dir = camera.position.clone().sub(controls.target || new THREE.Vector3()).normalize();
        if (!isFinite(dir.lengthSq()) || dir.lengthSq() < 1e-10) {
            dir.set(1, 0.7, 1).normalize();
        }
        camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    }
    else if (camera.isOrthographicCamera) {
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
function buildHelpers() {
    const group = new THREE.Group();
    const grid = makeWorldGrid(10, 200, false);
    group.add(grid);
    const groundMat = new THREE.MeshStandardMaterial({
        color: 0xf8fafc,
        transparent: true,
        opacity: 0.32,
        roughness: 1.0,
        metalness: 0.0,
        depthWrite: false,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.0001;
    ground.receiveShadow = true;
    ground.castShadow = false;
    ground.visible = false;
    ground.frustumCulled = false;
    group.add(ground);
    const axes = new THREE.AxesHelper(1);
    axes.visible = false;
    axes.frustumCulled = false;
    group.add(axes);
    return { group, grid, ground, axes };
}
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
            if (!this.enabled)
                return;
            e.preventDefault();
            const delta = -(e.deltaY || 0);
            this._dolly(delta);
            this.update();
        };
        this._onPointerDown = (e) => {
            if (!this.enabled)
                return;
            if (this._pointerId !== null)
                return;
            this._pointerId = e.pointerId;
            this._state = (e.button === 0) ? 1 : (e.button === 1) ? 2 : 3;
            this._start.set(e.clientX, e.clientY);
            this._end.copy(this._start);
            this._lastAngle = 0;
            this._lastPan.set(0, 0, 0);
            this._lastDolly = 0;
            try {
                this.domElement.setPointerCapture(e.pointerId);
            }
            catch (_) { }
            window.addEventListener('pointermove', this._onPointerMove, true);
            window.addEventListener('pointerup', this._onPointerUp, true);
        };
        this._onPointerMove = (e) => {
            if (!this.enabled)
                return;
            if (this._pointerId !== e.pointerId)
                return;
            this._end.set(e.clientX, e.clientY);
            if (this._state === 1) {
                this._rotate(this._start, this._end);
            }
            else if (this._state === 2) {
                const dy = (this._end.y - this._start.y);
                this._dolly(-dy * 4);
            }
            else if (this._state === 3) {
                this._pan(this._start, this._end);
            }
            this._start.copy(this._end);
            this.update();
        };
        this._onPointerUp = (e) => {
            if (this._pointerId !== e.pointerId)
                return;
            this._pointerId = null;
            this._state = 0;
            window.removeEventListener('pointermove', this._onPointerMove, true);
            window.removeEventListener('pointerup', this._onPointerUp, true);
            try {
                this.domElement.releasePointerCapture(e.pointerId);
            }
            catch (_) { }
        };
        this.domElement.addEventListener('contextmenu', this._onContextMenu);
        this.domElement.addEventListener('wheel', this._onWheel, { passive: false });
        this.domElement.addEventListener('pointerdown', this._onPointerDown, true);
    }
    handleResize() {
        this._rect = this.domElement.getBoundingClientRect();
    }
    update() {
        if (!this.staticMoving && this._state === 0) {
            if (Math.abs(this._lastAngle) > 1e-6) {
                this._applyRotation(this._lastAxis, this._lastAngle);
                this._lastAngle *= (1.0 - this.dynamicDampingFactor);
                if (Math.abs(this._lastAngle) < 1e-6)
                    this._lastAngle = 0;
            }
            if (this._lastPan.lengthSq() > 1e-12) {
                this.object.position.add(this._lastPan);
                this.target.add(this._lastPan);
                this._lastPan.multiplyScalar(1.0 - this.dynamicDampingFactor);
                if (this._lastPan.lengthSq() < 1e-12)
                    this._lastPan.set(0, 0, 0);
            }
            if (Math.abs(this._lastDolly) > 1e-6) {
                this._dolly(this._lastDolly);
                this._lastDolly *= (1.0 - this.dynamicDampingFactor);
                if (Math.abs(this._lastDolly) < 1e-6)
                    this._lastDolly = 0;
            }
        }
        this.object.lookAt(this.target);
    }
    _getRect() {
        if (!this._rect)
            this.handleResize();
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
        }
        else {
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
        if (axisLen < 1e-8)
            return;
        axisCam.normalize();
        const dot = THREE.MathUtils.clamp(a.dot(b), -1, 1);
        let angle = Math.acos(dot) * this.rotateSpeed;
        angle = -angle;
        const axisWorld = axisCam.clone().applyQuaternion(this.object.quaternion).normalize();
        this._applyRotation(axisWorld, angle);
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
        }
        else if (this.object.isOrthographicCamera) {
            this.object.zoom = Math.max(1e-3, this.object.zoom / zoomFactor);
            this.object.updateProjectionMatrix();
        }
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
        }
        else if (this.object.isOrthographicCamera) {
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
        this._lastPan.copy(pan);
    }
}
export function createViewer({ container, background = 0xffffff, pixelRatio } = {}) {
    assertThree();
    const rootEl = container || document.body;
    if (getComputedStyle(rootEl).position === 'static') {
        rootEl.style.position = 'relative';
    }
    const scene = new THREE.Scene();
    if (background === null || typeof background === 'undefined') {
        scene.background = null;
    }
    else {
        scene.background = new THREE.Color(background);
    }
    const aspect = Math.max(1e-6, (rootEl.clientWidth || 1) / (rootEl.clientHeight || 1));
    const persp = new THREE.PerspectiveCamera(75, aspect, 0.01, 10000);
    persp.position.set(0, 0, 3);
    const orthoSize = 2.5;
    const ortho = new THREE.OrthographicCamera(-orthoSize * aspect, orthoSize * aspect, orthoSize, -orthoSize, 0.01, 10000);
    ortho.position.set(0, 0, 3);
    let camera = persp;
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
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    const controls = new TrackballControls(camera, renderer.domElement);
    controls.rotateSpeed = 4.0;
    controls.zoomSpeed = 1.4;
    controls.panSpeed = 0.8;
    controls.staticMoving = false;
    controls.dynamicDampingFactor = 0.15;
    const hemi = new THREE.HemisphereLight(0xffffff, 0xcfeeee, 0.7);
    const dir = new THREE.DirectionalLight(0xffffff, 1.05);
    dir.position.set(3, 4, 2);
    dir.castShadow = false;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.near = 0.1;
    dir.shadow.camera.far = 1000;
    scene.add(hemi);
    scene.add(dir);
    const helpers = buildHelpers();
    scene.add(helpers.group);
    function sizeAxesHelper(maxDim, center) {
        helpers.axes.scale.setScalar(maxDim * 0.75);
        helpers.axes.position.copy(center || new THREE.Vector3());
    }
    function onResize() {
        const w = rootEl.clientWidth || 1;
        const h = rootEl.clientHeight || 1;
        const asp = Math.max(1e-6, w / h);
        if (camera.isPerspectiveCamera) {
            camera.aspect = asp;
        }
        else {
            const size = Math.abs(camera.top) || orthoSize;
            camera.left = -size * asp;
            camera.right = size * asp;
            camera.top = size;
            camera.bottom = -size;
        }
        camera.updateProjectionMatrix();
        try {
            keepOrthographicDepthSafe(camera, controls, helpers, robotModel);
        }
        catch (_) { }
        renderer.setSize(w, h);
        if (controls && typeof controls.handleResize === 'function')
            controls.handleResize();
    }
    window.addEventListener('resize', onResize);
    const urdfLoader = new URDFLoader();
    let robotModel = null;
    function loadURDF(urdfText, { loadMeshCb } = {}) {
        if (robotModel) {
            try {
                scene.remove(robotModel);
            }
            catch (_) { }
            robotModel = null;
        }
        if (!urdfText || typeof urdfText !== 'string')
            return null;
        if (typeof loadMeshCb === 'function') {
            urdfLoader.loadMeshCb = loadMeshCb;
        }
        let robot = null;
        try {
            robot = urdfLoader.parse(urdfText);
        }
        catch (e) {
            console.warn('[ViewerCore] URDF parse error:', e);
            return null;
        }
        if (robot && robot.isObject3D) {
            robotModel = robot;
            scene.add(robotModel);
            rectifyUpForward(robotModel);
            applyDoubleSided(robotModel);
            setTimeout(() => {
                if (!robotModel)
                    return;
                try {
                    resizeSceneHelpersForObject(helpers, robotModel);
                    configureSceneShadowsForObject(robotModel, helpers, dir);
                }
                catch (_) { }
                const ok = fitAndCenter(camera, controls, robotModel, 1.06);
                if (ok) {
                    const b = getObjectBounds(robotModel);
                    if (b)
                        sizeAxesHelper(b.maxDim, b.center);
                }
                try {
                    keepGridInfiniteForView(helpers, camera, controls, robotModel);
                }
                catch (_) { }
            }, 50);
        }
        return robotModel;
    }
    function setProjection(mode = 'Perspective') {
        const w = rootEl.clientWidth || 1, h = rootEl.clientHeight || 1;
        const asp = Math.max(1e-6, w / h);
        if (mode === 'Orthographic' && camera.isPerspectiveCamera) {
            const t = controls.target.clone();
            const v = camera.position.clone().sub(t);
            const dist = v.length();
            const dirN = v.clone().normalize();
            const b = robotModel ? getObjectBounds(robotModel, 1.0) : null;
            const gridSpan = helpers.__gridWorldSize || (b ? reasonableGridSpan(b.maxDim, helpers.__gridCellSize) : 10);
            const span = Math.max(orthoSize, (b ? b.maxDim : 0), gridSpan * 0.55);
            ortho.left = -span * asp;
            ortho.right = span * asp;
            ortho.top = span;
            ortho.bottom = -span;
            const safeDepth = Math.max(gridSpan * 8.0, (b ? b.maxDim * 100 : 1000), 1000);
            ortho.near = -safeDepth;
            ortho.far = safeDepth;
            ortho.position.copy(t.clone().add(dirN.multiplyScalar(dist)));
            ortho.updateProjectionMatrix();
            controls.object = ortho;
            camera = ortho;
            controls.target.copy(t);
            controls.update();
        }
        else if (mode === 'Perspective' && camera.isOrthographicCamera) {
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
    function setSceneToggles({ grid, ground, axes, shadows } = {}) {
        if (typeof grid === 'boolean')
            helpers.grid.visible = grid;
        if (typeof ground === 'boolean')
            helpers.ground.visible = ground;
        if (typeof axes === 'boolean')
            helpers.axes.visible = axes;
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
        if (robotModel) {
            try {
                resizeSceneHelpersForObject(helpers, robotModel);
            }
            catch (_) { }
            try {
                if (typeof shadows === 'boolean')
                    configureSceneShadowsForObject(robotModel, helpers, dir);
            }
            catch (_) { }
            try {
                keepGridInfiniteForView(helpers, camera, controls, robotModel);
            }
            catch (_) { }
            if (helpers.axes.visible) {
                const b = getObjectBounds(robotModel);
                if (b)
                    sizeAxesHelper(b.maxDim, b.center);
            }
        }
    }
    function setBackground(colorIntOrNull) {
        if (colorIntOrNull === null || typeof colorIntOrNull === 'undefined') {
            scene.background = null;
        }
        else {
            scene.background = new THREE.Color(colorIntOrNull);
        }
    }
    function setPixelRatio(r) {
        const pr = Math.max(0.5, Math.min(3, r || window.devicePixelRatio || 1));
        renderer.setPixelRatio(pr);
        onResize();
    }
    let raf = null;
    let paused = false;
    function setPaused(v) { paused = !!v; }
    function animate() {
        raf = requestAnimationFrame(animate);
        controls.update();
        try {
            keepGridInfiniteForView(helpers, camera, controls, robotModel);
        }
        catch (_) { }
        try {
            if (typeof renderer.__automindUpdateMechanismDecorations === 'function')
                renderer.__automindUpdateMechanismDecorations();
        }
        catch (_) { }
        if (!paused)
            renderer.render(scene, camera);
    }
    animate();
    function destroy() {
        try {
            cancelAnimationFrame(raf);
        }
        catch (_) { }
        try {
            window.removeEventListener('resize', onResize);
        }
        catch (_) { }
        try {
            const el = renderer?.domElement;
            if (el && el.parentNode)
                el.parentNode.removeChild(el);
        }
        catch (_) { }
        try {
            renderer?.dispose?.();
        }
        catch (_) { }
    }
    return {
        scene,
        get camera() { return camera; },
        renderer,
        controls,
        helpers,
        get robot() { return robotModel; },
        setPaused,
        loadURDF,
        fitAndCenter: (obj, pad) => fitAndCenter(camera, controls, obj || robotModel, pad),
        setProjection,
        setSceneToggles,
        refreshRobotContext: (obj = robotModel) => { try {
            resizeSceneHelpersForObject(helpers, obj);
            configureSceneShadowsForObject(obj, helpers, dir);
            keepGridInfiniteForView(helpers, camera, controls, obj);
            return true;
        }
        catch (_) {
            return false;
        } },
        setBackground,
        setPixelRatio,
        onResize,
        destroy
    };
}
