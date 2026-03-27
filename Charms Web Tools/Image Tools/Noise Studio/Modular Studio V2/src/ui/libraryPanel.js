const SKIP_PARAMS = new Set(['_libraryName', '_libraryTags', '_libraryProjectType', '_libraryHoverSource', '_librarySourceArea', '_librarySourceCount']);
const LIBRARY_EXPORT_TYPE = 'noise-studio-library';
const LIBRARY_EXPORT_FORMAT = 'library-json/v1';
const LIBRARY_SECURE_EXPORT_FORMAT = 'library-secure-json/v1';
const LIBRARY_SECURE_KDF_ITERATIONS = 250000;
const textEncoder = new TextEncoder();

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripJsonExtension(name) {
    return String(name || '').replace(/\.json$/i, '');
}

function toJsonFilename(name) {
    const safe = String(name || 'library-project')
        .trim()
        .replace(/[<>:"/\\|?*]+/g, '-')
        .replace(/\s+/g, ' ');
    return `${safe || 'library-project'}.json`;
}

function buildDefaultLibraryFilename(name = 'noise-studio-library') {
    const stamp = new Date().toISOString().slice(0, 10);
    return toJsonFilename(`${stripJsonExtension(name)} ${stamp}`);
}

function clamp01(value) {
    return Math.min(1, Math.max(0, Number(value) || 0));
}

function formatDateTime(value) {
    if (!value) return 'Unknown';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Unknown';
    return date.toLocaleString();
}

function getProjectTypeLabel(projectType) {
    return projectType === 'stitch' ? 'Stitch' : 'Editor';
}

function formatParamValue(value) {
    if (Array.isArray(value)) return value.map((entry) => formatParamValue(entry)).join(', ');
    if (value && typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/\.?0+$/, '');
    }
    if (typeof value === 'boolean') return value ? 'Enabled' : 'Disabled';
    if (value == null || value === '') return 'None';
    return String(value);
}

function valuesMatch(a, b) {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i += 1) {
            if (!valuesMatch(a[i], b[i])) return false;
        }
        return true;
    }
    if (a && b && typeof a === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        for (const key of keys) {
            if (!valuesMatch(a[key], b[key])) return false;
        }
        return true;
    }
    return false;
}

function normalizeLibraryDocumentPayload(payload) {
    const normalized = JSON.parse(JSON.stringify(payload || {}));
    delete normalized._libraryName;
    delete normalized._libraryTags;
    delete normalized._libraryProjectType;
    delete normalized._libraryHoverSource;
    delete normalized._librarySourceArea;
    delete normalized._librarySourceCount;
    normalized.version = normalized.version === 2 ? 'mns/v2' : (normalized.version || 'mns/v2');
    normalized.kind = normalized.kind || (normalized.mode === 'stitch' ? 'stitch-document' : 'document');
    normalized.mode = normalized.mode || (normalized.kind === 'stitch-document' ? 'stitch' : 'studio');
    if (Array.isArray(normalized.layerStack)) {
        normalized.layerStack = normalized.layerStack.map((layer) => ({
            ...layer,
            params: { ...(layer?.params || {}) }
        }));
    }
    return normalized;
}

function buildLibraryProjectExportPayload(project) {
    return {
        _libraryName: project.name,
        _libraryTags: normalizeTagList(project.tags),
        _libraryProjectType: project.projectType || (project.payload?.kind === 'stitch-document' || project.payload?.mode === 'stitch' ? 'stitch' : 'studio'),
        _libraryHoverSource: project.hoverSource || null,
        _librarySourceArea: Number(project.sourceAreaOverride || project.sourceArea || 0) || 0,
        _librarySourceCount: Number(project.sourceCount || 0) || 0,
        ...normalizeLibraryDocumentPayload(project.payload)
    };
}

function buildLibraryExportBundle(projects, tagCatalog, name = 'noise-studio-library') {
    const exportedAt = new Date().toISOString();
    const normalizedProjects = (projects || []).map((project) => ({
        id: project.id || null,
        name: String(project.name || 'Untitled Project'),
        savedAt: project.timestamp ? new Date(project.timestamp).toISOString() : exportedAt,
        tags: normalizeTagList(project.tags),
        sourceSize: {
            width: Number(project.sourceWidth || project.payload?.source?.width || 0),
            height: Number(project.sourceHeight || project.payload?.source?.height || 0)
        },
        renderSize: {
            width: Number(project.renderWidth || 0),
            height: Number(project.renderHeight || 0)
        },
        payload: buildLibraryProjectExportPayload(project)
    }));

    return {
        type: LIBRARY_EXPORT_TYPE,
        format: LIBRARY_EXPORT_FORMAT,
        version: 1,
        name: stripJsonExtension(name || 'noise-studio-library') || 'noise-studio-library',
        exportedAt,
        projectCount: normalizedProjects.length,
        tags: normalizeTagList(tagCatalog),
        projects: normalizedProjects
    };
}

function isPlainLibraryExportPayload(parsed) {
    return !!parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && parsed.type === LIBRARY_EXPORT_TYPE
        && parsed.format === LIBRARY_EXPORT_FORMAT;
}

function isSecureLibraryExportPayload(parsed) {
    return !!parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && parsed.type === LIBRARY_EXPORT_TYPE
        && parsed.format === LIBRARY_SECURE_EXPORT_FORMAT;
}

function createImportEntryFromPayload(rawPayload, fallbackName, index = 0, explicitTags = null) {
    const payload = normalizeLibraryDocumentPayload(rawPayload || {});
    const name = stripJsonExtension(
        rawPayload?._libraryName
        || rawPayload?.name
        || fallbackName
        || `Library Project ${index + 1}`
    ) || `Library Project ${index + 1}`;
    const tags = normalizeTagList(explicitTags || rawPayload?._libraryTags || rawPayload?.tags || []);
    const finalPayload = {
        _libraryName: name,
        _libraryTags: tags,
        _libraryProjectType: rawPayload?._libraryProjectType || (payload.kind === 'stitch-document' || payload.mode === 'stitch' ? 'stitch' : 'studio'),
        _libraryHoverSource: rawPayload?._libraryHoverSource || null,
        _librarySourceArea: Number(rawPayload?._librarySourceArea || 0) || 0,
        _librarySourceCount: Number(rawPayload?._librarySourceCount || 0) || 0,
        ...payload
    };
    return {
        name,
        tags,
        text: JSON.stringify(finalPayload)
    };
}

function extractLibraryImportBundle(parsed, fallbackName) {
    if (isPlainLibraryExportPayload(parsed)) {
        const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
        const entries = projects.map((project, index) => createImportEntryFromPayload(
            project?.payload || project,
            project?.name || `${fallbackName} ${index + 1}`,
            index,
            project?.tags || project?.payload?._libraryTags
        ));
        const importedTags = normalizeTagList([
            ...(parsed.tags || []),
            ...entries.flatMap((entry) => entry.tags)
        ]);
        return {
            kind: 'library-bundle',
            sourceFormat: LIBRARY_EXPORT_FORMAT,
            bundleName: stripJsonExtension(parsed.name || fallbackName) || 'noise-studio-library',
            exportedAt: parsed.exportedAt || null,
            entries,
            tags: importedTags
        };
    }

    if (Array.isArray(parsed)) {
        const entries = parsed.map((entry, index) => createImportEntryFromPayload(
            entry,
            `${fallbackName} ${index + 1}`,
            index
        ));
        return {
            kind: 'library-bundle',
            sourceFormat: 'legacy-array',
            bundleName: stripJsonExtension(fallbackName) || 'noise-studio-library',
            exportedAt: null,
            entries,
            tags: normalizeTagList(entries.flatMap((entry) => entry.tags))
        };
    }

    return {
        kind: 'single-project',
        sourceFormat: 'single-project',
        bundleName: stripJsonExtension(fallbackName) || 'library-project',
        exportedAt: null,
        entries: [createImportEntryFromPayload(parsed, fallbackName, 0)],
        tags: normalizeTagList(parsed?._libraryTags || parsed?.tags || [])
    };
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

function base64ToBytes(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

async function gzipText(text) {
    if (typeof CompressionStream !== 'function') {
        throw new Error('This browser does not support compressed Library exports yet.');
    }
    const stream = new Blob([text], { type: 'application/json' })
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

async function gunzipText(bytes) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('This browser does not support compressed Library imports yet.');
    }
    const stream = new Blob([bytes], { type: 'application/gzip' })
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
}

async function deriveLibraryKey(passphrase, salt, iterations = LIBRARY_SECURE_KDF_ITERATIONS) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        textEncoder.encode(String(passphrase || '')),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations,
            hash: 'SHA-256'
        },
        keyMaterial,
        {
            name: 'AES-GCM',
            length: 256
        },
        false,
        ['encrypt', 'decrypt']
    );
}

async function encryptLibraryBytes(bytes, passphrase, iterations = LIBRARY_SECURE_KDF_ITERATIONS) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveLibraryKey(passphrase, salt, iterations);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return {
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        data: bytesToBase64(new Uint8Array(encrypted))
    };
}

async function decryptLibraryBytes(copy, passphrase, iterations = LIBRARY_SECURE_KDF_ITERATIONS) {
    const salt = base64ToBytes(copy?.salt || '');
    const iv = base64ToBytes(copy?.iv || '');
    const data = base64ToBytes(copy?.data || '');
    const key = await deriveLibraryKey(passphrase, salt, iterations);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new Uint8Array(decrypted);
}

function downloadJsonFile(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = toJsonFilename(stripJsonExtension(filename));
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getTagKey(tag) {
    return String(tag || '').trim().toLowerCase();
}

function normalizeTagList(tags) {
    const rawTags = Array.isArray(tags)
        ? tags
        : String(tags || '')
            .split(',')
            .map((value) => value.trim());
    const seen = new Set();
    const result = [];
    for (const rawTag of rawTags) {
        const cleaned = String(rawTag || '').trim().replace(/\s+/g, ' ');
        const key = getTagKey(cleaned);
        if (!cleaned || seen.has(key)) continue;
        seen.add(key);
        result.push(cleaned);
    }
    return result;
}

function encodeTag(tag) {
    return encodeURIComponent(tag || '');
}

function decodeTag(tag) {
    return decodeURIComponent(tag || '');
}

function formatDimensions(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!w || !h) return 'Unknown';
    return `${w.toLocaleString()} x ${h.toLocaleString()}`;
}

function getImageArea(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    return w * h;
}

function formatArea(area) {
    const normalized = Number(area) || 0;
    if (!normalized) return 'Unknown';
    return `${normalized.toLocaleString()} px`;
}

function readImageDimensions(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth || image.width || 0, height: image.naturalHeight || image.height || 0 });
        image.onerror = () => reject(new Error('Could not read image dimensions.'));
        image.src = url;
    });
}

function formatCollapsedParamValue(value, depth = 0) {
    if (depth > 2) {
        if (Array.isArray(value)) return `[...] (${value.length})`;
        if (value && typeof value === 'object') return '{...}';
    }

    if (Array.isArray(value)) {
        const preview = value.slice(0, 3).map((entry) => formatCollapsedParamValue(entry, depth + 1));
        const suffix = value.length > 3 ? `, ... +${value.length - 3}` : '';
        return `[${preview.join(', ')}${suffix}]`;
    }

    if (value && typeof value === 'object') {
        const entries = Object.entries(value);
        const preview = entries.slice(0, 3).map(([key, entryValue]) => `${key}: ${formatCollapsedParamValue(entryValue, depth + 1)}`);
        const suffix = entries.length > 3 ? `, ... +${entries.length - 3}` : '';
        return `{ ${preview.join(', ')}${suffix} }`;
    }

    const text = formatParamValue(value);
    return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

function formatExpandedParamValue(value) {
    if (Array.isArray(value) || (value && typeof value === 'object')) {
        return JSON.stringify(value, null, 2);
    }
    return formatParamValue(value);
}

function getParamDisplay(value, expanded) {
    const compact = formatCollapsedParamValue(value);
    const full = formatExpandedParamValue(value);
    const isStructured = Array.isArray(value) || (value && typeof value === 'object');
    return {
        text: expanded ? full : compact,
        canExpand: full.length > 140 || (Array.isArray(value) && value.length > 3) || (isStructured && compact !== full && full.length > 60)
    };
}

function getProjectPreviewSignature(project, renderWidth, renderHeight) {
    return JSON.stringify([
        project?.timestamp || 0,
        project?.blob?.size || 0,
        project?.blob?.type || '',
        project?.projectType || '',
        project?.hoverSource?.imageData?.length || 0,
        renderWidth || 0,
        renderHeight || 0
    ]);
}

function getProjectRecordSignature(project, tags, sourceWidth, sourceHeight, renderWidth, renderHeight) {
    return JSON.stringify([
        project?.id || '',
        project?.timestamp || 0,
        project?.name || '',
        project?.projectType || '',
        tags,
        sourceWidth || 0,
        sourceHeight || 0,
        project?.sourceAreaOverride || 0,
        project?.sourceCount || 0,
        renderWidth || 0,
        renderHeight || 0,
        project?.blob?.size || 0,
        project?.blob?.type || ''
    ]);
}

function releaseUnusedUrls(previousEntries, nextEntries) {
    const retainedUrls = new Set(
        nextEntries
            .map((item) => item?.url)
            .filter((url) => url && String(url).startsWith('blob:'))
    );

    for (const item of previousEntries) {
        if (item?.url && String(item.url).startsWith('blob:') && !retainedUrls.has(item.url)) {
            URL.revokeObjectURL(item.url);
        }
    }
}

function renderTagPills(tags, mode = 'display') {
    const normalized = normalizeTagList(tags);
    if (!normalized.length) {
        return '<div class="library-tag-list"><span class="library-tag-empty">No tags yet</span></div>';
    }

    const pills = normalized.map((tag) => {
        if (mode === 'editable') {
            return `
                <button
                    type="button"
                    class="library-tag library-tag-button"
                    data-library-action="remove-tag"
                    data-library-tag="${encodeTag(tag)}"
                    aria-label="Remove tag ${escapeHtml(tag)}"
                >
                    <span>${escapeHtml(tag)}</span>
                    <span aria-hidden="true">&times;</span>
                </button>
            `;
        }

        return `<span class="library-tag">${escapeHtml(tag)}</span>`;
    }).join('');

    return `<div class="library-tag-list">${pills}</div>`;
}

function getSortDirectionLabels(sortKey) {
    if (sortKey === 'name') {
        return { desc: 'Z to A', asc: 'A to Z' };
    }
    if (sortKey === 'timestamp') {
        return { desc: 'Newest first', asc: 'Oldest first' };
    }
    return { desc: 'Largest first', asc: 'Smallest first' };
}

export function createLibraryPanel(root, { actions, layerDefaults = {} }) {
    root.innerHTML = `
        <div class="library-panel-shell">
            <div class="toolbar library-toolbar">
                <div class="library-toolbar-title">Library</div>
                <button type="button" class="toolbar-button" data-library-action="upload">Import JSON</button>
                <button type="button" class="toolbar-button" data-library-action="toggle-select-mode" aria-pressed="false">Select</button>
                <button type="button" class="toolbar-button" data-library-action="toggle-hover" aria-pressed="false">Compare Source</button>
                <button type="button" class="toolbar-button" data-library-action="toggle-fullscreen" aria-pressed="false">Focus View</button>
                <button type="button" class="toolbar-button" data-library-action="save-library">Save Library</button>
                <button type="button" class="toolbar-button" data-library-action="export-zip">Export ZIP</button>
                <button type="button" class="toolbar-button" data-library-action="clear-all">Clear Library</button>
            </div>
            <div class="library-content">
                <input type="file" accept=".json,application/json" multiple hidden data-library-role="upload-input">
                <div class="library-grid-view"></div>
                <div class="library-empty-state">
                    <strong data-library-role="empty-title">Library is empty</strong>
                    <span data-library-role="empty-text">Save projects from Editor or Stitch, or import JSON files to build your gallery.</span>
                </div>
                <div class="library-fullscreen-view">
                    <div class="library-fullscreen-label">Library Preview</div>
                    <div class="library-hover-hint">Hovering Original</div>
                    <img class="library-img-base" alt="">
                    <img class="library-img-hover" alt="">
                </div>
            </div>
            <button type="button" class="library-side-tab" data-library-action="toggle-side-panel" aria-expanded="false">
                <span>Library Tools</span>
            </button>
            <aside class="library-side-panel" aria-hidden="true">
                <div class="library-side-scroll">
                    <div class="library-side-header">
                        <strong>Library Tools</strong>
                        <button type="button" class="toolbar-button" data-library-action="close-side-panel">Close</button>
                    </div>
                    <div class="library-side-content"></div>
                </div>
            </aside>
            <div class="library-loading-overlay">
                <p class="library-status-text">Working...</p>
                <p class="library-count-text"></p>
                <div class="library-progress-bar">
                    <div class="library-progress-fill"></div>
                </div>
            </div>
            <div class="library-modal-overlay">
                <div class="library-modal-box">
                    <div class="library-modal-title"></div>
                    <div class="library-modal-text"></div>
                    <div class="library-modal-content"></div>
                    <div class="library-modal-error" aria-live="polite"></div>
                    <div class="library-modal-actions">
                        <button type="button" class="toolbar-button" data-library-action="cancel-modal">Cancel</button>
                        <button type="button" class="toolbar-button" data-library-action="confirm-modal">Confirm</button>
                    </div>
                </div>
            </div>
            <div class="library-detail-overlay">
                <div class="library-detail-shell">
                    <div class="library-detail-image-pane">
                        <div class="library-hover-hint">Hovering Original</div>
                        <img class="library-img-base" alt="">
                        <img class="library-img-hover" alt="">
                    </div>
                    <div class="library-detail-sidebar">
                        <div class="library-detail-sidebar-header">
                            <div class="library-detail-header-row">
                                <h3 data-library-role="detail-name">Project Preview</h3>
                                <button type="button" class="toolbar-button" data-library-action="close-detail">Close</button>
                            </div>
                            <div class="library-detail-meta" data-library-role="detail-meta"></div>
                        </div>
                        <div class="library-detail-sidebar-scroll">
                            <div data-library-role="detail-layers"></div>
                        </div>
                        <div class="library-detail-sidebar-footer">
                            <button type="button" class="toolbar-button" data-library-action="download-project">Download JSON</button>
                            <button type="button" class="toolbar-button" data-library-action="load-detail">Load Project</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const refs = {
        shell: root.querySelector('.library-panel-shell'),
        toolbar: root.querySelector('.library-toolbar'),
        content: root.querySelector('.library-content'),
        grid: root.querySelector('.library-grid-view'),
        empty: root.querySelector('.library-empty-state'),
        emptyTitle: root.querySelector('[data-library-role="empty-title"]'),
        emptyText: root.querySelector('[data-library-role="empty-text"]'),
        uploadInput: root.querySelector('[data-library-role="upload-input"]'),
        selectToggle: root.querySelector('[data-library-action="toggle-select-mode"]'),
        hoverToggle: root.querySelector('[data-library-action="toggle-hover"]'),
        fullscreenToggle: root.querySelector('[data-library-action="toggle-fullscreen"]'),
        fullscreenView: root.querySelector('.library-fullscreen-view'),
        fullscreenLabel: root.querySelector('.library-fullscreen-label'),
        fullscreenBase: root.querySelector('.library-fullscreen-view .library-img-base'),
        fullscreenHover: root.querySelector('.library-fullscreen-view .library-img-hover'),
        sideTab: root.querySelector('.library-side-tab'),
        sidePanel: root.querySelector('.library-side-panel'),
        sideContent: root.querySelector('.library-side-content'),
        loadingOverlay: root.querySelector('.library-loading-overlay'),
        statusText: root.querySelector('.library-status-text'),
        countText: root.querySelector('.library-count-text'),
        progressFill: root.querySelector('.library-progress-fill'),
        modalOverlay: root.querySelector('.library-modal-overlay'),
        modalBox: root.querySelector('.library-modal-box'),
        modalTitle: root.querySelector('.library-modal-title'),
        modalText: root.querySelector('.library-modal-text'),
        modalContent: root.querySelector('.library-modal-content'),
        modalError: root.querySelector('.library-modal-error'),
        modalCancel: root.querySelector('[data-library-action="cancel-modal"]'),
        modalConfirm: root.querySelector('[data-library-action="confirm-modal"]'),
        detailOverlay: root.querySelector('.library-detail-overlay'),
        detailName: root.querySelector('[data-library-role="detail-name"]'),
        detailMeta: root.querySelector('[data-library-role="detail-meta"]'),
        detailLayers: root.querySelector('[data-library-role="detail-layers"]'),
        detailBase: root.querySelector('.library-detail-image-pane .library-img-base'),
        detailHover: root.querySelector('.library-detail-image-pane .library-img-hover')
    };

    let libraryData = [];
    let visibleLibraryData = [];
    let libraryTags = [];
    let isHoverEnabled = false;
    let isFullscreen = false;
    let isSidePanelOpen = false;
    let isSelectMode = false;
    let currentIndex = 0;
    let detailData = null;
    let selectedProjectId = null;
    let selectedProjectIds = new Set();
    let pendingApplyTagKeys = new Set();
    let refreshToken = 0;
    let sortKey = 'timestamp';
    let sortDirection = 'desc';
    let activeTagMode = 'all';
    let activeTagFilters = new Set();
    let rememberedTagFilters = new Set();
    let modalState = null;
    let expandedParamIds = new Set();
    let hasRenderedLibrary = false;
    let suppressOutsideClick = false;

    function getSelectedProject() {
        return libraryData.find((item) => item.id === selectedProjectId) || null;
    }

    function getSelectedProjects() {
        return libraryData.filter((item) => selectedProjectIds.has(item.id));
    }

    function getSelectedProjectIds() {
        return [...selectedProjectIds];
    }

    function getTagSummaries() {
        const map = new Map(libraryTags.map((tag) => [getTagKey(tag), { key: getTagKey(tag), tag, count: 0 }]));
        for (const item of libraryData) {
            for (const tag of normalizeTagList(item.tags)) {
                const key = getTagKey(tag);
                if (!map.has(key)) {
                    map.set(key, { key, tag, count: 0 });
                }
                map.get(key).count += 1;
            }
        }
        return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
    }

    function getSelectionTagSummaries() {
        const map = new Map();
        for (const item of getSelectedProjects()) {
            for (const tag of normalizeTagList(item.tags)) {
                const key = getTagKey(tag);
                if (!map.has(key)) {
                    map.set(key, { key, tag, count: 0 });
                }
                map.get(key).count += 1;
            }
        }
        return [...map.values()].sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' }));
    }

    function updateSelectToggle() {
        const selectionCount = selectedProjectIds.size;
        refs.selectToggle.setAttribute('aria-pressed', isSelectMode ? 'true' : 'false');
        refs.selectToggle.textContent = selectionCount ? `Select (${selectionCount})` : 'Select';
        refs.shell.classList.toggle('is-select-mode', isSelectMode);
    }

    function setSelectModeEnabled(enabled) {
        isSelectMode = Boolean(enabled);
        updateSelectToggle();
    }

    function clearProjectSelection() {
        selectedProjectIds = new Set();
        pendingApplyTagKeys = new Set();
        updateSelectToggle();
    }

    function toggleProjectSelection(id) {
        if (!id) return;
        if (selectedProjectIds.has(id)) selectedProjectIds.delete(id);
        else selectedProjectIds.add(id);
        updateSelectToggle();
    }

    function ensureActiveFilterStillExists() {
        const summaries = getTagSummaries();
        const validKeys = new Set(summaries.map((summary) => summary.key));
        activeTagFilters = new Set([...activeTagFilters].filter((key) => validKeys.has(key)));
        rememberedTagFilters = new Set([...rememberedTagFilters].filter((key) => validKeys.has(key)));
        pendingApplyTagKeys = new Set([...pendingApplyTagKeys].filter((key) => validKeys.has(key)));

        if (activeTagMode === 'custom' && !activeTagFilters.size) {
            activeTagMode = 'all';
        }
    }

    function toggleSpecialTagMode(mode) {
        if (activeTagMode === mode) {
            if (rememberedTagFilters.size) {
                activeTagMode = 'custom';
                activeTagFilters = new Set(rememberedTagFilters);
            } else {
                activeTagMode = 'all';
                activeTagFilters = new Set();
            }
            return;
        }

        if (activeTagMode === 'custom') {
            rememberedTagFilters = new Set(activeTagFilters);
        }
        activeTagMode = mode;
        activeTagFilters = new Set();
    }

    function toggleTagFilter(key) {
        const next = new Set(activeTagMode === 'custom' ? activeTagFilters : rememberedTagFilters);
        if (next.has(key)) next.delete(key);
        else next.add(key);

        if (next.size) {
            activeTagMode = 'custom';
            activeTagFilters = next;
            rememberedTagFilters = new Set(next);
        } else {
            activeTagMode = 'all';
            activeTagFilters = new Set();
        }
    }

    function compareByDimensions(aWidth, aHeight, bWidth, bHeight) {
        return (Number(aWidth) || 0) - (Number(bWidth) || 0) || (Number(aHeight) || 0) - (Number(bHeight) || 0);
    }

    function getVisibleLibraryData() {
        const filtered = libraryData.filter((item) => {
            const itemTags = normalizeTagList(item.tags);
            if (activeTagMode === 'all') return true;
            if (activeTagMode === 'untagged') return !itemTags.length;
            return [...activeTagFilters].some((key) => itemTags.some((tag) => getTagKey(tag) === key));
        });

        const direction = sortDirection === 'asc' ? 1 : -1;
        filtered.sort((a, b) => {
            let comparison = 0;

            if (sortKey === 'name') {
                comparison = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
            } else if (sortKey === 'source-area') {
                comparison = (a.sourceArea || 0) - (b.sourceArea || 0);
                if (comparison === 0) {
                    comparison = compareByDimensions(a.sourceWidth, a.sourceHeight, b.sourceWidth, b.sourceHeight);
                }
            } else if (sortKey === 'render-area') {
                comparison = (a.renderArea || 0) - (b.renderArea || 0);
                if (comparison === 0) {
                    comparison = compareByDimensions(a.renderWidth, a.renderHeight, b.renderWidth, b.renderHeight);
                }
            } else {
                comparison = (a.timestamp || 0) - (b.timestamp || 0);
            }

            if (comparison === 0) {
                comparison = (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' });
            }

            return comparison * direction;
        });

        return filtered;
    }

    function setHoverEnabled(enabled) {
        isHoverEnabled = Boolean(enabled);
        refs.shell.classList.toggle('is-hover-enabled', isHoverEnabled);
        refs.hoverToggle.setAttribute('aria-pressed', isHoverEnabled ? 'true' : 'false');
    }

    function updateFullscreenToggle() {
        refs.fullscreenToggle.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
        refs.fullscreenView.classList.toggle('is-active', isFullscreen);
        refs.grid.classList.toggle('is-hidden', isFullscreen);
        refs.empty.classList.toggle('is-hidden', isFullscreen);
    }

    function setSidePanelOpen(enabled) {
        isSidePanelOpen = Boolean(enabled);
        refs.shell.classList.toggle('is-side-panel-open', isSidePanelOpen);
        refs.sidePanel.classList.toggle('is-open', isSidePanelOpen);
        refs.sidePanel.setAttribute('aria-hidden', isSidePanelOpen ? 'false' : 'true');
        refs.sideTab.setAttribute('aria-expanded', isSidePanelOpen ? 'true' : 'false');
        refs.sideTab.classList.toggle('is-open', isSidePanelOpen);
    }

    function setFullscreenEnabled(enabled) {
        isFullscreen = Boolean(enabled) && visibleLibraryData.length > 0;
        updateFullscreenToggle();
        if (isFullscreen) {
            currentIndex = Math.max(0, Math.min(currentIndex, visibleLibraryData.length - 1));
            updateFullscreen();
        }
    }

    function revokeUrls(entries = libraryData) {
        for (const item of entries) {
            if (item?.url && String(item.url).startsWith('blob:')) {
                URL.revokeObjectURL(item.url);
            }
        }
    }

    function renderLayerCards(payload) {
        if (payload?.kind === 'stitch-document' || payload?.mode === 'stitch') {
            const inputs = Array.isArray(payload.inputs) ? payload.inputs : [];
            const settings = payload.settings && typeof payload.settings === 'object' ? payload.settings : {};
            return `
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>Stitch Inputs</strong>
                        <span>${inputs.length} source${inputs.length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="library-layer-card-body">
                        ${inputs.length ? inputs.map((input) => `
                            <div class="library-param-row">
                                <span class="library-param-key">${escapeHtml(input.name || 'Input')}</span>
                                <span class="library-param-val">${escapeHtml(formatDimensions(input.width, input.height))}</span>
                            </div>
                        `).join('') : '<div class="library-detail-empty">This stitch project did not include any input images.</div>'}
                    </div>
                </section>
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>Stitch Settings</strong>
                        <span>${escapeHtml(payload.activeCandidateId ? 'Candidate ready' : 'Manual layout')}</span>
                    </div>
                    <div class="library-layer-card-body">
                        ${Object.keys(settings).length ? Object.entries(settings).map(([key, value]) => `
                            <div class="library-param-row">
                                <span class="library-param-key">${escapeHtml(key)}</span>
                                <span class="library-param-val">${escapeHtml(formatParamValue(value))}</span>
                            </div>
                        `).join('') : '<div class="library-detail-empty">This stitch project did not include custom analysis settings.</div>'}
                    </div>
                </section>
            `;
        }

        const layers = Array.isArray(payload?.layerStack) ? payload.layerStack : [];
        if (!layers.length) {
            return '<div class="library-detail-empty">This saved project did not include any layers.</div>';
        }

        return layers.map((layer, index) => {
            const defaults = layerDefaults[layer.layerId] || {};
            const params = Object.entries(layer?.params || {})
                .filter(([key, value]) => !SKIP_PARAMS.has(key) && !valuesMatch(value, defaults[key]))
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, value]) => {
                    const paramId = encodeURIComponent(`${detailData?.id || 'detail'}:${layer.instanceId || layer.layerId || index}:${key}`);
                    const expanded = expandedParamIds.has(paramId);
                    const display = getParamDisplay(value, expanded);
                    return `
                        <div class="library-param-row ${display.canExpand ? 'is-expandable' : ''}">
                            <span class="library-param-key">${escapeHtml(key)}</span>
                            <div class="library-param-value-wrap">
                                <span class="library-param-val ${expanded ? 'is-expanded' : ''}">${escapeHtml(display.text)}</span>
                                ${display.canExpand ? `
                                    <button
                                        type="button"
                                        class="library-param-toggle"
                                        data-library-action="toggle-param-expand"
                                        data-param-id="${paramId}"
                                        aria-expanded="${expanded ? 'true' : 'false'}"
                                    >${expanded ? '^' : 'v'}</button>
                                ` : ''}
                            </div>
                        </div>
                    `;
                })
                .join('');

            const stateBits = [
                layer.enabled === false ? 'Disabled' : null,
                layer.visible === false ? 'Hidden' : 'Visible'
            ].filter(Boolean).join(' / ');

            return `
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>${escapeHtml(layer.label || layer.layerId || `Layer ${index + 1}`)}</strong>
                        <span>${escapeHtml(stateBits)}</span>
                    </div>
                    <div class="library-layer-card-body">
                        ${params || '<div class="library-detail-empty">Only default parameters differ for this layer.</div>'}
                    </div>
                </section>
            `;
        }).join('');
    }

    function renderProjectSummaryCard(data) {
        return `
            <section class="library-source-info">
                <div class="library-layer-card-header">
                    <strong>Project Summary</strong>
                    <span>${escapeHtml(formatDateTime(data.timestamp))}</span>
                </div>
                <div class="library-layer-card-body">
                    <div class="library-param-row">
                        <span class="library-param-key">Project Type</span>
                        <span class="library-param-val">${escapeHtml(getProjectTypeLabel(data.projectType))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Source Size</span>
                        <span class="library-param-val">${escapeHtml(formatDimensions(data.sourceWidth, data.sourceHeight))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Source Count</span>
                        <span class="library-param-val">${escapeHtml(String(data.sourceCount || (data.projectType === 'stitch' ? 0 : 1)))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Rendered Size</span>
                        <span class="library-param-val">${escapeHtml(formatDimensions(data.renderWidth, data.renderHeight))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Source Area</span>
                        <span class="library-param-val">${escapeHtml(formatArea(data.sourceArea))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Render Area</span>
                        <span class="library-param-val">${escapeHtml(formatArea(data.renderArea))}</span>
                    </div>
                    <div class="library-project-tags">
                        ${renderTagPills(data.tags)}
                    </div>
                </div>
            </section>
        `;
    }

    function renderGrid() {
        if (!libraryData.length) {
            refs.grid.innerHTML = '';
            refs.empty.classList.add('is-visible');
            refs.emptyTitle.textContent = 'Library is empty';
            refs.emptyText.textContent = 'Save projects from Editor or Stitch, or import JSON files to build your gallery.';
            return;
        }

        if (!visibleLibraryData.length) {
            refs.grid.innerHTML = '';
            refs.empty.classList.add('is-visible');
            refs.emptyTitle.textContent = 'No projects match this view';
            refs.emptyText.textContent = 'Try a different tag tab or sorting mode from the Library Tools drawer.';
            return;
        }

        refs.empty.classList.remove('is-visible');
        refs.grid.innerHTML = visibleLibraryData.map((item, index) => `
            <article class="library-grid-item ${selectedProjectIds.has(item.id) || selectedProjectId === item.id ? 'is-selected' : ''}" data-library-index="${index}" data-library-id="${item.id}">
                <button type="button" class="library-delete-button" data-library-action="delete-project" data-library-id="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">&times;</button>
                ${selectedProjectIds.has(item.id) ? '<div class="library-selection-badge">Selected</div>' : ''}
                ${item.hoverSrc ? '<div class="library-hover-hint">Hovering Original</div>' : ''}
                <div class="library-image-container">
                    <img src="${item.url}" class="library-img-base" alt="${escapeHtml(item.name)}">
                    ${item.hoverSrc ? `<img src="${item.hoverSrc}" class="library-img-hover" alt="">` : ''}
                </div>
                <div class="library-card-meta">
                    <div class="library-card-title">${escapeHtml(item.name)}</div>
                    <div class="library-card-dimensions">
                        <span>Source ${escapeHtml(formatDimensions(item.sourceWidth, item.sourceHeight))}</span>
                        <span>Render ${escapeHtml(formatDimensions(item.renderWidth, item.renderHeight))}</span>
                    </div>
                    ${renderTagPills(item.tags)}
                </div>
            </article>
        `).join('');
    }

    function updateFullscreen() {
        if (!isFullscreen || !visibleLibraryData.length) {
            refs.fullscreenBase.removeAttribute('src');
            refs.fullscreenHover.removeAttribute('src');
            return;
        }

        currentIndex = Math.max(0, Math.min(currentIndex, visibleLibraryData.length - 1));
        const current = visibleLibraryData[currentIndex];
        refs.fullscreenLabel.textContent = `${current.name} (${currentIndex + 1}/${visibleLibraryData.length})`;
        refs.fullscreenBase.src = current.url;
        if (current.hoverSrc) refs.fullscreenHover.src = current.hoverSrc;
        else refs.fullscreenHover.removeAttribute('src');
    }

    function renderDetail() {
        if (!detailData) {
            refs.detailOverlay.classList.remove('is-active');
            refs.detailName.textContent = 'Project Preview';
            refs.detailMeta.textContent = '';
            refs.detailLayers.innerHTML = '';
            refs.detailBase.removeAttribute('src');
            refs.detailHover.removeAttribute('src');
            return;
        }

        refs.detailOverlay.classList.add('is-active');
        refs.detailName.textContent = detailData.name;
        refs.detailMeta.textContent = `${getProjectTypeLabel(detailData.projectType)} | Saved ${formatDateTime(detailData.timestamp)} | Source ${formatDimensions(detailData.sourceWidth, detailData.sourceHeight)} | Render ${formatDimensions(detailData.renderWidth, detailData.renderHeight)}`;
        refs.detailBase.src = detailData.url;
        if (detailData.hoverSrc) refs.detailHover.src = detailData.hoverSrc;
        else refs.detailHover.removeAttribute('src');
        refs.detailLayers.innerHTML = renderProjectSummaryCard(detailData) + renderLayerCards(detailData.payload);
    }

    function openDetailByData(data) {
        if (!data) return;
        if (detailData?.id !== data.id) expandedParamIds = new Set();
        detailData = data;
        selectedProjectId = data.id;
        renderDetail();
        renderSidePanel();
    }

    function closeDetail() {
        detailData = null;
        expandedParamIds = new Set();
        renderDetail();
    }

    function renderSidePanel() {
        const focusedProject = getSelectedProject();
        const selectedProjects = getSelectedProjects();
        const selectionCount = selectedProjects.length;
        const tagSummaries = getTagSummaries();
        const selectionTagSummaries = getSelectionTagSummaries();
        const sortLabels = getSortDirectionLabels(sortKey);
        const selectedNames = selectedProjects.slice(0, 3).map((item) => item.name).join(', ');

        refs.sideContent.innerHTML = `
            ${selectionCount ? `
                <section class="library-side-section">
                    <h3>Selection Actions</h3>
                    <p class="library-side-summary">${selectionCount} project${selectionCount === 1 ? '' : 's'} selected</p>
                    <div class="library-side-actions">
                        <button type="button" class="toolbar-button" data-library-action="delete-selected-projects">Delete</button>
                        <button type="button" class="toolbar-button" data-library-action="clear-selection">Clear Selection</button>
                    </div>
                </section>
            ` : ''}
            <section class="library-side-section">
                <h3>Gallery View</h3>
                <label class="library-side-label" for="library-sort-key">Sort Projects</label>
                <select id="library-sort-key" class="library-side-select" data-library-role="sort-key">
                    <option value="timestamp" ${sortKey === 'timestamp' ? 'selected' : ''}>Saved date</option>
                    <option value="name" ${sortKey === 'name' ? 'selected' : ''}>Project name</option>
                    <option value="source-area" ${sortKey === 'source-area' ? 'selected' : ''}>Original image size</option>
                    <option value="render-area" ${sortKey === 'render-area' ? 'selected' : ''}>Rendered image size</option>
                </select>
                <div class="library-sort-direction">
                    <button type="button" class="library-filter-chip ${sortDirection === 'desc' ? 'is-active' : ''}" data-library-action="set-sort-direction" data-direction="desc">${escapeHtml(sortLabels.desc)}</button>
                    <button type="button" class="library-filter-chip ${sortDirection === 'asc' ? 'is-active' : ''}" data-library-action="set-sort-direction" data-direction="asc">${escapeHtml(sortLabels.asc)}</button>
                </div>
                <p class="library-side-summary">${visibleLibraryData.length} of ${libraryData.length} projects visible</p>
            </section>
            <section class="library-side-section">
                <h3>Tag Tabs</h3>
                <div class="library-filter-tabs">
                    <button type="button" class="library-filter-chip ${activeTagMode === 'all' ? 'is-active' : ''}" data-library-action="toggle-special-filter" data-mode="all">All (${libraryData.length})</button>
                    <button type="button" class="library-filter-chip ${activeTagMode === 'untagged' ? 'is-active' : ''}" data-library-action="toggle-special-filter" data-mode="untagged">Untagged (${libraryData.filter((item) => !normalizeTagList(item.tags).length).length})</button>
                    ${tagSummaries.map((summary) => `
                        <button type="button" class="library-filter-chip ${activeTagMode === 'custom' && activeTagFilters.has(summary.key) ? 'is-active' : ''}" data-library-action="toggle-tag-filter" data-filter="${escapeHtml(summary.key)}">${escapeHtml(summary.tag)} (${summary.count})</button>
                    `).join('')}
                </div>
            </section>
            <section class="library-side-section">
                <h3>${selectionCount ? 'Selected Images' : 'Focused Project'}</h3>
                ${selectionCount ? `
                    <div class="library-selected-card">
                        <strong>${selectionCount} project${selectionCount === 1 ? '' : 's'} selected</strong>
                        <div class="library-selected-meta">
                            <span>${escapeHtml(selectedNames)}${selectionCount > 3 ? `, +${selectionCount - 3} more` : ''}</span>
                            <span>${selectionTagSummaries.length} total tag${selectionTagSummaries.length === 1 ? '' : 's'} across selection</span>
                        </div>
                        <div class="library-side-label">Selection Tags</div>
                        ${selectionTagSummaries.length ? `
                            <div class="library-tag-list">
                                ${selectionTagSummaries.map((summary) => `
                                    <button
                                        type="button"
                                        class="library-tag library-tag-button"
                                        data-library-action="remove-tag-from-selection"
                                        data-library-tag="${encodeTag(summary.tag)}"
                                    >
                                        <span>${escapeHtml(summary.tag)}</span>
                                        <span>${summary.count}/${selectionCount}</span>
                                    </button>
                                `).join('')}
                            </div>
                        ` : '<div class="library-side-empty">Selected images do not have any tags yet.</div>'}
                        <div class="library-side-label">Create Tag</div>
                        <div class="library-tag-input-row">
                            <input type="text" class="library-tag-input" data-library-role="create-tag-input" placeholder="Create a new tag">
                            <button type="button" class="toolbar-button" data-library-action="create-tag">Create Tag</button>
                        </div>
                        <div class="library-side-label">Available Tags</div>
                        ${libraryTags.length ? `
                            <div class="library-filter-tabs">
                                ${libraryTags.map((tag) => `
                                    <button
                                        type="button"
                                        class="library-filter-chip ${pendingApplyTagKeys.has(getTagKey(tag)) ? 'is-active' : ''}"
                                        data-library-action="toggle-pending-tag"
                                        data-library-tag="${encodeTag(tag)}"
                                    >${escapeHtml(tag)}</button>
                                `).join('')}
                            </div>
                        ` : '<div class="library-side-empty">Create your first tag, then apply it to the selected images.</div>'}
                        <div class="library-side-actions">
                            <button type="button" class="toolbar-button" data-library-action="apply-pending-tags" ${pendingApplyTagKeys.size ? '' : 'disabled'}>Apply Chosen Tags</button>
                        </div>
                    </div>
                ` : focusedProject ? `
                    <div class="library-selected-card">
                        <strong>${escapeHtml(focusedProject.name)}</strong>
                        <div class="library-selected-meta">
                            <span>${escapeHtml(getProjectTypeLabel(focusedProject.projectType))}</span>
                            <span>Source ${escapeHtml(formatDimensions(focusedProject.sourceWidth, focusedProject.sourceHeight))}</span>
                            <span>Render ${escapeHtml(formatDimensions(focusedProject.renderWidth, focusedProject.renderHeight))}</span>
                            <span>Saved ${escapeHtml(formatDateTime(focusedProject.timestamp))}</span>
                        </div>
                        ${focusedProject.tags.length ? `
                            <div class="library-tag-list">
                                ${focusedProject.tags.map((tag) => `
                                    <button
                                        type="button"
                                        class="library-tag library-tag-button"
                                        data-library-action="remove-tag-from-focused"
                                        data-library-tag="${encodeTag(tag)}"
                                    >${escapeHtml(tag)}</button>
                                `).join('')}
                            </div>
                        ` : '<div class="library-side-empty">This project has no tags yet.</div>'}
                        <div class="library-side-actions">
                            <button type="button" class="toolbar-button" data-library-action="open-selected-detail">Open Details</button>
                            <button type="button" class="toolbar-button" data-library-action="load-selected-project">Load Project</button>
                        </div>
                    </div>
                ` : `
                    <div class="library-side-empty">Use Select to mark one or more images, then manage tags or batch-delete them from this panel.</div>
                `}
            </section>
        `;
    }

    function applyViewState() {
        ensureActiveFilterStillExists();
        visibleLibraryData = getVisibleLibraryData();
        selectedProjectIds = new Set([...selectedProjectIds].filter((id) => libraryData.some((item) => item.id === id)));
        updateSelectToggle();

        if (selectedProjectId && !libraryData.some((item) => item.id === selectedProjectId)) {
            selectedProjectId = null;
        }

        if (detailData) {
            const freshDetail = libraryData.find((item) => item.id === detailData.id);
            if (freshDetail) detailData = freshDetail;
            else closeDetail();
        }

        if (!visibleLibraryData.length) currentIndex = 0;
        else currentIndex = Math.max(0, Math.min(currentIndex, visibleLibraryData.length - 1));

        renderGrid();
        renderSidePanel();
        renderDetail();

        if (isFullscreen && visibleLibraryData.length) {
            updateFullscreen();
        } else if (isFullscreen && !visibleLibraryData.length) {
            setFullscreenEnabled(false);
        } else {
            updateFullscreenToggle();
        }
    }

    function setModalError(message = '') {
        refs.modalError.textContent = message || '';
        refs.modalError.classList.toggle('is-visible', Boolean(message));
    }

    function setModalBusy(isBusy) {
        if (!modalState) return;
        modalState.isBusy = Boolean(isBusy);
        refs.modalCancel.disabled = Boolean(isBusy);
        refs.modalConfirm.disabled = Boolean(isBusy);
        refs.modalBox.classList.toggle('is-busy', Boolean(isBusy));
    }

    function resetModalContent() {
        refs.modalTitle.textContent = '';
        refs.modalText.textContent = '';
        refs.modalContent.innerHTML = '';
        refs.modalCancel.textContent = 'Cancel';
        refs.modalCancel.style.display = '';
        refs.modalConfirm.textContent = 'Confirm';
        refs.modalConfirm.classList.remove('is-danger');
        refs.modalConfirm.style.display = '';
        refs.modalCancel.disabled = false;
        refs.modalConfirm.disabled = false;
        refs.modalBox.classList.remove('is-busy');
        setModalError('');
    }

    function hideModal(force = false) {
        if (modalState?.isBusy && !force) return;
        modalState = null;
        refs.modalOverlay.classList.remove('is-active');
        resetModalContent();
    }

    function getModalContext() {
        return {
            root: refs.modalContent,
            setError: setModalError,
            close: () => hideModal(true)
        };
    }

    function showModal(options) {
        modalState = {
            title: options.title || 'Library',
            text: options.text || '',
            html: options.html || '',
            confirmLabel: options.confirmLabel || 'Confirm',
            cancelLabel: options.cancelLabel || 'Cancel',
            isAlert: Boolean(options.isAlert),
            isDanger: Boolean(options.isDanger),
            closeOnOverlay: options.closeOnOverlay !== false,
            isBusy: false,
            onConfirm: options.onConfirm || null,
            onCancel: options.onCancel || null
        };

        refs.modalTitle.textContent = modalState.title;
        refs.modalText.textContent = modalState.text;
        refs.modalContent.innerHTML = modalState.html || '';
        refs.modalCancel.textContent = modalState.cancelLabel;
        refs.modalCancel.style.display = modalState.isAlert ? 'none' : '';
        refs.modalConfirm.textContent = modalState.confirmLabel;
        refs.modalConfirm.classList.toggle('is-danger', modalState.isDanger);
        setModalError('');
        refs.modalOverlay.classList.add('is-active');
        options.onOpen?.(getModalContext());
    }

    async function confirmModal() {
        if (!modalState || modalState.isBusy) return;
        const callback = modalState.onConfirm;
        if (!callback) {
            hideModal(true);
            return;
        }

        try {
            setModalBusy(true);
            const result = await callback(getModalContext());
            if (result === false) {
                setModalBusy(false);
                return;
            }
            hideModal(true);
        } catch (error) {
            setModalBusy(false);
            setModalError(error?.message || 'Could not continue.');
        }
    }

    async function cancelModal() {
        if (!modalState || modalState.isBusy) return;
        try {
            const result = await modalState.onCancel?.(getModalContext());
            if (result === false) return;
        } catch (error) {
            setModalError(error?.message || 'Could not close this window yet.');
            return;
        }
        hideModal(true);
    }

    function showAlert(text, title = 'Library') {
        showModal({
            title,
            text,
            confirmLabel: 'OK',
            isAlert: true
        });
    }

    function runModalStep(options) {
        return new Promise((resolve) => {
            showModal({
                ...options,
                onCancel: async (context) => {
                    options.onCancel?.(context);
                    resolve(null);
                },
                onConfirm: async (context) => {
                    const value = options.onConfirm ? await options.onConfirm(context) : true;
                    if (value === false) return false;
                    resolve(value === undefined ? true : value);
                    return true;
                }
            });
        });
    }

    function focusModalField(selector) {
        const target = refs.modalContent.querySelector(selector);
        if (target && typeof target.focus === 'function') {
            requestAnimationFrame(() => target.focus());
        }
    }

    async function promptLibraryFilename(title, text, defaultValue) {
        const value = await runModalStep({
            title,
            text,
            html: `
                <label class="library-modal-field">
                    <span>File name</span>
                    <input type="text" class="library-modal-input" data-library-role="modal-filename" value="${escapeHtml(stripJsonExtension(defaultValue || 'noise-studio-library'))}">
                </label>
            `,
            confirmLabel: 'Continue',
            onOpen: () => focusModalField('[data-library-role="modal-filename"]'),
            onConfirm: ({ root, setError }) => {
                const input = root.querySelector('[data-library-role="modal-filename"]');
                const filename = stripJsonExtension(input?.value || '').trim();
                if (!filename) {
                    setError('Enter a file name first.');
                    return false;
                }
                return filename;
            }
        });
        return value ? toJsonFilename(value) : null;
    }

    async function promptSaveLibraryMode(defaultName) {
        const exportMode = await runModalStep({
            title: 'Save Library',
            text: 'Choose how you want to save the current Library.',
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-export-mode" value="plain" checked>
                        <strong>Json Export</strong>
                        <span>Readable Library JSON with every project, tag, and export date preserved.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-export-mode" value="secure">
                        <strong>Secure Export</strong>
                        <span>Pack the whole Library into a compressed JSON-safe block, with optional encryption.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Next',
            onConfirm: ({ root, setError }) => {
                const selected = root.querySelector('input[name="library-export-mode"]:checked')?.value;
                if (!selected) {
                    setError('Choose an export type first.');
                    return false;
                }
                return { exportMode: selected, suggestedFilename: buildDefaultLibraryFilename(defaultName) };
            }
        });
        return exportMode;
    }

    async function promptSecureSaveMode() {
        return runModalStep({
            title: 'Secure Export',
            text: 'Pick how protected the packed Library file should be.',
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-secure-mode" value="compressed" checked>
                        <strong>Compressed Base64</strong>
                        <span>Gzip the whole Library, then store it as base64 inside JSON for safer transport.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-secure-mode" value="encrypted">
                        <strong>Compressed + Encrypted</strong>
                        <span>Gzip first, then encrypt the packed Library with a key you choose.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Next',
            onConfirm: ({ root, setError }) => {
                const selected = root.querySelector('input[name="library-secure-mode"]:checked')?.value;
                if (!selected) {
                    setError('Choose a secure export mode first.');
                    return false;
                }
                return selected;
            }
        });
    }

    async function promptEncryptionPassphrase() {
        return runModalStep({
            title: 'Encryption Key',
            text: 'Enter the key that should protect this Library export.',
            html: `
                <label class="library-modal-field">
                    <span>Key</span>
                    <input type="password" class="library-modal-input" data-library-role="modal-passphrase" autocomplete="new-password">
                </label>
                <label class="library-modal-field">
                    <span>Confirm key</span>
                    <input type="password" class="library-modal-input" data-library-role="modal-passphrase-confirm" autocomplete="new-password">
                </label>
            `,
            confirmLabel: 'Next',
            onOpen: () => focusModalField('[data-library-role="modal-passphrase"]'),
            onConfirm: ({ root, setError }) => {
                const passphrase = root.querySelector('[data-library-role="modal-passphrase"]')?.value || '';
                const confirm = root.querySelector('[data-library-role="modal-passphrase-confirm"]')?.value || '';
                if (!passphrase.trim()) {
                    setError('Enter an encryption key first.');
                    return false;
                }
                if (passphrase !== confirm) {
                    setError('The confirmation key does not match.');
                    return false;
                }
                return passphrase;
            }
        });
    }

    async function promptDuplicateCopyChoice() {
        return runModalStep({
            title: 'Duplicate Secure Copies',
            text: 'Do you want this encrypted export to carry two sealed copies of the packed Library data?',
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-duplicate-copies" value="double" checked>
                        <strong>Store Two Copies</strong>
                        <span>Lets the import path recover from one damaged or altered encrypted copy more easily.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-duplicate-copies" value="single">
                        <strong>Store One Copy</strong>
                        <span>Keeps the file smaller, but there is no backup ciphertext to compare or recover from.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Save Library',
            onConfirm: ({ root, setError }) => {
                const selected = root.querySelector('input[name="library-duplicate-copies"]:checked')?.value;
                if (!selected) {
                    setError('Choose how many encrypted copies to store.');
                    return false;
                }
                return selected === 'double';
            }
        });
    }

    async function promptReplaceMode(incomingCount) {
        return runModalStep({
            title: 'Load Library File',
            text: `This file contains ${incomingCount} Library project${incomingCount === 1 ? '' : 's'}. How should it be loaded?`,
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-replace-mode" value="merge" checked>
                        <strong>Add To Current Library</strong>
                        <span>Keep everything that is already saved and add the incoming Library items to it.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-replace-mode" value="replace">
                        <strong>Replace Current Library</strong>
                        <span>Clear existing Library projects first, then load the incoming Library file.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Continue',
            onConfirm: ({ root, setError }) => {
                const selected = root.querySelector('input[name="library-replace-mode"]:checked')?.value;
                if (!selected) {
                    setError('Choose how to load the Library file.');
                    return false;
                }
                return selected;
            }
        });
    }

    async function promptSaveBeforeReplace() {
        return runModalStep({
            title: 'Replace Current Library',
            text: 'Do you want to save the current Library before it is cleared?',
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-save-before-replace" value="save" checked>
                        <strong>Save Current Library</strong>
                        <span>Run the Save Library workflow first, then replace the current contents.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-save-before-replace" value="discard">
                        <strong>Replace Without Saving</strong>
                        <span>Skip the backup and clear the current Library immediately before loading the new file.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Continue',
            onConfirm: ({ root, setError }) => {
                const selected = root.querySelector('input[name="library-save-before-replace"]:checked')?.value;
                if (!selected) {
                    setError('Choose whether to save the current Library first.');
                    return false;
                }
                return selected;
            }
        });
    }

    async function promptSecureImportKey(filename) {
        return runModalStep({
            title: 'Unlock Library',
            text: `Enter the decryption key for "${filename}".`,
            html: `
                <label class="library-modal-field">
                    <span>Decryption key</span>
                    <input type="password" class="library-modal-input" data-library-role="modal-import-key" autocomplete="current-password">
                </label>
            `,
            confirmLabel: 'Unlock',
            onOpen: () => focusModalField('[data-library-role="modal-import-key"]'),
            onConfirm: ({ root, setError }) => {
                const passphrase = root.querySelector('[data-library-role="modal-import-key"]')?.value || '';
                if (!passphrase.trim()) {
                    setError('Enter the decryption key first.');
                    return false;
                }
                return passphrase;
            }
        });
    }

    async function promptRecoveredFileDownload(filename) {
        return runModalStep({
            title: 'Recover Secure Library',
            text: 'One encrypted copy could be recovered and another one failed to open. You can load the Library now and optionally download a repaired copy first.',
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-repair-choice" value="download" checked>
                        <strong>Download Repaired File</strong>
                        <span>Save a fresh repaired copy of "${filename}" before loading the recovered Library data.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-repair-choice" value="skip">
                        <strong>Load Without Download</strong>
                        <span>Continue with the recovered data right away and skip the repaired file download.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Continue',
            onConfirm: ({ root, setError }) => {
                const selected = root.querySelector('input[name="library-repair-choice"]:checked')?.value;
                if (!selected) {
                    setError('Choose whether to download a repaired secure file.');
                    return false;
                }
                return selected === 'download';
            }
        });
    }

    function showProgress(text, countText = '', ratio = 0) {
        refs.statusText.textContent = text || 'Working...';
        refs.countText.textContent = countText || '';
        refs.progressFill.style.width = `${Math.round(clamp01(ratio) * 100)}%`;
        refs.loadingOverlay.classList.add('is-active');
    }

    function hideProgress() {
        refs.loadingOverlay.classList.remove('is-active');
        refs.progressFill.style.width = '0%';
    }

    async function refresh() {
        const token = ++refreshToken;
        const previousData = libraryData;
        const previousTags = libraryTags;
        const previousById = new Map(previousData.map((item) => [item.id, item]));
        const [projects, nextLibraryTagsRaw] = await Promise.all([
            actions.getLibraryProjects(),
            actions.getLibraryTagCatalog?.() || []
        ]);
        const nextLibraryTags = normalizeTagList(nextLibraryTagsRaw || []);

        const nextData = await Promise.all(projects.map(async (project) => {
            const previous = previousById.get(project.id);
            const tags = normalizeTagList(project.tags || []);
            let renderWidth = Number(project.renderWidth || 0);
            let renderHeight = Number(project.renderHeight || 0);
            const hoverSource = project.hoverSource || project.payload?._libraryHoverSource || project.payload?.source || null;
            const sourceWidth = Number(project.sourceWidth || hoverSource?.width || project.payload?.source?.width || 0);
            const sourceHeight = Number(project.sourceHeight || hoverSource?.height || project.payload?.source?.height || 0);
            const sourceAreaOverride = Number(project.sourceAreaOverride || project.payload?._librarySourceArea || 0) || 0;
            const sourceCount = Number(project.sourceCount || project.payload?._librarySourceCount || (project.projectType === 'stitch' ? project.payload?.inputs?.length || 0 : (hoverSource?.imageData ? 1 : 0)) || 0);
            let previewSignature = getProjectPreviewSignature(project, renderWidth, renderHeight);
            let url = previous?.previewSignature === previewSignature
                ? previous.url
                : (project.blob ? URL.createObjectURL(project.blob) : (hoverSource?.imageData || ''));

            if ((!renderWidth || !renderHeight) && previous?.previewSignature === previewSignature) {
                renderWidth = previous.renderWidth;
                renderHeight = previous.renderHeight;
            }

            if ((!renderWidth || !renderHeight) && url) {
                try {
                    const measured = await readImageDimensions(url);
                    renderWidth = measured.width;
                    renderHeight = measured.height;
                } catch (_error) {
                    renderWidth = Number(project.payload?.source?.width || 0);
                    renderHeight = Number(project.payload?.source?.height || 0);
                }
            }

            previewSignature = getProjectPreviewSignature(project, renderWidth, renderHeight);
            const recordSignature = getProjectRecordSignature(project, tags, sourceWidth, sourceHeight, renderWidth, renderHeight);

            return {
                ...project,
                name: String(project.name || 'Untitled Project'),
                payload: project.payload || {},
                projectType: project.projectType || (project.payload?.kind === 'stitch-document' || project.payload?.mode === 'stitch' ? 'stitch' : 'studio'),
                tags,
                url,
                hoverSrc: hoverSource?.imageData || '',
                hoverSource,
                sourceWidth,
                sourceHeight,
                sourceAreaOverride,
                sourceCount,
                renderWidth,
                renderHeight,
                sourceArea: sourceAreaOverride || getImageArea(sourceWidth, sourceHeight),
                renderArea: getImageArea(renderWidth, renderHeight),
                previewSignature,
                recordSignature
            };
        }));

        if (token !== refreshToken) {
            for (const item of nextData) {
                const previous = previousById.get(item.id);
                if (item?.url && String(item.url).startsWith('blob:') && item.url !== previous?.url) {
                    URL.revokeObjectURL(item.url);
                }
            }
            return;
        }

        const didDataChange = !hasRenderedLibrary
            || previousData.length !== nextData.length
            || nextData.some((item) => previousById.get(item.id)?.recordSignature !== item.recordSignature)
            || JSON.stringify(previousTags) !== JSON.stringify(nextLibraryTags);

        releaseUnusedUrls(previousData, nextData);
        libraryData = nextData;
        libraryTags = nextLibraryTags;
        if (!didDataChange && hasRenderedLibrary) {
            return;
        }

        hasRenderedLibrary = true;
        applyViewState();
    }

    async function saveTagsForProject(projectId, nextTags) {
        await actions.updateLibraryProjectTags(projectId, normalizeTagList(nextTags));
        await refresh();
    }

    async function createLibraryTagFromInput(rawTag) {
        const nextTags = normalizeTagList(String(rawTag || '').split(','));
        if (!nextTags.length) return;
        for (const tag of nextTags) {
            await actions.createLibraryTag?.(tag);
        }
        await refresh();
    }

    async function removeTagFromFocusedProject(tag) {
        const project = getSelectedProject();
        if (!project) return;
        const removeKey = getTagKey(tag);
        await saveTagsForProject(project.id, project.tags.filter((item) => getTagKey(item) !== removeKey));
    }

    async function applyPendingTagsToSelection() {
        const targetIds = getSelectedProjectIds();
        if (!targetIds.length || !pendingApplyTagKeys.size) return;
        const tagsToApply = libraryTags.filter((tag) => pendingApplyTagKeys.has(getTagKey(tag)));
        if (!tagsToApply.length) return;
        await actions.applyLibraryTagsToProjects?.(targetIds, tagsToApply);
        pendingApplyTagKeys = new Set();
        await refresh();
    }

    async function removeTagFromSelection(tag) {
        const targetIds = getSelectedProjectIds();
        if (!targetIds.length) return;
        await actions.removeLibraryTagFromProjects?.(targetIds, tag);
        await refresh();
    }

    function downloadProject(project) {
        if (!project) return;
        downloadJsonFile(buildLibraryProjectExportPayload(project), project.name);
    }

    async function buildSecureLibraryExportRecord(bundle, { secureMode, passphrase = '', duplicateCopies = false }) {
        const bundleText = JSON.stringify(bundle);
        const compressed = await gzipText(bundleText);
        if (secureMode === 'compressed') {
            return {
                type: LIBRARY_EXPORT_TYPE,
                format: LIBRARY_SECURE_EXPORT_FORMAT,
                version: 1,
                name: bundle.name,
                exportedAt: new Date().toISOString(),
                mode: 'compressed',
                payloadFormat: LIBRARY_EXPORT_FORMAT,
                compression: 'gzip',
                encoding: 'base64',
                payload: {
                    data: bytesToBase64(compressed)
                }
            };
        }

        if (!crypto?.subtle) {
            throw new Error('This browser does not support encrypted Library exports.');
        }

        const copyCount = duplicateCopies ? 2 : 1;
        const copies = [];
        for (let index = 0; index < copyCount; index += 1) {
            copies.push(await encryptLibraryBytes(compressed, passphrase, LIBRARY_SECURE_KDF_ITERATIONS));
        }
        return {
            type: LIBRARY_EXPORT_TYPE,
            format: LIBRARY_SECURE_EXPORT_FORMAT,
            version: 1,
            name: bundle.name,
            exportedAt: new Date().toISOString(),
            mode: 'encrypted',
            payloadFormat: LIBRARY_EXPORT_FORMAT,
            compression: 'gzip',
            encoding: 'base64',
            duplicateCopies,
            encryption: {
                algorithm: 'AES-GCM',
                kdf: 'PBKDF2',
                hash: 'SHA-256',
                iterations: LIBRARY_SECURE_KDF_ITERATIONS
            },
            payload: { copies }
        };
    }

    async function saveLibraryWorkflow(options = {}) {
        if (!libraryData.length && !libraryTags.length) {
            showAlert('There are no Library projects or tags to save yet.');
            return false;
        }

        const defaultName = stripJsonExtension(options.defaultName || buildDefaultLibraryFilename('noise-studio-library'));
        const exportChoice = await promptSaveLibraryMode(defaultName);
        if (!exportChoice) return false;

        const filename = await promptLibraryFilename(
            'Save Library',
            'Choose a file name for this Library export.',
            exportChoice.suggestedFilename || defaultName
        );
        if (!filename) return false;

        const bundle = buildLibraryExportBundle(libraryData, libraryTags, stripJsonExtension(filename));

        if (exportChoice.exportMode === 'plain') {
            downloadJsonFile(bundle, filename);
            return true;
        }

        const secureMode = await promptSecureSaveMode();
        if (!secureMode) return false;

        let passphrase = '';
        let duplicateCopies = false;
        if (secureMode === 'encrypted') {
            passphrase = await promptEncryptionPassphrase();
            if (!passphrase) return false;
            const duplicateChoice = await promptDuplicateCopyChoice();
            if (duplicateChoice === null) return false;
            duplicateCopies = duplicateChoice;
        }

        try {
            showProgress('Packing Library export...', `${libraryData.length} project${libraryData.length === 1 ? '' : 's'}`, 0.15);
            const payload = await buildSecureLibraryExportRecord(bundle, {
                secureMode,
                passphrase,
                duplicateCopies
            });
            showProgress('Saving Library export...', toJsonFilename(filename), 1);
            downloadJsonFile(payload, filename);
            return true;
        } catch (error) {
            console.error(error);
            showAlert(error.message || 'Could not save the Library export.');
            return false;
        } finally {
            hideProgress();
        }
    }

    async function resolveSecureImportPayload(parsed, fallbackName) {
        if (parsed.mode === 'compressed') {
            const compressedText = await gunzipText(base64ToBytes(parsed?.payload?.data || ''));
            return extractLibraryImportBundle(JSON.parse(compressedText), fallbackName);
        }

        if (parsed.mode !== 'encrypted') {
            throw new Error('This secure Library format is not recognized.');
        }

        if (!crypto?.subtle) {
            throw new Error('This browser cannot decrypt secure Library files.');
        }

        const passphrase = await promptSecureImportKey(toJsonFilename(parsed.name || fallbackName));
        if (!passphrase) return null;

        const copies = Array.isArray(parsed?.payload?.copies) ? parsed.payload.copies : [];
        if (!copies.length) {
            throw new Error('This secure Library file does not contain any encrypted copies.');
        }

        const iterations = Number(parsed?.encryption?.iterations || LIBRARY_SECURE_KDF_ITERATIONS) || LIBRARY_SECURE_KDF_ITERATIONS;
        const successes = [];
        let failedCount = 0;

        for (const copy of copies) {
            try {
                const decompressedBytes = await decryptLibraryBytes(copy, passphrase, iterations);
                const recoveredText = await gunzipText(decompressedBytes);
                successes.push(recoveredText);
            } catch (_error) {
                failedCount += 1;
            }
        }

        if (!successes.length) {
            throw new Error('Could not decrypt this secure Library file with that key.');
        }

        const recoveredText = successes[0];
        if (successes.some((entry) => entry !== recoveredText)) {
            throw new Error('This secure Library file contains mismatched encrypted copies and could not be trusted automatically.');
        }

        const recoveredParsed = JSON.parse(recoveredText);
        const extracted = extractLibraryImportBundle(recoveredParsed, fallbackName);

        if (failedCount && copies.length > 1) {
            const wantsRepairDownload = await promptRecoveredFileDownload(toJsonFilename(parsed.name || fallbackName));
            if (wantsRepairDownload === null) return null;
            if (wantsRepairDownload) {
                const repairedPayload = await buildSecureLibraryExportRecord(
                    isPlainLibraryExportPayload(recoveredParsed)
                        ? recoveredParsed
                        : buildLibraryExportBundle(
                            extracted.entries.map((entry) => ({
                                name: entry.name,
                                tags: entry.tags,
                                payload: JSON.parse(entry.text)
                            })),
                            extracted.tags,
                            parsed.name || fallbackName
                        ),
                    {
                        secureMode: 'encrypted',
                        passphrase,
                        duplicateCopies: Boolean(parsed.duplicateCopies || copies.length > 1)
                    }
                );
                downloadJsonFile(repairedPayload, `${stripJsonExtension(parsed.name || fallbackName)} repaired`);
            }
        }

        return extracted;
    }

    async function parseUploadFile(file) {
        const fallbackName = stripJsonExtension(file.name || 'library-project') || 'library-project';
        const rawText = await file.text();
        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (error) {
            throw new Error(`"${file.name}" is not valid JSON.`);
        }

        if (isSecureLibraryExportPayload(parsed)) {
            return resolveSecureImportPayload(parsed, fallbackName);
        }

        return extractLibraryImportBundle(parsed, fallbackName);
    }

    async function exportZip() {
        if (!libraryData.length) {
            showAlert('There are no Library projects to export.');
            return;
        }
        if (!window.JSZip) {
            showAlert('JSZip is not available in this build.');
            return;
        }

        try {
            showProgress('Creating Library ZIP...', `${libraryData.length} project${libraryData.length === 1 ? '' : 's'}`, 0.1);
            const zip = new window.JSZip();
            const usedNames = new Map();

            for (let index = 0; index < libraryData.length; index += 1) {
                const project = libraryData[index];
                const baseName = stripJsonExtension(toJsonFilename(project.name));
                const count = usedNames.get(baseName) || 0;
                usedNames.set(baseName, count + 1);
                const finalName = count ? `${baseName} (${count + 1}).json` : `${baseName}.json`;
                const payload = buildLibraryProjectExportPayload(project);
                zip.file(finalName, JSON.stringify(payload, null, 2));
                showProgress('Creating Library ZIP...', `${index + 1} of ${libraryData.length}`, (index + 1) / libraryData.length);
            }

            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'noise-studio-library.zip';
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (error) {
            console.error(error);
            showAlert(`Could not export the Library ZIP: ${error.message}`);
        } finally {
            hideProgress();
        }
    }

    async function triggerUpload() {
        refs.uploadInput.click();
    }

    async function handleUpload(files) {
        if (!files.length) return;

        try {
            const importPackages = [];
            for (const file of files) {
                const parsedPackage = await parseUploadFile(file);
                if (!parsedPackage) return;
                importPackages.push(parsedPackage);
            }

            const allEntries = importPackages.flatMap((entry) => entry.entries || []);
            const importedCatalog = normalizeTagList(importPackages.flatMap((entry) => entry.tags || []));
            const containsLibraryBundle = importPackages.some((entry) => entry.kind === 'library-bundle');

            if (!allEntries.length && !importedCatalog.length) {
                showAlert('No Library data was found in those JSON files.');
                return;
            }

            let replaceExisting = false;
            if (libraryData.length && containsLibraryBundle) {
                const replaceMode = await promptReplaceMode(allEntries.length);
                if (!replaceMode) return;
                replaceExisting = replaceMode === 'replace';
                if (replaceExisting) {
                    const saveChoice = await promptSaveBeforeReplace();
                    if (!saveChoice) return;
                    if (saveChoice === 'save') {
                        const didSave = await saveLibraryWorkflow({ defaultName: buildDefaultLibraryFilename('noise-studio-library backup') });
                        if (!didSave) return;
                    }
                }
            }

            if (replaceExisting) {
                selectedProjectId = null;
                clearProjectSelection();
                closeDetail();
                setFullscreenEnabled(false);
                await actions.clearLibraryProjects?.();
                await actions.setLibraryTagCatalog?.([]);
            }

            if (allEntries.length) {
                await actions.processLibraryPayloads(
                    allEntries.map((entry) => entry.text),
                    allEntries.map((entry) => entry.name),
                    ({ phase, count = 0, total = allEntries.length, filename = '' }) => {
                        if (phase === 'start') {
                            showProgress('Rendering Library projects...', `0 of ${total}`, 0);
                        } else if (phase === 'progress') {
                            const safeFilename = filename ? ` | ${filename}` : '';
                            showProgress('Rendering Library projects...', `${count} of ${total}${safeFilename}`, total ? count / total : 0);
                        } else if (phase === 'complete') {
                            showProgress('Finalizing Library import...', `${total} file${total === 1 ? '' : 's'}`, 1);
                        }
                    }
                );
            }

            const nextCatalog = normalizeTagList([
                ...(replaceExisting ? [] : libraryTags),
                ...importedCatalog
            ]);
            if (actions.setLibraryTagCatalog) {
                await actions.setLibraryTagCatalog(nextCatalog);
            }

            await refresh();
        } catch (error) {
            console.error(error);
            showAlert(error.message || 'The Library JSON import failed.');
        } finally {
            hideProgress();
            refs.uploadInput.value = '';
        }
    }

    async function deleteProject(id) {
        const project = libraryData.find((item) => item.id === id);
        if (!project) return;

        showModal({
            text: `Delete "${project.name}" from the Library?`,
            confirmLabel: 'Delete',
            isDanger: true,
            onConfirm: async () => {
                if (detailData?.id === id) closeDetail();
                if (selectedProjectId === id) selectedProjectId = null;
                if (selectedProjectIds.has(id)) {
                    selectedProjectIds.delete(id);
                    updateSelectToggle();
                }
                await actions.deleteLibraryProject(id);
                await refresh();
            }
        });
    }

    async function deleteSelectedProjects() {
        const selectedProjects = getSelectedProjects();
        if (!selectedProjects.length) {
            showAlert('Select one or more Library projects first.');
            return;
        }

        showModal({
            text: `Delete ${selectedProjects.length} selected project${selectedProjects.length === 1 ? '' : 's'} from the Library?`,
            confirmLabel: 'Delete',
            isDanger: true,
            onConfirm: async () => {
                const ids = selectedProjects.map((item) => item.id);
                if (detailData && ids.includes(detailData.id)) closeDetail();
                if (selectedProjectId && ids.includes(selectedProjectId)) {
                    selectedProjectId = null;
                }
                clearProjectSelection();
                await actions.deleteLibraryProjects?.(ids);
                await refresh();
            }
        });
    }

    async function clearAll() {
        if (!libraryData.length) {
            showAlert('The Library is already empty.');
            return;
        }

        showModal({
            text: 'Clear every saved Library project? This cannot be undone.',
            confirmLabel: 'Clear Library',
            isDanger: true,
            onConfirm: async () => {
                selectedProjectId = null;
                clearProjectSelection();
                closeDetail();
                setFullscreenEnabled(false);
                await actions.clearLibraryProjects();
                await refresh();
            }
        });
    }

    async function loadProjectIntoEditor(project) {
        if (!project) return;
        const loaded = await actions.loadLibraryProject(project.payload, project.id, project.name);
        if (loaded) closeDetail();
    }

    function handleGlobalPointerDown(event) {
        if (!isSidePanelOpen) return;
        const target = event.target;
        if (modalState && refs.modalOverlay.contains(target)) return;
        if (refs.sidePanel.contains(target) || refs.sideTab.contains(target) || refs.toolbar.contains(target)) return;
        suppressOutsideClick = true;
        event.preventDefault();
        event.stopPropagation();
        setSidePanelOpen(false);
    }

    function handleGlobalKeyDown(event) {
        if (event.key !== 'Escape') return;
        if (modalState) {
            cancelModal();
            return;
        }
        if (detailData) {
            closeDetail();
            return;
        }
        if (isSidePanelOpen) {
            setSidePanelOpen(false);
        }
    }

    refs.detailOverlay.addEventListener('click', (event) => {
        if (event.target === refs.detailOverlay) closeDetail();
    });

    refs.modalOverlay.addEventListener('click', (event) => {
        if (event.target === refs.modalOverlay && modalState?.closeOnOverlay && !modalState?.isAlert) {
            cancelModal();
        }
    });

    refs.fullscreenView.addEventListener('click', () => {
        if (!visibleLibraryData.length) return;
        currentIndex = (currentIndex + 1) % visibleLibraryData.length;
        updateFullscreen();
    });

    root.addEventListener('change', async (event) => {
        const target = event.target;

        if (target === refs.uploadInput) {
            await handleUpload(Array.from(refs.uploadInput.files || []));
            return;
        }

        if (target.matches('[data-library-role="sort-key"]')) {
            sortKey = target.value || 'timestamp';
            applyViewState();
        }
    });

    root.addEventListener('keydown', async (event) => {
        const target = event.target;
        if (modalState && event.key === 'Enter' && refs.modalOverlay.contains(target) && !target.matches('textarea')) {
            event.preventDefault();
            await confirmModal();
            return;
        }
        if (event.key !== 'Enter') return;
        if (target.matches('[data-library-role="create-tag-input"]')) {
            event.preventDefault();
            await createLibraryTagFromInput(target.value);
            target.value = '';
        }
    });

    root.addEventListener('click', async (event) => {
        if (suppressOutsideClick) {
            suppressOutsideClick = false;
            return;
        }

        const actionNode = event.target.closest('[data-library-action]');
        if (actionNode) {
            const action = actionNode.dataset.libraryAction;

            if (action === 'upload') {
                await triggerUpload();
                return;
            }

            if (action === 'toggle-select-mode') {
                setSelectModeEnabled(!isSelectMode);
                return;
            }

            if (action === 'toggle-hover') {
                setHoverEnabled(!isHoverEnabled);
                return;
            }

            if (action === 'toggle-fullscreen') {
                setFullscreenEnabled(!isFullscreen);
                return;
            }

            if (action === 'save-library') {
                await saveLibraryWorkflow();
                return;
            }

            if (action === 'export-zip') {
                await exportZip();
                return;
            }

            if (action === 'clear-all') {
                await clearAll();
                return;
            }

            if (action === 'delete-selected-projects') {
                await deleteSelectedProjects();
                return;
            }

            if (action === 'clear-selection') {
                clearProjectSelection();
                renderGrid();
                renderSidePanel();
                return;
            }

            if (action === 'delete-project') {
                await deleteProject(actionNode.dataset.libraryId);
                return;
            }

            if (action === 'toggle-side-panel') {
                setSidePanelOpen(!isSidePanelOpen);
                return;
            }

            if (action === 'close-side-panel') {
                setSidePanelOpen(false);
                return;
            }

            if (action === 'set-sort-direction') {
                sortDirection = actionNode.dataset.direction === 'asc' ? 'asc' : 'desc';
                applyViewState();
                return;
            }

            if (action === 'toggle-special-filter') {
                toggleSpecialTagMode(actionNode.dataset.mode || 'all');
                applyViewState();
                return;
            }

            if (action === 'toggle-tag-filter') {
                toggleTagFilter(actionNode.dataset.filter || '');
                applyViewState();
                return;
            }

            if (action === 'create-tag') {
                const input = refs.sideContent.querySelector('[data-library-role="create-tag-input"]');
                await createLibraryTagFromInput(input?.value || '');
                if (input) input.value = '';
                return;
            }

            if (action === 'toggle-pending-tag') {
                const tagKey = getTagKey(decodeTag(actionNode.dataset.libraryTag));
                if (!tagKey) return;
                if (pendingApplyTagKeys.has(tagKey)) pendingApplyTagKeys.delete(tagKey);
                else pendingApplyTagKeys.add(tagKey);
                renderSidePanel();
                return;
            }

            if (action === 'apply-pending-tags') {
                await applyPendingTagsToSelection();
                return;
            }

            if (action === 'remove-tag-from-selection') {
                const tag = decodeTag(actionNode.dataset.libraryTag);
                showModal({
                    text: `Remove "${tag}" from the selected images? The tag itself will remain available in the Library.`,
                    confirmLabel: 'Remove Tag',
                    onConfirm: async () => {
                        await removeTagFromSelection(tag);
                    }
                });
                return;
            }

            if (action === 'remove-tag-from-focused') {
                const tag = decodeTag(actionNode.dataset.libraryTag);
                showModal({
                    text: `Remove "${tag}" from this project? The tag itself will remain available in the Library.`,
                    confirmLabel: 'Remove Tag',
                    onConfirm: async () => {
                        await removeTagFromFocusedProject(tag);
                    }
                });
                return;
            }

            if (action === 'toggle-param-expand') {
                const paramId = actionNode.dataset.paramId;
                if (!paramId) return;
                if (expandedParamIds.has(paramId)) expandedParamIds.delete(paramId);
                else expandedParamIds.add(paramId);
                renderDetail();
                return;
            }

            if (action === 'open-selected-detail') {
                const project = getSelectedProject();
                if (project) openDetailByData(project);
                return;
            }

            if (action === 'load-selected-project') {
                await loadProjectIntoEditor(getSelectedProject());
                return;
            }

            if (action === 'close-detail') {
                closeDetail();
                return;
            }

            if (action === 'download-project') {
                downloadProject(detailData || getSelectedProject());
                return;
            }

            if (action === 'load-detail') {
                await loadProjectIntoEditor(detailData || getSelectedProject());
                return;
            }

            if (action === 'cancel-modal') {
                await cancelModal();
                return;
            }

            if (action === 'confirm-modal') {
                await confirmModal();
                return;
            }
        }

        const item = event.target.closest('.library-grid-item');
        if (!item || !refs.grid.contains(item)) return;

        const index = Number(item.dataset.libraryIndex || 0);
        const project = visibleLibraryData[index];
        if (!project) return;

        if (isSelectMode) {
            toggleProjectSelection(project.id);
            renderGrid();
            renderSidePanel();
            return;
        }

        selectedProjectId = project.id;
        currentIndex = index;
        openDetailByData(project);
    });

    document.addEventListener('pointerdown', handleGlobalPointerDown, true);
    document.addEventListener('keydown', handleGlobalKeyDown);

    setHoverEnabled(false);
    setFullscreenEnabled(false);
    setSidePanelOpen(false);
    renderSidePanel();

    return {
        activate() {
            root.style.display = 'block';
            refresh().catch((error) => {
                console.error(error);
                showAlert('Could not load Library projects.');
            });
        },
        deactivate() {
            root.style.display = 'none';
            setSidePanelOpen(false);
        },
        refresh
    };
}
