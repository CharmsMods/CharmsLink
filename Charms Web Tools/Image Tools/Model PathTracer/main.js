import * as THREE from 'three';
import { setupRenderer, renderFrame } from './app/renderer.js';
import { initUI } from './app/ui.js';
import { initLoaders } from './app/loaders.js';

// Application State
export const state = {
    scene: null,
    camera: null,
    renderer: null,
    pathTracer: null,
    controls: null,
    gui: null,
    
    model: null,
    glassMaterial: null,
    uploadedTexture: null,
    lights: [], // Track added lights
    
    // Render settings
    paused: false,
    resolutionScale: 1.0,
    maxSamples: 100,
    autoExport: false,
    bgColor: '#cccccc', // Bright neutral environment for path tracing
    
    // UI Elements
    samplesEl: null,
    loadingEl: null,
    errorEl: null,
};

async function init() {
    // 1. Setup UI DOM references
    state.samplesEl = document.getElementById('samples-count');
    state.loadingEl = document.getElementById('loading-overlay');
    state.errorEl = document.getElementById('error-message');
    
    // 2. Initialize Core Renderer (Three.js + PathTracer)
    const { scene, camera, renderer, pathTracer, controls } = await setupRenderer();
    state.scene = scene;
    state.camera = camera;
    state.renderer = renderer;
    state.pathTracer = pathTracer;
    state.controls = controls;
    
    // Add a default helper to scene
    const gridHelper = new THREE.GridHelper(10, 10, 0x444444, 0x222222);
    gridHelper.position.y = -0.01;
    scene.add(gridHelper);

    // 3. Initialize UI (lil-gui and HTML overlays)
    initUI(state);
    
    // 4. Initialize Loaders (Drag & Drop, etc.)
    initLoaders(state);

    // 5. Start Render Loop
    requestAnimationFrame(animate);
}

function animate() {
    requestAnimationFrame(animate);
    renderFrame(state);
}

// Global error handler
window.showError = (msg, duration = 5000) => {
    let errorEl = document.getElementById('error-message');
    if (!errorEl) {
        errorEl = document.createElement('div');
        errorEl.id = 'error-message';
        document.body.appendChild(errorEl);
    }
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
    
    if(window.errorTimeout) clearTimeout(window.errorTimeout);
    window.errorTimeout = setTimeout(() => {
        errorEl.style.display = 'none';
    }, duration);
};

window.showLoading = (msg) => {
    let el = document.getElementById('loading-overlay');
    if (!el) {
        el = document.createElement('div');
        el.id = 'loading-overlay';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = 'block';
};

window.hideLoading = () => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.display = 'none';
};

init().catch(err => {
    console.error("Initialization failed:", err);
    alert("Failed to initialize WebGL / PathTracer. Check console.");
});
