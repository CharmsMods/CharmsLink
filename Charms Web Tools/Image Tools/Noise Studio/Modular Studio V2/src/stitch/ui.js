import { getActivePlacements, getPlacementByInput, getSelectedStitchInput, normalizeStitchDocument } from './document.js';
import { STITCH_ANALYSIS_GROUPS, STITCH_SELECTION_ACTION_HELP, STITCH_SELECTION_FIELDS } from './meta.js';
import { createProgressOverlayController } from '../ui/progressOverlay.js';

const PANEL_TABS = [
    { id: 'inputs', label: 'Inputs', description: 'Load and manage source images.' },
    { id: 'analysis', label: 'Analysis', description: 'Run the matcher and tune settings.' },
    { id: 'selection', label: 'Selection', description: 'Adjust the selected image.' },
    { id: 'candidates', label: 'Results', description: 'Choose candidates and export.' }
];

const OPEN_ANALYSIS_GROUPS = new Set(['detection', 'warp']);

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatNumber(value, digits = 2) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '0';
    const formatted = numeric.toFixed(digits).replace(/\.?0+$/, '');
    return formatted === '-' || formatted === '-0' ? '0' : formatted;
}

function formatPercent(value) {
    return `${Math.round((Number(value) || 0) * 100)}%`;
}

function formatDimensions(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!w || !h) return 'Unknown';
    return `${w.toLocaleString()} x ${h.toLocaleString()}`;
}

function formatModelType(value) {
    const label = String(value || 'rigid')
        .replace(/[-_]/g, ' ')
        .replace(/\b\w/g, (match) => match.toUpperCase());
    return label === 'Rigid' ? 'Rigid' : label;
}

function tooltipMarkup(id, help) {
    return `
        <span class="stitch-tooltip-wrap" data-stitch-tooltip-wrap="${id}">
            <button type="button" class="stitch-help-button" data-stitch-tooltip-button="${id}" aria-label="Open help" aria-expanded="false">?</button>
            <div class="stitch-tooltip-popover" data-stitch-tooltip="${id}" role="tooltip">${escapeHtml(help)}</div>
        </span>
    `;
}

function renderSettingField(document, field, runtimeDiagnostics = {}) {
    const value = document.settings?.[field.key];
    const isRunning = document.analysis?.status === 'running';
    const supportedDetectors = Array.isArray(runtimeDiagnostics?.supportedDetectors)
        ? runtimeDiagnostics.supportedDetectors
        : [];
    const disableSift = field.key === 'featureDetector' && !supportedDetectors.includes('sift');
    const disabled = isRunning || (field.key === 'analysisMaxDimension' && document.settings.useFullResolutionAnalysis);
    const labelRow = `
        <span class="stitch-setting-label">
            <span>${escapeHtml(field.label)}</span>
            ${tooltipMarkup(`setting:${field.key}`, field.help)}
        </span>
    `;

    if (field.type === 'select') {
        return `
            <label class="stitch-setting">
                ${labelRow}
                <select data-stitch-setting="${field.key}" ${isRunning ? 'disabled' : ''}>
                    ${field.options.map((option) => {
                        const optionDisabled = option.value === 'sift' && disableSift;
                        return `<option value="${option.value}" ${String(value) === option.value ? 'selected' : ''} ${optionDisabled ? 'disabled' : ''}>${escapeHtml(option.label)}</option>`;
                    }).join('')}
                </select>
            </label>
        `;
    }

    if (field.type === 'checkbox') {
        return `
            <label class="stitch-setting-checkbox">
                <input type="checkbox" data-stitch-setting="${field.key}" ${value ? 'checked' : ''} ${isRunning ? 'disabled' : ''}>
                <div class="stitch-setting-checkbox-content">
                    <span class="stitch-setting-label stitch-setting-label-checkbox">
                        <strong>${escapeHtml(field.label)}</strong>
                        ${tooltipMarkup(`setting:${field.key}`, field.help)}
                    </span>
                </div>
            </label>
        `;
    }

    return `
        <label class="stitch-setting">
            ${labelRow}
            <input type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${value}" data-stitch-setting="${field.key}" ${disabled ? 'disabled' : ''}>
        </label>
    `;
}

function getPanelLabel(tabId) {
    return PANEL_TABS.find((entry) => entry.id === tabId)?.label || tabId;
}

function buildMetricChip(label, value, muted = true) {
    return `<span class="stitch-overlay-chip ${muted ? 'is-muted' : ''}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(value)}</span></span>`;
}

function getStageStatus(document) {
    const analysis = document.analysis || {};
    const activeCandidate = document.candidates.find((candidate) => candidate.id === document.activeCandidateId) || null;
    const selected = getSelectedStitchInput(document);

    if (analysis.status === 'running') return { text: analysis.progressMessage || 'Running stitch analysis and scoring ranked candidates.', tone: 'info' };
    if (analysis.error) return { text: analysis.error, tone: 'error' };
    if (analysis.warning) return { text: analysis.warning, tone: 'warning' };
    if (!document.inputs.length) return { text: 'Load images into Stitch to start building a composite.', tone: 'info' };
    if (document.inputs.length < 2) return { text: 'Add at least one more image before running stitch analysis.', tone: 'info' };
    if (selected) return { text: `Editing ${selected.name}. Drag directly in the viewport to nudge it into place.`, tone: 'info' };
    if (activeCandidate) return { text: `${activeCandidate.name} is active. Refine it manually or switch to a different ranked result.`, tone: 'info' };
    return { text: 'Run the analysis to generate ranked stitch candidates.', tone: 'info' };
}

export function createStitchWorkspace(root, { actions, stitchEngine, logger = null }) {
    root.innerHTML = `
        <style data-stitch-compact-style>
            .stitch-shell{--stitch-border:#b8b2a3;--stitch-border-soft:rgba(184,178,163,.28);--stitch-accent:rgba(184,178,163,.14);--stitch-muted:#b8b2a3;position:relative;width:100%;height:100%;min-width:0;min-height:0;display:grid;grid-template-columns:minmax(232px,292px) minmax(0,1fr);gap:8px;padding:8px;background:#000;color:#fff;font-size:11px;line-height:1.24;overflow:hidden}
            .stitch-shell button,.stitch-shell input,.stitch-shell select,.stitch-gallery-overlay button{font-size:11px!important}
            .stitch-shell .mini-button,.stitch-shell .toolbar-button,.stitch-shell input[type="number"],.stitch-shell select,.stitch-gallery-overlay .toolbar-button{min-height:22px;padding:2px 7px!important;border-radius:4px;border:1px solid var(--stitch-border);background:#000;color:#fff;box-shadow:none}
            .stitch-shell .mini-button.is-danger{border-color:rgba(184,178,163,.72)}
            .stitch-dock,.stitch-stage-card,.stitch-gallery-panel{min-width:0;min-height:0;border:1px solid var(--stitch-border);background:#000;overflow:hidden}
            .stitch-dock{display:flex;flex-direction:column}
            .stitch-dock-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:6px;border-bottom:1px solid var(--stitch-border);background:#050505}
            .stitch-dock-tab{min-height:20px;padding:0 7px;border:1px solid transparent;border-radius:4px;background:transparent;color:var(--stitch-muted);cursor:pointer}
            .stitch-dock-tab.is-active,.stitch-dock-tab:hover{background:var(--stitch-accent);border-color:var(--stitch-border);color:#fff}
            .stitch-dock-panels{flex:1;min-height:0}.stitch-dock-panel{display:none;height:100%;min-height:0;flex-direction:column}.stitch-dock-panel.is-active{display:flex}
            .stitch-dock-panel-head{padding:8px 9px 7px;border-bottom:1px solid var(--stitch-border);background:#050505}.stitch-dock-panel-head span{display:block;margin-top:2px;color:var(--stitch-muted);font-size:10px}
            .stitch-dock-panel-body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding:8px;display:flex;flex-direction:column;gap:8px}
            .stitch-stage-card{display:flex;flex-direction:column}
            .stitch-stage-topbar{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;border-bottom:1px solid var(--stitch-border);background:#050505}
            .stitch-stage-title{min-width:0}.stitch-stage-title .eyebrow{margin:0 0 2px;color:var(--stitch-muted);font-size:10px;letter-spacing:.04em;text-transform:uppercase}.stitch-stage-title h2{margin:0;font-size:12px;line-height:1.2;overflow-wrap:anywhere}
            .stitch-mini-bar{display:inline-flex;align-items:center;gap:3px;padding:3px;border:1px solid var(--stitch-border-soft);background:rgba(0,0,0,.92)}.stitch-mini-bar .mini-button{min-height:20px;padding:0 6px!important;border-radius:3px}
            .stitch-stage-wrap{position:relative;flex:1;min-width:0;min-height:0;overflow:hidden;background:#000}.stitch-canvas{display:block;width:100%;height:100%;background:#000}
            .stitch-stage-overlay{position:absolute;display:flex;gap:4px;z-index:3;pointer-events:none;max-width:min(64%,calc(100% - 12px))}.stitch-overlay-top-right{top:6px;right:6px;flex-wrap:wrap;justify-content:flex-end}.stitch-overlay-bottom-left{left:6px;bottom:6px}
            .stitch-overlay-chip,.stitch-status-chip{display:inline-flex;align-items:center;gap:4px;min-height:20px;padding:0 6px;border:1px solid var(--stitch-border-soft);background:rgba(0,0,0,.92);color:#fff;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.stitch-overlay-chip.is-muted{color:var(--stitch-muted)}.stitch-status-chip[data-tone="warning"],.stitch-status-chip[data-tone="error"]{border-color:rgba(184,178,163,.72)}
            .stitch-empty-state{position:absolute;inset:12px;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px;text-align:center;pointer-events:none;color:var(--stitch-muted);border:1px dashed var(--stitch-border-soft);background:rgba(0,0,0,.74)}.stitch-empty-state.is-visible{display:flex}
            .stitch-stack,.stitch-input-list,.stitch-candidate-list,.stitch-settings-stack{display:flex;flex-direction:column;gap:8px;min-width:0}.stitch-button-row{display:grid;gap:6px}.stitch-button-row-2{grid-template-columns:repeat(2,minmax(0,1fr))}.stitch-button-row-3{grid-template-columns:repeat(3,minmax(0,1fr))}
            .stitch-info-banner,.stitch-analysis-note{padding:7px 8px;border:1px solid var(--stitch-border-soft);background:rgba(184,178,163,.08);color:#fff;font-size:10px;line-height:1.4}.stitch-analysis-note.is-warning,.stitch-analysis-note.is-error{border-color:rgba(184,178,163,.72)}.stitch-mini-empty{padding:4px 0;color:var(--stitch-muted);font-size:10px;line-height:1.4}
            .stitch-summary-card,.stitch-input-item,.stitch-candidate-card,.stitch-foldout,.stitch-gallery-card{border:1px solid var(--stitch-border);background:#050505;min-width:0}.stitch-summary-card{padding:8px;display:flex;flex-direction:column;gap:6px}
            .stitch-summary-row,.stitch-analysis-line{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:10px;color:var(--stitch-muted)}.stitch-summary-row strong,.stitch-analysis-line strong{color:#fff}
            .stitch-input-item.is-selected,.stitch-candidate-card.is-active,.stitch-gallery-card.is-active{background:var(--stitch-accent);border-color:var(--stitch-border)}
            .stitch-input-main,.stitch-candidate-main{width:100%;border:none;background:none;color:inherit;text-align:left;padding:7px;display:flex;flex-direction:column;gap:4px;cursor:pointer}
            .stitch-input-copy,.stitch-candidate-copy,.stitch-gallery-meta{display:flex;flex-direction:column;gap:2px;min-width:0}.stitch-input-copy strong,.stitch-candidate-copy strong,.stitch-gallery-meta strong{font-size:11px;overflow-wrap:anywhere}
            .stitch-input-copy span,.stitch-candidate-copy span,.stitch-gallery-meta span{color:var(--stitch-muted);font-size:10px}
            .stitch-item-badges{display:flex;flex-wrap:wrap;gap:4px}.stitch-kind-badge{display:inline-flex;align-items:center;justify-content:center;min-height:18px;padding:0 5px;border:1px solid var(--stitch-border-soft);background:rgba(184,178,163,.08);color:var(--stitch-muted);font-size:9px;letter-spacing:.04em;text-transform:uppercase}
            .stitch-input-actions,.stitch-candidate-actions,.stitch-gallery-actions{display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:6px;padding:0 7px 7px}
            .stitch-foldout summary{list-style:none;cursor:pointer;user-select:none;padding:7px 8px;color:#fff;font-weight:600}.stitch-foldout summary::-webkit-details-marker{display:none}.stitch-foldout-body{padding:0 8px 8px;display:flex;flex-direction:column;gap:8px}
            .stitch-setting-grid{display:grid;grid-template-columns:1fr;gap:8px}.stitch-setting{display:flex;flex-direction:column;gap:6px;font-size:10px;color:var(--stitch-muted);min-width:0}
            .stitch-setting-label{display:flex;align-items:flex-start;justify-content:space-between;gap:6px;min-width:0;color:inherit}.stitch-setting-label>span:first-child{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}.stitch-setting-label-checkbox{margin-bottom:3px}
            .stitch-setting input,.stitch-setting select{width:100%}.stitch-setting-checkbox{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;padding:7px 8px;border:1px solid var(--stitch-border);background:#000}.stitch-setting-checkbox strong{display:block;font-size:10px;color:#fff}
            .stitch-help-button{width:16px;height:16px;border-radius:999px;border:1px solid var(--stitch-border-soft);background:#000;color:var(--stitch-muted);font:700 10px/1 monospace;display:inline-flex;align-items:center;justify-content:center;padding:0;cursor:pointer}.stitch-tooltip-wrap{position:relative;display:inline-flex;align-items:center}
            .stitch-tooltip-wrap.is-open .stitch-help-button,.stitch-help-button:hover{color:#fff;border-color:var(--stitch-border)}
            .stitch-tooltip-popover{position:fixed;top:0;left:0;width:min(260px,60vw);padding:9px 10px;border:1px solid var(--stitch-border);background:#000;color:#fff;font-size:10px;line-height:1.45;z-index:40;display:none;white-space:normal}.stitch-tooltip-wrap.is-open .stitch-tooltip-popover{display:block}
            .stitch-selection-help-row{display:flex;flex-direction:column;gap:6px}.stitch-selection-help-chip{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--stitch-muted);font-size:10px}
            .stitch-gallery-overlay{position:absolute;inset:0;display:none;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.78);z-index:30}.stitch-gallery-overlay.is-open{display:flex}
            .stitch-gallery-panel{width:min(1060px,100%);height:min(86vh,760px);display:flex;flex-direction:column;gap:8px;padding:10px}.stitch-gallery-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.stitch-gallery-header .eyebrow{margin:0 0 2px;color:var(--stitch-muted);font-size:10px;text-transform:uppercase;letter-spacing:.04em}.stitch-gallery-header h3{margin:0;font-size:12px}
            .stitch-gallery-grid{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}.stitch-gallery-preview{aspect-ratio:4/3;background:#000;border-bottom:1px solid var(--stitch-border);display:flex;align-items:center;justify-content:center}.stitch-gallery-preview img{display:block;width:100%;height:100%;object-fit:contain}.stitch-gallery-placeholder{color:var(--stitch-muted);font-size:10px}
            @media (max-width:980px){.stitch-shell{grid-template-columns:1fr;grid-template-rows:minmax(240px,42vh) minmax(0,1fr)}.stitch-gallery-overlay{padding:8px}.stitch-gallery-panel{width:100%;height:100%}}
        </style>
        <div class="stitch-shell">
            <aside class="stitch-dock">
                <div class="stitch-dock-tabs">${PANEL_TABS.map((tab) => `<button type="button" class="stitch-dock-tab" data-stitch-action="workspace-tab" data-sidebar-view="${tab.id}">${tab.label}</button>`).join('')}</div>
                <div class="stitch-dock-panels">
                    ${PANEL_TABS.map((tab) => `
                        <section class="stitch-dock-panel" data-stitch-panel="${tab.id}">
                            <div class="stitch-dock-panel-head"><strong>${tab.label}</strong><span>${tab.description}</span></div>
                            <div class="stitch-dock-panel-body" data-stitch-role="${tab.id}-panel"></div>
                        </section>
                    `).join('')}
                </div>
            </aside>
            <section class="stitch-stage-card">
                <div class="stitch-stage-topbar">
                    <div class="stitch-stage-title">
                        <div class="eyebrow">Stitch Preview</div>
                        <h2 data-stitch-role="title">Stitch Workspace</h2>
                    </div>
                    <div class="stitch-mini-bar">
                        <button type="button" class="mini-button" data-stitch-action="fit-view">Frame</button>
                        <button type="button" class="mini-button" data-stitch-action="open-gallery">Gallery</button>
                        <button type="button" class="mini-button" data-stitch-action="export-project">Export</button>
                    </div>
                </div>
                <div class="stitch-stage-wrap">
                    <canvas class="stitch-canvas" data-stitch-role="canvas"></canvas>
                    <div class="stitch-stage-overlay stitch-overlay-top-right" data-stitch-role="metrics"></div>
                    <div class="stitch-stage-overlay stitch-overlay-bottom-left"><div class="stitch-status-chip" data-stitch-role="status" data-tone="info">Stitch workspace ready.</div></div>
                    <div class="stitch-empty-state" data-stitch-role="empty-state"><strong>Add two or more images</strong><span>Run analysis to generate candidate layouts, then refine the result directly in the viewport.</span></div>
                </div>
            </section>
            <div class="stitch-gallery-overlay" data-stitch-role="gallery-overlay">
                <div class="stitch-gallery-panel">
                    <div class="stitch-gallery-header">
                        <div><div class="eyebrow">Candidate Gallery</div><h3>Possible Stitch Layouts</h3></div>
                        <button type="button" class="toolbar-button" data-stitch-action="close-gallery">Close</button>
                    </div>
                    <div class="stitch-gallery-grid" data-stitch-role="gallery-grid"></div>
                </div>
            </div>
            <input type="file" accept="image/*" multiple hidden data-stitch-role="file-input">
        </div>
    `;

    const refs = {
        canvas: root.querySelector('[data-stitch-role="canvas"]'),
        title: root.querySelector('[data-stitch-role="title"]'),
        metrics: root.querySelector('[data-stitch-role="metrics"]'),
        status: root.querySelector('[data-stitch-role="status"]'),
        empty: root.querySelector('[data-stitch-role="empty-state"]'),
        inputsPanel: root.querySelector('[data-stitch-role="inputs-panel"]'),
        analysisPanel: root.querySelector('[data-stitch-role="analysis-panel"]'),
        selectionPanel: root.querySelector('[data-stitch-role="selection-panel"]'),
        candidatesPanel: root.querySelector('[data-stitch-role="candidates-panel"]'),
        galleryOverlay: root.querySelector('[data-stitch-role="gallery-overlay"]'),
        galleryGrid: root.querySelector('[data-stitch-role="gallery-grid"]'),
        fileInput: root.querySelector('[data-stitch-role="file-input"]')
    };
    const progressOverlay = createProgressOverlayController(root.querySelector('.stitch-stage-wrap'), {
        zIndex: 12,
        defaultTitle: 'Working',
        defaultMessage: 'Preparing the Stitch workspace...',
        backdrop: 'rgba(0, 0, 0, 0.52)',
        panelBackground: 'rgba(0, 0, 0, 0.94)',
        borderColor: 'rgba(184,178,163,0.5)',
        borderSoftColor: 'rgba(184,178,163,0.28)',
        textColor: '#ffffff',
        mutedColor: 'rgba(184,178,163,0.88)',
        accentColor: 'rgba(184,178,163,0.96)',
        progressFill: 'linear-gradient(90deg, rgba(184,178,163,0.2), rgba(184,178,163,0.92))'
    });

    let currentDocument = normalizeStitchDocument();
    let dragState = null;
    let openTooltipId = null;
    let lastStatusLogSignature = '';
    const canUseHoverTooltips = typeof window.matchMedia === 'function'
        ? window.matchMedia('(hover: hover)').matches
        : false;

    function logStitch(level, message, options = {}) {
        if (!logger || !message) return;
        const method = typeof logger[level] === 'function'
            ? logger[level].bind(logger)
            : logger.info.bind(logger);
        method('stitch.workspace', 'Stitch Workspace', message, options);
    }

    stitchEngine.attachCanvas(refs.canvas);

    function applyTooltipState() {
        const tooltips = root.querySelectorAll('[data-stitch-tooltip-wrap]');
        tooltips.forEach((node) => {
            const id = node.dataset.stitchTooltipWrap;
            const isOpen = id === openTooltipId;
            node.classList.toggle('is-open', isOpen);

            const button = node.querySelector('[data-stitch-tooltip-button]');
            const popover = node.querySelector('[data-stitch-tooltip]');
            if (button) button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

            if (isOpen && button && popover) {
                popover.style.display = 'block';
                popover.style.visibility = 'hidden';
                popover.style.pointerEvents = 'none';
                const triggerRect = button.getBoundingClientRect();
                const popoverRect = popover.getBoundingClientRect();
                let top = triggerRect.bottom + 8;
                let left = triggerRect.right - popoverRect.width;
                if (left < 10) left = triggerRect.left;
                if (left + popoverRect.width > window.innerWidth - 10) left = window.innerWidth - popoverRect.width - 10;
                if (top + popoverRect.height > window.innerHeight - 10) top = triggerRect.top - popoverRect.height - 8;
                if (left < 10) left = 10;
                if (top < 10) top = 10;
                popover.style.top = `${top}px`;
                popover.style.left = `${left}px`;
                popover.style.visibility = 'visible';
                popover.style.pointerEvents = 'auto';
            } else if (popover) {
                popover.style.top = '';
                popover.style.left = '';
                popover.style.display = '';
                popover.style.visibility = '';
                popover.style.pointerEvents = '';
            }
        });
    }

    function setOpenTooltip(id) {
        openTooltipId = id || null;
        applyTooltipState();
    }

    function renderDockState(document) {
        const activeTab = document.workspace?.sidebarView || 'inputs';
        root.querySelectorAll('[data-sidebar-view]').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.sidebarView === activeTab);
        });
        root.querySelectorAll('[data-stitch-panel]').forEach((panel) => {
            panel.classList.toggle('is-active', panel.dataset.stitchPanel === activeTab);
        });
    }

    function renderInputs(document) {
        const isRunning = document.analysis?.status === 'running';
        const orderedInputs = [...document.inputs].sort((a, b) => {
            const placementA = getPlacementByInput(document, a.id);
            const placementB = getPlacementByInput(document, b.id);
            return (placementA?.z || 0) - (placementB?.z || 0);
        });

        refs.inputsPanel.innerHTML = `
            <div class="stitch-stack">
                <div class="stitch-button-row stitch-button-row-2">
                    <button type="button" class="mini-button" data-stitch-action="add-images">Add Images</button>
                    <button type="button" class="mini-button" data-stitch-action="new-project">New Stitch</button>
                </div>
                <div class="stitch-info-banner">${isRunning ? 'Input changes are temporarily locked while Stitch analysis is running.' : 'Use this panel to load, reorder, hide, and lock the image stack while the viewport stays focused on the composite.'}</div>
                ${orderedInputs.length ? `
                    <div class="stitch-input-list">
                        ${orderedInputs.map((input, index) => {
                            const placement = getPlacementByInput(document, input.id);
                            const selected = document.selection.inputId === input.id;
                            const badges = [
                                placement?.visible === false ? 'Hidden' : 'Visible',
                                placement?.locked ? 'Locked' : 'Free'
                            ];
                            return `
                                <article class="stitch-input-item ${selected ? 'is-selected' : ''}">
                                    <button type="button" class="stitch-input-main" data-stitch-action="select-input" data-input-id="${input.id}">
                                        <span class="stitch-input-copy">
                                            <strong>${escapeHtml(input.name)}</strong>
                                            <span>${escapeHtml(formatDimensions(input.width, input.height))}</span>
                                        </span>
                                        <span class="stitch-item-badges">
                                            ${badges.map((badge) => `<span class="stitch-kind-badge">${escapeHtml(badge)}</span>`).join('')}
                                        </span>
                                    </button>
                                    <div class="stitch-input-actions">
                                        <button type="button" class="mini-button" data-stitch-action="toggle-visibility" data-input-id="${input.id}" ${isRunning ? 'disabled' : ''}>${placement?.visible === false ? 'Show' : 'Hide'}</button>
                                        <button type="button" class="mini-button" data-stitch-action="toggle-lock" data-input-id="${input.id}" ${isRunning ? 'disabled' : ''}>${placement?.locked ? 'Unlock' : 'Lock'}</button>
                                        <button type="button" class="mini-button" data-stitch-action="move-up" data-input-id="${input.id}" ${(isRunning || index === 0) ? 'disabled' : ''}>Up</button>
                                        <button type="button" class="mini-button" data-stitch-action="move-down" data-input-id="${input.id}" ${(isRunning || index === orderedInputs.length - 1) ? 'disabled' : ''}>Down</button>
                                        <button type="button" class="mini-button is-danger" data-stitch-action="remove-input" data-input-id="${input.id}" ${isRunning ? 'disabled' : ''}>Remove</button>
                                    </div>
                                </article>
                            `;
                        }).join('')}
                    </div>
                ` : '<div class="stitch-mini-empty">No images loaded yet. Start by adding a set of overlapping images.</div>'}
            </div>
        `;
    }

    function renderAnalysis(document) {
        const analysis = document.analysis || {};
        const topCandidate = (document.candidates || [])[0] || null;
        const runtimeDiagnostics = actions.getState?.()?.settings?.stitch?.diagnostics || {};
        const isRunning = analysis.status === 'running';

        refs.analysisPanel.innerHTML = `
            <div class="stitch-stack">
                <div class="stitch-button-row stitch-button-row-2">
                    <button type="button" class="toolbar-button" data-stitch-action="run-analysis" ${document.inputs.length < 2 || isRunning ? 'disabled' : ''}>${analysis.status === 'running' ? 'Analyzing...' : 'Run Analysis'}</button>
                    <button type="button" class="mini-button" data-stitch-action="reset-candidate" ${document.activeCandidateId && !isRunning ? '' : 'disabled'}>Reset Candidate</button>
                </div>
                <div class="stitch-summary-card">
                    <div class="stitch-summary-row"><strong>Status</strong><span>${escapeHtml(analysis.status || 'idle')}</span></div>
                    <div class="stitch-summary-row"><strong>Inputs</strong><span>${document.inputs.length}</span></div>
                    <div class="stitch-summary-row"><strong>Candidates</strong><span>${document.candidates.length}</span></div>
                    ${topCandidate ? `<div class="stitch-summary-row"><strong>Top Result</strong><span>${escapeHtml(formatModelType(topCandidate.modelType))} | ${formatPercent(topCandidate.confidence || 0)}</span></div>` : ''}
                </div>
                ${analysis.progressMessage ? `<div class="stitch-analysis-note">${escapeHtml(analysis.progressMessage)}</div>` : ''}
                ${analysis.warning ? `<div class="stitch-analysis-note is-warning">${escapeHtml(analysis.warning)}</div>` : ''}
                ${analysis.error ? `<div class="stitch-analysis-note is-error">${escapeHtml(analysis.error)}</div>` : ''}
                <div class="stitch-settings-stack">
                    ${STITCH_ANALYSIS_GROUPS.map((group) => `
                        <details class="stitch-foldout" ${OPEN_ANALYSIS_GROUPS.has(group.id) ? 'open' : ''}>
                            <summary>${escapeHtml(group.title)}</summary>
                            <div class="stitch-foldout-body">
                                <div class="stitch-setting-grid">
                                    ${group.fields.map((field) => renderSettingField(document, field, runtimeDiagnostics)).join('')}
                                </div>
                            </div>
                        </details>
                    `).join('')}
                </div>
            </div>
        `;
    }

    function renderSelection(document) {
        const input = getSelectedStitchInput(document);
        const placement = input ? getPlacementByInput(document, input.id) : null;
        const isRunning = document.analysis?.status === 'running';

        if (!input || !placement) {
            refs.selectionPanel.innerHTML = '<div class="stitch-mini-empty">Select an image to move, rotate, scale, hide, or lock it.</div>';
            return;
        }

        refs.selectionPanel.innerHTML = `
            <div class="stitch-stack">
                <div class="stitch-summary-card">
                    <div class="stitch-summary-row"><strong>Image</strong><span>${escapeHtml(input.name)}</span></div>
                    <div class="stitch-summary-row"><strong>Size</strong><span>${escapeHtml(formatDimensions(input.width, input.height))}</span></div>
                    <div class="stitch-summary-row"><strong>Visible</strong><span>${placement.visible === false ? 'No' : 'Yes'}</span></div>
                    <div class="stitch-summary-row"><strong>Locked</strong><span>${placement.locked ? 'Yes' : 'No'}</span></div>
                </div>
                <div class="stitch-setting-grid">
                    ${STITCH_SELECTION_FIELDS.map((field) => `
                        <label class="stitch-setting">
                            <span class="stitch-setting-label">
                                <span>${escapeHtml(field.label)}</span>
                                ${tooltipMarkup(`placement:${field.key}`, field.help)}
                            </span>
                            <input
                                type="number"
                                ${field.key === 'scale' ? 'min="0.05" max="8" step="0.01"' : ''}
                                ${field.key === 'rotation' ? 'min="-180" max="180" step="0.5"' : ''}
                                ${field.key === 'x' || field.key === 'y' ? 'step="1"' : ''}
                                value="${field.key === 'rotation' ? formatNumber((placement.rotation || 0) * (180 / Math.PI), 1) : formatNumber(placement[field.key], field.key === 'scale' ? 2 : 0)}"
                                data-stitch-placement="${field.key}"
                                data-input-id="${input.id}"
                                ${isRunning ? 'disabled' : ''}
                            >
                        </label>
                    `).join('')}
                </div>
                ${placement.warp ? `<div class="stitch-analysis-note">Auto warp: ${escapeHtml(formatModelType(placement.warp.type))} grid ${escapeHtml(String(placement.warp.cols))} x ${escapeHtml(String(placement.warp.rows))}</div>` : ''}
                <div class="stitch-button-row stitch-button-row-3">
                    <button type="button" class="mini-button" data-stitch-action="toggle-visibility" data-input-id="${input.id}" ${isRunning ? 'disabled' : ''}>${placement.visible === false ? 'Show' : 'Hide'}</button>
                    <button type="button" class="mini-button" data-stitch-action="toggle-lock" data-input-id="${input.id}" ${isRunning ? 'disabled' : ''}>${placement.locked ? 'Unlock' : 'Lock'}</button>
                    <button type="button" class="mini-button" data-stitch-action="reset-selected" ${isRunning ? 'disabled' : ''}>Reset</button>
                </div>
                <details class="stitch-foldout">
                    <summary>Help</summary>
                    <div class="stitch-foldout-body">
                        <div class="stitch-selection-help-row">
                            <span class="stitch-selection-help-chip"><strong>Reset Image</strong>${tooltipMarkup('action:reset', STITCH_SELECTION_ACTION_HELP.reset)}</span>
                            <span class="stitch-selection-help-chip"><strong>Hide / Show</strong>${tooltipMarkup('action:visibility', STITCH_SELECTION_ACTION_HELP.visibility)}</span>
                            <span class="stitch-selection-help-chip"><strong>Lock</strong>${tooltipMarkup('action:lock', STITCH_SELECTION_ACTION_HELP.lock)}</span>
                        </div>
                    </div>
                </details>
            </div>
        `;
    }

    function renderCandidates(document) {
        const candidates = document.candidates || [];
        const activeCandidate = candidates.find((candidate) => candidate.id === document.activeCandidateId) || null;
        const isRunning = document.analysis?.status === 'running';

        refs.candidatesPanel.innerHTML = `
            <div class="stitch-stack">
                <div class="stitch-button-row stitch-button-row-2">
                    <button type="button" class="mini-button" data-stitch-action="open-gallery" ${candidates.length && !isRunning ? '' : 'disabled'}>Open Gallery</button>
                    <button type="button" class="mini-button" data-stitch-action="toggle-alternatives" ${candidates.length && !isRunning ? '' : 'disabled'}>${document.workspace.alternativesOpen === false ? 'Show List' : 'Hide List'}</button>
                </div>
                <div class="stitch-button-row stitch-button-row-2">
                    <button type="button" class="mini-button" data-stitch-action="export-project" ${document.inputs.length && !isRunning ? '' : 'disabled'}>Export PNG</button>
        <button type="button" class="mini-button" data-stitch-action="save-library" ${document.inputs.length && !isRunning ? '' : 'disabled'}>Save to Library</button>
                </div>
                ${activeCandidate ? `
                    <div class="stitch-summary-card">
                        <div class="stitch-summary-row"><strong>Active</strong><span>${escapeHtml(activeCandidate.name)}</span></div>
                        <div class="stitch-summary-row"><strong>Rank</strong><span>#${activeCandidate.rank || 0}</span></div>
                        <div class="stitch-summary-row"><strong>Model</strong><span>${escapeHtml(formatModelType(activeCandidate.modelType))}</span></div>
                        <div class="stitch-summary-row"><strong>Confidence</strong><span>${formatPercent(activeCandidate.confidence || 0)}</span></div>
                        <div class="stitch-summary-row"><strong>Coverage</strong><span>${formatPercent(activeCandidate.coverage || 0)}</span></div>
                    </div>
                ` : '<div class="stitch-mini-empty">Run analysis to generate candidate layouts.</div>'}
                ${document.workspace.alternativesOpen === false || !candidates.length ? '' : `
                    <div class="stitch-candidate-list">
                        ${candidates.map((candidate) => `
                            <article class="stitch-candidate-card ${document.activeCandidateId === candidate.id ? 'is-active' : ''}">
                                <button type="button" class="stitch-candidate-main" data-stitch-action="use-candidate" data-candidate-id="${candidate.id}">
                                    <span class="stitch-candidate-copy">
                                        <strong>${escapeHtml(candidate.name)}</strong>
                                        <span>#${candidate.rank || 0} | ${escapeHtml(formatModelType(candidate.modelType))}</span>
                                        <span>${formatPercent(candidate.coverage)} coverage | ${formatPercent(candidate.confidence || 0)} confidence</span>
                                    </span>
                                </button>
                                <div class="stitch-candidate-actions">
                                    <button type="button" class="mini-button" data-stitch-action="use-candidate" data-candidate-id="${candidate.id}" ${isRunning ? 'disabled' : ''}>Use</button>
                                </div>
                            </article>
                        `).join('')}
                    </div>
                `}
            </div>
        `;
    }

    function renderGallery(document) {
        refs.galleryOverlay.classList.toggle('is-open', !!document.workspace.galleryOpen);
        refs.galleryGrid.innerHTML = (document.candidates || []).length
            ? document.candidates.map((candidate) => `
                <article class="stitch-gallery-card ${document.activeCandidateId === candidate.id ? 'is-active' : ''}">
                    <div class="stitch-gallery-preview">
                        ${document.analysis?.previews?.[candidate.id]
                            ? `<img src="${document.analysis.previews[candidate.id]}" alt="${escapeHtml(candidate.name)}">`
                            : '<div class="stitch-gallery-placeholder">Preview pending</div>'}
                    </div>
                    <div class="stitch-gallery-meta">
                        <strong>${escapeHtml(candidate.name)}</strong>
                        <span>Rank #${candidate.rank || 0} | ${escapeHtml(formatModelType(candidate.modelType))}</span>
                        <span>Coverage ${formatPercent(candidate.coverage)} | Confidence ${formatPercent(candidate.confidence || 0)}</span>
                        <span>Score ${formatNumber(candidate.score, 2)} | Blend ${escapeHtml(formatModelType(candidate.blendMode || 'auto'))}</span>
                        ${candidate.warning ? `<div class="stitch-analysis-note is-warning">${escapeHtml(candidate.warning)}</div>` : ''}
                    </div>
                    <div class="stitch-gallery-actions">
                        <button type="button" class="toolbar-button" data-stitch-action="use-candidate" data-candidate-id="${candidate.id}">Use This</button>
                    </div>
                </article>
            `).join('')
            : '<div class="stitch-mini-empty">No candidates yet.</div>';
    }

    function renderHeader(document) {
        const activeCandidate = document.candidates.find((candidate) => candidate.id === document.activeCandidateId) || null;
        const activePlacements = getActivePlacements(document);
        const chips = [];

        refs.title.textContent = document.inputs.length
            ? activeCandidate
                ? `${activeCandidate.name} (${formatModelType(activeCandidate.modelType)})`
                : `Stitch Draft (${document.inputs.length} input${document.inputs.length === 1 ? '' : 's'})`
            : 'Stitch Workspace';

        if (stitchEngine.runtime.renderWidth || stitchEngine.runtime.renderHeight) {
            chips.push(buildMetricChip('Render', formatDimensions(stitchEngine.runtime.renderWidth, stitchEngine.runtime.renderHeight)));
        }
        chips.push(buildMetricChip('Sources', String(document.inputs.length)));
        chips.push(buildMetricChip('Visible', String(activePlacements.length)));
        chips.push(buildMetricChip('Panel', getPanelLabel(document.workspace.sidebarView)));
        if (activeCandidate) chips.push(buildMetricChip('Confidence', formatPercent(activeCandidate.confidence || 0), false));
        refs.metrics.innerHTML = chips.join('');

        const status = getStageStatus(document);
        refs.status.textContent = status.text;
        refs.status.dataset.tone = status.tone;
        const signature = `${status.tone}|${status.text}`;
        if (signature !== lastStatusLogSignature) {
            lastStatusLogSignature = signature;
            if (document.analysis?.status === 'running') {
                return;
            }
            logStitch(
                status.tone === 'error'
                    ? 'error'
                    : status.tone === 'warning'
                        ? 'warning'
                        : status.tone === 'success'
                            ? 'success'
                            : 'info',
                status.text,
                {
                    dedupeKey: signature,
                    dedupeWindowMs: 160
                }
            );
        }
    }

    async function render(document) {
        currentDocument = normalizeStitchDocument(document);
        renderDockState(currentDocument);
        renderHeader(currentDocument);
        renderInputs(currentDocument);
        renderAnalysis(currentDocument);
        renderSelection(currentDocument);
        renderCandidates(currentDocument);
        renderGallery(currentDocument);
        refs.empty.classList.toggle('is-visible', !currentDocument.inputs.length);
        applyTooltipState();
        requestAnimationFrame(() => renderHeader(currentDocument));
    }

    function toCanvasPoint(event) {
        const rect = refs.canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) * (refs.canvas.width / Math.max(1, rect.width)),
            y: (event.clientY - rect.top) * (refs.canvas.height / Math.max(1, rect.height))
        };
    }

    refs.fileInput.addEventListener('change', async () => {
        const files = Array.from(refs.fileInput.files || []);
        if (files.length) await actions.openStitchImages(files);
        refs.fileInput.value = '';
    });

    refs.canvas.addEventListener('pointerdown', (event) => {
        if (currentDocument.analysis?.status === 'running') return;
        const point = toCanvasPoint(event);
        const hit = stitchEngine.hitTest(currentDocument, point.x, point.y);
        if (!hit) {
            actions.selectStitchInput(null);
            return;
        }
        actions.selectStitchInput(hit.inputId);
        if (hit.placement?.locked) return;
        dragState = {
            inputId: hit.inputId,
            startWorldX: hit.worldX,
            startWorldY: hit.worldY,
            startPlacementX: hit.placement.x || 0,
            startPlacementY: hit.placement.y || 0
        };
        refs.canvas.setPointerCapture?.(event.pointerId);
    });

    refs.canvas.addEventListener('pointermove', (event) => {
        if (!dragState) return;
        const point = toCanvasPoint(event);
        const world = stitchEngine.screenToWorld(point.x, point.y);
        const deltaX = world.x - dragState.startWorldX;
        const deltaY = world.y - dragState.startWorldY;
        actions.updateStitchPlacement(dragState.inputId, {
            x: dragState.startPlacementX + deltaX,
            y: dragState.startPlacementY + deltaY
        }, { renderStitch: true, skipViewRender: true });
    });

    const finishDrag = () => {
        dragState = null;
    };
    refs.canvas.addEventListener('pointerup', finishDrag);
    refs.canvas.addEventListener('pointerleave', finishDrag);
    refs.canvas.addEventListener('pointercancel', finishDrag);

    root.addEventListener('click', async (event) => {
        const tooltipButton = event.target.closest('[data-stitch-tooltip-button]');
        if (tooltipButton) {
            const tooltipId = tooltipButton.dataset.stitchTooltipButton;
            setOpenTooltip(openTooltipId === tooltipId ? null : tooltipId);
            return;
        }

        const target = event.target.closest('[data-stitch-action]');
        if (!target) return;

        const action = target.dataset.stitchAction;
        const inputId = target.dataset.inputId;
        const candidateId = target.dataset.candidateId;
        const isRunning = currentDocument.analysis?.status === 'running';

        if (action === 'workspace-tab') {
            actions.setStitchSidebarView?.(target.dataset.sidebarView || 'inputs');
            return;
        }
        if (action === 'add-images') {
            refs.fileInput.click();
            return;
        }
        if (action === 'new-project') {
            await actions.newStitchProject?.();
            return;
        }
        if (action === 'run-analysis') {
            await actions.runStitchAnalysis?.();
            return;
        }
        if (action === 'open-gallery') {
            actions.setStitchGalleryOpen?.(true);
            return;
        }
        if (action === 'close-gallery') {
            actions.setStitchGalleryOpen?.(false);
            return;
        }
        if (isRunning && ['use-candidate', 'toggle-alternatives', 'remove-input', 'toggle-lock', 'toggle-visibility', 'move-up', 'move-down', 'reset-selected', 'reset-candidate', 'export-project', 'save-library'].includes(action)) {
            return;
        }
        if (action === 'use-candidate') {
            actions.chooseStitchCandidate?.(candidateId);
            return;
        }
        if (action === 'toggle-alternatives') {
            actions.setStitchAlternativesOpen?.(currentDocument.workspace.alternativesOpen === false);
            return;
        }
        if (action === 'select-input') {
            actions.selectStitchInput?.(inputId);
            return;
        }
        if (action === 'remove-input') {
            await actions.removeStitchInput?.(inputId);
            return;
        }
        if (action === 'toggle-lock') {
            actions.toggleStitchInputLock?.(inputId);
            return;
        }
        if (action === 'toggle-visibility') {
            actions.toggleStitchInputVisibility?.(inputId);
            return;
        }
        if (action === 'move-up') {
            actions.reorderStitchInput?.(inputId, -1);
            return;
        }
        if (action === 'move-down') {
            actions.reorderStitchInput?.(inputId, 1);
            return;
        }
        if (action === 'reset-selected') {
            actions.resetSelectedStitchPlacement?.();
            return;
        }
        if (action === 'reset-candidate') {
            actions.resetActiveStitchCandidate?.();
            return;
        }
        if (action === 'fit-view') {
            actions.resetStitchView?.();
            return;
        }
        if (action === 'export-project') {
            await actions.exportStitchProject?.();
            return;
        }
        if (action === 'save-library') {
            await actions.saveProjectToLibrary?.(null, { projectType: 'stitch' });
        }
    });

    root.addEventListener('click', (event) => {
        if (!openTooltipId) return;
        if (event.target.closest('[data-stitch-tooltip-wrap]')) return;
        setOpenTooltip(null);
    });

    root.addEventListener('change', (event) => {
        const target = event.target;
        if (currentDocument.analysis?.status === 'running') return;
        if (target.matches('[data-stitch-setting]')) {
            actions.updateStitchSetting?.(
                target.dataset.stitchSetting,
                target.type === 'checkbox' ? target.checked : target.value
            );
            return;
        }
        if (target.matches('[data-stitch-placement]')) {
            const key = target.dataset.stitchPlacement;
            const inputId = target.dataset.inputId;
            let value = Number(target.value);
            if (key === 'rotation') value *= (Math.PI / 180);
            actions.updateStitchPlacement?.(inputId, { [key]: value });
        }
    });

    root.addEventListener('pointerover', (event) => {
        if (!canUseHoverTooltips) return;
        const button = event.target.closest('[data-stitch-tooltip-button]');
        if (!button) return;
        setOpenTooltip(button.dataset.stitchTooltipButton);
    });

    root.addEventListener('pointerout', (event) => {
        if (!canUseHoverTooltips) return;
        const wrap = event.target.closest('[data-stitch-tooltip-wrap]');
        if (!wrap) return;
        if (event.relatedTarget && wrap.contains(event.relatedTarget)) return;
        if (openTooltipId === wrap.dataset.stitchTooltipWrap) setOpenTooltip(null);
    });

    root.addEventListener('focusin', (event) => {
        const button = event.target.closest('[data-stitch-tooltip-button]');
        if (!button) return;
        setOpenTooltip(button.dataset.stitchTooltipButton);
    });

    root.addEventListener('focusout', (event) => {
        const wrap = event.target.closest('[data-stitch-tooltip-wrap]');
        if (!wrap) return;
        if (event.relatedTarget && wrap.contains(event.relatedTarget)) return;
        if (openTooltipId === wrap.dataset.stitchTooltipWrap) setOpenTooltip(null);
    });

    root.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && openTooltipId) setOpenTooltip(null);
    });

    root.ownerDocument.addEventListener('pointerdown', (event) => {
        if (!openTooltipId) return;
        if (!root.contains(event.target)) setOpenTooltip(null);
    });

    root.addEventListener('scroll', (event) => {
        if (openTooltipId && event.target.closest('.stitch-dock-panel-body, .stitch-gallery-panel')) {
            setOpenTooltip(null);
        }
    }, { capture: true, passive: true });

    return {
        activate() {
            root.style.display = 'block';
            logStitch('info', 'Stitch workspace activated.', {
                dedupeKey: 'stitch-workspace-activated',
                dedupeWindowMs: 180
            });
            stitchEngine.requestRender(currentDocument);
        },
        deactivate() {
            root.style.display = 'none';
            logStitch('info', 'Stitch workspace hidden.', {
                dedupeKey: 'stitch-workspace-hidden',
                dedupeWindowMs: 180
            });
        },
        openPicker() {
            refs.fileInput.click();
        },
        setProgressOverlay(payload = null) {
            if (payload?.active) {
                progressOverlay.show(payload);
                return;
            }
            progressOverlay.hide();
        },
        async render(document) {
            await render(document);
        }
    };
}
