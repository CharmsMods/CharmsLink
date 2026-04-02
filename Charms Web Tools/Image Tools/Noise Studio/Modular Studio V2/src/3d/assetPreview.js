import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

function disposeMaterial(material) {
    if (Array.isArray(material)) {
        material.forEach((entry) => disposeMaterial(entry));
        return;
    }
    if (!material) return;
    Object.values(material).forEach((value) => {
        if (value?.isTexture) value.dispose?.();
    });
    material.dispose?.();
}

function disposeObject(root) {
    if (!root) return;
    root.traverse((child) => {
        child.geometry?.dispose?.();
        if (child.material) {
            disposeMaterial(child.material);
        }
    });
}

function fitCameraToObject(camera, controls, object) {
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxSize = Math.max(size.x, size.y, size.z, 0.5);
    const distance = maxSize * 1.85;
    camera.position.set(center.x + distance, center.y + distance * 0.55, center.z + distance);
    camera.near = Math.max(0.01, distance / 100);
    camera.far = Math.max(100, distance * 20);
    camera.updateProjectionMatrix();
    controls.target.copy(center);
    controls.update();
}

function dataUrlToArrayBuffer(dataUrl) {
    return fetch(dataUrl).then((response) => response.arrayBuffer());
}

function dataUrlToText(dataUrl) {
    return fetch(dataUrl).then((response) => response.text());
}

export class ThreeDAssetPreview {
    constructor(host) {
        this.host = host;
        this.loader = new GLTFLoader();
        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(46, 1, 0.01, 1000);
        this.renderer = new THREE.WebGLRenderer({
            antialias: true,
            alpha: true,
            preserveDrawingBuffer: true
        });
        this.renderer.setClearColor(0x000000, 0);
        this.renderer.domElement.style.width = '100%';
        this.renderer.domElement.style.height = '100%';
        this.renderer.domElement.style.display = 'block';
        this.renderer.domElement.style.outline = 'none';
        this.host.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.08;
        this.controls.enablePan = true;
        this.controls.enableZoom = true;
        this.controls.minDistance = 0.2;
        this.controls.maxDistance = 300;

        this.scene.add(new THREE.HemisphereLight(0xf2f4ff, 0x111018, 1.35));
        const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
        keyLight.position.set(6, 8, 5);
        this.scene.add(keyLight);
        const fillLight = new THREE.DirectionalLight(0xaab8ff, 0.65);
        fillLight.position.set(-5, 3, -6);
        this.scene.add(fillLight);

        this.currentRoot = null;
        this.destroyed = false;
        this.loadToken = 0;
        this.animate = this.animate.bind(this);
        this.handleResize = this.handleResize.bind(this);
        this.resizeObserver = new ResizeObserver(this.handleResize);
        this.resizeObserver.observe(this.host);
        this.handleResize();
        this.animate();
    }

    handleResize() {
        if (this.destroyed) return;
        const width = Math.max(1, Math.round(this.host.clientWidth || 1));
        const height = Math.max(1, Math.round(this.host.clientHeight || 1));
        this.camera.aspect = width / Math.max(1, height);
        this.camera.updateProjectionMatrix();
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        this.renderer.setSize(width, height, false);
        this.renderNow();
    }

    animate() {
        if (this.destroyed) return;
        this.animationFrame = requestAnimationFrame(this.animate);
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    renderNow() {
        if (this.destroyed) return;
        this.renderer.render(this.scene, this.camera);
    }

    clear() {
        if (!this.currentRoot) return;
        this.scene.remove(this.currentRoot);
        disposeObject(this.currentRoot);
        this.currentRoot = null;
        this.renderNow();
    }

    async createObject(assetRecord) {
        const normalizedFormat = String(assetRecord?.format || '').toLowerCase();
        if (normalizedFormat === 'gltf') {
            const text = await dataUrlToText(assetRecord.dataUrl);
            return new Promise((resolve, reject) => {
                this.loader.parse(text, '', (gltf) => {
                    resolve(gltf.scene || gltf.scenes?.[0] || new THREE.Group());
                }, reject);
            });
        }
        const buffer = await dataUrlToArrayBuffer(assetRecord.dataUrl);
        return new Promise((resolve, reject) => {
            this.loader.parse(buffer, '', (gltf) => {
                resolve(gltf.scene || gltf.scenes?.[0] || new THREE.Group());
            }, reject);
        });
    }

    async loadAsset(assetRecord) {
        if (this.destroyed) return;
        const token = ++this.loadToken;
        const root = await this.createObject(assetRecord);
        if (this.destroyed || token !== this.loadToken) {
            disposeObject(root);
            return;
        }
        this.clear();
        this.currentRoot = root;
        this.scene.add(root);
        fitCameraToObject(this.camera, this.controls, root);
        this.renderNow();
    }

    destroy() {
        this.destroyed = true;
        this.loadToken += 1;
        if (this.animationFrame) {
            cancelAnimationFrame(this.animationFrame);
        }
        this.resizeObserver?.disconnect();
        this.controls?.dispose?.();
        this.clear();
        this.renderer?.dispose?.();
        if (this.renderer?.domElement?.parentNode === this.host) {
            this.renderer.domElement.remove();
        }
    }
}

export function createThreeDAssetPreview(host) {
    return new ThreeDAssetPreview(host);
}
