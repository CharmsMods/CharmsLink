import { ThreeDEngine } from './engine.js';
import { createProgressOverlayController } from '../ui/progressOverlay.js';
import { nextPaint } from '../ui/scheduling.js';

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
    return item?.kind === 'model' || item?.kind === 'primitive' || item?.kind === 'image-plane';
}

function isTextItem(item) {
    return item?.kind === 'text';
}

function isShapeItem(item) {
    return item?.kind === 'shape-2d';
}

function formatRenderSize(job) {
    if (!job?.outputWidth || !job?.outputHeight) return '0 x 0';
    return `${job.outputWidth} x ${job.outputHeight}`;
}

function formatDuration(durationMs = 0) {
    const safeMs = Math.max(0, Math.round(Number(durationMs) || 0));
    if (safeMs < 1000) return `${safeMs} ms`;
    const totalSeconds = safeMs / 1000;
    if (totalSeconds < 60) return `${totalSeconds.toFixed(totalSeconds >= 10 ? 1 : 2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1')} s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.round(totalSeconds % 60);
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function describeItemKind(item) {
    return item.kind === 'light'
        ? item.light?.lightType || 'light'
        : item.kind === 'image-plane'
            ? 'image plane'
            : item.kind === 'primitive'
                ? item.asset?.primitiveType || 'primitive'
                : item.kind === 'text'
                    ? `${item.text?.mode === 'extruded' ? '3d' : 'flat'} text`
                    : item.kind === 'shape-2d'
                        ? `${item.shape2d?.type || 'shape'} 2d`
                        : item.asset?.format || 'model';
}

function formatRenderModeLabel(mode) {
    if (mode === 'pathtrace') return 'Path Trace';
    if (mode === 'mesh') return 'Mesh';
    return 'Edit';
}

function formatLibraryAssetType(asset) {
    if (asset?.assetType === 'model') {
        return String(asset.format || 'model').toUpperCase();
    }
    return 'IMAGE';
}

function formatLibraryAssetSize(asset) {
    const width = Number(asset?.width || 0);
    const height = Number(asset?.height || 0);
    if (width > 0 && height > 0) {
        return `${width} x ${height}`;
    }
    return asset?.assetType === 'model' ? '3D Asset' : 'Image Asset';
}

const LIBRARY_ASSET_DRAG_TYPE = 'application/x-noise-studio-library-asset';

function getPathTraceLoadingProgress(message = '') {
    const normalized = String(message || '').trim().toLowerCase();
    if (!normalized) return 0.18;
    if (normalized.includes('rebuilding path tracer scene')) return 0.36;
    if (normalized.includes('updating path tracer lights')) return 0.52;
    if (normalized.includes('updating path trace settings')) return 0.66;
    if (normalized.includes('building render scene')) return 0.24;
    if (normalized.includes('compiling render kernels')) return 0.48;
    if (normalized.includes('preparing render')) return 0.2;
    if (normalized.includes('rendering')) return 0.74;
    if (normalized.includes('encoding png')) return 0.9;
    if (normalized.includes('denoising')) return 0.96;
    return 0.18;
}

function buildEngineSyncKey(documentState) {
    return JSON.stringify({
        scene: documentState?.scene || null,
        selection: documentState?.selection || null,
        view: documentState?.view
            ? {
                cameraMode: documentState.view.cameraMode,
                projection: documentState.view.projection,
                navigationMode: documentState.view.navigationMode,
                lockedView: documentState.view.lockedView,
                lockedRotation: documentState.view.lockedRotation,
                orthoZoom: documentState.view.orthoZoom,
                wheelMode: documentState.view.wheelMode,
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
        assets: documentState?.assets || null,
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
    { id: 'selection', label: 'Selection' },
    { id: 'scene', label: 'Scene' },
    { id: 'render', label: 'Render' },
    { id: 'views', label: 'Views' }
];

const PANEL_TAB_META = {
    outliner: { title: 'Outliner', subtitle: 'Scene items, visibility, and locking' },
    add: { title: 'Add', subtitle: 'Import assets and add text, shapes, lights, and primitives' },
    selection: { title: 'Selection', subtitle: 'Focused editing for the selected item' },
    scene: { title: 'Scene', subtitle: 'World light, background, and camera options' },
    render: { title: 'Render', subtitle: 'Viewport mode, quality, and export' },
    views: { title: 'Views', subtitle: 'Camera presets and framing shortcuts' }
};

const DEFAULT_WORKSPACE = {
    taskView: 'layout',
    panelTab: 'outliner',
    taskTabs: {
        layout: { leftTab: 'outliner', rightTab: 'scene' },
        model: { leftTab: 'add', rightTab: 'selection' },
        render: { leftTab: 'views', rightTab: 'render' }
    }
};

function getWorkspaceState(documentState) {
    const workspace = documentState?.workspace || DEFAULT_WORKSPACE;
    const taskView = workspace.taskView || DEFAULT_WORKSPACE.taskView;
    const fallbackPanelTab = taskView === 'model'
        ? 'selection'
        : taskView === 'render'
            ? 'render'
            : 'outliner';
    return {
        taskView,
        panelTab: workspace.panelTab === 'object' || workspace.panelTab === 'material'
            ? 'selection'
            : (workspace.panelTab || fallbackPanelTab)
    };
}

function describeWorkspacePanel(side, tabId) {
    return PANEL_TABS.find((entry) => entry.id === tabId)?.label || tabId;
}

function inferTaskViewFromPanel(panelTab) {
    if (panelTab === 'render') return 'render';
    if (panelTab === 'add' || panelTab === 'selection') return 'model';
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
    if (item?.kind === 'text') return 'Text';
    if (item?.kind === 'shape-2d') return item.shape2d?.type === 'circle' ? 'Circle' : 'Square';
    return item?.asset?.format === 'gltf' ? 'GLTF' : 'GLB';
}

export function createThreeDWorkspace(actions, store) {
    const logger = store?.logger || null;
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
                        <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:8px;">
                            <button type="button" class="primary-button" data-threed-action="load-models">Load Models</button>
                            <button type="button" class="toolbar-button" data-threed-action="load-images">Add Image Planes</button>
                            <button type="button" class="toolbar-button" data-threed-action="save-library">Save to Library</button>
                            <button type="button" class="toolbar-button" data-threed-action="save-scene-json">Save JSON</button>
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
                                <option value="raster">Edit</option>
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
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                            <div data-threed-role="selection-name" style="font-weight:600;">Nothing selected</div>
                            <button type="button" class="secondary-button" data-threed-action="selection-menu">Item Menu</button>
                        </div>
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
        <input type="file" accept=".ttf,.otf,.woff,.woff2,font/ttf,font/otf,font/woff,font/woff2" data-threed-role="font-input" multiple hidden>
        <input type="file" accept=".hdr" data-threed-role="hdri-input" hidden>
        <input type="file" accept="image/*" data-threed-role="texture-input" hidden>
    `;

    const refs = {
        canvasContainer: root.querySelector('.threed-canvas-container'),
        modelInput: root.querySelector('[data-threed-role="model-input"]'),
        imageInput: root.querySelector('[data-threed-role="image-input"]'),
        fontInput: root.querySelector('[data-threed-role="font-input"]'),
        hdriInput: root.querySelector('[data-threed-role="hdri-input"]'),
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
            .threed-shell { --threed-bg:#000000; --threed-panel:#000000; --threed-panel-alt:#050505; --threed-border:#b8b2a3; --threed-border-soft:rgba(184,178,163,0.28); --threed-accent:rgba(184,178,163,0.14); --threed-text:#ffffff; --threed-muted:#b8b2a3; position:relative; width:100%; height:100%; min-width:0; min-height:0; display:grid; grid-template-columns:minmax(220px, 280px) minmax(0, 1fr); gap:8px; padding:8px; background:var(--threed-bg); color:var(--threed-text); font-size:11px; line-height:1.24; overflow:hidden; }
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
            .threed-range-control { display:grid; grid-template-columns:minmax(0, 1fr) 68px; gap:8px; align-items:center; }
            .threed-range-control input[type="range"] { min-width:0; margin:0; }
            .threed-range-control .control-number { width:100%; }
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
            .threed-mini-bar { display:inline-flex; align-items:center; gap:3px; padding:3px; border:1px solid var(--threed-border-soft); background:rgba(0,0,0,0.92); box-shadow:none !important; filter:none !important; }
            .threed-mini-bar .toolbar-button, .threed-mini-bar .secondary-button { min-height:20px; padding:0 6px !important; border-radius:3px; box-shadow:none !important; filter:none !important; text-shadow:none; }
            .threed-mini-bar .toolbar-button:focus, .threed-mini-bar .secondary-button:focus { outline:none; }
            .threed-mini-bar .toolbar-button:focus-visible, .threed-mini-bar .secondary-button:focus-visible { outline:1px solid var(--threed-border); outline-offset:1px; }
            .threed-overlay-chip { display:inline-flex; align-items:center; gap:4px; min-height:20px; padding:0 6px; border:1px solid var(--threed-border-soft); background:rgba(0,0,0,0.92); color:var(--threed-text); font-size:10px; white-space:nowrap; box-shadow:none !important; filter:none !important; }
            .threed-overlay-chip.is-muted { color:var(--threed-muted); }
            .threed-context-menu-host { position:absolute; inset:0; z-index:18; pointer-events:none; }
            .threed-context-menu { position:absolute; min-width:180px; max-width:240px; display:flex; flex-direction:column; gap:2px; padding:4px; border:1px solid var(--threed-border); background:#000000; box-shadow:0 18px 38px rgba(0,0,0,0.38); pointer-events:auto; }
            .threed-context-menu button { width:100%; min-height:22px; padding:0 8px; display:flex; align-items:center; justify-content:space-between; gap:8px; border:1px solid transparent; background:transparent; color:var(--threed-text); text-align:left; }
            .threed-context-menu button:hover { background:var(--threed-accent); border-color:var(--threed-border-soft); }
            .threed-context-menu span:last-child { color:var(--threed-muted); }
            .threed-status-pill { max-width:100%; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .threed-pathtrace-loading { position:absolute; inset:0; z-index:6; display:none; align-items:center; justify-content:center; padding:18px; background:rgba(8,10,14,0.62); pointer-events:none; }
            .threed-pathtrace-loading.is-active { display:flex; }
            .threed-asset-drawer { position:absolute; left:10px; right:10px; bottom:10px; z-index:9; display:flex; flex-direction:column; align-items:center; gap:6px; pointer-events:none; }
            .threed-asset-drawer-tab { min-height:18px; padding:0 9px !important; border:1px solid var(--threed-border); background:rgba(0,0,0,0.94); color:var(--threed-text); font-size:9px !important; letter-spacing:0.08em; text-transform:uppercase; pointer-events:auto; }
            .threed-asset-drawer-panel { width:min(100%, 860px); max-width:100%; height:226px; display:none; flex-direction:column; gap:8px; padding:10px; border:1px solid var(--threed-border); background:rgba(0,0,0,0.96); box-shadow:0 -18px 42px rgba(0,0,0,0.36); pointer-events:auto; }
            .threed-asset-drawer.is-open .threed-asset-drawer-panel { display:flex; }
            .threed-asset-drawer-head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
            .threed-asset-drawer-head strong { font-size:10px; letter-spacing:0.08em; text-transform:uppercase; color:var(--threed-muted); }
            .threed-asset-search { width:132px; min-width:132px; min-height:20px; padding:2px 6px !important; border:1px solid var(--threed-border); background:#000000; color:var(--threed-text); font-size:10px !important; }
            .threed-asset-grid { flex:1; min-height:0; overflow:auto; display:grid; grid-template-columns:repeat(auto-fill, minmax(88px, 1fr)); gap:8px; }
            .threed-asset-card { display:flex; flex-direction:column; gap:6px; padding:6px; border:1px solid var(--threed-border-soft); background:rgba(184,178,163,0.06); color:var(--threed-text); text-align:left; cursor:grab; }
            .threed-asset-card:active { cursor:grabbing; }
            .threed-asset-card:hover { background:rgba(184,178,163,0.1); border-color:var(--threed-border); }
            .threed-asset-thumb { aspect-ratio:1 / 1; display:flex; align-items:flex-end; justify-content:flex-start; padding:6px; border:1px dashed var(--threed-border-soft); background:linear-gradient(180deg, rgba(184,178,163,0.08), rgba(184,178,163,0.02)); color:var(--threed-muted); font-size:9px; letter-spacing:0.08em; text-transform:uppercase; }
            .threed-asset-card strong { font-size:10px; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .threed-asset-card span { font-size:9px; color:var(--threed-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .threed-asset-empty { display:none; flex:1; align-items:center; justify-content:center; text-align:center; color:var(--threed-muted); border:1px dashed var(--threed-border-soft); padding:12px; }
            .threed-asset-empty.is-visible { display:flex; }
            .threed-loading-card { min-width:min(300px,100%); display:flex; flex-direction:column; gap:10px; padding:12px 14px; border:1px solid var(--threed-border); background:rgba(0,0,0,0.94); color:var(--threed-text); }
            .threed-loading-card-head { display:flex; align-items:center; gap:12px; }
            .threed-loading-card-copy { display:flex; flex-direction:column; gap:4px; min-width:0; }
            .threed-loading-progress { position:relative; width:100%; height:6px; overflow:hidden; border:1px solid var(--threed-border-soft); background:rgba(184,178,163,0.08); }
            .threed-loading-progress-fill { position:absolute; inset:0 auto 0 0; width:0%; background:linear-gradient(90deg, rgba(184,178,163,0.26), rgba(184,178,163,0.9)); transition:width 180ms ease; }
            .threed-loading-progress-label { font-size:9px; color:var(--threed-muted); letter-spacing:0.04em; text-transform:uppercase; }
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
            @media (max-width: 680px) { .threed-shell { grid-template-columns:minmax(170px, 42vw) minmax(0, 1fr); } .threed-asset-drawer { left:6px; right:6px; bottom:6px; } .threed-asset-drawer-panel { height:200px; padding:8px; } .threed-asset-search { width:108px; min-width:108px; } .threed-asset-grid { grid-template-columns:repeat(auto-fill, minmax(78px, 1fr)); gap:6px; } }
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
        const selectionPanel = createPanel('selection');
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

        const addCanvasItems = document.createElement('div');
        addCanvasItems.className = 'threed-button-row threed-button-row-2';
        addCanvasItems.innerHTML = `
            <button type="button" class="secondary-button" data-threed-action="add-text">Add Text</button>
            <button type="button" class="secondary-button" data-threed-action="upload-fonts">Upload Fonts</button>
            <button type="button" class="secondary-button" data-threed-action="add-shape" data-shape-type="square">Add Square</button>
            <button type="button" class="secondary-button" data-threed-action="add-shape" data-shape-type="circle">Add Circle</button>
        `;
        addPanel.body.appendChild(addCanvasItems);

        if (inspectorBody) {
            selectionPanel.body.appendChild(inspectorBody);
        }
        if (refs.materialFields) {
            compactNode(refs.materialFields);
            const materialFoldout = createFoldout('Material');
            materialFoldout.body.appendChild(refs.materialFields);
            selectionPanel.body.appendChild(materialFoldout.element);
        }

        const textFields = document.createElement('div');
        textFields.dataset.threedRole = 'text-fields';
        textFields.style.display = 'none';
        textFields.style.flexDirection = 'column';
        textFields.style.gap = '10px';
        textFields.innerHTML = `
            <div style="border-top:1px solid rgba(255,255,255,0.08); padding-top:10px; display:flex; flex-direction:column; gap:10px;">
                <label style="display:flex; flex-direction:column; gap:6px;">
                    <span>Text Content</span>
                    <textarea class="control-number" rows="4" data-threed-role="text-content"></textarea>
                </label>
                <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Mode</span>
                        <select class="custom-select" data-threed-role="text-mode">
                            <option value="flat">Flat</option>
                            <option value="extruded">Extruded</option>
                        </select>
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Font Source</span>
                        <select class="custom-select" data-threed-role="text-font-source-type">
                            <option value="system">System</option>
                            <option value="upload">Upload</option>
                        </select>
                    </label>
                </div>
                <label data-threed-role="text-font-family-field" style="display:flex; flex-direction:column; gap:6px;">
                    <span>Font Family</span>
                    <input type="text" class="control-number" data-threed-role="text-font-family" placeholder="Arial">
                </label>
                <label data-threed-role="text-font-upload-field" style="display:none; flex-direction:column; gap:6px;">
                    <span>Uploaded Font</span>
                    <div style="display:grid; grid-template-columns:minmax(0,1fr) auto; gap:8px;">
                        <select class="custom-select" data-threed-role="text-font-asset"></select>
                        <button type="button" class="toolbar-button" data-threed-action="upload-fonts">Upload</button>
                    </div>
                </label>
                <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
                    <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                        <span>Color</span>
                        <input type="color" data-threed-role="text-color">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Opacity</span>
                        <input type="range" min="0.01" max="1" step="0.01" data-threed-role="text-opacity">
                    </label>
                </div>
                <label class="check-row">
                    <input type="checkbox" data-threed-role="text-glow-enabled">
                    <span>Glow</span>
                </label>
                <div data-threed-role="text-glow-fields" style="display:none; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
                    <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                        <span>Glow Color</span>
                        <input type="color" data-threed-role="text-glow-color">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Glow Intensity</span>
                        <input type="range" min="0" max="50" step="0.1" data-threed-role="text-glow-intensity">
                    </label>
                </div>
                <div data-threed-role="text-extrude-fields" style="display:none; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Depth</span>
                        <input type="number" min="0.01" max="10" step="0.01" class="control-number" data-threed-role="text-depth">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Bevel Size</span>
                        <input type="number" min="0" max="2" step="0.01" class="control-number" data-threed-role="text-bevel-size">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Bevel Thickness</span>
                        <input type="number" min="0" max="2" step="0.01" class="control-number" data-threed-role="text-bevel-thickness">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Bevel Segments</span>
                        <input type="number" min="1" max="32" step="1" class="control-number" data-threed-role="text-bevel-segments">
                    </label>
                </div>
                <div>
                    <div style="display:flex; justify-content:space-between; gap:10px; align-items:center;">
                        <strong>Character Flips</strong>
                        <span style="font-size:10px; color:#b8b2a3;">Per character</span>
                    </div>
                    <div data-threed-role="text-character-overrides" style="margin-top:8px; display:flex; flex-direction:column; gap:6px;"></div>
                </div>
            </div>
        `;
        refs.textFields = textFields;
        refs.textContent = textFields.querySelector('[data-threed-role="text-content"]');
        refs.textMode = textFields.querySelector('[data-threed-role="text-mode"]');
        refs.textFontSourceType = textFields.querySelector('[data-threed-role="text-font-source-type"]');
        refs.textFontFamilyField = textFields.querySelector('[data-threed-role="text-font-family-field"]');
        refs.textFontFamily = textFields.querySelector('[data-threed-role="text-font-family"]');
        refs.textFontUploadField = textFields.querySelector('[data-threed-role="text-font-upload-field"]');
        refs.textFontAsset = textFields.querySelector('[data-threed-role="text-font-asset"]');
        refs.textColor = textFields.querySelector('[data-threed-role="text-color"]');
        refs.textOpacity = textFields.querySelector('[data-threed-role="text-opacity"]');
        refs.textGlowEnabled = textFields.querySelector('[data-threed-role="text-glow-enabled"]');
        refs.textGlowFields = textFields.querySelector('[data-threed-role="text-glow-fields"]');
        refs.textGlowColor = textFields.querySelector('[data-threed-role="text-glow-color"]');
        refs.textGlowIntensity = textFields.querySelector('[data-threed-role="text-glow-intensity"]');
        refs.textExtrudeFields = textFields.querySelector('[data-threed-role="text-extrude-fields"]');
        refs.textDepth = textFields.querySelector('[data-threed-role="text-depth"]');
        refs.textBevelSize = textFields.querySelector('[data-threed-role="text-bevel-size"]');
        refs.textBevelThickness = textFields.querySelector('[data-threed-role="text-bevel-thickness"]');
        refs.textBevelSegments = textFields.querySelector('[data-threed-role="text-bevel-segments"]');
        refs.textCharacterOverrides = textFields.querySelector('[data-threed-role="text-character-overrides"]');
        selectionPanel.body.appendChild(textFields);

        const shapeFields = document.createElement('div');
        shapeFields.dataset.threedRole = 'shape-fields';
        shapeFields.style.display = 'none';
        shapeFields.style.flexDirection = 'column';
        shapeFields.style.gap = '10px';
        shapeFields.innerHTML = `
            <div style="border-top:1px solid rgba(255,255,255,0.08); padding-top:10px; display:flex; flex-direction:column; gap:10px;">
                <label style="display:flex; flex-direction:column; gap:6px;">
                    <span>Shape</span>
                    <select class="custom-select" data-threed-role="shape-type">
                        <option value="square">Square</option>
                        <option value="circle">Circle</option>
                    </select>
                </label>
                <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                    <span>Color</span>
                    <input type="color" data-threed-role="shape-color">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px;">
                    <span>Opacity</span>
                    <input type="range" min="0.01" max="1" step="0.01" data-threed-role="shape-opacity">
                </label>
                <label class="check-row">
                    <input type="checkbox" data-threed-role="shape-glow-enabled">
                    <span>Glow</span>
                </label>
                <div data-threed-role="shape-glow-fields" style="display:none; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
                    <label style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                        <span>Glow Color</span>
                        <input type="color" data-threed-role="shape-glow-color">
                    </label>
                    <label style="display:flex; flex-direction:column; gap:6px;">
                        <span>Glow Intensity</span>
                        <input type="range" min="0" max="50" step="0.1" data-threed-role="shape-glow-intensity">
                    </label>
                </div>
            </div>
        `;
        refs.shapeFields = shapeFields;
        refs.shapeType = shapeFields.querySelector('[data-threed-role="shape-type"]');
        refs.shapeColor = shapeFields.querySelector('[data-threed-role="shape-color"]');
        refs.shapeOpacity = shapeFields.querySelector('[data-threed-role="shape-opacity"]');
        refs.shapeGlowEnabled = shapeFields.querySelector('[data-threed-role="shape-glow-enabled"]');
        refs.shapeGlowFields = shapeFields.querySelector('[data-threed-role="shape-glow-fields"]');
        refs.shapeGlowColor = shapeFields.querySelector('[data-threed-role="shape-glow-color"]');
        refs.shapeGlowIntensity = shapeFields.querySelector('[data-threed-role="shape-glow-intensity"]');
        selectionPanel.body.appendChild(shapeFields);

        const sceneCameraFoldout = createFoldout('Camera');
        const sceneNavigationFoldout = createFoldout('Navigation');
        const sceneWorldFoldout = createFoldout('World Light', true);
        [backgroundField, showGridRow, showAxesRow].filter(Boolean).forEach((node) => scenePanel.body.appendChild(node));
        const cameraModeExtras = document.createElement('div');
        cameraModeExtras.className = 'threed-stack';
        cameraModeExtras.innerHTML = `
            <label style="display:flex; flex-direction:column; gap:6px;">
                <span>Projection</span>
                <select class="custom-select" data-threed-role="camera-projection">
                    <option value="perspective">Perspective</option>
                    <option value="orthographic">Orthographic</option>
                </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px;">
                <span>Navigation</span>
                <select class="custom-select" data-threed-role="navigation-mode">
                    <option value="free">Free</option>
                    <option value="canvas">Canvas</option>
                </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px;">
                <span>Locked View</span>
                <select class="custom-select" data-threed-role="locked-view">
                    <option value="front">Front</option>
                    <option value="back">Back</option>
                    <option value="left">Left</option>
                    <option value="right">Right</option>
                    <option value="top">Top</option>
                    <option value="bottom">Bottom</option>
                    <option value="current">Current</option>
                </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px;">
                <span>Wheel Mode</span>
                <select class="custom-select" data-threed-role="wheel-mode">
                    <option value="travel">Travel</option>
                    <option value="zoom">Zoom</option>
                </select>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px;">
                <span>Ortho Zoom</span>
                <input type="number" min="0.05" max="100" step="0.05" class="control-number" data-threed-role="ortho-zoom">
            </label>
        `;
        refs.cameraProjection = cameraModeExtras.querySelector('[data-threed-role="camera-projection"]');
        refs.navigationMode = cameraModeExtras.querySelector('[data-threed-role="navigation-mode"]');
        refs.lockedView = cameraModeExtras.querySelector('[data-threed-role="locked-view"]');
        refs.wheelMode = cameraModeExtras.querySelector('[data-threed-role="wheel-mode"]');
        refs.orthoZoom = cameraModeExtras.querySelector('[data-threed-role="ortho-zoom"]');
        [cameraFovField, cameraModeField, cameraModeExtras].filter(Boolean).forEach((node) => sceneCameraFoldout.body.appendChild(node));
        [linkPlaneScaleRow, snapGrid, flyInfo].filter(Boolean).forEach((node) => sceneNavigationFoldout.body.appendChild(node));
        sceneWorldFoldout.body.innerHTML = `
            <label class="check-row">
                <input type="checkbox" data-threed-role="world-light-enabled">
                <span>Enable World Light</span>
            </label>
            <label style="display:flex; flex-direction:column; gap:6px;">
                <span>Mode</span>
                <select class="custom-select" data-threed-role="world-light-mode">
                    <option value="solid">Solid</option>
                    <option value="gradient">Gradient</option>
                    <option value="hdri">HDRI</option>
                </select>
            </label>
            <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
                <label style="display:flex; flex-direction:column; gap:6px;">
                    <span>Intensity</span>
                    <input type="range" min="0" max="20" step="0.05" data-threed-role="world-light-intensity">
                </label>
                <label style="display:flex; flex-direction:column; gap:6px;">
                    <span>Rotation</span>
                    <input type="number" class="control-number" min="-720" max="720" step="1" data-threed-role="world-light-rotation">
                </label>
            </div>
            <div style="display:grid; grid-template-columns:minmax(0, 1fr); gap:8px;">
                <label class="check-row">
                    <input type="checkbox" data-threed-role="world-light-background-visible">
                    <span>Show Background</span>
                </label>
            </div>
            <label data-threed-role="world-light-color-field" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                <span>Color</span>
                <input type="color" data-threed-role="world-light-color">
            </label>
            <div data-threed-role="world-light-gradient-field" style="display:none; flex-direction:column; gap:8px;">
                <div data-threed-role="world-light-gradient-stops" style="display:flex; flex-direction:column; gap:6px;"></div>
                <button type="button" class="toolbar-button" data-threed-action="add-world-gradient-stop">Add Stop</button>
            </div>
            <div data-threed-role="world-light-hdri-field" style="display:none; flex-direction:column; gap:8px;">
                <select class="custom-select" data-threed-role="world-light-hdri-asset"></select>
                <button type="button" class="toolbar-button" data-threed-action="upload-hdri">Upload HDRI</button>
            </div>
        `;
        refs.worldLightEnabled = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-enabled"]');
        refs.worldLightMode = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-mode"]');
        refs.worldLightIntensity = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-intensity"]');
        refs.worldLightRotation = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-rotation"]');
        refs.worldLightBackgroundVisible = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-background-visible"]');
        refs.worldLightColorField = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-color-field"]');
        refs.worldLightColor = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-color"]');
        refs.worldLightGradientField = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-gradient-field"]');
        refs.worldLightGradientStops = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-gradient-stops"]');
        refs.worldLightHdriField = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-hdri-field"]');
        refs.worldLightHdriAsset = sceneWorldFoldout.body.querySelector('[data-threed-role="world-light-hdri-asset"]');
        if (sceneCameraFoldout.body.childElementCount) {
            scenePanel.body.appendChild(sceneCameraFoldout.element);
        }
        if (sceneNavigationFoldout.body.childElementCount) {
            scenePanel.body.appendChild(sceneNavigationFoldout.element);
        }
        scenePanel.body.appendChild(sceneWorldFoldout.element);

        const renderBasics = document.createElement('div');
        renderBasics.className = 'threed-stack';
        [renderModeField, samplesTargetField, sampleCountRow].filter(Boolean).forEach((node) => renderBasics.appendChild(node));
        const renderActions = document.createElement('div');
        renderActions.className = 'threed-button-row threed-button-row-3';
        renderActions.innerHTML = `
            <button type="button" class="primary-button" data-threed-action="render-scene">Render PNG</button>
            <button type="button" class="toolbar-button" data-threed-action="save-viewport-png">Viewport PNG</button>
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
        viewsHint.innerHTML = 'Use <code>1</code>, <code>2</code>, and <code>3</code> for edit, path trace, and mesh. Press <code>F</code> in orbit mode to frame the selected object.';
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
            selectionPanel,
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
        const contextMenuHost = document.createElement('div');
        contextMenuHost.className = 'threed-context-menu-host';
        contextMenuHost.dataset.threedRole = 'context-menu-host';
        const viewportTopLeft = document.createElement('div');
        viewportTopLeft.className = 'threed-overlay-corner threed-overlay-top-left';
        viewportTopLeft.innerHTML = `
            <div class="threed-mini-bar">
                <button type="button" class="toolbar-button" data-threed-action="set-render-mode" data-render-mode="raster">Edit</button>
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
                <button type="button" class="toolbar-button" data-threed-action="save-viewport-png">Viewport PNG</button>
                <button type="button" class="toolbar-button" data-threed-action="abort-render">Abort</button>
                <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="edit">Panels</button>
                <button type="button" class="toolbar-button" data-threed-action="ui-mode" data-ui-mode="fullscreen">Fullscreen</button>
                <button type="button" class="toolbar-button" data-threed-action="save-library">Save</button>
                <button type="button" class="toolbar-button" data-threed-action="save-scene-json">JSON</button>
            </div>
            <span class="threed-overlay-chip">Mode <strong data-threed-role="compact-render-mode-label">Edit</strong></span>
            <span class="threed-overlay-chip">Spp <strong data-threed-role="header-sample-count">0</strong></span>
        `;
        const viewportBottomLeft = document.createElement('div');
        viewportBottomLeft.className = 'threed-overlay-corner threed-overlay-bottom-left';
        const viewportBottomRight = document.createElement('div');
        viewportBottomRight.className = 'threed-overlay-corner threed-overlay-bottom-right';
        const pathTraceLoading = document.createElement('div');
        pathTraceLoading.className = 'threed-pathtrace-loading';
        pathTraceLoading.dataset.threedRole = 'pathtrace-loading';
        pathTraceLoading.innerHTML = `
            <div class="threed-loading-card">
                <div class="threed-loading-card-head">
                    <div class="threed-spinner" aria-hidden="true"></div>
                    <div class="threed-loading-card-copy">
                        <strong data-threed-role="pathtrace-loading-title">Preparing Renderer</strong>
                        <span data-threed-role="pathtrace-loading-text">Preparing renderer...</span>
                    </div>
                </div>
                <div class="threed-loading-progress" aria-hidden="true">
                    <div class="threed-loading-progress-fill" data-threed-role="pathtrace-loading-progress-fill"></div>
                </div>
                <div class="threed-loading-progress-label" data-threed-role="pathtrace-loading-progress-label">Warming up path tracer</div>
            </div>
        `;
        const assetDrawer = document.createElement('section');
        assetDrawer.className = 'threed-asset-drawer';
        assetDrawer.dataset.threedRole = 'asset-drawer';
        assetDrawer.innerHTML = `
            <button type="button" class="threed-asset-drawer-tab" data-threed-action="toggle-asset-drawer">Assets</button>
            <div class="threed-asset-drawer-panel">
                <div class="threed-asset-drawer-head">
                    <strong>Content Drawer</strong>
                    <input type="search" class="threed-asset-search" data-threed-role="asset-search" placeholder="Search">
                </div>
                <div class="threed-asset-grid" data-threed-role="asset-grid"></div>
                <div class="threed-asset-empty" data-threed-role="asset-empty">Library assets from the Assets page appear here. Drag a card into the viewport to place it.</div>
            </div>
        `;

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
        viewportStage.appendChild(assetDrawer);

        shell.appendChild(viewportPanel);
        shell.appendChild(contextMenuHost);
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
    refs.contextMenuHost = root.querySelector('[data-threed-role="context-menu-host"]');
    refs.compactSampleCount = root.querySelector('[data-threed-role="compact-sample-count"]') || refs.headerSampleCount;
    refs.compactRenderModeLabel = root.querySelector('[data-threed-role="compact-render-mode-label"]');
    refs.pathTraceLoading = root.querySelector('[data-threed-role="pathtrace-loading"]');
    refs.pathTraceLoadingTitle = root.querySelector('[data-threed-role="pathtrace-loading-title"]');
    refs.pathTraceLoadingText = root.querySelector('[data-threed-role="pathtrace-loading-text"]');
    refs.pathTraceLoadingProgressFill = root.querySelector('[data-threed-role="pathtrace-loading-progress-fill"]');
    refs.pathTraceLoadingProgressLabel = root.querySelector('[data-threed-role="pathtrace-loading-progress-label"]');
    refs.assetDrawer = root.querySelector('[data-threed-role="asset-drawer"]');
    refs.assetSearch = root.querySelector('[data-threed-role="asset-search"]');
    refs.assetGrid = root.querySelector('[data-threed-role="asset-grid"]');
    refs.assetEmpty = root.querySelector('[data-threed-role="asset-empty"]');

    function clampRangeMirrorValue(rangeInput, rawValue) {
        const numeric = Number(rawValue);
        if (!Number.isFinite(numeric)) return null;
        const min = rangeInput.min === '' ? -Infinity : Number(rangeInput.min);
        const max = rangeInput.max === '' ? Infinity : Number(rangeInput.max);
        return Math.min(max, Math.max(min, numeric));
    }

    function buildRangeInputMirror(rangeInput) {
        if (!rangeInput || rangeInput._numberMirror || !rangeInput.parentNode) {
            return rangeInput?._numberMirror || null;
        }
        const wrapper = document.createElement('div');
        wrapper.className = 'threed-range-control';
        rangeInput.parentNode.insertBefore(wrapper, rangeInput);
        wrapper.appendChild(rangeInput);

        const numberInput = document.createElement('input');
        numberInput.type = 'number';
        numberInput.className = 'control-number threed-range-number';
        if (rangeInput.min !== '') numberInput.min = rangeInput.min;
        if (rangeInput.max !== '') numberInput.max = rangeInput.max;
        if (rangeInput.step !== '') numberInput.step = rangeInput.step;
        numberInput.value = rangeInput.value;
        wrapper.appendChild(numberInput);

        rangeInput._numberMirror = numberInput;
        numberInput._rangeSource = rangeInput;

        const syncNumberInput = () => {
            if (document.activeElement !== numberInput) {
                numberInput.value = rangeInput.value;
            }
            numberInput.disabled = rangeInput.disabled;
        };

        rangeInput.addEventListener('input', syncNumberInput);
        rangeInput.addEventListener('change', syncNumberInput);
        numberInput.addEventListener('input', () => {
            if (numberInput.value === '') return;
            const normalized = clampRangeMirrorValue(rangeInput, numberInput.value);
            if (!Number.isFinite(normalized)) return;
            rangeInput.value = String(normalized);
            rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
        numberInput.addEventListener('change', () => {
            if (numberInput.value === '') {
                numberInput.value = rangeInput.value;
                return;
            }
            const normalized = clampRangeMirrorValue(rangeInput, numberInput.value);
            if (!Number.isFinite(normalized)) {
                numberInput.value = rangeInput.value;
                return;
            }
            const nextValue = String(normalized);
            rangeInput.value = nextValue;
            numberInput.value = nextValue;
            rangeInput.dispatchEvent(new Event('input', { bubbles: true }));
            rangeInput.dispatchEvent(new Event('change', { bubbles: true }));
        });

        syncNumberInput();
        return numberInput;
    }

    function enhanceRangeInputs() {
        root.querySelectorAll('input[type="range"]').forEach((rangeInput) => buildRangeInputMirror(rangeInput));
    }

    function syncRangeInputMirrors() {
        root.querySelectorAll('input[type="range"]').forEach((rangeInput) => {
            if (!rangeInput._numberMirror) return;
            rangeInput._numberMirror.disabled = rangeInput.disabled;
            if (document.activeElement !== rangeInput._numberMirror) {
                rangeInput._numberMirror.value = rangeInput.value;
            }
        });
    }

    enhanceRangeInputs();
    const progressOverlay = createProgressOverlayController(root.querySelector('.threed-viewport-stage'), {
        zIndex: 5,
        defaultTitle: 'Working',
        defaultMessage: 'Preparing the 3D workspace...',
        backdrop: 'rgba(8, 10, 14, 0.48)',
        panelBackground: 'rgba(0, 0, 0, 0.94)',
        borderColor: 'rgba(184,178,163,0.38)',
        borderSoftColor: 'rgba(184,178,163,0.18)',
        textColor: '#f4f4f4',
        mutedColor: 'rgba(184,178,163,0.86)',
        accentColor: 'rgba(184,178,163,0.96)',
        progressFill: 'linear-gradient(90deg, rgba(184,178,163,0.26), rgba(184,178,163,0.92))'
    });

    let engine = null;
    let active = false;
    let sampleCount = 0;
    let previewTransform = null;
    let statusTone = 'info';
    let statusResetTimer = null;
    let renderSyncToken = 0;
    let lastEngineSyncKey = '';
    let uiMode = 'edit';
    let renderDialogOpen = false;
    let renderPreviewCanvas = null;
    let contextMenuPath = [];
    let contextMenuAnchor = null;
    let lastContextMenuOpenAt = 0;
    let surfaceAttachTextId = null;
    let libraryAssets = [];
    let visibleLibraryAssets = [];
    let assetDrawerOpen = false;
    let assetSearchQuery = '';
    let assetRefreshToken = 0;
    let assetRefreshPending = false;
    let draggedAssetId = '';
    let lastStatusLogSignature = '';
    let lastPathTraceLogSignature = '';
    let lastRenderProgressSignature = '';
    let lastAssetRefreshSignature = '';

    function logThreeD(level, processId, message, progressOrOptions = {}, maybeOptions = {}) {
        if (!logger || !message) return;
        const label = processId === '3d.render'
            ? '3D Render'
            : processId === '3d.assets'
                ? '3D Assets'
                : '3D Workspace';
        if (level === 'progress' && typeof logger.progress === 'function') {
            logger.progress(processId, label, message, progressOrOptions, maybeOptions);
            return;
        }
        const method = typeof logger[level] === 'function'
            ? logger[level].bind(logger)
            : logger.info.bind(logger);
        method(processId, label, message, progressOrOptions);
    }

    function shouldLogStatusMessage(text) {
        const normalized = String(text || '').trim();
        if (!normalized) return false;
        if (
            normalized.startsWith('Edit view is active.')
            || normalized.startsWith('Mesh view is active.')
            || normalized.startsWith('Path tracing is active.')
            || normalized.startsWith('Fly camera active.')
            || normalized.startsWith('Load models or add image planes to start building a 3D scene.')
            || normalized.startsWith('Surface attach is active.')
            || normalized.startsWith('Path Trace is active, but there are no visible objects')
            || normalized.startsWith('Final render running:')
            || normalized.includes('samples at')
        ) {
            return false;
        }
        return true;
    }

    function logStatusMessage(text, tone = 'info') {
        const message = String(text || '').trim();
        if (!shouldLogStatusMessage(message)) return;
        const signature = `${tone}|${message}`;
        if (signature === lastStatusLogSignature) return;
        lastStatusLogSignature = signature;
        logThreeD(
            tone === 'error'
                ? 'error'
                : tone === 'warning'
                    ? 'warning'
                    : tone === 'success'
                        ? 'success'
                        : 'info',
            '3d.workspace',
            message,
            {
                dedupeKey: signature,
                dedupeWindowMs: 120
            }
        );
    }

    const transformInputs = {
        position: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="position-${index}"]`)),
        rotation: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="rotation-${index}"]`)),
        scale: [0, 1, 2].map((index) => root.querySelector(`[data-threed-role="scale-${index}"]`))
    };

    function getVisibleLibraryAssets() {
        const query = String(assetSearchQuery || '').trim().toLowerCase();
        return [...libraryAssets]
            .filter((asset) => !query || String(asset.name || '').toLowerCase().includes(query))
            .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { sensitivity: 'base' }));
    }

    function setAssetDrawerOpen(enabled) {
        assetDrawerOpen = Boolean(enabled);
        refs.assetDrawer?.classList.toggle('is-open', assetDrawerOpen);
    }

    function renderAssetDrawer() {
        visibleLibraryAssets = getVisibleLibraryAssets();
        if (refs.assetGrid) {
            refs.assetGrid.innerHTML = visibleLibraryAssets.map((asset) => `
                <button
                    type="button"
                    class="threed-asset-card"
                    draggable="true"
                    data-library-asset-id="${escapeHtml(asset.id)}"
                    title="${escapeHtml(asset.name || 'Library asset')}"
                >
                    <div class="threed-asset-thumb">${escapeHtml(formatLibraryAssetType(asset))}</div>
                    <strong>${escapeHtml(asset.name || 'Library Asset')}</strong>
                    <span>${escapeHtml(formatLibraryAssetSize(asset))}</span>
                </button>
            `).join('');
        }
        if (refs.assetEmpty) {
            refs.assetEmpty.classList.toggle('is-visible', !visibleLibraryAssets.length);
            refs.assetEmpty.textContent = visibleLibraryAssets.length
                ? ''
                : (libraryAssets.length
                    ? 'No Library assets match this search.'
                    : 'Library assets from the Assets page appear here. Drag a card into the viewport to place it.');
        }
    }

    async function refreshLibraryAssets() {
        if (!active) {
            assetRefreshPending = true;
            return;
        }
        logThreeD('active', '3d.assets', 'Refreshing the 3D content drawer from the Assets Library.', {
            dedupeKey: '3d-content-drawer-refresh-start',
            dedupeWindowMs: 250
        });
        const token = ++assetRefreshToken;
        const nextAssets = await actions.getLibraryAssets?.() || [];
        if (token !== assetRefreshToken) return;
        if (!active) {
            assetRefreshPending = true;
            return;
        }
        libraryAssets = Array.isArray(nextAssets) ? nextAssets : [];
        assetRefreshPending = false;
        const refreshSignature = `${libraryAssets.length}:${libraryAssets.map((asset) => asset.id).slice(0, 12).join('|')}`;
        if (refreshSignature !== lastAssetRefreshSignature) {
            lastAssetRefreshSignature = refreshSignature;
            logThreeD('info', '3d.assets', `Content drawer ready with ${libraryAssets.length} synced asset${libraryAssets.length === 1 ? '' : 's'}.`, {
                dedupeKey: refreshSignature,
                dedupeWindowMs: 120
            });
        }
        renderAssetDrawer();
    }

    function applyStatus(text, tone = 'info') {
        statusTone = tone;
        refs.status.textContent = text || '';
        refs.status.dataset.tone = tone;
        refs.status.style.background = 'rgba(0,0,0,0.92)';
        refs.status.style.color = '#ffffff';
        refs.status.style.borderColor = tone === 'info'
            ? 'rgba(184,178,163,0.28)'
            : 'rgba(184,178,163,0.72)';
        logStatusMessage(text, tone);
    }

    function applyBaseStatus(state = store.getState()) {
        const document = state?.threeDDocument;
        if (!document) return;
        const hasTracePreviewContent = document.scene.items.some((item) => item.visible !== false && item.kind !== 'light');
        if (document.renderJob?.active) {
            const renderMessage = document.renderJob.message
                ? `${document.renderJob.message} ${document.renderJob.currentSamples || 0} / ${document.renderJob.requestedSamples || 0} samples at ${formatRenderSize(document.renderJob)}.`
                : `Final render running: ${document.renderJob.currentSamples || 0} / ${document.renderJob.requestedSamples || 0} samples at ${formatRenderSize(document.renderJob)}.`;
            applyStatus(renderMessage, 'info');
            return;
        }
        if (document.view.navigationMode !== 'canvas' && document.view.cameraMode === 'fly') {
            applyStatus('Fly camera active. Click the viewport, then use right-drag to look and W A S D Q E to move.', 'info');
            return;
        }
        if (surfaceAttachTextId) {
            applyStatus('Surface attach is active. Click a model or primitive surface, or press Escape to cancel.', 'info');
            return;
        }
        if (!document.scene.items.length) {
            applyStatus('Load models or add image planes to start building a 3D scene.', 'info');
            return;
        }
        if (document.render.mode === 'pathtrace' && !hasTracePreviewContent) {
            applyStatus('Path Trace is active, but there are no visible objects to trace yet. Add a model, primitive, text, shape, or image plane to preview lighting.', 'info');
            return;
        }
        if (document.render.mode === 'pathtrace') {
            applyStatus(
                document.render.denoiseEnabled
                    ? 'Path tracing is active. Denoising is enabled, so noise should settle faster but very fine detail can soften a bit.'
                    : 'Path tracing is active. Editor helpers are excluded from the traced scene.',
                'info'
            );
            return;
        }
        if (document.render.mode === 'mesh') {
            applyStatus('Mesh view is active. Scene geometry is shown as wireframe while the editor controls stay available.', 'info');
            return;
        }
        applyStatus('Edit view is active. Objects are shown unlit for faster editing and clearer visibility; switch to Path Trace to preview lighting.', 'info');
    }

    function clearStatusResetTimer() {
        if (!statusResetTimer) return;
        clearTimeout(statusResetTimer);
        statusResetTimer = null;
    }

    function setStatus(text, tone = 'info', timeout = 0) {
        clearStatusResetTimer();
        applyStatus(text, tone);
        if (timeout > 0) {
            statusResetTimer = setTimeout(() => {
                statusResetTimer = null;
                applyBaseStatus(store.getState());
            }, timeout);
        }
    }

    function setInputValue(input, value) {
        if (!input) return;
        const nextValue = String(value);
        if (document.activeElement !== input) {
            input.value = nextValue;
        }
        if (input._numberMirror && document.activeElement !== input._numberMirror) {
            input._numberMirror.value = nextValue;
        }
    }

    function waitForUiPaint() {
        return nextPaint();
    }

    function renderRenderJobUi(job = {}) {
        refs.renderJobStatus.textContent = job?.status ? String(job.status).toUpperCase() : 'IDLE';
        refs.renderJobSamples.textContent = `${job?.currentSamples || 0} / ${job?.requestedSamples || 0}`;
        refs.renderJobSize.textContent = formatRenderSize(job);
        root.querySelectorAll('[data-threed-action="abort-render"]').forEach((node) => {
            node.disabled = !job?.active;
        });
    }

    function setPathTraceLoading(active, message = 'Preparing renderer...', progress = null) {
        const enabled = !!active;
        refs.pathTraceLoading?.classList.toggle('is-active', enabled);
        if (refs.pathTraceLoadingTitle) {
            refs.pathTraceLoadingTitle.textContent = 'Preparing Renderer';
        }
        if (refs.pathTraceLoadingText) {
            refs.pathTraceLoadingText.textContent = message || 'Preparing renderer...';
        }
        if (refs.pathTraceLoadingProgressFill) {
            const ratio = enabled ? (progress == null ? getPathTraceLoadingProgress(message) : Math.max(0, Math.min(1, Number(progress) || 0))) : 1;
            refs.pathTraceLoadingProgressFill.style.width = `${Math.round(ratio * 100)}%`;
        }
        if (refs.pathTraceLoadingProgressLabel) {
            refs.pathTraceLoadingProgressLabel.textContent = enabled
                ? (message || 'Preparing renderer...')
                : 'Ready';
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
        const document = store.getState().threeDDocument;
        const hasTracePreviewContent = (document?.scene?.items || []).some((item) => item.visible !== false && item.kind !== 'light');
        if (nextMode === 'pathtrace' && hasTracePreviewContent) {
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
            <div class="threed-outliner-item ${state.threeDDocument.selection.itemId === item.id ? 'is-active' : ''}" data-threed-item-id="${item.id}">
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

    function renderTextFontOptions(state, selected) {
        if (!refs.textFontAsset) return;
        const fonts = state.threeDDocument?.assets?.fonts || [];
        if (!fonts.length) {
            refs.textFontAsset.innerHTML = '<option value="">Upload a font first</option>';
            refs.textFontAsset.value = '';
            return;
        }
        refs.textFontAsset.innerHTML = fonts.map((asset) => `
            <option value="${asset.id}">${escapeHtml(asset.name)}</option>
        `).join('');
        refs.textFontAsset.value = selected?.text?.fontSource?.assetId && fonts.some((asset) => asset.id === selected.text.fontSource.assetId)
            ? selected.text.fontSource.assetId
            : fonts[0].id;
    }

    function renderWorldLightOptions(documentState) {
        if (!refs.worldLightHdriAsset) return;
        const hdris = documentState?.assets?.hdris || [];
        refs.worldLightHdriAsset.innerHTML = hdris.length
            ? hdris.map((asset) => `<option value="${asset.id}">${escapeHtml(asset.name)}</option>`).join('')
            : '<option value="">Upload an HDRI first</option>';
        const activeId = documentState?.scene?.worldLight?.hdriAssetId || '';
        refs.worldLightHdriAsset.value = hdris.some((asset) => asset.id === activeId) ? activeId : (hdris[0]?.id || '');
        const stops = documentState?.scene?.worldLight?.gradientStops || [];
        refs.worldLightGradientStops.innerHTML = stops.map((stop, index) => `
            <div style="display:grid; grid-template-columns:minmax(0, 1fr) auto auto; gap:8px; align-items:center;">
                <input type="number" min="0" max="1" step="0.01" class="control-number" data-threed-role="gradient-stop-position" data-stop-index="${index}" value="${formatNumber(stop.position, 2)}">
                <input type="color" data-threed-role="gradient-stop-color" data-stop-index="${index}" value="${stop.color}">
                <button type="button" class="toolbar-button" data-threed-action="remove-world-gradient-stop" data-stop-index="${index}">Del</button>
            </div>
        `).join('');
    }

    function renderTextCharacterOverrides(selected) {
        if (!refs.textCharacterOverrides) return;
        const characters = Array.from(selected?.text?.content || '');
        if (!characters.length) {
            refs.textCharacterOverrides.innerHTML = '<div class="empty-inline">No characters to edit.</div>';
            return;
        }
        const overrideMap = new Map((selected?.text?.characterOverrides || []).map((entry) => [Number(entry.index), entry]));
        refs.textCharacterOverrides.innerHTML = characters.map((character, index) => {
            const override = overrideMap.get(index) || { flipX: false, flipY: false };
            const label = character === '\n' ? '\\n' : character === ' ' ? 'space' : character;
            return `
                <label style="display:grid; grid-template-columns:minmax(0, 1fr) auto auto; gap:8px; align-items:center;">
                    <span>${escapeHtml(label)}</span>
                    <span style="display:flex; align-items:center; gap:4px;"><input type="checkbox" data-threed-role="text-char-flip-x" data-char-index="${index}" ${override.flipX ? 'checked' : ''}> H</span>
                    <span style="display:flex; align-items:center; gap:4px;"><input type="checkbox" data-threed-role="text-char-flip-y" data-char-index="${index}" ${override.flipY ? 'checked' : ''}> V</span>
                </label>
            `;
        }).join('');
    }

    function getUploadedFontAssets() {
        return store.getState().threeDDocument?.assets?.fonts || [];
    }

    function clearSurfaceAttachMode(showMessage = false) {
        if (!surfaceAttachTextId) return;
        surfaceAttachTextId = null;
        if (showMessage) {
            setStatus('Surface attach cancelled.', 'info');
        }
    }

    function setSelectedTextMode(mode, itemId = null) {
        const state = store.getState();
        const selected = (state.threeDDocument?.scene?.items || []).find((item) => item.id === (itemId || state.threeDDocument?.selection?.itemId)) || null;
        if (!isTextItem(selected)) return;
        if (mode === 'extruded') {
            const hasUploadedFont = selected.text?.fontSource?.type === 'upload' && !!selected.text?.fontSource?.assetId;
            if (!hasUploadedFont) {
                setInputValue(refs.textMode, selected.text?.mode || 'flat');
                setStatus('Extruded text requires an uploaded font. Pick one in the Selection panel first.', 'warning');
                return;
            }
        }
        actions.updateThreeDText?.(selected.id, { mode: mode === 'extruded' ? 'extruded' : 'flat' });
    }

    function updateWorldLightGradientStop(stopIndex, patch = {}) {
        if (!Number.isFinite(stopIndex)) return;
        const stops = [...(store.getState().threeDDocument?.scene?.worldLight?.gradientStops || [])];
        if (!stops[stopIndex]) return;
        stops[stopIndex] = {
            ...stops[stopIndex],
            ...patch
        };
        actions.updateThreeDWorldLight?.({ gradientStops: stops });
    }

    function updateTextCharacterOverride(characterIndex, patch = {}) {
        const selected = getSelectedItem(store.getState());
        if (!isTextItem(selected) || !Number.isFinite(characterIndex)) return;
        const overrides = [...(selected.text?.characterOverrides || [])];
        const overrideIndex = overrides.findIndex((entry) => Number(entry.index) === characterIndex);
        const current = overrideIndex >= 0
            ? { ...overrides[overrideIndex] }
            : { index: characterIndex, flipX: false, flipY: false };
        const next = {
            ...current,
            ...patch,
            index: characterIndex
        };
        const keepOverride = !!next.flipX || !!next.flipY;
        if (keepOverride && overrideIndex >= 0) {
            overrides.splice(overrideIndex, 1, next);
        } else if (keepOverride) {
            overrides.push(next);
        } else if (overrideIndex >= 0) {
            overrides.splice(overrideIndex, 1);
        }
        actions.updateThreeDText?.(selected.id, {
            characterOverrides: overrides
                .map((entry) => ({ index: Number(entry.index), flipX: !!entry.flipX, flipY: !!entry.flipY }))
                .sort((a, b) => a.index - b.index)
        });
    }

    function openContextMenuForItem(itemId, options = {}) {
        if (!itemId || !refs.contextMenuHost || !refs.canvasContainer) {
            closeContextMenu();
            return false;
        }
        const rect = refs.shell?.getBoundingClientRect() || refs.contextMenuHost.getBoundingClientRect();
        const hostRect = refs.contextMenuHost.getBoundingClientRect();
        const anchorElement = options.anchorEl || refs.selectionName || refs.canvasContainer;
        const anchorRect = anchorElement?.getBoundingClientRect?.() || rect;
        const requestedX = Number.isFinite(Number(options.clientX))
            ? Number(options.clientX)
            : (anchorRect.left + Math.min(anchorRect.width, 180));
        const requestedY = Number.isFinite(Number(options.clientY))
            ? Number(options.clientY)
            : (anchorRect.bottom + 10);
        const maxX = Math.max(8, hostRect.width - 196);
        const maxY = Math.max(8, hostRect.height - 160);
        contextMenuAnchor = {
            x: clamp(requestedX - rect.left, 8, maxX),
            y: clamp(requestedY - rect.top, 8, maxY),
            itemId
        };
        lastContextMenuOpenAt = Date.now();
        contextMenuPath = [];
        renderContextMenus(store.getState());
        return true;
    }

    function openContextMenuAt(event, itemId) {
        return openContextMenuForItem(itemId, {
            clientX: event?.clientX,
            clientY: event?.clientY,
            anchorEl: event?.currentTarget || event?.target || refs.selectionName
        });
    }

    function closeContextMenu() {
        contextMenuPath = [];
        contextMenuAnchor = null;
        if (refs.contextMenuHost) {
            refs.contextMenuHost.innerHTML = '';
        }
    }

    function getContextMenuEntries(state, item) {
        if (!item) return [];
        const entries = [
            { id: 'duplicate', label: 'Duplicate' },
            { id: 'rename', label: 'Rename' },
            { id: item.visible !== false ? 'hide' : 'show', label: item.visible !== false ? 'Hide' : 'Show' },
            { id: item.locked ? 'unlock' : 'lock', label: item.locked ? 'Unlock' : 'Lock' },
            { id: 'reset-transform', label: 'Reset Transform' },
            { id: 'delete', label: 'Delete' }
        ];
        if (isMaterialItem(item)) {
            entries.push({
                id: 'material-preset',
                label: 'Material',
                submenu: [
                    { id: 'mat-original', label: 'Original' },
                    { id: 'mat-matte', label: 'Matte' },
                    { id: 'mat-metal', label: 'Metal' },
                    { id: 'mat-glass', label: 'Glass' },
                    { id: 'mat-emissive', label: 'Emissive' }
                ]
            });
        }
        if (isTextItem(item)) {
            entries.push({
                id: 'text-actions',
                label: 'Text',
                submenu: [
                    { id: 'text-flat', label: 'Flat Mode' },
                    { id: 'text-extruded', label: 'Extruded Mode' },
                    { id: item.text?.attachment ? 'text-detach' : 'text-attach', label: item.text?.attachment ? 'Detach Surface' : 'Attach To Surface' }
                ]
            });
        }
        if (isShapeItem(item)) {
            entries.push({
                id: 'shape-actions',
                label: 'Shape',
                submenu: [
                    { id: 'shape-square', label: 'Square' },
                    { id: 'shape-circle', label: 'Circle' }
                ]
            });
        }
        return entries;
    }

    function renderContextMenus(state) {
        if (!refs.contextMenuHost || !contextMenuAnchor?.itemId) {
            closeContextMenu();
            return;
        }
        const item = state.threeDDocument?.scene?.items?.find((entry) => entry.id === contextMenuAnchor.itemId) || null;
        if (!item) {
            closeContextMenu();
            return;
        }
        const rootEntries = getContextMenuEntries(state, item);
        const submenuEntries = rootEntries.find((entry) => entry.id === contextMenuPath[0])?.submenu || null;
        refs.contextMenuHost.innerHTML = `
            <div class="threed-context-menu" style="left:${contextMenuAnchor.x}px; top:${contextMenuAnchor.y}px;">
                ${rootEntries.map((entry) => `<button type="button" data-threed-action="context-menu-entry" data-menu-entry="${entry.id}"><span>${escapeHtml(entry.label)}</span>${entry.submenu ? '<span>&gt;</span>' : ''}</button>`).join('')}
            </div>
            ${submenuEntries ? `<div class="threed-context-menu" style="left:${contextMenuAnchor.x + 188}px; top:${contextMenuAnchor.y}px;">${submenuEntries.map((entry) => `<button type="button" data-threed-action="context-menu-entry" data-menu-entry="${entry.id}"><span>${escapeHtml(entry.label)}</span></button>`).join('')}</div>` : ''}
        `;
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
        const exportEngine = 'pathtrace';

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
            exportEngine,
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
        setStatus(`Path Trace rendering ${requestedSamples} samples at ${outputWidth} x ${outputHeight}. The final render now takes over the viewport until export completes.`, 'info');
        logThreeD('active', '3d.render', `Starting final 3D render at ${outputWidth} x ${outputHeight} for ${requestedSamples} samples.`);
        await waitForUiPaint();

        engine.startBackgroundRender({
            documentState: renderDocument,
            samples: requestedSamples,
            width: outputWidth,
            height: outputHeight,
            fileName: suggestedName,
            saveHandler: (blob, nextFileName) => actions.persistThreeDRenderSave?.(blob, nextFileName, {
                documentState: renderDocument,
                width: outputWidth,
                height: outputHeight
            })
        }).catch((error) => {
            console.error(error);
            setPathTraceLoading(false);
            if (store.getState().threeDDocument?.renderJob?.status !== 'error') {
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
                setStatus(error?.message || 'The render failed.', 'error', 7000);
            }
        });
    }

    root.addEventListener('click', async (event) => {
        const actionNode = event.target.closest('[data-threed-action]');
        if (!actionNode) return;
        const action = actionNode.dataset.threedAction;
        if (action !== 'context-menu-entry') {
            closeContextMenu();
        }
        if (action === 'ui-mode') {
            uiMode = actionNode.dataset.uiMode === 'fullscreen' ? 'fullscreen' : 'edit';
            applyUiMode();
        } else if (action === 'toggle-asset-drawer') {
            setAssetDrawerOpen(!assetDrawerOpen);
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
            setStatus('Preparing the current 3D scene for Library save...', 'info', 2400);
            actions.saveProjectToLibrary(null, { projectType: '3d' }).catch((error) => {
                console.error(error);
                setStatus(error?.message || 'Could not save this 3D scene to the Library.', 'error', 7000);
            });
        } else if (action === 'save-scene-json') {
            setStatus('Preparing the current 3D scene JSON for local save...', 'info', 2400);
            actions.exportThreeDSceneJson?.().catch((error) => {
                console.error(error);
                setStatus(error?.message || 'Could not save the 3D scene JSON.', 'error', 7000);
            });
        } else if (action === 'save-viewport-png') {
            setStatus('Capturing the current 3D viewport to PNG...', 'info', 2400);
            actions.exportThreeDViewportPng?.().catch((error) => {
                console.error(error);
                setStatus(error?.message || 'Could not save the current 3D viewport PNG.', 'error', 7000);
            });
        } else if (action === 'selection-menu') {
            const selected = getSelectedItem(store.getState());
            if (!selected) {
                setStatus('Select an item first to open its context menu.', 'warning', 4200);
                return;
            }
            openContextMenuForItem(selected.id, {
                anchorEl: actionNode
            });
        } else if (action === 'new-scene') {
            actions.newThreeDProject?.();
        } else if (action === 'add-light') {
            actions.addThreeDLight(actionNode.dataset.lightType || 'directional');
        } else if (action === 'add-primitive') {
            actions.addThreeDPrimitive?.(actionNode.dataset.primitiveType || 'cube');
        } else if (action === 'add-text') {
            actions.addThreeDText?.();
        } else if (action === 'add-shape') {
            actions.addThreeDShape?.(actionNode.dataset.shapeType || 'square');
        } else if (action === 'upload-fonts') {
            refs.fontInput.click();
        } else if (action === 'upload-hdri') {
            refs.hdriInput.click();
        } else if (action === 'add-world-gradient-stop') {
            const stops = [...(store.getState().threeDDocument?.scene?.worldLight?.gradientStops || [])];
            stops.push({ position: 0.5, color: '#ffffff' });
            actions.updateThreeDWorldLight?.({ gradientStops: stops });
        } else if (action === 'remove-world-gradient-stop') {
            const stopIndex = Number(actionNode.dataset.stopIndex);
            const stops = [...(store.getState().threeDDocument?.scene?.worldLight?.gradientStops || [])];
            if (Number.isFinite(stopIndex)) {
                stops.splice(stopIndex, 1);
                actions.updateThreeDWorldLight?.({ gradientStops: stops.length ? stops : [{ position: 0, color: '#ffffff' }, { position: 1, color: '#222222' }] });
            }
        } else if (action === 'select-item') {
            previewTransform = null;
            clearSurfaceAttachMode();
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
        } else if (action === 'reset-camera') {
            actions.resetThreeDCamera?.();
        } else if (action === 'save-camera-preset') {
            const snapshot = engine?.getCameraSnapshot?.() || store.getState().threeDDocument?.view;
            const name = await actions.requestTextDialog?.({
                title: 'Save Camera Preset',
                text: 'Choose a name for this camera preset.',
                fieldLabel: 'Preset name',
                defaultValue: `Camera ${(store.getState().threeDDocument?.view?.presets?.length || 0) + 1}`,
                confirmLabel: 'Save Preset',
                cancelLabel: 'Cancel'
            });
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
        } else if (action === 'context-menu-entry') {
            const entry = actionNode.dataset.menuEntry || '';
            const state = store.getState();
            const item = state.threeDDocument?.scene?.items?.find((entryItem) => entryItem.id === contextMenuAnchor?.itemId) || null;
            if (!item) {
                closeContextMenu();
                return;
            }
            if (entry === 'material-preset' || entry === 'text-actions' || entry === 'shape-actions') {
                contextMenuPath = contextMenuPath[0] === entry ? [] : [entry];
                renderContextMenus(state);
                return;
            }
            closeContextMenu();
            if (entry === 'duplicate') actions.duplicateThreeDItem?.(item.id);
            else if (entry === 'rename') {
                const name = await actions.requestTextDialog?.({
                    title: 'Rename 3D Item',
                    text: 'Enter a new name for the selected 3D item.',
                    fieldLabel: 'Item name',
                    defaultValue: item.name || 'Item',
                    confirmLabel: 'Rename',
                    cancelLabel: 'Cancel'
                });
                if (name != null) actions.renameThreeDItem?.(item.id, name);
            } else if (entry === 'hide' || entry === 'show') actions.toggleThreeDItemVisibility?.(item.id);
            else if (entry === 'lock' || entry === 'unlock') actions.toggleThreeDItemLock?.(item.id);
            else if (entry === 'reset-transform') actions.resetThreeDItemTransform?.(item.id);
            else if (entry === 'delete') actions.deleteThreeDItem?.(item.id);
            else if (entry === 'mat-original') actions.updateThreeDMaterial?.(item.id, { preset: 'original' });
            else if (entry === 'mat-matte') actions.updateThreeDMaterial?.(item.id, { preset: 'matte' });
            else if (entry === 'mat-metal') actions.updateThreeDMaterial?.(item.id, { preset: 'metal' });
            else if (entry === 'mat-glass') actions.updateThreeDMaterial?.(item.id, { preset: 'glass' });
            else if (entry === 'mat-emissive') actions.updateThreeDMaterial?.(item.id, { preset: 'emissive' });
            else if (entry === 'text-flat') setSelectedTextMode('flat', item.id);
            else if (entry === 'text-extruded') setSelectedTextMode('extruded', item.id);
            else if (entry === 'text-attach') {
                surfaceAttachTextId = item.id;
                setStatus(`Click a model or primitive surface to attach "${item.name}".`, 'info');
            } else if (entry === 'text-detach') actions.detachThreeDTextSurface?.(item.id);
            else if (entry === 'shape-square') actions.updateThreeDShape?.(item.id, { type: 'square' });
            else if (entry === 'shape-circle') actions.updateThreeDShape?.(item.id, { type: 'circle' });
        }
    });

    root.addEventListener('input', (event) => {
        const role = event.target?.dataset?.threedRole || '';
        if (role === 'asset-search') {
            assetSearchQuery = event.target.value || '';
            renderAssetDrawer();
        } else if (role === 'gradient-stop-color') {
            updateWorldLightGradientStop(
                Number(event.target.dataset.stopIndex),
                { color: event.target.value || '#ffffff' }
            );
        }
    });

    root.addEventListener('change', (event) => {
        const role = event.target?.dataset?.threedRole || '';
        if (role === 'gradient-stop-position') {
            updateWorldLightGradientStop(
                Number(event.target.dataset.stopIndex),
                { position: clamp(Number(event.target.value) || 0, 0, 1) }
            );
        } else if (role === 'text-char-flip-x' || role === 'text-char-flip-y') {
            const index = Number(event.target.dataset.charIndex);
            const row = event.target.closest('label');
            const flipX = !!row?.querySelector('[data-threed-role="text-char-flip-x"]')?.checked;
            const flipY = !!row?.querySelector('[data-threed-role="text-char-flip-y"]')?.checked;
            updateTextCharacterOverride(index, { flipX, flipY });
        }
    });

    function handleCanvasContextRequest(event) {
        if (!active) return;
        if ((Date.now() - lastContextMenuOpenAt) < 120 && event.type !== 'contextmenu') return;
        event.preventDefault();
        event.stopPropagation();
        const documentState = store.getState().threeDDocument;
        if (documentState?.view?.cameraMode === 'fly') {
            closeContextMenu();
            return;
        }
        if (surfaceAttachTextId || documentState?.renderJob?.active) {
            closeContextMenu();
            return;
        }
        const liveEngine = hydrateEngine();
        const itemId = liveEngine.pickItemAtClientPoint(event.clientX, event.clientY, { includeHelpers: true });
        const selectedId = documentState?.selection?.itemId || null;
        if (!itemId || itemId !== selectedId) {
            closeContextMenu();
            return;
        }
        openContextMenuAt(event, itemId);
    }

    function handleHierarchyContextRequest(event) {
        const itemNode = event.target.closest('[data-threed-item-id]');
        if (!itemNode) return;
        event.preventDefault();
        event.stopPropagation();
        if ((Date.now() - lastContextMenuOpenAt) < 120 && event.type !== 'contextmenu') return;
        const itemId = itemNode.dataset.threedItemId || '';
        if (!itemId) {
            closeContextMenu();
            return;
        }
        previewTransform = null;
        if (store.getState().threeDDocument?.selection?.itemId !== itemId) {
            actions.setThreeDSelection(itemId);
        }
        openContextMenuAt(event, itemId);
    }

    refs.canvasContainer.addEventListener('contextmenu', handleCanvasContextRequest);
    refs.canvasContainer.addEventListener('pointerup', (event) => {
        if (event.button !== 2) return;
        handleCanvasContextRequest(event);
    });

    refs.hierarchy.addEventListener('contextmenu', handleHierarchyContextRequest);
    refs.hierarchy.addEventListener('pointerup', (event) => {
        if (event.button !== 2) return;
        handleHierarchyContextRequest(event);
    });

    refs.canvasContainer.addEventListener('pointerdown', (event) => {
        if (!surfaceAttachTextId || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        closeContextMenu();
        const liveEngine = hydrateEngine();
        const hit = liveEngine.pickSurfaceAtClientPoint(event.clientX, event.clientY);
        if (!hit) {
            setStatus('Click a model or primitive surface to attach the selected text.', 'warning');
            return;
        }
        const textItem = store.getState().threeDDocument?.scene?.items?.find((item) => item.id === surfaceAttachTextId) || null;
        actions.attachThreeDTextToSurface?.(surfaceAttachTextId, hit);
        surfaceAttachTextId = null;
        setStatus(`Attached "${textItem?.name || 'Text'}" to the selected surface.`, 'success');
    }, true);

    refs.assetGrid?.addEventListener('dragstart', (event) => {
        const assetCard = event.target.closest('[data-library-asset-id]');
        if (!assetCard) return;
        draggedAssetId = assetCard.dataset.libraryAssetId || '';
        if (!draggedAssetId) return;
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData(LIBRARY_ASSET_DRAG_TYPE, draggedAssetId);
            event.dataTransfer.setData('text/plain', draggedAssetId);
        }
        const assetName = libraryAssets.find((asset) => asset.id === draggedAssetId)?.name || 'Library asset';
        logThreeD('info', '3d.assets', `Dragging "${assetName}" from the content drawer into the 3D scene.`, {
            dedupeKey: `drag-asset:${draggedAssetId}`,
            dedupeWindowMs: 120
        });
    });

    refs.assetGrid?.addEventListener('dragend', () => {
        draggedAssetId = '';
    });

    refs.canvasContainer.addEventListener('dragover', (event) => {
        const dragTypes = Array.from(event.dataTransfer?.types || []);
        if (!draggedAssetId && !dragTypes.includes(LIBRARY_ASSET_DRAG_TYPE)) return;
        event.preventDefault();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'copy';
        }
    });

    refs.canvasContainer.addEventListener('drop', async (event) => {
        const assetId = (
            event.dataTransfer?.getData(LIBRARY_ASSET_DRAG_TYPE)
            || event.dataTransfer?.getData('text/plain')
            || draggedAssetId
            || ''
        ).trim();
        draggedAssetId = '';
        if (!assetId) return;
        event.preventDefault();
        try {
            const didPlace = await actions.addLibraryAssetToThreeDScene?.(assetId);
            if (didPlace) {
                setAssetDrawerOpen(false);
                setStatus('Placed Library asset into the 3D scene.', 'success');
            }
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not place that Library asset.', 'error');
        }
    });

    window.addEventListener('pointerdown', (event) => {
        if (!contextMenuAnchor) return;
        if (refs.contextMenuHost?.contains(event.target)) return;
        closeContextMenu();
    }, true);

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

    refs.fontInput.addEventListener('change', async (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = '';
        if (!files.length) return;
        try {
            await actions.importThreeDFontFiles?.(files);
            setStatus(`Imported ${files.length} font file${files.length === 1 ? '' : 's'}.`, 'success');
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not import those fonts.', 'error');
        }
    });

    refs.hdriInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0] || null;
        event.target.value = '';
        if (!file) return;
        try {
            await actions.importThreeDHdriFile?.(file);
            setStatus(`Loaded HDRI "${file.name}" into the world light.`, 'success');
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not import that HDRI.', 'error');
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
    refs.cameraProjection?.addEventListener('change', (event) => {
        actions.configureThreeDCanvasView?.({ projection: event.target.value === 'orthographic' ? 'orthographic' : 'perspective' }, engine?.getCameraSnapshot?.());
    });
    refs.navigationMode?.addEventListener('change', (event) => {
        actions.configureThreeDCanvasView?.({ navigationMode: event.target.value === 'canvas' ? 'canvas' : 'free' }, engine?.getCameraSnapshot?.());
    });
    refs.lockedView?.addEventListener('change', (event) => {
        actions.configureThreeDCanvasView?.({ lockedView: event.target.value || 'front', navigationMode: 'canvas' }, engine?.getCameraSnapshot?.());
    });
    refs.wheelMode?.addEventListener('change', (event) => {
        actions.configureThreeDCanvasView?.({ wheelMode: event.target.value === 'zoom' ? 'zoom' : 'travel' }, engine?.getCameraSnapshot?.());
    });
    refs.orthoZoom?.addEventListener('change', (event) => {
        actions.configureThreeDCanvasView?.({ orthoZoom: Math.max(0.05, Number(event.target.value) || 1) }, engine?.getCameraSnapshot?.());
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
    refs.textContent?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { content: event.target.value });
    });
    refs.textMode?.addEventListener('change', (event) => {
        setSelectedTextMode(event.target.value === 'extruded' ? 'extruded' : 'flat');
    });
    refs.textFontSourceType?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (!isTextItem(selected)) return;
        const nextType = event.target.value === 'upload' ? 'upload' : 'system';
        if (nextType === 'upload' && !getUploadedFontAssets().length) {
            setStatus('Upload a font first, then switch this text item to an uploaded font.', 'warning');
            setInputValue(refs.textFontSourceType, selected.text?.fontSource?.type || 'system');
            return;
        }
        actions.updateThreeDText?.(selected.id, {
            fontSource: nextType === 'upload'
                ? { type: 'upload', assetId: refs.textFontAsset?.value || null, family: '' }
                : { type: 'system', assetId: null, family: refs.textFontFamily?.value || 'Arial' }
        });
    });
    refs.textFontFamily?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { fontSource: { type: 'system', family: event.target.value || 'Arial', assetId: null } });
    });
    refs.textFontAsset?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { fontSource: { type: 'upload', assetId: event.target.value || null, family: '' } });
    });
    refs.textColor?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { color: event.target.value });
    });
    refs.textOpacity?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { opacity: Number(event.target.value) || 1 });
    });
    refs.textGlowEnabled?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { glow: { enabled: !!event.target.checked } });
    });
    refs.textGlowColor?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { glow: { color: event.target.value } });
    });
    refs.textGlowIntensity?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isTextItem(selected)) actions.updateThreeDText?.(selected.id, { glow: { intensity: Number(event.target.value) || 0 } });
    });
    [refs.textDepth, refs.textBevelSize, refs.textBevelThickness, refs.textBevelSegments].forEach((input) => {
        input?.addEventListener('change', () => {
            const selected = getSelectedItem(store.getState());
            if (isTextItem(selected)) {
                actions.updateThreeDText?.(selected.id, {
                    extrude: {
                        depth: Number(refs.textDepth?.value) || 0.2,
                        bevelSize: Number(refs.textBevelSize?.value) || 0,
                        bevelThickness: Number(refs.textBevelThickness?.value) || 0,
                        bevelSegments: Number(refs.textBevelSegments?.value) || 1
                    }
                });
            }
        });
    });
    refs.shapeType?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isShapeItem(selected)) actions.updateThreeDShape?.(selected.id, { type: event.target.value === 'circle' ? 'circle' : 'square' });
    });
    refs.shapeColor?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isShapeItem(selected)) actions.updateThreeDShape?.(selected.id, { color: event.target.value });
    });
    refs.shapeOpacity?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isShapeItem(selected)) actions.updateThreeDShape?.(selected.id, { opacity: Number(event.target.value) || 1 });
    });
    refs.shapeGlowEnabled?.addEventListener('change', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isShapeItem(selected)) actions.updateThreeDShape?.(selected.id, { glow: { enabled: !!event.target.checked } });
    });
    refs.shapeGlowColor?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isShapeItem(selected)) actions.updateThreeDShape?.(selected.id, { glow: { color: event.target.value } });
    });
    refs.shapeGlowIntensity?.addEventListener('input', (event) => {
        const selected = getSelectedItem(store.getState());
        if (isShapeItem(selected)) actions.updateThreeDShape?.(selected.id, { glow: { intensity: Number(event.target.value) || 0 } });
    });
    refs.worldLightEnabled?.addEventListener('change', (event) => {
        actions.updateThreeDWorldLight?.({ enabled: !!event.target.checked });
    });
    refs.worldLightMode?.addEventListener('change', (event) => {
        const nextMode = event.target.value || 'solid';
        if (nextMode === 'hdri' && !(store.getState().threeDDocument?.assets?.hdris || []).length) {
            setStatus('Upload an HDRI first, then switch the world light to HDRI mode.', 'warning');
            setInputValue(refs.worldLightMode, store.getState().threeDDocument?.scene?.worldLight?.mode || 'solid');
            return;
        }
        actions.updateThreeDWorldLight?.({ mode: nextMode });
    });
    refs.worldLightIntensity?.addEventListener('input', (event) => {
        actions.updateThreeDWorldLight?.({ intensity: Number(event.target.value) || 0 });
    });
    refs.worldLightRotation?.addEventListener('change', (event) => {
        const degrees = Number(event.target.value) || 0;
        actions.updateThreeDWorldLight?.({ rotation: degrees * (Math.PI / 180) });
    });
    refs.worldLightBackgroundVisible?.addEventListener('change', (event) => {
        actions.updateThreeDWorldLight?.({ backgroundVisible: !!event.target.checked });
    });
    refs.worldLightColor?.addEventListener('input', (event) => {
        actions.updateThreeDWorldLight?.({ color: event.target.value });
    });
    refs.worldLightHdriAsset?.addEventListener('change', (event) => {
        actions.updateThreeDWorldLight?.({ hdriAssetId: event.target.value || null, mode: 'hdri', enabled: true });
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
        if (key === 'escape') {
            if (contextMenuAnchor) {
                event.preventDefault();
                closeContextMenu();
                return;
            }
            if (surfaceAttachTextId) {
                event.preventDefault();
                clearSurfaceAttachMode(true);
                return;
            }
        }
        if (store.getState().threeDDocument?.renderJob?.active) return;
        if (event.shiftKey && key === 'f10') {
            const selected = getSelectedItem(store.getState());
            if (!selected) {
                setStatus('Select an item first to open its context menu.', 'warning', 4200);
                return;
            }
            event.preventDefault();
            openContextMenuForItem(selected.id, {
                anchorEl: refs.selectionName
            });
            return;
        }
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
        engine.onAssetPipelineMessage = (payload) => {
            logThreeD(payload?.level || 'info', payload?.processId || '3d.assets', payload?.message || '', {
                dedupeKey: payload?.dedupeKey,
                dedupeWindowMs: payload?.dedupeWindowMs
            });
        };
        engine.reportCompressedAssetPipelineStatus?.();
        engine.onSelectionChanged = (itemId) => {
            previewTransform = null;
            closeContextMenu();
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
            const progress = payload?.active ? getPathTraceLoadingProgress(payload?.message) : 1;
            setPathTraceLoading(payload?.active, payload?.message, progress);
            if (payload?.active) {
                const signature = `${payload?.message || 'Preparing renderer'}|${Math.round(progress * 100)}`;
                if (signature !== lastPathTraceLogSignature) {
                    lastPathTraceLogSignature = signature;
                    logThreeD('progress', '3d.render', payload?.message || 'Preparing renderer...', progress, {
                        dedupeKey: signature,
                        dedupeWindowMs: 100
                    });
                }
            } else if (lastPathTraceLogSignature) {
                lastPathTraceLogSignature = '';
                logThreeD('info', '3d.render', 'Renderer preparation finished.', {
                    dedupeKey: 'renderer-prep-finished',
                    dedupeWindowMs: 220
                });
            }
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
            const durationLabel = payload?.durationMs ? ` in ${formatDuration(payload.durationMs)}` : '';
            if (payload?.active) {
                const requestedSamples = Math.max(1, Number(payload.requestedSamples || 0));
                const ratio = requestedSamples > 0 ? Math.min(1, (Number(payload.currentSamples || 0) / requestedSamples)) : 0;
                const bucket = Math.floor(ratio * 20);
                const signature = `${payload.status || 'active'}|${payload.message || ''}|${requestedSamples}|${bucket}|${formatRenderSize(payload)}`;
                if (signature !== lastRenderProgressSignature) {
                    lastRenderProgressSignature = signature;
                    logThreeD('progress', '3d.render', `${payload.message || 'Final render running'} ${payload.currentSamples || 0} / ${payload.requestedSamples || 0} samples at ${formatRenderSize(payload)}.`, ratio, {
                        dedupeKey: signature,
                        dedupeWindowMs: 80
                    });
                }
            } else if (payload?.status === 'complete') {
                lastRenderProgressSignature = '';
                if (payload?.libraryStatus === 'failed') {
                    logThreeD('warning', '3d.render', `${payload?.message || '3D render complete. PNG exported.'}${durationLabel} The Assets Library copy could not be updated: ${payload?.libraryError || 'Unknown Library error.'}`);
                    setStatus(`${payload?.message || 'Render complete. PNG exported.'}${durationLabel} Local save worked, but the Assets Library copy could not be updated.`, 'warning', 7000);
                } else {
                    logThreeD('success', '3d.render', `${payload?.message || '3D render complete. PNG exported.'}${durationLabel}`);
                    setStatus(
                        payload?.libraryStatus === 'saved'
                            ? `${payload?.message || 'Render complete. PNG exported.'}${durationLabel} Saved locally and added to the Assets Library.`
                            : `${payload?.message || 'Render complete. PNG exported.'}${durationLabel}`,
                        'success',
                        4200
                    );
                }
            } else if (payload?.status === 'cancelled') {
                lastRenderProgressSignature = '';
                logThreeD('warning', '3d.render', `${payload?.message || '3D render finished, but the PNG save was cancelled.'}${durationLabel}`);
                setStatus(`${payload?.message || 'Render finished, but the PNG save was cancelled.'}${durationLabel}`, 'warning', 4200);
            } else if (payload?.status === 'aborted') {
                lastRenderProgressSignature = '';
                logThreeD('warning', '3d.render', `${payload?.message || '3D render aborted.'}${durationLabel}`);
                setStatus(`${payload?.message || 'Render aborted.'}${durationLabel}`, 'warning', 4200);
            } else if (payload?.status === 'error') {
                lastRenderProgressSignature = '';
                logThreeD('error', '3d.render', `${payload?.message || 'The 3D render failed.'}${durationLabel}`);
                setStatus(`${payload?.message || 'The 3D render failed.'}${durationLabel}`, 'error', 7000);
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
    setAssetDrawerOpen(false);
    renderAssetDrawer();

    return {
        root,
        activate() {
            active = true;
            logThreeD('info', '3d.workspace', '3D workspace activated.');
            hydrateEngine();
            engine.setViewportActive?.(true);
            const assetRefreshPromise = (assetRefreshPending || !libraryAssets.length) ? refreshLibraryAssets() : Promise.resolve();
            assetRefreshPromise.catch((error) => {
                console.error(error);
                setStatus('Could not refresh Library assets for the content drawer.', 'error');
            });
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
            logThreeD('info', '3d.workspace', '3D workspace hidden; live viewport work is paused while background jobs can continue.', {
                dedupeKey: '3d-workspace-hidden',
                dedupeWindowMs: 200
            });
            engine?.setViewportActive?.(false);
            closeRenderDialog();
            closeContextMenu();
            clearSurfaceAttachMode();
        },
        refreshLibraryAssets,
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
            refs.cameraProjection.value = document.view.projection || 'perspective';
            refs.navigationMode.value = document.view.navigationMode || 'free';
            refs.lockedView.value = document.view.lockedView || 'front';
            refs.wheelMode.value = document.view.wheelMode || 'travel';
            setInputValue(refs.orthoZoom, formatNumber(document.view.orthoZoom ?? 1, 3));
            const lockedViewField = refs.lockedView?.closest('label');
            const wheelModeField = refs.wheelMode?.closest('label');
            const orthoZoomField = refs.orthoZoom?.closest('label');
            if (lockedViewField) {
                lockedViewField.style.display = document.view.navigationMode === 'canvas' ? 'flex' : 'none';
            }
            if (wheelModeField) {
                wheelModeField.style.display = document.view.navigationMode === 'canvas' ? 'flex' : 'none';
            }
            if (orthoZoomField) {
                orthoZoomField.style.display = document.view.projection === 'orthographic' ? 'flex' : 'none';
            }
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
            const hasTracePreviewContent = document.scene.items.some((item) => item.visible !== false && item.kind !== 'light');
            const renderLocked = !!document.renderJob?.active;
            const selectionLocked = !!selected?.locked;
            const lightSupportsTarget = selected?.kind === 'light' && ['directional', 'spot'].includes(selected.light?.lightType);
            if (surfaceAttachTextId && !document.scene.items.some((item) => item.id === surfaceAttachTextId && item.kind === 'text')) {
                surfaceAttachTextId = null;
            }
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

            const selectedIsText = isTextItem(selected);
            refs.textFields.style.display = selectedIsText ? 'flex' : 'none';
            if (selectedIsText) {
                setInputValue(refs.textContent, selected.text?.content || 'Text');
                refs.textMode.value = selected.text?.mode || 'flat';
                refs.textFontSourceType.value = selected.text?.fontSource?.type || 'system';
                refs.textFontFamilyField.style.display = refs.textFontSourceType.value === 'system' ? 'flex' : 'none';
                refs.textFontUploadField.style.display = refs.textFontSourceType.value === 'upload' ? 'flex' : 'none';
                refs.textGlowFields.style.display = selected.text?.glow?.enabled ? 'flex' : 'none';
                refs.textExtrudeFields.style.display = selected.text?.mode === 'extruded' ? 'flex' : 'none';
                setInputValue(refs.textFontFamily, selected.text?.fontSource?.family || 'Arial');
                renderTextFontOptions(state, selected);
                refs.textColor.value = selected.text?.color || '#ffffff';
                setInputValue(refs.textOpacity, selected.text?.opacity ?? 1);
                refs.textGlowEnabled.checked = !!selected.text?.glow?.enabled;
                refs.textGlowColor.value = selected.text?.glow?.color || selected.text?.color || '#ffffff';
                setInputValue(refs.textGlowIntensity, selected.text?.glow?.intensity ?? 4);
                setInputValue(refs.textDepth, selected.text?.extrude?.depth ?? 0.2);
                setInputValue(refs.textBevelSize, selected.text?.extrude?.bevelSize ?? 0.02);
                setInputValue(refs.textBevelThickness, selected.text?.extrude?.bevelThickness ?? 0.02);
                setInputValue(refs.textBevelSegments, selected.text?.extrude?.bevelSegments ?? 2);
                renderTextCharacterOverrides(selected);
            } else {
                refs.textFontFamilyField.style.display = 'none';
                refs.textFontUploadField.style.display = 'none';
                refs.textGlowFields.style.display = 'none';
                refs.textExtrudeFields.style.display = 'none';
            }

            const selectedIsShape = isShapeItem(selected);
            refs.shapeFields.style.display = selectedIsShape ? 'flex' : 'none';
            if (selectedIsShape) {
                refs.shapeType.value = selected.shape2d?.type || 'square';
                refs.shapeColor.value = selected.shape2d?.color || '#ffffff';
                setInputValue(refs.shapeOpacity, selected.shape2d?.opacity ?? 1);
                refs.shapeGlowEnabled.checked = !!selected.shape2d?.glow?.enabled;
                refs.shapeGlowFields.style.display = selected.shape2d?.glow?.enabled ? 'flex' : 'none';
                refs.shapeGlowColor.value = selected.shape2d?.glow?.color || selected.shape2d?.color || '#ffffff';
                setInputValue(refs.shapeGlowIntensity, selected.shape2d?.glow?.intensity ?? 4);
            } else {
                refs.shapeGlowFields.style.display = 'none';
            }

            const worldLight = document.scene.worldLight || {};
            refs.worldLightEnabled.checked = !!worldLight.enabled;
            refs.worldLightMode.value = worldLight.mode || 'solid';
            setInputValue(refs.worldLightIntensity, worldLight.intensity ?? 1);
            setInputValue(refs.worldLightRotation, formatNumber((Number(worldLight.rotation) || 0) * (180 / Math.PI), 1));
            refs.worldLightBackgroundVisible.checked = worldLight.backgroundVisible !== false;
            refs.worldLightColor.value = worldLight.color || '#f7f4eb';
            refs.worldLightColorField.style.display = worldLight.mode === 'solid' ? 'flex' : 'none';
            refs.worldLightGradientField.style.display = worldLight.mode === 'gradient' ? 'flex' : 'none';
            refs.worldLightHdriField.style.display = worldLight.mode === 'hdri' ? 'flex' : 'none';
            renderWorldLightOptions(document);

            renderHierarchy(state);
            renderCameraPresets(state);
            syncTransformFields(state);
            renderContextMenus(state);

            if (refs.statusHints) {
                refs.statusHints.textContent = document.view.navigationMode === 'canvas'
                    ? (document.view.projection === 'orthographic'
                        ? '1/2/3 | Canvas pan | Wheel zoom | Alt+Wheel depth'
                        : '1/2/3 | Canvas pan | Wheel depth | F frame')
                    : document.view.cameraMode === 'fly'
                        ? '1/2/3 | RMB look | W A S D Q E | Shift'
                        : '1/2/3 | F frame | Orbit drag | Wheel';
            }
            if (refs.statusStats) {
                refs.statusStats.textContent = `${document.scene.items.length} items | ${selected ? `${selected.name}${selectionLocked ? ' (locked)' : ''}` : (surfaceAttachTextId ? 'Pick a surface' : 'No selection')} | ${formatRenderModeLabel(document.render.mode)} | ${sampleCount} spp`;
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
            root.querySelectorAll('[data-threed-action="selection-menu"]').forEach((node) => {
                node.disabled = renderLocked || !hasSelection;
            });
            ['duplicate-item', 'reset-transform', 'delete-item'].forEach((actionName) => {
                root.querySelectorAll(`[data-threed-action="${actionName}"]`).forEach((node) => {
                    node.disabled = renderLocked || !hasSelection || selectionLocked;
                });
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
            refs.cameraMode.disabled = renderLocked || document.view.navigationMode === 'canvas';
            refs.cameraProjection.disabled = renderLocked;
            refs.navigationMode.disabled = renderLocked;
            refs.lockedView.disabled = renderLocked || document.view.navigationMode !== 'canvas';
            refs.wheelMode.disabled = renderLocked || document.view.navigationMode !== 'canvas';
            refs.orthoZoom.disabled = renderLocked || document.view.projection !== 'orthographic';
            refs.textContent.disabled = renderLocked || selectionLocked || !selectedIsText;
            refs.textMode.disabled = renderLocked || selectionLocked || !selectedIsText;
            refs.textFontSourceType.disabled = renderLocked || selectionLocked || !selectedIsText;
            refs.textFontFamily.disabled = renderLocked || selectionLocked || !selectedIsText || refs.textFontSourceType.value !== 'system';
            refs.textFontAsset.disabled = renderLocked || selectionLocked || !selectedIsText || refs.textFontSourceType.value !== 'upload';
            refs.textColor.disabled = renderLocked || selectionLocked || !selectedIsText;
            refs.textOpacity.disabled = renderLocked || selectionLocked || !selectedIsText;
            refs.textGlowEnabled.disabled = renderLocked || selectionLocked || !selectedIsText;
            refs.textGlowColor.disabled = renderLocked || selectionLocked || !selectedIsText || !selected?.text?.glow?.enabled;
            refs.textGlowIntensity.disabled = renderLocked || selectionLocked || !selectedIsText || !selected?.text?.glow?.enabled;
            refs.textDepth.disabled = renderLocked || selectionLocked || !selectedIsText || selected?.text?.mode !== 'extruded';
            refs.textBevelSize.disabled = renderLocked || selectionLocked || !selectedIsText || selected?.text?.mode !== 'extruded';
            refs.textBevelThickness.disabled = renderLocked || selectionLocked || !selectedIsText || selected?.text?.mode !== 'extruded';
            refs.textBevelSegments.disabled = renderLocked || selectionLocked || !selectedIsText || selected?.text?.mode !== 'extruded';
            refs.textCharacterOverrides.querySelectorAll('input').forEach((node) => {
                node.disabled = renderLocked || selectionLocked || !selectedIsText;
            });
            refs.shapeType.disabled = renderLocked || selectionLocked || !selectedIsShape;
            refs.shapeColor.disabled = renderLocked || selectionLocked || !selectedIsShape;
            refs.shapeOpacity.disabled = renderLocked || selectionLocked || !selectedIsShape;
            refs.shapeGlowEnabled.disabled = renderLocked || selectionLocked || !selectedIsShape;
            refs.shapeGlowColor.disabled = renderLocked || selectionLocked || !selectedIsShape || !selected?.shape2d?.glow?.enabled;
            refs.shapeGlowIntensity.disabled = renderLocked || selectionLocked || !selectedIsShape || !selected?.shape2d?.glow?.enabled;
            refs.worldLightEnabled.disabled = renderLocked;
            refs.worldLightMode.disabled = renderLocked;
            refs.worldLightIntensity.disabled = renderLocked;
            refs.worldLightRotation.disabled = renderLocked;
            refs.worldLightBackgroundVisible.disabled = renderLocked;
            refs.worldLightColor.disabled = renderLocked || worldLight.mode !== 'solid';
            refs.worldLightHdriAsset.disabled = renderLocked || worldLight.mode !== 'hdri' || !(document.assets?.hdris || []).length;
            refs.worldLightGradientStops.querySelectorAll('input, button').forEach((node) => {
                node.disabled = renderLocked || worldLight.mode !== 'gradient';
            });
            syncRangeInputMirrors();

            if (!statusResetTimer && statusTone !== 'error') {
                applyBaseStatus(state);
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
        },
        async captureViewportPng() {
            if (!engine) {
                hydrateEngine();
                await engine.queueSync(store.getState().threeDDocument);
            }
            return engine.captureViewportPng();
        },
        setProgressOverlay(payload = null) {
            if (payload?.active) {
                progressOverlay.show(payload);
                return;
            }
            progressOverlay.hide();
        }
    };
}
