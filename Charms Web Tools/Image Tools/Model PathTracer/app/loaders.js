import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { applyBVH } from './bvh.js';
import { createGlassMaterial, applyTexture } from './materials.js';
import { resetSamples } from './renderer.js';

export function initLoaders(state) {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    // Prevent default drag behaviors
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    // Highlight drop zone
    ['dragenter', 'dragover'].forEach(eventName => {
        document.body.addEventListener(eventName, () => {
            dropZone.classList.remove('hidden');
            dropZone.classList.add('active');
        }, false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        document.body.addEventListener(eventName, (e) => {
            if (e.target === dropZone) {
                dropZone.classList.remove('active');
                dropZone.classList.add('hidden');
            }
        }, false);
    });

    document.body.addEventListener('drop', (e) => {
        dropZone.classList.remove('active');
        dropZone.classList.add('hidden');
        handleFiles(e.dataTransfer.files, state);
    });

    fileInput.addEventListener('change', (e) => {
        handleFiles(e.target.files, state);
    });
}

function handleFiles(files, state) {
    if (!files.length) return;
    const file = files[0];
    const ext = file.name.split('.').pop().toLowerCase();

    window.showLoading(`Loading ${file.name}...`);

    if (ext === 'glb' || ext === 'gltf') {
        loadGLTF(file, state);
    } else if (['jpg', 'jpeg', 'png', 'webp'].includes(ext)) {
        loadTexture(file, state);
    } else {
        window.showError(`Unsupported file format: ${ext}`);
        window.hideLoading();
    }
}

async function loadGLTF(file, state) {
    const url = URL.createObjectURL(file);
    const loader = new GLTFLoader();
    
    // Optional: DRACO
    const dracoLoader = new DRACOLoader();
    dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/libs/draco/');
    loader.setDRACOLoader(dracoLoader);

    try {
        const gltf = await loader.loadAsync(url);
        
        // Remove old model
        if (state.model) {
            state.scene.remove(state.model);
            // In a pro app, we'd dispose geometry/materials properly here
        }

        const model = gltf.scene;
        state.model = model;

        // Apply custom material only if override is enabled
        model.traverse((child) => {
            if (child.isMesh) {
                if (state.guiSettings && state.guiSettings.overrideMaterial) {
                    child.material = createGlassMaterial(state);
                }
                child.material.needsUpdate = true;
            }
        });

        // Compute BVH
        applyBVH(model);

        // Center and scale model
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        
        const maxDim = Math.max(size.x, size.y, size.z);
        const scale = 2.0 / maxDim; // Fit inside a 2-unit box
        
        model.scale.setScalar(scale);
        model.position.sub(center.multiplyScalar(scale));

        state.scene.add(model);
        pathTracerUpdate(state);

    } catch (e) {
        console.error(e);
        window.showError("Failed to load GLTF.", 5000);
    } finally {
        window.hideLoading();
        URL.revokeObjectURL(url);
    }
}

async function loadTexture(file, state) {
    const url = URL.createObjectURL(file);
    const loader = new THREE.TextureLoader();
    
    try {
        const tex = await loader.loadAsync(url);
        tex.flipY = false;
        tex.colorSpace = THREE.SRGBColorSpace;
        
        state.uploadedTexture = tex;
        
        if (state.model) {
            applyTexture(state.model, tex, state);
            pathTracerUpdate(state);
        } else {
            window.showError("Please load a model first.", 3000);
        }
    } catch(e) {
        window.showError("Failed to load Texture.");
    } finally {
        window.hideLoading();
        URL.revokeObjectURL(url);
    }
}

function pathTracerUpdate(state) {
    state.pathTracer.updateEnvironment(); // Refresh scene data
    state.pathTracer.updateMaterials();
    resetSamples(state.pathTracer);
}
