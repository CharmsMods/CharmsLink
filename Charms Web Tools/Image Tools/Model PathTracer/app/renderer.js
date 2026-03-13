import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGLPathTracer } from 'three-gpu-pathtracer';

export async function setupRenderer() {
    // 1. Core Three.js Setup
    const canvas = document.getElementById('gl-canvas');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setClearColor(0xcccccc);
    
    // Physical lighting requirements
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    const scene = new THREE.Scene();
    
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(2, 2, -3);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;

    // 2. Initialize Path Tracer
    const pathTracer = new WebGLPathTracer(renderer);
    pathTracer.setScene(scene, camera);
    pathTracer.renderToCanvas = true; // Ensure it draws directly to our visible canvas
    pathTracer.renderScale = 1;
    
    // It's highly recommended to use an HDRI for physical glass rendering
    // We'll load a very small proxy HDRI (or use scene background if missing)
    loadEnvironment(scene, pathTracer);

    // 3. Handle Resizing
    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
        pathTracer.updateCamera();
        resetSamples(pathTracer);
    });
    
    // When camera moves, reset path tracer accumulation
    controls.addEventListener('change', () => {
        resetSamples(pathTracer);
    });

    return { scene, camera, renderer, pathTracer, controls };
}

export function renderFrame(state) {
    if (!state.renderer || !state.pathTracer) return;
    
    state.controls.update();

    if (!state.paused) {
        // Accumulate another sample
        if (state.pathTracer.samples < state.maxSamples) {
            state.pathTracer.renderSample();
            
            // Auto export trigger
            if (state.autoExport && Math.floor(state.pathTracer.samples) === state.maxSamples) {
                // Prevent infinite exports
                state.paused = true;
                window.exportPNG(state.guiSettings ? state.guiSettings.ExportRes : window.innerWidth);
            }
        }
    }

    // Update UI readout
    if (state.samplesEl) {
        state.samplesEl.textContent = `Samples: ${Math.floor(state.pathTracer.samples)} / ${state.maxSamples}`;
    }
}

export function resetSamples(pathTracer) {
    if (pathTracer) {
        // According to three-gpu-pathtracer API
        pathTracer.updateCamera(); // Invalidate cache
    }
}

// Creates a small equirectangular DataTexture filled with a solid color.
// three-gpu-pathtracer requires scene.environment to be a real Texture
// (not a THREE.Color), or it crashes in EquirectHdrInfoUniform.updateFrom.
export function createSolidEnvTexture(color) {
    const width = 16;
    const height = 8;
    const size = width * height;
    const data = new Float32Array(size * 4);
    
    const c = color instanceof THREE.Color ? color : new THREE.Color(color);
    for (let i = 0; i < size; i++) {
        const stride = i * 4;
        data[stride]     = c.r;
        data[stride + 1] = c.g;
        data[stride + 2] = c.b;
        data[stride + 3] = 1.0;
    }
    
    const tex = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.needsUpdate = true;
    return tex;
}

// Internal helper for environment light
async function loadEnvironment(scene, pathTracer) {
    // Use a bright neutral background so the path tracer has real illumination.
    const envColor = new THREE.Color(0xcccccc);
    scene.background = envColor;
    
    // Create a proper texture for the environment map — the path tracer
    // needs a real texture, not a Color object.
    scene.environment = createSolidEnvTexture(envColor);
    
    pathTracer.updateEnvironment();
}
