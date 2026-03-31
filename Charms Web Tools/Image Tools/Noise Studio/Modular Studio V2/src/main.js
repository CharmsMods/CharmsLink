import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { downloadState, readJsonFile, validateImportPayload } from './io/documents.js';
import { createProjectAdapterRegistry } from './io/projectAdapters.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { StitchEngine } from './stitch/engine.js';
import {
    applyCandidateToDocument,
    coerceStitchSettingValue,
    computeCompositeBounds,
    createEmptyStitchDocument,
    createStitchInputId,
    getPlacementByInput,
    normalizeStitchDocument,
    stripEphemeralStitchState,
    summarizeStitchDocument,
    updateInputOrder as updateStitchInputOrderHelper,
    updatePlacement as updateStitchPlacementHelper
} from './stitch/document.js';
import { createWorkspaceUI } from './ui/workspaces.js';
import { clamp, createDefaultViewState, normalizeViewState, MAX_PREVIEW_ZOOM } from './state/documentHelpers.js';
import {
    createEmptyThreeDDocument,
    createThreeDCameraPresetId,
    createThreeDSceneItemId,
    isThreeDDocumentPayload,
    normalizeThreeDDocument,
    serializeThreeDDocument,
    summarizeThreeDDocument
} from './3d/document.js';

const DB_NAME = 'ModularStudioDB';
const DB_VERSION = 2;
const STORE_NAME = 'LibraryProjects';
const LIBRARY_META_ID = '__library_meta__';

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onblocked = () => reject(new Error('Library database upgrade was blocked by another open tab.'));
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => {
            const db = e.target.result;
            if (db.objectStoreNames.contains(STORE_NAME)) {
                resolve(db);
                return;
            }

            const nextVersion = db.version + 1;
            db.close();
            const repairRequest = indexedDB.open(DB_NAME, nextVersion);
            repairRequest.onblocked = () => reject(new Error('Library database repair was blocked by another open tab.'));
            repairRequest.onupgradeneeded = (repairEvent) => {
                const repairDb = repairEvent.target.result;
                if (!repairDb.objectStoreNames.contains(STORE_NAME)) {
                    repairDb.createObjectStore(STORE_NAME, { keyPath: 'id' });
                }
            };
            repairRequest.onsuccess = (repairEvent) => resolve(repairEvent.target.result);
            repairRequest.onerror = (repairEvent) => reject(repairEvent.target.error);
        };
        request.onerror = (e) => reject(e.target.error);
    });
}

function saveToLibraryDB(project) {
    if (!project.id) project.id = Date.now().toString(36) + Math.random().toString(36).substr(2);
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).put(project);
        req.onsuccess = () => resolve(project);
        req.onerror = (e) => reject(e.target.error);
    }));
}

function getFromLibraryDB(id) {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
    }));
}

function deleteFromLibraryDB(id) {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    }));
}

function clearAllFromLibraryDB() {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const req = tx.objectStore(STORE_NAME).clear();
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    }));
}

function getAllFromLibraryDB() {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = (e) => reject(e.target.error);
    }));
}

function stableSerialize(value) {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const keys = Object.keys(value).sort();
        return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function stripLibraryMetadata(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const cloned = JSON.parse(JSON.stringify(payload));
    delete cloned._libraryName;
    delete cloned._libraryTags;
    delete cloned._libraryProjectType;
    delete cloned._libraryHoverSource;
    delete cloned._librarySourceArea;
    delete cloned._librarySourceCount;
    if (isThreeDDocumentPayload(cloned)) {
        if (cloned.preview && typeof cloned.preview === 'object') {
            delete cloned.preview.width;
            delete cloned.preview.height;
            delete cloned.preview.imageData;
            delete cloned.preview.updatedAt;
        }
        if (cloned.render && typeof cloned.render === 'object') {
            delete cloned.render.currentSamples;
        }
    }
    return cloned;
}

function makeProjectFingerprint(payload) {
    return stableSerialize(stripLibraryMetadata(payload));
}

function createLibraryProjectId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function stripProjectExtension(name) {
    return String(name || '').replace(/\.[^/.]+$/, '');
}

function normalizeLibraryTags(tags) {
    if (!Array.isArray(tags)) return [];
    const seen = new Set();
    const normalized = [];
    tags.forEach((tag) => {
        const trimmed = String(tag || '').trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push(trimmed);
    });
    return normalized;
}

function isLibraryMetaRecord(entry) {
    return !!entry && (entry.id === LIBRARY_META_ID || entry.kind === 'library-meta');
}

async function getLibraryMetaRecord() {
    const existing = await getFromLibraryDB(LIBRARY_META_ID);
    if (isLibraryMetaRecord(existing)) {
        return {
            ...existing,
            kind: 'library-meta',
            tags: normalizeLibraryTags(existing.tags || [])
        };
    }
    return {
        id: LIBRARY_META_ID,
        kind: 'library-meta',
        tags: []
    };
}

async function setLibraryMetaTags(tags) {
    const current = await getLibraryMetaRecord();
    const next = {
        ...current,
        kind: 'library-meta',
        tags: normalizeLibraryTags(tags)
    };
    await saveToLibraryDB(next);
    return next.tags;
}

async function loadLibraryTagCatalogFromDB() {
    const entries = await getAllFromLibraryDB();
    const meta = entries.find((entry) => isLibraryMetaRecord(entry)) || { tags: [] };
    const discoveredTags = entries
        .filter((entry) => !isLibraryMetaRecord(entry))
        .flatMap((entry) => normalizeLibraryTags(entry.tags || []));
    return normalizeLibraryTags([...(meta.tags || []), ...discoveredTags]);
}

async function registerLibraryTags(tags) {
    const merged = normalizeLibraryTags([...(await loadLibraryTagCatalogFromDB()), ...normalizeLibraryTags(tags)]);
    await setLibraryMetaTags(merged);
    return merged;
}

function getSuggestedProjectName(documentState, nameOverride = null) {
    return stripProjectExtension(nameOverride || documentState.source?.name || 'Untitled') || 'Untitled';
}

function getSuggestedStitchProjectName(documentState, nameOverride = null) {
    const normalized = normalizeStitchDocument(documentState);
    const primary = normalized.inputs[0];
    const fallback = normalized.inputs.length > 1
        ? `Stitch Project (${normalized.inputs.length} images)`
        : primary?.name
            || 'Stitch Project';
    return stripProjectExtension(nameOverride || fallback) || 'Stitch Project';
}

function getSuggestedThreeDProjectName(documentState, nameOverride = null) {
    const normalized = normalizeThreeDDocument(documentState);
    const firstAsset = normalized.scene.items.find((item) => item.kind !== 'light');
    const fallback = firstAsset?.name || '3D Scene';
    return stripProjectExtension(nameOverride || fallback) || '3D Scene';
}

const THREE_D_PRIMITIVE_LABELS = {
    cube: 'Cube',
    sphere: 'Sphere',
    cone: 'Cone',
    cylinder: 'Cylinder'
};

function createDefaultThreeDMaterial(overrides = {}) {
    return {
        preset: 'matte',
        color: '#ffffff',
        roughness: 0.65,
        metalness: 0,
        opacity: 1,
        emissiveColor: '#ffffff',
        emissiveIntensity: 0,
        ior: 1.5,
        transmission: 1,
        thickness: 0.35,
        attenuationColor: '#ffffff',
        attenuationDistance: 1.5,
        texture: null,
        ...overrides
    };
}

function createUniqueThreeDItemName(baseName, items = []) {
    const desired = String(baseName || 'Item').trim() || 'Item';
    const existingNames = new Set((items || []).map((item) => String(item?.name || '').trim().toLowerCase()).filter(Boolean));
    if (!existingNames.has(desired.toLowerCase())) return desired;
    let suffix = 2;
    while (existingNames.has(`${desired} ${suffix}`.toLowerCase())) {
        suffix += 1;
    }
    return `${desired} ${suffix}`;
}

function createDuplicateThreeDItemName(baseName, items = []) {
    const desired = `${String(baseName || 'Item').trim() || 'Item'} Copy`;
    const existingNames = new Set((items || []).map((item) => String(item?.name || '').trim().toLowerCase()).filter(Boolean));
    if (!existingNames.has(desired.toLowerCase())) return desired;
    let suffix = 2;
    while (existingNames.has(`${desired} ${suffix}`.toLowerCase())) {
        suffix += 1;
    }
    return `${desired} ${suffix}`;
}

function createThreeDPrimitiveItem(primitiveType = 'cube') {
    const normalizedType = Object.prototype.hasOwnProperty.call(THREE_D_PRIMITIVE_LABELS, primitiveType)
        ? primitiveType
        : 'cube';
    const label = THREE_D_PRIMITIVE_LABELS[normalizedType] || 'Primitive';
    return {
        id: createThreeDSceneItemId(normalizedType),
        kind: 'primitive',
        name: label,
        visible: true,
        locked: false,
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
        asset: {
            format: 'primitive',
            primitiveType: normalizedType,
            name: label
        },
        material: createDefaultThreeDMaterial()
    };
}

function buildLibraryPayload(documentState) {
    return {
        version: 'mns/v2',
        kind: 'document',
        mode: 'studio',
        workspace: documentState.workspace,
        palette: documentState.palette,
        selection: documentState.selection,
        view: documentState.view,
        export: documentState.export,
        source: documentState.source,
        layerStack: documentState.layerStack
    };
}

function buildStitchLibraryPayload(documentState) {
    return stripEphemeralStitchState(documentState);
}

function buildThreeDLibraryPayload(documentState) {
    return serializeThreeDDocument(normalizeThreeDDocument(documentState));
}

function normalizeLegacyDocumentPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.version === 2 || payload.version === '2') {
        return {
            mode: payload.mode || 'studio',
            ...payload,
            version: 'mns/v2',
            kind: payload.kind || 'document'
        };
    }
    return payload;
}

function inferProjectTypeFromPayload(payload, fallbackType = null) {
    if (fallbackType === '3d') return '3d';
    if (isThreeDDocumentPayload(payload)) return '3d';
    if (fallbackType === 'stitch') return 'stitch';
    if (payload?.kind === 'stitch-document' || payload?.mode === 'stitch') return 'stitch';
    return 'studio';
}

function extractLibraryProjectMeta(rawPayload) {
    return {
        projectType: rawPayload?._libraryProjectType || null,
        hoverSource: rawPayload?._libraryHoverSource || null,
        sourceArea: Number(rawPayload?._librarySourceArea || 0) || 0,
        sourceCount: Number(rawPayload?._librarySourceCount || 0) || 0,
        tags: normalizeLibraryTags(rawPayload?._libraryTags || [])
    };
}

const activeLibraryOrigins = {
    studio: { id: null, name: null },
    stitch: { id: null, name: null },
    '3d': { id: null, name: null }
};

function getActiveLibraryOrigin(projectType) {
    return activeLibraryOrigins[projectType] || activeLibraryOrigins.studio;
}

function setActiveLibraryOrigin(projectType, id, name) {
    const origin = getActiveLibraryOrigin(projectType);
    origin.id = id || null;
    origin.name = name || null;
}

function clearActiveLibraryOrigin(projectType = null) {
    if (!projectType) {
        setActiveLibraryOrigin('studio', null, null);
        setActiveLibraryOrigin('stitch', null, null);
        setActiveLibraryOrigin('3d', null, null);
        return;
    }
    setActiveLibraryOrigin(projectType, null, null);
}

function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataUrl;
    });
}

async function dataUrlToBlob(dataUrl) {
    const response = await fetch(dataUrl);
    return response.blob();
}

function normalizeLibraryHoverSource(source) {
    if (!source?.imageData) return null;
    return {
        name: String(source.name || ''),
        type: String(source.type || ''),
        imageData: String(source.imageData || ''),
        width: Math.max(0, Number(source.width) || 0),
        height: Math.max(0, Number(source.height) || 0)
    };
}

function buildLibraryProjectRecord({
    id,
    name,
    blob,
    payload,
    tags = [],
    projectType = 'studio',
    hoverSource = null,
    sourceWidth = 0,
    sourceHeight = 0,
    sourceArea = 0,
    sourceCount = 0,
    renderWidth = 0,
    renderHeight = 0,
    timestamp = Date.now()
}) {
    return {
        id,
        timestamp,
        name: String(name || 'Untitled Project'),
        blob,
        payload,
        tags: normalizeLibraryTags(tags),
        projectType,
        hoverSource: normalizeLibraryHoverSource(hoverSource),
        sourceWidth: Math.max(0, Number(sourceWidth) || 0),
        sourceHeight: Math.max(0, Number(sourceHeight) || 0),
        sourceAreaOverride: Math.max(0, Number(sourceArea) || 0),
        sourceCount: Math.max(0, Number(sourceCount) || 0),
        renderWidth: Math.max(0, Number(renderWidth) || 0),
        renderHeight: Math.max(0, Number(renderHeight) || 0)
    };
}

function releaseUnusedStitchPreviewUrls(previousPreviews = {}, nextPreviews = {}) {
    const retained = new Set(
        Object.values(nextPreviews)
            .filter((value) => value && String(value).startsWith('blob:'))
    );
    Object.values(previousPreviews || {}).forEach((value) => {
        if (value && String(value).startsWith('blob:') && !retained.has(value)) {
            URL.revokeObjectURL(value);
        }
    });
}

function appendStitchInputs(documentState, newInputs) {
    const normalized = normalizeStitchDocument(documentState);
    const nextInputs = (Array.isArray(newInputs) ? newInputs : []).filter((input) => input?.imageData);
    if (!nextInputs.length) return normalized;

    const bounds = computeCompositeBounds(normalized);
    let cursorX = normalized.inputs.length ? bounds.maxX + 48 : 0;
    const nextPlacements = [...normalized.placements];
    const baseZ = nextPlacements.length;

    nextInputs.forEach((input, index) => {
        nextPlacements.push({
            inputId: input.id,
            x: cursorX,
            y: 0,
            scale: 1,
            rotation: 0,
            visible: true,
            locked: false,
            z: baseZ + index,
            opacity: 1
        });
        cursorX += Math.max(1, Number(input.width) || 1) + 48;
    });

    return normalizeStitchDocument({
        ...normalized,
        inputs: [...normalized.inputs, ...nextInputs],
        placements: nextPlacements,
        candidates: [],
        activeCandidateId: null,
        selection: {
            inputId: nextInputs[0]?.id || normalized.selection.inputId || null
        },
        analysis: {
            ...normalized.analysis,
            status: 'idle',
            warning: normalized.inputs.length
                ? 'Run the analysis again to include the newly added images.'
                : '',
            error: '',
            backend: '',
            diagnostics: [],
            previews: {}
        }
    });
}

function hslToHex(hue, saturation, lightness) {
    const chroma = (1 - Math.abs((2 * lightness) - 1)) * saturation;
    const segment = hue / 60;
    const x = chroma * (1 - Math.abs((segment % 2) - 1));
    let red = 0;
    let green = 0;
    let blue = 0;

    if (segment >= 0 && segment < 1) {
        red = chroma;
        green = x;
    } else if (segment < 2) {
        red = x;
        green = chroma;
    } else if (segment < 3) {
        green = chroma;
        blue = x;
    } else if (segment < 4) {
        green = x;
        blue = chroma;
    } else if (segment < 5) {
        red = x;
        blue = chroma;
    } else {
        red = chroma;
        blue = x;
    }

    const match = lightness - (chroma / 2);
    return `#${[red, green, blue]
        .map((value) => Math.round((value + match) * 255).toString(16).padStart(2, '0'))
        .join('')}`;
}

function createRandomPaletteColor() {
    const hue = Math.random() * 360;
    const saturation = 0.55 + (Math.random() * 0.35);
    const lightness = 0.35 + (Math.random() * 0.3);
    return hslToHex(hue, saturation, lightness);
}

const STUDIO_VIEWS = new Set(['edit', 'layer', 'pipeline', 'scopes']);

function normalizePanelView(_mode, view, hasSelection = false) {
    if (STUDIO_VIEWS.has(view)) return view;
    return hasSelection ? 'layer' : 'edit';
}

function normalizeWorkspace(_mode, workspace = {}, hasSelection = false) {
    return {
        batchOpen: !!workspace.batchOpen,
        studioView: normalizePanelView('studio', workspace.studioView, hasSelection)
    };
}

function createEmptyBatchState() {
    return {
        imageFiles: [],
        allFiles: [],
        currentIndex: 0,
        isPlaying: false,
        actualFps: 0
    };
}

function getInitialActiveSection() {
    try {
        const section = new URL(window.location.href).searchParams.get('section');
        if (section === 'library' || section === 'stitch' || section === '3d') return section;
        return 'editor';
    } catch (_error) {
        return 'editor';
    }
}

function syncSectionUrl(section) {
    try {
        const url = new URL(window.location.href);
        if (section === 'library') url.searchParams.set('section', 'library');
        else if (section === 'stitch') url.searchParams.set('section', 'stitch');
        else if (section === '3d') url.searchParams.set('section', '3d');
        else url.searchParams.delete('section');
        window.history.replaceState(null, '', url);
    } catch (_error) {
        // Ignore URL sync issues in unsupported environments.
    }
}

function createInitialState() {
    return {
        document: {
            version: 'mns/v2',
            kind: 'document',
            mode: 'studio',
            workspace: { studioView: 'edit', batchOpen: false },
            source: { name: '', type: '', imageData: null, width: 0, height: 0 },
            palette: ['#111111', '#f5f7fa', '#ff8a00', '#00d1ff'],
            layerStack: [],
            selection: { layerInstanceId: null },
            view: createDefaultViewState(),
            export: { keepFolderStructure: false, playFps: 10 },
            batch: createEmptyBatchState()
        },
        stitchDocument: createEmptyStitchDocument('light'),
        threeDDocument: createEmptyThreeDDocument(),
        ui: {
            activeSection: getInitialActiveSection(),
            compareOpen: false,
            jsonCompareModalOpen: false,
            jsonCompareResults: [],
            jsonCompareView: 'grid',
            jsonCompareIndex: 0,
            loadImageOnOpen: true,
            saveImageOnSave: false
        },
        notice: null,
        eyedropperTarget: null
    };
}

function reindexStack(registry, layerStack) {
    const normalized = layerStack.map((instance) => {
        const layer = registry.byId[instance.layerId];
        if (!layer) return null;
        const params = { ...(layer.defaults || {}), ...(instance.params || {}) };
        const enabled = layer.enableKey && typeof params[layer.enableKey] === 'boolean'
            ? params[layer.enableKey]
            : typeof instance.enabled === 'boolean'
                ? instance.enabled
                : layer.enableDefault !== false;
        return {
            ...instance,
            enabled,
            visible: instance.visible !== false,
            params
        };
    }).filter(Boolean);

    return normalized.map((instance) => {
        const siblings = normalized.filter((item) => item.layerId === instance.layerId);
        return relabelInstance(instance, registry, siblings);
    });
}

function coerceValue(existing, rawValue) {
    if (typeof existing === 'boolean') return !!rawValue;
    if (typeof existing === 'number') return Number(rawValue);
    return rawValue;
}

function clampByte(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return clamp(Math.round(numeric), 0, 255);
}

function normalizeRgbaColor(color) {
    if (!color || typeof color !== 'object') {
        return { r: 255, g: 255, b: 255, a: 255 };
    }
    return {
        r: clampByte(color.r ?? 255),
        g: clampByte(color.g ?? 255),
        b: clampByte(color.b ?? 255),
        a: clampByte(color.a ?? 255)
    };
}

function createPaletteFromImage(image, count) {
    const canvas = document.createElement('canvas');
    const longestEdge = Math.max(image.width || 1, image.height || 1);
    const sampleScale = Math.min(1, 320 / longestEdge);
    canvas.width = Math.max(1, Math.round((image.width || 1) * sampleScale));
    canvas.height = Math.max(1, Math.round((image.height || 1) * sampleScale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    const samples = [];
    const targetCount = clamp(Math.round(Number(count) || 8), 2, 200);
    const totalPixels = canvas.width * canvas.height;
    const maxSamples = targetCount > 96 ? 10000 : 8000;
    const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / maxSamples)));

    for (let y = 0; y < canvas.height; y += stride) {
        for (let x = 0; x < canvas.width; x += stride) {
            const index = ((y * canvas.width) + x) * 4;
            const alpha = pixels[index + 3];
            if (alpha < 240) continue;
            samples.push({
                r: pixels[index],
                g: pixels[index + 1],
                b: pixels[index + 2]
            });
        }
    }
    if (!samples.length) return ['#111111', '#f5f7fa'];
    const paletteSize = Math.min(targetCount, samples.length);
    const centers = [samples[Math.floor(Math.random() * samples.length)]];
    const minDistances = new Array(samples.length).fill(Infinity);

    const distanceSq = (a, b) => {
        const dr = a.r - b.r;
        const dg = a.g - b.g;
        const db = a.b - b.b;
        return (dr * dr) + (dg * dg) + (db * db);
    };

    const refreshDistances = (center) => {
        samples.forEach((sample, index) => {
            const dist = distanceSq(sample, center);
            if (dist < minDistances[index]) minDistances[index] = dist;
        });
    };

    refreshDistances(centers[0]);
    while (centers.length < paletteSize) {
        let bestIndex = 0;
        let bestDistance = -1;
        minDistances.forEach((distance, index) => {
            if (distance > bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        });
        centers.push({ ...samples[bestIndex] });
        refreshDistances(samples[bestIndex]);
    }

    for (let iteration = 0; iteration < 5; iteration += 1) {
        const totals = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));

        samples.forEach((sample) => {
            let bestIndex = 0;
            let bestDistance = Infinity;
            centers.forEach((center, index) => {
                const dist = distanceSq(sample, center);
                if (dist < bestDistance) {
                    bestDistance = dist;
                    bestIndex = index;
                }
            });
            totals[bestIndex].r += sample.r;
            totals[bestIndex].g += sample.g;
            totals[bestIndex].b += sample.b;
            totals[bestIndex].count += 1;
        });

        let moved = false;
        centers.forEach((center, index) => {
            const total = totals[index];
            if (!total.count) return;
            const next = {
                r: Math.round(total.r / total.count),
                g: Math.round(total.g / total.count),
                b: Math.round(total.b / total.count)
            };
            if (next.r !== center.r || next.g !== center.g || next.b !== center.b) moved = true;
            centers[index] = next;
        });
        if (!moved) break;
    }

    return centers
        .map((sample) => ({
            hex: `#${[sample.r, sample.g, sample.b].map((value) => value.toString(16).padStart(2, '0')).join('')}`,
            weight: (sample.r * 0.2126) + (sample.g * 0.7152) + (sample.b * 0.0722)
        }))
        .sort((a, b) => a.weight - b.weight)
        .map((sample) => sample.hex);
}

window.addEventListener('DOMContentLoaded', async () => {
    const registry = await loadRegistry();
    const store = createStore(createInitialState());
    const root = document.getElementById('app');
    const engine = new NoiseStudioEngine(registry, {
        onNotice: (text, type = 'info') => setNotice(text, type),
        onMetrics: ({ fps }) => {
            const state = store.getState();
            if (!state.document.batch.isPlaying) return;
            store.setState((current) => ({
                ...current,
                document: {
                    ...current.document,
                    batch: { ...current.document.batch, actualFps: fps }
                }
            }));
        }
    });
    const stitchEngine = new StitchEngine();

    let noticeTimer = null;
    let playbackTimer = null;
    let view = null;
    let paletteExtractionImage = null;
    let paletteExtractionOwner = null;
    let stitchAnalysisToken = 0;

    function setNotice(text, type = 'info', timeout = 4200) {
        if (noticeTimer) clearTimeout(noticeTimer);
        store.setState((state) => ({ ...state, notice: { text, type } }));
        if (timeout > 0) {
            noticeTimer = setTimeout(() => {
                store.setState((state) => ({ ...state, notice: null }));
            }, timeout);
        }
    }

    function updateDocument(mutator, meta = { render: true }) {
        store.setState((state) => ({ ...state, document: mutator(state.document) }), meta);
    }

    function updateStitchDocument(mutator, meta = { renderStitch: true }) {
        const previous = store.getState().stitchDocument;
        const next = normalizeStitchDocument(mutator(previous));
        releaseUnusedStitchPreviewUrls(previous?.analysis?.previews, next?.analysis?.previews);
        store.setState((state) => ({ ...state, stitchDocument: next }), meta);
    }

    function updateThreeDDocument(mutator, meta = { render: false }) {
        const previous = store.getState().threeDDocument;
        const next = normalizeThreeDDocument(mutator(previous));
        store.setState((state) => ({ ...state, threeDDocument: next }), meta);
    }

    function isThreeDRenderJobActive() {
        return !!store.getState().threeDDocument?.renderJob?.active;
    }

    function ensureThreeDSceneUnlocked(actionLabel = 'editing the 3D scene') {
        if (!isThreeDRenderJobActive()) return true;
        setNotice(`Abort the active 3D render before ${actionLabel}.`, 'warning', 6000);
        return false;
    }

    function updateInstance(instanceId, updater, meta = { render: true }) {
        updateDocument((document) => ({
            ...document,
            layerStack: document.layerStack.map((instance) => instance.instanceId === instanceId ? updater(instance, registry.byId[instance.layerId]) : instance)
        }), meta);
    }

    function buildCanvasPixelSample(pixel, uv, canvas) {
        if (!pixel || !uv || !canvas?.width || !canvas?.height) return null;
        return {
            ...pixel,
            x: clamp(Math.floor(uv.x * canvas.width), 0, Math.max(0, canvas.width - 1)),
            y: clamp(Math.floor(uv.y * canvas.height), 0, Math.max(0, canvas.height - 1)),
            width: canvas.width,
            height: canvas.height
        };
    }

    function getLayerInputSample(instanceId, uv, previewPixel = null) {
        if (!instanceId || !uv) return null;
        const activeCanvas = engine.getActiveDisplayCanvas?.();
        const sampledPreviewPixel = previewPixel || engine.pickPixelAtUv(uv.x, uv.y);
        const fallbackSample = buildCanvasPixelSample(sampledPreviewPixel, uv, activeCanvas);
        const layerSample = engine.pickSelectedLayerInputAtUv(instanceId, uv.x, uv.y)
            || engine.pickLayerInputAtUv(store.getState().document, instanceId, uv.x, uv.y);

        if (layerSample) return layerSample;
        if (!engine.runtime.hasRenderableLayers) return fallbackSample;
        return null;
    }

    async function syncImageSource(file, dataUrl) {
        await engine.loadImageFromFile(file, { imageData: dataUrl });
        updateDocument((document) => ({
            ...document,
            source: {
                name: file.name,
                type: file.type,
                imageData: dataUrl,
                width: engine.runtime.sourceWidth,
                height: engine.runtime.sourceHeight
            }
        }));
    }

    async function loadBatchImage(file, index) {
        await engine.loadImageFromFile(file, {});
        updateDocument((document) => ({
            ...document,
            source: {
                name: file.name,
                type: file.type,
                imageData: null,
                width: engine.runtime.sourceWidth,
                height: engine.runtime.sourceHeight
            },
            batch: {
                ...document.batch,
                currentIndex: index
            }
        }));
    }

    function stopPlayback() {
        if (playbackTimer) clearInterval(playbackTimer);
        playbackTimer = null;
        updateDocument((document) => ({
            ...document,
            batch: { ...document.batch, isPlaying: false }
        }), { render: false });
    }

    function commitActiveSection(section) {
        const nextSection = section === 'library' ? 'library' : section === 'stitch' ? 'stitch' : section === '3d' ? '3d' : 'editor';
        if (nextSection !== 'editor') stopPlayback();
        syncSectionUrl(nextSection);
        store.setState((state) => ({
            ...state,
            document: nextSection !== 'editor'
                ? {
                    ...state.document,
                    workspace: { ...state.document.workspace, batchOpen: false }
                }
                : state.document,
            ui: {
                ...state.ui,
                activeSection: nextSection,
                compareOpen: nextSection === 'editor' ? state.ui.compareOpen : false,
                jsonCompareModalOpen: nextSection === 'editor' ? state.ui.jsonCompareModalOpen : false
            },
            eyedropperTarget: nextSection === 'editor' ? state.eyedropperTarget : null
        }), { render: false });
    }

    function notifyLibraryChanged() {
        view?.refreshLibrary?.();
    }

    let projectAdapters = null;

    function getProjectTypeForSection(section) {
        if (section === '3d') return '3d';
        return section === 'stitch' ? 'stitch' : 'studio';
    }

    function getLibraryProjectType(entry) {
        if (!entry) return 'studio';
        return inferProjectTypeFromPayload(entry.payload, entry.projectType || null);
    }

    async function createStitchInputsFromFiles(files) {
        const inputs = [];
        for (const file of files || []) {
            if (!file?.type?.startsWith('image/')) continue;
            const imageData = await fileToDataUrl(file);
            const image = await loadImageFromDataUrl(imageData);
            inputs.push({
                id: createStitchInputId(),
                name: file.name,
                type: file.type,
                imageData,
                width: image.naturalWidth || image.width || 1,
                height: image.naturalHeight || image.height || 1
            });
        }
        return inputs;
    }

    async function buildStitchPreviewMap(documentState) {
        const normalized = normalizeStitchDocument(documentState);
        if (!normalized.candidates.length) return {};
        return stitchEngine.buildCandidatePreviewMap(normalized);
    }

    async function createThreeDModelItemsFromFiles(files) {
        const items = [];
        for (const file of files || []) {
            const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
            if (extension !== 'glb' && extension !== 'gltf') continue;
            const dataUrl = await fileToDataUrl(file);
            items.push({
                id: createThreeDSceneItemId('model'),
                kind: 'model',
                name: stripProjectExtension(file.name) || 'Model',
                visible: true,
                locked: false,
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                asset: {
                    format: extension,
                    name: file.name,
                    mimeType: file.type || '',
                    dataUrl
                }
            });
        }
        return items;
    }

    async function createThreeDImagePlaneItemsFromFiles(files) {
        const items = [];
        for (const file of files || []) {
            if (!String(file?.type || '').startsWith('image/')) continue;
            const dataUrl = await fileToDataUrl(file);
            const image = await loadImageFromDataUrl(dataUrl);
            items.push({
                id: createThreeDSceneItemId('image-plane'),
                kind: 'image-plane',
                name: stripProjectExtension(file.name) || 'Image Plane',
                visible: true,
                locked: false,
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                asset: {
                    format: 'image',
                    name: file.name,
                    mimeType: file.type || '',
                    dataUrl,
                    width: image.naturalWidth || image.width || 1,
                    height: image.naturalHeight || image.height || 1
                },
                material: createDefaultThreeDMaterial({
                    roughness: 1
                })
            });
        }
        return items;
    }

    async function getMatchingLibraryEntries(payload, projectType = null) {
        const fingerprint = makeProjectFingerprint(payload);
        try {
            const existing = await getAllFromLibraryDB();
            return existing.filter((entry) => {
                if (!entry.payload || isLibraryMetaRecord(entry)) return false;
                if (projectType && getLibraryProjectType(entry) !== projectType) return false;
                return makeProjectFingerprint(entry.payload) === fingerprint;
            });
        } catch (_error) {
            return [];
        }
    }

    async function ensureProjectCanBeReplaced(projectType, actionLabel) {
        const adapter = projectAdapters?.getAdapter(projectType);
        if (!adapter) return true;
        const state = store.getState();
        const currentDocument = adapter.getCurrentDocument(state);
        if (adapter.isEmpty(currentDocument)) return true;

        const exactMatches = await getMatchingLibraryEntries(adapter.serializeDocument(currentDocument), projectType);
        if (exactMatches.length) return true;

        const shouldSave = confirm(`Save the current ${adapter.label} project to the Library before ${actionLabel}?`);
        if (shouldSave) {
            const saved = await actions.saveProjectToLibrary(adapter.suggestName(currentDocument), {
                forceNew: true,
                preferExisting: true,
                projectType
            });
            return !!saved;
        }
        return confirm(`Continue ${actionLabel} without saving the current ${adapter.label} project to the Library?`);
    }

    const actions = {
        getState() {
            return store.getState();
        },
        setActiveSection(section) {
            commitActiveSection(section);
        },
        setMode(mode) {
            updateDocument((document) => ({
                ...document,
                mode: 'studio',
                workspace: normalizeWorkspace('studio', document.workspace, !!document.selection.layerInstanceId)
            }), { render: false });
        },
        setStudioView(studioView) {
            updateDocument((document) => ({
                ...document,
                mode: 'studio',
                workspace: normalizeWorkspace('studio', { ...document.workspace, studioView }, !!document.selection.layerInstanceId)
            }));
        },
        setTheme(enabled) {
            const theme = enabled ? 'dark' : 'light';
            updateDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    theme
                }
            }), { render: false });
            updateStitchDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    theme
                }
            }), { renderStitch: true, skipViewRender: false });
        },
        setBatchOpen(open) {
            if (!open) stopPlayback();
            updateDocument((document) => ({ ...document, workspace: { ...document.workspace, batchOpen: open } }), { render: false });
        },
        addLayer(layerId) {
            updateDocument((document) => {
                const layer = registry.byId[layerId];
                if (layer?.supportsMultiInstance === false) {
                    const existing = document.layerStack.find((instance) => instance.layerId === layerId);
                    if (existing) {
                        return {
                            ...document,
                            selection: { layerInstanceId: existing.instanceId },
                            view: { ...document.view, layerPreviewIndex: 0 },
                            workspace: normalizeWorkspace(document.mode, { ...document.workspace, studioView: 'layer' }, true)
                        };
                    }
                }
                const next = createLayerInstance(registry, layerId, document.layerStack);
                const layerStack = reindexStack(registry, [...document.layerStack, next]);
                return {
                    ...document,
                    layerStack,
                    selection: { layerInstanceId: next.instanceId },
                    view: { ...document.view, layerPreviewIndex: 0 },
                    workspace: normalizeWorkspace(document.mode, { ...document.workspace, studioView: 'layer' }, true)
                };
            });
        },
        selectLayerFamily(layerId) {
            updateDocument((document) => {
                const target = document.layerStack.find((instance) => instance.layerId === layerId);
                return target ? {
                    ...document,
                    selection: { layerInstanceId: target.instanceId },
                    view: { ...document.view, layerPreviewIndex: 0 },
                    workspace: normalizeWorkspace(document.mode, { ...document.workspace, studioView: 'layer' }, true)
                } : document;
            });
        },
        selectInstance(instanceId) {
            updateDocument((document) => ({
                ...document,
                selection: { layerInstanceId: instanceId },
                view: { ...document.view, layerPreviewIndex: 0 }
            }));
        },
        removeLayer(instanceId) {
            if (paletteExtractionOwner === instanceId) {
                paletteExtractionOwner = null;
                paletteExtractionImage = null;
            }
            updateDocument((document) => {
                const layerStack = reindexStack(registry, document.layerStack.filter((instance) => instance.instanceId !== instanceId));
                const selection = layerStack.find((instance) => instance.instanceId === document.selection.layerInstanceId) ? document.selection : { layerInstanceId: layerStack[0]?.instanceId || null };
                return {
                    ...document,
                    layerStack,
                    selection,
                    view: selection.layerInstanceId === document.selection.layerInstanceId
                        ? document.view
                        : { ...document.view, layerPreviewIndex: 0 },
                    workspace: normalizeWorkspace(document.mode, document.workspace, !!selection.layerInstanceId)
                };
            });
        },
        duplicateLayer(instanceId) {
            updateDocument((document) => {
                const original = document.layerStack.find((instance) => instance.instanceId === instanceId);
                if (!original) return document;
                const layer = registry.byId[original.layerId];
                if (layer?.supportsMultiInstance === false) return document;
                const duplicate = createLayerInstance(registry, original.layerId, document.layerStack);
                duplicate.params = structuredClone(original.params);
                duplicate.enabled = original.enabled;
                duplicate.visible = original.visible;
                const index = document.layerStack.findIndex((instance) => instance.instanceId === instanceId);
                const layerStack = [...document.layerStack];
                layerStack.splice(index + 1, 0, duplicate);
                return {
                    ...document,
                    layerStack: reindexStack(registry, layerStack),
                    selection: { layerInstanceId: duplicate.instanceId },
                    view: { ...document.view, layerPreviewIndex: 0 }
                };
            });
        },
        reorderLayer(sourceId, targetId) {
            updateDocument((document) => {
                const layerStack = [...document.layerStack];
                const from = layerStack.findIndex((instance) => instance.instanceId === sourceId);
                const to = layerStack.findIndex((instance) => instance.instanceId === targetId);
                if (from === -1 || to === -1 || from === to) return document;
                const [item] = layerStack.splice(from, 1);
                layerStack.splice(to, 0, item);
                return { ...document, layerStack: reindexStack(registry, layerStack) };
            });
        },
        toggleLayerEnabled(instanceId) {
            updateDocument((document) => ({
                ...document,
                layerStack: document.layerStack.map((instance) => {
                    if (instance.instanceId !== instanceId) return instance;
                    const layer = registry.byId[instance.layerId];
                    const enabled = !instance.enabled;
                    return {
                        ...instance,
                        enabled,
                        params: layer?.enableKey ? { ...instance.params, [layer.enableKey]: enabled } : instance.params
                    };
                })
            }));
        },
        toggleLayerVisible(instanceId) {
            updateDocument((document) => ({
                ...document,
                layerStack: document.layerStack.map((instance) => instance.instanceId === instanceId ? { ...instance, visible: !instance.visible } : instance)
            }));
        },
        resetCaCenter(instanceId) {
            updateDocument((document) => ({
                ...document,
                layerStack: document.layerStack.map((instance) => instance.instanceId === instanceId ? { ...instance, params: { ...instance.params, caCenterX: 0.5, caCenterY: 0.5 } } : instance)
            }));
        },
        setZoomLock(enabled) {
            updateDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    zoomLocked: !!enabled
                }
            }), { render: false });
        },
        toggleZoomLock() {
            updateDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    zoomLocked: !document.view.zoomLocked
                }
            }), { render: false });
        },
        addBgPatcherProtectedColor(instanceId) {
            updateInstance(instanceId, (instance) => {
                const current = Array.isArray(instance.params.bgPatcherProtectedColors) ? instance.params.bgPatcherProtectedColors : [];
                if (current.length >= 8) return instance;
                return {
                    ...instance,
                    params: {
                        ...instance.params,
                        bgPatcherProtectedColors: [...current, { color: '#808080', tolerance: 15 }]
                    }
                };
            });
        },
        removeBgPatcherProtectedColor(instanceId, index) {
            updateInstance(instanceId, (instance) => ({
                ...instance,
                params: {
                    ...instance.params,
                    bgPatcherProtectedColors: (instance.params.bgPatcherProtectedColors || []).filter((_, itemIndex) => itemIndex !== index)
                }
            }));
        },
        updateBgPatcherProtectedTolerance(instanceId, index, value, meta = { render: true }) {
            updateInstance(instanceId, (instance) => ({
                ...instance,
                params: {
                    ...instance.params,
                    bgPatcherProtectedColors: (instance.params.bgPatcherProtectedColors || []).map((entry, itemIndex) => itemIndex === index
                        ? { ...entry, tolerance: clamp(Number(value) || 0, 0, 100) }
                        : entry)
                }
            }), meta);
        },
        getLayerInputSampleAtClient(instanceId, clientX, clientY) {
            if (!view) return null;
            const uv = view.clientToImageUv(clientX, clientY);
            if (!uv) return null;
            return getLayerInputSample(instanceId, uv);
        },
        addBgPatcherPatchAtCenter(instanceId) {
            const state = store.getState();
            const metrics = engine.getLayerInputMetrics(state.document, instanceId);
            const width = Math.max(1, metrics?.width || state.document.source.width || 256);
            const height = Math.max(1, metrics?.height || state.document.source.height || 256);
            const size = Math.max(10, Math.min(128, Math.round(Math.min(width, height) * 0.18)));
            actions.addBgPatcherPatch(instanceId, {
                x: Math.round((width - size) * 0.5),
                y: Math.round((height - size) * 0.5),
                size,
                color: '#ff0000'
            });
        },
        selectBgPatcherPatch(instanceId, index) {
            updateInstance(instanceId, (instance) => ({
                ...instance,
                params: {
                    ...instance.params,
                    bgPatcherSelectedPatchIndex: index
                }
            }), { render: false });
        },
        addBgPatcherPatch(instanceId, patch) {
            updateInstance(instanceId, (instance) => {
                const current = Array.isArray(instance.params.bgPatcherPatches) ? instance.params.bgPatcherPatches : [];
                if (current.length >= 32) return instance;
                const nextPatch = {
                    x: Math.max(0, Math.round(Number(patch?.x ?? 0))),
                    y: Math.max(0, Math.round(Number(patch?.y ?? 0))),
                    size: Math.max(1, Math.round(Number(patch?.size ?? 64))),
                    color: patch?.color || '#ff0000'
                };
                return {
                    ...instance,
                    params: {
                        ...instance.params,
                        bgPatcherPatchEnabled: true,
                        bgPatcherPatches: [...current, nextPatch],
                        bgPatcherSelectedPatchIndex: current.length
                    }
                };
            });
        },
        updateBgPatcherPatch(instanceId, index, patch, meta = { render: true }) {
            updateInstance(instanceId, (instance) => ({
                ...instance,
                params: {
                    ...instance.params,
                    bgPatcherPatches: (instance.params.bgPatcherPatches || []).map((entry, itemIndex) => itemIndex === index
                        ? { ...entry, ...patch }
                        : entry)
                }
            }), meta);
        },
        removeBgPatcherPatch(instanceId, index) {
            updateInstance(instanceId, (instance) => {
                const nextPatches = (instance.params.bgPatcherPatches || []).filter((_, itemIndex) => itemIndex !== index);
                const currentSelected = Number(instance.params.bgPatcherSelectedPatchIndex ?? -1);
                let nextSelected = -1;
                if (nextPatches.length) {
                    if (currentSelected === index) nextSelected = Math.min(index, nextPatches.length - 1);
                    else if (currentSelected > index) nextSelected = currentSelected - 1;
                    else nextSelected = clamp(currentSelected, 0, nextPatches.length - 1);
                }
                return {
                    ...instance,
                    params: {
                        ...instance.params,
                        bgPatcherPatches: nextPatches,
                        bgPatcherSelectedPatchIndex: nextSelected
                    }
                };
            });
        },
        resetBgPatcher(instanceId) {
            updateInstance(instanceId, (instance, layer) => ({
                ...instance,
                enabled: layer?.enableDefault !== false,
                params: structuredClone(layer?.defaults || instance.params)
            }));
        },
        updateControl(instanceId, key, rawValue, meta) {
            updateDocument((document) => ({
                ...document,
                layerStack: document.layerStack.map((instance) => {
                    if (instance.instanceId !== instanceId) return instance;
                    const current = instance.params[key];
                    const layer = registry.byId[instance.layerId];
                    const nextValue = coerceValue(current, rawValue);
                    const nextParams = { ...instance.params, [key]: nextValue };
                    if (instance.layerId === 'alpha') {
                        if (key === 'alphaExcludeAll' && nextValue) nextParams.alphaExcludeTransparentOnly = false;
                        if (key === 'alphaExcludeTransparentOnly' && nextValue) nextParams.alphaExcludeAll = false;
                    }
                    return {
                        ...instance,
                        enabled: layer?.enableKey === key ? !!nextValue : instance.enabled,
                        params: nextParams
                    };
                }),
                palette: key === 'extractCount' && paletteExtractionImage && paletteExtractionOwner === instanceId
                    ? createPaletteFromImage(paletteExtractionImage, Number(rawValue))
                    : document.palette
            }), meta);
        },
        setZoom(mode) {
            updateDocument((document) => {
                const current = document.view.zoom;
                let next;
                if (typeof mode === 'number') {
                    next = mode;
                } else if (mode === 'fit') {
                    next = 1;
                } else {
                    next = mode === 'in' ? current * 1.1 : current / 1.1;
                }
                return { ...document, view: { ...document.view, zoom: clamp(next, 1, MAX_PREVIEW_ZOOM) } };
            }, { render: false });
        },
        setHighQualityPreview(enabled) {
            updateDocument((document) => ({ ...document, view: { ...document.view, highQualityPreview: enabled } }));
        },
        setHoverCompareEnabled(enabled) {
            updateDocument((document) => ({ ...document, view: { ...document.view, hoverCompareEnabled: enabled } }), { render: false });
        },
        setRenderUpToActiveLayer(enabled) {
            updateDocument((document) => ({ ...document, view: { ...document.view, isolateActiveLayerChain: !!enabled } }));
        },
        toggleLayerPreviews() {
            updateDocument((document) => ({ ...document, view: { ...document.view, layerPreviewsOpen: !document.view.layerPreviewsOpen, layerPreviewIndex: 0 } }));
        },
        cycleLayerPreview() {
            updateDocument((document) => ({ ...document, view: { ...document.view, layerPreviewIndex: (document.view.layerPreviewIndex || 0) + 1 } }));
        },
        addPaletteColor() {
            updateDocument((document) => ({ ...document, palette: [...document.palette, createRandomPaletteColor()] }));
        },
        removePaletteColor(index) {
            updateDocument((document) => ({ ...document, palette: document.palette.filter((_, colorIndex) => colorIndex !== index) }));
        },
        updatePaletteColor(index, value) {
            updateDocument((document) => ({ ...document, palette: document.palette.map((color, colorIndex) => colorIndex === index ? value : color) }));
        },
        randomizePalette() {
            updateDocument((document) => ({ ...document, palette: document.palette.map(() => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`) }));
        },
        clearPalette() {
            updateDocument((document) => ({ ...document, palette: [] }));
        },
        async newStitchProject() {
            if (!await ensureProjectCanBeReplaced('stitch', 'starting a new stitch project')) return;
            stitchAnalysisToken += 1;
            const theme = store.getState().stitchDocument.view?.theme || store.getState().document.view?.theme || 'light';
            updateStitchDocument(() => createEmptyStitchDocument(theme), { renderStitch: true });
            clearActiveLibraryOrigin('stitch');
            commitActiveSection('stitch');
            setNotice('Started a new stitch project.', 'success');
        },
        openStitchPicker() {
            view?.openStitchPicker?.();
        },
        async openStitchImages(files) {
            const nextInputs = await createStitchInputsFromFiles(files);
            if (!nextInputs.length) {
                setNotice('Choose one or more images to add to the Stitch workspace.', 'warning');
                return;
            }
            stitchAnalysisToken += 1;
            updateStitchDocument((document) => appendStitchInputs(document, nextInputs), { renderStitch: true });
            commitActiveSection('stitch');
            setNotice(`Added ${nextInputs.length} image${nextInputs.length === 1 ? '' : 's'} to Stitch.`, 'success');
        },
        async runStitchAnalysis() {
            const snapshot = normalizeStitchDocument(store.getState().stitchDocument);
            if (snapshot.inputs.length < 2) {
                setNotice('Add at least two images before running Stitch analysis.', 'warning');
                updateStitchDocument((document) => ({
                    ...document,
                    analysis: {
                        ...document.analysis,
                        status: 'idle',
                        warning: snapshot.inputs.length ? 'Only one image is loaded, so overlap analysis cannot run yet.' : 'Add two or more images to analyze a stitch.',
                        error: '',
                        backend: '',
                        diagnostics: [],
                        previews: {}
                    }
                }), { renderStitch: true });
                return;
            }

            const token = ++stitchAnalysisToken;
            updateStitchDocument((document) => ({
                ...document,
                workspace: {
                    ...document.workspace,
                    galleryOpen: false
                },
                analysis: {
                    ...document.analysis,
                    status: 'running',
                    warning: '',
                    error: '',
                    backend: '',
                    diagnostics: [],
                    previews: {}
                }
            }), { renderStitch: true });
            setNotice('Running stitch analysis...', 'info', 0);

            try {
                let lastProgressMessage = '';
                const result = await stitchEngine.analyze(snapshot, {
                    onProgress(progress) {
                        if (token !== stitchAnalysisToken) return;
                        const label = String(progress?.label || '').trim();
                        const detail = String(progress?.detail || '').trim();
                        const message = [label, detail].filter(Boolean).join(' ');
                        if (!message || message === lastProgressMessage) return;
                        lastProgressMessage = message;
                        console.info('[Stitch]', progress);
                        updateStitchDocument((document) => {
                            if (document.analysis?.status !== 'running') return document;
                            return {
                                ...document,
                                analysis: {
                                    ...document.analysis,
                                    warning: message
                                }
                            };
                        }, { renderStitch: true });
                    }
                });
                if (token !== stitchAnalysisToken) return;
                const latest = normalizeStitchDocument(store.getState().stitchDocument);
                const analysisCandidates = result.candidates || [];
                const preferredCandidate = (() => {
                    if (!analysisCandidates.length) return null;
                    if (snapshot.settings?.warpMode === 'mesh') {
                        return analysisCandidates.find((candidate) => candidate.modelType === 'mesh') || analysisCandidates[0];
                    }
                    if (snapshot.settings?.warpMode === 'perspective') {
                        return analysisCandidates.find((candidate) => candidate.modelType === 'perspective') || analysisCandidates[0];
                    }
                    if ((snapshot.settings?.sceneMode === 'photo' || snapshot.settings?.sceneMode === 'auto') && snapshot.settings?.warpDistribution === 'balanced') {
                        return analysisCandidates.find((candidate) => candidate.modelType === 'mesh') || analysisCandidates[0];
                    }
                    return analysisCandidates[0];
                })();
                console.info('[Stitch] Candidate summary', analysisCandidates.map((candidate) => ({
                    name: candidate.name,
                    modelType: candidate.modelType,
                    score: candidate.score,
                    confidence: candidate.confidence
                })), { preferredCandidateId: preferredCandidate?.id || null });
                let nextDocument = normalizeStitchDocument({
                    ...latest,
                    candidates: analysisCandidates,
                    activeCandidateId: preferredCandidate?.id || analysisCandidates[0]?.id || null,
                    placements: preferredCandidate?.placements || analysisCandidates[0]?.placements || latest.placements,
                    workspace: {
                        ...latest.workspace,
                        galleryOpen: true,
                        alternativesOpen: true
                    },
                    analysis: {
                        ...latest.analysis,
                        status: 'ready',
                        warning: result.warning || '',
                        error: '',
                        lastRunAt: Date.now(),
                        backend: result.backend || '',
                        diagnostics: result.diagnostics || [],
                        previews: {}
                    }
                });
                const previews = await buildStitchPreviewMap(nextDocument);
                if (token !== stitchAnalysisToken) {
                    releaseUnusedStitchPreviewUrls(previews, {});
                    return;
                }
                nextDocument = normalizeStitchDocument({
                    ...nextDocument,
                    analysis: {
                        ...nextDocument.analysis,
                        previews
                    }
                });
                updateStitchDocument(() => nextDocument, { renderStitch: true });
                setNotice(result.warning || 'Stitch analysis is ready.', result.warning ? 'warning' : 'success');
            } catch (error) {
                if (token !== stitchAnalysisToken) return;
                updateStitchDocument((document) => ({
                    ...document,
                    analysis: {
                        ...document.analysis,
                        status: 'error',
                        error: error?.message || 'The stitch analysis failed.',
                        warning: '',
                        backend: '',
                        diagnostics: [],
                        previews: {}
                    }
                }), { renderStitch: true });
                setNotice(error?.message || 'The stitch analysis failed.', 'error', 7000);
            }
        },
        setStitchGalleryOpen(open) {
            updateStitchDocument((document) => ({
                ...document,
                workspace: {
                    ...document.workspace,
                    galleryOpen: !!open
                }
            }), { renderStitch: true });
        },
        setStitchAlternativesOpen(open) {
            updateStitchDocument((document) => ({
                ...document,
                workspace: {
                    ...document.workspace,
                    alternativesOpen: !!open
                }
            }), { renderStitch: true });
        },
        chooseStitchCandidate(candidateId) {
            if (!candidateId) return;
            updateStitchDocument((document) => ({
                ...applyCandidateToDocument(document, candidateId),
                workspace: {
                    ...document.workspace,
                    galleryOpen: false,
                    alternativesOpen: true
                }
            }), { renderStitch: true });
        },
        selectStitchInput(inputId) {
            updateStitchDocument((document) => ({
                ...document,
                selection: {
                    inputId: inputId || null
                }
            }), { renderStitch: true, skipViewRender: false });
        },
        async removeStitchInput(inputId) {
            if (!inputId) return;
            stitchAnalysisToken += 1;
            updateStitchDocument((document) => {
                const normalized = normalizeStitchDocument(document);
                const nextInputs = normalized.inputs.filter((input) => input.id !== inputId);
                const nextPlacements = normalized.placements.filter((placement) => placement.inputId !== inputId);
                const nextSelection = normalized.selection.inputId === inputId
                    ? { inputId: nextInputs[0]?.id || null }
                    : normalized.selection;
                return normalizeStitchDocument({
                    ...normalized,
                    inputs: nextInputs,
                    placements: nextPlacements,
                    candidates: [],
                    activeCandidateId: null,
                    selection: nextSelection,
                    analysis: {
                        ...normalized.analysis,
                        status: 'idle',
                        warning: nextInputs.length > 1 ? 'Run the analysis again after removing images.' : '',
                        error: '',
                        backend: '',
                        diagnostics: [],
                        previews: {}
                    }
                });
            }, { renderStitch: true });
        },
        toggleStitchInputLock(inputId) {
            if (!inputId) return;
            const placement = getPlacementByInput(store.getState().stitchDocument, inputId);
            actions.updateStitchPlacement(inputId, { locked: !(placement?.locked) });
        },
        toggleStitchInputVisibility(inputId) {
            if (!inputId) return;
            const placement = getPlacementByInput(store.getState().stitchDocument, inputId);
            actions.updateStitchPlacement(inputId, { visible: placement?.visible === false });
        },
        reorderStitchInput(inputId, direction) {
            if (!inputId || !direction) return;
            updateStitchDocument((document) => updateStitchInputOrderHelper(document, inputId, direction), { renderStitch: true });
        },
        updateStitchPlacement(inputId, patch, meta = { renderStitch: true }) {
            if (!inputId || !patch || typeof patch !== 'object') return;
            updateStitchDocument((document) => updateStitchPlacementHelper(document, inputId, patch), meta);
        },
        updateStitchSetting(key, value) {
            if (!key) return;
            updateStitchDocument((document) => ({
                ...document,
                settings: {
                    ...document.settings,
                    [key]: coerceStitchSettingValue(key, value)
                },
                analysis: {
                    ...document.analysis,
                    status: 'idle',
                    warning: key === 'useFullResolutionAnalysis' && value
                        ? 'Full-resolution analysis is enabled. It can be slower, but it may help on screenshots and UI captures.'
                        : 'Stitch settings changed. Run the analysis again to refresh the ranked candidates.',
                    error: '',
                    backend: ''
                }
            }), { renderStitch: true });
        },
        resetSelectedStitchPlacement() {
            const documentState = normalizeStitchDocument(store.getState().stitchDocument);
            const inputId = documentState.selection.inputId;
            if (!inputId) return;
            const activeCandidate = documentState.candidates.find((candidate) => candidate.id === documentState.activeCandidateId);
            const candidatePlacement = activeCandidate?.placements?.find((placement) => placement.inputId === inputId);
            if (candidatePlacement) {
                actions.updateStitchPlacement(inputId, candidatePlacement);
                return;
            }
            const index = documentState.inputs.findIndex((input) => input.id === inputId);
            const input = documentState.inputs[index];
            if (!input) return;
            actions.updateStitchPlacement(inputId, {
                x: 0,
                y: 0,
                scale: 1,
                rotation: 0,
                visible: true,
                locked: false,
                z: index,
                opacity: 1
            });
        },
        resetActiveStitchCandidate() {
            const documentState = normalizeStitchDocument(store.getState().stitchDocument);
            if (!documentState.activeCandidateId) return;
            actions.chooseStitchCandidate(documentState.activeCandidateId);
        },
        resetStitchView() {
            updateStitchDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    zoom: 1,
                    panX: 0,
                    panY: 0
                }
            }), { renderStitch: true });
        },
        async exportStitchProject() {
            const documentState = normalizeStitchDocument(store.getState().stitchDocument);
            if (!documentState.inputs.length) {
                setNotice('Add images to the Stitch workspace before exporting.', 'warning');
                return;
            }
            const blob = await stitchEngine.exportPngBlob(documentState);
            const baseName = getSuggestedStitchProjectName(documentState).replace(/\.[^/.]+$/, '') || 'stitch-project';
            downloadBlob(blob, `${baseName}-stitched.png`);
            setNotice('Stitch PNG export complete.', 'success');
        },
        updateInstance,
        armEyedropper(target) {
            store.setState((state) => ({ ...state, eyedropperTarget: target, notice: { text: 'Click the preview to sample a color.', type: 'info' } }), { render: false });
        },
        async extractPaletteFromFile(file) {
            if (!file) return;
            const dataUrl = await fileToDataUrl(file);
            const image = await loadImageFromDataUrl(dataUrl);
            const state = store.getState();
            const owner = state.document.selection.layerInstanceId;
            const selected = state.document.layerStack.find((instance) => instance.instanceId === owner && instance.layerId === 'palette');
            paletteExtractionImage = image;
            paletteExtractionOwner = selected?.instanceId || null;
            updateDocument((document) => ({
                ...document,
                palette: createPaletteFromImage(image, Number(selected?.params.extractCount || 8))
            }));
        },
        async saveProjectToLibrary(nameOverride = null, optionsOrForceNew = false) {
            const options = typeof optionsOrForceNew === 'object' && optionsOrForceNew !== null
                ? optionsOrForceNew
                : { forceNew: !!optionsOrForceNew };
            const forceNew = !!options.forceNew;
            const preferExisting = !!options.preferExisting;
            const state = store.getState();
            const projectType = options.projectType || getProjectTypeForSection(state.ui.activeSection);
            if (projectType === '3d' && isThreeDRenderJobActive()) {
                setNotice('Abort the active 3D render before saving this scene to the Library.', 'warning', 6000);
                return null;
            }
            const adapter = projectAdapters?.getAdapter(projectType);
            if (!adapter) {
                setNotice('This project type cannot be saved to the Library yet.', 'error', 7000);
                return null;
            }
            const currentDocument = adapter.getCurrentDocument(state);
            if (adapter.isEmpty(currentDocument) || !adapter.canSave(currentDocument)) {
                setNotice(adapter.emptyNotice || `There is no ${adapter.label} project ready to save.`, 'warning');
                return null;
            }

            const payloadParams = adapter.serializeDocument(currentDocument);
            const matchingEntries = await getMatchingLibraryEntries(payloadParams, projectType);
            const activeOrigin = getActiveLibraryOrigin(projectType);
            const activeMatch = activeOrigin.id
                ? matchingEntries.find((entry) => entry.id === activeOrigin.id) || null
                : null;
            const reusableMatch = preferExisting
                ? activeMatch || matchingEntries[0] || null
                : null;

            if (reusableMatch) {
                const wasActiveMatch = reusableMatch.id === activeOrigin.id;
                setActiveLibraryOrigin(projectType, reusableMatch.id, reusableMatch.name);
                setNotice(
                    wasActiveMatch
                        ? 'Already saved - no changes detected.'
                        : `Already in Library as "${reusableMatch.name}".`,
                    'info'
                );
                return reusableMatch;
            }

            let name;
            let saveId;

            if (!forceNew && activeOrigin.id) {
                const defaultName = activeOrigin.name || adapter.suggestName(currentDocument, nameOverride);
                const choice = prompt(
                    activeMatch
                        ? `This project already matches "${defaultName}".\n\nLeave the name as-is to keep that saved version, or type a new name to save a NEW entry:`
                        : `This project was loaded from "${defaultName}".\n\nType a new name to save as a NEW entry, or leave as-is to OVERWRITE the existing one:`,
                    defaultName
                );
                if (choice === null) return null;
                const trimmedChoice = choice.trim();
                if (!trimmedChoice) return null;
                if (trimmedChoice === defaultName) {
                    if (activeMatch) {
                        setNotice('Already saved - no changes detected.', 'info');
                        return activeMatch;
                    }
                    saveId = activeOrigin.id;
                    name = defaultName;
                } else {
                    saveId = createLibraryProjectId();
                    name = trimmedChoice;
                }
            } else {
                const defaultName = adapter.suggestName(currentDocument, nameOverride);
                const askedName = prompt('Name your project for the Library:', defaultName);
                if (askedName === null) return null;
                name = askedName.trim();
                if (!name) return null;
                saveId = createLibraryProjectId();
            }

            try {
                setNotice('Saving to Library...', 'info', 0);
                const existingRecord = saveId ? await getFromLibraryDB(saveId).catch(() => null) : null;
                const capture = await adapter.captureDocument(currentDocument, payloadParams);
                const projectData = buildLibraryProjectRecord({
                    id: saveId,
                    timestamp: Date.now(),
                    name,
                    blob: capture.blob,
                    payload: capture.payload || payloadParams,
                    tags: normalizeLibraryTags(existingRecord?.tags || []),
                    projectType,
                    ...(capture.summary || {})
                });
                await saveToLibraryDB(projectData);
                await registerLibraryTags(projectData.tags);
                setActiveLibraryOrigin(projectType, saveId, name);
                setNotice(`Saved "${name}" to Library.`, 'success');
                notifyLibraryChanged();
                return projectData;
            } catch (error) {
                console.error(error);
                setNotice(error?.message || 'Could not save that project to the Library.', 'error', 7000);
                return null;
            }
        },
        async getLibraryProjects() {
            try {
                return (await getAllFromLibraryDB())
                    .filter((entry) => !isLibraryMetaRecord(entry))
                    .map((entry) => ({
                        ...entry,
                        projectType: getLibraryProjectType(entry),
                        tags: normalizeLibraryTags(entry.tags || extractLibraryProjectMeta(entry.payload).tags || []),
                        hoverSource: normalizeLibraryHoverSource(entry.hoverSource || extractLibraryProjectMeta(entry.payload).hoverSource || entry.payload?.source || null),
                        sourceWidth: Number(entry.sourceWidth || entry.hoverSource?.width || extractLibraryProjectMeta(entry.payload).hoverSource?.width || entry.payload?.source?.width || 0),
                        sourceHeight: Number(entry.sourceHeight || entry.hoverSource?.height || extractLibraryProjectMeta(entry.payload).hoverSource?.height || entry.payload?.source?.height || 0),
                        sourceAreaOverride: Number(entry.sourceAreaOverride || extractLibraryProjectMeta(entry.payload).sourceArea || 0),
                        sourceCount: Number(entry.sourceCount || extractLibraryProjectMeta(entry.payload).sourceCount || (entry.payload?.kind === 'stitch-document' ? entry.payload?.inputs?.length || 0 : (entry.payload?.source?.imageData ? 1 : 0)) || 0)
                    }));
            } catch (_error) {
                return [];
            }
        },
        async getLibraryTagCatalog() {
            try {
                return await loadLibraryTagCatalogFromDB();
            } catch (_error) {
                return [];
            }
        },
        async createLibraryTag(tag) {
            const trimmed = String(tag || '').trim();
            if (!trimmed) return [];
            const tags = await registerLibraryTags([trimmed]);
            notifyLibraryChanged();
            return tags;
        },
        async setLibraryTagCatalog(tags) {
            const nextTags = normalizeLibraryTags(tags);
            await setLibraryMetaTags(nextTags);
            notifyLibraryChanged();
            return nextTags;
        },
        async updateLibraryProjectTags(id, tags) {
            if (!id) return null;
            const existing = await getFromLibraryDB(id);
            if (!existing || isLibraryMetaRecord(existing)) return null;
            const updated = {
                ...existing,
                tags: normalizeLibraryTags(tags)
            };
            await saveToLibraryDB(updated);
            await registerLibraryTags(updated.tags);
            notifyLibraryChanged();
            return updated;
        },
        async applyLibraryTagsToProjects(ids, tags) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            const nextTags = normalizeLibraryTags(tags);
            if (!targetIds.length || !nextTags.length) return [];

            await registerLibraryTags(nextTags);
            const updatedProjects = [];
            for (const id of targetIds) {
                const existing = await getFromLibraryDB(id);
                if (!existing || isLibraryMetaRecord(existing)) continue;
                const updated = {
                    ...existing,
                    tags: normalizeLibraryTags([...(existing.tags || []), ...nextTags])
                };
                await saveToLibraryDB(updated);
                updatedProjects.push(updated);
            }
            notifyLibraryChanged();
            return updatedProjects;
        },
        async removeLibraryTagFromProjects(ids, tag) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            const removeKey = String(tag || '').trim().toLowerCase();
            if (!targetIds.length || !removeKey) return [];

            const updatedProjects = [];
            for (const id of targetIds) {
                const existing = await getFromLibraryDB(id);
                if (!existing || isLibraryMetaRecord(existing)) continue;
                const updated = {
                    ...existing,
                    tags: normalizeLibraryTags((existing.tags || []).filter((entry) => String(entry || '').trim().toLowerCase() !== removeKey))
                };
                await saveToLibraryDB(updated);
                updatedProjects.push(updated);
            }
            notifyLibraryChanged();
            return updatedProjects;
        },
        async deleteLibraryProject(id) {
            if (!id) return;
            const existing = await getFromLibraryDB(id).catch(() => null);
            await deleteFromLibraryDB(id);
            const projectType = getLibraryProjectType(existing);
            if (getActiveLibraryOrigin(projectType).id === id) {
                clearActiveLibraryOrigin(projectType);
            }
            notifyLibraryChanged();
        },
        async deleteLibraryProjects(ids) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            if (!targetIds.length) return;
            for (const id of targetIds) {
                const existing = await getFromLibraryDB(id).catch(() => null);
                await deleteFromLibraryDB(id);
                const projectType = getLibraryProjectType(existing);
                if (getActiveLibraryOrigin(projectType).id === id) {
                    clearActiveLibraryOrigin(projectType);
                }
            }
            notifyLibraryChanged();
        },
        async clearLibraryProjects() {
            const entries = await getAllFromLibraryDB();
            for (const entry of entries) {
                if (isLibraryMetaRecord(entry)) continue;
                await deleteFromLibraryDB(entry.id);
            }
            clearActiveLibraryOrigin();
            notifyLibraryChanged();
        },
        async loadLibraryProject(payload, libraryId = null, libraryName = null) {
            try {
                const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
                const rawState = normalizeLegacyDocumentPayload(JSON.parse(payloadStr));
                const projectMeta = extractLibraryProjectMeta(rawState);
                const adapter = projectAdapters?.getAdapterForPayload(rawState, projectMeta.projectType);
                if (!adapter) throw new Error('This Library project type is not supported in the current build.');
                if (!await ensureProjectCanBeReplaced(adapter.type, `loading "${libraryName || 'this Library project'}"`)) return false;
                return await adapter.restorePayload(rawState, libraryId, libraryName);
            } catch (error) {
                console.error(error);
                setNotice('Failed to load project from Library', 'error');
                throw error;
            }
        },
        async newProject() {
            if (!await ensureProjectCanBeReplaced('studio', 'starting a new project')) return;
            stopPlayback();
            paletteExtractionImage = null;
            paletteExtractionOwner = null;
            updateDocument((document) => ({
                ...document,
                source: { width: 0, height: 0, name: '', imageData: null },
                layerStack: [],
                palette: [],
                selection: { layerInstanceId: null },
                workspace: { ...document.workspace, batchOpen: false },
                batch: createEmptyBatchState()
            }), { render: false });
            clearActiveLibraryOrigin('studio');
            engine.requestRender(store.getState().document);
            setNotice('Started a new project.', 'success');
        },
        async openImageFile(file) {
            if (!file) return;
            if (!await ensureProjectCanBeReplaced('studio', 'loading a new image')) return;
            try {
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                const dataUrl = await fileToDataUrl(file);
                await syncImageSource(file, dataUrl);
                updateDocument((document) => ({
                    ...document,
                    view: { ...document.view, zoom: 1 },
                    workspace: { ...document.workspace, batchOpen: false },
                    batch: createEmptyBatchState()
                }), { render: false });

                clearActiveLibraryOrigin('studio');
                engine.requestRender(store.getState().document);
                await actions.saveProjectToLibrary(stripProjectExtension(file.name), { preferExisting: true, projectType: 'studio' });

                setNotice(`Loaded ${file.name}.`, 'success');
            } catch (error) {
                setNotice(`Could not load image: ${error.message}`, 'error', 6000);
            }
        },
        async openStateFile(file) {
            if (!file) return;
            if (!await ensureProjectCanBeReplaced('studio', 'loading a state file')) return;
            try {
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                const payload = validateImportPayload(normalizeLegacyDocumentPayload(await readJsonFile(file)), 'document');
                const importedLayerCount = Array.isArray(payload.layerStack) ? payload.layerStack.length : 0;
                const layerStack = reindexStack(registry, payload.layerStack || []);
                const droppedLayerCount = Math.max(0, importedLayerCount - layerStack.length);
                const requestedSelectionId = payload.selection?.layerInstanceId;
                const selection = requestedSelectionId && layerStack.some((instance) => instance.instanceId === requestedSelectionId)
                    ? payload.selection
                    : { layerInstanceId: layerStack[0]?.instanceId || null };
                const state = store.getState();
                const shouldLoadImage = !!state.ui.loadImageOnOpen;
                const embeddedSource = payload.source?.imageData ? payload.source : null;
                const preservedSource = state.document.source;
                store.setState((current) => ({
                    ...current,
                    document: {
                        ...current.document,
                        ...payload,
                        version: 'mns/v2',
                        kind: 'document',
                        mode: 'studio',
                        workspace: normalizeWorkspace('studio', payload.workspace || current.document.workspace, !!selection.layerInstanceId),
                        source: preservedSource,
                        palette: payload.palette || current.document.palette,
                        layerStack,
                        selection,
                        view: normalizeViewState({ ...current.document.view, ...(payload.view || {}) }),
                        export: { ...current.document.export, ...(payload.export || {}) },
                        batch: createEmptyBatchState()
                    }
                }), { render: engine.hasImage() && !(shouldLoadImage && embeddedSource) });
                clearActiveLibraryOrigin('studio');

                if (shouldLoadImage && embeddedSource) {
                    try {
                        const image = await loadImageFromDataUrl(embeddedSource.imageData);
                        await engine.loadImage(image, embeddedSource);
                        updateDocument((document) => ({ ...document, source: embeddedSource }), { render: false });
                        engine.requestRender(store.getState().document);
                        await actions.saveProjectToLibrary(stripProjectExtension(file.name), { preferExisting: true, projectType: 'studio' });
                        setNotice(
                            droppedLayerCount
                                ? `State loaded: ${file.name}. Removed ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                                : `State loaded: ${file.name}`,
                            droppedLayerCount ? 'warning' : 'success'
                        );
                    } catch (error) {
                        setNotice(`State loaded, but the embedded image could not be restored: ${error.message}`, 'warning', 7000);
                    }
                    return;
                }

                if (shouldLoadImage && !embeddedSource) {
                    setNotice('State loaded, but the file did not contain an embedded image.', 'warning', 7000);
                    return;
                }

                setNotice(
                    droppedLayerCount
                        ? `State loaded: ${file.name}. Removed ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                        : `State loaded: ${file.name}`,
                    droppedLayerCount ? 'warning' : 'success'
                );
            } catch (error) {
                setNotice(error.message, 'error', 7000);
            }
        },
        saveState() {
            const state = store.getState();
            const includeImage = !!state.ui.saveImageOnSave;
            downloadState(state.document, includeImage);

            if (includeImage && !state.document.source?.imageData) {
                setNotice('State saved, but no embeddable source image was available.', 'warning', 7000);
                return;
            }
            setNotice('State saved.', 'success');
        },
        setLoadImageOnOpen(value) {
            store.setState((state) => ({ ...state, ui: { ...state.ui, loadImageOnOpen: value } }), { render: false });
        },
        setSaveImageOnSave(value) {
            store.setState((state) => ({ ...state, ui: { ...state.ui, saveImageOnSave: value } }), { render: false });
        },
        setSaveToLibrary(value) {
            store.setState((state) => ({ ...state, ui: { ...state.ui, saveToLibrary: value } }), { render: false });
        },
        async exportCurrent() {
            if (!engine.hasImage()) return setNotice('Load an image before exporting.', 'warning');
            const state = store.getState();
            const blob = await engine.exportPngBlob(state.document);
            const baseName = (state.document.source.name || 'noise-studio').replace(/\.[^/.]+$/, '');
            downloadBlob(blob, `${baseName}-processed.png`);
            setNotice('PNG export complete.', 'success');
        },
        async openCompare() {
            if (!engine.hasImage()) return setNotice('Load an image before comparing.', 'warning');
            store.setState((state) => ({ ...state, ui: { ...state.ui, compareOpen: true } }), { render: false });
            requestAnimationFrame(() => engine.openCompare(store.getState().document, view.getRenderRefs()));
        },
        closeCompare() {
            store.setState((state) => ({ ...state, ui: { ...state.ui, compareOpen: false } }), { render: false });
        },
        exportCompare(mode) {
            engine.exportComparison(mode, view.getRenderRefs().compareOriginal, view.getRenderRefs().compareProcessed);
        },
        openPopup() {
            engine.openPopup();
        },
        async loadFolder() {
            if (!window.showDirectoryPicker) return setNotice('Folder access is not supported in this browser.', 'warning', 7000);
            try {
                const dirHandle = await window.showDirectoryPicker();
                const imageFiles = [];
                const allFiles = [];
                async function scan(handle, relativePath = '') {
                    for await (const entry of handle.values()) {
                        if (entry.kind === 'file') {
                            const file = await entry.getFile();
                            file.relativePath = relativePath;
                            allFiles.push(file);
                            if (file.type.startsWith('image/')) imageFiles.push(file);
                        } else if (entry.kind === 'directory') {
                            await scan(entry, `${relativePath}${entry.name}/`);
                        }
                    }
                }
                await scan(dirHandle);
                imageFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                if (!imageFiles.length) return setNotice('The selected folder does not contain any images.', 'warning');
                stopPlayback();
                updateDocument((document) => ({
                    ...document,
                    workspace: { ...document.workspace, batchOpen: true },
                    batch: { ...document.batch, imageFiles, allFiles, currentIndex: 0, isPlaying: false, actualFps: 0 }
                }), { render: false });
                await loadBatchImage(imageFiles[0], 0);
                setNotice(`Loaded ${imageFiles.length} images for batch processing.`, 'success');
            } catch (error) {
                if (error?.name !== 'AbortError') setNotice('Could not open the selected folder.', 'error', 7000);
            }
        },
        async changeBatchImage(direction) {
            const state = store.getState();
            const nextIndex = state.document.batch.currentIndex + direction;
            if (nextIndex < 0 || nextIndex >= state.document.batch.imageFiles.length) return;
            await loadBatchImage(state.document.batch.imageFiles[nextIndex], nextIndex);
        },
        toggleBatchPlayback() {
            const state = store.getState();
            if (!state.document.batch.imageFiles.length) return;
            if (playbackTimer) {
                stopPlayback();
                return;
            }
            let lastTick = performance.now();
            updateDocument((document) => ({ ...document, batch: { ...document.batch, isPlaying: true } }), { render: false });
            playbackTimer = setInterval(async () => {
                const snapshot = store.getState();
                const count = snapshot.document.batch.imageFiles.length;
                if (!count) return;
                const nextIndex = (snapshot.document.batch.currentIndex + 1) % count;
                const now = performance.now();
                const fps = 1000 / Math.max(1, now - lastTick);
                lastTick = now;
                updateDocument((document) => ({ ...document, batch: { ...document.batch, actualFps: fps } }), { render: false });
                await loadBatchImage(snapshot.document.batch.imageFiles[nextIndex], nextIndex);
            }, Math.max(16, Math.round(1000 / Math.max(1, state.document.export.playFps))));
        },
        setBatchFps(value) {
            updateDocument((document) => ({ ...document, export: { ...document.export, playFps: clamp(value || 10, 1, 60) } }), { render: false });
            if (playbackTimer) {
                stopPlayback();
                actions.toggleBatchPlayback();
            }
        },
        setKeepFolderStructure(value) {
            updateDocument((document) => ({ ...document, export: { ...document.export, keepFolderStructure: value } }), { render: false });
        },
        async exportBatch() {
            const state = store.getState();
            const batchFiles = state.document.export.keepFolderStructure ? state.document.batch.allFiles : state.document.batch.imageFiles;
            if (!batchFiles.length || !window.showDirectoryPicker) return;
            let dirHandle;
            try {
                dirHandle = await window.showDirectoryPicker();
            } catch (error) {
                return;
            }
            stopPlayback();
            const originalIndex = state.document.batch.currentIndex;
            const originalSource = state.document.source;
            for (let index = 0; index < batchFiles.length; index += 1) {
                const file = batchFiles[index];
                setNotice(`Exporting ${index + 1}/${batchFiles.length}: ${file.name}`, 'info', 0);
                let targetDir = dirHandle;
                try {
                    if (state.document.export.keepFolderStructure && file.relativePath) {
                        for (const part of file.relativePath.split('/').filter(Boolean)) {
                            targetDir = await targetDir.getDirectoryHandle(part, { create: true });
                        }
                    }
                    const isImage = state.document.batch.imageFiles.includes(file);
                    if (isImage) {
                        await loadBatchImage(file, state.document.batch.imageFiles.indexOf(file));
                        const blob = await engine.exportPngBlob(store.getState().document);
                        const fileHandle = await targetDir.getFileHandle(`${file.name.replace(/\.[^/.]+$/, '')}.png`, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(blob);
                        await writable.close();
                    } else if (state.document.export.keepFolderStructure) {
                        const fileHandle = await targetDir.getFileHandle(file.name, { create: true });
                        const writable = await fileHandle.createWritable();
                        await writable.write(file);
                        await writable.close();
                    }
                } catch (error) {
                    setNotice(`Skipped ${file.name}: ${error.message}`, 'warning', 5000);
                }
            }
            if (state.document.batch.imageFiles[originalIndex]) {
                await loadBatchImage(state.document.batch.imageFiles[originalIndex], originalIndex);
                updateDocument((document) => ({ ...document, source: originalSource }), { render: false });
            }
            setNotice('Batch export complete.', 'success');
        },
        async processLibraryPayloads(payloadsText, filenames, onProgress = null) {
            const state = store.getState();
            const originalSource = state.document.source;
            let savedCount = 0;
            let failedCount = 0;
            let lastError = null;
            const importedTags = [];
            setNotice(`Rendering ${payloadsText.length} variants to Library DB...`, 'info', 0);

            onProgress?.({ phase: 'start', total: payloadsText.length });

            for (let i = 0; i < payloadsText.length; i++) {
                onProgress?.({ phase: 'progress', count: i, total: payloadsText.length, filename: filenames[i] });

                try {
                    const rawState = normalizeLegacyDocumentPayload(JSON.parse(payloadsText[i]));
                    const meta = extractLibraryProjectMeta(rawState);
                    const adapter = projectAdapters?.getAdapterForPayload(rawState, meta.projectType);
                    if (!adapter) {
                        throw new Error('Unsupported project type in Library import.');
                    }

                    const prepared = await adapter.prepareImportedProject(rawState);
                    const projectName = stripProjectExtension(rawState._libraryName || filenames[i] || adapter.suggestName(prepared.payload))
                        || adapter.suggestName(prepared.payload)
                        || `Library Project ${i + 1}`;
                    const projectData = buildLibraryProjectRecord({
                        id: createLibraryProjectId(),
                        timestamp: Date.now(),
                        name: projectName,
                        blob: prepared.blob,
                        payload: prepared.payload,
                        tags: meta.tags,
                        projectType: adapter.type,
                        ...(prepared.summary || {})
                    });
                    await saveToLibraryDB(projectData);
                    importedTags.push(...projectData.tags);
                    savedCount += 1;
                } catch (err) {
                    failedCount += 1;
                    lastError = err;
                    console.error(`[Library] Error processing file ${filenames[i]}:`, err);
                }

                onProgress?.({ phase: 'progress', count: i + 1, total: payloadsText.length, filename: filenames[i] });
            }

            if (originalSource && originalSource.imageData) {
                try {
                    const originalImage = await loadImageFromDataUrl(originalSource.imageData);
                    await engine.loadImage(originalImage, originalSource);
                } catch(e) {}
            }
            if (store.getState().document.source?.imageData) {
                engine.requestRender(store.getState().document);
            }

            onProgress?.({ phase: 'complete', total: payloadsText.length });
            if (importedTags.length) {
                await registerLibraryTags(importedTags);
            }
            notifyLibraryChanged();
            if (!savedCount) {
                throw new Error(lastError?.message || 'No Library items were saved to the database.');
            }
            setNotice(
                failedCount
                    ? `Saved ${savedCount} of ${payloadsText.length} Library item${payloadsText.length === 1 ? '' : 's'}.`
                    : 'Library renders saved to DB.',
                failedCount ? 'warning' : 'success',
                failedCount ? 5000 : 3000
            );
        },

        openLibrary() {
            actions.setActiveSection('library');
        },
        handlePreviewClick(event) {
            const state = store.getState();
            const uv = view.clientToImageUv(event.clientX, event.clientY);
            if (!uv) return;
            if (state.eyedropperTarget) {
                const previewPixel = engine.pickPixelAtUv(uv.x, uv.y);
                const needsLayerInputPick = (
                    state.eyedropperTarget.kind === 'bg-patcher-main'
                    || state.eyedropperTarget.kind === 'bg-patcher-protected'
                    || state.eyedropperTarget.kind === 'bg-patcher-patch'
                    || state.eyedropperTarget.kind === 'bg-patcher-add-sample'
                );
                const layerInputPixel = needsLayerInputPick
                    ? getLayerInputSample(state.eyedropperTarget.instanceId, uv, previewPixel)
                    : null;
                if (needsLayerInputPick && !layerInputPixel) {
                    setNotice('Click inside the background remover image area to sample this layer.', 'warning', 3200);
                    return;
                }
                const pixel = layerInputPixel || previewPixel;
                if (state.eyedropperTarget.kind === 'palette') {
                    updateDocument((document) => ({ ...document, palette: [...document.palette, pixel.hex] }));
                } else if (state.eyedropperTarget.kind === 'control') {
                    const [instanceId, key] = state.eyedropperTarget.target.split(':');
                    actions.updateControl(instanceId, key, pixel.hex);
                } else if (state.eyedropperTarget.kind === 'bg-patcher-main') {
                    updateInstance(state.eyedropperTarget.instanceId, (instance) => ({
                        ...instance,
                        params: {
                            ...instance.params,
                            bgPatcherTargetColor: pixel.hex,
                            bgPatcherSampleX: layerInputPixel?.x ?? -1,
                            bgPatcherSampleY: layerInputPixel?.y ?? -1,
                            bgPatcherSamples: []
                        }
                    }));
                } else if (state.eyedropperTarget.kind === 'bg-patcher-add-sample') {
                    updateInstance(state.eyedropperTarget.instanceId, (instance) => ({
                        ...instance,
                        params: {
                            ...instance.params,
                            bgPatcherSamples: [...(instance.params.bgPatcherSamples || []), { x: layerInputPixel?.x ?? -1, y: layerInputPixel?.y ?? -1 }]
                        }
                    }));
                } else if (state.eyedropperTarget.kind === 'bg-patcher-protected') {
                    updateInstance(state.eyedropperTarget.instanceId, (instance) => ({
                        ...instance,
                        params: {
                            ...instance.params,
                            bgPatcherProtectedColors: (instance.params.bgPatcherProtectedColors || []).map((entry, index) => index === state.eyedropperTarget.index
                                ? { ...entry, color: pixel.hex }
                                : entry)
                        }
                    }));
                } else if (state.eyedropperTarget.kind === 'bg-patcher-patch') {
                    updateInstance(state.eyedropperTarget.instanceId, (instance) => ({
                        ...instance,
                        params: {
                            ...instance.params,
                            bgPatcherPatches: (instance.params.bgPatcherPatches || []).map((entry, index) => index === state.eyedropperTarget.index
                                ? { ...entry, color: pixel.hex }
                                : entry)
                        }
                    }));
                } else if (state.eyedropperTarget.kind === 'expander-color') {
                    actions.updateControl(state.eyedropperTarget.instanceId, 'expanderColor', normalizeRgbaColor(pixel));
                }
                store.setState((current) => ({ ...current, eyedropperTarget: null, notice: null }), { render: false });
                return;
            }
            const current = state.document.layerStack.find((instance) => instance.instanceId === state.document.selection.layerInstanceId);
            if (current?.layerId === 'ca' && current.params.caPin) {
                const x = clamp(uv.x, 0, 1);
                const y = clamp(1 - uv.y, 0, 1);
                updateDocument((document) => ({
                    ...document,
                    layerStack: document.layerStack.map((instance) => instance.instanceId === current.instanceId ? { ...instance, params: { ...instance.params, caCenterX: x, caCenterY: y } } : instance)
                }));
            } else if (current?.layerId === 'tiltShiftBlur' && current.params.tiltShiftPin) {
                const x = clamp(uv.x, 0, 1);
                const y = clamp(1 - uv.y, 0, 1);
                updateDocument((document) => ({
                    ...document,
                    layerStack: document.layerStack.map((instance) => instance.instanceId === current.instanceId ? { ...instance, params: { ...instance.params, tiltShiftCenterX: x, tiltShiftCenterY: y } } : instance)
                }));
            }
        },
        async newThreeDProject() {
            if (!ensureThreeDSceneUnlocked('starting a new 3D scene')) return;
            if (!await ensureProjectCanBeReplaced('3d', 'starting a new 3D scene')) return;
            updateThreeDDocument(() => createEmptyThreeDDocument());
            clearActiveLibraryOrigin('3d');
            commitActiveSection('3d');
            setNotice('Started a new 3D scene.', 'success');
        },
        async importThreeDModelFiles(files) {
            if (!ensureThreeDSceneUnlocked('importing more 3D models')) return;
            const items = await createThreeDModelItemsFromFiles(files);
            if (!items.length) {
                throw new Error('Choose one or more `.glb` or self-contained `.gltf` files.');
            }
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const existingAssets = normalized.scene.items.filter((item) => item.kind !== 'light').length;
                const placedItems = items.map((item, index) => ({
                    ...item,
                    position: [(existingAssets + index) * 2.4, 0, 0]
                }));
                const nextItems = [...normalized.scene.items, ...placedItems];
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: nextItems
                    },
                    selection: {
                        itemId: placedItems[placedItems.length - 1]?.id || normalized.selection.itemId || null
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
            commitActiveSection('3d');
        },
        async importThreeDImageFiles(files) {
            if (!ensureThreeDSceneUnlocked('adding image planes')) return;
            const items = await createThreeDImagePlaneItemsFromFiles(files);
            if (!items.length) {
                throw new Error('Choose one or more image files to turn into planes.');
            }
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const existingAssets = normalized.scene.items.filter((item) => item.kind !== 'light').length;
                const placedItems = items.map((item, index) => ({
                    ...item,
                    position: [(existingAssets + index) * 2.4, 0, 0]
                }));
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: [...normalized.scene.items, ...placedItems]
                    },
                    selection: {
                        itemId: placedItems[placedItems.length - 1]?.id || normalized.selection.itemId || null
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
            commitActiveSection('3d');
        },
        setThreeDSelection(itemId) {
            if (!ensureThreeDSceneUnlocked('changing the selected 3D item')) return;
            updateThreeDDocument((document) => ({
                ...document,
                selection: {
                    ...document.selection,
                    itemId: itemId || null
                }
            }));
        },
        updateThreeDSceneSettings(patch = {}) {
            if (!ensureThreeDSceneUnlocked('changing 3D scene settings')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    ...patch
                }
            }));
        },
        updateThreeDRenderSettings(patch = {}) {
            if (!ensureThreeDSceneUnlocked('changing 3D render settings')) return;
            updateThreeDDocument((document) => ({
                ...document,
                render: {
                    ...document.render,
                    ...patch,
                    currentSamples: 0
                }
            }));
        },
        updateThreeDView(patch = {}) {
            if (!ensureThreeDSceneUnlocked('moving the 3D camera')) return;
            updateThreeDDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    ...patch
                }
            }));
        },
        resetThreeDCamera() {
            if (!ensureThreeDSceneUnlocked('resetting the 3D camera')) return;
            const defaults = createEmptyThreeDDocument().view;
            updateThreeDDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    cameraPosition: [...defaults.cameraPosition],
                    cameraTarget: [...defaults.cameraTarget],
                    fov: defaults.fov,
                    near: defaults.near,
                    far: defaults.far
                }
            }));
        },
        saveThreeDCameraPreset(name, snapshot = null) {
            const presetName = String(name || '').trim() || `Camera ${store.getState().threeDDocument.view.presets.length + 1}`;
            updateThreeDDocument((document) => {
                const source = snapshot || document.view;
                const preset = {
                    id: createThreeDCameraPresetId(),
                    name: presetName,
                    cameraPosition: [...(source.cameraPosition || document.view.cameraPosition)],
                    cameraTarget: [...(source.cameraTarget || document.view.cameraTarget)],
                    fov: Number(source.fov || document.view.fov || 50)
                };
                return {
                    ...document,
                    view: {
                        ...document.view,
                        presets: [...document.view.presets, preset]
                    }
                };
            });
        },
        applyThreeDCameraPreset(presetId) {
            if (!ensureThreeDSceneUnlocked('jumping to a saved camera')) return;
            if (!presetId) return;
            updateThreeDDocument((document) => {
                const preset = document.view.presets.find((entry) => entry.id === presetId);
                if (!preset) return document;
                return {
                    ...document,
                    view: {
                        ...document.view,
                        cameraPosition: [...preset.cameraPosition],
                        cameraTarget: [...preset.cameraTarget],
                        fov: preset.fov
                    }
                };
            });
        },
        deleteThreeDCameraPreset(presetId) {
            if (!presetId) return;
            updateThreeDDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    presets: document.view.presets.filter((entry) => entry.id !== presetId)
                }
            }));
        },
        addThreeDLight(lightType = 'directional') {
            if (!ensureThreeDSceneUnlocked('adding a light')) return;
            const lightName = lightType === 'point'
                ? 'Point Light'
                : lightType === 'spot'
                    ? 'Spot Light'
                    : 'Directional Light';
            const lightPosition = lightType === 'directional'
                ? [5, 8, 5]
                : lightType === 'spot'
                    ? [0, 8, 4]
                    : [0, 5, 0];
            const lightItem = {
                id: createThreeDSceneItemId('light'),
                kind: 'light',
                name: lightName,
                visible: true,
                locked: false,
                position: lightPosition,
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                light: {
                    lightType,
                    color: '#ffffff',
                    intensity: lightType === 'directional' ? 1.5 : 2,
                    distance: 50,
                    angle: Math.PI / 6,
                    penumbra: 0.35,
                    decay: 1,
                    castShadow: true
                }
            };
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: [...document.scene.items, lightItem]
                },
                selection: {
                    itemId: lightItem.id
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
            commitActiveSection('3d');
        },
        addThreeDPrimitive(primitiveType = 'cube') {
            if (!ensureThreeDSceneUnlocked('adding a primitive')) return;
            const primitiveItem = createThreeDPrimitiveItem(primitiveType);
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const existingAssets = normalized.scene.items.filter((item) => item.kind !== 'light').length;
                const nextName = createUniqueThreeDItemName(primitiveItem.name, normalized.scene.items);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: [
                            ...normalized.scene.items,
                            {
                                ...primitiveItem,
                                name: nextName,
                                asset: {
                                    ...primitiveItem.asset,
                                    name: nextName
                                },
                                position: [existingAssets * 2.2, 0, 0]
                            }
                        ]
                    },
                    selection: {
                        itemId: primitiveItem.id
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
            commitActiveSection('3d');
        },
        updateThreeDItemTransform(itemId, patch = {}) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('editing transforms')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items.map((item) => item.id === itemId
                        ? {
                            ...item,
                            ...(patch.position ? { position: [...patch.position] } : {}),
                            ...(patch.rotation ? { rotation: [...patch.rotation] } : {}),
                            ...(patch.scale ? { scale: [...patch.scale] } : {})
                        }
                        : item)
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        resetThreeDItemTransform(itemId) {
            actions.updateThreeDItemTransform(itemId, {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1]
            });
        },
        duplicateThreeDItem(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('duplicating a 3D item')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const source = normalized.scene.items.find((item) => item.id === itemId);
                if (!source) return normalized;
                const offsetStep = Math.max(Number(normalized.view.snapTranslationStep || 0), 0.75);
                const duplicate = JSON.parse(JSON.stringify(source));
                duplicate.id = createThreeDSceneItemId(source.kind === 'light' ? 'light' : source.kind || 'item');
                duplicate.name = createDuplicateThreeDItemName(source.name, normalized.scene.items);
                duplicate.position = [
                    Number(source.position?.[0] || 0) + offsetStep,
                    Number(source.position?.[1] || 0),
                    Number(source.position?.[2] || 0) + offsetStep
                ];
                if (duplicate.kind !== 'light' && duplicate.asset?.format === 'primitive') {
                    duplicate.asset.name = duplicate.name;
                }
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: [...normalized.scene.items, duplicate]
                    },
                    selection: {
                        itemId: duplicate.id
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
            commitActiveSection('3d');
        },
        renameThreeDItem(itemId, name) {
            const trimmedName = String(name || '').trim();
            if (!itemId || !trimmedName) return;
            if (!ensureThreeDSceneUnlocked('renaming a 3D item')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items.map((item) => item.id === itemId
                        ? {
                            ...item,
                            name: trimmedName
                        }
                        : item)
                }
            }));
        },
        deleteThreeDItem(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('deleting a 3D item')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items
                        .filter((item) => item.id !== itemId)
                        .map((item) => item.kind === 'light' && item.light?.targetItemId === itemId
                            ? {
                                ...item,
                                light: {
                                    ...item.light,
                                    targetItemId: null
                                }
                            }
                            : item)
                },
                selection: {
                    itemId: document.selection.itemId === itemId ? null : document.selection.itemId
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        updateThreeDMaterial(itemId, patch = {}) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('changing materials')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items.map((item) => item.id === itemId && item.kind !== 'light'
                        ? {
                            ...item,
                            material: {
                                ...item.material,
                                ...patch,
                                texture: patch.texture === undefined
                                    ? item.material?.texture || null
                                    : patch.texture
                                        ? {
                                            ...(item.material?.texture || {}),
                                            ...patch.texture
                                        }
                                        : null
                            }
                        }
                        : item)
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        async setThreeDMaterialTexture(itemId, file) {
            if (!itemId || !file) return;
            if (!ensureThreeDSceneUnlocked('uploading a texture')) return;
            if (!String(file.type || '').startsWith('image/')) {
                throw new Error('Choose an image file to use as a texture.');
            }
            const dataUrl = await fileToDataUrl(file);
            actions.updateThreeDMaterial(itemId, {
                texture: {
                    name: file.name,
                    mimeType: file.type || '',
                    dataUrl,
                    repeat: [1, 1],
                    offset: [0, 0],
                    rotation: 0
                }
            });
        },
        clearThreeDMaterialTexture(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('removing a texture')) return;
            actions.updateThreeDMaterial(itemId, { texture: null });
        },
        updateThreeDLight(itemId, patch = {}) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('editing lights')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items.map((item) => item.id === itemId && item.kind === 'light'
                        ? {
                            ...item,
                            light: {
                                ...item.light,
                                ...patch
                            }
                        }
                        : item)
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        setThreeDRenderJob(patch = {}, meta = { render: false }) {
            updateThreeDDocument((document) => ({
                ...document,
                renderJob: {
                    ...document.renderJob,
                    ...patch
                }
            }), meta);
        },
        resetThreeDRenderJob(patch = {}, meta = { render: false }) {
            const defaults = createEmptyThreeDDocument().renderJob;
            updateThreeDDocument((document) => ({
                ...document,
                renderJob: {
                    ...defaults,
                    ...patch
                }
            }), meta);
        }
    };

    projectAdapters = createProjectAdapterRegistry([
        {
            type: 'studio',
            label: 'Editor',
            getCurrentDocument(state) {
                return state.document;
            },
            isEmpty(document) {
                return !document?.source?.imageData && !(document?.layerStack || []).length;
            },
            canSave(document) {
                return !!document?.source?.imageData;
            },
            emptyNotice: 'Load an image in the Editor before saving to the Library.',
            suggestName(document, nameOverride = null) {
                return getSuggestedProjectName(document, nameOverride);
            },
            serializeDocument(document) {
                return buildLibraryPayload(document);
            },
            validatePayload(rawPayload) {
                const normalized = stripLibraryMetadata(normalizeLegacyDocumentPayload(rawPayload));
                const validated = validateImportPayload(normalized, 'document');
                return {
                    ...validated,
                    layerStack: reindexStack(registry, validated.layerStack || [])
                };
            },
            async captureDocument(document, payload = null) {
                const finalPayload = payload || buildLibraryPayload(document);
                if (!finalPayload.source?.imageData) {
                    throw new Error('Load an image in the Editor before saving to the Library.');
                }
                const blob = await engine.exportPngBlob(document);
                return {
                    payload: finalPayload,
                    blob,
                    summary: {
                        hoverSource: finalPayload.source,
                        sourceWidth: Number(finalPayload.source?.width || 0),
                        sourceHeight: Number(finalPayload.source?.height || 0),
                        sourceArea: Number(finalPayload.source?.width || 0) * Number(finalPayload.source?.height || 0),
                        sourceCount: finalPayload.source?.imageData ? 1 : 0,
                        renderWidth: Number(engine.runtime.renderWidth || finalPayload.source?.width || 0),
                        renderHeight: Number(engine.runtime.renderHeight || finalPayload.source?.height || 0)
                    }
                };
            },
            async prepareImportedProject(rawPayload) {
                const validated = this.validatePayload(rawPayload);
                if (!validated.source?.imageData) {
                    throw new Error('Studio Library imports must include an embedded source image.');
                }
                const tempDoc = {
                    ...store.getState().document,
                    ...validated,
                    layerStack: validated.layerStack,
                    source: validated.source
                };
                const image = await loadImageFromDataUrl(validated.source.imageData);
                await engine.loadImage(image, validated.source);
                const blob = await engine.exportPngBlob(tempDoc);
                return {
                    payload: validated,
                    blob,
                    summary: {
                        hoverSource: validated.source,
                        sourceWidth: Number(validated.source?.width || 0),
                        sourceHeight: Number(validated.source?.height || 0),
                        sourceArea: Number(validated.source?.width || 0) * Number(validated.source?.height || 0),
                        sourceCount: validated.source?.imageData ? 1 : 0,
                        renderWidth: Number(engine.runtime.renderWidth || validated.source?.width || 0),
                        renderHeight: Number(engine.runtime.renderHeight || validated.source?.height || 0)
                    }
                };
            },
            async restorePayload(rawPayload, libraryId = null, libraryName = null) {
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                const validated = this.validatePayload(rawPayload);
                if (validated.source?.imageData) {
                    const image = await loadImageFromDataUrl(validated.source.imageData);
                    await engine.loadImage(image, validated.source);
                }
                updateDocument((document) => ({
                    ...document,
                    ...validated,
                    layerStack: validated.layerStack,
                    source: validated.source || document.source,
                    workspace: normalizeWorkspace('studio', validated.workspace || document.workspace, !!validated.selection?.layerInstanceId)
                }), { render: true });
                setActiveLibraryOrigin('studio', libraryId, libraryName);
                commitActiveSection('editor');
                setNotice(`Loaded "${libraryName || 'project'}" from Library.`, 'success');
                return true;
            }
        },
        {
            type: 'stitch',
            label: 'Stitch',
            getCurrentDocument(state) {
                return state.stitchDocument;
            },
            isEmpty(document) {
                return !normalizeStitchDocument(document).inputs.length;
            },
            canSave(document) {
                return normalizeStitchDocument(document).inputs.length > 0;
            },
            emptyNotice: 'Add images to Stitch before saving to the Library.',
            suggestName(document, nameOverride = null) {
                return getSuggestedStitchProjectName(document, nameOverride);
            },
            serializeDocument(document) {
                return buildStitchLibraryPayload(document);
            },
            validatePayload(rawPayload) {
                const normalized = stripLibraryMetadata(normalizeLegacyDocumentPayload(rawPayload));
                return normalizeStitchDocument(validateImportPayload(normalized, 'stitch-document'));
            },
            async captureDocument(document) {
                const normalized = normalizeStitchDocument(document);
                const payload = buildStitchLibraryPayload(normalized);
                const blob = await stitchEngine.exportPngBlob(normalized);
                const summary = summarizeStitchDocument(normalized);
                return {
                    payload,
                    blob,
                    summary: {
                        ...summary,
                        hoverSource: summary.primarySource
                    }
                };
            },
            async prepareImportedProject(rawPayload) {
                const validated = this.validatePayload(rawPayload);
                const payload = buildStitchLibraryPayload(validated);
                const blob = await stitchEngine.exportPngBlob(validated);
                const summary = summarizeStitchDocument(validated);
                return {
                    payload,
                    blob,
                    summary: {
                        ...summary,
                        hoverSource: summary.primarySource
                    }
                };
            },
            async restorePayload(rawPayload, libraryId = null, libraryName = null) {
                stitchAnalysisToken += 1;
                let validated = this.validatePayload(rawPayload);
                let previews = {};
                try {
                    previews = await buildStitchPreviewMap(validated);
                } catch (_error) {
                    previews = {};
                }
                validated = normalizeStitchDocument({
                    ...validated,
                    analysis: {
                        ...validated.analysis,
                        previews
                    }
                });
                updateStitchDocument(() => validated, { renderStitch: true });
                setActiveLibraryOrigin('stitch', libraryId, libraryName);
                commitActiveSection('stitch');
                setNotice(`Loaded "${libraryName || 'project'}" from Library.`, 'success');
                return true;
            }
        },
        {
            type: '3d',
            label: '3D Scene',
            getCurrentDocument(state) {
                return state.threeDDocument;
            },
            isEmpty(document) {
                return !document?.scene?.items?.length;
            },
            canSave(document) {
                return !!document?.scene?.items?.length;
            },
            emptyNotice: 'Add at least one 3D asset to the scene before saving to the Library.',
            suggestName(document, nameOverride = null) {
                return getSuggestedThreeDProjectName(document, nameOverride);
            },
            serializeDocument(document) {
                return buildThreeDLibraryPayload(document);
            },
            validatePayload(rawPayload) {
                return normalizeThreeDDocument(stripLibraryMetadata(normalizeLegacyDocumentPayload(rawPayload)));
            },
            async captureDocument(document) {
                const normalized = normalizeThreeDDocument(document);
                let preview = null;
                try {
                    preview = await view?.captureThreeDPreview?.();
                } catch (_error) {
                    preview = null;
                }
                const payload = this.serializeDocument({
                    ...normalized,
                    preview: preview
                        ? {
                            imageData: preview.dataUrl,
                            width: preview.width,
                            height: preview.height,
                            updatedAt: Date.now()
                        }
                        : normalized.preview
                });
                const blob = preview?.blob || (payload.preview?.imageData ? await dataUrlToBlob(payload.preview.imageData) : await new Promise((resolve) => {
                    const canvas = globalThis.document.createElement('canvas');
                    canvas.width = 320;
                    canvas.height = 200;
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = payload.scene.backgroundColor || '#202020';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.fillStyle = '#f4f4f4';
                    ctx.font = '20px sans-serif';
                    ctx.textAlign = 'center';
                    ctx.fillText('3D Scene', canvas.width / 2, canvas.height / 2);
                    canvas.toBlob(resolve, 'image/png');
                }));
                const summary = summarizeThreeDDocument(payload);
                return {
                    payload,
                    blob,
                    summary
                };
            },
            async prepareImportedProject(rawPayload) {
                const payload = this.validatePayload(rawPayload);
                const blob = payload.preview?.imageData
                    ? await dataUrlToBlob(payload.preview.imageData)
                    : await new Promise((resolve) => {
                        const canvas = globalThis.document.createElement('canvas');
                        canvas.width = 320;
                        canvas.height = 200;
                        const ctx = canvas.getContext('2d');
                        ctx.fillStyle = payload.scene.backgroundColor || '#202020';
                        ctx.fillRect(0, 0, canvas.width, canvas.height);
                        ctx.fillStyle = '#f4f4f4';
                        ctx.font = '20px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.fillText('3D Scene', canvas.width / 2, canvas.height / 2);
                        canvas.toBlob(resolve, 'image/png');
                    });
                return {
                    payload,
                    blob,
                    summary: summarizeThreeDDocument(payload)
                };
            },
            async restorePayload(rawPayload, libraryId = null, libraryName = null) {
                if (!ensureThreeDSceneUnlocked(`loading "${libraryName || 'this 3D Library project'}"`)) return false;
                const validated = this.validatePayload(rawPayload);
                store.setState((current) => ({ ...current, threeDDocument: validated }), { render: false });
                setActiveLibraryOrigin('3d', libraryId, libraryName);
                commitActiveSection('3d');
                setNotice(`Loaded "${libraryName || 'project'}" from Library.`, 'success');
                return true;
            }
        }
    ]);

    view = createWorkspaceUI(root, registry, actions, { stitchEngine });
    await engine.init(view.getRenderRefs().canvas);
    engine.attachRefs(view.getRenderRefs());

    store.subscribe((state, meta) => {
        if (!meta.skipViewRender) {
            view.render(state);
            engine.attachRefs(view.getRenderRefs());
        }
        if (meta.render && engine.hasImage()) engine.requestRender(state.document);
        if (meta.renderStitch) stitchEngine.requestRender(state.stitchDocument);
    });

    view.render(store.getState());
    engine.attachRefs(view.getRenderRefs());
    setNotice(
        store.getState().ui.activeSection === 'library'
            ? 'Browse saved projects in the Library, or switch to Editor to start a new one.'
            : store.getState().ui.activeSection === 'stitch'
                ? 'Add two or more images in Stitch to start building a composite.'
                : store.getState().ui.activeSection === '3d'
                    ? 'Load .glb models or add image planes to start building a 3D scene.'
                    : 'Load an image to start editing.',
        'info',
        6500
    );
});
