/**
 * Modular Studio Library Logic
 * Handled as a standalone script for library.html
 */

const DB_NAME = 'ModularStudioDB';
const STORE_NAME = 'LibraryProjects';
const libraryChannel = new BroadcastChannel('ModularStudioLibraryChannel');

// State
let LAYER_DEFAULTS = {};
let libraryData = [];
let isHoverEnabled = false;
let isFullscreen = false;
let currentIndex = 0;
let detailData = null;

// DOM Elements
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

/* --- Modals --- */
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

/* --- DB Helpers --- */
function getAllFromLibraryDB() {
    return new Promise((resolve) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onsuccess = (e) => { 
            const db = e.target.result; 
            if (!db.objectStoreNames.contains(STORE_NAME)) return resolve([]); 
            const tx = db.transaction(STORE_NAME, 'readonly'); 
            const req = tx.objectStore(STORE_NAME).getAll(); 
            req.onsuccess = () => resolve(req.result); 
        };
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

/* --- Rendering --- */
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
        const itemHtml = `
            <div class="grid-item" data-index="${index}">
                <div class="label">${res.name}</div>
                <button class="delete-btn" data-delete-id="${res.id}" title="Delete">&times;</button>
                <div class="hover-hint">Hovering Original</div>
                <div class="image-container">
                    <img src="${res.url}" class="img-base" />
                    <img src="${res.hoverSrc}" class="img-hover" />
                </div>
            </div>
        `;
        gridView.insertAdjacentHTML('beforeend', itemHtml);
    });
    if (isFullscreen) updateFullscreen();
}

function updateFullscreen() {
    if (!libraryData.length) return;
    if (currentIndex >= libraryData.length) currentIndex = 0;
    const current = libraryData[currentIndex];
    fsLabel.textContent = current.name + ' (' + (currentIndex + 1) + ' / ' + libraryData.length + ')';
    fsBase.src = current.url;
    fsHover.src = current.hoverSrc || '';
}

/* --- Events --- */
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
        sendToMain({ type: 'RENDER_LIBRARY_FILES', payloads: unrolledPayloads, filenames: unrolledNames });
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

document.getElementById('detailClose').addEventListener('click', closeDetail);
document.getElementById('detailLoad').addEventListener('click', () => {
    if (!detailData) return;
    sendToMain({ type: 'LOAD_PROJECT', payload: detailData.payload, libraryId: detailData.id, libraryName: detailData.name });
    closeDetail();
});
detailOverlay.addEventListener('click', (e) => { if (e.target === detailOverlay) closeDetail(); });

/* --- Handshake & Communication --- */
function sendToMain(msg) {
    const enriched = { ...msg, _mid: Date.now() + '-' + Math.random().toString(36).substring(2, 7) };
    libraryChannel.postMessage(enriched);
    if (window.opener && window.opener !== window) {
        window.opener.postMessage(enriched, '*');
    }
}

const processedMids = new Set();
function handleMainMessage(data) {
    if (!data || !data.type) return;
    
    if (data._mid) {
        if (processedMids.has(data._mid)) return;
        processedMids.add(data._mid);
        setTimeout(() => processedMids.delete(data._mid), 10000);
    }
    
    if (data.type === 'START_RENDER') {
        loadingOverlay.classList.add('active');
        document.getElementById('statusText').textContent = 'Preparing engine...';
        document.getElementById('countText').textContent = '0 / ' + data.total + ' variants';
        document.getElementById('progressFill').style.width = '0%';
    }
    else if (data.type === 'UPDATE_PROGRESS') {
        document.getElementById('statusText').textContent = 'Rendering ' + data.filename + '...';
        document.getElementById('countText').textContent = data.count + ' / ' + data.total + ' variants';
        document.getElementById('progressFill').style.width = ((data.count / data.total) * 100) + '%';
    }
    else if (data.type === 'LIBRARY_DB_UPDATED') {
        loadingOverlay.classList.remove('active');
        refreshLibrary();
    }
    else if (data.type === 'RES_LAYER_DEFAULTS') {
        LAYER_DEFAULTS = data.data;
        refreshLibrary();
    }
}

libraryChannel.onmessage = (e) => handleMainMessage(e.data);
window.addEventListener('message', (e) => handleMainMessage(e.data));

// Start handshake and initial load
refreshLibrary();
sendToMain({ type: 'REQ_LAYER_DEFAULTS' });
