import { createThreeDAssetPreview } from '../3d/assetPreview.js';
import { didSaveFile, saveDataUrlLocally, saveJsonLocally, saveTextLocally, wasSaveCancelled } from '../io/localSave.js';
import { maybeYieldToUi, nextPaint } from './scheduling.js';
import {
    isSecureLibraryCompatibilityError,
    LIBRARY_ASSET_FOLDER_FORMAT,
    LIBRARY_EXPORT_FORMAT,
    LIBRARY_EXPORT_TYPE,
    LIBRARY_SECURE_EXPORT_FORMAT,
    LEGACY_LIBRARY_EXPORT_FORMAT
} from '../library/secureTransfer.js';

const SKIP_PARAMS = new Set(['_libraryName', '_libraryTags', '_libraryProjectType', '_libraryHoverSource', '_librarySourceArea', '_librarySourceCount']);

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

function sanitizeFileStem(name, fallback = 'library-item') {
    return String(name || fallback)
        .trim()
        .replace(/[<>:"/\\|?*]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        || fallback;
}

function formatCountLabel(count, singular, plural = `${singular}s`) {
    const safeCount = Number(count || 0);
    return `${safeCount} ${safeCount === 1 ? singular : plural}`;
}

function formatImportSummary(projectCount = 0, assetCount = 0) {
    const parts = [];
    if (projectCount) parts.push(formatCountLabel(projectCount, 'project'));
    if (assetCount) parts.push(formatCountLabel(assetCount, 'asset'));
    return parts.join(' and ') || '0 items';
}

function formatScopeLabel(scope) {
    if (scope === 'library') return 'Library';
    if (scope === 'assets') return 'Assets';
    return 'Library + Assets';
}

function getScopeDefaultBaseName(scope) {
    if (scope === 'library') return 'noise-studio-library';
    if (scope === 'assets') return 'noise-studio-assets';
    return 'noise-studio-library-package';
}

function getScopeDescription(scope, projectCount, assetCount) {
    if (scope === 'library') {
        return `${formatCountLabel(projectCount, 'project')} and Library tags.`;
    }
    if (scope === 'assets') {
        return `${formatCountLabel(assetCount, 'asset')} and Asset tags.`;
    }
    return `${formatCountLabel(projectCount, 'project')} plus ${formatCountLabel(assetCount, 'asset')} in one package.`;
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

function isThreeDPayload(payload) {
    return !!payload && (
        payload.kind === '3d-document'
        || payload.mode === '3d'
        || payload.schema === '3d-document'
    );
}

function inferProjectTypeFromPayload(payload, fallbackType = null) {
    if (fallbackType === 'composite' || payload?.kind === 'composite-document' || payload?.mode === 'composite') return 'composite';
    if (fallbackType === '3d' || isThreeDPayload(payload)) return '3d';
    if (fallbackType === 'stitch' || payload?.kind === 'stitch-document' || payload?.mode === 'stitch') return 'stitch';
    return 'studio';
}

function getProjectTypeLabel(projectType) {
    if (projectType === 'composite') return 'Composite';
    if (projectType === '3d') return '3D';
    return projectType === 'stitch' ? 'Stitch' : 'Editor';
}

function getProjectSourceLabel(projectType) {
    if (projectType === 'composite') return 'Canvas Size';
    return projectType === '3d' ? 'Preview Size' : 'Source Size';
}

function getProjectSourceCountLabel(projectType) {
    if (projectType === 'composite') return 'Layer Count';
    return projectType === '3d' ? 'Asset Count' : 'Source Count';
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
    const inferredType = inferProjectTypeFromPayload(normalized);
    if (!normalized.kind) {
        normalized.kind = inferredType === '3d'
            ? '3d-document'
            : inferredType === 'stitch'
                ? 'stitch-document'
                : 'document';
    }
    if (!normalized.mode) {
        normalized.mode = inferredType === '3d'
            ? '3d'
            : inferredType === 'stitch'
                ? 'stitch'
                : 'studio';
    }
    if (Array.isArray(normalized.layerStack)) {
        normalized.layerStack = normalized.layerStack.map((layer) => ({
            ...layer,
            params: { ...(layer?.params || {}) }
        }));
    }
    return normalized;
}

function buildLibraryProjectExportPayload(project) {
    const payload = normalizeLibraryDocumentPayload(project.payload);
    const inferredType = inferProjectTypeFromPayload(payload, project.projectType || null);
    if (payload?.preview && typeof payload.preview === 'object' && inferredType !== 'composite') {
        delete payload.preview.imageData;
        delete payload.preview.width;
        delete payload.preview.height;
        delete payload.preview.updatedAt;
        if (!Object.keys(payload.preview).length) {
            delete payload.preview;
        }
    }
    if (payload?.render && typeof payload.render === 'object') {
        delete payload.render.currentSamples;
    }
    delete payload.renderJob;
    return {
        _libraryName: project.name,
        _libraryTags: normalizeTagList(project.tags),
        _libraryProjectType: project.projectType || inferredType,
        _libraryHoverSource: project.hoverSource || null,
        _librarySourceArea: Number(project.sourceAreaOverride || project.sourceArea || 0) || 0,
        _librarySourceCount: Number(project.sourceCount || 0) || 0,
        ...payload
    };
}

function normalizeLibraryAssetType(assetType) {
    return String(assetType || '').toLowerCase() === 'model' ? 'model' : 'image';
}

function buildLibraryAssetExportPayload(asset) {
    return {
        id: asset.id || null,
        kind: 'library-asset',
        recordType: 'asset',
        timestamp: Number(asset.timestamp || Date.now()),
        name: String(asset.name || (normalizeLibraryAssetType(asset.assetType) === 'model' ? 'Model Asset' : 'Image Asset')),
        assetType: normalizeLibraryAssetType(asset.assetType),
        format: String(asset.format || ''),
        mimeType: String(asset.mimeType || ''),
        dataUrl: String(asset.dataUrl || ''),
        tags: normalizeTagList(asset.tags),
        width: Number(asset.width || 0),
        height: Number(asset.height || 0),
        sourceProjectId: asset.sourceProjectId || null,
        sourceProjectType: asset.sourceProjectType || null,
        sourceProjectName: asset.sourceProjectName || null,
        origin: asset.origin || 'library',
        assetFingerprint: asset.assetFingerprint || ''
    };
}

function buildLibraryAssetFolderManifest({
    assets = [],
    tagCatalog = [],
    name = 'noise-studio-assets'
} = {}) {
    const exportedAt = new Date().toISOString();
    return {
        type: LIBRARY_EXPORT_TYPE,
        format: LIBRARY_ASSET_FOLDER_FORMAT,
        version: 1,
        scope: 'assets',
        name: stripJsonExtension(name || 'noise-studio-assets') || 'noise-studio-assets',
        exportedAt,
        assetCount: (assets || []).length,
        tags: normalizeTagList(tagCatalog),
        assets: (assets || []).map((asset) => {
            const payload = buildLibraryAssetExportPayload(asset);
            delete payload.dataUrl;
            delete payload.previewDataUrl;
            return payload;
        })
    };
}

function buildLibraryExportBundle({
    projects = [],
    assets = [],
    tagCatalog = [],
    name = 'noise-studio-library',
    scope = 'combined'
} = {}) {
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
    const normalizedAssets = (assets || []).map((asset) => buildLibraryAssetExportPayload(asset));

    return {
        type: LIBRARY_EXPORT_TYPE,
        format: LIBRARY_EXPORT_FORMAT,
        version: 2,
        scope: scope === 'library' || scope === 'assets' ? scope : 'combined',
        name: stripJsonExtension(name || 'noise-studio-library') || 'noise-studio-library',
        exportedAt,
        projectCount: normalizedProjects.length,
        assetCount: normalizedAssets.length,
        tags: normalizeTagList(tagCatalog),
        projects: normalizedProjects,
        assets: normalizedAssets
    };
}

function isPlainLibraryExportPayload(parsed) {
    return !!parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && parsed.type === LIBRARY_EXPORT_TYPE
        && (parsed.format === LIBRARY_EXPORT_FORMAT || parsed.format === LEGACY_LIBRARY_EXPORT_FORMAT);
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
        _libraryProjectType: rawPayload?._libraryProjectType || inferProjectTypeFromPayload(payload),
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

function isLibraryAssetPayload(parsed) {
    return !!parsed
        && typeof parsed === 'object'
        && !Array.isArray(parsed)
        && (parsed.recordType === 'asset' || parsed.kind === 'library-asset');
}

function createImportAssetEntryFromPayload(rawAsset, fallbackName, index = 0, explicitTags = null) {
    const dataUrl = String(rawAsset?.dataUrl || '');
    if (!dataUrl) return null;
    return {
        name: String(rawAsset?.name || fallbackName || `Asset ${index + 1}`),
        tags: normalizeTagList(explicitTags || rawAsset?.tags || []),
        asset: {
            id: rawAsset?.id || null,
            timestamp: Number(rawAsset?.timestamp || Date.parse(rawAsset?.savedAt || '') || Date.now()),
            name: String(rawAsset?.name || fallbackName || `Asset ${index + 1}`),
            assetType: normalizeLibraryAssetType(rawAsset?.assetType),
            format: String(rawAsset?.format || ''),
            mimeType: String(rawAsset?.mimeType || ''),
            dataUrl,
            previewDataUrl: String(rawAsset?.previewDataUrl || ''),
            width: Number(rawAsset?.width || rawAsset?.sourceSize?.width || 0),
            height: Number(rawAsset?.height || rawAsset?.sourceSize?.height || 0),
            sourceProjectId: rawAsset?.sourceProjectId || null,
            sourceProjectType: rawAsset?.sourceProjectType || null,
            sourceProjectName: rawAsset?.sourceProjectName || null,
            origin: rawAsset?.origin || 'import',
            assetFingerprint: rawAsset?.assetFingerprint || ''
        }
    };
}

function extractLibraryImportBundle(parsed, fallbackName) {
    if (isPlainLibraryExportPayload(parsed)) {
        const projects = Array.isArray(parsed.projects) ? parsed.projects : [];
        const assets = Array.isArray(parsed.assets) ? parsed.assets : [];
        const projectEntries = projects.map((project, index) => createImportEntryFromPayload(
            project?.payload || project,
            project?.name || `${fallbackName} ${index + 1}`,
            index,
            project?.tags || project?.payload?._libraryTags
        ));
        const assetEntries = assets.map((asset, index) => createImportAssetEntryFromPayload(
            asset,
            asset?.name || `${fallbackName} Asset ${index + 1}`,
            index,
            asset?.tags
        )).filter(Boolean);
        const importedTags = normalizeTagList([
            ...(parsed.tags || []),
            ...projectEntries.flatMap((entry) => entry.tags),
            ...assetEntries.flatMap((entry) => entry.tags)
        ]);
        return {
            kind: 'library-bundle',
            sourceFormat: parsed.format,
            bundleName: stripJsonExtension(parsed.name || fallbackName) || 'noise-studio-library',
            exportedAt: parsed.exportedAt || null,
            scope: parsed.scope || (assetEntries.length && projectEntries.length ? 'combined' : assetEntries.length ? 'assets' : 'library'),
            projectEntries,
            assetEntries,
            tags: importedTags
        };
    }

    if (Array.isArray(parsed)) {
        const projectEntries = parsed.map((entry, index) => createImportEntryFromPayload(
            entry,
            `${fallbackName} ${index + 1}`,
            index
        ));
        return {
            kind: 'library-bundle',
            sourceFormat: 'legacy-array',
            bundleName: stripJsonExtension(fallbackName) || 'noise-studio-library',
            exportedAt: null,
            scope: 'library',
            projectEntries,
            assetEntries: [],
            tags: normalizeTagList(projectEntries.flatMap((entry) => entry.tags))
        };
    }

    if (isLibraryAssetPayload(parsed)) {
        const assetEntry = createImportAssetEntryFromPayload(parsed, fallbackName, 0, parsed.tags);
        return {
            kind: 'single-asset',
            sourceFormat: 'single-asset',
            bundleName: stripJsonExtension(fallbackName) || 'library-asset',
            exportedAt: null,
            scope: 'assets',
            projectEntries: [],
            assetEntries: assetEntry ? [assetEntry] : [],
            tags: normalizeTagList(parsed?.tags || [])
        };
    }

    return {
        kind: 'single-project',
        sourceFormat: 'single-project',
        bundleName: stripJsonExtension(fallbackName) || 'library-project',
        exportedAt: null,
        scope: 'library',
        projectEntries: [createImportEntryFromPayload(parsed, fallbackName, 0)],
        assetEntries: [],
        tags: normalizeTagList(parsed?._libraryTags || parsed?.tags || [])
    };
}

async function downloadJsonFile(payload, filename, options = {}) {
    return saveJsonLocally(payload, toJsonFilename(stripJsonExtension(filename)), {
        title: options.title || 'Save JSON',
        buttonLabel: options.buttonLabel || 'Save JSON',
        pretty: options.pretty !== false,
        filters: [{ name: 'JSON File', extensions: ['json'] }]
    });
}

async function downloadJsonTextFile(text, filename, options = {}) {
    return saveTextLocally(String(text || ''), toJsonFilename(stripJsonExtension(filename)), {
        title: options.title || 'Save JSON',
        buttonLabel: options.buttonLabel || 'Save JSON',
        filters: [{ name: 'JSON File', extensions: ['json'] }]
    });
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

function normalizeAssetMimeType(format, mimeType, assetType = 'image') {
    const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
    if (normalizedMimeType) return normalizedMimeType;
    const normalizedFormat = String(format || '').trim().toLowerCase();
    if (assetType === 'model') {
        if (normalizedFormat === 'gltf') return 'model/gltf+json';
        return 'model/gltf-binary';
    }
    if (normalizedFormat === 'jpg' || normalizedFormat === 'jpeg') return 'image/jpeg';
    if (normalizedFormat === 'webp') return 'image/webp';
    if (normalizedFormat === 'gif') return 'image/gif';
    if (normalizedFormat === 'svg') return 'image/svg+xml';
    return 'image/png';
}

function getAssetFileExtension(asset) {
    const normalizedFormat = String(asset?.format || '').trim().toLowerCase();
    if (normalizedFormat === 'glb' || normalizedFormat === 'gltf') return normalizedFormat;
    if (normalizedFormat === 'jpg' || normalizedFormat === 'jpeg') return 'jpg';
    if (normalizedFormat === 'webp') return 'webp';
    if (normalizedFormat === 'gif') return 'gif';
    if (normalizedFormat === 'svg') return 'svg';
    const mimeType = String(asset?.mimeType || '').toLowerCase();
    if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
    if (mimeType.includes('webp')) return 'webp';
    if (mimeType.includes('gif')) return 'gif';
    if (mimeType.includes('svg')) return 'svg';
    if (mimeType.includes('gltf')) return normalizedFormat === 'gltf' ? 'gltf' : 'glb';
    return asset?.assetType === 'model' ? 'glb' : 'png';
}

async function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(blob);
    });
}

function parseDataUrl(dataUrl) {
    const source = String(dataUrl || '');
    if (!source.startsWith('data:')) return null;
    const commaIndex = source.indexOf(',');
    if (commaIndex < 0) {
        throw new Error('Invalid data URL.');
    }
    const meta = source.slice(5, commaIndex);
    const payload = source.slice(commaIndex + 1);
    const parts = meta.split(';').filter(Boolean);
    const isBase64 = parts.some((part) => part.toLowerCase() === 'base64');
    const mimeType = String(parts.find((part) => part.toLowerCase() !== 'base64') || 'application/octet-stream').trim() || 'application/octet-stream';
    return {
        mimeType,
        isBase64,
        payload
    };
}

function base64ToUint8Array(base64) {
    const normalized = String(base64 || '').replace(/\s+/g, '');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

async function dataUrlToBlob(dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (parsed) {
        const bytes = parsed.isBase64
            ? base64ToUint8Array(parsed.payload)
            : new TextEncoder().encode(parsed.payload.includes('%') ? decodeURIComponent(parsed.payload) : parsed.payload);
        return new Blob([bytes], { type: parsed.mimeType });
    }
    const response = await fetch(String(dataUrl || ''));
    return response.blob();
}

function inferAssetFileMeta(fileName, mimeType = '') {
    const extension = String(fileName || '').trim().toLowerCase().split('.').pop() || '';
    const normalizedMime = String(mimeType || '').trim().toLowerCase();

    if (extension === 'glb' || extension === 'gltf' || normalizedMime.includes('model/gltf')) {
        return {
            assetType: 'model',
            format: extension === 'gltf' ? 'gltf' : 'glb',
            mimeType: normalizeAssetMimeType(extension, normalizedMime, 'model')
        };
    }

    const imageExtension = extension === 'jpeg' ? 'jpg' : extension;
    const supportedImageExtensions = new Set(['png', 'jpg', 'webp', 'gif', 'svg']);
    if (supportedImageExtensions.has(imageExtension) || normalizedMime.startsWith('image/')) {
        const inferredFormat = supportedImageExtensions.has(imageExtension)
            ? imageExtension
            : (normalizedMime.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('+xml', '');
        return {
            assetType: 'image',
            format: inferredFormat || 'png',
            mimeType: normalizeAssetMimeType(inferredFormat, normalizedMime, 'image')
        };
    }

    return null;
}

async function collectDirectoryFiles(directoryHandle, prefix = '') {
    const entries = [];
    for await (const handle of directoryHandle.values()) {
        const path = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (handle.kind === 'file') {
            entries.push({ handle, path });
            continue;
        }
        if (handle.kind === 'directory') {
            entries.push(...await collectDirectoryFiles(handle, path));
        }
    }
    return entries;
}

async function getNestedFileHandle(directoryHandle, relativePath) {
    const parts = String(relativePath || '').split('/').filter(Boolean);
    if (!parts.length) return null;
    let current = directoryHandle;
    for (let index = 0; index < parts.length - 1; index += 1) {
        current = await current.getDirectoryHandle(parts[index]);
    }
    return current.getFileHandle(parts[parts.length - 1]);
}

async function writeDirectoryFile(directoryHandle, fileName, content) {
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
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

export function createLibraryPanel(root, { actions, layerDefaults = {}, logger = null }) {
    root.innerHTML = `
        <div class="library-panel-shell">
            <div class="toolbar library-toolbar">
                <div class="library-toolbar-page">
                    <div class="library-toolbar-title">Library Page</div>
                    <div class="library-page-tabs" data-library-role="page-tabs">
                        <button type="button" class="mode-button is-active" data-library-action="set-page-mode" data-mode="library">Library</button>
                        <button type="button" class="mode-button" data-library-action="set-page-mode" data-mode="assets">Assets</button>
                    </div>
                </div>
                <button type="button" class="toolbar-button" data-library-action="upload">Import JSON</button>
                <button type="button" class="toolbar-button" data-library-action="import-folder" data-library-role="folder-import-button">Import Folder</button>
                <button type="button" class="toolbar-button" data-library-action="toggle-select-mode" aria-pressed="false">Select</button>
                <button type="button" class="toolbar-button" data-library-action="toggle-hover" aria-pressed="false">Compare Source</button>
                <button type="button" class="toolbar-button" data-library-action="toggle-fullscreen" aria-pressed="false">Focus View</button>
                <button type="button" class="toolbar-button" data-library-action="save-library" data-library-role="save-button">Save Library</button>
                <button type="button" class="toolbar-button" data-library-action="export-zip" data-library-role="zip-button">Export ZIP</button>
                <button type="button" class="toolbar-button" data-library-action="export-folder" data-library-role="folder-export-button">Export Folder</button>
                <button type="button" class="toolbar-button" data-library-action="clear-all" data-library-role="clear-button">Clear Library</button>
            </div>
            <div class="library-content">
                <input type="file" accept=".json,application/json" multiple hidden data-library-role="upload-input">
                <div class="library-grid-view">
                    <div class="library-grid-mode library-project-grid is-active" data-library-role="project-grid"></div>
                    <div class="library-grid-mode library-asset-grid" data-library-role="asset-grid"></div>
                </div>
                <div class="library-empty-state">
                    <strong data-library-role="empty-title">Library is empty</strong>
                    <span data-library-role="empty-text">Save projects from Editor, Composite, Stitch, or 3D, or import JSON files to build your gallery.</span>
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
                <p class="library-status-text">Preparing Library...</p>
                <p class="library-count-text"></p>
                <div class="library-progress-bar">
                    <div class="library-progress-fill"></div>
                </div>
                <div class="library-loading-log-shell">
                    <div class="library-loading-log-head">
                        <span>Live Library Log</span>
                        <span>Same feed as Logs</span>
                    </div>
                    <div class="library-loading-log-lines" data-library-role="loading-log-lines"></div>
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
                        <div class="library-asset-preview-shell" data-library-role="asset-preview-shell">
                            <div class="library-asset-preview-host" data-library-role="asset-preview-host"></div>
                        </div>
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
                            <button type="button" class="toolbar-button" data-library-action="download-asset">Download Asset</button>
                            <button type="button" class="toolbar-button" data-library-action="rename-asset">Rename Asset</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

    const refs = {
        shell: root.querySelector('.library-panel-shell'),
        toolbar: root.querySelector('.library-toolbar'),
        pageTabs: root.querySelector('[data-library-role="page-tabs"]'),
        content: root.querySelector('.library-content'),
        grid: root.querySelector('.library-grid-view'),
        projectGrid: root.querySelector('[data-library-role="project-grid"]'),
        assetGrid: root.querySelector('[data-library-role="asset-grid"]'),
        empty: root.querySelector('.library-empty-state'),
        emptyTitle: root.querySelector('[data-library-role="empty-title"]'),
        emptyText: root.querySelector('[data-library-role="empty-text"]'),
        uploadInput: root.querySelector('[data-library-role="upload-input"]'),
        folderImportButton: root.querySelector('[data-library-role="folder-import-button"]'),
        selectToggle: root.querySelector('[data-library-action="toggle-select-mode"]'),
        hoverToggle: root.querySelector('[data-library-action="toggle-hover"]'),
        fullscreenToggle: root.querySelector('[data-library-action="toggle-fullscreen"]'),
        saveButton: root.querySelector('[data-library-role="save-button"]'),
        zipButton: root.querySelector('[data-library-role="zip-button"]'),
        folderExportButton: root.querySelector('[data-library-role="folder-export-button"]'),
        clearButton: root.querySelector('[data-library-role="clear-button"]'),
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
        loadingLogLines: root.querySelector('[data-library-role="loading-log-lines"]'),
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
        detailHover: root.querySelector('.library-detail-image-pane .library-img-hover'),
        detailAssetPreviewShell: root.querySelector('[data-library-role="asset-preview-shell"]'),
        detailAssetPreviewHost: root.querySelector('[data-library-role="asset-preview-host"]')
    };

    let libraryData = [];
    let visibleLibraryData = [];
    let assetData = [];
    let visibleAssetData = [];
    let libraryTags = [];
    let activePageMode = 'library';
    let isHoverEnabled = false;
    let isFullscreen = false;
    let isSidePanelOpen = false;
    let isSelectMode = false;
    let currentIndex = 0;
    let detailData = null;
    let selectedProjectId = null;
    let selectedProjectIds = new Set();
    let selectedAssetId = null;
    let selectedAssetIds = new Set();
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
    let assetPreview = null;
    let detailPreviewToken = 0;
    let panelActive = false;
    let pendingRefreshWhileInactive = false;
    const gridMarkupSignatureByMode = { library: '', assets: '' };
    const gridStateSignatureByMode = { library: '', assets: '' };
    let lastProgressLogSignature = '';

    function getSettings() {
        return actions.getState?.()?.settings || null;
    }

    function getLibrarySettings() {
        return getSettings()?.library || {};
    }

    function applyLibraryPreferenceDefaults() {
        const settings = getLibrarySettings();
        sortKey = settings.defaultSortKey || 'timestamp';
        sortDirection = settings.defaultSortDirection || 'desc';
        refs.shell.classList.toggle('is-list-layout', settings.defaultViewLayout === 'list');
        if (assetPreview && typeof assetPreview.setQuality === 'function') {
            assetPreview.setQuality(settings.assetPreviewQuality || 'balanced');
        }
    }

    function logLibrary(level, processId, message, progressOrOptions = {}, maybeOptions = {}) {
        if (!logger || !message) return;
        const label = processId === 'library.import'
            ? 'Library Import'
            : processId === 'library.export'
                ? 'Library Export'
                : processId === 'library.assets'
                    ? 'Library Assets'
                    : 'Library Sync';
        if (level === 'progress' && typeof logger.progress === 'function') {
            logger.progress(processId, label, message, progressOrOptions, maybeOptions);
            return;
        }
        const method = typeof logger[level] === 'function'
            ? logger[level].bind(logger)
            : logger.info.bind(logger);
        method(processId, label, message, progressOrOptions);
    }

    function formatLoadingOverlayTime(timestamp) {
        if (!timestamp) return '--:--:--';
        try {
            return new Date(timestamp).toLocaleTimeString();
        } catch (_error) {
            return '--:--:--';
        }
    }

    function collectLoadingOverlayLogs(limit = 6) {
        if (typeof logger?.getSnapshot !== 'function') return [];
        return logger.getSnapshot()
            .filter((process) => String(process?.id || '').startsWith('library.'))
            .flatMap((process) => (process.entries || []).map((entry) => ({
                ...entry,
                processLabel: process.label || 'Library'
            })))
            .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0))
            .slice(-Math.max(1, Number(limit) || 6));
    }

    function renderLoadingOverlayLogs() {
        if (!refs.loadingLogLines) return;
        const lines = collectLoadingOverlayLogs(6);
        refs.loadingLogLines.innerHTML = lines.length
            ? lines.map((entry) => `
                <div class="library-loading-log-line" data-level="${escapeHtml(entry.level || 'info')}">
                    <span class="library-loading-log-time">${escapeHtml(formatLoadingOverlayTime(entry.timestamp))}</span>
                    <span class="library-loading-log-text">${escapeHtml(`${entry.processLabel}: ${entry.message || 'Status updated.'}`)}</span>
                </div>
            `).join('')
            : '<div class="library-loading-log-empty">Library activity details will appear here while the overlay is active.</div>';
    }

    if (typeof logger?.subscribeEvents === 'function') {
        logger.subscribeEvents((event) => {
            if (!String(event?.processId || '').startsWith('library.')) return;
            renderLoadingOverlayLogs();
        });
    }

    function getLibraryProcessId(message = '') {
        const normalized = String(message || '').trim().toLowerCase();
        if (
            normalized.includes('import')
            || normalized.includes('scanning asset folder')
            || normalized.includes('rendering library projects')
        ) {
            return 'library.import';
        }
        if (
            normalized.includes('export')
            || normalized.includes('zip')
            || normalized.includes('packing')
            || normalized.includes('saving export')
        ) {
            return 'library.export';
        }
        return 'library.sync';
    }

    function scopeIncludesProjects(scope) {
        return scope === 'library' || scope === 'combined';
    }

    function scopeIncludesAssets(scope) {
        return scope === 'assets' || scope === 'combined';
    }

    function isAssetsPage() {
        return activePageMode === 'assets';
    }

    function getActiveExportScope() {
        return isAssetsPage() ? 'assets' : 'library';
    }

    function getCurrentData() {
        return isAssetsPage() ? assetData : libraryData;
    }

    function getVisibleCurrentData() {
        return isAssetsPage() ? visibleAssetData : visibleLibraryData;
    }

    function getSelectedPrimaryId() {
        return isAssetsPage() ? selectedAssetId : selectedProjectId;
    }

    function setSelectedPrimaryId(id) {
        if (isAssetsPage()) selectedAssetId = id || null;
        else selectedProjectId = id || null;
    }

    function getSelectedIdSet() {
        return isAssetsPage() ? selectedAssetIds : selectedProjectIds;
    }

    function setSelectedIdSet(nextSet) {
        if (isAssetsPage()) selectedAssetIds = nextSet;
        else selectedProjectIds = nextSet;
    }

    function getDataForScope(scope) {
        return {
            projects: scopeIncludesProjects(scope) ? libraryData : [],
            assets: scopeIncludesAssets(scope) ? assetData : []
        };
    }

    function getTagCatalogForScope(scope) {
        const { projects, assets } = getDataForScope(scope);
        return normalizeTagList([
            ...libraryTags,
            ...projects.flatMap((item) => item.tags || []),
            ...assets.flatMap((item) => item.tags || [])
        ]);
    }

    function getExportCounts(scope) {
        const { projects, assets } = getDataForScope(scope);
        return {
            projectCount: projects.length,
            assetCount: assets.length
        };
    }

    function buildExportBundleForScope(scope, filename) {
        const { projects, assets } = getDataForScope(scope);
        return buildLibraryExportBundle({
            projects,
            assets,
            tagCatalog: getTagCatalogForScope(scope),
            name: stripJsonExtension(filename || getScopeDefaultBaseName(scope)),
            scope
        });
    }

    function getSurvivingTagsForReplace(scope) {
        const survivingTags = [];
        if (!scopeIncludesProjects(scope)) {
            survivingTags.push(...libraryData.flatMap((item) => item.tags || []));
        }
        if (!scopeIncludesAssets(scope)) {
            survivingTags.push(...assetData.flatMap((item) => item.tags || []));
        }
        return normalizeTagList(survivingTags);
    }

    function resetScopeUiState(scope) {
        if (scopeIncludesProjects(scope)) {
            selectedProjectId = null;
            selectedProjectIds = new Set();
            if (!isAssetsPage()) {
                closeDetail();
                setFullscreenEnabled(false);
            }
        }
        if (scopeIncludesAssets(scope)) {
            selectedAssetId = null;
            selectedAssetIds = new Set();
            if (isAssetsPage()) {
                closeDetail();
            }
        }
        pendingApplyTagKeys = new Set();
        updateSelectToggle();
    }

    function getSelectedProject() {
        return getCurrentData().find((item) => item.id === getSelectedPrimaryId()) || null;
    }

    function getSelectedProjects() {
        const selectedIds = getSelectedIdSet();
        return getCurrentData().filter((item) => selectedIds.has(item.id));
    }

    function getSelectedProjectIds() {
        return [...getSelectedIdSet()];
    }

    function getTagSummaries() {
        const map = new Map(libraryTags.map((tag) => [getTagKey(tag), { key: getTagKey(tag), tag, count: 0 }]));
        for (const item of getCurrentData()) {
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
        const selectionCount = getSelectedIdSet().size;
        refs.selectToggle.setAttribute('aria-pressed', isSelectMode ? 'true' : 'false');
        refs.selectToggle.textContent = selectionCount ? `Select (${selectionCount})` : 'Select';
        refs.shell.classList.toggle('is-select-mode', isSelectMode);
    }

    function setSelectModeEnabled(enabled) {
        isSelectMode = Boolean(enabled);
        updateSelectToggle();
    }

    function clearProjectSelection() {
        if (isAssetsPage()) selectedAssetIds = new Set();
        else selectedProjectIds = new Set();
        pendingApplyTagKeys = new Set();
        updateSelectToggle();
    }

    function toggleProjectSelection(id) {
        if (!id) return;
        const nextSelection = new Set(getSelectedIdSet());
        if (nextSelection.has(id)) nextSelection.delete(id);
        else nextSelection.add(id);
        setSelectedIdSet(nextSelection);
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

    function getFilteredSortedData(data, pageMode = 'library') {
        const filtered = (data || []).filter((item) => {
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
                comparison = pageMode === 'assets'
                    ? getImageArea(a.width, a.height) - getImageArea(b.width, b.height)
                    : (a.sourceArea || 0) - (b.sourceArea || 0);
                if (comparison === 0) {
                    comparison = pageMode === 'assets'
                        ? compareByDimensions(a.width, a.height, b.width, b.height)
                        : compareByDimensions(a.sourceWidth, a.sourceHeight, b.sourceWidth, b.sourceHeight);
                }
            } else if (sortKey === 'render-area') {
                comparison = pageMode === 'assets'
                    ? getImageArea(a.width, a.height) - getImageArea(b.width, b.height)
                    : (a.renderArea || 0) - (b.renderArea || 0);
                if (comparison === 0) {
                    comparison = pageMode === 'assets'
                        ? compareByDimensions(a.width, a.height, b.width, b.height)
                        : compareByDimensions(a.renderWidth, a.renderHeight, b.renderWidth, b.renderHeight);
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

    function getVisibleLibraryData() {
        return getFilteredSortedData(libraryData, 'library');
    }

    function getVisibleAssetData() {
        return getFilteredSortedData(assetData, 'assets');
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

    function updateToolbarState() {
        refs.shell.classList.toggle('is-assets-mode', isAssetsPage());
        refs.pageTabs.querySelectorAll('[data-mode]').forEach((node) => {
            node.classList.toggle('is-active', node.dataset.mode === activePageMode);
        });
        refs.hoverToggle.style.display = isAssetsPage() ? 'none' : '';
        refs.fullscreenToggle.style.display = isAssetsPage() ? 'none' : '';
        refs.zipButton.style.display = isAssetsPage() ? 'none' : '';
        refs.folderImportButton.style.display = isAssetsPage() ? '' : 'none';
        refs.folderExportButton.style.display = isAssetsPage() ? '' : 'none';
        refs.saveButton.textContent = isAssetsPage() ? 'Save Assets' : 'Save Library';
        refs.clearButton.textContent = isAssetsPage() ? 'Clear Assets' : 'Clear Library';
    }

    function updateGridModeVisibility() {
        refs.projectGrid?.classList.toggle('is-active', !isAssetsPage());
        refs.assetGrid?.classList.toggle('is-active', isAssetsPage());
    }

    function setActivePageMode(mode) {
        const nextMode = mode === 'assets' ? 'assets' : 'library';
        if (activePageMode === nextMode) return;
        activePageMode = nextMode;
        logLibrary('info', 'library.sync', `Switched the Library page to ${nextMode === 'assets' ? 'Assets' : 'Library'} mode.`, {
            dedupeKey: `library-page-mode:${nextMode}`,
            dedupeWindowMs: 120
        });
        detailData = null;
        expandedParamIds = new Set();
        if (isFullscreen) {
            setFullscreenEnabled(false);
        }
        if (isHoverEnabled && isAssetsPage()) {
            setHoverEnabled(false);
        }
        updateToolbarState();
        applyViewState();
    }

    function getAssetDownloadExtension(asset) {
        return getAssetFileExtension(asset);
    }

    async function downloadAssetFile(asset) {
        if (!asset?.dataUrl) return false;
        const fileName = `${sanitizeFileStem(stripJsonExtension(asset.name || 'library-asset'), 'library-asset')}.${getAssetDownloadExtension(asset)}`;
        const saveResult = await saveDataUrlLocally(asset.dataUrl, fileName, {
            title: 'Save Library Asset',
            buttonLabel: 'Save Asset',
            filters: [{ name: 'Library Asset', extensions: [getAssetDownloadExtension(asset)] }]
        });
        if (wasSaveCancelled(saveResult)) {
            logLibrary('info', 'library.export', `Cancelled Library asset save for "${asset.name || fileName}".`);
            return false;
        }
        if (!didSaveFile(saveResult)) {
            const message = saveResult?.error || `Could not save "${asset.name || fileName}".`;
            logLibrary('error', 'library.export', message);
            showAlert(message);
            return false;
        }
        logLibrary('success', 'library.export', `Saved Library asset "${asset.name || fileName}".`);
        return true;
    }

    function ensureAssetPreview() {
        if (!assetPreview && refs.detailAssetPreviewHost) {
            assetPreview = createThreeDAssetPreview(refs.detailAssetPreviewHost, {
                quality: getLibrarySettings().assetPreviewQuality || 'balanced'
            });
        }
        return assetPreview;
    }

    function clearAssetPreview() {
        detailPreviewToken += 1;
        refs.detailAssetPreviewShell?.classList.remove('is-visible');
        assetPreview?.clear?.();
    }

    async function loadAssetPreview(asset) {
        clearAssetPreview();
        if (!asset?.dataUrl || asset.assetType !== 'model') return;
        const token = ++detailPreviewToken;
        refs.detailAssetPreviewShell?.classList.add('is-visible');
        showProgress('Loading asset preview...', asset.name || '3D asset', 0.3);
        try {
            const preview = ensureAssetPreview();
            await preview.loadAsset(asset);
            if (token !== detailPreviewToken) return;
        } catch (error) {
            clearAssetPreview();
            throw error;
        } finally {
            hideProgress();
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

        if (payload?.kind === 'composite-document' || payload?.mode === 'composite') {
            const layers = Array.isArray(payload.layers) ? payload.layers : [];
            const editorLayers = layers.filter((layer) => layer?.kind === 'editor-project');
            const imageLayers = layers.filter((layer) => layer?.kind === 'image');
            return `
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>Composite Layers</strong>
                        <span>${layers.length} total</span>
                    </div>
                    <div class="library-layer-card-body">
                        ${layers.length ? layers
                            .slice()
                            .sort((a, b) => Number(b?.z || 0) - Number(a?.z || 0))
                            .map((layer) => `
                                <div class="library-param-row">
                                    <span class="library-param-key">${escapeHtml(layer?.name || 'Layer')}</span>
                                    <span class="library-param-val">${escapeHtml([
                                        layer?.kind === 'editor-project' ? 'Editor' : 'Image',
                                        layer?.blendMode || 'normal',
                                        `${Math.round((Number(layer?.opacity || 1) || 1) * 100)}%`
                                    ].join(' | '))}</span>
                                </div>
                            `).join('')
                            : '<div class="library-detail-empty">This Composite project did not include any saved layers.</div>'}
                    </div>
                </section>
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>Composite Summary</strong>
                        <span>${editorLayers.length} Editor / ${imageLayers.length} Image</span>
                    </div>
                    <div class="library-layer-card-body">
                        <div class="library-param-row">
                            <span class="library-param-key">Sidebar View</span>
                            <span class="library-param-val">${escapeHtml(payload.workspace?.sidebarView || 'layers')}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Selected Layer</span>
                            <span class="library-param-val">${escapeHtml(payload.selection?.layerId || 'None')}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Checker Background</span>
                            <span class="library-param-val">${escapeHtml(payload.view?.showChecker === false ? 'Off' : 'On')}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Zoom</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(payload.view?.zoom || 1))}</span>
                        </div>
                    </div>
                </section>
            `;
        }

        if (isThreeDPayload(payload)) {
            const items = Array.isArray(payload.scene?.items) ? payload.scene.items : [];
            const models = items.filter((item) => item.kind === 'model');
            const imagePlanes = items.filter((item) => item.kind === 'image-plane');
            const primitives = items.filter((item) => item.kind === 'primitive');
            const lights = items.filter((item) => item.kind === 'light');
            const renderSettings = payload.render && typeof payload.render === 'object' ? payload.render : {};
            const viewSettings = payload.view && typeof payload.view === 'object' ? payload.view : {};
            return `
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>Scene Items</strong>
                        <span>${items.length} total</span>
                    </div>
                    <div class="library-layer-card-body">
                        ${items.length ? items.map((item) => `
                            <div class="library-param-row">
                                <span class="library-param-key">${escapeHtml(item.name || (item.kind === 'light' ? 'Light' : 'Model'))}</span>
                                <span class="library-param-val">${escapeHtml(item.kind === 'light' ? item.light?.lightType || 'light' : item.kind === 'primitive' ? item.asset?.primitiveType || 'primitive' : item.asset?.format || 'model')}</span>
                            </div>
                        `).join('') : '<div class="library-detail-empty">This 3D scene did not include any saved items.</div>'}
                    </div>
                </section>
                <section class="library-layer-card">
                    <div class="library-layer-card-header">
                        <strong>Scene Summary</strong>
                        <span>${models.length} model${models.length === 1 ? '' : 's'} / ${imagePlanes.length} plane${imagePlanes.length === 1 ? '' : 's'} / ${primitives.length} primitive${primitives.length === 1 ? '' : 's'} / ${lights.length} light${lights.length === 1 ? '' : 's'}</span>
                    </div>
                    <div class="library-layer-card-body">
                        <div class="library-param-row">
                            <span class="library-param-key">Render Mode</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(renderSettings.mode || 'raster'))}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Target Samples</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(renderSettings.samplesTarget || 0))}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Exposure</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(renderSettings.exposure || 1))}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Path Bounces</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(`${renderSettings.bounces || 10} / ${renderSettings.transmissiveBounces || 0} trans`))}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Denoise</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(renderSettings.denoiseEnabled ? 'enabled' : 'off'))}</span>
                        </div>
                        <div class="library-param-row">
                            <span class="library-param-key">Camera FOV</span>
                            <span class="library-param-val">${escapeHtml(formatParamValue(viewSettings.fov || 50))}</span>
                        </div>
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
        const sourceLabel = getProjectSourceLabel(data.projectType);
        const countLabel = getProjectSourceCountLabel(data.projectType);
        const compositeLayers = Array.isArray(data.payload?.layers) ? data.payload.layers : [];
        const compositeEditorLayers = compositeLayers.filter((layer) => layer?.kind === 'editor-project').length;
        const sourceCount = data.projectType === '3d'
            ? Number(data.sourceCount || data.payload?.scene?.items?.filter?.((item) => item.kind !== 'light').length || 0)
            : data.projectType === 'composite'
                ? Number(data.sourceCount || compositeLayers.length || 0)
                : Number(data.sourceCount || (data.projectType === 'stitch' ? 0 : 1));
        const sceneItemCount = Number(data.payload?.scene?.items?.length || 0);
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
                        <span class="library-param-key">${escapeHtml(sourceLabel)}</span>
                        <span class="library-param-val">${escapeHtml(formatDimensions(data.sourceWidth, data.sourceHeight))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">${escapeHtml(countLabel)}</span>
                        <span class="library-param-val">${escapeHtml(String(sourceCount))}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Rendered Size</span>
                        <span class="library-param-val">${escapeHtml(formatDimensions(data.renderWidth, data.renderHeight))}</span>
                    </div>
                    ${data.projectType === '3d' ? `
                        <div class="library-param-row">
                            <span class="library-param-key">Scene Items</span>
                            <span class="library-param-val">${escapeHtml(String(sceneItemCount))}</span>
                        </div>
                    ` : data.projectType === 'composite' ? `
                        <div class="library-param-row">
                            <span class="library-param-key">Editor-Linked Layers</span>
                            <span class="library-param-val">${escapeHtml(String(compositeEditorLayers))}</span>
                        </div>
                    ` : `
                        <div class="library-param-row">
                            <span class="library-param-key">Source Area</span>
                            <span class="library-param-val">${escapeHtml(formatArea(data.sourceArea))}</span>
                        </div>
                    `}
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

    function buildGridStateSignature(mode) {
        const data = mode === 'assets' ? assetData : libraryData;
        const visibleData = mode === 'assets' ? visibleAssetData : visibleLibraryData;
        const selectedIds = mode === 'assets' ? selectedAssetIds : selectedProjectIds;
        const selectedPrimaryId = mode === 'assets' ? selectedAssetId : selectedProjectId;
        return JSON.stringify({
            total: data.length,
            visible: visibleData.map((item) => item.recordSignature || item.id || ''),
            selected: [...selectedIds].sort(),
            focused: selectedPrimaryId || null
        });
    }

    function buildAssetGridHtml() {
        const selectedIds = selectedAssetIds;
        const selectedPrimaryId = selectedAssetId;
        return visibleAssetData.map((item, index) => `
            <article class="library-grid-item library-asset-card ${selectedIds.has(item.id) || selectedPrimaryId === item.id ? 'is-selected' : ''}" data-library-index="${index}" data-library-id="${item.id}">
                <button type="button" class="library-delete-button" data-library-action="delete-project" data-library-id="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">&times;</button>
                ${selectedIds.has(item.id) ? '<div class="library-selection-badge">Selected</div>' : ''}
                <div class="library-asset-thumb ${item.assetType === 'model' ? 'is-model' : 'is-image'}">
                    ${item.assetType === 'model'
                        ? `<span>${escapeHtml((item.format || 'model').toUpperCase())}</span>`
                        : `<img src="${item.previewDataUrl || item.dataUrl || ''}" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async">`}
                </div>
                <div class="library-card-meta">
                    <div class="library-card-title">${escapeHtml(item.name)}</div>
                    <div class="library-card-dimensions">
                        <span>${escapeHtml(item.assetType === 'model' ? '3D Asset' : 'Image Asset')}</span>
                        <span>${escapeHtml(formatDimensions(item.width, item.height))}</span>
                    </div>
                    ${renderTagPills(item.tags)}
                </div>
            </article>
        `).join('');
    }

    function buildProjectGridHtml() {
        const selectedIds = selectedProjectIds;
        const selectedPrimaryId = selectedProjectId;
        return visibleLibraryData.map((item, index) => `
            <article class="library-grid-item ${selectedIds.has(item.id) || selectedPrimaryId === item.id ? 'is-selected' : ''}" data-library-index="${index}" data-library-id="${item.id}">
                <button type="button" class="library-delete-button" data-library-action="delete-project" data-library-id="${item.id}" aria-label="Delete ${escapeHtml(item.name)}">&times;</button>
                ${selectedIds.has(item.id) ? '<div class="library-selection-badge">Selected</div>' : ''}
                ${item.hoverSrc ? '<div class="library-hover-hint">Hovering Original</div>' : ''}
                <div class="library-image-container">
                    <img src="${item.url}" class="library-img-base" alt="${escapeHtml(item.name)}" loading="lazy" decoding="async">
                    ${item.hoverSrc ? `<img src="${item.hoverSrc}" class="library-img-hover" alt="" loading="lazy" decoding="async">` : ''}
                </div>
                <div class="library-card-meta">
                    <div class="library-card-title">${escapeHtml(item.name)}</div>
                    <div class="library-card-dimensions">
                        <span>${escapeHtml(getProjectSourceLabel(item.projectType))} ${escapeHtml(formatDimensions(item.sourceWidth, item.sourceHeight))}</span>
                        <span>Render ${escapeHtml(formatDimensions(item.renderWidth, item.renderHeight))}</span>
                    </div>
                    ${renderTagPills(item.tags)}
                </div>
            </article>
        `).join('');
    }

    function renderGrid() {
        const currentData = getCurrentData();
        const visibleData = getVisibleCurrentData();
        const activeMode = isAssetsPage() ? 'assets' : 'library';
        const activeHost = activeMode === 'assets' ? refs.assetGrid : refs.projectGrid;

        updateGridModeVisibility();

        if (!currentData.length) {
            activeHost.innerHTML = '';
            gridMarkupSignatureByMode[activeMode] = gridStateSignatureByMode[activeMode];
            refs.empty.classList.add('is-visible');
            refs.emptyTitle.textContent = isAssetsPage() ? 'Assets page is empty' : 'Library is empty';
            refs.emptyText.textContent = isAssetsPage()
                ? '3D imports and saved Editor renders appear here as assets, or you can import asset bundles and asset folders.'
                : 'Save projects from Editor, Composite, Stitch, or 3D, or import JSON files to build your gallery.';
            return;
        }

        if (!visibleData.length) {
            activeHost.innerHTML = '';
            gridMarkupSignatureByMode[activeMode] = gridStateSignatureByMode[activeMode];
            refs.empty.classList.add('is-visible');
            refs.emptyTitle.textContent = isAssetsPage() ? 'No assets match this view' : 'No projects match this view';
            refs.emptyText.textContent = 'Try a different tag tab or sorting mode from the Library Tools drawer.';
            return;
        }

        refs.empty.classList.remove('is-visible');
        if (gridMarkupSignatureByMode[activeMode] === gridStateSignatureByMode[activeMode]) {
            return;
        }

        activeHost.innerHTML = activeMode === 'assets'
            ? buildAssetGridHtml()
            : buildProjectGridHtml();
        gridMarkupSignatureByMode[activeMode] = gridStateSignatureByMode[activeMode];
    }

    function updateFullscreen() {
        if (isAssetsPage() || !isFullscreen || !visibleLibraryData.length) {
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
            clearAssetPreview();
            root.querySelector('[data-library-action="download-project"]').style.display = '';
            root.querySelector('[data-library-action="load-detail"]').style.display = '';
            root.querySelector('[data-library-action="download-asset"]').style.display = 'none';
            root.querySelector('[data-library-action="rename-asset"]').style.display = 'none';
            return;
        }

        refs.detailOverlay.classList.add('is-active');
        refs.detailName.textContent = detailData.name;
        if (isAssetsPage()) {
            refs.detailMeta.textContent = `${detailData.assetType === 'model' ? '3D Model' : 'Image'} | Saved ${formatDateTime(detailData.timestamp)} | ${formatDimensions(detailData.width, detailData.height)}`;
            if (detailData.assetType === 'image' && detailData.dataUrl) {
                refs.detailBase.src = detailData.dataUrl;
            } else {
                refs.detailBase.removeAttribute('src');
            }
            refs.detailHover.removeAttribute('src');
            refs.detailLayers.innerHTML = `
                <section class="library-source-info">
                    <div class="library-param-row">
                        <span class="library-param-key">Asset Type</span>
                        <span class="library-param-val">${escapeHtml(detailData.assetType === 'model' ? '3D Model' : 'Image')}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Format</span>
                        <span class="library-param-val">${escapeHtml(detailData.format || 'Unknown')}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Mime Type</span>
                        <span class="library-param-val">${escapeHtml(detailData.mimeType || 'Unknown')}</span>
                    </div>
                    <div class="library-param-row">
                        <span class="library-param-key">Dimensions</span>
                        <span class="library-param-val">${escapeHtml(formatDimensions(detailData.width, detailData.height))}</span>
                    </div>
                    ${detailData.sourceProjectName ? `
                        <div class="library-param-row">
                            <span class="library-param-key">Linked Project</span>
                            <span class="library-param-val">${escapeHtml(detailData.sourceProjectName)}</span>
                        </div>
                    ` : ''}
                </section>
                <section class="library-source-info">
                    <div class="library-side-label">Tags</div>
                    ${renderTagPills(detailData.tags)}
                </section>
            `;
            root.querySelector('[data-library-action="download-project"]').style.display = 'none';
            root.querySelector('[data-library-action="load-detail"]').style.display = 'none';
            root.querySelector('[data-library-action="download-asset"]').style.display = '';
            root.querySelector('[data-library-action="rename-asset"]').style.display = '';
            return;
        }

        clearAssetPreview();
        refs.detailMeta.textContent = `${getProjectTypeLabel(detailData.projectType)} | Saved ${formatDateTime(detailData.timestamp)} | ${getProjectSourceLabel(detailData.projectType)} ${formatDimensions(detailData.sourceWidth, detailData.sourceHeight)} | Render ${formatDimensions(detailData.renderWidth, detailData.renderHeight)}`;
        refs.detailBase.src = detailData.url;
        if (detailData.hoverSrc) refs.detailHover.src = detailData.hoverSrc;
        else refs.detailHover.removeAttribute('src');
        refs.detailLayers.innerHTML = renderProjectSummaryCard(detailData) + renderLayerCards(detailData.payload);
        root.querySelector('[data-library-action="download-project"]').style.display = '';
        root.querySelector('[data-library-action="load-detail"]').style.display = '';
        root.querySelector('[data-library-action="download-asset"]').style.display = 'none';
        root.querySelector('[data-library-action="rename-asset"]').style.display = 'none';
    }

    async function openDetailByData(data) {
        if (!data) return;
        if (detailData?.id !== data.id) expandedParamIds = new Set();
        detailData = data;
        setSelectedPrimaryId(data.id);
        renderDetail();
        renderSidePanel();
        if (isAssetsPage()) {
            try {
                await loadAssetPreview(data);
            } catch (error) {
                console.error(error);
                showAlert(error.message || 'Could not load that asset preview.');
            }
        }
    }

    function closeDetail() {
        detailData = null;
        expandedParamIds = new Set();
        clearAssetPreview();
        renderDetail();
    }

    function renderSidePanel() {
        const currentData = getCurrentData();
        const visibleData = getVisibleCurrentData();
        const focusedProject = getSelectedProject();
        const selectedProjects = getSelectedProjects();
        const selectionCount = selectedProjects.length;
        const itemLabel = isAssetsPage() ? 'asset' : 'project';
        const itemLabelPlural = `${itemLabel}${selectionCount === 1 ? '' : 's'}`;
        const tagSummaries = getTagSummaries();
        const selectionTagSummaries = getSelectionTagSummaries();
        const sortLabels = getSortDirectionLabels(sortKey);
        const selectedNames = selectedProjects.slice(0, 3).map((item) => item.name).join(', ');

        refs.sideContent.innerHTML = `
            ${selectionCount ? `
                <section class="library-side-section">
                    <h3>Selection Actions</h3>
                    <p class="library-side-summary">${selectionCount} ${itemLabelPlural} selected</p>
                    <div class="library-side-actions">
                        <button type="button" class="toolbar-button" data-library-action="delete-selected-projects">Delete</button>
                        <button type="button" class="toolbar-button" data-library-action="clear-selection">Clear Selection</button>
                    </div>
                </section>
            ` : ''}
            <section class="library-side-section">
                <h3>Gallery View</h3>
                <label class="library-side-label" for="library-sort-key">Sort ${isAssetsPage() ? 'Assets' : 'Projects'}</label>
                <select id="library-sort-key" class="library-side-select" data-library-role="sort-key">
                    <option value="timestamp" ${sortKey === 'timestamp' ? 'selected' : ''}>Saved date</option>
                    <option value="name" ${sortKey === 'name' ? 'selected' : ''}>${isAssetsPage() ? 'Asset name' : 'Project name'}</option>
                    <option value="source-area" ${sortKey === 'source-area' ? 'selected' : ''}>${isAssetsPage() ? 'Asset size' : 'Original image size'}</option>
                    <option value="render-area" ${sortKey === 'render-area' ? 'selected' : ''}>${isAssetsPage() ? 'Asset size' : 'Rendered image size'}</option>
                </select>
                <div class="library-sort-direction">
                    <button type="button" class="library-filter-chip ${sortDirection === 'desc' ? 'is-active' : ''}" data-library-action="set-sort-direction" data-direction="desc">${escapeHtml(sortLabels.desc)}</button>
                    <button type="button" class="library-filter-chip ${sortDirection === 'asc' ? 'is-active' : ''}" data-library-action="set-sort-direction" data-direction="asc">${escapeHtml(sortLabels.asc)}</button>
                </div>
                <p class="library-side-summary">${visibleData.length} of ${currentData.length} ${isAssetsPage() ? 'assets' : 'projects'} visible</p>
            </section>
            <section class="library-side-section">
                <h3>Tag Tabs</h3>
                <div class="library-filter-tabs">
                    <button type="button" class="library-filter-chip ${activeTagMode === 'all' ? 'is-active' : ''}" data-library-action="toggle-special-filter" data-mode="all">All (${currentData.length})</button>
                    <button type="button" class="library-filter-chip ${activeTagMode === 'untagged' ? 'is-active' : ''}" data-library-action="toggle-special-filter" data-mode="untagged">Untagged (${currentData.filter((item) => !normalizeTagList(item.tags).length).length})</button>
                    ${tagSummaries.map((summary) => `
                        <button type="button" class="library-filter-chip ${activeTagMode === 'custom' && activeTagFilters.has(summary.key) ? 'is-active' : ''}" data-library-action="toggle-tag-filter" data-filter="${escapeHtml(summary.key)}">${escapeHtml(summary.tag)} (${summary.count})</button>
                    `).join('')}
                </div>
            </section>
            <section class="library-side-section">
                <h3>${selectionCount ? `Selected ${isAssetsPage() ? 'Assets' : 'Projects'}` : `Focused ${isAssetsPage() ? 'Asset' : 'Project'}`}</h3>
                ${selectionCount ? `
                    <div class="library-selected-card">
                        <strong>${selectionCount} ${itemLabelPlural} selected</strong>
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
                        ` : `<div class="library-side-empty">Selected ${isAssetsPage() ? 'assets' : 'projects'} do not have any tags yet.</div>`}
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
                        ` : `<div class="library-side-empty">Create your first tag, then apply it to the selected ${isAssetsPage() ? 'assets' : 'projects'}.</div>`}
                        <div class="library-side-actions">
                            <button type="button" class="toolbar-button" data-library-action="apply-pending-tags" ${pendingApplyTagKeys.size ? '' : 'disabled'}>Apply Chosen Tags</button>
                        </div>
                    </div>
                ` : focusedProject ? `
                    <div class="library-selected-card">
                        <strong>${escapeHtml(focusedProject.name)}</strong>
                        <div class="library-selected-meta">
                            <span>${escapeHtml(isAssetsPage() ? (focusedProject.assetType === 'model' ? '3D Model' : 'Image') : getProjectTypeLabel(focusedProject.projectType))}</span>
                            <span>${escapeHtml(isAssetsPage() ? 'Asset Size' : getProjectSourceLabel(focusedProject.projectType))} ${escapeHtml(isAssetsPage() ? formatDimensions(focusedProject.width, focusedProject.height) : formatDimensions(focusedProject.sourceWidth, focusedProject.sourceHeight))}</span>
                            ${!isAssetsPage() ? `<span>Render ${escapeHtml(formatDimensions(focusedProject.renderWidth, focusedProject.renderHeight))}</span>` : ''}
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
                        ` : `<div class="library-side-empty">This ${itemLabel} has no tags yet.</div>`}
                        <div class="library-side-actions">
                            <button type="button" class="toolbar-button" data-library-action="open-selected-detail">Open Details</button>
                            ${isAssetsPage()
                                ? '<button type="button" class="toolbar-button" data-library-action="rename-asset">Rename Asset</button>'
                                : '<button type="button" class="toolbar-button" data-library-action="load-selected-project">Load Project</button>'}
                        </div>
                    </div>
                ` : `
                    <div class="library-side-empty">Use Select to mark one or more ${isAssetsPage() ? 'assets' : 'projects'}, then manage tags or batch-delete them from this panel.</div>
                `}
            </section>
        `;
    }

    function applyViewState() {
        applyLibraryPreferenceDefaults();
        ensureActiveFilterStillExists();
        visibleLibraryData = getVisibleLibraryData();
        visibleAssetData = getVisibleAssetData();
        selectedProjectIds = new Set([...selectedProjectIds].filter((id) => libraryData.some((item) => item.id === id)));
        selectedAssetIds = new Set([...selectedAssetIds].filter((id) => assetData.some((item) => item.id === id)));
        updateSelectToggle();

        if (selectedProjectId && !libraryData.some((item) => item.id === selectedProjectId)) {
            selectedProjectId = null;
        }
        if (selectedAssetId && !assetData.some((item) => item.id === selectedAssetId)) {
            selectedAssetId = null;
        }

        if (detailData) {
            const freshDetail = getCurrentData().find((item) => item.id === detailData.id);
            if (freshDetail) detailData = freshDetail;
            else closeDetail();
        }

        const visibleData = getVisibleCurrentData();
        if (!visibleData.length) currentIndex = 0;
        else currentIndex = Math.max(0, Math.min(currentIndex, visibleData.length - 1));

        gridStateSignatureByMode.library = buildGridStateSignature('library');
        gridStateSignatureByMode.assets = buildGridStateSignature('assets');
        renderGrid();
        renderSidePanel();
        renderDetail();

        if (!isAssetsPage() && isFullscreen && visibleLibraryData.length) {
            updateFullscreen();
        } else if (!isAssetsPage() && isFullscreen && !visibleLibraryData.length) {
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
        const message = `${title}: ${text}`;
        const processId = getLibraryProcessId(message);
        const level = /could not|failed|error/i.test(message) ? 'error' : 'warning';
        logLibrary(level, processId, message, {
            dedupeKey: `alert:${message}`,
            dedupeWindowMs: 180
        });
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

    async function promptImportTags() {
        const existingTags = normalizeTagList(libraryTags);
        const selected = await runModalStep({
            title: 'Assign Tags',
            text: 'Choose one or more tags for the imported project, or continue without tags.',
            html: `
                <label class="library-modal-field">
                    <span>New tags</span>
                    <input type="text" class="library-modal-input" data-library-role="import-tags-input" placeholder="Comma separated tags">
                </label>
                ${existingTags.length ? `
                    <div class="library-side-label">Existing Tags</div>
                    <div class="library-tag-list">
                        ${existingTags.map((tag) => `
                            <label class="library-tag library-tag-button" style="cursor:pointer;">
                                <input type="checkbox" value="${escapeHtml(tag)}" data-library-role="import-tag-choice" style="display:none;">
                                <span>${escapeHtml(tag)}</span>
                            </label>
                        `).join('')}
                    </div>
                ` : '<div class="info-banner" style="margin:0;">No saved Library tags exist yet. You can still continue without assigning any tags.</div>'}
            `,
            confirmLabel: 'Continue',
            onConfirm: ({ root }) => {
                const typed = String(root.querySelector('[data-library-role="import-tags-input"]')?.value || '');
                const picked = Array.from(root.querySelectorAll('[data-library-role="import-tag-choice"]:checked')).map((node) => node.value);
                return normalizeTagList([...typed.split(','), ...picked]);
            }
        });
        return selected || [];
    }

    async function promptSaveLibraryMode(defaultScope = getActiveExportScope()) {
        const preferSecure = !!getLibrarySettings().secureExportByDefault;
        const exportChoice = await runModalStep({
            title: isAssetsPage() ? 'Save Assets' : 'Save Library',
            text: 'Choose what to export, then choose whether the package should be plain JSON or use the secure packed format.',
            html: `
                <div class="library-side-label">Export Scope</div>
                <div class="library-modal-choice-grid">
                    ${['library', 'assets', 'combined'].map((scope) => {
                        const counts = getExportCounts(scope);
                        return `
                            <label class="library-modal-choice">
                                <input type="radio" name="library-export-scope" value="${scope}" ${scope === defaultScope ? 'checked' : ''}>
                                <strong>${escapeHtml(formatScopeLabel(scope))}</strong>
                                <span>${escapeHtml(getScopeDescription(scope, counts.projectCount, counts.assetCount))}</span>
                            </label>
                        `;
                    }).join('')}
                </div>
                <div class="library-side-label">Export Format</div>
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-export-mode" value="plain" ${preferSecure ? '' : 'checked'}>
                        <strong>Json Export</strong>
                        <span>Readable JSON package with every included project, asset, tag, and export date preserved.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-export-mode" value="secure" ${preferSecure ? 'checked' : ''}>
                        <strong>Secure Export</strong>
                        <span>Pack the selected Library data into a compressed JSON-safe block, with optional encryption.</span>
                    </label>
                </div>
            `,
            confirmLabel: 'Next',
            onConfirm: ({ root, setError }) => {
                const scope = root.querySelector('input[name="library-export-scope"]:checked')?.value || defaultScope;
                const selected = root.querySelector('input[name="library-export-mode"]:checked')?.value;
                const counts = getExportCounts(scope);
                if ((scopeIncludesProjects(scope) && !counts.projectCount) && (scopeIncludesAssets(scope) && !counts.assetCount)) {
                    setError('There is nothing in that export scope yet.');
                    return false;
                }
                if (scope === 'library' && !counts.projectCount) {
                    setError('Save or import one or more Library projects first.');
                    return false;
                }
                if (scope === 'assets' && !counts.assetCount) {
                    setError('Import or create one or more Library assets first.');
                    return false;
                }
                if (!selected) {
                    setError('Choose an export type first.');
                    return false;
                }
                return {
                    scope,
                    exportMode: selected,
                    suggestedFilename: buildDefaultLibraryFilename(getScopeDefaultBaseName(scope))
                };
            }
        });
        return exportChoice;
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

    async function promptReplaceMode({ scope = 'combined', projectCount = 0, assetCount = 0 } = {}) {
        const scopeLabel = formatScopeLabel(scope);
        return runModalStep({
            title: `Load ${scopeLabel}`,
            text: `This import contains ${formatImportSummary(projectCount, assetCount)}. How should it be loaded?`,
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-replace-mode" value="merge" checked>
                        <strong>Add To Current ${escapeHtml(scopeLabel)}</strong>
                        <span>Keep what is already saved and add the incoming ${escapeHtml(scopeLabel.toLowerCase())} items on top.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-replace-mode" value="replace">
                        <strong>Replace Current ${escapeHtml(scopeLabel)}</strong>
                        <span>Clear the matching saved data first, then load the incoming ${escapeHtml(scopeLabel.toLowerCase())} items.</span>
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

    async function promptSaveBeforeReplace(scope = 'combined') {
        const scopeLabel = formatScopeLabel(scope);
        return runModalStep({
            title: `Replace Current ${scopeLabel}`,
            text: `Do you want to save the current ${scopeLabel} before it is cleared?`,
            html: `
                <div class="library-modal-choice-grid">
                    <label class="library-modal-choice">
                        <input type="radio" name="library-save-before-replace" value="save" checked>
                        <strong>Save Current ${escapeHtml(scopeLabel)}</strong>
                        <span>Run the save workflow first, then replace the current ${escapeHtml(scopeLabel.toLowerCase())} contents.</span>
                    </label>
                    <label class="library-modal-choice">
                        <input type="radio" name="library-save-before-replace" value="discard">
                        <strong>Replace Without Saving</strong>
                        <span>Skip the backup and clear the current ${escapeHtml(scopeLabel.toLowerCase())} immediately before loading the new file.</span>
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

    async function promptSecureCompatibilityFallback({ title, text, detail, confirmLabel }) {
        return runModalStep({
            title,
            text,
            html: `
                <div class="info-banner" style="margin:0;">
                    ${escapeHtml(detail || 'The faster secure packaging path is unavailable right now. You can continue with a slower compatibility path instead.')}
                </div>
            `,
            confirmLabel: confirmLabel || 'Use Compatibility Path',
            cancelLabel: 'Cancel'
        });
    }

    async function buildSecureLibraryExportRecord(bundle, { secureMode, passphrase = '', compatibilityMode = 'fast' } = {}) {
        return typeof actions.buildSecureLibraryExportRecord === 'function'
            ? actions.buildSecureLibraryExportRecord(bundle, {
                secureMode,
                passphrase,
                compatibilityMode
            })
            : null;
    }

    async function buildSecureLibraryExportWithFallback(bundle, options = {}) {
        try {
            return await buildSecureLibraryExportRecord(bundle, {
                ...options,
                compatibilityMode: 'fast'
            });
        } catch (error) {
            if (!isSecureLibraryCompatibilityError(error)) {
                throw error;
            }
            const detail = error.fallbackReason || error.message || 'The fast secure Library export path is unavailable.';
            logLibrary('warning', 'library.export', detail);
            logLibrary('info', 'library.export', 'Secure Library export compatibility prompt shown.');
            const accepted = await promptSecureCompatibilityFallback({
                title: 'Secure Export Compatibility',
                text: 'This export can continue using a slower compatibility path.',
                detail,
                confirmLabel: 'Use Compatibility Path'
            });
            if (!accepted) {
                logLibrary('info', 'library.export', 'Secure Library export compatibility fallback was declined.');
                return null;
            }
            logLibrary('info', 'library.export', 'Secure Library export compatibility fallback accepted.');
            return buildSecureLibraryExportRecord(bundle, {
                ...options,
                compatibilityMode: 'js'
            });
        }
    }

    async function resolveSecureLibraryImportRecord(parsed, passphrase = '', compatibilityMode = 'fast') {
        return typeof actions.resolveSecureLibraryImportRecord === 'function'
            ? actions.resolveSecureLibraryImportRecord(parsed, passphrase, { compatibilityMode })
            : null;
    }

    async function resolveSecureLibraryImportWithFallback(parsed, passphrase = '') {
        try {
            return await resolveSecureLibraryImportRecord(parsed, passphrase, 'fast');
        } catch (error) {
            if (!isSecureLibraryCompatibilityError(error)) {
                throw error;
            }
            const detail = error.fallbackReason || error.message || 'The fast secure Library import path is unavailable.';
            logLibrary('warning', 'library.import', detail);
            logLibrary('info', 'library.import', 'Secure Library import compatibility prompt shown.');
            const accepted = await promptSecureCompatibilityFallback({
                title: 'Secure Import Compatibility',
                text: 'This import can continue using a slower compatibility path.',
                detail,
                confirmLabel: 'Use Compatibility Path'
            });
            if (!accepted) {
                logLibrary('info', 'library.import', 'Secure Library import compatibility fallback was declined.');
                return null;
            }
            logLibrary('info', 'library.import', 'Secure Library import compatibility fallback accepted.');
            return resolveSecureLibraryImportRecord(parsed, passphrase, 'js');
        }
    }

    function showProgress(text, countText = '', ratio = 0) {
        refs.statusText.textContent = text || 'Preparing Library task...';
        refs.countText.textContent = countText || '';
        refs.progressFill.style.width = `${Math.round(clamp01(ratio) * 100)}%`;
        refs.loadingOverlay.classList.add('is-active');
        renderLoadingOverlayLogs();
        const message = [text || 'Preparing Library task...', countText || ''].filter(Boolean).join(' | ');
        const signature = `${message}|${Math.round(clamp01(ratio) * 1000)}`;
        if (signature !== lastProgressLogSignature) {
            lastProgressLogSignature = signature;
            logLibrary('progress', getLibraryProcessId(text), message, clamp01(ratio), {
                dedupeKey: signature,
                dedupeWindowMs: 80
            });
        }
    }

    function hideProgress() {
        refs.loadingOverlay.classList.remove('is-active');
        refs.progressFill.style.width = '0%';
        lastProgressLogSignature = '';
    }

    async function refresh(options = {}) {
        if (!panelActive && !options.forceInactive) {
            pendingRefreshWhileInactive = true;
            return;
        }
        applyLibraryPreferenceDefaults();
        const token = ++refreshToken;
        const shouldShowInitialProgress = !hasRenderedLibrary;
        const previousData = libraryData;
        const previousAssets = assetData;
        const previousTags = libraryTags;
        const previousById = new Map(previousData.map((item) => [item.id, item]));
        const previousAssetById = new Map(previousAssets.map((item) => [item.id, item]));
        if (shouldShowInitialProgress) {
            showProgress('Loading Library...', 'Reading saved projects, asset records, and tag catalog', 0.08);
        }
        logLibrary('active', 'library.sync', shouldShowInitialProgress
            ? 'Loading Library projects, tags, and assets from memory.'
            : 'Refreshing Library page data.');
        try {
            const [projects, nextLibraryTagsRaw, nextAssetsRaw] = await Promise.all([
                actions.getLibraryProjects(),
                actions.getLibraryTagCatalog?.() || [],
                actions.getLibraryAssets?.() || []
            ]);
            const nextLibraryTags = normalizeTagList(nextLibraryTagsRaw || []);

            if (shouldShowInitialProgress && token === refreshToken) {
                const summary = `${projects.length} project${projects.length === 1 ? '' : 's'} | ${(nextAssetsRaw || []).length} asset${(nextAssetsRaw || []).length === 1 ? '' : 's'}`;
                showProgress('Preparing Library metadata...', summary, 0.56);
            }

            const nextData = await Promise.all(projects.map(async (project) => {
                const previous = previousById.get(project.id);
                const tags = normalizeTagList(project.tags || []);
                let renderWidth = Number(project.renderWidth || 0);
                let renderHeight = Number(project.renderHeight || 0);
                const projectType = project.projectType || inferProjectTypeFromPayload(project.payload);
                const hoverSource = project.hoverSource || project.payload?._libraryHoverSource || project.payload?.source || null;
                const previewImageData = project.payload?.preview?.imageData || '';
                const sourceWidth = Number(project.sourceWidth || hoverSource?.width || project.payload?.source?.width || project.payload?.preview?.width || 0);
                const sourceHeight = Number(project.sourceHeight || hoverSource?.height || project.payload?.source?.height || project.payload?.preview?.height || 0);
                const sourceAreaOverride = Number(project.sourceAreaOverride || project.payload?._librarySourceArea || 0) || 0;
                const sourceCount = Number(
                    project.sourceCount
                    || project.payload?._librarySourceCount
                    || (projectType === '3d'
                        ? project.payload?.scene?.items?.filter?.((item) => item.kind !== 'light').length || 0
                        : projectType === 'stitch'
                            ? project.payload?.inputs?.length || 0
                            : (hoverSource?.imageData ? 1 : 0))
                    || 0
                );
                let previewSignature = getProjectPreviewSignature(project, renderWidth, renderHeight);
                let url = previous?.previewSignature === previewSignature
                    ? previous.url
                    : (project.blob ? URL.createObjectURL(project.blob) : (hoverSource?.imageData || previewImageData || ''));

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
                    projectType,
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

            if (shouldShowInitialProgress && token === refreshToken) {
                showProgress('Building Library gallery...', 'Creating project and asset cards', 0.82);
            }

            const nextAssetData = await Promise.all(((nextAssetsRaw || []) || []).map(async (asset) => {
                const previous = previousAssetById.get(asset.id);
                const tags = normalizeTagList(asset.tags || []);
                let width = Number(asset.width || 0);
                let height = Number(asset.height || 0);
                if ((!width || !height) && asset.assetType !== 'model' && asset.dataUrl) {
                    try {
                        const measured = await readImageDimensions(asset.dataUrl);
                        width = measured.width;
                        height = measured.height;
                    } catch (_error) {
                        width = Number(asset.width || 0);
                        height = Number(asset.height || 0);
                    }
                }
                return {
                    ...asset,
                    assetType: normalizeLibraryAssetType(asset.assetType),
                    tags,
                    width,
                    height,
                    recordSignature: [
                        asset.id,
                        asset.name,
                        asset.assetType,
                        asset.format,
                        asset.mimeType,
                        width,
                        height,
                        asset.timestamp,
                        tags.join('|'),
                        asset.sourceProjectId || '',
                        asset.assetFingerprint || '',
                        asset.previewDataUrl ? 'preview' : 'no-preview'
                    ].join('::')
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
                || previousAssets.length !== nextAssetData.length
                || nextAssetData.some((item) => previousAssetById.get(item.id)?.recordSignature !== item.recordSignature)
                || JSON.stringify(previousTags) !== JSON.stringify(nextLibraryTags);

            releaseUnusedUrls(previousData, nextData);
            libraryData = nextData;
            assetData = nextAssetData;
            libraryTags = nextLibraryTags;
            pendingRefreshWhileInactive = false;
            if (!didDataChange && hasRenderedLibrary) {
                return;
            }

            hasRenderedLibrary = true;
            applyViewState();
            logLibrary('success', 'library.sync', `Library ready with ${libraryData.length} project${libraryData.length === 1 ? '' : 's'} and ${assetData.length} asset${assetData.length === 1 ? '' : 's'}.`, {
                dedupeKey: `library-ready:${libraryData.length}:${assetData.length}`,
                dedupeWindowMs: 120
            });
        } finally {
            if (shouldShowInitialProgress && token === refreshToken) {
                hideProgress();
            }
        }
    }

    async function saveTagsForCurrentEntry(entryId, nextTags) {
        const normalizedTags = normalizeTagList(nextTags);
        if (isAssetsPage()) {
            await actions.updateLibraryAssetTags?.(entryId, normalizedTags);
        } else {
            await actions.updateLibraryProjectTags?.(entryId, normalizedTags);
        }
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

    async function removeTagFromFocusedEntry(tag) {
        const item = getSelectedProject();
        if (!item) return;
        const removeKey = getTagKey(tag);
        await saveTagsForCurrentEntry(item.id, item.tags.filter((entry) => getTagKey(entry) !== removeKey));
    }

    async function applyPendingTagsToSelection() {
        const targetIds = getSelectedProjectIds();
        if (!targetIds.length || !pendingApplyTagKeys.size) return;
        const tagsToApply = libraryTags.filter((tag) => pendingApplyTagKeys.has(getTagKey(tag)));
        if (!tagsToApply.length) return;
        if (isAssetsPage()) {
            await actions.applyLibraryTagsToAssets?.(targetIds, tagsToApply);
        } else {
            await actions.applyLibraryTagsToProjects?.(targetIds, tagsToApply);
        }
        pendingApplyTagKeys = new Set();
        await refresh();
    }

    async function removeTagFromSelection(tag) {
        const targetIds = getSelectedProjectIds();
        if (!targetIds.length) return;
        if (isAssetsPage()) {
            await actions.removeLibraryTagFromAssets?.(targetIds, tag);
        } else {
            await actions.removeLibraryTagFromProjects?.(targetIds, tag);
        }
        await refresh();
    }

    async function renameFocusedAsset(asset = detailData || getSelectedProject()) {
        if (!asset?.id) return;
        const nextName = await runModalStep({
            title: 'Rename Asset',
            text: 'Choose a new name for this saved asset.',
            html: `
                <label class="library-modal-field">
                    <span>Asset name</span>
                    <input type="text" class="library-modal-input" data-library-role="modal-asset-name" value="${escapeHtml(asset.name || 'Library Asset')}">
                </label>
            `,
            confirmLabel: 'Rename',
            onOpen: () => focusModalField('[data-library-role="modal-asset-name"]'),
            onConfirm: ({ root, setError }) => {
                const value = String(root.querySelector('[data-library-role="modal-asset-name"]')?.value || '').trim();
                if (!value) {
                    setError('Enter an asset name first.');
                    return false;
                }
                return value;
            }
        });
        if (!nextName) return;
        await actions.renameLibraryAsset?.(asset.id, nextName);
        await refresh();
    }

    async function downloadProject(project) {
        if (!project) return false;
        const saveResult = await downloadJsonFile(buildLibraryProjectExportPayload(project), project.name, {
            title: 'Save Library Project JSON',
            buttonLabel: 'Save JSON',
            pretty: true
        });
        if (wasSaveCancelled(saveResult)) {
            logLibrary('info', 'library.export', `Cancelled Library project download for "${project.name || 'project'}".`);
            return false;
        }
        if (!didSaveFile(saveResult)) {
            const message = saveResult?.error || `Could not save "${project.name || 'project'}".`;
            logLibrary('error', 'library.export', message);
            showAlert(message);
            return false;
        }
        logLibrary('success', 'library.export', `Saved Library project JSON "${toJsonFilename(project.name)}".`);
        return true;
    }

    async function saveLibraryWorkflow(options = {}) {
        if (!libraryData.length && !assetData.length && !libraryTags.length) {
            showAlert('There are no Library projects, assets, or tags to save yet.');
            return false;
        }

        const defaultScope = options.defaultScope || getActiveExportScope();
        const exportChoice = await promptSaveLibraryMode(defaultScope);
        if (!exportChoice) return false;

        const filename = await promptLibraryFilename(
            exportChoice.scope === 'assets' ? 'Save Assets' : 'Save Library',
            'Choose a file name for this export.',
            options.defaultName || exportChoice.suggestedFilename || buildDefaultLibraryFilename(getScopeDefaultBaseName(exportChoice.scope))
        );
        if (!filename) return false;

        const bundle = buildExportBundleForScope(exportChoice.scope, filename);
        const counts = getExportCounts(exportChoice.scope);
        const summary = formatImportSummary(counts.projectCount, counts.assetCount);
        logLibrary('active', 'library.export', `Preparing a ${exportChoice.scope === 'assets' ? 'Assets' : exportChoice.scope === 'combined' ? 'combined Library + Assets' : 'Library'} export named "${filename}".`);

        if (exportChoice.exportMode === 'plain') {
            const saveResult = await downloadJsonFile(bundle, filename, {
                title: 'Save Library Export',
                buttonLabel: 'Save JSON',
                pretty: false
            });
            if (wasSaveCancelled(saveResult)) {
                logLibrary('info', 'library.export', `Cancelled plain JSON export "${toJsonFilename(filename)}".`);
                return false;
            }
            if (!didSaveFile(saveResult)) {
                const message = saveResult?.error || 'Could not save the Library export JSON.';
                logLibrary('error', 'library.export', message);
                showAlert(message);
                return false;
            }
            logLibrary('success', 'library.export', `Saved plain JSON export "${toJsonFilename(filename)}".`);
            return true;
        }

        const secureMode = await promptSecureSaveMode();
        if (!secureMode) return false;

        let passphrase = '';
        if (secureMode === 'encrypted') {
            passphrase = await promptEncryptionPassphrase();
            if (!passphrase) return false;
        }

        try {
            showProgress('Packing export...', summary, 0.15);
            const payloadPackage = await buildSecureLibraryExportWithFallback(bundle, {
                secureMode,
                passphrase
            });
            if (!payloadPackage) {
                return false;
            }
            showProgress('Saving export...', toJsonFilename(filename), 1);
            const saveResult = await downloadJsonTextFile(payloadPackage.serializedText || JSON.stringify(payloadPackage.record || {}), filename, {
                title: 'Save Library Export',
                buttonLabel: 'Save JSON',
                pretty: false
            });
            if (wasSaveCancelled(saveResult)) {
                logLibrary('info', 'library.export', `Cancelled secure ${secureMode} export "${toJsonFilename(filename)}".`);
                return false;
            }
            if (!didSaveFile(saveResult)) {
                throw new Error(saveResult?.error || 'Could not save the secure Library export JSON.');
            }
            logLibrary('success', 'library.export', `Saved secure ${secureMode} export "${toJsonFilename(filename)}".`);
            return true;
        } catch (error) {
            console.error(error);
            logLibrary('error', 'library.export', error.message || 'Could not save the secure Library export.');
            showAlert(error.message || 'Could not save that export.');
            return false;
        } finally {
            hideProgress();
        }
    }

    async function resolveSecureImportPayload(parsed, fallbackName) {
        if (parsed.mode === 'compressed') {
            const resolved = await resolveSecureLibraryImportWithFallback(parsed, '');
            if (!resolved) return null;
            const recoveredText = String(resolved?.recoveredText || '');
            if (!recoveredText) {
                throw new Error('This secure Library file could not be unpacked.');
            }
            return extractLibraryImportBundle(JSON.parse(recoveredText), fallbackName);
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

        const resolved = await resolveSecureLibraryImportWithFallback(parsed, passphrase);
        if (!resolved) return null;
        const recoveredText = String(resolved?.recoveredText || '');
        const failedCount = Math.max(0, Number(resolved?.failedCount || 0));
        if (!recoveredText) {
            throw new Error('Could not decrypt this secure Library file with that key.');
        }
        const recoveredParsed = JSON.parse(recoveredText);
        const extracted = extractLibraryImportBundle(recoveredParsed, fallbackName);

        if (failedCount && copies.length > 1) {
            const wantsRepairDownload = await promptRecoveredFileDownload(toJsonFilename(parsed.name || fallbackName));
            if (wantsRepairDownload === null) return null;
            if (wantsRepairDownload) {
                const repairedPayloadPackage = await buildSecureLibraryExportWithFallback(
                    isPlainLibraryExportPayload(recoveredParsed)
                        ? recoveredParsed
                        : buildLibraryExportBundle({
                            projects: extracted.projectEntries.map((entry) => ({
                                name: entry.name,
                                tags: entry.tags,
                                payload: JSON.parse(entry.text)
                            })),
                            assets: extracted.assetEntries.map((entry) => ({
                                ...(entry.asset || {}),
                                name: entry.asset?.name || entry.name,
                                tags: entry.tags || entry.asset?.tags || []
                            })),
                            tagCatalog: extracted.tags,
                            name: parsed.name || fallbackName,
                            scope: extracted.scope || 'combined'
                        }),
                    {
                        secureMode: 'encrypted',
                        passphrase
                    }
                );
                if (!repairedPayloadPackage) {
                    return null;
                }
                const saveResult = await downloadJsonTextFile(repairedPayloadPackage.serializedText || JSON.stringify(repairedPayloadPackage.record || {}), `${stripJsonExtension(parsed.name || fallbackName)} repaired`, {
                    title: 'Save Repaired Library Export',
                    buttonLabel: 'Save JSON',
                    pretty: false
                });
                if (wasSaveCancelled(saveResult)) {
                    logLibrary('info', 'library.import', `Cancelled repaired secure Library export download for "${parsed.name || fallbackName}".`);
                } else if (!didSaveFile(saveResult)) {
                    showAlert(saveResult?.error || 'Could not save the repaired secure Library export.');
                    logLibrary('warning', 'library.import', saveResult?.error || 'Could not save the repaired secure Library export.');
                } else {
                    logLibrary('success', 'library.import', `Saved a repaired secure Library export for "${parsed.name || fallbackName}".`);
                }
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

    function getImportScopeFromEntries(projectEntries = [], assetEntries = []) {
        if (projectEntries.length && assetEntries.length) return 'combined';
        if (assetEntries.length) return 'assets';
        return 'library';
    }

    function hasStoredDataForScope(scope) {
        const counts = getExportCounts(scope);
        return (scopeIncludesProjects(scope) && counts.projectCount > 0)
            || (scopeIncludesAssets(scope) && counts.assetCount > 0);
    }

    function normalizeImportedAssetEntries(assetEntries = []) {
        return (assetEntries || []).map((entry, index) => {
            const asset = entry?.asset || entry || {};
            const meta = inferAssetFileMeta(asset.name || entry?.name || `Asset ${index + 1}`, asset.mimeType || '');
            const assetType = normalizeLibraryAssetType(asset.assetType || meta?.assetType || 'image');
            const format = String(asset.format || meta?.format || (assetType === 'model' ? 'glb' : 'png'));
            const mimeType = normalizeAssetMimeType(format, asset.mimeType || meta?.mimeType || '', assetType);
            const dataUrl = String(asset.dataUrl || '');
            if (!dataUrl) return null;
            return {
                id: asset.id || null,
                timestamp: Number(asset.timestamp || Date.now()),
                name: String(asset.name || entry?.name || `Asset ${index + 1}`),
                assetType,
                format,
                mimeType,
                dataUrl,
                tags: normalizeTagList(entry?.tags || asset.tags || []),
                width: Number(asset.width || 0),
                height: Number(asset.height || 0),
                sourceProjectId: asset.sourceProjectId || null,
                sourceProjectType: asset.sourceProjectType || null,
                sourceProjectName: asset.sourceProjectName || null,
                origin: asset.origin || 'import',
                assetFingerprint: asset.assetFingerprint || ''
            };
        }).filter(Boolean);
    }

    async function applyImportPackages(importPackages, { allowReplacePrompt = true } = {}) {
        const emptyImportSummary = {
            savedCount: 0,
            updatedCount: 0,
            skippedDuplicateCount: 0,
            rejectedCount: 0,
            importedProjectIds: [],
            importedIds: [],
            updatedIds: []
        };
        let projectEntries = importPackages.flatMap((entry) => entry.projectEntries || []);
        const assetEntries = normalizeImportedAssetEntries(importPackages.flatMap((entry) => entry.assetEntries || []));
        let importedCatalog = normalizeTagList([
            ...importPackages.flatMap((entry) => entry.tags || []),
            ...projectEntries.flatMap((entry) => entry.tags || []),
            ...assetEntries.flatMap((entry) => entry.tags || [])
        ]);

        if (!projectEntries.length && !assetEntries.length && !importedCatalog.length) {
            showAlert('No Library data was found in that import.');
            return;
        }

        const importScope = getImportScopeFromEntries(projectEntries, assetEntries);
        logLibrary('active', 'library.import', `Applying import packages with ${projectEntries.length} project${projectEntries.length === 1 ? '' : 's'} and ${assetEntries.length} asset${assetEntries.length === 1 ? '' : 's'}.`);
        const shouldPromptReplace = allowReplacePrompt && importPackages.some((entry) => entry.kind === 'library-bundle' || entry.kind === 'asset-folder');
        let replaceExisting = false;

        if (shouldPromptReplace && hasStoredDataForScope(importScope)) {
            const replaceMode = await promptReplaceMode({
                scope: importScope,
                projectCount: projectEntries.length,
                assetCount: assetEntries.length
            });
            if (!replaceMode) return;
            replaceExisting = replaceMode === 'replace';
            if (replaceExisting) {
                const saveChoice = await promptSaveBeforeReplace(importScope);
                if (!saveChoice) return;
                if (saveChoice === 'save') {
                    const didSave = await saveLibraryWorkflow({
                        defaultScope: importScope,
                        defaultName: buildDefaultLibraryFilename(`${getScopeDefaultBaseName(importScope)} backup`)
                    });
                    if (!didSave) return;
                }
            }
        }

        if (replaceExisting) {
            resetScopeUiState(importScope);
            if (scopeIncludesProjects(importScope)) {
                await actions.clearLibraryProjects?.();
            }
            if (scopeIncludesAssets(importScope)) {
                await actions.clearLibraryAssets?.();
            }
        }

        if (getLibrarySettings().requireTagOnImport && projectEntries.length) {
            const assignedTags = await promptImportTags();
            if (assignedTags.length) {
                importedCatalog = normalizeTagList([...importedCatalog, ...assignedTags]);
                projectEntries = projectEntries.map((entry) => {
                    try {
                        const parsed = JSON.parse(entry.text);
                        const mergedTags = normalizeTagList([...(entry.tags || []), ...assignedTags]);
                        return {
                            ...entry,
                            tags: mergedTags,
                            text: JSON.stringify({
                                ...parsed,
                                _libraryTags: mergedTags
                            })
                        };
                    } catch (_error) {
                        return entry;
                    }
                });
            }
        }

        let projectSummary = emptyImportSummary;
        if (projectEntries.length) {
            showProgress('Preparing Library import...', `${projectEntries.length} project${projectEntries.length === 1 ? '' : 's'}`, 0.02);
            await nextPaint();
            projectSummary = (await actions.processLibraryPayloads(
                projectEntries.map((entry) => entry.text),
                projectEntries.map((entry) => entry.name),
                ({ phase, count = 0, total = projectEntries.length, filename = '' }) => {
                    if (phase === 'start') {
                        showProgress('Rendering Library projects...', `0 of ${total}`, 0);
                    } else if (phase === 'progress') {
                        const safeFilename = filename ? ` | ${filename}` : '';
                        showProgress('Rendering Library projects...', `${count} of ${total}${safeFilename}`, total ? (count / total) * (assetEntries.length ? 0.7 : 1) : 0);
                    } else if (phase === 'complete') {
                        showProgress(assetEntries.length ? 'Preparing asset import...' : 'Finalizing Library import...', assetEntries.length ? formatCountLabel(assetEntries.length, 'asset') : `${total} file${total === 1 ? '' : 's'}`, assetEntries.length ? 0.72 : 1);
                    }
                }
            )) || emptyImportSummary;
        }

        let assetSummary = emptyImportSummary;
        if (assetEntries.length) {
            showProgress('Importing Library assets...', `0 of ${assetEntries.length}`, projectEntries.length ? 0.76 : 0.1);
            await nextPaint();
            assetSummary = (await actions.importLibraryAssets?.(assetEntries)) || emptyImportSummary;
            showProgress('Finalizing asset import...', `${assetEntries.length} of ${assetEntries.length}`, 1);
        }

        const nextCatalog = normalizeTagList([
            ...(replaceExisting ? getSurvivingTagsForReplace(importScope) : libraryTags),
            ...importedCatalog
        ]);
        if (actions.setLibraryTagCatalog) {
            await actions.setLibraryTagCatalog(nextCatalog);
        }

        await refresh();
        const totalSaved = Number(projectSummary.savedCount || 0) + Number(assetSummary.savedCount || 0);
        const totalUpdated = Number(projectSummary.updatedCount || 0) + Number(assetSummary.updatedCount || 0);
        const totalSkipped = Number(projectSummary.skippedDuplicateCount || 0) + Number(assetSummary.skippedDuplicateCount || 0);
        const totalRejected = Number(projectSummary.rejectedCount || 0) + Number(assetSummary.rejectedCount || 0);
        const visibleProjectIds = new Set(visibleLibraryData.map((item) => item.id));
        const visibleAssetIds = new Set(visibleAssetData.map((item) => item.id));
        const hiddenProjectCount = activePageMode === 'library' && activeTagMode !== 'all'
            ? (projectSummary.importedProjectIds || []).filter((id) => !visibleProjectIds.has(id)).length
            : 0;
        const hiddenAssetCount = activePageMode === 'assets' && activeTagMode !== 'all'
            ? ([...(assetSummary.importedIds || []), ...(assetSummary.updatedIds || [])]).filter((id) => !visibleAssetIds.has(id)).length
            : 0;
        const hiddenByFiltersCount = hiddenProjectCount + hiddenAssetCount;
        const summaryBits = [];
        if (totalSaved) summaryBits.push(`saved ${totalSaved}`);
        if (totalUpdated) summaryBits.push(`updated ${totalUpdated}`);
        if (totalSkipped) summaryBits.push(`skipped ${totalSkipped} duplicate${totalSkipped === 1 ? '' : 's'}`);
        if (totalRejected) summaryBits.push(`rejected ${totalRejected} invalid item${totalRejected === 1 ? '' : 's'}`);
        if (hiddenByFiltersCount) summaryBits.push(`${hiddenByFiltersCount} hidden by active filters`);
        logLibrary(
            totalRejected || (!totalSaved && !totalUpdated) || hiddenByFiltersCount ? 'warning' : 'success',
            'library.import',
            summaryBits.length
                ? `Library import summary: ${summaryBits.join(', ')}.`
                : 'Library import completed with no visible changes.'
        );

        if (!totalSaved && !totalUpdated) {
            if (totalSkipped && !totalRejected) {
                showAlert('Import finished without changes because everything in that package was already present in the Library.');
            } else if (totalRejected && !totalSkipped) {
                showAlert('Import finished without changes because every imported item was invalid, unsupported, or missing required data.');
            } else {
                showAlert('Import finished without changes. The package only contained duplicates or invalid items.');
            }
            return;
        }

        if (hiddenByFiltersCount) {
            showAlert(`Import completed, but ${hiddenByFiltersCount} imported item${hiddenByFiltersCount === 1 ? '' : 's'} are hidden by the current tag filters on this page.`);
        }
    }

    async function parseAssetFolder(directoryHandle) {
        const allFiles = await collectDirectoryFiles(directoryHandle);
        const manifestEntry = allFiles.find((entry) => entry.handle.name === 'library-assets-manifest.json');
        if (manifestEntry) {
            const manifestFile = await manifestEntry.handle.getFile();
            const manifestText = await manifestFile.text();
            const parsed = JSON.parse(manifestText);
            if (parsed?.type === LIBRARY_EXPORT_TYPE && parsed?.format === LIBRARY_ASSET_FOLDER_FORMAT) {
                const assetEntries = [];
                for (const [index, rawAsset] of (parsed.assets || []).entries()) {
                    const relativePath = rawAsset.fileName || rawAsset.filename || '';
                    if (!relativePath) continue;
                    const fileHandle = await getNestedFileHandle(directoryHandle, relativePath).catch(() => null);
                    if (!fileHandle) continue;
                    const file = await fileHandle.getFile();
                    const dataUrl = await blobToDataUrl(file);
                    const inferredMeta = inferAssetFileMeta(file.name, file.type);
                    const assetType = normalizeLibraryAssetType(rawAsset.assetType || inferredMeta?.assetType || 'image');
                    const format = String(rawAsset.format || inferredMeta?.format || (assetType === 'model' ? 'glb' : 'png'));
                    assetEntries.push({
                        name: String(rawAsset.name || stripJsonExtension(file.name) || `Asset ${index + 1}`),
                        tags: normalizeTagList(rawAsset.tags || []),
                        asset: {
                            ...rawAsset,
                            assetType,
                            format,
                            dataUrl,
                            mimeType: normalizeAssetMimeType(format, rawAsset.mimeType || file.type, assetType),
                            origin: rawAsset.origin || 'folder-import'
                        }
                    });
                    await maybeYieldToUi(index, 2);
                }
                return {
                    kind: 'asset-folder',
                    sourceFormat: LIBRARY_ASSET_FOLDER_FORMAT,
                    bundleName: stripJsonExtension(parsed.name || directoryHandle.name || 'noise-studio-assets'),
                    exportedAt: parsed.exportedAt || null,
                    scope: 'assets',
                    projectEntries: [],
                    assetEntries,
                    tags: normalizeTagList([
                        ...(parsed.tags || []),
                        ...assetEntries.flatMap((entry) => entry.tags || [])
                    ])
                };
            }
        }

        const looseAssetEntries = [];
        for (const [index, entry] of allFiles.entries()) {
            const file = await entry.handle.getFile();
            const meta = inferAssetFileMeta(file.name, file.type);
            if (!meta) continue;
            const dataUrl = await blobToDataUrl(file);
            looseAssetEntries.push({
                name: stripJsonExtension(file.name) || `Asset ${index + 1}`,
                tags: [],
                asset: {
                    timestamp: Number(file.lastModified || Date.now()),
                    name: stripJsonExtension(file.name) || `Asset ${index + 1}`,
                    assetType: meta.assetType,
                    format: meta.format,
                    mimeType: meta.mimeType,
                    dataUrl,
                    width: 0,
                    height: 0,
                    origin: 'folder-import'
                }
            });
            await maybeYieldToUi(index, 4);
        }

        return {
            kind: 'asset-folder',
            sourceFormat: 'folder-files',
            bundleName: stripJsonExtension(directoryHandle.name || 'noise-studio-assets'),
            exportedAt: null,
            scope: 'assets',
            projectEntries: [],
            assetEntries: looseAssetEntries,
            tags: []
        };
    }

    async function importAssetFolder() {
        if (!window.showDirectoryPicker) {
            showAlert('Folder access is not supported in this browser.');
            return;
        }

        try {
            const directoryHandle = await window.showDirectoryPicker();
            logLibrary('active', 'library.import', `Scanning asset folder "${directoryHandle.name || 'Assets'}" for import.`);
            showProgress('Scanning asset folder...', directoryHandle.name || 'Assets', 0.05);
            await nextPaint();
            const importPackage = await parseAssetFolder(directoryHandle);
            hideProgress();
            if (!importPackage.assetEntries.length) {
                showAlert('No supported image or 3D asset files were found in that folder.');
                return;
            }
            await applyImportPackages([importPackage], { allowReplacePrompt: true });
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.error(error);
            logLibrary('error', 'library.import', error.message || 'Could not import that asset folder.');
            showAlert(error.message || 'Could not import that asset folder.');
        } finally {
            hideProgress();
        }
    }

    async function exportAssetFolder() {
        if (!assetData.length) {
            showAlert('There are no Assets to export.');
            return;
        }
        if (!window.showDirectoryPicker) {
            showAlert('Folder access is not supported in this browser.');
            return;
        }

        try {
            const directoryHandle = await window.showDirectoryPicker();
            logLibrary('active', 'library.export', `Exporting ${assetData.length} asset${assetData.length === 1 ? '' : 's'} to folder "${directoryHandle.name}".`);
            showProgress('Preparing asset folder export...', directoryHandle.name, 0.02);
            await nextPaint();
            const assetsDirectoryHandle = await directoryHandle.getDirectoryHandle('assets', { create: true });
            const manifest = buildLibraryAssetFolderManifest({
                assets: assetData,
                tagCatalog: getTagCatalogForScope('assets'),
                name: getScopeDefaultBaseName('assets')
            });
            const usedNames = new Map();
            const manifestAssets = [];

            for (let index = 0; index < assetData.length; index += 1) {
                const asset = assetData[index];
                const extension = getAssetFileExtension(asset);
                const baseStem = sanitizeFileStem(stripJsonExtension(asset.name || `asset-${index + 1}`), `asset-${index + 1}`);
                const duplicateCount = usedNames.get(baseStem) || 0;
                usedNames.set(baseStem, duplicateCount + 1);
                const fileStem = duplicateCount ? `${baseStem}-${duplicateCount + 1}` : baseStem;
                const fileName = `${fileStem}.${extension}`;
                const blob = await dataUrlToBlob(asset.dataUrl);
                await writeDirectoryFile(assetsDirectoryHandle, fileName, blob);
                manifestAssets.push({
                    ...buildLibraryAssetExportPayload(asset),
                    dataUrl: undefined,
                    fileName: `assets/${fileName}`
                });
                showProgress('Exporting asset folder...', `${index + 1} of ${assetData.length}`, (index + 1) / Math.max(1, assetData.length));
                await maybeYieldToUi(index, 2);
            }

            manifest.assets = manifestAssets;
            await writeDirectoryFile(directoryHandle, 'library-assets-manifest.json', JSON.stringify(manifest, null, 2));
            logLibrary('success', 'library.export', `Exported ${assetData.length} asset${assetData.length === 1 ? '' : 's'} to folder "${directoryHandle.name}".`);
            showAlert(`Exported ${assetData.length} asset${assetData.length === 1 ? '' : 's'} to "${directoryHandle.name}".`, 'Assets Exported');
        } catch (error) {
            if (error?.name === 'AbortError') return;
            console.error(error);
            logLibrary('error', 'library.export', error.message || 'Could not export the asset folder.');
            showAlert(error.message || 'Could not export that asset folder.');
        } finally {
            hideProgress();
        }
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
            logLibrary('active', 'library.export', `Creating a ZIP export for ${libraryData.length} Library project${libraryData.length === 1 ? '' : 's'}.`);
            showProgress('Creating Library ZIP...', `${libraryData.length} project${libraryData.length === 1 ? '' : 's'}`, 0.1);
            await nextPaint();
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
                await maybeYieldToUi(index, 3);
            }

            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = 'noise-studio-library.zip';
            link.click();
            logLibrary('success', 'library.export', 'Created Library ZIP export "noise-studio-library.zip".');
            setTimeout(() => URL.revokeObjectURL(url), 0);
        } catch (error) {
            console.error(error);
            logLibrary('error', 'library.export', error.message || 'Could not create the Library ZIP export.');
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
            logLibrary('active', 'library.import', `Parsing ${files.length} uploaded Library file${files.length === 1 ? '' : 's'}.`);
            const importPackages = [];
            for (const file of files) {
                const parsedPackage = await parseUploadFile(file);
                if (!parsedPackage) return;
                importPackages.push(parsedPackage);
            }
            await applyImportPackages(importPackages, { allowReplacePrompt: true });
        } catch (error) {
            console.error(error);
            logLibrary('error', 'library.import', error.message || 'The Library JSON import failed.');
            showAlert(error.message || 'The Library JSON import failed.');
        } finally {
            hideProgress();
            refs.uploadInput.value = '';
        }
    }

    async function deleteEntry(id) {
        const entry = getCurrentData().find((item) => item.id === id);
        if (!entry) return;

        showModal({
            text: `Delete "${entry.name}" from the ${isAssetsPage() ? 'Assets' : 'Library'} page?`,
            confirmLabel: 'Delete',
            isDanger: true,
            onConfirm: async () => {
                if (detailData?.id === id) closeDetail();
                if (isAssetsPage()) {
                    if (selectedAssetId === id) selectedAssetId = null;
                    if (selectedAssetIds.has(id)) {
                        selectedAssetIds.delete(id);
                    }
                } else {
                    if (selectedProjectId === id) selectedProjectId = null;
                    if (selectedProjectIds.has(id)) {
                        selectedProjectIds.delete(id);
                    }
                }
                updateSelectToggle();
                if (isAssetsPage()) {
                    await actions.deleteLibraryAsset?.(id);
                } else {
                    await actions.deleteLibraryProject?.(id);
                }
                await refresh();
            }
        });
    }

    async function deleteSelectedEntries() {
        const selectedEntries = getSelectedProjects();
        if (!selectedEntries.length) {
            showAlert(`Select one or more ${isAssetsPage() ? 'saved assets' : 'Library projects'} first.`);
            return;
        }
        const itemLabel = isAssetsPage() ? 'asset' : 'project';

        showModal({
            text: `Delete ${selectedEntries.length} selected ${itemLabel}${selectedEntries.length === 1 ? '' : 's'} from the ${isAssetsPage() ? 'Assets' : 'Library'} page?`,
            confirmLabel: 'Delete',
            isDanger: true,
            onConfirm: async () => {
                const ids = selectedEntries.map((item) => item.id);
                if (detailData && ids.includes(detailData.id)) closeDetail();
                if (isAssetsPage()) {
                    if (selectedAssetId && ids.includes(selectedAssetId)) {
                        selectedAssetId = null;
                    }
                } else if (selectedProjectId && ids.includes(selectedProjectId)) {
                    selectedProjectId = null;
                }
                clearProjectSelection();
                if (isAssetsPage()) {
                    await actions.deleteLibraryAssets?.(ids);
                } else {
                    await actions.deleteLibraryProjects?.(ids);
                }
                await refresh();
            }
        });
    }

    async function clearAll() {
        const currentData = getCurrentData();
        if (!currentData.length) {
            showAlert(isAssetsPage() ? 'The Assets page is already empty.' : 'The Library is already empty.');
            return;
        }

        showModal({
            text: isAssetsPage()
                ? 'Clear every saved asset from the Assets page? This cannot be undone.'
                : 'Clear every saved Library project? This cannot be undone.',
            confirmLabel: isAssetsPage() ? 'Clear Assets' : 'Clear Library',
            isDanger: true,
            onConfirm: async () => {
                resetScopeUiState(isAssetsPage() ? 'assets' : 'library');
                if (isAssetsPage()) {
                    await actions.clearLibraryAssets?.();
                } else {
                    await actions.clearLibraryProjects?.();
                }
                await refresh();
            }
        });
    }

    async function loadProjectIntoEditor(project) {
        if (!project) return;
        const targetLabel = project.projectType === 'composite'
            ? 'Composite'
            : project.projectType === 'stitch'
            ? 'Stitch'
            : project.projectType === '3d'
                ? '3D'
                : 'Editor';
        showProgress('Loading Library project...', `Validating "${project.name || 'project'}" and opening it in ${targetLabel}`, 0.18);
        await nextPaint();
        try {
            const loaded = await actions.loadLibraryProject(project.payload, project.id, project.name);
            if (loaded) closeDetail();
        } finally {
            hideProgress();
        }
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

            if (action === 'set-page-mode') {
                setActivePageMode(actionNode.dataset.mode || 'library');
                return;
            }

            if (action === 'upload') {
                await triggerUpload();
                return;
            }

            if (action === 'import-folder') {
                await importAssetFolder();
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

            if (action === 'export-folder') {
                await exportAssetFolder();
                return;
            }

            if (action === 'clear-all') {
                await clearAll();
                return;
            }

            if (action === 'delete-selected-projects') {
                await deleteSelectedEntries();
                return;
            }

            if (action === 'clear-selection') {
                clearProjectSelection();
                renderGrid();
                renderSidePanel();
                return;
            }

            if (action === 'delete-project') {
                await deleteEntry(actionNode.dataset.libraryId);
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
                    text: `Remove "${tag}" from the selected ${isAssetsPage() ? 'items' : 'projects'}? The tag itself will remain available in the Library.`,
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
                    text: `Remove "${tag}" from this ${isAssetsPage() ? 'asset' : 'project'}? The tag itself will remain available in the Library.`,
                    confirmLabel: 'Remove Tag',
                    onConfirm: async () => {
                        await removeTagFromFocusedEntry(tag);
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
                const entry = getSelectedProject();
                if (entry) openDetailByData(entry);
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
                await downloadProject(detailData || getSelectedProject());
                return;
            }

            if (action === 'load-detail') {
                await loadProjectIntoEditor(detailData || getSelectedProject());
                return;
            }

            if (action === 'download-asset') {
                await downloadAssetFile(detailData || getSelectedProject());
                return;
            }

            if (action === 'rename-asset') {
                await renameFocusedAsset(detailData || getSelectedProject());
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
        const entry = getVisibleCurrentData()[index];
        if (!entry) return;

        if (isSelectMode) {
            toggleProjectSelection(entry.id);
            renderGrid();
            renderSidePanel();
            return;
        }

        setSelectedPrimaryId(entry.id);
        if (!isAssetsPage()) {
            currentIndex = index;
        }
        openDetailByData(entry);
    });

    document.addEventListener('pointerdown', handleGlobalPointerDown, true);
    document.addEventListener('keydown', handleGlobalKeyDown);

    setHoverEnabled(false);
    setFullscreenEnabled(false);
    setSidePanelOpen(false);
    applyLibraryPreferenceDefaults();
    updateToolbarState();
    renderSidePanel();

    return {
        activate() {
            panelActive = true;
            root.style.display = 'block';
            logLibrary('info', 'library.sync', 'Library page activated.', {
                dedupeKey: 'library-page-activated',
                dedupeWindowMs: 160
            });
            if (!hasRenderedLibrary || pendingRefreshWhileInactive) {
                refresh().catch((error) => {
                    console.error(error);
                    showAlert('Could not load the Library page.');
                });
            } else {
                applyViewState();
            }
        },
        deactivate() {
            panelActive = false;
            root.style.display = 'none';
            logLibrary('info', 'library.sync', 'Library page hidden.', {
                dedupeKey: 'library-page-hidden',
                dedupeWindowMs: 160
            });
            setSidePanelOpen(false);
            clearAssetPreview();
        },
        refresh
    };
}
