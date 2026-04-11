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

function formatInteger(value = 0) {
    const numeric = Math.max(0, Math.round(Number(value) || 0));
    return numeric ? numeric.toLocaleString() : '0';
}

function formatMegapixels(value = 0) {
    const numeric = Math.max(0, Number(value) || 0);
    return `${numeric.toFixed(numeric >= 100 ? 0 : 1).replace(/\.0$/, '')} MP`;
}

function normalizeCategory(category) {
    const normalized = String(category || '').trim().toLowerCase();
    return ['general', 'personalization', 'library', 'editor', 'composite', 'stitch', '3d', 'logs'].includes(normalized) ? normalized : 'general';
}

const CATEGORIES = [
    ['general', 'General'],
    ['personalization', 'Personalization'],
    ['library', 'Library'],
    ['editor', 'Editor'],
    ['composite', 'Composite'],
    ['stitch', 'Stitch'],
    ['3d', '3D'],
    ['logs', 'Logs']
];

const PERSONALIZATION_FIELDS = [
    ['page', 'Page Background'],
    ['surface', 'Raised Surface'],
    ['surfaceSoft', 'Inset Surface'],
    ['text', 'Primary Text'],
    ['muted', 'Muted Text'],
    ['accent', 'Highlight / Accent'],
    ['success', 'Success'],
    ['warning', 'Warning'],
    ['danger', 'Danger']
];

const SETTING_ICONS = {
    'general': `<svg viewBox="0 0 24 24"><path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.91,7.62,6.29L5.23,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.72,8.87 c-0.11,0.2-0.06,0.47,0.12,0.61l2.03,1.58C4.84,11.36,4.81,11.68,4.81,12c0,0.32,0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.11-0.2,0.06-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/></svg>`,
    'personalization': `<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 0 0-9 9a4 4 0 0 0 4 4h1.2a1.3 1.3 0 0 1 1.3 1.3A3.7 3.7 0 0 0 13.2 21H14a7 7 0 0 0 0-14h-2zm-4.1 8.3a1.3 1.3 0 1 1 0-2.6a1.3 1.3 0 0 1 0 2.6zm3.2-3.3a1.3 1.3 0 1 1 0-2.6a1.3 1.3 0 0 1 0 2.6zm3.6.4a1.3 1.3 0 1 1 0-2.6a1.3 1.3 0 0 1 0 2.6zm1.8 4a1.3 1.3 0 1 1 0-2.6a1.3 1.3 0 0 1 0 2.6z"/></svg>`,
    'library': `<svg viewBox="0 0 24 24"><path d="M20,8.18v8.64c0,0.44-0.24,0.86-0.61,1.08l-7,4.04c-0.25,0.14-0.54,0.14-0.79,0l-7-4.04 c-0.38-0.22-0.61-0.63-0.61-1.08V8.18c0-0.44,0.24-0.86,0.61-1.08l7-4.04c0.25-0.14,0.54-0.14,0.79,0l7,4.04 C19.76,7.31,20,7.73,20,8.18z M12,4.02L5,8.06l7,4.04l7-4.04L12,4.02z M19,9.81l-6,3.46v6.91l6-3.46V9.81z M5,9.81v6.91l6,3.46v-6.91 L5,9.81z"/></svg>`,
    'editor': `<svg viewBox="0 0 24 24"><path d="M4,10.5c-0.83,0-1.5,0.67-1.5,1.5s0.67,1.5,1.5,1.5s1.5-0.67,1.5-1.5S4.83,10.5,4,10.5z M4,4.5C3.17,4.5,2.5,5.17,2.5,6s0.67,1.5,1.5,1.5S5.5,6.83,5.5,6S4.83,4.5,4,4.5z M4,16.5c-0.83,0-1.5,0.67-1.5,1.5s0.67,1.5,1.5,1.5s1.5-0.67,1.5-1.5S4.83,16.5,4,16.5z M7,19h14v-2H7V19z M7,13h14v-2H7V13z M7,7h14V5H7V7z"/></svg>`,
    'composite': `<svg viewBox="0 0 24 24"><path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z"/></svg>`,
    'stitch': `<svg viewBox="0 0 24 24"><path d="M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5c0-1.38-1.12-2.5-2.5-2.5S8 2.12 8 3.5V5H4c-1.1 0-2 .9-2 2v4h1.5c1.38 0 2.5 1.12 2.5 2.5S4.88 16 3.5 16H2v4c0 1.1.9 2 2 2h4v-1.5c0-1.38 1.12-2.5 2.5-2.5S13 19.12 13 20.5V22h4c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z"/></svg>`,
    '3d': `<svg viewBox="0 0 24 24"><path d="M12,2L3,7v10l9,5l9-5V7L12,2z M12,12l-7-3.9L12,4.2l7,3.9L12,12z M12,21l-7-3.9v-7l7,3.9V21z M19,17.1l-7,3.9v-7l7-3.9V17.1z"/></svg>`,
    'logs': `<svg viewBox="0 0 24 24"><path d="M19,3h-4.18C14.4,1.84,13.3,1,12,1S9.6,1.84,9.18,3H5C3.9,3,3,3.9,3,5v14c0,1.1,0.9,2,2,2h14c1.1,0,2-0.9,2-2V5 C21,3.9,20.1,3,19,3z M12,3c0.55,0,1,0.45,1,1s-0.45,1-1,1s-1-0.45-1-1S11.45,3,12,3z M7,7h10v2H7V7z M7,11h10v2H7V11z M7,15h10v2H7V15z"/></svg>`
};

function renderRail(category) {
    return CATEGORIES.map(([id, label]) => `
        <button type="button" class="settings-rail-button ${category === id ? 'is-active' : ''}" data-settings-action="category" data-category="${id}">
            <div class="settings-rail-button-head">
                <span class="settings-rail-icon">${SETTING_ICONS[id] || '&#8226;'}</span>
                <strong>${label}</strong>
            </div>
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
    if (type === 'color') {
        const displayValue = String(value || '#000000').toUpperCase();
        return `
            <label class="settings-field">
                <span>${escapeHtml(label)}</span>
                <input type="color" value="${escapeHtml(value)}" data-settings-path="${escapeHtml(path)}">
                <small>${escapeHtml(note || displayValue)}</small>
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

function renderPersonalizationPalette(themeKey, palette = {}) {
    const themeLabel = themeKey === 'dark' ? 'Dark' : 'Light';
    return `
        <section class="settings-card">
            <div class="settings-card-header">
                <div>
                    <div class="settings-eyebrow">${themeLabel} Palette</div>
                    <h3>${themeLabel} Theme Colors</h3>
                </div>
                <div class="settings-button-grid">
                    <button type="button" class="toolbar-button" data-settings-action="personalization-copy" data-settings-source="${themeKey}" data-settings-target="${themeKey === 'dark' ? 'light' : 'dark'}">Copy To ${themeKey === 'dark' ? 'Light' : 'Dark'}</button>
                    <button type="button" class="toolbar-button" data-settings-action="personalization-reset-palette" data-settings-palette="${themeKey}">Reset ${themeLabel}</button>
                </div>
            </div>
            <div class="settings-field-grid">
                ${PERSONALIZATION_FIELDS.map(([key, label]) => renderField({
                    type: 'color',
                    path: `personalization.${themeKey}.${key}`,
                    label,
                    value: palette[key]
                })).join('')}
            </div>
        </section>
    `;
}

function renderPersonalizationPreview(activeThemeLabel = 'Light') {
    return `
        <section class="settings-card">
            <div class="settings-card-header">
                <div>
                    <div class="settings-eyebrow">Live Preview</div>
                    <h3>Shared UI Sample</h3>
                </div>
            </div>
            <div class="settings-preview-shell">
                <div class="settings-preview-toolbar">
                    <span class="settings-preview-chip is-accent">${activeThemeLabel} Active</span>
                    <span class="settings-preview-chip">Raised Surface</span>
                    <span class="settings-preview-chip">Inset Field</span>
                </div>
                <div class="settings-preview-content">
                    <div class="settings-preview-copy">
                        <strong>Preview Panel</strong>
                        <span>This sample reflects the same shared shell styling used by the main site tabs.</span>
                    </div>
                    <div class="settings-preview-actions">
                        <button type="button" class="settings-preview-action is-primary">Primary Action</button>
                        <button type="button" class="settings-preview-action">Secondary</button>
                    </div>
                    <div class="settings-preview-field">
                        <span>Inset Field</span>
                        <div class="settings-preview-field-surface">Text, chips, fields, and buttons derive from these palette colors.</div>
                    </div>
                    <div class="settings-preview-statuses">
                        <span class="settings-preview-status is-success">Success</span>
                        <span class="settings-preview-status is-warning">Warning</span>
                        <span class="settings-preview-status is-danger">Danger</span>
                    </div>
                </div>
            </div>
        </section>
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
    if (category === 'personalization') {
        const personalization = settings?.personalization || {};
        const activeTheme = settings?.general?.theme === 'dark' ? 'dark' : 'light';
        const activeThemeLabel = activeTheme === 'dark' ? 'Dark' : 'Light';
        return `
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">Personalization</div><h3>Shared UI Palette</h3></div></div>
                <div class="settings-banner">These controls recolor the shared shell used by <strong>Editor</strong>, <strong>Composite</strong>, <strong>Library</strong>, <strong>Stitch</strong>, <strong>Settings</strong>, and <strong>Logs</strong>. The <strong>General &gt; Theme</strong> setting still chooses whether the light or dark palette is active right now. The 3D tab keeps its own separate black interface for now.</div>
                <div class="settings-field-grid">
                    ${renderField({ path: 'personalization.enabled', label: 'Use custom site colors', value: personalization.enabled, note: `${activeThemeLabel} is the currently active palette.` })}
                    <div class="settings-field">
                        <span>Current theme</span>
                        <strong class="settings-inline-value">${activeThemeLabel}</strong>
                        <small>Switch between Light and Dark in the General category. Both palettes are editable here.</small>
                    </div>
                    <div class="settings-field">
                        <span>Coverage</span>
                        <strong class="settings-inline-value">Shared UI</strong>
                        <small>Applies to the shared neumorphic site shell and its feedback colors. Functional overlays and the 3D tab keep their own specialized colors.</small>
                    </div>
                </div>
            </section>
            ${renderPersonalizationPreview(activeThemeLabel)}
            ${renderPersonalizationPalette('light', personalization.light || {})}
            ${renderPersonalizationPalette('dark', personalization.dark || {})}
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
    if (category === 'composite') {
        const preferences = settings?.composite?.preferences || {};
        const diagnostics = settings?.composite?.diagnostics || {};
        const workerReady = !!(diagnostics.workerAvailable && diagnostics.offscreenCanvas2d && diagnostics.createImageBitmap);
        const gpuSafeEdge = Math.max(0, Number(diagnostics.gpuSafeMaxEdge) || 0);
        const maxTextureSize = Math.max(0, Number(diagnostics.maxTextureSize) || 0);
        const maxViewportWidth = Math.max(0, Number(diagnostics.maxViewportWidth) || 0);
        const maxViewportHeight = Math.max(0, Number(diagnostics.maxViewportHeight) || 0);
        return `
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">Composite</div><h3>Viewport Preferences</h3></div></div>
                <div class="settings-banner">These preferences apply to the current Composite workspace and seed new Composite projects. Quick export actions still stay inside the Composite Export panel. Composite export is still CPU 2D canvas rendering in both paths. In <strong>Auto</strong>, smaller exports stay on the main thread while larger exports route into the background worker when OffscreenCanvas 2D plus image-bitmap support are available. Browser canvas maximum size is still environment-dependent.</div>
                <div class="settings-field-grid">
                    ${renderField({ path: 'composite.preferences.showChecker', label: 'Show checker background', value: preferences.showChecker })}
                    ${renderField({ path: 'composite.preferences.zoomLocked', label: 'Lock wheel zoom by default', value: preferences.zoomLocked })}
                    ${renderField({ type: 'select', path: 'composite.preferences.exportBackend', label: 'Export execution path', value: preferences.exportBackend, options: [['auto', 'Auto'], ['worker', 'Background Worker'], ['main-thread', 'Main Thread']], note: `Auto keeps small exports on the main thread and routes larger ones to the background worker at ${formatMegapixels(diagnostics.autoWorkerThresholdMegapixels || 0)} or ${formatInteger(diagnostics.autoWorkerThresholdEdge || 0)} px max-edge when worker rendering is ready.` })}
                </div>
            </section>
            <section class="settings-card">
                <div class="settings-card-header"><div><div class="settings-eyebrow">Composite Diagnostics</div><h3>Export Runtime Readiness</h3></div></div>
                <div class="settings-kpi-grid">
                    <div class="settings-kpi"><span>Worker Export</span><strong>${workerReady ? 'Ready' : 'Unavailable'}</strong></div>
                    <div class="settings-kpi"><span>WebGL</span><strong>${diagnostics.webglAvailable ? 'Ready' : 'Unavailable'}</strong></div>
                    <div class="settings-kpi"><span>WebGL 2</span><strong>${diagnostics.webgl2Available ? 'Ready' : 'Unavailable'}</strong></div>
                    <div class="settings-kpi"><span>GPU Safe Edge</span><strong>${gpuSafeEdge ? `${formatInteger(gpuSafeEdge)} px` : 'Unknown'}</strong></div>
                </div>
                <div class="settings-field-grid" style="margin-top:16px">
                    <div class="settings-field">
                        <span>Auto worker threshold</span>
                        <small>${formatMegapixels(diagnostics.autoWorkerThresholdMegapixels || 0)} or ${formatInteger(diagnostics.autoWorkerThresholdEdge || 0)} px max-edge.</small>
                    </div>
                    <div class="settings-field">
                        <span>Worker prerequisites</span>
                        <small>${diagnostics.workerAvailable ? 'Worker API ready' : 'Worker unavailable'}, ${diagnostics.offscreenCanvas2d ? 'OffscreenCanvas 2D ready' : 'OffscreenCanvas 2D unavailable'}, ${diagnostics.createImageBitmap ? 'createImageBitmap ready' : 'createImageBitmap unavailable'}.</small>
                    </div>
                    <div class="settings-field">
                        <span>GPU limits</span>
                        <small>Max texture ${maxTextureSize ? `${formatInteger(maxTextureSize)} px` : 'unknown'}; max viewport ${maxViewportWidth && maxViewportHeight ? `${formatInteger(maxViewportWidth)} x ${formatInteger(maxViewportHeight)} px` : 'unknown'}.</small>
                    </div>
                    <div class="settings-field">
                        <span>Current renderer split</span>
                        <small>Composite does not have a dedicated GPU/WebGL export renderer yet. These numbers are here to guide future GPU-safe planning, while current exports stay on CPU 2D canvas.</small>
                    </div>
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
            .settings-shell {
                height: 100%;
                min-height: 0;
                display: grid;
                grid-template-columns: minmax(248px, 280px) minmax(0, 1fr);
                gap: 16px;
                padding: 4px;
                background: transparent;
                color: var(--studio-neu-text);
                font-family: inherit;
            }
            .settings-rail,
            .settings-header,
            .settings-card,
            .settings-feedback {
                border: none;
                background: var(--studio-neu-surface);
                color: var(--studio-neu-text);
                box-shadow: var(--studio-neu-shadow-card);
            }
            .settings-rail,
            .settings-header,
            .settings-card {
                border-radius: 22px;
            }
            .settings-rail {
                padding: 24px 18px;
                z-index: 2;
                display: flex;
                flex-direction: column;
                gap: 14px;
                overflow-y: auto;
            }
            .settings-rail-list {
                display: flex;
                flex-direction: column;
                gap: 12px;
            }
            .settings-rail-button,
            .settings-shell .toolbar-button {
                border: none;
                border-radius: 999px;
                background: var(--studio-neu-button-fill);
                color: var(--studio-neu-text);
                box-shadow: var(--studio-neu-shadow-button);
                transition: transform 0.18s ease, box-shadow 0.18s ease, background 0.18s ease, color 0.18s ease, opacity 0.18s ease;
            }
            .settings-rail-button {
                display: flex;
                padding: 12px 14px;
                cursor: pointer;
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
                width: 30px;
                height: 30px;
                border-radius: 999px;
                background: transparent;
                color: var(--studio-neu-muted);
                box-shadow: none;
                transition: inherit;
                flex: 0 0 auto;
            }
            .settings-rail-icon svg {
                width: 14px;
                height: 14px;
                fill: currentColor;
            }
            .settings-rail-button strong {
                font-size: 13px;
                font-weight: 700;
                color: var(--studio-neu-text);
            }

            .settings-rail-button:hover:not(:disabled),
            .settings-shell .toolbar-button:hover:not(:disabled) {
                background: var(--studio-neu-button-fill-hover);
                box-shadow: var(--studio-neu-shadow-button-soft);
                transform: translateY(-1px);
            }
            .settings-rail-button.is-active,
            .settings-shell .toolbar-button:active:not(:disabled),
            .settings-shell .toolbar-button.is-active {
                background: var(--studio-neu-button-fill-active);
                box-shadow: var(--studio-neu-shadow-button-pressed);
                transform: translateY(0);
            }
            .settings-rail-button.is-active:hover:not(:disabled),
            .settings-shell .toolbar-button.is-active:hover:not(:disabled) {
                background: var(--studio-neu-button-fill-active);
                box-shadow: var(--studio-neu-shadow-button-pressed);
                transform: translateY(0);
            }
            .settings-rail-button.is-active strong,
            .settings-rail-button.is-active .settings-rail-icon {
                color: var(--studio-accent);
            }
            .settings-rail-button.is-active .settings-rail-icon {
                background: transparent;
                box-shadow: none;
            }
            .settings-content {
                display: grid;
                grid-template-rows: auto auto minmax(0, 1fr);
                min-height: 0;
                gap: 16px;
                padding: 4px 4px 4px 0;
            }
            .settings-header {
                padding: 18px 24px;
                display: flex;
                align-items: center;
                justify-content: flex-end;
                gap: 12px;
                min-height: 0;
            }
            .settings-actions {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
                justify-content: flex-end;
            }
            .settings-scroll {
                min-height: 0;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 16px;
                padding: 4px;
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
                padding: 24px;
            }
            .settings-card-header {
                margin-bottom: 18px;
                display: flex;
                justify-content: space-between;
                align-items: flex-start;
                gap: 12px;
            }
            .settings-eyebrow {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 0.12em;
                color: var(--studio-neu-muted);
                margin-bottom: 6px;
            }
            .settings-card h3 {
                margin: 0;
                font-size: 17px;
                font-weight: 700;
                color: var(--studio-neu-text);
            }
            .settings-field-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
                gap: 16px;
            }
            .settings-button-grid {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }
            .settings-field,
            .settings-banner,
            .settings-kpi {
                border: none;
                background: transparent;
                box-shadow: none;
                color: var(--studio-neu-text);
            }
            .settings-field {
                display: flex;
                flex-direction: column;
                gap: 10px;
                padding: 2px 2px 0;
                border-radius: 0;
            }
            .settings-field span {
                font-size: 13px;
                font-weight: 600;
                color: var(--studio-neu-text);
            }
            .settings-field small {
                font-size: 11px;
                color: var(--studio-neu-muted);
                line-height: 1.45;
            }
            .settings-field-toggle {
                flex-direction: row;
                align-items: center;
                justify-content: space-between;
                cursor: pointer;
            }
            .settings-field-toggle input[type="checkbox"] {
                appearance: none;
                width: 46px;
                height: 24px;
                border: none;
                border-radius: 999px;
                position: relative;
                cursor: pointer;
                transition: background 0.18s ease, box-shadow 0.18s ease;
                flex-shrink: 0;
                margin: 0;
                background: var(--studio-neu-surface);
                box-shadow: var(--studio-neu-shadow-inset-soft);
            }
            .settings-field-toggle input[type="checkbox"]::before {
                content: '';
                position: absolute;
                inset: 3px auto 3px 3px;
                width: 18px;
                border-radius: 999px;
                background: var(--studio-neu-button-fill);
                box-shadow: var(--studio-neu-shadow-button-soft);
                transition: transform 0.18s ease, background 0.18s ease, box-shadow 0.18s ease;
            }
            .settings-field-toggle input[type="checkbox"]:checked {
                background: var(--studio-neu-button-fill-active);
                box-shadow: var(--studio-neu-shadow-button-pressed);
            }
            .settings-field-toggle input[type="checkbox"]:checked::before {
                transform: translateX(22px);
                background: var(--studio-accent);
                box-shadow: none;
            }
            .settings-shell :where(.custom-select, .control-number) {
                border: none;
                border-radius: 14px;
                padding: 10px 14px;
                color: var(--studio-neu-text);
                font-weight: 600;
                font-size: 13px;
                outline: none;
                background: var(--studio-neu-surface);
                box-shadow: var(--studio-neu-shadow-inset-soft);
                transition: box-shadow 0.18s ease, background 0.18s ease;
            }
            .settings-shell :where(.custom-select, .control-number):focus {
                box-shadow: var(--studio-neu-shadow-inset-soft), inset 0 0 0 2px color-mix(in srgb, var(--studio-accent) 18%, transparent);
            }
            .settings-shell input[type="color"] {
                width: 100%;
                height: 44px;
                padding: 0;
                border: none;
                border-radius: 14px;
                background: var(--studio-neu-surface);
                box-shadow: var(--studio-neu-shadow-inset-soft);
                cursor: pointer;
            }
            .settings-shell input[type="color"]::-webkit-color-swatch-wrapper {
                padding: 6px;
            }
            .settings-shell input[type="color"]::-webkit-color-swatch {
                border: none;
                border-radius: 10px;
                box-shadow: var(--studio-neu-shadow-button-soft);
            }
            .settings-shell input[type="color"]::-moz-color-swatch {
                border: none;
                border-radius: 10px;
                box-shadow: var(--studio-neu-shadow-button-soft);
            }
            .settings-banner {
                margin-bottom: 18px;
                padding: 2px 2px 0;
                border-radius: 0;
                font-size: 12px;
                color: var(--studio-neu-muted);
                font-weight: 600;
                line-height: 1.55;
            }
            .settings-banner strong {
                color: var(--studio-neu-text);
            }
            .settings-kpi-grid {
                display: grid;
                grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                gap: 14px;
                margin-top: 18px;
            }
            .settings-kpi {
                padding: 12px 2px 0;
                border-radius: 0;
                text-align: center;
            }
            .settings-kpi span {
                display: block;
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                font-weight: 700;
                color: var(--studio-neu-muted);
                margin-bottom: 6px;
            }
            .settings-kpi strong {
                font-size: 20px;
                font-weight: 700;
                color: var(--studio-neu-text);
            }
            .settings-inline-value {
                font-size: 18px;
                line-height: 1.1;
                color: var(--studio-neu-text);
            }
            .settings-preview-shell {
                display: flex;
                flex-direction: column;
                gap: 14px;
                padding: 2px 2px 0;
                border-radius: 0;
                background: transparent;
                box-shadow: none;
            }
            .settings-preview-toolbar {
                border: none;
                border-radius: 0;
                background: transparent;
                box-shadow: none;
            }
            .settings-preview-toolbar {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                padding: 0;
            }
            .settings-preview-content {
                display: grid;
                gap: 14px;
            }
            .settings-preview-copy {
                display: flex;
                flex-direction: column;
                gap: 5px;
            }
            .settings-preview-copy strong {
                font-size: 15px;
                color: var(--studio-neu-text);
            }
            .settings-preview-copy span,
            .settings-preview-field span {
                font-size: 12px;
                color: var(--studio-neu-muted);
                line-height: 1.5;
            }
            .settings-preview-actions,
            .settings-preview-statuses {
                display: flex;
                flex-wrap: wrap;
                gap: 10px;
            }
            .settings-preview-action,
            .settings-preview-chip,
            .settings-preview-status {
                border: none;
                border-radius: 999px;
                background: var(--studio-neu-button-fill);
                color: var(--studio-neu-text);
                box-shadow: var(--studio-neu-shadow-button-soft);
                font-weight: 700;
            }
            .settings-preview-action {
                min-height: 34px;
                padding: 0 16px;
                font-size: 12px;
            }
            .settings-preview-action.is-primary,
            .settings-preview-chip.is-accent {
                color: var(--studio-accent);
            }
            .settings-preview-chip,
            .settings-preview-status {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                min-height: 24px;
                padding: 0 10px;
                font-size: 10px;
                letter-spacing: 0.04em;
                text-transform: uppercase;
            }
            .settings-preview-field {
                display: grid;
                gap: 8px;
            }
            .settings-preview-field-surface {
                border: none;
                border-radius: 18px;
                background: var(--studio-neu-surface);
                box-shadow: var(--studio-neu-shadow-inset-soft);
                padding: 12px 14px;
                font-size: 12px;
                font-weight: 600;
                color: var(--studio-neu-text);
                line-height: 1.45;
            }
            .settings-preview-status.is-success {
                color: var(--studio-success);
            }
            .settings-preview-status.is-warning {
                color: var(--studio-warning);
            }
            .settings-preview-status.is-danger {
                color: var(--studio-danger);
            }
            .settings-shell input[type="range"] {
                appearance: none;
                background: transparent;
                cursor: pointer;
                width: 100%;
                margin: 8px 0;
            }
            .settings-shell input[type="range"]::-webkit-slider-runnable-track {
                background: var(--studio-neu-surface);
                box-shadow: var(--studio-neu-shadow-inset-soft);
                height: 8px;
                border-radius: 999px;
            }
            .settings-shell input[type="range"]::-webkit-slider-thumb {
                appearance: none;
                width: 20px;
                height: 20px;
                border: none;
                background: var(--studio-neu-button-fill);
                border-radius: 50%;
                margin-top: -6px;
                box-shadow: var(--studio-neu-shadow-button-soft);
            }
            .settings-shell input[type="range"]::-moz-range-track {
                background: var(--studio-neu-surface);
                box-shadow: var(--studio-neu-shadow-inset-soft);
                height: 8px;
                border-radius: 999px;
            }
            .settings-shell input[type="range"]::-moz-range-thumb {
                width: 20px;
                height: 20px;
                border: none;
                background: var(--studio-neu-button-fill);
                border-radius: 50%;
                box-shadow: var(--studio-neu-shadow-button-soft);
            }
            .settings-feedback {
                display: flex;
                align-items: center;
                gap: 8px;
                overflow: hidden;
                opacity: 0;
                min-height: 0;
                max-height: 0;
                margin: 0 4px;
                padding: 0 18px;
                border-radius: 18px;
                font-size: 13px;
                font-weight: 600;
                transition: opacity 0.22s ease, max-height 0.22s ease, padding 0.22s ease, margin 0.22s ease;
            }
            .settings-feedback.is-visible {
                opacity: 1;
                max-height: 56px;
                min-height: 48px;
                padding: 12px 18px;
                margin: 0 4px;
            }
            .settings-feedback[data-tone="success"] { color: var(--studio-success); }
            .settings-feedback[data-tone="warning"] { color: var(--studio-warning); }
            .settings-feedback[data-tone="error"] { color: var(--studio-danger); }
            .settings-shell .toolbar-button {
                padding: 10px 16px;
                font-size: 12px;
                font-weight: 700;
                cursor: pointer;
            }
            .settings-shell .toolbar-button.is-danger {
                color: var(--studio-danger);
            }
            @media (max-width: 980px) {
                .settings-shell {
                    grid-template-columns: 1fr;
                }
                .settings-content {
                    padding: 0 4px 4px;
                }
                .settings-header {
                    flex-direction: column;
                    min-height: 0;
                }
            }
        </style>
        <div class="settings-shell">
            <aside class="settings-rail">
                <div class="settings-rail-list" data-settings-role="rail"></div>
            </aside>
            <section class="settings-content">
                <header class="settings-header">
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

        if (currentCategory && category !== currentCategory && !isAnimating) {
            isAnimating = true;
            refs.content.classList.add('is-switching');
            
            setTimeout(() => {
                currentCategory = category;
                refs.rail.innerHTML = renderRail(category);
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
            return;
        }
        if (action === 'personalization-reset-palette') {
            const updated = await actions.resetPersonalizationPalette?.(node.dataset.settingsPalette || '');
            if (updated) showFeedback(`${String(node.dataset.settingsPalette || '').trim().toLowerCase() === 'dark' ? 'Dark' : 'Light'} palette reset.`);
            return;
        }
        if (action === 'personalization-copy') {
            const source = node.dataset.settingsSource || '';
            const target = node.dataset.settingsTarget || '';
            const updated = await actions.copyPersonalizationPalette?.(source, target);
            if (updated) showFeedback(`Copied ${source} palette to ${target}.`);
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
