import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { WebGLPathTracer } from 'three-gpu-pathtracer';
import { normalizeThreeDDocument } from './document.js';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const TONE_MAPPING_MAP = {
    aces: THREE.ACESFilmicToneMapping,
    neutral: THREE.NeutralToneMapping,
    none: THREE.NoToneMapping
};

const MATERIAL_MAP_KEYS = [
    'map',
    'alphaMap',
    'aoMap',
    'bumpMap',
    'displacementMap',
    'emissiveMap',
    'envMap',
    'lightMap',
    'metalnessMap',
    'normalMap',
    'roughnessMap',
    'specularMap',
    'transmissionMap'
];

function normalizeHexColor(value, fallback = '#ffffff') {
    const text = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

function extractItemId(object) {
    let current = object;
    while (current) {
        if (current.userData?.threeDItemId) return current.userData.threeDItemId;
        current = current.parent;
    }
    return null;
}

function markSceneItem(root, itemId) {
    root.userData.threeDItemId = itemId;
    root.traverse((child) => {
        child.userData.threeDItemId = itemId;
    });
}

function getMaterialList(material) {
    if (Array.isArray(material)) return material.filter(Boolean);
    return material ? [material] : [];
}

function disposeOwnedTextures(material) {
    getMaterialList(material).forEach((entry) => {
        MATERIAL_MAP_KEYS.forEach((key) => {
            const texture = entry?.[key];
            if (texture?.userData?.threeDOwnedTexture) {
                texture.dispose?.();
            }
        });
    });
}

function disposeMaterialSet(material) {
    disposeOwnedTextures(material);
    if (Array.isArray(material)) {
        material.forEach((entry) => entry?.dispose?.());
    } else {
        material?.dispose?.();
    }
}

function cloneMaterialSet(material) {
    if (Array.isArray(material)) return material.map((entry) => entry?.clone?.() || entry);
    return material?.clone?.() || material;
}

function disposeObject3D(root) {
    root.traverse((child) => {
        if (child.isMesh) {
            child.geometry?.dispose?.();
            disposeMaterialSet(child.material);
            if (child.userData?.threeDOriginalMaterialTemplate) {
                disposeMaterialSet(child.userData.threeDOriginalMaterialTemplate);
                delete child.userData.threeDOriginalMaterialTemplate;
            }
        }
    });
}

async function dataUrlToArrayBuffer(dataUrl) {
    const response = await fetch(dataUrl);
    return response.arrayBuffer();
}

async function dataUrlToText(dataUrl) {
    const response = await fetch(dataUrl);
    return response.text();
}

async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
}

function createHiddenCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.style.position = 'fixed';
    canvas.style.left = '-10000px';
    canvas.style.top = '-10000px';
    canvas.style.width = '1px';
    canvas.style.height = '1px';
    canvas.style.opacity = '0';
    canvas.style.pointerEvents = 'none';
    document.body.appendChild(canvas);
    return canvas;
}

function downloadBlob(blob, filename) {
    const safeName = String(filename || 'render.png').trim() || 'render.png';
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = safeName.endsWith('.png') ? safeName : `${safeName}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const LINKED_SCALE_AXES = {
    XY: [0, 1],
    XZ: [0, 2],
    YZ: [1, 2]
};

function isEditableTarget(target) {
    if (!target) return false;
    const tagName = String(target.tagName || '').toLowerCase();
    return tagName === 'input'
        || tagName === 'select'
        || tagName === 'textarea'
        || tagName === 'button'
        || target.isContentEditable;
}

function getObjectWorldCenter(object) {
    if (!object) return new THREE.Vector3();
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty()) {
        return box.getCenter(new THREE.Vector3());
    }
    return object.getWorldPosition(new THREE.Vector3());
}

function chooseLinkedPlaneScaleRatio(object, startScale, axisIndices) {
    if (!object || !startScale || !axisIndices?.length) return 1;
    let bestRatio = 1;
    let bestScore = 0;
    axisIndices.forEach((index) => {
        const startValue = Math.max(0.0001, Number(startScale.getComponent(index)) || 0.0001);
        const currentValue = Math.max(0.0001, Number(object.scale.getComponent(index)) || 0.0001);
        const ratio = currentValue / startValue;
        const score = Math.abs(Math.log(Math.max(0.0001, ratio)));
        if (score > bestScore) {
            bestScore = score;
            bestRatio = ratio;
        }
    });
    return Math.max(0.0001, bestRatio);
}

function disposePathTracerSafely(pathTracer) {
    if (!pathTracer) return;
    try {
        pathTracer.dispose?.();
    } catch (error) {
        console.warn('Could not fully dispose the path tracer cleanly.', error);
    }
}

export class ThreeDEngine {
    constructor(container) {
        this.container = container;
        this.destroyed = false;
        this.loader = new GLTFLoader();
        this.textureLoader = new THREE.TextureLoader();
        this.sceneObjects = new Map();
        this.itemLights = new Map();
        this.itemHelpers = new Map();
        this.itemSignatures = new Map();
        this.itemStateSignatures = new Map();
        this.editorObjects = new Set();
        this.textureCache = new Map();
        this.renderMode = 'raster';
        this.targetSamples = 256;
        this.activeDocument = normalizeThreeDDocument(null);
        this._syncPromise = null;
        this._queuedDocument = null;
        this._sceneRebuildTimer = null;
        this._editLocked = false;
        this._backgroundRenderJob = null;
        this._transformScaleStart = null;
        this._cameraMode = this.activeDocument.view.cameraMode;
        this._flyLookActive = false;
        this._flyPointerId = null;
        this._flyPointerX = 0;
        this._flyPointerY = 0;
        this._flyYaw = Math.PI;
        this._flyPitch = 0;
        this._flyTargetDistance = 8;
        this._flyKeys = new Set();
        this._cameraCommitTimer = null;
        this._lastCameraSignature = '';
        this._pathTraceWarmupPending = false;
        this._pathTraceLoadingActive = false;
        this._pathTraceLoadingMessage = 'Preparing path tracer...';
        this.clock = new THREE.Clock();

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(this.activeDocument.scene.backgroundColor);

        this.camera = new THREE.PerspectiveCamera(
            this.activeDocument.view.fov,
            this.getAspect(),
            this.activeDocument.view.near,
            this.activeDocument.view.far
        );
        this.camera.position.fromArray(this.activeDocument.view.cameraPosition);
        this.camera.lookAt(new THREE.Vector3(...this.activeDocument.view.cameraTarget));

        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true
        });
        this.renderer.domElement.tabIndex = 0;
        this.renderer.domElement.style.outline = 'none';
        this.renderer.setPixelRatio(window.devicePixelRatio || 1);
        this.renderer.setSize(Math.max(1, this.container.clientWidth), Math.max(1, this.container.clientHeight));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        this.pathTracer = new WebGLPathTracer(this.renderer);
        this.pathTracer.renderScale = 1;
        this.pathTracer.tiles.set(2, 2);
        this.pathTracer.renderDelay = 0;
        this.pathTracer.minSamples = 0;
        this.rebuildPathTracerScene();

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.target.fromArray(this.activeDocument.view.cameraTarget);
        this.controls.update();
        this.controls.addEventListener('end', () => {
            if (!this._editLocked && this._cameraMode === 'orbit') {
                this.commitCameraState();
            }
        });

        this.transformControl = new TransformControls(this.camera, this.renderer.domElement);
        this.transformControl.addEventListener('dragging-changed', (event) => {
            if (event.value && this.transformControl.object) {
                this._transformScaleStart = this.transformControl.object.scale.clone();
            } else {
                this._transformScaleStart = null;
            }
            this.controls.enabled = this._cameraMode === 'orbit' && !this._editLocked && !event.value;
            if (!event.value && this.transformControl.object && !this._editLocked) {
                this.commitTransformState(this.transformControl.object);
            }
        });
        this.transformControl.addEventListener('change', () => {
            if (!this.transformControl.object || this._editLocked) return;
            this.applyLinkedPlaneScale(this.transformControl.object);
            this.emitTransformPreview(this.transformControl.object);
        });
        this.transformControl.enabled = true;
        this.registerEditorObject(this.transformControl);

        this.raycaster = new THREE.Raycaster();
        this.mouse = new THREE.Vector2();
        this.renderer.domElement.addEventListener('pointerdown', (event) => this.onPointerDown(event));
        this.renderer.domElement.addEventListener('contextmenu', (event) => event.preventDefault());
        this.handleWindowPointerMove = (event) => this.onWindowPointerMove(event);
        this.handleWindowPointerUp = (event) => this.onWindowPointerUp(event);
        this.handleWindowKeyDown = (event) => this.onWindowKeyDown(event);
        this.handleWindowKeyUp = (event) => this.onWindowKeyUp(event);
        this.handleWindowBlur = () => this.onWindowBlur();
        window.addEventListener('pointermove', this.handleWindowPointerMove);
        window.addEventListener('pointerup', this.handleWindowPointerUp);
        window.addEventListener('keydown', this.handleWindowKeyDown);
        window.addEventListener('keyup', this.handleWindowKeyUp);
        window.addEventListener('blur', this.handleWindowBlur);

        this.gridHelper = new THREE.GridHelper(20, 20, 0x888888, 0x444444);
        this.axesHelper = new THREE.AxesHelper(5);
        this.registerEditorObject(this.gridHelper);
        this.registerEditorObject(this.axesHelper);

        this.ambientLight = new THREE.AmbientLight(0xffffff, 0.9);
        this.keyLight = new THREE.DirectionalLight(0xffffff, 1.35);
        this.keyLight.position.set(6, 10, 6);
        this.keyLight.castShadow = true;
        this.keyLight.shadow.camera.top = 12;
        this.keyLight.shadow.camera.bottom = -12;
        this.keyLight.shadow.camera.left = -12;
        this.keyLight.shadow.camera.right = 12;
        this.registerEditorObject(this.ambientLight);
        this.registerEditorObject(this.keyLight);

        this.resizeObserver = new ResizeObserver(() => this.onResize());
        this.resizeObserver.observe(this.container);

        this.animate = this.animate.bind(this);
        this.animate();
    }

    registerEditorObject(object) {
        this.editorObjects.add(object);
        object.traverse?.((child) => {
            if ('castShadow' in child) child.castShadow = false;
            if ('receiveShadow' in child) child.receiveShadow = false;
        });
        this.scene.add(object);
        return object;
    }

    emitPathTraceLoading(active, message = '') {
        const nextMessage = message || this._pathTraceLoadingMessage || 'Preparing path tracer...';
        if (this._pathTraceLoadingActive === !!active && (!active || nextMessage === this._pathTraceLoadingMessage)) {
            return;
        }
        this._pathTraceLoadingActive = !!active;
        if (active) {
            this._pathTraceLoadingMessage = nextMessage;
        }
        this.onPathTraceLoading?.({
            active: !!active,
            message: active ? nextMessage : ''
        });
    }

    queuePathTraceWarmup(message = 'Preparing path tracer...') {
        this._pathTraceLoadingMessage = message;
        if (this.renderMode !== 'pathtrace') return;
        this._pathTraceWarmupPending = true;
        this.emitPathTraceLoading(true, message);
    }

    getAspect() {
        return this.container.clientWidth / Math.max(1, this.container.clientHeight);
    }

    withPathTracerExclusions(callback) {
        const changedObjects = [];
        this.editorObjects.forEach((object) => {
            if (object?.visible) {
                changedObjects.push(object);
                object.visible = false;
            }
        });

        try {
            return callback();
        } finally {
            changedObjects.forEach((object) => {
                object.visible = true;
            });
        }
    }

    rebuildPathTracerScene() {
        this.queuePathTraceWarmup('Rebuilding path tracer scene...');
        return this.withPathTracerExclusions(() => this.pathTracer.setScene(this.scene, this.camera));
    }

    refreshPathTracerLights() {
        this.queuePathTraceWarmup('Updating path tracer lights...');
        this.withPathTracerExclusions(() => this.pathTracer.updateLights());
    }

    onPointerDown(event) {
        this.renderer.domElement.focus?.();
        if (event.button === 2) {
            if (!this._editLocked && !this.transformControl.dragging && this._cameraMode === 'fly') {
                this.beginFlyLook(event);
            }
            return;
        }
        if (event.button !== 0 || this.transformControl.dragging || this._editLocked) return;
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        this.mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

        this.raycaster.setFromCamera(this.mouse, this.camera);
        const objects = [
            ...this.sceneObjects.values(),
            ...this.itemHelpers.values()
        ];
        const intersects = this.raycaster.intersectObjects(objects, true);
        const hitId = intersects.length ? extractItemId(intersects[0].object) : null;
        this.onSelectionChanged?.(hitId);
    }

    beginFlyLook(event) {
        this._flyLookActive = true;
        this._flyPointerId = event.pointerId;
        this._flyPointerX = event.clientX;
        this._flyPointerY = event.clientY;
        this.syncFlyStateFromCamera();
        try {
            this.renderer.domElement.setPointerCapture?.(event.pointerId);
        } catch {
            // Ignore pointer capture failures on older browsers.
        }
        event.preventDefault();
    }

    endFlyLook(commit = true) {
        if (!this._flyLookActive) return;
        try {
            if (this._flyPointerId != null) {
                this.renderer.domElement.releasePointerCapture?.(this._flyPointerId);
            }
        } catch {
            // Ignore pointer capture failures on older browsers.
        }
        this._flyLookActive = false;
        this._flyPointerId = null;
        if (commit) {
            this.flushCameraCommit();
        }
    }

    onWindowPointerMove(event) {
        if (!this._flyLookActive || this._cameraMode !== 'fly' || this._editLocked) return;
        if (this._flyPointerId != null && event.pointerId !== this._flyPointerId) return;
        const deltaX = Number.isFinite(event.movementX) ? event.movementX : (event.clientX - this._flyPointerX);
        const deltaY = Number.isFinite(event.movementY) ? event.movementY : (event.clientY - this._flyPointerY);
        this._flyPointerX = event.clientX;
        this._flyPointerY = event.clientY;
        this._flyYaw -= deltaX * 0.003;
        this._flyPitch = Math.max(-Math.PI / 2 + 0.01, Math.min(Math.PI / 2 - 0.01, this._flyPitch - deltaY * 0.003));
        this.applyFlyOrientation();
        this.handleLiveCameraChange();
        this.queueCameraCommit();
        event.preventDefault();
    }

    onWindowPointerUp(event) {
        if (this._flyPointerId != null && event.pointerId !== this._flyPointerId) return;
        this.endFlyLook(true);
    }

    onWindowKeyDown(event) {
        const key = String(event.key || '').toLowerCase();
        const tagName = String(event.target?.tagName || '').toLowerCase();
        const blocksShortcuts = tagName === 'input' || tagName === 'select' || tagName === 'textarea' || event.target?.isContentEditable;
        const activeElement = document.activeElement;
        if (key === 'f' && this._cameraMode === 'orbit' && !this._editLocked && !blocksShortcuts && this.container.clientWidth > 0 && this.container.clientHeight > 0) {
            this.frameSelectedObject();
            event.preventDefault();
            return;
        }

        if (isEditableTarget(event.target)) return;
        if (this._cameraMode !== 'fly' || this._editLocked || this.transformControl.dragging) return;
        if (!this._flyLookActive && activeElement !== this.renderer.domElement) return;
        if (!['w', 'a', 's', 'd', 'q', 'e', 'shift', 'alt'].includes(key)) return;
        this._flyKeys.add(key);
        event.preventDefault();
    }

    onWindowKeyUp(event) {
        const key = String(event.key || '').toLowerCase();
        if (!this._flyKeys.delete(key)) return;
        this.queueCameraCommit(40);
        event.preventDefault();
    }

    onWindowBlur() {
        this._flyKeys.clear();
        this.endFlyLook(true);
    }

    syncFlyStateFromCamera(target = this.controls.target) {
        const direction = target.clone().sub(this.camera.position);
        const distance = Math.max(direction.length(), 1);
        direction.normalize();
        this._flyTargetDistance = distance;
        this._flyYaw = Math.atan2(direction.x, direction.z);
        this._flyPitch = Math.asin(Math.max(-1, Math.min(1, direction.y)));
    }

    applyFlyOrientation() {
        const direction = new THREE.Vector3(
            Math.sin(this._flyYaw) * Math.cos(this._flyPitch),
            Math.sin(this._flyPitch),
            Math.cos(this._flyYaw) * Math.cos(this._flyPitch)
        );
        const target = this.camera.position.clone().add(direction.multiplyScalar(Math.max(1, this._flyTargetDistance)));
        this.camera.lookAt(target);
        this.controls.target.copy(target);
    }

    updateFlyMovement(deltaTime) {
        if (this._cameraMode !== 'fly' || this._editLocked || this.transformControl.dragging) return false;
        if (!this._flyKeys.size) return false;
        const direction = new THREE.Vector3();
        this.camera.getWorldDirection(direction);
        direction.normalize();

        const right = new THREE.Vector3().crossVectors(direction, new THREE.Vector3(0, 1, 0));
        if (right.lengthSq() < 0.000001) {
            right.set(1, 0, 0);
        } else {
            right.normalize();
        }

        const movement = new THREE.Vector3();
        if (this._flyKeys.has('w')) movement.add(direction);
        if (this._flyKeys.has('s')) movement.sub(direction);
        if (this._flyKeys.has('d')) movement.add(right);
        if (this._flyKeys.has('a')) movement.sub(right);
        if (this._flyKeys.has('e')) movement.y += 1;
        if (this._flyKeys.has('q')) movement.y -= 1;
        if (movement.lengthSq() === 0) return false;

        movement.normalize();
        const speedMultiplier = this._flyKeys.has('shift') ? 3.5 : this._flyKeys.has('alt') ? 0.35 : 1;
        const speed = 6 * speedMultiplier * Math.min(Math.max(deltaTime, 1 / 240), 1 / 15);
        this.camera.position.addScaledVector(movement, speed);
        this.applyFlyOrientation();
        this.handleLiveCameraChange();
        this.queueCameraCommit();
        return true;
    }

    queueCameraCommit(delay = 160) {
        if (this.destroyed) return;
        if (this._cameraCommitTimer) clearTimeout(this._cameraCommitTimer);
        this._cameraCommitTimer = setTimeout(() => {
            this._cameraCommitTimer = null;
            if (!this.destroyed && !this._editLocked) {
                this.commitCameraState();
            }
        }, delay);
    }

    flushCameraCommit() {
        if (this._cameraCommitTimer) {
            clearTimeout(this._cameraCommitTimer);
            this._cameraCommitTimer = null;
        }
        if (!this.destroyed && !this._editLocked) {
            this.commitCameraState();
        }
    }

    buildCameraSignature() {
        return [
            this.camera.position.x.toFixed(4),
            this.camera.position.y.toFixed(4),
            this.camera.position.z.toFixed(4),
            this.camera.quaternion.x.toFixed(4),
            this.camera.quaternion.y.toFixed(4),
            this.camera.quaternion.z.toFixed(4),
            this.camera.quaternion.w.toFixed(4),
            this.camera.fov.toFixed(3),
            this.camera.aspect.toFixed(4)
        ].join('|');
    }

    handleLiveCameraChange(force = false) {
        const signature = this.buildCameraSignature();
        if (!force && signature === this._lastCameraSignature) return false;
        this._lastCameraSignature = signature;
        this.pathTracer.updateCamera();
        return true;
    }

    applyLinkedPlaneScale(object) {
        if (!object || this.activeDocument.view.linkPlaneScale === false) return;
        const mode = this.transformControl.getMode?.() || this.transformControl.mode;
        if (mode !== 'scale') return;
        const axisIndices = LINKED_SCALE_AXES[this.transformControl.axis];
        if (!axisIndices || !this._transformScaleStart) return;
        const ratio = chooseLinkedPlaneScaleRatio(object, this._transformScaleStart, axisIndices);
        axisIndices.forEach((index) => {
            object.scale.setComponent(index, Math.max(0.0001, this._transformScaleStart.getComponent(index) * ratio));
        });
    }

    updateTrackedLightTargets() {
        let changed = false;
        this.activeDocument.scene.items.forEach((item) => {
            if (item.kind !== 'light') return;
            const light = this.itemLights.get(item.id);
            const root = this.sceneObjects.get(item.id);
            if (!light || !root || (!light.isDirectionalLight && !light.isSpotLight) || !light.target) return;

            const targetItem = item.light?.targetItemId ? this.sceneObjects.get(item.light.targetItemId) : null;
            const desiredTarget = targetItem
                ? root.worldToLocal(getObjectWorldCenter(targetItem))
                : new THREE.Vector3(0, 0, -1);

            if (light.target.position.distanceToSquared(desiredTarget) > 0.000001) {
                light.target.position.copy(desiredTarget);
                light.target.updateMatrixWorld(true);
                changed = true;
            }
        });

        if (changed) {
            this.itemHelpers.forEach((helper) => helper?.update?.());
            this.refreshPathTracerLights();
        }
        return changed;
    }

    onResize() {
        if (!this.container || this.destroyed) return;
        const width = Math.max(1, this.container.clientWidth);
        const height = Math.max(1, this.container.clientHeight);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
        this.pathTracer.updateCamera();
    }

    queueSync(documentState) {
        this._queuedDocument = normalizeThreeDDocument(documentState);
        if (!this._syncPromise) {
            this._syncPromise = this.flushSyncQueue().finally(() => {
                this._syncPromise = null;
            });
        }
        return this._syncPromise;
    }

    async flushSyncQueue() {
        while (this._queuedDocument) {
            const next = this._queuedDocument;
            this._queuedDocument = null;
            await this.syncDocument(next);
        }
    }

    async syncDocument(documentState) {
        const document = normalizeThreeDDocument(documentState);
        this.activeDocument = document;
        this.applySceneSettings(document);

        const desiredIds = new Set(document.scene.items.map((item) => item.id));
        [...this.sceneObjects.keys()].forEach((itemId) => {
            if (!desiredIds.has(itemId)) {
                this.removeSceneItem(itemId);
            }
        });

        for (const item of document.scene.items) {
            await this.ensureSceneItem(item);
        }

        this.updatePreviewLighting();
        this.updateTrackedLightTargets();
        this.selectObject(document.selection.itemId);
    }

    applySceneSettings(document) {
        const previousRenderMode = this.renderMode;
        this.scene.background = new THREE.Color(document.scene.backgroundColor);
        this.gridHelper.visible = !!document.scene.showGrid;
        this.axesHelper.visible = !!document.scene.showAxes;
        this._cameraMode = document.view.cameraMode === 'fly' ? 'fly' : 'orbit';
        this.transformControl.translationSnap = document.view.snapTranslationStep > 0
            ? Number(document.view.snapTranslationStep)
            : null;
        this.transformControl.rotationSnap = document.view.snapRotationDegrees > 0
            ? THREE.MathUtils.degToRad(Number(document.view.snapRotationDegrees))
            : null;

        this.camera.fov = document.view.fov;
        this.camera.near = document.view.near;
        this.camera.far = document.view.far;
        this.camera.position.fromArray(document.view.cameraPosition);
        this.controls.target.fromArray(document.view.cameraTarget);
        this.syncFlyStateFromCamera(this.controls.target.clone());
        this.camera.lookAt(this.controls.target);
        this.controls.enabled = this._cameraMode === 'orbit' && !this._editLocked && !this.transformControl.dragging;
        if (this._cameraMode === 'orbit') {
            this.controls.update();
        } else {
            this.applyFlyOrientation();
        }
        this.camera.updateProjectionMatrix();

        this.renderer.toneMapping = TONE_MAPPING_MAP[document.render.toneMapping] || THREE.ACESFilmicToneMapping;
        this.renderer.toneMappingExposure = document.render.exposure;
        this.renderMode = document.render.mode;
        this.targetSamples = document.render.samplesTarget;
        if (this.renderMode === 'pathtrace' && previousRenderMode !== 'pathtrace') {
            this.queuePathTraceWarmup('Preparing path tracer...');
        } else if (this.renderMode !== 'pathtrace') {
            this._pathTraceWarmupPending = false;
            this.emitPathTraceLoading(false);
        }
        this.handleLiveCameraChange(true);
        this.updatePreviewLighting();
    }

    updatePreviewLighting() {
        const hasVisibleSceneLight = this.activeDocument.scene.items.some((item) => item.kind === 'light' && item.visible !== false);
        const showPreviewLights = this.renderMode === 'raster' && !hasVisibleSceneLight;
        this.ambientLight.visible = showPreviewLights;
        this.keyLight.visible = showPreviewLights;
    }

    buildItemSignature(item) {
        if (item.kind === 'light') {
            return JSON.stringify({
                kind: item.kind,
                type: item.light?.lightType || 'directional'
            });
        }
        return JSON.stringify({
            kind: item.kind,
            format: item.asset?.format || '',
            primitiveType: item.asset?.primitiveType || '',
            dataUrl: item.asset?.dataUrl || '',
            width: item.asset?.width || 0,
            height: item.asset?.height || 0
        });
    }

    buildItemStateSignature(item) {
        return JSON.stringify({
            name: item.name,
            visible: item.visible !== false,
            locked: !!item.locked,
            position: item.position,
            rotation: item.rotation,
            scale: item.scale,
            light: item.kind === 'light' ? item.light : null,
            material: item.kind !== 'light' ? item.material : null
        });
    }

    async ensureSceneItem(item) {
        const signature = this.buildItemSignature(item);
        const existing = this.sceneObjects.get(item.id);
        const lastSignature = this.itemSignatures.get(item.id);

        if (!existing || signature !== lastSignature) {
            if (existing) this.removeSceneItem(item.id);
            const created = item.kind === 'light'
                ? this.createLightObject(item)
                : item.kind === 'primitive'
                    ? this.createPrimitiveObject(item)
                : item.kind === 'image-plane'
                    ? await this.createImagePlaneObject(item)
                    : await this.createModelObject(item);
            markSceneItem(created, item.id);
            this.scene.add(created);
            this.sceneObjects.set(item.id, created);
            this.itemSignatures.set(item.id, signature);
            this.scheduleSceneRebuild();
        }

        const object = this.sceneObjects.get(item.id);
        const stateSignature = this.buildItemStateSignature(item);
        if (object && this.itemStateSignatures.get(item.id) !== stateSignature) {
            await this.applyItemState(item, object);
            this.itemStateSignatures.set(item.id, stateSignature);
            if (item.kind === 'light') {
                this.refreshPathTracerLights();
            } else {
                this.scheduleSceneRebuild();
            }
        }
    }

    async createModelObject(item) {
        if (!item.asset?.dataUrl) {
            throw new Error(`"${item.name || 'Model'}" is missing embedded model data.`);
        }
        const payload = item.asset.format === 'gltf'
            ? await dataUrlToText(item.asset.dataUrl)
            : await dataUrlToArrayBuffer(item.asset.dataUrl);
        const root = await new Promise((resolve, reject) => {
            this.loader.parse(payload, '', (gltf) => {
                resolve(gltf.scene || gltf.scenes?.[0] || new THREE.Group());
            }, reject);
        });
        root.name = item.name || item.asset.name || 'Model';
        root.traverse((child) => {
            if (!child.isMesh) return;
            child.castShadow = true;
            child.receiveShadow = true;
            child.userData.threeDOriginalMaterialTemplate = cloneMaterialSet(child.material);
        });
        return root;
    }

    createPrimitiveObject(item) {
        const primitiveType = String(item.asset?.primitiveType || 'cube').toLowerCase();
        const geometry = primitiveType === 'sphere'
            ? new THREE.SphereGeometry(0.5, 40, 24)
            : primitiveType === 'cone'
                ? new THREE.ConeGeometry(0.5, 1, 40, 1)
            : primitiveType === 'cylinder'
                ? new THREE.CylinderGeometry(0.5, 0.5, 1, 40, 1)
                : new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            roughness: 0.65,
            metalness: 0
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = item.name || item.asset?.name || 'Primitive';
        mesh.userData.threeDOriginalMaterialTemplate = cloneMaterialSet(material);
        return mesh;
    }

    async createImagePlaneObject(item) {
        const texture = await this.createConfiguredTexture(item.asset, {
            flipY: true,
            repeat: [1, 1],
            offset: [0, 0],
            rotation: 0
        });
        const aspect = Math.max(0.0001, Number(item.asset?.width || 1)) / Math.max(0.0001, Number(item.asset?.height || 1));
        const width = aspect >= 1 ? aspect : 1;
        const height = aspect >= 1 ? 1 : (1 / aspect);
        const geometry = new THREE.PlaneGeometry(width, height, 1, 1);
        const material = new THREE.MeshStandardMaterial({
            color: 0xffffff,
            map: texture,
            transparent: true,
            alphaTest: 0.001,
            side: THREE.DoubleSide,
            metalness: 0,
            roughness: 1
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.name = item.name || item.asset?.name || 'Image Plane';
        mesh.userData.threeDOriginalMaterialTemplate = cloneMaterialSet(material);
        return mesh;
    }

    createLightObject(item) {
        const config = item.light || {};
        const root = new THREE.Group();
        root.name = item.name || 'Light';

        let light;
        if (config.lightType === 'point') {
            light = new THREE.PointLight(0xffffff, 2, config.distance || 50, config.decay || 1);
        } else if (config.lightType === 'spot') {
            light = new THREE.SpotLight(0xffffff, 2, config.distance || 50, config.angle || (Math.PI / 6), config.penumbra || 0.35, config.decay || 1);
        } else {
            light = new THREE.DirectionalLight(0xffffff, 1.5);
        }

        light.castShadow = config.castShadow !== false;
        light.position.set(0, 0, 0);
        root.add(light);

        if (light.isDirectionalLight || light.isSpotLight) {
            const target = new THREE.Object3D();
            target.position.set(0, 0, -1);
            root.add(target);
            light.target = target;
        }

        let helper = null;
        if (light.isDirectionalLight) helper = new THREE.DirectionalLightHelper(light, 2);
        else if (light.isPointLight) helper = new THREE.PointLightHelper(light, 0.75);
        else if (light.isSpotLight) helper = new THREE.SpotLightHelper(light);

        if (helper) {
            markSceneItem(helper, item.id);
            this.registerEditorObject(helper);
            this.itemHelpers.set(item.id, helper);
        }

        this.itemLights.set(item.id, light);
        return root;
    }

    async getBaseTexture(dataUrl) {
        if (this.textureCache.has(dataUrl)) {
            return this.textureCache.get(dataUrl);
        }
        const promise = new Promise((resolve, reject) => {
            this.textureLoader.load(dataUrl, (texture) => {
                if ('colorSpace' in texture) {
                    texture.colorSpace = THREE.SRGBColorSpace;
                }
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                texture.needsUpdate = true;
                resolve(texture);
            }, undefined, reject);
        });
        this.textureCache.set(dataUrl, promise);
        return promise;
    }

    async createConfiguredTexture(textureConfig, options = {}) {
        const baseTexture = await this.getBaseTexture(textureConfig.dataUrl);
        const texture = baseTexture.clone();
        texture.userData = {
            ...(texture.userData || {}),
            threeDOwnedTexture: true
        };
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(
            Number(options.repeat?.[0] ?? textureConfig.repeat?.[0] ?? 1),
            Number(options.repeat?.[1] ?? textureConfig.repeat?.[1] ?? 1)
        );
        texture.offset.set(
            Number(options.offset?.[0] ?? textureConfig.offset?.[0] ?? 0),
            Number(options.offset?.[1] ?? textureConfig.offset?.[1] ?? 0)
        );
        texture.center.set(0.5, 0.5);
        texture.rotation = Number(options.rotation ?? textureConfig.rotation ?? 0);
        if (typeof options.flipY === 'boolean') {
            texture.flipY = options.flipY;
        }
        texture.needsUpdate = true;
        return texture;
    }

    createCustomMaterial(template, config, mapTexture = null, options = {}) {
        const emissiveIntensity = Number(config.emissiveIntensity ?? (config.preset === 'emissive' ? 4 : 0));
        const baseOptions = {
            color: new THREE.Color(normalizeHexColor(config.color, '#ffffff')),
            transparent: Boolean(config.opacity < 1 || mapTexture || options.transparent),
            opacity: Number(config.opacity ?? 1),
            side: options.side ?? template?.side ?? THREE.FrontSide,
            vertexColors: !!template?.vertexColors,
            flatShading: !!template?.flatShading,
            emissive: new THREE.Color(normalizeHexColor(config.emissiveColor, config.preset === 'emissive' ? config.color : '#000000')),
            emissiveIntensity,
            map: mapTexture || null
        };

        if (config.preset === 'glass') {
            return new THREE.MeshPhysicalMaterial({
                ...baseOptions,
                roughness: Number(config.roughness ?? 0.05),
                metalness: 0,
                transmission: Number(config.transmission ?? 1),
                ior: Number(config.ior ?? 1.5),
                thickness: Number(config.thickness ?? 0.35),
                attenuationColor: new THREE.Color(normalizeHexColor(config.attenuationColor, '#ffffff')),
                attenuationDistance: Number(config.attenuationDistance ?? 1.5)
            });
        }

        const material = new THREE.MeshStandardMaterial({
            ...baseOptions,
            roughness: Number(config.roughness ?? (config.preset === 'metal' ? 0.2 : 0.65)),
            metalness: Number(config.preset === 'metal' ? (config.metalness ?? 1) : (config.metalness ?? 0))
        });
        if (config.preset === 'emissive' && material.map) {
            material.emissiveMap = material.map;
        }
        return material;
    }

    async applyRenderableMaterial(item, object) {
        const isImagePlane = item.kind === 'image-plane';
        const meshes = [];
        object.traverse((child) => {
            if (child.isMesh) {
                meshes.push(child);
            }
        });

        for (const mesh of meshes) {
            const template = mesh.userData.threeDOriginalMaterialTemplate || mesh.material;
            if (!template) continue;

            let nextMaterial;
            if (isImagePlane) {
                const planeTexture = await this.createConfiguredTexture(item.asset, {
                    flipY: true,
                    repeat: [1, 1],
                    offset: [0, 0],
                    rotation: 0
                });
                nextMaterial = this.createCustomMaterial(
                    Array.isArray(template) ? template[0] : template,
                    {
                        ...item.material,
                        preset: 'matte'
                    },
                    planeTexture,
                    { transparent: true, side: THREE.DoubleSide }
                );
                nextMaterial.alphaTest = 0.001;
            } else if (item.material?.preset === 'original') {
                nextMaterial = cloneMaterialSet(template);
            } else {
                const texture = item.material?.texture
                    ? await this.createConfiguredTexture(item.material.texture, {
                        flipY: false
                    })
                    : null;
                if (Array.isArray(template)) {
                    nextMaterial = template.map((entry) => this.createCustomMaterial(entry, item.material, texture ? texture.clone() : null));
                    nextMaterial.forEach((entry) => {
                        if (entry.map) {
                            entry.map.userData = {
                                ...(entry.map.userData || {}),
                                threeDOwnedTexture: true
                            };
                            entry.map.needsUpdate = true;
                        }
                    });
                } else {
                    nextMaterial = this.createCustomMaterial(template, item.material, texture);
                }
            }

            disposeMaterialSet(mesh.material);
            mesh.material = nextMaterial;
            getMaterialList(mesh.material).forEach((material) => {
                material.needsUpdate = true;
            });
        }
    }

    async applyItemState(item, object) {
        object.name = item.name;
        object.visible = item.visible !== false;
        object.position.fromArray(item.position);
        object.rotation.set(item.rotation[0], item.rotation[1], item.rotation[2]);
        object.scale.fromArray(item.scale);
        object.userData.locked = !!item.locked;

        if (item.kind === 'light') {
            const light = this.itemLights.get(item.id);
            const helper = this.itemHelpers.get(item.id);
            if (!light) return;
            light.color.set(normalizeHexColor(item.light?.color, '#ffffff'));
            light.intensity = Number(item.light?.intensity || 0);
            light.castShadow = item.light?.castShadow !== false;
            if (light.isPointLight || light.isSpotLight) {
                light.distance = Number(item.light?.distance || light.distance || 0);
                light.decay = Number(item.light?.decay || light.decay || 1);
            }
            if (light.isSpotLight) {
                light.angle = Number(item.light?.angle || light.angle || (Math.PI / 6));
                light.penumbra = Number(item.light?.penumbra || light.penumbra || 0.35);
            }
            if (helper) {
                helper.visible = object.visible;
                helper.update?.();
            }
            return;
        }

        await this.applyRenderableMaterial(item, object);
    }

    removeSceneItem(itemId) {
        const object = this.sceneObjects.get(itemId);
        if (!object) return;
        if (this.transformControl.object === object) {
            this.transformControl.detach();
        }
        const helper = this.itemHelpers.get(itemId);
        if (helper) {
            this.scene.remove(helper);
            this.editorObjects.delete(helper);
            helper.dispose?.();
            this.itemHelpers.delete(itemId);
        }
        this.scene.remove(object);
        disposeObject3D(object);
        this.sceneObjects.delete(itemId);
        this.itemLights.delete(itemId);
        this.itemSignatures.delete(itemId);
        this.itemStateSignatures.delete(itemId);
        this.scheduleSceneRebuild();
    }

    selectObject(itemId) {
        const object = itemId ? this.sceneObjects.get(itemId) : null;
        if (object) {
            this.transformControl.attach(object);
        } else {
            this.transformControl.detach();
        }
    }

    setTransformMode(mode) {
        if (mode === 'translate' || mode === 'rotate' || mode === 'scale') {
            this.transformControl.setMode(mode);
        }
    }

    frameSelectedObject() {
        const object = this.transformControl.object;
        if (!object) return;
        const box = new THREE.Box3().setFromObject(object);
        if (box.isEmpty()) {
            const itemId = extractItemId(object);
            const helper = itemId ? this.itemHelpers.get(itemId) : null;
            if (helper) {
                box.setFromObject(helper);
            }
        }
        if (box.isEmpty()) return;
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        box.getCenter(center);
        box.getSize(size);
        const radius = Math.max(size.length() * 0.5, 1);
        const direction = this.camera.position.clone().sub(this.controls.target).normalize();
        if (!Number.isFinite(direction.lengthSq()) || direction.lengthSq() === 0) {
            direction.set(1, 0.7, 1).normalize();
        }
        this.controls.target.copy(center);
        this.camera.position.copy(center).add(direction.multiplyScalar(radius * 2.6));
        this.syncFlyStateFromCamera(center.clone());
        if (this._cameraMode === 'orbit') {
            this.controls.update();
        } else {
            this.applyFlyOrientation();
        }
        this.commitCameraState();
    }

    getCameraSnapshot() {
        if (this._cameraMode === 'orbit') {
            this.controls.update();
        }
        return {
            cameraPosition: this.camera.position.toArray(),
            cameraTarget: this.controls.target.toArray(),
            fov: this.camera.fov,
            near: this.camera.near,
            far: this.camera.far
        };
    }

    resetCamera(documentState = this.activeDocument) {
        const document = normalizeThreeDDocument(documentState);
        this.camera.position.fromArray(document.view.cameraPosition);
        this.controls.target.fromArray(document.view.cameraTarget);
        this.syncFlyStateFromCamera(this.controls.target.clone());
        if (this._cameraMode === 'orbit') {
            this.controls.update();
        } else {
            this.applyFlyOrientation();
        }
        this.commitCameraState();
    }

    emitTransformPreview(object) {
        const itemId = extractItemId(object);
        if (!itemId) return;
        this.onTransformPreview?.({
            itemId,
            position: object.position.toArray(),
            rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
            scale: object.scale.toArray()
        });
    }

    commitTransformState(object) {
        const itemId = extractItemId(object);
        if (!itemId) return;
        this.onTransformCommitted?.(itemId, {
            position: object.position.toArray(),
            rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
            scale: object.scale.toArray()
        });
        this.scheduleSceneRebuild();
    }

    commitCameraState() {
        if (this._cameraMode === 'orbit') {
            this.controls.update();
        }
        this.onCameraCommitted?.({
            cameraPosition: this.camera.position.toArray(),
            cameraTarget: this.controls.target.toArray(),
            fov: this.camera.fov,
            near: this.camera.near,
            far: this.camera.far
        });
        this.handleLiveCameraChange(true);
    }

    scheduleSceneRebuild() {
        if (this.destroyed) return;
        if (this._sceneRebuildTimer) clearTimeout(this._sceneRebuildTimer);
        this._sceneRebuildTimer = setTimeout(() => {
            this._sceneRebuildTimer = null;
            if (this.destroyed) return;
            this.rebuildPathTracerScene();
        }, 60);
    }

    async capturePreview(size = 320) {
        if (this.renderMode === 'raster' || this.pathTracer.samples < 1) {
            this.renderer.render(this.scene, this.camera);
        }
        const sourceCanvas = this.renderer.domElement;
        const aspect = sourceCanvas.width / Math.max(1, sourceCanvas.height);
        const width = size;
        const height = Math.max(1, Math.round(size / Math.max(aspect, 0.1)));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        context.fillStyle = normalizeHexColor(this.activeDocument.scene.backgroundColor, '#202020');
        context.fillRect(0, 0, width, height);
        context.drawImage(sourceCanvas, 0, 0, width, height);
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        const dataUrl = canvas.toDataURL('image/png');
        return {
            blob,
            dataUrl,
            width,
            height
        };
    }

    updateLight(itemId, patch = {}) {
        const light = this.itemLights.get(itemId);
        if (!light?.isLight) return;
        if (patch.color) light.color.set(normalizeHexColor(patch.color));
        if (patch.intensity != null) light.intensity = Number(patch.intensity);
        if (light.isPointLight || light.isSpotLight) {
            if (patch.distance != null) light.distance = Number(patch.distance);
            if (patch.decay != null) light.decay = Number(patch.decay);
        }
        if (light.isSpotLight) {
            if (patch.angle != null) light.angle = Number(patch.angle);
            if (patch.penumbra != null) light.penumbra = Number(patch.penumbra);
        }
        light.castShadow = patch.castShadow !== false;
        this.itemHelpers.get(itemId)?.update?.();
        this.onLightCommitted?.(itemId, patch);
        this.updateTrackedLightTargets();
        this.refreshPathTracerLights();
    }

    renderEditorOverlay() {
        const hiddenObjects = [];
        this.sceneObjects.forEach((object) => {
            if (object?.visible) {
                hiddenObjects.push(object);
                object.visible = false;
            }
        });

        const previousBackground = this.scene.background;
        const previousAutoClear = this.renderer.autoClear;
        this.scene.background = null;
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        this.scene.background = previousBackground;
        this.renderer.autoClear = previousAutoClear;

        hiddenObjects.forEach((object) => {
            object.visible = true;
        });
    }

    isBackgroundRenderActive() {
        return !!this._backgroundRenderJob?.active;
    }

    setEditingLocked(locked) {
        this._editLocked = !!locked;
        if (this._editLocked) {
            this._flyKeys.clear();
            this.endFlyLook(false);
        }
        this.controls.enabled = this._cameraMode === 'orbit' && !this._editLocked && !this.transformControl.dragging;
        this.transformControl.enabled = !this._editLocked;
    }

    async startBackgroundRender({
        documentState = this.activeDocument,
        samples = 256,
        width = 1920,
        height = 1080,
        fileName = '3d-render.png'
    } = {}) {
        if (this._backgroundRenderJob?.active) {
            throw new Error('A render is already running.');
        }

        const normalized = normalizeThreeDDocument(documentState);
        const outputWidth = Math.max(16, Math.round(width));
        const outputHeight = Math.max(16, Math.round(height));
        const requestedSamples = Math.max(1, Math.round(samples));
        const hiddenCanvas = createHiddenCanvas(outputWidth, outputHeight);
        const renderer = new THREE.WebGLRenderer({
            canvas: hiddenCanvas,
            antialias: true,
            alpha: false,
            preserveDrawingBuffer: true
        });
        renderer.setPixelRatio(1);
        renderer.setSize(outputWidth, outputHeight, false);
        renderer.toneMapping = TONE_MAPPING_MAP[normalized.render.toneMapping] || THREE.ACESFilmicToneMapping;
        renderer.toneMappingExposure = normalized.render.exposure;

        const tracer = new WebGLPathTracer(renderer);
        tracer.renderScale = 1;
        tracer.tiles.set(2, 2);
        tracer.renderDelay = 0;
        tracer.minSamples = 0;

        const renderCamera = this.camera.clone();
        renderCamera.aspect = outputWidth / Math.max(1, outputHeight);
        renderCamera.position.fromArray(normalized.view.cameraPosition);
        renderCamera.near = normalized.view.near;
        renderCamera.far = normalized.view.far;
        renderCamera.fov = normalized.view.fov;
        renderCamera.lookAt(new THREE.Vector3(...normalized.view.cameraTarget));
        renderCamera.updateProjectionMatrix();

        const job = {
            active: true,
            aborted: false,
            renderer,
            tracer,
            hiddenCanvas,
            fileName: String(fileName || '3d-render.png'),
            lastNotifiedAt: 0,
            lastNotifiedSamples: -1
        };
        this._backgroundRenderJob = job;
        this.setEditingLocked(true);

        const notifyUpdate = (payload, force = false) => {
            const currentSamples = Math.floor(payload.currentSamples ?? job.tracer.samples ?? 0);
            const now = Date.now();
            if (!force && currentSamples === job.lastNotifiedSamples && now - job.lastNotifiedAt < 160) {
                return;
            }
            job.lastNotifiedSamples = currentSamples;
            job.lastNotifiedAt = now;
            this.onBackgroundRenderUpdate?.({
                active: true,
                status: 'running',
                requestedSamples,
                outputWidth,
                outputHeight,
                fileName: job.fileName,
                ...payload
            });
        };

        const startedAt = Date.now();
        notifyUpdate({
            currentSamples: 0,
            startedAt,
            message: 'Building render scene...'
        }, true);

        try {
            await new Promise((resolve) => requestAnimationFrame(resolve));
            this.updateTrackedLightTargets();
            this.withPathTracerExclusions(() => tracer.setScene(this.scene, renderCamera));
            notifyUpdate({
                currentSamples: 0,
                startedAt,
                message: 'Compiling render kernels...'
            }, true);
            await new Promise((resolve) => requestAnimationFrame(resolve));

            while (!job.aborted && tracer.samples < requestedSamples) {
                tracer.renderSample();
                const currentSamples = Math.floor(tracer.samples);
                if (currentSamples !== job.lastNotifiedSamples) {
                    notifyUpdate({
                        currentSamples,
                        message: 'Rendering...'
                    });
                }
                await new Promise((resolve) => requestAnimationFrame(resolve));
            }

            if (job.aborted) {
                this.onBackgroundRenderUpdate?.({
                    active: false,
                    status: 'aborted',
                    requestedSamples,
                    currentSamples: Math.floor(tracer.samples),
                    outputWidth,
                    outputHeight,
                    fileName: job.fileName,
                    finishedAt: Date.now(),
                    message: 'Render aborted.'
                }, true);
                return { aborted: true };
            }

            notifyUpdate({
                currentSamples: Math.floor(tracer.samples),
                message: 'Encoding PNG...'
            }, true);
            const blob = await new Promise((resolve) => hiddenCanvas.toBlob(resolve, 'image/png'));
            if (!blob) {
                throw new Error('The render finished, but the browser could not encode the PNG.');
            }
            downloadBlob(blob, job.fileName);
            this.onBackgroundRenderUpdate?.({
                active: false,
                status: 'complete',
                requestedSamples,
                currentSamples: Math.floor(tracer.samples),
                outputWidth,
                outputHeight,
                fileName: job.fileName,
                finishedAt: Date.now(),
                message: 'Render complete. PNG exported.'
            }, true);
            return {
                aborted: false,
                blob
            };
        } finally {
            disposePathTracerSafely(tracer);
            renderer.dispose();
            hiddenCanvas.remove();
            this._backgroundRenderJob = null;
            this.setEditingLocked(false);
        }
    }

    abortBackgroundRender() {
        if (!this._backgroundRenderJob?.active) return false;
        this._backgroundRenderJob.aborted = true;
        return true;
    }

    animate() {
        if (this.destroyed) return;
        requestAnimationFrame(this.animate);
        const deltaTime = this.clock.getDelta();
        if (this._cameraMode === 'orbit') {
            this.controls.update();
        } else {
            this.updateFlyMovement(deltaTime);
        }
        this.handleLiveCameraChange();
        this.updateTrackedLightTargets();
        this.itemHelpers.forEach((helper) => helper?.update?.());

        if (this.renderMode === 'pathtrace') {
            if (this._pathTraceWarmupPending) {
                this._pathTraceWarmupPending = false;
                this.renderer.render(this.scene, this.camera);
                this.renderEditorOverlay();
                this.onSamplesUpdated?.(0);
                return;
            }
            if (this.targetSamples <= 0 || this.pathTracer.samples < this.targetSamples) {
                if (this.pathTracer.samples < 1 && !this._pathTraceLoadingActive) {
                    this.emitPathTraceLoading(true, 'Preparing path tracer...');
                }
                this.pathTracer.renderSample();
            }
            if (this.pathTracer.samples > 0) {
                this.emitPathTraceLoading(false);
            }
            this.renderEditorOverlay();
            this.onSamplesUpdated?.(Math.round(this.pathTracer.samples));
        } else {
            if (this._pathTraceLoadingActive) {
                this.emitPathTraceLoading(false);
            }
            this.renderer.render(this.scene, this.camera);
            this.onSamplesUpdated?.(0);
        }
    }

    destroy() {
        this.destroyed = true;
        this.abortBackgroundRender();
        if (this._sceneRebuildTimer) clearTimeout(this._sceneRebuildTimer);
        if (this._cameraCommitTimer) clearTimeout(this._cameraCommitTimer);
        window.removeEventListener('pointermove', this.handleWindowPointerMove);
        window.removeEventListener('pointerup', this.handleWindowPointerUp);
        window.removeEventListener('keydown', this.handleWindowKeyDown);
        window.removeEventListener('keyup', this.handleWindowKeyUp);
        window.removeEventListener('blur', this.handleWindowBlur);
        this.transformControl.dispose();
        this.controls.dispose();
        this.resizeObserver.disconnect();
        disposePathTracerSafely(this.pathTracer);
        this.sceneObjects.forEach((_object, itemId) => this.removeSceneItem(itemId));
        this.container.removeChild(this.renderer.domElement);
        this.renderer.dispose();
    }
}

export { dataUrlToBlob };
