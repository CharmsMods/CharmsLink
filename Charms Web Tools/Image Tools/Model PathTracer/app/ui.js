import * as THREE from 'three';
import GUI from 'lil-gui';
import { defaultMaterialSettings, updateMaterials } from './materials.js';
import { exportPNG } from './export.js';
import { resetSamples, createSolidEnvTexture } from './renderer.js';

export function initUI(state) {
    // Merge default settings into state
    state.guiSettings = { ...defaultMaterialSettings };
    state.guiSettings.MaxSamples = state.maxSamples;
    state.guiSettings.ExportRes = 1024;
    state.guiSettings.AutoExport = state.autoExport;
    
    // Create UI overlay structure
    setupHTMLUI(state);

    // Create complex lil-gui for parameters
    setupGUI(state);

    // Keyboard bindings
    setupKeyboard(state);
}

function setupHTMLUI(state) {
    const container = document.getElementById('ui-container');

    // Readout panel (Top Left)
    const readout = document.createElement('div');
    readout.className = 'overlay-panel top-left';
    readout.id = 'status-readout';
    
    const countRow = document.createElement('div');
    countRow.className = 'status-row';
    const clbl = document.createElement('span'); clbl.className = 'status-label'; clbl.textContent = 'Samples';
    const cval = document.createElement('span'); cval.id = 'samples-count'; cval.textContent = 'Samples: 0 / 100';
    countRow.appendChild(clbl); countRow.appendChild(cval);
    
    readout.appendChild(countRow);
    container.appendChild(readout);
    
    // Quick Actions Panel (Bottom Center/Left)
    const actions = document.createElement('div');
    actions.className = 'overlay-panel bottom-left';
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    
    const btnPlayPause = document.createElement('button');
    btnPlayPause.textContent = 'Pause';
    btnPlayPause.onclick = () => {
        state.paused = !state.paused;
        btnPlayPause.textContent = state.paused ? 'Resume' : 'Pause';
    };
    
    const btnReset = document.createElement('button');
    btnReset.textContent = 'Reset';
    btnReset.onclick = () => {
        resetSamples(state.pathTracer);
    };

    const btnScreenshot = document.createElement('button');
    btnScreenshot.textContent = 'Screenshot';
    btnScreenshot.onclick = async () => {
        const url = state.renderer.domElement.toDataURL('image/png');
        const link = document.createElement('a');
        link.href = url;
        link.download = 'screenshot.png';
        link.click();
    };

    actions.appendChild(btnPlayPause);
    actions.appendChild(btnReset);
    actions.appendChild(btnScreenshot);
    container.appendChild(actions);

    // Shortcuts helper
    const shortcuts = document.createElement('div');
    shortcuts.id = 'shortcuts';
    shortcuts.innerHTML = `
        <span><span class="key">Space</span> Pause/Resume</span>
        <span><span class="key">S</span> Quick Screenshot</span>
        <span><span class="key">R</span> Reset</span>
    `;
    container.appendChild(shortcuts);
    
    // Custom Upload Overlay (For texture input specifically as GUI file inputs are complex)
    const texInputPanel = document.createElement('div');
    texInputPanel.className = 'overlay-panel bottom-right';
    const texBtn = document.createElement('button');
    texBtn.textContent = 'Upload Texture/Model';
    texBtn.onclick = () => document.getElementById('file-input').click();
    texInputPanel.appendChild(texBtn);
    container.appendChild(texInputPanel);
    
    state.samplesEl = cval;
    
    // Register global event listener for export callback
    window.addEventListener('doExport', (e) => {
        if(state.guiSettings.AutoExport) {
            exportPNG(state);
        }
    });
}

function setupGUI(state) {
    const gui = new GUI({ title: 'Properties' });
    state.gui = gui;

    // Helper to extract opacity text display
    const updateOpacityDisplays = () => {}; // we handle it in onChange 
    
    // --- Glass Material Folder ---
    const fMat = gui.addFolder('Glass Material');
    
    fMat.add(state.guiSettings, 'overrideMaterial').name('Override Material').onChange(() => updateMaterials(state));
    fMat.add(state.guiSettings, 'transmission', 0.0, 1.0, 0.01).name('Transmission').onChange(() => updateMaterials(state));
    
    // We bind a custom 0-255 controller and log its variants
    const ctrlOp = fMat.add(state.guiSettings, 'opacity', 0, 255, 1).name('Opacity (0-255)');
    ctrlOp.onChange(() => {
        const val = state.guiSettings.opacity;
        ctrlOp.name(`Opacity: ${val} | ${((val/255)*100).toFixed(0)}% | ${(val/255).toFixed(2)}`);
        updateMaterials(state);
    });
    // Trigger initial label update
    ctrlOp.onChange();

    fMat.add(state.guiSettings, 'ior', 1.0, 2.5, 0.01).name('Index of Refraction').onChange(() => updateMaterials(state));
    fMat.add(state.guiSettings, 'roughness', 0.0, 1.0, 0.01).name('Surface Roughness').onChange(() => updateMaterials(state));
    fMat.add(state.guiSettings, 'thickness', 0.0, 1.0, 0.01).name('Thickness / Absorption').onChange(() => updateMaterials(state));
    fMat.addColor(state.guiSettings, 'tintColor').name('Tint Color').onChange(() => updateMaterials(state));
    
    // --- Texture Folder ---
    const fTex = gui.addFolder('Texture Overlay');
    
    const ctrlAlpha = fTex.add(state.guiSettings, 'textureAlpha', 0, 255, 1).name('Texture Alpha (0-255)');
    ctrlAlpha.onChange(() => {
        const val = state.guiSettings.textureAlpha;
        ctrlAlpha.name(`Tex Alpha: ${val} | ${((val/255)*100).toFixed(0)}% | ${(val/255).toFixed(2)}`);
        updateMaterials(state);
    });
    ctrlAlpha.onChange();

    fTex.add(state.guiSettings, 'texScale', 0.1, 10.0, 0.1).name('Scale').onChange(() => updateMaterials(state));
    fTex.add(state.guiSettings, 'texOffsetX', -1.0, 1.0, 0.01).name('Offset X').onChange(() => updateMaterials(state));
    fTex.add(state.guiSettings, 'texOffsetY', -1.0, 1.0, 0.01).name('Offset Y').onChange(() => updateMaterials(state));
    fTex.add(state.guiSettings, 'texRot', 0.0, Math.PI * 2, 0.01).name('Rotation').onChange(() => updateMaterials(state));

    // --- Render Folder ---
    const fRend = gui.addFolder('Path Tracing');
    
    // --- Lights Folder ---
    const fLight = gui.addFolder('Lighting');
    
    // Add default light to state and scene if none exists
    if (state.lights.length === 0) {
        const defaultLight = new THREE.DirectionalLight(0xffffff, 2.0);
        defaultLight.position.set(5, 5, 5);
        state.scene.add(defaultLight);
        state.lights.push(defaultLight);
    }
    
    const lSet = {
        intensity: state.lights[0].intensity,
        color: '#' + state.lights[0].color.getHexString(),
        posX: state.lights[0].position.x,
        posY: state.lights[0].position.y,
        posZ: state.lights[0].position.z
    };
    
    const updateLight = () => {
        state.lights[0].intensity = lSet.intensity;
        state.lights[0].color.set(lSet.color);
        state.lights[0].position.set(lSet.posX, lSet.posY, lSet.posZ);
        state.pathTracer.updateEnvironment();
        resetSamples(state.pathTracer);
    };

    fLight.add(lSet, 'intensity', 0, 10, 0.1).name('Intensity').onChange(updateLight);
    fLight.addColor(lSet, 'color').name('Color').onChange(updateLight);
    fLight.add(lSet, 'posX', -20, 20, 0.5).name('Position X').onChange(updateLight);
    fLight.add(lSet, 'posY', -20, 20, 0.5).name('Position Y').onChange(updateLight);
    fLight.add(lSet, 'posZ', -20, 20, 0.5).name('Position Z').onChange(updateLight);
    fRend.add(state.guiSettings, 'MaxSamples', 1, 10000, 1).name('Max Samples').onChange(v => state.maxSamples = v);
    fRend.add(state.guiSettings, 'AutoExport').name('Auto Export @ Max').onChange(v => state.autoExport = v);
    
    // Background color control
    fRend.addColor(state, 'bgColor').name('Background Color').onChange(hex => {
        const c = new THREE.Color(hex);
        state.scene.background = c;
        
        // Dispose old environment texture and create a new one
        if (state.scene.environment && state.scene.environment.dispose) {
            state.scene.environment.dispose();
        }
        state.scene.environment = createSolidEnvTexture(c);
        
        state.pathTracer.updateEnvironment();
        state.pathTracer.updateMaterials();
        resetSamples(state.pathTracer);
    });
    
    const resOpts = { "512x512": 512, "1024x1024": 1024, "2048x2048": 2048, "4096x4096": 4096 };
    fRend.add(state.guiSettings, 'ExportRes', resOpts).name('Export Resolution');
    fRend.add({ x: () => exportPNG(state) }, 'x').name('Export Now');
}

function setupKeyboard(state) {
    window.addEventListener('keydown', (e) => {
        if(e.target.tagName === 'INPUT') return; // ignore typing in fields
        
        switch(e.code) {
            case 'Space':
                state.paused = !state.paused;
                e.preventDefault();
                break;
            case 'KeyS':
                // Quick screenshot
                const url = state.renderer.domElement.toDataURL('image/png');
                const link = document.createElement('a');
                link.href = url;
                link.download = `render-${Date.now()}.png`;
                link.click();
                break;
            case 'KeyR':
                resetSamples(state.pathTracer);
                break;
        }
    });
}
