import { getActivePlacements, getPlacementByInput, getSelectedStitchInput, normalizeStitchDocument } from './document.js';

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
    return numeric.toFixed(digits).replace(/\.?0+$/, '');
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

export function createStitchWorkspace(root, { actions, stitchEngine }) {
    root.innerHTML = `
        <div class="stitch-shell">
            <div class="stitch-main">
                <aside class="stitch-sidebar stitch-sidebar-left">
                    <div class="stitch-sidebar-section">
                        <div class="stitch-section-header">
                            <strong>Inputs</strong>
                            <button type="button" class="mini-button" data-stitch-action="add-images">Add Images</button>
                        </div>
                        <div class="stitch-input-list" data-stitch-role="input-list"></div>
                    </div>
                    <div class="stitch-sidebar-section">
                        <div class="stitch-section-header">
                            <strong>Analysis</strong>
                            <button type="button" class="mini-button" data-stitch-action="open-gallery">Gallery</button>
                        </div>
                        <div class="stitch-analysis-card" data-stitch-role="analysis-card"></div>
                    </div>
                </aside>
                <section class="stitch-center">
                    <div class="stitch-stage-header">
                        <div>
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
                    <div class="stitch-sidebar-section">
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

    stitchEngine.attachCanvas(refs.canvas);

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
        refs.analysisCard.innerHTML = `
            <div class="stitch-analysis-line"><strong>Status</strong><span>${escapeHtml(analysis.status || 'idle')}</span></div>
            <div class="stitch-analysis-line"><strong>Inputs</strong><span>${document.inputs.length}</span></div>
            <div class="stitch-analysis-line"><strong>Candidates</strong><span>${document.candidates.length}</span></div>
            ${analysis.warning ? `<div class="stitch-analysis-note is-warning">${escapeHtml(analysis.warning)}</div>` : ''}
            ${analysis.error ? `<div class="stitch-analysis-note is-error">${escapeHtml(analysis.error)}</div>` : ''}
            <div class="stitch-setting-grid">
                <label class="stitch-setting">
                    <span>Analysis Size</span>
                    <input type="number" min="128" max="768" step="16" value="${document.settings.analysisMaxDimension}" data-stitch-setting="analysisMaxDimension" ${document.settings.useFullResolutionAnalysis ? 'disabled' : ''}>
                </label>
                <label class="stitch-setting">
                    <span>Max Features</span>
                    <input type="number" min="20" max="300" step="5" value="${document.settings.maxFeatures}" data-stitch-setting="maxFeatures">
                </label>
                <label class="stitch-setting">
                    <span>Match Ratio</span>
                    <input type="number" min="0.4" max="0.99" step="0.01" value="${document.settings.matchRatio}" data-stitch-setting="matchRatio">
                </label>
                <label class="stitch-setting">
                    <span>RANSAC</span>
                    <input type="number" min="40" max="1200" step="10" value="${document.settings.ransacIterations}" data-stitch-setting="ransacIterations">
                </label>
                <label class="stitch-setting">
                    <span>Threshold</span>
                    <input type="number" min="3" max="80" step="1" value="${document.settings.inlierThreshold}" data-stitch-setting="inlierThreshold">
                </label>
            </div>
            <label class="stitch-setting-checkbox">
                <input type="checkbox" data-stitch-setting="useFullResolutionAnalysis" ${document.settings.useFullResolutionAnalysis ? 'checked' : ''}>
                <div>
                    <strong>Use Full Resolution</strong>
                    <span>Skip the analysis downscale step and use the original image sizes. This can be much slower, but it can help on screenshots and UI captures.</span>
                </div>
            </label>
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
            <label class="stitch-setting">
                <span>Position X</span>
                <input type="number" step="1" value="${formatNumber(placement.x, 0)}" data-stitch-placement="x" data-input-id="${input.id}">
            </label>
            <label class="stitch-setting">
                <span>Position Y</span>
                <input type="number" step="1" value="${formatNumber(placement.y, 0)}" data-stitch-placement="y" data-input-id="${input.id}">
            </label>
            <label class="stitch-setting">
                <span>Scale</span>
                <input type="number" min="0.05" max="8" step="0.01" value="${formatNumber(placement.scale, 2)}" data-stitch-placement="scale" data-input-id="${input.id}">
            </label>
            <label class="stitch-setting">
                <span>Rotation (deg)</span>
                <input type="number" min="-180" max="180" step="0.5" value="${formatNumber((placement.rotation || 0) * (180 / Math.PI), 1)}" data-stitch-placement="rotation" data-input-id="${input.id}">
            </label>
            <div class="button-cluster">
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
                            <span>${formatPercent(candidate.coverage)} coverage</span>
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
                        <span>Coverage ${formatPercent(candidate.coverage)}</span>
                        <span>Score ${formatNumber(candidate.score, 2)}</span>
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
                ? `${activeCandidate.name} (${document.inputs.length} input${document.inputs.length === 1 ? '' : 's'})`
                : `Stitch Draft (${document.inputs.length} input${document.inputs.length === 1 ? '' : 's'})`
            : 'Stitch Workspace';
        refs.metrics.innerHTML = `
            <span>Render ${formatDimensions(stitchEngine.runtime.renderWidth, stitchEngine.runtime.renderHeight)}</span>
            <span>${document.inputs.length} source${document.inputs.length === 1 ? '' : 's'}</span>
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
