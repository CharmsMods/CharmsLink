import * as THREE from 'three';
import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { getRegistryUrls } from './registry/shared.js';
import { downloadState, readJsonFile, serializeState, validateImportPayload } from './io/documents.js';
import { createProjectAdapterRegistry } from './io/projectAdapters.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { StitchEngine } from './stitch/engine.js';
import { analyzePreparedStitchInputs } from './stitch/analysis.js';
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
    createThreeDAssetId,
    createThreeDCameraPresetId,
    createThreeDSceneItemId,
    isThreeDDocumentPayload,
    normalizeThreeDDocument,
    serializeThreeDDocument,
    summarizeThreeDDocument
} from './3d/document.js';
import {
    alignCameraToLockedView,
    createAttachmentFromWorldHit,
    createCanvasSpawnTransform,
    resolveAttachmentTransform
} from './3d/viewMath.js';
import { createLogEngine } from './logs/engine.js';
import { maybeYieldToUi, nextPaint } from './ui/scheduling.js';
import { createBackgroundTaskBroker } from './workers/runtime.js';
import { detectWorkerCapabilities } from './workers/capabilities.js';
import { createBootstrapMetrics } from './perf/bootstrapMetrics.js';
import { createBootShell } from './ui/bootShell.js';

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

function stripLibraryEnvelopeMetadata(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const cloned = JSON.parse(JSON.stringify(payload));
    delete cloned._libraryName;
    delete cloned._libraryTags;
    delete cloned._libraryProjectType;
    delete cloned._libraryHoverSource;
    delete cloned._librarySourceArea;
    delete cloned._librarySourceCount;
    return cloned;
}

function stripProjectFingerprintMetadata(payload) {
    const cloned = stripLibraryEnvelopeMetadata(payload);
    if (!cloned || typeof cloned !== 'object') return cloned;
    if (cloned.preview && typeof cloned.preview === 'object') {
        delete cloned.preview.width;
        delete cloned.preview.height;
        delete cloned.preview.imageData;
        delete cloned.preview.updatedAt;
    }
    if (isThreeDDocumentPayload(cloned)) {
        if (cloned.render && typeof cloned.render === 'object') {
            delete cloned.render.currentSamples;
        }
        delete cloned.renderJob;
    }
    return cloned;
}

function makeProjectFingerprint(payload) {
    return stableSerialize(stripProjectFingerprintMetadata(payload));
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

function isLibraryAssetRecord(entry) {
    return !!entry && (entry.kind === 'library-asset' || entry.recordType === 'asset');
}

function isLibraryProjectRecord(entry) {
    return !!entry && !isLibraryMetaRecord(entry) && !isLibraryAssetRecord(entry);
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

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripThreeDDuplicateSuffix(name) {
    const trimmed = String(name || 'Item').trim() || 'Item';
    return trimmed
        .replace(/\s+copy(?:\s+\d+)?$/i, '')
        .replace(/\s*\(\d+\)\s*$/i, '')
        .trim() || 'Item';
}

function getThreeDDuplicateFamilyIndex(name, stem) {
    const trimmed = String(name || '').trim();
    const normalizedStem = String(stem || '').trim();
    if (!trimmed || !normalizedStem) return null;
    if (trimmed.toLowerCase() === normalizedStem.toLowerCase()) return 1;

    const escapedStem = escapeRegExp(normalizedStem);
    const numberedMatch = trimmed.match(new RegExp(`^${escapedStem}\\s*\\((\\d+)\\)$`, 'i'));
    if (numberedMatch) {
        return Math.max(1, Number(numberedMatch[1]) || 1);
    }

    const legacyCopyMatch = trimmed.match(new RegExp(`^${escapedStem}\\s+copy(?:\\s+(\\d+))?$`, 'i'));
    if (legacyCopyMatch) {
        return legacyCopyMatch[1]
            ? Math.max(2, (Number(legacyCopyMatch[1]) || 1) + 1)
            : 2;
    }

    return null;
}

function createDuplicateThreeDItemName(baseName, items = []) {
    const stem = stripThreeDDuplicateSuffix(baseName);
    const familyIndices = (items || [])
        .map((item) => getThreeDDuplicateFamilyIndex(item?.name, stem))
        .filter((value) => Number.isFinite(value));
    const nextIndex = familyIndices.length
        ? Math.max(...familyIndices) + 1
        : 2;
    return `${stem} (${nextIndex})`;
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

function isThreeDBooleanCompatibleItem(item) {
    return item?.kind === 'model' || item?.kind === 'primitive';
}

function getThreeDCanvasSpawn(view = {}) {
    const spawn = createCanvasSpawnTransform(view);
    return {
        position: spawn.position || [0, 0, 0],
        rotation: spawn.rotation || [0, 0, 0]
    };
}

function createThreeDTextItem(view = {}, overrides = {}) {
    const spawn = getThreeDCanvasSpawn(view);
    return {
        id: createThreeDSceneItemId('text'),
        kind: 'text',
        name: 'Text',
        visible: true,
        locked: false,
        position: [...spawn.position],
        rotation: [...spawn.rotation],
        scale: [1, 1, 1],
        text: {
            content: 'Text',
            mode: 'flat',
            fontSource: {
                type: 'system',
                assetId: null,
                family: 'Arial'
            },
            color: '#ffffff',
            opacity: 1,
            glow: {
                enabled: false,
                color: '#ffffff',
                intensity: 4
            },
            characterOverrides: [],
            extrude: {
                depth: 0.2,
                bevelSize: 0.02,
                bevelThickness: 0.02,
                bevelSegments: 2
            },
            attachment: null,
            ...(overrides.text || {})
        }
    };
}

function createThreeDShapeItem(shapeType = 'square', view = {}) {
    const spawn = getThreeDCanvasSpawn(view);
    return {
        id: createThreeDSceneItemId('shape'),
        kind: 'shape-2d',
        name: shapeType === 'circle' ? 'Circle' : 'Square',
        visible: true,
        locked: false,
        position: [...spawn.position],
        rotation: [...spawn.rotation],
        scale: [1, 1, 1],
        shape2d: {
            type: shapeType === 'circle' ? 'circle' : 'square',
            color: '#ffffff',
            opacity: 1,
            glow: {
                enabled: false,
                color: '#ffffff',
                intensity: 4
            }
        }
    };
}

function getThreeDFileExtension(fileName = '') {
    const match = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
}

function buildThreeDTargetMatrix(item = {}) {
    return new THREE.Matrix4().compose(
        new THREE.Vector3(...(item.position || [0, 0, 0])),
        new THREE.Quaternion().setFromEuler(new THREE.Euler(...(item.rotation || [0, 0, 0]), 'XYZ')),
        new THREE.Vector3(...(item.scale || [1, 1, 1]))
    );
}

function applyAttachedTextTransforms(items = [], changedItemId = null) {
    const itemMap = new Map(items.map((item) => [item.id, item]));
    return items.map((item) => {
        if (item.kind !== 'text' || !item.text?.attachment?.targetItemId) return item;
        const target = itemMap.get(item.text.attachment.targetItemId);
        if (!target) {
            return {
                ...item,
                text: {
                    ...item.text,
                    attachment: null
                }
            };
        }
        if (changedItemId && target.id !== changedItemId) {
            return item;
        }
        const transform = resolveAttachmentTransform(target, item.text.attachment);
        if (!transform) return item;
        return {
            ...item,
            position: [...transform.position],
            rotation: [...transform.rotation]
        };
    });
}

function buildLibraryPayload(documentState, preview = null) {
    return serializeState(documentState, {
        includeSource: true,
        preview
    });
}

function buildStitchLibraryPayload(documentState) {
    return stripEphemeralStitchState(documentState);
}

function buildThreeDLibraryPayload(documentState) {
    const payload = serializeThreeDDocument(normalizeThreeDDocument(documentState));
    if (payload.render && typeof payload.render === 'object') {
        payload.render.currentSamples = 0;
    }
    delete payload.renderJob;
    return payload;
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

function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function createStudioPreviewSnapshot(studioEngine, documentState, dataUrl) {
    if (!dataUrl) return null;
    return {
        imageData: dataUrl,
        width: Number(studioEngine?.runtime?.renderWidth || documentState.source?.width || 0),
        height: Number(studioEngine?.runtime?.renderHeight || documentState.source?.height || 0),
        updatedAt: Date.now()
    };
}

function stripStudioPreview(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const cloned = { ...payload };
    delete cloned.preview;
    return cloned;
}

async function captureStudioDocumentSnapshot(studioEngine, documentState, payload = null) {
    const blob = await studioEngine.exportPngBlob(documentState);
    const dataUrl = await blobToDataUrl(blob);
    const preview = createStudioPreviewSnapshot(studioEngine, documentState, dataUrl);
    return {
        blob,
        preview,
        payload: buildLibraryPayload(documentState, preview || payload?.preview || null)
    };
}

function clearStudioEngineImage(studioEngine) {
    if (!studioEngine?.runtime) return;
    const { runtime } = studioEngine;
    const gl = runtime.gl;
    if (gl && runtime.textures?.base) {
        gl.deleteTexture(runtime.textures.base);
    }
    runtime.textures.base = null;
    runtime.baseImage = null;
    runtime.sourceWidth = 1;
    runtime.sourceHeight = 1;
    runtime.renderWidth = 1;
    runtime.renderHeight = 1;
    runtime.currentPool = null;
    runtime.fboPools = {};
    runtime.layerResolutions = {};
    runtime.layerLayouts = {};
    runtime.renderRequested = false;
    runtime.selectedLayerContext = null;
    runtime.selectedLayerOutput = null;
    runtime.hasRenderableLayers = false;
    runtime.sourcePlacement = { x: 0, y: 0, w: 1, h: 1 };
    const canvas = studioEngine.refs?.canvas;
    if (gl && canvas) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, Math.max(1, canvas.width || 1), Math.max(1, canvas.height || 1));
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
    }
}

function bytesToHex(bytes) {
    return Array.from(bytes || []).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function sampleHashString(text) {
    const source = String(text || '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function normalizeLibraryAssetType(assetType) {
    return String(assetType || '').toLowerCase() === 'model' ? 'model' : 'image';
}

async function computeLibraryAssetFingerprint({
    assetType = 'image',
    format = '',
    mimeType = '',
    dataUrl = ''
} = {}) {
    const normalizedType = normalizeLibraryAssetType(assetType);
    const normalizedFormat = String(format || '').trim().toLowerCase();
    const normalizedMimeType = String(mimeType || '').trim().toLowerCase();
    const normalizedDataUrl = String(dataUrl || '');
    if (!normalizedDataUrl) {
        return `${normalizedType}:${normalizedFormat}:${normalizedMimeType}:empty`;
    }
    if (crypto?.subtle) {
        try {
            const blob = await dataUrlToBlob(normalizedDataUrl);
            const buffer = await blob.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            return `${normalizedType}:${normalizedFormat}:${normalizedMimeType}:${bytesToHex(new Uint8Array(digest))}`;
        } catch (_error) {
            // Fall through to the string hash if byte hashing is unavailable.
        }
    }
    return `${normalizedType}:${normalizedFormat}:${normalizedMimeType}:${sampleHashString(normalizedDataUrl)}`;
}

async function createLibraryImageAssetPreview(dataUrl, { maxEdge = 192 } = {}) {
    const normalizedDataUrl = String(dataUrl || '');
    if (!normalizedDataUrl) return '';
    const image = await loadImageFromDataUrl(normalizedDataUrl);
    const sourceWidth = Math.max(1, image.naturalWidth || image.width || 1);
    const sourceHeight = Math.max(1, image.naturalHeight || image.height || 1);
    const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
    const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
    const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return '';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);
    return canvas.toDataURL('image/png');
}

async function readImageMetadataFallback({ dataUrl = '' } = {}) {
    const normalizedDataUrl = String(dataUrl || '');
    if (!normalizedDataUrl) {
        return {
            width: 0,
            height: 0
        };
    }
    const image = await loadImageFromDataUrl(normalizedDataUrl);
    return {
        width: Math.max(1, image.naturalWidth || image.width || 1),
        height: Math.max(1, image.naturalHeight || image.height || 1)
    };
}

async function prepareLibraryAssetRecordFallback(payload = {}) {
    const fingerprint = await computeLibraryAssetFingerprint(payload);
    if (normalizeLibraryAssetType(payload.assetType) !== 'image') {
        return {
            fingerprint,
            previewDataUrl: String(payload.previewDataUrl || ''),
            width: Math.max(0, Number(payload.width) || 0),
            height: Math.max(0, Number(payload.height) || 0)
        };
    }
    const metadata = await readImageMetadataFallback(payload);
    const previewDataUrl = payload.dataUrl
        ? await createLibraryImageAssetPreview(payload.dataUrl, { maxEdge: payload.maxEdge })
        : String(payload.previewDataUrl || '');
    return {
        fingerprint,
        previewDataUrl,
        width: metadata.width,
        height: metadata.height
    };
}

async function readStudioStateFileFallback(file) {
    const payload = validateImportPayload(normalizeLegacyDocumentPayload(await readJsonFile(file)), 'document');
    return { payload };
}

async function computeLibraryAssetFingerprintInBackground(payload = {}) {
    if (!backgroundTasks) {
        return computeLibraryAssetFingerprint(payload);
    }
    const result = await backgroundTasks.runTask('app-library', 'fingerprint-asset', payload, {
        priority: 'background',
        processId: 'library.assets'
    });
    return String(result?.fingerprint || '');
}

async function prepareLibraryAssetRecord(record, existingAsset = null) {
    const assetType = normalizeLibraryAssetType(record?.assetType);
    const dataUrl = String(record?.dataUrl || existingAsset?.dataUrl || '');
    const explicitPreview = String(record?.previewDataUrl || '');
    const fallbackWidth = Math.max(0, Number(record?.width || existingAsset?.width || 0));
    const fallbackHeight = Math.max(0, Number(record?.height || existingAsset?.height || 0));
    const fingerprint = record?.assetFingerprint || await computeLibraryAssetFingerprintInBackground({
        assetType,
        format: record?.format,
        mimeType: record?.mimeType,
        dataUrl
    });

    if (assetType !== 'image') {
        return {
            fingerprint,
            previewDataUrl: explicitPreview || String(existingAsset?.previewDataUrl || ''),
            width: fallbackWidth,
            height: fallbackHeight
        };
    }

    if (explicitPreview) {
        return {
            fingerprint,
            previewDataUrl: explicitPreview,
            width: fallbackWidth,
            height: fallbackHeight
        };
    }

    if (existingAsset?.previewDataUrl && existingAsset.assetFingerprint === fingerprint) {
        return {
            fingerprint,
            previewDataUrl: String(existingAsset.previewDataUrl || ''),
            width: fallbackWidth || Math.max(0, Number(existingAsset.width || 0)),
            height: fallbackHeight || Math.max(0, Number(existingAsset.height || 0))
        };
    }

    if (!dataUrl) {
        return {
            fingerprint,
            previewDataUrl: '',
            width: fallbackWidth,
            height: fallbackHeight
        };
    }

    if (!backgroundTasks) {
        return prepareLibraryAssetRecordFallback({
            assetType,
            format: record?.format,
            mimeType: record?.mimeType,
            dataUrl,
            width: fallbackWidth,
            height: fallbackHeight
        });
    }

    return backgroundTasks.runTask('app-library', 'prepare-asset-record', {
        assetType,
        format: record?.format,
        mimeType: record?.mimeType,
        dataUrl,
        width: fallbackWidth,
        height: fallbackHeight,
        maxEdge: 192
    }, {
        priority: 'background',
        processId: 'library.assets'
    });
}

async function resolveLibraryImageAssetPreview(record, existingAsset, fingerprint) {
    if (normalizeLibraryAssetType(record?.assetType) !== 'image') {
        return String(record?.previewDataUrl || existingAsset?.previewDataUrl || '');
    }
    const explicitPreview = String(record?.previewDataUrl || '');
    if (explicitPreview) return explicitPreview;
    if (existingAsset?.previewDataUrl && existingAsset.assetFingerprint === fingerprint) {
        return String(existingAsset.previewDataUrl);
    }
    const dataUrl = String(record?.dataUrl || existingAsset?.dataUrl || '');
    if (!dataUrl) return '';
    try {
        return await createLibraryImageAssetPreview(dataUrl);
    } catch (_error) {
        return existingAsset?.assetFingerprint === fingerprint
            ? String(existingAsset.previewDataUrl || '')
            : '';
    }
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
        kind: 'library-project',
        recordType: 'project',
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

function buildLibraryAssetRecord({
    id,
    name,
    assetType = 'image',
    format = '',
    mimeType = '',
    dataUrl = '',
    previewDataUrl = '',
    tags = [],
    width = 0,
    height = 0,
    timestamp = Date.now(),
    sourceProjectId = null,
    sourceProjectType = null,
    sourceProjectName = null,
    assetFingerprint = '',
    origin = 'library'
}) {
    return {
        id,
        kind: 'library-asset',
        recordType: 'asset',
        timestamp,
        name: String(name || (normalizeLibraryAssetType(assetType) === 'model' ? 'Model Asset' : 'Image Asset')),
        assetType: normalizeLibraryAssetType(assetType),
        format: String(format || '').trim().toLowerCase(),
        mimeType: String(mimeType || ''),
        dataUrl: String(dataUrl || ''),
        previewDataUrl: String(previewDataUrl || ''),
        tags: normalizeLibraryTags(tags),
        width: Math.max(0, Number(width) || 0),
        height: Math.max(0, Number(height) || 0),
        sourceProjectId: sourceProjectId ? String(sourceProjectId) : null,
        sourceProjectType: sourceProjectType ? String(sourceProjectType) : null,
        sourceProjectName: sourceProjectName ? String(sourceProjectName) : null,
        assetFingerprint: String(assetFingerprint || ''),
        origin: String(origin || 'library')
    };
}

function normalizeLibraryAssetRecord(entry) {
    if (!isLibraryAssetRecord(entry)) return null;
    return buildLibraryAssetRecord({
        ...entry,
        id: entry.id || createLibraryProjectId()
    });
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
        if (section === 'library' || section === 'stitch' || section === '3d' || section === 'logs') return section;
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
        else if (section === 'logs') url.searchParams.set('section', 'logs');
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
                loadImageOnOpen: true
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
    const root = document.getElementById('app');
    const bootShell = createBootShell(root, {
        detail: 'Preparing the app shell...'
    });
    const bootMetrics = createBootstrapMetrics();
    const logger = createLogEngine({
        recentLimit: 18,
        historyLimit: 0
    });
    const PROCESS_LABELS = {
        'app.bootstrap': 'App Startup',
        'app.performance': 'Performance',
        'app.navigation': 'Navigation',
        'app.notice': 'Notices',
        'editor.files': 'Editor Files',
        'editor.export': 'Editor Export',
        'library.projects': 'Library Projects',
        'library.assets': 'Library Assets',
        'library.sync': 'Library Sync',
        'library.import': 'Library Import',
        'library.export': 'Library Export',
        'stitch.workspace': 'Stitch Workspace',
        'stitch.analysis': 'Stitch Analysis',
        '3d.workspace': '3D Workspace',
        '3d.assets': '3D Assets',
        '3d.render': '3D Render'
    };
    let registry = null;
    let store = null;
    let engine = null;
    let stitchEngine = null;
    let backgroundTasks = null;
    let workerCapabilities = null;

    let noticeTimer = null;
    let playbackTimer = null;
    let view = null;
    let paletteExtractionImage = null;
    let paletteExtractionOwner = null;
    let stitchAnalysisToken = 0;
    bootMetrics.mark('dom-content-loaded', 'DOMContentLoaded fired.');

    function setEditorProgress(payload = null) {
        view?.setEditorProgress?.(payload);
    }

    function setStitchProgress(payload = null) {
        view?.setStitchProgress?.(payload);
    }

    function setThreeDProgress(payload = null) {
        view?.setThreeDProgress?.(payload);
    }

    function clearWorkspaceProgress(projectType) {
        if (projectType === 'stitch') {
            setStitchProgress(null);
            return;
        }
        if (projectType === '3d') {
            setThreeDProgress(null);
            return;
        }
        setEditorProgress(null);
    }

    function setWorkspaceProgress(projectType, payload = null) {
        if (projectType === 'stitch') {
            setStitchProgress(payload);
            return;
        }
        if (projectType === '3d') {
            setThreeDProgress(payload);
            return;
        }
        setEditorProgress(payload);
    }

    async function showWorkspaceProgress(projectType, payload = {}) {
        setWorkspaceProgress(projectType, { ...payload, active: true });
        await nextPaint();
    }

    function logProcess(level, processId, message, options = {}) {
        if (!logger || !message) return;
        const label = PROCESS_LABELS[processId] || processId;
        const method = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.info.bind(logger);
        method(processId, label, message, options);
    }

    function logTone(processId, message, tone = 'info', options = {}) {
        const level = tone === 'error'
            ? 'error'
            : tone === 'warning'
                ? 'warning'
                : tone === 'success'
                    ? 'success'
                    : tone === 'active'
                        ? 'active'
                    : 'info';
        logProcess(level, processId, message, options);
    }

    function logProgressProcess(processId, message, ratio, options = {}) {
        if (!logger || !message) return;
        const label = PROCESS_LABELS[processId] || processId;
        if (typeof logger.progress === 'function') {
            logger.progress(processId, label, message, ratio, options);
            return;
        }
        logProcess('active', processId, message, {
            ...options,
            progress: ratio
        });
    }

    function setBootStage(stage, detail) {
        bootShell.setStage(stage, detail);
        bootMetrics.mark(stage, detail);
        if (detail) {
            logProcess('info', 'app.bootstrap', detail, {
                dedupeKey: `boot-stage:${stage}`,
                dedupeWindowMs: 120
            });
        }
    }

    function handleWorkerEvent(event) {
        if (!event || event.type !== 'log' || !event.message) return;
        const processId = event.processId || 'app.bootstrap';
        const tone = event.level === 'error'
            ? 'error'
            : event.level === 'warning'
                ? 'warning'
                : event.level === 'success'
                    ? 'success'
                    : event.level === 'active'
                        ? 'active'
                        : 'info';
        logTone(processId, event.message, tone, {
            dedupeKey: `worker-log:${event.domain}:${event.task}:${event.message}`,
            dedupeWindowMs: 120
        });
    }

    function registerWorkerDomains() {
        if (!backgroundTasks) return;
        backgroundTasks.registerDomain('app-library', {
            workerUrl: new URL('./workers/appLibrary.worker.js', import.meta.url),
            supportsTask(task, capabilities) {
                if (task === 'prepare-asset-record') {
                    return !!capabilities.createImageBitmap && !!capabilities.offscreenCanvas2d;
                }
                if (task === 'read-image-metadata') {
                    return !!capabilities.createImageBitmap;
                }
                return true;
            },
            fallback(task, payload) {
                if (task === 'load-registry') {
                    return loadRegistry({
                        urls: {
                            registryUrl: payload.registryUrl,
                            utilityProgramsUrl: payload.utilityProgramsUrl
                        }
                    });
                }
                if (task === 'prepare-asset-record') {
                    return prepareLibraryAssetRecordFallback(payload);
                }
                if (task === 'fingerprint-asset') {
                    return computeLibraryAssetFingerprint(payload).then((fingerprint) => ({ fingerprint }));
                }
                if (task === 'read-image-metadata') {
                    return readImageMetadataFallback(payload);
                }
                throw new Error(`Unknown app-library task "${task}".`);
            }
        });
        backgroundTasks.registerDomain('editor', {
            workerUrl: new URL('./workers/editor.worker.js', import.meta.url),
            fallback(task, payload) {
                if (task === 'read-studio-state-file') {
                    return readStudioStateFileFallback(payload.file);
                }
                throw new Error(`Unknown editor task "${task}".`);
            }
        });
        backgroundTasks.registerDomain('stitch', {
            workerUrl: new URL('./workers/stitch.worker.js', import.meta.url),
            supportsTask(task, capabilities) {
                if (task === 'prepare-input-files') {
                    return !!capabilities.createImageBitmap;
                }
                return true;
            },
            fallback(task, payload, context) {
                if (task === 'analyze-screenshot') {
                    return analyzePreparedStitchInputs(payload.document, payload.preparedInputs);
                }
                if (task === 'prepare-input-files') {
                    return createStitchInputsFromFilesFallback(payload.files, {
                        onProgress(progress) {
                            context.progress(progress?.progress, progress?.message, progress);
                        }
                    });
                }
                throw new Error(`Unknown stitch task "${task}".`);
            }
        });
        backgroundTasks.registerDomain('three', {
            workerUrl: new URL('./workers/three.worker.js', import.meta.url),
            supportsTask(task, capabilities) {
                if (task === 'prepare-image-plane-files') {
                    return !!capabilities.createImageBitmap;
                }
                return true;
            },
            fallback(task, payload, context) {
                if (task === 'prepare-model-files') {
                    return createThreeDModelItemsFromFilesFallback(payload.files, {
                        onProgress(progress) {
                            context.progress(progress?.progress, progress?.message, progress);
                        }
                    }).then((items) => ({ items }));
                }
                if (task === 'prepare-image-plane-files') {
                    return createThreeDImagePlaneItemsFromFilesFallback(payload.files, {
                        onProgress(progress) {
                            context.progress(progress?.progress, progress?.message, progress);
                        }
                    }).then((items) => ({ items }));
                }
                if (task === 'prepare-font-files') {
                    return createThreeDFontAssetsFromFilesFallback(payload.files, {
                        onProgress(progress) {
                            context.progress(progress?.progress, progress?.message, progress);
                        }
                    }).then((assets) => ({ assets }));
                }
                if (task === 'prepare-hdri-file') {
                    return createThreeDHdriAssetFromFileFallback(payload.file, {
                        onProgress(progress) {
                            context.progress(progress?.progress, progress?.message, progress);
                        }
                    }).then((asset) => ({ asset }));
                }
                throw new Error(`Unknown three task "${task}".`);
            }
        });
    }

    setBootStage('boot shell', 'Preparing the app shell...');
    await nextPaint();
    bootMetrics.mark('boot-shell-painted', 'The lightweight boot shell rendered.');
    workerCapabilities = await detectWorkerCapabilities();
    backgroundTasks = createBackgroundTaskBroker({
        capabilities: workerCapabilities,
        onEvent: handleWorkerEvent,
        onTaskMetric: (metric) => bootMetrics.trackWorkerTask(metric)
    });
    registerWorkerDomains();
    logProcess('info', 'app.bootstrap', `Worker capabilities ready: ${[
        workerCapabilities.worker ? 'worker' : null,
        workerCapabilities.moduleWorker ? 'module-worker' : null,
        workerCapabilities.wasm ? 'wasm' : null,
        workerCapabilities.offscreenCanvas2d ? 'offscreen-2d' : null,
        workerCapabilities.offscreenCanvasWebgl2 ? 'offscreen-webgl2' : null,
        workerCapabilities.compressionStreams ? 'compression-streams' : null,
        workerCapabilities.fileSystemAccess ? 'fs-access' : null,
        workerCapabilities.createImageBitmap ? 'image-bitmap' : null
    ].filter(Boolean).join(', ') || 'fallback-only'}.`, {
        dedupeKey: 'worker-capabilities-ready',
        dedupeWindowMs: 500
    });
    window.__modularStudioPerformance = {
        capabilities: workerCapabilities,
        snapshot() {
            return bootMetrics.snapshot();
        }
    };

    setBootStage('registry bootstrap', 'Loading the effect registry...');
    registry = await backgroundTasks.runTask('app-library', 'load-registry', {
        ...getRegistryUrls()
    }, {
        priority: 'critical-boot',
        processId: 'app.bootstrap'
    });
    store = createStore(createInitialState());
    engine = new NoiseStudioEngine(registry, {
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
    stitchEngine = new StitchEngine({
        taskBroker: backgroundTasks
    });

    function setNotice(text, type = 'info', timeout = 4200) {
        if (noticeTimer) clearTimeout(noticeTimer);
        if (text) {
            logTone('app.notice', text, type, {
                dedupeKey: `${type}|${text}`,
                dedupeWindowMs: 250
            });
        }
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
        const currentSection = store.getState().ui.activeSection;
        const nextSection = section === 'library'
            ? 'library'
            : section === 'stitch'
                ? 'stitch'
                : section === '3d'
                    ? '3d'
                    : section === 'logs'
                        ? 'logs'
                        : 'editor';
        if (nextSection !== 'editor') stopPlayback();
        syncSectionUrl(nextSection);
        if (nextSection !== currentSection) {
            logProcess('info', 'app.navigation', `Switched to ${nextSection === '3d' ? '3D' : nextSection === 'logs' ? 'Logs' : nextSection.charAt(0).toUpperCase() + nextSection.slice(1)}.`, {
                dedupeKey: `section:${nextSection}`,
                dedupeWindowMs: 80
            });
        }
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

    let pendingLibraryRefreshNotification = false;
    function notifyLibraryChanged() {
        if (pendingLibraryRefreshNotification) return;
        pendingLibraryRefreshNotification = true;
        logProcess('active', 'library.sync', 'Queued a Library refresh for linked views.', {
            dedupeKey: 'library-refresh-queued',
            dedupeWindowMs: 400
        });
        const flushNotification = () => {
            pendingLibraryRefreshNotification = false;
            view?.refreshLibrary?.();
            logProcess('info', 'library.sync', 'Library-linked views refreshed.', {
                dedupeKey: 'library-refresh-flush',
                dedupeWindowMs: 400
            });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(flushNotification);
            return;
        }
        setTimeout(flushNotification, 0);
    }

    let studioProjectPreviewBackfillComplete = false;
    let studioProjectPreviewBackfillPromise = null;
    let derivedStudioAssetBackfillComplete = false;
    let derivedStudioAssetBackfillPromise = null;
    let imageAssetPreviewBackfillComplete = false;
    let imageAssetPreviewBackfillPromise = null;

    async function getAllLibraryProjectRecords() {
        return (await getAllFromLibraryDB()).filter((entry) => isLibraryProjectRecord(entry));
    }

    async function getAllLibraryAssetRecords() {
        return (await getAllFromLibraryDB())
            .filter((entry) => isLibraryAssetRecord(entry))
            .map((entry) => normalizeLibraryAssetRecord(entry))
            .filter(Boolean);
    }

    async function restoreActiveStudioRender() {
        const liveDocument = store.getState().document;
        const liveSource = liveDocument?.source;
        if (liveSource?.imageData) {
            const liveImage = await loadImageFromDataUrl(liveSource.imageData);
            await engine.loadImage(liveImage, liveSource);
            engine.requestRender(liveDocument);
            return true;
        }
        clearStudioEngineImage(engine);
        return false;
    }

    async function saveLibraryAssetRecord(record, options = {}) {
        const existingAsset = options.existingAsset ? normalizeLibraryAssetRecord(options.existingAsset) : null;
        const prepared = await prepareLibraryAssetRecord(record, existingAsset);
        const nextRecord = buildLibraryAssetRecord({
            ...record,
            id: existingAsset?.id || record.id || createLibraryProjectId(),
            timestamp: options.preserveTimestamp && existingAsset?.timestamp
                ? existingAsset.timestamp
                : (record.timestamp || Date.now()),
            name: options.preserveExistingName !== false && existingAsset?.name
                ? existingAsset.name
                : record.name,
            tags: options.preserveExistingTags !== false && existingAsset
                ? existingAsset.tags
                : record.tags,
            previewDataUrl: prepared.previewDataUrl,
            width: Number(record.width || prepared.width || existingAsset?.width || 0),
            height: Number(record.height || prepared.height || existingAsset?.height || 0),
            assetFingerprint: prepared.fingerprint
        });
        await saveToLibraryDB(nextRecord);
        if (nextRecord.tags.length) {
            await registerLibraryTags(nextRecord.tags);
        }
        logProcess('info', 'library.assets', `${existingAsset ? 'Updated' : 'Saved'} asset "${nextRecord.name || 'Asset'}" (${nextRecord.assetType || 'asset'}).`, {
            dedupeKey: `${existingAsset ? 'update' : 'save'}:${nextRecord.id}:${nextRecord.assetFingerprint || ''}`,
            dedupeWindowMs: 120
        });
        return nextRecord;
    }

    async function upsertDerivedStudioAsset(projectRecord, options = {}) {
        if (!projectRecord || getLibraryProjectType(projectRecord) !== 'studio') return null;
        const blob = projectRecord.blob
            || (projectRecord.payload?.preview?.imageData ? await dataUrlToBlob(projectRecord.payload.preview.imageData) : null);
        if (!blob) return null;

        const existingAsset = options.existingAsset
            || (options.existingAssets || []).find((asset) => asset.sourceProjectId === projectRecord.id)
            || (await getAllLibraryAssetRecords()).find((asset) => asset.sourceProjectId === projectRecord.id)
            || null;
        const dataUrl = await blobToDataUrl(blob);
        return saveLibraryAssetRecord({
            id: existingAsset?.id || null,
            name: existingAsset?.name || projectRecord.name,
            assetType: 'image',
            format: 'png',
            mimeType: blob.type || 'image/png',
            dataUrl,
            tags: existingAsset?.tags?.length ? existingAsset.tags : normalizeLibraryTags(projectRecord.tags || []),
            width: Number(projectRecord.renderWidth || projectRecord.payload?.preview?.width || 0),
            height: Number(projectRecord.renderHeight || projectRecord.payload?.preview?.height || 0),
            timestamp: Date.now(),
            sourceProjectId: projectRecord.id,
            sourceProjectType: 'studio',
            sourceProjectName: projectRecord.name,
            origin: 'editor-project'
        }, {
            existingAsset,
            preserveExistingName: true,
            preserveExistingTags: true
        });
    }

    async function saveLibraryAssetFromThreeDItem(item, options = {}) {
        if (!item?.asset?.dataUrl) return null;
        const assetType = item.kind === 'model' ? 'model' : item.kind === 'image-plane' ? 'image' : null;
        if (!assetType) return null;

        const format = item.asset?.format || (assetType === 'model' ? 'glb' : 'image');
        const mimeType = item.asset?.mimeType || '';
        const dataUrl = item.asset?.dataUrl || '';
        const fingerprint = await computeLibraryAssetFingerprintInBackground({
            assetType,
            format,
            mimeType,
            dataUrl
        });
        const existingAsset = options.existingAsset
            || (options.existingAssets || []).find((asset) => asset.assetFingerprint === fingerprint)
            || (await getAllLibraryAssetRecords()).find((asset) => asset.assetFingerprint === fingerprint)
            || null;
        if (existingAsset) {
            return existingAsset;
        }
        return saveLibraryAssetRecord({
            name: item.name,
            assetType,
            format,
            mimeType,
            dataUrl,
            width: Number(item.asset?.width || 0),
            height: Number(item.asset?.height || 0),
            tags: [],
            origin: '3d-import',
            assetFingerprint: fingerprint
        });
    }

    async function ensureLibraryAssetsFromThreeDItems(items = []) {
        const existingAssets = await getAllLibraryAssetRecords();
        const nextAssets = [...existingAssets];
        let addedCount = 0;
        if ((items || []).length) {
            logProcess('active', '3d.assets', `Checking ${(items || []).length} scene item${(items || []).length === 1 ? '' : 's'} against the Assets Library.`, {
                dedupeKey: `3d-asset-scan:${(items || []).length}`,
                dedupeWindowMs: 180
            });
        }
        for (let index = 0; index < (items || []).length; index += 1) {
            const item = items[index];
            if (!item?.asset?.dataUrl) continue;
            const savedAsset = await saveLibraryAssetFromThreeDItem(item, {
                existingAssets: nextAssets
            });
            if (!savedAsset) continue;
            if (!nextAssets.some((asset) => asset.id === savedAsset.id)) {
                nextAssets.push(savedAsset);
                addedCount += 1;
            }
            await maybeYieldToUi(index, 2);
        }
        if (addedCount) {
            notifyLibraryChanged();
            logProcess('success', 'library.assets', `Added ${addedCount} new asset${addedCount === 1 ? '' : 's'} from the 3D scene into the Assets Library.`);
        } else if ((items || []).length) {
            logProcess('info', 'library.assets', 'All scanned 3D scene assets were already present in the Assets Library.', {
                dedupeKey: '3d-asset-scan-noop',
                dedupeWindowMs: 500
            });
        }
        return addedCount;
    }

    async function deleteDerivedStudioAssetsByProjectIds(projectIds = []) {
        const targetIds = [...new Set((projectIds || []).filter(Boolean).map((value) => String(value)))];
        if (!targetIds.length) return;
        const assets = await getAllLibraryAssetRecords();
        for (const asset of assets) {
            if (asset.origin === 'editor-project' && asset.sourceProjectId && targetIds.includes(asset.sourceProjectId)) {
                await deleteFromLibraryDB(asset.id);
            }
        }
    }

    async function ensureStudioProjectPayloadPreviewsBackfilled(projectRecords = null) {
        if (studioProjectPreviewBackfillComplete) return;
        if (studioProjectPreviewBackfillPromise) {
            await studioProjectPreviewBackfillPromise;
            return;
        }
        studioProjectPreviewBackfillPromise = (async () => {
            const studioAdapter = projectAdapters?.getAdapter('studio');
            if (!studioAdapter) return;

            logProcess('active', 'library.projects', 'Checking saved Editor Library projects for missing embedded rendered previews.', {
                dedupeKey: 'studio-preview-backfill-start',
                dedupeWindowMs: 500
            });

            const sourceProjects = Array.isArray(projectRecords)
                ? projectRecords.filter((entry) => isLibraryProjectRecord(entry))
                : await getAllLibraryProjectRecords();

            let updatedCount = 0;
            let failedCount = 0;

            try {
                for (let index = 0; index < sourceProjects.length; index += 1) {
                    const projectRecord = sourceProjects[index];
                    if (getLibraryProjectType(projectRecord) !== 'studio') continue;

                    const existingPayload = normalizeLegacyDocumentPayload(projectRecord?.payload);
                    if (existingPayload?.preview?.imageData) continue;

                    try {
                        const validated = studioAdapter.validatePayload(existingPayload);
                        if (!validated?.source?.imageData) {
                            throw new Error('The saved Editor project is missing its embedded source image.');
                        }

                        const tempDoc = {
                            ...store.getState().document,
                            ...validated,
                            layerStack: validated.layerStack,
                            source: validated.source
                        };
                        const image = await loadImageFromDataUrl(validated.source.imageData);
                        await engine.loadImage(image, validated.source);
                        const capture = await captureStudioDocumentSnapshot(engine, tempDoc, validated);
                        const nextPayload = capture.payload || buildLibraryPayload(tempDoc, capture.preview || null);
                        const nextRecord = buildLibraryProjectRecord({
                            id: projectRecord.id,
                            timestamp: projectRecord.timestamp || Date.now(),
                            name: projectRecord.name,
                            blob: capture.blob || projectRecord.blob,
                            payload: nextPayload,
                            tags: normalizeLibraryTags(projectRecord.tags || extractLibraryProjectMeta(existingPayload).tags || []),
                            projectType: 'studio',
                            hoverSource: projectRecord.hoverSource || nextPayload.source,
                            sourceWidth: Number(projectRecord.sourceWidth || nextPayload.source?.width || 0),
                            sourceHeight: Number(projectRecord.sourceHeight || nextPayload.source?.height || 0),
                            sourceArea: Number(projectRecord.sourceAreaOverride || ((nextPayload.source?.width || 0) * (nextPayload.source?.height || 0)) || 0),
                            sourceCount: Number(projectRecord.sourceCount || (nextPayload.source?.imageData ? 1 : 0) || 0),
                            renderWidth: Number(capture.preview?.width || projectRecord.renderWidth || nextPayload.source?.width || 0),
                            renderHeight: Number(capture.preview?.height || projectRecord.renderHeight || nextPayload.source?.height || 0)
                        });
                        await saveToLibraryDB(nextRecord);
                        updatedCount += 1;
                        logProcess('info', 'library.projects', `Embedded a rendered preview into "${projectRecord.name || 'Untitled Project'}".`, {
                            dedupeKey: `studio-preview-backfill-item:${projectRecord.id}`,
                            dedupeWindowMs: 80
                        });
                    } catch (error) {
                        failedCount += 1;
                        console.warn('Could not backfill an embedded rendered preview for a Library Editor project.', error);
                        logProcess('warning', 'library.projects', `Could not embed a rendered preview into "${projectRecord.name || 'Untitled Project'}": ${error?.message || 'Unknown error.'}`);
                    }
                    await maybeYieldToUi(index, 1);
                }
            } finally {
                try {
                    await restoreActiveStudioRender();
                } catch (error) {
                    console.warn('Could not restore the active Editor render after Library preview backfill.', error);
                    logProcess('warning', 'library.projects', error?.message || 'Could not restore the active Editor render after Library preview backfill.');
                }
            }

            studioProjectPreviewBackfillComplete = failedCount === 0;
            if (updatedCount && failedCount) {
                notifyLibraryChanged();
                logProcess('warning', 'library.projects', `Embedded rendered previews into ${updatedCount} saved Editor project${updatedCount === 1 ? '' : 's'}; ${failedCount} still need attention.`);
                return;
            }
            if (updatedCount) {
                notifyLibraryChanged();
                logProcess('success', 'library.projects', `Embedded rendered previews into ${updatedCount} saved Editor project${updatedCount === 1 ? '' : 's'} missing them.`);
                return;
            }
            if (failedCount) {
                logProcess('warning', 'library.projects', `Could not embed rendered previews into ${failedCount} saved Editor project${failedCount === 1 ? '' : 's'}.`);
                return;
            }
            logProcess('info', 'library.projects', 'Every saved Editor Library project already had an embedded rendered preview.', {
                dedupeKey: 'studio-preview-backfill-noop',
                dedupeWindowMs: 1200
            });
        })().finally(() => {
            studioProjectPreviewBackfillPromise = null;
        });
        await studioProjectPreviewBackfillPromise;
    }

    async function ensureDerivedStudioAssetsBackfilled() {
        if (derivedStudioAssetBackfillComplete) return;
        if (derivedStudioAssetBackfillPromise) {
            await derivedStudioAssetBackfillPromise;
            return;
        }
        derivedStudioAssetBackfillPromise = (async () => {
            await ensureStudioProjectPayloadPreviewsBackfilled();
            logProcess('active', 'library.assets', 'Backfilling Editor-derived assets into the Assets Library.', {
                dedupeKey: 'editor-asset-backfill-start',
                dedupeWindowMs: 500
            });
            const [projectRecords, assetRecords] = await Promise.all([
                getAllLibraryProjectRecords(),
                getAllLibraryAssetRecords()
            ]);
            const nextAssets = [...assetRecords];
            let didChange = false;
            for (let index = 0; index < projectRecords.length; index += 1) {
                const projectRecord = projectRecords[index];
                if (getLibraryProjectType(projectRecord) !== 'studio') continue;
                const existingAsset = nextAssets.find((asset) => asset.sourceProjectId === projectRecord.id) || null;
                if (existingAsset) continue;
                const savedAsset = await upsertDerivedStudioAsset(projectRecord, {
                    existingAsset: null,
                    existingAssets: nextAssets
                });
                if (savedAsset) {
                    nextAssets.push(savedAsset);
                    didChange = true;
                }
                await maybeYieldToUi(index, 2);
            }
            derivedStudioAssetBackfillComplete = true;
            if (didChange) {
                notifyLibraryChanged();
                logProcess('success', 'library.assets', 'Editor-derived asset backfill completed with new assets.');
            } else {
                logProcess('info', 'library.assets', 'Editor-derived asset backfill found nothing new.', {
                    dedupeKey: 'editor-asset-backfill-noop',
                    dedupeWindowMs: 1200
                });
            }
        })().finally(() => {
            derivedStudioAssetBackfillPromise = null;
        });
        await derivedStudioAssetBackfillPromise;
    }

    async function ensureLibraryImageAssetPreviewsBackfilled(assetRecords = null) {
        if (imageAssetPreviewBackfillComplete) return;
        if (imageAssetPreviewBackfillPromise) {
            await imageAssetPreviewBackfillPromise;
            return;
        }
        imageAssetPreviewBackfillPromise = (async () => {
            logProcess('active', 'library.assets', 'Checking saved image assets for missing preview thumbnails.', {
                dedupeKey: 'image-preview-backfill-start',
                dedupeWindowMs: 500
            });
            const sourceAssets = Array.isArray(assetRecords)
                ? assetRecords.map((entry) => normalizeLibraryAssetRecord(entry)).filter(Boolean)
                : await getAllLibraryAssetRecords();
            let didChange = false;
            let updatedCount = 0;
            for (let index = 0; index < sourceAssets.length; index += 1) {
                const asset = sourceAssets[index];
                if (normalizeLibraryAssetType(asset.assetType) !== 'image') continue;
                if (!asset.dataUrl || asset.previewDataUrl) continue;
                const updatedAsset = await saveLibraryAssetRecord(asset, {
                    existingAsset: asset,
                    preserveTimestamp: true,
                    preserveExistingName: true,
                    preserveExistingTags: true
                });
                if (updatedAsset?.previewDataUrl && updatedAsset.previewDataUrl !== asset.previewDataUrl) {
                    didChange = true;
                    updatedCount += 1;
                }
                await maybeYieldToUi(index, 4);
            }
            imageAssetPreviewBackfillComplete = true;
            if (didChange) {
                notifyLibraryChanged();
                logProcess('success', 'library.assets', `Generated ${updatedCount} missing image preview thumbnail${updatedCount === 1 ? '' : 's'}.`);
            } else {
                logProcess('info', 'library.assets', 'Every saved image asset already had a preview thumbnail.', {
                    dedupeKey: 'image-preview-backfill-noop',
                    dedupeWindowMs: 1200
                });
            }
        })().finally(() => {
            imageAssetPreviewBackfillPromise = null;
        });
        await imageAssetPreviewBackfillPromise;
    }

    function scheduleLibraryImageAssetPreviewWarmup() {
        logProcess('info', 'app.bootstrap', 'Scheduled idle Library image preview warmup.', {
            dedupeKey: 'image-preview-warmup-scheduled',
            dedupeWindowMs: 2000
        });
        const run = () => {
            getAllLibraryAssetRecords()
                .then((assetRecords) => ensureLibraryImageAssetPreviewsBackfilled(assetRecords))
                .catch((error) => {
                    console.warn('Could not warm Library image previews.', error);
                    logProcess('warning', 'library.assets', error?.message || 'Could not warm Library image previews.');
                });
        };
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => {
                run();
            }, { timeout: 2400 });
            return;
        }
        setTimeout(run, 1200);
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

    function isLikelyImageFile(file) {
        const mimeType = String(file?.type || '').toLowerCase();
        if (mimeType.startsWith('image/')) return true;
        return /\.(png|apng|jpe?g|webp|gif|bmp|tiff?|avif|ico|svg)$/i.test(String(file?.name || ''));
    }

    async function createStitchInputsFromFilesFallback(files, options = {}) {
        const sourceFiles = (files || []).filter((file) => isLikelyImageFile(file));
        const inputs = [];
        const failures = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            const file = sourceFiles[index];
            try {
                options.onProgress?.({
                    index,
                    total: sourceFiles.length,
                    file,
                    message: `Reading "${file.name}" for Stitch.`,
                    progress: sourceFiles.length ? index / sourceFiles.length : 0
                });
                const imageData = await fileToDataUrl(file);
                options.onProgress?.({
                    index,
                    total: sourceFiles.length,
                    file,
                    message: `Decoding "${file.name}" for Stitch.`,
                    progress: sourceFiles.length ? (index + 0.45) / sourceFiles.length : 0.45
                });
                const image = await loadImageFromDataUrl(imageData);
                inputs.push({
                    id: createStitchInputId(),
                    name: file.name,
                    type: file.type,
                    imageData,
                    width: image.naturalWidth || image.width || 1,
                    height: image.naturalHeight || image.height || 1
                });
            } catch (error) {
                failures.push({
                    name: String(file?.name || 'Unnamed image'),
                    reason: error?.message || 'Could not read this image.'
                });
            }
            await maybeYieldToUi(index, 1);
        }
        return { inputs, failures };
    }

    async function createStitchInputsFromFiles(files, options = {}) {
        if (!backgroundTasks) {
            return createStitchInputsFromFilesFallback(files, options);
        }
        return backgroundTasks.runTask('stitch', 'prepare-input-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: 'stitch.workspace',
            onProgress(progress) {
                options.onProgress?.({
                    ...progress?.payload,
                    message: progress?.message,
                    progress: progress?.progress
                });
            }
        });
    }

    async function buildStitchPreviewMap(documentState) {
        const normalized = normalizeStitchDocument(documentState);
        if (!normalized.candidates.length) return {};
        return stitchEngine.buildCandidatePreviewMap(normalized);
    }

    async function createThreeDModelItemsFromFilesFallback(files, options = {}) {
        const sourceFiles = (files || []).filter((file) => {
            const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
            return extension === 'glb' || extension === 'gltf';
        });
        const items = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            const file = sourceFiles[index];
            const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
            options.onProgress?.({
                index,
                total: sourceFiles.length,
                file,
                message: `Reading model "${file.name}".`,
                progress: sourceFiles.length ? index / sourceFiles.length : 0
            });
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
            await maybeYieldToUi(index, 1);
        }
        return items;
    }

    async function createThreeDModelItemsFromFiles(files, options = {}) {
        if (!backgroundTasks) {
            return createThreeDModelItemsFromFilesFallback(files, options);
        }
        const result = await backgroundTasks.runTask('three', 'prepare-model-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            onProgress(progress) {
                options.onProgress?.({
                    ...progress?.payload,
                    message: progress?.message,
                    progress: progress?.progress
                });
            }
        });
        return result?.items || [];
    }

    async function createThreeDImagePlaneItemsFromFilesFallback(files, options = {}) {
        const sourceFiles = (files || []).filter((file) => String(file?.type || '').startsWith('image/'));
        const items = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            const file = sourceFiles[index];
            options.onProgress?.({
                index,
                total: sourceFiles.length,
                file,
                message: `Reading image plane "${file.name}".`,
                progress: sourceFiles.length ? index / sourceFiles.length : 0
            });
            const dataUrl = await fileToDataUrl(file);
            options.onProgress?.({
                index,
                total: sourceFiles.length,
                file,
                message: `Decoding image plane "${file.name}".`,
                progress: sourceFiles.length ? (index + 0.45) / sourceFiles.length : 0.45
            });
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
            await maybeYieldToUi(index, 1);
        }
        return items;
    }

    async function createThreeDImagePlaneItemsFromFiles(files, options = {}) {
        if (!backgroundTasks) {
            return createThreeDImagePlaneItemsFromFilesFallback(files, options);
        }
        const result = await backgroundTasks.runTask('three', 'prepare-image-plane-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            onProgress(progress) {
                options.onProgress?.({
                    ...progress?.payload,
                    message: progress?.message,
                    progress: progress?.progress
                });
            }
        });
        return (result?.items || []).map((item) => ({
            ...item,
            material: createDefaultThreeDMaterial({
                roughness: 1
            })
        }));
    }

    function createThreeDItemFromLibraryAsset(assetRecord, view = {}) {
        const normalizedAsset = normalizeLibraryAssetRecord(assetRecord);
        if (!normalizedAsset?.dataUrl) return null;
        const spawn = getThreeDCanvasSpawn(view);
        if (normalizedAsset.assetType === 'model') {
            return {
                id: createThreeDSceneItemId('model'),
                kind: 'model',
                name: normalizedAsset.name || 'Model',
                visible: true,
                locked: false,
                position: [...spawn.position],
                rotation: [...spawn.rotation],
                scale: [1, 1, 1],
                asset: {
                    format: normalizedAsset.format || 'glb',
                    name: normalizedAsset.name || 'Model',
                    mimeType: normalizedAsset.mimeType || '',
                    dataUrl: normalizedAsset.dataUrl
                }
            };
        }
        return {
            id: createThreeDSceneItemId('image-plane'),
            kind: 'image-plane',
            name: normalizedAsset.name || 'Image Plane',
            visible: true,
            locked: false,
            position: [...spawn.position],
            rotation: [...spawn.rotation],
            scale: [1, 1, 1],
            asset: {
                format: 'image',
                name: normalizedAsset.name || 'Image Plane',
                mimeType: normalizedAsset.mimeType || '',
                dataUrl: normalizedAsset.dataUrl,
                width: Math.max(1, Number(normalizedAsset.width || 1)),
                height: Math.max(1, Number(normalizedAsset.height || 1))
            },
            material: createDefaultThreeDMaterial({
                roughness: 1
            })
        };
    }

    async function createThreeDFontAssetsFromFilesFallback(files, options = {}) {
        const sourceFiles = (files || []).filter((file) => ['ttf', 'otf', 'woff', 'woff2'].includes(getThreeDFileExtension(file?.name)));
        const assets = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            const file = sourceFiles[index];
            const extension = getThreeDFileExtension(file?.name);
            options.onProgress?.({
                index,
                total: sourceFiles.length,
                file,
                message: `Reading font "${file.name}".`,
                progress: sourceFiles.length ? index / sourceFiles.length : 0
            });
            const assetDataUrl = await fileToDataUrl(file);
            assets.push({
                id: createThreeDAssetId('font'),
                name: stripProjectExtension(file.name) || 'Font',
                format: extension,
                mimeType: file.type || '',
                dataUrl: assetDataUrl
            });
            await maybeYieldToUi(index, 1);
        }
        return assets;
    }

    async function createThreeDFontAssetsFromFiles(files, options = {}) {
        if (!backgroundTasks) {
            return createThreeDFontAssetsFromFilesFallback(files, options);
        }
        const result = await backgroundTasks.runTask('three', 'prepare-font-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            onProgress(progress) {
                options.onProgress?.({
                    ...progress?.payload,
                    message: progress?.message,
                    progress: progress?.progress
                });
            }
        });
        return result?.assets || [];
    }

    async function createThreeDHdriAssetFromFileFallback(file, options = {}) {
        if (!file) return null;
        const extension = getThreeDFileExtension(file?.name);
        if (extension !== 'hdr') return null;
        options.onProgress?.({
            index: 0,
            total: 1,
            file,
            message: `Reading HDRI "${file.name}".`,
            progress: 0.2
        });
        const assetDataUrl = await fileToDataUrl(file);
        return {
            id: createThreeDAssetId('hdri'),
            name: stripProjectExtension(file.name) || 'HDRI',
            format: extension,
            mimeType: file.type || '',
            dataUrl: assetDataUrl
        };
    }

    async function createThreeDHdriAssetFromFile(file, options = {}) {
        if (!backgroundTasks) {
            return createThreeDHdriAssetFromFileFallback(file, options);
        }
        const result = await backgroundTasks.runTask('three', 'prepare-hdri-file', {
            file: file || null
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            onProgress(progress) {
                options.onProgress?.({
                    ...progress?.payload,
                    message: progress?.message,
                    progress: progress?.progress
                });
            }
        });
        return result?.asset || null;
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
            logProcess('success', 'stitch.workspace', 'Started a new Stitch project.');
            setNotice('Started a new stitch project.', 'success');
        },
        openStitchPicker() {
            view?.openStitchPicker?.();
        },
        async openStitchImages(files) {
            const totalFiles = (files || []).filter((file) => isLikelyImageFile(file)).length;
            logProcess('active', 'stitch.workspace', `Importing ${totalFiles || files.length} image${(totalFiles || files.length) === 1 ? '' : 's'} into Stitch.`);
            await showWorkspaceProgress('stitch', {
                title: 'Importing Images',
                message: totalFiles
                    ? `Reading 1 of ${totalFiles} selected image${totalFiles === 1 ? '' : 's'}...`
                    : 'Preparing selected Stitch images...',
                progress: 0.08
            });
            const { inputs: nextInputs, failures } = await createStitchInputsFromFiles(files, {
                onProgress: ({ index, total, file, message, progress }) => {
                    const ratio = total
                        ? Math.min(0.8, 0.12 + (((index + 0.55) / total) * 0.64))
                        : Math.min(0.8, 0.16 + ((Number(progress) || 0) * 0.5));
                    setStitchProgress({
                        active: true,
                        title: 'Importing Images',
                        message: message || `Reading "${file?.name || 'image'}"...`,
                        progress: ratio
                    });
                    logProgressProcess('stitch.workspace', message || `Reading "${file?.name || 'image'}"...`, ratio, {
                        dedupeKey: `stitch-import:${file?.name || index}:${Math.round(ratio * 1000)}`,
                        dedupeWindowMs: 80
                    });
                }
            });
            if (!nextInputs.length) {
                clearWorkspaceProgress('stitch');
                logProcess('warning', 'stitch.workspace', failures.length
                    ? `Could not add any Stitch inputs. ${failures.length} file${failures.length === 1 ? '' : 's'} failed to load.`
                    : 'Stitch image import was opened without any readable files.');
                if (failures.length) {
                    setNotice(
                        `None of the selected files could be added to Stitch. ${failures.length} image${failures.length === 1 ? '' : 's'} failed to load.`,
                        'error',
                        7000
                    );
                } else {
                    setNotice('Choose one or more images to add to the Stitch workspace.', 'warning');
                }
                return;
            }
            stitchAnalysisToken += 1;
            setStitchProgress({
                active: true,
                title: 'Importing Images',
                message: `Finalizing ${nextInputs.length} Stitch input${nextInputs.length === 1 ? '' : 's'}...`,
                progress: 0.9
            });
            updateStitchDocument((document) => appendStitchInputs(document, nextInputs), { renderStitch: true });
            commitActiveSection('stitch');
            clearWorkspaceProgress('stitch');
            logProcess(failures.length ? 'warning' : 'success', 'stitch.workspace', failures.length
                ? `Added ${nextInputs.length} Stitch input${nextInputs.length === 1 ? '' : 's'} and skipped ${failures.length} unreadable file${failures.length === 1 ? '' : 's'}.`
                : `Added ${nextInputs.length} Stitch input${nextInputs.length === 1 ? '' : 's'}.`);
            setNotice(
                failures.length
                    ? `Added ${nextInputs.length} image${nextInputs.length === 1 ? '' : 's'} to Stitch. Skipped ${failures.length} file${failures.length === 1 ? '' : 's'} that could not be read.`
                    : `Added ${nextInputs.length} image${nextInputs.length === 1 ? '' : 's'} to Stitch.`,
                failures.length ? 'warning' : 'success',
                failures.length ? 7000 : 4200
            );
        },
        async runStitchAnalysis() {
            const snapshot = normalizeStitchDocument(store.getState().stitchDocument);
            if (snapshot.inputs.length < 2) {
                clearWorkspaceProgress('stitch');
                logProcess('warning', 'stitch.analysis', 'Blocked Stitch analysis because fewer than two input images are loaded.');
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
            await showWorkspaceProgress('stitch', {
                title: 'Running Analysis',
                message: `Preparing Stitch analysis for ${snapshot.inputs.length} image${snapshot.inputs.length === 1 ? '' : 's'}...`,
                progress: 0.06
            });
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
            logProcess('active', 'stitch.analysis', `Running Stitch analysis on ${snapshot.inputs.length} input image${snapshot.inputs.length === 1 ? '' : 's'}.`);
            setNotice('Running stitch analysis...', 'info', 0);

            try {
                let lastProgressMessage = '';
                let lastProgressRatio = 0.12;
                const result = await stitchEngine.analyze(snapshot, {
                    onProgress(progress) {
                        if (token !== stitchAnalysisToken) return;
                        const label = String(progress?.label || '').trim();
                        const detail = String(progress?.detail || '').trim();
                        const message = [label, detail].filter(Boolean).join(' ');
                        if (!message || message === lastProgressMessage) return;
                        lastProgressMessage = message;
                        const completed = Number(progress?.completed);
                        const total = Number(progress?.total);
                        const ratio = Number.isFinite(completed) && Number.isFinite(total) && total > 0
                            ? Math.max(lastProgressRatio, Math.min(0.82, 0.16 + ((completed / total) * 0.52)))
                            : Math.min(0.82, lastProgressRatio + 0.04);
                        lastProgressRatio = ratio;
                        console.info('[Stitch]', progress);
                        logProgressProcess('stitch.analysis', message, ratio, {
                            dedupeKey: `stitch-progress:${message}:${Math.round(ratio * 1000)}`,
                            dedupeWindowMs: 120
                        });
                        setStitchProgress({
                            active: true,
                            title: 'Running Analysis',
                            message,
                            progress: ratio
                        });
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
                setStitchProgress({
                    active: true,
                    title: 'Running Analysis',
                    message: 'Rendering candidate previews for the gallery...',
                    progress: 0.9
                });
                logProcess('info', 'stitch.analysis', 'Rendering candidate previews for the gallery.', {
                    dedupeKey: `stitch-preview-build:${token}`,
                    dedupeWindowMs: 80
                });
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
                    clearWorkspaceProgress('stitch');
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
                clearWorkspaceProgress('stitch');
                logProcess(result.warning ? 'warning' : 'success', 'stitch.analysis', result.warning || 'Stitch analysis completed and candidates are ready.');
                setNotice(result.warning || 'Stitch analysis is ready.', result.warning ? 'warning' : 'success');
            } catch (error) {
                if (token !== stitchAnalysisToken) return;
                clearWorkspaceProgress('stitch');
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
                logProcess('error', 'stitch.analysis', error?.message || 'The stitch analysis failed.');
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
        setStitchSidebarView(sidebarView) {
            const nextView = String(sidebarView || '').toLowerCase();
            if (!nextView) return;
            updateStitchDocument((document) => ({
                ...document,
                workspace: {
                    ...document.workspace,
                    sidebarView: nextView
                }
            }), { renderStitch: false, skipViewRender: true });
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
                logProcess('warning', 'stitch.workspace', 'Blocked Stitch PNG export because the workspace has no inputs.');
                setNotice('Add images to the Stitch workspace before exporting.', 'warning');
                return;
            }
            await showWorkspaceProgress('stitch', {
                title: 'Exporting PNG',
                message: 'Rendering the stitched composite to PNG...',
                progress: 0.16
            });
            logProcess('active', 'stitch.workspace', 'Rendering the stitched composite to PNG.');
            try {
                const blob = await stitchEngine.exportPngBlob(documentState);
                const baseName = getSuggestedStitchProjectName(documentState).replace(/\.[^/.]+$/, '') || 'stitch-project';
                setStitchProgress({
                    active: true,
                    title: 'Exporting PNG',
                    message: `Writing "${baseName}-stitched.png"...`,
                    progress: 0.9
                });
                downloadBlob(blob, `${baseName}-stitched.png`);
                clearWorkspaceProgress('stitch');
                logProcess('success', 'stitch.workspace', `Exported Stitch PNG "${baseName}-stitched.png".`);
                setNotice('Stitch PNG export complete.', 'success');
            } catch (error) {
                clearWorkspaceProgress('stitch');
                logProcess('error', 'stitch.workspace', error?.message || 'Could not export the Stitch PNG.');
                setNotice(error?.message || 'Could not export the Stitch PNG.', 'error', 7000);
            }
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
            const suppressWorkspaceOverlay = !!options.suppressWorkspaceOverlay;
            const state = store.getState();
            const projectType = options.projectType || getProjectTypeForSection(state.ui.activeSection);
            if (projectType === '3d' && isThreeDRenderJobActive()) {
                logProcess('warning', 'library.projects', 'Blocked Library save because a 3D render is still active.');
                setNotice('Abort the active 3D render before saving this scene to the Library.', 'warning', 6000);
                return null;
            }
            const adapter = projectAdapters?.getAdapter(projectType);
            if (!adapter) {
                logProcess('error', 'library.projects', `No Library project adapter is available for "${projectType}".`);
                setNotice('This project type cannot be saved to the Library yet.', 'error', 7000);
                return null;
            }
            const currentDocument = adapter.getCurrentDocument(state);
            if (adapter.isEmpty(currentDocument) || !adapter.canSave(currentDocument)) {
                logProcess('warning', 'library.projects', adapter.emptyNotice || `Blocked ${adapter.label} save because the project is empty.`);
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
                logProcess('info', 'library.projects', wasActiveMatch
                    ? `Skipped save because the current ${adapter.label} project already matches "${reusableMatch.name}".`
                    : `Reused existing Library entry "${reusableMatch.name}" for the current ${adapter.label} project.`);
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
                        logProcess('info', 'library.projects', `Skipped save because "${defaultName}" already matches the current ${adapter.label} project.`);
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
                if (!suppressWorkspaceOverlay) {
                    await showWorkspaceProgress(projectType, {
                        title: 'Saving To Library',
                        message: `Preparing "${name}" for the Library...`,
                        progress: 0.08
                    });
                }
                logProcess('active', 'library.projects', `Saving ${adapter.label} project "${name}" to the Library...`);
                setNotice('Saving to Library...', 'info', 0);
                logProcess('info', 'library.projects', `Capturing ${adapter.label} project data for "${name}".`, {
                    dedupeKey: `library-save-capture:${projectType}:${name}`,
                    dedupeWindowMs: 120
                });
                const existingRecord = saveId ? await getFromLibraryDB(saveId).catch(() => null) : null;
                const capture = await adapter.captureDocument(currentDocument, payloadParams);
                if (!suppressWorkspaceOverlay) {
                    setWorkspaceProgress(projectType, {
                        active: true,
                        title: 'Saving To Library',
                        message: `Writing "${name}" into the Library...`,
                        progress: 0.58
                    });
                }
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
                if (projectType === 'studio') {
                    logProcess('info', 'library.projects', `Updating the Editor-derived asset for "${name}".`, {
                        dedupeKey: `library-save-derived-asset:${saveId || name}`,
                        dedupeWindowMs: 120
                    });
                    if (!suppressWorkspaceOverlay) {
                        setWorkspaceProgress(projectType, {
                            active: true,
                            title: 'Saving To Library',
                            message: `Updating the linked asset for "${name}"...`,
                            progress: 0.76
                        });
                    }
                    await upsertDerivedStudioAsset(projectData);
                }
                if (!suppressWorkspaceOverlay) {
                    setWorkspaceProgress(projectType, {
                        active: true,
                        title: 'Saving To Library',
                        message: `Finishing the Library entry for "${name}"...`,
                        progress: 0.92
                    });
                }
                await registerLibraryTags(projectData.tags);
                setActiveLibraryOrigin(projectType, saveId, name);
                logProcess('success', 'library.projects', `Saved "${name}" to the Library as a ${adapter.label} project.`);
                setNotice(`Saved "${name}" to Library.`, 'success');
                notifyLibraryChanged();
                clearWorkspaceProgress(projectType);
                return projectData;
            } catch (error) {
                console.error(error);
                clearWorkspaceProgress(projectType);
                logProcess('error', 'library.projects', error?.message || `Could not save the ${adapter.label} project to the Library.`);
                setNotice(error?.message || 'Could not save that project to the Library.', 'error', 7000);
                return null;
            }
        },
        async getLibraryProjects() {
            try {
                await ensureStudioProjectPayloadPreviewsBackfilled();
                return (await getAllFromLibraryDB())
                    .filter((entry) => isLibraryProjectRecord(entry))
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
        async getLibraryAssets() {
            try {
                await ensureDerivedStudioAssetsBackfilled();
                const assets = await getAllLibraryAssetRecords();
                ensureLibraryImageAssetPreviewsBackfilled(assets).catch((error) => {
                    console.warn('Could not backfill Library image previews.', error);
                });
                return assets;
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
            if (!existing || !isLibraryProjectRecord(existing)) return null;
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
                if (!existing || !isLibraryProjectRecord(existing)) continue;
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
                if (!existing || !isLibraryProjectRecord(existing)) continue;
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
            await deleteDerivedStudioAssetsByProjectIds([id]);
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
            await deleteDerivedStudioAssetsByProjectIds(targetIds);
            notifyLibraryChanged();
        },
        async clearLibraryProjects() {
            const entries = await getAllFromLibraryDB();
            const clearedProjectIds = [];
            for (const entry of entries) {
                if (!isLibraryProjectRecord(entry)) continue;
                clearedProjectIds.push(entry.id);
                await deleteFromLibraryDB(entry.id);
            }
            await deleteDerivedStudioAssetsByProjectIds(clearedProjectIds);
            clearActiveLibraryOrigin();
            notifyLibraryChanged();
        },
        async renameLibraryAsset(id, name) {
            const trimmedName = String(name || '').trim();
            if (!id || !trimmedName) return null;
            const existing = await getFromLibraryDB(id);
            if (!existing || !isLibraryAssetRecord(existing)) return null;
            const updated = {
                ...existing,
                name: trimmedName
            };
            await saveToLibraryDB(updated);
            notifyLibraryChanged();
            return normalizeLibraryAssetRecord(updated);
        },
        async updateLibraryAssetTags(id, tags) {
            if (!id) return null;
            const existing = await getFromLibraryDB(id);
            if (!existing || !isLibraryAssetRecord(existing)) return null;
            const updated = {
                ...existing,
                tags: normalizeLibraryTags(tags)
            };
            await saveToLibraryDB(updated);
            await registerLibraryTags(updated.tags);
            notifyLibraryChanged();
            return normalizeLibraryAssetRecord(updated);
        },
        async applyLibraryTagsToAssets(ids, tags) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            const nextTags = normalizeLibraryTags(tags);
            if (!targetIds.length || !nextTags.length) return [];

            await registerLibraryTags(nextTags);
            const updatedAssets = [];
            for (const id of targetIds) {
                const existing = await getFromLibraryDB(id);
                if (!existing || !isLibraryAssetRecord(existing)) continue;
                const updated = {
                    ...existing,
                    tags: normalizeLibraryTags([...(existing.tags || []), ...nextTags])
                };
                await saveToLibraryDB(updated);
                updatedAssets.push(normalizeLibraryAssetRecord(updated));
            }
            notifyLibraryChanged();
            return updatedAssets;
        },
        async removeLibraryTagFromAssets(ids, tag) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            const removeKey = String(tag || '').trim().toLowerCase();
            if (!targetIds.length || !removeKey) return [];

            const updatedAssets = [];
            for (const id of targetIds) {
                const existing = await getFromLibraryDB(id);
                if (!existing || !isLibraryAssetRecord(existing)) continue;
                const updated = {
                    ...existing,
                    tags: normalizeLibraryTags((existing.tags || []).filter((entry) => String(entry || '').trim().toLowerCase() !== removeKey))
                };
                await saveToLibraryDB(updated);
                updatedAssets.push(normalizeLibraryAssetRecord(updated));
            }
            notifyLibraryChanged();
            return updatedAssets;
        },
        async deleteLibraryAsset(id) {
            if (!id) return;
            await deleteFromLibraryDB(id);
            notifyLibraryChanged();
        },
        async deleteLibraryAssets(ids) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            if (!targetIds.length) return;
            for (const id of targetIds) {
                await deleteFromLibraryDB(id);
            }
            notifyLibraryChanged();
        },
        async clearLibraryAssets() {
            const entries = await getAllFromLibraryDB();
            for (const entry of entries) {
                if (!isLibraryAssetRecord(entry)) continue;
                await deleteFromLibraryDB(entry.id);
            }
            notifyLibraryChanged();
        },
        async importLibraryAssets(assetEntries = []) {
            const existingAssets = await getAllLibraryAssetRecords();
            const nextAssets = [...existingAssets];
            const importedAssets = [];
            if (assetEntries.length) {
                logProcess('active', 'library.import', `Importing ${assetEntries.length} asset${assetEntries.length === 1 ? '' : 's'} into the Assets Library.`);
            }
            for (let index = 0; index < (assetEntries || []).length; index += 1) {
                const entry = assetEntries[index];
                const normalizedType = normalizeLibraryAssetType(entry.assetType || entry.type || 'image');
                const dataUrl = String(entry.dataUrl || '');
                if (!dataUrl) continue;
                const fingerprint = entry.assetFingerprint || await computeLibraryAssetFingerprintInBackground({
                    assetType: normalizedType,
                    format: entry.format,
                    mimeType: entry.mimeType,
                    dataUrl
                });
                if (
                    nextAssets.some((asset) => asset.assetFingerprint === fingerprint)
                    || (entry.sourceProjectId && nextAssets.some((asset) => asset.sourceProjectId === String(entry.sourceProjectId)))
                ) {
                    continue;
                }
                const savedAsset = await saveLibraryAssetRecord({
                    name: entry.name,
                    assetType: normalizedType,
                    format: entry.format,
                    mimeType: entry.mimeType,
                    dataUrl,
                    previewDataUrl: entry.previewDataUrl || '',
                    tags: normalizeLibraryTags(entry.tags || []),
                    width: Number(entry.width || 0),
                    height: Number(entry.height || 0),
                    timestamp: entry.timestamp || Date.now(),
                    sourceProjectId: entry.sourceProjectId || null,
                    sourceProjectType: entry.sourceProjectType || null,
                    sourceProjectName: entry.sourceProjectName || null,
                    origin: entry.origin || 'import',
                    assetFingerprint: fingerprint
                });
                nextAssets.push(savedAsset);
                importedAssets.push(savedAsset);
                await maybeYieldToUi(index, 2);
            }
            notifyLibraryChanged();
            if (assetEntries.length) {
                logProcess('success', 'library.import', importedAssets.length
                    ? `Imported ${importedAssets.length} new asset${importedAssets.length === 1 ? '' : 's'} into the Assets Library.`
                    : 'Asset import completed without adding duplicates.');
            }
            return importedAssets;
        },
        async loadLibraryProject(payload, libraryId = null, libraryName = null) {
            try {
                const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
                const rawState = normalizeLegacyDocumentPayload(JSON.parse(payloadStr));
                const projectMeta = extractLibraryProjectMeta(rawState);
                const adapter = projectAdapters?.getAdapterForPayload(rawState, projectMeta.projectType);
                if (!adapter) throw new Error('This Library project type is not supported in the current build.');
                logProcess('active', 'library.projects', `Loading "${libraryName || 'Library project'}" into ${adapter.label}.`);
                if (!await ensureProjectCanBeReplaced(adapter.type, `loading "${libraryName || 'this Library project'}"`)) return false;
                return await adapter.restorePayload(rawState, libraryId, libraryName);
            } catch (error) {
                console.error(error);
                logProcess('error', 'library.projects', error?.message || 'Failed to load a project from the Library.');
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
            logProcess('success', 'editor.files', 'Started a new Editor project.');
            setNotice('Started a new project.', 'success');
        },
        async openImageFile(file) {
            if (!file) return;
            if (!await ensureProjectCanBeReplaced('studio', 'loading a new image')) return;
            try {
                await showWorkspaceProgress('studio', {
                    title: 'Loading Image',
                    message: `Reading "${file.name}"...`,
                    progress: 0.08
                });
                logProcess('active', 'editor.files', `Loading image "${file.name}" into the Editor.`);
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                logProcess('info', 'editor.files', `Reading file bytes for "${file.name}".`, {
                    dedupeKey: `editor-load-image-read:${file.name}`,
                    dedupeWindowMs: 120
                });
                const dataUrl = await fileToDataUrl(file);
                setEditorProgress({
                    active: true,
                    title: 'Loading Image',
                    message: `Decoding "${file.name}" and building the Editor source...`,
                    progress: 0.42
                });
                await syncImageSource(file, dataUrl);
                updateDocument((document) => ({
                    ...document,
                    view: { ...document.view, zoom: 1 },
                    workspace: { ...document.workspace, batchOpen: false },
                    batch: createEmptyBatchState()
                }), { render: false });

                clearActiveLibraryOrigin('studio');
                engine.requestRender(store.getState().document);
                setEditorProgress({
                    active: true,
                    title: 'Loading Image',
                    message: `Saving "${file.name}" into the Library for quick recall...`,
                    progress: 0.82
                });
                await actions.saveProjectToLibrary(stripProjectExtension(file.name), {
                    preferExisting: true,
                    projectType: 'studio',
                    suppressWorkspaceOverlay: true
                });

                logProcess('success', 'editor.files', `Loaded image "${file.name}" into the Editor.`);
                setNotice(`Loaded ${file.name}.`, 'success');
                clearWorkspaceProgress('studio');
            } catch (error) {
                clearWorkspaceProgress('studio');
                logProcess('error', 'editor.files', error?.message || `Could not load image "${file.name}".`);
                setNotice(`Could not load image: ${error.message}`, 'error', 6000);
            }
        },
        async openStateFile(file) {
            if (!file) return;
            if (!await ensureProjectCanBeReplaced('studio', 'loading a state file')) return;
            try {
                await showWorkspaceProgress('studio', {
                    title: 'Loading State',
                    message: `Reading "${file.name}"...`,
                    progress: 0.08
                });
                logProcess('active', 'editor.files', `Loading state file "${file.name}".`);
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                logProcess('info', 'editor.files', `Parsing state file "${file.name}".`, {
                    dedupeKey: `editor-state-parse:${file.name}`,
                    dedupeWindowMs: 120
                });
                const parsedState = backgroundTasks
                    ? await backgroundTasks.runTask('editor', 'read-studio-state-file', {
                        file
                    }, {
                        priority: 'user-visible',
                        processId: 'editor.files'
                    })
                    : await readStudioStateFileFallback(file);
                const payload = parsedState.payload;
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
                const payloadWithoutPreview = stripStudioPreview(payload);
                const preservedSource = state.document.source;
                store.setState((current) => ({
                    ...current,
                    document: {
                        ...current.document,
                        ...payloadWithoutPreview,
                        version: 'mns/v2',
                        kind: 'document',
                        mode: 'studio',
                        workspace: normalizeWorkspace('studio', payloadWithoutPreview.workspace || current.document.workspace, !!selection.layerInstanceId),
                        source: preservedSource,
                        palette: payloadWithoutPreview.palette || current.document.palette,
                        layerStack,
                        selection,
                        view: normalizeViewState({ ...current.document.view, ...(payloadWithoutPreview.view || {}) }),
                        export: { ...current.document.export, ...(payloadWithoutPreview.export || {}) },
                        batch: createEmptyBatchState()
                    }
                }), { render: engine.hasImage() && !(shouldLoadImage && embeddedSource) });
                clearActiveLibraryOrigin('studio');

                if (shouldLoadImage && embeddedSource) {
                    try {
                        setEditorProgress({
                            active: true,
                            title: 'Loading State',
                            message: `Restoring the embedded source image from "${file.name}"...`,
                            progress: 0.54
                        });
                        logProcess('info', 'editor.files', `Restoring the embedded source image from "${file.name}".`, {
                            dedupeKey: `editor-state-embedded-source:${file.name}`,
                            dedupeWindowMs: 120
                        });
                        const image = await loadImageFromDataUrl(embeddedSource.imageData);
                        await engine.loadImage(image, embeddedSource);
                        updateDocument((document) => ({ ...document, source: embeddedSource }), { render: false });
                        engine.requestRender(store.getState().document);
                        setEditorProgress({
                            active: true,
                            title: 'Loading State',
                            message: `Saving "${file.name}" into the Library...`,
                            progress: 0.84
                        });
                        await actions.saveProjectToLibrary(stripProjectExtension(file.name), {
                            preferExisting: true,
                            projectType: 'studio',
                            suppressWorkspaceOverlay: true
                        });
                        logProcess(droppedLayerCount ? 'warning' : 'success', 'editor.files', droppedLayerCount
                            ? `Loaded state file "${file.name}" and dropped ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                            : `Loaded state file "${file.name}" with its embedded image.`);
                        setNotice(
                            droppedLayerCount
                                ? `State loaded: ${file.name}. Removed ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                                : `State loaded: ${file.name}`,
                            droppedLayerCount ? 'warning' : 'success'
                        );
                        clearWorkspaceProgress('studio');
                    } catch (error) {
                        clearWorkspaceProgress('studio');
                        logProcess('warning', 'editor.files', `Loaded state file "${file.name}", but the embedded image could not be restored: ${error.message}`);
                        setNotice(`State loaded, but the embedded image could not be restored: ${error.message}`, 'warning', 7000);
                    }
                    return;
                }

                if (shouldLoadImage && !embeddedSource) {
                    clearWorkspaceProgress('studio');
                    logProcess('warning', 'editor.files', `Loaded state file "${file.name}", but it did not include an embedded image.`);
                    setNotice('State loaded, but the file did not contain an embedded image.', 'warning', 7000);
                    return;
                }

                clearWorkspaceProgress('studio');
                logProcess(droppedLayerCount ? 'warning' : 'success', 'editor.files', droppedLayerCount
                    ? `Loaded state file "${file.name}" and dropped ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                    : `Loaded state file "${file.name}".`);
                setNotice(
                    droppedLayerCount
                        ? `State loaded: ${file.name}. Removed ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                        : `State loaded: ${file.name}`,
                    droppedLayerCount ? 'warning' : 'success'
                );
            } catch (error) {
                clearWorkspaceProgress('studio');
                logProcess('error', 'editor.files', error?.message || `Could not load state file "${file?.name || 'document'}".`);
                setNotice(error.message, 'error', 7000);
            }
        },
        async saveState() {
            const state = store.getState();
            let preview = null;
            await showWorkspaceProgress('studio', {
                title: 'Saving State',
                message: 'Preparing the Editor state JSON...',
                progress: 0.1
            });
            if (state.document.source?.imageData && engine.hasImage()) {
                try {
                    logProcess('active', 'editor.export', 'Capturing the current Editor render for state JSON save.');
                    setEditorProgress({
                        active: true,
                        title: 'Saving State',
                        message: 'Capturing the latest rendered preview for the state file...',
                        progress: 0.46
                    });
                    ({ preview } = await captureStudioDocumentSnapshot(engine, state.document));
                } catch (error) {
                    console.error(error);
                    clearWorkspaceProgress('studio');
                    logProcess('error', 'editor.export', error?.message || 'Could not capture the current Editor render for state JSON save.');
                    setNotice(error?.message || 'Could not save the current state JSON.', 'error', 7000);
                    return;
                }
            }

            setEditorProgress({
                active: true,
                title: 'Saving State',
                message: 'Writing the self-contained state JSON...',
                progress: 0.88
            });
            downloadState(state.document, {
                includeSource: true,
                preview
            });

            if (!state.document.source?.imageData) {
                clearWorkspaceProgress('studio');
                logProcess('warning', 'editor.export', 'Saved state JSON without an embeddable source image or rendered preview.');
                setNotice('State saved, but no embeddable source image was available.', 'warning', 7000);
                return;
            }
            if (!preview) {
                clearWorkspaceProgress('studio');
                logProcess('warning', 'editor.export', 'Saved state JSON without a captured rendered preview.');
                setNotice('State saved, but the current rendered preview could not be embedded.', 'warning', 7000);
                return;
            }
            clearWorkspaceProgress('studio');
            logProcess('success', 'editor.export', 'Saved self-contained state JSON from the Editor.');
            setNotice('State saved.', 'success');
        },
        setLoadImageOnOpen(value) {
            store.setState((state) => ({ ...state, ui: { ...state.ui, loadImageOnOpen: value } }), { render: false });
        },
        setSaveToLibrary(value) {
            store.setState((state) => ({ ...state, ui: { ...state.ui, saveToLibrary: value } }), { render: false });
        },
        async exportCurrent() {
            if (!engine.hasImage()) return setNotice('Load an image before exporting.', 'warning');
            const state = store.getState();
            await showWorkspaceProgress('studio', {
                title: 'Exporting PNG',
                message: 'Rendering the current Editor image to PNG...',
                progress: 0.16
            });
            logProcess('active', 'editor.export', 'Rendering the current Editor image to PNG.');
            try {
                const blob = await engine.exportPngBlob(state.document);
                const baseName = (state.document.source.name || 'noise-studio').replace(/\.[^/.]+$/, '');
                setEditorProgress({
                    active: true,
                    title: 'Exporting PNG',
                    message: `Writing "${baseName}-processed.png"...`,
                    progress: 0.9
                });
                downloadBlob(blob, `${baseName}-processed.png`);
                clearWorkspaceProgress('studio');
                logProcess('success', 'editor.export', `Exported PNG "${baseName}-processed.png" from the Editor.`);
                setNotice('PNG export complete.', 'success');
            } catch (error) {
                clearWorkspaceProgress('studio');
                logProcess('error', 'editor.export', error?.message || 'Could not export the current Editor PNG.');
                setNotice(error?.message || 'Could not export the current Editor PNG.', 'error', 7000);
            }
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
                logProcess('active', 'editor.files', 'Scanning a folder for batch processing images.');
                const dirHandle = await window.showDirectoryPicker();
                await showWorkspaceProgress('studio', {
                    title: 'Scanning Folder',
                    message: `Reading "${dirHandle.name}" for batch images...`,
                    progress: 0.08
                });
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
                        if (allFiles.length % 8 === 0) {
                            logProgressProcess('editor.files', `Indexed ${allFiles.length} file${allFiles.length === 1 ? '' : 's'} in "${dirHandle.name}".`, 0.42, {
                                dedupeKey: `editor-batch-scan:${dirHandle.name}:${allFiles.length}`,
                                dedupeWindowMs: 120
                            });
                            setEditorProgress({
                                active: true,
                                title: 'Scanning Folder',
                                message: `Indexed ${allFiles.length} file${allFiles.length === 1 ? '' : 's'} in "${dirHandle.name}".`,
                                progress: 0.42
                            });
                            await nextPaint();
                        }
                    }
                }
                await scan(dirHandle);
                imageFiles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
                if (!imageFiles.length) {
                    clearWorkspaceProgress('studio');
                    return setNotice('The selected folder does not contain any images.', 'warning');
                }
                stopPlayback();
                updateDocument((document) => ({
                    ...document,
                    workspace: { ...document.workspace, batchOpen: true },
                    batch: { ...document.batch, imageFiles, allFiles, currentIndex: 0, isPlaying: false, actualFps: 0 }
                }), { render: false });
                setEditorProgress({
                    active: true,
                    title: 'Scanning Folder',
                    message: `Loading the first batch image from "${dirHandle.name}"...`,
                    progress: 0.82
                });
                await loadBatchImage(imageFiles[0], 0);
                clearWorkspaceProgress('studio');
                logProcess('success', 'editor.files', `Loaded ${imageFiles.length} image${imageFiles.length === 1 ? '' : 's'} for batch processing from "${dirHandle.name}".`);
                setNotice(`Loaded ${imageFiles.length} images for batch processing.`, 'success');
            } catch (error) {
                clearWorkspaceProgress('studio');
                if (error?.name !== 'AbortError') {
                    logProcess('error', 'editor.files', 'Could not open the selected batch folder.');
                }
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
            logProcess('active', 'library.import', `Rendering ${payloadsText.length} imported project payload${payloadsText.length === 1 ? '' : 's'} into the Library database.`);
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

                    logProcess('info', 'library.import', `Preparing ${filenames[i] || `item ${i + 1}`} as a ${adapter.label} Library entry.`, {
                        dedupeKey: `library-import-item:${filenames[i] || i}`,
                        dedupeWindowMs: 80
                    });
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
                    if (adapter.type === 'studio') {
                        await upsertDerivedStudioAsset(projectData);
                    }
                    importedTags.push(...projectData.tags);
                    savedCount += 1;
                } catch (err) {
                    failedCount += 1;
                    lastError = err;
                    console.error(`[Library] Error processing file ${filenames[i]}:`, err);
                }

                onProgress?.({ phase: 'progress', count: i + 1, total: payloadsText.length, filename: filenames[i] });
                await maybeYieldToUi(i, 1);
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
                logProcess('error', 'library.import', lastError?.message || 'No imported Library items could be saved.');
                throw new Error(lastError?.message || 'No Library items were saved to the database.');
            }
            logProcess(failedCount ? 'warning' : 'success', 'library.import', failedCount
                ? `Imported ${savedCount} of ${payloadsText.length} Library item${payloadsText.length === 1 ? '' : 's'}; ${failedCount} failed.`
                : `Imported ${savedCount} Library item${savedCount === 1 ? '' : 's'} into the database.`);
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
            logProcess('success', '3d.workspace', 'Started a new 3D scene.');
            setNotice('Started a new 3D scene.', 'success');
        },
        async importThreeDModelFiles(files) {
            if (!ensureThreeDSceneUnlocked('importing more 3D models')) return;
            logProcess('active', '3d.assets', `Importing ${files.length} model file${files.length === 1 ? '' : 's'} into the 3D scene.`);
            await showWorkspaceProgress('3d', {
                title: 'Importing Models',
                message: `Reading ${files.length} model file${files.length === 1 ? '' : 's'}...`,
                progress: 0.08
            });
            try {
                const items = await createThreeDModelItemsFromFiles(files, {
                    onProgress: ({ index, total, file, message }) => {
                        const ratio = total ? Math.min(0.68, 0.12 + (((index + 0.55) / total) * 0.48)) : 0.28;
                        setThreeDProgress({
                            active: true,
                            title: 'Importing Models',
                            message: message || `Reading model "${file?.name || 'asset'}".`,
                            progress: ratio
                        });
                        logProgressProcess('3d.assets', message || `Reading model "${file?.name || 'asset'}".`, ratio, {
                            dedupeKey: `3d-model-import:${file?.name || index}:${Math.round(ratio * 1000)}`,
                            dedupeWindowMs: 80
                        });
                    }
                });
                if (!items.length) {
                    clearWorkspaceProgress('3d');
                    logProcess('warning', '3d.assets', '3D model import did not produce any supported assets.');
                    throw new Error('Choose one or more `.glb` or self-contained `.gltf` files.');
                }
                setThreeDProgress({
                    active: true,
                    title: 'Importing Models',
                    message: `Creating ${items.length} model scene item${items.length === 1 ? '' : 's'}...`,
                    progress: 0.76
                });
                logProcess('info', '3d.assets', 'Creating scene items for imported 3D models.', {
                    dedupeKey: `3d-model-create:${items.length}`,
                    dedupeWindowMs: 120
                });
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
                setThreeDProgress({
                    active: true,
                    title: 'Importing Models',
                    message: 'Syncing imported models with the Assets Library...',
                    progress: 0.92
                });
                logProgressProcess('3d.assets', 'Syncing imported models with the Assets Library.', 0.92, {
                    dedupeKey: `3d-model-sync:${items.length}`,
                    dedupeWindowMs: 120
                });
                await ensureLibraryAssetsFromThreeDItems(items);
                commitActiveSection('3d');
                clearWorkspaceProgress('3d');
                logProcess('success', '3d.assets', `Added ${items.length} model${items.length === 1 ? '' : 's'} to the 3D scene.`);
            } catch (error) {
                clearWorkspaceProgress('3d');
                logProcess('error', '3d.assets', error?.message || 'Could not import the selected 3D models.');
                throw error;
            }
        },
        async importThreeDImageFiles(files) {
            if (!ensureThreeDSceneUnlocked('adding image planes')) return;
            logProcess('active', '3d.assets', `Importing ${files.length} image file${files.length === 1 ? '' : 's'} as 3D planes.`);
            await showWorkspaceProgress('3d', {
                title: 'Importing Image Planes',
                message: `Reading ${files.length} image file${files.length === 1 ? '' : 's'}...`,
                progress: 0.08
            });
            try {
                const items = await createThreeDImagePlaneItemsFromFiles(files, {
                    onProgress: ({ index, total, file, message }) => {
                        const ratio = total ? Math.min(0.68, 0.12 + (((index + 0.55) / total) * 0.48)) : 0.28;
                        setThreeDProgress({
                            active: true,
                            title: 'Importing Image Planes',
                            message: message || `Reading image plane "${file?.name || 'asset'}".`,
                            progress: ratio
                        });
                        logProgressProcess('3d.assets', message || `Reading image plane "${file?.name || 'asset'}".`, ratio, {
                            dedupeKey: `3d-image-import:${file?.name || index}:${Math.round(ratio * 1000)}`,
                            dedupeWindowMs: 80
                        });
                    }
                });
                if (!items.length) {
                    clearWorkspaceProgress('3d');
                    logProcess('warning', '3d.assets', '3D image-plane import did not produce any supported assets.');
                    throw new Error('Choose one or more image files to turn into planes.');
                }
                setThreeDProgress({
                    active: true,
                    title: 'Importing Image Planes',
                    message: `Creating ${items.length} image plane${items.length === 1 ? '' : 's'} in the scene...`,
                    progress: 0.76
                });
                logProcess('info', '3d.assets', 'Creating scene items for imported image planes.', {
                    dedupeKey: `3d-image-create:${items.length}`,
                    dedupeWindowMs: 120
                });
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
                setThreeDProgress({
                    active: true,
                    title: 'Importing Image Planes',
                    message: 'Syncing imported image planes with the Assets Library...',
                    progress: 0.92
                });
                logProgressProcess('3d.assets', 'Syncing imported image planes with the Assets Library.', 0.92, {
                    dedupeKey: `3d-image-sync:${items.length}`,
                    dedupeWindowMs: 120
                });
                await ensureLibraryAssetsFromThreeDItems(items);
                commitActiveSection('3d');
                clearWorkspaceProgress('3d');
                logProcess('success', '3d.assets', `Added ${items.length} image plane${items.length === 1 ? '' : 's'} to the 3D scene.`);
            } catch (error) {
                clearWorkspaceProgress('3d');
                logProcess('error', '3d.assets', error?.message || 'Could not import the selected 3D image planes.');
                throw error;
            }
        },
        async addLibraryAssetToThreeDScene(assetId) {
            if (!ensureThreeDSceneUnlocked('placing a Library asset into the 3D scene')) return false;
            const existing = await getFromLibraryDB(assetId).catch(() => null);
            const assetRecord = normalizeLibraryAssetRecord(existing);
            if (!assetRecord?.dataUrl) {
                logProcess('error', '3d.assets', 'Could not find the requested Library asset for 3D placement.');
                throw new Error('That Library asset could not be found.');
            }
            const nextItem = createThreeDItemFromLibraryAsset(assetRecord, store.getState().threeDDocument?.view);
            if (!nextItem) {
                logProcess('warning', '3d.assets', `Blocked placement of "${assetRecord.name || 'Library asset'}" because its format is unsupported in the 3D scene.`);
                throw new Error('That Library asset format is not supported in the 3D scene.');
            }
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const uniqueName = createUniqueThreeDItemName(nextItem.name, normalized.scene.items);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: [
                            ...normalized.scene.items,
                            {
                                ...nextItem,
                                name: uniqueName,
                                asset: {
                                    ...nextItem.asset,
                                    name: uniqueName
                                }
                            }
                        ]
                    },
                    selection: {
                        itemId: nextItem.id
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
            commitActiveSection('3d');
            logProcess('success', '3d.assets', `Placed Library asset "${assetRecord.name || 'Asset'}" into the 3D scene.`);
            return true;
        },
        async importThreeDFontFiles(files) {
            if (!ensureThreeDSceneUnlocked('uploading fonts')) return [];
            logProcess('active', '3d.assets', `Importing ${files.length} font file${files.length === 1 ? '' : 's'} into 3D.`);
            await showWorkspaceProgress('3d', {
                title: 'Importing Fonts',
                message: `Reading ${files.length} font file${files.length === 1 ? '' : 's'}...`,
                progress: 0.08
            });
            try {
                const assets = await createThreeDFontAssetsFromFiles(files, {
                    onProgress: ({ index, total, file, message }) => {
                        const ratio = total ? Math.min(0.76, 0.16 + (((index + 0.55) / total) * 0.52)) : 0.32;
                        setThreeDProgress({
                            active: true,
                            title: 'Importing Fonts',
                            message: message || `Reading font "${file?.name || 'asset'}".`,
                            progress: ratio
                        });
                        logProgressProcess('3d.assets', message || `Reading font "${file?.name || 'asset'}".`, ratio, {
                            dedupeKey: `3d-font-import:${file?.name || index}:${Math.round(ratio * 1000)}`,
                            dedupeWindowMs: 80
                        });
                    }
                });
                if (!assets.length) {
                    clearWorkspaceProgress('3d');
                    logProcess('warning', '3d.assets', 'No supported font files were imported into 3D.');
                    throw new Error('Choose one or more `.ttf`, `.otf`, `.woff`, or `.woff2` font files.');
                }
                setThreeDProgress({
                    active: true,
                    title: 'Importing Fonts',
                    message: `Registering ${assets.length} font asset${assets.length === 1 ? '' : 's'}...`,
                    progress: 0.9
                });
                logProgressProcess('3d.assets', 'Registering imported fonts with the 3D workspace.', 0.9, {
                    dedupeKey: `3d-font-register:${assets.length}`,
                    dedupeWindowMs: 120
                });
                updateThreeDDocument((document) => {
                    const normalized = normalizeThreeDDocument(document);
                    return {
                        ...normalized,
                        assets: {
                            ...normalized.assets,
                            fonts: [...normalized.assets.fonts, ...assets]
                        }
                    };
                }, { render: false });
                clearWorkspaceProgress('3d');
                logProcess('success', '3d.assets', `Imported ${assets.length} font asset${assets.length === 1 ? '' : 's'} into 3D.`);
                return assets;
            } catch (error) {
                clearWorkspaceProgress('3d');
                logProcess('error', '3d.assets', error?.message || 'Could not import the selected 3D fonts.');
                throw error;
            }
        },
        async importThreeDHdriFile(file) {
            if (!ensureThreeDSceneUnlocked('uploading an HDRI')) return null;
            logProcess('active', '3d.assets', `Importing HDRI "${file?.name || 'environment'}" into the 3D world light.`);
            await showWorkspaceProgress('3d', {
                title: 'Importing HDRI',
                message: `Reading "${file?.name || 'environment'}"...`,
                progress: 0.12
            });
            try {
                const asset = await createThreeDHdriAssetFromFile(file, {
                    onProgress: ({ message }) => {
                        setThreeDProgress({
                            active: true,
                            title: 'Importing HDRI',
                            message: message || `Reading "${file?.name || 'environment'}"...`,
                            progress: 0.42
                        });
                        logProgressProcess('3d.assets', message || `Reading "${file?.name || 'environment'}"...`, 0.42, {
                            dedupeKey: `3d-hdri-import:${file?.name || 'hdri'}`,
                            dedupeWindowMs: 120
                        });
                    }
                });
                if (!asset) {
                    clearWorkspaceProgress('3d');
                    logProcess('warning', '3d.assets', 'No valid HDRI file was imported into 3D.');
                    throw new Error('Choose a `.hdr` file for the world light environment.');
                }
                setThreeDProgress({
                    active: true,
                    title: 'Importing HDRI',
                    message: `Applying "${asset.name || file?.name || 'environment'}" to the world light...`,
                    progress: 0.88
                });
                logProgressProcess('3d.assets', `Applying "${asset.name || file?.name || 'environment'}" to the 3D world light.`, 0.88, {
                    dedupeKey: `3d-hdri-apply:${asset.id || file?.name || 'hdri'}`,
                    dedupeWindowMs: 120
                });
                updateThreeDDocument((document) => {
                    const normalized = normalizeThreeDDocument(document);
                    return {
                        ...normalized,
                        assets: {
                            ...normalized.assets,
                            hdris: [...normalized.assets.hdris, asset]
                        },
                        scene: {
                            ...normalized.scene,
                            worldLight: {
                                ...normalized.scene.worldLight,
                                mode: 'hdri',
                                enabled: true,
                                hdriAssetId: asset.id
                            }
                        },
                        render: {
                            ...normalized.render,
                            currentSamples: 0
                        }
                    };
                });
                clearWorkspaceProgress('3d');
                logProcess('success', '3d.assets', `Loaded HDRI "${asset.name || file?.name || 'environment'}" into the 3D scene.`);
                return asset;
            } catch (error) {
                clearWorkspaceProgress('3d');
                logProcess('error', '3d.assets', error?.message || 'Could not import the selected HDRI.');
                throw error;
            }
        },
        addThreeDText() {
            if (!ensureThreeDSceneUnlocked('adding text')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const item = createThreeDTextItem(normalized.view);
                item.name = createUniqueThreeDItemName(item.name, normalized.scene.items);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: [...normalized.scene.items, item]
                    },
                    selection: {
                        itemId: item.id
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
            commitActiveSection('3d');
        },
        addThreeDShape(shapeType = 'square') {
            if (!ensureThreeDSceneUnlocked('adding a 2D shape')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const item = createThreeDShapeItem(shapeType, normalized.view);
                item.name = createUniqueThreeDItemName(item.name, normalized.scene.items);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: [...normalized.scene.items, item]
                    },
                    selection: {
                        itemId: item.id
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
        toggleThreeDItemVisibility(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('changing 3D item visibility')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items.map((item) => item.id === itemId
                        ? {
                            ...item,
                            visible: item.visible === false
                        }
                        : item)
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        toggleThreeDItemLock(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('changing 3D item locks')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    items: document.scene.items.map((item) => item.id === itemId
                        ? {
                            ...item,
                            locked: !item.locked
                        }
                        : item)
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        updateThreeDWorkspace(patch = {}) {
            updateThreeDDocument((document) => ({
                ...document,
                workspace: {
                    ...document.workspace,
                    ...(patch.taskView ? { taskView: patch.taskView } : {}),
                    ...(patch.panelTab ? { panelTab: patch.panelTab } : {}),
                    taskTabs: {
                        ...document.workspace?.taskTabs,
                        layout: {
                            ...document.workspace?.taskTabs?.layout,
                            ...(patch.taskTabs?.layout || {})
                        },
                        model: {
                            ...document.workspace?.taskTabs?.model,
                            ...(patch.taskTabs?.model || {})
                        },
                        render: {
                            ...document.workspace?.taskTabs?.render,
                            ...(patch.taskTabs?.render || {})
                        }
                    }
                }
            }), { render: false });
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
        updateThreeDWorldLight(patch = {}) {
            if (!ensureThreeDSceneUnlocked('changing world light settings')) return;
            updateThreeDDocument((document) => ({
                ...document,
                scene: {
                    ...document.scene,
                    worldLight: {
                        ...(document.scene?.worldLight || {}),
                        ...patch,
                        gradientStops: patch.gradientStops === undefined
                            ? document.scene?.worldLight?.gradientStops || []
                            : patch.gradientStops
                    }
                },
                render: {
                    ...document.render,
                    currentSamples: 0
                }
            }));
        },
        updateThreeDRenderSettings(patch = {}) {
            if (!ensureThreeDSceneUnlocked('changing 3D render settings')) return;
            const resetsPreview = Object.keys(patch).some((key) => key !== 'exportEngine');
            updateThreeDDocument((document) => ({
                ...document,
                render: {
                    ...document.render,
                    ...patch,
                    currentSamples: resetsPreview ? 0 : document.render?.currentSamples || 0
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
        configureThreeDCanvasView(patch = {}, snapshot = null) {
            if (!ensureThreeDSceneUnlocked('changing the 3D camera view')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                let nextView = {
                    ...normalized.view,
                    ...patch
                };
                if (patch.lockedView === 'current' && snapshot?.cameraQuaternion) {
                    nextView.lockedRotation = [...snapshot.cameraQuaternion];
                }
                if (nextView.navigationMode === 'canvas') {
                    const aligned = alignCameraToLockedView({
                        ...nextView,
                        cameraPosition: snapshot?.cameraPosition || nextView.cameraPosition,
                        cameraTarget: snapshot?.cameraTarget || nextView.cameraTarget
                    });
                    nextView = {
                        ...nextView,
                        cameraPosition: aligned.cameraPosition,
                        cameraTarget: aligned.cameraTarget,
                        lockedRotation: nextView.lockedView === 'current'
                            ? aligned.lockedRotation
                            : nextView.lockedRotation
                    };
                    if (nextView.projection === 'orthographic' && (patch.wheelMode == null)) {
                        nextView.wheelMode = 'zoom';
                    } else if (nextView.projection === 'perspective' && (patch.wheelMode == null)) {
                        nextView.wheelMode = 'travel';
                    }
                }
                return {
                    ...normalized,
                    view: nextView
                };
            });
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
                    fov: Number(source.fov || document.view.fov || 50),
                    projection: source.projection || document.view.projection || 'perspective',
                    orthoZoom: Number(source.orthoZoom || document.view.orthoZoom || 1)
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
                        fov: preset.fov,
                        projection: preset.projection || document.view.projection,
                        orthoZoom: Number(preset.orthoZoom || document.view.orthoZoom || 1)
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
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const nextItems = normalized.scene.items.map((item) => item.id === itemId
                    ? {
                        ...item,
                        ...(patch.position ? { position: [...patch.position] } : {}),
                        ...(patch.rotation ? { rotation: [...patch.rotation] } : {}),
                        ...(patch.scale ? { scale: [...patch.scale] } : {}),
                        ...(item.kind === 'text' && item.text?.attachment
                            ? {
                                text: {
                                    ...item.text,
                                    attachment: null
                                }
                            }
                            : {})
                    }
                    : item);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: applyAttachedTextTransforms(nextItems, itemId)
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
        },
        resetThreeDItemTransform(itemId) {
            actions.updateThreeDItemTransform(itemId, {
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1]
            });
        },
        applyThreeDBooleanSlice(itemId, cutSnapshot = null) {
            if (!itemId || !cutSnapshot?.geometry) return;
            if (!ensureThreeDSceneUnlocked('applying a boolean slice')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const target = normalized.scene.items.find((item) => item.id === itemId);
                if (!isThreeDBooleanCompatibleItem(target)) return normalized;
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: normalized.scene.items.map((item) => item.id === itemId
                            ? {
                                ...item,
                                booleanCuts: [
                                    ...(Array.isArray(item.booleanCuts) ? item.booleanCuts : []),
                                    {
                                        ...cutSnapshot,
                                        mode: 'subtract'
                                    }
                                ]
                            }
                            : item)
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
        },
        resetThreeDItemBooleanSlices(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('resetting boolean slices')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const target = normalized.scene.items.find((item) => item.id === itemId);
                if (!isThreeDBooleanCompatibleItem(target) || !(target.booleanCuts || []).length) {
                    return normalized;
                }
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: normalized.scene.items.map((item) => item.id === itemId
                            ? {
                                ...item,
                                booleanCuts: []
                            }
                            : item)
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
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
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const nextItems = normalized.scene.items
                    .filter((item) => item.id !== itemId)
                    .map((item) => item.kind === 'light' && item.light?.targetItemId === itemId
                        ? {
                            ...item,
                            light: {
                                ...item.light,
                                targetItemId: null
                            }
                        }
                        : item.kind === 'text' && item.text?.attachment?.targetItemId === itemId
                            ? {
                                ...item,
                                text: {
                                    ...item.text,
                                    attachment: null
                                }
                            }
                            : item);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: nextItems
                    },
                    selection: {
                        itemId: normalized.selection.itemId === itemId ? null : normalized.selection.itemId
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
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
        updateThreeDText(itemId, patch = {}) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('editing text')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: normalized.scene.items.map((item) => item.id === itemId && item.kind === 'text'
                            ? {
                                ...item,
                                text: {
                                    ...item.text,
                                    ...patch,
                                    fontSource: patch.fontSource
                                        ? {
                                            ...item.text.fontSource,
                                            ...patch.fontSource
                                        }
                                        : item.text.fontSource,
                                    glow: patch.glow
                                        ? {
                                            ...item.text.glow,
                                            ...patch.glow
                                        }
                                        : item.text.glow,
                                    extrude: patch.extrude
                                        ? {
                                            ...item.text.extrude,
                                            ...patch.extrude
                                        }
                                        : item.text.extrude,
                                    attachment: patch.attachment === undefined ? item.text.attachment : patch.attachment
                                }
                            }
                            : item)
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
        },
        updateThreeDShape(itemId, patch = {}) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('editing shapes')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: normalized.scene.items.map((item) => item.id === itemId && item.kind === 'shape-2d'
                            ? {
                                ...item,
                                shape2d: {
                                    ...item.shape2d,
                                    ...patch,
                                    glow: patch.glow
                                        ? {
                                            ...item.shape2d.glow,
                                            ...patch.glow
                                        }
                                        : item.shape2d.glow
                                }
                            }
                            : item)
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
        },
        attachThreeDTextToSurface(itemId, surfaceHit) {
            if (!itemId || !surfaceHit?.targetItemId) return;
            if (!ensureThreeDSceneUnlocked('attaching text to a surface')) return;
            updateThreeDDocument((document) => {
                const normalized = normalizeThreeDDocument(document);
                const target = normalized.scene.items.find((item) => item.id === surfaceHit.targetItemId);
                const textItem = normalized.scene.items.find((item) => item.id === itemId && item.kind === 'text');
                if (!target || !textItem) return normalized;
                const attachment = createAttachmentFromWorldHit(
                    target,
                    new THREE.Vector3(...surfaceHit.point),
                    new THREE.Vector3(...surfaceHit.normal),
                    surfaceHit.tangent ? new THREE.Vector3(...surfaceHit.tangent) : null,
                    surfaceHit.offset ?? 0.01
                );
                const transform = resolveAttachmentTransform(target, attachment);
                return {
                    ...normalized,
                    scene: {
                        ...normalized.scene,
                        items: normalized.scene.items.map((item) => item.id === itemId
                            ? {
                                ...item,
                                position: transform ? [...transform.position] : item.position,
                                rotation: transform ? [...transform.rotation] : item.rotation,
                                text: {
                                    ...item.text,
                                    attachment
                                }
                            }
                            : item)
                    },
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    }
                };
            });
        },
        detachThreeDTextSurface(itemId) {
            if (!itemId) return;
            if (!ensureThreeDSceneUnlocked('detaching text from a surface')) return;
            actions.updateThreeDText(itemId, { attachment: null });
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
                const normalized = stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload));
                const validated = validateImportPayload(normalized, 'document');
                return {
                    ...validated,
                    layerStack: reindexStack(registry, validated.layerStack || [])
                };
            },
            async captureDocument(document, payload = null) {
                const basePayload = payload || buildLibraryPayload(document);
                if (!basePayload.source?.imageData) {
                    throw new Error('Load an image in the Editor before saving to the Library.');
                }
                const capture = await captureStudioDocumentSnapshot(engine, document, basePayload);
                const finalPayload = capture.payload;
                return {
                    payload: finalPayload,
                    blob: capture.blob,
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
                const capture = await captureStudioDocumentSnapshot(engine, tempDoc, validated);
                return {
                    payload: capture.payload,
                    blob: capture.blob,
                    summary: {
                        hoverSource: capture.payload.source,
                        sourceWidth: Number(capture.payload.source?.width || 0),
                        sourceHeight: Number(capture.payload.source?.height || 0),
                        sourceArea: Number(capture.payload.source?.width || 0) * Number(capture.payload.source?.height || 0),
                        sourceCount: capture.payload.source?.imageData ? 1 : 0,
                        renderWidth: Number(engine.runtime.renderWidth || capture.payload.source?.width || 0),
                        renderHeight: Number(engine.runtime.renderHeight || capture.payload.source?.height || 0)
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
                const runtimePayload = stripStudioPreview(validated);
                updateDocument((document) => ({
                    ...document,
                    ...runtimePayload,
                    layerStack: runtimePayload.layerStack,
                    source: runtimePayload.source || document.source,
                    workspace: normalizeWorkspace('studio', runtimePayload.workspace || document.workspace, !!runtimePayload.selection?.layerInstanceId)
                }), { render: true });
                setActiveLibraryOrigin('studio', libraryId, libraryName);
                commitActiveSection('editor');
                logProcess('success', 'library.projects', `Loaded "${libraryName || 'project'}" from the Library into Editor.`);
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
                const normalized = stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload));
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
                logProcess('success', 'library.projects', `Loaded "${libraryName || 'project'}" from the Library into Stitch.`);
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
                const normalized = normalizeThreeDDocument(stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload)));
                return {
                    ...normalized,
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    },
                    renderJob: {
                        ...createEmptyThreeDDocument().renderJob
                    }
                };
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
                ensureLibraryAssetsFromThreeDItems(validated.scene?.items || []).catch((error) => {
                    console.error(error);
                    logProcess('warning', 'library.assets', error?.message || 'Could not backfill scene assets while loading a 3D Library project.');
                });
                logProcess('success', 'library.projects', `Loaded "${libraryName || 'project'}" from the Library into 3D.`);
                setNotice(`Loaded "${libraryName || 'project'}" from Library.`, 'success');
                return true;
            }
        }
    ]);

    setBootStage('workspace init', 'Building workspace UI shells.');
    view = createWorkspaceUI(root, registry, actions, { stitchEngine, logger });
    bootMetrics.mark('workspace-ui-ready', 'Workspace UI shells are mounted.');
    setBootStage('editor engine init', 'Initializing the Editor render engine.');
    await engine.init(view.getRenderRefs().canvas);
    engine.attachRefs(view.getRenderRefs());
    bootMetrics.mark('editor-engine-ready', 'The Editor render engine finished booting.');
    setBootStage('background warmup', 'Scheduling background warmup jobs.');
    scheduleLibraryImageAssetPreviewWarmup();
    bootMetrics.mark('background-warmup-scheduled', 'Background warmup jobs are scheduled.');

    let lastSubscribedSection = store.getState().ui.activeSection;
    let pendingEditorRender = false;
    let pendingStitchRender = false;

    store.subscribe((state, meta) => {
        const activeSection = state.ui.activeSection;
        const sectionChanged = activeSection !== lastSubscribedSection;
        if (!meta.skipViewRender) {
            view.render(state);
            engine.attachRefs(view.getRenderRefs());
        }
        if (meta.render && engine.hasImage()) {
            if (activeSection === 'editor') {
                pendingEditorRender = false;
                engine.requestRender(state.document);
            } else {
                pendingEditorRender = true;
            }
        }
        if (meta.renderStitch) {
            if (activeSection === 'stitch') {
                pendingStitchRender = false;
                stitchEngine.requestRender(state.stitchDocument);
            } else {
                pendingStitchRender = true;
            }
        }
        if (sectionChanged) {
            if (activeSection === 'editor' && engine.hasImage()) {
                pendingEditorRender = false;
                engine.requestRender(state.document);
            }
            if (activeSection === 'stitch' && pendingStitchRender) {
                pendingStitchRender = false;
                stitchEngine.requestRender(state.stitchDocument);
            }
            lastSubscribedSection = activeSection;
        }
    });

    view.render(store.getState());
    engine.attachRefs(view.getRenderRefs());
    bootMetrics.mark('first-interactive', 'Initial render completed.');
    logProcess('success', 'app.bootstrap', 'Workspace UI and core engines finished booting.');
    setNotice(
        store.getState().ui.activeSection === 'library'
            ? 'Browse saved projects in the Library, or switch to Editor to start a new one.'
            : store.getState().ui.activeSection === 'stitch'
                ? 'Add two or more images in Stitch to start building a composite.'
                : store.getState().ui.activeSection === '3d'
                    ? 'Load .glb models or add image planes to start building a 3D scene.'
                    : store.getState().ui.activeSection === 'logs'
                        ? 'Review live process cards here while the rest of the site works in the background.'
                    : 'Load an image to start editing.',
        'info',
        6500
    );
});
