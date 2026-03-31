import { ThreeDEngine } from './engine.js';

function formatNumber(value, digits = 3) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0';
    return numeric.toFixed(digits).replace(/\.?0+$/, '');
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getSelectedItem(state) {
    const itemId = state?.threeDDocument?.selection?.itemId;
    return state?.threeDDocument?.scene?.items?.find((item) => item.id === itemId) || null;
}

function getSelectedMaterial(state) {
    return getSelectedItem(state)?.material || null;
}

function isMaterialItem(item) {
    return item?.kind === 'model' || item?.kind === 'primitive';
}

function formatRenderSize(job) {
    if (!job?.outputWidth || !job?.outputHeight) return '0 x 0';
    return `${job.outputWidth} x ${job.outputHeight}`;
}

function describeItemKind(item) {
    if (item.kind === 'light') return item.light?.lightType || 'light';
    if (item.kind === 'image-plane') return 'image plane';
    if (item.kind === 'primitive') return item.asset?.primitiveType || 'primitive';
    return item.asset?.format || 'model';
}

function buildEngineSyncKey(documentState) {
    return JSON.stringify({
        scene: documentState?.scene || null,
        selection: documentState?.selection || null,
        view: documentState?.view
            ? {
                cameraMode: documentState.view.cameraMode,
                linkPlaneScale: documentState.view.linkPlaneScale,
                snapTranslationStep: documentState.view.snapTranslationStep,
                snapRotationDegrees: documentState.view.snapRotationDegrees,
                cameraPosition: documentState.view.cameraPosition,
                cameraTarget: documentState.view.cameraTarget,
                fov: documentState.view.fov,
                near: documentState.view.near,
                far: documentState.view.far
            }
            : null,
        render: documentState?.render
            ? {
                mode: documentState.render.mode,
                samplesTarget: documentState.render.samplesTarget,
                exposure: documentState.render.exposure,
                toneMapping: documentState.render.toneMapping
            }
            : null
    });
}

export function createThreeDWorkspace(actions, store) {
    const root = document.createElement('div');
    root.className = 'threed-workspace-root';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.position = 'relative';
    root.style.overflow = 'hidden';
    root.style.background = '#111111';

    root.innerHTML = `
        <div class="threed-canvas-container" style="position:absolute; inset:0;"></div>
        <div class="threed-overlay-shell" style="position:absolute; inset:0; pointer-events:none; color:#f4f4f4; font-size:12px;">
            <aside style="position:absolute; top:16px; left:16px; width:min(360px, calc(100vw - 32px)); display:flex; flex-direction:column; gap:12px; pointer-events:auto;">
                <section class="panel-section" style="background:rgba(15,15,18,0.84); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,0.1); border-radius:14px; overflow:hidden;">
                    <div class="panel-heading" style="padding:14px 16px; margin:0; border-bottom:1px solid rgba(255,255,255,0.08);">3D Scene</div>
                    <div style="padding:16px; display:flex; flex-direction:column; gap:10px;">
                        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px;">
                            <button type="button" class="primary-button" data-threed-action="load-models">Load Models</button>
                            <button type="button" class="toolbar-button" data-threed-action="load-images">Add Image Planes</button>
                            <button type="button" class="toolbar-button" data-threed-action="save-library">Save to Library</button>
                        </div>
                        <button type="button" class="toolbar-button" data-threed-action="new-scene">New 3D Scene</button>
                        <div class="info-banner" style="margin:0;">Embedded <code>.glb</code> and embedded images are the most reliable Library formats for both browser and Electron builds.</div>
                        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px;">
                            <button type="button" class="secondary-button" data-threed-action="add-light" data-light-type="directional">+ Dir</button>
                            <button type="button" class="secondary-button" data-threed-action="add-light" data-light-type="point">+ Point</button>
                            <button type="button" class="secondary-button" data-threed-action="add-light" data-light-type="spot">+ Spot</button>
                        </div>
                        <div style="display:flex; flex-direction:column; gap:8px;">
                            <span style="font-size:11px; opacity:0.72;">Primitives</span>
                            <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px;">
                                <button type="button" class="secondary-button" data-threed-action="add-primitive" data-primitive-type="cube">Cube</button>
                                <button type="button" class="secondary-button" data-threed-action="add-primitive" data-primitive-type="sphere">Sphere</button>
                                <button type="button" class="secondary-button" data-threed-action="add-primitive" data-primitive-type="cone">Cone</button>
                                <button type="button" class="secondary-button" data-threed-action="add-primitive" data-primitive-type="cylinder">Cylinder</button>
                            </div>
                        </div>
                        <label style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                            <span>Background</span>
                            <input type="color" data-threed-role="background-color">
                        </label>
                        <label class="check-row">
                            <input type="checkbox" data-threed-role="show-grid">
                            <span>Show Grid</span>
                        </label>
                        <label class="check-row">
                            <input type="checkbox" data-threed-role="show-axes">
                            <span>Show Axes</span>
                        </label>
                    </div>
                </section>

                <section class="panel-section" style="background:rgba(15,15,18,0.84); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,0.1); border-radius:14px; overflow:hidden;">
                    <div class="panel-heading" style="padding:14px 16px; margin:0; border-bottom:1px solid rgba(255,255,255,0.08);">Renderer</div>
                    <div style="padding:16px; display:flex; flex-direction:column; gap:10px;">
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Mode</span>
                            <select class="custom-select" data-threed-role="render-mode">
                                <option value="raster">Raster</option>
                                <option value="pathtrace">Path Trace</option>
                            </select>
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Viewport Target Samples</span>
                            <input type="number" min="1" max="4096" step="1" class="control-number" data-threed-role="samples-target">
                        </label>
                        <div style="display:flex; justify-content:space-between; gap:12px;">
                            <span>Viewport Samples</span>
                            <strong data-threed-role="sample-count">0</strong>
                        </div>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Exposure</span>
                            <input type="range" min="0.05" max="4" step="0.05" data-threed-role="exposure-range">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Tone Mapping</span>
                            <select class="custom-select" data-threed-role="tone-mapping">
                                <option value="aces">ACES</option>
                                <option value="neutral">Neutral</option>
                                <option value="none">None</option>
                            </select>
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Field of View</span>
                            <input type="range" min="15" max="120" step="1" data-threed-role="camera-fov">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Camera Mode</span>
                            <select class="custom-select" data-threed-role="camera-mode">
                                <option value="orbit">Orbit</option>
                                <option value="fly">Fly</option>
                            </select>
                        </label>
                        <label class="check-row">
                            <input type="checkbox" data-threed-role="link-plane-scale">
                            <span>Lock 2-axis plane scaling</span>
                        </label>
                        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Move Snap</span>
                                <input type="number" min="0" max="1000" step="0.01" class="control-number" data-threed-role="snap-translation-step">
                            </label>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Rotate Snap</span>
                                <input type="number" min="0" max="360" step="1" class="control-number" data-threed-role="snap-rotation-degrees">
                            </label>
                        </div>
                        <div style="font-size:11px; line-height:1.45; opacity:0.72;">Fly mode: click the viewport, then use right-drag to look and <code>W A S D Q E</code> to move. Hold <code>Shift</code> to boost speed.</div>
                        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                            <button type="button" class="primary-button" data-threed-action="render-scene">Render PNG</button>
                            <button type="button" class="toolbar-button" data-threed-action="abort-render">Abort</button>
                        </div>
                        <div style="display:flex; justify-content:space-between; gap:12px;">
                            <span>Job State</span>
                            <strong data-threed-role="render-job-status">Idle</strong>
                        </div>
                        <div style="display:flex; justify-content:space-between; gap:12px;">
                            <span>Job Samples</span>
                            <strong data-threed-role="render-job-samples">0 / 0</strong>
                        </div>
                        <div style="display:flex; justify-content:space-between; gap:12px;">
                            <span>Output Size</span>
                            <strong data-threed-role="render-job-size">0 x 0</strong>
                        </div>
                        <div style="display:flex; justify-content:space-between; gap:12px;">
                            <span>Camera</span>
                            <button type="button" class="toolbar-button" data-threed-action="reset-camera">Reset View</button>
                        </div>
                    </div>
                </section>

                <section class="panel-section" style="background:rgba(15,15,18,0.84); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,0.1); border-radius:14px; overflow:hidden;">
                    <div class="panel-heading" style="padding:14px 16px; margin:0; border-bottom:1px solid rgba(255,255,255,0.08);">Camera Presets</div>
                    <div style="padding:16px; display:flex; flex-direction:column; gap:10px;">
                        <button type="button" class="toolbar-button" data-threed-action="save-camera-preset">Save Current View</button>
                        <div data-threed-role="camera-presets" style="display:flex; flex-direction:column; gap:6px;"></div>
                    </div>
                </section>
            </aside>

            <aside style="position:absolute; top:16px; right:16px; width:min(380px, calc(100vw - 32px)); display:flex; flex-direction:column; gap:12px; pointer-events:auto;">
                <section class="panel-section" style="background:rgba(15,15,18,0.84); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,0.1); border-radius:14px; overflow:hidden;">
                    <div class="panel-heading" style="padding:14px 16px; margin:0; border-bottom:1px solid rgba(255,255,255,0.08);">Scene Items</div>
                    <div data-threed-role="hierarchy" style="padding:10px; max-height:260px; overflow:auto; display:flex; flex-direction:column; gap:6px;"></div>
                </section>

                <section class="panel-section" style="background:rgba(15,15,18,0.84); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,0.1); border-radius:14px; overflow:hidden;">
                    <div class="panel-heading" style="padding:14px 16px; margin:0; border-bottom:1px solid rgba(255,255,255,0.08);">Inspector</div>
                    <div style="padding:16px; display:flex; flex-direction:column; gap:10px;">
                        <div data-threed-role="selection-name" style="font-weight:600;">Nothing selected</div>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Name</span>
                            <input type="text" class="control-number" data-threed-role="item-name" placeholder="Select an item to rename it">
                        </label>
                        <div style="display:grid; grid-template-columns:repeat(3, 1fr); gap:8px;">
                            <button type="button" class="secondary-button" data-threed-action="transform-mode" data-transform-mode="translate">Move</button>
                            <button type="button" class="secondary-button" data-threed-action="transform-mode" data-transform-mode="rotate">Rotate</button>
                            <button type="button" class="secondary-button" data-threed-action="transform-mode" data-transform-mode="scale">Scale</button>
                        </div>
                        <div style="display:grid; grid-template-columns:auto 1fr 1fr 1fr; gap:8px; align-items:center;">
                            <span style="color:#ff8a80;">Pos</span>
                            <input type="number" class="control-number" step="0.01" data-threed-role="position-0">
                            <input type="number" class="control-number" step="0.01" data-threed-role="position-1">
                            <input type="number" class="control-number" step="0.01" data-threed-role="position-2">
                            <span style="color:#ffd180;">Rot</span>
                            <input type="number" class="control-number" step="0.01" data-threed-role="rotation-0">
                            <input type="number" class="control-number" step="0.01" data-threed-role="rotation-1">
                            <input type="number" class="control-number" step="0.01" data-threed-role="rotation-2">
                            <span style="color:#80d8ff;">Scale</span>
                            <input type="number" class="control-number" step="0.01" min="0.01" data-threed-role="scale-0">
                            <input type="number" class="control-number" step="0.01" min="0.01" data-threed-role="scale-1">
                            <input type="number" class="control-number" step="0.01" min="0.01" data-threed-role="scale-2">
                        </div>
                        <div style="display:grid; grid-template-columns:repeat(4, 1fr); gap:8px;">
                            <button type="button" class="toolbar-button" data-threed-action="frame-item" style="flex:1;">Frame</button>
                            <button type="button" class="toolbar-button" data-threed-action="duplicate-item" style="flex:1;">Duplicate</button>
                            <button type="button" class="toolbar-button" data-threed-action="reset-transform" style="flex:1;">Reset</button>
                            <button type="button" class="toolbar-button" data-threed-action="delete-item" style="flex:1;">Delete</button>
                        </div>
                        <div data-threed-role="light-fields" style="display:none; flex-direction:column; gap:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:10px;">
                            <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                                <span>Light Color</span>
                                <input type="color" data-threed-role="light-color">
                            </label>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Intensity</span>
                                <input type="range" min="0" max="10" step="0.05" data-threed-role="light-intensity">
                            </label>
                            <label data-threed-role="light-target-fields" style="display:none; flex-direction:column; gap:6px;">
                                <span>Target Item</span>
                                <select class="custom-select" data-threed-role="light-target"></select>
                            </label>
                        </div>
                        <div data-threed-role="material-fields" style="display:none; flex-direction:column; gap:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:10px;">
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Material</span>
                                <select class="custom-select" data-threed-role="material-preset">
                                    <option value="original">Original</option>
                                    <option value="matte">Matte</option>
                                    <option value="metal">Metal</option>
                                    <option value="glass">Glass</option>
                                    <option value="emissive">Emissive</option>
                                </select>
                            </label>
                            <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                                <span>Base Color</span>
                                <input type="color" data-threed-role="material-color">
                            </label>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Roughness</span>
                                <input type="range" min="0" max="1" step="0.01" data-threed-role="material-roughness">
                            </label>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Metalness</span>
                                <input type="range" min="0" max="1" step="0.01" data-threed-role="material-metalness">
                            </label>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Opacity</span>
                                <input type="range" min="0.05" max="1" step="0.01" data-threed-role="material-opacity">
                            </label>
                            <div data-threed-role="emissive-fields" style="display:none; flex-direction:column; gap:10px;">
                                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                                    <span>Emission Color</span>
                                    <input type="color" data-threed-role="material-emissive-color">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Emission Intensity</span>
                                    <input type="range" min="0" max="50" step="0.1" data-threed-role="material-emissive-intensity">
                                </label>
                            </div>
                            <div data-threed-role="glass-fields" style="display:none; flex-direction:column; gap:10px;">
                                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                                    <span>Glass Tint</span>
                                    <input type="color" data-threed-role="material-attenuation-color">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>IOR</span>
                                    <input type="range" min="1" max="3" step="0.01" data-threed-role="material-ior">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Transmission</span>
                                    <input type="range" min="0" max="1" step="0.01" data-threed-role="material-transmission">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Thickness</span>
                                    <input type="range" min="0" max="10" step="0.01" data-threed-role="material-thickness">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Attenuation Distance</span>
                                    <input type="number" min="0.001" step="0.01" class="control-number" data-threed-role="material-attenuation-distance">
                                </label>
                            </div>
                            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                                <button type="button" class="toolbar-button" data-threed-action="upload-texture">Upload Texture</button>
                                <button type="button" class="toolbar-button" data-threed-action="clear-texture">Clear Texture</button>
                            </div>
                            <div data-threed-role="texture-fields" style="display:flex; flex-direction:column; gap:10px;">
                                <div style="display:flex; justify-content:space-between; gap:12px;">
                                    <span>Texture</span>
                                    <strong data-threed-role="texture-name">None</strong>
                                </div>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Tile X</span>
                                    <input type="number" min="0.0001" step="0.01" class="control-number" data-threed-role="texture-repeat-x">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Tile Y</span>
                                    <input type="number" min="0.0001" step="0.01" class="control-number" data-threed-role="texture-repeat-y">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Rotation (Radians)</span>
                                    <input type="number" step="0.01" class="control-number" data-threed-role="texture-rotation">
                                </label>
                            </div>
                        </div>
                    </div>
                </section>
            </aside>

            <div data-threed-role="status" style="position:absolute; left:16px; bottom:16px; max-width:min(560px, calc(100vw - 32px)); padding:10px 14px; border-radius:999px; background:rgba(15,15,18,0.88); border:1px solid rgba(255,255,255,0.08); pointer-events:auto;">3D workspace ready.</div>
        </div>
        <div class="threed-render-dialog" data-threed-role="render-dialog" aria-hidden="true">
            <div class="threed-render-dialog-card" role="dialog" aria-modal="true" aria-label="Render PNG settings">
                <div class="threed-render-dialog-header">
                    <strong>Render PNG</strong>
                    <button type="button" class="toolbar-button" data-threed-action="render-dialog-cancel">Close</button>
                </div>
                <div class="threed-render-dialog-body">
                    <div class="info-banner" data-threed-role="render-dialog-note">Choose the final sample count and export resolution for this background render.</div>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Samples</span>
                        <input type="number" min="1" max="1000000" step="1" class="control-number" data-threed-role="render-dialog-samples">
                    </label>
                    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Width</span>
                            <input type="number" min="16" max="32768" step="1" class="control-number" data-threed-role="render-dialog-width">
                        </label>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Height</span>
                            <input type="number" min="16" max="32768" step="1" class="control-number" data-threed-role="render-dialog-height">
                        </label>
                    </div>
                </div>
                <div class="threed-render-dialog-footer">
                    <button type="button" class="toolbar-button" data-threed-action="render-dialog-cancel">Cancel</button>
                    <button type="button" class="primary-button" data-threed-action="render-dialog-confirm">Start Render</button>
                </div>
            </div>
        </div>
        <input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" data-threed-role="model-input" multiple hidden>
        <input type="file" accept="image/*" data-threed-role="image-input" multiple hidden>
        <input type="file" accept="image/*" data-threed-role="texture-input" hidden>
    `;

    const refs = {
        canvasContainer: root.querySelector('.threed-canvas-container'),
        modelInput: root.querySelector('[data-threed-role="model-input"]'),
        imageInput: root.querySelector('[data-threed-role="image-input"]'),
        textureInput: root.querySelector('[data-threed-role="texture-input"]'),
        hierarchy: root.querySelector('[data-threed-role="hierarchy"]'),
        cameraPresets: root.querySelector('[data-threed-role="camera-presets"]'),
        status: root.querySelector('[data-threed-role="status"]'),
        selectionName: root.querySelector('[data-threed-role="selection-name"]'),
        sampleCount: root.querySelector('[data-threed-role="sample-count"]'),
        backgroundColor: root.querySelector('[data-threed-role="background-color"]'),
        showGrid: root.querySelector('[data-threed-role="show-grid"]'),
        showAxes: root.querySelector('[data-threed-role="show-axes"]'),
        renderMode: root.querySelector('[data-threed-role="render-mode"]'),
        samplesTarget: root.querySelector('[data-threed-role="samples-target"]'),
        exposureRange: root.querySelector('[data-threed-role="exposure-range"]'),
        toneMapping: root.querySelector('[data-threed-role="tone-mapping"]'),
        cameraFov: root.querySelector('[data-threed-role="camera-fov"]'),
        cameraMode: root.querySelector('[data-threed-role="camera-mode"]'),
        linkPlaneScale: root.querySelector('[data-threed-role="link-plane-scale"]'),
        snapTranslationStep: root.querySelector('[data-threed-role="snap-translation-step"]'),
        snapRotationDegrees: root.querySelector('[data-threed-role="snap-rotation-degrees"]'),
        renderJobStatus: root.querySelector('[data-threed-role="render-job-status"]'),
        renderJobSamples: root.querySelector('[data-threed-role="render-job-samples"]'),
        renderJobSize: root.querySelector('[data-threed-role="render-job-size"]'),
        itemName: root.querySelector('[data-threed-role="item-name"]'),
        lightFields: root.querySelector('[data-threed-role="light-fields"]'),
        lightColor: root.querySelector('[data-threed-role="light-color"]'),
        lightIntensity: root.querySelector('[data-threed-role="light-intensity"]'),
        lightTargetFields: root.querySelector('[data-threed-role="light-target-fields"]'),
        lightTarget: root.querySelector('[data-threed-role="light-target"]'),
        materialFields: root.querySelector('[data-threed-role="material-fields"]'),
        materialPreset: root.querySelector('[data-threed-role="material-preset"]'),
        materialColor: root.querySelector('[data-threed-role="material-color"]'),
        materialRoughness: root.querySelector('[data-threed-role="material-roughness"]'),
        materialMetalness: root.querySelector('[data-threed-role="material-metalness"]'),
        materialOpacity: root.querySelector('[data-threed-role="material-opacity"]'),
        emissiveFields: root.querySelector('[data-threed-role="emissive-fields"]'),
        materialEmissiveColor: root.querySelector('[data-threed-role="material-emissive-color"]'),
        materialEmissiveIntensity: root.querySelector('[data-threed-role="material-emissive-intensity"]'),
        glassFields: root.querySelector('[data-threed-role="glass-fields"]'),
        materialAttenuationColor: root.querySelector('[data-threed-role="material-attenuation-color"]'),
        materialIor: root.querySelector('[data-threed-role="material-ior"]'),
        materialTransmission: root.querySelector('[data-threed-role="material-transmission"]'),
        materialThickness: root.querySelector('[data-threed-role="material-thickness"]'),
        materialAttenuationDistance: root.querySelector('[data-threed-role="material-attenuation-distance"]'),
        textureFields: root.querySelector('[data-threed-role="texture-fields"]'),
        textureName: root.querySelector('[data-threed-role="texture-name"]'),
        textureRepeatX: root.querySelector('[data-threed-role="texture-repeat-x"]'),
        textureRepeatY: root.querySelector('[data-threed-role="texture-repeat-y"]'),
        textureRotation: root.querySelector('[data-threed-role="texture-rotation"]'),
        renderDialog: root.querySelector('[data-threed-role="render-dialog"]'),
        renderDialogNote: root.querySelector('[data-threed-role="render-dialog-note"]'),
        renderDialogSamples: root.querySelector('[data-threed-role="render-dialog-samples"]'),
        renderDialogWidth: root.querySelector('[data-threed-role="render-dialog-width"]'),
        renderDialogHeight: root.querySelector('[data-threed-role="render-dialog-height"]')
    };

    function buildLayoutChrome() {
        const overlayShell = root.querySelector('.threed-overlay-shell');
        const sidebars = overlayShell ? Array.from(overlayShell.querySelectorAll('aside')) : [];
        const leftSidebar = sidebars[0] || null;
        const rightSidebar = sidebars[1] || null;
        if (!overlayShell || !leftSidebar || !rightSidebar) return;

        const style = document.createElement('style');
        style.textContent = `
            .threed-shell { width:100%; height:100%; display:flex; color:#f4f4f4; font-size:11px; line-height:1.35; }
            .threed-shell button, .threed-shell input, .threed-shell select { font-size:11px !important; }
            .threed-shell .panel-section { border-radius:12px !important; }
            .threed-shell .panel-heading { padding:10px 12px !important; font-size:11px; }
            .threed-shell .panel-section > div:not(.panel-heading) { padding:12px !important; gap:8px !important; }
            .threed-shell .control-number, .threed-shell .custom-select, .threed-shell input[type="text"], .threed-shell input[type="number"] { min-height:28px; padding:4px 8px !important; }
            .threed-shell .primary-button, .threed-shell .secondary-button, .threed-shell .toolbar-button { min-height:28px; padding:5px 8px !important; }
            .threed-stage { flex:1; min-width:0; min-height:0; display:grid; grid-template-columns:minmax(240px,280px) minmax(0,1fr) minmax(260px,320px); gap:12px; padding:12px; }
            .threed-sidebar { min-height:0; overflow:auto; display:flex; flex-direction:column; gap:10px; padding-right:2px; pointer-events:auto; }
            .threed-viewport-panel { min-width:0; min-height:0; display:flex; }
            .threed-viewport-card { position:relative; flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; background:linear-gradient(180deg, rgba(21,24,31,0.96), rgba(10,11,15,0.98)); border:1px solid rgba(255,255,255,0.08); border-radius:14px; overflow:hidden; box-shadow:0 18px 60px rgba(0,0,0,0.32); }
            .threed-viewport-toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 11px; background:rgba(12,14,20,0.88); border-bottom:1px solid rgba(255,255,255,0.08); }
            .threed-toolbar-cluster { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
            .threed-chip { display:inline-flex; align-items:center; gap:5px; padding:4px 8px; border-radius:999px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.05); }
            .threed-viewport-stage { position:relative; flex:1; min-height:0; background:#111111; }
            .threed-compact-hud { position:absolute; top:12px; left:12px; z-index:7; display:none; flex-wrap:wrap; gap:6px; pointer-events:auto; }
            .threed-pathtrace-loading { position:absolute; inset:0; z-index:6; display:none; align-items:center; justify-content:center; padding:24px; background:rgba(8,10,14,0.62); pointer-events:none; }
            .threed-pathtrace-loading.is-active { display:flex; }
            .threed-loading-card { min-width:min(320px,100%); display:flex; align-items:center; gap:12px; padding:14px 16px; border-radius:14px; border:1px solid rgba(255,255,255,0.12); background:rgba(12,14,20,0.92); box-shadow:0 18px 50px rgba(0,0,0,0.35); }
            .threed-spinner { width:16px; height:16px; flex:0 0 auto; border-radius:50%; border:2px solid rgba(255,255,255,0.22); border-top-color:#f4f4f4; animation:threed-spin 0.8s linear infinite; }
            .threed-status-pill { position:absolute; left:12px; bottom:12px; z-index:7; max-width:min(560px, calc(100% - 24px)); padding:8px 12px; border-radius:999px; border:1px solid rgba(255,255,255,0.08); background:rgba(15,15,18,0.88); pointer-events:auto; }
            .threed-render-dialog { position:absolute; inset:0; z-index:12; display:none; align-items:center; justify-content:center; padding:24px; background:rgba(5,7,10,0.62); }
            .threed-render-dialog.is-open { display:flex; }
            .threed-render-dialog-card { width:min(440px, calc(100vw - 40px)); display:flex; flex-direction:column; gap:0; border-radius:16px; border:1px solid rgba(255,255,255,0.1); background:rgba(12,14,20,0.98); box-shadow:0 24px 70px rgba(0,0,0,0.42); overflow:hidden; pointer-events:auto; }
            .threed-render-dialog-header, .threed-render-dialog-footer { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px 14px; background:rgba(255,255,255,0.03); }
            .threed-render-dialog-body { display:flex; flex-direction:column; gap:10px; padding:14px; }
            .threed-render-dialog-footer { justify-content:flex-end; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-stage { grid-template-columns:minmax(0,1fr); padding:0; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-sidebar, .threed-shell[data-ui-mode="fullscreen"] .threed-viewport-toolbar { display:none; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-compact-hud { display:flex; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-viewport-card { border:none; border-radius:0; box-shadow:none; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-status-pill { left:20px; bottom:20px; }
            @keyframes threed-spin { to { transform: rotate(360deg); } }
            @media (max-width: 1320px) {
                .threed-stage { grid-template-columns:minmax(220px,260px) minmax(0,1fr); grid-template-rows:minmax(0,1fr) auto; }
                .threed-sidebar.threed-right { grid-column:1 / span 2; max-height:300px; }
            }
            @media (max-width: 1040px) {
                .threed-stage { grid-template-columns:minmax(0,1fr); grid-template-rows:minmax(0,48vh) auto auto; }
                .threed-sidebar { max-height:none; }
                .threed-viewport-panel { min-height:320px; }
            }
        `;
        root.prepend(style);

        leftSidebar.removeAttribute('style');
        rightSidebar.removeAttribute('style');
        leftSidebar.className = 'threed-sidebar threed-left';
        rightSidebar.className = 'threed-sidebar threed-right';
        refs.status.removeAttribute('style');
        refs.status.className = 'threed-status-pill';

        leftSidebar.insertAdjacentHTML('afterbegin', `
            <section class="panel-section" style="background:rgba(15,15,18,0.84); backdrop-filter:blur(14px); border:1px solid rgba(255,255,255,0.1); border-radius:14px; overflow:hidden;">
                <div class="panel-heading" style="padding:14px 16px; margin:0; border-bottom:1px solid rgba(255,255,255,0.08);">Workspace</div>
                <div style="padding:16px; display:flex; flex-direction:column; gap:10px;">
                    <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                        <button type="button" class="primary-button" data-threed-action="ui-mode" data-ui-mode="edit">Editing Mode</button>
                        <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="fullscreen">Fullscreen</button>
                    </div>
                    <div class="info-banner" style="margin:0;">Editing mode keeps controls in scrollable side panels. Fullscreen hides most UI so the viewport can take over.</div>
                </div>
            </section>
        `);

        const shell = document.createElement('div');
        shell.className = 'threed-shell';
        shell.dataset.threedRole = 'shell';
        shell.dataset.uiMode = 'edit';

        const stage = document.createElement('div');
        stage.className = 'threed-stage';

        const viewportPanel = document.createElement('section');
        viewportPanel.className = 'threed-viewport-panel';

        const viewportCard = document.createElement('div');
        viewportCard.className = 'threed-viewport-card';

        const viewportToolbar = document.createElement('div');
        viewportToolbar.className = 'threed-viewport-toolbar';
        viewportToolbar.innerHTML = `
            <div class="threed-toolbar-cluster">
                <strong>3D Viewport</strong>
                <span class="threed-chip">Press <code>F</code> to frame the selected object in orbit mode.</span>
            </div>
            <div class="threed-toolbar-cluster">
                <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="fullscreen">Fullscreen</button>
                <button type="button" class="toolbar-button" data-threed-action="frame-item">Frame</button>
                <button type="button" class="toolbar-button" data-threed-action="reset-camera">Reset View</button>
            </div>
        `;

        const viewportStage = document.createElement('div');
        viewportStage.className = 'threed-viewport-stage';

        const compactHud = document.createElement('div');
        compactHud.className = 'threed-compact-hud';
        compactHud.innerHTML = `
            <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="edit">Editing UI</button>
            <button type="button" class="toolbar-button" data-threed-action="render-scene">Render PNG</button>
            <button type="button" class="toolbar-button" data-threed-action="abort-render">Abort</button>
            <span class="threed-chip"><span data-threed-role="compact-render-mode-label">Raster</span></span>
            <span class="threed-chip">Samples <strong data-threed-role="compact-sample-count">0</strong></span>
        `;

        const pathTraceLoading = document.createElement('div');
        pathTraceLoading.className = 'threed-pathtrace-loading';
        pathTraceLoading.dataset.threedRole = 'pathtrace-loading';
        pathTraceLoading.innerHTML = `
            <div class="threed-loading-card">
                <div class="threed-spinner" aria-hidden="true"></div>
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <strong>Preparing Path Tracer</strong>
                    <span data-threed-role="pathtrace-loading-text">Preparing path tracer...</span>
                </div>
            </div>
        `;

        refs.canvasContainer.style.position = 'absolute';
        refs.canvasContainer.style.inset = '0';

        viewportStage.appendChild(refs.canvasContainer);
        viewportStage.appendChild(compactHud);
        viewportStage.appendChild(pathTraceLoading);
        viewportStage.appendChild(refs.status);
        viewportCard.appendChild(viewportToolbar);
        viewportCard.appendChild(viewportStage);
        viewportPanel.appendChild(viewportCard);

        stage.appendChild(leftSidebar);
        stage.appendChild(viewportPanel);
        stage.appendChild(rightSidebar);
        shell.appendChild(stage);
        root.appendChild(shell);
        overlayShell.remove();
    }

    buildLayoutChrome();
    refs.shell = root.querySelector('[data-threed-role="shell"]');
    refs.compactSampleCount = root.querySelector('[data-threed-role="compact-sample-count"]');
    refs.compactRenderModeLabel = root.querySelector('[data-threed-role="compact-render-mode-label"]');
    refs.pathTraceLoading = root.querySelector('[data-threed-role="pathtrace-loading"]');
    refs.pathTraceLoadingText = root.querySelector('[data-threed-role="pathtrace-loading-text"]');

    let engine = null;
    let active = false;
    let sampleCount = 0;
    let previewTransform = null;
    let statusTone = 'info';
    let renderSyncToken = 0;
    let lastEngineSyncKey = '';
    let uiMode = 'edit';
    let renderDialogOpen = false;

    const transformInputs = {
        position: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="position-${index}"]`)),
        rotation: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="rotation-${index}"]`)),
        scale: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="scale-${index}"]`))
    };

    function setStatus(text, tone = 'info') {
        statusTone = tone;
        refs.status.textContent = text || '';
        refs.status.style.background = tone === 'error'
            ? 'rgba(110, 27, 27, 0.92)'
            : tone === 'success'
                ? 'rgba(22, 77, 47, 0.92)'
                : tone === 'warning'
                    ? 'rgba(102, 77, 20, 0.92)'
                    : 'rgba(15,15,18,0.88)';
    }

    function setInputValue(input, value) {
        if (!input || document.activeElement === input) return;
        input.value = String(value);
    }

    function waitForUiPaint() {
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    function renderRenderJobUi(job = {}) {
        refs.renderJobStatus.textContent = job?.status ? String(job.status).toUpperCase() : 'IDLE';
        refs.renderJobSamples.textContent = `${job?.currentSamples || 0} / ${job?.requestedSamples || 0}`;
        refs.renderJobSize.textContent = formatRenderSize(job);
        root.querySelectorAll('[data-threed-action="abort-render"]').forEach((node) => {
            node.disabled = !job?.active;
        });
    }

    function setPathTraceLoading(active, message = 'Preparing path tracer...') {
        refs.pathTraceLoading?.classList.toggle('is-active', !!active);
        if (refs.pathTraceLoadingText) {
            refs.pathTraceLoadingText.textContent = message || 'Preparing path tracer...';
        }
    }

    function setRenderDialogNote(text, tone = 'info') {
        if (!refs.renderDialogNote) return;
        refs.renderDialogNote.textContent = text || '';
        refs.renderDialogNote.style.background = tone === 'error'
            ? 'rgba(110, 27, 27, 0.28)'
            : tone === 'warning'
                ? 'rgba(102, 77, 20, 0.28)'
                : 'rgba(255,255,255,0.06)';
    }

    function openRenderDialog() {
        const state = store.getState();
        if (state.threeDDocument?.renderJob?.active) {
            setStatus('A background render is already running.', 'warning');
            return;
        }
        const defaultSamples = state.threeDDocument?.render?.lastJobSamples || state.threeDDocument?.render?.samplesTarget || 256;
        const defaultWidth = state.threeDDocument?.render?.outputWidth || 1920;
        const defaultHeight = state.threeDDocument?.render?.outputHeight || 1080;
        setInputValue(refs.renderDialogSamples, defaultSamples);
        setInputValue(refs.renderDialogWidth, defaultWidth);
        setInputValue(refs.renderDialogHeight, defaultHeight);
        setRenderDialogNote('Choose the final sample count and export resolution for this background render.', 'info');
        renderDialogOpen = true;
        refs.renderDialog?.classList.add('is-open');
        refs.renderDialog?.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => refs.renderDialogSamples?.focus());
    }

    function closeRenderDialog() {
        renderDialogOpen = false;
        refs.renderDialog?.classList.remove('is-open');
        refs.renderDialog?.setAttribute('aria-hidden', 'true');
    }

    function applyUiMode() {
        if (refs.shell) {
            refs.shell.dataset.uiMode = uiMode;
        }
        root.querySelectorAll('[data-threed-action="ui-mode"]').forEach((node) => {
            const isActive = node.dataset.uiMode === uiMode;
            node.disabled = isActive;
            if (isActive) {
                node.classList.add('is-active');
            } else {
                node.classList.remove('is-active');
            }
        });
    }

    function syncTransformFields(state) {
        const selected = getSelectedItem(state);
        const live = previewTransform && previewTransform.itemId === selected?.id ? previewTransform : selected;
        const position = live?.position || [0, 0, 0];
        const rotation = live?.rotation || [0, 0, 0];
        const scale = live?.scale || [1, 1, 1];
        transformInputs.position.forEach((input, index) => setInputValue(input, formatNumber(position[index])));
        transformInputs.rotation.forEach((input, index) => setInputValue(input, formatNumber(rotation[index])));
        transformInputs.scale.forEach((input, index) => setInputValue(input, formatNumber(scale[index])));
        const disabled = !selected;
        [...transformInputs.position, ...transformInputs.rotation, ...transformInputs.scale].forEach((input) => {
            input.disabled = disabled;
        });
    }

    function renderHierarchy(state) {
        const items = state.threeDDocument?.scene?.items || [];
        if (!items.length) {
            refs.hierarchy.innerHTML = '<div class="empty-inline" style="padding:8px;">No 3D assets or lights in this scene yet.</div>';
            return;
        }
        refs.hierarchy.innerHTML = items.map((item) => `
            <button
                type="button"
                data-threed-action="select-item"
                data-item-id="${item.id}"
                style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border-radius:10px; border:1px solid ${state.threeDDocument.selection.itemId === item.id ? 'rgba(255,255,255,0.24)' : 'rgba(255,255,255,0.08)'}; background:${state.threeDDocument.selection.itemId === item.id ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.04)'}; color:inherit; cursor:pointer; text-align:left;"
            >
                <span style="display:flex; flex-direction:column; gap:2px;">
                    <strong style="font-size:11px;">${escapeHtml(item.name)}</strong>
                    <span style="font-size:9px; opacity:0.72;">${escapeHtml(describeItemKind(item))}</span>
                </span>
                <span style="font-size:9px; opacity:0.72;">${item.visible === false ? 'Hidden' : 'Visible'}</span>
            </button>
        `).join('');
    }

    function renderCameraPresets(state) {
        const presets = state.threeDDocument?.view?.presets || [];
        if (!presets.length) {
            refs.cameraPresets.innerHTML = '<div class="empty-inline" style="padding:8px;">Save a camera pose to teleport back to it later.</div>';
            return;
        }
        refs.cameraPresets.innerHTML = presets.map((preset) => `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; border-radius:10px; background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);">
                <span style="display:flex; flex-direction:column; gap:2px;">
                    <strong style="font-size:11px;">${escapeHtml(preset.name)}</strong>
                    <span style="font-size:9px; opacity:0.72;">FOV ${formatNumber(preset.fov, 1)}</span>
                </span>
                <span style="display:flex; gap:6px;">
                    <button type="button" class="secondary-button" data-threed-action="apply-camera-preset" data-preset-id="${preset.id}">Jump</button>
                    <button type="button" class="toolbar-button" data-threed-action="delete-camera-preset" data-preset-id="${preset.id}">Delete</button>
                </span>
            </div>
        `).join('');
    }

    function renderLightTargetOptions(state, selected) {
        if (selected?.kind !== 'light') {
            refs.lightTarget.innerHTML = '<option value="">Free aim</option>';
            return;
        }
        const options = [
            '<option value="">Free aim (use light rotation)</option>',
            ...((state.threeDDocument?.scene?.items || [])
                .filter((item) => item.kind !== 'light' && item.id !== selected.id)
                .map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`))
        ];
        refs.lightTarget.innerHTML = options.join('');
        refs.lightTarget.value = selected.light?.targetItemId || '';
    }

    function applyTransformInput(group, axisIndex, rawValue) {
        const state = store.getState();
        const selected = getSelectedItem(state);
        if (!selected) return;
        const source = Array.isArray(selected[group]) ? [...selected[group]] : group === 'scale' ? [1, 1, 1] : [0, 0, 0];
        const fallback = group === 'scale' ? 1 : 0;
        const nextValue = Number.isFinite(Number(rawValue)) ? Number(rawValue) : fallback;
        source[axisIndex] = group === 'scale' ? Math.max(0.01, nextValue) : nextValue;
        actions.updateThreeDItemTransform(selected.id, { [group]: source });
    }

    async function beginBackgroundRender() {
        const state = store.getState();
        if (state.threeDDocument?.renderJob?.active) {
            setStatus('A background render is already running.', 'warning');
            return;
        }

        const requestedSamples = Math.round(Number(refs.renderDialogSamples?.value) || 0);
        const outputWidth = Math.round(Number(refs.renderDialogWidth?.value) || 0);
        const outputHeight = Math.round(Number(refs.renderDialogHeight?.value) || 0);

        if (requestedSamples < 1 || requestedSamples > 1000000) {
            setRenderDialogNote('Enter a sample count between 1 and 1,000,000.', 'error');
            refs.renderDialogSamples?.focus();
            return;
        }
        if (outputWidth < 16 || outputWidth > 32768 || outputHeight < 16 || outputHeight > 32768) {
            setRenderDialogNote('Enter a width and height between 16 and 32768 pixels.', 'error');
            (outputWidth < 16 || outputWidth > 32768 ? refs.renderDialogWidth : refs.renderDialogHeight)?.focus();
            return;
        }
        closeRenderDialog();

        const suggestedName = `${(state.threeDDocument?.scene?.items?.find((item) => item.kind !== 'light')?.name || '3d-render')
            .replace(/[<>:"/\\\\|?*]+/g, '-')
            .trim() || '3d-render'}-${outputWidth}x${outputHeight}.png`;

        const liveSnapshot = engine?.getCameraSnapshot?.() || null;
        if (liveSnapshot) {
            actions.updateThreeDView(liveSnapshot);
        }
        const renderDocument = {
            ...store.getState().threeDDocument,
            view: {
                ...store.getState().threeDDocument.view,
                ...(liveSnapshot || {})
            }
        };

        actions.updateThreeDRenderSettings({
            outputWidth,
            outputHeight,
            lastJobSamples: requestedSamples
        });
        actions.resetThreeDRenderJob({
            active: true,
            status: 'running',
            requestedSamples,
            currentSamples: 0,
            outputWidth,
            outputHeight,
            startedAt: Date.now(),
            fileName: suggestedName,
            message: 'Preparing background render...'
        });
        setPathTraceLoading(true, 'Preparing background render...');
        setStatus(`Rendering ${requestedSamples} samples at ${outputWidth} x ${outputHeight}. The render will keep running while you work in other tabs.`, 'info');
        await waitForUiPaint();

        engine.startBackgroundRender({
            documentState: renderDocument,
            samples: requestedSamples,
            width: outputWidth,
            height: outputHeight,
            fileName: suggestedName
        }).catch((error) => {
            console.error(error);
            actions.resetThreeDRenderJob({
                active: false,
                status: 'error',
                requestedSamples,
                currentSamples: 0,
                outputWidth,
                outputHeight,
                finishedAt: Date.now(),
                fileName: suggestedName,
                message: error?.message || 'The render failed.'
            });
            setPathTraceLoading(false);
            setStatus(error?.message || 'The background render failed.', 'error');
        });
    }

    root.addEventListener('click', (event) => {
        const actionNode = event.target.closest('[data-threed-action]');
        if (!actionNode) return;
        const action = actionNode.dataset.threedAction;
        if (action === 'ui-mode') {
            uiMode = actionNode.dataset.uiMode === 'fullscreen' ? 'fullscreen' : 'edit';
            applyUiMode();
        } else if (action === 'load-models') {
            refs.modelInput.click();
        } else if (action === 'load-images') {
            refs.imageInput.click();
        } else if (action === 'save-library') {
            actions.saveProjectToLibrary(null, { projectType: '3d' });
        } else if (action === 'new-scene') {
            actions.newThreeDProject?.();
        } else if (action === 'add-light') {
            actions.addThreeDLight(actionNode.dataset.lightType || 'directional');
        } else if (action === 'add-primitive') {
            actions.addThreeDPrimitive?.(actionNode.dataset.primitiveType || 'cube');
        } else if (action === 'select-item') {
            previewTransform = null;
            actions.setThreeDSelection(actionNode.dataset.itemId || null);
        } else if (action === 'transform-mode') {
            engine?.setTransformMode(actionNode.dataset.transformMode || 'translate');
        } else if (action === 'frame-item') {
            engine?.frameSelectedObject();
        } else if (action === 'duplicate-item') {
            const selected = getSelectedItem(store.getState());
            if (selected) actions.duplicateThreeDItem?.(selected.id);
        } else if (action === 'reset-transform') {
            const selected = getSelectedItem(store.getState());
            if (selected) actions.resetThreeDItemTransform(selected.id);
        } else if (action === 'delete-item') {
            const selected = getSelectedItem(store.getState());
            if (selected) actions.deleteThreeDItem(selected.id);
        } else if (action === 'reset-camera') {
            actions.resetThreeDCamera?.();
        } else if (action === 'save-camera-preset') {
            const snapshot = engine?.getCameraSnapshot?.() || store.getState().threeDDocument?.view;
            const name = window.prompt('Name this camera preset:', `Camera ${(store.getState().threeDDocument?.view?.presets?.length || 0) + 1}`);
            if (name != null) {
                actions.saveThreeDCameraPreset(name, snapshot);
                setStatus(`Saved camera preset "${String(name || '').trim() || 'Camera'}".`, 'success');
            }
        } else if (action === 'apply-camera-preset') {
            actions.applyThreeDCameraPreset(actionNode.dataset.presetId || null);
        } else if (action === 'delete-camera-preset') {
            actions.deleteThreeDCameraPreset(actionNode.dataset.presetId || null);
        } else if (action === 'render-scene') {
            openRenderDialog();
        } else if (action === 'render-dialog-cancel') {
            closeRenderDialog();
        } else if (action === 'render-dialog-confirm') {
            beginBackgroundRender().catch((error) => {
                console.error(error);
                setPathTraceLoading(false);
                setStatus(error?.message || 'Could not start the background render.', 'error');
            });
        } else if (action === 'abort-render') {
            if (engine?.abortBackgroundRender()) {
                setStatus('Abort requested. The background render will stop after the current sample finishes.', 'warning');
            }
        } else if (action === 'upload-texture') {
            const selected = getSelectedItem(store.getState());
            if (isMaterialItem(selected)) {
                refs.textureInput.click();
            }
        } else if (action === 'clear-texture') {
            const selected = getSelectedItem(store.getState());
            if (isMaterialItem(selected)) {
                actions.clearThreeDMaterialTexture(selected.id);
            }
        }
    });

    refs.modelInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        try {
            await actions.importThreeDModelFiles(files);
            setStatus(`Added ${files.length} model file${files.length === 1 ? '' : 's'} to the 3D scene.`, 'success');
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not import those 3D models.', 'error');
        }
    });

    refs.imageInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        try {
            await actions.importThreeDImageFiles(files);
            setStatus(`Added ${files.length} image plane${files.length === 1 ? '' : 's'} to the scene.`, 'success');
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not create those image planes.', 'error');
        }
    });

    refs.textureInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0] || null;
        event.target.value = '';
        if (!file) return;
        const selected = getSelectedItem(store.getState());
        if (!selected?.id || !isMaterialItem(selected)) return;
        try {
            if (selected.material?.preset === 'original') {
                actions.updateThreeDMaterial(selected.id, { preset: 'matte' });
            }
            await actions.setThreeDMaterialTexture(selected.id, file);
            setStatus(`Applied texture "${file.name}" to ${selected.name}.`, 'success');
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not apply that texture.', 'error');
        }
    });

    refs.showGrid.addEventListener('change', (event) => {
        actions.updateThreeDSceneSettings({ showGrid: event.target.checked });
    });
    refs.showAxes.addEventListener('change', (event) => {
        actions.updateThreeDSceneSettings({ showAxes: event.target.checked });
    });
    refs.backgroundColor.addEventListener('input', (event) => {
        actions.updateThreeDSceneSettings({ backgroundColor: event.target.value });
    });
    refs.renderMode.addEventListener('change', (event) => {
        if (event.target.value === 'pathtrace') {
            setPathTraceLoading(true, 'Preparing path tracer...');
        } else {
            setPathTraceLoading(false);
        }
        actions.updateThreeDRenderSettings({ mode: event.target.value });
    });
    refs.samplesTarget.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ samplesTarget: Math.round(clamp(Number(event.target.value) || 256, 1, 4096)) });
    });
    refs.exposureRange.addEventListener('input', (event) => {
        actions.updateThreeDRenderSettings({ exposure: clamp(Number(event.target.value) || 1, 0.05, 10) });
    });
    refs.toneMapping.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ toneMapping: event.target.value });
    });
    refs.cameraFov.addEventListener('input', (event) => {
        actions.updateThreeDView(event.target.value ? { fov: Number(event.target.value) } : {});
    });
    refs.cameraMode.addEventListener('change', (event) => {
        actions.updateThreeDView({ cameraMode: event.target.value === 'fly' ? 'fly' : 'orbit' });
    });
    refs.linkPlaneScale.addEventListener('change', (event) => {
        actions.updateThreeDView({ linkPlaneScale: !!event.target.checked });
    });
    refs.snapTranslationStep.addEventListener('change', (event) => {
        actions.updateThreeDView({ snapTranslationStep: Math.max(0, Number(event.target.value) || 0) });
    });
    refs.snapRotationDegrees.addEventListener('change', (event) => {
        actions.updateThreeDView({ snapRotationDegrees: clamp(Number(event.target.value) || 0, 0, 360) });
    });
    refs.itemName.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (!selected?.id) return;
        const trimmed = String(event.target.value || '').trim();
        if (!trimmed) {
            setInputValue(refs.itemName, selected.name || '');
            return;
        }
        actions.renameThreeDItem?.(selected.id, trimmed);
    });
    refs.lightColor.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (selected?.kind === 'light') {
            actions.updateThreeDLight(selected.id, { color: event.target.value });
        }
    });
    refs.lightIntensity.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (selected?.kind === 'light') {
            actions.updateThreeDLight(selected.id, { intensity: Number(event.target.value) });
        }
    });
    refs.lightTarget.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (selected?.kind === 'light') {
            actions.updateThreeDLight(selected.id, { targetItemId: event.target.value || null });
        }
    });

    refs.materialPreset.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            const nextPreset = event.target.value;
            actions.updateThreeDMaterial(selected.id, {
                preset: nextPreset,
                ...(nextPreset === 'emissive' && !((selected.material?.emissiveIntensity || 0) > 0)
                    ? {
                        emissiveColor: selected.material?.emissiveColor || selected.material?.color || '#ffffff',
                        emissiveIntensity: 4
                    }
                    : {})
            });
        }
    });
    refs.materialColor.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { color: event.target.value });
        }
    });
    refs.materialRoughness.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { roughness: Number(event.target.value) });
        }
    });
    refs.materialMetalness.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { metalness: Number(event.target.value) });
        }
    });
    refs.materialOpacity.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { opacity: Number(event.target.value) });
        }
    });
    refs.materialEmissiveColor.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { emissiveColor: event.target.value });
        }
    });
    refs.materialEmissiveIntensity.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { emissiveIntensity: Number(event.target.value) });
        }
    });
    refs.materialAttenuationColor.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { attenuationColor: event.target.value });
        }
    });
    refs.materialIor.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { ior: Number(event.target.value) });
        }
    });
    refs.materialTransmission.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { transmission: Number(event.target.value) });
        }
    });
    refs.materialThickness.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { thickness: Number(event.target.value) });
        }
    });
    refs.materialAttenuationDistance.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isMaterialItem(selected)) {
            actions.updateThreeDMaterial(selected.id, { attenuationDistance: Number(event.target.value) || 1.5 });
        }
    });
    refs.textureRepeatX.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        const material = getSelectedMaterial(store.getState());
        if (isMaterialItem(selected) && material?.texture) {
            actions.updateThreeDMaterial(selected.id, {
                texture: {
                    repeat: [Math.max(0.0001, Number(event.target.value) || 1), material.texture.repeat?.[1] || 1]
                }
            });
        }
    });
    refs.textureRepeatY.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        const material = getSelectedMaterial(store.getState());
        if (isMaterialItem(selected) && material?.texture) {
            actions.updateThreeDMaterial(selected.id, {
                texture: {
                    repeat: [material.texture.repeat?.[0] || 1, Math.max(0.0001, Number(event.target.value) || 1)]
                }
            });
        }
    });
    refs.textureRotation.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        const material = getSelectedMaterial(store.getState());
        if (isMaterialItem(selected) && material?.texture) {
            actions.updateThreeDMaterial(selected.id, {
                texture: {
                    rotation: Number(event.target.value) || 0
                }
            });
        }
    });

    Object.entries(transformInputs).forEach(([group, inputs]) => {
        inputs.forEach((input, axisIndex) => {
            input.addEventListener('change', (event) => {
                applyTransformInput(group, axisIndex, event.target.value);
            });
        });
    });

    window.addEventListener('keydown', (event) => {
        const key = String(event.key || '').toLowerCase();
        if (renderDialogOpen) {
            if (key === 'escape') {
                event.preventDefault();
                closeRenderDialog();
                return;
            }
            if (key === 'enter') {
                event.preventDefault();
                beginBackgroundRender().catch((error) => {
                    console.error(error);
                    setPathTraceLoading(false);
                    setStatus(error?.message || 'Could not start the background render.', 'error');
                });
            }
            return;
        }
        if (!active) return;
        if (store.getState().threeDDocument?.renderJob?.active) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
        if (event.repeat || event.defaultPrevented || event.isComposing) return;
        const tagName = String(event.target?.tagName || '').toLowerCase();
        if (tagName === 'input' || tagName === 'select' || tagName === 'textarea' || event.target?.isContentEditable) return;
        if (key === '1') {
            event.preventDefault();
            setPathTraceLoading(false);
            actions.updateThreeDRenderSettings({ mode: 'raster' });
        } else if (key === '2') {
            event.preventDefault();
            setPathTraceLoading(true, 'Preparing path tracer...');
            actions.updateThreeDRenderSettings({ mode: 'pathtrace' });
        }
    });

    function hydrateEngine() {
        if (engine) return engine;
        engine = new ThreeDEngine(refs.canvasContainer);
        engine.onSelectionChanged = (itemId) => {
            previewTransform = null;
            actions.setThreeDSelection(itemId);
        };
        engine.onTransformPreview = (payload) => {
            previewTransform = payload;
            syncTransformFields(store.getState());
        };
        engine.onTransformCommitted = (itemId, transform) => {
            previewTransform = null;
            actions.updateThreeDItemTransform(itemId, transform);
        };
        engine.onCameraCommitted = (view) => {
            actions.updateThreeDView(view);
        };
        engine.onSamplesUpdated = (samples) => {
            if (samples === sampleCount) return;
            sampleCount = samples;
            refs.sampleCount.textContent = String(samples);
            if (refs.compactSampleCount) {
                refs.compactSampleCount.textContent = String(samples);
            }
            if (samples > 0) {
                setPathTraceLoading(false);
            }
        };
        engine.onPathTraceLoading = (payload) => {
            setPathTraceLoading(payload?.active, payload?.message);
        };
        engine.onBackgroundRenderUpdate = (payload) => {
            renderRenderJobUi(payload);
            if (payload?.active && (payload.currentSamples || 0) < 1) {
                setPathTraceLoading(true, payload.message || 'Preparing background render...');
            } else {
                setPathTraceLoading(false);
            }
            if (statusTone !== 'error' && payload?.active) {
                const prefix = payload?.message ? `${payload.message} ` : 'Background render running: ';
                setStatus(`${prefix}${payload.currentSamples || 0} / ${payload.requestedSamples || 0} samples at ${formatRenderSize(payload)}.`, 'info');
            }
            actions.setThreeDRenderJob(
                payload,
                payload?.active
                    ? { render: false, skipViewRender: true }
                    : { render: false }
            );
        };
        return engine;
    }

    applyUiMode();

    return {
        root,
        activate() {
            active = true;
            hydrateEngine();
            refs.sampleCount.textContent = String(sampleCount);
            engine.onResize();
            engine.queueSync(store.getState().threeDDocument).catch((error) => {
                console.error(error);
                setStatus(error?.message || 'Could not sync the 3D scene.', 'error');
            });
        },
        deactivate() {
            active = false;
            closeRenderDialog();
        },
        render(state) {
            const document = state.threeDDocument;
            if (!document) return;

            refs.backgroundColor.value = document.scene.backgroundColor || '#202020';
            refs.showGrid.checked = !!document.scene.showGrid;
            refs.showAxes.checked = !!document.scene.showAxes;
            refs.renderMode.value = document.render.mode || 'raster';
            setInputValue(refs.samplesTarget, document.render.samplesTarget || 256);
            setInputValue(refs.exposureRange, document.render.exposure || 1);
            refs.toneMapping.value = document.render.toneMapping || 'aces';
            setInputValue(refs.cameraFov, document.view.fov || 50);
            refs.cameraMode.value = document.view.cameraMode || 'orbit';
            refs.linkPlaneScale.checked = document.view.linkPlaneScale !== false;
            setInputValue(refs.snapTranslationStep, document.view.snapTranslationStep ?? 0);
            setInputValue(refs.snapRotationDegrees, document.view.snapRotationDegrees ?? 0);
            if (refs.compactRenderModeLabel) {
                refs.compactRenderModeLabel.textContent = document.render.mode === 'pathtrace' ? 'Path Trace' : 'Raster';
            }
            if (refs.compactSampleCount) {
                refs.compactSampleCount.textContent = String(sampleCount);
            }
            renderRenderJobUi(document.renderJob);

            const selected = getSelectedItem(state);
            const selectedMaterial = getSelectedMaterial(state);
            const renderLocked = !!document.renderJob?.active;
            const lightSupportsTarget = selected?.kind === 'light' && ['directional', 'spot'].includes(selected.light?.lightType);
            if (renderLocked && renderDialogOpen) {
                closeRenderDialog();
            }

            refs.selectionName.textContent = selected ? selected.name : 'Nothing selected';
            setInputValue(refs.itemName, selected?.name || '');
            refs.lightFields.style.display = selected?.kind === 'light' ? 'flex' : 'none';
            if (selected?.kind === 'light') {
                setInputValue(refs.lightColor, selected.light?.color || '#ffffff');
                setInputValue(refs.lightIntensity, selected.light?.intensity ?? 1);
                refs.lightTargetFields.style.display = lightSupportsTarget ? 'flex' : 'none';
                renderLightTargetOptions(state, selected);
            } else {
                refs.lightTargetFields.style.display = 'none';
            }

            const showMaterialFields = isMaterialItem(selected);
            refs.materialFields.style.display = showMaterialFields ? 'flex' : 'none';
            refs.emissiveFields.style.display = showMaterialFields && selectedMaterial?.preset === 'emissive' ? 'flex' : 'none';
            refs.glassFields.style.display = showMaterialFields && selectedMaterial?.preset === 'glass' ? 'flex' : 'none';
            refs.textureFields.style.display = showMaterialFields ? 'flex' : 'none';
            if (showMaterialFields) {
                refs.materialPreset.value = selectedMaterial?.preset || 'original';
                refs.materialColor.value = selectedMaterial?.color || '#ffffff';
                setInputValue(refs.materialRoughness, selectedMaterial?.roughness ?? 0.65);
                setInputValue(refs.materialMetalness, selectedMaterial?.metalness ?? 0);
                setInputValue(refs.materialOpacity, selectedMaterial?.opacity ?? 1);
                refs.materialEmissiveColor.value = selectedMaterial?.emissiveColor || '#ffffff';
                setInputValue(refs.materialEmissiveIntensity, selectedMaterial?.emissiveIntensity ?? 0);
                refs.materialAttenuationColor.value = selectedMaterial?.attenuationColor || '#ffffff';
                setInputValue(refs.materialIor, selectedMaterial?.ior ?? 1.5);
                setInputValue(refs.materialTransmission, selectedMaterial?.transmission ?? 1);
                setInputValue(refs.materialThickness, selectedMaterial?.thickness ?? 0.35);
                setInputValue(refs.materialAttenuationDistance, selectedMaterial?.attenuationDistance ?? 1.5);
                refs.textureName.textContent = selectedMaterial?.texture?.name || 'None';
                setInputValue(refs.textureRepeatX, selectedMaterial?.texture?.repeat?.[0] ?? 1);
                setInputValue(refs.textureRepeatY, selectedMaterial?.texture?.repeat?.[1] ?? 1);
                setInputValue(refs.textureRotation, selectedMaterial?.texture?.rotation ?? 0);
            }

            renderHierarchy(state);
            renderCameraPresets(state);
            syncTransformFields(state);

            const selectedIsLight = selected?.kind === 'light';
            const selectedIsMaterial = isMaterialItem(selected);
            const hasSelection = !!selected;

            root.querySelectorAll('button, input, select, textarea').forEach((node) => {
                node.disabled = renderLocked;
            });
            root.querySelectorAll('[data-threed-action="transform-mode"]').forEach((node) => {
                node.disabled = renderLocked || !hasSelection;
            });
            ['frame-item', 'duplicate-item', 'reset-transform', 'delete-item'].forEach((actionName) => {
                root.querySelectorAll(`[data-threed-action="${actionName}"]`).forEach((node) => {
                    node.disabled = renderLocked || !hasSelection;
                });
            });
            ['upload-texture', 'clear-texture'].forEach((actionName) => {
                root.querySelectorAll(`[data-threed-action="${actionName}"]`).forEach((node) => {
                    node.disabled = renderLocked || !selectedIsMaterial;
                });
            });
            root.querySelectorAll('[data-threed-action="abort-render"]').forEach((node) => {
                node.disabled = !renderLocked;
            });

            refs.lightColor.disabled = renderLocked || !selectedIsLight;
            refs.lightIntensity.disabled = renderLocked || !selectedIsLight;
            refs.lightTarget.disabled = renderLocked || !lightSupportsTarget;
            refs.itemName.disabled = renderLocked || !hasSelection;
            [...transformInputs.position, ...transformInputs.rotation, ...transformInputs.scale].forEach((input) => {
                input.disabled = renderLocked || !hasSelection;
            });
            refs.materialPreset.disabled = renderLocked || !selectedIsMaterial;
            refs.materialColor.disabled = renderLocked || !selectedIsMaterial;
            refs.materialRoughness.disabled = renderLocked || !selectedIsMaterial;
            refs.materialMetalness.disabled = renderLocked || !selectedIsMaterial;
            refs.materialOpacity.disabled = renderLocked || !selectedIsMaterial;
            refs.materialEmissiveColor.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'emissive';
            refs.materialEmissiveIntensity.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'emissive';
            refs.materialAttenuationColor.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialIor.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialTransmission.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialThickness.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialAttenuationDistance.disabled = renderLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.textureRepeatX.disabled = renderLocked || !selectedIsMaterial || !selectedMaterial?.texture;
            refs.textureRepeatY.disabled = renderLocked || !selectedIsMaterial || !selectedMaterial?.texture;
            refs.textureRotation.disabled = renderLocked || !selectedIsMaterial || !selectedMaterial?.texture;

            if (statusTone !== 'error') {
                if (document.renderJob?.active) {
                    const renderMessage = document.renderJob.message
                        ? `${document.renderJob.message} ${document.renderJob.currentSamples || 0} / ${document.renderJob.requestedSamples || 0} samples at ${formatRenderSize(document.renderJob)}.`
                        : `Background render running: ${document.renderJob.currentSamples || 0} / ${document.renderJob.requestedSamples || 0} samples at ${formatRenderSize(document.renderJob)}.`;
                    setStatus(renderMessage, 'info');
                } else if (document.renderJob?.status === 'complete') {
                    setStatus(document.renderJob.message || 'Background render complete. PNG exported.', 'success');
                } else if (document.renderJob?.status === 'aborted') {
                    setStatus(document.renderJob.message || 'Background render aborted.', 'warning');
                } else if (document.view.cameraMode === 'fly') {
                    setStatus('Fly camera active. Click the viewport, then use right-drag to look and W A S D Q E to move.', 'info');
                } else if (!document.scene.items.length) {
                    setStatus('Load models or add image planes to start building a 3D scene.');
                } else if (document.render.mode === 'pathtrace') {
                    setStatus('Path tracing is active. Editor helpers are excluded from the traced scene.');
                } else {
                    setStatus(`${document.scene.items.length} scene item${document.scene.items.length === 1 ? '' : 's'} ready.`, 'info');
                }
            }

            if (document.renderJob?.active && (document.renderJob.currentSamples || 0) < 1) {
                setPathTraceLoading(true, document.renderJob.message || 'Preparing background render...');
            } else if (document.render.mode !== 'pathtrace') {
                setPathTraceLoading(false);
            }

            if (active && engine) {
                const nextSyncKey = buildEngineSyncKey(document);
                if (nextSyncKey === lastEngineSyncKey) return;
                lastEngineSyncKey = nextSyncKey;
                const token = ++renderSyncToken;
                engine.queueSync(document).catch((error) => {
                    if (token !== renderSyncToken) return;
                    console.error(error);
                    setStatus(error?.message || 'Could not sync the 3D scene.', 'error');
                });
            }
        },
        async capturePreview() {
            if (!engine) {
                hydrateEngine();
                await engine.queueSync(store.getState().threeDDocument);
            }
            return engine.capturePreview();
        }
    };
}
