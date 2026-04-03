import { STITCH_ANALYSIS_GROUPS } from '../stitch/meta.js';

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatBytes(value = 0) {
    const bytes = Math.max(0, Number(value) || 0);
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = bytes;
    let index = 0;
    while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
    }
    return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1).replace(/\.0$/, '')} ${units[index]}`;
}

function formatPercent(value = 0) {
    return `${(Math.max(0, Math.min(1, Number(value) || 0)) * 100).toFixed(0)}%`;
}

function normalizeCategory(category) {
    const normalized = String(category || '').trim().toLowerCase();
    return ['general', 'library', 'editor', 'stitch', '3d', 'logs'].includes(normalized) ? normalized : 'general';
}

const CATEGORIES = [
    ['general', 'General', 'Theme, save behavior, workers, settings import/export'],
    ['library', 'Library', 'Storage, auto-load, defaults, maintenance'],
    ['editor', 'Editor', 'Viewport defaults, palette automation, checker tone'],
    ['stitch', 'Stitch', 'Analysis defaults, photo runtime diagnostics, workspace-first behavior'],
    ['3d', '3D', 'Navigation, helpers, snapping, render defaults'],
    ['logs', 'Logs', 'Retention, cards, flash effects, filters']
];

const SETTING_ICONS = {
    'general': `<svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.91,7.62,6.29L5.23,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.72,8.87 c-0.11,0.2-0.06,0.47,0.12,0.61l2.03,1.58C4.84,11.36,4.81,11.68,4.81,12c0,0.32,0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.11-0.2,0.06-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>`,
    'library': `<svg viewBox="0 0 24 24"><path d="M20,8.18v8.64c0,0.44-0.24,0.86-0.61,1.08l-7,4.04c-0.25,0.14-0.54,0.14-0.79,0l-7-4.04 c-0.38-0.22-0.61-0.63-0.61-1.08V8.18c0-0.44,0.24-0.86,0.61-1.08l7-4.04c0.25-0.14,0.54-0.14,0.79,0l7,4.04 C19.76,7.31,20,7.73,20,8.18z M12,4.02L5,8.06l7,4.04l7-4.04L12,4.02z M19,9.81l-6,3.46v6.91l6-3.46V9.81z M5,9.81v6.91l6,3.46v-6.91 L5,9.81z"/></svg>`,
    'editor': `<svg viewBox="0 0 24 24"><path d="M4,10.5c-0.83,0-1.5,0.67-1.5,1.5s0.67,1.5,1.5,1.5s1.5-0.67,1.5-1.5S4.83,10.5,4,10.5z M4,4.5C3.17,4.5,2.5,5.17,2.5,6s0.67,1.5,1.5,1.5S5.5,6.83,5.5,6S4.83,4.5,4,4.5z M4,16.5c-0.83,0-1.5,0.67-1.5,1.5s0.67,1.5,1.5,1.5s1.5-0.67,1.5-1.5S4.83,16.5,4,16.5z M7,19h14v-2H7V19z M7,13h14v-2H7V13z M7,7h14V5H7V7z"/></svg>`,
    'stitch': `<svg viewBox="0 0 24 24"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5c0-1.38-1.12-2.5-2.5-2.5S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v4h1.5c1.38 0 2.5 1.12 2.5 2.5S4.88 16 3.5 16H2v4c0 1.1.9 2 2 2h4v-1.5c0-1.38 1.12-2.5 2.5-2.5S13 19.12 13 20.5V22h4c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>`,
    '3d': `<svg viewBox="0 0 24 24"><path d="M12,2L3,7v10l9,5l9-5V7L12,2z M12,12l-7-3.9L12,4.2l7,3.9L12,12z M12,21l-7-3.9v-7l7,3.9V21z M19,17.1l-7,3.9v-7l7-3.9V17.1z"/></svg>`,
    'logs': `<svg viewBox="0 0 24 24"><path d="M19,3h-4.18C14.4,1.84,13.3,1,12,1S9.6,1.84,9.18,3H5C3.9,3,3,3.9,3,5v14c0,1.1,0.9,2,2,2h14c1.1,0,2-0.9,2-2V5 C21,3.9,20.1,3,19,3z M12,3c0.55,0,1,0.45,1,1s-0.45,1-1,1s-1-0.45-1-1S11.45,3,12,3z M7,7h10v2H7V7z M7,11h10v2H7V11z M7,15h10v2H7V15z"/></svg>`
};

function renderRail(category) {
    return CATEGORIES.map(([id, label, summary]) => `
        <button type="button" class="settings-rail-button ${category === id ? 'is-active' : ''}" data-settings-action="category" data-category="${id}">
            <div class="settings-rail-button-head">
                <span class="settings-rail-icon">${SETTING_ICONS[id] || '&#8226;'}</span>
                <strong>${label}</strong>
            </div>
            <span>${summary}</span>
        </button>
    `).join('');
}

function renderField({ type = 'checkbox', path, label, value, min, max, step, options = [], note = '' }) {
    if (type === 'select') {
        return `
            <label class="settings-field">
                <span>${escapeHtml(label)}</span>
                <select class="custom-select" data-settings-path="${escapeHtml(path)}">
                    ${options.map(([optionValue, optionLabel]) => `<option value="${escapeHtml(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${escapeHtml(optionLabel)}</option>`).join('')}
                </select>
                ${note ? `<small>${escapeHtml(note)}</small>` : ''}
            </label>
        `;
    }
    if (type === 'number' || type === 'range') {
        return `
            <label class="settings-field">
                <span>${escapeHtml(label)}</span>
                <input class="${type === 'number' ? 'control-number' : ''}" type="${type}" ${min != null ? `min="${min}"` : ''} ${max != null ? `max="${max}"` : ''} ${step != null ? `step="${step}"` : ''} data-settings-path="${escapeHtml(path)}" value="${escapeHtml(value)}">
                ${note ? `<small>${escapeHtml(note)}</small>` : ''}
            </label>
        `;
    }
    return `
        <label class="settings-field settings-field-toggle">
            <span>${escapeHtml(label)}</span>
            <input type="checkbox" data-settings-path="${escapeHtml(path)}" ${value ? 'checked' : ''}>
        </label>
    `;
}

function renderStitchDefaultField(field, settings, diagnostics) {
    const value = settings?.stitch?.defaults?.[field.key];
    const path = `stitch.defaults.${field.key}`;
    const supportedDetectors = Array.isArray(diagnostics?.supportedDetectors) ? diagnostics.supportedDetectors : [];
    const disableSift = field.key === 'featureDetector' && !supportedDetectors.includes('sift');
    const note = disableSift
        ? `${field.help} SIFT is disabled because the current OpenCV runtime does not report SIFT support.`
        : field.help;

    if (field.type === 'select') {
        return `
            <label class="settings-field">
                <span>${escapeHtml(field.label)}</span>
                <select class="custom-select" data-settings-path="${escapeHtml(path)}">
                    ${field.options.map((option) => {
                        const disabled = option.value === 'sift' && disableSift;
                        return `<option value="${escapeHtml(option.value)}" ${String(value) === String(option.value) ? 'selected' : ''} ${disabled ? 'disabled' : ''}>${escapeHtml(option.label)}</option>`;
                    }).join('')}
                </select>
                <small>${escapeHtml(note)}</small>
            </label>
        `;
    }
    if (field.type === 'checkbox') {
        return `
            <div class="settings-field">
                <label class="settings-field settings-field-toggle" style="padding:0;border:none;background:transparent">
                    <span>${escapeHtml(field.label)}</span>
                    <input type="checkbox" data-settings-path="${escapeHtml(path)}" ${value ? 'checked' : ''}>
                </label>
                <small>${escapeHtml(note)}</small>
            </div>
        `;
    }
    return `
        <label class="settings-field">
            <span>${escapeHtml(field.label)}</span>
            <input class="control-number" type="number" ${field.min != null ? `min="${field.min}"` : ''} ${field.max != null ? `max="${field.max}"` : ''} ${field.step != null ? `step="${field.step}"` : ''} data-settings-path="${escapeHtml(path)}" value="${escapeHtml(value)}">
            <small>${escapeHtml(note)}</small>
        </label>
    `;
}

function renderCategoryContent(category, settings) {
    const storage = settings?.diagnostics?.storageEstimate;
    const storageSummary = storage ? `${formatBytes(storage.usage)} used of ${formatBytes(storage.quota)} (${formatPercent(storage.ratio)})` : 'Storage estimate unavailable in this browser.';
    if (category === 'general') {
        return `
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">General</div><h3>Application Defaults</h3></div></div>
                <div class="settings-field-grid">
                    ${renderField({ type: 'select', path: 'general.theme', label: 'Theme', value: settings.general.theme, options: [['light', 'Light'], ['dark', 'Dark']] })}
                    ${renderField({ path: 'general.saveImageOnSave', label: 'Save Image On Save', value: settings.general.saveImageOnSave })}
                    ${renderField({ type: 'number', path: 'general.maxBackgroundWorkers', label: 'Max background workers', value: settings.general.maxBackgroundWorkers, min: 0, max: 64, step: 1, note: 'Set 0 for automatic scheduling.' })}
                </div>
                <div class="settings-kpi-grid">
                    <div class="settings-kpi"><span>Detected CPU cores</span><strong>${escapeHtml(settings.diagnostics.detectedCpuCores || 0)}</strong></div>
                    <div class="settings-kpi"><span>Applied worker limit</span><strong>${escapeHtml(settings.diagnostics.workerLimitApplied || 'Auto')}</strong></div>
                    <div class="settings-kpi"><span>Asset version</span><strong>${escapeHtml(settings.diagnostics.assetVersion || 'Unknown')}</strong></div>
                </div>
            </section>
        `;
    }
    if (category === 'library') {
        return `
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">Library</div><h3>Storage And Defaults</h3></div><button type="button" class="toolbar-button" data-settings-action="refresh-storage">Refresh Storage Info</button></div>
                <div class="settings-banner">${escapeHtml(storageSummary)}</div>
                <div class="settings-field-grid">
                    ${renderField({ path: 'library.autoLoadOnStartup', label: 'Automatic Library Loading', value: settings.library.autoLoadOnStartup })}
                    ${renderField({ type: 'range', path: 'library.storagePressureThreshold', label: 'Storage pressure alert threshold', value: settings.library.storagePressureThreshold, min: 0.1, max: 0.98, step: 0.01, note: formatPercent(settings.library.storagePressureThreshold) })}
                    ${renderField({ type: 'select', path: 'library.defaultViewLayout', label: 'Default view layout', value: settings.library.defaultViewLayout, options: [['grid', 'Grid'], ['list', 'List']] })}
                    ${renderField({ type: 'select', path: 'library.defaultSortKey', label: 'Default sort method', value: settings.library.defaultSortKey, options: [['timestamp', 'Saved Date'], ['name', 'Name'], ['source-area', 'Original Size'], ['render-area', 'Rendered Size']] })}
                    ${renderField({ type: 'select', path: 'library.defaultSortDirection', label: 'Default sort direction', value: settings.library.defaultSortDirection, options: [['desc', 'Descending'], ['asc', 'Ascending']] })}
                    ${renderField({ type: 'select', path: 'library.assetPreviewQuality', label: '3D asset preview quality', value: settings.library.assetPreviewQuality, options: [['performance', 'Performance'], ['balanced', 'Balanced'], ['quality', 'Quality']] })}
                    ${renderField({ path: 'library.secureExportByDefault', label: 'Secure export by default', value: settings.library.secureExportByDefault })}
                    ${renderField({ path: 'library.requireTagOnImport', label: 'Require tag on project load/import into the Library', value: settings.library.requireTagOnImport })}
                </div>
            </section>
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">Maintenance</div><h3>Background Repair And Cleanup</h3></div></div>
                <div class="settings-button-grid">
                    <button type="button" class="toolbar-button" data-settings-action="maintenance" data-kind="purge-rendered-previews">Purge Rendered Images</button>
                    <button type="button" class="toolbar-button" data-settings-action="maintenance" data-kind="heal-rendered-previews">Heal Missing Images</button>
                    <button type="button" class="toolbar-button" data-settings-action="maintenance" data-kind="cleanup-orphaned-assets">Cleanup Orphaned Assets</button>
                    <button type="button" class="toolbar-button" data-settings-action="maintenance" data-kind="clear-cache">Clear Cache</button>
                    <button type="button" class="toolbar-button is-danger" data-settings-action="maintenance" data-kind="wipe-library">Wipe Library</button>
                    <button type="button" class="toolbar-button is-danger" data-settings-action="maintenance" data-kind="wipe-assets">Wipe Assets</button>
                </div>
            </section>
        `;
    }
    if (category === 'editor') {
        return `
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">Editor</div><h3>Viewport Defaults</h3></div></div>
                <div class="settings-field-grid">
                    ${renderField({ path: 'editor.defaultHighQualityPreview', label: 'Default to high quality preview', value: settings.editor.defaultHighQualityPreview })}
                    ${renderField({ path: 'editor.hoverCompareOriginal', label: 'Hover compare original', value: settings.editor.hoverCompareOriginal })}
                    ${renderField({ path: 'editor.isolateActiveLayerChain', label: 'Isolate active layer chain', value: settings.editor.isolateActiveLayerChain })}
                    ${renderField({ path: 'editor.layerPreviewsOpen', label: 'Sub-layer previews drawer open by default', value: settings.editor.layerPreviewsOpen })}
                    ${renderField({ path: 'editor.autoExtractPaletteOnLoad', label: 'Auto-extract palette on image load', value: settings.editor.autoExtractPaletteOnLoad })}
                    ${renderField({ type: 'select', path: 'editor.transparencyCheckerTone', label: 'Transparency checker tone', value: settings.editor.transparencyCheckerTone, options: [['light', 'Light'], ['dark', 'Dark']] })}
                </div>
            </section>
        `;
    }
    if (category === 'stitch') {
        const diagnostics = settings?.stitch?.diagnostics || {};
        const supportedDetectors = Array.isArray(diagnostics.supportedDetectors) ? diagnostics.supportedDetectors : [];
        return `
            <section class="settings-card">
                <div class="settings-card-header">
                    <div>
                        <div class="settings-eyebrow">Stitch Defaults</div>
                        <h3>New Project Analysis Defaults</h3>
                    </div>
                    <div class="settings-actions">
                        <button type="button" class="toolbar-button" data-settings-action="stitch-apply-defaults">Apply Defaults To Current Stitch Project</button>
                        <button type="button" class="toolbar-button" data-settings-action="stitch-probe-runtime">Probe Photo Runtime</button>
                    </div>
                </div>
                <div class="settings-banner">Stitch stays workspace-first. These defaults apply to new Stitch projects and explicit apply-defaults actions. The live Stitch tab still owns the current project.</div>
            </section>
            ${STITCH_ANALYSIS_GROUPS.map((group) => `
                <section class="settings-card">
                    <div class="settings-card-header">
                        <div>
                            <div class="settings-eyebrow">Stitch ${escapeHtml(group.title)}</div>
                            <h3>${escapeHtml(group.title)} Defaults</h3>
                        </div>
                    </div>
                    <div class="settings-field-grid">
                        ${group.fields.map((field) => renderStitchDefaultField(field, settings, diagnostics)).join('')}
                    </div>
                </section>
            `).join('')}
            <section class="settings-card">
                <div class="settings-card-header">
                    <div>
                        <div class="settings-eyebrow">Runtime Diagnostics</div>
                        <h3>Photo Mode Readiness</h3>
                    </div>
                </div>
                <div class="settings-kpi-grid">
                    <div class="settings-kpi"><span>Worker</span><strong>${diagnostics.workerAvailable ? 'Ready' : 'Unavailable'}</strong></div>
                    <div class="settings-kpi"><span>WASM</span><strong>${diagnostics.wasmAvailable ? 'Ready' : 'Unavailable'}</strong></div>
                    <div class="settings-kpi"><span>Photo Runtime</span><strong>${diagnostics.runtimeAvailable ? 'Ready' : 'Unavailable'}</strong></div>
                    <div class="settings-kpi"><span>Detectors</span><strong>${escapeHtml(supportedDetectors.length ? supportedDetectors.join(', ') : 'None')}</strong></div>
                </div>
                <div class="settings-field-grid" style="margin-top:16px">
                    <div class="settings-field">
                        <span>Last runtime selection</span>
                        <small>${escapeHtml(diagnostics.lastRuntimeSelection || 'No Stitch analysis runtime has been selected yet.')}</small>
                    </div>
                    <div class="settings-field">
                        <span>Last fallback reason</span>
                        <small>${escapeHtml(diagnostics.lastFallbackReason || 'No fallback recorded.')}</small>
                    </div>
                </div>
            </section>
        `;
    }
    if (category === '3d') {
        return `
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">3D Preferences</div><h3>Viewport And Navigation</h3></div><button type="button" class="toolbar-button" data-settings-action="apply-3d-defaults">Apply Render Defaults To Current Scene</button></div>
                <div class="settings-field-grid">
                    ${renderField({ type: 'select', path: 'threeD.preferences.cameraMode', label: 'Navigation mode', value: settings.threeD.preferences.cameraMode, options: [['orbit', 'Orbit'], ['fly', 'Fly']] })}
                    ${renderField({ type: 'select', path: 'threeD.preferences.wheelMode', label: 'Mouse wheel behavior', value: settings.threeD.preferences.wheelMode, options: [['travel', 'Dolly / Travel'], ['zoom', 'Zoom / FOV']] })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.flyMoveSpeed', label: 'Fly move speed', value: settings.threeD.preferences.flyMoveSpeed, min: 0.25, max: 64, step: 0.25 })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.flyLookSensitivity', label: 'Fly look sensitivity', value: settings.threeD.preferences.flyLookSensitivity, min: 0.0005, max: 0.03, step: 0.0005 })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.fov', label: 'Default field of view', value: settings.threeD.preferences.fov, min: 15, max: 120, step: 1 })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.near', label: 'Near clipping plane', value: settings.threeD.preferences.near, min: 0.01, max: 100, step: 0.01 })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.far', label: 'Far clipping plane', value: settings.threeD.preferences.far, min: 10, max: 10000, step: 1 })}
                    ${renderField({ path: 'threeD.preferences.showGrid', label: 'Show grid by default', value: settings.threeD.preferences.showGrid })}
                    ${renderField({ path: 'threeD.preferences.showAxes', label: 'Show axes by default', value: settings.threeD.preferences.showAxes })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.gizmoScale', label: 'Gizmo scale', value: settings.threeD.preferences.gizmoScale, min: 0.4, max: 4, step: 0.1 })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.snapTranslationStep', label: 'Move snap increment', value: settings.threeD.preferences.snapTranslationStep, min: 0, max: 1000, step: 0.01 })}
                    ${renderField({ type: 'number', path: 'threeD.preferences.snapRotationDegrees', label: 'Rotation snap degrees', value: settings.threeD.preferences.snapRotationDegrees, min: 0, max: 360, step: 1 })}
                    ${renderField({ path: 'threeD.preferences.viewportHighResCap', label: 'High-resolution scaling cap', value: settings.threeD.preferences.viewportHighResCap })}
                </div>
            </section>
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">3D Defaults</div><h3>New Scene Render Defaults</h3></div></div>
                <div class="settings-field-grid">
                    ${renderField({ type: 'number', path: 'threeD.defaults.samplesTarget', label: 'Target samples', value: settings.threeD.defaults.samplesTarget, min: 1, max: 4096, step: 1 })}
                    ${renderField({ type: 'number', path: 'threeD.defaults.bounces', label: 'Bounces', value: settings.threeD.defaults.bounces, min: 1, max: 64, step: 1 })}
                    ${renderField({ type: 'number', path: 'threeD.defaults.transmissiveBounces', label: 'Transmissive bounces', value: settings.threeD.defaults.transmissiveBounces, min: 0, max: 64, step: 1 })}
                    ${renderField({ type: 'number', path: 'threeD.defaults.filterGlossyFactor', label: 'Glossy firefly filter', value: settings.threeD.defaults.filterGlossyFactor, min: 0, max: 1, step: 0.01 })}
                    ${renderField({ path: 'threeD.defaults.denoiseEnabled', label: 'Denoise by default', value: settings.threeD.defaults.denoiseEnabled })}
                    ${renderField({ type: 'number', path: 'threeD.defaults.denoiseSigma', label: 'Denoise sigma', value: settings.threeD.defaults.denoiseSigma, min: 0.5, max: 12, step: 0.1 })}
                    ${renderField({ type: 'number', path: 'threeD.defaults.denoiseThreshold', label: 'Denoise threshold', value: settings.threeD.defaults.denoiseThreshold, min: 0.0001, max: 1, step: 0.001 })}
                    ${renderField({ type: 'number', path: 'threeD.defaults.denoiseKSigma', label: 'Denoise radius scale', value: settings.threeD.defaults.denoiseKSigma, min: 0.1, max: 5, step: 0.1 })}
                    ${renderField({ type: 'select', path: 'threeD.defaults.toneMapping', label: 'Default tone mapping', value: settings.threeD.defaults.toneMapping, options: [['aces', 'ACES'], ['neutral', 'Neutral'], ['none', 'None']] })}
                </div>
            </section>
        `;
    }
    return `
        <section class="settings-card">
            <div class="settings-card-header"><div><div class="settings-eyebrow">Logs</div><h3>Retention And UI Behavior</h3></div></div>
            <div class="settings-field-grid">
                ${renderField({ type: 'number', path: 'logs.recentLimit', label: 'Max lines per card', value: settings.logs.recentLimit, min: 6, max: 200, step: 1 })}
                ${renderField({ type: 'number', path: 'logs.historyLimit', label: 'Process history limit', value: settings.logs.historyLimit, min: 0, max: 2000, step: 1, note: 'Set 0 for unlimited.' })}
                ${renderField({ type: 'select', path: 'logs.autoClearSuccessMs', label: 'Auto-clear successful tasks', value: settings.logs.autoClearSuccessMs, options: [['0', 'Off'], ['60000', '1 minute'], ['300000', '5 minutes']] })}
                ${renderField({ type: 'number', path: 'logs.maxUiCards', label: 'Maximum UI cards', value: settings.logs.maxUiCards, min: 0, max: 100, step: 1, note: 'Set 0 for unlimited.' })}
                ${renderField({ path: 'logs.completionFlashEffects', label: 'Completion flash effects', value: settings.logs.completionFlashEffects })}
                ${renderField({ type: 'select', path: 'logs.levelFilter', label: 'Log level filter', value: settings.logs.levelFilter, options: [['all', 'All messages'], ['warnings-errors', 'Warnings and errors only']] })}
                ${renderField({ path: 'logs.compactMessages', label: 'Message compaction', value: settings.logs.compactMessages })}
            </div>
        </section>
    `;
}

export function createSettingsPanel(root, { actions } = {}) {
    root.innerHTML = `
        <style data-settings-panel-style>
            :root {
                --s-bg-main: #0a0c10;
                --s-bg-side: #0e1116;
                --s-bg-card: rgba(20, 24, 30, 0.65);
                --s-bg-field: rgba(255, 255, 255, 0.03);
                --s-accent: #f5d08e;
                --s-accent-rgb: 245, 208, 142;
                --s-text: #f5f1e8;
                --s-text-muted: rgba(245, 241, 232, 0.6);
                --s-border: rgba(255, 255, 255, 0.08);
                --s-radius: 8px;
            }
            .settings-shell {
                height: 100%;
                min-height: 0;
                display: grid;
                grid-template-columns: 280px 1fr;
                background: var(--s-bg-main);
                color: var(--s-text);
                font-family: inherit;
            }
            .settings-rail {
                padding: 32px 20px;
                background: var(--s-bg-side);
                border-right: 1px solid var(--s-border);
                display: flex;
                flex-direction: column;
                gap: 24px;
                overflow-y: auto;
            }
            .settings-rail h2 {
                margin: 0;
                font-size: 1.5rem;
                font-weight: 600;
                letter-spacing: -0.01em;
            }
            .settings-rail-copy {
                font-size: 12px;
                line-height: 1.6;
                color: var(--s-text-muted);
            }
            .settings-rail-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .settings-rail-button {
                display: flex;
                flex-direction: column;
                gap: 8px;
                padding: 14px 16px;
                background: transparent;
                border: 1px solid transparent;
                border-radius: var(--s-radius);
                color: var(--s-text);
                cursor: pointer;
                transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
                text-align: left;
            }
            .settings-rail-button-head {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            .settings-rail-icon {
                font-size: 16px;
                display: flex;
                align-items: center;
                justify-content: center;
                width: 24px;
                height: 24px;
                background: rgba(255, 255, 255, 0.05);
                border-radius: 6px;
                color: var(--s-text-muted);
                transition: all 0.2s ease;
            }
            .settings-rail-icon svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }
            .settings-rail-button.is-active .settings-rail-icon {
                background: rgba(var(--s-accent-rgb), 0.15);
                color: var(--s-accent);
                box-shadow: 0 0 8px rgba(var(--s-accent-rgb), 0.2);
            }
            .settings-rail-button:hover {
                background: rgba(255, 255, 255, 0.04);
                border-color: rgba(255, 255, 255, 0.1);
            }
            .settings-rail-button.is-active {
                background: rgba(var(--s-accent-rgb), 0.08);
                border-color: rgba(var(--s-accent-rgb), 0.3);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
            }
            .settings-rail-button strong {
                font-size: 13px;
                font-weight: 600;
                color: var(--s-text);
            }
            .settings-rail-button.is-active strong {
                color: var(--s-accent);
            }
            .settings-rail-button span {
                font-size: 11px;
                color: var(--s-text-muted);
                line-height: 1.4;
            }
            .settings-content {
                display: grid;
                grid-template-rows: auto auto 1fr;
                min-height: 0;
                background: radial-gradient(circle at top right, rgba(var(--s-accent-rgb), 0.03), transparent 40%);
            }
            .settings-header {
                padding: 32px 40px;
                display: flex;
                align-items: flex-start;
                justify-content: space-between;
                gap: 24px;
                border-bottom: 1px solid var(--s-border);
                min-height: 124px; /* Normalize height across all categories */
            }
            .settings-header h3 {
                margin: 4px 0 8px;
                font-size: 24px;
                font-weight: 600;
                line-height: 1.2;
            }
            .settings-header p {
                margin: 0;
                font-size: 13px;
                color: var(--s-text-muted);
                line-height: 1.5;
            }
            .settings-actions {
                display: flex;
                gap: 10px;
            }
            .settings-scroll {
                padding: 32px 40px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 32px;
                transition: opacity 0.15s ease, transform 0.15s ease, filter 0.15s ease;
            }
            .settings-scroll.is-switching {
                opacity: 0;
                transform: translateY(8px);
                filter: blur(4px);
                pointer-events: none;
            }
            .settings-scroll.is-entering {
                animation: settings-content-in 0.35s cubic-bezier(0.2, 0, 0, 1) forwards;
            }
            @keyframes settings-content-in {
                0% { opacity: 0; transform: translateY(8px); filter: blur(4px); }
                100% { opacity: 1; transform: translateY(0); filter: blur(0); }
            }
            .settings-card {
                background: var(--s-bg-card);
                border: 1px solid var(--s-border);
                border-radius: 12px;
                padding: 24px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
                backdrop-filter: blur(12px);
            }
            .settings-card-header {
                margin-bottom: 24px;
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
            }
            .settings-eyebrow {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.12em;
                color: var(--s-accent);
                margin-bottom: 6px;
            }
            .settings-card h3 {
                margin: 0;
                font-size: 17px;
                font-weight: 600;
            }
            .settings-field-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
                gap: 16px;
            }
            .settings-field {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 16px;
                background: var(--s-bg-field);
                border: 1px solid var(--s-border);
                border-radius: var(--s-radius);
                transition: border-color 0.2s ease;
            }
            .settings-field:focus-within {
                border-color: rgba(var(--s-accent-rgb), 0.4);
            }
            .settings-field span {
                font-size: 13px;
                font-weight: 500;
                color: var(--s-text);
            }
            .settings-field small {
                font-size: 11px;
                color: var(--s-text-muted);
            }
            /* Custom Toggles */
            .settings-field-toggle {
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
            }
            .settings-field-toggle input[type="checkbox"] {
                appearance: none;
                width: 38px;
                height: 20px;
                background: rgba(255, 255, 255, 0.1);
                border-radius: 20px;
                position: relative;
                cursor: pointer;
                transition: background 0.2s ease;
                flex-shrink: 0;
                margin: 0;
            }
            .settings-field-toggle input[type="checkbox"]::before {
                content: '';
                position: absolute;
                width: 14px;
                height: 14px;
                background: #fff;
                border-radius: 50%;
                top: 3px;
                left: 3px;
                transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .settings-field-toggle input[type="checkbox"]:checked {
                background: var(--s-accent);
            }
            .settings-field-toggle input[type="checkbox"]:checked::before {
                transform: translateX(18px);
                background: #000;
            }
            /* Styled Inputs */
            .custom-select, .control-number {
                background: rgba(0, 0, 0, 0.2);
                border: 1px solid var(--s-border);
                border-radius: 6px;
                padding: 8px 12px;
                color: var(--s-text);
                font-size: 13px;
                outline: none;
                transition: border-color 0.2s ease;
            }
            .custom-select:focus, .control-number:focus {
                border-color: var(--s-accent);
            }
            /* Progress & KPI Styles */
            .settings-banner {
                margin-bottom: 20px;
                padding: 12px 16px;
                background: rgba(var(--s-accent-rgb), 0.05);
                border: 1px solid rgba(var(--s-accent-rgb), 0.1);
                border-radius: var(--s-radius);
                font-size: 12px;
                color: var(--s-accent);
            }
            .settings-kpi-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                gap: 12px;
                margin-top: 24px;
            }
            .settings-kpi {
                padding: 16px;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid var(--s-border);
                border-radius: var(--s-radius);
                text-align: center;
            }
            .settings-kpi span {
                display: block;
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.05em;
                color: var(--s-text-muted);
                margin-bottom: 4px;
            }
            .settings-kpi strong {
                font-size: 18px;
                font-weight: 600;
                color: var(--s-accent);
            }
            /* Range Styling */
            input[type="range"] {
                appearance: none;
                background: transparent;
                cursor: pointer;
                width: 100%;
                margin: 10px 0;
            }
            input[type="range"]::-webkit-slider-runnable-track {
                background: rgba(255, 255, 255, 0.1);
                height: 4px;
                border-radius: 4px;
            }
            input[type="range"]::-webkit-slider-thumb {
                appearance: none;
                width: 16px;
                height: 16px;
                background: var(--s-accent);
                border-radius: 50%;
                margin-top: -6px;
                box-shadow: 0 0 10px rgba(var(--s-accent-rgb), 0.4);
            }
            /* Feedback styling */
            .settings-feedback {
                padding: 12px 40px;
                font-size: 13px;
                font-weight: 500;
                background: #111;
                border-bottom: 1px solid var(--s-border);
                display: flex;
                align-items: center;
                gap: 8px;
                height: 0;
                overflow: hidden;
                opacity: 0;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }
            .settings-feedback.is-visible {
                height: 44px;
                opacity: 1;
            }
            .settings-feedback[data-tone="success"] { color: #8ef5b4; background: rgba(142, 245, 180, 0.05); }
            .settings-feedback[data-tone="warning"] { color: #f5d08e; background: rgba(245, 208, 142, 0.05); }
            .settings-feedback[data-tone="error"] { color: #f58e8e; background: rgba(245, 142, 142, 0.05); }

            /* Action Buttons Styling (override toolbar-button for settings context) */
            .settings-actions .toolbar-button {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid var(--s-border);
                color: var(--s-text);
                padding: 8px 16px;
                border-radius: 6px;
                font-size: 12px;
                font-weight: 500;
                transition: all 0.2s ease;
            }
            .settings-actions .toolbar-button:hover {
                background: rgba(255, 255, 255, 0.1);
                border-color: rgba(255, 255, 255, 0.2);
            }
            .settings-actions .toolbar-button.is-danger {
                background: rgba(255, 142, 142, 0.05);
                border-color: rgba(255, 142, 142, 0.1);
                color: #f58e8e;
            }
            .settings-actions .toolbar-button.is-danger:hover {
                background: rgba(255, 142, 142, 0.15);
                border-color: rgba(255, 142, 142, 0.3);
                color: #fff;
            }

            @media (max-width: 980px) {
                .settings-shell { grid-template-columns: 1fr; }
                .settings-rail { border-right: none; border-bottom: 1px solid var(--s-border); }
                .settings-header, .settings-scroll { padding: 24px; }
            }
        </style>
        <div class="settings-shell">
            <aside class="settings-rail">
                <h2>Settings</h2>
                <div class="settings-rail-copy">App-wide preferences, maintenance actions, and runtime limits that persist across loads.</div>
                <div class="settings-rail-list" data-settings-role="rail"></div>
            </aside>
            <section class="settings-content">
                <header class="settings-header">
                    <div>
                        <div class="settings-eyebrow">Preferences</div>
                        <h3 data-settings-role="title">General</h3>
                        <p data-settings-role="summary">Theme, save behavior, workers, settings import/export</p>
                    </div>
                    <div class="settings-actions">
                        <button type="button" class="toolbar-button" data-settings-action="export">Export Settings</button>
                        <button type="button" class="toolbar-button" data-settings-action="import">Import Settings</button>
                        <button type="button" class="toolbar-button" data-settings-action="reset-category">Reset Category</button>
                        <button type="button" class="toolbar-button is-danger" data-settings-action="reset-all">Reset All</button>
                    </div>
                </header>
                <div class="settings-feedback" data-settings-role="feedback"></div>
                <div class="settings-scroll" data-settings-role="content"></div>
                <input type="file" accept=".json,application/json" hidden data-settings-role="import-input">
            </section>
        </div>
    `;

    const refs = {
        rail: root.querySelector('[data-settings-role="rail"]'),
        title: root.querySelector('[data-settings-role="title"]'),
        summary: root.querySelector('[data-settings-role="summary"]'),
        feedback: root.querySelector('[data-settings-role="feedback"]'),
        content: root.querySelector('[data-settings-role="content"]'),
        importInput: root.querySelector('[data-settings-role="import-input"]')
    };
    let latestState = null;
    let feedbackTimer = null;

    function showFeedback(text, tone = 'success') {
        if (feedbackTimer) clearTimeout(feedbackTimer);
        refs.feedback.textContent = String(text || '');
        refs.feedback.dataset.tone = tone;
        refs.feedback.classList.toggle('is-visible', !!text);
        if (!text) return;
        feedbackTimer = setTimeout(() => refs.feedback.classList.remove('is-visible'), 2200);
    }

    let currentCategory = null;
    let isAnimating = false;

    function render(state) {
        latestState = state;
        const category = normalizeCategory(state?.ui?.settingsCategory);
        const meta = CATEGORIES.find(([id]) => id === category) || CATEGORIES[0];

        if (currentCategory && category !== currentCategory && !isAnimating) {
            isAnimating = true;
            refs.content.classList.add('is-switching');
            
            setTimeout(() => {
                currentCategory = category;
                refs.rail.innerHTML = renderRail(category);
                refs.title.textContent = meta[1];
                refs.summary.textContent = meta[2];
                refs.content.innerHTML = renderCategoryContent(category, state.settings);
                
                requestAnimationFrame(() => {
                    refs.content.classList.remove('is-switching');
                    refs.content.classList.add('is-entering');
                    
                    setTimeout(() => {
                        refs.content.classList.remove('is-entering');
                        isAnimating = false;
                    }, 400);
                });
            }, 150);
            return;
        }

        if (!isAnimating) {
            currentCategory = category;
            refs.rail.innerHTML = renderRail(category);
            refs.title.textContent = meta[1];
            refs.summary.textContent = meta[2];
            refs.content.innerHTML = renderCategoryContent(category, state.settings);
        }
    }

    function readInputValue(target) {
        if (target.type === 'checkbox') return !!target.checked;
        if (target.type === 'number' || target.type === 'range') return Number(target.value);
        return target.value;
    }

    root.addEventListener('click', async (event) => {
        const node = event.target.closest('[data-settings-action]');
        if (!node) return;
        const action = node.dataset.settingsAction;
        if (action === 'category') return actions.setSettingsCategory?.(node.dataset.category);
        if (action === 'export') {
            const result = await actions.exportSettings?.();
            if (result?.status === 'saved') showFeedback('Settings exported.');
            else if (result?.status === 'cancelled') showFeedback('Settings export cancelled.', 'warning');
            return;
        }
        if (action === 'import') {
            refs.importInput.value = '';
            refs.importInput.click();
            return;
        }
        if (action === 'reset-category') {
            const didReset = await actions.resetSettingsCategory?.(normalizeCategory(latestState?.ui?.settingsCategory));
            if (didReset) showFeedback('Category settings reset.');
            return;
        }
        if (action === 'reset-all') {
            const didReset = await actions.resetAllSettings?.();
            if (didReset) showFeedback('All settings reset.');
            return;
        }
        if (action === 'refresh-storage') {
            await actions.refreshSettingsDiagnostics?.();
            showFeedback('Storage estimate refreshed.');
            return;
        }
        if (action === 'maintenance') {
            const result = await actions.runLibraryMaintenance?.(node.dataset.kind || '');
            if (result?.status) {
                const tone = result.status === 'failed'
                    ? 'error'
                    : result.status === 'warning' || result.status === 'cancelled'
                        ? 'warning'
                        : 'success';
                showFeedback(result.message || 'Library maintenance completed.', tone);
            }
            return;
        }
        if (action === 'stitch-apply-defaults') {
            const applied = await actions.applyCurrentStitchDefaults?.();
            if (applied) showFeedback('Stitch defaults applied to the current project.');
            return;
        }
        if (action === 'stitch-probe-runtime') {
            const diagnostics = await actions.probeStitchPhotoRuntime?.();
            if (diagnostics?.runtimeAvailable) {
                showFeedback('Stitch photo runtime is ready.');
            } else if (diagnostics?.lastFallbackReason) {
                showFeedback(diagnostics.lastFallbackReason, 'warning');
            }
            return;
        }
        if (action === 'apply-3d-defaults') {
            const applied = await actions.applyCurrentThreeDDefaults?.();
            if (applied) showFeedback('3D render defaults applied to the current scene.');
        }
    });

    root.addEventListener('change', async (event) => {
        const target = event.target;
        if (target === refs.importInput) {
            const file = refs.importInput.files?.[0];
            if (!file) return;
            const result = await actions.importSettingsFile?.(file);
            if (result?.status === 'success') showFeedback('Settings imported.');
            else if (result?.status === 'cancelled') showFeedback('Settings import cancelled.', 'warning');
            return;
        }
        const path = target?.dataset?.settingsPath;
        if (!path) return;
        await actions.updateAppSetting?.(path, readInputValue(target));
        showFeedback('Setting updated.');
    });

    return {
        activate() {
            root.style.display = 'block';
        },
        deactivate() {
            root.style.display = 'none';
        },
        render,
        destroy() {
            if (feedbackTimer) clearTimeout(feedbackTimer);
        }
    };
}
