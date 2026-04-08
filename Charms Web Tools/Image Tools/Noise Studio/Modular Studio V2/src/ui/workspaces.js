import { getLayerInstancesByGroup } from '../registry/index.js';
import { hasRenderableLayers, MAX_PREVIEW_ZOOM } from '../state/documentHelpers.js';
import { createLibraryPanel } from './libraryPanel.js';
import { clientToImageUv, computePreviewTransform, getPointerRatio } from './previewViewport.js';
import { createCompositeWorkspace } from '../composite/ui.js';
import { createStitchWorkspace } from '../stitch/ui.js';
import { createThreeDWorkspace } from '../3d/ui.js';
import { createLogsPanel } from './logsPanel.js';
import { createSettingsPanel } from './settingsPanel.js';
import { createProgressOverlayController } from './progressOverlay.js';
import { getCropTransformMetrics } from '../engine/cropTransformShared.js';

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

function clampByte(value) {
    return clamp(Math.round(Number(value) || 0), 0, 255);
}

function normalizeRgbaColor(color) {
    if (!color || typeof color !== 'object') {
        return { r: 255, g: 255, b: 255, a: 255 };
    }
    return {
        r: clampByte(color.r ?? 255),
        g: clampByte(color.g ?? 255),
        b: clampByte(color.b ?? 255),
        a: clampByte(color.a ?? 255)
    };
}

function rgbaToCss(color) {
    const normalized = normalizeRgbaColor(color);
    return `rgba(${normalized.r}, ${normalized.g}, ${normalized.b}, ${(normalized.a / 255).toFixed(3)})`;
}

function rgbaToLabel(color) {
    const normalized = normalizeRgbaColor(color);
    return `RGBA ${normalized.r}, ${normalized.g}, ${normalized.b}, ${normalized.a}`;
}

function computeResolutionThroughInstance(state, stopInstanceId = null) {
    let width = Math.max(1, Number(state.document.source.width) || 1);
    let height = Math.max(1, Number(state.document.source.height) || 1);

    for (const stackItem of state.document.layerStack) {
        if (stackItem.visible !== false && stackItem.enabled !== false) {
            if (stackItem.layerId === 'scale') {
                const factor = Math.max(0.1, parseFloat(stackItem.params.scaleMultiplier || 1));
                width = Math.max(1, Math.round(width * factor));
                height = Math.max(1, Math.round(height * factor));
            } else if (stackItem.layerId === 'expander') {
                const padding = Math.max(0, Math.round(Number(stackItem.params.expanderPadding || 0)));
                width += padding * 2;
                height += padding * 2;
            } else if (stackItem.layerId === 'cropTransform') {
                const cropMetrics = getCropTransformMetrics(stackItem.params, width, height);
                width = cropMetrics.outputWidth;
                height = cropMetrics.outputHeight;
            }
        }

        if (stopInstanceId && stackItem.instanceId === stopInstanceId) {
            break;
        }
    }

    return { width, height };
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

function renderBgPatcherEditor(instance) {
    const params = instance.params || {};
    const targetColor = params.bgPatcherTargetColor || '#000000';
    const protectedColors = params.bgPatcherProtectedColors || [];
    const patches = params.bgPatcherPatches || [];
    const selectedPatchIndex = Number(params.bgPatcherSelectedPatchIndex ?? -1);
    const selectedPatch = selectedPatchIndex >= 0 ? patches[selectedPatchIndex] : null;

    return `
        <div class="custom-layer-editor">
            <div class="info-banner">Pick a background color from the preview, refine the matte, and optionally cover leftovers with square patches.</div>
            <section class="custom-group">
                <div class="panel-heading">Selection</div>
                <div class="custom-picker-row">
                    <button type="button" class="secondary-button compact-button" data-action="bg-patcher-pick-main" data-instance="${instance.instanceId}">Pick Color To Remove</button>
                    <span class="grade-swatch large-swatch checker-swatch" style="--swatch:${targetColor}"></span>
                    <code>${String(targetColor).toUpperCase()}</code>
                </div>
                ${(params.bgPatcherSamples || []).length > 0 ? `
                    <div class="info-banner" style="margin: 0px 16px;">${params.bgPatcherSamples.length} Additional Flood Origin(s)</div>
                ` : ''}
                <div class="button-cluster" style="margin: 8px 16px;">
                    <button type="button" class="secondary-button compact-button" data-action="bg-patcher-add-sample" data-instance="${instance.instanceId}">+ Add Pin</button>
                    ${(params.bgPatcherSamples || []).length > 0 ? `
                        <button type="button" class="secondary-button danger" data-action="bg-patcher-clear-samples" data-instance="${instance.instanceId}">Clear Pins</button>
                    ` : ''}
                </div>
                ${rangeRow(instance, 'bgPatcherOpacity', 'Opacity To Transparent', 0, 100, 1, 0)}
                <label class="check-row"><input type="checkbox" ${params.bgPatcherFloodFill ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="bgPatcherFloodFill"><span>Contiguous Mode (Flood Fill)</span></label>
            </section>
            <section class="custom-group">
                <div class="panel-heading">Tolerance & Edges</div>
                ${rangeRow(instance, 'bgPatcherTolerance', 'Color Tolerance', 0, 100, 1, 0)}
                <div style="margin: 4px 16px 16px; position: relative;">
                    <span style="display: block; font-size: 10px; color: rgba(255,255,255,0.5); margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; text-align: center;">Range of colors currently Affected</span>
                    <canvas class="tolerance-spectrum-canvas" data-instance="${instance.instanceId}" style="width: 100%; height: 12px; border-radius: 4px; cursor: crosshair; display: block; box-shadow: inset 0 0 0 1px rgba(255,255,255,0.1), 0 0 0 1px rgba(0,0,0,0.5);"></canvas>
                </div>
                ${rangeRow(instance, 'bgPatcherSmoothing', 'Edge Smoothing', 0, 100, 1, 0)}
                ${rangeRow(instance, 'bgPatcherEdgeShift', 'Edge Shift (px)', 0, 10, 0.1, 0)}
                ${rangeRow(instance, 'bgPatcherDefringe', 'Defringe', 0, 100, 1, 0)}
                <label class="check-row"><input type="checkbox" ${params.bgPatcherAaEnabled ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="bgPatcherAaEnabled"><span>Enable Anti-Aliasing</span></label>
                ${params.bgPatcherAaEnabled ? rangeRow(instance, 'bgPatcherAaRadius', 'Spread Radius (px)', 0, 10, 0.1, 0) : ''}
            </section>
            <section class="custom-group">
                <div class="panel-heading">Manual Brush Mask</div>
                <label class="check-row"><input type="checkbox" ${params.bgPatcherBrushEnabled ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="bgPatcherBrushEnabled"><span>Enable Brush Tool</span></label>
                ${params.bgPatcherBrushEnabled ? `
                    <div class="control-row">
                        <div class="control-row-top"><label>Brush Mode</label></div>
                        <select class="custom-select" data-control-instance="${instance.instanceId}" data-control-key="bgPatcherBrushMode">
                            <option value="remove" ${params.bgPatcherBrushMode !== 'keep' ? 'selected' : ''}>Remove (Transparent)</option>
                            <option value="keep" ${params.bgPatcherBrushMode === 'keep' ? 'selected' : ''}>Keep (Opaque)</option>
                        </select>
                    </div>
                    ${rangeRow(instance, 'bgPatcherBrushRadius', 'Brush Radius (px)', 1, 500, 1, 20)}
                    ${rangeRow(instance, 'bgPatcherBrushHardness', 'Brush Hardness', 0, 100, 1, 50)}
                    <div class="button-cluster" style="margin-top: 8px;">
                        <button type="button" class="mini-button danger" data-action="bg-patcher-clear-brush" data-instance="${instance.instanceId}">Clear Strokes</button>
                    </div>
                ` : ''}
            </section>
            <section class="custom-group">
                <div class="panel-heading">Protected Colors</div>
                <div class="button-cluster">
                    <button type="button" class="mini-button" data-action="bg-patcher-add-protected" data-instance="${instance.instanceId}" ${protectedColors.length >= 8 ? 'disabled' : ''}>+ Add Protected Color</button>
                </div>
                <div class="custom-stack">
                    ${protectedColors.length ? protectedColors.map((entry, index) => `
                        <div class="custom-list-item">
                            <div class="custom-list-row">
                                <div class="custom-picker-row">
                                    <span class="grade-swatch checker-swatch" style="--swatch:${entry.color || '#808080'}"></span>
                                    <code>${String(entry.color || '#808080').toUpperCase()}</code>
                                </div>
                                <div class="button-cluster">
                                    <button type="button" class="mini-button" data-action="bg-patcher-pick-protected" data-instance="${instance.instanceId}" data-index="${index}">Pick Color</button>
                                    <button type="button" class="mini-button danger" data-action="bg-patcher-remove-protected" data-instance="${instance.instanceId}" data-index="${index}">Delete</button>
                                </div>
                            </div>
                            <div class="control-row">
                                <div class="control-row-top"><label>Protection Radius</label><span class="control-value">${formatNumber(entry.tolerance ?? 0)}</span></div>
                                <input type="range" min="0" max="100" step="1" value="${entry.tolerance ?? 0}" data-bg-protected-instance="${instance.instanceId}" data-bg-protected-index="${index}">
                            </div>
                        </div>
                    `).join('') : '<div class="empty-inline">No protected colors.</div>'}
                </div>
            </section>
            <section class="custom-group">
                <div class="panel-heading">Patching</div>
                <label class="check-row"><input type="checkbox" ${params.bgPatcherPatchEnabled ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="bgPatcherPatchEnabled"><span>Enable Patching Mode</span></label>
                ${params.bgPatcherPatchEnabled ? `
                    <div class="button-cluster">
                        <button type="button" class="mini-button" data-action="bg-patcher-add-patch" data-instance="${instance.instanceId}" ${patches.length >= 32 ? 'disabled' : ''}>+ Add New Patch</button>
                        <span class="scope-selection">Drag on preview to move. Hold Shift while dragging to resize.</span>
                    </div>
                    <div class="custom-stack">
                        ${patches.length ? patches.map((patch, index) => `
                            <button type="button" class="custom-list-item custom-list-button ${selectedPatchIndex === index ? 'is-selected' : ''}" data-action="bg-patcher-select-patch" data-instance="${instance.instanceId}" data-index="${index}">
                                <span class="custom-picker-row"><span class="grade-swatch checker-swatch" style="--swatch:${patch.color || '#ff0000'}"></span><strong>Patch ${index + 1}</strong></span>
                                <span class="scope-selection">${formatNumber(patch.size ?? 64)}px</span>
                            </button>
                        `).join('') : '<div class="empty-inline">No patches.</div>'}
                    </div>
                    ${selectedPatch ? `
                        <div class="custom-list-item">
                            <div class="panel-heading">Selected Patch</div>
                            <div class="color-row">
                                <input type="color" value="${selectedPatch.color || '#ff0000'}" data-bg-patch-color-instance="${instance.instanceId}" data-bg-patch-color-index="${selectedPatchIndex}">
                                <button type="button" class="mini-button" data-action="bg-patcher-pick-patch" data-instance="${instance.instanceId}" data-index="${selectedPatchIndex}">Pick Color</button>
                                <button type="button" class="mini-button danger" data-action="bg-patcher-delete-patch" data-instance="${instance.instanceId}" data-index="${selectedPatchIndex}">Delete Selected Patch</button>
                            </div>
                            <div class="control-row">
                                <div class="control-row-top"><label>Patch Size</label><span class="control-value">${formatNumber(selectedPatch.size ?? 64)}px</span></div>
                                <input type="range" min="10" max="2048" step="1" value="${selectedPatch.size ?? 64}" data-bg-patch-size-instance="${instance.instanceId}" data-bg-patch-size-index="${selectedPatchIndex}">
                            </div>
                        </div>
                    ` : ''}
                ` : ''}
            </section>
            <section class="custom-group">
                <div class="panel-heading">View</div>
                <label class="check-row"><input type="checkbox" ${params.bgPatcherShowMask ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="bgPatcherShowMask"><span>Highlight Removed Areas</span></label>
                <label class="check-row"><input type="checkbox" ${params.bgPatcherCheckerEnabled ? 'checked' : ''} data-control-instance="${instance.instanceId}" data-control-key="bgPatcherCheckerEnabled"><span>Transparency Checker</span></label>
                ${params.bgPatcherCheckerEnabled ? `
                    <div class="control-row">
                        <div class="control-row-top"><label>Checker Tone</label></div>
                        <select data-control-instance="${instance.instanceId}" data-control-key="bgPatcherCheckerTone">
                            <option value="white" ${params.bgPatcherCheckerTone !== 'black' ? 'selected' : ''}>White</option>
                            <option value="black" ${params.bgPatcherCheckerTone === 'black' ? 'selected' : ''}>Black</option>
                        </select>
                    </div>
                ` : ''}
                <div class="button-cluster">
                    <button type="button" class="mini-button" data-action="bg-patcher-reset" data-instance="${instance.instanceId}">Reset Layer</button>
                    <button type="button" class="mini-button" data-action="export-current">Export PNG</button>
                </div>
            </section>
        </div>
    `;
}

function renderExpanderEditor(instance, state) {
    const color = normalizeRgbaColor(instance.params?.expanderColor);
    const resolution = computeResolutionThroughInstance(state, instance.instanceId);

    return `
        <div class="custom-layer-editor">
            <div class="info-banner">Adds equal canvas space around the image without scaling the image content. Pick a preview pixel or dial in RGBA directly.</div>
            <section class="custom-group">
                <div class="panel-heading">Fill Color</div>
                <div class="custom-picker-row">
                    <button type="button" class="secondary-button compact-button" data-action="expander-pick-color" data-instance="${instance.instanceId}">Select Color</button>
                    <span class="grade-swatch large-swatch checker-swatch" style="--swatch:${rgbaToCss(color)}"></span>
                    <code>${rgbaToLabel(color)}</code>
                </div>
                <div class="rgba-grid">
                    ${['r', 'g', 'b', 'a'].map((channel) => `
                        <label class="control-row compact-control">
                            <div class="control-row-top"><span>${channel.toUpperCase()}</span></div>
                            <input type="number" min="0" max="255" step="1" value="${color[channel]}" data-expander-instance="${instance.instanceId}" data-expander-channel="${channel}">
                        </label>
                    `).join('')}
                </div>
            </section>
            <section class="custom-group">
                <div class="panel-heading">Canvas Growth</div>
                ${rangeRow(instance, 'expanderPadding', 'Padding Per Side (px)', 0, 4096, 1, 0)}
                <div class="info-banner is-data"><span>Resulting Resolution</span><strong>${resolution.width} x ${resolution.height}</strong></div>
            </section>
        </div>
    `;
}

function layerHasControlKey(layerDef, key) {
    const walk = (controls = []) => controls.some((control) => {
        if (!control || typeof control !== 'object') return false;
        if (control.key === key) return true;
        if (control.type === 'conditionalGroup') return walk(control.controls || []);
        if (control.type === 'colorWheel3Way') return (control.items || []).some((item) => item.key === key);
        return false;
    });
    return walk(layerDef.controls || []);
}

function renderControl(instance, control, state, layerDef) {
    const presentedControl = getControlPresentation(instance, control, layerDef);
    switch (control.type) {
        case 'range':
            return rangeRow(
                instance,
                presentedControl.key,
                presentedControl.label,
                presentedControl.min ?? 0,
                presentedControl.max ?? 100,
                presentedControl.step ?? 1,
                presentedControl.default ?? presentedControl.min ?? 0,
                presentedControl.hidden
            );
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
                const { width, height } = computeResolutionThroughInstance(state, instance.instanceId);
                return `<div class="info-banner is-data"><span>${control.text}</span><strong>${width} x ${height}</strong></div>`;
            }
            if (layerDef.layerId === 'noise' && control.text === 'Advanced Settings' && !hasVisibleNoiseAdvancedControls(instance, layerDef)) {
                return '';
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
        case 'bgPatcherEditor':
            return renderBgPatcherEditor(instance);
        case 'expanderEditor':
            return renderExpanderEditor(instance, state);
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
    const needsEnableControl = layerDef.enableKey && !layerHasControlKey(layerDef, layerDef.enableKey);
    const controls = needsEnableControl
        ? [{ type: 'checkbox', key: layerDef.enableKey, label: 'Enable Layer' }, ...(layerDef.controls || [])]
        : (layerDef.controls || []);

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
        <div class="panel-section controls-section">${controls.map((control) => renderControl(instance, control, state, layerDef)).join('')}${renderMask(instance, layerDef)}</div>
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
        ${currentView === 'layer' ? `
        <div class="panel-section layer-preview-container ${state.document.view.layerPreviewsOpen ? 'is-open' : 'is-collapsed'}" style="margin-bottom: 0; flex-shrink: 0; border-bottom: 1px solid var(--border-light); background: var(--bg-100); z-index: 10;">
            <div class="panel-heading" style="cursor: pointer; display: flex; justify-content: space-between; align-items: center;" data-action="toggle-layer-previews">
                <span>Sub-Layer Previews</span>
                <span>${state.document.view.layerPreviewsOpen ? '▲' : '▼'}</span>
            </div>
            ${state.document.view.layerPreviewsOpen ? `
                <div class="preview-canvas-wrapper fixed-size" style="padding: 12px; padding-top: 0;">
                    <div class="preview-label" style="font-size: 11px; margin-bottom: 8px; color: var(--text-muted);"><span id="subLayerLabel">Loading...</span></div>
                    <canvas id="subLayerCanvas" width="320" height="180" data-action="cycle-layer-preview" style="cursor: pointer; display: block; width: 100%; border-radius: 4px; border: 1px solid var(--border-light); background: #000;"></canvas>
                </div>
            ` : ''}
        </div>
        ` : ''}
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

function renderJsonCompareDialog(state) {
    if (!state.ui.jsonCompareModalOpen) return '';
    const results = state.ui.jsonCompareResults;
    const view = state.ui.jsonCompareView;
    const activeIndex = state.ui.jsonCompareIndex;
    
    // We remove the global originalSrc here because each JSON payload has its own source now
    
    return `
        <div class="dialog is-open" id="jsonCompareDialog" style="z-index: 1000;">
            <div class="dialog-panel" style="width: 90vw; max-width: 1400px; height: 90vh; max-height: 900px; display: flex; flex-direction: column;">
                <div class="dialog-header">
                    <div>
                        <div class="eyebrow">Comparison Tool</div>
                        <h3>JSON Base Image Renders</h3>
                    </div>
                    ${results.length ? `
                    <div style="flex:1; display:flex; justify-content:center;" class="button-cluster">
                        <button type="button" class="secondary-button ${view === 'grid' ? 'is-active' : ''}" data-action="json-compare-view-grid">Grid View</button>
                        <button type="button" class="secondary-button ${view === 'single' ? 'is-active' : ''}" data-action="json-compare-view-single">Single View</button>
                    </div>` : ''}
                    <button type="button" class="icon-button" data-action="json-compare-close">Close</button>
                </div>
                <div class="dialog-body" style="flex: 1; overflow: hidden; display: flex; flex-direction: column;">
                    ${!results.length ? `
                        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; opacity: 0.5;">
                            <h3>No Valid Renders Generated</h3>
                        </div>
                    ` : view === 'grid' ? `
                        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; overflow-y: auto; padding-right: 8px;">
                            ${results.map((res, i) => `
                                <div class="scope-card" style="cursor: pointer;" data-action="json-compare-select" data-index="${i}">
                                    <div class="scope-card-header" style="text-overflow:ellipsis; overflow:hidden; white-space:nowrap;" title="${res.filename}">${res.filename}</div>
                                    <div style="position: relative; width: 100%; aspect-ratio: ${Math.max(1, res.payload.source?.width || 1)} / ${Math.max(1, res.payload.source?.height || 1)}; background: #000;">
                                        <img src="${res.url}" class="json-compare-image" style="width: 100%; height: 100%; object-fit: contain; pointer-events: auto;" onmouseenter="this.dataset.swapSrc=this.src; this.src='${res.payload.source?.imageData || ''}'" onmouseleave="this.src=this.dataset.swapSrc" />
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    ` : `
                        <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative;">
                            ${results[activeIndex] ? `
                                <div class="scope-card-header" style="position: absolute; top: 16px; left: 16px; z-index: 10; font-size: 16px; background: rgba(0,0,0,0.7); padding: 8px 12px; border-radius: 4px;">
                                    ${results[activeIndex].filename} (${activeIndex + 1} / ${results.length})
                                </div>
                                <div style="display: flex; align-items: center; justify-content: center; height: 100%; width: 100%; position: relative;">
                                    <button type="button" class="icon-button" data-action="json-compare-prev" style="position: absolute; left: 16px; top: 50%; transform: translateY(-50%); font-size: 24px; padding: 16px; z-index: 10; background:rgba(0,0,0,0.5); border-radius:50%; width:48px; height:48px; border:1px solid rgba(255,255,255,0.2)">&lsaquo;</button>
                                    <img src="${results[activeIndex].url}" class="json-compare-image" style="max-width: 100%; max-height: 100%; object-fit: contain; pointer-events: auto;" onmouseenter="this.dataset.swapSrc=this.src; this.src='${results[activeIndex].payload.source?.imageData || ''}'" onmouseleave="this.src=this.dataset.swapSrc" />
                                    <button type="button" class="icon-button" data-action="json-compare-next" style="position: absolute; right: 16px; top: 50%; transform: translateY(-50%); font-size: 24px; padding: 16px; z-index: 10; background:rgba(0,0,0,0.5); border-radius:50%; width:48px; height:48px; border:1px solid rgba(255,255,255,0.2)">&rsaquo;</button>
                                </div>
                            ` : `<p>Invalid active render index.</p>`}
                        </div>
                    `}
                </div>
            </div>
        </div>
    `;
}

function renderStudioToolbar(state) {
    const bridge = state.ui?.compositeEditorBridge || null;
    const showUpdateOriginal = !!bridge?.active && !!bridge?.originalLibraryId;
    return `
        <header class="toolbar">
            <div class="toolbar-cluster">
                <button type="button" class="toolbar-button" data-action="trigger-image-input">Load Image</button>
                <button type="button" class="toolbar-button" data-action="new-project">New Project</button>
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
                <button type="button" class="toolbar-button" data-action="save-to-library">Save to Library</button>
                ${showUpdateOriginal ? '<button type="button" class="toolbar-button" data-action="composite-update-original-editor">Update Original Editor Project</button>' : ''}
            </div>
        </header>
    `;
}

function renderStitchToolbar(state) {
    const isRunning = state.stitchDocument?.analysis?.status === 'running';
    return `
        <header class="toolbar">
            <div class="toolbar-cluster">
                <button type="button" class="toolbar-button" data-action="stitch-new-project">New Stitch</button>
                <button type="button" class="toolbar-button" data-action="stitch-add-images">Add Images</button>
                <button type="button" class="toolbar-button" data-action="stitch-run-analysis" ${state.stitchDocument.inputs.length < 2 || isRunning ? 'disabled' : ''}>${isRunning ? 'Analyzing...' : 'Run Analysis'}</button>
                <button type="button" class="toolbar-button" data-action="stitch-open-gallery" ${state.stitchDocument.candidates.length && !isRunning ? '' : 'disabled'}>Candidate Gallery</button>
            </div>
            <div class="toolbar-cluster toolbar-state-actions">
                <button type="button" class="toolbar-button" data-action="stitch-export-current" ${state.stitchDocument.inputs.length && !isRunning ? '' : 'disabled'}>Export PNG</button>
                <button type="button" class="toolbar-button" data-action="stitch-save-to-library" ${state.stitchDocument.inputs.length && !isRunning ? '' : 'disabled'}>Save to Library</button>
                <button type="button" class="toolbar-button" data-action="stitch-reset-view">Fit View</button>
            </div>
        </header>
    `;
}

function renderCompositeToolbar(state) {
    const layerCount = state.compositeDocument?.layers?.length || 0;
    return `
        <header class="toolbar">
            <div class="toolbar-cluster">
                <button type="button" class="toolbar-button" data-action="composite-new-project">New Project</button>
                <button type="button" class="toolbar-button" data-action="composite-add-editor-project">Add Editor Project</button>
                <button type="button" class="toolbar-button" data-action="composite-add-images">Add Images</button>
                <button type="button" class="toolbar-button" data-action="composite-add-text">Add Text</button>
                <button type="button" class="toolbar-button" data-action="composite-add-square">Add Square</button>
            </div>
            <div class="toolbar-cluster toolbar-state-actions">
                <button type="button" class="toolbar-button" data-action="composite-export-png" ${layerCount ? '' : 'disabled'}>Export PNG</button>
                <button type="button" class="toolbar-button" data-action="composite-open-state">Load</button>
                <button type="button" class="toolbar-button" data-action="composite-save-state" ${layerCount ? '' : 'disabled'}>Save</button>
                <button type="button" class="toolbar-button" data-action="composite-save-to-library" ${layerCount ? '' : 'disabled'}>Save to Library</button>
            </div>
        </header>
    `;
}

function renderSectionTabs(state, headerStatus = null) {
    const activeSection = state.ui.activeSection === 'composite'
        ? 'composite'
        : state.ui.activeSection === 'library'
        ? 'library'
        : state.ui.activeSection === 'stitch'
            ? 'stitch'
            : state.ui.activeSection === '3d'
                ? '3d'
                : state.ui.activeSection === 'settings'
                    ? 'settings'
                : state.ui.activeSection === 'logs'
                    ? 'logs'
                : 'editor';
    const statusTone = headerStatus?.tone || 'info';
    const statusText = String(headerStatus?.text || '').trim();
    return `
        <nav class="section-switcher">
            <div class="section-switcher-buttons">
                <button type="button" class="mode-button ${activeSection === 'editor' ? 'is-active' : ''}" data-action="set-app-section" data-section="editor">Editor</button>
                <button type="button" class="mode-button ${activeSection === 'composite' ? 'is-active' : ''}" data-action="set-app-section" data-section="composite">Composite</button>
                <button type="button" class="mode-button ${activeSection === 'library' ? 'is-active' : ''}" data-action="set-app-section" data-section="library">Library</button>
                <button type="button" class="mode-button ${activeSection === 'stitch' ? 'is-active' : ''}" data-action="set-app-section" data-section="stitch">Stitch</button>
                <button type="button" class="mode-button ${activeSection === '3d' ? 'is-active' : ''}" data-action="set-app-section" data-section="3d">3D</button>
                <button type="button" class="mode-button ${activeSection === 'settings' ? 'is-active' : ''}" data-action="set-app-section" data-section="settings">Settings</button>
                <button type="button" class="mode-button ${activeSection === 'logs' ? 'is-active' : ''}" data-action="set-app-section" data-section="logs">Logs</button>
            </div>
            <div class="section-header-status ${statusText ? `is-${statusTone}` : 'is-empty'}" aria-live="polite" title="${escapeHtml(statusText)}">
                ${statusText ? `<span>${escapeHtml(statusText)}</span>` : ''}
            </div>
        </nav>
    `;
}

function buildWheelColor(surface, clientX, clientY) {
    const rect = surface.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    return buildWheelColorFromOffset(surface, clientX - centerX, clientY - centerY);
}

const GRADE_WHEEL_DRAG_DIVISOR = 3;

function buildWheelColorFromOffset(surface, dx, dy) {
    const rect = surface.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const distance = Math.min(Math.hypot(dx, dy), radius);
    const saturation = clamp(distance / radius, 0, 1);
    const hue = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
    return hsvToHex(hue, saturation, 1);
}

function getWheelOffsetFromHex(surface, hex) {
    const rect = surface.getBoundingClientRect();
    const radius = Math.min(rect.width, rect.height) / 2;
    const rgb = hexToRgb(hex || '#ffffff');
    const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
    const angle = (hsv.h * Math.PI) / 180;
    const distance = clamp(hsv.s, 0, 1) * radius;
    return {
        x: Math.cos(angle) * distance,
        y: Math.sin(angle) * distance
    };
}

const NOISE_ADVANCED_CONTROL_KEYS = new Set(['noiseParamA', 'noiseParamB', 'noiseParamC']);

const NOISE_ADVANCED_PRESENTATIONS = {
    '5': {
        noiseParamA: { label: 'Detail Layers' },
        noiseParamB: { label: 'Cloud Scale' },
        noiseParamC: { label: 'Roughness' }
    },
    '6': {
        noiseParamA: { label: 'Cell Jitter' },
        noiseParamB: { label: 'Cell Density' },
        noiseParamC: { label: 'Distance Blend' }
    },
    '7': {
        noiseParamA: { label: 'Line Thickness' },
        noiseParamB: { label: 'Vertical Jitter' },
        noiseParamC: { label: 'Grain Mix' }
    },
    '8': {
        noiseParamA: { label: 'Speck Density' },
        noiseParamB: { label: 'Edge Softness' },
        noiseParamC: { label: 'Size Variation' }
    },
    '9': {
        noiseParamA: { label: 'Block Height' },
        noiseParamB: { label: 'Horizontal Shift' },
        noiseParamC: { label: 'RGB Split' }
    },
    '10': {
        noiseParamA: { label: 'Fiber Stretch' },
        noiseParamB: { label: 'Rotation' },
        noiseParamC: { label: 'Variation' }
    },
    '11': {
        noiseParamA: { label: 'Cell Scale' },
        noiseParamB: { label: 'Point Jitter' },
        noiseParamC: { label: 'Color Mix' }
    },
    '12': {
        noiseParamA: { label: 'Line Density' },
        noiseParamB: { label: 'Angle' },
        noiseParamC: { label: 'Variation' }
    }
};

function getNoiseAdvancedPresentation(instance, control, layerDef) {
    if (layerDef?.layerId !== 'noise' || !NOISE_ADVANCED_CONTROL_KEYS.has(control?.key)) {
        return null;
    }
    const noiseType = String(instance?.params?.noiseType ?? '');
    return NOISE_ADVANCED_PRESENTATIONS[noiseType]?.[control.key] || null;
}

function hasVisibleNoiseAdvancedControls(instance, layerDef) {
    if (layerDef?.layerId !== 'noise') return false;
    const noiseType = String(instance?.params?.noiseType ?? '');
    return Boolean(NOISE_ADVANCED_PRESENTATIONS[noiseType]);
}

function getControlPresentation(instance, control, layerDef) {
    const noisePresentation = getNoiseAdvancedPresentation(instance, control, layerDef);
    if (!noisePresentation) {
        if (layerDef?.layerId === 'noise' && NOISE_ADVANCED_CONTROL_KEYS.has(control?.key)) {
            return {
                ...control,
                hidden: true
            };
        }
        return control;
    }
    return {
        ...control,
        ...noisePresentation,
        hidden: false
    };
}

export function createWorkspaceUI(root, registry, actions, extras = {}) {
    root.innerHTML = `
        <div class="app-shell">
            <div id="sectionTabsSlot"></div>
            <div id="toolbarSlot"></div>
            <div class="workspace-shell" id="workspaceShell">
                <aside class="workspace-sidebar" id="sidebarPanel"></aside>
                <section class="workspace-center">
                    <div class="preview-topbar">
                        <div class="preview-title-block"><div class="eyebrow">Preview</div><h2 id="previewTitle">No source loaded</h2></div>
                        <div class="preview-toolbar">
                            <label class="tiny-toggle"><input type="checkbox" id="highQualityPreviewToggle"><span>High Quality</span></label>
                            <label class="tiny-toggle"><input type="checkbox" id="hoverCompareToggle"><span>Hover Original</span></label>
                            <label class="tiny-toggle"><input type="checkbox" id="isolateActiveLayerToggle"><span>Render to Active Layer</span></label>
                            <button type="button" class="mini-button" data-action="zoom-out">-</button>
                            <input id="previewZoomRange" type="range" min="1" max="${MAX_PREVIEW_ZOOM}" step="0.1" value="1">
                            <button type="button" class="mini-button" data-action="zoom-in">+</button>
                            <button type="button" class="mini-button" data-action="zoom-fit">Fit</button>
                            <span class="zoom-readout" id="previewZoomLabel">1.0x</span>
                        </div>
                    </div>
                    <div class="preview-shell" id="previewShell">
                        <div class="preview-empty" id="previewEmpty"><strong>No image loaded</strong><span>Load an image to start editing.</span></div>
                        <div class="preview-stage" id="previewStage">
                            <div class="preview-scale-wrap" id="previewScaleWrap"><canvas id="sourcePreviewCanvas"></canvas><canvas id="displayCanvas"></canvas><canvas id="hoverPreviewCanvas" class="hover-preview-canvas"></canvas><div class="ca-pin-overlay" id="caPinOverlay"></div><div class="ca-pin-overlay" id="tiltShiftPinOverlay" style="border-radius: 50%; box-shadow: 0 0 0 1px #fff, inset 0 0 0 1px rgba(0,0,0,0.5);"></div><div id="previewBrushCursor" style="display: none; position: absolute; pointer-events: none; border-radius: 50%; box-shadow: 0 0 0 1px rgba(255,255,255,0.7), inset 0 0 0 1px rgba(0,0,0,0.5); z-index: 100; transform: translate(-50%, -50%); border: 1px dashed rgba(255,255,255,0.3);"></div></div>
                        </div>
                        <div class="preview-loupe" id="previewLoupe"><canvas id="previewLoupeCanvas" width="88" height="88"></canvas></div>
                    </div>
                </section>
            </div>
            <section class="app-section-panel" id="libraryPanel"></section>
            <section class="app-section-panel" id="compositePanel"></section>
            <section class="app-section-panel" id="stitchPanel"></section>
            <section class="app-section-panel" id="threedPanel"></section>
            <section class="app-section-panel" id="settingsPanel"></section>
            <section class="app-section-panel" id="logsPanel"></section>
            <input id="imageInput" type="file" accept="image/*" hidden>
            <input id="stateInput" type="file" accept=".json,.mns.json" hidden>
            <input id="paletteImageInput" type="file" accept="image/*" hidden>
            <div class="dialog" id="compareDialog"><div class="dialog-panel compare-panel"><div class="dialog-header"><div><div class="eyebrow">Comparison</div><h3>Original vs Processed</h3></div><button type="button" class="icon-button" data-action="compare-close">Close</button></div><div class="dialog-body"><div class="compare-grid"><div class="scope-card"><div class="scope-card-header">Original</div><canvas id="compareOriginal" width="640" height="360"></canvas></div><div class="scope-card"><div class="scope-card-header">Processed</div><canvas id="compareProcessed" width="640" height="360"></canvas></div></div><div class="scope-meta-line" id="compareInfo">Source -- | Render --</div><div class="button-cluster"><button type="button" class="secondary-button" data-action="compare-export" data-mode="side">Export Side</button><button type="button" class="secondary-button" data-action="compare-export" data-mode="stack">Export Stack</button></div></div></div></div>
            <div class="dialog" id="appDialog" aria-hidden="true">
                <div class="dialog-panel app-modal-panel">
                    <div class="dialog-header">
                        <div>
                            <div class="eyebrow">App Dialog</div>
                            <h3 id="appDialogTitle">Continue</h3>
                        </div>
                        <button type="button" class="icon-button" data-action="app-dialog-close">Close</button>
                    </div>
                    <div class="dialog-body app-modal-body">
                        <p class="app-modal-text" id="appDialogText"></p>
                        <div class="app-modal-content" id="appDialogContent"></div>
                        <div class="library-modal-error" id="appDialogError"></div>
                        <div class="library-modal-actions">
                            <button type="button" class="toolbar-button" id="appDialogCancel" data-action="app-dialog-cancel">Cancel</button>
                            <button type="button" class="primary-button" id="appDialogConfirm" data-action="app-dialog-confirm">Continue</button>
                        </div>
                    </div>
                </div>
            </div>
            <div id="toleranceTooltip" style="display: none; position: fixed; pointer-events: none; z-index: 1000; background: #222; color: #fff; padding: 2px 6px; border-radius: 4px; font-family: monospace; font-size: 11px; transform: translate(-50%, -100%); margin-top: -8px;"></div>
            <div id="batchSlot"></div>
            <div id="jsonCompareSlot"></div>
        </div>
    `;

    const refs = {
        root,
        sectionTabsSlot: root.querySelector('#sectionTabsSlot'),
        toolbarSlot: root.querySelector('#toolbarSlot'),
        workspaceShell: root.querySelector('#workspaceShell'),
        sidebarPanel: root.querySelector('#sidebarPanel'),
        libraryPanel: root.querySelector('#libraryPanel'),
        compositePanel: root.querySelector('#compositePanel'),
        stitchPanel: root.querySelector('#stitchPanel'),
        threedPanel: root.querySelector('#threedPanel'),
        settingsPanel: root.querySelector('#settingsPanel'),
        logsPanel: root.querySelector('#logsPanel'),
        previewShell: root.querySelector('#previewShell'),
        previewEmpty: root.querySelector('#previewEmpty'),
        sourcePreviewCanvas: root.querySelector('#sourcePreviewCanvas'),
        canvas: root.querySelector('#displayCanvas'),
        hoverPreviewCanvas: root.querySelector('#hoverPreviewCanvas'),
        previewStage: root.querySelector('#previewStage'),
        previewScaleWrap: root.querySelector('#previewScaleWrap'),
        previewBrushCursor: root.querySelector('#previewBrushCursor'),
        previewTitle: root.querySelector('#previewTitle'),
        previewZoomRange: root.querySelector('#previewZoomRange'),
        previewZoomLabel: root.querySelector('#previewZoomLabel'),
        highQualityPreviewToggle: root.querySelector('#highQualityPreviewToggle'),
        imageInput: root.querySelector('#imageInput'),
        stateInput: root.querySelector('#stateInput'),
        paletteImageInput: root.querySelector('#paletteImageInput'),
        batchSlot: root.querySelector('#batchSlot'),
        jsonCompareSlot: root.querySelector('#jsonCompareSlot'),
        compareDialog: root.querySelector('#compareDialog'),
        appDialog: root.querySelector('#appDialog'),
        appDialogTitle: root.querySelector('#appDialogTitle'),
        appDialogText: root.querySelector('#appDialogText'),
        appDialogContent: root.querySelector('#appDialogContent'),
        appDialogError: root.querySelector('#appDialogError'),
        appDialogCancel: root.querySelector('#appDialogCancel'),
        appDialogConfirm: root.querySelector('#appDialogConfirm'),
        compareOriginal: root.querySelector('#compareOriginal'),
        compareProcessed: root.querySelector('#compareProcessed'),
        compareInfo: root.querySelector('#compareInfo'),
        caPinOverlay: root.querySelector('#caPinOverlay'),
        tiltShiftPinOverlay: root.querySelector('#tiltShiftPinOverlay'),
        previewLoupe: root.querySelector('#previewLoupe'),
        previewLoupeCanvas: root.querySelector('#previewLoupeCanvas'),
        toleranceTooltip: root.querySelector('#toleranceTooltip')
    };
    const editorProgressOverlay = createProgressOverlayController(refs.previewShell, {
        zIndex: 7,
        defaultTitle: 'Working',
        defaultMessage: 'Preparing the editor task...',
        backdrop: 'rgba(8, 10, 14, 0.48)',
        panelBackground: 'rgba(10, 10, 10, 0.94)',
        borderColor: 'rgba(245, 241, 232, 0.16)',
        borderSoftColor: 'rgba(245, 241, 232, 0.12)',
        textColor: '#f5f1e8',
        mutedColor: 'rgba(245, 241, 232, 0.72)',
        accentColor: 'rgba(255, 223, 168, 0.96)',
        progressFill: 'linear-gradient(90deg, rgba(255,223,168,0.26), rgba(255,223,168,0.9))'
    });
    let dragSourceId = null;
    let wheelDrag = null;
    let wheelFrame = null;
    let wheelQueued = null;
    let previewClickSuppressed = false;
    let previewInteraction = null;
    let brushInteraction = null;
    let latestState = null;
    let lastActiveSection = null;
    let lastSourceSignature = '';
    let logsTabPulse = '';
    let logsTabPulseTimer = null;
    let logsTabPulseMessage = '';
    let logsTabPulseTone = 'info';
    let appDialogState = null;
    let appDialogRestoreFocus = null;
    const viewportState = {
        pointer: { x: 0.5, y: 0.5 }
    };
    const loupeCtx = refs.previewLoupeCanvas.getContext('2d');
    const libraryPanel = createLibraryPanel(refs.libraryPanel, {
        actions,
        layerDefaults: Object.fromEntries(registry.layers.map((layer) => [layer.layerId, layer.defaults])),
        logger: extras.logger
    });
    const compositePanel = createCompositeWorkspace(refs.compositePanel, {
        actions,
        logger: extras.logger
    });
    const stitchPanel = createStitchWorkspace(refs.stitchPanel, {
        actions,
        stitchEngine: extras.stitchEngine,
        logger: extras.logger
    });
    const threedPanel = createThreeDWorkspace(actions, {
        getState: actions.getState,
        logger: extras.logger
    });
    refs.threedPanel.appendChild(threedPanel.root);
    const settingsPanel = createSettingsPanel(refs.settingsPanel, {
        actions
    });
    const logsPanel = createLogsPanel(refs.logsPanel, {
        logger: extras.logger,
        settings: actions.getState?.()?.settings?.logs || null
    });
    const unsubscribeLogEvents = extras.logger?.subscribeEvents?.((event) => {
        if (!event?.completed) return;
        if (event.status !== 'success' && event.status !== 'error') return;
        const flashEffectsEnabled = actions.getState?.()?.settings?.logs?.completionFlashEffects !== false;
        if (!flashEffectsEnabled) return;
        const activeSection = actions.getState?.()?.ui?.activeSection || latestState?.ui?.activeSection || 'editor';
        if (activeSection === 'logs') return;
        logsTabPulse = event.status === 'error' ? 'error' : 'success';
        logsTabPulseTone = logsTabPulse;
        logsTabPulseMessage = String(event.message || (logsTabPulse === 'error' ? 'A background task failed.' : 'A background task finished successfully.'));
        if (logsTabPulseTimer) clearTimeout(logsTabPulseTimer);
        renderSectionTabsSlot();
        applyLogsTabPulse();
        logsTabPulseTimer = setTimeout(() => {
            logsTabPulse = '';
            logsTabPulseMessage = '';
            logsTabPulseTone = 'info';
            renderSectionTabsSlot();
            applyLogsTabPulse();
        }, 1600);
    }) || (() => {});

    function getLiveState() {
        return actions.getState?.() || latestState;
    }

    function setAppDialogError(message = '') {
        if (!refs.appDialogError) return;
        const text = String(message || '').trim();
        refs.appDialogError.textContent = text;
        refs.appDialogError.classList.toggle('is-visible', !!text);
    }

    function setAppDialogBusy(busy) {
        if (!refs.appDialog || !refs.appDialogConfirm || !refs.appDialogCancel) return;
        const isBusy = !!busy;
        refs.appDialogConfirm.disabled = isBusy;
        refs.appDialogCancel.disabled = isBusy;
        refs.appDialog.querySelector('.app-modal-panel')?.classList.toggle('is-busy', isBusy);
        refs.appDialog.dataset.busy = isBusy ? 'true' : 'false';
        if (appDialogState) {
            appDialogState.isBusy = isBusy;
        }
    }

    function getAppDialogContext() {
        return {
            root: refs.appDialogContent,
            setError: setAppDialogError,
            close: () => hideAppDialog(true)
        };
    }

    function hideAppDialog(restoreFocus = false) {
        if (!refs.appDialog) return;
        refs.appDialog.classList.remove('is-open');
        refs.appDialog.setAttribute('aria-hidden', 'true');
        refs.appDialogContent.innerHTML = '';
        refs.appDialogText.textContent = '';
        refs.appDialogText.style.display = 'none';
        refs.appDialogCancel.style.display = '';
        refs.appDialogConfirm.classList.remove('is-danger');
        setAppDialogError('');
        setAppDialogBusy(false);
        const focusTarget = restoreFocus ? appDialogRestoreFocus : null;
        appDialogState = null;
        appDialogRestoreFocus = null;
        if (focusTarget && typeof focusTarget.focus === 'function') {
            requestAnimationFrame(() => focusTarget.focus());
        }
    }

    function showAppDialog(options = {}) {
        if (!refs.appDialog || !refs.appDialogTitle || !refs.appDialogText || !refs.appDialogContent) {
            options.resolve?.(null);
            return;
        }
        if (appDialogState?.resolve) {
            appDialogState.resolve(null);
        }
        hideAppDialog(false);
        appDialogRestoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        appDialogState = {
            title: String(options.title || 'Continue'),
            text: String(options.text || ''),
            html: String(options.html || ''),
            confirmLabel: String(options.confirmLabel || 'Continue'),
            cancelLabel: String(options.cancelLabel || 'Cancel'),
            isAlert: !!options.isAlert,
            isDanger: !!options.isDanger,
            closeOnOverlay: options.closeOnOverlay !== false,
            onConfirm: options.onConfirm || null,
            onCancel: options.onCancel || null,
            onOpen: options.onOpen || null,
            resolve: typeof options.resolve === 'function' ? options.resolve : null,
            isBusy: false
        };
        refs.appDialogTitle.textContent = appDialogState.title;
        refs.appDialogText.textContent = appDialogState.text;
        refs.appDialogText.style.display = appDialogState.text ? 'block' : 'none';
        refs.appDialogContent.innerHTML = appDialogState.html || '';
        refs.appDialogCancel.textContent = appDialogState.cancelLabel;
        refs.appDialogCancel.style.display = appDialogState.isAlert ? 'none' : '';
        refs.appDialogConfirm.textContent = appDialogState.confirmLabel;
        refs.appDialogConfirm.classList.toggle('is-danger', appDialogState.isDanger);
        setAppDialogError('');
        setAppDialogBusy(false);
        refs.appDialog.classList.add('is-open');
        refs.appDialog.setAttribute('aria-hidden', 'false');
        requestAnimationFrame(() => {
            appDialogState?.onOpen?.(getAppDialogContext());
        });
    }

    async function confirmAppDialog() {
        if (!appDialogState || appDialogState.isBusy) return;
        const callback = appDialogState.onConfirm;
        if (!callback) {
            const resolve = appDialogState.resolve;
            hideAppDialog(true);
            resolve?.(true);
            return;
        }
        try {
            setAppDialogBusy(true);
            const result = await callback(getAppDialogContext());
            if (result === false) {
                setAppDialogBusy(false);
                return;
            }
            const resolve = appDialogState.resolve;
            const resolvedValue = result === undefined ? true : result;
            hideAppDialog(true);
            resolve?.(resolvedValue);
        } catch (error) {
            setAppDialogBusy(false);
            setAppDialogError(error?.message || 'Could not continue.');
        }
    }

    async function cancelAppDialog() {
        if (!appDialogState || appDialogState.isBusy) return;
        try {
            const result = await appDialogState.onCancel?.(getAppDialogContext());
            if (result === false) return;
        } catch (error) {
            setAppDialogError(error?.message || 'Could not close this dialog yet.');
            return;
        }
        const resolve = appDialogState.resolve;
        hideAppDialog(true);
        resolve?.(null);
    }

    function focusAppDialogField(selector) {
        const field = refs.appDialogContent?.querySelector(selector);
        if (field && typeof field.focus === 'function') {
            requestAnimationFrame(() => field.focus());
        }
    }

    function runAppDialog(options = {}) {
        return new Promise((resolve) => {
            showAppDialog({
                ...options,
                resolve
            });
        });
    }

    async function requestAppConfirm(options = {}) {
        const result = await runAppDialog({
            title: options.title || 'Confirm',
            text: options.text || '',
            html: options.html || '',
            confirmLabel: options.confirmLabel || 'Continue',
            cancelLabel: options.cancelLabel || 'Cancel',
            isDanger: !!options.isDanger,
            isAlert: !!options.isAlert,
            closeOnOverlay: options.closeOnOverlay !== false,
            onOpen: options.onOpen,
            onCancel: options.onCancel,
            onConfirm: options.onConfirm || (() => true)
        });
        return !!result;
    }

    async function requestAppText(options = {}) {
        const inputId = 'app-dialog-input';
        const fieldLabel = escapeHtml(options.fieldLabel || 'Value');
        const placeholder = escapeHtml(options.placeholder || '');
        const defaultValue = String(options.defaultValue ?? '');
        const html = options.html || `
            <label class="library-modal-field">
                <span>${fieldLabel}</span>
                <input type="text" class="library-modal-input" id="${inputId}" value="${escapeHtml(defaultValue)}" placeholder="${placeholder}">
            </label>
        `;
        return runAppDialog({
            title: options.title || 'Enter A Value',
            text: options.text || '',
            html,
            confirmLabel: options.confirmLabel || 'Continue',
            cancelLabel: options.cancelLabel || 'Cancel',
            isDanger: !!options.isDanger,
            closeOnOverlay: options.closeOnOverlay !== false,
            onOpen: (context) => {
                options.onOpen?.(context);
                focusAppDialogField(`#${inputId}`);
            },
            onConfirm: ({ root, setError }) => {
                const rawValue = root.querySelector(`#${inputId}`)?.value ?? '';
                const value = options.trim === false ? String(rawValue) : String(rawValue).trim();
                if (options.required !== false && !value) {
                    setError(options.requiredMessage || 'Enter a value first.');
                    return false;
                }
                if (typeof options.validate === 'function') {
                    const validationResult = options.validate(value, { root, setError });
                    if (validationResult === false) return false;
                    if (validationResult !== undefined) return validationResult;
                }
                return value;
            }
        });
    }

    function getHeaderStatus(state = getLiveState()) {
        const activeSection = state?.ui?.activeSection || '';
        if (logsTabPulseMessage && activeSection !== 'logs') {
            return {
                text: logsTabPulseMessage,
                tone: logsTabPulseTone
            };
        }
        if (state?.notice?.text) {
            return {
                text: state.notice.text,
                tone: state.notice.type || 'info'
            };
        }
        return null;
    }

    function renderSectionTabsSlot(state = getLiveState()) {
        if (!state || !refs.sectionTabsSlot) return;
        refs.sectionTabsSlot.innerHTML = renderSectionTabs(state, getHeaderStatus(state));
    }

    function applyLogsTabPulse() {
        const logsButton = refs.sectionTabsSlot?.querySelector('[data-section="logs"]');
        if (!logsButton) return;
        const activeSection = actions.getState?.()?.ui?.activeSection || latestState?.ui?.activeSection || '';
        logsButton.style.transition = 'background 260ms ease, color 260ms ease, border-color 260ms ease, box-shadow 260ms ease, transform 260ms ease, opacity 260ms ease';
        if (!logsTabPulse || activeSection === 'logs') {
            logsButton.style.background = '';
            logsButton.style.color = '';
            logsButton.style.borderColor = '';
            logsButton.style.boxShadow = '';
            logsButton.style.transform = '';
            logsButton.style.opacity = '';
            return;
        }
        if (logsTabPulse === 'error') {
            logsButton.style.background = 'rgba(179, 63, 63, 0.9)';
            logsButton.style.color = '#fff6f6';
            logsButton.style.borderColor = 'rgba(255, 145, 145, 0.92)';
            logsButton.style.boxShadow = '0 0 0 1px rgba(255,145,145,0.18), 0 0 20px rgba(217,86,86,0.18)';
        } else {
            logsButton.style.background = 'rgba(58, 145, 94, 0.92)';
            logsButton.style.color = '#f6fff8';
            logsButton.style.borderColor = 'rgba(154, 255, 205, 0.92)';
            logsButton.style.boxShadow = '0 0 0 1px rgba(154,255,205,0.16), 0 0 18px rgba(91,194,130,0.16)';
        }
        logsButton.style.transform = 'translateY(-1px)';
        logsButton.style.opacity = '1';
    }

    function currentSelectedInstance() {
        const state = getLiveState();
        return state ? selectedInstance(state) : null;
    }

    function getPreviewPixelPosition(clientX, clientY) {
        const activeCanvas = getActivePreviewCanvas(getLiveState());
        if (!activeCanvas?.width || !activeCanvas?.height) return null;
        const uv = clientToImageUv(clientX, clientY, refs.previewScaleWrap.getBoundingClientRect());
        if (!uv) return null;
        return {
            x: clamp(Math.floor(uv.x * activeCanvas.width), 0, Math.max(0, activeCanvas.width - 1)),
            y: clamp(Math.floor(uv.y * activeCanvas.height), 0, Math.max(0, activeCanvas.height - 1)),
            width: activeCanvas.width,
            height: activeCanvas.height
        };
    }

    function getLayerInputPixelPosition(instanceId, clientX, clientY) {
        if (!instanceId || !actions.getLayerInputSampleAtClient) return null;
        const sample = actions.getLayerInputSampleAtClient(instanceId, clientX, clientY);
        if (!sample) return null;
        return {
            x: sample.x,
            y: sample.y,
            width: sample.width,
            height: sample.height
        };
    }

    function hitTestBgPatch(instance, pixelX, pixelY) {
        const patches = instance?.params?.bgPatcherPatches || [];
        for (let index = patches.length - 1; index >= 0; index -= 1) {
            const patch = patches[index];
            const size = Number(patch?.size ?? 0);
            if (
                pixelX >= Number(patch?.x ?? 0) &&
                pixelX < Number(patch?.x ?? 0) + size &&
                pixelY >= Number(patch?.y ?? 0) &&
                pixelY < Number(patch?.y ?? 0) + size
            ) {
                return { index, patch };
            }
        }
        return null;
    }

    function hideLoupe() {
        refs.previewLoupe.style.display = 'none';
    }

    function updateLoupe(clientX, clientY) {
        if (previewInteraction) {
            hideLoupe();
            return;
        }
        const state = getLiveState();
        const eyedropperKind = state?.eyedropperTarget?.kind;
        const loupeActive = eyedropperKind === 'bg-patcher-main'
            || eyedropperKind === 'bg-patcher-protected'
            || eyedropperKind === 'bg-patcher-patch'
            || eyedropperKind === 'expander-color';
        if (!state || !loupeActive || !state.document.source.width) {
            hideLoupe();
            return;
        }
        const activeCanvas = getActivePreviewCanvas(state);
        if (!activeCanvas?.width || !activeCanvas?.height) {
            hideLoupe();
            return;
        }
        const rect = refs.previewScaleWrap.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
            hideLoupe();
            return;
        }
        const pixel = getPreviewPixelPosition(clientX, clientY);
        if (!pixel) {
            hideLoupe();
            return;
        }

        const zoomWindow = 11;
        const sampleWidth = Math.min(zoomWindow, activeCanvas.width);
        const sampleHeight = Math.min(zoomWindow, activeCanvas.height);
        const sourceX = clamp(pixel.x - Math.floor(sampleWidth / 2), 0, Math.max(0, activeCanvas.width - sampleWidth));
        const sourceY = clamp(pixel.y - Math.floor(sampleHeight / 2), 0, Math.max(0, activeCanvas.height - sampleHeight));
        loupeCtx.clearRect(0, 0, refs.previewLoupeCanvas.width, refs.previewLoupeCanvas.height);
        loupeCtx.imageSmoothingEnabled = false;
        loupeCtx.drawImage(activeCanvas, sourceX, sourceY, sampleWidth, sampleHeight, 0, 0, refs.previewLoupeCanvas.width, refs.previewLoupeCanvas.height);
        loupeCtx.strokeStyle = '#ff00ff';
        loupeCtx.lineWidth = 1;
        loupeCtx.strokeRect(
            Math.floor((refs.previewLoupeCanvas.width / sampleWidth) * (pixel.x - sourceX)),
            Math.floor((refs.previewLoupeCanvas.height / sampleHeight) * (pixel.y - sourceY)),
            Math.ceil(refs.previewLoupeCanvas.width / sampleWidth),
            Math.ceil(refs.previewLoupeCanvas.height / sampleHeight)
        );

        const shellRect = refs.previewShell.getBoundingClientRect();
        const loupeWidth = refs.previewLoupe.offsetWidth || 96;
        const loupeHeight = refs.previewLoupe.offsetHeight || 96;
        const left = clamp(clientX - shellRect.left + 16, 8, Math.max(8, shellRect.width - loupeWidth - 8));
        const top = clamp(clientY - shellRect.top - (loupeHeight * 0.5), 8, Math.max(8, shellRect.height - loupeHeight - 8));
        refs.previewLoupe.style.left = `${left}px`;
        refs.previewLoupe.style.top = `${top}px`;
        refs.previewLoupe.style.display = 'block';
    }

    function syncDraftControl(target) {
        const row = target.closest('.control-row');
        if (!row) return;
        row.querySelectorAll(`[data-control-instance="${target.dataset.controlInstance}"][data-control-key="${target.dataset.controlKey}"]`).forEach((element) => {
            if (element !== target) element.value = target.value;
        });
        const valueEl = row.querySelector('.control-value');
        if (valueEl) valueEl.textContent = formatNumber(target.value);
    }

    function hasProcessedPreview(state = getLiveState()) {
        return hasRenderableLayers(registry, state?.document);
    }

    function getActivePreviewCanvas(state = getLiveState()) {
        return hasProcessedPreview(state) ? refs.canvas : refs.sourcePreviewCanvas;
    }

    function resetViewportPointer() {
        viewportState.pointer = { x: 0.5, y: 0.5 };
    }

    function updateViewportPointer(clientX, clientY) {
        viewportState.pointer = getPointerRatio(clientX, clientY, refs.previewStage.getBoundingClientRect(), viewportState.pointer);
    }

    function applyPreviewScale() {
        if (!latestState) return;
        const hasSource = !!latestState.document.source.width && !!latestState.document.source.height;
        const activeCanvas = getActivePreviewCanvas(latestState);
        if (!hasSource || !activeCanvas?.width || !activeCanvas?.height) {
            refs.previewScaleWrap.style.transform = 'translate(0px, 0px) scale(1)';
            refs.previewScaleWrap.style.width = '0px';
            refs.previewScaleWrap.style.height = '0px';
            refs.previewZoomLabel.textContent = `${Number(latestState.document.view.zoom || 1).toFixed(2)}x`;
            return;
        }
        const transform = computePreviewTransform(
            Math.max(1, refs.previewStage.clientWidth),
            Math.max(1, refs.previewStage.clientHeight),
            activeCanvas.width,
            activeCanvas.height,
            latestState.document.view.zoom,
            viewportState.pointer
        );
        refs.previewScaleWrap.style.width = `${activeCanvas.width}px`;
        refs.previewScaleWrap.style.height = `${activeCanvas.height}px`;
        refs.previewScaleWrap.style.transform = `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.visualScale})`;
        refs.previewZoomLabel.textContent = `${Number(latestState.document.view.zoom || 1).toFixed(2)}x`;
    }

    const previewResizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => applyPreviewScale()) : null;
    previewResizeObserver?.observe(refs.previewShell);
    previewResizeObserver?.observe(refs.previewStage);
    previewResizeObserver?.observe(refs.canvas);
    previewResizeObserver?.observe(refs.sourcePreviewCanvas);
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
        const offsetX = wheelDrag.startOffsetX + ((clientX - wheelDrag.originX) / GRADE_WHEEL_DRAG_DIVISOR);
        const offsetY = wheelDrag.startOffsetY + ((clientY - wheelDrag.originY) / GRADE_WHEEL_DRAG_DIVISOR);
        queueWheelUpdate(wheelDrag.instanceId, wheelDrag.key, buildWheelColorFromOffset(surface, offsetX, offsetY));
    }

    function updateBgPatchDrag(clientX, clientY) {
        if (!previewInteraction) return;
        const current = currentSelectedInstance();
        if (!current || current.instanceId !== previewInteraction.instanceId) {
            previewInteraction = null;
            return;
        }
        const pixel = getLayerInputPixelPosition(previewInteraction.instanceId, clientX, clientY);
        if (!pixel) return;
        const patch = current.params.bgPatcherPatches?.[previewInteraction.patchIndex];
        if (!patch) return;

        if (previewInteraction.mode === 'drag') {
            const size = Math.max(1, Number(patch.size ?? 64));
            actions.updateBgPatcherPatch(previewInteraction.instanceId, previewInteraction.patchIndex, {
                x: clamp(Math.round(pixel.x - previewInteraction.offsetX), 0, Math.max(0, pixel.width - size)),
                y: clamp(Math.round(pixel.y - previewInteraction.offsetY), 0, Math.max(0, pixel.height - size))
            }, { render: true, skipViewRender: true });
        } else if (previewInteraction.mode === 'resize') {
            const nextSize = clamp(
                Math.round(Math.max(pixel.x - Number(patch.x ?? 0), pixel.y - Number(patch.y ?? 0))),
                10,
                Math.max(10, Math.min(pixel.width - Number(patch.x ?? 0), pixel.height - Number(patch.y ?? 0)))
            );
            actions.updateBgPatcherPatch(previewInteraction.instanceId, previewInteraction.patchIndex, { size: nextSize }, { render: true, skipViewRender: true });
        }
    }

    function updateBgBrushDrag(clientX, clientY) {
        if (!brushInteraction) return;
        const current = currentSelectedInstance();
        if (!current || current.instanceId !== brushInteraction.instanceId) {
            brushInteraction = null;
            return;
        }
        const pixel = getLayerInputPixelPosition(brushInteraction.instanceId, clientX, clientY);
        if (!pixel) return;
        
        const pt = { x: Math.round(pixel.x), y: Math.round(pixel.y) };
        const path = brushInteraction.path;
        const last = path[path.length - 1];
        if (Math.abs(pt.x - last.x) > 1 || Math.abs(pt.y - last.y) > 1) {
            path.push(pt);
            actions.updateControl(current.instanceId, 'bgPatcherBrushLiveStroke', brushInteraction, { render: true, skipViewRender: true });
        }
    }

    function updateBrushCursor(clientX, clientY) {
        if (!refs.previewBrushCursor) return;
        const current = currentSelectedInstance();
        if (!current || current.layerId !== 'bgPatcher' || !current.params.bgPatcherBrushEnabled) {
            refs.previewBrushCursor.style.display = 'none';
            return;
        }
        const pixel = getLayerInputPixelPosition(current.instanceId, clientX, clientY);
        if (!pixel) {
            refs.previewBrushCursor.style.display = 'none';
            return;
        }
        const radius = Number(current.params.bgPatcherBrushRadius ?? 20);
        const hardness = clamp(Number(current.params.bgPatcherBrushHardness ?? 50), 0, 100) / 100;
        refs.previewBrushCursor.style.display = 'block';
        refs.previewBrushCursor.style.width = `${radius * 2}px`;
        refs.previewBrushCursor.style.height = `${radius * 2}px`;
        refs.previewBrushCursor.style.left = `${pixel.x}px`;
        refs.previewBrushCursor.style.top = `${pixel.y}px`;
        const innerRadius = radius * hardness;
        refs.previewBrushCursor.style.boxShadow = `0 0 0 1px rgba(255,255,255,0.7), inset 0 0 0 1px rgba(0,0,0,0.5), inset 0 0 0 ${Math.max(0, radius - innerRadius)}px rgba(255,255,255,0.2)`;
    }

    window.addEventListener('pointermove', (event) => {
        updateWheelFromPointer(event.clientX, event.clientY);
        updateBgPatchDrag(event.clientX, event.clientY);
        updateBgBrushDrag(event.clientX, event.clientY);
    });
    window.addEventListener('pointerup', () => {
        wheelDrag = null;
        previewInteraction = null;
        if (brushInteraction) {
            const current = currentSelectedInstance();
            if (current && current.instanceId === brushInteraction.instanceId) {
                const existingStrokes = current.params.bgPatcherBrushStrokes || [];
                actions.updateInstance(brushInteraction.instanceId, (instance) => ({
                    ...instance,
                    params: {
                        ...instance.params,
                        bgPatcherBrushStrokes: [...existingStrokes, brushInteraction],
                        bgPatcherBrushLiveStroke: null
                    }
                }), { render: true, skipViewRender: true });
            }
            brushInteraction = null;
        }
    });
    window.addEventListener('pointercancel', () => {
        wheelDrag = null;
        previewInteraction = null;
        brushInteraction = null;
    });
    window.addEventListener('keydown', (event) => {
        if (appDialogState) {
            const key = String(event.key || '').toLowerCase();
            if (key === 'escape' && !appDialogState.isAlert) {
                event.preventDefault();
                cancelAppDialog();
                return;
            }
            if (key === 'enter' && refs.appDialog?.contains(event.target) && String(event.target?.tagName || '').toLowerCase() !== 'textarea') {
                event.preventDefault();
                confirmAppDialog();
                return;
            }
        }
        if (!event.key || (event.key.toLowerCase() !== 'l' && event.code !== 'KeyL')) return;
        const tag = document.activeElement?.tagName;
        const type = document.activeElement?.type;
        if (tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && (type === 'text' || type === 'number' || type === 'search' || type === 'color'))) return;
        const state = getLiveState();
        if (!state?.document.source.width || (state.document.view.zoom || 1) <= 1) return;
        event.preventDefault();
        actions.toggleZoomLock();
    });

    const handleAction = (node) => {
        const action = node.dataset.action;
        if (!action) return;
        const actionMap = {
            'set-app-section': () => actions.setActiveSection(node.dataset.section),
            'trigger-image-input': () => refs.imageInput.click(),
            'new-project': actions.newProject,
            'open-library': () => actions.setActiveSection('library'),
            'app-dialog-close': cancelAppDialog,
            'app-dialog-cancel': cancelAppDialog,
            'app-dialog-confirm': confirmAppDialog,
            'json-compare-close': () => actions.setJsonCompareModal(false),
            'json-compare-view-grid': () => actions.setJsonCompareView('grid'),
            'json-compare-view-single': () => actions.setJsonCompareView('single'),
            'json-compare-prev': () => actions.setJsonCompareIndex((getLiveState()?.ui.jsonCompareIndex || 0) - 1),
            'json-compare-next': () => actions.setJsonCompareIndex((getLiveState()?.ui.jsonCompareIndex || 0) + 1),
            'json-compare-select': () => {
                actions.setJsonCompareIndex(parseInt(node.dataset.index, 10));
                actions.setJsonCompareView('single');
            },
            'open-state': () => refs.stateInput.click(),
            'set-studio-view': () => actions.setStudioView(node.dataset.view),
            'add-layer': () => actions.addLayer(node.dataset.layer),
            'tilt-shift-pick-focus': () => {
                const instance = getLiveState()?.document.layerStack.find((item) => item.instanceId === node.dataset.instance);
                actions.updateControl(node.dataset.instance, 'tiltShiftPin', !instance?.params?.tiltShiftPin, { render: true });
            },
            'select-layer-family': () => actions.selectLayerFamily(node.dataset.layer),
            'select-instance': () => actions.selectInstance(node.dataset.instance),
            'duplicate-layer': () => actions.duplicateLayer(node.dataset.instance),
            'remove-layer': () => actions.removeLayer(node.dataset.instance),
            'toggle-layer-enabled': () => actions.toggleLayerEnabled(node.dataset.instance),
            'toggle-layer-visible': () => actions.toggleLayerVisible(node.dataset.instance),
            'reset-ca-center': () => actions.resetCaCenter(node.dataset.instance),
            'set-wheel-neutral': () => actions.updateControl(node.dataset.instance, node.dataset.key, '#ffffff'),
            'save-state': actions.saveState,
            'save-to-library': () => actions.saveProjectToLibrary(),
            'composite-new-project': actions.newCompositeProject,
            'composite-add-editor-project': () => actions.openCompositeProjectPicker?.(),
            'composite-add-images': () => actions.openCompositeImagePicker?.(),
            'composite-add-text': actions.addCompositeTextLayer,
            'composite-add-square': actions.addCompositeSquareLayer,
            'composite-export-png': actions.exportCompositePng,
            'composite-open-state': () => actions.openCompositeStatePicker?.(),
            'composite-save-state': actions.saveCompositeState,
            'composite-save-to-library': () => actions.saveProjectToLibrary(null, { projectType: 'composite' }),
            'composite-update-original-editor': actions.updateOriginalEditorProjectFromComposite,
            'stitch-new-project': actions.newStitchProject,
            'stitch-add-images': actions.openStitchPicker,
            'stitch-run-analysis': actions.runStitchAnalysis,
            'stitch-open-gallery': () => actions.setStitchGalleryOpen(true),
            'stitch-export-current': actions.exportStitchProject,
            'stitch-save-to-library': () => actions.saveProjectToLibrary(null, { projectType: 'stitch' }),
            'stitch-reset-view': actions.resetStitchView,
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
            'arm-eyedropper': () => actions.armEyedropper({ kind: 'control', target: node.dataset.target }),
            'bg-patcher-pick-main': () => actions.armEyedropper({ kind: 'bg-patcher-main', instanceId: node.dataset.instance }),
            'bg-patcher-add-sample': () => actions.armEyedropper({ kind: 'bg-patcher-add-sample', instanceId: node.dataset.instance }),
            'bg-patcher-clear-samples': () => actions.updateControl(node.dataset.instance, 'bgPatcherSamples', [], { render: true }),
            'bg-patcher-add-protected': () => {
                const instance = getLiveState()?.document.layerStack.find((item) => item.instanceId === node.dataset.instance);
                const nextIndex = instance?.params?.bgPatcherProtectedColors?.length || 0;
                actions.addBgPatcherProtectedColor(node.dataset.instance);
                actions.armEyedropper({ kind: 'bg-patcher-protected', instanceId: node.dataset.instance, index: nextIndex });
            },
            'bg-patcher-pick-protected': () => actions.armEyedropper({ kind: 'bg-patcher-protected', instanceId: node.dataset.instance, index: parseInt(node.dataset.index, 10) }),
            'bg-patcher-remove-protected': () => actions.removeBgPatcherProtectedColor(node.dataset.instance, parseInt(node.dataset.index, 10)),
            'bg-patcher-add-patch': () => actions.addBgPatcherPatchAtCenter(node.dataset.instance),
            'bg-patcher-clear-brush': () => actions.updateControl(node.dataset.instance, 'bgPatcherBrushStrokes', [], { render: true }),
            'bg-patcher-select-patch': () => actions.selectBgPatcherPatch(node.dataset.instance, parseInt(node.dataset.index, 10)),
            'bg-patcher-pick-patch': () => actions.armEyedropper({ kind: 'bg-patcher-patch', instanceId: node.dataset.instance, index: parseInt(node.dataset.index, 10) }),
            'bg-patcher-delete-patch': () => actions.removeBgPatcherPatch(node.dataset.instance, parseInt(node.dataset.index, 10)),
            'bg-patcher-reset': () => actions.resetBgPatcher(node.dataset.instance),
            'expander-pick-color': () => actions.armEyedropper({ kind: 'expander-color', instanceId: node.dataset.instance }),
            'toggle-layer-previews': () => actions.toggleLayerPreviews(),
            'cycle-layer-preview': () => actions.cycleLayerPreview()
        };
        actionMap[action]?.();
    };

    root.addEventListener('click', (event) => {
        const specCanvas = event.target.closest('.tolerance-spectrum-canvas');
        if (specCanvas && refs.toleranceTooltip) {
            const hex = specCanvas.dataset.hoverHex;
            if (hex) {
                navigator.clipboard.writeText(hex);
                refs.toleranceTooltip.textContent = 'Copied!';
                refs.toleranceTooltip.dataset.copied = 'true';
                setTimeout(() => { if (refs.toleranceTooltip) refs.toleranceTooltip.dataset.copied = 'false'; }, 1000);
            }
            return;
        }

        const target = event.target.closest('[data-action]');
        if (target) return handleAction(target);
        if (event.target === refs.compareDialog) actions.closeCompare();
        if (event.target === refs.appDialog && appDialogState?.closeOnOverlay && !appDialogState?.isAlert) {
            cancelAppDialog();
        }
    });
    root.addEventListener('pointermove', (event) => {
        const specCanvas = event.target.closest('.tolerance-spectrum-canvas');
        if (specCanvas && refs.toleranceTooltip) {
            const rect = specCanvas.getBoundingClientRect();
            const x = clamp(Math.floor(((event.clientX - rect.left) / rect.width) * specCanvas.width), 0, specCanvas.width - 1);
            const ctx = specCanvas.getContext('2d', { willReadFrequently: true });
            const p = ctx.getImageData(x, Math.floor(specCanvas.height / 2), 1, 1).data;
            const hex = '#' + [p[0], p[1], p[2]].map(v => v.toString(16).padStart(2, '0')).join('');
            
            refs.toleranceTooltip.style.display = 'block';
            refs.toleranceTooltip.style.left = `${event.clientX}px`;
            refs.toleranceTooltip.style.top = `${rect.top}px`;
            if (refs.toleranceTooltip.dataset.copied !== 'true') {
                refs.toleranceTooltip.textContent = hex.toUpperCase();
            }
            specCanvas.dataset.hoverHex = hex.toUpperCase();
        } else if (refs.toleranceTooltip) {
            refs.toleranceTooltip.style.display = 'none';
        }
    });

    root.addEventListener('pointerleave', () => {
        if (refs.toleranceTooltip) refs.toleranceTooltip.style.display = 'none';
    });

    root.addEventListener('pointerdown', (event) => {
        const surface = event.target.closest('.grade-wheel-surface');
        if (!surface) return;
        if (typeof event.button === 'number' && event.button !== 0) return;
        event.preventDefault();
        const clickedColor = buildWheelColor(surface, event.clientX, event.clientY);
        const clickedOffset = getWheelOffsetFromHex(surface, clickedColor);
        wheelDrag = {
            instanceId: surface.dataset.wheelInstance,
            key: surface.dataset.wheelKey,
            originX: event.clientX,
            originY: event.clientY,
            startOffsetX: clickedOffset.x,
            startOffsetY: clickedOffset.y
        };
        queueWheelUpdate(wheelDrag.instanceId, wheelDrag.key, clickedColor);
    });
    refs.previewScaleWrap.addEventListener('pointerdown', (event) => {
        const liveState = getLiveState();
        if (liveState?.eyedropperTarget) {
            previewClickSuppressed = true;
            actions.handlePreviewClick(event);
            event.preventDefault();
            return;
        }
        const current = currentSelectedInstance();
        if (!current || current.layerId !== 'bgPatcher') return;
        const pixel = getLayerInputPixelPosition(current.instanceId, event.clientX, event.clientY);
        if (!pixel) return;

        if (current.params.bgPatcherPatchEnabled) {
            const hit = hitTestBgPatch(current, pixel.x, pixel.y);
            if (hit) {
                previewClickSuppressed = true;
                actions.selectBgPatcherPatch(current.instanceId, hit.index);
                previewInteraction = {
                    instanceId: current.instanceId,
                    patchIndex: hit.index,
                    mode: event.shiftKey ? 'resize' : 'drag',
                    offsetX: pixel.x - Number(hit.patch.x ?? 0),
                    offsetY: pixel.y - Number(hit.patch.y ?? 0)
                };
                hideLoupe();
                event.preventDefault();
                return;
            }
        }

        if (current.params.bgPatcherBrushEnabled) {
            previewClickSuppressed = true;
            const path = [{ x: Math.round(pixel.x), y: Math.round(pixel.y) }];
            brushInteraction = {
                instanceId: current.instanceId,
                mode: current.params.bgPatcherBrushMode === 'keep' ? 'keep' : 'remove',
                radius: Number(current.params.bgPatcherBrushRadius ?? 20),
                hardness: Number(current.params.bgPatcherBrushHardness ?? 50),
                path
            };
            actions.updateControl(current.instanceId, 'bgPatcherBrushLiveStroke', brushInteraction, { render: true, skipViewRender: true });
            hideLoupe();
            event.preventDefault();
            return;
        }
    });
    refs.previewScaleWrap.addEventListener('click', (event) => {
        if (previewClickSuppressed) {
            previewClickSuppressed = false;
            return;
        }
        actions.handlePreviewClick(event);
    });
    refs.previewShell.addEventListener('pointerenter', (event) => {
        if (!getLiveState()?.document.view.zoomLocked) updateViewportPointer(event.clientX, event.clientY);
        applyPreviewScale();
        updateLoupe(event.clientX, event.clientY);
        updateBrushCursor(event.clientX, event.clientY);
    });
    refs.previewShell.addEventListener('pointermove', (event) => {
        if (!getLiveState()?.document.view.zoomLocked) updateViewportPointer(event.clientX, event.clientY);
        applyPreviewScale();
        updateLoupe(event.clientX, event.clientY);
        updateBrushCursor(event.clientX, event.clientY);
    });
    refs.previewShell.addEventListener('pointerleave', () => {
        hideLoupe();
        if (refs.previewBrushCursor) refs.previewBrushCursor.style.display = 'none';
    });
    root.addEventListener('input', (event) => {
        const target = event.target;
        if (target.dataset.controlInstance && target.dataset.controlKey && (target.type === 'range' || target.type === 'number')) {
            syncDraftControl(target);
            if (target.type === 'range') {
                actions.updateControl(
                    target.dataset.controlInstance,
                    target.dataset.controlKey,
                    target.value,
                    { render: true, skipViewRender: target.dataset.controlKey !== 'extractCount' }
                );
                if (target.dataset.controlKey === 'bgPatcherTolerance') {
                    const state = getLiveState();
                    if (state) drawToleranceSpectrums(state);
                }
            }
        } else if (target.dataset.bgProtectedInstance && target.dataset.bgProtectedIndex) {
            actions.updateBgPatcherProtectedTolerance(
                target.dataset.bgProtectedInstance,
                parseInt(target.dataset.bgProtectedIndex, 10),
                target.value,
                { render: true, skipViewRender: true }
            );
        } else if (target.dataset.bgPatchSizeInstance && target.dataset.bgPatchSizeIndex) {
            actions.updateBgPatcherPatch(
                target.dataset.bgPatchSizeInstance,
                parseInt(target.dataset.bgPatchSizeIndex, 10),
                { size: Math.max(10, parseInt(target.value, 10) || 10) },
                { render: true, skipViewRender: true }
            );
        } else if (target === refs.previewZoomRange) {
            refs.previewZoomLabel.textContent = `${Number(target.value).toFixed(2)}x`;
        }
    });
    root.addEventListener('change', (event) => {
        const target = event.target;
        if (target.dataset.controlInstance && target.dataset.controlKey) actions.updateControl(target.dataset.controlInstance, target.dataset.controlKey, target.type === 'checkbox' ? target.checked : target.value);
        else if (target.dataset.bgPatchColorInstance && target.dataset.bgPatchColorIndex) actions.updateBgPatcherPatch(target.dataset.bgPatchColorInstance, parseInt(target.dataset.bgPatchColorIndex, 10), { color: target.value });
        else if (target.dataset.expanderInstance && target.dataset.expanderChannel) {
            const instance = getLiveState()?.document.layerStack.find((item) => item.instanceId === target.dataset.expanderInstance);
            const current = normalizeRgbaColor(instance?.params?.expanderColor);
            current[target.dataset.expanderChannel] = clampByte(target.value);
            actions.updateControl(target.dataset.expanderInstance, 'expanderColor', current);
        }
        else if (target.dataset.paletteIndex) actions.updatePaletteColor(parseInt(target.dataset.paletteIndex, 10), target.value);
        else if (target === refs.previewZoomRange) actions.setZoom(parseFloat(target.value));
        else if (target === refs.highQualityPreviewToggle) actions.setHighQualityPreview(target.checked);
        else if (target.id === 'hoverCompareToggle') actions.setHoverCompareEnabled(target.checked);
        else if (target.id === 'isolateActiveLayerToggle') actions.setRenderUpToActiveLayer(target.checked);
        else if (target.id === 'loadImageToggle') actions.setLoadImageOnOpen(target.checked);

        else if (target.id === 'themeToggle') actions.setTheme(target.checked);
        else if (target.dataset.action === 'batch-fps') actions.setBatchFps(parseInt(target.value, 10) || 10);
        else if (target.dataset.action === 'batch-keep-structure') actions.setKeepFolderStructure(target.checked);
    });
    refs.previewShell.addEventListener('wheel', (event) => {
        event.preventDefault();
        if (getLiveState()?.document.view.zoomLocked) return;
        updateViewportPointer(event.clientX, event.clientY);
        actions.setZoom(event.deltaY > 0 ? 'out' : 'in');
    }, { passive: false });
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
        const activeSection = state.ui.activeSection;
        if (state.settings?.logs?.completionFlashEffects === false && logsTabPulse) {
            if (logsTabPulseTimer) clearTimeout(logsTabPulseTimer);
            logsTabPulse = '';
            logsTabPulseMessage = '';
            logsTabPulseTone = 'info';
        }
        const isEditorActive = activeSection === 'editor';
        const hasSource = !!state.document.source.width && !!state.document.source.height;
        const processedPreview = hasProcessedPreview(state);
        const sourceSignature = `${state.document.source.name}|${state.document.source.width}x${state.document.source.height}`;
        if (sourceSignature !== lastSourceSignature) {
            lastSourceSignature = sourceSignature;
            resetViewportPointer();
        }

        document.documentElement.dataset.theme = state.document.view.theme === 'dark' ? 'dark' : 'light';
        renderSectionTabsSlot(state);
        applyLogsTabPulse();
        logsPanel.setSettings?.(state.settings?.logs || null);
        refs.toolbarSlot.innerHTML = activeSection === 'editor'
            ? renderStudioToolbar(state)
            : activeSection === 'composite'
                ? renderCompositeToolbar(state)
            : activeSection === 'stitch'
                ? renderStitchToolbar(state)
                : '';
        refs.toolbarSlot.style.display = (activeSection === 'editor' || activeSection === 'composite' || activeSection === 'stitch') ? 'block' : 'none';
        refs.workspaceShell.className = `workspace-shell mode-${state.document.mode} tab-${state.document.workspace.studioView}`;
        refs.workspaceShell.style.display = activeSection === 'editor' ? 'grid' : 'none';
        refs.compositePanel.style.display = activeSection === 'composite' ? 'block' : 'none';
        refs.libraryPanel.style.display = activeSection === 'library' ? 'block' : 'none';
        refs.stitchPanel.style.display = activeSection === 'stitch' ? 'block' : 'none';
        refs.threedPanel.style.display = activeSection === '3d' ? 'block' : 'none';
        refs.settingsPanel.style.display = activeSection === 'settings' ? 'block' : 'none';
        refs.logsPanel.style.display = activeSection === 'logs' ? 'block' : 'none';
        if (activeSection !== lastActiveSection) {
            if (activeSection === 'composite') {
                libraryPanel.deactivate();
                compositePanel.activate();
                stitchPanel.deactivate();
                threedPanel.deactivate();
                settingsPanel.deactivate();
                logsPanel.deactivate();
            } else if (activeSection === 'library') {
                libraryPanel.activate();
                compositePanel.deactivate();
                stitchPanel.deactivate();
                threedPanel.deactivate();
                settingsPanel.deactivate();
                logsPanel.deactivate();
            } else if (activeSection === 'stitch') {
                libraryPanel.deactivate();
                compositePanel.deactivate();
                stitchPanel.activate();
                threedPanel.deactivate();
                settingsPanel.deactivate();
                logsPanel.deactivate();
            } else if (activeSection === '3d') {
                libraryPanel.deactivate();
                compositePanel.deactivate();
                stitchPanel.deactivate();
                threedPanel.activate();
                settingsPanel.deactivate();
                logsPanel.deactivate();
            } else if (activeSection === 'settings') {
                libraryPanel.deactivate();
                compositePanel.deactivate();
                stitchPanel.deactivate();
                threedPanel.deactivate();
                settingsPanel.activate();
                logsPanel.deactivate();
            } else if (activeSection === 'logs') {
                libraryPanel.deactivate();
                compositePanel.deactivate();
                stitchPanel.deactivate();
                threedPanel.deactivate();
                settingsPanel.deactivate();
                logsPanel.activate();
            } else {
                libraryPanel.deactivate();
                compositePanel.deactivate();
                stitchPanel.deactivate();
                threedPanel.deactivate();
                settingsPanel.deactivate();
                logsPanel.deactivate();
            }
            lastActiveSection = activeSection;
        }

        refs.batchSlot.innerHTML = renderBatchDialog(state);
        refs.jsonCompareSlot.innerHTML = renderJsonCompareDialog(state);
        refs.compareDialog.classList.toggle('is-open', !!state.ui.compareOpen);
        if (isEditorActive) {
            const sidebarScrollElement = refs.sidebarPanel.querySelector('.sidebar-scroll');
            const sidebarScrollTop = sidebarScrollElement ? sidebarScrollElement.scrollTop : refs.sidebarPanel.scrollTop;

            refs.sidebarPanel.innerHTML = renderSidebar(state, registry);

            const newSidebarScroll = refs.sidebarPanel.querySelector('.sidebar-scroll');
            if (newSidebarScroll) {
                newSidebarScroll.scrollTop = sidebarScrollTop;
            } else {
                refs.sidebarPanel.scrollTop = sidebarScrollTop;
            }

            drawToleranceSpectrums(state);
            refs.previewTitle.textContent = state.document.source.name || 'No source loaded';
            refs.previewZoomRange.value = String(state.document.view.zoom);
            refs.previewScaleWrap.style.display = hasSource ? 'block' : 'none';
            refs.previewStage.style.display = hasSource ? 'flex' : 'none';
            refs.highQualityPreviewToggle.checked = !!state.document.view.highQualityPreview;
            const hoverCompareToggle = root.querySelector('#hoverCompareToggle');
            if (hoverCompareToggle) hoverCompareToggle.checked = !!state.document.view.hoverCompareEnabled;
            const isolateActiveLayerToggle = root.querySelector('#isolateActiveLayerToggle');
            if (isolateActiveLayerToggle) isolateActiveLayerToggle.checked = !!state.document.view.isolateActiveLayerChain;
            const current = selectedInstance(state);
            const suppressHoverCompare = current?.layerId === 'bgPatcher'
                && (
                    current.params.bgPatcherPatchEnabled
                    || state.eyedropperTarget?.kind === 'bg-patcher-main'
                    || state.eyedropperTarget?.kind === 'bg-patcher-protected'
                    || state.eyedropperTarget?.kind === 'bg-patcher-patch'
                );
            refs.previewShell.classList.toggle('is-empty', !hasSource);
            refs.previewShell.classList.toggle('has-source', hasSource);
            refs.previewShell.classList.toggle('compare-enabled', hasSource && processedPreview && !!state.document.view.hoverCompareEnabled && !suppressHoverCompare);
            refs.previewEmpty.style.display = hasSource ? 'none' : 'flex';
            refs.sourcePreviewCanvas.style.display = hasSource && !processedPreview ? 'block' : 'none';
            refs.canvas.style.display = hasSource && processedPreview ? 'block' : 'none';
            refs.hoverPreviewCanvas.style.display = hasSource && processedPreview ? 'block' : 'none';
            refs.previewShell.classList.toggle('zoom-locked', !!state.document.view.zoomLocked);
            refs.previewShell.classList.toggle('checker-active', !!(current?.layerId === 'bgPatcher' && current.params.bgPatcherCheckerEnabled));
            refs.previewShell.classList.toggle('checker-dark', !!(current?.layerId === 'bgPatcher' && current.params.bgPatcherCheckerEnabled && current.params.bgPatcherCheckerTone === 'black'));
            if (current?.layerId === 'ca' && current.params.caPin && hasSource) {
                refs.caPinOverlay.style.display = 'block';
                refs.caPinOverlay.style.left = `${(current.params.caCenterX ?? 0.5) * 100}%`;
                refs.caPinOverlay.style.top = `${(1 - (current.params.caCenterY ?? 0.5)) * 100}%`;
            } else {
                refs.caPinOverlay.style.display = 'none';
            }
            if (current?.layerId === 'tiltShiftBlur' && current.params.tiltShiftPin && hasSource) {
                refs.tiltShiftPinOverlay.style.display = 'block';
                refs.tiltShiftPinOverlay.style.left = `${(current.params.tiltShiftCenterX ?? 0.5) * 100}%`;
                refs.tiltShiftPinOverlay.style.top = `${(1 - (current.params.tiltShiftCenterY ?? 0.5)) * 100}%`;
            } else {
                refs.tiltShiftPinOverlay.style.display = 'none';
            }
            const loupeEyedropper = state.eyedropperTarget?.kind === 'bg-patcher-main'
                || state.eyedropperTarget?.kind === 'bg-patcher-protected'
                || state.eyedropperTarget?.kind === 'bg-patcher-patch'
                || state.eyedropperTarget?.kind === 'expander-color';
            if (!hasSource || !loupeEyedropper) {
                hideLoupe();
            }
            applyPreviewScale();
            bindPipelineDrag();
        } else {
            hideLoupe();
        }

        if (activeSection === 'composite') {
            compositePanel.render(state.compositeDocument).catch((error) => console.error(error));
        }
        if (activeSection === 'stitch') {
            stitchPanel.render(state.stitchDocument).catch((error) => console.error(error));
        }
        if (activeSection === '3d') {
            threedPanel.render(state);
        }
        if (activeSection === 'settings') {
            settingsPanel.render(state);
        }
    }

    function destroy() {
        previewResizeObserver?.disconnect();
        loupeTicker = null;
    }
    
    function hexToRgb(hex) {
        if (!hex) return [0, 0, 0];
        const bigint = parseInt(hex.slice(1), 16);
        return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
    }

    function drawToleranceSpectrums(state) {
        const canvases = refs.sidebarPanel.querySelectorAll('.tolerance-spectrum-canvas');
        canvases.forEach(canvas => {
            const instanceId = canvas.dataset.instance;
            const instance = state.document.layerStack.find(l => l.instanceId === instanceId);
            if (!instance) return;
            
            const tol = (clamp(Number(instance.params.bgPatcherTolerance || 0), 0, 100) / 100) * 1.5;
            const targetColorHex = instance.params.bgPatcherTargetColor || '#000000';
            const rgb = hexToRgb(targetColorHex).map(v => v / 255);
            
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const w = canvas.clientWidth;
            const h = canvas.clientHeight;
            if (w === 0 || h === 0) return;
            if (canvas.width !== w) canvas.width = w;
            if (canvas.height !== h) canvas.height = h;

            const grad = ctx.createLinearGradient(0, 0, w, 0);
            for (let i = 0; i <= 4; i++) {
                const mix = (i / 4.0) * 2.0 - 1.0; 
                const variance = (tol / Math.sqrt(3)) * mix;
                const tr = Math.round(clamp(rgb[0] + variance, 0.0, 1.0) * 255);
                const tg = Math.round(clamp(rgb[1] + variance, 0.0, 1.0) * 255);
                const tb = Math.round(clamp(rgb[2] + variance, 0.0, 1.0) * 255);
                grad.addColorStop(i / 4.0, `rgb(${tr},${tg},${tb})`);
            }
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        });
    }

    return {
        render,
        setEditorProgress(payload = null) {
            if (payload?.active) {
                editorProgressOverlay.show(payload);
                return;
            }
            editorProgressOverlay.hide();
        },
        setCompositeProgress(payload = null) {
            compositePanel.setProgressOverlay?.(payload);
        },
        setStitchProgress(payload = null) {
            stitchPanel.setProgressOverlay?.(payload);
        },
        setThreeDProgress(payload = null) {
            threedPanel.setProgressOverlay?.(payload);
        },
        refreshLibrary() {
            libraryPanel.refresh();
            threedPanel.refreshLibraryAssets?.();
        },
        primeLibrary() {
            libraryPanel.refresh({ forceInactive: true });
            threedPanel.refreshLibraryAssets?.();
        },
        openStitchPicker() {
            stitchPanel.openPicker?.();
        },
        openCompositeImagePicker() {
            compositePanel.openImagePicker?.();
        },
        openCompositeStatePicker() {
            compositePanel.openStatePicker?.();
        },
        openCompositeProjectPicker() {
            return compositePanel.openProjectPicker?.();
        },
        getCompositeViewportMetrics() {
            return compositePanel.getViewportMetrics?.();
        },
        captureCompositePreview(document) {
            return compositePanel.capturePreview?.(document);
        },
        exportCompositePng(document) {
            return compositePanel.exportPngBlob?.(document);
        },
        captureThreeDPreview() {
            return threedPanel.capturePreview?.();
        },
        captureThreeDViewportPng() {
            return threedPanel.captureViewportPng?.();
        },
        clientToImageUv(clientX, clientY) {
            return clientToImageUv(clientX, clientY, refs.previewScaleWrap.getBoundingClientRect());
        },
        getRenderRefs() {
            return {
                sourcePreviewCanvas: refs.sourcePreviewCanvas,
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
                breakdownContainer: root.querySelector('#breakdownContainer'),
                subLayerCanvas: root.querySelector('#subLayerCanvas'),
                subLayerLabel: root.querySelector('#subLayerLabel')
            };
        },
        requestAppConfirm,
        requestAppText,
        destroy() {
            if (logsTabPulseTimer) clearTimeout(logsTabPulseTimer);
            unsubscribeLogEvents();
            settingsPanel.destroy?.();
        }
    };
}
