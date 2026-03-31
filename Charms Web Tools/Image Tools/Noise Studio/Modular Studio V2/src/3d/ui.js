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

function isSliceCompatibleItem(item) {
    return item?.kind === 'model' || item?.kind === 'primitive';
}

function formatRenderSize(job) {
    if (!job?.outputWidth || !job?.outputHeight) return '0 x 0';
    return `${job.outputWidth} x ${job.outputHeight}`;
}

function describeItemKind(item) {
    const baseLabel = item.kind === 'light'
        ? item.light?.lightType || 'light'
        : item.kind === 'image-plane'
            ? 'image plane'
            : item.kind === 'primitive'
                ? item.asset?.primitiveType || 'primitive'
                : item.asset?.format || 'model';
    const cutCount = Number(item?.booleanCuts?.length || 0);
    return cutCount > 0 ? `${baseLabel}, ${cutCount} cut${cutCount === 1 ? '' : 's'}` : baseLabel;
}

function formatRenderModeLabel(mode) {
    if (mode === 'pathtrace') return 'Path Trace';
    if (mode === 'mesh') return 'Mesh';
    return 'Raster';
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
                toneMapping: documentState.render.toneMapping,
                bounces: documentState.render.bounces,
                transmissiveBounces: documentState.render.transmissiveBounces,
                filterGlossyFactor: documentState.render.filterGlossyFactor,
                denoiseEnabled: documentState.render.denoiseEnabled,
                denoiseSigma: documentState.render.denoiseSigma,
                denoiseThreshold: documentState.render.denoiseThreshold,
                denoiseKSigma: documentState.render.denoiseKSigma
            }
            : null
    });
}

const PANEL_TABS = [
    { id: 'outliner', label: 'Outliner' },
    { id: 'add', label: 'Add' },
    { id: 'object', label: 'Object' },
    { id: 'material', label: 'Material' },
    { id: 'scene', label: 'Scene' },
    { id: 'render', label: 'Render' },
    { id: 'views', label: 'Views' }
];

const PANEL_TAB_META = {
    outliner: { title: 'Outliner', subtitle: 'Scene items, visibility, and locking' },
    add: { title: 'Add', subtitle: 'Import models, image planes, lights, and primitives' },
    object: { title: 'Object', subtitle: 'Selection, transforms, and slicing tools' },
    material: { title: 'Material', subtitle: 'Surface, texture, and shading controls' },
    scene: { title: 'Scene', subtitle: 'Background, camera, and navigation options' },
    render: { title: 'Render', subtitle: 'Viewport mode, quality, and export' },
    views: { title: 'Views', subtitle: 'Camera presets and framing shortcuts' }
};

const DEFAULT_WORKSPACE = {
    taskView: 'layout',
    panelTab: 'outliner',
    taskTabs: {
        layout: { leftTab: 'outliner', rightTab: 'scene' },
        model: { leftTab: 'add', rightTab: 'object' },
        render: { leftTab: 'views', rightTab: 'render' }
    }
};

function getWorkspaceState(documentState) {
    const workspace = documentState?.workspace || DEFAULT_WORKSPACE;
    const taskView = workspace.taskView || DEFAULT_WORKSPACE.taskView;
    const fallbackPanelTab = taskView === 'model'
        ? 'object'
        : taskView === 'render'
            ? 'render'
            : 'outliner';
    return {
        taskView,
        panelTab: workspace.panelTab || fallbackPanelTab
    };
}

function describeWorkspacePanel(side, tabId) {
    return PANEL_TABS.find((entry) => entry.id === tabId)?.label || tabId;
}

function inferTaskViewFromPanel(panelTab) {
    if (panelTab === 'render') return 'render';
    if (panelTab === 'add' || panelTab === 'object' || panelTab === 'material') return 'model';
    return 'layout';
}

function describeHierarchyBadge(item) {
    if (item?.kind === 'light') return item.light?.lightType === 'point' ? 'Point' : item.light?.lightType === 'spot' ? 'Spot' : 'Sun';
    if (item?.kind === 'image-plane') return 'Image';
    if (item?.kind === 'primitive') return item.asset?.primitiveType === 'cylinder'
        ? 'Cyl'
        : item.asset?.primitiveType === 'sphere'
            ? 'Sphere'
            : item.asset?.primitiveType === 'cone'
                ? 'Cone'
                : 'Cube';
    return item?.asset?.format === 'gltf' ? 'GLTF' : 'GLB';
}

export function createThreeDWorkspace(actions, store) {
    const root = document.createElement('div');
    root.className = 'threed-workspace-root';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.position = 'relative';
    root.style.overflow = 'hidden';
    root.style.background = '#000000';

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
                                <option value="mesh">Mesh</option>
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
                        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Bounces</span>
                                <input type="number" min="1" max="64" step="1" class="control-number" data-threed-role="path-bounces">
                            </label>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Trans Bounces</span>
                                <input type="number" min="0" max="64" step="1" class="control-number" data-threed-role="path-transmissive-bounces">
                            </label>
                        </div>
                        <label style="display:flex; flex-direction:column; gap:6px;">
                            <span>Glossy Firefly Filter</span>
                            <input type="range" min="0" max="1" step="0.01" data-threed-role="path-filter-glossy-factor">
                        </label>
                        <label class="check-row">
                            <input type="checkbox" data-threed-role="path-denoise-enabled">
                            <span>Denoise Path Trace</span>
                        </label>
                        <div data-threed-role="path-denoise-fields" style="display:none; flex-direction:column; gap:10px;">
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Denoise Sigma</span>
                                <input type="range" min="0.5" max="12" step="0.1" data-threed-role="path-denoise-sigma">
                            </label>
                            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Threshold</span>
                                    <input type="number" min="0.0001" max="1" step="0.001" class="control-number" data-threed-role="path-denoise-threshold">
                                </label>
                                <label style="display:flex; flex-direction:column; gap:6px;">
                                    <span>Radius Scale</span>
                                    <input type="number" min="0.1" max="5" step="0.1" class="control-number" data-threed-role="path-denoise-ksigma">
                                </label>
                            </div>
                        </div>
                        <div style="font-size:11px; line-height:1.45; opacity:0.72;">Higher bounce counts help glass and deep reflections. The glossy filter reduces fireflies, while denoising smooths grain but can soften detail because this renderer only has the beauty image available here.</div>
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
                        <div data-threed-role="slice-fields" style="display:none; flex-direction:column; gap:10px; border-top:1px solid rgba(255,255,255,0.08); padding-top:10px;">
                            <div style="display:flex; justify-content:space-between; gap:12px;">
                                <span>Stored Cuts</span>
                                <strong data-threed-role="slice-count">0</strong>
                            </div>
                            <label style="display:flex; flex-direction:column; gap:6px;">
                                <span>Cutter Object</span>
                                <select class="custom-select" data-threed-role="slice-cutter"></select>
                            </label>
                            <div class="info-banner" style="margin:0;">Position another model or primitive where you want the subtraction, then click Slice. The cutter is captured as a snapshot, so you can move or delete it later. Reset Cuts restores the original uncut object.</div>
                            <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                                <button type="button" class="secondary-button" data-threed-action="apply-slice">Slice</button>
                                <button type="button" class="toolbar-button" data-threed-action="reset-slices">Reset Cuts</button>
                            </div>
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
                    <div class="info-banner" data-threed-role="render-dialog-note">Choose the final sample count and export resolution for this render. The viewport will switch to the final render pass while the PNG is being generated.</div>
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
        pathBounces: root.querySelector('[data-threed-role="path-bounces"]'),
        pathTransmissiveBounces: root.querySelector('[data-threed-role="path-transmissive-bounces"]'),
        pathFilterGlossyFactor: root.querySelector('[data-threed-role="path-filter-glossy-factor"]'),
        pathDenoiseEnabled: root.querySelector('[data-threed-role="path-denoise-enabled"]'),
        pathDenoiseFields: root.querySelector('[data-threed-role="path-denoise-fields"]'),
        pathDenoiseSigma: root.querySelector('[data-threed-role="path-denoise-sigma"]'),
        pathDenoiseThreshold: root.querySelector('[data-threed-role="path-denoise-threshold"]'),
        pathDenoiseKSigma: root.querySelector('[data-threed-role="path-denoise-ksigma"]'),
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
        sliceFields: root.querySelector('[data-threed-role="slice-fields"]'),
        sliceCount: root.querySelector('[data-threed-role="slice-count"]'),
        sliceCutter: root.querySelector('[data-threed-role="slice-cutter"]'),
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

    function buildCompactLayoutChrome() {
        const overlayShell = root.querySelector('.threed-overlay-shell');
        const sidebars = overlayShell ? Array.from(overlayShell.querySelectorAll('aside')) : [];
        const leftSidebar = sidebars[0] || null;
        const rightSidebar = sidebars[1] || null;
        if (!overlayShell || !leftSidebar || !rightSidebar) return;

        const sceneBody = leftSidebar.children[0]?.children[1];
        const cameraBody = leftSidebar.children[2]?.children[1];
        const inspectorBody = rightSidebar.children[1]?.children[1];
        const backgroundField = refs.backgroundColor?.closest('label');
        const showGridRow = refs.showGrid?.closest('label');
        const showAxesRow = refs.showAxes?.closest('label');
        const renderModeField = refs.renderMode?.closest('label');
        const samplesTargetField = refs.samplesTarget?.closest('label');
        const sampleCountRow = refs.sampleCount?.parentElement;
        const pathBounceGrid = refs.pathBounces?.closest('label')?.parentElement;
        const glossyField = refs.pathFilterGlossyFactor?.closest('label');
        const denoiseToggle = refs.pathDenoiseEnabled?.closest('label');
        const denoiseInfo = refs.pathDenoiseFields?.nextElementSibling;
        const exposureField = refs.exposureRange?.closest('label');
        const toneMappingField = refs.toneMapping?.closest('label');
        const cameraFovField = refs.cameraFov?.closest('label');
        const cameraModeField = refs.cameraMode?.closest('label');
        const linkPlaneScaleRow = refs.linkPlaneScale?.closest('label');
        const snapGrid = refs.snapTranslationStep?.closest('label')?.parentElement;
        const flyInfo = snapGrid?.nextElementSibling || null;
        const renderJobStatusRow = refs.renderJobStatus?.parentElement;
        const renderJobSamplesRow = refs.renderJobSamples?.parentElement;
        const renderJobSizeRow = refs.renderJobSize?.parentElement;

        const compactNode = (node) => {
            if (!node) return null;
            node.style.padding = '0';
            node.style.margin = '0';
            node.style.display = 'flex';
            node.style.flexDirection = 'column';
            node.style.gap = '8px';
            node.classList.add('threed-stack');
            return node;
        };

        const createPanel = (id) => {
            const meta = PANEL_TAB_META[id] || { title: describeWorkspacePanel(null, id), subtitle: '' };
            const section = document.createElement('section');
            section.className = 'threed-dock-panel';
            section.dataset.threedPanel = id;
            section.innerHTML = `
                <div class="threed-dock-panel-head">
                    <strong>${escapeHtml(meta.title)}</strong>
                    <span>${escapeHtml(meta.subtitle)}</span>
                </div>
                <div class="threed-dock-panel-body"></div>
            `;
            return { panel: section, body: section.querySelector('.threed-dock-panel-body') };
        };

        const createFoldout = (label, open = false) => {
            const element = document.createElement('details');
            element.className = 'threed-foldout';
            element.open = open;
            element.innerHTML = `<summary>${escapeHtml(label)}</summary><div class="threed-foldout-body"></div>`;
            return { element, body: element.querySelector('.threed-foldout-body') };
        };

        const style = document.createElement('style');
        style.textContent = `
            .threed-shell { --threed-bg:#000000; --threed-panel:#000000; --threed-panel-alt:#050505; --threed-border:#b8b2a3; --threed-border-soft:rgba(184,178,163,0.28); --threed-accent:rgba(184,178,163,0.14); --threed-text:#ffffff; --threed-muted:#b8b2a3; width:100%; height:100%; min-width:0; min-height:0; display:grid; grid-template-columns:minmax(220px, 280px) minmax(0, 1fr); gap:8px; padding:8px; background:var(--threed-bg); color:var(--threed-text); font-size:11px; line-height:1.24; overflow:hidden; }
            .threed-shell button, .threed-shell input, .threed-shell select, .threed-render-dialog button, .threed-render-dialog input, .threed-render-dialog select { font-size:11px !important; }
            .threed-shell .control-number, .threed-shell .custom-select, .threed-shell input[type="text"], .threed-shell input[type="number"], .threed-render-dialog .control-number { min-height:22px; padding:2px 6px !important; border-radius:4px; background:#000000; color:var(--threed-text); border:1px solid var(--threed-border); }
            .threed-shell .primary-button, .threed-shell .secondary-button, .threed-shell .toolbar-button, .threed-render-dialog .primary-button, .threed-render-dialog .toolbar-button { min-height:22px; padding:2px 7px !important; border-radius:4px; background:#000000; color:var(--threed-text); border:1px solid var(--threed-border); }
            .threed-shell [style*="font-size:11px"] { font-size:10px !important; }
            .threed-shell [style*="font-size:9px"] { font-size:9px !important; }
            .threed-shell .info-banner, .threed-render-dialog .info-banner { margin:0; padding:7px 8px !important; border-radius:4px; font-size:10px !important; line-height:1.35; background:rgba(184,178,163,0.08); border:1px solid var(--threed-border-soft); color:var(--threed-text); }
            .threed-dock, .threed-viewport-card { min-width:0; min-height:0; border:1px solid var(--threed-border); background:var(--threed-panel); overflow:hidden; }
            .threed-dock { display:flex; flex-direction:column; }
            .threed-dock-tabs { display:flex; flex-wrap:wrap; gap:4px; padding:6px; border-bottom:1px solid var(--threed-border); background:var(--threed-panel-alt); }
            .threed-dock-tab { min-height:20px; padding:0 7px; border:1px solid transparent; border-radius:4px; background:transparent; color:var(--threed-muted); cursor:pointer; }
            .threed-dock-tab.is-active, .threed-dock-tab:hover { color:var(--threed-text); background:var(--threed-accent); border-color:var(--threed-border); }
            .threed-dock-panels { flex:1; min-height:0; }
            .threed-dock-panel { display:none; height:100%; min-height:0; flex-direction:column; }
            .threed-dock-panel.is-active { display:flex; }
            .threed-dock-panel-head { padding:8px 9px 7px; border-bottom:1px solid var(--threed-border); background:var(--threed-panel-alt); }
            .threed-dock-panel-head span { display:block; margin-top:2px; color:var(--threed-muted); font-size:10px; }
            .threed-dock-panel-body { flex:1; min-height:0; overflow:auto; overscroll-behavior:contain; padding:8px; display:flex; flex-direction:column; gap:8px; }
            .threed-stack, .threed-stack > div, .threed-stack > label { min-width:0; }
            .threed-stack { display:flex; flex-direction:column; gap:8px; }
            .threed-button-row { display:grid; gap:6px; }
            .threed-button-row-2 { grid-template-columns:repeat(2, minmax(0, 1fr)); }
            .threed-button-row-3 { grid-template-columns:repeat(3, minmax(0, 1fr)); }
            .threed-button-row-4 { grid-template-columns:repeat(4, minmax(0, 1fr)); }
            .threed-foldout { border:1px solid var(--threed-border); background:var(--threed-panel-alt); }
            .threed-foldout summary { list-style:none; cursor:pointer; user-select:none; padding:7px 8px; color:var(--threed-text); font-weight:600; }
            .threed-foldout summary::-webkit-details-marker { display:none; }
            .threed-foldout[open] summary { border-bottom:1px solid var(--threed-border); }
            .threed-foldout-body { padding:8px; display:flex; flex-direction:column; gap:8px; }
            .threed-viewport-panel { min-width:0; min-height:0; display:flex; }
            .threed-viewport-card { position:relative; display:flex; flex:1; background:var(--threed-panel); }
            .threed-viewport-stage { position:relative; flex:1; min-width:0; min-height:0; background:#000000; }
            .threed-canvas-container.is-hidden { visibility:hidden; opacity:0; }
            .threed-render-preview-host { position:absolute; inset:0; z-index:5; display:none; align-items:center; justify-content:center; padding:10px; background:#000000; pointer-events:none; }
            .threed-render-preview-host.is-active { display:flex; }
            .threed-render-preview-host canvas { width:auto !important; height:auto !important; max-width:100%; max-height:100%; object-fit:contain; }
            .threed-overlay-corner { position:absolute; z-index:8; display:flex; gap:4px; max-width:calc(100% - 12px); pointer-events:none; }
            .threed-overlay-corner > * { pointer-events:auto; }
            .threed-overlay-top-left { top:6px; left:6px; flex-wrap:wrap; align-items:flex-start; }
            .threed-overlay-top-right { top:6px; right:6px; flex-wrap:wrap; justify-content:flex-end; align-items:flex-start; }
            .threed-overlay-bottom-left { left:6px; bottom:6px; max-width:min(58%, calc(100% - 12px)); }
            .threed-overlay-bottom-right { right:6px; bottom:6px; flex-direction:column; align-items:flex-end; gap:4px; max-width:min(58%, calc(100% - 12px)); }
            .threed-mini-bar { display:inline-flex; align-items:center; gap:3px; padding:3px; border:1px solid var(--threed-border-soft); background:rgba(0,0,0,0.92); }
            .threed-mini-bar .toolbar-button, .threed-mini-bar .secondary-button { min-height:20px; padding:0 6px !important; border-radius:3px; }
            .threed-overlay-chip { display:inline-flex; align-items:center; gap:4px; min-height:20px; padding:0 6px; border:1px solid var(--threed-border-soft); background:rgba(0,0,0,0.92); color:var(--threed-text); font-size:10px; white-space:nowrap; }
            .threed-overlay-chip.is-muted { color:var(--threed-muted); }
            .threed-status-pill { max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .threed-pathtrace-loading { position:absolute; inset:0; z-index:6; display:none; align-items:center; justify-content:center; padding:18px; background:rgba(8,10,14,0.62); pointer-events:none; }
            .threed-pathtrace-loading.is-active { display:flex; }
            .threed-loading-card { min-width:min(280px,100%); display:flex; align-items:center; gap:12px; padding:12px 14px; border:1px solid var(--threed-border); background:rgba(0,0,0,0.94); color:var(--threed-text); }
            .threed-spinner { width:15px; height:15px; flex:0 0 auto; border-radius:50%; border:2px solid rgba(184,178,163,0.2); border-top-color:var(--threed-border); animation:threed-spin 0.8s linear infinite; }
            .threed-outliner { display:flex; flex-direction:column; gap:6px; }
            .threed-outliner-item { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:6px; width:100%; padding:6px 7px; border:1px solid var(--threed-border); background:#000000; color:inherit; cursor:pointer; text-align:left; }
            .threed-outliner-item.is-active { background:var(--threed-accent); border-color:var(--threed-border); }
            .threed-outliner-main, .threed-outliner-copy, .threed-outliner-tools { display:flex; gap:6px; }
            .threed-outliner-main { min-width:0; align-items:center; border:none; background:none; padding:0; color:inherit; text-align:left; }
            .threed-outliner-copy { flex-direction:column; min-width:0; gap:2px; }
            .threed-outliner-copy strong, .threed-outliner-copy span, .threed-overlay-bottom-right .threed-overlay-chip { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .threed-outliner-copy span { color:var(--threed-muted); font-size:11px; }
            .threed-kind-badge { display:inline-flex; align-items:center; justify-content:center; min-width:36px; min-height:18px; padding:0 5px; border:1px solid var(--threed-border-soft); background:rgba(184,178,163,0.08); color:var(--threed-muted); font-size:9px; letter-spacing:0.04em; text-transform:uppercase; }
            .threed-icon-button { min-width:20px; min-height:20px; padding:0; border:1px solid var(--threed-border-soft); background:var(--threed-panel-alt); color:var(--threed-muted); cursor:pointer; }
            .threed-icon-button.is-active, .threed-shell .toolbar-button.is-active, .threed-shell .secondary-button.is-active { color:var(--threed-text); background:var(--threed-accent); border-color:var(--threed-border); }
            .threed-shell [style*="color:#ff8a80"], .threed-shell [style*="color:#ffd180"], .threed-shell [style*="color:#80d8ff"] { color:var(--threed-muted) !important; }
            .threed-render-dialog { position:absolute; inset:0; z-index:40; display:none; align-items:flex-start; justify-content:center; padding:12px; background:rgba(0,0,0,0.78); backdrop-filter:blur(4px); }
            .threed-render-dialog.is-open { display:flex; }
            .threed-render-dialog-card { width:min(360px, calc(100vw - 24px)); border:1px solid var(--threed-border); background:#000000; box-shadow:0 18px 48px rgba(0,0,0,0.34); pointer-events:auto; color:var(--threed-text); }
            .threed-render-dialog-header, .threed-render-dialog-footer { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px; border-bottom:1px solid var(--threed-border); }
            .threed-render-dialog-footer { border-top:1px solid var(--threed-border); border-bottom:none; justify-content:flex-end; }
            .threed-render-dialog-body { padding:8px; display:flex; flex-direction:column; gap:8px; }
            .threed-shell[data-ui-mode="fullscreen"] { grid-template-columns:minmax(0, 1fr); padding:0; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-dock { display:none; }
            .threed-shell[data-ui-mode="fullscreen"] .threed-viewport-card { border:none; }
            @keyframes threed-spin { to { transform: rotate(360deg); } }
            @media (max-width: 920px) { .threed-shell { grid-template-columns:minmax(190px, 230px) minmax(0, 1fr); gap:6px; padding:6px; } }
            @media (max-width: 680px) { .threed-shell { grid-template-columns:minmax(170px, 42vw) minmax(0, 1fr); } }
        `;
        root.prepend(style);

        refs.hierarchy.classList.add('threed-outliner');
        refs.hierarchy.style.maxHeight = 'none';
        refs.hierarchy.style.padding = '0';
        refs.hierarchy.style.overflow = 'visible';
        refs.cameraPresets.style.padding = '0';
        refs.cameraPresets.style.display = 'flex';
        refs.cameraPresets.style.flexDirection = 'column';
        refs.cameraPresets.style.gap = '6px';

        compactNode(sceneBody);
        compactNode(cameraBody);
        compactNode(inspectorBody);

        const outlinerPanel = createPanel('outliner');
        const addPanel = createPanel('add');
        const objectPanel = createPanel('object');
        const materialPanel = createPanel('material');
        const scenePanel = createPanel('scene');
        const renderPanel = createPanel('render');
        const viewsPanel = createPanel('views');

        outlinerPanel.body.appendChild(refs.hierarchy);

        if (sceneBody) {
            addPanel.body.appendChild(sceneBody);
        }
        const addLightsBlock = sceneBody?.querySelector('[data-threed-action="add-light"]')?.closest('div') || null;
        if (addLightsBlock) {
            const foldout = createFoldout('Lights');
            foldout.body.appendChild(addLightsBlock);
            addPanel.body.appendChild(foldout.element);
        }
        const addPrimitivesBlock = sceneBody?.querySelector('[data-threed-action="add-primitive"]')?.closest('div')?.parentElement || null;
        if (addPrimitivesBlock && addPrimitivesBlock !== addLightsBlock) {
            const foldout = createFoldout('Primitives');
            foldout.body.appendChild(addPrimitivesBlock);
            addPanel.body.appendChild(foldout.element);
        }

        if (inspectorBody) {
            objectPanel.body.appendChild(inspectorBody);
        }
        if (refs.materialFields) {
            compactNode(refs.materialFields);
            materialPanel.body.appendChild(refs.materialFields);
        }

        const sceneCameraFoldout = createFoldout('Camera');
        const sceneNavigationFoldout = createFoldout('Navigation');
        [backgroundField, showGridRow, showAxesRow].filter(Boolean).forEach((node) => scenePanel.body.appendChild(node));
        [cameraFovField, cameraModeField].filter(Boolean).forEach((node) => sceneCameraFoldout.body.appendChild(node));
        [linkPlaneScaleRow, snapGrid, flyInfo].filter(Boolean).forEach((node) => sceneNavigationFoldout.body.appendChild(node));
        if (sceneCameraFoldout.body.childElementCount) {
            scenePanel.body.appendChild(sceneCameraFoldout.element);
        }
        if (sceneNavigationFoldout.body.childElementCount) {
            scenePanel.body.appendChild(sceneNavigationFoldout.element);
        }

        const renderBasics = document.createElement('div');
        renderBasics.className = 'threed-stack';
        [renderModeField, samplesTargetField, sampleCountRow].filter(Boolean).forEach((node) => renderBasics.appendChild(node));
        const renderActions = document.createElement('div');
        renderActions.className = 'threed-button-row threed-button-row-2';
        renderActions.innerHTML = `
            <button type="button" class="primary-button" data-threed-action="render-scene">Render PNG</button>
            <button type="button" class="toolbar-button" data-threed-action="abort-render">Abort</button>
        `;
        renderBasics.appendChild(renderActions);
        [renderJobStatusRow, renderJobSamplesRow, renderJobSizeRow].filter(Boolean).forEach((node) => renderBasics.appendChild(node));
        renderPanel.body.appendChild(renderBasics);

        const renderQualityFoldout = createFoldout('Path Trace Quality');
        [pathBounceGrid, glossyField, denoiseToggle, refs.pathDenoiseFields, denoiseInfo].filter(Boolean).forEach((node) => renderQualityFoldout.body.appendChild(node));
        if (renderQualityFoldout.body.childElementCount) {
            renderPanel.body.appendChild(renderQualityFoldout.element);
        }
        const renderToneFoldout = createFoldout('Tone & Exposure');
        [exposureField, toneMappingField].filter(Boolean).forEach((node) => renderToneFoldout.body.appendChild(node));
        if (renderToneFoldout.body.childElementCount) {
            renderPanel.body.appendChild(renderToneFoldout.element);
        }

        const viewActions = document.createElement('div');
        viewActions.className = 'threed-button-row threed-button-row-2';
        viewActions.innerHTML = `
            <button type="button" class="toolbar-button" data-threed-action="save-camera-preset">Save Current View</button>
            <button type="button" class="toolbar-button" data-threed-action="frame-item">Frame Selected</button>
            <button type="button" class="toolbar-button" data-threed-action="reset-camera">Reset View</button>
            <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="fullscreen">Fullscreen</button>
        `;
        viewsPanel.body.appendChild(viewActions);
        const viewsHint = document.createElement('div');
        viewsHint.className = 'info-banner';
        viewsHint.innerHTML = 'Use <code>1</code>, <code>2</code>, and <code>3</code> for raster, path trace, and mesh. Press <code>F</code> in orbit mode to frame the selected object.';
        viewsPanel.body.appendChild(viewsHint);
        if (cameraBody) {
            cameraBody.remove();
        }
        viewsPanel.body.appendChild(refs.cameraPresets);

        refs.status.removeAttribute('style');
        refs.status.className = 'threed-status-pill threed-overlay-chip';
        const statusHints = document.createElement('div');
        statusHints.className = 'threed-overlay-chip is-muted';
        statusHints.dataset.threedRole = 'status-hints';
        const statusStats = document.createElement('div');
        statusStats.className = 'threed-overlay-chip is-muted';
        statusStats.dataset.threedRole = 'status-stats';

        const shell = document.createElement('div');
        shell.className = 'threed-shell';
        shell.dataset.threedRole = 'shell';
        shell.dataset.uiMode = 'edit';
        shell.innerHTML = `
            <aside class="threed-dock">
                <div class="threed-dock-tabs">${PANEL_TABS.map((tab) => `<button type="button" class="threed-dock-tab" data-threed-action="workspace-panel-tab" data-workspace-panel-tab="${tab.id}">${tab.label}</button>`).join('')}</div>
                <div class="threed-dock-panels"></div>
            </aside>
        `;
        const dockPanels = shell.querySelector('.threed-dock-panels');
        [
            outlinerPanel,
            addPanel,
            objectPanel,
            materialPanel,
            scenePanel,
            renderPanel,
            viewsPanel
        ].forEach(({ panel }) => dockPanels.appendChild(panel));

        const viewportPanel = document.createElement('section');
        viewportPanel.className = 'threed-viewport-panel';
        viewportPanel.innerHTML = `<div class="threed-viewport-card"><div class="threed-viewport-stage"></div></div>`;
        const viewportStage = viewportPanel.querySelector('.threed-viewport-stage');
        const renderPreviewHost = document.createElement('div');
        renderPreviewHost.className = 'threed-render-preview-host';
        renderPreviewHost.dataset.threedRole = 'render-preview-host';
        const viewportTopLeft = document.createElement('div');
        viewportTopLeft.className = 'threed-overlay-corner threed-overlay-top-left';
        viewportTopLeft.innerHTML = `
            <div class="threed-mini-bar">
                <button type="button" class="toolbar-button" data-threed-action="set-render-mode" data-render-mode="raster">Raster</button>
                <button type="button" class="toolbar-button" data-threed-action="set-render-mode" data-render-mode="pathtrace">Path Trace</button>
                <button type="button" class="toolbar-button" data-threed-action="set-render-mode" data-render-mode="mesh">Mesh</button>
            </div>
            <div class="threed-mini-bar">
                <button type="button" class="toolbar-button" data-threed-action="transform-mode" data-transform-mode="translate">Move</button>
                <button type="button" class="toolbar-button" data-threed-action="transform-mode" data-transform-mode="rotate">Rotate</button>
                <button type="button" class="toolbar-button" data-threed-action="transform-mode" data-transform-mode="scale">Scale</button>
            </div>
        `;
        const viewportTopRight = document.createElement('div');
        viewportTopRight.className = 'threed-overlay-corner threed-overlay-top-right';
        viewportTopRight.innerHTML = `
            <div class="threed-mini-bar">
                <button type="button" class="toolbar-button" data-threed-action="frame-item">Frame</button>
                <button type="button" class="toolbar-button" data-threed-action="reset-camera">Reset</button>
                <button type="button" class="toolbar-button" data-threed-action="render-scene">Render PNG</button>
                <button type="button" class="toolbar-button" data-threed-action="abort-render">Abort</button>
                <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="edit">Panels</button>
                <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="fullscreen">Fullscreen</button>
                <button type="button" class="toolbar-button" data-threed-action="save-library">Save</button>
            </div>
            <span class="threed-overlay-chip">Mode <strong data-threed-role="compact-render-mode-label">Raster</strong></span>
            <span class="threed-overlay-chip">Spp <strong data-threed-role="header-sample-count">0</strong></span>
        `;
        const viewportBottomLeft = document.createElement('div');
        viewportBottomLeft.className = 'threed-overlay-corner threed-overlay-bottom-left';
        const viewportBottomRight = document.createElement('div');
        viewportBottomRight.className = 'threed-overlay-corner threed-overlay-bottom-right';
        const pathTraceLoading = document.createElement('div');
        pathTraceLoading.className = 'threed-pathtrace-loading';
        pathTraceLoading.dataset.threedRole = 'pathtrace-loading';
        pathTraceLoading.innerHTML = `<div class="threed-loading-card"><div class="threed-spinner" aria-hidden="true"></div><div style="display:flex; flex-direction:column; gap:4px;"><strong>Preparing Path Tracer</strong><span data-threed-role="pathtrace-loading-text">Preparing path tracer...</span></div></div>`;

        refs.canvasContainer.style.position = 'absolute';
        refs.canvasContainer.style.inset = '0';
        viewportBottomLeft.appendChild(refs.status);
        viewportBottomRight.appendChild(statusHints);
        viewportBottomRight.appendChild(statusStats);
        viewportStage.appendChild(refs.canvasContainer);
        viewportStage.appendChild(renderPreviewHost);
        viewportStage.appendChild(viewportTopLeft);
        viewportStage.appendChild(viewportTopRight);
        viewportStage.appendChild(viewportBottomLeft);
        viewportStage.appendChild(viewportBottomRight);
        viewportStage.appendChild(pathTraceLoading);

        shell.appendChild(viewportPanel);
        root.appendChild(shell);
        overlayShell.remove();
    }

    function buildLayoutChrome() {
        buildCompactLayoutChrome();
    }

    buildLayoutChrome();
    refs.shell = root.querySelector('[data-threed-role="shell"]');
    refs.statusHints = root.querySelector('[data-threed-role="status-hints"]');
    refs.statusStats = root.querySelector('[data-threed-role="status-stats"]');
    refs.headerSampleCount = root.querySelector('[data-threed-role="header-sample-count"]');
    refs.renderPreviewHost = root.querySelector('[data-threed-role="render-preview-host"]');
    refs.compactSampleCount = root.querySelector('[data-threed-role="compact-sample-count"]') || refs.headerSampleCount;
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
    let renderPreviewCanvas = null;
    let sliceCutterId = '';

    const transformInputs = {
        position: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="position-${index}"]`)),
        rotation: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="rotation-${index}"]`)),
        scale: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="scale-${index}"]`))
    };

    function setStatus(text, tone = 'info') {
        statusTone = tone;
        refs.status.textContent = text || '';
        refs.status.dataset.tone = tone;
        refs.status.style.background = 'rgba(0,0,0,0.92)';
        refs.status.style.color = '#ffffff';
        refs.status.style.borderColor = tone === 'info'
            ? 'rgba(184,178,163,0.28)'
            : 'rgba(184,178,163,0.72)';
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

    function setRenderViewportPreview(payload = {}) {
        const nextActive = !!payload?.active;
        refs.renderPreviewHost?.classList.toggle('is-active', nextActive);
        refs.canvasContainer?.classList.toggle('is-hidden', nextActive);

        if (nextActive && payload?.canvas && refs.renderPreviewHost) {
            renderPreviewCanvas = payload.canvas;
            if (payload.canvas.parentNode !== refs.renderPreviewHost) {
                refs.renderPreviewHost.appendChild(payload.canvas);
            }
            return;
        }

        if (renderPreviewCanvas?.parentNode === refs.renderPreviewHost) {
            renderPreviewCanvas.remove();
        }
        renderPreviewCanvas = null;
    }

    function setRenderMode(mode) {
        const nextMode = mode === 'pathtrace' || mode === 'mesh' ? mode : 'raster';
        if (nextMode === 'pathtrace') {
            setPathTraceLoading(true, 'Preparing path tracer...');
        } else if (!store.getState().threeDDocument?.renderJob?.active) {
            setPathTraceLoading(false);
        }
        actions.updateThreeDRenderSettings({ mode: nextMode });
    }

    function setRenderDialogNote(text, tone = 'info') {
        if (!refs.renderDialogNote) return;
        refs.renderDialogNote.textContent = text || '';
        refs.renderDialogNote.style.background = tone === 'info'
            ? 'rgba(184,178,163,0.08)'
            : 'rgba(184,178,163,0.14)';
        refs.renderDialogNote.style.borderColor = tone === 'info'
            ? 'rgba(184,178,163,0.28)'
            : 'rgba(184,178,163,0.72)';
        refs.renderDialogNote.style.color = '#ffffff';
    }

    function openRenderDialog() {
        const state = store.getState();
        if (state.threeDDocument?.renderJob?.active) {
            setStatus('A render is already running.', 'warning');
            return;
        }
        const defaultSamples = state.threeDDocument?.render?.lastJobSamples || state.threeDDocument?.render?.samplesTarget || 256;
        const defaultWidth = state.threeDDocument?.render?.outputWidth || 1920;
        const defaultHeight = state.threeDDocument?.render?.outputHeight || 1080;
        const denoiseEnabled = !!state.threeDDocument?.render?.denoiseEnabled;
        setInputValue(refs.renderDialogSamples, defaultSamples);
        setInputValue(refs.renderDialogWidth, defaultWidth);
        setInputValue(refs.renderDialogHeight, defaultHeight);
        setRenderDialogNote(
            denoiseEnabled
                ? 'Choose the final sample count and export resolution for this render. The viewport will switch to the final render pass, and the current denoise settings will also be applied before export.'
                : 'Choose the final sample count and export resolution for this render. The viewport will switch to the final render pass while the PNG is being generated.',
            'info'
        );
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

    function renderWorkspaceChrome(documentState) {
        const workspace = getWorkspaceState(documentState);
        root.querySelectorAll('[data-threed-action="workspace-panel-tab"]').forEach((node) => {
            node.classList.toggle('is-active', node.dataset.workspacePanelTab === workspace.panelTab);
        });
        root.querySelectorAll('[data-threed-panel]').forEach((node) => {
            node.classList.toggle('is-active', node.dataset.threedPanel === workspace.panelTab);
        });
    }

    function renderHierarchy(state) {
        const items = state.threeDDocument?.scene?.items || [];
        if (!items.length) {
            refs.hierarchy.innerHTML = '<div class="empty-inline" style="padding:8px;">No 3D assets or lights in this scene yet.</div>';
            return;
        }
        refs.hierarchy.innerHTML = items.map((item) => `
            <div class="threed-outliner-item ${state.threeDDocument.selection.itemId === item.id ? 'is-active' : ''}">
                <button type="button" class="threed-outliner-main" data-threed-action="select-item" data-item-id="${item.id}">
                    <span class="threed-kind-badge">${escapeHtml(describeHierarchyBadge(item))}</span>
                    <span class="threed-outliner-copy">
                        <strong>${escapeHtml(item.name)}</strong>
                        <span>${escapeHtml(describeItemKind(item))}</span>
                    </span>
                </button>
                <span class="threed-outliner-tools">
                    <button type="button" class="threed-icon-button ${item.visible !== false ? 'is-active' : ''}" data-threed-action="toggle-item-visibility" data-item-id="${item.id}" title="${item.visible !== false ? 'Hide item' : 'Show item'}">${item.visible !== false ? 'Vis' : 'Hide'}</button>
                    <button type="button" class="threed-icon-button ${item.locked ? 'is-active' : ''}" data-threed-action="toggle-item-lock" data-item-id="${item.id}" title="${item.locked ? 'Unlock item' : 'Lock item'}">${item.locked ? 'Lock' : 'Free'}</button>
                </span>
            </div>
        `).join('');
    }

    function renderCameraPresets(state) {
        const presets = state.threeDDocument?.view?.presets || [];
        if (!presets.length) {
            refs.cameraPresets.innerHTML = '<div class="empty-inline" style="padding:8px;">Save a camera pose to teleport back to it later.</div>';
            return;
        }
        refs.cameraPresets.innerHTML = presets.map((preset) => `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:7px 9px; border-radius:10px; background:rgba(184,178,163,0.08); border:1px solid rgba(184,178,163,0.28);">
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

    function getSliceCutterCandidates(state, selected) {
        return (state.threeDDocument?.scene?.items || [])
            .filter((item) => isSliceCompatibleItem(item) && item.id !== selected?.id);
    }

    function renderSliceOptions(state, selected) {
        if (!isSliceCompatibleItem(selected)) {
            refs.sliceCount.textContent = '0';
            refs.sliceCutter.innerHTML = '<option value="">Select a solid object</option>';
            refs.sliceCutter.value = '';
            sliceCutterId = '';
            return;
        }

        const candidates = getSliceCutterCandidates(state, selected);
        refs.sliceCount.textContent = String(selected?.booleanCuts?.length || 0);
        if (!candidates.length) {
            refs.sliceCutter.innerHTML = '<option value="">Add another model or primitive first</option>';
            refs.sliceCutter.value = '';
            sliceCutterId = '';
            return;
        }

        if (!candidates.some((item) => item.id === sliceCutterId)) {
            sliceCutterId = candidates[0].id;
        }

        refs.sliceCutter.innerHTML = candidates.map((item) => `
            <option value="${item.id}">${escapeHtml(item.name)}</option>
        `).join('');
        refs.sliceCutter.value = sliceCutterId;
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
            setStatus('A render is already running.', 'warning');
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
            message: 'Preparing render...'
        });
        setPathTraceLoading(true, 'Preparing render...');
        setStatus(`Rendering ${requestedSamples} samples at ${outputWidth} x ${outputHeight}. The final render now takes over the viewport until export completes.`, 'info');
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
            setStatus(error?.message || 'The render failed.', 'error');
        });
    }

    root.addEventListener('click', (event) => {
        const actionNode = event.target.closest('[data-threed-action]');
        if (!actionNode) return;
        const action = actionNode.dataset.threedAction;
        if (action === 'ui-mode') {
            uiMode = actionNode.dataset.uiMode === 'fullscreen' ? 'fullscreen' : 'edit';
            applyUiMode();
        } else if (action === 'workspace-panel-tab') {
            const panelTab = actionNode.dataset.workspacePanelTab || 'outliner';
            actions.updateThreeDWorkspace?.({
                panelTab,
                taskView: inferTaskViewFromPanel(panelTab)
            });
        } else if (action === 'set-render-mode') {
            setRenderMode(actionNode.dataset.renderMode || 'raster');
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
        } else if (action === 'toggle-item-visibility') {
            actions.toggleThreeDItemVisibility?.(actionNode.dataset.itemId || null);
        } else if (action === 'toggle-item-lock') {
            actions.toggleThreeDItemLock?.(actionNode.dataset.itemId || null);
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
        } else if (action === 'apply-slice') {
            const state = store.getState();
            const selected = getSelectedItem(state);
            const cutterId = refs.sliceCutter?.value || sliceCutterId || '';
            const cutter = (state.threeDDocument?.scene?.items || []).find((item) => item.id === cutterId) || null;
            if (!isSliceCompatibleItem(selected)) return;
            if (!cutterId || !isSliceCompatibleItem(cutter)) {
                setStatus('Add another model or primitive to use as a cutter first.', 'warning');
                return;
            }
            setStatus(`Slicing ${selected.name} with ${cutter.name}...`, 'info');
            (async () => {
                const liveEngine = hydrateEngine();
                await liveEngine.queueSync(store.getState().threeDDocument);
                const snapshot = await liveEngine.captureBooleanCutSnapshot(selected.id, cutterId);
                actions.applyThreeDBooleanSlice?.(selected.id, snapshot);
                setStatus(`Sliced ${selected.name} with ${snapshot.sourceName}. Reset Cuts restores the original shape.`, 'success');
            })().catch((error) => {
                console.error(error);
                setStatus(error?.message || 'Could not apply that slice.', 'error');
            });
        } else if (action === 'reset-slices') {
            const selected = getSelectedItem(store.getState());
            if (isSliceCompatibleItem(selected) && (selected.booleanCuts?.length || 0) > 0) {
                actions.resetThreeDItemBooleanSlices?.(selected.id);
                setStatus(`Reset all stored cuts on ${selected.name}.`, 'success');
            }
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
                setStatus(error?.message || 'Could not start the render.', 'error');
            });
        } else if (action === 'abort-render') {
            if (engine?.abortBackgroundRender()) {
                setStatus('Abort requested. The render will stop after the current sample finishes.', 'warning');
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
        setRenderMode(event.target.value);
    });
    refs.samplesTarget.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ samplesTarget: Math.round(clamp(Number(event.target.value) || 256, 1, 4096)) });
    });
    refs.pathBounces.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ bounces: Math.round(clamp(Number(event.target.value) || 10, 1, 64)) });
    });
    refs.pathTransmissiveBounces.addEventListener('change', (event) => {
        const nextValue = String(event.target.value || '').trim() === ''
            ? 10
            : Number(event.target.value);
        actions.updateThreeDRenderSettings({ transmissiveBounces: Math.round(clamp(nextValue, 0, 64)) });
    });
    refs.pathFilterGlossyFactor.addEventListener('input', (event) => {
        actions.updateThreeDRenderSettings({ filterGlossyFactor: clamp(Number(event.target.value) || 0, 0, 1) });
    });
    refs.pathDenoiseEnabled.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ denoiseEnabled: !!event.target.checked });
    });
    refs.pathDenoiseSigma.addEventListener('input', (event) => {
        actions.updateThreeDRenderSettings({ denoiseSigma: clamp(Number(event.target.value) || 5, 0.5, 12) });
    });
    refs.pathDenoiseThreshold.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ denoiseThreshold: clamp(Number(event.target.value) || 0.03, 0.0001, 1) });
    });
    refs.pathDenoiseKSigma.addEventListener('change', (event) => {
        actions.updateThreeDRenderSettings({ denoiseKSigma: clamp(Number(event.target.value) || 1, 0.1, 5) });
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
    refs.sliceCutter.addEventListener('change', (event) => {
        sliceCutterId = event.target.value || '';
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
                    setStatus(error?.message || 'Could not start the render.', 'error');
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
            setRenderMode('raster');
        } else if (key === '2') {
            event.preventDefault();
            setRenderMode('pathtrace');
        } else if (key === '3') {
            event.preventDefault();
            setRenderMode('mesh');
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
            if (refs.headerSampleCount) {
                refs.headerSampleCount.textContent = String(samples);
            }
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
        engine.onBackgroundRenderViewport = (payload) => {
            setRenderViewportPreview(payload);
        };
        engine.onBackgroundRenderUpdate = (payload) => {
            renderRenderJobUi(payload);
            if (payload?.active && (payload.currentSamples || 0) < 1) {
                setPathTraceLoading(true, payload.message || 'Preparing render...');
            } else {
                setPathTraceLoading(false);
            }
            if (statusTone !== 'error' && payload?.active) {
                const prefix = payload?.message ? `${payload.message} ` : 'Final render running: ';
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
            if (refs.headerSampleCount) {
                refs.headerSampleCount.textContent = String(sampleCount);
            }
            engine.onResize();
            const documentState = store.getState().threeDDocument;
            const nextSyncKey = buildEngineSyncKey(documentState);
            if (nextSyncKey === lastEngineSyncKey) {
                return;
            }
            lastEngineSyncKey = nextSyncKey;
            engine.queueSync(documentState).catch((error) => {
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
            setInputValue(refs.pathBounces, document.render.bounces ?? 10);
            setInputValue(refs.pathTransmissiveBounces, document.render.transmissiveBounces ?? 10);
            setInputValue(refs.pathFilterGlossyFactor, document.render.filterGlossyFactor ?? 0);
            refs.pathDenoiseEnabled.checked = !!document.render.denoiseEnabled;
            refs.pathDenoiseFields.style.display = document.render.denoiseEnabled ? 'flex' : 'none';
            setInputValue(refs.pathDenoiseSigma, document.render.denoiseSigma ?? 5);
            setInputValue(refs.pathDenoiseThreshold, document.render.denoiseThreshold ?? 0.03);
            setInputValue(refs.pathDenoiseKSigma, document.render.denoiseKSigma ?? 1);
            setInputValue(refs.exposureRange, document.render.exposure || 1);
            refs.toneMapping.value = document.render.toneMapping || 'aces';
            setInputValue(refs.cameraFov, document.view.fov || 50);
            refs.cameraMode.value = document.view.cameraMode || 'orbit';
            refs.linkPlaneScale.checked = document.view.linkPlaneScale !== false;
            setInputValue(refs.snapTranslationStep, document.view.snapTranslationStep ?? 0);
            setInputValue(refs.snapRotationDegrees, document.view.snapRotationDegrees ?? 0);
            if (refs.compactRenderModeLabel) {
                refs.compactRenderModeLabel.textContent = formatRenderModeLabel(document.render.mode);
            }
            if (refs.compactSampleCount) {
                refs.compactSampleCount.textContent = String(sampleCount);
            }
            if (refs.headerSampleCount) {
                refs.headerSampleCount.textContent = String(sampleCount);
            }
            renderRenderJobUi(document.renderJob);
            renderWorkspaceChrome(document);
            root.querySelectorAll('[data-threed-action="set-render-mode"]').forEach((node) => {
                node.classList.toggle('is-active', node.dataset.renderMode === document.render.mode);
            });
            const activeTransformMode = engine?.getTransformMode?.() || 'translate';
            root.querySelectorAll('[data-threed-action="transform-mode"]').forEach((node) => {
                node.classList.toggle('is-active', node.dataset.transformMode === activeTransformMode);
            });

            const selected = getSelectedItem(state);
            const selectedMaterial = getSelectedMaterial(state);
            const renderLocked = !!document.renderJob?.active;
            const selectionLocked = !!selected?.locked;
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

            const selectedCanSlice = isSliceCompatibleItem(selected);
            const sliceCandidates = selectedCanSlice ? getSliceCutterCandidates(state, selected) : [];
            const hasSliceCandidates = sliceCandidates.length > 0;
            const hasStoredCuts = (selected?.booleanCuts?.length || 0) > 0;
            refs.sliceFields.style.display = selectedCanSlice ? 'flex' : 'none';
            renderSliceOptions(state, selected);

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

            if (refs.statusHints) {
                refs.statusHints.textContent = document.view.cameraMode === 'fly'
                    ? '1/2/3 | RMB look | W A S D Q E | Shift'
                    : '1/2/3 | F frame | Orbit drag | Wheel';
            }
            if (refs.statusStats) {
                refs.statusStats.textContent = `${document.scene.items.length} items | ${selected ? `${selected.name}${selectionLocked ? ' (locked)' : ''}` : 'No selection'} | ${formatRenderModeLabel(document.render.mode)} | ${sampleCount} spp`;
            }

            const selectedIsLight = selected?.kind === 'light';
            const selectedIsMaterial = isMaterialItem(selected);
            const hasSelection = !!selected;

            root.querySelectorAll('button, input, select, textarea').forEach((node) => {
                node.disabled = renderLocked;
            });
            root.querySelectorAll('[data-threed-action="transform-mode"]').forEach((node) => {
                node.disabled = renderLocked || !hasSelection || selectionLocked;
            });
            ['frame-item'].forEach((actionName) => {
                root.querySelectorAll(`[data-threed-action="${actionName}"]`).forEach((node) => {
                    node.disabled = renderLocked || !hasSelection;
                });
            });
            ['duplicate-item', 'reset-transform', 'delete-item'].forEach((actionName) => {
                root.querySelectorAll(`[data-threed-action="${actionName}"]`).forEach((node) => {
                    node.disabled = renderLocked || !hasSelection || selectionLocked;
                });
            });
            root.querySelectorAll('[data-threed-action="apply-slice"]').forEach((node) => {
                node.disabled = renderLocked || selectionLocked || !selectedCanSlice || !hasSliceCandidates;
            });
            root.querySelectorAll('[data-threed-action="reset-slices"]').forEach((node) => {
                node.disabled = renderLocked || selectionLocked || !selectedCanSlice || !hasStoredCuts;
            });
            ['upload-texture', 'clear-texture'].forEach((actionName) => {
                root.querySelectorAll(`[data-threed-action="${actionName}"]`).forEach((node) => {
                    node.disabled = renderLocked || selectionLocked || !selectedIsMaterial;
                });
            });
            root.querySelectorAll('[data-threed-action="abort-render"]').forEach((node) => {
                node.disabled = !renderLocked;
            });

            refs.lightColor.disabled = renderLocked || selectionLocked || !selectedIsLight;
            refs.lightIntensity.disabled = renderLocked || selectionLocked || !selectedIsLight;
            refs.lightTarget.disabled = renderLocked || selectionLocked || !lightSupportsTarget;
            refs.sliceCutter.disabled = renderLocked || selectionLocked || !selectedCanSlice || !hasSliceCandidates;
            refs.itemName.disabled = renderLocked || selectionLocked || !hasSelection;
            [...transformInputs.position, ...transformInputs.rotation, ...transformInputs.scale].forEach((input) => {
                input.disabled = renderLocked || selectionLocked || !hasSelection;
            });
            refs.materialPreset.disabled = renderLocked || selectionLocked || !selectedIsMaterial;
            refs.materialColor.disabled = renderLocked || selectionLocked || !selectedIsMaterial;
            refs.materialRoughness.disabled = renderLocked || selectionLocked || !selectedIsMaterial;
            refs.materialMetalness.disabled = renderLocked || selectionLocked || !selectedIsMaterial;
            refs.materialOpacity.disabled = renderLocked || selectionLocked || !selectedIsMaterial;
            refs.materialEmissiveColor.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'emissive';
            refs.materialEmissiveIntensity.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'emissive';
            refs.materialAttenuationColor.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialIor.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialTransmission.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialThickness.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.materialAttenuationDistance.disabled = renderLocked || selectionLocked || !selectedIsMaterial || selectedMaterial?.preset !== 'glass';
            refs.textureRepeatX.disabled = renderLocked || selectionLocked || !selectedIsMaterial || !selectedMaterial?.texture;
            refs.textureRepeatY.disabled = renderLocked || selectionLocked || !selectedIsMaterial || !selectedMaterial?.texture;
            refs.textureRotation.disabled = renderLocked || selectionLocked || !selectedIsMaterial || !selectedMaterial?.texture;

            if (statusTone !== 'error') {
                if (document.renderJob?.active) {
                    const renderMessage = document.renderJob.message
                        ? `${document.renderJob.message} ${document.renderJob.currentSamples || 0} / ${document.renderJob.requestedSamples || 0} samples at ${formatRenderSize(document.renderJob)}.`
                        : `Final render running: ${document.renderJob.currentSamples || 0} / ${document.renderJob.requestedSamples || 0} samples at ${formatRenderSize(document.renderJob)}.`;
                    setStatus(renderMessage, 'info');
                } else if (document.renderJob?.status === 'complete') {
                    setStatus(document.renderJob.message || 'Render complete. PNG exported.', 'success');
                } else if (document.renderJob?.status === 'aborted') {
                    setStatus(document.renderJob.message || 'Render aborted.', 'warning');
                } else if (document.view.cameraMode === 'fly') {
                    setStatus('Fly camera active. Click the viewport, then use right-drag to look and W A S D Q E to move.', 'info');
                } else if (!document.scene.items.length) {
                    setStatus('Load models or add image planes to start building a 3D scene.');
                } else if (document.render.mode === 'pathtrace') {
                    setStatus(
                        document.render.denoiseEnabled
                            ? 'Path tracing is active. Denoising is enabled, so noise should settle faster but very fine detail can soften a bit.'
                            : 'Path tracing is active. Editor helpers are excluded from the traced scene.',
                        'info'
                    );
                } else if (document.render.mode === 'mesh') {
                    setStatus('Mesh view is active. Scene geometry is shown as wireframe while the editor controls stay available.', 'info');
                } else {
                    setStatus(`${document.scene.items.length} scene item${document.scene.items.length === 1 ? '' : 's'} ready.`, 'info');
                }
            }

            if (document.renderJob?.active && (document.renderJob.currentSamples || 0) < 1) {
                setPathTraceLoading(true, document.renderJob.message || 'Preparing render...');
            } else if (document.render.mode !== 'pathtrace' && !document.renderJob?.active) {
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
