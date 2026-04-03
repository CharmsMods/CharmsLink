import * as THREE from 'three';
import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { getRegistryUrls } from './registry/shared.js';
import { downloadState, readJsonFile, serializeState, validateImportPayload } from './io/documents.js';
import { createProjectAdapterRegistry } from './io/projectAdapters.js';
import { didSaveFile, saveBlobLocally, saveJsonLocally, wasSaveCancelled } from './io/localSave.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { StitchEngine } from './stitch/engine.js';
import { analyzePreparedStitchInputs } from './stitch/analysis.js';
import {
    applyCandidateToDocument,
    coerceStitchSettingValue,
    computeCompositeBounds,
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
    countLegacyThreeDBooleanCuts,
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
import { createWorkerFileEntries, createWorkerSingleFileEntry } from './workers/filePayload.js';
import { createBootstrapMetrics } from './perf/bootstrapMetrics.js';
import { createBootShell } from './ui/bootShell.js';
import { computeAnalysisVisualsJs, computeDiffPreviewJs, extractPaletteFromFileJs } from './editor/backgroundCompute.js';
import { extractPaletteFromImageSource } from './editor/palette.js';
import { APP_ASSET_VERSION, withAssetVersion } from './appAssetVersion.js';
import { createDefaultAppSettings } from './settings/defaults.js';
import { applyEditorSettingsToDocument, applyEditorSettingsToLayerInstance, applyStitchSettingsToDocument, applyThemeToStitchDocument, applyThreeDSettingsToDocument, createSettingsDrivenStitchDocument, createSettingsDrivenThreeDDocument } from './settings/apply.js';
import { loadPersistedAppSettings, persistAppSettings, buildSettingsExportPayload, parseImportedSettingsPayload } from './settings/persistence.js';
import { normalizeAppSettings, normalizeSettingsCategory } from './settings/schema.js';
import {
    buildSecureLibraryExportRecord as buildSecureLibraryExportRecordData,
    createSecureLibraryCompatibilityError,
    resolveSecureLibraryImportRecord as resolveSecureLibraryImportRecordData
} from './library/secureTransfer.js';

const DB_NAME = 'ModularStudioDB';
const DB_VERSION = 2;
const STORE_NAME = 'LibraryProjects';
const LIBRARY_META_ID = '__library_meta__';
let backgroundTasks = null;
let workerCapabilities = null;

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

function describeSavedLocation(result) {
    return result?.filePath ? ` at "${result.filePath}"` : '';
}

async function requestAppConfirmDialog(view, options = {}) {
    if (view?.requestAppConfirm) {
        return !!(await view.requestAppConfirm(options));
    }
    return !!globalThis.confirm?.(String(options.text || options.title || 'Continue?'));
}

async function requestAppTextDialog(view, options = {}) {
    if (view?.requestAppText) {
        return view.requestAppText(options);
    }
    const fallbackText = String(options.text || options.title || 'Enter a value:');
    const fallbackDefault = String(options.defaultValue ?? '');
    const value = globalThis.prompt?.(fallbackText, fallbackDefault);
    return value == null ? null : String(options.trim === false ? value : value.trim());
}

function normalizeComparableLabel(value) {
    return String(value || '').trim().toLowerCase();
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

function isAbortError(error) {
    return error?.name === 'AbortError';
}

async function buildWorkerFileListRequest(files = [], options = {}) {
    const { fileEntries, transfer } = await createWorkerFileEntries(files, options);
    return {
        payload: { fileEntries },
        transfer
    };
}

async function buildWorkerSingleFileRequest(file, options = {}) {
    const { fileEntry, transfer } = await createWorkerSingleFileEntry(file, options);
    return {
        payload: { fileEntry },
        transfer
    };
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
        processId: 'library.assets',
        scope: 'background:library-assets',
        replayOnWorkerCrash: true,
        maxCrashReplays: 2
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
        processId: 'library.assets',
        scope: 'background:library-assets',
        replayOnWorkerCrash: true,
        maxCrashReplays: 2
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
            progressMessage: '',
            runId: 0,
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

function invalidateStitchAnalysis(documentState, options = {}) {
    const normalized = normalizeStitchDocument(documentState);
    const nextWarning = typeof options.warning === 'string' ? options.warning : normalized.analysis.warning;
    return normalizeStitchDocument({
        ...normalized,
        candidates: [],
        activeCandidateId: null,
        workspace: {
            ...normalized.workspace,
            galleryOpen: false,
            alternativesOpen: normalized.workspace.alternativesOpen !== false
        },
        analysis: {
            ...normalized.analysis,
            status: 'idle',
            progressMessage: '',
            runId: 0,
            warning: nextWarning,
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
        if (section === 'library' || section === 'stitch' || section === '3d' || section === 'settings' || section === 'logs') return section;
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
        else if (section === 'settings') url.searchParams.set('section', 'settings');
        else if (section === 'logs') url.searchParams.set('section', 'logs');
        else url.searchParams.delete('section');
        window.history.replaceState(null, '', url);
    } catch (_error) {
        // Ignore URL sync issues in unsupported environments.
    }
}

function createInitialState(settings = createDefaultAppSettings()) {
    const normalizedSettings = normalizeAppSettings(settings);
    return {
        document: applyEditorSettingsToDocument({
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
        }, normalizedSettings),
        stitchDocument: createSettingsDrivenStitchDocument(normalizedSettings),
        threeDDocument: createSettingsDrivenThreeDDocument(normalizedSettings),
            ui: {
                activeSection: getInitialActiveSection(),
                compareOpen: false,
                jsonCompareModalOpen: false,
                jsonCompareResults: [],
                jsonCompareView: 'grid',
                jsonCompareIndex: 0,
                loadImageOnOpen: true,
                settingsCategory: 'general'
            },
            settings: normalizedSettings,
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
    return extractPaletteFromImageSource(image, count, {
        deterministic: true
    });
}

function createJsFallbackRuntime(taskMs, reason = '') {
    return {
        selection: 'js-fallback',
        initMs: 0,
        taskMs,
        fallbackReason: reason
    };
}

function computeAnalysisVisualsFallback(payload) {
    const startedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
    const result = computeAnalysisVisualsJs(payload);
    const taskMs = Math.max(0, (typeof performance?.now === 'function' ? performance.now() : Date.now()) - startedAt);
    return {
        ...result,
        runtime: createJsFallbackRuntime(taskMs, 'Editor worker or WASM runtime was unavailable.')
    };
}

function computeDiffPreviewFallback(payload) {
    const startedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
    const result = computeDiffPreviewJs(payload);
    const taskMs = Math.max(0, (typeof performance?.now === 'function' ? performance.now() : Date.now()) - startedAt);
    return {
        ...result,
        runtime: createJsFallbackRuntime(taskMs, 'Editor worker or WASM runtime was unavailable.')
    };
}

async function extractPaletteFromFileFallback(file, count) {
    const startedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
    const palette = await extractPaletteFromFileJs(file, count, {
        deterministic: true
    });
    const taskMs = Math.max(0, (typeof performance?.now === 'function' ? performance.now() : Date.now()) - startedAt);
    return {
        palette,
        runtime: createJsFallbackRuntime(taskMs, 'Editor worker or WASM runtime was unavailable.')
    };
}

async function buildSecureLibraryExportRecordFallback(bundle, options = {}) {
    if (String(options.compatibilityMode || '').toLowerCase() !== 'js') {
        throw createSecureLibraryCompatibilityError(
            'The secure Library export fast path is unavailable without the background worker runtime.',
            {
                stage: 'runtime-init',
                fallbackReason: 'Library worker or WASM runtime was unavailable.',
                compatibilityMode: 'js'
            }
        );
    }
    const startedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
    const recordPackage = await buildSecureLibraryExportRecordData(bundle, options);
    const taskMs = Math.max(0, (typeof performance?.now === 'function' ? performance.now() : Date.now()) - startedAt);
    return {
        ...recordPackage,
        runtime: createJsFallbackRuntime(taskMs, 'Library worker or WASM runtime was unavailable.')
    };
}

async function resolveSecureLibraryImportRecordFallback(parsed, passphrase, options = {}) {
    if (String(options.compatibilityMode || '').toLowerCase() !== 'js') {
        throw createSecureLibraryCompatibilityError(
            'The secure Library import fast path is unavailable without the background worker runtime.',
            {
                stage: 'runtime-init',
                fallbackReason: 'Library worker or WASM runtime was unavailable.',
                compatibilityMode: 'js'
            }
        );
    }
    const startedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
    const resolved = await resolveSecureLibraryImportRecordData(parsed, passphrase);
    const taskMs = Math.max(0, (typeof performance?.now === 'function' ? performance.now() : Date.now()) - startedAt);
    return {
        ...resolved,
        runtime: createJsFallbackRuntime(taskMs, 'Library worker or WASM runtime was unavailable.')
    };
}

window.addEventListener('DOMContentLoaded', async () => {
    const root = document.getElementById('app');
    const bootShell = createBootShell(root, {
        detail: 'Preparing the app shell...'
    });
    let activeSettings = loadPersistedAppSettings({
        diagnostics: {
            detectedCpuCores: Math.max(0, Math.round(Number(globalThis.navigator?.hardwareConcurrency) || 0)),
            assetVersion: APP_ASSET_VERSION
        }
    });
    document.documentElement.dataset.theme = activeSettings.general.theme === 'dark' ? 'dark' : 'light';
    const bootMetrics = createBootstrapMetrics();
    const logger = createLogEngine({
        recentLimit: activeSettings.logs.recentLimit,
        historyLimit: activeSettings.logs.historyLimit
    });
    const PROCESS_LABELS = {
        'app.bootstrap': 'App Startup',
        'app.performance': 'Performance',
        'app.navigation': 'Navigation',
        'app.notice': 'Notices',
        'settings.general': 'Settings',
        'settings.library': 'Library Settings',
        'settings.editor': 'Editor Settings',
        'settings.stitch': 'Stitch Settings',
        'settings.3d': '3D Settings',
        'settings.logs': 'Logs Settings',
        'editor.files': 'Editor Files',
        'editor.export': 'Editor Export',
        'library.projects': 'Library Projects',
        'library.assets': 'Library Assets',
        'library.sync': 'Library Sync',
        'library.import': 'Library Import',
        'library.export': 'Library Export',
        'stitch.workspace': 'Stitch Workspace',
        'stitch.import': 'Stitch Import',
        'stitch.analysis': 'Stitch Analysis',
        'stitch.preview': 'Stitch Preview',
        'stitch.export': 'Stitch Export',
        'stitch.settings': 'Stitch Settings',
        'stitch.worker': 'Stitch Runtime',
        '3d.workspace': '3D Workspace',
        '3d.assets': '3D Assets',
        '3d.render': '3D Render'
    };
    let registry = null;
    let store = null;
    let engine = null;
    let stitchEngine = null;

    let noticeTimer = null;
    let playbackTimer = null;
    let view = null;
    let paletteExtractionImage = null;
    let paletteExtractionOwner = null;
    let stitchAnalysisToken = 0;
    let lastPersistedSettings = JSON.stringify(activeSettings);
    const logAutoClearTimers = new Map();

    function buildSettingsDiagnostics(overrides = {}) {
        const detectedCpuCores = Math.max(0, Math.round(Number(workerCapabilities?.hardwareConcurrency || globalThis.navigator?.hardwareConcurrency) || 0));
        const requestedWorkerLimit = Number(activeSettings?.general?.maxBackgroundWorkers || 0);
        const appliedWorkerLimit = requestedWorkerLimit > 0
            ? requestedWorkerLimit
            : Number(backgroundTasks?.getConfig?.().maxConcurrentTasks || 0);
        return {
            detectedCpuCores,
            workerCapabilities: { ...(workerCapabilities || {}) },
            assetVersion: APP_ASSET_VERSION,
            workerLimitApplied: appliedWorkerLimit,
            storageEstimate: overrides.storageEstimate ?? activeSettings?.diagnostics?.storageEstimate ?? null
        };
    }

    function buildStitchSettingsDiagnostics(overrides = {}) {
        const current = activeSettings?.stitch?.diagnostics || createDefaultAppSettings().stitch.diagnostics;
        return {
            workerAvailable: overrides.workerAvailable ?? current.workerAvailable ?? !!workerCapabilities?.worker,
            wasmAvailable: overrides.wasmAvailable ?? current.wasmAvailable ?? !!workerCapabilities?.wasm,
            runtimeAvailable: overrides.runtimeAvailable ?? current.runtimeAvailable ?? false,
            supportedDetectors: Array.isArray(overrides.supportedDetectors)
                ? overrides.supportedDetectors
                : (Array.isArray(current.supportedDetectors) ? current.supportedDetectors : []),
            lastRuntimeSelection: String(overrides.lastRuntimeSelection ?? current.lastRuntimeSelection ?? ''),
            lastFallbackReason: String(overrides.lastFallbackReason ?? current.lastFallbackReason ?? '')
        };
    }

    function syncStitchSettingsDiagnostics(overrides = {}, meta = {}) {
        return updateSettingsState((current) => ({
            ...current,
            stitch: {
                ...(current.stitch || {}),
                diagnostics: buildStitchSettingsDiagnostics(overrides)
            }
        }), {
            ...meta,
            render: false,
            renderStitch: false,
            skipViewRender: meta.skipViewRender ?? false
        });
    }

    function clearLogAutoClearTimer(processId) {
        const timer = logAutoClearTimers.get(processId);
        if (!timer) return;
        clearTimeout(timer);
        logAutoClearTimers.delete(processId);
    }

    function scheduleLogAutoClear(processId, delayMs) {
        clearLogAutoClearTimer(processId);
        if (!(delayMs > 0) || !processId) return;
        const timer = setTimeout(() => {
            logAutoClearTimers.delete(processId);
            const process = logger.getSnapshot().find((entry) => entry.id === processId);
            if (process?.status === 'success') {
                logger.clearProcess(processId);
            }
        }, delayMs);
        logAutoClearTimers.set(processId, timer);
    }

    function enforceLogCardLimit(limit = activeSettings?.logs?.maxUiCards || 0) {
        const maxCards = Math.max(0, Math.round(Number(limit) || 0));
        if (!(maxCards > 0)) return;
        const snapshot = logger.getSnapshot();
        if (snapshot.length <= maxCards) return;
        const removable = snapshot
            .filter((process) => process.status !== 'active')
            .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
        let overflow = snapshot.length - maxCards;
        for (const process of removable) {
            if (overflow <= 0) break;
            logger.clearProcess(process.id);
            clearLogAutoClearTimer(process.id);
            overflow -= 1;
        }
    }

    function syncLogHousekeeping() {
        const snapshot = logger.getSnapshot();
        const processIds = new Set(snapshot.map((process) => process.id));
        [...logAutoClearTimers.keys()].forEach((processId) => {
            if (!processIds.has(processId)) {
                clearLogAutoClearTimer(processId);
            }
        });
        const autoClearMs = Math.max(0, Number(activeSettings?.logs?.autoClearSuccessMs || 0));
        snapshot.forEach((process) => {
            if (process.status === 'success' && autoClearMs > 0) {
                scheduleLogAutoClear(process.id, autoClearMs);
            } else {
                clearLogAutoClearTimer(process.id);
            }
        });
        enforceLogCardLimit(activeSettings?.logs?.maxUiCards || 0);
    }

    logger.subscribeEvents?.((event) => {
        if (!event?.processId) return;
        if (event.status === 'success') {
            const autoClearMs = Math.max(0, Number(activeSettings?.logs?.autoClearSuccessMs || 0));
            if (autoClearMs > 0) {
                scheduleLogAutoClear(event.processId, autoClearMs);
            }
        } else {
            clearLogAutoClearTimer(event.processId);
        }
        enforceLogCardLimit(activeSettings?.logs?.maxUiCards || 0);
    });

    function normalizeSettingsForState(nextSettings, overrides = {}) {
        return normalizeAppSettings(nextSettings, {
            diagnostics: buildSettingsDiagnostics(overrides),
            stitchDiagnostics: buildStitchSettingsDiagnostics(overrides.stitchDiagnostics || {})
        });
    }

    function cloneSettingsValue(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function updateSettingsPathValue(settings, path, value) {
        const segments = String(path || '').split('.').filter(Boolean);
        if (!segments.length) return settings;
        const next = cloneSettingsValue(settings);
        let cursor = next;
        for (let index = 0; index < segments.length - 1; index += 1) {
            const segment = segments[index];
            cursor[segment] = cursor[segment] && typeof cursor[segment] === 'object'
                ? { ...cursor[segment] }
                : {};
            cursor = cursor[segment];
        }
        cursor[segments[segments.length - 1]] = value;
        return next;
    }

    function applySettingsToLiveState(state, nextSettings) {
        const nextLayerStack = (state?.document?.layerStack || []).map((instance) => applyEditorSettingsToLayerInstance(instance, nextSettings));
        return {
            ...state,
            settings: nextSettings,
            document: applyEditorSettingsToDocument({
                ...state.document,
                layerStack: nextLayerStack
            }, nextSettings),
            stitchDocument: applyStitchSettingsToDocument(state.stitchDocument, nextSettings, 'current'),
            threeDDocument: applyThreeDSettingsToDocument(state.threeDDocument, nextSettings, 'current')
        };
    }

    function syncSettingsPersistence(nextSettings) {
        const serialized = JSON.stringify(nextSettings);
        if (serialized === lastPersistedSettings) return;
        persistAppSettings(nextSettings);
        lastPersistedSettings = serialized;
    }

    function applySettingsRuntime(nextSettings) {
        logger.configure?.({
            recentLimit: nextSettings.logs.recentLimit,
            historyLimit: nextSettings.logs.historyLimit
        });
        backgroundTasks?.configure?.({
            maxConcurrentTasks: nextSettings.general.maxBackgroundWorkers > 0
                ? nextSettings.general.maxBackgroundWorkers
                : 0
        });
        document.documentElement.dataset.theme = nextSettings.general.theme === 'dark' ? 'dark' : 'light';
        syncLogHousekeeping();
    }

    function updateSettingsState(mutator, meta = {}) {
        const baseSettings = store ? store.getState().settings : activeSettings;
        const proposed = typeof mutator === 'function' ? mutator(baseSettings) : mutator;
        const normalized = normalizeSettingsForState(proposed, meta.diagnostics || {});
        activeSettings = normalized;
        applySettingsRuntime(normalized);
        if (store) {
            store.setState((state) => applySettingsToLiveState(state, normalized), {
                render: meta.render ?? false,
                renderStitch: meta.renderStitch ?? false,
                skipViewRender: meta.skipViewRender ?? false
            });
        }
        syncSettingsPersistence(normalized);
        return normalized;
    }

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
            workerUrl: withAssetVersion(new URL('./workers/appLibrary.worker.js', import.meta.url)),
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
                if (task === 'build-secure-library-export-record') {
                    return buildSecureLibraryExportRecordFallback(payload.bundle, {
                        secureMode: payload.secureMode,
                        passphrase: payload.passphrase || '',
                        compatibilityMode: payload.compatibilityMode || 'fast'
                    });
                }
                if (task === 'resolve-secure-library-import-record') {
                    return resolveSecureLibraryImportRecordFallback(payload.parsed, payload.passphrase || '', {
                        compatibilityMode: payload.compatibilityMode || 'fast'
                    });
                }
                throw new Error(`Unknown app-library task "${task}".`);
            }
        });
        backgroundTasks.registerDomain('editor', {
            workerUrl: withAssetVersion(new URL('./workers/editor.worker.js', import.meta.url)),
            supportsTask(task, capabilities) {
                if (task === 'compute-analysis-visuals') {
                    return !!capabilities.offscreenCanvas2d;
                }
                if (task === 'extract-palette-from-image') {
                    return !!capabilities.createImageBitmap && !!capabilities.offscreenCanvas2d;
                }
                return true;
            },
            fallback(task, payload) {
                if (task === 'read-studio-state-file') {
                    return readStudioStateFileFallback(payload.file);
                }
                if (task === 'compute-analysis-visuals') {
                    return computeAnalysisVisualsFallback(payload);
                }
                if (task === 'compute-diff-preview') {
                    return computeDiffPreviewFallback(payload);
                }
                if (task === 'extract-palette-from-image') {
                    return extractPaletteFromFileFallback(payload.file, payload.count);
                }
                throw new Error(`Unknown editor task "${task}".`);
            }
        });
        backgroundTasks.registerDomain('stitch', {
            workerUrl: withAssetVersion(new URL('./workers/stitch.worker.js', import.meta.url)),
            supportsTask(task, capabilities) {
                if (task === 'prepare-input-files') {
                    return !!capabilities.createImageBitmap;
                }
                if (task === 'prepare-analysis-inputs' || task === 'build-candidate-previews') {
                    return !!capabilities.createImageBitmap && !!capabilities.offscreenCanvas2d;
                }
                return true;
            },
            fallback(task, payload, context) {
                if (task === 'analyze-screenshot') {
                    return analyzePreparedStitchInputs(payload.document, payload.preparedInputs);
                }
                if (task === 'prepare-analysis-inputs') {
                    return (stitchEngine || new StitchEngine()).buildPreparedInputs(payload.document);
                }
                if (task === 'classify-scene-mode') {
                    return (stitchEngine || new StitchEngine()).classifySceneMode(payload.preparedInputs, { preferWorker: false });
                }
                if (task === 'build-candidate-previews') {
                    return (stitchEngine || new StitchEngine()).buildCandidatePreviewMap(payload.document);
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
        backgroundTasks.registerDomain('stitch-opencv', {
            workerUrl: withAssetVersion(new URL('./workers/stitchOpencv.worker.js', import.meta.url)),
            type: 'classic',
            supportsTask(task, capabilities) {
                if (task === 'self-test-photo-runtime') {
                    return !!capabilities.worker;
                }
                return !!capabilities.worker && !!capabilities.wasm;
            },
            fallback(task) {
                if (task === 'self-test-photo-runtime') {
                    return {
                        runtime: buildStitchSettingsDiagnostics({
                            workerAvailable: !!workerCapabilities?.worker,
                            wasmAvailable: !!workerCapabilities?.wasm,
                            runtimeAvailable: false,
                            supportedDetectors: [],
                            lastRuntimeSelection: '',
                            lastFallbackReason: 'Photo analysis requires Worker and WebAssembly support for OpenCV.js.'
                        }),
                        summary: {
                            ready: false,
                            error: 'Photo analysis requires Worker and WebAssembly support for OpenCV.js.',
                            supportedDetectors: []
                        }
                    };
                }
                throw new Error('Photo analysis requires browser Worker and WebAssembly support for OpenCV.js.');
            }
        });
        backgroundTasks.registerDomain('three', {
            workerUrl: withAssetVersion(new URL('./workers/three.worker.js', import.meta.url)),
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
        onTaskMetric: (metric) => bootMetrics.trackWorkerTask(metric),
        maxConcurrentTasks: activeSettings.general.maxBackgroundWorkers > 0 ? activeSettings.general.maxBackgroundWorkers : 0
    });
    registerWorkerDomains();
    activeSettings = normalizeSettingsForState(activeSettings);
    applySettingsRuntime(activeSettings);
    logProcess('info', 'app.bootstrap', `Asset version ${APP_ASSET_VERSION} loaded for workers and WASM modules.`, {
        dedupeKey: `asset-version:${APP_ASSET_VERSION}`,
        dedupeWindowMs: 500
    });
    logProcess('info', 'app.bootstrap', `Worker capabilities ready: ${[
        workerCapabilities.worker ? 'worker' : null,
        workerCapabilities.moduleWorker ? 'module-worker' : null,
        workerCapabilities.wasm ? 'wasm' : null,
        workerCapabilities.wasmSimd ? 'wasm-simd' : null,
        workerCapabilities.offscreenCanvas2d ? 'offscreen-2d' : null,
        workerCapabilities.offscreenCanvasWebgl2 ? 'offscreen-webgl2' : null,
        workerCapabilities.compressionStreams ? 'compression-streams' : null,
        workerCapabilities.fileSystemAccess ? 'fs-access' : null,
        workerCapabilities.createImageBitmap ? 'image-bitmap' : null,
        workerCapabilities.hardwareConcurrency ? `${workerCapabilities.hardwareConcurrency} cores` : null
    ].filter(Boolean).join(', ') || 'fallback-only'}.`, {
        dedupeKey: 'worker-capabilities-ready',
        dedupeWindowMs: 500
    });
    window.__modularStudioPerformance = {
        assetVersion: APP_ASSET_VERSION,
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
        processId: 'app.bootstrap',
        scope: 'boot:registry',
        replayOnWorkerCrash: true,
        maxCrashReplays: 2
    });
    store = createStore(createInitialState(activeSettings));
    engine = new NoiseStudioEngine(registry, {
        onNotice: (text, type = 'info') => setNotice(text, type),
        computeAnalysisVisuals: (payload, options = {}) => backgroundTasks.runTask('editor', 'compute-analysis-visuals', payload, {
            priority: options.priority || 'background',
            processId: options.processId || 'editor.scopes',
            scope: options.scope || 'section:editor',
            replaceKey: options.replaceKey || 'editor-analysis-visuals',
            replaceActive: options.replaceActive ?? true,
            signal: options.signal || null,
            createRequest() {
                const pixels = payload?.pixels instanceof Uint8Array
                    ? payload.pixels
                    : new Uint8Array(payload?.pixels || []);
                return {
                    payload: {
                        ...payload,
                        pixels: pixels.buffer
                    },
                    transfer: [pixels.buffer]
                };
            }
        }),
        computeDiffPreview: (payload, options = {}) => backgroundTasks.runTask('editor', 'compute-diff-preview', payload, {
            priority: options.priority || 'background',
            processId: options.processId || 'editor.preview',
            scope: options.scope || 'section:editor',
            replaceKey: options.replaceKey || `editor-diff-preview:${options.key || 'default'}`,
            replaceActive: options.replaceActive ?? true,
            signal: options.signal || null,
            createRequest() {
                const basePixels = payload?.basePixels instanceof Uint8ClampedArray
                    ? payload.basePixels
                    : new Uint8ClampedArray(payload?.basePixels || []);
                const processedPixels = payload?.processedPixels instanceof Uint8ClampedArray
                    ? payload.processedPixels
                    : new Uint8ClampedArray(payload?.processedPixels || []);
                return {
                    payload: {
                        ...payload,
                        basePixels: basePixels.buffer,
                        processedPixels: processedPixels.buffer
                    },
                    transfer: [basePixels.buffer, processedPixels.buffer]
                };
            }
        }),
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
                    : section === 'settings'
                        ? 'settings'
                    : section === 'logs'
                    ? 'logs'
                        : 'editor';
        if (nextSection !== 'editor') stopPlayback();
        syncSectionUrl(nextSection);
        if (nextSection !== currentSection && backgroundTasks && ['editor', 'stitch', '3d'].includes(currentSection)) {
            backgroundTasks.cancelScope(`section:${currentSection}`, {
                reason: `Switched away from ${currentSection === '3d' ? '3D' : currentSection}.`
            });
        }
        if (nextSection !== currentSection) {
            const sectionLabel = nextSection === '3d'
                ? '3D'
                : nextSection === 'logs'
                    ? 'Logs'
                    : nextSection === 'settings'
                        ? 'Settings'
                        : nextSection.charAt(0).toUpperCase() + nextSection.slice(1);
            logProcess('info', 'app.navigation', `Switched to ${sectionLabel}.`, {
                dedupeKey: `section:${nextSection}`,
                dedupeWindowMs: 80
            });
            if (nextSection === 'settings') {
                logProcess('info', 'settings.general', 'Opened the Settings tab.', {
                    dedupeKey: 'settings-tab-open',
                    dedupeWindowMs: 160
                });
            }
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

    async function upsertRenderedThreeDAsset(blob, documentState, options = {}) {
        if (!blob) {
            throw new Error('The 3D render finished, but no PNG data was available for the Library asset.');
        }
        const sceneDocument = normalizeThreeDDocument(documentState || store.getState().threeDDocument);
        const fileName = String(options.fileName || '3d-render.png').trim() || '3d-render.png';
        const baseName = stripProjectExtension(fileName) || getSuggestedThreeDProjectName(sceneDocument) || '3d-render';
        const activeOrigin = getActiveLibraryOrigin('3d');
        const existingAssets = await getAllLibraryAssetRecords();
        const existingAsset = activeOrigin.id
            ? existingAssets.find((asset) => asset.origin === '3d-render' && asset.sourceProjectId === activeOrigin.id) || null
            : null;
        const width = Number(options.width || sceneDocument.renderJob?.outputWidth || sceneDocument.render?.outputWidth || 0);
        const height = Number(options.height || sceneDocument.renderJob?.outputHeight || sceneDocument.render?.outputHeight || 0);
        const dataUrl = await blobToDataUrl(blob);
        const savedAsset = await saveLibraryAssetRecord({
            id: existingAsset?.id || null,
            name: existingAsset?.name || baseName,
            assetType: 'image',
            format: 'png',
            mimeType: blob.type || 'image/png',
            dataUrl,
            tags: existingAsset?.tags?.length ? existingAsset.tags : [],
            width,
            height,
            timestamp: Date.now(),
            sourceProjectId: activeOrigin.id || null,
            sourceProjectType: '3d',
            sourceProjectName: activeOrigin.name || getSuggestedThreeDProjectName(sceneDocument),
            origin: '3d-render'
        }, {
            existingAsset,
            preserveExistingName: true,
            preserveExistingTags: true
        });
        notifyLibraryChanged();
        logProcess('success', 'library.assets', `Saved the final 3D render "${savedAsset.name || baseName}" into the Assets Library.`);
        return savedAsset;
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
        await nextPaint();
        return backgroundTasks.runTask('stitch', 'prepare-input-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: 'stitch.import',
            scope: 'section:stitch',
            replaceKey: 'section:stitch:prepare-input-files',
            replaceActive: true,
            replayOnWorkerCrash: true,
            maxCrashReplays: 1,
            createRequest: ({ payload, assertNotCancelled }) => buildWorkerFileListRequest(payload.files || [], {
                assertNotCancelled
            }),
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
        if (backgroundTasks) {
            return backgroundTasks.runTask('stitch', 'build-candidate-previews', {
                document: normalized
            }, {
                priority: 'background',
                processId: 'stitch.preview',
                scope: 'section:stitch',
                replaceKey: 'section:stitch:candidate-previews',
                replaceActive: true,
                replayOnWorkerCrash: true,
                maxCrashReplays: 1
            });
        }
        return stitchEngine.buildCandidatePreviewMap(normalized);
    }

    async function runStitchPhotoRuntimeProbe(options = {}) {
        if (!backgroundTasks) {
            const diagnostics = buildStitchSettingsDiagnostics({
                workerAvailable: !!workerCapabilities?.worker,
                wasmAvailable: !!workerCapabilities?.wasm,
                runtimeAvailable: false,
                supportedDetectors: [],
                lastRuntimeSelection: '',
                lastFallbackReason: 'The shared worker broker is unavailable.'
            });
            syncStitchSettingsDiagnostics(diagnostics, { skipViewRender: true });
            if (options.log !== false) {
                logProcess('warning', 'stitch.worker', diagnostics.lastFallbackReason);
            }
            return diagnostics;
        }
        try {
            const result = await backgroundTasks.runTask('stitch-opencv', 'self-test-photo-runtime', {}, {
                priority: options.priority || 'background',
                processId: 'stitch.worker',
                scope: 'section:stitch',
                replaceKey: 'section:stitch:photo-runtime-probe',
                replaceActive: true,
                replayOnWorkerCrash: false
            });
            const diagnostics = buildStitchSettingsDiagnostics(result?.runtime || {});
            syncStitchSettingsDiagnostics(diagnostics, { skipViewRender: true });
            return diagnostics;
        } catch (error) {
            const diagnostics = buildStitchSettingsDiagnostics({
                workerAvailable: !!workerCapabilities?.worker,
                wasmAvailable: !!workerCapabilities?.wasm,
                runtimeAvailable: false,
                supportedDetectors: [],
                lastRuntimeSelection: '',
                lastFallbackReason: error?.message || 'The Stitch photo runtime probe failed.'
            });
            syncStitchSettingsDiagnostics(diagnostics, { skipViewRender: true });
            if (options.log !== false) {
                logProcess('warning', 'stitch.worker', diagnostics.lastFallbackReason, {
                    dedupeKey: `stitch-worker-probe:${diagnostics.lastFallbackReason}`,
                    dedupeWindowMs: 400
                });
            }
            return diagnostics;
        }
    }

    function syncStitchDiagnosticsFromAnalysisResult(result = null, options = {}) {
        const normalizedResult = result && typeof result === 'object' ? result : {};
        const runtime = normalizedResult.runtime && typeof normalizedResult.runtime === 'object'
            ? normalizedResult.runtime
            : {};
        const backend = String(normalizedResult.backend || runtime.lastRuntimeSelection || '').trim();
        const warning = String(normalizedResult.warning || '').trim();
        const diagnostics = buildStitchSettingsDiagnostics({
            ...runtime,
            lastRuntimeSelection: backend || runtime.lastRuntimeSelection || '',
            lastFallbackReason: normalizedResult.lastFallbackReason ?? runtime.lastFallbackReason ?? (warning && backend === 'opencv-wasm' ? warning : '')
        });
        syncStitchSettingsDiagnostics(diagnostics, options);
        return diagnostics;
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
        await nextPaint();
        const result = await backgroundTasks.runTask('three', 'prepare-model-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            scope: 'section:3d',
            replaceKey: 'section:3d:prepare-model-files',
            replaceActive: true,
            replayOnWorkerCrash: true,
            maxCrashReplays: 1,
            createRequest: ({ payload, assertNotCancelled }) => buildWorkerFileListRequest(payload.files || [], {
                assertNotCancelled
            }),
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
        await nextPaint();
        const result = await backgroundTasks.runTask('three', 'prepare-image-plane-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            scope: 'section:3d',
            replaceKey: 'section:3d:prepare-image-plane-files',
            replaceActive: true,
            replayOnWorkerCrash: true,
            maxCrashReplays: 1,
            createRequest: ({ payload, assertNotCancelled }) => buildWorkerFileListRequest(payload.files || [], {
                assertNotCancelled
            }),
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
        await nextPaint();
        const result = await backgroundTasks.runTask('three', 'prepare-font-files', {
            files: files || []
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            scope: 'section:3d',
            replaceKey: 'section:3d:prepare-font-files',
            replaceActive: true,
            replayOnWorkerCrash: true,
            maxCrashReplays: 1,
            createRequest: ({ payload, assertNotCancelled }) => buildWorkerFileListRequest(payload.files || [], {
                assertNotCancelled
            }),
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
        await nextPaint();
        const result = await backgroundTasks.runTask('three', 'prepare-hdri-file', {
            file: file || null
        }, {
            priority: 'user-visible',
            processId: '3d.assets',
            scope: 'section:3d',
            replaceKey: 'section:3d:prepare-hdri-file',
            replaceActive: true,
            replayOnWorkerCrash: true,
            maxCrashReplays: 1,
            createRequest: ({ payload, assertNotCancelled }) => buildWorkerSingleFileRequest(payload.file || null, {
                assertNotCancelled
            }),
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

        const shouldSave = await requestAppConfirmDialog(view, {
            title: `Save Current ${adapter.label}`,
            text: `Save the current ${adapter.label} project to the Library before ${actionLabel}?`,
            confirmLabel: 'Save To Library',
            cancelLabel: 'Skip Save'
        });
        if (shouldSave) {
            const saved = await actions.saveProjectToLibrary(adapter.suggestName(currentDocument), {
                forceNew: true,
                preferExisting: true,
                projectType
            });
            return !!saved;
        }
        return requestAppConfirmDialog(view, {
            title: `Continue Without Saving`,
            text: `Continue ${actionLabel} without saving the current ${adapter.label} project to the Library?`,
            confirmLabel: 'Continue',
            cancelLabel: 'Cancel',
            isDanger: true
        });
    }

    function getSettingsProcessIdForPath(path = '') {
        const normalized = String(path || '');
        if (normalized.startsWith('library.')) return 'settings.library';
        if (normalized.startsWith('editor.')) return 'settings.editor';
        if (normalized.startsWith('stitch.')) return 'settings.stitch';
        if (normalized.startsWith('threeD.')) return 'settings.3d';
        if (normalized.startsWith('logs.')) return 'settings.logs';
        return 'settings.general';
    }

    function shouldRenderForSettingsPath(path = '') {
        const normalized = String(path || '');
        return normalized === 'editor.defaultHighQualityPreview'
            || normalized === 'editor.isolateActiveLayerChain'
            || normalized === 'editor.transparencyCheckerTone';
    }

    function shouldRenderStitchForSettingsPath(path = '') {
        return String(path || '') === 'general.theme';
    }

    function describeSettingValue(value) {
        if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
        if (value == null || value === '') return 'default';
        return String(value);
    }

    function applyCurrentThreeDDefaults(document, settings = activeSettings) {
        const normalized = normalizeThreeDDocument(document);
        const defaults = settings?.threeD?.defaults || {};
        return normalizeThreeDDocument({
            ...normalized,
            render: {
                ...normalized.render,
                samplesTarget: Number(defaults.samplesTarget ?? normalized.render.samplesTarget) || normalized.render.samplesTarget,
                bounces: Number(defaults.bounces ?? normalized.render.bounces) || normalized.render.bounces,
                transmissiveBounces: Number(defaults.transmissiveBounces ?? normalized.render.transmissiveBounces) || normalized.render.transmissiveBounces,
                filterGlossyFactor: Number(defaults.filterGlossyFactor ?? normalized.render.filterGlossyFactor) || 0,
                denoiseEnabled: !!defaults.denoiseEnabled,
                denoiseSigma: Number(defaults.denoiseSigma ?? normalized.render.denoiseSigma) || normalized.render.denoiseSigma,
                denoiseThreshold: Number(defaults.denoiseThreshold ?? normalized.render.denoiseThreshold) || normalized.render.denoiseThreshold,
                denoiseKSigma: Number(defaults.denoiseKSigma ?? normalized.render.denoiseKSigma) || normalized.render.denoiseKSigma,
                toneMapping: defaults.toneMapping || normalized.render.toneMapping,
                currentSamples: 0
            }
        });
    }

    async function readStorageEstimate() {
        if (!navigator.storage?.estimate) return null;
        try {
            const estimate = await navigator.storage.estimate();
            const usage = Math.max(0, Number(estimate?.usage || 0));
            const quota = Math.max(0, Number(estimate?.quota || 0));
            return {
                usage,
                quota,
                ratio: quota > 0 ? Math.min(1, usage / quota) : 0
            };
        } catch (_error) {
            return null;
        }
    }

    function formatStorageBytes(value = 0) {
        const bytes = Math.max(0, Number(value) || 0);
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let size = bytes;
        let index = 0;
        while (size >= 1024 && index < units.length - 1) {
            size /= 1024;
            index += 1;
        }
        return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1).replace(/\.0$/, '')} ${units[index]}`;
    }

    function resetLibraryBackfillState() {
        studioProjectPreviewBackfillComplete = false;
        derivedStudioAssetBackfillComplete = false;
        imageAssetPreviewBackfillComplete = false;
    }

    function warnIfStoragePressureHigh(storageEstimate, settings = activeSettings) {
        if (!storageEstimate || !(storageEstimate.quota > 0)) return false;
        const threshold = Number(settings?.library?.storagePressureThreshold || 0.8);
        if (storageEstimate.ratio < threshold) return false;
        const message = `Library storage is at ${Math.round(storageEstimate.ratio * 100)}% of the browser quota (${formatStorageBytes(storageEstimate.usage)} of ${formatStorageBytes(storageEstimate.quota)}).`;
        logProcess('warning', 'settings.library', message, {
            dedupeKey: `storage-pressure:${Math.round(storageEstimate.ratio * 100)}`,
            dedupeWindowMs: 4000
        });
        setNotice(message, 'warning', 7000);
        return true;
    }

    async function maybeSaveCompanionImageOnSave(blob, fileName, options = {}) {
        if (!(blob instanceof Blob)) {
            return { status: 'skipped' };
        }
        const result = await saveBlobLocally(blob, fileName, {
            title: options.title || 'Save Companion PNG',
            buttonLabel: options.buttonLabel || 'Save PNG',
            filters: [{ name: 'PNG Image', extensions: ['png'] }]
        });
        if (didSaveFile(result)) {
            logProcess('success', options.processId || 'editor.export', options.successMessage || `Saved a companion image${describeSavedLocation(result)}.`);
            return {
                status: 'saved',
                ...result
            };
        }
        if (wasSaveCancelled(result)) {
            logProcess('info', options.processId || 'editor.export', options.cancelMessage || 'Cancelled the companion image save dialog.');
            return {
                status: 'cancelled',
                ...result
            };
        }
        logProcess('warning', options.processId || 'editor.export', result?.error || options.errorMessage || 'Could not save the companion image.');
        return {
            status: 'failed',
            ...result
        };
    }

    const actions = {
        getState() {
            return store.getState();
        },
        async requestConfirmDialog(options = {}) {
            return requestAppConfirmDialog(view, options);
        },
        async requestTextDialog(options = {}) {
            return requestAppTextDialog(view, options);
        },
        setSettingsCategory(category) {
            const normalizedCategory = normalizeSettingsCategory(category);
            store.setState((state) => ({
                ...state,
                ui: {
                    ...state.ui,
                    settingsCategory: normalizedCategory
                }
            }), { render: false });
            logProcess('info', getSettingsProcessIdForPath(normalizedCategory === '3d' ? 'threeD' : normalizedCategory), `Opened the ${normalizedCategory === '3d' ? '3D' : normalizedCategory.charAt(0).toUpperCase() + normalizedCategory.slice(1)} settings category.`, {
                dedupeKey: `settings-category:${normalizedCategory}`,
                dedupeWindowMs: 120
            });
        },
        async updateAppSetting(path, value) {
            const processId = getSettingsProcessIdForPath(path);
            const normalized = updateSettingsState((current) => updateSettingsPathValue(current, path, value), {
                render: shouldRenderForSettingsPath(path),
                renderStitch: shouldRenderStitchForSettingsPath(path)
            });
            logProcess('success', processId, `Set ${path} to ${describeSettingValue(value)}.`, {
                dedupeKey: `setting:${path}:${JSON.stringify(value)}`,
                dedupeWindowMs: 80
            });
            if (path.startsWith('library.')) {
                view?.refreshLibrary?.();
            }
            return normalized;
        },
        async resetSettingsCategory(category) {
            const normalizedCategory = normalizeSettingsCategory(category);
            const defaults = createDefaultAppSettings();
            const confirmed = await requestAppConfirmDialog(view, {
                title: 'Reset Category Settings',
                text: `Reset the ${normalizedCategory === '3d' ? '3D' : normalizedCategory} settings category back to its defaults?`,
                confirmLabel: 'Reset Category',
                cancelLabel: 'Cancel',
                isDanger: true
            });
            if (!confirmed) return false;
            updateSettingsState((current) => ({
                ...current,
                [normalizedCategory === '3d' ? 'threeD' : normalizedCategory]: cloneSettingsValue(defaults[normalizedCategory === '3d' ? 'threeD' : normalizedCategory])
            }), {
                render: normalizedCategory === 'editor',
                renderStitch: normalizedCategory === 'general'
            });
            logProcess('success', getSettingsProcessIdForPath(normalizedCategory === '3d' ? 'threeD' : normalizedCategory), `Reset the ${normalizedCategory === '3d' ? '3D' : normalizedCategory} settings category to defaults.`);
            if (normalizedCategory === 'library') {
                view?.refreshLibrary?.();
            }
            return true;
        },
        async resetAllSettings() {
            const confirmed = await requestAppConfirmDialog(view, {
                title: 'Reset All Settings',
                text: 'Reset every settings category back to defaults?',
                confirmLabel: 'Reset All',
                cancelLabel: 'Cancel',
                isDanger: true
            });
            if (!confirmed) return false;
            updateSettingsState(createDefaultAppSettings(), {
                render: true,
                renderStitch: true
            });
            logProcess('success', 'settings.general', 'Reset all app settings to defaults.');
            view?.refreshLibrary?.();
            return true;
        },
        async exportSettings() {
            const payload = buildSettingsExportPayload(store.getState().settings);
            const result = await saveJsonLocally(payload, 'noise-studio-settings.json', {
                title: 'Save Settings JSON',
                buttonLabel: 'Save JSON',
                filters: [{ name: 'Settings JSON', extensions: ['json'] }]
            });
            if (didSaveFile(result)) {
                logProcess('success', 'settings.general', `Exported settings to "${result.fileName || 'noise-studio-settings.json'}".`);
            } else if (wasSaveCancelled(result)) {
                logProcess('info', 'settings.general', 'Cancelled the settings export dialog.');
            } else {
                logProcess('error', 'settings.general', result?.error || 'Could not export the settings JSON.');
            }
            return result;
        },
        async importSettingsFile(file) {
            if (!file) return { status: 'cancelled' };
            try {
                const parsed = parseImportedSettingsPayload(await file.text(), { diagnostics: buildSettingsDiagnostics() });
                updateSettingsState(parsed, {
                    render: true,
                    renderStitch: true
                });
                logProcess('success', 'settings.general', `Imported settings from "${file.name}".`);
                view?.refreshLibrary?.();
                return { status: 'success' };
            } catch (error) {
                logProcess('error', 'settings.general', error?.message || 'Could not import the settings file.');
                setNotice(error?.message || 'Could not import the settings file.', 'error', 7000);
                return { status: 'failed', error: error?.message || 'Import failed.' };
            }
        },
        async refreshSettingsDiagnostics() {
            const storageEstimate = await readStorageEstimate();
            updateSettingsState((current) => current, {
                diagnostics: { storageEstimate }
            });
            warnIfStoragePressureHigh(storageEstimate);
            logProcess('info', 'settings.library', storageEstimate
                ? `Updated storage diagnostics: ${formatStorageBytes(storageEstimate.usage)} used of ${formatStorageBytes(storageEstimate.quota)}.`
                : 'Storage diagnostics are unavailable in this browser.', {
                dedupeKey: `settings-storage:${storageEstimate?.usage || 0}:${storageEstimate?.quota || 0}`,
                dedupeWindowMs: 250
            });
            return storageEstimate;
        },
        async runLibraryMaintenance(kind = '') {
            const maintenanceKind = String(kind || '').trim().toLowerCase();
            if (!maintenanceKind) {
                return { status: 'cancelled', message: 'No maintenance action was requested.' };
            }

            const descriptions = {
                'purge-rendered-previews': {
                    title: 'Purge Rendered Images',
                    text: 'Remove embedded rendered previews from saved Editor Library projects? Original images and project settings will be left intact.',
                    confirmLabel: 'Purge',
                    start: 'Purging embedded rendered previews from saved Editor Library projects.',
                    progress: 'Removing embedded rendered previews from saved Editor projects...',
                    success: (count) => count
                        ? `Purged embedded rendered previews from ${count} saved Editor project${count === 1 ? '' : 's'}.`
                        : 'No saved Editor projects had embedded rendered previews to purge.'
                },
                'heal-rendered-previews': {
                    title: 'Heal Missing Images',
                    text: 'Rebuild missing Library previews and derived assets in the background?',
                    confirmLabel: 'Heal',
                    start: 'Healing missing Library previews and derived assets.',
                    progress: 'Rebuilding missing Library previews and derived assets...',
                    success: () => 'Library preview healing completed.'
                },
                'cleanup-orphaned-assets': {
                    title: 'Cleanup Orphaned Assets',
                    text: 'Remove saved assets that still point to missing Library projects?',
                    confirmLabel: 'Cleanup',
                    start: 'Scanning the Assets Library for orphaned project-linked assets.',
                    progress: 'Removing orphaned project-linked assets...',
                    success: (count) => count
                        ? `Removed ${count} orphaned asset${count === 1 ? '' : 's'} from the Assets Library.`
                        : 'No orphaned project-linked assets were found.'
                },
                'clear-cache': {
                    title: 'Clear Library Cache',
                    text: 'Clear cached previews and rendered images from saved Library records? This keeps the core project and asset data.',
                    confirmLabel: 'Clear Cache',
                    start: 'Clearing cached Library previews and rendered images.',
                    progress: 'Removing cached Library previews...',
                    success: (_count, extra = {}) => `Cleared cached previews from ${extra.projectCount || 0} project${(extra.projectCount || 0) === 1 ? '' : 's'} and ${extra.assetCount || 0} asset${(extra.assetCount || 0) === 1 ? '' : 's'}.`
                },
                'wipe-library': {
                    title: 'Wipe Library',
                    text: 'Delete every saved Library project? This cannot be undone.',
                    confirmLabel: 'Wipe Library',
                    start: 'Deleting every saved Library project.',
                    progress: 'Deleting saved Library projects...',
                    success: (count) => count
                        ? `Deleted ${count} saved Library project${count === 1 ? '' : 's'}.`
                        : 'The Library was already empty.'
                },
                'wipe-assets': {
                    title: 'Wipe Assets',
                    text: 'Delete every saved asset from the Assets Library? This cannot be undone.',
                    confirmLabel: 'Wipe Assets',
                    start: 'Deleting every saved asset from the Assets Library.',
                    progress: 'Deleting saved Assets Library entries...',
                    success: (count) => count
                        ? `Deleted ${count} saved asset${count === 1 ? '' : 's'}.`
                        : 'The Assets Library was already empty.'
                }
            };

            const config = descriptions[maintenanceKind];
            if (!config) {
                return { status: 'failed', message: 'That maintenance action is not supported.' };
            }

            const confirmed = await requestAppConfirmDialog(view, {
                title: config.title,
                text: config.text,
                confirmLabel: config.confirmLabel,
                cancelLabel: 'Cancel',
                isDanger: maintenanceKind !== 'heal-rendered-previews'
            });
            if (!confirmed) {
                logProcess('info', 'settings.library', `Cancelled "${config.title}".`);
                return { status: 'cancelled', message: `${config.title} cancelled.` };
            }

            logProcess('active', 'settings.library', config.start);
            setNotice(config.progress, 'info', 0);
            await nextPaint();

            try {
                let changedCount = 0;
                let extraSummary = {};

                if (maintenanceKind === 'purge-rendered-previews') {
                    const projectRecords = await getAllLibraryProjectRecords();
                    const studioProjects = projectRecords.filter((entry) => getLibraryProjectType(entry) === 'studio');
                    for (let index = 0; index < studioProjects.length; index += 1) {
                        const record = studioProjects[index];
                        const payload = record?.payload && typeof record.payload === 'object'
                            ? { ...record.payload }
                            : record.payload;
                        const hadPreview = !!record?.blob || !!payload?.preview;
                        if (payload && typeof payload === 'object' && payload.preview) {
                            delete payload.preview;
                        }
                        if (hadPreview) {
                            await saveToLibraryDB({
                                ...record,
                                blob: null,
                                payload
                            });
                            changedCount += 1;
                        }
                        if (studioProjects.length) {
                            logProgressProcess('settings.library', `Purging rendered previews... ${index + 1}/${studioProjects.length}`, (index + 1) / studioProjects.length, {
                                dedupeKey: `settings-library-purge:${index}`
                            });
                        }
                        await maybeYieldToUi(index, 3);
                    }
                    resetLibraryBackfillState();
                    if (changedCount) {
                        notifyLibraryChanged();
                    }
                } else if (maintenanceKind === 'heal-rendered-previews') {
                    resetLibraryBackfillState();
                    await ensureStudioProjectPayloadPreviewsBackfilled();
                    await ensureDerivedStudioAssetsBackfilled();
                    await ensureLibraryImageAssetPreviewsBackfilled();
                } else if (maintenanceKind === 'cleanup-orphaned-assets') {
                    const [projectRecords, assetRecords] = await Promise.all([
                        getAllLibraryProjectRecords(),
                        getAllLibraryAssetRecords()
                    ]);
                    const knownProjectIds = new Set(projectRecords.map((entry) => String(entry.id || '')).filter(Boolean));
                    for (let index = 0; index < assetRecords.length; index += 1) {
                        const asset = assetRecords[index];
                        if (asset.sourceProjectId && !knownProjectIds.has(String(asset.sourceProjectId))) {
                            await deleteFromLibraryDB(asset.id);
                            changedCount += 1;
                        }
                        if (assetRecords.length) {
                            logProgressProcess('settings.library', `Checking project-linked assets... ${index + 1}/${assetRecords.length}`, (index + 1) / assetRecords.length, {
                                dedupeKey: `settings-library-orphans:${index}`
                            });
                        }
                        await maybeYieldToUi(index, 4);
                    }
                    if (changedCount) {
                        notifyLibraryChanged();
                    }
                } else if (maintenanceKind === 'clear-cache') {
                    const [projectRecords, assetRecords] = await Promise.all([
                        getAllLibraryProjectRecords(),
                        getAllLibraryAssetRecords()
                    ]);
                    let clearedProjectCount = 0;
                    let clearedAssetCount = 0;
                    for (let index = 0; index < projectRecords.length; index += 1) {
                        const record = projectRecords[index];
                        const payload = record?.payload && typeof record.payload === 'object'
                            ? { ...record.payload }
                            : record.payload;
                        const hadPreview = !!record?.blob || !!payload?.preview;
                        if (payload && typeof payload === 'object' && payload.preview) {
                            delete payload.preview;
                        }
                        if (hadPreview) {
                            await saveToLibraryDB({
                                ...record,
                                blob: null,
                                payload
                            });
                            clearedProjectCount += 1;
                        }
                        await maybeYieldToUi(index, 3);
                    }
                    for (let index = 0; index < assetRecords.length; index += 1) {
                        const asset = assetRecords[index];
                        if (asset.previewDataUrl) {
                            await saveToLibraryDB({
                                ...asset,
                                previewDataUrl: ''
                            });
                            clearedAssetCount += 1;
                        }
                        if (assetRecords.length) {
                            logProgressProcess('settings.library', `Clearing cached asset previews... ${index + 1}/${assetRecords.length}`, (index + 1) / assetRecords.length, {
                                dedupeKey: `settings-library-clear-cache:${index}`
                            });
                        }
                        await maybeYieldToUi(index, 4);
                    }
                    changedCount = clearedProjectCount + clearedAssetCount;
                    extraSummary = {
                        projectCount: clearedProjectCount,
                        assetCount: clearedAssetCount
                    };
                    resetLibraryBackfillState();
                    if (changedCount) {
                        notifyLibraryChanged();
                    }
                } else if (maintenanceKind === 'wipe-library') {
                    const projectRecords = await getAllLibraryProjectRecords();
                    changedCount = projectRecords.length;
                    await actions.clearLibraryProjects();
                    resetLibraryBackfillState();
                } else if (maintenanceKind === 'wipe-assets') {
                    const assetRecords = await getAllLibraryAssetRecords();
                    changedCount = assetRecords.length;
                    await actions.clearLibraryAssets();
                    resetLibraryBackfillState();
                }

                const storageEstimate = await readStorageEstimate();
                updateSettingsState((current) => current, {
                    diagnostics: { storageEstimate }
                });
                warnIfStoragePressureHigh(storageEstimate);
                const successMessage = config.success(changedCount, extraSummary);
                logProcess('success', 'settings.library', successMessage);
                setNotice(successMessage, 'success', 5200);
                return { status: 'success', message: successMessage };
            } catch (error) {
                console.error(error);
                const message = error?.message || `Could not finish "${config.title}".`;
                logProcess('error', 'settings.library', message);
                setNotice(message, 'error', 7000);
                return { status: 'failed', message };
            }
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
            return actions.updateAppSetting('general.theme', enabled ? 'dark' : 'light');
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
                const next = applyEditorSettingsToLayerInstance(
                    createLayerInstance(registry, layerId, document.layerStack),
                    store.getState().settings
                );
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
                const duplicate = applyEditorSettingsToLayerInstance(
                    createLayerInstance(registry, original.layerId, document.layerStack),
                    store.getState().settings
                );
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
            return actions.updateAppSetting('editor.defaultHighQualityPreview', !!enabled);
        },
        setHoverCompareEnabled(enabled) {
            return actions.updateAppSetting('editor.hoverCompareOriginal', !!enabled);
        },
        setRenderUpToActiveLayer(enabled) {
            return actions.updateAppSetting('editor.isolateActiveLayerChain', !!enabled);
        },
        toggleLayerPreviews() {
            const current = !!store.getState().settings?.editor?.layerPreviewsOpen;
            return actions.updateAppSetting('editor.layerPreviewsOpen', !current);
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
            clearWorkspaceProgress('stitch');
            updateStitchDocument(() => createSettingsDrivenStitchDocument(store.getState().settings), { renderStitch: true });
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
            logProcess('active', 'stitch.import', `Importing ${totalFiles || files.length} image${(totalFiles || files.length) === 1 ? '' : 's'} into Stitch.`);
            await showWorkspaceProgress('stitch', {
                title: 'Importing Images',
                message: totalFiles
                    ? `Reading 1 of ${totalFiles} selected image${totalFiles === 1 ? '' : 's'}...`
                    : 'Preparing selected Stitch images...',
                progress: 0.08
            });
            try {
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
                        logProgressProcess('stitch.import', message || `Reading "${file?.name || 'image'}"...`, ratio, {
                            dedupeKey: `stitch-import:${file?.name || index}:${Math.round(ratio * 1000)}`,
                            dedupeWindowMs: 80
                        });
                    }
                });
                if (!nextInputs.length) {
                    clearWorkspaceProgress('stitch');
                    logProcess('warning', 'stitch.import', failures.length
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
                logProcess(failures.length ? 'warning' : 'success', 'stitch.import', failures.length
                    ? `Added ${nextInputs.length} Stitch input${nextInputs.length === 1 ? '' : 's'} and skipped ${failures.length} unreadable file${failures.length === 1 ? '' : 's'}.`
                    : `Added ${nextInputs.length} Stitch input${nextInputs.length === 1 ? '' : 's'}.`);
                setNotice(
                    failures.length
                        ? `Added ${nextInputs.length} image${nextInputs.length === 1 ? '' : 's'} to Stitch. Skipped ${failures.length} file${failures.length === 1 ? '' : 's'} that could not be read.`
                        : `Added ${nextInputs.length} image${nextInputs.length === 1 ? '' : 's'} to Stitch.`,
                    failures.length ? 'warning' : 'success',
                    failures.length ? 7000 : 4200
                );
            } catch (error) {
                clearWorkspaceProgress('stitch');
                if (isAbortError(error)) return;
                logProcess('error', 'stitch.import', error?.message || 'Could not import the selected Stitch images.');
                setNotice(error?.message || 'Could not import the selected Stitch images.', 'error', 7000);
            }
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
                        progressMessage: '',
                        runId: 0,
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
            if ((snapshot.settings?.sceneMode || 'auto') !== 'screenshot') {
                await runStitchPhotoRuntimeProbe({ log: false, priority: 'user-visible' });
            }
            await showWorkspaceProgress('stitch', {
                title: 'Running Analysis',
                message: `Preparing Stitch analysis for ${snapshot.inputs.length} image${snapshot.inputs.length === 1 ? '' : 's'}...`,
                progress: 0.06
            });
            updateStitchDocument((document) => normalizeStitchDocument({
                ...document,
                candidates: [],
                activeCandidateId: null,
                workspace: {
                    ...document.workspace,
                    galleryOpen: false,
                    alternativesOpen: document.workspace?.alternativesOpen !== false
                },
                analysis: {
                    ...document.analysis,
                    status: 'running',
                    progressMessage: '',
                    runId: token,
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
                            if (document.analysis?.status !== 'running' || document.analysis?.runId !== token) return document;
                            return normalizeStitchDocument({
                                ...document,
                                analysis: {
                                    ...document.analysis,
                                    progressMessage: message
                                }
                            });
                        }, { renderStitch: true });
                    }
                });
                if (token !== stitchAnalysisToken) return;
                syncStitchDiagnosticsFromAnalysisResult(result, {
                    render: false,
                    renderStitch: false,
                    skipViewRender: false
                });
                if (result.backend) {
                    logProcess('info', 'stitch.analysis', `Stitch selected the ${result.backend === 'opencv-wasm' ? 'photo/OpenCV' : 'screenshot'} backend.`, {
                        dedupeKey: `stitch-backend:${token}:${result.backend}`,
                        dedupeWindowMs: 120
                    });
                }
                if (result.detectorLabel) {
                    logProcess('info', 'stitch.worker', `Stitch photo analysis used ${result.detectorLabel} features.`, {
                        dedupeKey: `stitch-detector:${token}:${result.detectorLabel}`,
                        dedupeWindowMs: 120
                    });
                }
                setStitchProgress({
                    active: true,
                    title: 'Running Analysis',
                    message: 'Rendering candidate previews for the gallery...',
                    progress: 0.9
                });
                logProcess('active', 'stitch.preview', 'Rendering candidate previews for the gallery.', {
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
                const previewStartedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
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
                logProcess('success', 'stitch.preview', `Rendered ${Object.keys(previews || {}).length} Stitch candidate preview${Object.keys(previews || {}).length === 1 ? '' : 's'} in ${Math.max(0, Math.round((typeof performance?.now === 'function' ? performance.now() : Date.now()) - previewStartedAt))}ms.`);
                logProcess(result.warning ? 'warning' : 'success', 'stitch.analysis', result.warning || 'Stitch analysis completed and candidates are ready.');
                setNotice(result.warning || 'Stitch analysis is ready.', result.warning ? 'warning' : 'success');
            } catch (error) {
                if (token !== stitchAnalysisToken) return;
                clearWorkspaceProgress('stitch');
                syncStitchDiagnosticsFromAnalysisResult({
                    runtime: error?.details?.runtime || null,
                    backend: '',
                    warning: '',
                    lastFallbackReason: error?.details?.fallbackReason || error?.message || 'The Stitch analysis failed.'
                }, {
                    render: false,
                    renderStitch: false,
                    skipViewRender: false
                });
                updateStitchDocument((document) => ({
                    ...document,
                    analysis: {
                        ...document.analysis,
                        status: 'error',
                        progressMessage: '',
                        runId: 0,
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
            if (store.getState().stitchDocument?.analysis?.status === 'running') return;
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
            if (store.getState().stitchDocument?.analysis?.status === 'running') return;
            stitchAnalysisToken += 1;
            updateStitchDocument((document) => {
                const normalized = normalizeStitchDocument(document);
                const nextInputs = normalized.inputs.filter((input) => input.id !== inputId);
                const nextPlacements = normalized.placements.filter((placement) => placement.inputId !== inputId);
                const nextSelection = normalized.selection.inputId === inputId
                    ? { inputId: nextInputs[0]?.id || null }
                    : normalized.selection;
                return invalidateStitchAnalysis({
                    ...normalized,
                    inputs: nextInputs,
                    placements: nextPlacements,
                    selection: nextSelection
                }, {
                    warning: nextInputs.length > 1 ? 'Run the analysis again after removing images.' : ''
                });
            }, { renderStitch: true });
            logProcess('info', 'stitch.import', 'Removed an input image from the Stitch workspace.');
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
            if (store.getState().stitchDocument?.analysis?.status === 'running') return;
            updateStitchDocument((document) => updateStitchInputOrderHelper(document, inputId, direction), { renderStitch: true });
        },
        updateStitchPlacement(inputId, patch, meta = { renderStitch: true }) {
            if (!inputId || !patch || typeof patch !== 'object') return;
            if (store.getState().stitchDocument?.analysis?.status === 'running') return;
            updateStitchDocument((document) => updateStitchPlacementHelper(document, inputId, patch), meta);
        },
        updateStitchSetting(key, value) {
            if (!key) return;
            const nextValue = coerceStitchSettingValue(key, value);
            updateStitchDocument((document) => invalidateStitchAnalysis({
                ...document,
                settings: {
                    ...document.settings,
                    [key]: nextValue
                }
            }, {
                warning: key === 'useFullResolutionAnalysis' && nextValue
                    ? 'Full-resolution analysis is enabled. It can be slower, but it may help on screenshots and UI captures.'
                    : 'Stitch settings changed. Run the analysis again to refresh the ranked candidates.'
            }), { renderStitch: true });
            logProcess('success', 'stitch.settings', `Set Stitch ${key} to ${describeSettingValue(nextValue)}.`, {
                dedupeKey: `stitch-setting:${key}:${JSON.stringify(nextValue)}`,
                dedupeWindowMs: 80
            });
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
                logProcess('warning', 'stitch.export', 'Blocked Stitch PNG export because the workspace has no inputs.');
                setNotice('Add images to the Stitch workspace before exporting.', 'warning');
                return;
            }
            const exportStartedAt = typeof performance?.now === 'function' ? performance.now() : Date.now();
            await showWorkspaceProgress('stitch', {
                title: 'Exporting PNG',
                message: 'Rendering the stitched composite to PNG...',
                progress: 0.16
            });
            logProcess('active', 'stitch.export', 'Rendering the stitched composite to PNG.');
            try {
                const blob = await stitchEngine.exportPngBlob(documentState);
                const baseName = getSuggestedStitchProjectName(documentState).replace(/\.[^/.]+$/, '') || 'stitch-project';
                setStitchProgress({
                    active: true,
                    title: 'Exporting PNG',
                    message: `Writing "${baseName}-stitched.png"...`,
                    progress: 0.9
                });
                const saveResult = await saveBlobLocally(blob, `${baseName}-stitched.png`, {
                    title: 'Save Stitch PNG',
                    buttonLabel: 'Save PNG',
                    filters: [{ name: 'PNG Image', extensions: ['png'] }]
                });
                clearWorkspaceProgress('stitch');
                if (wasSaveCancelled(saveResult)) {
                    logProcess('info', 'stitch.export', 'Cancelled the Stitch PNG save dialog.');
                    setNotice('Stitch PNG save cancelled.', 'info', 4200);
                    return;
                }
                if (!didSaveFile(saveResult)) {
                    throw new Error(saveResult?.error || 'Could not save the Stitch PNG.');
                }
                logProcess('success', 'stitch.export', `Exported Stitch PNG "${baseName}-stitched.png" in ${Math.max(0, Math.round((typeof performance?.now === 'function' ? performance.now() : Date.now()) - exportStartedAt))}ms.`);
                setNotice('Stitch PNG export complete.', 'success');
            } catch (error) {
                clearWorkspaceProgress('stitch');
                logProcess('error', 'stitch.export', error?.message || 'Could not export the Stitch PNG.');
                setNotice(error?.message || 'Could not export the Stitch PNG.', 'error', 7000);
            }
        },
        updateInstance,
        armEyedropper(target) {
            store.setState((state) => ({ ...state, eyedropperTarget: target, notice: { text: 'Click the preview to sample a color.', type: 'info' } }), { render: false });
        },
        async extractPaletteFromFile(file) {
            if (!file) return;
            const state = store.getState();
            const owner = state.document.selection.layerInstanceId;
            const selected = state.document.layerStack.find((instance) => instance.instanceId === owner && instance.layerId === 'palette');
            const extractCount = Number(selected?.params.extractCount || 8);
            try {
                let paletteResult;
                if (backgroundTasks) {
                    const { fileEntry, transfer } = await createWorkerSingleFileEntry(file);
                    paletteResult = await backgroundTasks.runTask('editor', 'extract-palette-from-image', {
                        file,
                        fileEntry,
                        count: extractCount
                    }, {
                        priority: 'user-visible',
                        processId: 'editor.palette',
                        scope: 'section:editor',
                        replaceKey: 'editor-palette-extract',
                        replaceActive: true,
                        replayOnWorkerCrash: false,
                        createRequest() {
                            return {
                                payload: {
                                    fileEntry,
                                    count: extractCount
                                },
                                transfer
                            };
                        }
                    });
                } else {
                    paletteResult = await extractPaletteFromFileFallback(file, extractCount);
                }

                const dataUrl = await fileToDataUrl(file);
                const image = await loadImageFromDataUrl(dataUrl);
                paletteExtractionImage = image;
                paletteExtractionOwner = selected?.instanceId || null;
                updateDocument((document) => ({
                    ...document,
                    palette: Array.isArray(paletteResult?.palette) && paletteResult.palette.length
                        ? paletteResult.palette
                        : createPaletteFromImage(image, extractCount)
                }));

                if (paletteResult?.runtime?.selection) {
                    logProcess('info', 'editor.palette', `Extracted ${Math.max(0, paletteResult.palette?.length || 0)} palette color${(paletteResult.palette?.length || 0) === 1 ? '' : 's'} via ${paletteResult.runtime.selection}.`, {
                        dedupeKey: `editor-palette-runtime:${paletteResult.runtime.selection}`,
                        dedupeWindowMs: 400
                    });
                }
            } catch (error) {
                logProcess('error', 'editor.palette', error?.message || 'Could not extract a palette from that image.');
                setNotice(error?.message || 'Could not extract a palette from that image.', 'error', 6000);
            }
        },
        async saveProjectToLibrary(nameOverride = null, optionsOrForceNew = false) {
            const options = typeof optionsOrForceNew === 'object' && optionsOrForceNew !== null
                ? optionsOrForceNew
                : { forceNew: !!optionsOrForceNew };
            const forceNew = !!options.forceNew;
            const preferExisting = !!options.preferExisting;
            const promptless = !!options.promptless;
            const suppressNotice = !!options.suppressNotice;
            const suppressWorkspaceOverlay = !!options.suppressWorkspaceOverlay;
            const updateActiveOriginSilently = (id, name) => {
                setActiveLibraryOrigin(projectType, id, name);
            };
            const showLibraryNotice = (...args) => {
                if (!suppressNotice) {
                    setNotice(...args);
                }
            };
            const state = store.getState();
            const projectType = options.projectType || getProjectTypeForSection(state.ui.activeSection);
            if (projectType === '3d' && isThreeDRenderJobActive()) {
                logProcess('warning', 'library.projects', 'Blocked Library save because a 3D render is still active.');
                showLibraryNotice('Abort the active 3D render before saving this scene to the Library.', 'warning', 6000);
                return null;
            }
            const adapter = projectAdapters?.getAdapter(projectType);
            if (!adapter) {
                logProcess('error', 'library.projects', `No Library project adapter is available for "${projectType}".`);
                showLibraryNotice('This project type cannot be saved to the Library yet.', 'error', 7000);
                return null;
            }
            const currentDocument = adapter.getCurrentDocument(state);
            if (adapter.isEmpty(currentDocument) || !adapter.canSave(currentDocument)) {
                logProcess('warning', 'library.projects', adapter.emptyNotice || `Blocked ${adapter.label} save because the project is empty.`);
                showLibraryNotice(adapter.emptyNotice || `There is no ${adapter.label} project ready to save.`, 'warning');
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
                updateActiveOriginSilently(reusableMatch.id, reusableMatch.name);
                logProcess('info', 'library.projects', wasActiveMatch
                    ? `Skipped save because the current ${adapter.label} project already matches "${reusableMatch.name}".`
                    : `Reused existing Library entry "${reusableMatch.name}" for the current ${adapter.label} project.`);
                showLibraryNotice(
                    wasActiveMatch
                        ? 'Already saved - no changes detected.'
                        : `Already in Library as "${reusableMatch.name}".`,
                    'info'
                );
                return reusableMatch;
            }

            let name;
            let saveId;

            if (promptless) {
                if (!forceNew && activeOrigin.id) {
                    saveId = activeOrigin.id;
                    name = activeOrigin.name || adapter.suggestName(currentDocument, nameOverride);
                } else {
                    name = adapter.suggestName(currentDocument, nameOverride);
                    saveId = createLibraryProjectId();
                }
            } else if (!forceNew && activeOrigin.id) {
                const defaultName = activeOrigin.name || adapter.suggestName(currentDocument, nameOverride);
                const choice = await requestAppTextDialog(view, {
                    title: `Save ${adapter.label} To Library`,
                    text: activeMatch
                        ? `This project already matches "${defaultName}". Leave the name as-is to keep that saved version, or enter a new name to save a new Library entry.`
                        : `This project was loaded from "${defaultName}". Leave the name as-is to overwrite that Library entry, or enter a new name to save a new one.`,
                    fieldLabel: `${adapter.label} name`,
                    defaultValue: defaultName,
                    confirmLabel: activeMatch ? 'Keep Or Save' : 'Overwrite Or Save',
                    cancelLabel: 'Cancel'
                });
                if (choice === null) return null;
                const trimmedChoice = String(choice || '').trim();
                if (!trimmedChoice) return null;
                if (normalizeComparableLabel(trimmedChoice) === normalizeComparableLabel(defaultName)) {
                    if (activeMatch) {
                        logProcess('info', 'library.projects', `Skipped save because "${defaultName}" already matches the current ${adapter.label} project.`);
                        showLibraryNotice('Already saved - no changes detected.', 'info');
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
                const askedName = await requestAppTextDialog(view, {
                    title: `Name Your ${adapter.label} Library Entry`,
                    text: 'Choose a name for this Library save.',
                    fieldLabel: `${adapter.label} name`,
                    defaultValue: defaultName,
                    confirmLabel: 'Save To Library',
                    cancelLabel: 'Cancel'
                });
                if (askedName === null) return null;
                name = String(askedName || '').trim();
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
                showLibraryNotice('Saving to Library...', 'info', 0);
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
                updateActiveOriginSilently(saveId, name);
                logProcess('success', 'library.projects', `Saved "${name}" to the Library as a ${adapter.label} project.`);
                showLibraryNotice(`Saved "${name}" to Library.`, 'success');
                notifyLibraryChanged();
                clearWorkspaceProgress(projectType);
                return projectData;
            } catch (error) {
                console.error(error);
                clearWorkspaceProgress(projectType);
                logProcess('error', 'library.projects', error?.message || `Could not save the ${adapter.label} project to the Library.`);
                showLibraryNotice(error?.message || 'Could not save that project to the Library.', 'error', 7000);
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
            resetLibraryBackfillState();
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
            resetLibraryBackfillState();
            notifyLibraryChanged();
        },
        async buildSecureLibraryExportRecord(bundle, options = {}) {
            if (!bundle || typeof bundle !== 'object') {
                throw new Error('No Library export payload was provided.');
            }
            const request = {
                bundle,
                secureMode: options.secureMode || 'compressed',
                passphrase: options.passphrase || '',
                compatibilityMode: options.compatibilityMode || 'fast'
            };
            const result = backgroundTasks
                ? await backgroundTasks.runTask('app-library', 'build-secure-library-export-record', request, {
                    priority: 'user-visible',
                    processId: 'library.export',
                    scope: 'section:library',
                    replaceKey: 'library-secure-export-record',
                    replaceActive: true,
                    replayOnWorkerCrash: false
                })
                : await buildSecureLibraryExportRecordFallback(bundle, request);
            if (result?.runtime?.selection) {
                logProcess(result.runtime.selection === 'js-fallback' ? 'warning' : 'info', 'library.export', `Secure Library export packaging used ${result.runtime.selection}.${result.runtime.fallbackReason ? ` ${result.runtime.fallbackReason}` : ''}`, {
                    dedupeKey: `library-export-runtime:${result.runtime.selection}`,
                    dedupeWindowMs: 400
                });
            }
            return result;
        },
        async resolveSecureLibraryImportRecord(parsed, passphrase = '', options = {}) {
            if (!parsed || typeof parsed !== 'object') {
                throw new Error('No secure Library import payload was provided.');
            }
            const result = backgroundTasks
                ? await backgroundTasks.runTask('app-library', 'resolve-secure-library-import-record', {
                    parsed,
                    passphrase: passphrase || '',
                    compatibilityMode: options.compatibilityMode || 'fast'
                }, {
                    priority: 'user-visible',
                    processId: 'library.import',
                    scope: 'section:library',
                    replaceKey: 'library-secure-import-record',
                    replaceActive: true,
                    replayOnWorkerCrash: false
                })
                : await resolveSecureLibraryImportRecordFallback(parsed, passphrase || '', {
                    compatibilityMode: options.compatibilityMode || 'fast'
                });
            if (result?.runtime?.selection) {
                logProcess(result.runtime.selection === 'js-fallback' ? 'warning' : 'info', 'library.import', `Secure Library import decoding used ${result.runtime.selection}.${result.runtime.fallbackReason ? ` ${result.runtime.fallbackReason}` : ''}`, {
                    dedupeKey: `library-import-runtime:${result.runtime.selection}`,
                    dedupeWindowMs: 400
                });
            }
            return result;
        },
        async importLibraryAssets(assetEntries = []) {
            const existingAssets = await getAllLibraryAssetRecords();
            const nextAssets = [...existingAssets];
            const importedAssets = [];
            const updatedAssets = [];
            let skippedDuplicateCount = 0;
            let rejectedCount = 0;
            if (assetEntries.length) {
                logProcess('active', 'library.import', `Importing ${assetEntries.length} asset${assetEntries.length === 1 ? '' : 's'} into the Assets Library.`);
            }
            for (let index = 0; index < (assetEntries || []).length; index += 1) {
                const entry = assetEntries[index];
                const normalizedType = normalizeLibraryAssetType(entry.assetType || entry.type || 'image');
                const dataUrl = String(entry.dataUrl || '');
                if (!dataUrl) {
                    rejectedCount += 1;
                    logProcess('warning', 'library.import', `Rejected "${entry.name || `asset ${index + 1}`}" because it did not include any embedded asset data.`);
                    continue;
                }
                const fingerprint = entry.assetFingerprint || await computeLibraryAssetFingerprintInBackground({
                    assetType: normalizedType,
                    format: entry.format,
                    mimeType: entry.mimeType,
                    dataUrl
                });
                const duplicateAsset = nextAssets.find((asset) => asset.assetFingerprint === fingerprint) || null;
                if (duplicateAsset) {
                    skippedDuplicateCount += 1;
                    logProcess('info', 'library.import', `Skipped duplicate asset "${entry.name || `asset ${index + 1}`}" during import.`, {
                        dedupeKey: `library-asset-duplicate:${entry.name || index}:${fingerprint}`,
                        dedupeWindowMs: 200
                    });
                    continue;
                }
                const existingBySourceProject = entry.sourceProjectId
                    ? nextAssets.find((asset) => asset.sourceProjectId === String(entry.sourceProjectId)) || null
                    : null;
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
                }, existingBySourceProject
                    ? {
                        existingAsset: existingBySourceProject,
                        preserveExistingName: true,
                        preserveExistingTags: true
                    }
                    : {});
                if (existingBySourceProject) {
                    const replaceIndex = nextAssets.findIndex((asset) => asset.id === existingBySourceProject.id);
                    if (replaceIndex >= 0) nextAssets.splice(replaceIndex, 1, savedAsset);
                    updatedAssets.push(savedAsset);
                    logProcess('info', 'library.import', `Updated existing asset "${savedAsset.name || entry.name || `asset ${index + 1}`}" from the import payload.`);
                } else {
                    nextAssets.push(savedAsset);
                    importedAssets.push(savedAsset);
                }
                await maybeYieldToUi(index, 2);
            }
            notifyLibraryChanged();
            if (assetEntries.length) {
                const summaryBits = [];
                if (importedAssets.length) summaryBits.push(`saved ${importedAssets.length}`);
                if (updatedAssets.length) summaryBits.push(`updated ${updatedAssets.length}`);
                if (skippedDuplicateCount) summaryBits.push(`skipped ${skippedDuplicateCount} duplicate${skippedDuplicateCount === 1 ? '' : 's'}`);
                if (rejectedCount) summaryBits.push(`rejected ${rejectedCount} invalid asset${rejectedCount === 1 ? '' : 's'}`);
                logProcess(
                    rejectedCount || (!importedAssets.length && !updatedAssets.length) ? 'warning' : 'success',
                    'library.import',
                    summaryBits.length
                        ? `Assets import summary: ${summaryBits.join(', ')}.`
                        : 'Assets import completed with no changes.'
                );
            }
            return {
                importedAssets,
                updatedAssets,
                savedCount: importedAssets.length,
                updatedCount: updatedAssets.length,
                skippedDuplicateCount,
                rejectedCount,
                totalRequested: assetEntries.length,
                importedIds: importedAssets.map((asset) => asset.id),
                updatedIds: updatedAssets.map((asset) => asset.id)
            };
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
                setNotice(error?.message || 'Failed to load project from Library', 'error', 7000);
                throw error;
            }
        },
        async newProject() {
            if (!await ensureProjectCanBeReplaced('studio', 'starting a new project')) return;
            stopPlayback();
            paletteExtractionImage = null;
            paletteExtractionOwner = null;
            updateDocument((document) => applyEditorSettingsToDocument({
                ...document,
                source: { width: 0, height: 0, name: '', imageData: null },
                layerStack: [],
                palette: [],
                selection: { layerInstanceId: null },
                workspace: { ...document.workspace, batchOpen: false },
                batch: createEmptyBatchState()
            }, store.getState().settings), { render: false });
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
                if (store.getState().settings.editor.autoExtractPaletteOnLoad) {
                    logProcess('info', 'settings.editor', `Auto-extracting a palette from "${file.name}" because Editor auto palette extraction is enabled.`, {
                        dedupeKey: `auto-palette:${file.name}`,
                        dedupeWindowMs: 120
                    });
                    await actions.extractPaletteFromFile(file);
                }
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
                await nextPaint();
                const parsedState = backgroundTasks
                    ? await backgroundTasks.runTask('editor', 'read-studio-state-file', {
                        file
                    }, {
                        priority: 'user-visible',
                        processId: 'editor.files',
                        scope: 'section:editor',
                        replaceKey: 'section:editor:read-studio-state-file',
                        replaceActive: true,
                        replayOnWorkerCrash: true,
                        maxCrashReplays: 1,
                        createRequest: ({ payload, assertNotCancelled }) => buildWorkerSingleFileRequest(payload.file || null, {
                            assertNotCancelled
                        })
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
                    document: applyEditorSettingsToDocument({
                        ...current.document,
                        ...payloadWithoutPreview,
                        version: 'mns/v2',
                        kind: 'document',
                        mode: 'studio',
                        workspace: normalizeWorkspace('studio', payloadWithoutPreview.workspace || current.document.workspace, !!selection.layerInstanceId),
                        source: preservedSource,
                        palette: payloadWithoutPreview.palette || current.document.palette,
                        layerStack: layerStack.map((instance) => applyEditorSettingsToLayerInstance(instance, store.getState().settings)),
                        selection,
                        view: normalizeViewState({ ...current.document.view, ...(payloadWithoutPreview.view || {}) }),
                        export: { ...current.document.export, ...(payloadWithoutPreview.export || {}) },
                        batch: createEmptyBatchState()
                    }, store.getState().settings)
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
                if (isAbortError(error)) return;
                logProcess('error', 'editor.files', error?.message || `Could not load state file "${file?.name || 'document'}".`);
                setNotice(error.message, 'error', 7000);
            }
        },
        async saveState() {
            const state = store.getState();
            let preview = null;
            let previewBlob = null;
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
                    ({ preview, blob: previewBlob } = await captureStudioDocumentSnapshot(engine, state.document));
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
            const saveResult = await downloadState(state.document, {
                includeSource: true,
                preview
            });
            if (wasSaveCancelled(saveResult)) {
                clearWorkspaceProgress('studio');
                logProcess('info', 'editor.export', 'Cancelled the Editor state JSON save dialog.');
                setNotice('State save cancelled.', 'info', 4200);
                return;
            }
            if (!didSaveFile(saveResult)) {
                clearWorkspaceProgress('studio');
                logProcess('error', 'editor.export', saveResult?.error || 'Could not save the current state JSON.');
                setNotice(saveResult?.error || 'Could not save the current state JSON.', 'error', 7000);
                return;
            }

            let companionImageResult = null;
            if (state.settings.general.saveImageOnSave && previewBlob instanceof Blob) {
                setEditorProgress({
                    active: true,
                    title: 'Saving State',
                    message: 'Saving the companion processed PNG...',
                    progress: 0.93
                });
                const baseName = stripProjectExtension(saveResult.fileName || state.document.source.name || 'noise-studio-state');
                companionImageResult = await maybeSaveCompanionImageOnSave(previewBlob, `${baseName}-processed.png`, {
                    title: 'Save Companion Editor PNG',
                    processId: 'editor.export',
                    successMessage: 'Saved the companion processed PNG for the Editor state JSON.',
                    cancelMessage: 'Cancelled the companion processed PNG save dialog after saving the state JSON.',
                    errorMessage: 'Could not save the companion processed PNG.'
                });
            }

            let libraryProject = null;
            if (state.document.source?.imageData) {
                setEditorProgress({
                    active: true,
                    title: 'Saving State',
                    message: 'Updating the linked Library project...',
                    progress: 0.96
                });
                libraryProject = await actions.saveProjectToLibrary(
                    stripProjectExtension(saveResult.fileName || state.document.source.name || 'noise-studio-state'),
                    {
                        preferExisting: true,
                        promptless: true,
                        projectType: 'studio',
                        suppressWorkspaceOverlay: true,
                        suppressNotice: true
                    }
                );
            }

            if (!state.document.source?.imageData) {
                clearWorkspaceProgress('studio');
                logProcess('warning', 'editor.export', 'Saved state JSON without an embeddable source image or rendered preview.');
                setNotice('State saved, but no embeddable source image was available.', 'warning', 7000);
                return;
            }
            if (!preview) {
                clearWorkspaceProgress('studio');
                if (libraryProject) {
                    logProcess('warning', 'editor.export', 'Saved state JSON without a captured rendered preview, but the Library project still updated.');
                    setNotice('State saved and Library sync completed, but the current rendered preview could not be embedded.', 'warning', 7000);
                    return;
                }
                logProcess('warning', 'editor.export', 'Saved state JSON without a captured rendered preview.');
                setNotice('State saved, but the current rendered preview could not be embedded.', 'warning', 7000);
                return;
            }
            clearWorkspaceProgress('studio');
            if (!libraryProject) {
                logProcess('warning', 'editor.export', 'Saved self-contained state JSON locally, but could not update the matching Library project.');
                setNotice('State saved locally, but the matching Library project could not be updated.', 'warning', 7000);
                return;
            }
            logProcess('success', 'editor.export', 'Saved self-contained state JSON from the Editor.');
            setNotice(companionImageResult?.status === 'failed'
                ? 'State saved and synced to Library, but the companion processed PNG could not be saved.'
                : 'State saved locally and synced to Library.', companionImageResult?.status === 'failed' ? 'warning' : 'success');
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
                const saveResult = await saveBlobLocally(blob, `${baseName}-processed.png`, {
                    title: 'Save Editor PNG',
                    buttonLabel: 'Save PNG',
                    filters: [{ name: 'PNG Image', extensions: ['png'] }]
                });
                clearWorkspaceProgress('studio');
                if (wasSaveCancelled(saveResult)) {
                    logProcess('info', 'editor.export', 'Cancelled the Editor PNG save dialog.');
                    setNotice('PNG save cancelled.', 'info', 4200);
                    return;
                }
                if (!didSaveFile(saveResult)) {
                    throw new Error(saveResult?.error || 'Could not save the current Editor PNG.');
                }
                logProcess('success', 'editor.export', `Exported PNG "${baseName}-processed.png" from the Editor.`);
                setNotice('PNG export complete.', 'success');
            } catch (error) {
                clearWorkspaceProgress('studio');
                logProcess('error', 'editor.export', error?.message || 'Could not export the current Editor PNG.');
                setNotice(error?.message || 'Could not export the current Editor PNG.', 'error', 7000);
            }
        },
        async persistThreeDRenderSave(blob, fileName, options = {}) {
            const saveResult = await saveBlobLocally(blob, fileName, {
                title: 'Save 3D Render PNG',
                buttonLabel: 'Save PNG',
                filters: [{ name: 'PNG Image', extensions: ['png'] }]
            });
            if (!didSaveFile(saveResult)) {
                return saveResult;
            }
            try {
                await upsertRenderedThreeDAsset(blob, options.documentState || store.getState().threeDDocument, {
                    fileName,
                    width: options.width,
                    height: options.height
                });
                return {
                    ...saveResult,
                    libraryStatus: 'saved'
                };
            } catch (error) {
                console.error(error);
                logProcess('warning', '3d.render', `Saved the final 3D render locally${describeSavedLocation(saveResult)}, but could not update the Assets Library: ${error?.message || 'Unknown Library error.'}`);
                return {
                    ...saveResult,
                    libraryStatus: 'failed',
                    libraryError: error?.message || 'Could not update the Assets Library.'
                };
            }
        },
        async exportThreeDSceneJson() {
            if (isThreeDRenderJobActive()) {
                logProcess('warning', '3d.export', 'Blocked 3D scene JSON save because a render is still active.');
                setNotice('Abort the active 3D render before saving the current 3D scene JSON.', 'warning', 6000);
                return null;
            }
            const adapter = projectAdapters?.getAdapter('3d');
            const documentState = store.getState().threeDDocument;
            if (!adapter || adapter.isEmpty(documentState) || !adapter.canSave(documentState)) {
                logProcess('warning', '3d.export', 'Blocked 3D scene JSON save because the scene is empty.');
                setNotice('Add at least one 3D asset to the scene before saving a 3D JSON file.', 'warning', 6000);
                return null;
            }

            const suggestedName = `${adapter.suggestName(documentState) || '3d-scene'}.json`;
            await showWorkspaceProgress('3d', {
                title: 'Saving 3D JSON',
                message: 'Capturing the current 3D scene...',
                progress: 0.14
            });
            logProcess('active', '3d.export', `Preparing "${suggestedName}" for local 3D JSON save.`);
            try {
                const capture = await adapter.captureDocument(documentState);
                setThreeDProgress({
                    active: true,
                    title: 'Saving 3D JSON',
                    message: `Writing "${suggestedName}"...`,
                    progress: 0.9
                });
                const saveResult = await saveJsonLocally(capture.payload, suggestedName, {
                    title: 'Save 3D Scene JSON',
                    buttonLabel: 'Save JSON',
                    filters: [{ name: '3D Scene JSON', extensions: ['json'] }]
                });
                if (wasSaveCancelled(saveResult)) {
                    clearWorkspaceProgress('3d');
                    logProcess('info', '3d.export', 'Cancelled the 3D scene JSON save dialog.');
                    setNotice('3D scene JSON save cancelled.', 'info', 4200);
                    return null;
                }
                if (!didSaveFile(saveResult)) {
                    throw new Error(saveResult?.error || 'Could not save the 3D scene JSON.');
                }
                let companionImageResult = null;
                if (store.getState().settings.general.saveImageOnSave && capture.blob instanceof Blob) {
                    setThreeDProgress({
                        active: true,
                        title: 'Saving 3D JSON',
                        message: 'Saving the companion 3D preview PNG...',
                        progress: 0.94
                    });
                    const baseName = stripProjectExtension(saveResult.fileName || suggestedName);
                    companionImageResult = await maybeSaveCompanionImageOnSave(capture.blob, `${baseName}-preview.png`, {
                        title: 'Save Companion 3D Preview PNG',
                        processId: '3d.export',
                        successMessage: 'Saved the companion 3D preview PNG for the scene JSON.',
                        cancelMessage: 'Cancelled the companion 3D preview PNG save dialog after saving the scene JSON.',
                        errorMessage: 'Could not save the companion 3D preview PNG.'
                    });
                }
                setThreeDProgress({
                    active: true,
                    title: 'Saving 3D JSON',
                    message: 'Updating the matching Library project...',
                    progress: 0.97
                });
                const libraryProject = await actions.saveProjectToLibrary(stripProjectExtension(saveResult.fileName || suggestedName), {
                    preferExisting: true,
                    promptless: true,
                    projectType: '3d',
                    suppressWorkspaceOverlay: true,
                    suppressNotice: true
                });
                clearWorkspaceProgress('3d');
                logProcess('success', '3d.export', `Saved "${suggestedName}" as a local 3D scene JSON${describeSavedLocation(saveResult)}.`);
                if (!libraryProject) {
                    logProcess('warning', '3d.export', 'Saved the 3D scene JSON locally, but could not update the matching Library project.');
                    setNotice('3D scene JSON saved locally, but the matching Library project could not be updated.', 'warning', 7000);
                    return saveResult;
                }
                setNotice(companionImageResult?.status === 'failed'
                    ? '3D scene JSON saved and synced to Library, but the companion preview PNG could not be saved.'
                    : '3D scene JSON saved locally and synced to Library.', companionImageResult?.status === 'failed' ? 'warning' : 'success');
                return saveResult;
            } catch (error) {
                clearWorkspaceProgress('3d');
                logProcess('error', '3d.export', error?.message || 'Could not save the 3D scene JSON.');
                setNotice(error?.message || 'Could not save the 3D scene JSON.', 'error', 7000);
                return null;
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
            const existingProjects = await getAllLibraryProjectRecords();
            const knownFingerprints = new Set(
                existingProjects.map((entry) => `${getLibraryProjectType(entry)}:${makeProjectFingerprint(entry.payload)}`)
            );
            let savedCount = 0;
            let updatedCount = 0;
            let skippedDuplicateCount = 0;
            let rejectedCount = 0;
            let lastError = null;
            const importedTags = [];
            const importedProjectIds = [];
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
                    const fingerprintKey = `${adapter.type}:${makeProjectFingerprint(prepared.payload)}`;
                    if (knownFingerprints.has(fingerprintKey)) {
                        skippedDuplicateCount += 1;
                        logProcess('info', 'library.import', `Skipped duplicate Library project "${filenames[i] || `item ${i + 1}`}" because the same ${adapter.label} payload is already saved.`);
                        continue;
                    }
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
                    knownFingerprints.add(fingerprintKey);
                    importedTags.push(...projectData.tags);
                    savedCount += 1;
                    importedProjectIds.push(projectData.id);
                } catch (err) {
                    rejectedCount += 1;
                    lastError = err;
                    console.error(`[Library] Error processing file ${filenames[i]}:`, err);
                    logProcess('warning', 'library.import', `Skipped "${filenames[i] || `item ${i + 1}`}" during Library import: ${err?.message || 'Unknown import error.'}`);
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
            const summaryBits = [];
            if (savedCount) summaryBits.push(`saved ${savedCount}`);
            if (updatedCount) summaryBits.push(`updated ${updatedCount}`);
            if (skippedDuplicateCount) summaryBits.push(`skipped ${skippedDuplicateCount} duplicate${skippedDuplicateCount === 1 ? '' : 's'}`);
            if (rejectedCount) summaryBits.push(`rejected ${rejectedCount} invalid project${rejectedCount === 1 ? '' : 's'}`);
            logProcess(
                rejectedCount || (!savedCount && skippedDuplicateCount) ? 'warning' : (savedCount ? 'success' : 'error'),
                'library.import',
                summaryBits.length
                    ? `Library project import summary: ${summaryBits.join(', ')}.`
                    : (lastError?.message || 'No imported Library items could be saved.')
            );
            return {
                savedCount,
                updatedCount,
                skippedDuplicateCount,
                rejectedCount,
                totalRequested: payloadsText.length,
                importedTags,
                importedProjectIds
            };
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
            updateThreeDDocument(() => createSettingsDrivenThreeDDocument(store.getState().settings));
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
                if (isAbortError(error)) return;
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
                if (isAbortError(error)) return;
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
                if (isAbortError(error)) return [];
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
                if (isAbortError(error)) return null;
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
            const settingsPatch = {};
            if (Object.prototype.hasOwnProperty.call(patch, 'showGrid')) settingsPatch.showGrid = !!patch.showGrid;
            if (Object.prototype.hasOwnProperty.call(patch, 'showAxes')) settingsPatch.showAxes = !!patch.showAxes;
            if (Object.keys(settingsPatch).length) {
                updateSettingsState((current) => ({
                    ...current,
                    threeD: {
                        ...current.threeD,
                        preferences: {
                            ...current.threeD.preferences,
                            ...settingsPatch
                        }
                    }
                }));
            }
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
            const settingsPatch = {};
            ['cameraMode', 'navigationMode', 'wheelMode', 'snapTranslationStep', 'snapRotationDegrees', 'fov', 'near', 'far', 'flyMoveSpeed', 'flyLookSensitivity', 'gizmoScale', 'viewportHighResCap'].forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(patch, key)) settingsPatch[key] = patch[key];
            });
            if (Object.keys(settingsPatch).length) {
                updateSettingsState((current) => ({
                    ...current,
                    threeD: {
                        ...current.threeD,
                        preferences: {
                            ...current.threeD.preferences,
                            ...settingsPatch
                        }
                    }
                }));
            }
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
            const settingsPatch = {};
            ['cameraMode', 'navigationMode', 'wheelMode', 'snapTranslationStep', 'snapRotationDegrees', 'fov', 'near', 'far', 'flyMoveSpeed', 'flyLookSensitivity', 'gizmoScale', 'viewportHighResCap'].forEach((key) => {
                if (Object.prototype.hasOwnProperty.call(patch, key)) settingsPatch[key] = patch[key];
            });
            if (Object.keys(settingsPatch).length) {
                updateSettingsState((current) => ({
                    ...current,
                    threeD: {
                        ...current.threeD,
                        preferences: {
                            ...current.threeD.preferences,
                            ...settingsPatch
                        }
                    }
                }));
            }
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
            const defaults = applyThreeDSettingsToDocument(createEmptyThreeDDocument(), store.getState().settings, 'current').view;
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
        },
        async applyCurrentStitchDefaults() {
            const settings = store.getState().settings;
            stitchAnalysisToken += 1;
            clearWorkspaceProgress('stitch');
            updateStitchDocument((document) => invalidateStitchAnalysis(
                applyStitchSettingsToDocument(document, settings, 'apply-defaults'),
                { warning: 'Applied the saved Stitch defaults to the current project. Run the analysis again to refresh candidates.' }
            ), { renderStitch: true });
            logProcess('success', 'stitch.settings', 'Applied the saved Stitch defaults to the current project.');
            setNotice('Applied the saved Stitch defaults to the current project.', 'success', 4200);
            return true;
        },
        async probeStitchPhotoRuntime() {
            const diagnostics = await runStitchPhotoRuntimeProbe({ log: true, priority: 'user-visible' });
            if (diagnostics.runtimeAvailable) {
                logProcess('success', 'stitch.worker', `Stitch photo runtime is ready. Supported detectors: ${(diagnostics.supportedDetectors || []).join(', ') || 'none reported'}.`, {
                    dedupeKey: `stitch-worker-ready:${(diagnostics.supportedDetectors || []).join(',')}`,
                    dedupeWindowMs: 240
                });
                setNotice('Stitch photo runtime is ready.', 'success', 4200);
            } else {
                setNotice(diagnostics.lastFallbackReason || 'The Stitch photo runtime is unavailable.', 'warning', 6000);
            }
            return diagnostics;
        },
        async applyCurrentThreeDDefaults() {
            if (!ensureThreeDSceneUnlocked('applying 3D render defaults')) return false;
            updateThreeDDocument((document) => applyCurrentThreeDDefaults(document, store.getState().settings));
            logProcess('success', 'settings.3d', 'Applied the saved 3D render defaults to the current scene.');
            setNotice('Applied the saved 3D render defaults to the current scene.', 'success', 4200);
            return true;
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
                return applyEditorSettingsToDocument({
                    ...validated,
                    layerStack: reindexStack(registry, validated.layerStack || []).map((instance) => applyEditorSettingsToLayerInstance(instance, store.getState().settings))
                }, store.getState().settings);
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
                updateDocument((document) => applyEditorSettingsToDocument({
                    ...document,
                    ...runtimePayload,
                    layerStack: runtimePayload.layerStack,
                    source: runtimePayload.source || document.source,
                    workspace: normalizeWorkspace('studio', runtimePayload.workspace || document.workspace, !!runtimePayload.selection?.layerInstanceId)
                }, store.getState().settings), { render: true });
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
                return applyThemeToStitchDocument(normalizeStitchDocument(validateImportPayload(normalized, 'stitch-document')), store.getState().settings);
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
            countLegacyCuts(rawPayload) {
                return countLegacyThreeDBooleanCuts(stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload)));
            },
            validatePayload(rawPayload) {
                const normalized = normalizeThreeDDocument(stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload)));
                return applyThreeDSettingsToDocument({
                    ...normalized,
                    render: {
                        ...normalized.render,
                        currentSamples: 0
                    },
                    renderJob: {
                        ...createEmptyThreeDDocument().renderJob
                    }
                }, store.getState().settings, 'current');
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
                const legacyCutCount = this.countLegacyCuts(rawPayload);
                const validated = this.validatePayload(rawPayload);
                store.setState((current) => ({ ...current, threeDDocument: validated }), { render: false });
                setActiveLibraryOrigin('3d', libraryId, libraryName);
                commitActiveSection('3d');
                try {
                    await ensureLibraryAssetsFromThreeDItems(validated.scene?.items || []);
                } catch (error) {
                    console.error(error);
                    logProcess('warning', 'library.assets', error?.message || 'Could not backfill scene assets while loading a 3D Library project.');
                }
                if (legacyCutCount > 0) {
                    const cutLabel = `${legacyCutCount} legacy cut${legacyCutCount === 1 ? '' : 's'}`;
                    logProcess('warning', '3d.workspace', `Removed ${cutLabel} while loading "${libraryName || 'project'}". 3D cuts are no longer supported.`, {
                        dedupeKey: `legacy-3d-cuts:${libraryId || libraryName || legacyCutCount}`,
                        dedupeWindowMs: 500
                    });
                    setNotice(`Removed ${cutLabel} from "${libraryName || 'project'}" because 3D cuts are no longer supported.`, 'warning', 7000);
                }
                logProcess('success', 'library.projects', `Loaded "${libraryName || 'project'}" from the Library into 3D.`);
                setNotice(`Loaded "${libraryName || 'project'}" from Library.`, 'success');
                return true;
            }
        }
    ]);

    setBootStage('workspace init', 'Building workspace UI shells.');
    view = createWorkspaceUI(root, registry, actions, { stitchEngine, logger });
    bootMetrics.mark('workspace-ui-ready', 'Workspace UI shells are mounted.');
    readStorageEstimate().then((storageEstimate) => {
        if (!storageEstimate) return;
        updateSettingsState((current) => current, {
            diagnostics: { storageEstimate },
            skipViewRender: false
        });
        warnIfStoragePressureHigh(storageEstimate);
    }).catch(() => {});
    if (activeSettings.library.autoLoadOnStartup) {
        logProcess('info', 'settings.library', 'Priming the Library in the background on startup because Library auto-load is enabled.', {
            dedupeKey: 'settings-library-autoload',
            dedupeWindowMs: 1500
        });
        view.primeLibrary?.();
    }
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
