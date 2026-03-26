const SKIP_PARAMS = new Set(['_libraryName']);

function formatParamValue(value) {
    if (value === null || value === undefined) return '-';
    if (typeof value === 'boolean') return value ? 'ON' : 'OFF';
    if (typeof value === 'number') return String(Math.round(value * 1000) / 1000);
    if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}...` : value;
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') return `{${Object.keys(value).length} keys}`;
    return String(value);
}

function valuesMatch(left, right) {
    if (left === right) return true;
    if (typeof left !== typeof right) return false;
    if (typeof left === 'object' && left !== null && right !== null) {
        try {
            return JSON.stringify(left) === JSON.stringify(right);
        } catch (_error) {
            return false;
        }
    }
    return false;
}

function normalizeLibraryDocumentPayload(payload) {
    return {
        ...(payload || {}),
        mode: payload?.mode || 'studio',
        version: 'mns/v2',
        kind: 'document'
    };
}

function createTemplate() {
    return `
        <div class="library-panel-shell">
            <header class="toolbar library-toolbar">
                <div class="library-toolbar-title">Library</div>
                <div class="toolbar-cluster">
                    <button type="button" class="toolbar-button" data-library-action="upload">Upload JSON</button>
                    <button type="button" class="toolbar-button" data-library-action="toggle-hover">Hover Original</button>
                    <button type="button" class="toolbar-button" data-library-action="toggle-fullscreen">Interactive Series</button>
                </div>
                <div class="toolbar-cluster">
                    <button type="button" class="toolbar-button" data-library-action="download-all">Save Full Project</button>
                    <button type="button" class="toolbar-button" data-library-action="export-zip">Export All JSONs</button>
                    <button type="button" class="toolbar-button" data-library-action="clear-all">Clear All</button>
                </div>
            </header>
            <div class="library-content">
                <div class="library-grid-view"></div>
                <div class="library-empty-state">
                    <strong>Library is empty</strong>
                    <span>Save from the editor or upload Library JSON files to build a project collection here.</span>
                </div>
                <div class="library-fullscreen-view">
                    <div class="library-fullscreen-label"></div>
                    <div class="library-hover-hint">Hovering Original</div>
                    <div class="library-image-container">
                        <img src="" class="library-img-base" data-library-role="fullscreen-base" alt="">
                        <img src="" class="library-img-hover" data-library-role="fullscreen-hover" alt="">
                    </div>
                </div>
                <div class="library-loading-overlay">
                    <h2 class="library-status-text">Preparing engine...</h2>
                    <p class="library-count-text">0 / 0 variants</p>
                    <div class="library-progress-bar"><div class="library-progress-fill"></div></div>
                </div>
            </div>
            <div class="library-modal-overlay">
                <div class="library-modal-box">
                    <div class="library-modal-text"></div>
                    <div class="library-modal-actions"></div>
                </div>
            </div>
            <div class="library-detail-overlay">
                <div class="library-detail-shell">
                    <div class="library-detail-image-pane">
                        <div class="library-hover-hint">Hovering Original</div>
                        <div class="library-image-container">
                            <img src="" class="library-img-base" data-library-role="detail-base" alt="">
                            <img src="" class="library-img-hover" data-library-role="detail-hover" alt="">
                        </div>
                    </div>
                    <div class="library-detail-sidebar">
                        <div class="library-detail-sidebar-header">
                            <div>
                                <h3 class="library-detail-name"></h3>
                                <div class="library-detail-meta"></div>
                            </div>
                        </div>
                        <div class="library-detail-sidebar-scroll"></div>
                        <div class="library-detail-sidebar-footer">
                            <button type="button" class="toolbar-button" data-library-action="load-detail">Load In Editor</button>
                            <button type="button" class="toolbar-button" data-library-action="close-detail">Close</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

export function createLibraryPanel(root, { actions, layerDefaults }) {
    root.innerHTML = createTemplate();

    const refs = {
        shell: root.querySelector('.library-panel-shell'),
        toolbar: root.querySelector('.library-toolbar'),
        gridView: root.querySelector('.library-grid-view'),
        emptyState: root.querySelector('.library-empty-state'),
        fullscreenView: root.querySelector('.library-fullscreen-view'),
        fullscreenLabel: root.querySelector('.library-fullscreen-label'),
        fullscreenBase: root.querySelector('[data-library-role="fullscreen-base"]'),
        fullscreenHover: root.querySelector('[data-library-role="fullscreen-hover"]'),
        loadingOverlay: root.querySelector('.library-loading-overlay'),
        statusText: root.querySelector('.library-status-text'),
        countText: root.querySelector('.library-count-text'),
        progressFill: root.querySelector('.library-progress-fill'),
        modalOverlay: root.querySelector('.library-modal-overlay'),
        modalText: root.querySelector('.library-modal-text'),
        modalActions: root.querySelector('.library-modal-actions'),
        detailOverlay: root.querySelector('.library-detail-overlay'),
        detailBase: root.querySelector('[data-library-role="detail-base"]'),
        detailHover: root.querySelector('[data-library-role="detail-hover"]'),
        detailName: root.querySelector('.library-detail-name'),
        detailMeta: root.querySelector('.library-detail-meta'),
        detailLayers: root.querySelector('.library-detail-sidebar-scroll')
    };

    let libraryData = [];
    let isHoverEnabled = false;
    let isFullscreen = false;
    let currentIndex = 0;
    let detailData = null;
    let refreshToken = 0;

    function setHoverEnabled(nextValue) {
        isHoverEnabled = !!nextValue;
        refs.shell.classList.toggle('is-hover-enabled', isHoverEnabled);
        const button = refs.toolbar.querySelector('[data-library-action="toggle-hover"]');
        if (button) button.classList.toggle('is-active', isHoverEnabled);
    }

    function updateFullscreenToggle() {
        const button = refs.toolbar.querySelector('[data-library-action="toggle-fullscreen"]');
        if (!button) return;
        button.classList.toggle('is-active', isFullscreen);
        button.textContent = isFullscreen ? 'Show Grid' : 'Interactive Series';
    }

    function setFullscreenEnabled(nextValue) {
        isFullscreen = !!nextValue && libraryData.length > 0;
        refs.gridView.classList.toggle('is-hidden', isFullscreen);
        refs.fullscreenView.classList.toggle('is-active', isFullscreen);
        updateFullscreenToggle();
        updateFullscreen();
    }

    function revokeUrls() {
        libraryData.forEach((item) => URL.revokeObjectURL(item.url));
    }

    function renderLayerCards(payload) {
        let html = '';
        if (payload.source) {
            html += '<div class="library-source-info"><div class="eyebrow">Source Image</div>';
            html += `<div class="library-param-row"><span class="library-param-key">name</span><span class="library-param-val">${payload.source.name || '-'}</span></div>`;
            if (payload.source.width) {
                html += `<div class="library-param-row"><span class="library-param-key">size</span><span class="library-param-val">${payload.source.width} x ${payload.source.height}</span></div>`;
            }
            html += '</div>';
        }
        const stack = payload.layerStack || [];
        if (!stack.length) {
            html += '<div class="library-detail-empty">No layers</div>';
            return html;
        }
        stack.forEach((layer, index) => {
            const defaults = layerDefaults[layer.layerId] || {};
            html += '<div class="library-layer-card">';
            html += `<div class="library-layer-card-header"><strong>${layer.layerId || 'unknown'}</strong><span>#${index + 1}${layer.enabled === false ? ' - OFF' : ''}</span></div>`;
            html += '<div class="library-layer-card-body">';
            const params = layer.params || {};
            const keys = Object.keys(params).filter((key) => {
                if (SKIP_PARAMS.has(key) || key.startsWith('_')) return false;
                const value = params[key];
                if (typeof value === 'string' && value.startsWith('data:')) return false;
                if (key in defaults && valuesMatch(value, defaults[key])) return false;
                return true;
            });
            if (!keys.length) {
                html += '<div class="library-detail-empty">Default settings</div>';
            } else {
                keys.forEach((key) => {
                    html += `<div class="library-param-row"><span class="library-param-key">${key}</span><span class="library-param-val">${formatParamValue(params[key])}</span></div>`;
                });
            }
            html += '</div></div>';
        });
        return html;
    }

    function renderGrid() {
        refs.gridView.innerHTML = libraryData.map((item, index) => `
            <div class="library-grid-item" data-library-index="${index}">
                <div class="library-label">${item.name}</div>
                <button type="button" class="library-delete-button" data-library-action="delete-project" data-library-id="${item.id}" title="Delete">&times;</button>
                <div class="library-hover-hint">Hovering Original</div>
                <div class="library-image-container">
                    <img src="${item.url}" class="library-img-base" alt="">
                    <img src="${item.hoverSrc}" class="library-img-hover" alt="">
                </div>
            </div>
        `).join('');
        refs.emptyState.classList.toggle('is-visible', libraryData.length === 0);
    }

    function updateFullscreen() {
        if (!libraryData.length || !isFullscreen) return;
        if (currentIndex >= libraryData.length) currentIndex = 0;
        const current = libraryData[currentIndex];
        refs.fullscreenLabel.textContent = `${current.name} (${currentIndex + 1} / ${libraryData.length})`;
        refs.fullscreenBase.src = current.url;
        refs.fullscreenHover.src = current.hoverSrc || '';
    }

    function openDetailByData(data) {
        if (!data) return;
        detailData = data;
        refs.detailBase.src = data.url;
        refs.detailHover.src = data.hoverSrc || '';
        refs.detailName.textContent = data.name;
        const stack = data.payload.layerStack || [];
        const activeCount = stack.filter((layer) => layer.enabled !== false).length;
        refs.detailMeta.textContent = `${stack.length} layers - ${activeCount} active`;
        refs.detailLayers.innerHTML = renderLayerCards(data.payload);
        refs.detailOverlay.classList.add('is-active');
    }

    function closeDetail() {
        refs.detailOverlay.classList.remove('is-active');
        detailData = null;
    }

    function showModal(message, buttons) {
        return new Promise((resolve) => {
            refs.modalText.textContent = message;
            refs.modalActions.innerHTML = '';
            buttons.forEach((button) => {
                const element = document.createElement('button');
                element.type = 'button';
                element.className = `toolbar-button${button.className ? ` ${button.className}` : ''}`;
                element.textContent = button.label;
                element.addEventListener('click', () => {
                    refs.modalOverlay.classList.remove('is-active');
                    resolve(button.value);
                });
                refs.modalActions.appendChild(element);
            });
            refs.modalOverlay.classList.add('is-active');
        });
    }

    function showAlert(message) {
        return showModal(message, [{ label: 'OK', value: true, className: 'is-active' }]);
    }

    function setProgress(event) {
        if (!event || event.phase === 'complete') {
            refs.loadingOverlay.classList.remove('is-active');
            return;
        }
        refs.loadingOverlay.classList.add('is-active');
        if (event.phase === 'start') {
            refs.statusText.textContent = 'Preparing engine...';
            refs.countText.textContent = `0 / ${event.total} variants`;
            refs.progressFill.style.width = '0%';
            return;
        }
        refs.statusText.textContent = `Rendering ${event.filename}...`;
        refs.countText.textContent = `${event.count} / ${event.total} variants`;
        refs.progressFill.style.width = `${event.total ? (event.count / event.total) * 100 : 0}%`;
    }

    async function refresh() {
        const token = refreshToken + 1;
        refreshToken = token;
        const projects = await actions.getLibraryProjects();
        if (token !== refreshToken) return;
        revokeUrls();
        const sorted = [...projects].sort((left, right) => left.timestamp - right.timestamp);
        libraryData = sorted.map((project) => ({
            ...project,
            url: URL.createObjectURL(project.blob),
            hoverSrc: project.payload?.source?.imageData || ''
        }));
        renderGrid();
        if (isFullscreen && !libraryData.length) {
            setFullscreenEnabled(false);
        } else {
            updateFullscreen();
        }
        if (detailData) {
            const replacement = libraryData.find((item) => item.id === detailData.id);
            if (replacement) openDetailByData(replacement);
            else closeDetail();
        }
    }

    async function triggerUpload() {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = '.mns.json,.json';
        input.addEventListener('change', async (event) => {
            const files = Array.from(event.target.files || []);
            if (!files.length) return;
            const payloadTexts = await Promise.all(files.map((file) => file.text()));
            const unrolledPayloads = [];
            const unrolledNames = [];
            payloadTexts.forEach((text, index) => {
                try {
                    const parsed = JSON.parse(text);
                    if (Array.isArray(parsed)) {
                        parsed.forEach((item, subIndex) => {
                            const savedName = item._libraryName || `${files[index].name.replace('.json', '')}-${subIndex}.json`;
                            unrolledPayloads.push(JSON.stringify(item));
                            unrolledNames.push(savedName);
                        });
                    } else {
                        unrolledPayloads.push(text);
                        unrolledNames.push(files[index].name);
                    }
                } catch (_error) {
                    // Skip invalid payloads silently to preserve the previous behavior.
                }
            });

            if (!unrolledPayloads.length) {
                showAlert('No valid JSON payloads were found in the selected files.');
                return;
            }

            try {
                await actions.processLibraryPayloads(unrolledPayloads, unrolledNames, setProgress);
                await refresh();
            } catch (error) {
                setProgress({ phase: 'complete' });
                await showAlert(error?.message || 'Could not process Library JSON files.');
            }
        });
        input.click();
    }

    function triggerFullProjectDownload() {
        if (!libraryData.length) return;
        const payload = libraryData.map((item) => ({ _libraryName: item.name, ...normalizeLibraryDocumentPayload(item.payload) }));
        const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'modular_studio_library.json';
        link.click();
        URL.revokeObjectURL(url);
    }

    async function exportZip() {
        if (!libraryData.length) {
            await showAlert('Library is empty.');
            return;
        }
        if (typeof window.JSZip === 'undefined') {
            await showAlert('ZIP export is unavailable because JSZip did not load.');
            return;
        }
        const zip = new window.JSZip();
        libraryData.forEach((item) => {
            const payload = normalizeLibraryDocumentPayload(item.payload);
            let filename = item.name || 'untitled';
            if (!filename.endsWith('.json')) filename += '.mns.json';
            zip.file(filename, JSON.stringify(payload, null, 2));
        });
        const content = await zip.generateAsync({ type: 'blob' });
        const url = URL.createObjectURL(content);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'modular_studio_exports.zip';
        link.click();
        URL.revokeObjectURL(url);
    }

    async function clearAll() {
        if (!libraryData.length) {
            await showAlert('Library is already empty.');
            return;
        }
        const saveFirst = await showModal('Save the full library before clearing?', [
            { label: 'No', value: false },
            { label: 'Save', value: true, className: 'is-active' }
        ]);
        if (saveFirst) triggerFullProjectDownload();
        const proceed = await showModal('Clear the entire Library? This cannot be undone.', [
            { label: 'Cancel', value: false },
            { label: 'Clear All', value: true }
        ]);
        if (!proceed) return;
        await actions.clearLibraryProjects();
        closeDetail();
        setFullscreenEnabled(false);
        await refresh();
    }

    root.addEventListener('click', async (event) => {
        const actionNode = event.target.closest('[data-library-action]');
        if (actionNode) {
            const action = actionNode.dataset.libraryAction;
            if (action === 'upload') {
                triggerUpload();
            } else if (action === 'toggle-hover') {
                setHoverEnabled(!isHoverEnabled);
            } else if (action === 'toggle-fullscreen') {
                setFullscreenEnabled(!isFullscreen);
            } else if (action === 'download-all') {
                if (!libraryData.length) showAlert('Library is empty.');
                else triggerFullProjectDownload();
            } else if (action === 'export-zip') {
                exportZip();
            } else if (action === 'clear-all') {
                clearAll();
            } else if (action === 'delete-project') {
                event.stopPropagation();
                const projectId = actionNode.dataset.libraryId;
                const proceed = await showModal('Remove this project from the Library?', [
                    { label: 'Cancel', value: false },
                    { label: 'Delete', value: true }
                ]);
                if (proceed) {
                    await actions.deleteLibraryProject(projectId);
                    await refresh();
                }
            } else if (action === 'close-detail') {
                closeDetail();
            } else if (action === 'load-detail') {
                if (!detailData) return;
                const didLoad = await actions.loadLibraryProject(detailData.payload, detailData.id, detailData.name);
                if (didLoad) closeDetail();
            }
            return;
        }

        const gridItem = event.target.closest('[data-library-index]');
        if (gridItem && refs.gridView.contains(gridItem)) {
            openDetailByData(libraryData[parseInt(gridItem.dataset.libraryIndex, 10)]);
            return;
        }

        if (isFullscreen && refs.fullscreenView.contains(event.target) && libraryData.length) {
            currentIndex = (currentIndex + 1) % libraryData.length;
            updateFullscreen();
        } else if (event.target === refs.detailOverlay) {
            closeDetail();
        }
    });

    setHoverEnabled(false);
    setFullscreenEnabled(false);

    return {
        activate() {
            root.style.display = 'block';
            refresh();
        },
        deactivate() {
            root.style.display = 'none';
        },
        refresh
    };
}
