/**
 * Modular Studio Library Template Module
 * Generates the full HTML/CSS/JS string for the Library tab.
 * @param {Object} LAYER_DEFAULTS - Mapping of { layerId: { defaultParams } }
 * @returns {string} The full HTML document
 */
export function getLibraryHTML(LAYER_DEFAULTS) {
    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Modular Studio Library</title>
            <style>
                :root {
                    --bg: #101010;
                    --bg-soft: #181818;
                    --bg-muted: #1f1f1f;
                    --line: #f4f4f4;
                    --line-soft: #3a3a3a;
                    --text: #f4f4f4;
                    --muted: #999;
                    --font: 'Segoe UI', 'Aptos', sans-serif;
                    --mono: 'Consolas', 'SFMono-Regular', monospace;
                }
                * { box-sizing: border-box; margin: 0; }
                body { background: var(--bg); overflow: hidden; display: flex; flex-direction: column; height: 100vh; font: 13px/1.4 var(--font); color: var(--text); }

                /* Toolbar */
                .header { display: flex; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--line); flex-shrink: 0; gap: 10px; flex-wrap: wrap; background: var(--bg); }
                .header-title { font-weight: 600; font-size: 13px; margin-right: auto; text-transform: uppercase; letter-spacing: 0.08em; font-family: var(--mono); }
                .toolbar-btn { background: var(--bg); border: 1px solid var(--line); color: var(--text); padding: 5px 8px; min-height: 28px; cursor: pointer; font: 13px/1 var(--font); white-space: nowrap; }
                .toolbar-btn:hover { background: var(--bg-muted); }
                .toolbar-btn.active { background: var(--line); color: var(--bg); }
                .toolbar-btn.danger { color: var(--text); }

                /* Content */
                .content { flex: 1; overflow-y: auto; overflow-x: hidden; position: relative; }
                .grid-view { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 1px; background: var(--line-soft); }
                .grid-view.hidden { display: none; }
                .grid-item { position: relative; background: var(--bg); overflow: hidden; display: flex; align-items: center; justify-content: center; height: 48vh; cursor: pointer; }
                .grid-item:hover { outline: 1px solid var(--line); outline-offset: -1px; z-index: 2; }

                /* Fullscreen Series */
                .fullscreen-view { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: var(--bg); align-items: center; justify-content: center; cursor: pointer; user-select: none; }
                .fullscreen-view.active { display: flex; }

                /* Images */
                .image-container { width: 100%; height: 100%; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
                .img-base, .img-hover { position: absolute; width: 100%; height: 100%; object-fit: contain; pointer-events: none; transition: opacity 0.3s ease; }
                .img-hover { opacity: 0; z-index: 5; }
                .img-base { opacity: 1; z-index: 1; }
                body.hover-enabled .image-container:hover .img-hover { opacity: 1; }
                body.hover-enabled .image-container:hover .img-base { opacity: 0; }

                /* Labels */
                .label { position: absolute; top: 8px; left: 8px; background: var(--bg); border: 1px solid var(--line-soft); font: 11px/1 var(--mono); padding: 4px 6px; pointer-events: none; z-index: 10; text-transform: uppercase; letter-spacing: 0.06em; }
                .delete-btn { position: absolute; bottom: 8px; right: 8px; z-index: 20; background: var(--bg); border: 1px solid var(--line-soft); color: var(--text); width: 24px; height: 24px; cursor: pointer; font-size: 16px; line-height: 1; display: flex; align-items: center; justify-content: center; opacity: 0; transition: opacity 0.15s ease; padding: 0; }
                .grid-item:hover .delete-btn { opacity: 1; }
                .delete-btn:hover { border-color: var(--line); background: var(--bg-muted); }
                .hover-hint { position: absolute; top: 8px; right: 8px; border: 1px solid var(--line-soft); background: var(--bg); font: 10px/1 var(--mono); padding: 3px 6px; pointer-events: none; z-index: 10; opacity: 0; transition: opacity 0.2s ease; text-transform: uppercase; letter-spacing: 0.06em; }
                body.hover-enabled .grid-item:hover .hover-hint, body.hover-enabled .fullscreen-view:hover .hover-hint { opacity: 1; }
                .fullscreen-label { position: absolute; top: 10px; left: 10px; background: var(--bg); border: 1px solid var(--line-soft); font: 13px/1 var(--mono); padding: 6px 8px; pointer-events: none; z-index: 10; }

                /* Loading Overlay */
                .loading-overlay { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(16,16,16,0.95); z-index: 100; flex-direction: column; align-items: center; justify-content: center; }
                .loading-overlay.active { display: flex; }
                .progress-bar { width: 320px; height: 4px; background: var(--bg); border: 1px solid var(--line); margin-top: 20px; overflow: hidden; }
                .progress-fill { height: 100%; background: var(--text); width: 0%; transition: width 0.2s ease; }
                .loading-overlay h2 { font: 500 16px/1 var(--font); color: var(--text); }
                .loading-overlay p { margin-top: 6px; font-size: 11px; color: var(--muted); }

                /* Small Modal */
                .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.7); z-index: 200; align-items: center; justify-content: center; }
                .modal-overlay.active { display: flex; }
                .modal-box { background: var(--bg); border: 1px solid var(--line); padding: 20px; max-width: 380px; width: 90%; }
                .modal-text { font-size: 13px; line-height: 1.6; color: var(--text); margin: 0 0 16px; }
                .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
                .modal-btn { padding: 5px 12px; min-height: 28px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: 13px/1 var(--font); cursor: pointer; }
                .modal-btn:hover { background: var(--bg-muted); }
                .modal-btn.primary { background: var(--line); color: var(--bg); }
                .modal-btn.primary:hover { opacity: 0.85; }
                .modal-btn.danger { background: var(--bg); color: var(--text); }
                .modal-btn.danger:hover { background: var(--bg-muted); }

                /* Project Detail Modal */
                .detail-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.85); z-index: 150; }
                .detail-overlay.active { display: flex; }
                .detail-shell { display: grid; grid-template-columns: 1fr 360px; width: calc(100% - 40px); height: calc(100% - 40px); margin: 20px; border: 1px solid var(--line); background: var(--bg); overflow: hidden; }
                .detail-image-pane { position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #000; }
                .detail-image-pane .image-container { width: 100%; height: 100%; }
                .detail-sidebar { display: flex; flex-direction: column; border-left: 1px solid var(--line); overflow: hidden; }
                .detail-sidebar-header { display: flex; align-items: flex-start; justify-content: space-between; padding: 10px; border-bottom: 1px solid var(--line); gap: 8px; }
                .detail-sidebar-header h3 { font: 600 13px/1.3 var(--font); margin: 0; word-break: break-all; }
                .detail-sidebar-header .eyebrow { font: 11px/1 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-top: 4px; }
                .detail-sidebar-scroll { flex: 1; overflow-y: auto; padding: 10px; }
                .detail-sidebar-footer { display: flex; gap: 8px; padding: 10px; border-top: 1px solid var(--line); }
                .detail-sidebar-footer .toolbar-btn { flex: 1; text-align: center; }

                /* Layer Cards */
                .layer-card { border: 1px solid var(--line-soft); margin-bottom: 8px; }
                .layer-card-header { display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; border-bottom: 1px solid var(--line-soft); background: var(--bg-soft); }
                .layer-card-header strong { font: 600 11px/1 var(--mono); text-transform: uppercase; }
                .layer-card-header span { font: 11px/1 var(--mono); color: var(--muted); }
                .layer-card-body { padding: 6px 8px; }
                .param-row { display: flex; justify-content: space-between; align-items: baseline; padding: 2px 0; gap: 8px; }
                .param-key { font: 11px/1.4 var(--mono); color: var(--muted); }
                .param-val { font: 11px/1.4 var(--mono); color: var(--text); text-align: right; word-break: break-all; max-width: 180px; }
                .source-info { border: 1px solid var(--line-soft); padding: 8px; margin-bottom: 8px; }
                .source-info .eyebrow { font: 11px/1 var(--mono); color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 6px; }
                .detail-empty { color: var(--muted); font-size: 11px; padding: 8px 0; }
            </style>
            <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"><\/script>
        </head>
        <body>
            <div class="header">
                <div class="header-title">Library</div>
                <button class="toolbar-btn" id="btnUpload">Upload JSON</button>
                <button class="toolbar-btn" id="btnHover">Hover Original</button>
                <button class="toolbar-btn" id="btnFullscreen">Interactive Series</button>
                <button class="toolbar-btn" id="btnDownloadSave" style="margin-left: auto;">Save Full Project</button>
                <button class="toolbar-btn" id="btnExportZip">Export All JSONs</button>
                <button class="toolbar-btn danger" id="btnClearAll">Clear All</button>
            </div>
            <div class="content">
                <div class="grid-view" id="gridView"></div>
                <div class="fullscreen-view" id="fullscreenView">
                    <div class="fullscreen-label" id="fsLabel"></div>
                    <div class="hover-hint">Hovering Original</div>
                    <div class="image-container">
                        <img src="" class="img-base" id="fsBase" />
                        <img src="" class="img-hover" id="fsHover" />
                    </div>
                </div>
                <div class="loading-overlay" id="loadingOverlay">
                    <h2 id="statusText">Preparing engine...</h2>
                    <p id="countText">0 variants completed</p>
                    <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
                </div>
            </div>

            <div class="modal-overlay" id="modalOverlay">
                <div class="modal-box">
                    <div class="modal-text" id="modalText"></div>
                    <div class="modal-actions" id="modalActions"></div>
                </div>
            </div>

            <div class="detail-overlay" id="detailOverlay">
                <div class="detail-shell">
                    <div class="detail-image-pane">
                        <div class="hover-hint">Hovering Original</div>
                        <div class="image-container">
                            <img src="" class="img-base" id="detailBase" />
                            <img src="" class="img-hover" id="detailHover" />
                        </div>
                    </div>
                    <div class="detail-sidebar">
                        <div class="detail-sidebar-header">
                            <div>
                                <h3 id="detailName"></h3>
                                <div class="eyebrow" id="detailMeta"></div>
                            </div>
                        </div>
                        <div class="detail-sidebar-scroll" id="detailLayers"></div>
                        <div class="detail-sidebar-footer">
                            <button class="toolbar-btn primary" id="detailLoad">Load in Editor</button>
                            <button class="toolbar-btn" id="detailClose">Close</button>
                        </div>
                    </div>
                </div>
            </div>

            <script>
                const DB_NAME = 'ModularStudioDB';
                const STORE_NAME = 'LibraryProjects';
                const LAYER_DEFAULTS = ${JSON.stringify(LAYER_DEFAULTS)};
                const libraryChannel = new BroadcastChannel('ModularStudioLibraryChannel');

                function showModal(message, buttons) {
                    return new Promise((resolve) => {
                        const overlay = document.getElementById('modalOverlay');
                        const textEl = document.getElementById('modalText');
                        const actionsEl = document.getElementById('modalActions');
                        textEl.textContent = message;
                        actionsEl.innerHTML = '';
                        buttons.forEach((btn) => {
                            const el = document.createElement('button');
                            el.className = 'modal-btn' + (btn.class ? ' ' + btn.class : '');
                            el.textContent = btn.label;
                            el.addEventListener('click', () => { overlay.classList.remove('active'); resolve(btn.value); });
                            actionsEl.appendChild(el);
                        });
                        overlay.classList.add('active');
                    });
                }
                function showAlert(msg) { return showModal(msg, [{ label: 'OK', value: true, class: 'primary' }]); }
                function showConfirm(msg) { return showModal(msg, [{ label: 'Cancel', value: false }, { label: 'Confirm', value: true, class: 'primary' }]); }

                function getAllFromLibraryDB() {
                    return new Promise((resolve) => {
                        const request = indexedDB.open(DB_NAME, 1);
                        request.onsuccess = (e) => { const db = e.target.result; if (!db.objectStoreNames.contains(STORE_NAME)) return resolve([]); const tx = db.transaction(STORE_NAME, 'readonly'); const req = tx.objectStore(STORE_NAME).getAll(); req.onsuccess = () => resolve(req.result); };
                        request.onerror = () => resolve([]);
                    });
                }
                function deleteFromLibraryDB(id) {
                    return new Promise((resolve) => {
                        const request = indexedDB.open(DB_NAME, 1);
                        request.onsuccess = (e) => { const db = e.target.result; const tx = db.transaction(STORE_NAME, 'readwrite'); tx.objectStore(STORE_NAME).delete(id); tx.oncomplete = () => resolve(); };
                        request.onerror = () => resolve();
                    });
                }
                function clearAllFromLibraryDB() {
                    return new Promise((resolve) => {
                        const request = indexedDB.open(DB_NAME, 1);
                        request.onsuccess = (e) => { const db = e.target.result; const tx = db.transaction(STORE_NAME, 'readwrite'); tx.objectStore(STORE_NAME).clear(); tx.oncomplete = () => resolve(); };
                        request.onerror = () => resolve();
                    });
                }

                function formatParamValue(v) {
                    if (v === null || v === undefined) return '\u2014';
                    if (typeof v === 'boolean') return v ? 'ON' : 'OFF';
                    if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
                    if (typeof v === 'string') { if (v.length > 60) return v.slice(0, 57) + '...'; return v; }
                    if (Array.isArray(v)) return '[' + v.length + ' items]';
                    if (typeof v === 'object') return '{' + Object.keys(v).length + ' keys}';
                    return String(v);
                }
                function valuesMatch(v1, v2) {
                    if (v1 === v2) return true;
                    if (typeof v1 !== typeof v2) return false;
                    if (typeof v1 === 'object' && v1 !== null && v2 !== null) {
                        try { return JSON.stringify(v1) === JSON.stringify(v2); } catch (e) { return false; }
                    }
                    return false;
                }

                const SKIP_PARAMS = new Set(['_libraryName']);
                function renderLayerCards(payload) {
                    let html = '';
                    if (payload.source) {
                        html += '<div class="source-info"><div class="eyebrow">Source Image</div>';
                        html += '<div class="param-row"><span class="param-key">name</span><span class="param-val">' + (payload.source.name || '\u2014') + '</span></div>';
                        if (payload.source.width) html += '<div class="param-row"><span class="param-key">size</span><span class="param-val">' + payload.source.width + ' \u00d7 ' + payload.source.height + '</span></div>';
                        html += '</div>';
                    }
                    const stack = payload.layerStack || [];
                    if (!stack.length) { html += '<div class="detail-empty">No layers</div>'; return html; }
                    stack.forEach((layer, i) => {
                        const defaults = LAYER_DEFAULTS[layer.layerId] || {};
                        html += '<div class="layer-card">';
                        html += '<div class="layer-card-header"><strong>' + (layer.layerId || 'unknown') + '</strong><span>#' + (i + 1) + (layer.enabled === false ? ' \u00b7 OFF' : '') + '</span></div>';
                        html += '<div class="layer-card-body">';
                        const params = layer.params || {};
                        const keys = Object.keys(params).filter(k => {
                            if (SKIP_PARAMS.has(k) || k.startsWith('_')) return false;
                            const v = params[k];
                            if (typeof v === 'string' && v.startsWith('data:')) return false;
                            // Filter out values that match defaults
                            if (k in defaults && valuesMatch(v, defaults[k])) return false;
                            return true;
                        });
                        
                        if (!keys.length) { 
                            html += '<div class="detail-empty">Default settings</div>'; 
                        } else {
                            keys.forEach(k => {
                                html += '<div class="param-row"><span class="param-key">' + k + '</span><span class="param-val">' + formatParamValue(params[k]) + '</span></div>';
                            });
                        }
                        html += '</div></div>';
                    });
                    return html;
                }

                let libraryData = [];
                let isHoverEnabled = false;
                let isFullscreen = false;
                let currentIndex = 0;
                let detailData = null;

                const gridView = document.getElementById('gridView');
                const fullscreenView = document.getElementById('fullscreenView');
                const fsLabel = document.getElementById('fsLabel');
                const fsBase = document.getElementById('fsBase');
                const fsHover = document.getElementById('fsHover');
                const loadingOverlay = document.getElementById('loadingOverlay');
                const detailOverlay = document.getElementById('detailOverlay');
                const btnHover = document.getElementById('btnHover');
                const btnFullscreen = document.getElementById('btnFullscreen');
                const btnUpload = document.getElementById('btnUpload');
                const btnDownloadSave = document.getElementById('btnDownloadSave');
                const btnExportZip = document.getElementById('btnExportZip');
                const btnClearAll = document.getElementById('btnClearAll');

                async function refreshLibrary() {
                    const projects = await getAllFromLibraryDB();
                    projects.sort((a,b) => a.timestamp - b.timestamp);
                    libraryData.forEach(d => URL.revokeObjectURL(d.url));
                    libraryData = projects.map(p => ({
                        ...p,
                        url: URL.createObjectURL(p.blob),
                        hoverSrc: p.payload.source?.imageData || ''
                    }));
                    gridView.innerHTML = '';
                    libraryData.forEach((res, index) => {
                        const itemHtml = \`
                            <div class="grid-item" data-index="\${index}">
                                <div class="label">\${res.name}</div>
                                <button class="delete-btn" data-delete-id="\${res.id}" title="Delete">&times;</button>
                                <div class="hover-hint">Hovering Original</div>
                                <div class="image-container">
                                    <img src="\${res.url}" class="img-base" />
                                    <img src="\${res.hoverSrc}" class="img-hover" />
                                </div>
                            </div>
                        \`;
                        gridView.insertAdjacentHTML('beforeend', itemHtml);
                    });
                    if (isFullscreen) updateFullscreen();
                }
                refreshLibrary();

                function openDetail(index) {
                    const data = libraryData[index];
                    if (!data) return;
                    detailData = data;
                    document.getElementById('detailBase').src = data.url;
                    document.getElementById('detailHover').src = data.hoverSrc;
                    document.getElementById('detailName').textContent = data.name;
                    const stack = data.payload.layerStack || [];
                    const activeCount = stack.filter(l => l.enabled !== false).length;
                    document.getElementById('detailMeta').textContent = stack.length + ' layers \u00b7 ' + activeCount + ' active';
                    document.getElementById('detailLayers').innerHTML = renderLayerCards(data.payload);
                    detailOverlay.classList.add('active');
                }
                function closeDetail() { detailOverlay.classList.remove('active'); detailData = null; }
                document.getElementById('detailClose').addEventListener('click', closeDetail);
                document.getElementById('detailLoad').addEventListener('click', () => {
                    if (!detailData) return;
                    libraryChannel.postMessage({ type: 'LOAD_PROJECT', payload: detailData.payload, libraryId: detailData.id, libraryName: detailData.name });
                    closeDetail();
                });
                detailOverlay.addEventListener('click', (e) => { if (e.target === detailOverlay) closeDetail(); });

                btnUpload.addEventListener('click', () => {
                    const input = document.createElement('input');
                    input.type = 'file'; input.multiple = true; input.accept = '.mns.json,.json';
                    input.onchange = async (e) => {
                        const files = Array.from(e.target.files);
                        if (!files.length) return;
                        const payloads = await Promise.all(files.map(f => f.text()));
                        let unrolledPayloads = [], unrolledNames = [];
                        payloads.forEach((text, i) => {
                            try {
                                const parsed = JSON.parse(text);
                                if (Array.isArray(parsed)) {
                                    parsed.forEach((item, subIdx) => {
                                        const savedName = item._libraryName || (files[i].name.replace('.json', '') + '-' + subIdx + '.json');
                                        unrolledPayloads.push(JSON.stringify(item));
                                        unrolledNames.push(savedName);
                                    });
                                } else { unrolledPayloads.push(text); unrolledNames.push(files[i].name); }
                            } catch (err) { }
                        });
                        libraryChannel.postMessage({ type: 'RENDER_LIBRARY_FILES', payloads: unrolledPayloads, filenames: unrolledNames });
                    };
                    input.click();
                });

                function triggerFullProjectDownload() {
                    if (!libraryData.length) return;
                    const projectPayload = libraryData.map(d => ({ _libraryName: d.name, ...d.payload }));
                    const blob = new Blob([JSON.stringify(projectPayload, null, 2)], { type: 'application/json' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a'); a.href = url; a.download = 'modular_studio_library.json'; a.click();
                    URL.revokeObjectURL(url);
                }
                btnDownloadSave.addEventListener('click', () => { if (!libraryData.length) return showAlert('Library is empty.'); triggerFullProjectDownload(); });

                btnExportZip.addEventListener('click', async () => {
                    if (!libraryData.length) return showAlert('Library is empty.');
                    if (typeof JSZip === 'undefined') return showAlert('ZIP library failed to load.');
                    const zip = new JSZip();
                    libraryData.forEach((d) => {
                        const payload = { version: 2, kind: 'document', ...d.payload };
                        let filename = d.name || 'untitled';
                        if (!filename.endsWith('.json')) filename += '.mns.json';
                        zip.file(filename, JSON.stringify(payload, null, 2));
                    });
                    const content = await zip.generateAsync({ type: 'blob' });
                    const url = URL.createObjectURL(content);
                    const a = document.createElement('a'); a.href = url; a.download = 'modular_studio_exports.zip'; a.click();
                    URL.revokeObjectURL(url);
                });

                btnClearAll.addEventListener('click', async () => {
                    if (!libraryData.length) return showAlert('Library is already empty.');
                    const save = await showModal('Save the full library before clearing?', [
                        { label: 'No', value: false },
                        { label: 'Save', value: true, class: 'primary' }
                    ]);
                    if (save) triggerFullProjectDownload();
                    const proceed = await showModal('Clear the entire Library? This cannot be undone.', [
                        { label: 'Cancel', value: false },
                        { label: 'Clear All', value: true, class: 'danger' }
                    ]);
                    if (!proceed) return;
                    await clearAllFromLibraryDB();
                    await refreshLibrary();
                });

                btnHover.addEventListener('click', () => {
                    isHoverEnabled = !isHoverEnabled;
                    btnHover.classList.toggle('active', isHoverEnabled);
                    document.body.classList.toggle('hover-enabled', isHoverEnabled);
                });
                btnFullscreen.addEventListener('click', () => {
                    isFullscreen = !isFullscreen;
                    btnFullscreen.classList.toggle('active', isFullscreen);
                    if (isFullscreen) { gridView.classList.add('hidden'); fullscreenView.classList.add('active'); btnFullscreen.textContent = 'Show Grid'; updateFullscreen(); }
                    else { gridView.classList.remove('hidden'); fullscreenView.classList.remove('active'); btnFullscreen.textContent = 'Interactive Series'; }
                });
                fullscreenView.addEventListener('click', () => { if (!libraryData.length) return; currentIndex = (currentIndex + 1) % libraryData.length; updateFullscreen(); });

                gridView.addEventListener('click', async (e) => {
                    const deleteBtn = e.target.closest('.delete-btn');
                    if (deleteBtn) {
                        e.stopPropagation();
                        const id = deleteBtn.dataset.deleteId;
                        const proceed = await showModal('Remove this project from the Library?', [
                            { label: 'Cancel', value: false },
                            { label: 'Delete', value: true, class: 'danger' }
                        ]);
                        if (proceed) { await deleteFromLibraryDB(id); await refreshLibrary(); }
                        return;
                    }
                    const item = e.target.closest('.grid-item');
                    if (!item) return;
                    openDetail(parseInt(item.dataset.index, 10));
                });

                function updateFullscreen() {
                    if (!libraryData.length) return;
                    if (currentIndex >= libraryData.length) currentIndex = 0;
                    const current = libraryData[currentIndex];
                    fsLabel.textContent = current.name + ' (' + (currentIndex + 1) + ' / ' + libraryData.length + ')';
                    fsBase.src = current.url;
                    fsHover.src = current.hoverSrc || '';
                }

                window.addEventListener('message', (e) => {
                    if (!e.data || !e.data.type) return;
                    if (e.data.type === 'START_RENDER') {
                        loadingOverlay.classList.add('active');
                        document.getElementById('statusText').textContent = 'Preparing engine...';
                        document.getElementById('countText').textContent = '0 / ' + e.data.total + ' variants';
                        document.getElementById('progressFill').style.width = '0%';
                    }
                    else if (e.data.type === 'UPDATE_PROGRESS') {
                        document.getElementById('statusText').textContent = 'Rendering ' + e.data.filename + '...';
                        document.getElementById('countText').textContent = e.data.count + ' / ' + e.data.total + ' variants';
                        document.getElementById('progressFill').style.width = ((e.data.count / e.data.total) * 100) + '%';
                    }
                    else if (e.data.type === 'LIBRARY_DB_UPDATED') {
                        loadingOverlay.classList.remove('active');
                        refreshLibrary();
                    }
                });
            </script>
        </body>
        </html>
    `;
}
