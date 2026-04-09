import { CompositeEngine } from './engine.js';
import {
    computeCompositeFramedView,
    COMPOSITE_MAX_SCALE,
    COMPOSITE_MAX_ZOOM,
    COMPOSITE_MIN_SCALE,
    COMPOSITE_MIN_ZOOM,
    computeCompositeViewBounds,
    getCompositeLayerDimensions,
    getCompositeLayerResizeMode,
    isCompositeLayerStretchCapable,
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

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeHexColor(value, fallback = '#ffffff') {
    const raw = String(value || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    return fallback;
}

function renderRangeRow(config = {}) {
    const inputId = config.id || `composite-range-${Math.random().toString(36).slice(2, 8)}`;
    const attrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    const action = escapeHtml(config.action || 'update-layer-number');
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
                    data-composite-action="${action}"
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
                    data-composite-action="${action}"
                    ${attrs}
                    ${config.disabled ? 'disabled' : ''}
                >
            </div>
        </label>
    `;
}

function renderTextInputRow(config = {}) {
    const attrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    const action = escapeHtml(config.action || 'update-layer-asset-text');
    return `
        <label class="composite-setting">
            <div class="composite-setting-label">
                <span>${escapeHtml(config.label || 'Text')}</span>
                <span>${escapeHtml(config.meta || '')}</span>
            </div>
            <input
                class="composite-text-input"
                type="text"
                value="${escapeHtml(config.value ?? '')}"
                placeholder="${escapeHtml(config.placeholder || '')}"
                data-composite-action="${action}"
                ${attrs}
                ${config.disabled ? 'disabled' : ''}
            >
        </label>
    `;
}

function renderTextAreaRow(config = {}) {
    const attrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    const action = escapeHtml(config.action || 'update-layer-asset-text');
    return `
        <label class="composite-setting">
            <div class="composite-setting-label">
                <span>${escapeHtml(config.label || 'Text')}</span>
                <span>${escapeHtml(config.meta || '')}</span>
            </div>
            <textarea
                class="composite-textarea"
                rows="${escapeHtml(config.rows ?? 3)}"
                placeholder="${escapeHtml(config.placeholder || '')}"
                data-composite-action="${action}"
                ${attrs}
                ${config.disabled ? 'disabled' : ''}
            >${escapeHtml(config.value ?? '')}</textarea>
        </label>
    `;
}

function renderSelectRow(config = {}) {
    const attrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    const action = escapeHtml(config.action || '');
    return `
        <label class="composite-select-wrap">
            <div class="composite-setting-label">
                <span>${escapeHtml(config.label || 'Option')}</span>
                <span>${escapeHtml(config.meta || '')}</span>
            </div>
            <select class="composite-select" data-composite-action="${action}" ${attrs} ${config.disabled ? 'disabled' : ''}>
                ${(config.options || []).map((option) => `
                    <option value="${escapeHtml(option.value)}" ${String(option.value) === String(config.value ?? '') ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                `).join('')}
            </select>
        </label>
    `;
}

function renderColorRow(config = {}) {
    const attrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    const action = escapeHtml(config.action || 'update-layer-color');
    const normalizedValue = normalizeHexColor(config.value, '#ffffff');
    return `
        <label class="composite-setting">
            <div class="composite-setting-label">
                <span>${escapeHtml(config.label || 'Color')}</span>
                <span>${escapeHtml(normalizedValue.toUpperCase())}</span>
            </div>
            <div class="composite-color-row">
                <input
                    class="composite-color-input"
                    type="color"
                    value="${escapeHtml(normalizedValue)}"
                    data-composite-action="${action}"
                    ${attrs}
                    ${config.disabled ? 'disabled' : ''}
                >
                <input
                    class="composite-text-input"
                    type="text"
                    value="${escapeHtml(normalizedValue.toUpperCase())}"
                    data-composite-action="${action}"
                    ${attrs}
                    ${config.disabled ? 'disabled' : ''}
                >
            </div>
        </label>
    `;
}

function renderResizeModeChooser(config = {}) {
    const options = Array.isArray(config.options) ? config.options : [];
    const currentValue = String(config.value || '');
    const disabled = !!config.disabled;
    const dataAttrs = Object.entries(config.dataset || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    return `
        <div class="composite-info-card">
            <div class="composite-setting-label">
                <span>${escapeHtml(config.label || 'Handle Mode')}</span>
                <span>${escapeHtml(options.find((option) => option.value === currentValue)?.label || '')}</span>
            </div>
            <div class="composite-mode-grid">
                ${options.map((option) => `
                    <button
                        type="button"
                        class="composite-mode-button ${String(option.value) === currentValue ? 'is-active' : ''}"
                        data-composite-action="set-layer-resize-mode-button"
                        data-resize-mode="${escapeHtml(option.value)}"
                        ${dataAttrs}
                        ${disabled ? 'disabled' : ''}
                    >${escapeHtml(option.label)}</button>
                `).join('')}
            </div>
            ${config.help ? `<span class="composite-help">${escapeHtml(config.help)}</span>` : ''}
        </div>
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

const EXPORT_ASPECT_PRESETS = [
    { value: '1.77777778', label: '16:9 Landscape', ratio: 16 / 9 },
    { value: '0.5625', label: '9:16 Portrait', ratio: 9 / 16 },
    { value: '1.33333333', label: '4:3 Landscape', ratio: 4 / 3 },
    { value: '0.75', label: '3:4 Portrait', ratio: 3 / 4 },
    { value: '1', label: '1:1 Square', ratio: 1 }
];

const RESIZE_MODE_OPTIONS = [
    { value: 'center-uniform', label: 'From Center / Keep Shape' },
    { value: 'anchor-uniform', label: 'From Opposite Side / Keep Shape' },
    { value: 'anchor-stretch', label: 'From Opposite Side / Stretch' }
];

function mapBlendLabel(mode) {
    return BLEND_MODE_OPTIONS.find(([value]) => value === mode)?.[1] || 'Normal';
}

function mapLayerKindLabel(layer) {
    if (layer?.kind === 'editor-project') return 'Editor';
    if (layer?.kind === 'text') return 'Text';
    if (layer?.kind === 'square') return 'Square';
    if (layer?.kind === 'circle') return 'Circle';
    if (layer?.kind === 'triangle') return 'Triangle';
    return 'Image';
}

export function createCompositeWorkspace(root, { actions, logger = null }) {
    root.innerHTML = `
        <style data-composite-style>
            .composite-shell{--comp-border:#b8b2a3;--comp-border-soft:rgba(184,178,163,.24);--comp-accent:rgba(184,178,163,.14);--comp-muted:#b8b2a3;position:relative;width:100%;height:100%;min-width:0;min-height:0;display:grid;grid-template-columns:minmax(248px,312px) minmax(0,1fr);gap:8px;padding:8px;background:#000;color:#fff;font-size:11px;line-height:1.3;overflow:hidden}
            .composite-shell button,.composite-shell input,.composite-shell select,.composite-shell textarea{font-size:11px!important}
            .composite-shell .mini-button,.composite-shell .toolbar-button,.composite-shell input[type="number"],.composite-shell select,.composite-text-input,.composite-textarea{min-height:22px;padding:2px 7px!important;border-radius:4px;border:1px solid var(--comp-border);background:#000;color:#fff;box-shadow:none}
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
            .composite-export-bounds.is-pick-layer,.composite-export-bounds.is-pick-layer *{pointer-events:none!important}
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
            .composite-selection-box{position:absolute;border:1px solid #f0c26d;pointer-events:none;z-index:18;display:none;box-shadow:0 0 0 1px rgba(240,194,109,.32)}
            .composite-selection-box.is-visible{display:block}
            .composite-selection-box[data-selection-mode="multi"]{border-style:dashed;box-shadow:0 0 0 1px rgba(240,194,109,.2)}
            .composite-selection-handle{position:absolute;width:12px;height:12px;background:#f0c26d;border:1px solid #fff;pointer-events:auto;z-index:19}
            .composite-selection-handle.nw{top:-6px;left:-6px;cursor:nwse-resize}
            .composite-selection-handle.ne{top:-6px;right:-6px;cursor:nesw-resize}
            .composite-selection-handle.sw{bottom:-6px;left:-6px;cursor:nesw-resize}
            .composite-selection-handle.se{bottom:-6px;right:-6px;cursor:nwse-resize}
            .composite-selection-handle.n{top:-6px;left:50%;margin-left:-6px;cursor:ns-resize}
            .composite-selection-handle.s{bottom:-6px;left:50%;margin-left:-6px;cursor:ns-resize}
            .composite-selection-handle.w{top:50%;left:-6px;margin-top:-6px;cursor:ew-resize}
            .composite-selection-handle.e{top:50%;right:-6px;margin-top:-6px;cursor:ew-resize}
            .composite-marquee{position:absolute;border:1px dashed #79d8ff;background:rgba(44,153,255,.12);pointer-events:none;z-index:17;display:none}
            .composite-marquee.is-visible{display:block}
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
            .composite-mode-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(78px,1fr));gap:6px}
            .composite-mode-button{min-height:26px;padding:6px;border:1px solid var(--comp-border);border-radius:4px;background:#000;color:var(--comp-muted);text-align:left;cursor:pointer}
            .composite-mode-button.is-active{background:var(--comp-accent);color:#fff;border-color:var(--comp-border)}
            .composite-mode-button:disabled{opacity:.45;cursor:not-allowed}
            .composite-setting{display:flex;flex-direction:column;gap:6px;color:var(--comp-muted)}
            .composite-setting-label{display:flex;align-items:center;justify-content:space-between;gap:8px}
            .composite-setting-inputs{display:grid;grid-template-columns:minmax(0,1fr) 78px;gap:6px}
            .composite-range,.composite-number,.composite-select{width:100%}
            .composite-text-input,.composite-textarea{width:100%}
            .composite-textarea{resize:vertical;min-height:72px;padding-top:6px!important;padding-bottom:6px!important}
            .composite-color-row{display:grid;grid-template-columns:52px minmax(0,1fr);gap:6px;align-items:center}
            .composite-color-input{width:100%;height:28px;padding:0!important;border-radius:4px;border:1px solid var(--comp-border);background:#000}
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
                    <div class="composite-selection-box" data-composite-role="selection-box">
                        <div class="composite-selection-handle nw" data-composite-action="layer-scale" data-dir="nw"></div>
                        <div class="composite-selection-handle n" data-composite-action="layer-scale" data-dir="n"></div>
                        <div class="composite-selection-handle ne" data-composite-action="layer-scale" data-dir="ne"></div>
                        <div class="composite-selection-handle w" data-composite-action="layer-scale" data-dir="w"></div>
                        <div class="composite-selection-handle e" data-composite-action="layer-scale" data-dir="e"></div>
                        <div class="composite-selection-handle sw" data-composite-action="layer-scale" data-dir="sw"></div>
                        <div class="composite-selection-handle s" data-composite-action="layer-scale" data-dir="s"></div>
                        <div class="composite-selection-handle se" data-composite-action="layer-scale" data-dir="se"></div>
                    </div>
                    <div class="composite-marquee" data-composite-role="marquee-box"></div>
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
                    <div class="composite-empty is-visible" data-composite-role="empty-state"><strong>Add one or more layers</strong><span>Bring in saved Editor projects, local images, text, or simple shapes to start compositing.</span></div>
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
        sidebar: root.querySelector('.composite-sidebar'),
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
        selectionUI: root.querySelector('[data-composite-role="selection-box"]'),
        marqueeUI: root.querySelector('[data-composite-role="marquee-box"]'),
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
    let sessionDocument = currentDocument;
    let pickerItems = [];
    let selectedPickerIds = new Set();
    let dragState = null;
    let dragLayerId = null;
    let enablePixelMatch = false;
    let pixelMatchMessage = '';
    let stageFrameHandle = 0;
    let wheelCommitTimer = null;
    let panelInputActive = false;
    let panelInputRefreshTimer = null;
    const panelPointerIds = new Set();
    let lastSidebarView = null;
    let selectedLayerIds = new Set();
    let selectionResizeMode = 'center-uniform';
    const layerNodes = new Map();

    function logWorkspace(level, message, options = {}) {
        if (!logger || !message) return;
        const method = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
        method('composite.workspace', 'Composite Workspace', message, options);
    }

    function setStatus(message, tone = 'info') {
        refs.status.textContent = String(message || 'Composite workspace ready.');
        refs.status.dataset.tone = tone;
    }

    function getViewportMetrics() {
        const rect = refs.stageWrap.getBoundingClientRect();
        const rawWidth = Number(rect.width) || 0;
        const rawHeight = Number(rect.height) || 0;
        return {
            width: Math.round(rawWidth >= 64 ? rawWidth : 1600),
            height: Math.round(rawHeight >= 64 ? rawHeight : 900),
            left: Number(rect.left) || 0,
            top: Number(rect.top) || 0
        };
    }

    function currentStageDocument() {
        return dragState ? sessionDocument : currentDocument;
    }

    function cloneDocument(document) {
        return normalizeCompositeDocument(document);
    }

    function isPanelEditableTarget(node) {
        if (!node || !root.contains(node)) return false;
        const tag = String(node.tagName || '').toLowerCase();
        if (!['input', 'textarea', 'select'].includes(tag)) return false;
        return node.type !== 'file' && node.type !== 'hidden';
    }

    function getStageLayerSourceDimensions(layer) {
        const runtimeAsset = engine.layerAssets.get(layer?.id);
        if (runtimeAsset?.width && runtimeAsset?.height) {
            return {
                width: Math.max(1, Number(runtimeAsset.width) || 1),
                height: Math.max(1, Number(runtimeAsset.height) || 1)
            };
        }
        return getCompositeLayerDimensions(layer);
    }

    function getStageLayerRenderedSize(layer) {
        const source = getStageLayerSourceDimensions(layer);
        return {
            width: Math.max(0.0001, source.width * getLayerScaleValue(layer, 'x')),
            height: Math.max(0.0001, source.height * getLayerScaleValue(layer, 'y'))
        };
    }

    function computeStageLayerBounds(layer) {
        const source = getStageLayerSourceDimensions(layer);
        const rendered = {
            width: source.width * getLayerScaleValue(layer, 'x'),
            height: source.height * getLayerScaleValue(layer, 'y')
        };
        const centerX = Number(layer?.x || 0) + (rendered.width * 0.5);
        const centerY = Number(layer?.y || 0) + (rendered.height * 0.5);
        const corners = [
            rotatePoint(-rendered.width * 0.5, -rendered.height * 0.5, Number(layer?.rotation) || 0),
            rotatePoint(rendered.width * 0.5, -rendered.height * 0.5, Number(layer?.rotation) || 0),
            rotatePoint(rendered.width * 0.5, rendered.height * 0.5, Number(layer?.rotation) || 0),
            rotatePoint(-rendered.width * 0.5, rendered.height * 0.5, Number(layer?.rotation) || 0)
        ].map((point) => ({
            x: point.x + centerX,
            y: point.y + centerY
        }));
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        return {
            minX: Math.min(...xs),
            minY: Math.min(...ys),
            maxX: Math.max(...xs),
            maxY: Math.max(...ys),
            width: Math.max(0, Math.max(...xs) - Math.min(...xs)),
            height: Math.max(0, Math.max(...ys) - Math.min(...ys))
        };
    }

    function syncSelectionFromDocument(document = currentDocument) {
        const normalized = normalizeCompositeDocument(document);
        const validIds = new Set(normalized.layers.map((layer) => layer.id));
        selectedLayerIds = new Set([...selectedLayerIds].filter((layerId) => validIds.has(layerId)));
        const requestedLayerId = validIds.has(normalized.selection.layerId) ? normalized.selection.layerId : null;
        if (!selectedLayerIds.size && requestedLayerId) {
            selectedLayerIds = new Set([requestedLayerId]);
        } else if (selectedLayerIds.size <= 1 && !requestedLayerId) {
            selectedLayerIds.clear();
        } else if (selectedLayerIds.size === 1 && requestedLayerId && !selectedLayerIds.has(requestedLayerId)) {
            selectedLayerIds = new Set([requestedLayerId]);
        }
        if (selectedLayerIds.size <= 1) {
            selectionResizeMode = 'center-uniform';
        }
        return normalized;
    }

    function getSelectedLayerIds(document = currentDocument) {
        syncSelectionFromDocument(document);
        return [...selectedLayerIds];
    }

    function getSelectedLayers(document = currentDocument) {
        const ids = new Set(getSelectedLayerIds(document));
        return normalizeCompositeDocument(document).layers.filter((layer) => ids.has(layer.id));
    }

    function isLayerSelected(layerId, document = currentDocument) {
        return getSelectedLayerIds(document).includes(String(layerId || ''));
    }

    function setSelectedLayers(layerIds, options = {}) {
        const normalized = normalizeCompositeDocument(options.document || currentDocument);
        const validIds = new Set(normalized.layers.map((layer) => layer.id));
        selectedLayerIds = new Set((Array.isArray(layerIds) ? layerIds : []).map((layerId) => String(layerId || '')).filter((layerId) => validIds.has(layerId)));
        if (selectedLayerIds.size <= 1) {
            selectionResizeMode = 'center-uniform';
        }
        const explicitPrimary = String(options.primaryId || '');
        const nextPrimaryId = explicitPrimary && selectedLayerIds.has(explicitPrimary)
            ? explicitPrimary
            : selectedLayerIds.size === 1
                ? [...selectedLayerIds][0]
                : selectedLayerIds.has(normalized.selection.layerId)
                    ? normalized.selection.layerId
                    : [...selectedLayerIds][0] || null;
        currentDocument = normalizeCompositeDocument({
            ...normalized,
            selection: {
                layerId: nextPrimaryId || null
            }
        });
        sessionDocument = dragState ? sessionDocument : currentDocument;
        if (options.syncStore !== false) {
            actions.selectCompositeLayer?.(nextPrimaryId || null);
        }
        if (active && !dragState) {
            render(currentDocument).catch(() => {});
        }
        return currentDocument;
    }

    function getSelectionBounds(document = currentDocument) {
        const layers = getSelectedLayers(document);
        if (!layers.length) return null;
        const boundsList = layers.map((layer) => computeStageLayerBounds(layer));
        return {
            minX: Math.min(...boundsList.map((bounds) => bounds.minX)),
            minY: Math.min(...boundsList.map((bounds) => bounds.minY)),
            maxX: Math.max(...boundsList.map((bounds) => bounds.maxX)),
            maxY: Math.max(...boundsList.map((bounds) => bounds.maxY)),
            width: Math.max(0, Math.max(...boundsList.map((bounds) => bounds.maxX)) - Math.min(...boundsList.map((bounds) => bounds.minX))),
            height: Math.max(0, Math.max(...boundsList.map((bounds) => bounds.maxY)) - Math.min(...boundsList.map((bounds) => bounds.minY)))
        };
    }

    function computeLiveDocumentBounds(document = currentStageDocument()) {
        const layers = getActiveCompositeLayers(normalizeCompositeDocument(document));
        if (!layers.length) {
            return {
                minX: 0,
                minY: 0,
                maxX: 0,
                maxY: 0,
                width: 0,
                height: 0
            };
        }
        const boundsList = layers.map((layer) => computeStageLayerBounds(layer));
        const minX = Math.min(...boundsList.map((entry) => entry.minX));
        const minY = Math.min(...boundsList.map((entry) => entry.minY));
        const maxX = Math.max(...boundsList.map((entry) => entry.maxX));
        const maxY = Math.max(...boundsList.map((entry) => entry.maxY));
        return {
            minX,
            minY,
            maxX,
            maxY,
            width: Math.max(0, maxX - minX),
            height: Math.max(0, maxY - minY)
        };
    }

    function getSelectionScreenBounds(document = currentStageDocument()) {
        const bounds = getSelectionBounds(document);
        if (!bounds) return null;
        const metrics = getViewportMetrics();
        const topLeft = engine.worldToScreen(document, metrics.width, metrics.height, bounds.minX, bounds.minY);
        const bottomRight = engine.worldToScreen(document, metrics.width, metrics.height, bounds.maxX, bounds.maxY);
        if (!topLeft || !bottomRight) return null;
        return {
            left: Math.min(topLeft.x, bottomRight.x),
            top: Math.min(topLeft.y, bottomRight.y),
            width: Math.abs(bottomRight.x - topLeft.x),
            height: Math.abs(bottomRight.y - topLeft.y)
        };
    }

    function getLayerScreenBounds(layer, document = currentStageDocument()) {
        const worldBounds = computeStageLayerBounds(layer);
        const metrics = getViewportMetrics();
        const topLeft = engine.worldToScreen(document, metrics.width, metrics.height, worldBounds.minX, worldBounds.minY);
        const bottomRight = engine.worldToScreen(document, metrics.width, metrics.height, worldBounds.maxX, worldBounds.maxY);
        if (!topLeft || !bottomRight) return null;
        return {
            left: Math.min(topLeft.x, bottomRight.x),
            top: Math.min(topLeft.y, bottomRight.y),
            right: Math.max(topLeft.x, bottomRight.x),
            bottom: Math.max(topLeft.y, bottomRight.y),
            width: Math.abs(bottomRight.x - topLeft.x),
            height: Math.abs(bottomRight.y - topLeft.y)
        };
    }

    function getSelectionResizeMode(document = currentDocument) {
        const layer = selectedLayer(document);
        return layer ? getCompositeLayerResizeMode(layer) : selectionResizeMode;
    }

    function selectedLayer(document = currentDocument) {
        const layers = getSelectedLayers(document);
        return layers.length === 1 ? layers[0] : null;
    }

    function getLayerResizeOptions(layer) {
        return RESIZE_MODE_OPTIONS.filter((option) => option.value !== 'anchor-stretch' || isCompositeLayerStretchCapable(layer));
    }

    function getLayerScaleValue(layer, axis = 'uniform') {
        const scaleX = Math.max(COMPOSITE_MIN_SCALE, Number(layer?.scaleX) || Number(layer?.scale) || 1);
        const scaleY = Math.max(COMPOSITE_MIN_SCALE, Number(layer?.scaleY) || Number(layer?.scale) || 1);
        if (axis === 'x') return scaleX;
        if (axis === 'y') return scaleY;
        return Math.max(COMPOSITE_MIN_SCALE, Number(layer?.scale) || Math.sqrt(scaleX * scaleY));
    }

    function rotatePoint(x, y, radians = 0) {
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);
        return {
            x: (x * cos) - (y * sin),
            y: (x * sin) + (y * cos)
        };
    }

    function getResizeHandleDescriptor(dir = 'se') {
        return {
            activeX: dir.includes('e') ? 1 : dir.includes('w') ? -1 : 0,
            activeY: dir.includes('s') ? 1 : dir.includes('n') ? -1 : 0
        };
    }

    function buildLayerPatchFromScales(layer, nextScaleX, nextScaleY, nextX = layer.x, nextY = layer.y) {
        const clampedScaleX = clamp(Number(nextScaleX) || 1, COMPOSITE_MIN_SCALE, COMPOSITE_MAX_SCALE);
        const clampedScaleY = clamp(Number(nextScaleY) || 1, COMPOSITE_MIN_SCALE, COMPOSITE_MAX_SCALE);
        return {
            x: nextX,
            y: nextY,
            scale: Math.sqrt(clampedScaleX * clampedScaleY),
            scaleX: clampedScaleX,
            scaleY: clampedScaleY
        };
    }

    function setSettingMeta(setting, text) {
        const metaNode = setting?.querySelector('.composite-setting-label span:last-child');
        if (metaNode) metaNode.textContent = String(text ?? '');
    }

    function syncNumericSettingInputs(target, value) {
        const setting = target?.closest('.composite-setting');
        if (!setting) return;
        const numericValue = Number(value);
        const nextValue = Number.isFinite(numericValue) ? String(numericValue) : String(value ?? '');
        setting.querySelectorAll('input.composite-range, input.composite-number').forEach((input) => {
            if (input !== target) input.value = nextValue;
        });
        setSettingMeta(setting, formatNumber(value));
    }

    function syncColorSettingInputs(target, value) {
        const setting = target?.closest('.composite-setting');
        if (!setting) return;
        const normalized = normalizeHexColor(value, '#ffffff');
        setting.querySelectorAll('input').forEach((input) => {
            if (input === target) return;
            input.value = input.type === 'color' ? normalized : normalized.toUpperCase();
        });
        setSettingMeta(setting, normalized.toUpperCase());
    }

    function syncExportResolutionInputs(resolution = {}) {
        const width = Math.max(1, Math.round(Number(resolution?.width) || 1));
        const height = Math.max(1, Math.round(Number(resolution?.height) || 1));
        root.querySelectorAll('[data-composite-action="update-export-resolution"][data-field="width"]').forEach((input) => {
            input.value = String(width);
            setSettingMeta(input.closest('.composite-setting'), formatNumber(width));
        });
        root.querySelectorAll('[data-composite-action="update-export-resolution"][data-field="height"]').forEach((input) => {
            input.value = String(height);
            setSettingMeta(input.closest('.composite-setting'), formatNumber(height));
        });
    }

    function applyResizeModeChange(control = {}) {
        if (control.selectionscope === 'multi') {
            selectionResizeMode = String(control.value || 'center-uniform');
            renderTransformPanel();
            return true;
        }
        const layerId = control.layerid;
        const layer = currentDocument.layers.find((entry) => entry.id === layerId) || null;
        if (!layer) return false;
        if (control.value === 'anchor-stretch') {
            actions.updateCompositeLayerFields?.(layerId, { resizeMode: control.value });
            return true;
        }
        const uniformScale = getLayerScaleValue(layer);
        actions.updateCompositeLayerFields?.(layerId, {
            resizeMode: control.value,
            scale: uniformScale,
            scaleX: uniformScale,
            scaleY: uniformScale
        });
        return true;
    }

    function setPanelInputActiveState(nextActive) {
        const activeState = !!nextActive;
        if (panelInputActive === activeState) return;
        panelInputActive = activeState;
        if (!panelInputActive && active && !dragState) {
            render(currentDocument).catch(() => {});
        }
    }

    function isPanelInteractionLocked() {
        return panelInputActive || panelPointerIds.size > 0;
    }

    function refreshPanelInputState() {
        if (panelInputRefreshTimer) {
            clearTimeout(panelInputRefreshTimer);
        }
        panelInputRefreshTimer = setTimeout(() => {
            panelInputRefreshTimer = null;
            setPanelInputActiveState(isPanelEditableTarget(root.ownerDocument?.activeElement));
        }, 0);
    }

    function patchLayerAsset(layerId, assetKey, field, value) {
        const layer = currentDocument.layers.find((entry) => entry.id === layerId) || null;
        if (!layer || !assetKey || !field) return;
        actions.updateCompositeLayerFields?.(layerId, {
            [assetKey]: {
                ...(layer[assetKey] || {}),
                [field]: value
            }
        });
    }

    function clearWheelCommitTimer() {
        if (wheelCommitTimer) {
            clearTimeout(wheelCommitTimer);
            wheelCommitTimer = null;
        }
    }

    function scheduleStagePaint() {
        if (stageFrameHandle) return;
        stageFrameHandle = requestAnimationFrame(() => {
            stageFrameHandle = 0;
            const document = currentStageDocument();
            updateExportBoundsUI(document);
            updateSelectedLayerUI(document);
            syncCanvasDOM(document);
        });
    }

    async function syncStageFromDocument(document = currentStageDocument()) {
        try {
            updateExportBoundsUI(document);
            await engine.syncDocument(document);
            scheduleStagePaint();
        } catch (error) {
            console.error(error);
            setStatus(error?.message || 'Could not render the composite.', 'error');
        }
    }

    function isLayerWithinExportBounds(layer, document = currentDocument) {
        const normalized = normalizeCompositeDocument(document);
        if (normalized.export.boundsMode !== 'custom') {
            return {
                eligible: false,
                reason: 'Switch Export to custom bounds before using pixel match.'
            };
        }
        if (!layer || layer.visible === false) {
            return {
                eligible: false,
                reason: 'Choose a visible layer inside the current custom bounds.'
            };
        }
        const exportBounds = normalized.export.bounds;
        const layerBounds = computeStageLayerBounds(layer);
        const contained = layerBounds.minX >= (exportBounds.x - 0.5)
            && layerBounds.maxX <= (exportBounds.x + exportBounds.width + 0.5)
            && layerBounds.minY >= (exportBounds.y - 0.5)
            && layerBounds.maxY <= (exportBounds.y + exportBounds.height + 0.5);
        if (!contained) {
            return {
                eligible: false,
                reason: 'That layer is only partially inside the current custom bounds.'
            };
        }
        const source = getStageLayerSourceDimensions(layer);
        const transformedWidth = Math.max(0.01, source.width * getLayerScaleValue(layer, 'x'));
        const transformedHeight = Math.max(0.01, source.height * getLayerScaleValue(layer, 'y'));
        return {
            eligible: true,
            reason: '',
            outputWidth: Math.max(1, Math.round(exportBounds.width * (source.width / transformedWidth))),
            outputHeight: Math.max(1, Math.round(exportBounds.height * (source.height / transformedHeight)))
        };
    }

    function getPixelMatchSummary(document = currentDocument) {
        const normalized = normalizeCompositeDocument(document);
        if (normalized.export.boundsMode !== 'custom') {
            return {
                eligibleCount: 0,
                totalVisible: normalized.layers.filter((layer) => layer.visible !== false).length,
                status: 'Pixel match is available only with custom export bounds.'
            };
        }
        const visibleLayers = normalized.layers.filter((layer) => layer.visible !== false);
        const eligibleCount = visibleLayers.filter((layer) => isLayerWithinExportBounds(layer, normalized).eligible).length;
        if (pixelMatchMessage) {
            return {
                eligibleCount,
                totalVisible: visibleLayers.length,
                status: pixelMatchMessage
            };
        }
        if (!visibleLayers.length) {
            return {
                eligibleCount,
                totalVisible: 0,
                status: 'Add at least one visible layer before using pixel match.'
            };
        }
        if (!eligibleCount) {
            return {
                eligibleCount,
                totalVisible: visibleLayers.length,
                status: 'Only layers fully inside the custom bounds can be pixel matched.'
            };
        }
        return {
            eligibleCount,
            totalVisible: visibleLayers.length,
            status: enablePixelMatch
                ? 'Click an eligible layer on the canvas to lock the export resolution to it.'
                : `${eligibleCount} visible layer${eligibleCount === 1 ? '' : 's'} can be pixel matched right now.`
        };
    }

    function commitSessionView() {
        clearWheelCommitTimer();
        if (!sessionDocument || !currentDocument) return;
        const nextView = sessionDocument.view || {};
        const prevView = currentDocument.view || {};
        if (
            Number(nextView.zoom) === Number(prevView.zoom)
            && Number(nextView.panX) === Number(prevView.panX)
            && Number(nextView.panY) === Number(prevView.panY)
        ) {
            return;
        }
        currentDocument = cloneDocument(sessionDocument);
        actions.patchCompositeView?.({
            zoom: nextView.zoom,
            panX: nextView.panX,
            panY: nextView.panY
        });
    }

    function scheduleWheelCommit() {
        clearWheelCommitTimer();
        wheelCommitTimer = setTimeout(() => {
            wheelCommitTimer = null;
            commitSessionView();
        }, 140);
    }

    function getBoundsAspect(bounds = null) {
        const width = Math.max(0.0001, Number(bounds?.width) || 0.0001);
        const height = Math.max(0.0001, Number(bounds?.height) || 0.0001);
        return width / height;
    }

    function getExportResolutionDensity(bounds = null, resolution = null) {
        const width = Math.max(0.0001, Number(bounds?.width) || 0.0001);
        const height = Math.max(0.0001, Number(bounds?.height) || 0.0001);
        const densityX = Math.max(0, Number(resolution?.width) || 0) / width;
        const densityY = Math.max(0, Number(resolution?.height) || 0) / height;
        if (densityX > 0 && densityY > 0) {
            return (densityX + densityY) * 0.5;
        }
        return densityX || densityY || 1;
    }

    function buildAspectLockedResolution(bounds, currentResolution = null, options = {}) {
        const aspect = getBoundsAspect(bounds);
        if (!(aspect > 0)) {
            return {
                width: Math.max(1, Math.round(Number(currentResolution?.width) || 1920)),
                height: Math.max(1, Math.round(Number(currentResolution?.height) || 1080))
            };
        }
        if (options.editedField === 'width') {
            const width = Math.max(1, Math.round(Number(options.editedValue) || 1));
            return {
                width,
                height: Math.max(1, Math.round(width / aspect))
            };
        }
        if (options.editedField === 'height') {
            const height = Math.max(1, Math.round(Number(options.editedValue) || 1));
            return {
                width: Math.max(1, Math.round(height * aspect)),
                height
            };
        }
        const referenceBounds = options.referenceBounds || bounds;
        const density = Math.max(0.0001, Number(options.density) || getExportResolutionDensity(referenceBounds, currentResolution));
        return {
            width: Math.max(1, Math.round((Number(bounds?.width) || 1) * density)),
            height: Math.max(1, Math.round((Number(bounds?.height) || 1) * density))
        };
    }

    function getSelectedExportPresetValue(bounds = null) {
        const aspect = getBoundsAspect(bounds);
        const match = EXPORT_ASPECT_PRESETS.find((preset) => Math.abs(preset.ratio - aspect) <= 0.015);
        return match?.value || '';
    }

    function intersectBounds(a, b) {
        if (!a || !b) return null;
        const minX = Math.max(Number(a.minX ?? a.x ?? 0), Number(b.minX ?? b.x ?? 0));
        const minY = Math.max(Number(a.minY ?? a.y ?? 0), Number(b.minY ?? b.y ?? 0));
        const maxX = Math.min(
            Number(a.maxX ?? ((a.x ?? 0) + (a.width ?? 0))),
            Number(b.maxX ?? ((b.x ?? 0) + (b.width ?? 0)))
        );
        const maxY = Math.min(
            Number(a.maxY ?? ((a.y ?? 0) + (a.height ?? 0))),
            Number(b.maxY ?? ((b.y ?? 0) + (b.height ?? 0)))
        );
        const width = maxX - minX;
        const height = maxY - minY;
        if (!(width > 0) || !(height > 0)) return null;
        return {
            minX,
            minY,
            maxX,
            maxY,
            width,
            height
        };
    }

    function unionBounds(boundsList = []) {
        const valid = (Array.isArray(boundsList) ? boundsList : []).filter((entry) => entry && entry.width > 0 && entry.height > 0);
        if (!valid.length) return null;
        const minX = Math.min(...valid.map((entry) => entry.minX));
        const minY = Math.min(...valid.map((entry) => entry.minY));
        const maxX = Math.max(...valid.map((entry) => entry.maxX));
        const maxY = Math.max(...valid.map((entry) => entry.maxY));
        return {
            minX,
            minY,
            maxX,
            maxY,
            width: Math.max(0, maxX - minX),
            height: Math.max(0, maxY - minY)
        };
    }

    function computePreferredCustomExportBounds(document = currentDocument) {
        const normalized = normalizeCompositeDocument(document);
        const liveBounds = computeLiveDocumentBounds(normalized);
        if (!(liveBounds.width > 0) || !(liveBounds.height > 0)) {
            return { ...normalized.export.bounds };
        }
        const metrics = getViewportMetrics();
        const viewBounds = computeCompositeViewBounds(normalized.view, metrics.width, metrics.height);
        const clippedLayerBounds = normalized.layers
            .filter((layer) => layer.visible !== false)
            .map((layer) => {
                const layerBounds = computeStageLayerBounds(layer);
                const clipped = intersectBounds(layerBounds, viewBounds);
                if (!clipped) return null;
                const viewportArea = Math.max(1, viewBounds.width * viewBounds.height);
                const layerArea = Math.max(1, layerBounds.width * layerBounds.height);
                const clippedArea = clipped.width * clipped.height;
                const backgroundCandidate = clippedArea >= (viewportArea * 0.94) && layerArea >= (viewportArea * 4);
                return {
                    layer,
                    layerBounds,
                    clipped,
                    backgroundCandidate
                };
            })
            .filter(Boolean);
        const preferredClippedBounds = unionBounds(
            (clippedLayerBounds.some((entry) => !entry.backgroundCandidate)
                ? clippedLayerBounds.filter((entry) => !entry.backgroundCandidate)
                : clippedLayerBounds
            ).map((entry) => entry.clipped)
        );
        if (preferredClippedBounds?.width >= 1 && preferredClippedBounds?.height >= 1) {
            return {
                x: Math.round(preferredClippedBounds.minX),
                y: Math.round(preferredClippedBounds.minY),
                width: Math.max(1, Math.round(preferredClippedBounds.width)),
                height: Math.max(1, Math.round(preferredClippedBounds.height))
            };
        }
        const intersected = intersectBounds(liveBounds, viewBounds);
        if (intersected?.width >= 1 && intersected?.height >= 1) {
            return {
                x: Math.round(intersected.minX),
                y: Math.round(intersected.minY),
                width: Math.max(1, Math.round(intersected.width)),
                height: Math.max(1, Math.round(intersected.height))
            };
        }
        return {
            x: Math.round(liveBounds.minX),
            y: Math.round(liveBounds.minY),
            width: Math.max(1, Math.round(liveBounds.width)),
            height: Math.max(1, Math.round(liveBounds.height))
        };
    }

    function rotateToLocal(pointX, pointY, radians = 0) {
        const cos = Math.cos(-radians);
        const sin = Math.sin(-radians);
        return {
            x: (pointX * cos) - (pointY * sin),
            y: (pointX * sin) + (pointY * cos)
        };
    }

    function updateMarqueeUI(rect = null) {
        if (!refs.marqueeUI) return;
        const isVisible = !!rect && rect.width > 0 && rect.height > 0;
        refs.marqueeUI.classList.toggle('is-visible', isVisible);
        if (!isVisible) return;
        refs.marqueeUI.style.left = `${rect.left}px`;
        refs.marqueeUI.style.top = `${rect.top}px`;
        refs.marqueeUI.style.width = `${rect.width}px`;
        refs.marqueeUI.style.height = `${rect.height}px`;
    }

    function buildLayerPatchMap(previousDocument, nextDocument, layerIds) {
        const previousById = new Map(normalizeCompositeDocument(previousDocument).layers.map((layer) => [layer.id, layer]));
        const nextById = new Map(normalizeCompositeDocument(nextDocument).layers.map((layer) => [layer.id, layer]));
        const patches = {};
        (Array.isArray(layerIds) ? layerIds : []).forEach((layerId) => {
            const previousLayer = previousById.get(layerId);
            const nextLayer = nextById.get(layerId);
            if (!previousLayer || !nextLayer) return;
            const patch = {};
            ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotation', 'opacity', 'blendMode', 'flipX', 'flipY'].forEach((field) => {
                if (nextLayer[field] !== previousLayer[field]) {
                    patch[field] = nextLayer[field];
                }
            });
            if (Object.keys(patch).length) {
                patches[layerId] = patch;
            }
        });
        return patches;
    }

    function applySelectionScaleToDocument(document, state, factorX, factorY) {
        const normalized = normalizeCompositeDocument(document);
        const nextFactorX = clamp(Number(factorX) || 1, COMPOSITE_MIN_SCALE, COMPOSITE_MAX_SCALE);
        const nextFactorY = clamp(Number(factorY) || 1, COMPOSITE_MIN_SCALE, COMPOSITE_MAX_SCALE);
        normalized.layers.forEach((layer) => {
            const startLayer = (state.startLayers || []).find((entry) => entry.id === layer.id);
            if (!startLayer) return;
            const nextWidth = startLayer.width * nextFactorX;
            const nextHeight = startLayer.height * nextFactorY;
            const nextCenterX = state.anchorWorldX + ((startLayer.centerX - state.anchorWorldX) * nextFactorX);
            const nextCenterY = state.anchorWorldY + ((startLayer.centerY - state.anchorWorldY) * nextFactorY);
            Object.assign(layer, buildLayerPatchFromScales(
                layer,
                startLayer.scaleX * nextFactorX,
                startLayer.scaleY * nextFactorY,
                nextCenterX - (nextWidth * 0.5),
                nextCenterY - (nextHeight * 0.5)
            ));
        });
        return normalized;
    }

    function updateSelectedLayerUI(document = currentStageDocument()) {
        if (!refs.selectionUI) return;
        const normalized = normalizeCompositeDocument(document);
        const selectedLayers = getSelectedLayers(normalized).filter((layer) => layer.visible !== false);
        const layer = selectedLayers.length === 1 ? selectedLayers[0] : null;
        const selectionBounds = selectedLayers.length > 1 ? getSelectionBounds(normalized) : null;
        const isVisible = selectedLayers.length > 0 && normalized.workspace.sidebarView !== 'export';
        refs.selectionUI.classList.toggle('is-visible', isVisible);
        refs.selectionUI.dataset.selectionMode = selectedLayers.length > 1 ? 'multi' : 'single';
        if (!isVisible) return;

        const metrics = getViewportMetrics();
        if (selectionBounds) {
            const topLeft = engine.worldToScreen(normalized, metrics.width, metrics.height, selectionBounds.minX, selectionBounds.minY);
            const bottomRight = engine.worldToScreen(normalized, metrics.width, metrics.height, selectionBounds.maxX, selectionBounds.maxY);
            if (!topLeft || !bottomRight) return;
            refs.selectionUI.style.left = `${Math.min(topLeft.x, bottomRight.x)}px`;
            refs.selectionUI.style.top = `${Math.min(topLeft.y, bottomRight.y)}px`;
            refs.selectionUI.style.width = `${Math.abs(bottomRight.x - topLeft.x)}px`;
            refs.selectionUI.style.height = `${Math.abs(bottomRight.y - topLeft.y)}px`;
            refs.selectionUI.style.transform = 'none';
            refs.selectionUI.dataset.layerId = '';
            return;
        }
        const rendered = getStageLayerRenderedSize(layer);
        const topLeft = engine.worldToScreen(normalized, metrics.width, metrics.height, layer.x, layer.y);
        if (!topLeft) return;
        const zoom = Math.max(COMPOSITE_MIN_ZOOM, Number(normalized.view.zoom) || 1);
        refs.selectionUI.style.left = `${topLeft.x}px`;
        refs.selectionUI.style.top = `${topLeft.y}px`;
        refs.selectionUI.style.width = `${rendered.width * zoom}px`;
        refs.selectionUI.style.height = `${rendered.height * zoom}px`;
        refs.selectionUI.style.transform = `rotate(${layer.rotation || 0}rad)`;
        refs.selectionUI.dataset.layerId = layer.id;
    }

    function renderLayersPanel() {
        const layers = [...currentDocument.layers].sort((a, b) => (b.z || 0) - (a.z || 0));
        if (!layers.length) {
            refs.layersPanel.innerHTML = `
                <div class="composite-info-card">
                    <strong>No layers yet</strong>
                    <span class="composite-help">Use the top toolbar to add Editor projects, images, text, or square/circle/triangle objects.</span>
                </div>
            `;
            return;
        }
        refs.layersPanel.innerHTML = `
            <div class="composite-stack">
                ${layers.map((layer) => {
                    const dimensions = getStageLayerSourceDimensions(layer);
                    const rendered = getStageLayerRenderedSize(layer);
                    const scaleLabel = Math.abs(getLayerScaleValue(layer, 'x') - getLayerScaleValue(layer, 'y')) <= 0.001
                        ? formatNumber(getLayerScaleValue(layer))
                        : `${formatNumber(getLayerScaleValue(layer, 'x'))} x ${formatNumber(getLayerScaleValue(layer, 'y'))}`;
                    const isSelected = isLayerSelected(layer.id, currentDocument);
                    return `
                        <section class="composite-card ${isSelected ? 'is-selected' : ''}" draggable="true" data-composite-layer-row="${layer.id}">
                            <button type="button" class="composite-card-main" data-composite-action="select-layer" data-layer-id="${layer.id}">
                                <strong>${escapeHtml(layer.name || 'Layer')}</strong>
                                <div class="composite-card-badges">
                                    <span class="composite-kind-badge">${escapeHtml(mapLayerKindLabel(layer))}</span>
                                    <span class="composite-kind-badge">${escapeHtml(mapBlendLabel(layer.blendMode))}</span>
                                    <span class="composite-kind-badge">${escapeHtml(formatDimensions(dimensions.width, dimensions.height))}</span>
                                </div>
                                <span>${escapeHtml(`Pos ${formatNumber(layer.x)}, ${formatNumber(layer.y)} | Scale ${scaleLabel} | Size ${formatDimensions(rendered.width, rendered.height)} | Rot ${formatNumber(layer.rotation)} deg`)}</span>
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

    function renderLayerSpecificTransformControls(layer) {
        if (layer.kind === 'text') {
            return `
                ${renderTextAreaRow({
                    label: 'Text',
                    value: layer.textAsset?.text || 'Text',
                    rows: 4,
                    action: 'update-layer-asset-text',
                    disabled: layer.locked,
                    dataset: { layerid: layer.id, asset: 'textAsset', field: 'text' }
                })}
                ${renderTextInputRow({
                    label: 'Font Family',
                    value: layer.textAsset?.fontFamily || 'Arial',
                    action: 'update-layer-asset-text',
                    disabled: layer.locked,
                    dataset: { layerid: layer.id, asset: 'textAsset', field: 'fontFamily' }
                })}
                ${renderRangeRow({
                    id: `layer-font-size-${layer.id}`,
                    label: 'Font Size',
                    value: Math.max(4, Number(layer.textAsset?.fontSize) || 96),
                    min: 4,
                    max: 512,
                    step: 1,
                    action: 'update-layer-asset-number',
                    disabled: layer.locked,
                    dataset: { layerid: layer.id, asset: 'textAsset', field: 'fontSize' }
                })}
                ${renderColorRow({
                    label: 'Text Color',
                    value: layer.textAsset?.color || '#ffffff',
                    action: 'update-layer-color',
                    disabled: layer.locked,
                    dataset: { layerid: layer.id, asset: 'textAsset', field: 'color' }
                })}
            `;
        }
        if (layer.kind === 'square' || layer.kind === 'circle' || layer.kind === 'triangle') {
            return renderColorRow({
                label: `${mapLayerKindLabel(layer)} Color`,
                value: layer.squareAsset?.color || layer.circleAsset?.color || layer.triangleAsset?.color || '#ffffff',
                action: 'update-layer-color',
                disabled: layer.locked,
                dataset: {
                    layerid: layer.id,
                    asset: layer.kind === 'square' ? 'squareAsset' : layer.kind === 'circle' ? 'circleAsset' : 'triangleAsset',
                    field: 'color'
                }
            });
        }
        return '';
    }

    function renderTransformPanel() {
        const selectedLayers = getSelectedLayers();
        const layer = selectedLayers.length === 1 ? selectedLayers[0] : null;
        if (!selectedLayers.length) {
            refs.transformPanel.innerHTML = '<div class="composite-mini-empty">Select one or more layers to edit transforms.</div>';
            return;
        }
        if (selectedLayers.length > 1) {
            const bounds = getSelectionBounds(currentDocument);
            const resizeMode = getSelectionResizeMode(currentDocument);
            refs.transformPanel.innerHTML = `
                <div class="composite-setting-stack">
                <div class="composite-info-card">
                    <div class="composite-info-line"><span>Selection</span><strong>${selectedLayers.length} layers</strong></div>
                    <div class="composite-info-line"><span>Bounds Position</span><strong>${escapeHtml(`${formatNumber(bounds?.minX || 0)}, ${formatNumber(bounds?.minY || 0)}`)}</strong></div>
                    <div class="composite-info-line"><span>Bounds Size</span><strong>${escapeHtml(formatDimensions(bounds?.width || 0, bounds?.height || 0))}</strong></div>
                </div>
                ${renderResizeModeChooser({
                    label: 'Handle Mode',
                    value: resizeMode,
                    dataset: { selectionscope: 'multi' },
                    options: RESIZE_MODE_OPTIONS,
                    help: 'Grouped handles can scale from center, from the opposite side, or stretch from the opposite side.'
                })}
                <div class="composite-info-card">
                    <span class="composite-help">Drag any selected object to move the group, use the gold handles to scale the group, or press Delete to remove the full selection.</span>
                </div>
                    <div class="composite-card-actions">
                        <button type="button" class="toolbar-button" data-composite-action="clear-selection">Clear Selection</button>
                        <button type="button" class="toolbar-button" data-composite-action="remove-selected-layers">Delete Selected</button>
                    </div>
                </div>
            `;
            return;
        }
        const dimensions = getStageLayerSourceDimensions(layer);
        const rendered = getStageLayerRenderedSize(layer);
        const resizeMode = getCompositeLayerResizeMode(layer);
        const supportsStretch = isCompositeLayerStretchCapable(layer);
        const showStretchScales = supportsStretch && resizeMode === 'anchor-stretch';
        refs.transformPanel.innerHTML = `
            <div class="composite-setting-stack">
                <div class="composite-info-card">
                    <div class="composite-info-line"><span>Layer</span><strong>${escapeHtml(layer.name || 'Layer')}</strong></div>
                    <div class="composite-info-line"><span>Type</span><strong>${escapeHtml(layer.kind === 'editor-project' ? 'Embedded Editor Project' : mapLayerKindLabel(layer))}</strong></div>
                    <div class="composite-info-line"><span>Base Size</span><strong>${escapeHtml(formatDimensions(dimensions.width, dimensions.height))}</strong></div>
                    <div class="composite-info-line"><span>Rendered Size</span><strong>${escapeHtml(formatDimensions(rendered.width, rendered.height))}</strong></div>
                </div>
                ${layer.kind === 'image' ? `
                    <div class="composite-card-actions">
                        <button type="button" class="toolbar-button" data-composite-action="convert-layer-to-editor" data-layer-id="${layer.id}" ${layer.locked ? 'disabled' : ''}>Convert + Edit In Editor</button>
                    </div>
                    <div class="composite-info-card">
                        <span class="composite-help">Converted image layers become linked Editor projects. Their generated Editor Library records are kept in sync when Composite saves to the Library.</span>
                    </div>
                ` : layer.kind === 'editor-project' ? `
                    <div class="composite-card-actions">
                        <button type="button" class="toolbar-button" data-composite-action="open-layer-in-editor" data-layer-id="${layer.id}">Open In Editor</button>
                    </div>
                ` : ''}
                <div class="composite-card-actions">
                    <button type="button" class="toolbar-button" data-composite-action="toggle-layer-flip" data-layer-id="${layer.id}" data-axis="x" ${layer.locked ? 'disabled' : ''}>${layer.flipX ? 'Unflip X' : 'Flip X'}</button>
                    <button type="button" class="toolbar-button" data-composite-action="toggle-layer-flip" data-layer-id="${layer.id}" data-axis="y" ${layer.locked ? 'disabled' : ''}>${layer.flipY ? 'Unflip Y' : 'Flip Y'}</button>
                </div>
                ${renderResizeModeChooser({
                    label: 'Handle Mode',
                    value: resizeMode,
                    disabled: layer.locked,
                    dataset: { layerid: layer.id },
                    options: getLayerResizeOptions(layer),
                    help: supportsStretch
                        ? 'This layer can also stretch or squish from the opposite side. Pick a mode here before dragging the canvas handles.'
                        : 'Pick whether the layer scales from its center or from the opposite side before dragging the canvas handles.'
                })}
                ${renderLayerSpecificTransformControls(layer)}
                ${renderRangeRow({ id: `layer-x-${layer.id}`, label: 'X Position', value: layer.x, min: -8192, max: 8192, step: 1, disabled: layer.locked, dataset: { layerid: layer.id, field: 'x' } })}
                ${renderRangeRow({ id: `layer-y-${layer.id}`, label: 'Y Position', value: layer.y, min: -8192, max: 8192, step: 1, disabled: layer.locked, dataset: { layerid: layer.id, field: 'y' } })}
                ${showStretchScales
                    ? `${renderRangeRow({ id: `layer-scale-x-${layer.id}`, label: 'Scale X', value: getLayerScaleValue(layer, 'x'), min: COMPOSITE_MIN_SCALE, max: COMPOSITE_MAX_SCALE, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'scaleX' } })}
                       ${renderRangeRow({ id: `layer-scale-y-${layer.id}`, label: 'Scale Y', value: getLayerScaleValue(layer, 'y'), min: COMPOSITE_MIN_SCALE, max: COMPOSITE_MAX_SCALE, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'scaleY' } })}`
                    : renderRangeRow({ id: `layer-scale-${layer.id}`, label: 'Scale', value: getLayerScaleValue(layer), min: COMPOSITE_MIN_SCALE, max: COMPOSITE_MAX_SCALE, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'scale' } })}
                ${renderRangeRow({ id: `layer-rotation-${layer.id}`, label: 'Rotation', value: layer.rotation, min: -6.283, max: 6.283, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'rotation' } })}
                ${renderRangeRow({ id: `layer-opacity-${layer.id}`, label: 'Opacity', value: layer.opacity, min: 0, max: 1, step: 0.01, disabled: layer.locked, dataset: { layerid: layer.id, field: 'opacity' } })}
            </div>
        `;
    }

    function renderBlendPanel() {
        const selectedLayers = getSelectedLayers();
        const layer = selectedLayers.length === 1 ? selectedLayers[0] : null;
        const bounds = computeLiveDocumentBounds(currentDocument);
        const sharedBlendMode = selectedLayers.length > 1 && selectedLayers.every((entry) => entry.blendMode === selectedLayers[0]?.blendMode)
            ? selectedLayers[0].blendMode
            : '';
        refs.blendPanel.innerHTML = `
            <div class="composite-setting-stack">
                ${selectedLayers.length > 1 ? `
                    <label class="composite-select-wrap">
                        <div class="composite-setting-label">
                            <span>Blend Mode</span>
                            <span>Apply to ${selectedLayers.length} layers</span>
                        </div>
                        <select class="composite-select" data-composite-action="set-layer-blend" data-selection-scope="multi">
                            <option value="" ${!sharedBlendMode ? 'selected' : ''}>Mixed / Set All</option>
                            ${BLEND_MODE_OPTIONS.map(([value, label]) => `<option value="${value}" ${value === sharedBlendMode ? 'selected' : ''}>${label}</option>`).join('')}
                        </select>
                    </label>
                ` : layer ? `
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
        const pixelMatch = getPixelMatchSummary(currentDocument);
        const selectedPreset = getSelectedExportPresetValue(exportState.bounds);
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
                        <div class="composite-info-line"><span>Resolution Mode</span><strong>${enablePixelMatch ? 'Pixel Match Armed' : 'Manual / Pixel Match'}</strong></div>
                    </div>
                    <label class="composite-select-wrap">
                        <div class="composite-setting-label">
                            <span>Aspect Preset</span>
                            <span>${selectedPreset ? EXPORT_ASPECT_PRESETS.find((preset) => preset.value === selectedPreset)?.label || 'Preset' : 'Custom / Freeform'}</span>
                        </div>
                        <select class="composite-select" data-composite-action="set-export-preset">
                            <option value="" ${!selectedPreset ? 'selected' : ''}>Custom / Freeform</option>
                            ${EXPORT_ASPECT_PRESETS.map((preset) => `<option value="${preset.value}" ${preset.value === selectedPreset ? 'selected' : ''}>${preset.label}</option>`).join('')}
                        </select>
                    </label>
                    ${renderRangeRow({ id: 'export-res-w', label: 'Output Width', value: exportState.customResolution?.width || 1920, min: 1, max: 8192, step: 1, action: 'update-export-resolution', dataset: { field: 'width' } })}
                    ${renderRangeRow({ id: 'export-res-h', label: 'Output Height', value: exportState.customResolution?.height || 1080, min: 1, max: 8192, step: 1, action: 'update-export-resolution', dataset: { field: 'height' } })}
                    <div class="composite-info-card">
                        <div class="composite-info-line"><span>Pixel Match</span><strong>${pixelMatch.eligibleCount}/${pixelMatch.totalVisible} eligible</strong></div>
                        <span class="composite-help">${escapeHtml(pixelMatch.status)}</span>
                    </div>
                    <div class="composite-card-actions">
                        <button type="button" class="toolbar-button" data-composite-action="set-custom-export-from-view">Use View As Export</button>
                        <button type="button" class="toolbar-button ${enablePixelMatch ? 'primary-button' : ''}" data-composite-action="toggle-pixel-match" ${pixelMatch.eligibleCount ? '' : 'disabled'}>
                            ${enablePixelMatch ? 'Click Layer on Canvas...' : 'Match Layer 1:1'}
                        </button>
                    </div>
                    <div class="composite-info-card">
                        <span class="composite-help">Export execution path is controlled in Settings &gt; Composite. Current Composite export stays on CPU 2D canvas; the setting only chooses worker vs main-thread execution.</span>
                    </div>
                ` : `
                    <div class="composite-mini-empty">Export bounds and resolution will match the full visible area of all layers together automatically.</div>
                    <div class="composite-card-actions">
                        <button type="button" class="toolbar-button" data-composite-action="set-custom-export-from-view">Use View As Export</button>
                    </div>
                    <div class="composite-info-card">
                        <span class="composite-help">Export execution path is controlled in Settings &gt; Composite. Current Composite export stays on CPU 2D canvas; the setting only chooses worker vs main-thread execution.</span>
                    </div>
                `}
            </div>
        `;
    }

    function renderStageChrome() {
        const bounds = computeLiveDocumentBounds(currentDocument);
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

    function updateExportBoundsUI(document = currentStageDocument()) {
        if (!refs.exportBoundsUI) return;
        const normalized = normalizeCompositeDocument(document);
        const isExporting = normalized.workspace.sidebarView === 'export' && normalized.export.boundsMode === 'custom';
        refs.exportBoundsUI.classList.toggle('is-visible', isExporting);
        refs.exportBoundsUI.classList.toggle('is-pick-layer', !!enablePixelMatch);
        if (!isExporting) return;

        const bounds = normalized.export.bounds;
        const metrics = getViewportMetrics();
        const topLeft = engine.worldToScreen(normalized, metrics.width, metrics.height, bounds.x, bounds.y);
        const bottomRight = engine.worldToScreen(normalized, metrics.width, metrics.height, bounds.x + bounds.width, bounds.y + bounds.height);
        if (!topLeft || !bottomRight) return;
        const left = Math.min(topLeft.x, bottomRight.x);
        const top = Math.min(topLeft.y, bottomRight.y);
        const width = Math.abs(bottomRight.x - topLeft.x);
        const height = Math.abs(bottomRight.y - topLeft.y);
        refs.exportBoundsUI.style.left = `${left}px`;
        refs.exportBoundsUI.style.top = `${top}px`;
        refs.exportBoundsUI.style.width = `${width}px`;
        refs.exportBoundsUI.style.height = `${height}px`;
    }

    function syncCanvasDOM(document) {
        if (!refs.domStage) return;
        const normalized = normalizeCompositeDocument(document);
        const metrics = getViewportMetrics();
        const viewport = engine.computeViewport(normalized, metrics.width, metrics.height, 'screen');

        refs.domStage.style.position = 'absolute';
        refs.domStage.style.top = '50%';
        refs.domStage.style.left = '50%';
        refs.domStage.style.width = '0px';
        refs.domStage.style.height = '0px';
        refs.domStage.style.transform = `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.scale}) translate(${-viewport.centerWorld.x}px, ${-viewport.centerWorld.y}px)`;

        const layers = getActiveCompositeLayers(normalized);
        const activeIds = new Set(layers.map((layer) => layer.id));
        layerNodes.forEach((node, layerId) => {
            if (activeIds.has(layerId)) return;
            node.remove();
            layerNodes.delete(layerId);
        });

        for (const layer of layers) {
            const asset = engine.layerAssets.get(layer.id);
            if (!asset?.image) continue;
            const scaledWidth = asset.width * getLayerScaleValue(layer, 'x');
            const scaledHeight = asset.height * getLayerScaleValue(layer, 'y');
            const flipScaleX = layer.flipX ? -1 : 1;
            const flipScaleY = layer.flipY ? -1 : 1;
            const cssBlendMode = layer.blendMode === 'add' ? 'plus-lighter' : layer.blendMode === 'normal' ? 'normal' : layer.blendMode;

            let node = layerNodes.get(layer.id) || null;
            if (!node) {
                node = window.document.createElement('img');
                node.className = 'composite-layer';
                node.dataset.layerId = layer.id;
                node.style.position = 'absolute';
                node.style.pointerEvents = 'auto';
                node.style.userSelect = 'none';
                node.style.transformOrigin = 'center center';
                node.draggable = false;
                layerNodes.set(layer.id, node);
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
        sortedLayers.forEach((layer) => {
            const node = layerNodes.get(layer.id);
            if (node) refs.domStage.appendChild(node);
        });
    }

    async function render(document) {
        currentDocument = normalizeCompositeDocument(document);
        syncSelectionFromDocument(currentDocument);
        const sidebarChanged = currentDocument.workspace.sidebarView !== lastSidebarView;
        if (currentDocument.workspace.sidebarView !== 'export' || currentDocument.export.boundsMode !== 'custom') {
            enablePixelMatch = false;
        }
        if (!dragState) {
            sessionDocument = currentDocument;
            refs.tabs.forEach((tab) => tab.classList.toggle('is-active', tab.dataset.sidebarView === currentDocument.workspace.sidebarView));
            refs.panels.forEach((panel) => panel.classList.toggle('is-active', panel.dataset.compositePanel === currentDocument.workspace.sidebarView));
            renderStageChrome();
            if (!isPanelInteractionLocked() || sidebarChanged) {
                renderLayersPanel();
                renderTransformPanel();
                renderBlendPanel();
                renderExportPanel();
            }
            lastSidebarView = currentDocument.workspace.sidebarView;
        }
        if (!active) return;
        await syncStageFromDocument(currentStageDocument());
    }

    function syncLayerControlInputs(layer) {
        if (!layer) return;
        root.querySelectorAll(`[data-composite-action="update-layer-number"][data-layerid="${layer.id}"][data-field="x"]`).forEach((input) => {
            input.value = String(Math.round(layer.x));
            setSettingMeta(input.closest('.composite-setting'), formatNumber(layer.x));
        });
        root.querySelectorAll(`[data-composite-action="update-layer-number"][data-layerid="${layer.id}"][data-field="y"]`).forEach((input) => {
            input.value = String(Math.round(layer.y));
            setSettingMeta(input.closest('.composite-setting'), formatNumber(layer.y));
        });
        root.querySelectorAll(`[data-composite-action="update-layer-number"][data-layerid="${layer.id}"][data-field="scale"]`).forEach((input) => {
            input.value = String(getLayerScaleValue(layer));
            setSettingMeta(input.closest('.composite-setting'), formatNumber(getLayerScaleValue(layer)));
        });
        root.querySelectorAll(`[data-composite-action="update-layer-number"][data-layerid="${layer.id}"][data-field="scaleX"]`).forEach((input) => {
            input.value = String(getLayerScaleValue(layer, 'x'));
            setSettingMeta(input.closest('.composite-setting'), formatNumber(getLayerScaleValue(layer, 'x')));
        });
        root.querySelectorAll(`[data-composite-action="update-layer-number"][data-layerid="${layer.id}"][data-field="scaleY"]`).forEach((input) => {
            input.value = String(getLayerScaleValue(layer, 'y'));
            setSettingMeta(input.closest('.composite-setting'), formatNumber(getLayerScaleValue(layer, 'y')));
        });
    }

    function beginPanDrag(event, document = currentDocument) {
        sessionDocument = cloneDocument(document);
        dragState = {
            mode: 'pan',
            pointerId: event.pointerId,
            startClientX: event.clientX,
            startClientY: event.clientY,
            startPanX: sessionDocument.view.panX || 0,
            startPanY: sessionDocument.view.panY || 0
        };
        refs.stageWrap.classList.add('is-dragging');
        refs.stageWrap.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    }

    function handleCanvasPointerDown(event) {
        if (!active) return;
        const layerNode = event.target.closest('.composite-layer');
        const layerId = layerNode ? layerNode.dataset.layerId : null;
        const selectedIds = getSelectedLayerIds(currentDocument);
        const selectedLayersNow = getSelectedLayers(currentDocument);
        const hasMultiSelection = selectedLayersNow.length > 1;
        const isSelectedHit = !!layerId && selectedIds.includes(layerId);

        if (event.button === 1) {
            beginPanDrag(event);
            return;
        }
        if (event.button === 2) {
            if (currentDocument.workspace.sidebarView !== 'export' && !layerId && !event.target.closest('[data-composite-action="layer-scale"]')) {
                const stageRect = refs.stageWrap.getBoundingClientRect();
                dragState = {
                    mode: 'marquee-select',
                    pointerId: event.pointerId,
                    startClientX: event.clientX,
                    startClientY: event.clientY,
                    stageLeft: Number(stageRect.left) || 0,
                    stageTop: Number(stageRect.top) || 0
                };
                refs.stageWrap.classList.add('is-dragging');
                refs.stageWrap.setPointerCapture?.(event.pointerId);
                updateMarqueeUI({
                    left: event.clientX - dragState.stageLeft,
                    top: event.clientY - dragState.stageTop,
                    width: 0,
                    height: 0
                });
            }
            event.preventDefault();
            return;
        }
        if (event.button !== 0) return;
        const metrics = getViewportMetrics();
        const scaleHandle = event.target.closest('[data-composite-action="layer-scale"]');

        if (scaleHandle) {
            sessionDocument = cloneDocument(currentDocument);
            if (hasMultiSelection) {
                const groupLayers = getSelectedLayers(sessionDocument);
                if (!groupLayers.length || groupLayers.some((layer) => layer.locked)) {
                    setStatus('Unlock all selected layers before transforming the grouped selection.', 'warning');
                    return;
                }
                const selectionBounds = getSelectionBounds(sessionDocument);
                if (!selectionBounds) return;
                const descriptor = getResizeHandleDescriptor(scaleHandle.dataset.dir || 'se');
                const centerX = selectionBounds.minX + (selectionBounds.width * 0.5);
                const centerY = selectionBounds.minY + (selectionBounds.height * 0.5);
                const anchorLocal = {
                    x: (-descriptor.activeX) * selectionBounds.width * 0.5,
                    y: (-descriptor.activeY) * selectionBounds.height * 0.5
                };
                dragState = {
                    mode: 'selection-scale',
                    dir: scaleHandle.dataset.dir || 'se',
                    pointerId: event.pointerId,
                    layerIds: groupLayers.map((layer) => layer.id),
                    sourceWidth: Math.max(1, selectionBounds.width),
                    sourceHeight: Math.max(1, selectionBounds.height),
                    centerX,
                    centerY,
                    rotation: 0,
                    resizeMode: getSelectionResizeMode(sessionDocument),
                    activeX: descriptor.activeX,
                    activeY: descriptor.activeY,
                    anchorNormX: -descriptor.activeX,
                    anchorNormY: -descriptor.activeY,
                    startScale: 1,
                    startScaleX: 1,
                    startScaleY: 1,
                    startHalfWidth: selectionBounds.width * 0.5,
                    startHalfHeight: selectionBounds.height * 0.5,
                    anchorWorldX: centerX + anchorLocal.x,
                    anchorWorldY: centerY + anchorLocal.y,
                    startLayers: groupLayers.map((layer) => {
                        const rendered = getStageLayerRenderedSize(layer);
                        return {
                            id: layer.id,
                            x: layer.x,
                            y: layer.y,
                            scaleX: getLayerScaleValue(layer, 'x'),
                            scaleY: getLayerScaleValue(layer, 'y'),
                            width: rendered.width,
                            height: rendered.height,
                            centerX: layer.x + (rendered.width * 0.5),
                            centerY: layer.y + (rendered.height * 0.5)
                        };
                    })
                };
                refs.stageWrap.classList.add('is-dragging');
                refs.stageWrap.setPointerCapture?.(event.pointerId);
                event.preventDefault();
                return;
            }
            const layer = selectedLayer(sessionDocument);
            if (!layer || layer.locked) return;
            const source = getStageLayerSourceDimensions(layer);
            const rendered = getStageLayerRenderedSize(layer);
            const descriptor = getResizeHandleDescriptor(scaleHandle.dataset.dir || 'se');
            const centerX = layer.x + (rendered.width * 0.5);
            const centerY = layer.y + (rendered.height * 0.5);
            const anchorLocal = {
                x: (-descriptor.activeX) * rendered.width * 0.5,
                y: (-descriptor.activeY) * rendered.height * 0.5
            };
            const anchorOffset = rotatePoint(anchorLocal.x, anchorLocal.y, Number(layer.rotation) || 0);
            dragState = {
                mode: 'layer-scale',
                dir: scaleHandle.dataset.dir || 'se',
                pointerId: event.pointerId,
                layerId: layer.id,
                sourceWidth: source.width,
                sourceHeight: source.height,
                centerX,
                centerY,
                rotation: Number(layer.rotation) || 0,
                resizeMode: getCompositeLayerResizeMode(layer),
                activeX: descriptor.activeX,
                activeY: descriptor.activeY,
                anchorNormX: -descriptor.activeX,
                anchorNormY: -descriptor.activeY,
                startScale: getLayerScaleValue(layer),
                startScaleX: getLayerScaleValue(layer, 'x'),
                startScaleY: getLayerScaleValue(layer, 'y'),
                startHalfWidth: rendered.width * 0.5,
                startHalfHeight: rendered.height * 0.5,
                anchorWorldX: centerX + anchorOffset.x,
                anchorWorldY: centerY + anchorOffset.y
            };
            refs.stageWrap.classList.add('is-dragging');
            refs.stageWrap.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            return;
        }

        if (event.target.closest('[data-composite-action^="bounds-"]')) {
            sessionDocument = cloneDocument(currentDocument);
            const action = event.target.closest('[data-composite-action]').dataset.compositeAction;
            const dir = event.target.dataset.dir || '';
            const bounds = sessionDocument.export.bounds;
            const world = engine.screenToWorld(sessionDocument, metrics.width, metrics.height, event.clientX, event.clientY, metrics.left, metrics.top);
            dragState = {
                mode: action === 'bounds-resize' ? 'bounds-resize' : 'bounds-move',
                dir,
                pointerId: event.pointerId,
                startWorldX: world.x,
                startWorldY: world.y,
                startBounds: { ...bounds },
                startResolution: { ...(sessionDocument.export.customResolution || {}) }
            };
            refs.stageWrap.classList.add('is-dragging');
            refs.stageWrap.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            return;
        }

        const isExportMode = currentDocument.workspace.sidebarView === 'export';

        if (isExportMode) {
            if (enablePixelMatch && layerId) {
                const layer = currentDocument.layers.find((entry) => entry.id === layerId) || null;
                const pixelMatch = isLayerWithinExportBounds(layer, currentDocument);
                enablePixelMatch = false;
                if (!pixelMatch.eligible) {
                    pixelMatchMessage = pixelMatch.reason;
                    renderExportPanel();
                    setStatus(pixelMatch.reason, 'warning');
                    event.preventDefault();
                    return;
                }
                pixelMatchMessage = `Resolution matched 1:1 with "${layer?.name || 'Layer'}".`;
                actions.patchCompositeExport?.({
                    customResolution: {
                        width: pixelMatch.outputWidth,
                        height: pixelMatch.outputHeight
                    }
                });
                renderExportPanel();
                setStatus(pixelMatchMessage, 'success');
                event.preventDefault();
                return;
            }
            beginPanDrag(event);
            return;
        }

        if ((event.ctrlKey || event.metaKey || event.shiftKey) && layerId) {
            const nextIds = isSelectedHit
                ? selectedIds.filter((entryId) => entryId !== layerId)
                : [...selectedIds, layerId];
            setSelectedLayers(nextIds, { primaryId: layerId });
            event.preventDefault();
            return;
        }

        if (layerId && !isSelectedHit) {
            setSelectedLayers([layerId], { primaryId: layerId });
        } else if (!layerId && selectedIds.length) {
            setSelectedLayers([], { primaryId: null });
        }
        sessionDocument = cloneDocument(currentDocument);
        const sessionSelectedLayers = getSelectedLayers(sessionDocument);
        const sessionLayer = layerId ? sessionDocument.layers.find((entry) => entry.id === layerId) || null : null;
        if (layerId && isSelectedHit && sessionSelectedLayers.length > 1) {
            if (sessionSelectedLayers.some((layer) => layer.locked)) {
                setStatus('Unlock all selected layers before moving the grouped selection.', 'warning');
                event.preventDefault();
                return;
            }
            const world = engine.screenToWorld(sessionDocument, metrics.width, metrics.height, event.clientX, event.clientY, metrics.left, metrics.top);
            dragState = {
                mode: 'selection-move',
                pointerId: event.pointerId,
                layerIds: sessionSelectedLayers.map((layer) => layer.id),
                startWorldX: world.x,
                startWorldY: world.y,
                startLayers: sessionSelectedLayers.map((layer) => ({
                    id: layer.id,
                    x: layer.x,
                    y: layer.y
                }))
            };
        } else if (sessionLayer && !sessionLayer.locked) {
            const world = engine.screenToWorld(sessionDocument, metrics.width, metrics.height, event.clientX, event.clientY, metrics.left, metrics.top);
            dragState = {
                mode: 'layer',
                pointerId: event.pointerId,
                layerId: sessionLayer.id,
                startWorldX: world.x,
                startWorldY: world.y,
                startLayerX: sessionLayer.x,
                startLayerY: sessionLayer.y
            };
        } else {
            beginPanDrag(event, sessionDocument);
            return;
        }

        refs.stageWrap.classList.add('is-dragging');
        refs.stageWrap.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    }

    function handleCanvasPointerMove(event) {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const metrics = getViewportMetrics();
        const world = engine.screenToWorld(sessionDocument, metrics.width, metrics.height, event.clientX, event.clientY, metrics.left, metrics.top);

        if (dragState.mode === 'marquee-select') {
            updateMarqueeUI({
                left: Math.min(dragState.startClientX, event.clientX) - dragState.stageLeft,
                top: Math.min(dragState.startClientY, event.clientY) - dragState.stageTop,
                width: Math.abs(event.clientX - dragState.startClientX),
                height: Math.abs(event.clientY - dragState.startClientY)
            });
        } else if (dragState.mode === 'bounds-move') {
            sessionDocument.export.bounds.x = dragState.startBounds.x + (world.x - dragState.startWorldX);
            sessionDocument.export.bounds.y = dragState.startBounds.y + (world.y - dragState.startWorldY);
            pixelMatchMessage = '';
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
            sessionDocument.export.bounds = patch;
            sessionDocument.export.customResolution = buildAspectLockedResolution(patch, dragState.startResolution, {
                referenceBounds: dragState.startBounds
            });
            pixelMatchMessage = '';
        } else if (dragState.mode === 'selection-scale') {
            const local = rotateToLocal(
                world.x - dragState.centerX,
                world.y - dragState.centerY,
                dragState.rotation
            );
            if (dragState.resizeMode === 'center-uniform') {
                const factorCandidates = [];
                if (dragState.activeX !== 0) {
                    factorCandidates.push((Math.abs(local.x) * 2) / Math.max(1, dragState.sourceWidth));
                }
                if (dragState.activeY !== 0) {
                    factorCandidates.push((Math.abs(local.y) * 2) / Math.max(1, dragState.sourceHeight));
                }
                const uniformFactor = clamp(
                    factorCandidates.length ? Math.max(...factorCandidates) : 1,
                    COMPOSITE_MIN_SCALE,
                    COMPOSITE_MAX_SCALE
                );
                applySelectionScaleToDocument(sessionDocument, dragState, uniformFactor, uniformFactor);
            } else {
                const startAnchorX = dragState.anchorNormX * dragState.startHalfWidth;
                const startAnchorY = dragState.anchorNormY * dragState.startHalfHeight;
                const startActiveX = dragState.activeX * dragState.startHalfWidth;
                const startActiveY = dragState.activeY * dragState.startHalfHeight;
                const ratioX = dragState.activeX !== 0
                    ? Math.abs(local.x - startAnchorX) / Math.max(0.0001, Math.abs(startActiveX - startAnchorX))
                    : 1;
                const ratioY = dragState.activeY !== 0
                    ? Math.abs(local.y - startAnchorY) / Math.max(0.0001, Math.abs(startActiveY - startAnchorY))
                    : 1;
                if (dragState.resizeMode === 'anchor-stretch') {
                    applySelectionScaleToDocument(
                        sessionDocument,
                        dragState,
                        dragState.activeX !== 0 ? ratioX : 1,
                        dragState.activeY !== 0 ? ratioY : 1
                    );
                } else {
                    const uniformFactor = clamp(
                        [dragState.activeX !== 0 ? ratioX : null, dragState.activeY !== 0 ? ratioY : null].filter((value) => value != null).reduce((maxValue, value) => Math.max(maxValue, value), 1),
                        COMPOSITE_MIN_SCALE,
                        COMPOSITE_MAX_SCALE
                    );
                    applySelectionScaleToDocument(sessionDocument, dragState, uniformFactor, uniformFactor);
                }
            }
        } else if (dragState.mode === 'layer-scale') {
            const layer = sessionDocument.layers.find((entry) => entry.id === dragState.layerId) || null;
            if (layer) {
                const local = rotateToLocal(
                    world.x - dragState.centerX,
                    world.y - dragState.centerY,
                    dragState.rotation
                );
                if (dragState.resizeMode === 'center-uniform') {
                    const scaleCandidates = [];
                    if (dragState.activeX !== 0) {
                        scaleCandidates.push((Math.abs(local.x) * 2) / Math.max(1, dragState.sourceWidth));
                    }
                    if (dragState.activeY !== 0) {
                        scaleCandidates.push((Math.abs(local.y) * 2) / Math.max(1, dragState.sourceHeight));
                    }
                    const nextScale = clamp(
                        scaleCandidates.length ? Math.max(...scaleCandidates) : dragState.startScale,
                        COMPOSITE_MIN_SCALE,
                        COMPOSITE_MAX_SCALE
                    );
                    Object.assign(layer, buildLayerPatchFromScales(
                        layer,
                        nextScale,
                        nextScale,
                        dragState.centerX - ((dragState.sourceWidth * nextScale) * 0.5),
                        dragState.centerY - ((dragState.sourceHeight * nextScale) * 0.5)
                    ));
                } else {
                    const startAnchorX = dragState.anchorNormX * dragState.startHalfWidth;
                    const startAnchorY = dragState.anchorNormY * dragState.startHalfHeight;
                    const startActiveX = dragState.activeX * dragState.startHalfWidth;
                    const startActiveY = dragState.activeY * dragState.startHalfHeight;
                    const ratioX = dragState.activeX !== 0
                        ? Math.abs(local.x - startAnchorX) / Math.max(0.0001, Math.abs(startActiveX - startAnchorX))
                        : 1;
                    const ratioY = dragState.activeY !== 0
                        ? Math.abs(local.y - startAnchorY) / Math.max(0.0001, Math.abs(startActiveY - startAnchorY))
                        : 1;

                    let nextScaleX = dragState.startScaleX;
                    let nextScaleY = dragState.startScaleY;

                    if (dragState.resizeMode === 'anchor-stretch') {
                        nextScaleX = dragState.activeX !== 0 ? dragState.startScaleX * clamp(ratioX, COMPOSITE_MIN_SCALE, COMPOSITE_MAX_SCALE) : dragState.startScaleX;
                        nextScaleY = dragState.activeY !== 0 ? dragState.startScaleY * clamp(ratioY, COMPOSITE_MIN_SCALE, COMPOSITE_MAX_SCALE) : dragState.startScaleY;
                    } else {
                        const factorCandidates = [];
                        if (dragState.activeX !== 0) factorCandidates.push(ratioX);
                        if (dragState.activeY !== 0) factorCandidates.push(ratioY);
                        const uniformFactor = clamp(
                            factorCandidates.length ? Math.max(...factorCandidates) : 1,
                            COMPOSITE_MIN_SCALE,
                            COMPOSITE_MAX_SCALE
                        );
                        nextScaleX = dragState.startScaleX * uniformFactor;
                        nextScaleY = dragState.startScaleY * uniformFactor;
                    }

                    const nextHalfWidth = (dragState.sourceWidth * nextScaleX) * 0.5;
                    const nextHalfHeight = (dragState.sourceHeight * nextScaleY) * 0.5;
                    const centerOffset = rotatePoint(
                        dragState.anchorNormX * nextHalfWidth,
                        dragState.anchorNormY * nextHalfHeight,
                        dragState.rotation
                    );
                    const nextCenterX = dragState.anchorWorldX - centerOffset.x;
                    const nextCenterY = dragState.anchorWorldY - centerOffset.y;
                    Object.assign(layer, buildLayerPatchFromScales(
                        layer,
                        nextScaleX,
                        nextScaleY,
                        nextCenterX - nextHalfWidth,
                        nextCenterY - nextHalfHeight
                    ));
                }
                syncLayerControlInputs(layer);
            }
        } else if (dragState.mode === 'selection-move') {
            const deltaX = world.x - dragState.startWorldX;
            const deltaY = world.y - dragState.startWorldY;
            dragState.startLayers.forEach((startLayer) => {
                const layer = sessionDocument.layers.find((entry) => entry.id === startLayer.id) || null;
                if (!layer) return;
                layer.x = startLayer.x + deltaX;
                layer.y = startLayer.y + deltaY;
            });
        } else if (dragState.mode === 'layer') {
            const layer = sessionDocument.layers.find((entry) => entry.id === dragState.layerId) || null;
            if (layer) {
                layer.x = dragState.startLayerX + (world.x - dragState.startWorldX);
                layer.y = dragState.startLayerY + (world.y - dragState.startWorldY);
                syncLayerControlInputs(layer);
            }
        } else if (dragState.mode === 'pan') {
            sessionDocument.view.panX = dragState.startPanX + (event.clientX - dragState.startClientX);
            sessionDocument.view.panY = dragState.startPanY + (event.clientY - dragState.startClientY);
        }

        scheduleStagePaint();
        event.preventDefault();
    }

    function handleCanvasPointerUp(event) {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const completedDrag = dragState;
        dragState = null;
        refs.stageWrap.classList.remove('is-dragging');
        refs.stageWrap.releasePointerCapture?.(event.pointerId);
        updateMarqueeUI(null);

        if (completedDrag.mode === 'marquee-select') {
            const selectionRect = {
                left: Math.min(completedDrag.startClientX, event.clientX) - completedDrag.stageLeft,
                top: Math.min(completedDrag.startClientY, event.clientY) - completedDrag.stageTop,
                right: Math.max(completedDrag.startClientX, event.clientX) - completedDrag.stageLeft,
                bottom: Math.max(completedDrag.startClientY, event.clientY) - completedDrag.stageTop
            };
            const hits = normalizeCompositeDocument(currentDocument).layers
                .filter((layer) => layer.visible !== false)
                .sort((a, b) => (b.z || 0) - (a.z || 0))
                .filter((layer) => {
                    const screenBounds = getLayerScreenBounds(layer, currentDocument);
                    if (!screenBounds) return false;
                    return screenBounds.left <= selectionRect.right
                        && screenBounds.right >= selectionRect.left
                        && screenBounds.top <= selectionRect.bottom
                        && screenBounds.bottom >= selectionRect.top;
                })
                .map((layer) => layer.id);
            setSelectedLayers(hits, { primaryId: hits[0] || null });
            return;
        }

        const nextDocument = cloneDocument(sessionDocument);
        const previousDocument = currentDocument;
        currentDocument = nextDocument;
        sessionDocument = nextDocument;

        if (completedDrag.mode === 'layer') {
            const previousLayer = previousDocument.layers.find((entry) => entry.id === completedDrag.layerId) || null;
            const nextLayer = nextDocument.layers.find((entry) => entry.id === completedDrag.layerId) || null;
            if (nextLayer && previousLayer && (nextLayer.x !== previousLayer.x || nextLayer.y !== previousLayer.y)) {
                actions.updateCompositeLayerFields?.(completedDrag.layerId, {
                    x: nextLayer.x,
                    y: nextLayer.y
                });
            }
        } else if (completedDrag.mode === 'layer-scale') {
            const previousLayer = previousDocument.layers.find((entry) => entry.id === completedDrag.layerId) || null;
            const nextLayer = nextDocument.layers.find((entry) => entry.id === completedDrag.layerId) || null;
            if (
                nextLayer
                && previousLayer
                && (
                    nextLayer.x !== previousLayer.x
                    || nextLayer.y !== previousLayer.y
                    || nextLayer.scale !== previousLayer.scale
                    || nextLayer.scaleX !== previousLayer.scaleX
                    || nextLayer.scaleY !== previousLayer.scaleY
                )
            ) {
                actions.updateCompositeLayerFields?.(completedDrag.layerId, {
                    x: nextLayer.x,
                    y: nextLayer.y,
                    scale: nextLayer.scale,
                    scaleX: nextLayer.scaleX,
                    scaleY: nextLayer.scaleY
                });
            }
        } else if (completedDrag.mode === 'selection-move' || completedDrag.mode === 'selection-scale') {
            const patches = buildLayerPatchMap(previousDocument, nextDocument, completedDrag.layerIds || []);
            if (Object.keys(patches).length) {
                actions.updateCompositeLayerBatch?.(patches);
            }
        } else if (completedDrag.mode === 'pan') {
            const nextView = nextDocument.view;
            const previousView = previousDocument.view;
            if (nextView.panX !== previousView.panX || nextView.panY !== previousView.panY) {
                actions.patchCompositeView?.({
                    panX: nextView.panX,
                    panY: nextView.panY
                });
            }
        } else if (completedDrag.mode === 'bounds-move' || completedDrag.mode === 'bounds-resize') {
            const nextBounds = nextDocument.export.bounds;
            const previousBounds = previousDocument.export.bounds;
            if (
                nextBounds.x !== previousBounds.x
                || nextBounds.y !== previousBounds.y
                || nextBounds.width !== previousBounds.width
                || nextBounds.height !== previousBounds.height
            ) {
                actions.patchCompositeExport?.({
                    bounds: { ...nextBounds },
                    ...(completedDrag.mode === 'bounds-resize'
                        ? { customResolution: { ...nextDocument.export.customResolution } }
                        : {})
                });
            }
        }

        render(nextDocument).catch(() => {});
    }

    function handleCanvasWheel(event) {
        if (!active || dragState || currentDocument.view.zoomLocked) return;
        const metrics = getViewportMetrics();
        sessionDocument = cloneDocument(currentDocument);
        const currentZoom = Math.max(COMPOSITE_MIN_ZOOM, Number(sessionDocument.view.zoom) || 1);
        const zoomFactor = Math.exp(-Number(event.deltaY || 0) * 0.0015);
        const nextZoom = clamp(currentZoom * zoomFactor, COMPOSITE_MIN_ZOOM, COMPOSITE_MAX_ZOOM);
        if (nextZoom === Number(sessionDocument.view.zoom || 1)) {
            event.preventDefault();
            return;
        }
        const world = engine.screenToWorld(sessionDocument, metrics.width, metrics.height, event.clientX, event.clientY, metrics.left, metrics.top);
        const screenX = event.clientX - metrics.left;
        const screenY = event.clientY - metrics.top;
        sessionDocument.view.zoom = nextZoom;
        sessionDocument.view.panX = screenX - (metrics.width * 0.5) - (world.x * nextZoom);
        sessionDocument.view.panY = screenY - (metrics.height * 0.5) - (world.y * nextZoom);
        scheduleStagePaint();
        scheduleWheelCommit();
        event.preventDefault();
    }

    root.addEventListener('click', async (event) => {
        const node = event.target.closest('[data-composite-action]');
        if (!node) return;
        const action = node.dataset.compositeAction;
        if (action === 'workspace-tab') {
            setPanelInputActiveState(false);
            actions.setCompositeSidebarView?.(node.dataset.sidebarView);
            return;
        }
        if (action === 'set-layer-resize-mode-button') {
            applyResizeModeChange({
                value: node.dataset.resizeMode,
                layerid: node.dataset.layerid,
                selectionscope: node.dataset.selectionscope
            });
            return;
        }
        if (action === 'select-layer') {
            const layerId = node.dataset.layerId || null;
            if (!layerId) return;
            if (event.ctrlKey || event.metaKey || event.shiftKey) {
                const nextIds = isLayerSelected(layerId)
                    ? getSelectedLayerIds().filter((entryId) => entryId !== layerId)
                    : [...getSelectedLayerIds(), layerId];
                setSelectedLayers(nextIds, { primaryId: layerId });
                return;
            }
            setSelectedLayers([layerId], { primaryId: layerId });
            return;
        }
        if (action === 'clear-selection') {
            setSelectedLayers([], { primaryId: null });
            return;
        }
        if (action === 'remove-selected-layers') {
            const ids = getSelectedLayerIds();
            if (!ids.length) return;
            actions.removeCompositeLayers?.(ids);
            selectedLayerIds.clear();
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
        if (action === 'convert-layer-to-editor') {
            await actions.convertCompositeLayerToEditorProject?.(node.dataset.layerId, {
                openInEditor: true
            });
            return;
        }
        if (action === 'open-layer-in-editor') {
            await actions.openCompositeLayerInEditor?.(node.dataset.layerId);
            return;
        }
        if (action === 'toggle-checker') {
            const input = node.matches('input') ? node : node.querySelector('input');
            if (actions.updateAppSetting) {
                actions.updateAppSetting('composite.preferences.showChecker', !!input?.checked);
            } else {
                actions.patchCompositeView?.({
                    showChecker: !!input?.checked
                });
            }
            return;
        }
        if (action === 'frame-view') {
            const bounds = computeLiveDocumentBounds(currentDocument);
            const metrics = getViewportMetrics();
            const framedView = computeCompositeFramedView(bounds, metrics.width, metrics.height, {
                paddingPx: 48,
                minZoom: COMPOSITE_MIN_ZOOM,
                maxZoom: COMPOSITE_MAX_ZOOM
            });
            actions.patchCompositeView?.({
                zoom: framedView.zoom,
                panX: framedView.panX,
                panY: framedView.panY
            });
            return;
        }
        if (action === 'reset-pan') {
            actions.patchCompositeView?.({ panX: 0, panY: 0 });
            return;
        }
        if (action === 'zoom-in') {
            actions.patchCompositeView?.({ zoom: clamp((Number(currentDocument.view.zoom) || 1) * 1.25, COMPOSITE_MIN_ZOOM, COMPOSITE_MAX_ZOOM) });
            return;
        }
        if (action === 'zoom-out') {
            actions.patchCompositeView?.({ zoom: clamp((Number(currentDocument.view.zoom) || 1) / 1.25, COMPOSITE_MIN_ZOOM, COMPOSITE_MAX_ZOOM) });
            return;
        }
        if (action === 'set-custom-export-from-view') {
            const nextBounds = computePreferredCustomExportBounds(currentDocument);
            actions.setCompositeSidebarView?.('export');
            actions.patchCompositeExport?.({
                boundsMode: 'custom',
                bounds: nextBounds,
                customResolution: buildAspectLockedResolution(nextBounds, currentDocument.export.customResolution, {
                    referenceBounds: currentDocument.export.bounds
                })
            });
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
            const pixelMatch = getPixelMatchSummary(currentDocument);
            if (currentDocument.export.boundsMode !== 'custom' || !pixelMatch.eligibleCount) {
                pixelMatchMessage = pixelMatch.status;
                renderExportPanel();
                setStatus(pixelMatchMessage, 'warning');
                return;
            }
            enablePixelMatch = !enablePixelMatch;
            if (enablePixelMatch) {
                pixelMatchMessage = '';
            }
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
            const layer = currentDocument.layers.find((entry) => entry.id === layerId) || null;
            if (!layer) return;
            const numericValue = Number(target.value);
            if (!Number.isFinite(numericValue)) return;
            syncNumericSettingInputs(target, numericValue);
            if (field === 'scale') {
                actions.updateCompositeLayerFields?.(layerId, {
                    scale: numericValue,
                    scaleX: numericValue,
                    scaleY: numericValue
                });
                return;
            }
            if (field === 'scaleX') {
                actions.updateCompositeLayerFields?.(layerId, {
                    scaleX: numericValue,
                    scale: Math.sqrt(Math.max(0.01, numericValue) * Math.max(0.01, getLayerScaleValue(layer, 'y')))
                });
                return;
            }
            if (field === 'scaleY') {
                actions.updateCompositeLayerFields?.(layerId, {
                    scaleY: numericValue,
                    scale: Math.sqrt(Math.max(0.01, numericValue) * Math.max(0.01, getLayerScaleValue(layer, 'x')))
                });
                return;
            }
            actions.updateCompositeLayerFields?.(layerId, {
                [field]: numericValue
            });
            return;
        }
        if (action === 'update-layer-asset-text') {
            const layerId = target.dataset.layerid;
            const assetKey = target.dataset.asset;
            const field = target.dataset.field;
            if (!layerId || !assetKey || !field) return;
            patchLayerAsset(layerId, assetKey, field, target.value);
            return;
        }
        if (action === 'update-layer-asset-number') {
            const layerId = target.dataset.layerid;
            const assetKey = target.dataset.asset;
            const field = target.dataset.field;
            const numericValue = Number(target.value);
            if (!layerId || !assetKey || !field || !Number.isFinite(numericValue)) return;
            syncNumericSettingInputs(target, numericValue);
            patchLayerAsset(layerId, assetKey, field, numericValue);
            return;
        }
        if (action === 'update-layer-color') {
            const layerId = target.dataset.layerid;
            const assetKey = target.dataset.asset;
            const field = target.dataset.field;
            const rawValue = String(target.value || '').trim();
            if (!layerId || !assetKey || !field || !/^#?[0-9a-fA-F]{6}$/.test(rawValue)) return;
            const normalizedValue = normalizeHexColor(rawValue);
            syncColorSettingInputs(target, normalizedValue);
            patchLayerAsset(layerId, assetKey, field, normalizedValue);
            return;
        }
        if (action === 'set-layer-blend') {
            if (target.dataset.selectionScope === 'multi') {
                if (!target.value) return;
                const patches = {};
                getSelectedLayerIds().forEach((layerId) => {
                    patches[layerId] = { blendMode: target.value };
                });
                if (Object.keys(patches).length) {
                    actions.updateCompositeLayerBatch?.(patches);
                }
                return;
            }
            const layerId = target.dataset.layerId;
            if (!layerId) return;
            actions.updateCompositeLayerFields?.(layerId, {
                blendMode: target.value
            });
            return;
        }
        if (action === 'set-layer-resize-mode') {
            if (applyResizeModeChange({
                value: target.value,
                layerid: target.dataset.layerid,
                selectionscope: target.dataset.selectionscope
            })) {
                return;
            }
        }
        if (action === 'update-export-resolution') {
            const field = target.dataset.field;
            if (!field) return;
            enablePixelMatch = false;
            pixelMatchMessage = '';
            const nextResolution = buildAspectLockedResolution(currentDocument.export.bounds, currentDocument.export.customResolution, {
                editedField: field,
                editedValue: Number(target.value)
            });
            syncExportResolutionInputs(nextResolution);
            actions.patchCompositeExport?.({
                customResolution: nextResolution
            });
            return;
        }
        if (action === 'set-export-mode') {
            enablePixelMatch = false;
            pixelMatchMessage = '';
            if (target.value === 'custom') {
                const nextBounds = computePreferredCustomExportBounds(currentDocument);
                actions.patchCompositeExport?.({
                    boundsMode: 'custom',
                    bounds: nextBounds,
                    customResolution: buildAspectLockedResolution(nextBounds, currentDocument.export.customResolution, {
                        referenceBounds: currentDocument.export.bounds
                    })
                });
                return;
            }
            actions.patchCompositeExport?.({
                boundsMode: 'auto'
            });
            return;
        }
        if (action === 'set-export-preset') {
            const ratio = Number(target.value);
            if (ratio) {
                enablePixelMatch = false;
                const area = Math.max(1, Number(currentDocument.export.bounds.width || 1) * Number(currentDocument.export.bounds.height || 1));
                const centerX = currentDocument.export.bounds.x + (currentDocument.export.bounds.width * 0.5);
                const centerY = currentDocument.export.bounds.y + (currentDocument.export.bounds.height * 0.5);
                const width = Math.max(1, Math.round(Math.sqrt(area * ratio)));
                const height = Math.max(1, Math.round(width / ratio));
                const nextBounds = {
                    x: Math.round(centerX - (width * 0.5)),
                    y: Math.round(centerY - (height * 0.5)),
                    width,
                    height
                };
                pixelMatchMessage = '';
                actions.patchCompositeExport?.({
                    bounds: nextBounds,
                    customResolution: buildAspectLockedResolution(nextBounds, currentDocument.export.customResolution, {
                        referenceBounds: currentDocument.export.bounds
                    })
                });
            }
            return;
        }
    });

    root.addEventListener('focusin', (event) => {
        if (panelInputRefreshTimer) {
            clearTimeout(panelInputRefreshTimer);
            panelInputRefreshTimer = null;
        }
        if (isPanelEditableTarget(event.target)) {
            setPanelInputActiveState(true);
        }
    });

    root.addEventListener('focusout', () => {
        refreshPanelInputState();
    });

    root.addEventListener('pointerdown', (event) => {
        if (!refs.sidebar?.contains(event.target)) return;
        if (!isPanelEditableTarget(event.target)) return;
        panelPointerIds.add(event.pointerId);
        if (panelInputRefreshTimer) {
            clearTimeout(panelInputRefreshTimer);
            panelInputRefreshTimer = null;
        }
        setPanelInputActiveState(true);
    });

    window.addEventListener('pointerup', (event) => {
        if (!panelPointerIds.delete(event.pointerId)) return;
        refreshPanelInputState();
    });

    window.addEventListener('pointercancel', (event) => {
        if (!panelPointerIds.delete(event.pointerId)) return;
        refreshPanelInputState();
    });

    refs.stageWrap.addEventListener('pointerdown', handleCanvasPointerDown);
    refs.stageWrap.addEventListener('pointermove', handleCanvasPointerMove);
    refs.stageWrap.addEventListener('pointerup', handleCanvasPointerUp);
    refs.stageWrap.addEventListener('pointercancel', handleCanvasPointerUp);
    refs.stageWrap.addEventListener('wheel', handleCanvasWheel, { passive: false });
    refs.stageWrap.addEventListener('mousedown', (event) => {
        if (event.button === 1) {
            event.preventDefault();
        }
    });
    refs.stageWrap.addEventListener('auxclick', (event) => {
        if (event.button === 1) {
            event.preventDefault();
        }
    });
    refs.stageWrap.addEventListener('contextmenu', (event) => {
        event.preventDefault();
    });

    window.addEventListener('keydown', (event) => {
        if (!active) return;
        if (event.key !== 'Delete') return;
        if (refs.pickerOverlay.classList.contains('is-open')) return;
        if (isPanelEditableTarget(root.ownerDocument?.activeElement)) return;
        const ids = getSelectedLayerIds();
        if (!ids.length) return;
        event.preventDefault();
        if (ids.length === 1) {
            actions.removeCompositeLayer?.(ids[0]);
            return;
        }
        actions.removeCompositeLayers?.(ids);
        selectedLayerIds.clear();
    });

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
            dragState = null;
            panelInputActive = false;
            panelPointerIds.clear();
            if (panelInputRefreshTimer) {
                clearTimeout(panelInputRefreshTimer);
                panelInputRefreshTimer = null;
            }
            updateMarqueeUI(null);
            clearWheelCommitTimer();
            if (stageFrameHandle) {
                cancelAnimationFrame(stageFrameHandle);
                stageFrameHandle = 0;
            }
            root.style.display = 'none';
            refs.pickerOverlay.classList.remove('is-open');
            refs.stageWrap.classList.remove('is-dragging');
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
        getViewportMetrics() {
            return getViewportMetrics();
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
