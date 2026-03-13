import { getLayerInstancesByGroup } from '../registry/index.js';

const GROUP_LABELS = {
    base: 'Base',
    color: 'Color',
    texture: 'Texture',
    optics: 'Optics',
    stylize: 'Stylize',
    damage: 'Damage'
};
const STUDIO_TABS = [
    { id: 'edit', label: 'Edit' },
    { id: 'layer', label: 'Layer' },
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'scopes', label: 'Scopes' }
];

function selectedInstance(state) {
    return state.document.layerStack.find((instance) => instance.instanceId === state.document.selection.layerInstanceId) || null;
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function formatNumber(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value ?? '');
    if (Number.isInteger(numeric)) return String(numeric);
    return numeric.toFixed(2).replace(/\.0+$/, '').replace(/(\.\d*[1-9])0+$/, '$1');
}

function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return { r: 255, g: 255, b: 255 };
    }
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
    };
}

function rgbToHex(r, g, b) {
    return `#${[r, g, b].map((value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsv(r, g, b) {
    const red = r / 255;
    const green = g / 255;
    const blue = b / 255;
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const delta = max - min;
    let hue = 0;

    if (delta !== 0) {
        if (max === red) hue = ((green - blue) / delta) % 6;
        else if (max === green) hue = ((blue - red) / delta) + 2;
        else hue = ((red - green) / delta) + 4;
        hue *= 60;
        if (hue < 0) hue += 360;
    }

    const saturation = max === 0 ? 0 : delta / max;
    return { h: hue, s: saturation, v: max };
}

function hsvToHex(h, s, v = 1) {
    const hue = ((h % 360) + 360) % 360;
    const chroma = v * s;
    const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = v - chroma;
    let red = 0;
    let green = 0;
    let blue = 0;

    if (hue < 60) {
        red = chroma;
        green = x;
    } else if (hue < 120) {
        red = x;
        green = chroma;
    } else if (hue < 180) {
        green = chroma;
        blue = x;
    } else if (hue < 240) {
        green = x;
        blue = chroma;
    } else if (hue < 300) {
        red = x;
        blue = chroma;
    } else {
        red = chroma;
        blue = x;
    }

    return rgbToHex((red + m) * 255, (green + m) * 255, (blue + m) * 255);
}

function getWheelHandlePosition(hex) {
    const rgb = hexToRgb(hex);
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const angle = (hsv.h * Math.PI) / 180;
    const radius = hsv.s * 42;
    return {
        x: 50 + Math.cos(angle) * radius,
        y: 50 + Math.sin(angle) * radius
    };
}

function tabsForState(state) {
    return STUDIO_TABS;
}

function renderGroups(state, registry) {
    return getLayerInstancesByGroup(registry, state.document.layerStack).map(({ group, layers }) => `
        <section class="library-group">
            <div class="panel-heading"><span>${GROUP_LABELS[group] || group}</span></div>
            <div class="chip-grid">
                ${layers.map(({ layer, instances }) => {
        const active = instances.length > 0;
        const selected = instances.some((instance) => instance.instanceId === state.document.selection.layerInstanceId);
        return `
                        <div class="effect-chip ${active ? 'is-active' : ''} ${selected ? 'is-selected' : ''}">
                            <button type="button" class="effect-chip-main" data-action="${active ? 'select-layer-family' : 'add-layer'}" data-layer="${layer.layerId}">
                                <span>${layer.label}</span>
                                <strong>${active ? instances.length : '+'}</strong>
                            </button>
                            ${active && layer.supportsMultiInstance !== false ? `<button type="button" class="chip-add" data-action="add-layer" data-layer="${layer.layerId}" title="Add ${layer.label}">Add</button>` : ''}
                        </div>
                    `;
    }).join('')}
            </div>
        </section>
    `).join('');
}

function rangeRow(instance, key, label, min, max, step = 1, fallback = 0, hidden = false) {
    const value = instance.params[key] ?? fallback;
    return `
        <div class="control-row control-row-range ${hidden ? 'is-hidden' : ''}">
            <div class="control-row-top">
                <label>${label}</label>
                <span class="control-value">${formatNumber(value)}</span>
            </div>
            <div class="control-stack">
                <input type="range" min="${min}" max="${max}" step="${step}" value="${value}" data-control-instance="${instance.instanceId}" data-control-key="${key}">
                <input class="control-number" type="number" min="${min}" max="${max}" step="${step}" value="${value}" data-control-instance="${instance.instanceId}" data-control-key="${key}">
            </div>
        </div>
    `;
}

function renderColorRow(instance, control) {
    const value = instance.params[control.key] ?? control.default ?? '#000000';
    return `
        <div class="control-row control-row-color">
            <div class="control-row-top">
                <label>${control.label}</label>
                <span class="control-value">${String(value).toUpperCase()}</span>
            </div>
            <div class="color-row">
                <input type="color" value="${value}" data-control-instance="${instance.instanceId}" data-control-key="${control.key}">
                <button type="button" class="mini-button" data-action="arm-eyedropper" data-target="${instance.instanceId}:${control.key}">Pick</button>
            </div>
        </div>
    `;
}

function renderThreeWayWheel(instance, control) {
    return `
        <div class="grade-wheel-grid">
            ${control.items.map((item) => {
        const value = instance.params[item.key] ?? item.default ?? '#ffffff';
        const handle = getWheelHandlePosition(value);
        return `
                    <section class="grade-wheel-card">
                        <div class="grade-wheel-header">
                            <strong>${item.label}</strong>
                            <button type="button" class="text-button" data-action="set-wheel-neutral" data-instance="${instance.instanceId}" data-key="${item.key}">Reset</button>
                        </div>
                        <div class="grade-wheel-surface" data-wheel-instance="${instance.instanceId}" data-wheel-key="${item.key}" style="--handle-x:${handle.x}%; --handle-y:${handle.y}%">
                            <span class="grade-wheel-handle"></span>
                        </div>
                        <div class="grade-wheel-readout"><span class="grade-swatch" style="--swatch:${value}"></span><code>${String(value).toUpperCase()}</code></div>
                    </section>
                `;
    }).join('')}
        </div>
    `;
}
function renderControl(instance, control, state, layerDef) {
    switch (control.type) {
        case 'range':
            return rangeRow(instance, control.key, control.label, control.min ?? 0, control.max ?? 100, control.step ?? 1, control.default ?? control.min ?? 0, control.hidden);
        case 'select': {
            const value = String(instance.params[control.key] ?? control.options?.find((option) => option.selected)?.value ?? control.options?.[0]?.value ?? '');
            return `
                <div class="control-row">
                    <div class="control-row-top"><label>${control.label}</label></div>
                    <select data-control-instance="${instance.instanceId}" data-control-key="${control.key}">
                        ${(control.options || []).map((option) => `<option value="${option.value}" ${String(option.value) === value ? 'selected' : ''}>${option.label}</option>`).join('')}
                    </select>
                </div>
            `;
        }
        case 'checkbox':
            return `<label class="check-row"><input type="checkbox" ${(control.key === layerDef.enableKey ? instance.enabled : instance.params[control.key]) ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="${control.key}"><span>${control.label}</span></label>`;
        case 'color':
            return renderColorRow(instance, control);
        case 'message':
            if (control.dynamic === 'resolution') {
                let width = state.document.source.width || 1;
                let height = state.document.source.height || 1;
                for (const stackItem of state.document.layerStack) {
                    if (stackItem.layerId === 'scale' && stackItem.enabled && stackItem.visible) {
                        const factor = Math.max(0.1, parseFloat(stackItem.params.scaleMultiplier || 1));
                        width = Math.round(width * factor);
                        height = Math.round(height * factor);
                    }
                    if (stackItem.instanceId === instance.instanceId) break;
                }
                return `<div class="info-banner is-data"><span>${control.text}</span><strong>${width} x ${height}</strong></div>`;
            }
            return `<div class="info-banner ${control.tone === 'section' ? 'is-section' : ''}">${control.text || layerDef.description}</div>`;
        case 'separator':
            return '<div class="control-separator"></div>';
        case 'button':
            return `<button type="button" class="secondary-button compact-button" data-action="${control.action}" data-instance="${instance.instanceId}">${control.label}</button>`;
        case 'colorWheel3Way':
            return renderThreeWayWheel(instance, control);
        case 'conditionalGroup':
            return String(instance.params[control.when.key] ?? '') === String(control.when.equals)
                ? `<div class="conditional-group"><div class="group-label">${control.label || ''}</div>${(control.controls || []).map((item) => renderControl(instance, item, state, layerDef)).join('')}</div>`
                : '';
        case 'paletteEditor':
            return `
                <div class="palette-editor">
                    <div class="palette-actions">
                        <button type="button" class="mini-button" data-action="palette-add">Add Color</button>
                        <button type="button" class="mini-button" data-action="palette-randomize">Randomize</button>
                        <button type="button" class="mini-button" data-action="palette-clear">Clear</button>
                        <button type="button" class="mini-button" data-action="palette-pick">Pick From Preview</button>
                        <button type="button" class="mini-button" data-action="palette-upload">Extract From Image</button>
                    </div>
                    <div class="palette-swatches">
                        ${state.document.palette.map((color, index) => `<div class="palette-swatch"><input type="color" value="${color}" data-palette-index="${index}"><button type="button" class="text-button danger-text" data-action="palette-remove" data-index="${index}">Remove</button></div>`).join('')}
                    </div>
                </div>
            `;
        default:
            return '';
    }
}

function renderMask(instance, layerDef) {
    if (!layerDef.mask) return '';
    const blocks = [];
    if (layerDef.mask.colorExclude) {
        const mask = layerDef.mask.colorExclude;
        const color = instance.params[mask.colorKey] || '#000000';
        blocks.push(`
            <label class="check-row"><input type="checkbox" ${instance.params[mask.enableKey] ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="${mask.enableKey}"><span>Color Exclusion</span></label>
            <div class="control-row control-row-color">
                <div class="control-row-top">
                    <label>Target Color</label>
                    <span class="control-value">${String(color).toUpperCase()}</span>
                </div>
                <div class="color-row is-mask-picker">
                    <span class="grade-swatch" style="--swatch:${color}"></span>
                    <button type="button" class="mini-button" data-action="arm-eyedropper" data-target="${instance.instanceId}:${mask.colorKey}">Pick From Preview</button>
                </div>
            </div>
            ${rangeRow(instance, mask.toleranceKey, 'Tolerance', 0, 100, 1, 10)}
            ${rangeRow(instance, mask.fadeKey, 'Fade', 0, 100, 1, 20)}
        `);
    }
    if (layerDef.mask.lumaMask) {
        const mask = layerDef.mask.lumaMask;
        blocks.push(`
            <label class="check-row"><input type="checkbox" ${instance.params[mask.enableKey] ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="${mask.enableKey}"><span>Luma Mask</span></label>
            ${rangeRow(instance, mask.shadowThresholdKey, 'Shadow Threshold', 0, 1, 0.01, 0)}
            ${rangeRow(instance, mask.shadowFadeKey, 'Shadow Fade', 0, 1, 0.01, 0)}
            ${rangeRow(instance, mask.highlightThresholdKey, 'Highlight Threshold', 0, 1, 0.01, 1)}
            ${rangeRow(instance, mask.highlightFadeKey, 'Highlight Fade', 0, 1, 0.01, 0)}
        `);
    }
    if (layerDef.mask.invertKey) {
        blocks.push(`<label class="check-row"><input type="checkbox" ${instance.params[layerDef.mask.invertKey] ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="${layerDef.mask.invertKey}"><span>Invert Mask</span></label>`);
    }
    return `<section class="mask-editor"><div class="panel-heading">Mask</div>${blocks.join('')}</section>`;
}

function renderLayerPanel(state, registry) {
    const instance = selectedInstance(state);
    if (!instance) {
        return `
            <div class="panel-section">
                <div class="panel-heading">Layer</div>
                <div class="empty-panel">
                    <h3>No layer selected</h3>
                    <p>Select an active effect to edit it. In Studio, ordering and visibility stay in Pipeline.</p>
                </div>
            </div>
        `;
    }
    const layerDef = registry.byId[instance.layerId];

    return `
        <div class="panel-section">
            <div class="inspector-header compact-header">
                <div>
                    <div class="eyebrow">${GROUP_LABELS[layerDef.group] || layerDef.group}</div>
                    <h3>${layerDef.label}${instance.meta.instanceIndex > 1 ? ` ${instance.meta.instanceIndex}` : ''}</h3>
                    <p>${layerDef.description}</p>
                </div>
                <div class="inspector-note">Manage order, duplication, visibility, and removal in Pipeline.</div>
            </div>
        </div>
        <div class="panel-section controls-section">${(layerDef.controls || []).map((control) => renderControl(instance, control, state, layerDef)).join('')}${renderMask(instance, layerDef)}</div>
    `;
}

function renderPipeline(state, registry) {
    if (!state.document.layerStack.length) {
        return `
            <div class="panel-section">
                <div class="panel-heading">Pipeline</div>
                <div class="empty-panel"><h3>No layers</h3><p>Add effects from Edit, then use Pipeline to reorder and manage them.</p></div>
            </div>
        `;
    }

    return `
        <div class="panel-section">
            <div class="panel-heading">Pipeline</div>
            <div class="pipeline-list">
                ${state.document.layerStack.map((instance) => {
        const layer = registry.byId[instance.layerId];
        const selected = instance.instanceId === state.document.selection.layerInstanceId;
        return `
                        <div class="pipeline-item ${selected ? 'is-selected' : ''}" draggable="true" data-instance="${instance.instanceId}">
                            <button type="button" class="pipeline-main" data-action="select-instance" data-instance="${instance.instanceId}">
                                <span class="pipeline-name">${layer.label}${instance.meta.instanceIndex > 1 ? ` ${instance.meta.instanceIndex}` : ''}</span>
                                <span class="pipeline-meta">${GROUP_LABELS[layer.group] || layer.group} | ${instance.enabled ? 'Enabled' : 'Disabled'} | ${instance.visible ? 'Visible' : 'Hidden'}</span>
                            </button>
                            <div class="pipeline-actions">
                                <button type="button" class="mini-button" data-action="toggle-layer-visible" data-instance="${instance.instanceId}">${instance.visible ? 'Hide' : 'Show'}</button>
                                <button type="button" class="mini-button" data-action="toggle-layer-enabled" data-instance="${instance.instanceId}">${instance.enabled ? 'Disable' : 'Enable'}</button>
                                ${layer.supportsMultiInstance !== false ? `<button type="button" class="mini-button" data-action="duplicate-layer" data-instance="${instance.instanceId}">Duplicate</button>` : ''}
                                <button type="button" class="mini-button danger" data-action="remove-layer" data-instance="${instance.instanceId}">Delete</button>
                            </div>
                        </div>
                    `;
    }).join('')}
            </div>
        </div>
    `;
}
function renderScopes(state, registry) {
    const selected = selectedInstance(state);
    return `
        <div class="panel-section">
            <div class="panel-heading">Scopes</div>
            <div class="scope-tools">
                <button type="button" class="mini-button" data-action="compare-open">Compare</button>
                <button type="button" class="mini-button" data-action="popup-open">Pop-out</button>
            </div>
        </div>
        <div class="scope-stack">
            <div class="scope-card"><div class="scope-card-header">Histogram</div><canvas id="histogramCanvas" width="512" height="220"></canvas><div class="scope-meta"><span>Avg Brightness</span><strong id="avgBrightnessValue">--</strong></div><div class="scope-meta"><span>Render Resolution</span><strong id="renderResolutionValue">--</strong></div></div>
            <div class="scope-card"><div class="scope-card-header">Vectorscope</div><canvas id="vectorscopeCanvas" width="360" height="360"></canvas><div class="scope-meta"><span>Avg Saturation</span><strong id="avgSaturationValue">--</strong></div></div>
            <div class="scope-card"><div class="scope-card-header">RGB Parade</div><canvas id="paradeCanvas" width="620" height="220"></canvas></div>
            <div class="panel-heading">Layer Breakdown</div>
            <div class="scope-selection">${selected ? `Selected: ${registry.byId[selected.layerId]?.label || selected.layerId}` : 'Select a layer to inspect its breakdown.'}</div>
            <div class="scope-breakdowns" id="breakdownContainer"></div>
        </div>
    `;
}

function renderSidebar(state, registry) {
    const tabs = tabsForState(state);
    const currentView = tabs.some((tab) => tab.id === state.document.workspace.studioView) ? state.document.workspace.studioView : tabs[0].id;
    let body = '';

    if (currentView === 'pipeline') body = renderPipeline(state, registry);
    else if (currentView === 'scopes') body = renderScopes(state, registry);
    else if (currentView === 'layer') body = renderLayerPanel(state, registry);
    else body = `<div class="panel-section"><div class="panel-heading">Effect Library</div>${renderGroups(state, registry)}</div>`;

    return `
        <div class="workspace-tabs">
            ${tabs.map((tab) => `<button type="button" class="workspace-tab ${currentView === tab.id ? 'is-active' : ''}" data-action="set-studio-view" data-view="${tab.id}">${tab.label}</button>`).join('')}
        </div>
        <div class="sidebar-scroll">${body}</div>
    `;
}

function renderBatchDialog(state) {
    const batch = state.document.batch;
    return `
        <div class="dialog ${state.document.workspace.batchOpen ? 'is-open' : ''}" id="batchDialog">
            <div class="dialog-panel batch-panel">
                <div class="dialog-header"><div><div class="eyebrow">Secondary Workspace</div><h3>Batch Process</h3></div><button type="button" class="icon-button" data-action="batch-close">Close</button></div>
                <div class="dialog-body">
                    <div class="button-cluster"><button type="button" class="primary-button" data-action="batch-load-folder">Load Folder</button><button type="button" class="secondary-button" data-action="batch-export-all" ${batch.imageFiles.length ? '' : 'disabled'}>Export Batch</button></div>
                    <div class="batch-status"><strong>${batch.imageFiles.length ? `Image ${batch.currentIndex + 1} / ${batch.imageFiles.length}` : 'No folder loaded'}</strong><span>${batch.actualFps ? `Actual ${Math.round(batch.actualFps)} FPS` : 'Playback idle'}</span></div>
                    <div class="button-cluster"><button type="button" class="mini-button" data-action="batch-prev" ${batch.currentIndex <= 0 ? 'disabled' : ''}>Prev</button><button type="button" class="mini-button" data-action="batch-next" ${batch.currentIndex >= batch.imageFiles.length - 1 ? 'disabled' : ''}>Next</button><button type="button" class="mini-button" data-action="batch-play-toggle" ${batch.imageFiles.length ? '' : 'disabled'}>${batch.isPlaying ? 'Stop' : 'Play'}</button></div>
                    <div class="control-row"><div class="control-row-top"><label>Playback FPS</label></div><input type="number" min="1" max="60" step="1" value="${state.document.export.playFps}" data-action="batch-fps"></div>
                    <label class="check-row"><input type="checkbox" ${state.document.export.keepFolderStructure ? 'checked' : ''} data-action="batch-keep-structure"><span>Keep folder structure on export</span></label>
                </div>
            </div>
        </div>
    `;
}

function renderToolbar(state) {
    return `
        <header class="toolbar">
            <div class="toolbar-cluster">
                <button type="button" class="toolbar-button" data-action="trigger-image-input">Load Image</button>
                <button type="button" class="toolbar-button" data-action="export-current">Export PNG</button>
                <button type="button" class="toolbar-button" data-action="batch-open">Batch Process</button>
            </div>
            <div class="toolbar-cluster toolbar-state-actions">
                <button type="button" class="toolbar-button" data-action="open-state">Load</button>
                <label class="tiny-toggle toolbar-toggle">
                    <input id="loadImageToggle" type="checkbox" ${state.ui.loadImageOnOpen ? 'checked' : ''}>
                    <span>Load Image</span>
                </label>
                <button type="button" class="toolbar-button" data-action="save-state">Save</button>
                <label class="tiny-toggle toolbar-toggle">
                    <input id="saveImageToggle" type="checkbox" ${state.ui.saveImageOnSave ? 'checked' : ''}>
                    <span>Save Image</span>
                </label>
            </div>
        </header>
    `;
}

function buildWheelColor(surface, clientX, clientY) {
    const rect = surface.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = clientX - centerX;
    const dy = clientY - centerY;
    const distance = Math.min(Math.hypot(dx, dy), radius);
    const saturation = clamp(distance / radius, 0, 1);
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return hsvToHex(hue, saturation, 1);
}

export function createWorkspaceUI(root, registry, actions) {
    root.innerHTML = `
        <div class="app-shell">
            <div id="toolbarSlot"></div>
            <div class="notice-strip" id="noticeStrip"></div>
            <div class="workspace-shell" id="workspaceShell">
                <aside class="workspace-sidebar" id="sidebarPanel"></aside>
                <section class="workspace-center">
                    <div class="preview-topbar">
                        <div class="preview-title-block"><div class="eyebrow">Preview</div><h2 id="previewTitle">No source loaded</h2></div>
                        <div class="preview-toolbar">
                            <label class="tiny-toggle"><input type="checkbox" id="highQualityPreviewToggle"><span>High Quality</span></label>
                            <button type="button" class="mini-button" data-action="zoom-out">-</button>
                            <input id="previewZoomRange" type="range" min="1" max="4" step="0.1" value="1">
                            <button type="button" class="mini-button" data-action="zoom-in">+</button>
                            <button type="button" class="mini-button" data-action="zoom-fit">Fit</button>
                            <span class="zoom-readout" id="previewZoomLabel">1.0x</span>
                        </div>
                    </div>
                    <div class="preview-shell" id="previewShell">
                        <div class="preview-empty" id="previewEmpty"><strong>No image loaded</strong><span>Load an image to start editing.</span></div>
                        <div class="preview-stage" id="previewStage">
                            <div class="preview-scale-wrap" id="previewScaleWrap"><canvas id="displayCanvas"></canvas><canvas id="hoverPreviewCanvas" class="hover-preview-canvas"></canvas><div class="ca-pin-overlay" id="caPinOverlay"></div></div>
                        </div>
                    </div>
                </section>
            </div>
            <input id="imageInput" type="file" accept="image/*" hidden>
            <input id="stateInput" type="file" accept=".json,.mns.json" hidden>
            <input id="paletteImageInput" type="file" accept="image/*" hidden>
            <div class="dialog" id="compareDialog"><div class="dialog-panel compare-panel"><div class="dialog-header"><div><div class="eyebrow">Comparison</div><h3>Original vs Processed</h3></div><button type="button" class="icon-button" data-action="compare-close">Close</button></div><div class="dialog-body"><div class="compare-grid"><div class="scope-card"><div class="scope-card-header">Original</div><canvas id="compareOriginal" width="640" height="360"></canvas></div><div class="scope-card"><div class="scope-card-header">Processed</div><canvas id="compareProcessed" width="640" height="360"></canvas></div></div><div class="scope-meta-line" id="compareInfo">Source -- | Render --</div><div class="button-cluster"><button type="button" class="secondary-button" data-action="compare-export" data-mode="side">Export Side</button><button type="button" class="secondary-button" data-action="compare-export" data-mode="stack">Export Stack</button></div></div></div></div>
            <div id="batchSlot"></div>
        </div>
    `;

    const refs = {
        root,
        toolbarSlot: root.querySelector('#toolbarSlot'),
        noticeStrip: root.querySelector('#noticeStrip'),
        workspaceShell: root.querySelector('#workspaceShell'),
        sidebarPanel: root.querySelector('#sidebarPanel'),
        previewShell: root.querySelector('#previewShell'),
        previewEmpty: root.querySelector('#previewEmpty'),
        canvas: root.querySelector('#displayCanvas'),
        hoverPreviewCanvas: root.querySelector('#hoverPreviewCanvas'),
        previewStage: root.querySelector('#previewStage'),
        previewScaleWrap: root.querySelector('#previewScaleWrap'),
        previewTitle: root.querySelector('#previewTitle'),
        previewZoomRange: root.querySelector('#previewZoomRange'),
        previewZoomLabel: root.querySelector('#previewZoomLabel'),
        highQualityPreviewToggle: root.querySelector('#highQualityPreviewToggle'),
        imageInput: root.querySelector('#imageInput'),
        stateInput: root.querySelector('#stateInput'),
        paletteImageInput: root.querySelector('#paletteImageInput'),
        batchSlot: root.querySelector('#batchSlot'),
        compareDialog: root.querySelector('#compareDialog'),
        compareOriginal: root.querySelector('#compareOriginal'),
        compareProcessed: root.querySelector('#compareProcessed'),
        compareInfo: root.querySelector('#compareInfo'),
        caPinOverlay: root.querySelector('#caPinOverlay')
    };
    let dragSourceId = null;
    let wheelDrag = null;
    let wheelFrame = null;
    let wheelQueued = null;
    let latestState = null;

    function syncDraftControl(target) {
        const row = target.closest('.control-row');
        if (!row) return;
        row.querySelectorAll(`[data-control-instance="${target.dataset.controlInstance}"][data-control-key="${target.dataset.controlKey}"]`).forEach((element) => {
            if (element !== target) element.value = target.value;
        });
        const valueEl = row.querySelector('.control-value');
        if (valueEl) valueEl.textContent = formatNumber(target.value);
    }

    function applyPreviewScale() {
        if (!latestState) return;
        const hasSource = !!latestState.document.source.width && !!latestState.document.source.height;
        if (!hasSource || !refs.canvas.width || !refs.canvas.height) {
            refs.previewScaleWrap.style.transform = 'scale(1)';
            refs.previewZoomLabel.textContent = `${Number(latestState.document.view.zoom || 1).toFixed(1)}x`;
            return;
        }
        const fitScale = Math.min(
            1,
            Math.max(1, refs.previewShell.clientWidth - 2) / refs.canvas.width,
            Math.max(1, refs.previewShell.clientHeight - 2) / refs.canvas.height
        );
        const visualScale = fitScale * latestState.document.view.zoom;
        refs.previewScaleWrap.style.transform = `scale(${visualScale})`;
        refs.previewZoomLabel.textContent = `${visualScale.toFixed(2)}x`;
    }

    const previewResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyPreviewScale()) : null;
    previewResizeObserver?.observe(refs.previewShell);
    previewResizeObserver?.observe(refs.canvas);
    window.addEventListener('resize', applyPreviewScale);

    const queueWheelUpdate = (instanceId, key, value) => {
        wheelQueued = { instanceId, key, value };
        if (wheelFrame) return;
        wheelFrame = requestAnimationFrame(() => {
            if (wheelQueued) actions.updateControl(wheelQueued.instanceId, wheelQueued.key, wheelQueued.value);
            wheelQueued = null;
            wheelFrame = null;
        });
    };

    function updateWheelFromPointer(clientX, clientY) {
        if (!wheelDrag) return;
        const selector = `.grade-wheel-surface[data-wheel-instance="${wheelDrag.instanceId}"][data-wheel-key="${wheelDrag.key}"]`;
        const surface = root.querySelector(selector);
        if (!surface) return;
        queueWheelUpdate(wheelDrag.instanceId, wheelDrag.key, buildWheelColor(surface, clientX, clientY));
    }

    window.addEventListener('pointermove', (event) => updateWheelFromPointer(event.clientX, event.clientY));
    window.addEventListener('pointerup', () => { wheelDrag = null; });
    window.addEventListener('pointercancel', () => { wheelDrag = null; });

    const handleAction = (node) => {
        const action = node.dataset.action;
        if (!action) return;
        const actionMap = {
            'trigger-image-input': () => refs.imageInput.click(),
            'open-state': () => refs.stateInput.click(),
            'set-studio-view': () => actions.setStudioView(node.dataset.view),
            'add-layer': () => actions.addLayer(node.dataset.layer),
            'select-layer-family': () => actions.selectLayerFamily(node.dataset.layer),
            'select-instance': () => actions.selectInstance(node.dataset.instance),
            'duplicate-layer': () => actions.duplicateLayer(node.dataset.instance),
            'remove-layer': () => actions.removeLayer(node.dataset.instance),
            'toggle-layer-enabled': () => actions.toggleLayerEnabled(node.dataset.instance),
            'toggle-layer-visible': () => actions.toggleLayerVisible(node.dataset.instance),
            'reset-ca-center': () => actions.resetCaCenter(node.dataset.instance),
            'set-wheel-neutral': () => actions.updateControl(node.dataset.instance, node.dataset.key, '#ffffff'),
            'save-state': actions.saveState,
            'export-current': actions.exportCurrent,
            'compare-open': actions.openCompare,
            'compare-close': actions.closeCompare,
            'compare-export': () => actions.exportCompare(node.dataset.mode),
            'popup-open': actions.openPopup,
            'batch-open': () => actions.setBatchOpen(true),
            'batch-close': () => actions.setBatchOpen(false),
            'batch-load-folder': actions.loadFolder,
            'batch-export-all': actions.exportBatch,
            'batch-prev': () => actions.changeBatchImage(-1),
            'batch-next': () => actions.changeBatchImage(1),
            'batch-play-toggle': actions.toggleBatchPlayback,
            'zoom-in': () => actions.setZoom('in'),
            'zoom-out': () => actions.setZoom('out'),
            'zoom-fit': () => actions.setZoom('fit'),
            'palette-add': actions.addPaletteColor,
            'palette-remove': () => actions.removePaletteColor(parseInt(node.dataset.index, 10)),
            'palette-randomize': actions.randomizePalette,
            'palette-clear': actions.clearPalette,
            'palette-pick': () => actions.armEyedropper({ kind: 'palette' }),
            'palette-upload': () => refs.paletteImageInput.click(),
            'arm-eyedropper': () => actions.armEyedropper({ kind: 'control', target: node.dataset.target })
        };
        actionMap[action]?.();
    };

    root.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action]');
        if (target) return handleAction(target);
        if (event.target === refs.compareDialog) actions.closeCompare();
    });
    root.addEventListener('pointerdown', (event) => {
        const surface = event.target.closest('.grade-wheel-surface');
        if (!surface) return;
        event.preventDefault();
        wheelDrag = {
            instanceId: surface.dataset.wheelInstance,
            key: surface.dataset.wheelKey
        };
        updateWheelFromPointer(event.clientX, event.clientY);
    });
    refs.previewScaleWrap.addEventListener('click', (event) => actions.handlePreviewClick(event));
    root.addEventListener('input', (event) => {
        const target = event.target;
        if (target.dataset.controlInstance && target.dataset.controlKey && (target.type === 'range' || target.type === 'number')) {
            syncDraftControl(target);
            if (target.type === 'range') {
                actions.updateControl(
                    target.dataset.controlInstance,
                    target.dataset.controlKey,
                    target.value,
                    { render: true, skipViewRender: true }
                );
            }
        } else if (target === refs.previewZoomRange) {
            refs.previewZoomLabel.textContent = `${Number(target.value).toFixed(2)}x`;
        }
    });
    root.addEventListener('change', (event) => {
        const target = event.target;
        if (target.dataset.controlInstance && target.dataset.controlKey) actions.updateControl(target.dataset.controlInstance, target.dataset.controlKey, target.type === 'checkbox' ? target.checked : target.value);
        else if (target.dataset.paletteIndex) actions.updatePaletteColor(parseInt(target.dataset.paletteIndex, 10), target.value);
        else if (target === refs.previewZoomRange) actions.setZoom(parseFloat(target.value));
        else if (target === refs.highQualityPreviewToggle) actions.setHighQualityPreview(target.checked);
        else if (target.id === 'loadImageToggle') actions.setLoadImageOnOpen(target.checked);
        else if (target.id === 'saveImageToggle') actions.setSaveImageOnSave(target.checked);
        else if (target.dataset.action === 'batch-fps') actions.setBatchFps(parseInt(target.value, 10) || 10);
        else if (target.dataset.action === 'batch-keep-structure') actions.setKeepFolderStructure(target.checked);
    });
    refs.previewShell.addEventListener('wheel', (event) => { event.preventDefault(); actions.setZoom(event.deltaY > 0 ? 'out' : 'in'); }, { passive: false });
    const bindFileInput = (input, handler) => {
        input.addEventListener('change', (event) => {
            const file = event.target.files?.[0];
            handler(file);
            event.target.value = '';
        });
    };
    bindFileInput(refs.imageInput, actions.openImageFile);
    bindFileInput(refs.stateInput, actions.openStateFile);
    bindFileInput(refs.paletteImageInput, actions.extractPaletteFromFile);

    function bindPipelineDrag() {
        root.querySelectorAll('.pipeline-item').forEach((item) => {
            item.addEventListener('dragstart', () => { dragSourceId = item.dataset.instance; item.classList.add('is-dragging'); });
            item.addEventListener('dragend', () => { dragSourceId = null; item.classList.remove('is-dragging'); });
            item.addEventListener('dragover', (event) => event.preventDefault());
            item.addEventListener('drop', (event) => {
                event.preventDefault();
                if (dragSourceId && dragSourceId !== item.dataset.instance) actions.reorderLayer(dragSourceId, item.dataset.instance);
            });
        });
    }

    function render(state) {
        latestState = state;
        const hasSource = !!state.document.source.width && !!state.document.source.height;
        refs.toolbarSlot.innerHTML = renderToolbar(state);
        refs.noticeStrip.className = `notice-strip ${state.notice ? `is-${state.notice.type || 'info'}` : ''}`;
        refs.noticeStrip.textContent = state.notice?.text || '';
        refs.noticeStrip.style.display = state.notice ? 'flex' : 'none';
        refs.workspaceShell.className = `workspace-shell mode-${state.document.mode} tab-${state.document.workspace.studioView}`;
        refs.sidebarPanel.innerHTML = renderSidebar(state, registry);
        refs.batchSlot.innerHTML = renderBatchDialog(state);
        refs.compareDialog.classList.toggle('is-open', !!state.ui.compareOpen);
        refs.previewTitle.textContent = state.document.source.name || 'No source loaded';
        refs.previewZoomRange.value = String(state.document.view.zoom);
        refs.previewScaleWrap.style.display = hasSource ? 'inline-block' : 'none';
        refs.previewStage.style.display = hasSource ? 'flex' : 'none';
        refs.highQualityPreviewToggle.checked = !!state.document.view.highQualityPreview;
        refs.previewShell.classList.toggle('is-empty', !hasSource);
        refs.previewShell.classList.toggle('has-source', hasSource);
        refs.previewEmpty.style.display = hasSource ? 'none' : 'flex';
        refs.canvas.style.display = hasSource ? 'block' : 'none';
        refs.hoverPreviewCanvas.style.display = hasSource ? 'block' : 'none';
        const current = selectedInstance(state);
        if (current?.layerId === 'ca' && current.params.caPin && hasSource) {
            refs.caPinOverlay.style.display = 'block';
            refs.caPinOverlay.style.left = `${(current.params.caCenterX ?? 0.5) * 100}%`;
            refs.caPinOverlay.style.top = `${(1 - (current.params.caCenterY ?? 0.5)) * 100}%`;
        } else {
            refs.caPinOverlay.style.display = 'none';
        }
        applyPreviewScale();
        bindPipelineDrag();
    }

    return {
        render,
        getRenderRefs() {
            return {
                canvas: refs.canvas,
                hoverPreviewCanvas: refs.hoverPreviewCanvas,
                compareOriginal: refs.compareOriginal,
                compareProcessed: refs.compareProcessed,
                compareInfo: refs.compareInfo,
                originalCanvas: refs.compareOriginal,
                processedCanvas: refs.compareProcessed,
                infoEl: refs.compareInfo,
                histogramCanvas: root.querySelector('#histogramCanvas'),
                vectorscopeCanvas: root.querySelector('#vectorscopeCanvas'),
                paradeCanvas: root.querySelector('#paradeCanvas'),
                avgBrightnessEl: root.querySelector('#avgBrightnessValue'),
                renderResolutionEl: root.querySelector('#renderResolutionValue'),
                avgSaturationEl: root.querySelector('#avgSaturationValue'),
                breakdownContainer: root.querySelector('#breakdownContainer')
            };
        }
    };
}
