import { CompositeEngine } from './engine.js';
import {
    computeCompositeDocumentBounds,
    getCompositeLayerDimensions,
    getSelectedCompositeLayer,
    normalizeCompositeDocument,
    getActiveCompositeLayers
} from './document.js';
import { createProgressOverlayController } from '../ui/progressOverlay.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0';
    if (Math.abs(numeric) >= 100 || Number.isInteger(numeric)) return String(Math.round(numeric));
    return numeric.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function formatDimensions(width, height) {
    return `${Math.max(0, Math.round(Number(width) || 0))} x ${Math.max(0, Math.round(Number(height) || 0))}`;
}

function renderRangeRow(config = {}) {
    const inputId = config.id || `composite-range-${Math.random().toString(36).slice(2, 8)}`;
    const attrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    return `
        <label class="composite-setting">
            <div class="composite-setting-label">
                <span>${escapeHtml(config.label || 'Value')}</span>
                <span>${escapeHtml(formatNumber(config.value ?? 0))}</span>
            </div>
            <div class="composite-setting-inputs">
                <input
                    id="${inputId}"
                    class="composite-range"
                    type="range"
                    min="${escapeHtml(config.min ?? 0)}"
                    max="${escapeHtml(config.max ?? 100)}"
                    step="${escapeHtml(config.step ?? 1)}"
                    value="${escapeHtml(config.value ?? 0)}"
                    data-composite-action="update-layer-number"
                    ${attrs}
                    ${config.disabled ? 'disabled' : ''}
                >
                <input
                    class="composite-number"
                    type="number"
                    min="${escapeHtml(config.min ?? 0)}"
                    max="${escapeHtml(config.max ?? 100)}"
                    step="${escapeHtml(config.step ?? 1)}"
                    value="${escapeHtml(config.value ?? 0)}"
                    data-composite-action="update-layer-number"
                    ${attrs}
                    ${config.disabled ? 'disabled' : ''}
                >
            </div>
        </label>
    `;
}

const SIDEBAR_TABS = [
    { id: 'layers', label: 'Layers', description: 'Stack order, visibility, locking, and layer ingest.' },
    { id: 'transform', label: 'Transform', description: 'Position, scale, rotation, and opacity for the selected layer.' },
    { id: 'blend', label: 'Blend', description: 'Blend modes plus viewport and checker controls.' },
    { id: 'export', label: 'Export', description: 'Configure custom bounds and resolution for export.' }
];

const BLEND_MODE_OPTIONS = [
    ['normal', 'Normal'],
    ['multiply', 'Multiply'],
    ['screen', 'Screen'],
    ['add', 'Add'],
    ['overlay', 'Overlay'],
    ['soft-light', 'Soft Light'],
    ['hard-light', 'Hard Light'],
    ['hue', 'Hue'],
    ['color', 'Color']
];

function mapBlendLabel(mode) {
    return BLEND_MODE_OPTIONS.find(([value]) => value === mode)?.[1] || 'Normal';
}

export function createCompositeWorkspace(root, { actions, logger = null }) {
    root.innerHTML = `
        <style data-composite-style>
            .composite-shell{--comp-border:#b8b2a3;--comp-border-soft:rgba(184,178,163,.24);--comp-accent:rgba(184,178,163,.14);--comp-muted:#b8b2a3;position:relative;width:100%;height:100%;min-width:0;min-height:0;display:grid;grid-template-columns:minmax(248px,312px) minmax(0,1fr);gap:8px;padding:8px;background:#000;color:#fff;font-size:11px;line-height:1.3;overflow:hidden}
            .composite-shell button,.composite-shell input,.composite-shell select{font-size:11px!important}
            .composite-shell .mini-button,.composite-shell .toolbar-button,.composite-shell input[type="number"],.composite-shell select{min-height:22px;padding:2px 7px!important;border-radius:4px;border:1px solid var(--comp-border);background:#000;color:#fff;box-shadow:none}
            .composite-sidebar,.composite-stage-card,.composite-picker-panel{min-width:0;min-height:0;border:1px solid var(--comp-border);background:#000;overflow:hidden}
            .composite-sidebar{display:flex;flex-direction:column}
            .composite-sidebar-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:6px;border-bottom:1px solid var(--comp-border);background:#050505}
            .composite-sidebar-tab{min-height:20px;padding:0 7px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--comp-muted);cursor:pointer}
            .composite-sidebar-tab.is-active,.composite-sidebar-tab:hover{background:var(--comp-accent);border-color:var(--comp-border);color:#fff}
            .composite-panel{display:none;height:100%;min-height:0;flex-direction:column}
            .composite-panel.is-active{display:flex}
            .composite-panel-head{padding:8px 9px 7px;border-bottom:1px solid var(--comp-border);background:#050505}
            .composite-panel-head span{display:block;margin-top:2px;color:var(--comp-muted);font-size:10px}
            .composite-panel-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px;display:flex;flex-direction:column;gap:8px}
            .composite-stage-card{display:flex;flex-direction:column}
            .composite-stage-topbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid var(--comp-border);background:#050505}
            .composite-stage-title .eyebrow{margin:0 0 2px;color:var(--comp-muted);font-size:10px;letter-spacing:.04em;text-transform:uppercase}
            .composite-stage-title h2{margin:0;font-size:12px;line-height:1.2}
            .composite-stage-meta{display:flex;gap:8px;flex-wrap:wrap;color:var(--comp-muted);font-size:10px}
            .composite-stage-wrap{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;background:#000;touch-action:none;cursor:grab}
            .composite-stage-wrap.is-dragging{cursor:grabbing}
            .composite-stage-wrap.is-checker{background:linear-gradient(45deg, rgba(255,255,255,.1) 25%, transparent 25%, transparent 75%, rgba(255,255,255,.1) 75%, rgba(255,255,255,.1)),linear-gradient(45deg, rgba(255,255,255,.08) 25%, transparent 25%, transparent 75%, rgba(255,255,255,.08) 75%, rgba(255,255,255,.08));background-size:24px 24px;background-position:0 0,12px 12px}
            .composite-dom-stage{position:absolute;overflow:visible;pointer-events:none}
            .composite-layer{position:absolute;pointer-events:auto;user-select:none;transform-origin:center center}
            .composite-empty{position:absolute;inset:12px;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px;text-align:center;pointer-events:none;color:var(--comp-muted);border:1px dashed var(--comp-border-soft);background:rgba(0,0,0,.74)}
            .composite-empty.is-visible{display:flex}
            .composite-export-bounds{position:absolute;border:1px solid #0bf;pointer-events:none;z-index:20;display:none;box-shadow:0 0 0 9999px rgba(0,0,0,0.5)}
            .composite-export-bounds.is-visible{display:block}
            .composite-export-bounds-handle{position:absolute;width:12px;height:12px;background:#0bf;border:1px solid #fff;pointer-events:auto;z-index:21}
            .composite-export-bounds-handle.nw{top:-6px;left:-6px;cursor:nwse-resize}
            .composite-export-bounds-handle.ne{top:-6px;right:-6px;cursor:nesw-resize}
            .composite-export-bounds-handle.sw{bottom:-6px;left:-6px;cursor:nesw-resize}
            .composite-export-bounds-handle.se{bottom:-6px;right:-6px;cursor:nwse-resize}
            .composite-export-bounds-handle.n{top:-6px;left:50%;margin-left:-6px;cursor:ns-resize}
            .composite-export-bounds-handle.s{bottom:-6px;left:50%;margin-left:-6px;cursor:ns-resize}
            .composite-export-bounds-handle.w{top:50%;left:-6px;margin-top:-6px;cursor:ew-resize}
            .composite-export-bounds-handle.e{top:50%;right:-6px;margin-top:-6px;cursor:ew-resize}
            .composite-export-bounds-move{position:absolute;inset:0;cursor:move;pointer-events:auto}
            .composite-chip-bar{position:absolute;left:6px;bottom:6px;display:flex;gap:4px;flex-wrap:wrap;pointer-events:none;z-index:30}
            .composite-chip{display:inline-flex;align-items:center;gap:4px;min-height:20px;padding:0 6px;border:1px solid var(--comp-border-soft);background:rgba(0,0,0,.92);color:#fff;font-size:10px}
            .composite-stack,.composite-setting-stack,.composite-picker-grid{display:flex;flex-direction:column;gap:8px;min-width:0}
            .composite-card,.composite-picker-item{border:1px solid var(--comp-border);background:#050505;min-width:0}
            .composite-card.is-selected,.composite-picker-item.is-selected{background:var(--comp-accent);border-color:var(--comp-border)}
            .composite-card-main{width:100%;border:none;background:none;color:inherit;text-align:left;padding:7px;display:flex;flex-direction:column;gap:4px;cursor:pointer}
            .composite-card-main strong,.composite-picker-copy strong{font-size:11px;overflow-wrap:anywhere}
            .composite-card-main span,.composite-picker-copy span,.composite-mini-empty,.composite-help{color:var(--comp-muted);font-size:10px}
            .composite-card-badges{display:flex;flex-wrap:wrap;gap:4px}
            .composite-kind-badge{display:inline-flex;align-items:center;justify-content:center;min-height:18px;padding:0 5px;border:1px solid var(--comp-border-soft);background:rgba(184,178,163,.08);color:var(--comp-muted);font-size:9px;letter-spacing:.04em;text-transform:uppercase}
            .composite-card-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(68px,1fr));gap:6px;padding:0 7px 7px}
            .composite-setting{display:flex;flex-direction:column;gap:6px;color:var(--comp-muted)}
            .composite-setting-label{display:flex;align-items:center;justify-content:space-between;gap:8px}
            .composite-setting-inputs{display:grid;grid-template-columns:minmax(0,1fr) 78px;gap:6px}
            .composite-range,.composite-number,.composite-select{width:100%}
            .composite-select-wrap,.composite-toggle-row,.composite-info-card{border:1px solid var(--comp-border);background:#050505;padding:8px}
            .composite-toggle-row{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start}
            .composite-toggle-row strong{display:block;color:#fff;font-size:10px}
            .composite-info-card{display:flex;flex-direction:column;gap:6px}
            .composite-info-line{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--comp-muted);font-size:10px}
            .composite-info-line strong{color:#fff}
            .composite-picker-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.78);z-index:30}
            .composite-picker-overlay.is-open{display:flex}
            .composite-picker-panel{width:min(1080px,100%);height:min(86vh,760px);display:flex;flex-direction:column;gap:8px;padding:10px}
            .composite-picker-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
            .composite-picker-header .eyebrow{margin:0 0 2px;color:var(--comp-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}
            .composite-picker-header h3{margin:0;font-size:12px}
            .composite-picker-grid{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
            .composite-picker-item{display:flex;flex-direction:column;overflow:hidden}
            .composite-picker-preview{aspect-ratio:4/3;background:#000;border-bottom:1px solid var(--comp-border);display:flex;align-items:center;justify-content:center}
            .composite-picker-preview img{display:block;width:100%;height:100%;object-fit:contain}
            .composite-picker-copy{padding:8px;display:flex;flex-direction:column;gap:4px}
            .composite-picker-actions{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap}
            .composite-picker-selection{color:var(--comp-muted);font-size:10px}
            @media (max-width:980px){.composite-shell{grid-template-columns:1fr;grid-template-rows:minmax(220px,42vh) minmax(0,1fr)}.composite-picker-overlay{padding:8px}.composite-picker-panel{width:100%;height:100%}}
        </style>
        <div class="composite-shell">
            <aside class="composite-sidebar">
                <div class="composite-sidebar-tabs">
                    ${SIDEBAR_TABS.map((tab) => `<button type="button" class="composite-sidebar-tab" data-composite-action="workspace-tab" data-sidebar-view="${tab.id}">${tab.label}</button>`).join('')}
                </div>
                ${SIDEBAR_TABS.map((tab) => `
                    <section class="composite-panel" data-composite-panel="${tab.id}">
                        <div class="composite-panel-head"><strong>${tab.label}</strong><span>${tab.description}</span></div>
                        <div class="composite-panel-body" data-composite-role="${tab.id}-panel"></div>
                    </section>
                `).join('')}
            </aside>
            <section class="composite-stage-card">
                <div class="composite-stage-topbar">
                    <div class="composite-stage-title">
                        <div class="eyebrow">Composite Preview</div>
                        <h2 data-composite-role="title">Composite Workspace</h2>
                    </div>
                    <div class="composite-stage-meta" data-composite-role="meta"></div>
                </div>
                <div class="composite-stage-wrap is-checker" data-composite-role="stage-wrap">
                    <div class="composite-dom-stage" data-composite-role="dom-stage"></div>
                    <div class="composite-export-bounds" data-composite-role="export-bounds">
                        <div class="composite-export-bounds-move" data-composite-action="bounds-move"></div>
                        <div class="composite-export-bounds-handle nw" data-composite-action="bounds-resize" data-dir="nw"></div>
                        <div class="composite-export-bounds-handle n" data-composite-action="bounds-resize" data-dir="n"></div>
                        <div class="composite-export-bounds-handle ne" data-composite-action="bounds-resize" data-dir="ne"></div>
                        <div class="composite-export-bounds-handle w" data-composite-action="bounds-resize" data-dir="w"></div>
                        <div class="composite-export-bounds-handle e" data-composite-action="bounds-resize" data-dir="e"></div>
                        <div class="composite-export-bounds-handle sw" data-composite-action="bounds-resize" data-dir="sw"></div>
                        <div class="composite-export-bounds-handle s" data-composite-action="bounds-resize" data-dir="s"></div>
                        <div class="composite-export-bounds-handle se" data-composite-action="bounds-resize" data-dir="se"></div>
                    </div>
                    <div class="composite-empty is-visible" data-composite-role="empty-state"><strong>Add one or more layers</strong><span>Bring in saved Editor projects or local images to start compositing.</span></div>
                    <div class="composite-chip-bar">
                        <div class="composite-chip" data-composite-role="status">Composite workspace ready.</div>
                    </div>
                </div>
            </section>
            <div class="composite-picker-overlay" data-composite-role="picker-overlay">
                <div class="composite-picker-panel">
                    <div class="composite-picker-header">
                        <div><div class="eyebrow">Library Editor Projects</div><h3>Add Editor Projects To Composite</h3></div>
                        <button type="button" class="toolbar-button" data-composite-action="close-picker">Close</button>
                    </div>
                    <div class="composite-picker-actions">
                        <div class="composite-picker-selection" data-composite-role="picker-selection">Loading editor projects...</div>
                        <div style="display:flex;gap:6px;flex-wrap:wrap">
                            <button type="button" class="toolbar-button" data-composite-action="refresh-picker">Refresh</button>
                            <button type="button" class="primary-button" data-composite-action="confirm-picker">Add Selected</button>
                        </div>
                    </div>
                    <div class="composite-picker-grid" data-composite-role="picker-grid"></div>
                </div>
            </div>
            <input type="file" accept="image/*" multiple hidden data-composite-role="image-input">
            <input type="file" accept=".json,.mns.json" hidden data-composite-role="state-input">
        </div>
    `;

    const refs = {
        tabs: [...root.querySelectorAll('[data-composite-action="workspace-tab"]')],
        panels: [...root.querySelectorAll('[data-composite-panel]')],
        domStage: root.querySelector('[data-composite-role="dom-stage"]'),
        title: root.querySelector('[data-composite-role="title"]'),
        meta: root.querySelector('[data-composite-role="meta"]'),
        status: root.querySelector('[data-composite-role="status"]'),
        stageWrap: root.querySelector('[data-composite-role="stage-wrap"]'),
        emptyState: root.querySelector('[data-composite-role="empty-state"]'),
        imageInput: root.querySelector('[data-composite-role="image-input"]'),
        stateInput: root.querySelector('[data-composite-role="state-input"]'),
        layersPanel: root.querySelector('[data-composite-role="layers-panel"]'),
        transformPanel: root.querySelector('[data-composite-role="transform-panel"]'),
        blendPanel: root.querySelector('[data-composite-role="blend-panel"]'),
        exportPanel: root.querySelector('[data-composite-role="export-panel"]'),
        exportBoundsUI: root.querySelector('[data-composite-role="export-bounds"]'),
        pickerOverlay: root.querySelector('[data-composite-role="picker-overlay"]'),
        pickerGrid: root.querySelector('[data-composite-role="picker-grid"]'),
        pickerSelection: root.querySelector('[data-composite-role="picker-selection"]')
    };

    const engine = new CompositeEngine({
        onNotice(message) {
            setStatus(message);
        }
    });

    const progressOverlay = createProgressOverlayController(refs.stageWrap, {
        defaultTitle: 'Composite Task',
        defaultMessage: 'Preparing the composite workspace...'
    });

    let active = false;
    let currentDocument = normalizeCompositeDocument();
    let pickerItems = [];
    let selectedPickerIds = new Set();
    let dragState = null;
    let dragLayerId = null;
    let enablePixelMatch = false;

    function logWorkspace(level, message, options = {}) {
        if (!logger || !message) return;
        const method = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
        method('composite.workspace', 'Composite Workspace', message, options);
    }

    function setStatus(message, tone = 'info') {
        refs.status.textContent = String(message || 'Composite workspace ready.');
        refs.status.dataset.tone = tone;
    }

    function selectedLayer() {
        return getSelectedCompositeLayer(currentDocument);
    }

    function renderLayersPanel() {
        const layers = [...currentDocument.layers].sort((a, b) => (b.z || 0) - (a.z || 0));
        if (!layers.length) {
            refs.layersPanel.innerHTML = `
                <div class="composite-info-card">
                    <strong>No layers yet</strong>
                    <span class="composite-help">Use the top toolbar to add saved Editor projects or local images.</span>
                </div>
            `;
            return;
        }
        refs.layersPanel.innerHTML = `
            <div class="composite-stack">
                ${layers.map((layer) => {
                    const dimensions = getCompositeLayerDimensions(layer);
                    const isSelected = layer.id === currentDocument.selection.layerId;
                    return `
                        <section class="composite-card ${isSelected ? 'is-selected' : ''}" draggable="true" data-composite-layer-row="${layer.id}">
                            <button type="button" class="composite-card-main" data-composite-action="select-layer" data-layer-id="${layer.id}">
                                <strong>${escapeHtml(layer.name || 'Layer')}</strong>
                                <div class="composite-card-badges">
                                    <span class="composite-kind-badge">${escapeHtml(layer.kind === 'editor-project' ? 'Editor' : 'Image')}</span>
                                    <span class="composite-kind-badge">${escapeHtml(mapBlendLabel(layer.blendMode))}</span>
                                    <span class="composite-kind-badge">${escapeHtml(formatDimensions(dimensions.width, dimensions.height))}</span>
                                </div>
                                <span>${escapeHtml(`Pos ${formatNumber(layer.x)}, ${formatNumber(layer.y)} | Scale ${formatNumber(layer.scale)} | Rot ${formatNumber(layer.rotation)} deg`)}</span>
                            </button>
                            <div class="composite-card-actions">
                                <button type="button" class="toolbar-button" data-composite-action="toggle-layer-visible" data-layer-id="${layer.id}">${layer.visible === false ? 'Show' : 'Hide'}</button>
                                <button type="button" class="toolbar-button" data-composite-action="toggle-layer-lock" data-layer-id="${layer.id}">${layer.locked ? 'Unlock' : 'Lock'}</button>
                                <button type="button" class="toolbar-button" data-composite-action="move-layer-up" data-layer-id="${layer.id}">Up</button>
                                <button type="button" class="toolbar-button" data-composite-action="move-layer-down" data-layer-id="${layer.id}">Down</button>
                                <button type="button" class="toolbar-button" data-composite-action="remove-layer" data-layer-id="${layer.id}">Remove</button>
                            </div>
                        </section>
                    `;
                }).join('')}
            </div>
        `;
    }

    function renderTransformPanel() {
        const layer = selectedLayer();
        if (!layer) {
            refs.transformPanel.innerHTML = '<div class="composite-mini-empty">Select a layer to edit its transform.</div>';
            return;
        }
        refs.transformPanel.innerHTML = `
            <div class="composite-setting-stack">
                <div class="composite-info-card">
                    <div class="composite-info-line"><span>Layer</span><strong>${escapeHtml(layer.name || 'Layer')}</strong></div>
                    <div class="composite-info-line"><span>Type</span><strong>${escapeHtml(layer.kind === 'editor-project' ? 'Embedded Editor Project' : 'Image')}</strong></div>
                </div>
                <div class="composite-card-actions">
                    <button type="button" class="toolbar-button" data-composite-action="toggle-layer-flip" data-layer-id="${layer.id}" data-axis="x" ${layer.locked ? 'disabled' : ''}>${layer.flipX ? 'Unflip X' : 'Flip X'}</button>
                    <button type="button" class="toolbar-button" data-composite-action="toggle-layer-flip" data-layer-id="${layer.id}" data-axis="y" ${layer.locked ? 'disabled' : ''}>${layer.flipY ? 'Unflip Y' : 'Flip Y'}</button>
                </div>
                ${renderRangeRow({ id: `layer-x-${layer.id}`, label: 'X Position', value: layer.x, min: -8192, max: 8192, step: 1, disabled: layer.locked, dataset: { layerid: layer.id, field: 'x' } })}
                ${renderRangeRow({ id: `layer-y-${layer.id}`, label: 'Y Position', value: layer.y, min: -8192, max: 8192, step: 1, disabled: layer.locked, dataset: { layerid: layer.id, field: 'y' } })}
                ${renderRangeRow({ id: `layer-scale-${layer.id}`, label: 'Scale', value: layer.scale, min: 0.05, max: 8, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'scale' } })}
                ${renderRangeRow({ id: `layer-rotation-${layer.id}`, label: 'Rotation', value: layer.rotation, min: -6.283, max: 6.283, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'rotation' } })}
                ${renderRangeRow({ id: `layer-opacity-${layer.id}`, label: 'Opacity', value: layer.opacity, min: 0, max: 1, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'opacity' } })}
            </div>
        `;
    }

    function renderBlendPanel() {
        const layer = selectedLayer();
        const bounds = computeCompositeDocumentBounds(currentDocument);
        refs.blendPanel.innerHTML = `
            <div class="composite-setting-stack">
                ${layer ? `
                    <label class="composite-select-wrap">
                        <div class="composite-setting-label">
                            <span>Blend Mode</span>
                            <span>${escapeHtml(mapBlendLabel(layer.blendMode))}</span>
                        </div>
                        <select class="composite-select" data-composite-action="set-layer-blend" data-layer-id="${layer.id}" ${layer.locked ? 'disabled' : ''}>
                            ${BLEND_MODE_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === layer.blendMode ? 'selected' : ''}>${label}</option>`).join('')}
                        </select>
                    </label>
                ` : '<div class="composite-mini-empty">Select a layer to edit blending.</div>'}
                <label class="composite-toggle-row">
                    <input type="checkbox" data-composite-action="toggle-checker" ${currentDocument.view.showChecker ? 'checked' : ''}>
                    <div><strong>Checker Background</strong><span class="composite-help">Preview transparency against the composite stage only.</span></div>
                </label>
                <div class="composite-info-card">
                    <div class="composite-info-line"><span>Visible Bounds</span><strong>${escapeHtml(formatDimensions(bounds.width, bounds.height))}</strong></div>
                    <div class="composite-info-line"><span>Zoom</span><strong>${escapeHtml(`${formatNumber(currentDocument.view.zoom)}x`)}</strong></div>
                    <div class="composite-info-line"><span>Pan</span><strong>${escapeHtml(`${formatNumber(currentDocument.view.panX)}, ${formatNumber(currentDocument.view.panY)}`)}</strong></div>
                </div>
                <div class="composite-card-actions">
                    <button type="button" class="toolbar-button" data-composite-action="frame-view">Frame</button>
                    <button type="button" class="toolbar-button" data-composite-action="reset-pan">Reset Pan</button>
                    <button type="button" class="toolbar-button" data-composite-action="zoom-in">Zoom In</button>
                    <button type="button" class="toolbar-button" data-composite-action="zoom-out">Zoom Out</button>
                </div>
            </div>
        `;
    }

    function renderExportPanel() {
        if (!refs.exportPanel) return;
        const exportState = currentDocument.export || {};
        const isCustom = exportState.boundsMode === 'custom';
        refs.exportPanel.innerHTML = `
            <div class="composite-setting-stack">
                <label class="composite-select-wrap">
                    <div class="composite-setting-label">
                        <span>Bounds Mode</span>
                        <span>${isCustom ? 'Custom' : 'Auto (All Layers)'}</span>
                    </div>
                    <select class="composite-select" data-composite-action="set-export-mode">
                        <option value="auto" ${!isCustom ? 'selected' : ''}>Auto Contain</option>
                        <option value="custom" ${isCustom ? 'selected' : ''}>Custom Bounds</option>
                    </select>
                </label>
                ${isCustom ? `
                    <div class="composite-info-card">
                        <div class="composite-info-line"><span>Bounds Position</span><strong>${exportState.bounds.x}, ${exportState.bounds.y}</strong></div>
                        <div class="composite-info-line"><span>Bounds Size</span><strong>${exportState.bounds.width} x ${exportState.bounds.height}</strong></div>
                    </div>
                    <label class="composite-select-wrap">
                        <div class="composite-setting-label">
                            <span>Force Aspect Ratio</span>
                        </div>
                        <select class="composite-select" data-composite-action="set-export-preset">
                            <option value="">Freeform</option>
                            <option value="1.77777778">16:9 Landscape</option>
                            <option value="0.5625">9:16 Portrait</option>
                            <option value="1.33333333">4:3 Landscape</option>
                            <option value="0.75">3:4 Portrait</option>
                            <option value="1">1:1 Square</option>
                        </select>
                    </label>
                    ${renderRangeRow({ id: 'export-res-w', label: 'Output Width', value: exportState.customResolution?.width || 1920, min: 1, max: 8192, step: 1, dataset: { field: 'width' } })}
                    ${renderRangeRow({ id: 'export-res-h', label: 'Output Height', value: exportState.customResolution?.height || 1080, min: 1, max: 8192, step: 1, dataset: { field: 'height' } })}
                    <div class="composite-card-actions">
                        <button type="button" class="toolbar-button ${enablePixelMatch ? 'primary-button' : ''}" data-composite-action="toggle-pixel-match">
                            ${enablePixelMatch ? 'Click Layer on Canvas...' : 'Match Layer 1:1'}
                        </button>
                    </div>
                ` : `
                    <div class="composite-mini-empty">Export bounds and resolution will match the full visible area of all layers together automatically.</div>
                `}
            </div>
        `;
    }

    function renderStageChrome() {
        const bounds = computeCompositeDocumentBounds(currentDocument);
        refs.title.textContent = currentDocument.layers.length
            ? `${currentDocument.layers.length} layer${currentDocument.layers.length === 1 ? '' : 's'} in Composite`
            : 'Composite Workspace';
        refs.meta.innerHTML = `
            <span>${escapeHtml(`${currentDocument.layers.length} layer${currentDocument.layers.length === 1 ? '' : 's'}`)}</span>
            <span>${escapeHtml(`Bounds ${formatDimensions(bounds.width, bounds.height)}`)}</span>
            <span>${escapeHtml(`Zoom ${formatNumber(currentDocument.view.zoom)}x`)}</span>
        `;
        refs.stageWrap.classList.toggle('is-checker', currentDocument.view.showChecker !== false);
        refs.emptyState.classList.toggle('is-visible', !currentDocument.layers.length);
    }

    function renderPicker() {
        const selectedCount = selectedPickerIds.size;
        refs.pickerSelection.textContent = pickerItems.length
            ? `${selectedCount} selected of ${pickerItems.length} saved Editor project${pickerItems.length === 1 ? '' : 's'}`
            : 'No saved Editor projects are available in the Library.';
        refs.pickerGrid.innerHTML = pickerItems.length
            ? pickerItems.map((item) => `
                <button type="button" class="composite-picker-item ${selectedPickerIds.has(item.id) ? 'is-selected' : ''}" data-composite-action="toggle-picker-item" data-library-id="${item.id}">
                    <div class="composite-picker-preview">
                        ${item.previewDataUrl ? `<img src="${item.previewDataUrl}" alt="${escapeHtml(item.name || 'Editor project preview')}">` : '<span class="composite-mini-empty">No preview</span>'}
                    </div>
                    <div class="composite-picker-copy">
                        <strong>${escapeHtml(item.name || 'Editor Project')}</strong>
                        <span>${escapeHtml(item.dimensionsText || 'Unknown size')}</span>
                        <span>${escapeHtml(item.savedAtText || '')}</span>
                    </div>
                </button>
            `).join('')
            : '<div class="composite-mini-empty">Save an Editor project to the Library first, then return here to add it as a Composite layer.</div>';
    }

    async function refreshPicker() {
        refs.pickerSelection.textContent = 'Loading saved Editor projects...';
        refs.pickerGrid.innerHTML = '';
        try {
            pickerItems = await actions.listCompositeSourceProjects?.();
            renderPicker();
        } catch (error) {
            refs.pickerSelection.textContent = error?.message || 'Could not load the saved Editor projects.';
            refs.pickerGrid.innerHTML = '<div class="composite-mini-empty">Could not load the saved Editor projects from the Library.</div>';
        }
    }

    async function openProjectPicker() {
        selectedPickerIds = new Set();
        refs.pickerOverlay.classList.add('is-open');
        await refreshPicker();
    }

    async function confirmPickerSelection() {
        const ids = [...selectedPickerIds];
        if (!ids.length) return;
        refs.pickerOverlay.classList.remove('is-open');
        await actions.addCompositeEditorProjects?.(ids);
    }

    function updateExportBoundsUI() {
        if (!refs.exportBoundsUI) return;
        const isExporting = currentDocument.workspace.sidebarView === 'export' && currentDocument.export.boundsMode === 'custom';
        refs.exportBoundsUI.classList.toggle('is-visible', isExporting);
        if (!isExporting) return;
        
        const bounds = currentDocument.export.bounds;
        const rect = refs.stageWrap.getBoundingClientRect();
        const topLeftScale = engine.worldToScreen(currentDocument, rect.width || 1, rect.height || 1, bounds.x, bounds.y);
        const bottomRightScale = engine.worldToScreen(currentDocument, rect.width || 1, rect.height || 1, bounds.x + bounds.width, bounds.y + bounds.height);
        
        if (topLeftScale && bottomRightScale) {
            refs.exportBoundsUI.style.left = `${topLeftScale.x}px`;
            refs.exportBoundsUI.style.top = `${topLeftScale.y}px`;
            refs.exportBoundsUI.style.width = `${bottomRightScale.x - topLeftScale.x}px`;
            refs.exportBoundsUI.style.height = `${bottomRightScale.y - topLeftScale.y}px`;
        }
    }

    function syncCanvasDOM(document) {
        if (!refs.domStage) return;
        const rect = refs.stageWrap.getBoundingClientRect();
        const viewport = engine.computeViewport(document, rect.width || 1, rect.height || 1, 'screen');
        
        refs.domStage.style.position = 'absolute';
        refs.domStage.style.top = '50%';
        refs.domStage.style.left = '50%';
        refs.domStage.style.width = '0px';
        refs.domStage.style.height = '0px';
        refs.domStage.style.transform = `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale}) translate(${-viewport.centerWorld.x}px, ${-viewport.centerWorld.y}px)`;

        const layers = getActiveCompositeLayers(document);
        // Remove old nodes
        const activeIds = new Set(layers.map(l => l.id));
        Array.from(refs.domStage.children).forEach(child => {
            if (!activeIds.has(child.dataset.layerId)) {
                child.remove();
            }
        });

        for (const layer of layers) {
            const asset = engine.layerAssets.get(layer.id);
            if (!asset?.image) continue;
            
            const scaledWidth = asset.width * layer.scale;
            const scaledHeight = asset.height * layer.scale;
            const flipScaleX = (layer.flipX ? -1 : 1);
            const flipScaleY = (layer.flipY ? -1 : 1);
            const cssBlendMode = layer.blendMode === 'add' ? 'plus-lighter' : layer.blendMode === 'normal' ? 'normal' : layer.blendMode;
            
            let node = refs.domStage.querySelector(`[data-layer-id="${layer.id}"]`);
            if (!node) {
                node = window.document.createElement('img');
                node.className = 'composite-layer';
                node.dataset.layerId = layer.id;
                node.style.position = 'absolute';
                node.style.pointerEvents = 'auto';
                node.style.userSelect = 'none';
                node.style.transformOrigin = 'center center';
                node.draggable = false;
                refs.domStage.appendChild(node);
            }
            if (node.src !== asset.image.src) node.src = asset.image.src;
            node.style.width = `${scaledWidth}px`;
            node.style.height = `${scaledHeight}px`;
            node.style.left = `${layer.x}px`;
            node.style.top = `${layer.y}px`;
            node.style.transform = `rotate(${layer.rotation || 0}rad) scale(${flipScaleX}, ${flipScaleY})`;
            node.style.opacity = layer.opacity !== undefined ? layer.opacity : 1;
            node.style.mixBlendMode = cssBlendMode;
            node.style.display = layer.visible === false ? 'none' : 'block';
        }

        const sortedLayers = [...layers].sort((a, b) => (a.z || 0) - (b.z || 0));
        sortedLayers.forEach(layer => {
             const node = refs.domStage.querySelector(`[data-layer-id="${layer.id}"]`);
             if (node) refs.domStage.appendChild(node); 
        });
    }

    async function render(document) {
        currentDocument = normalizeCompositeDocument(document);
        if (!dragState) {
            refs.tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.sidebarView === currentDocument.workspace.sidebarView));
            refs.panels.forEach((panel) => panel.classList.toggle('is-active', panel.dataset.compositePanel === currentDocument.workspace.sidebarView));
            renderLayersPanel();
            renderTransformPanel();
            renderBlendPanel();
            renderExportPanel();
            renderStageChrome();
        }
        if (!active) return;
        try {
            updateExportBoundsUI();
            await engine.syncDocument(currentDocument);
            syncCanvasDOM(currentDocument);
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not render the composite.', 'error');
        }
    }

    function handleCanvasPointerDown(event) {
        if (!active || event.button !== 0) return;
        
        if (event.target.closest('[data-composite-action^="bounds-"]')) {
            const action = event.target.closest('[data-composite-action]').dataset.compositeAction;
            const dir = event.target.dataset.dir || '';
            const bounds = currentDocument.export.bounds;
            const rect = refs.stageWrap.getBoundingClientRect();
            const world = engine.screenToWorld(currentDocument, rect.width, rect.height, event.clientX, event.clientY, rect.left, rect.top);
            
            dragState = {
                mode: action === 'bounds-resize' ? 'bounds-resize' : 'bounds-move',
                dir,
                startWorldX: world.x,
                startWorldY: world.y,
                startBounds: { ...bounds }
            };
            refs.stageWrap.classList.add('is-dragging');
            if (refs.stageWrap.setPointerCapture) event.target.setPointerCapture(event.pointerId);
            event.preventDefault();
            return;
        }

        const isExportMode = currentDocument.workspace.sidebarView === 'export';
        const layerNode = event.target.closest('.composite-layer');
        const layerId = layerNode ? layerNode.dataset.layerId : null;

        if (isExportMode) {
            if (enablePixelMatch && layerId) {
                const layer = currentDocument.layers.find((l) => l.id === layerId);
                if (layer) {
                    const bounds = currentDocument.export.bounds;
                    actions.patchCompositeExport?.({
                        customResolution: {
                            width: Math.round(bounds.width / Math.max(0.01, layer.scale)),
                            height: Math.round(bounds.height / Math.max(0.01, layer.scale))
                        }
                    });
                    enablePixelMatch = false;
                    renderExportPanel();
                    setStatus(`Resolution matched 1:1 with "${layer.name}".`, 'success');
                }
            } else {
                dragState = {
                    mode: 'pan',
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    startPanX: currentDocument.view.panX || 0,
                    startPanY: currentDocument.view.panY || 0
                };
            }
        } else {
            if (layerId && layerId !== currentDocument.selection.layerId) {
                actions.selectCompositeLayer?.(layerId);
            }
            if (layerId && (!selectedLayer() || selectedLayer().id === layerId) && !currentDocument.layers.find(l => l.id === layerId)?.locked) {
                const layer = currentDocument.layers.find((l) => l.id === layerId);
                const rect = refs.stageWrap.getBoundingClientRect();
                const world = engine.screenToWorld(currentDocument, rect.width, rect.height, event.clientX, event.clientY, rect.left, rect.top);
                dragState = {
                    mode: 'layer',
                    layerId: layer.id,
                    startWorldX: world.x,
                    startWorldY: world.y,
                    startLayerX: layer.x,
                    startLayerY: layer.y
                };
            } else {
                dragState = {
                    mode: 'pan',
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    startPanX: currentDocument.view.panX || 0,
                    startPanY: currentDocument.view.panY || 0
                };
            }
        }
        
        refs.stageWrap.classList.add('is-dragging');
        if (refs.stageWrap.setPointerCapture) refs.stageWrap.setPointerCapture(event.pointerId);
        event.preventDefault();
    }

    function handleCanvasPointerMove(event) {
        if (!dragState) return;
        const rect = refs.stageWrap.getBoundingClientRect();
        const world = engine.screenToWorld(currentDocument, rect.width, rect.height, event.clientX, event.clientY, rect.left, rect.top);

        if (dragState.mode === 'bounds-move') {
            const bx = dragState.startBounds.x + (world.x - dragState.startWorldX);
            const by = dragState.startBounds.y + (world.y - dragState.startWorldY);
            currentDocument.export.bounds.x = bx;
            currentDocument.export.bounds.y = by;
            updateExportBoundsUI();
            actions.patchCompositeExport?.({
                bounds: { ...dragState.startBounds, x: bx, y: by }
            });
        } else if (dragState.mode === 'bounds-resize') {
            const patch = { ...dragState.startBounds };
            const dx = world.x - dragState.startWorldX;
            const dy = world.y - dragState.startWorldY;
            
            if (dragState.dir.includes('w')) {
                patch.width = Math.max(1, patch.width - dx);
                patch.x += (dragState.startBounds.width - patch.width);
            }
            if (dragState.dir.includes('e')) {
                patch.width = Math.max(1, patch.width + dx);
            }
            if (dragState.dir.includes('n')) {
                patch.height = Math.max(1, patch.height - dy);
                patch.y += (dragState.startBounds.height - patch.height);
            }
            if (dragState.dir.includes('s')) {
                patch.height = Math.max(1, patch.height + dy);
            }
            currentDocument.export.bounds = { ...patch };
            updateExportBoundsUI();
            actions.patchCompositeExport?.({ bounds: patch });
        } else if (dragState.mode === 'layer') {
            const nx = dragState.startLayerX + (world.x - dragState.startWorldX);
            const ny = dragState.startLayerY + (world.y - dragState.startWorldY);
            const layer = currentDocument.layers.find((l) => l.id === dragState.layerId);
            if (layer) {
                layer.x = nx;
                layer.y = ny;
                const vx = root.querySelector(`#layer-x-${layer.id}`);
                const vy = root.querySelector(`#layer-y-${layer.id}`);
                if (vx) vx.value = Math.round(nx);
                if (vy) vy.value = Math.round(ny);
            }
            actions.updateCompositeLayerFields?.(dragState.layerId, { x: nx, y: ny });
        } else if (dragState.mode === 'pan') {
            const px = dragState.startPanX + (event.clientX - dragState.startClientX) * ((rect.width || 1) / Math.max(1, rect.width || 1));
            const py = dragState.startPanY + (event.clientY - dragState.startClientY) * ((rect.height || 1) / Math.max(1, rect.height || 1));
            currentDocument.view.panX = px;
            currentDocument.view.panY = py;
            actions.patchCompositeView?.({ panX: px, panY: py });
        }

        syncCanvasDOM(currentDocument);
    }

    function handleCanvasPointerUp(event) {
        if (!dragState) return;
        dragState = null;
        refs.stageWrap.classList.remove('is-dragging');
        if (event.target.releasePointerCapture) event.target.releasePointerCapture(event.pointerId);
        else if (refs.stageWrap.releasePointerCapture) refs.stageWrap.releasePointerCapture(event.pointerId);
        render(currentDocument).catch(() => {});
    }

    function handleCanvasWheel(event) {
        if (currentDocument.view.zoomLocked) return;
        const delta = event.deltaY > 0 ? -0.1 : 0.1;
        actions.patchCompositeView?.({
            zoom: Math.max(0.1, Math.min(32, (Number(currentDocument.view.zoom) || 1) + delta))
        });
        event.preventDefault();
    }

    root.addEventListener('click', async (event) => {
        const node = event.target.closest('[data-composite-action]');
        if (!node) return;
        const action = node.dataset.compositeAction;
        if (action === 'workspace-tab') {
            actions.setCompositeSidebarView?.(node.dataset.sidebarView);
            return;
        }
        if (action === 'select-layer') {
            actions.selectCompositeLayer?.(node.dataset.layerId || null);
            return;
        }
        if (action === 'toggle-layer-flip') {
            const axis = node.dataset.axis;
            const layer = currentDocument.layers.find((l) => l.id === node.dataset.layerId);
            if (layer) {
                actions.updateCompositeLayerFields?.(layer.id, {
                    [axis === 'x' ? 'flipX' : 'flipY']: !layer[axis === 'x' ? 'flipX' : 'flipY']
                });
            }
            return;
        }
        if (action === 'toggle-layer-visible') {
            actions.toggleCompositeLayerVisible?.(node.dataset.layerId);
            return;
        }
        if (action === 'toggle-layer-lock') {
            actions.toggleCompositeLayerLocked?.(node.dataset.layerId);
            return;
        }
        if (action === 'move-layer-up') {
            actions.moveCompositeLayer?.(node.dataset.layerId, 1);
            return;
        }
        if (action === 'move-layer-down') {
            actions.moveCompositeLayer?.(node.dataset.layerId, -1);
            return;
        }
        if (action === 'remove-layer') {
            actions.removeCompositeLayer?.(node.dataset.layerId);
            return;
        }
        if (action === 'toggle-checker') {
            actions.patchCompositeView?.({
                showChecker: event.target.checked
            });
            return;
        }
        if (action === 'frame-view') {
            actions.frameCompositeView?.();
            return;
        }
        if (action === 'reset-pan') {
            actions.patchCompositeView?.({ panX: 0, panY: 0 });
            return;
        }
        if (action === 'zoom-in') {
            actions.patchCompositeView?.({ zoom: Math.min(32, (Number(currentDocument.view.zoom) || 1) + 0.1) });
            return;
        }
        if (action === 'zoom-out') {
            actions.patchCompositeView?.({ zoom: Math.max(0.1, (Number(currentDocument.view.zoom) || 1) - 0.1) });
            return;
        }
        if (action === 'close-picker') {
            refs.pickerOverlay.classList.remove('is-open');
            return;
        }
        if (action === 'refresh-picker') {
            await refreshPicker();
            return;
        }
        if (action === 'toggle-picker-item') {
            const id = node.dataset.libraryId;
            if (!id) return;
            if (selectedPickerIds.has(id)) selectedPickerIds.delete(id);
            else selectedPickerIds.add(id);
            renderPicker();
            return;
        }
        if (action === 'confirm-picker') {
            await confirmPickerSelection();
            return;
        }
        if (action === 'toggle-pixel-match') {
            enablePixelMatch = !enablePixelMatch;
            renderExportPanel();
            return;
        }
    });

    root.addEventListener('input', (event) => {
        const target = event.target;
        const action = target?.dataset?.compositeAction;
        if (action === 'update-layer-number') {
            const layerId = target.dataset.layerid;
            const field = target.dataset.field;
            if (!layerId || !field) return;
            actions.updateCompositeLayerFields?.(layerId, {
                [field]: Number(target.value)
            });
            return;
        }
        if (action === 'set-layer-blend') {
            const layerId = target.dataset.layerId;
            if (!layerId) return;
            actions.updateCompositeLayerFields?.(layerId, {
                blendMode: target.value
            });
            return;
        }
        if (action === 'set-export-mode') {
            actions.patchCompositeExport?.({
                boundsMode: target.value
            });
            return;
        }
        if (action === 'set-export-preset') {
            const ratio = Number(target.value);
            if (ratio) {
                const currentWidth = currentDocument.export.bounds.width;
                actions.patchCompositeExport?.({
                    bounds: {
                        ...currentDocument.export.bounds,
                        height: Math.round(currentWidth / ratio)
                    }
                });
            }
            return;
        }
        const fieldMatch = target.id.match(/^export-res-([wh])/);
        if (fieldMatch) {
            actions.patchCompositeExport?.({
                customResolution: {
                    ...currentDocument.export.customResolution,
                    [target.dataset.field]: Number(target.value)
                }
            });
            return;
        }
    });

    refs.exportBoundsUI.addEventListener('pointerdown', handleCanvasPointerDown);
    refs.stageWrap.addEventListener('pointerdown', handleCanvasPointerDown);
    refs.stageWrap.addEventListener('pointermove', handleCanvasPointerMove);
    refs.stageWrap.addEventListener('pointerup', handleCanvasPointerUp);
    refs.stageWrap.addEventListener('pointercancel', handleCanvasPointerUp);
    refs.stageWrap.addEventListener('wheel', handleCanvasWheel, { passive: false });

    root.addEventListener('dragstart', (event) => {
        const row = event.target.closest('[data-composite-layer-row]');
        if (!row) return;
        dragLayerId = row.dataset.compositeLayerRow;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', dragLayerId || '');
    });

    root.addEventListener('dragover', (event) => {
        if (!dragLayerId) return;
        const row = event.target.closest('[data-composite-layer-row]');
        if (!row || row.dataset.compositeLayerRow === dragLayerId) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
    });

    root.addEventListener('drop', (event) => {
        const row = event.target.closest('[data-composite-layer-row]');
        const targetId = row?.dataset?.compositeLayerRow;
        if (!dragLayerId || !targetId || dragLayerId === targetId) return;
        event.preventDefault();
        actions.reorderCompositeLayer?.(dragLayerId, targetId);
        dragLayerId = null;
    });

    root.addEventListener('dragend', () => {
        dragLayerId = null;
    });

    refs.imageInput.addEventListener('change', async (event) => {
        const files = [...(event.target.files || [])];
        event.target.value = '';
        if (!files.length) return;
        await actions.addCompositeImageFiles?.(files);
    });

    refs.stateInput.addEventListener('change', async (event) => {
        const file = event.target.files?.[0] || null;
        event.target.value = '';
        if (!file) return;
        await actions.openCompositeStateFile?.(file);
    });

    return {
        activate() {
            active = true;
            root.style.display = 'block';
            
            // Initialization doesn't need WebGL context anymore
            render(currentDocument).catch((error) => {
                console.error(error);
                setStatus(error?.message || 'Could not initialize the Composite workspace.', 'error');
            });
            
            logWorkspace('info', 'Composite workspace activated.', {
                dedupeKey: 'composite-workspace-activated',
                dedupeWindowMs: 180
            });
        },
        deactivate() {
            active = false;
            root.style.display = 'none';
            refs.pickerOverlay.classList.remove('is-open');
            logWorkspace('info', 'Composite workspace hidden.', {
                dedupeKey: 'composite-workspace-hidden',
                dedupeWindowMs: 180
            });
        },
        async render(document) {
            await render(document);
        },
        openImagePicker() {
            refs.imageInput.click();
        },
        openStatePicker() {
            refs.stateInput.click();
        },
        async openProjectPicker() {
            await openProjectPicker();
        },
        setProgressOverlay(payload = null) {
            if (payload?.active) {
                progressOverlay.show(payload);
                return;
            }
            progressOverlay.hide();
        },
        exportPngBlob(document = currentDocument) {
            return engine.exportPngBlob(document);
        },
        capturePreview(document = currentDocument) {
            return engine.capturePreview(document);
        }
    };
}
