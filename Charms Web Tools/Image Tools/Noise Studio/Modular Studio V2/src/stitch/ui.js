import { getActivePlacements, getPlacementByInput, getSelectedStitchInput, normalizeStitchDocument } from './document.js';
import { STITCH_ANALYSIS_GROUPS, STITCH_SELECTION_ACTION_HELP, STITCH_SELECTION_FIELDS } from './meta.js';

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
            <button
                type="button"
                class="stitch-help-button"
                data-stitch-tooltip-button="${id}"
                aria-label="Open help"
                aria-expanded="false"
            >?</button>
            <div class="stitch-tooltip-popover" data-stitch-tooltip="${id}" role="tooltip">${escapeHtml(help)}</div>
        </span>
    `;
}

function renderSettingField(document, field) {
    const value = document.settings?.[field.key];
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
                <select data-stitch-setting="${field.key}">
                    ${field.options.map((option) => `
                        <option value="${option.value}" ${String(value) === option.value ? 'selected' : ''}>${escapeHtml(option.label)}</option>
                    `).join('')}
                </select>
            </label>
        `;
    }
    if (field.type === 'checkbox') {
        return `
            <label class="stitch-setting-checkbox">
                <input type="checkbox" data-stitch-setting="${field.key}" ${value ? 'checked' : ''}>
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
            <input type="number" min="${field.min}" max="${field.max}" step="${field.step}" value="${value}" data-stitch-setting="${field.key}" ${field.key === 'analysisMaxDimension' && document.settings.useFullResolutionAnalysis ? 'disabled' : ''}>
        </label>
    `;
}

export function createStitchWorkspace(root, { actions, stitchEngine }) {
    root.innerHTML = `
        <div class="stitch-shell">
            <div class="stitch-main">
                <aside class="stitch-sidebar stitch-sidebar-left">
                    <div class="stitch-sidebar-section stitch-sidebar-section-inputs">
                        <div class="stitch-section-header">
                            <strong>Inputs</strong>
                            <button type="button" class="mini-button" data-stitch-action="add-images">Add Images</button>
                        </div>
                        <div class="stitch-input-list" data-stitch-role="input-list"></div>
                    </div>
                    <div class="stitch-sidebar-section stitch-sidebar-section-analysis">
                        <div class="stitch-section-header">
                            <strong>Analysis</strong>
                            <button type="button" class="mini-button" data-stitch-action="open-gallery">Gallery</button>
                        </div>
                        <div class="stitch-analysis-card" data-stitch-role="analysis-card"></div>
                    </div>
                </aside>
                <section class="stitch-center">
                    <div class="stitch-stage-header">
                        <div class="stitch-stage-title">
                            <div class="eyebrow">Stitch Preview</div>
                            <h2 data-stitch-role="title">Stitch Workspace</h2>
                        </div>
                        <div class="stitch-stage-metrics" data-stitch-role="metrics"></div>
                    </div>
                    <div class="stitch-stage-wrap">
                        <canvas class="stitch-canvas" data-stitch-role="canvas"></canvas>
                        <div class="stitch-empty-state" data-stitch-role="empty-state">
                            <strong>Add two or more images</strong>
                            <span>Run the Stitch analysis to generate candidate layouts, then refine the result by hand.</span>
                        </div>
                    </div>
                    <div class="stitch-alternatives" data-stitch-role="alternatives"></div>
                </section>
                <aside class="stitch-sidebar stitch-sidebar-right">
                    <div class="stitch-sidebar-section stitch-sidebar-section-selection">
                        <div class="stitch-section-header">
                            <strong>Selection</strong>
                            <button type="button" class="mini-button" data-stitch-action="reset-selected">Reset Image</button>
                        </div>
                        <div class="stitch-selection-card" data-stitch-role="selection-card"></div>
                    </div>
                </aside>
            </div>
            <div class="stitch-gallery-overlay" data-stitch-role="gallery-overlay">
                <div class="stitch-gallery-panel">
                    <div class="stitch-gallery-header">
                        <div>
                            <div class="eyebrow">Candidate Gallery</div>
                            <h3>Possible Stitch Layouts</h3>
                        </div>
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
        empty: root.querySelector('[data-stitch-role="empty-state"]'),
        inputList: root.querySelector('[data-stitch-role="input-list"]'),
        analysisCard: root.querySelector('[data-stitch-role="analysis-card"]'),
        selectionCard: root.querySelector('[data-stitch-role="selection-card"]'),
        alternatives: root.querySelector('[data-stitch-role="alternatives"]'),
        galleryOverlay: root.querySelector('[data-stitch-role="gallery-overlay"]'),
        galleryGrid: root.querySelector('[data-stitch-role="gallery-grid"]'),
        fileInput: root.querySelector('[data-stitch-role="file-input"]')
    };

    let currentDocument = normalizeStitchDocument();
    let dragState = null;
    let openTooltipId = null;
    const canUseHoverTooltips = typeof window.matchMedia === 'function'
        ? window.matchMedia('(hover: hover)').matches
        : false;

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
                // Ensure popover is visible for measurement
                popover.style.display = 'block';
                popover.style.visibility = 'hidden';
                popover.style.pointerEvents = 'none';

                const triggerRect = button.getBoundingClientRect();
                const popoverRect = popover.getBoundingClientRect();
                const viewportWidth = window.innerWidth;
                const viewportHeight = window.innerHeight;

                // Default: below, right-aligned to trigger
                let top = triggerRect.bottom + 8;
                let left = triggerRect.right - popoverRect.width;

                // Horizontal bounds check
                if (left < 10) {
                    left = triggerRect.left; // Try left-aligned
                }
                if (left + popoverRect.width > viewportWidth - 10) {
                    left = viewportWidth - popoverRect.width - 10;
                }
                if (left < 10) left = 10;

                // Vertical bounds check
                if (top + popoverRect.height > viewportHeight - 10) {
                    // Flip to top if it would go off bottom
                    top = triggerRect.top - popoverRect.height - 8;
                }
                
                // Final safety clamp for vertical
                if (top < 10) top = 10;

                popover.style.top = `${top}px`;
                popover.style.left = `${left}px`;
                popover.style.visibility = 'visible';
                popover.style.pointerEvents = 'auto';
            } else if (!isOpen && popover) {
                // Reset styles when closed
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

    function renderInputs(document) {
        const orderedInputs = [...document.inputs].sort((a, b) => {
            const placementA = getPlacementByInput(document, a.id);
            const placementB = getPlacementByInput(document, b.id);
            return (placementA?.z || 0) - (placementB?.z || 0);
        });
        refs.inputList.innerHTML = orderedInputs.length
            ? orderedInputs.map((input) => {
                const placement = getPlacementByInput(document, input.id);
                const selected = document.selection.inputId === input.id;
                return `
                    <div class="stitch-input-item ${selected ? 'is-selected' : ''}">
                        <button type="button" class="stitch-input-main" data-stitch-action="select-input" data-input-id="${input.id}">
                            <strong>${escapeHtml(input.name)}</strong>
                            <span>${escapeHtml(formatDimensions(input.width, input.height))}</span>
                        </button>
                        <div class="stitch-input-actions">
                            <button type="button" class="mini-button" data-stitch-action="toggle-visibility" data-input-id="${input.id}">${placement?.visible === false ? 'Show' : 'Hide'}</button>
                            <button type="button" class="mini-button" data-stitch-action="toggle-lock" data-input-id="${input.id}">${placement?.locked ? 'Unlock' : 'Lock'}</button>
                            <button type="button" class="mini-button" data-stitch-action="move-up" data-input-id="${input.id}">Up</button>
                            <button type="button" class="mini-button" data-stitch-action="move-down" data-input-id="${input.id}">Down</button>
                            <button type="button" class="mini-button is-danger" data-stitch-action="remove-input" data-input-id="${input.id}">Remove</button>
                        </div>
                    </div>
                `;
            }).join('')
            : '<div class="stitch-mini-empty">No images loaded yet.</div>';
    }

    function renderAnalysis(document) {
        const analysis = document.analysis || {};
        const topCandidate = (document.candidates || [])[0] || null;
        refs.analysisCard.innerHTML = `
            <div class="stitch-analysis-line"><strong>Status</strong><span>${escapeHtml(analysis.status || 'idle')}</span></div>
            <div class="stitch-analysis-line"><strong>Inputs</strong><span>${document.inputs.length}</span></div>
            <div class="stitch-analysis-line"><strong>Candidates</strong><span>${document.candidates.length}</span></div>
            ${topCandidate ? `<div class="stitch-analysis-line"><strong>Top Result</strong><span>${escapeHtml(formatModelType(topCandidate.modelType))} | ${formatPercent(topCandidate.confidence || 0)}</span></div>` : ''}
            ${analysis.warning ? `<div class="stitch-analysis-note is-warning">${escapeHtml(analysis.warning)}</div>` : ''}
            ${analysis.error ? `<div class="stitch-analysis-note is-error">${escapeHtml(analysis.error)}</div>` : ''}
            ${STITCH_ANALYSIS_GROUPS.map((group) => `
                <section class="stitch-settings-group">
                    <div class="stitch-settings-group-header">
                        <strong>${escapeHtml(group.title)}</strong>
                    </div>
                    <div class="stitch-setting-grid ${group.fields.some((field) => field.type === 'checkbox') ? 'has-checkbox' : ''}">
                        ${group.fields.map((field) => renderSettingField(document, field)).join('')}
                    </div>
                </section>
            `).join('')}
            <div class="button-cluster stitch-analysis-actions">
                <button type="button" class="toolbar-button" data-stitch-action="run-analysis" ${document.inputs.length < 2 ? 'disabled' : ''}>${analysis.status === 'running' ? 'Analyzing...' : 'Run Analysis'}</button>
                <button type="button" class="toolbar-button" data-stitch-action="reset-candidate" ${document.activeCandidateId ? '' : 'disabled'}>Reset Candidate</button>
            </div>
        `;
    }

    function renderSelection(document) {
        const input = getSelectedStitchInput(document);
        const placement = input ? getPlacementByInput(document, input.id) : null;
        if (!input || !placement) {
            refs.selectionCard.innerHTML = '<div class="stitch-mini-empty">Select an image to move, rotate, scale, or lock it.</div>';
            return;
        }

        refs.selectionCard.innerHTML = `
            <div class="stitch-selection-header">
                <strong>${escapeHtml(input.name)}</strong>
                <span>${escapeHtml(formatDimensions(input.width, input.height))}</span>
            </div>
            <div class="stitch-setting-grid stitch-setting-grid-selection">
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
                        >
                    </label>
                `).join('')}
            </div>
            ${placement.warp ? `
                <div class="stitch-analysis-note">
                    Auto warp: ${escapeHtml(formatModelType(placement.warp.type))} grid ${escapeHtml(String(placement.warp.cols))} x ${escapeHtml(String(placement.warp.rows))}
                </div>
            ` : ''}
            <div class="stitch-selection-help-row">
                <span class="stitch-selection-help-chip">
                    <strong>Reset Image</strong>
                    ${tooltipMarkup('action:reset', STITCH_SELECTION_ACTION_HELP.reset)}
                </span>
                <span class="stitch-selection-help-chip">
                    <strong>Hide / Show</strong>
                    ${tooltipMarkup('action:visibility', STITCH_SELECTION_ACTION_HELP.visibility)}
                </span>
                <span class="stitch-selection-help-chip">
                    <strong>Lock</strong>
                    ${tooltipMarkup('action:lock', STITCH_SELECTION_ACTION_HELP.lock)}
                </span>
            </div>
            <div class="button-cluster stitch-selection-actions">
                <button type="button" class="mini-button" data-stitch-action="toggle-visibility" data-input-id="${input.id}">${placement.visible === false ? 'Show' : 'Hide'}</button>
                <button type="button" class="mini-button" data-stitch-action="toggle-lock" data-input-id="${input.id}">${placement.locked ? 'Unlock' : 'Lock'}</button>
            </div>
        `;
    }

    function renderAlternatives(document) {
        const candidates = document.candidates || [];
        if (!candidates.length) {
            refs.alternatives.innerHTML = '<div class="stitch-mini-empty">Run the analysis to generate stitch candidates.</div>';
            return;
        }

        refs.alternatives.innerHTML = `
            <div class="stitch-alt-header">
                <strong>Alternatives</strong>
                <button type="button" class="mini-button" data-stitch-action="toggle-alternatives">${document.workspace.alternativesOpen === false ? 'Show' : 'Hide'}</button>
            </div>
            ${document.workspace.alternativesOpen === false ? '' : `
                <div class="stitch-alt-list">
                    ${candidates.map((candidate) => `
                        <button
                            type="button"
                            class="stitch-alt-chip ${document.activeCandidateId === candidate.id ? 'is-active' : ''}"
                            data-stitch-action="use-candidate"
                            data-candidate-id="${candidate.id}"
                        >
                            <strong>${escapeHtml(candidate.name)}</strong>
                            <span>#${candidate.rank || 0} | ${escapeHtml(formatModelType(candidate.modelType))}</span>
                            <span>${formatPercent(candidate.coverage)} coverage | ${formatPercent(candidate.confidence || 0)} confidence</span>
                        </button>
                    `).join('')}
                </div>
            `}
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
        const activeCandidate = document.candidates.find((candidate) => candidate.id === document.activeCandidateId);
        refs.title.textContent = document.inputs.length
            ? activeCandidate
                ? `${activeCandidate.name} (${formatModelType(activeCandidate.modelType)} | ${document.inputs.length} input${document.inputs.length === 1 ? '' : 's'})`
                : `Stitch Draft (${document.inputs.length} input${document.inputs.length === 1 ? '' : 's'})`
            : 'Stitch Workspace';
        refs.metrics.innerHTML = `
            <span>Render ${formatDimensions(stitchEngine.runtime.renderWidth, stitchEngine.runtime.renderHeight)}</span>
            <span>${document.inputs.length} source${document.inputs.length === 1 ? '' : 's'}</span>
            ${activeCandidate ? `<span>${escapeHtml(formatPercent(activeCandidate.confidence || 0))} confidence</span>` : ''}
        `;
    }

    async function render(document) {
        currentDocument = normalizeStitchDocument(document);
        renderHeader(currentDocument);
        renderInputs(currentDocument);
        renderAnalysis(currentDocument);
        renderSelection(currentDocument);
        renderAlternatives(currentDocument);
        renderGallery(currentDocument);
        refs.empty.classList.toggle('is-visible', !currentDocument.inputs.length);
        applyTooltipState();
        stitchEngine.requestRender(currentDocument);
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

        if (action === 'add-images') {
            refs.fileInput.click();
            return;
        }
        if (action === 'run-analysis') {
            await actions.runStitchAnalysis();
            return;
        }
        if (action === 'open-gallery') {
            actions.setStitchGalleryOpen(true);
            return;
        }
        if (action === 'close-gallery') {
            actions.setStitchGalleryOpen(false);
            return;
        }
        if (action === 'use-candidate') {
            actions.chooseStitchCandidate(candidateId);
            return;
        }
        if (action === 'toggle-alternatives') {
            actions.setStitchAlternativesOpen(currentDocument.workspace.alternativesOpen === false);
            return;
        }
        if (action === 'select-input') {
            actions.selectStitchInput(inputId);
            return;
        }
        if (action === 'remove-input') {
            await actions.removeStitchInput(inputId);
            return;
        }
        if (action === 'toggle-lock') {
            actions.toggleStitchInputLock(inputId);
            return;
        }
        if (action === 'toggle-visibility') {
            actions.toggleStitchInputVisibility(inputId);
            return;
        }
        if (action === 'move-up') {
            actions.reorderStitchInput(inputId, -1);
            return;
        }
        if (action === 'move-down') {
            actions.reorderStitchInput(inputId, 1);
            return;
        }
        if (action === 'reset-selected') {
            actions.resetSelectedStitchPlacement();
            return;
        }
        if (action === 'reset-candidate') {
            actions.resetActiveStitchCandidate();
        }
    });

    root.addEventListener('click', (event) => {
        if (!openTooltipId) return;
        if (event.target.closest('[data-stitch-tooltip-wrap]')) return;
        setOpenTooltip(null);
    });

    root.addEventListener('change', (event) => {
        const target = event.target;
        if (target.matches('[data-stitch-setting]')) {
            actions.updateStitchSetting(
                target.dataset.stitchSetting,
                target.type === 'checkbox' ? target.checked : target.value
            );
            return;
        }
        if (target.matches('[data-stitch-placement]')) {
            const key = target.dataset.stitchPlacement;
            const inputId = target.dataset.inputId;
            let value = Number(target.value);
            if (key === 'rotation') value = value * (Math.PI / 180);
            actions.updateStitchPlacement(inputId, { [key]: value });
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
        if (event.key === 'Escape' && openTooltipId) {
            setOpenTooltip(null);
        }
    });

    root.ownerDocument.addEventListener('pointerdown', (event) => {
        if (!openTooltipId) return;
        if (!root.contains(event.target)) setOpenTooltip(null);
    });

    // Close tooltips on scroll to prevent "floating" detached from trigger
    root.addEventListener('scroll', (event) => {
        if (openTooltipId && event.target.closest('.stitch-sidebar, .stitch-main')) {
            setOpenTooltip(null);
        }
    }, { capture: true, passive: true });

    return {
        activate() {
            root.style.display = 'block';
            stitchEngine.requestRender(currentDocument);
        },
        deactivate() {
            root.style.display = 'none';
        },
        openPicker() {
            refs.fileInput.click();
        },
        async render(document) {
            await render(document);
        }
    };
}
