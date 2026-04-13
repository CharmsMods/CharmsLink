import * as THREE from 'three';
import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { getRegistryUrls } from './registry/shared.js';
import { downloadState, readJsonFile, serializeState, validateImportPayload } from './io/documents.js';
import { createProjectAdapterRegistry } from './io/projectAdapters.js';
import { didSaveFile, saveBlobLocally, saveJsonLocally, wasSaveCancelled } from './io/localSave.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { getCropTransformMetrics } from './engine/cropTransformShared.js';
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
import {
    COMPOSITE_MAX_ZOOM,
    COMPOSITE_MIN_ZOOM,
    computeCompositeFittedLayerPlacement,
    computeCompositeFramedView,
    computeCompositeDocumentBounds,
    createCompositeLayerId,
    getCompositeLayerDimensions,
    getSelectedCompositeLayer,
    isCompositeDocumentPayload,
    normalizeCompositeDocument,
    serializeCompositeDocument,
    summarizeCompositeDocument
} from './composite/document.js';
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
import { detectGraphicsCapabilities } from './graphics/capabilities.js';
import { createBootstrapMetrics } from './perf/bootstrapMetrics.js';
import { createBootShell } from './ui/bootShell.js';
import { computeAnalysisVisualsJs, computeDiffPreviewJs, extractPaletteFromFileJs } from './editor/backgroundCompute.js';
import {
    applyEditorBaseAspectPreset as applyEditorBaseAspectPresetHelper,
    createDefaultEditorBase,
    createEditorBaseSurface,
    getEditorCanvasLabel,
    getEditorCanvasResolution,
    hasEditorSourceImage,
    isDefaultEditorBase,
    normalizeEditorBase,
    normalizeEditorSource
} from './editor/baseCanvas.js';
import {
    createDefaultDngDevelopParams,
    DNG_ATTACHMENT_KIND,
    DNG_SOURCE_KIND,
    getDngPresetForProbe,
    isDngSource,
    normalizeDngDevelopParams,
    normalizeDngSourceState,
    stripDngSourceRawPayload
} from './editor/dngDevelopShared.js';
import { decodeDngBuffer, probeDngBuffer } from './editor/dngProcessing.js';
import { getEditorTextBounds, normalizeEditorTextParams } from './editor/textLayerShared.js';
import { extractPaletteFromImageSource } from './editor/palette.js';
import { APP_ASSET_VERSION, withAssetVersion } from './appAssetVersion.js';
import { createDefaultAppSettings } from './settings/defaults.js';
import { applyPersonalizationTheme, createDefaultPersonalizationSettings } from './settings/personalization.js';
import { applyCompositeSettingsToDocument, applyEditorSettingsToDocument, applyEditorSettingsToLayerInstance, applyStitchSettingsToDocument, applyThemeToStitchDocument, applyThreeDSettingsToDocument, createSettingsDrivenCompositeDocument, createSettingsDrivenStitchDocument, createSettingsDrivenThreeDDocument } from './settings/apply.js';
import { loadPersistedAppSettings, persistAppSettings, buildSettingsExportPayload, parseImportedSettingsPayload } from './settings/persistence.js';
import { normalizeAppSettings, normalizeSettingsCategory } from './settings/schema.js';
import {
    buildSecureLibraryExportRecord as buildSecureLibraryExportRecordData,
    createSecureLibraryCompatibilityError,
    resolveSecureLibraryImportRecord as resolveSecureLibraryImportRecordData
} from './library/secureTransfer.js';

const DB_NAME = 'ModularStudioDB';
const DB_VERSION = 3;
const STORE_NAME = 'LibraryProjects';
const ATTACHMENT_STORE_NAME = 'LibraryProjectAttachments';
const LIBRARY_META_ID = '__library_meta__';
let backgroundTasks = null;
let workerCapabilities = null;
let graphicsCapabilities = null;
let view = null;
let appStore = null;
let dngRuntimeRegistry = null;
const COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS = 16;
const COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE = 4096;
const dngDecodedSourceCache = new Map();

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onblocked = () => reject(new Error('Library database upgrade was blocked by another open tab.'));
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
            if (!db.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
                const store = db.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: 'id' });
                store.createIndex('projectId', 'projectId', { unique: false });
                store.createIndex('kind', 'kind', { unique: false });
            }
        };
        request.onsuccess = (e) => {
            const db = e.target.result;
            if (db.objectStoreNames.contains(STORE_NAME) && db.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
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
                if (!repairDb.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
                    const store = repairDb.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: 'id' });
                    store.createIndex('projectId', 'projectId', { unique: false });
                    store.createIndex('kind', 'kind', { unique: false });
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

function getLibraryProjectRecordsByCursor(options = {}) {
    const filterRecord = typeof options.filterRecord === 'function' ? options.filterRecord : null;
    const mapRecord = typeof options.mapRecord === 'function' ? options.mapRecord : null;
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).openCursor();
        const results = [];
        req.onsuccess = (event) => {
            const cursor = event.target.result;
            if (!cursor) {
                resolve(results);
                return;
            }
            try {
                const entry = cursor.value;
                if (isLibraryProjectRecord(entry) && (!filterRecord || filterRecord(entry))) {
                    const mapped = mapRecord ? mapRecord(entry) : entry;
                    if (mapped != null) {
                        results.push(mapped);
                    }
                }
            } catch (error) {
                reject(error);
                return;
            }
            cursor.continue();
        };
        req.onerror = (event) => reject(event.target.error);
    }));
}

function saveLibraryAttachment(record) {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE_NAME, 'readwrite');
        const req = tx.objectStore(ATTACHMENT_STORE_NAME).put(record);
        req.onsuccess = () => resolve(record);
        req.onerror = (e) => reject(e.target.error);
    }));
}

function getLibraryAttachment(id) {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE_NAME, 'readonly');
        const req = tx.objectStore(ATTACHMENT_STORE_NAME).get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => reject(e.target.error);
    }));
}

function getLibraryAttachmentsByProjectId(projectId) {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE_NAME, 'readonly');
        const index = tx.objectStore(ATTACHMENT_STORE_NAME).index('projectId');
        const req = index.getAll(String(projectId || ''));
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = (e) => reject(e.target.error);
    }));
}

function deleteLibraryAttachment(id) {
    return initDB().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(ATTACHMENT_STORE_NAME, 'readwrite');
        const req = tx.objectStore(ATTACHMENT_STORE_NAME).delete(id);
        req.onsuccess = () => resolve();
        req.onerror = (e) => reject(e.target.error);
    }));
}

async function deleteLibraryAttachmentsByProjectId(projectId) {
    const attachments = await getLibraryAttachmentsByProjectId(projectId);
    for (const attachment of attachments) {
        await deleteLibraryAttachment(attachment.id);
    }
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
    const cloned = { ...payload };
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
        cloned.preview = { ...cloned.preview };
        delete cloned.preview.width;
        delete cloned.preview.height;
        delete cloned.preview.imageData;
        delete cloned.preview.updatedAt;
    }
    if (isDngSource(cloned.source)) {
        cloned.source = normalizeEditorSource({
            ...stripDngSourceRawPayload(cloned.source),
            imageData: null,
            dng: {
                sourceSignature: cloned.source?.dng?.sourceSignature || '',
                attachmentId: '',
                lastPreparedParamsHash: '',
                lastPreparedAt: 0,
                prepareQuality: 'fast',
                preset: cloned.source?.dng?.preset || '',
                fidelity: cloned.source?.dng?.fidelity || 'partial',
                warnings: [],
                probe: null
            }
        });
    }
    if (isThreeDDocumentPayload(cloned)) {
        if (cloned.render && typeof cloned.render === 'object') {
            cloned.render = { ...cloned.render };
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

function createLibraryAttachmentId() {
    return `attachment-${createLibraryProjectId()}`;
}

function isDngFile(file) {
    const name = String(file?.name || '').trim().toLowerCase();
    const type = String(file?.type || '').trim().toLowerCase();
    return name.endsWith('.dng') || type === 'image/x-adobe-dng' || type === 'image/dng';
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
    const fallbackName = nameOverride || getEditorCanvasLabel(documentState) || 'Editor Canvas';
    return stripProjectExtension(fallbackName) || 'Editor Canvas';
}

function getSuggestedCompositeProjectName(documentState, nameOverride = null) {
    const normalized = normalizeCompositeDocument(documentState);
    const topLayer = [...normalized.layers].sort((a, b) => (b.z || 0) - (a.z || 0))[0] || null;
    const fallback = topLayer?.name || 'Composite Project';
    return stripProjectExtension(nameOverride || fallback) || 'Composite Project';
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
        includeRawDng: false,
        preview
    });
}

function buildStitchLibraryPayload(documentState) {
    return stripEphemeralStitchState(documentState);
}

function buildCompositeLibraryPayload(documentState) {
    return serializeCompositeDocument(normalizeCompositeDocument(documentState));
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
    if (fallbackType === 'composite') return 'composite';
    if (isCompositeDocumentPayload(payload)) return 'composite';
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
    composite: { id: null, name: null },
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
        setActiveLibraryOrigin('composite', null, null);
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

function arrayBufferToDataUrl(buffer, mimeType = 'application/octet-stream') {
    const bytes = buffer instanceof Uint8Array
        ? buffer
        : new Uint8Array(buffer instanceof ArrayBuffer
            ? buffer
            : (ArrayBuffer.isView(buffer)
                ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
                : new ArrayBuffer(0)));
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return `data:${mimeType};base64,${btoa(binary)}`;
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

async function buildWorkerSingleBinaryRequest(file) {
    const { fileEntry, transfer } = await createWorkerSingleFileEntry(file);
    return {
        payload: { fileEntry },
        transfer
    };
}

function collectDecodedDngTransfers(decodedSource = null) {
    const transfers = [];
    if (decodedSource?.rawRaster?.data instanceof Float32Array) {
        transfers.push(decodedSource.rawRaster.data.buffer);
    }
    if (decodedSource?.metadata?.linearizationTable instanceof Float32Array) {
        transfers.push(decodedSource.metadata.linearizationTable.buffer);
    }
    if (Array.isArray(decodedSource?.metadata?.gainMaps)) {
        decodedSource.metadata.gainMaps.forEach((entry) => {
            if (entry?.gains instanceof Float32Array) {
                transfers.push(entry.gains.buffer);
            }
        });
    }
    return transfers;
}

async function runEditorDngTask(task, payload, options = {}) {
    if (backgroundTasks) {
        return backgroundTasks.runTask('dng', task, payload, {
            processId: options.processId || 'editor.dng',
            priority: options.priority || 'user-visible',
            scope: options.scope || 'section:editor',
            transfer: options.transfer || [],
            replaceKey: options.replaceKey || null,
            replaceActive: options.replaceActive !== false
        });
    }

    if (task === 'probe-dng-source') {
        return probeDngBuffer(payload.buffer);
    }
    if (task === 'decode-dng-source') {
        return decodeDngBuffer(payload.buffer);
    }
    throw new Error(`Unknown editor DNG task "${task}".`);
}

async function readDngBufferFromSource(source) {
    if (source instanceof Blob) {
        return source.arrayBuffer();
    }
    const normalized = normalizeEditorSource(source);
    if (normalized.rawData) {
        const blob = await dataUrlToBlob(normalized.rawData);
        return blob.arrayBuffer();
    }
    throw new Error('This DNG source is missing its original raw payload.');
}

async function probeDngFileInBackground(file, options = {}) {
    if (!(file instanceof Blob)) {
        throw new Error('A DNG file is required.');
    }
    if (backgroundTasks) {
        const request = await createWorkerSingleFileEntry(file);
        return backgroundTasks.runTask('dng', 'probe-dng-source', {
            file,
            fileEntry: request.fileEntry
        }, {
            processId: options.processId || 'editor.dng',
            priority: options.priority || 'user-visible',
            scope: options.scope || 'section:editor',
            transfer: request.transfer,
            replaceKey: options.replaceKey || `probe-dng:${file.name}`,
            replaceActive: true
        });
    }
    return probeDngBuffer(await file.arrayBuffer());
}

async function decodeDngSourceInBackground(source, options = {}) {
    const buffer = await readDngBufferFromSource(source);
    const sourceSignature = String(source?.dng?.sourceSignature || '');
    if (sourceSignature && dngDecodedSourceCache.has(sourceSignature)) {
        return structuredClone(dngDecodedSourceCache.get(sourceSignature));
    }
    const result = await runEditorDngTask('decode-dng-source', {
        buffer
    }, {
        processId: options.processId || 'editor.dng',
        priority: options.priority || 'user-visible',
        scope: options.scope || 'section:editor',
        transfer: [buffer],
        replaceKey: options.replaceKey || `decode-dng:${sourceSignature || source?.name || 'source'}`,
        replaceActive: true
    });
    if (sourceSignature) {
        dngDecodedSourceCache.set(sourceSignature, structuredClone(result));
    }
    return result;
}

function createCanvasFromRgba(width, height, rgba) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(Number(width) || 1));
    canvas.height = Math.max(1, Math.round(Number(height) || 1));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('Could not create a preview canvas for the DNG render.');
    }
    const pixels = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba || []);
    ctx.putImageData(new ImageData(pixels, canvas.width, canvas.height), 0, 0);
    return canvas;
}

function summarizeDngWarnings(warnings = []) {
    const list = (warnings || []).filter(Boolean);
    if (!list.length) return '';
    return list[0];
}

async function ensureDngSourceDecoded(documentState, options = {}) {
    const normalizedDocument = normalizeStudioDocumentForDng(
        applyEditorSettingsToDocument(documentState, options.settings || appStore?.getState?.().settings || activeSettings)
    );
    const source = normalizeEditorSource(normalizedDocument.source);
    if (!isDngSource(source)) {
        return {
            document: normalizedDocument,
            decoded: null
        };
    }

    const decoded = await decodeDngSourceInBackground(source, {
        processId: options.processId || 'editor.dng',
        priority: options.priority || 'user-visible',
        scope: options.scope || 'section:editor',
        replaceKey: options.replaceKey || `dng-decode:${source.dng?.sourceSignature || source.name || 'source'}`
    });
    const nextSource = normalizeEditorSource({
        ...source,
        imageData: null,
        width: Number(decoded?.probe?.width || source.width || 0),
        height: Number(decoded?.probe?.height || source.height || 0),
        dng: normalizeDngSourceState({
            ...source.dng,
            sourceSignature: decoded?.sourceSignature || source?.dng?.sourceSignature || '',
            lastPreparedParamsHash: '',
            lastPreparedAt: Date.now(),
            prepareQuality: normalizedDocument.view?.highQualityPreview ? 'high' : 'fast',
            preset: decoded?.preset || getDngPresetForProbe(decoded?.probe),
            fidelity: decoded?.fidelity || source?.dng?.fidelity || 'partial',
            warnings: decoded?.warnings || source?.dng?.warnings || [],
            probe: decoded?.probe || source?.dng?.probe || null
        })
    });
    return {
        document: normalizeStudioDocumentForDng({
            ...normalizedDocument,
            source: nextSource,
            base: normalizeEditorBase(normalizedDocument.base, nextSource)
        }),
        decoded
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
    const baseResolution = getEditorCanvasResolution(documentState);
    return {
        imageData: dataUrl,
        width: Number(studioEngine?.runtime?.renderWidth || baseResolution.width || 0),
        height: Number(studioEngine?.runtime?.renderHeight || baseResolution.height || 0),
        updatedAt: Date.now()
    };
}

function createCompositePreviewSnapshot(documentState, dataUrl, width, height) {
    if (!dataUrl) return null;
    return {
        imageData: dataUrl,
        width: Math.max(0, Number(width) || 0),
        height: Math.max(0, Number(height) || 0),
        updatedAt: Date.now()
    };
}

function stripStudioPreview(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const cloned = { ...payload };
    delete cloned.preview;
    return cloned;
}

function stripCompositePreview(payload) {
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

async function captureCompositeDocumentSnapshot(documentState, options = {}) {
    const normalized = normalizeCompositeDocument(documentState);
    const previewOptions = options?.previewOptions && typeof options.previewOptions === 'object'
        ? options.previewOptions
        : {};
    const exportOptions = options?.exportOptions && typeof options.exportOptions === 'object'
        ? options.exportOptions
        : {};
    let blob = null;
    let preview = normalized.preview || null;

    try {
        blob = await renderCompositePngBlob(normalized, exportOptions);
    } catch (_error) {
        blob = null;
    }

    try {
        preview = await renderCompositePreview(normalized, previewOptions) || preview;
    } catch (_error) {
        preview = preview || null;
    }

    if (!preview?.imageData && blob instanceof Blob) {
        try {
            const exportDataUrl = await blobToDataUrl(blob);
            const previewDataUrl = await createLibraryImageAssetPreview(exportDataUrl, { maxEdge: 320 });
            if (previewDataUrl) {
                const previewImage = await loadImageFromDataUrl(previewDataUrl);
                preview = createCompositePreviewSnapshot(
                    normalized,
                    previewDataUrl,
                    Math.max(1, Number(previewImage.naturalWidth || previewImage.width || 1)),
                    Math.max(1, Number(previewImage.naturalHeight || previewImage.height || 1))
                );
            }
        } catch (_error) {
            preview = preview || null;
        }
    }

    if (!blob && preview?.imageData) {
        try {
            blob = await dataUrlToBlob(preview.imageData);
        } catch (_error) {
            blob = null;
        }
    }

    return {
        blob,
        preview,
        payload: buildCompositeLibraryPayload({
            ...normalized,
            preview
        })
    };
}

function normalizeCompositeViewportMetrics(viewport = null) {
    const rawWidth = Number(viewport?.width) || 0;
    const rawHeight = Number(viewport?.height) || 0;
    return {
        width: Math.round(rawWidth >= 64 ? rawWidth : 1600),
        height: Math.round(rawHeight >= 64 ? rawHeight : 900)
    };
}

function getCompositeViewportMetrics() {
    return normalizeCompositeViewportMetrics(view?.getCompositeViewportMetrics?.());
}

function createCompositePngBlobFromResult(result = null) {
    if (result instanceof Blob) {
        return result;
    }
    const sourceBuffer = result?.buffer;
    const buffer = sourceBuffer instanceof ArrayBuffer
        ? sourceBuffer
        : ArrayBuffer.isView(sourceBuffer)
            ? sourceBuffer.buffer.slice(sourceBuffer.byteOffset, sourceBuffer.byteOffset + sourceBuffer.byteLength)
            : null;
    if (!buffer) return null;
    return new Blob([buffer], { type: result?.mimeType || 'image/png' });
}

function getCompositeExportBackendPreference(settings = null) {
    const requested = String(settings?.composite?.preferences?.exportBackend || '').trim().toLowerCase();
    return requested === 'worker' || requested === 'main-thread' ? requested : 'auto';
}

function getCompositeExportTargetMetrics(documentState) {
    const normalized = normalizeCompositeDocument(documentState);
    const bounds = computeCompositeDocumentBounds(normalized);
    const isCustom = normalized.export.boundsMode === 'custom';
    const outputWidth = isCustom
        ? Math.max(1, Math.round(Number(normalized.export.customResolution?.width) || 1))
        : Math.max(1, Math.ceil(Number(bounds.width) || 1));
    const outputHeight = isCustom
        ? Math.max(1, Math.round(Number(normalized.export.customResolution?.height) || 1))
        : Math.max(1, Math.ceil(Number(bounds.height) || 1));
    const pixelCount = outputWidth * outputHeight;
    return {
        boundsMode: isCustom ? 'custom' : 'auto',
        outputWidth,
        outputHeight,
        pixelCount,
        megapixels: pixelCount / 1000000,
        maxEdge: Math.max(outputWidth, outputHeight)
    };
}

function formatCompositeExportTarget(target = null) {
    if (!target) return 'an unknown output size';
    const megapixels = Number(target.megapixels) || 0;
    const megapixelLabel = megapixels >= 100
        ? megapixels.toFixed(0)
        : megapixels.toFixed(1).replace(/\.0$/, '');
    return `${Math.max(1, Math.round(Number(target.outputWidth) || 1)).toLocaleString()}x${Math.max(1, Math.round(Number(target.outputHeight) || 1)).toLocaleString()} (${megapixelLabel} MP)`;
}

function canUseCompositeWorkerRendering() {
    return !!backgroundTasks && !!workerCapabilities?.createImageBitmap && !!workerCapabilities?.offscreenCanvas2d;
}

function resolveCompositeRenderBackend(options = {}) {
    const purpose = options.purpose === 'preview' ? 'preview' : 'export';
    const preference = options.forceBackend === 'worker' || options.forceBackend === 'main-thread'
        ? options.forceBackend
        : getCompositeExportBackendPreference(options.settings || appStore?.getState?.().settings || null);
    const workerCapable = canUseCompositeWorkerRendering();
    const target = purpose === 'export' && options.document
        ? getCompositeExportTargetMetrics(options.document)
        : null;
    const gpuSafeMaxEdge = Math.max(0, Number(graphicsCapabilities?.gpuSafeMaxEdge) || 0);
    const exceedsGpuSafeEdge = !!(target && gpuSafeMaxEdge > 0 && target.maxEdge > gpuSafeMaxEdge);
    const gpuEdgeNote = exceedsGpuSafeEdge
        ? ` The current CPU 2D export path also avoids depending on a WebGL texture above the probed ${gpuSafeMaxEdge.toLocaleString()} px safe edge.`
        : '';
    if (preference === 'main-thread') {
        return {
            preference,
            mode: 'main-thread',
            workerCapable,
            label: 'Main Thread 2D',
            target,
            fallbackReason: '',
            decisionReason: purpose === 'export'
                ? `Composite export used Main Thread 2D because Settings forced that path for ${formatCompositeExportTarget(target)}.${gpuEdgeNote}`.trim()
                : 'Composite preview used Main Thread 2D because Settings forced that path.',
            logKey: `forced-main-thread:${purpose}:${target?.outputWidth || 0}x${target?.outputHeight || 0}`
        };
    }
    if (preference === 'worker' && workerCapable) {
        return {
            preference,
            mode: 'worker',
            workerCapable,
            label: 'Background Worker 2D',
            target,
            fallbackReason: '',
            decisionReason: purpose === 'export'
                ? `Composite export used Background Worker 2D because Settings forced that path for ${formatCompositeExportTarget(target)}.${gpuEdgeNote}`.trim()
                : 'Composite preview used Background Worker 2D because Settings forced that path.',
            logKey: `forced-worker:${purpose}:${target?.outputWidth || 0}x${target?.outputHeight || 0}`
        };
    }
    if (preference === 'worker') {
        return {
            preference,
            mode: 'main-thread',
            workerCapable: false,
            label: 'Main Thread 2D',
            target,
            fallbackReason: purpose === 'export'
                ? `Composite worker rendering was forced in Settings, but Worker + OffscreenCanvas 2D export is unavailable, so ${formatCompositeExportTarget(target)} fell back to Main Thread 2D.${gpuEdgeNote}`.trim()
                : 'Composite worker rendering was forced in Settings, but Worker + OffscreenCanvas 2D preview is unavailable, so the app fell back to the main thread.',
            decisionReason: '',
            logKey: `forced-worker-fallback:${purpose}:${target?.outputWidth || 0}x${target?.outputHeight || 0}`
        };
    }
    if (!workerCapable) {
        return {
            preference,
            mode: 'main-thread',
            workerCapable: false,
            label: 'Main Thread 2D',
            target,
            fallbackReason: purpose === 'export'
                ? `Composite worker rendering is unavailable, so ${formatCompositeExportTarget(target)} is running on Main Thread 2D.${gpuEdgeNote}`.trim()
                : 'Composite worker rendering is unavailable, so preview is running on the main thread.',
            decisionReason: '',
            logKey: `auto-worker-unavailable:${purpose}:${target?.outputWidth || 0}x${target?.outputHeight || 0}`
        };
    }
    if (purpose === 'export' && target) {
        const useWorker = target.megapixels >= COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS
            || target.maxEdge >= COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE;
        return {
            preference,
            mode: useWorker ? 'worker' : 'main-thread',
            workerCapable: true,
            label: useWorker ? 'Background Worker 2D' : 'Main Thread 2D',
            target,
            fallbackReason: '',
            decisionReason: useWorker
                ? `Composite export used Background Worker 2D because ${formatCompositeExportTarget(target)} crosses the Auto large-export threshold (${COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS} MP or ${COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE.toLocaleString()} px max-edge).${gpuEdgeNote}`.trim()
                : `Composite export kept ${formatCompositeExportTarget(target)} on Main Thread 2D because it stays below the Auto large-export threshold (${COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS} MP and ${COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE.toLocaleString()} px max-edge).${gpuEdgeNote}`.trim(),
            logKey: `${useWorker ? 'auto-worker' : 'auto-main-thread'}:${target.outputWidth}x${target.outputHeight}`
        };
    }
    return {
        preference,
        mode: 'worker',
        workerCapable: true,
        label: 'Background Worker 2D',
        target,
        fallbackReason: '',
        decisionReason: 'Composite preview used Background Worker 2D because worker preview rendering is available.',
        logKey: `auto-worker:${purpose}`
    };
}

async function renderCompositePreview(documentState, options = {}) {
    const normalized = normalizeCompositeDocument(documentState);
    const backend = resolveCompositeRenderBackend({
        ...options,
        document: normalized,
        purpose: 'preview'
    });
    options.onBackend?.(backend);
    if (backend.mode === 'main-thread') {
        if (!view?.captureCompositePreview) {
            throw new Error('Composite workspace preview is not ready yet.');
        }
        return view.captureCompositePreview(normalized);
    }
    return backgroundTasks.runTask('composite', 'render-preview', {
        document: normalized,
        maxEdge: Math.max(1, Number(options.maxEdge) || 320)
    }, {
        priority: options.priority || 'user-visible',
        processId: options.processId || 'composite.render',
        scope: options.scope || 'section:composite',
        replaceKey: options.replaceKey || ''
    });
}

async function renderCompositePngBlob(documentState, options = {}) {
    const normalized = normalizeCompositeDocument(documentState);
    const backend = resolveCompositeRenderBackend({
        ...options,
        document: normalized,
        purpose: 'export'
    });
    options.onBackend?.(backend);
    if (backend.mode === 'main-thread') {
        if (!view?.exportCompositePng) {
            throw new Error('Composite workspace export is not ready yet.');
        }
        return view.exportCompositePng(normalized);
    }
    const result = await backgroundTasks.runTask('composite', 'render-export-png', {
        document: normalized
    }, {
        priority: options.priority || 'user-visible',
        processId: options.processId || 'composite.export',
        scope: options.scope || 'section:composite'
    });
    const blob = createCompositePngBlobFromResult(result);
    if (!blob) {
        throw new Error('Could not encode the Composite PNG.');
    }
    return blob;
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

async function syncStudioEngineToDocument(studioEngine, documentState, options = {}) {
    if (!studioEngine) return null;
    const resolvedSettings = options.settings
        || appStore?.getState?.().settings
        || activeSettings;
    let normalizedDocument = normalizeStudioDocumentForDng(applyEditorSettingsToDocument({
        ...(documentState || {}),
        source: normalizeEditorSource(documentState?.source),
        base: normalizeEditorBase(documentState?.base, documentState?.source),
        export: normalizeEditorExportState(documentState?.export, documentState)
    }, resolvedSettings));
    let sourceImage = options.sourceImage || null;
    let decodedDngSource = null;
    if (isDngSource(normalizedDocument.source)) {
        const decodedSource = await ensureDngSourceDecoded(normalizedDocument, {
            settings: resolvedSettings,
            processId: options.processId || 'editor.dng',
            priority: options.priority || 'user-visible',
            scope: options.scope || 'section:editor',
            replaceKey: options.replaceKey || 'editor-dng-sync'
        });
        normalizedDocument = decodedSource.document;
        decodedDngSource = decodedSource.decoded;
    } else if (!sourceImage && normalizedDocument.source.imageData) {
        sourceImage = await loadImageFromDataUrl(normalizedDocument.source.imageData);
    }
    const surface = createEditorBaseSurface(normalizedDocument, sourceImage);
    await studioEngine.loadImage(surface, {
        ...normalizeEditorSource(normalizedDocument.source),
        width: surface.width,
        height: surface.height,
        canvasWidth: surface.width,
        canvasHeight: surface.height
    });
    if (decodedDngSource) {
        await studioEngine.loadDngSource(decodedDngSource, {
            ...normalizeEditorSource(normalizedDocument.source),
            width: surface.width,
            height: surface.height,
            canvasWidth: surface.width,
            canvasHeight: surface.height
        });
    }
    return {
        document: normalizedDocument,
        surface,
        sourceImage,
        decodedDngSource
    };
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

function hasPersistableEditorSource(source) {
    const normalized = normalizeEditorSource(source);
    return !!(normalized.imageData || normalized.rawData);
}

function createLibraryProjectListPayload(record) {
    const payload = normalizeLegacyDocumentPayload(record?.payload);
    if (!payload || typeof payload !== 'object') return payload;
    if (getLibraryProjectType(record) !== 'studio') return payload;

    const source = normalizeEditorSource(payload.source);
    if (!isDngSource(source)) return payload;

    const nextPayload = {
        ...payload,
        source: normalizeEditorSource({
            ...stripDngSourceRawPayload(source),
            imageData: null,
            dng: {
                ...source.dng,
                lastPreparedParamsHash: '',
                lastPreparedAt: 0
            }
        })
    };
    if (nextPayload.preview && typeof nextPayload.preview === 'object' && record?.blob instanceof Blob) {
        nextPayload.preview = { ...nextPayload.preview };
        delete nextPayload.preview.imageData;
    }
    return nextPayload;
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

function buildLibraryAttachmentRecord({
    id,
    projectId,
    kind,
    fileName = '',
    mimeType = 'application/octet-stream',
    byteLength = 0,
    dataUrl = '',
    timestamp = Date.now()
}) {
    return {
        id: id || createLibraryAttachmentId(),
        projectId: String(projectId || ''),
        kind: String(kind || ''),
        fileName: String(fileName || ''),
        mimeType: String(mimeType || 'application/octet-stream'),
        byteLength: Math.max(0, Number(byteLength) || 0),
        dataUrl: String(dataUrl || ''),
        timestamp: Math.max(0, Number(timestamp) || Date.now())
    };
}

async function saveStudioDngAttachment(projectId, source) {
    const normalized = normalizeEditorSource(source);
    if (!projectId || !isDngSource(normalized) || !normalized.rawData) return null;
    const record = buildLibraryAttachmentRecord({
        id: normalized.dng?.attachmentId || null,
        projectId,
        kind: DNG_ATTACHMENT_KIND,
        fileName: normalized.name,
        mimeType: normalized.rawMimeType || normalized.type || 'image/x-adobe-dng',
        byteLength: normalized.rawByteLength || 0,
        dataUrl: normalized.rawData
    });
    await saveLibraryAttachment(record);
    return record;
}

async function hydrateStudioDngPayloadFromAttachment(payload, projectId) {
    const normalizedPayload = payload && typeof payload === 'object' ? { ...payload } : payload;
    const source = normalizeEditorSource(normalizedPayload?.source);
    if (!isDngSource(source)) return normalizedPayload;
    if (source.rawData) return normalizedPayload;
    const attachmentId = source.dng?.attachmentId;
    let attachment = attachmentId ? await getLibraryAttachment(attachmentId).catch(() => null) : null;
    if (!attachment && projectId) {
        attachment = (await getLibraryAttachmentsByProjectId(projectId).catch(() => [])).find((entry) => entry.kind === DNG_ATTACHMENT_KIND) || null;
    }
    if (!attachment?.dataUrl) return normalizedPayload;
    return {
        ...normalizedPayload,
        source: normalizeEditorSource({
            ...source,
            rawData: attachment.dataUrl,
            rawMimeType: attachment.mimeType || source.rawMimeType,
            rawByteLength: attachment.byteLength || source.rawByteLength,
            dng: {
                ...source.dng,
                attachmentId: attachment.id
            }
        })
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

const STUDIO_VIEWS = new Set(['edit', 'base', 'info', 'layer', 'pipeline', 'scopes']);

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
        if (section === 'composite' || section === 'library' || section === 'stitch' || section === '3d' || section === 'settings' || section === 'logs') return section;
        return 'editor';
    } catch (_error) {
        return 'editor';
    }
}

function syncSectionUrl(section) {
    try {
        const url = new URL(window.location.href);
        if (section === 'composite') url.searchParams.set('section', 'composite');
        else if (section === 'library') url.searchParams.set('section', 'library');
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
        document: normalizeStudioDocumentForDng(applyEditorSettingsToDocument({
            version: 'mns/v2',
            kind: 'document',
            mode: 'studio',
            workspace: { studioView: 'edit', batchOpen: false },
            source: normalizeEditorSource(),
            base: createDefaultEditorBase(),
            palette: ['#111111', '#f5f7fa', '#ff8a00', '#00d1ff'],
            layerStack: [],
            selection: { layerInstanceId: null },
            view: createDefaultViewState(),
            export: { keepFolderStructure: false, playFps: 10, pngBitDepth: '8-bit' },
            batch: createEmptyBatchState()
        }, normalizedSettings)),
        compositeDocument: createSettingsDrivenCompositeDocument(normalizedSettings),
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
                settingsCategory: 'general',
                compositeEditorBridge: {
                    active: false,
                    layerId: null,
                    originalLibraryId: null,
                    originalLibraryName: null
                }
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

function getDngDevelopInstance(document) {
    return (document?.layerStack || []).find((instance) => instance.layerId === 'dngDevelop') || null;
}

function getDngDevelopParamsFromDocument(document) {
    const source = normalizeEditorSource(document?.source);
    return normalizeDngDevelopParams(
        getDngDevelopInstance(document)?.params || createDefaultDngDevelopParams(),
        source.dng?.probe || null
    );
}

function buildDngDebugSnapshot(document) {
    const normalizedDocument = normalizeStudioDocumentForDng(document || createInitialState().document);
    const source = normalizeEditorSource(normalizedDocument.source);
    if (!isDngSource(source)) return null;
    const probe = source.dng?.probe || {};
    const params = getDngDevelopParamsFromDocument(normalizedDocument);
    return {
        capturedAt: new Date().toISOString(),
        source: {
            name: source.name || '',
            sourceSignature: source.dng?.sourceSignature || '',
            fidelity: source.dng?.fidelity || 'partial',
            warnings: Array.isArray(source.dng?.warnings) ? source.dng.warnings : [],
            make: probe.make || '',
            model: probe.model || '',
            preset: probe.preset || source.dng?.preset || '',
            classificationMode: probe.classificationMode || '',
            compression: probe.compressionLabel || '',
            dimensions: {
                width: Number(probe.width || source.width || 0) || 0,
                height: Number(probe.height || source.height || 0) || 0
            },
            supports: {
                remosaic: !!probe.supportsRemosaic,
                orientationToggle: !!probe.supportsOrientationToggle,
                opcodeCorrections: !!probe.supportsOpcodeCorrections,
                gainMapCorrections: !!probe.supportsGainMapCorrections,
                linearization: !!probe.supportsLinearization
            },
            flags: {
                hasOpcodeList: !!probe.hasOpcodeList,
                hasGainMap: !!probe.hasGainMap,
                hasProfileGainTableMap: !!probe.hasProfileGainTableMap,
                hasLinearizationTable: !!probe.hasLinearizationTable
            }
        },
        controls: params,
        editorView: {
            highQualityPreview: !!normalizedDocument.view?.highQualityPreview,
            hoverCompareOriginal: !!normalizedDocument.view?.hoverCompareOriginal,
            renderToActiveLayer: !!normalizedDocument.view?.renderToActiveLayer
        }
    };
}

function reconcileDngDevelopLayer(document) {
    const registryRef = dngRuntimeRegistry;
    if (!document || !registryRef?.byId?.dngDevelop) return document;
    const source = normalizeEditorSource(document.source);
    const isDng = isDngSource(source);
    const currentStack = Array.isArray(document.layerStack) ? document.layerStack : [];
    const existing = currentStack.find((instance) => instance.layerId === 'dngDevelop') || null;

    if (!isDng) {
        if (!existing) return document;
        const nextStack = reindexStack(registryRef, currentStack.filter((instance) => instance.layerId !== 'dngDevelop'));
        const nextSelection = document.selection?.layerInstanceId === existing.instanceId
            ? { layerInstanceId: nextStack[0]?.instanceId || null }
            : document.selection;
        return {
            ...document,
            layerStack: nextStack,
            selection: nextSelection
        };
    }

    const currentSourceSignature = String(source.dng?.sourceSignature || '');
    const existingSourceSignature = String(existing?.meta?.dngSourceSignature || '');
    const resetForNewSource = !!existing
        && !!currentSourceSignature
        && !!existingSourceSignature
        && existingSourceSignature !== currentSourceSignature;
    const normalizedParams = normalizeDngDevelopParams(
        resetForNewSource ? createDefaultDngDevelopParams() : (existing?.params || createDefaultDngDevelopParams()),
        source.dng?.probe || null
    );
    if (existing) {
        const nextStack = reindexStack(registryRef, currentStack.map((instance) => (
            instance.instanceId === existing.instanceId
                ? {
                    ...instance,
                    enabled: true,
                    visible: true,
                    meta: {
                        ...(instance.meta || {}),
                        dngSourceSignature: currentSourceSignature
                    },
                    params: {
                        ...instance.params,
                        ...normalizedParams
                    }
                }
                : instance
        )));
        const dngIndex = nextStack.findIndex((instance) => instance.layerId === 'dngDevelop');
        if (dngIndex > 0) {
            const ordered = [...nextStack];
            const [dngLayer] = ordered.splice(dngIndex, 1);
            ordered.unshift(dngLayer);
            return { ...document, layerStack: reindexStack(registryRef, ordered) };
        }
        return { ...document, layerStack: nextStack };
    }

    const created = applyEditorSettingsToLayerInstance(
        createLayerInstance(registryRef, 'dngDevelop', currentStack),
        appStore?.getState?.().settings || createDefaultAppSettings()
    );
    created.params = { ...created.params, ...normalizedParams };
    created.meta = {
        ...(created.meta || {}),
        dngSourceSignature: currentSourceSignature
    };
    const nextStack = reindexStack(registryRef, [created, ...currentStack]);
    const hasValidSelection = !!document.selection?.layerInstanceId
        && nextStack.some((instance) => instance.instanceId === document.selection.layerInstanceId);
    return {
        ...document,
        layerStack: nextStack,
        selection: hasValidSelection ? document.selection : { layerInstanceId: created.instanceId }
    };
}

function normalizeEditorExportState(exportState = null, document = null) {
    const source = normalizeEditorSource(document?.source);
    const current = exportState && typeof exportState === 'object' ? exportState : {};
    const defaultBitDepth = isDngSource(source) ? '16-bit' : '8-bit';
    const bitDepth = String(current.pngBitDepth || current.bitDepth || defaultBitDepth).trim().toLowerCase() === '16-bit'
        ? '16-bit'
        : '8-bit';
    return {
        ...current,
        keepFolderStructure: !!current.keepFolderStructure,
        playFps: clamp(Number(current.playFps || 10), 1, 60),
        pngBitDepth: isDngSource(source) ? bitDepth : '8-bit'
    };
}

function normalizeStudioDocumentForDng(document) {
    const reconciled = reconcileDngDevelopLayer(document);
    return {
        ...reconciled,
        export: normalizeEditorExportState(reconciled.export, reconciled)
    };
}

function computeEditorResolutionThroughStack(documentState, stopInstanceId = null) {
    const baseResolution = getEditorCanvasResolution(documentState);
    let width = Math.max(1, Number(baseResolution.width) || 1);
    let height = Math.max(1, Number(baseResolution.height) || 1);

    for (const stackItem of documentState?.layerStack || []) {
        if (stackItem.visible !== false && stackItem.enabled !== false) {
            if (stackItem.layerId === 'scale') {
                const factor = Math.max(0.1, parseFloat(stackItem.params?.scaleMultiplier || 1));
                width = Math.max(1, Math.round(width * factor));
                height = Math.max(1, Math.round(height * factor));
            } else if (stackItem.layerId === 'expander') {
                const padding = Math.max(0, Math.round(Number(stackItem.params?.expanderPadding || 0)));
                width += padding * 2;
                height += padding * 2;
            } else if (stackItem.layerId === 'cropTransform') {
                const cropMetrics = getCropTransformMetrics(stackItem.params, width, height);
                width = cropMetrics.outputWidth;
                height = cropMetrics.outputHeight;
            }
        }
        if (stopInstanceId && stackItem.instanceId === stopInstanceId) {
            break;
        }
    }

    return { width, height };
}

function centerTextLayerParams(documentState, params = {}, stopInstanceId = null) {
    const normalized = normalizeEditorTextParams(params);
    const bounds = getEditorTextBounds(normalized);
    const resolution = computeEditorResolutionThroughStack(documentState, stopInstanceId);
    return {
        ...normalized,
        textX: Math.round((resolution.width - bounds.width) * 0.5),
        textY: Math.round((resolution.height - bounds.height) * 0.5)
    };
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
        'settings.personalization': 'Personalization',
        'settings.library': 'Library Settings',
        'settings.editor': 'Editor Settings',
        'settings.composite': 'Composite Settings',
        'settings.stitch': 'Stitch Settings',
        'settings.3d': '3D Settings',
        'settings.logs': 'Logs Settings',
        'editor.files': 'Editor Files',
        'editor.dng': 'Editor DNG',
        'editor.export': 'Editor Export',
        'composite.workspace': 'Composite Workspace',
        'composite.layers': 'Composite Layers',
        'composite.render': 'Composite Render',
        'composite.link': 'Composite Link',
        'composite.export': 'Composite Export',
        'composite.autosave': 'Composite Autosave',
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
    let compositeEditorRenderEngine = null;
    let compositeEditorRenderCanvas = null;
    let compositeEditorRenderReady = false;
    let stitchEngine = null;
    let compositeAutosaveTimer = null;
    let compositeAutosaveInFlight = false;
    let compositeAutosaveDocumentVersion = 0;

    let noticeTimer = null;
    let playbackTimer = null;
    view = null;
    let paletteExtractionImage = null;
    let paletteExtractionOwner = null;
    let dngPreviewRefreshToken = 0;
    let dngPreviewStatusToken = 0;
    let dngPreviewStatusTimer = null;
    let dngPreviewScheduleTimer = null;
    let dngPreviewScheduledDocument = null;
    let dngPreviewScheduledOptions = null;
    let dngPreviewScheduledResolves = [];
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

    function buildCompositeSettingsDiagnostics(overrides = {}) {
        const current = activeSettings?.composite?.diagnostics || createDefaultAppSettings().composite.diagnostics;
        return {
            workerAvailable: overrides.workerAvailable ?? current.workerAvailable ?? !!workerCapabilities?.worker,
            offscreenCanvas2d: overrides.offscreenCanvas2d ?? current.offscreenCanvas2d ?? !!workerCapabilities?.offscreenCanvas2d,
            createImageBitmap: overrides.createImageBitmap ?? current.createImageBitmap ?? !!workerCapabilities?.createImageBitmap,
            webglAvailable: overrides.webglAvailable ?? current.webglAvailable ?? !!graphicsCapabilities?.webglAvailable,
            webgl2Available: overrides.webgl2Available ?? current.webgl2Available ?? !!graphicsCapabilities?.webgl2Available,
            maxTextureSize: Math.max(0, Math.round(Number(overrides.maxTextureSize ?? current.maxTextureSize ?? graphicsCapabilities?.maxTextureSize) || 0)),
            maxRenderbufferSize: Math.max(0, Math.round(Number(overrides.maxRenderbufferSize ?? current.maxRenderbufferSize ?? graphicsCapabilities?.maxRenderbufferSize) || 0)),
            maxViewportWidth: Math.max(0, Math.round(Number(overrides.maxViewportWidth ?? current.maxViewportWidth ?? graphicsCapabilities?.maxViewportWidth) || 0)),
            maxViewportHeight: Math.max(0, Math.round(Number(overrides.maxViewportHeight ?? current.maxViewportHeight ?? graphicsCapabilities?.maxViewportHeight) || 0)),
            gpuSafeMaxEdge: Math.max(0, Math.round(Number(overrides.gpuSafeMaxEdge ?? current.gpuSafeMaxEdge ?? graphicsCapabilities?.gpuSafeMaxEdge) || 0)),
            autoWorkerThresholdMegapixels: Number(overrides.autoWorkerThresholdMegapixels ?? current.autoWorkerThresholdMegapixels ?? COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS) || COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS,
            autoWorkerThresholdEdge: Math.max(1, Math.round(Number(overrides.autoWorkerThresholdEdge ?? current.autoWorkerThresholdEdge ?? COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE) || COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE))
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
            compositeDiagnostics: buildCompositeSettingsDiagnostics(overrides.compositeDiagnostics || {}),
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
            compositeDocument: applyCompositeSettingsToDocument(state.compositeDocument, nextSettings),
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
        applyPersonalizationTheme(nextSettings, {
            root: document.documentElement,
            appShell: document.querySelector('.app-shell')
        });
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
                renderComposite: meta.renderComposite ?? false,
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

    function beginDngPreviewRenderStatus(options = {}) {
        const token = ++dngPreviewStatusToken;
        const payload = {
            active: true,
            title: String(options.title || 'Rendering'),
            message: String(options.message || 'Updating the DNG preview...')
        };
        const delayMs = Math.max(0, Number(options.delayMs) || 0);
        clearTimeout(dngPreviewStatusTimer);
        if (view?.getEditorPreviewRenderStatus?.()?.active) {
            view?.setEditorPreviewRenderStatus?.(payload);
            return token;
        }
        dngPreviewStatusTimer = setTimeout(() => {
            if (token !== dngPreviewStatusToken) return;
            view?.setEditorPreviewRenderStatus?.(payload);
        }, delayMs);
        return token;
    }

    function endDngPreviewRenderStatus(token) {
        if (token !== dngPreviewStatusToken) return;
        clearTimeout(dngPreviewStatusTimer);
        dngPreviewStatusTimer = null;
        view?.setEditorPreviewRenderStatus?.(null);
    }

    function setStitchProgress(payload = null) {
        view?.setStitchProgress?.(payload);
    }

    function setThreeDProgress(payload = null) {
        view?.setThreeDProgress?.(payload);
    }

    function clearWorkspaceProgress(projectType) {
        if (projectType === 'composite') {
            view?.setCompositeProgress?.(null);
            return;
        }
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
        if (projectType === 'composite') {
            view?.setCompositeProgress?.(payload);
            return;
        }
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
        backgroundTasks.registerDomain('dng', {
            workerUrl: withAssetVersion(new URL('./workers/dng.worker.js', import.meta.url)),
            restartWorkerOnActiveCancel: false,
            fallback(task, payload) {
                if (task === 'probe-dng-source') {
                    if (payload.buffer) return probeDngBuffer(payload.buffer);
                    if (payload.fileEntry?.buffer instanceof ArrayBuffer) {
                        return probeDngBuffer(payload.fileEntry.buffer);
                    }
                    if (payload.file instanceof Blob) {
                        return payload.file.arrayBuffer().then((buffer) => probeDngBuffer(buffer));
                    }
                }
                if (task === 'decode-dng-source') {
                    return decodeDngBuffer(payload.buffer);
                }
                throw new Error(`Unknown dng task "${task}".`);
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
        backgroundTasks.registerDomain('composite', {
            workerUrl: withAssetVersion(new URL('./workers/composite.worker.js', import.meta.url)),
            supportsTask(task, capabilities) {
                if (task === 'prepare-image-files') {
                    return !!capabilities.createImageBitmap;
                }
                if (task === 'render-preview' || task === 'render-export-png') {
                    return !!capabilities.createImageBitmap && !!capabilities.offscreenCanvas2d;
                }
                return true;
            },
            fallback(task, payload, context) {
                if (task === 'prepare-image-files') {
                    return prepareCompositeImageFilesFallback(payload.files, {
                        onProgress(progress) {
                            context.progress(progress?.progress, progress?.message, progress);
                        }
                    });
                }
                if (task === 'render-preview') {
                    if (!view?.captureCompositePreview) {
                        throw new Error('Composite workspace preview is not ready yet.');
                    }
                    return view.captureCompositePreview(normalizeCompositeDocument(payload.document));
                }
                if (task === 'render-export-png') {
                    if (!view?.exportCompositePng) {
                        throw new Error('Composite workspace export is not ready yet.');
                    }
                    return view.exportCompositePng(normalizeCompositeDocument(payload.document))
                        .then(async (blob) => ({
                            buffer: await blob.arrayBuffer(),
                            mimeType: blob.type || 'image/png'
                        }));
                }
                throw new Error(`Unknown composite task "${task}".`);
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
    graphicsCapabilities = detectGraphicsCapabilities();
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
    logProcess('info', 'app.bootstrap', graphicsCapabilities?.webglAvailable
        ? `Graphics capabilities ready: ${graphicsCapabilities.webgl2Available ? 'webgl2' : 'webgl'}; max texture ${Math.max(0, Number(graphicsCapabilities.maxTextureSize) || 0).toLocaleString()} px; max viewport ${Math.max(0, Number(graphicsCapabilities.maxViewportWidth) || 0).toLocaleString()} x ${Math.max(0, Number(graphicsCapabilities.maxViewportHeight) || 0).toLocaleString()} px; GPU-safe edge ${Math.max(0, Number(graphicsCapabilities.gpuSafeMaxEdge) || 0).toLocaleString()} px.`
        : 'Graphics capabilities ready: WebGL is unavailable, so future GPU export paths should be treated as unsupported on this machine.', {
        dedupeKey: 'graphics-capabilities-ready',
        dedupeWindowMs: 500
    });
    window.__modularStudioPerformance = {
        assetVersion: APP_ASSET_VERSION,
        capabilities: workerCapabilities,
        graphicsCapabilities,
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
    dngRuntimeRegistry = registry;
    store = createStore(createInitialState(activeSettings));
    appStore = store;
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
            // Keep preview-space overlays in the same coordinate system the engine just rendered.
            view?.syncEditorPreviewOverlays?.();
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

    async function copyTextToClipboard(text) {
        const value = String(text ?? '');
        if (navigator?.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
        const textArea = document.createElement('textarea');
        textArea.value = value;
        textArea.setAttribute('readonly', 'readonly');
        textArea.style.position = 'fixed';
        textArea.style.left = '-9999px';
        textArea.style.top = '0';
        document.body.appendChild(textArea);
        textArea.select();
        const copied = document.execCommand('copy');
        textArea.remove();
        if (!copied) {
            throw new Error('Clipboard access is not available in this environment.');
        }
        return true;
    }

    function updateDocument(mutator, meta = { render: true }) {
        store.setState((state) => ({
            ...state,
            document: normalizeStudioDocumentForDng(mutator(state.document))
        }), meta);
    }

    function updateCompositeDocument(mutator, meta = { renderComposite: true }) {
        const previous = store.getState().compositeDocument;
        const next = normalizeCompositeDocument(mutator(previous));
        store.setState((state) => ({ ...state, compositeDocument: next }), meta);
        if (meta?.compositeAutosave === true) {
            compositeAutosaveDocumentVersion += 1;
            scheduleCompositeAutosave(meta.compositeAutosaveReason || 'Queued Composite autosave after a committed change.');
        }
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

    async function syncImageSource(file, dataUrl, options = {}) {
        const sourceImage = options.sourceImage || await loadImageFromDataUrl(dataUrl);
        const nextSource = normalizeEditorSource({
            name: file.name,
            type: file.type,
            imageData: dataUrl,
            width: sourceImage.width,
            height: sourceImage.height
        });
        const current = store.getState().document;
        const nextBase = normalizeEditorBase(options.base || current.base, nextSource);
        const nextDocument = applyEditorSettingsToDocument({
            ...current,
            source: nextSource,
            base: nextBase
        }, store.getState().settings);
        const synced = await syncStudioEngineToDocument(engine, nextDocument, { sourceImage });
        const syncedDocument = synced?.document || nextDocument;
        updateDocument(() => syncedDocument, { render: false });
        engine.requestRender(syncedDocument);
        return syncedDocument;
    }

    async function loadBatchImage(file, index) {
        await engine.loadImageFromFile(file, {});
        const nextSource = normalizeEditorSource({
            name: file.name,
            type: file.type,
            imageData: null,
            width: engine.runtime.sourceWidth,
            height: engine.runtime.sourceHeight
        });
        const current = store.getState().document;
        const nextDocument = applyEditorSettingsToDocument({
            ...current,
            source: nextSource,
            base: normalizeEditorBase({
                ...current.base,
                width: engine.runtime.sourceWidth,
                height: engine.runtime.sourceHeight
            }, nextSource),
            batch: {
                ...current.batch,
                currentIndex: index
            }
        }, store.getState().settings);
        updateDocument(() => nextDocument, { render: false });
        engine.requestRender(nextDocument);
    }

    async function commitEditorBaseDocument(nextDocument, options = {}) {
        try {
            const normalizedDocument = applyEditorSettingsToDocument(nextDocument, store.getState().settings);
            const synced = await syncStudioEngineToDocument(engine, normalizedDocument, {
                sourceImage: options.sourceImage || null
            });
            const syncedDocument = synced?.document || normalizedDocument;
            updateDocument(() => syncedDocument, { render: false });
            if (options.clearLibraryOrigin !== false) {
                clearActiveLibraryOrigin('studio');
            }
            engine.requestRender(syncedDocument);
            return syncedDocument;
        } catch (error) {
            logProcess('error', 'editor.base', error?.message || 'Could not update the Editor base canvas.');
            setNotice(error?.message || 'Could not update the Editor base canvas.', 'error', 7000);
            return null;
        }
    }

    async function refreshEditorDngPreview(nextDocument, options = {}) {
        const normalizedDocument = normalizeStudioDocumentForDng(
            applyEditorSettingsToDocument(nextDocument, store.getState().settings)
        );
        if (!isDngSource(normalizedDocument.source)) {
            return normalizedDocument;
        }
        const token = ++dngPreviewRefreshToken;
        const statusToken = options.showRenderStatus === false
            ? 0
            : beginDngPreviewRenderStatus({
                title: options.renderStatusTitle || 'Rendering',
                message: options.renderStatusMessage || 'Updating the DNG preview...',
                delayMs: options.renderStatusDelayMs ?? 150
            });
        updateDocument(() => normalizedDocument, { render: false });
        return new Promise((resolve) => {
            engine.requestRender(normalizedDocument, {
                onComplete: () => {
                    if (statusToken) {
                        endDngPreviewRenderStatus(statusToken);
                    }
                    if (token !== dngPreviewRefreshToken) {
                        resolve(null);
                        return;
                    }
                    resolve(normalizedDocument);
                }
            });
        });
    }

    function scheduleEditorDngPreviewRefresh(nextDocument, options = {}) {
        const delayMs = Math.max(0, Number(options.delayMs) || 0);
        if (delayMs <= 0) {
            const pendingResolves = dngPreviewScheduledResolves.splice(0, dngPreviewScheduledResolves.length);
            clearTimeout(dngPreviewScheduleTimer);
            dngPreviewScheduleTimer = null;
            dngPreviewScheduledDocument = null;
            dngPreviewScheduledOptions = null;
            return refreshEditorDngPreview(nextDocument, options).then((result) => {
                pendingResolves.forEach((complete) => complete(result));
                return result;
            });
        }

        dngPreviewScheduledDocument = nextDocument;
        dngPreviewScheduledOptions = { ...options, delayMs: 0 };
        return new Promise((resolve) => {
            dngPreviewScheduledResolves.push(resolve);
            clearTimeout(dngPreviewScheduleTimer);
            dngPreviewScheduleTimer = setTimeout(async () => {
                const scheduledDocument = dngPreviewScheduledDocument;
                const scheduledOptions = dngPreviewScheduledOptions || {};
                const scheduledResolves = dngPreviewScheduledResolves.splice(0, dngPreviewScheduledResolves.length);
                dngPreviewScheduledDocument = null;
                dngPreviewScheduledOptions = null;
                dngPreviewScheduleTimer = null;
                const result = await refreshEditorDngPreview(scheduledDocument, scheduledOptions);
                scheduledResolves.forEach((complete) => complete(result));
            }, delayMs);
        });
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
        const nextSection = section === 'composite'
            ? 'composite'
            : section === 'library'
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
        if (nextSection !== currentSection && backgroundTasks && ['editor', 'composite', 'stitch', '3d'].includes(currentSection)) {
            backgroundTasks.cancelScope(`section:${currentSection}`, {
                reason: `Switched away from ${currentSection === '3d' ? '3D' : currentSection === 'composite' ? 'Composite' : currentSection}.`
            });
        }
        if (nextSection !== currentSection) {
            const sectionLabel = nextSection === '3d'
                ? '3D'
                : nextSection === 'composite'
                    ? 'Composite'
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
        return getLibraryProjectRecordsByCursor();
    }

    async function getAllLibraryAssetRecords() {
        return (await getAllFromLibraryDB())
            .filter((entry) => isLibraryAssetRecord(entry))
            .map((entry) => normalizeLibraryAssetRecord(entry))
            .filter(Boolean);
    }

    async function restoreActiveStudioRender() {
        const liveDocument = store.getState().document;
        if (liveDocument) {
            const synced = await syncStudioEngineToDocument(engine, liveDocument);
            updateDocument(() => synced.document, { render: false });
            engine.requestRender(synced.document);
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
                        const tempDoc = {
                            ...store.getState().document,
                            ...validated,
                            layerStack: validated.layerStack,
                            source: normalizeEditorSource(validated.source),
                            base: normalizeEditorBase(validated.base, validated.source)
                        };
                        const synced = await syncStudioEngineToDocument(engine, tempDoc);
                        const syncedDocument = synced?.document || tempDoc;
                        const capture = await captureStudioDocumentSnapshot(engine, syncedDocument, validated);
                        const nextPayload = capture.payload || buildLibraryPayload(syncedDocument, capture.preview || null);
                        const baseResolution = getEditorCanvasResolution(nextPayload);
                        const nextRecord = buildLibraryProjectRecord({
                            id: projectRecord.id,
                            timestamp: projectRecord.timestamp || Date.now(),
                            name: projectRecord.name,
                            blob: capture.blob || projectRecord.blob,
                            payload: nextPayload,
                            tags: normalizeLibraryTags(projectRecord.tags || extractLibraryProjectMeta(existingPayload).tags || []),
                            projectType: 'studio',
                            hoverSource: projectRecord.hoverSource || nextPayload.source,
                            sourceWidth: Number(projectRecord.sourceWidth || baseResolution.width || 0),
                            sourceHeight: Number(projectRecord.sourceHeight || baseResolution.height || 0),
                            sourceArea: Number(projectRecord.sourceAreaOverride || ((baseResolution.width || 0) * (baseResolution.height || 0)) || 0),
                            sourceCount: Number(projectRecord.sourceCount || (hasPersistableEditorSource(nextPayload.source) ? 1 : 0) || 0),
                            renderWidth: Number(capture.preview?.width || projectRecord.renderWidth || baseResolution.width || 0),
                            renderHeight: Number(capture.preview?.height || projectRecord.renderHeight || baseResolution.height || 0)
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
        if (section === 'composite') return 'composite';
        if (section === '3d') return '3d';
        return section === 'stitch' ? 'stitch' : 'studio';
    }

    function getLibraryProjectType(entry) {
        if (!entry) return 'studio';
        return inferProjectTypeFromPayload(entry.payload, entry.projectType || null);
    }

    function cloneSerializable(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function getComparableStudioPayload(payload = null) {
        if (!payload || typeof payload !== 'object') return null;
        return stripStudioPreview(stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(cloneSerializable(payload))));
    }

    function findMatchingCompositeEditorLayerForEditorDocument(editorDocument, compositeDocument) {
        const editorPayload = getComparableStudioPayload(buildLibraryPayload(editorDocument));
        if (!editorPayload) return null;
        const serializedEditorPayload = stableSerialize(editorPayload);
        return normalizeCompositeDocument(compositeDocument).layers.find((layer) => {
            if (layer?.kind !== 'editor-project' || !layer.embeddedEditorDocument) return false;
            const embeddedPayload = getComparableStudioPayload(layer.embeddedEditorDocument);
            return embeddedPayload && stableSerialize(embeddedPayload) === serializedEditorPayload;
        }) || null;
    }

    async function syncEmbeddedEditorPayloadImageDimensions(payload = null) {
        if (!payload || typeof payload !== 'object') return payload;
        const nextPayload = cloneSerializable(payload);
        let changed = false;

        const previewDataUrl = String(nextPayload?.preview?.imageData || '');
        if (previewDataUrl.startsWith('data:')) {
            try {
                const previewImage = await loadImageFromDataUrl(previewDataUrl);
                const width = Math.max(1, Number(previewImage.naturalWidth || previewImage.width || 1));
                const height = Math.max(1, Number(previewImage.naturalHeight || previewImage.height || 1));
                if (Number(nextPayload.preview.width || 0) !== width || Number(nextPayload.preview.height || 0) !== height) {
                    nextPayload.preview = {
                        ...nextPayload.preview,
                        width,
                        height
                    };
                    changed = true;
                }
            } catch (_error) {
                // Ignore preview dimension healing failures and keep existing metadata.
            }
        }

        const sourceDataUrl = String(nextPayload?.source?.imageData || '');
        if (sourceDataUrl.startsWith('data:')) {
            try {
                const sourceImage = await loadImageFromDataUrl(sourceDataUrl);
                const width = Math.max(1, Number(sourceImage.naturalWidth || sourceImage.width || 1));
                const height = Math.max(1, Number(sourceImage.naturalHeight || sourceImage.height || 1));
                if (Number(nextPayload.source.width || 0) !== width || Number(nextPayload.source.height || 0) !== height) {
                    nextPayload.source = {
                        ...nextPayload.source,
                        width,
                        height
                    };
                    changed = true;
                }
            } catch (_error) {
                // Ignore source dimension healing failures and keep existing metadata.
            }
        }

        return changed ? nextPayload : payload;
    }

    function resolveCompositeEditorLayerRenderSize({ payload = null, preview = null, record = null, sourceMeta = null } = {}) {
        const width = Math.max(
            1,
            Math.round(Number(
                preview?.width
                || payload?.preview?.width
                || sourceMeta?.renderWidth
                || record?.renderWidth
                || payload?.base?.width
                || payload?.source?.width
                || record?.sourceWidth
                || 1
            ) || 1)
        );
        const height = Math.max(
            1,
            Math.round(Number(
                preview?.height
                || payload?.preview?.height
                || sourceMeta?.renderHeight
                || record?.renderHeight
                || payload?.base?.height
                || payload?.source?.height
                || record?.sourceHeight
                || 1
            ) || 1)
        );
        return { width, height };
    }

    function getCompositeBridgeState() {
        return store.getState().ui?.compositeEditorBridge || {
            active: false,
            layerId: null,
            originalLibraryId: null,
            originalLibraryName: null
        };
    }

    function setCompositeBridgeState(nextBridge) {
        store.setState((state) => ({
            ...state,
            ui: {
                ...state.ui,
                compositeEditorBridge: {
                    active: !!nextBridge?.active,
                    layerId: nextBridge?.layerId || null,
                    originalLibraryId: nextBridge?.originalLibraryId || null,
                    originalLibraryName: nextBridge?.originalLibraryName || null
                }
            }
        }), { render: false });
    }

    function clearCompositeBridgeState() {
        setCompositeBridgeState({
            active: false,
            layerId: null,
            originalLibraryId: null,
            originalLibraryName: null
        });
    }

    function clearCompositeAutosaveTimer() {
        if (!compositeAutosaveTimer) return;
        clearTimeout(compositeAutosaveTimer);
        compositeAutosaveTimer = null;
    }

    function mergePersistedGeneratedCompositeDocument(currentDocument, persistedDocument) {
        const liveDocument = normalizeCompositeDocument(currentDocument);
        const savedDocument = normalizeCompositeDocument(persistedDocument);
        const savedGeneratedLayersById = new Map(
            savedDocument.layers
                .filter((layer) => isGeneratedCompositeEditorLayer(layer))
                .map((layer) => [layer.id, layer])
        );
        if (!savedGeneratedLayersById.size) {
            return {
                document: liveDocument,
                mergedCount: 0
            };
        }

        let mergedCount = 0;
        const nextLayers = liveDocument.layers.map((layer) => {
            const savedLayer = savedGeneratedLayersById.get(layer.id);
            if (!savedLayer || !isGeneratedCompositeEditorLayer(layer)) {
                return layer;
            }
            mergedCount += 1;
            const currentSource = layer.source && typeof layer.source === 'object'
                ? layer.source
                : {};
            const savedSource = savedLayer.source && typeof savedLayer.source === 'object'
                ? savedLayer.source
                : {};
            return {
                ...layer,
                embeddedEditorDocument: savedLayer.embeddedEditorDocument || layer.embeddedEditorDocument,
                source: {
                    ...currentSource,
                    originalLibraryId: savedSource.originalLibraryId || currentSource.originalLibraryId || null,
                    originalLibraryName: savedSource.originalLibraryName || currentSource.originalLibraryName || '',
                    originalProjectType: savedSource.originalProjectType || currentSource.originalProjectType || 'studio',
                    generatedFromCompositeImage: savedSource.generatedFromCompositeImage === true || currentSource.generatedFromCompositeImage === true,
                    renderWidth: Math.max(1, Number(savedSource.renderWidth || currentSource.renderWidth || 1)),
                    renderHeight: Math.max(1, Number(savedSource.renderHeight || currentSource.renderHeight || 1))
                }
            };
        });

        return {
            document: mergedCount
                ? normalizeCompositeDocument({
                    ...liveDocument,
                    layers: nextLayers
                })
                : liveDocument,
            mergedCount
        };
    }

    function getCompositeAutosaveCaptureOptions() {
        const forceBackend = canUseCompositeWorkerRendering() ? 'worker' : null;
        const sharedOptions = {
            priority: 'background',
            scope: 'background:composite-autosave'
        };
        return {
            exportOptions: {
                ...sharedOptions,
                processId: 'composite.autosave.export',
                ...(forceBackend ? { forceBackend } : {})
            },
            previewOptions: {
                ...sharedOptions,
                processId: 'composite.autosave.preview',
                replaceKey: 'composite-autosave-preview',
                ...(forceBackend ? { forceBackend } : {})
            }
        };
    }

    async function ensureCompositeEditorRenderEngineReady() {
        if (!compositeEditorRenderEngine) {
            compositeEditorRenderEngine = new NoiseStudioEngine(registry, {
                onNotice: (text, type = 'info') => logTone('composite.render', text, type, {
                    dedupeKey: `composite-hidden-editor:${type}:${text}`,
                    dedupeWindowMs: 300
                })
            });
        }
        if (!compositeEditorRenderCanvas) {
            compositeEditorRenderCanvas = document.createElement('canvas');
            compositeEditorRenderCanvas.width = 1;
            compositeEditorRenderCanvas.height = 1;
        }
        if (!compositeEditorRenderReady) {
            await compositeEditorRenderEngine.init(compositeEditorRenderCanvas);
            compositeEditorRenderReady = true;
        }
        return compositeEditorRenderEngine;
    }

    function buildEditorDocumentFromPayload(rawPayload) {
        const studioAdapter = projectAdapters?.getAdapter('studio');
        const validated = studioAdapter?.validatePayload
            ? studioAdapter.validatePayload(rawPayload)
            : stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload));
        const baseDocument = store.getState().document;
        const runtimePayload = stripStudioPreview(validated);
        const layerStack = reindexStack(registry, runtimePayload.layerStack || [])
            .map((instance) => applyEditorSettingsToLayerInstance(instance, store.getState().settings));
        const requestedSelectionId = runtimePayload.selection?.layerInstanceId;
        const selection = requestedSelectionId && layerStack.some((instance) => instance.instanceId === requestedSelectionId)
            ? runtimePayload.selection
            : { layerInstanceId: layerStack[0]?.instanceId || null };
        return applyEditorSettingsToDocument({
            ...baseDocument,
            ...runtimePayload,
            version: 'mns/v2',
            kind: 'document',
            mode: 'studio',
            workspace: normalizeWorkspace('studio', runtimePayload.workspace || baseDocument.workspace, !!selection.layerInstanceId),
            source: Object.prototype.hasOwnProperty.call(runtimePayload || {}, 'source')
                ? normalizeEditorSource(runtimePayload.source)
                : normalizeEditorSource(baseDocument.source),
            base: normalizeEditorBase(runtimePayload.base, runtimePayload.source),
            palette: runtimePayload.palette || baseDocument.palette,
            layerStack,
            selection,
            view: normalizeViewState({ ...baseDocument.view, ...(runtimePayload.view || {}) }),
            export: { ...baseDocument.export, ...(runtimePayload.export || {}) },
            batch: createEmptyBatchState()
        }, store.getState().settings);
    }

    function buildEditorDocumentFromCompositeImageLayer(layer) {
        const imageAsset = layer?.imageAsset;
        if (!imageAsset?.imageData) {
            throw new Error('This Composite image layer is missing its embedded image data.');
        }
        const baseDocument = store.getState().document;
        const source = {
            width: Math.max(1, Number(imageAsset.width) || 1),
            height: Math.max(1, Number(imageAsset.height) || 1),
            name: String(imageAsset.name || layer?.name || 'Image'),
            type: String(imageAsset.mimeType || 'image/png'),
            imageData: String(imageAsset.imageData || '')
        };
        return applyEditorSettingsToDocument({
            ...baseDocument,
            version: 'mns/v2',
            kind: 'document',
            mode: 'studio',
            workspace: normalizeWorkspace('studio', {
                ...baseDocument.workspace,
                batchOpen: false
            }, false),
            source,
            base: normalizeEditorBase({
                width: source.width,
                height: source.height
            }, source),
            palette: [],
            layerStack: [],
            selection: { layerInstanceId: null },
            view: normalizeViewState({ ...baseDocument.view, zoom: 1 }),
            export: { ...baseDocument.export },
            batch: createEmptyBatchState()
        }, store.getState().settings);
    }

    function buildEditorPayloadFromCompositeImageLayer(layer) {
        return buildLibraryPayload(buildEditorDocumentFromCompositeImageLayer(layer));
    }

    function isGeneratedCompositeEditorLayer(layer) {
        return !!(
            layer
            && layer.kind === 'editor-project'
            && layer.embeddedEditorDocument
            && layer.source?.generatedFromCompositeImage
        );
    }

    async function persistEmbeddedStudioPayloadToLibrary(rawPayload, options = {}) {
        const existingRecord = options.existingRecord && getLibraryProjectType(options.existingRecord) === 'studio'
            ? options.existingRecord
            : null;
        const capture = await captureCompositeEditorLayerDocument(rawPayload);
        const payload = capture.payload || rawPayload;
        const editorDocument = buildEditorDocumentFromPayload(payload);
        const baseResolution = getEditorCanvasResolution(payload);
        const projectData = buildLibraryProjectRecord({
            id: existingRecord?.id || createLibraryProjectId(),
            timestamp: Date.now(),
            name: String(
                options.name
                || existingRecord?.name
                || getSuggestedProjectName(editorDocument)
                || 'Editor Project'
            ).trim() || 'Editor Project',
            blob: capture.blob || null,
            payload,
            tags: normalizeLibraryTags(options.tags || existingRecord?.tags || []),
            projectType: 'studio',
            hoverSource: payload.source,
            sourceWidth: Number(baseResolution.width || 0),
            sourceHeight: Number(baseResolution.height || 0),
            sourceArea: Number(baseResolution.width || 0) * Number(baseResolution.height || 0),
            sourceCount: hasPersistableEditorSource(payload.source) ? 1 : 0,
            renderWidth: Number(capture.preview?.width || payload.preview?.width || baseResolution.width || 0),
            renderHeight: Number(capture.preview?.height || payload.preview?.height || baseResolution.height || 0)
        });
        await saveToLibraryDB(projectData);
        await upsertDerivedStudioAsset(projectData);
        return {
            projectData,
            payload
        };
    }

    async function persistGeneratedCompositeEditorProjects(documentState, options = {}) {
        const normalized = normalizeCompositeDocument(documentState);
        const nextLayers = [...normalized.layers];
        let savedCount = 0;

        for (let index = 0; index < nextLayers.length; index += 1) {
            const layer = nextLayers[index];
            if (!isGeneratedCompositeEditorLayer(layer)) continue;

            const existingRecord = layer.source?.originalLibraryId
                ? await getFromLibraryDB(layer.source.originalLibraryId).catch(() => null)
                : null;
            const fallbackName = `${stripProjectExtension(layer.name || 'Composite Image')} Editor`;
            const { projectData, payload } = await persistEmbeddedStudioPayloadToLibrary(layer.embeddedEditorDocument, {
                existingRecord,
                name: layer.source?.originalLibraryName || fallbackName
            });
            nextLayers[index] = {
                ...layer,
                embeddedEditorDocument: payload,
                source: {
                    ...layer.source,
                    originalLibraryId: projectData.id,
                    originalLibraryName: projectData.name,
                    originalProjectType: 'studio',
                    generatedFromCompositeImage: true,
                    renderWidth: Math.max(1, Number(projectData.renderWidth || payload?.preview?.width || payload?.source?.width || 1)),
                    renderHeight: Math.max(1, Number(projectData.renderHeight || payload?.preview?.height || payload?.source?.height || 1))
                }
            };
            savedCount += 1;
            await maybeYieldToUi(index, 1);
        }

        const nextDocument = savedCount
            ? normalizeCompositeDocument({
                ...normalized,
                layers: nextLayers
            })
            : normalized;

        if (savedCount && options.updateStore) {
            updateCompositeDocument((currentDocument) => mergePersistedGeneratedCompositeDocument(currentDocument, nextDocument).document, {
                renderComposite: false,
                skipCompositeAutosave: true
            });
        }
        if (savedCount) {
            notifyLibraryChanged();
            if (options.log !== false) {
                logProcess('success', 'composite.link', `Saved ${savedCount} generated Editor project${savedCount === 1 ? '' : 's'} linked from Composite.`);
            }
        }

        return {
            document: nextDocument,
            savedCount
        };
    }

    async function captureCompositeEditorLayerDocument(rawPayload) {
        const preparedPayload = await syncEmbeddedEditorPayloadImageDimensions(rawPayload);
        const editorDocument = buildEditorDocumentFromPayload(preparedPayload);
        const hiddenEngine = await ensureCompositeEditorRenderEngineReady();
        const synced = await syncStudioEngineToDocument(hiddenEngine, editorDocument);
        const syncedDocument = synced?.document || editorDocument;
        const capture = await captureStudioDocumentSnapshot(hiddenEngine, syncedDocument, preparedPayload);
        const payload = await syncEmbeddedEditorPayloadImageDimensions(capture.payload || preparedPayload);
        return {
            ...capture,
            preview: payload?.preview || capture.preview || null,
            payload
        };
    }

    async function convertCompositeImageLayerToEditorProject(layerId, options = {}) {
        const compositeState = normalizeCompositeDocument(store.getState().compositeDocument);
        const currentLayer = compositeState.layers.find((layer) => layer.id === layerId) || null;
        if (!currentLayer) {
            throw new Error('That Composite layer could not be found.');
        }
        if (currentLayer.kind === 'editor-project' && currentLayer.embeddedEditorDocument) {
            if (options.openInEditor) {
                return openCompositeLayerInEditorFlow(currentLayer.id, { allowImageConversion: false });
            }
            return currentLayer;
        }
        if (currentLayer.kind !== 'image' || !currentLayer.imageAsset?.imageData) {
            throw new Error('Select an embedded image layer before converting it into an Editor project.');
        }

        const payload = buildEditorPayloadFromCompositeImageLayer(currentLayer);
        const capture = await captureCompositeEditorLayerDocument(payload);
        const renderSize = resolveCompositeEditorLayerRenderSize({
            payload: capture.payload,
            preview: capture.preview,
            sourceMeta: currentLayer.source
        });
        const nextLayer = {
            ...currentLayer,
            kind: 'editor-project',
            embeddedEditorDocument: capture.payload,
            imageAsset: null,
            source: {
                ...currentLayer.source,
                originalProjectType: 'studio',
                generatedFromCompositeImage: true,
                renderWidth: renderSize.width,
                renderHeight: renderSize.height
            }
        };
        updateCompositeDocument((documentState) => ({
            ...normalizeCompositeDocument(documentState),
            layers: normalizeCompositeDocument(documentState).layers.map((layer) => layer.id === currentLayer.id ? nextLayer : layer),
            selection: { layerId: currentLayer.id }
        }), {
            renderComposite: true,
            compositeAutosave: true,
            compositeAutosaveReason: 'Queued Composite autosave after converting an image layer into an Editor project.'
        });

        logProcess('success', 'composite.link', `Converted "${currentLayer.name || 'Image'}" into a linked Editor project inside Composite.`);
        if (options.openInEditor) {
            await openCompositeLayerInEditorFlow(currentLayer.id, { allowImageConversion: false });
        } else if (!options.suppressNotice) {
            setNotice(`Converted "${currentLayer.name || 'Image'}" into a linked Editor project.`, 'success', 5200);
        }
        return nextLayer;
    }

    async function openCompositeLayerInEditorFlow(layerId = null, options = {}) {
        let compositeState = normalizeCompositeDocument(store.getState().compositeDocument);
        let selectedLayer = layerId
            ? compositeState.layers.find((layer) => layer.id === layerId) || null
            : getSelectedCompositeLayer(compositeState);
        let alreadyCheckedEditorReplace = false;
        if (!selectedLayer) {
            setNotice('Select a Composite layer first.', 'warning', 6000);
            return false;
        }
        if (selectedLayer.kind === 'image' && selectedLayer.imageAsset?.imageData && options.allowImageConversion !== false) {
            if (!await ensureProjectCanBeReplaced('studio', 'opening the linked Composite layer in Editor')) {
                return false;
            }
            alreadyCheckedEditorReplace = true;
            await convertCompositeImageLayerToEditorProject(selectedLayer.id, {
                openInEditor: false,
                suppressNotice: true
            });
            compositeState = normalizeCompositeDocument(store.getState().compositeDocument);
            selectedLayer = compositeState.layers.find((layer) => layer.id === selectedLayer.id) || null;
        }
        if (!selectedLayer || selectedLayer.kind !== 'editor-project' || !selectedLayer.embeddedEditorDocument) {
            setNotice('Select a linked Editor layer or convert an image layer first.', 'warning', 6000);
            return false;
        }

        const currentEditorDocument = store.getState().document;
        const matchingCompositeLayer = findMatchingCompositeEditorLayerForEditorDocument(currentEditorDocument, compositeState);
        if (!matchingCompositeLayer && !alreadyCheckedEditorReplace && !await ensureProjectCanBeReplaced('studio', 'opening the linked Composite layer in Editor')) {
            return false;
        }

        const editorDocument = buildEditorDocumentFromPayload(selectedLayer.embeddedEditorDocument);
        const synced = await syncStudioEngineToDocument(engine, editorDocument);
        const syncedDocument = synced?.document || editorDocument;
        stopPlayback();
        paletteExtractionImage = null;
        paletteExtractionOwner = null;
        updateDocument(() => syncedDocument, { render: false });
        if (selectedLayer.source?.generatedFromCompositeImage && selectedLayer.source?.originalLibraryId) {
            setActiveLibraryOrigin('studio', selectedLayer.source.originalLibraryId, selectedLayer.source.originalLibraryName);
        } else {
            clearActiveLibraryOrigin('studio');
        }
        setCompositeBridgeState({
            active: true,
            layerId: selectedLayer.id,
            originalLibraryId: selectedLayer.source?.originalLibraryId || null,
            originalLibraryName: selectedLayer.source?.originalLibraryName || null
        });
        commitActiveSection('editor');
        engine.requestRender(syncedDocument);
        logProcess('success', 'composite.link', matchingCompositeLayer
            ? `Switched Editor from Composite-linked layer "${matchingCompositeLayer.name || 'Layer'}" to "${selectedLayer.name || 'Layer'}" without an extra save prompt.`
            : `Opened "${selectedLayer.name || 'Layer'}" in Editor from Composite.`);
        return true;
    }

    function getCompositeLayerPlacement(documentState, sourceWidth, sourceHeight, viewportMetrics = null, options = {}) {
        const normalized = normalizeCompositeDocument(documentState);
        const metrics = normalizeCompositeViewportMetrics(viewportMetrics);
        return computeCompositeFittedLayerPlacement({
            document: normalized,
            sourceWidth,
            sourceHeight,
            viewportWidth: metrics.width,
            viewportHeight: metrics.height,
            cascadeIndex: Math.min(normalized.layers.length, 4),
            cascadePx: Number(options.cascadePx) || 36,
            fit: Number(options.fit) || 0.82,
            maxScale: Math.max(0.01, Number(options.maxScale) || 1)
        });
    }

    function createCompositeImageLayerFromPreparedItem(item, documentState, viewportMetrics = null) {
        const width = Math.max(1, Number(item?.width) || 1);
        const height = Math.max(1, Number(item?.height) || 1);
        const position = getCompositeLayerPlacement(documentState, width, height, viewportMetrics);
        return {
            id: createCompositeLayerId('image'),
            kind: 'image',
            name: stripProjectExtension(item?.name || 'Image') || 'Image',
            visible: true,
            locked: false,
            z: normalizeCompositeDocument(documentState).layers.length,
            x: position.x,
            y: position.y,
            scale: position.scale,
            scaleX: position.scale,
            scaleY: position.scale,
            resizeMode: 'center-uniform',
            rotation: 0,
            opacity: 1,
            blendMode: 'normal',
            source: {
                originalLibraryId: null,
                originalLibraryName: null,
                originalProjectType: null
            },
            imageAsset: {
                name: item?.name || 'Image',
                type: item?.type || 'image/png',
                imageData: String(item?.imageData || ''),
                width,
                height
            }
        };
    }

    function getCompositeReplacementBaseLayer(currentLayer) {
        const normalizedLayer = normalizeCompositeDocument({
            layers: currentLayer ? [currentLayer] : [],
            selection: {
                layerId: currentLayer?.id || null
            }
        }).layers[0] || null;
        if (!normalizedLayer) {
            throw new Error('That Composite layer could not be found.');
        }
        return normalizedLayer;
    }

    function buildCompositeReplacementLayer(currentLayer, replacement = {}) {
        const baseLayer = getCompositeReplacementBaseLayer(currentLayer);
        const nextKind = String(replacement.kind || 'image').toLowerCase() === 'editor-project' ? 'editor-project' : 'image';
        const baseDimensions = getCompositeLayerDimensions(baseLayer);
        const baseScaleX = Math.max(0.000001, Number(baseLayer.scaleX || baseLayer.scale || 1) || 1);
        const baseScaleY = Math.max(0.000001, Number(baseLayer.scaleY || baseLayer.scale || 1) || 1);
        const baseRenderedWidth = Math.max(1, baseDimensions.width * baseScaleX);
        const baseRenderedHeight = Math.max(1, baseDimensions.height * baseScaleY);
        const baseCenterX = Number(baseLayer.x || 0) + (baseRenderedWidth * 0.5);
        const baseCenterY = Number(baseLayer.y || 0) + (baseRenderedHeight * 0.5);
        const replacementProbeLayer = {
            kind: nextKind,
            source: replacement.source || null,
            embeddedEditorDocument: nextKind === 'editor-project' ? replacement.embeddedEditorDocument || null : null,
            imageAsset: nextKind === 'image' ? replacement.imageAsset || null : null,
            crop: {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0
            }
        };
        const replacementDimensions = getCompositeLayerDimensions(replacementProbeLayer);
        const fitScale = Math.max(
            0.000001,
            Math.min(
                baseRenderedWidth / Math.max(1, replacementDimensions.width),
                baseRenderedHeight / Math.max(1, replacementDimensions.height)
            )
        );
        const nextRenderedWidth = replacementDimensions.width * fitScale;
        const nextRenderedHeight = replacementDimensions.height * fitScale;
        return {
            id: baseLayer.id,
            kind: nextKind,
            name: String(replacement.name || baseLayer.name || (nextKind === 'editor-project' ? 'Editor Project' : 'Image')),
            visible: baseLayer.visible !== false,
            locked: !!baseLayer.locked,
            z: baseLayer.z,
            x: baseCenterX - (nextRenderedWidth * 0.5),
            y: baseCenterY - (nextRenderedHeight * 0.5),
            scale: fitScale,
            scaleX: fitScale,
            scaleY: fitScale,
            resizeMode: baseLayer.resizeMode,
            rotation: baseLayer.rotation,
            flipX: !!baseLayer.flipX,
            flipY: !!baseLayer.flipY,
            opacity: baseLayer.opacity,
            blendMode: baseLayer.blendMode,
            source: replacement.source || {
                originalLibraryId: null,
                originalLibraryName: null,
                originalProjectType: null
            },
            embeddedEditorDocument: nextKind === 'editor-project' ? replacement.embeddedEditorDocument || null : null,
            imageAsset: nextKind === 'image' ? replacement.imageAsset || null : null,
            textAsset: null,
            squareAsset: null,
            circleAsset: null,
            triangleAsset: null,
            crop: {
                left: 0,
                top: 0,
                right: 0,
                bottom: 0
            }
        };
    }

    function createCompositeTextLayer(documentState, viewportMetrics = null) {
        const baseLayer = {
            id: createCompositeLayerId('text'),
            kind: 'text',
            name: 'Text',
            visible: true,
            locked: false,
            z: normalizeCompositeDocument(documentState).layers.length,
            x: 0,
            y: 0,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
            resizeMode: 'center-uniform',
            rotation: 0,
            opacity: 1,
            blendMode: 'normal',
            source: {
                originalLibraryId: null,
                originalLibraryName: null,
                originalProjectType: null
            },
            textAsset: {
                text: 'Text',
                fontFamily: 'Arial',
                fontSize: 96,
                color: '#ffffff'
            }
        };
        const dimensions = getCompositeLayerDimensions(baseLayer);
        const position = getCompositeLayerPlacement(documentState, dimensions.width, dimensions.height, viewportMetrics, {
            maxScale: 8,
            fit: 0.62
        });
        return {
            ...baseLayer,
            x: position.x,
            y: position.y,
            scale: position.scale,
            scaleX: position.scale,
            scaleY: position.scale
        };
    }

    function createCompositeSquareLayer(documentState, viewportMetrics = null) {
        const baseLayer = {
            id: createCompositeLayerId('square'),
            kind: 'square',
            name: 'Square',
            visible: true,
            locked: false,
            z: normalizeCompositeDocument(documentState).layers.length,
            x: 0,
            y: 0,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
            resizeMode: 'center-uniform',
            rotation: 0,
            opacity: 1,
            blendMode: 'normal',
            source: {
                originalLibraryId: null,
                originalLibraryName: null,
                originalProjectType: null
            },
            squareAsset: {
                color: '#ffffff'
            }
        };
        const dimensions = getCompositeLayerDimensions(baseLayer);
        const position = getCompositeLayerPlacement(documentState, dimensions.width, dimensions.height, viewportMetrics, {
            maxScale: 256,
            fit: 0.42
        });
        return {
            ...baseLayer,
            x: position.x,
            y: position.y,
            scale: position.scale,
            scaleX: position.scale,
            scaleY: position.scale
        };
    }

    function createCompositeCircleLayer(documentState, viewportMetrics = null) {
        const baseLayer = {
            id: createCompositeLayerId('circle'),
            kind: 'circle',
            name: 'Circle',
            visible: true,
            locked: false,
            z: normalizeCompositeDocument(documentState).layers.length,
            x: 0,
            y: 0,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
            resizeMode: 'center-uniform',
            rotation: 0,
            opacity: 1,
            blendMode: 'normal',
            source: {
                originalLibraryId: null,
                originalLibraryName: null,
                originalProjectType: null
            },
            circleAsset: {
                color: '#ffffff'
            }
        };
        const dimensions = getCompositeLayerDimensions(baseLayer);
        const position = getCompositeLayerPlacement(documentState, dimensions.width, dimensions.height, viewportMetrics, {
            maxScale: 256,
            fit: 0.42
        });
        return {
            ...baseLayer,
            x: position.x,
            y: position.y,
            scale: position.scale,
            scaleX: position.scale,
            scaleY: position.scale
        };
    }

    function createCompositeTriangleLayer(documentState, viewportMetrics = null) {
        const baseLayer = {
            id: createCompositeLayerId('triangle'),
            kind: 'triangle',
            name: 'Triangle',
            visible: true,
            locked: false,
            z: normalizeCompositeDocument(documentState).layers.length,
            x: 0,
            y: 0,
            scale: 1,
            scaleX: 1,
            scaleY: 1,
            resizeMode: 'center-uniform',
            rotation: 0,
            opacity: 1,
            blendMode: 'normal',
            source: {
                originalLibraryId: null,
                originalLibraryName: null,
                originalProjectType: null
            },
            triangleAsset: {
                color: '#ffffff'
            }
        };
        const dimensions = getCompositeLayerDimensions(baseLayer);
        const position = getCompositeLayerPlacement(documentState, dimensions.width, dimensions.height, viewportMetrics, {
            maxScale: 256,
            fit: 0.42
        });
        return {
            ...baseLayer,
            x: position.x,
            y: position.y,
            scale: position.scale,
            scaleX: position.scale,
            scaleY: position.scale
        };
    }

    function moveCompositeLayerInVisualOrder(documentState, layerId, targetIndex) {
        const normalized = normalizeCompositeDocument(documentState);
        const visualLayers = [...normalized.layers].sort((a, b) => (b.z || 0) - (a.z || 0));
        const currentIndex = visualLayers.findIndex((layer) => layer.id === layerId);
        if (currentIndex < 0) return normalized;
        const boundedTargetIndex = Math.max(0, Math.min(visualLayers.length - 1, targetIndex));
        if (boundedTargetIndex === currentIndex) return normalized;
        const [moved] = visualLayers.splice(currentIndex, 1);
        visualLayers.splice(boundedTargetIndex, 0, moved);
        return normalizeCompositeDocument({
            ...normalized,
            layers: [...visualLayers].reverse().map((layer, index) => ({
                ...layer,
                z: index
            }))
        });
    }

    function scheduleCompositeAutosave(reason = 'Composite project updated.') {
        clearCompositeAutosaveTimer();
        if (!getActiveLibraryOrigin('composite')?.id) return;
        compositeAutosaveTimer = setTimeout(() => {
            compositeAutosaveTimer = null;
            flushCompositeAutosave({ reason }).catch((error) => {
                console.error(error);
            });
        }, 10000);
        logProcess('active', 'composite.autosave', reason, {
            dedupeKey: `composite-autosave-scheduled:${getActiveLibraryOrigin('composite')?.id || 'none'}`,
            dedupeWindowMs: 1200
        });
    }

    async function flushCompositeAutosave(options = {}) {
        clearCompositeAutosaveTimer();
        const scheduledVersion = compositeAutosaveDocumentVersion;
        await nextPaint();
        if (scheduledVersion !== compositeAutosaveDocumentVersion) {
            scheduleCompositeAutosave('Deferred Composite autosave because a newer change landed as save was starting.');
            return null;
        }

        const activeOrigin = getActiveLibraryOrigin('composite');
        const normalized = normalizeCompositeDocument(store.getState().compositeDocument);
        if (!activeOrigin?.id || !normalized.layers.length || compositeAutosaveInFlight) {
            return null;
        }

        compositeAutosaveInFlight = true;
        const saveVersion = compositeAutosaveDocumentVersion;
        try {
            logProcess('active', 'composite.autosave', options.reason || `Autosaving "${activeOrigin.name || 'Composite Project'}" to the Library...`);
            const saved = await actions.saveProjectToLibrary(
                activeOrigin.name || getSuggestedCompositeProjectName(normalized),
                {
                    projectType: 'composite',
                    preferExisting: true,
                    promptless: true,
                    suppressWorkspaceOverlay: true,
                    suppressNotice: true,
                    captureOptions: getCompositeAutosaveCaptureOptions()
                }
            );
            if (saved) {
                logProcess('success', 'composite.autosave', `Autosaved "${saved.name || activeOrigin.name || 'Composite Project'}" to the Library.`);
            }
            return saved;
        } catch (error) {
            logProcess('warning', 'composite.autosave', error?.message || 'Could not autosave the Composite project.');
            return null;
        } finally {
            compositeAutosaveInFlight = false;
            if (compositeAutosaveDocumentVersion !== saveVersion) {
                scheduleCompositeAutosave('Queued follow-up Composite autosave after newer changes landed during save.');
            }
        }
    }

    async function syncBridgeEditorDocumentBackToComposite() {
        const bridge = getCompositeBridgeState();
        if (!bridge.active || !bridge.layerId) {
            return false;
        }
        const state = store.getState();
        const currentLayer = normalizeCompositeDocument(state.compositeDocument).layers.find((layer) => layer.id === bridge.layerId) || null;
        if (!currentLayer || currentLayer.kind !== 'editor-project') {
            clearCompositeBridgeState();
            return false;
        }
        let editorDocument = state.document;
        if (!engine.hasImage()) {
            const synced = await syncStudioEngineToDocument(engine, state.document);
            editorDocument = synced?.document || state.document;
            updateDocument(() => editorDocument, { render: false });
        }
        const capture = await captureStudioDocumentSnapshot(engine, editorDocument);
        const renderSize = resolveCompositeEditorLayerRenderSize({
            payload: capture.payload,
            preview: capture.preview,
            sourceMeta: currentLayer.source
        });
        const activeStudioOrigin = getActiveLibraryOrigin('studio');
        const nextSource = currentLayer.source?.generatedFromCompositeImage && activeStudioOrigin?.id
            ? {
                ...currentLayer.source,
                originalLibraryId: activeStudioOrigin.id,
                originalLibraryName: activeStudioOrigin.name || currentLayer.source?.originalLibraryName || null,
                originalProjectType: 'studio',
                generatedFromCompositeImage: true,
                renderWidth: renderSize.width,
                renderHeight: renderSize.height
            }
            : {
                ...currentLayer.source,
                renderWidth: renderSize.width,
                renderHeight: renderSize.height
            };
        updateCompositeDocument((documentState) => ({
            ...normalizeCompositeDocument(documentState),
            layers: normalizeCompositeDocument(documentState).layers.map((layer) => layer.id === bridge.layerId
                ? {
                    ...layer,
                    embeddedEditorDocument: capture.payload,
                    source: nextSource
                }
                : layer)
        }), {
            renderComposite: true,
            compositeAutosave: true,
            compositeAutosaveReason: 'Queued Composite autosave after syncing linked Editor changes.'
        });
        logProcess('success', 'composite.link', `Updated the linked Composite layer "${currentLayer.name || 'Layer'}" from Editor.`);
        clearCompositeBridgeState();
        return true;
    }

    async function queueCompositeLayerRerenders(layerIds = []) {
        const uniqueIds = [...new Set((layerIds || []).filter(Boolean))];
        for (let index = 0; index < uniqueIds.length; index += 1) {
            const layerId = uniqueIds[index];
            const layer = normalizeCompositeDocument(store.getState().compositeDocument).layers.find((entry) => entry.id === layerId) || null;
            if (!layer || layer.kind !== 'editor-project' || !layer.embeddedEditorDocument) continue;
            try {
                const capture = await captureCompositeEditorLayerDocument(layer.embeddedEditorDocument);
                const renderSize = resolveCompositeEditorLayerRenderSize({
                    payload: capture.payload,
                    preview: capture.preview,
                    sourceMeta: layer.source
                });
                updateCompositeDocument((documentState) => ({
                    ...normalizeCompositeDocument(documentState),
                    layers: normalizeCompositeDocument(documentState).layers.map((entry) => entry.id === layerId
                        ? {
                            ...entry,
                            embeddedEditorDocument: capture.payload,
                            source: {
                                ...entry.source,
                                renderWidth: renderSize.width,
                                renderHeight: renderSize.height
                            }
                        }
                        : entry)
                }), {
                    renderComposite: true,
                    compositeAutosave: true,
                    compositeAutosaveReason: 'Queued Composite autosave after refreshing an embedded Editor layer.'
                });
                logProgressProcess('composite.render', `Refreshed embedded Editor layer ${index + 1}/${uniqueIds.length}.`, (index + 1) / Math.max(1, uniqueIds.length), {
                    dedupeKey: `composite-rerender:${layerId}:${index}`
                });
            } catch (error) {
                logProcess('warning', 'composite.render', error?.message || `Could not refresh the embedded Editor render for "${layer.name || 'Layer'}".`);
            }
            await maybeYieldToUi(index, 1);
        }
    }

    function isLikelyImageFile(file) {
        const mimeType = String(file?.type || '').toLowerCase();
        if (mimeType.startsWith('image/')) return true;
        return /\.(png|apng|jpe?g|webp|gif|bmp|tiff?|avif|ico|svg)$/i.test(String(file?.name || ''));
    }

    async function prepareCompositeImageFilesFallback(files, options = {}) {
        const sourceFiles = (files || []).filter((file) => isLikelyImageFile(file));
        const items = [];
        const failures = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            const file = sourceFiles[index];
            try {
                options.onProgress?.({
                    index,
                    total: sourceFiles.length,
                    file,
                    message: `Reading "${file.name}" for Composite.`,
                    progress: sourceFiles.length ? index / sourceFiles.length : 0
                });
                const imageData = await fileToDataUrl(file);
                const image = await loadImageFromDataUrl(imageData);
                items.push({
                    name: file.name || 'Image',
                    type: file.type || 'image/png',
                    imageData,
                    width: Math.max(1, image.naturalWidth || image.width || 1),
                    height: Math.max(1, image.naturalHeight || image.height || 1)
                });
                options.onProgress?.({
                    index: index + 1,
                    total: sourceFiles.length,
                    file,
                    message: `Prepared "${file.name}" for Composite.`,
                    progress: sourceFiles.length ? (index + 0.9) / sourceFiles.length : 0.9
                });
            } catch (error) {
                failures.push({
                    name: String(file?.name || 'Unnamed image'),
                    reason: error?.message || 'Could not read this image.'
                });
            }
        }
        return { items, failures };
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
            return await getLibraryProjectRecordsByCursor({
                filterRecord(entry) {
                    if (!entry.payload || isLibraryMetaRecord(entry)) return false;
                    if (projectType && getLibraryProjectType(entry) !== projectType) return false;
                    return makeProjectFingerprint(entry.payload) === fingerprint;
                },
                mapRecord(entry) {
                    return {
                        id: entry.id,
                        name: entry.name,
                        projectType: getLibraryProjectType(entry)
                    };
                }
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
        if (normalized === 'personalization' || normalized.startsWith('personalization.')) return 'settings.personalization';
        if (normalized.startsWith('library.')) return 'settings.library';
        if (normalized.startsWith('editor.')) return 'settings.editor';
        if (normalized.startsWith('composite.')) return 'settings.composite';
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

    function shouldRenderCompositeForSettingsPath(path = '') {
        return String(path || '').startsWith('composite.');
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
                renderComposite: shouldRenderCompositeForSettingsPath(path),
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
                renderComposite: normalizedCategory === 'composite',
                renderStitch: normalizedCategory === 'general'
            });
            logProcess('success', getSettingsProcessIdForPath(normalizedCategory === '3d' ? 'threeD' : normalizedCategory), `Reset the ${normalizedCategory === '3d' ? '3D' : normalizedCategory} settings category to defaults.`);
            if (normalizedCategory === 'library') {
                view?.refreshLibrary?.();
            }
            return true;
        },
        async resetPersonalizationPalette(theme) {
            const paletteKey = String(theme || '').trim().toLowerCase() === 'dark' ? 'dark' : 'light';
            const defaults = createDefaultPersonalizationSettings();
            updateSettingsState((current) => ({
                ...current,
                personalization: {
                    ...(current.personalization || defaults),
                    [paletteKey]: { ...defaults[paletteKey] }
                }
            }));
            logProcess('success', 'settings.personalization', `Reset the ${paletteKey} palette to defaults.`);
            return true;
        },
        async copyPersonalizationPalette(sourceTheme, targetTheme) {
            const source = String(sourceTheme || '').trim().toLowerCase() === 'dark' ? 'dark' : 'light';
            const target = String(targetTheme || '').trim().toLowerCase() === 'dark' ? 'dark' : 'light';
            if (source === target) return false;
            updateSettingsState((current) => {
                const personalization = current?.personalization || createDefaultPersonalizationSettings();
                return {
                    ...current,
                    personalization: {
                        ...personalization,
                        [target]: { ...(personalization[source] || {}) }
                    }
                };
            });
            logProcess('success', 'settings.personalization', `Copied the ${source} palette to ${target}.`);
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
                renderComposite: true,
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
                    renderComposite: true,
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
        async setActiveSection(section) {
            const currentState = store.getState();
            const currentSection = currentState.ui.activeSection;
            const nextSection = section === 'composite'
                ? 'composite'
                : section === 'library'
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
            if (nextSection === currentSection) return;

            if (currentSection === 'composite' && nextSection !== 'composite') {
                await flushCompositeAutosave({
                    reason: 'Flushing pending Composite autosave before switching sections.'
                });
            }

            if (currentSection === 'composite' && nextSection === 'editor') {
                const compositeState = normalizeCompositeDocument(store.getState().compositeDocument);
                const selectedLayer = getSelectedCompositeLayer(compositeState);
                if (
                    (selectedLayer?.kind === 'editor-project' && selectedLayer.embeddedEditorDocument)
                    || (selectedLayer?.kind === 'image' && selectedLayer.imageAsset?.imageData)
                ) {
                    try {
                        await openCompositeLayerInEditorFlow(selectedLayer.id);
                        return;
                    } catch (error) {
                        logProcess('error', 'composite.link', error?.message || 'Could not open the selected Composite layer in Editor.');
                        setNotice(error?.message || 'Could not open the selected Composite layer in Editor.', 'error', 7000);
                        return;
                    }
                }
            }

            if (getCompositeBridgeState().active && nextSection !== 'editor') {
                try {
                    await syncBridgeEditorDocumentBackToComposite();
                } catch (error) {
                    logProcess('warning', 'composite.link', error?.message || 'Could not sync the linked Editor changes back into Composite.');
                    setNotice(error?.message || 'Could not sync the linked Editor changes back into Composite.', 'warning', 7000);
                }
            }

            commitActiveSection(nextSection);
        },
        async newCompositeProject() {
            if (!await ensureProjectCanBeReplaced('composite', 'starting a new Composite project')) return false;
            clearCompositeAutosaveTimer();
            clearCompositeBridgeState();
            updateCompositeDocument(() => createSettingsDrivenCompositeDocument(store.getState().settings), {
                renderComposite: true,
                skipCompositeAutosave: true
            });
            clearActiveLibraryOrigin('composite');
            commitActiveSection('composite');
            logProcess('success', 'composite.workspace', 'Started a new Composite project.');
            setNotice('Started a new Composite project.', 'success', 4200);
            return true;
        },
        openCompositeImagePicker() {
            view?.openCompositeImagePicker?.();
        },
        openCompositeStatePicker() {
            view?.openCompositeStatePicker?.();
        },
        openCompositeProjectPicker() {
            return view?.openCompositeProjectPicker?.();
        },
        openCompositeReplaceMenu() {
            return view?.openCompositeReplaceMenu?.();
        },
        async openCompositeLayerInEditor(layerId = null) {
            return openCompositeLayerInEditorFlow(layerId);
        },
        async convertCompositeLayerToEditorProject(layerId = null, options = {}) {
            if (!layerId) {
                const selectedLayer = getSelectedCompositeLayer(normalizeCompositeDocument(store.getState().compositeDocument));
                if (!selectedLayer?.id) {
                    setNotice('Select an image layer first.', 'warning', 6000);
                    return false;
                }
                layerId = selectedLayer.id;
            }
            try {
                await convertCompositeImageLayerToEditorProject(layerId, options);
                return true;
            } catch (error) {
                logProcess('error', 'composite.link', error?.message || 'Could not convert that Composite image layer into an Editor project.');
                setNotice(error?.message || 'Could not convert that Composite image layer into an Editor project.', 'error', 7000);
                return false;
            }
        },
        addCompositeTextLayer() {
            const viewportMetrics = getCompositeViewportMetrics();
            const nextLayer = createCompositeTextLayer(store.getState().compositeDocument, viewportMetrics);
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    workspace: {
                        ...normalized.workspace,
                        sidebarView: 'transform'
                    },
                    layers: [...normalized.layers, nextLayer],
                    selection: { layerId: nextLayer.id }
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after adding a text layer.'
            });
            logProcess('success', 'composite.layers', 'Added a text layer to Composite.');
            setNotice('Added a text layer to Composite.', 'success', 4200);
        },
        addCompositeSquareLayer() {
            const viewportMetrics = getCompositeViewportMetrics();
            const nextLayer = createCompositeSquareLayer(store.getState().compositeDocument, viewportMetrics);
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    workspace: {
                        ...normalized.workspace,
                        sidebarView: 'transform'
                    },
                    layers: [...normalized.layers, nextLayer],
                    selection: { layerId: nextLayer.id }
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after adding a square layer.'
            });
            logProcess('success', 'composite.layers', 'Added a square layer to Composite.');
            setNotice('Added a square layer to Composite.', 'success', 4200);
        },
        addCompositeCircleLayer() {
            const viewportMetrics = getCompositeViewportMetrics();
            const nextLayer = createCompositeCircleLayer(store.getState().compositeDocument, viewportMetrics);
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    workspace: {
                        ...normalized.workspace,
                        sidebarView: 'transform'
                    },
                    layers: [...normalized.layers, nextLayer],
                    selection: { layerId: nextLayer.id }
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after adding a circle layer.'
            });
            logProcess('success', 'composite.layers', 'Added a circle layer to Composite.');
            setNotice('Added a circle layer to Composite.', 'success', 4200);
        },
        addCompositeTriangleLayer() {
            const viewportMetrics = getCompositeViewportMetrics();
            const nextLayer = createCompositeTriangleLayer(store.getState().compositeDocument, viewportMetrics);
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    workspace: {
                        ...normalized.workspace,
                        sidebarView: 'transform'
                    },
                    layers: [...normalized.layers, nextLayer],
                    selection: { layerId: nextLayer.id }
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after adding a triangle layer.'
            });
            logProcess('success', 'composite.layers', 'Added a triangle layer to Composite.');
            setNotice('Added a triangle layer to Composite.', 'success', 4200);
        },
        setCompositeSidebarView(sidebarView) {
            const nextSidebarView = ['layers', 'transform', 'blend', 'export'].includes(String(sidebarView || '').toLowerCase())
                ? String(sidebarView).toLowerCase()
                : 'layers';
            updateCompositeDocument((documentState) => ({
                ...documentState,
                workspace: {
                    ...documentState.workspace,
                    sidebarView: nextSidebarView
                }
            }), { renderComposite: true });
        },
        selectCompositeLayer(layerId) {
            updateCompositeDocument((documentState) => ({
                ...documentState,
                selection: {
                    layerId: layerId || null
                }
            }), { renderComposite: true, skipCompositeAutosave: true });
        },
        updateCompositeLayerFields(layerId, patch = {}) {
            if (!layerId || !patch || typeof patch !== 'object') return;
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    layers: normalized.layers.map((layer) => layer.id === layerId
                        ? {
                            ...layer,
                            ...patch
                        }
                        : layer)
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after updating layer settings.'
            });
        },
        updateCompositeLayerBatch(patchesById = {}) {
            const entries = Object.entries(patchesById || {}).filter(([layerId, patch]) => layerId && patch && typeof patch === 'object');
            if (!entries.length) return;
            const patchMap = new Map(entries);
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    layers: normalized.layers.map((layer) => patchMap.has(layer.id)
                        ? {
                            ...layer,
                            ...patchMap.get(layer.id)
                        }
                        : layer)
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after updating multiple layer settings.'
            });
        },
        toggleCompositeLayerVisible(layerId) {
            if (!layerId) return;
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    layers: normalized.layers.map((layer) => layer.id === layerId
                        ? {
                            ...layer,
                            visible: layer.visible === false
                        }
                        : layer)
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after changing layer visibility.'
            });
        },
        toggleCompositeLayerLocked(layerId) {
            if (!layerId) return;
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    layers: normalized.layers.map((layer) => layer.id === layerId
                        ? {
                            ...layer,
                            locked: !layer.locked
                        }
                        : layer)
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after changing layer lock state.'
            });
        },
        moveCompositeLayer(layerId, direction = 0) {
            if (!layerId || !direction) return;
            const normalized = normalizeCompositeDocument(store.getState().compositeDocument);
            const visualLayers = [...normalized.layers].sort((a, b) => (b.z || 0) - (a.z || 0));
            const currentIndex = visualLayers.findIndex((layer) => layer.id === layerId);
            if (currentIndex < 0) return;
            const targetIndex = currentIndex - Math.sign(Number(direction) || 0);
            updateCompositeDocument((documentState) => moveCompositeLayerInVisualOrder(documentState, layerId, targetIndex), {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after reordering layers.'
            });
        },
        reorderCompositeLayer(layerId, targetLayerId) {
            if (!layerId || !targetLayerId || layerId === targetLayerId) return;
            const normalized = normalizeCompositeDocument(store.getState().compositeDocument);
            const visualLayers = [...normalized.layers].sort((a, b) => (b.z || 0) - (a.z || 0));
            const targetIndex = visualLayers.findIndex((layer) => layer.id === targetLayerId);
            if (targetIndex < 0) return;
            updateCompositeDocument((documentState) => moveCompositeLayerInVisualOrder(documentState, layerId, targetIndex), {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after reordering layers.'
            });
        },
        removeCompositeLayer(layerId) {
            if (!layerId) return;
            updateCompositeDocument((documentState) => ({
                ...normalizeCompositeDocument(documentState),
                layers: normalizeCompositeDocument(documentState).layers.filter((layer) => layer.id !== layerId)
            }), {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after removing a layer.'
            });
        },
        removeCompositeLayers(layerIds = []) {
            const ids = [...new Set((Array.isArray(layerIds) ? layerIds : []).map((value) => String(value || '')).filter(Boolean))];
            if (!ids.length) return;
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                const nextLayers = normalized.layers.filter((layer) => !ids.includes(layer.id));
                const nextSelectedId = nextLayers.some((layer) => layer.id === normalized.selection.layerId)
                    ? normalized.selection.layerId
                    : null;
                return {
                    ...normalized,
                    layers: nextLayers,
                    selection: {
                        layerId: nextSelectedId
                    }
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after removing multiple layers.'
            });
        },
        patchCompositeView(patch = {}) {
            if (!patch || typeof patch !== 'object') return;
            updateCompositeDocument((documentState) => ({
                ...documentState,
                view: {
                    ...documentState.view,
                    ...patch
                }
            }), {
                renderComposite: true,
                skipCompositeAutosave: true
            });
        },
        patchCompositeExport(patch = {}) {
            if (!patch || typeof patch !== 'object') return;
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                return {
                    ...normalized,
                    export: {
                        ...normalized.export,
                        ...patch
                    }
                };
            }, {
                renderComposite: true,
                compositeAutosave: true,
                compositeAutosaveReason: 'Queued Composite autosave after updating export settings.'
            });
        },
        frameCompositeView(viewportMetrics = null) {
            updateCompositeDocument((documentState) => {
                const normalized = normalizeCompositeDocument(documentState);
                const bounds = computeCompositeDocumentBounds(normalized);
                const metrics = normalizeCompositeViewportMetrics(viewportMetrics);
                const framedView = computeCompositeFramedView(bounds, metrics.width, metrics.height, {
                    paddingPx: 48,
                    minZoom: COMPOSITE_MIN_ZOOM,
                    maxZoom: COMPOSITE_MAX_ZOOM
                });
                return {
                    ...normalized,
                    view: {
                        ...normalized.view,
                        zoom: framedView.zoom,
                        panX: framedView.panX,
                        panY: framedView.panY
                    }
                };
            }, {
                renderComposite: true,
                skipCompositeAutosave: true
            });
        },
        async listCompositeSourceProjects() {
            await ensureStudioProjectPayloadPreviewsBackfilled();
            const projects = (await getAllLibraryProjectRecords())
                .filter((entry) => getLibraryProjectType(entry) === 'studio')
                .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
            return Promise.all(projects.map(async (entry) => {
                let previewDataUrl = String(entry?.payload?.preview?.imageData || '');
                if (!previewDataUrl && entry?.blob instanceof Blob) {
                    try {
                        previewDataUrl = await blobToDataUrl(entry.blob);
                    } catch (_error) {
                        previewDataUrl = '';
                    }
                }
                if (!previewDataUrl) {
                    previewDataUrl = String(entry?.payload?.source?.imageData || '');
                }
                return {
                    id: entry.id,
                    name: entry.name || 'Editor Project',
                    previewDataUrl,
                    dimensionsText: `${Number(entry.renderWidth || entry.sourceWidth || entry.payload?.preview?.width || entry.payload?.source?.width || 0) || 0} x ${Number(entry.renderHeight || entry.sourceHeight || entry.payload?.preview?.height || entry.payload?.source?.height || 0) || 0}`,
                    savedAtText: entry.timestamp ? new Date(entry.timestamp).toLocaleString() : 'Unknown save time'
                };
            }));
        },
        async addCompositeEditorProjects(ids = []) {
            const targetIds = [...new Set((ids || []).filter(Boolean))];
            if (!targetIds.length) return [];
            await showWorkspaceProgress('composite', {
                title: 'Adding Editor Projects',
                message: 'Loading the selected Editor projects from the Library...',
                progress: 0.12
            });
            try {
                const records = await Promise.all(targetIds.map((id) => getFromLibraryDB(id).catch(() => null)));
                const viewportMetrics = getCompositeViewportMetrics();
                let workingDocument = normalizeCompositeDocument(store.getState().compositeDocument);
                const appendedLayers = [];
                const warnings = [];

                for (let index = 0; index < records.length; index += 1) {
                    const record = records[index];
                    if (!record || getLibraryProjectType(record) !== 'studio') continue;
                    setWorkspaceProgress('composite', {
                        active: true,
                        title: 'Adding Editor Projects',
                        message: `Capturing "${record.name || `Editor Project ${index + 1}`}" for Composite...`,
                        progress: 0.16 + ((index / Math.max(1, records.length)) * 0.72)
                    });
                    const initialPayload = await syncEmbeddedEditorPayloadImageDimensions(
                        cloneSerializable(stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(record.payload)))
                    );
                    if (!initialPayload?.preview?.imageData && record?.blob instanceof Blob) {
                        try {
                            initialPayload.preview = {
                                imageData: await blobToDataUrl(record.blob),
                                width: Number(record.renderWidth || initialPayload.source?.width || 0),
                                height: Number(record.renderHeight || initialPayload.source?.height || 0),
                                updatedAt: Number(record.timestamp || Date.now())
                            };
                        } catch (_error) {
                            initialPayload.preview = initialPayload.preview || null;
                        }
                    }
                    if (!initialPayload?.preview?.imageData && initialPayload?.source?.imageData) {
                            initialPayload.preview = {
                                imageData: String(initialPayload.source.imageData),
                                width: Number(initialPayload.source.width || 0),
                                height: Number(initialPayload.source.height || 0),
                                updatedAt: Number(record.timestamp || Date.now())
                            };
                        }
                    let authoritativePayload = initialPayload;
                    let authoritativePreview = initialPayload?.preview || null;
                    try {
                        const capture = await captureCompositeEditorLayerDocument(initialPayload);
                        authoritativePayload = capture.payload || initialPayload;
                        authoritativePreview = capture.preview || authoritativePayload?.preview || initialPayload?.preview || null;
                    } catch (error) {
                        warnings.push(error?.message || `Could not refresh "${record.name || 'that Editor project'}" before adding it to Composite.`);
                        logProcess('warning', 'composite.layers', error?.message || `Could not refresh "${record.name || 'that Editor project'}" before adding it to Composite.`);
                    }
                    const renderSize = resolveCompositeEditorLayerRenderSize({
                        payload: authoritativePayload,
                        preview: authoritativePreview,
                        record
                    });
                    const sourceWidth = renderSize.width;
                    const sourceHeight = renderSize.height;
                    const position = getCompositeLayerPlacement(workingDocument, sourceWidth, sourceHeight, viewportMetrics);
                    const nextLayer = {
                        id: createCompositeLayerId('editor'),
                        kind: 'editor-project',
                        name: stripProjectExtension(record.name || authoritativePayload.source?.name || 'Editor Project') || 'Editor Project',
                        visible: true,
                        locked: false,
                        z: workingDocument.layers.length,
                        x: position.x,
                        y: position.y,
                        scale: position.scale,
                        scaleX: position.scale,
                        scaleY: position.scale,
                        resizeMode: 'center-uniform',
                        rotation: 0,
                        opacity: 1,
                        blendMode: 'normal',
                        source: {
                            originalLibraryId: record.id || null,
                            originalLibraryName: record.name || null,
                            originalProjectType: 'studio',
                            renderWidth: renderSize.width,
                            renderHeight: renderSize.height
                        },
                        embeddedEditorDocument: authoritativePayload
                    };
                    appendedLayers.push(nextLayer);
                    workingDocument = normalizeCompositeDocument({
                        ...workingDocument,
                        layers: [...workingDocument.layers, nextLayer],
                        selection: { layerId: nextLayer.id }
                    });
                    logProgressProcess('composite.layers', `Prepared Editor layer ${index + 1}/${records.length}.`, (index + 1) / Math.max(1, records.length), {
                        dedupeKey: `composite-add-editor:${record.id || index}`
                    });
                    await maybeYieldToUi(index, 1);
                }

                if (appendedLayers.length) {
                    updateCompositeDocument((documentState) => ({
                        ...normalizeCompositeDocument(documentState),
                        layers: [...normalizeCompositeDocument(documentState).layers, ...appendedLayers],
                        selection: { layerId: appendedLayers[appendedLayers.length - 1]?.id || documentState.selection.layerId }
                    }), {
                        renderComposite: true,
                        compositeAutosave: true,
                        compositeAutosaveReason: 'Queued Composite autosave after adding Editor project layers.'
                    });
                    logProcess('success', 'composite.layers', `Added ${appendedLayers.length} Editor project layer${appendedLayers.length === 1 ? '' : 's'} to Composite.`);
                    setNotice(
                        warnings.length
                            ? `Added ${appendedLayers.length} Editor project layer${appendedLayers.length === 1 ? '' : 's'} to Composite. Some previews fell back to saved data.`
                            : `Added ${appendedLayers.length} Editor project layer${appendedLayers.length === 1 ? '' : 's'} to Composite.`,
                        warnings.length ? 'warning' : 'success',
                        5200
                    );
                }
                clearWorkspaceProgress('composite');
                return appendedLayers;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.layers', error?.message || 'Could not add the selected Editor projects to Composite.');
                setNotice(error?.message || 'Could not add the selected Editor projects to Composite.', 'error', 7000);
                return [];
            }
        },
        async replaceCompositeLayerWithEditorProject(layerId = null, libraryId = null) {
            if (!layerId || !libraryId) return null;
            await showWorkspaceProgress('composite', {
                title: 'Replacing Layer',
                message: 'Loading the selected Editor project for replacement...',
                progress: 0.12
            });
            try {
                const compositeState = normalizeCompositeDocument(store.getState().compositeDocument);
                const currentLayer = compositeState.layers.find((layer) => layer.id === layerId) || null;
                if (!currentLayer) {
                    throw new Error('Select one Composite layer before replacing it.');
                }
                if (currentLayer.locked) {
                    throw new Error('Unlock the selected Composite layer before replacing it.');
                }
                const record = await getFromLibraryDB(libraryId).catch(() => null);
                if (!record || getLibraryProjectType(record) !== 'studio') {
                    throw new Error('That saved Editor project could not be loaded for replacement.');
                }
                setWorkspaceProgress('composite', {
                    active: true,
                    title: 'Replacing Layer',
                    message: `Capturing "${record.name || 'Editor Project'}" for replacement...`,
                    progress: 0.42
                });
                const initialPayload = await syncEmbeddedEditorPayloadImageDimensions(
                    cloneSerializable(stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(record.payload)))
                );
                if (!initialPayload?.preview?.imageData && record?.blob instanceof Blob) {
                    try {
                        initialPayload.preview = {
                            imageData: await blobToDataUrl(record.blob),
                            width: Number(record.renderWidth || initialPayload.source?.width || 0),
                            height: Number(record.renderHeight || initialPayload.source?.height || 0),
                            updatedAt: Number(record.timestamp || Date.now())
                        };
                    } catch (_error) {
                        initialPayload.preview = initialPayload.preview || null;
                    }
                }
                if (!initialPayload?.preview?.imageData && initialPayload?.source?.imageData) {
                    initialPayload.preview = {
                        imageData: String(initialPayload.source.imageData),
                        width: Number(initialPayload.source.width || 0),
                        height: Number(initialPayload.source.height || 0),
                        updatedAt: Number(record.timestamp || Date.now())
                    };
                }
                let authoritativePayload = initialPayload;
                let authoritativePreview = initialPayload?.preview || null;
                try {
                    const capture = await captureCompositeEditorLayerDocument(initialPayload);
                    authoritativePayload = capture.payload || initialPayload;
                    authoritativePreview = capture.preview || authoritativePayload?.preview || initialPayload?.preview || null;
                } catch (error) {
                    logProcess('warning', 'composite.layers', error?.message || `Could not fully refresh "${record.name || 'that Editor project'}" before replacing the layer. Using saved preview data instead.`);
                }
                const renderSize = resolveCompositeEditorLayerRenderSize({
                    payload: authoritativePayload,
                    preview: authoritativePreview,
                    record
                });
                const nextLayer = buildCompositeReplacementLayer(currentLayer, {
                    kind: 'editor-project',
                    name: stripProjectExtension(record.name || authoritativePayload.source?.name || 'Editor Project') || 'Editor Project',
                    source: {
                        originalLibraryId: record.id || null,
                        originalLibraryName: record.name || null,
                        originalProjectType: 'studio',
                        renderWidth: renderSize.width,
                        renderHeight: renderSize.height
                    },
                    embeddedEditorDocument: authoritativePayload
                });
                updateCompositeDocument((documentState) => ({
                    ...normalizeCompositeDocument(documentState),
                    layers: normalizeCompositeDocument(documentState).layers.map((layer) => layer.id === layerId ? nextLayer : layer),
                    selection: { layerId }
                }), {
                    renderComposite: true,
                    compositeAutosave: true,
                    compositeAutosaveReason: 'Queued Composite autosave after replacing a layer with an Editor project.'
                });
                clearWorkspaceProgress('composite');
                logProcess('success', 'composite.layers', `Replaced "${currentLayer.name || 'Layer'}" with Editor project "${record.name || 'Editor Project'}".`);
                setNotice(`Replaced "${currentLayer.name || 'Layer'}" with "${record.name || 'Editor Project'}".`, 'success', 5200);
                return nextLayer;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.layers', error?.message || 'Could not replace that Composite layer with the selected Editor project.');
                setNotice(error?.message || 'Could not replace that Composite layer with the selected Editor project.', 'error', 7000);
                return null;
            }
        },
        async addCompositeImageFiles(files = []) {
            const sourceFiles = (files || []).filter((file) => isLikelyImageFile(file));
            if (!sourceFiles.length) {
                setNotice('Choose one or more image files to add to Composite.', 'warning', 5000);
                return [];
            }
            await showWorkspaceProgress('composite', {
                title: 'Adding Images',
                message: 'Embedding the selected images into Composite...',
                progress: 0.12
            });
            try {
                const viewportMetrics = getCompositeViewportMetrics();
                const prepared = backgroundTasks
                    ? await backgroundTasks.runTask('composite', 'prepare-image-files', { files: sourceFiles }, {
                        createRequest: () => buildWorkerFileListRequest(sourceFiles),
                        priority: 'user-visible',
                        processId: 'composite.layers',
                        scope: 'section:composite',
                        onProgress(progress) {
                            setWorkspaceProgress('composite', {
                                active: true,
                                title: 'Adding Images',
                                message: progress?.message || 'Embedding the selected images into Composite...',
                                progress: 0.12 + ((Number(progress?.progress) || 0) * 0.48)
                            });
                        }
                    })
                    : await prepareCompositeImageFilesFallback(sourceFiles, {
                        onProgress(progress) {
                            setWorkspaceProgress('composite', {
                                active: true,
                                title: 'Adding Images',
                                message: progress?.message || 'Embedding the selected images into Composite...',
                                progress: 0.12 + ((Number(progress?.progress) || 0) * 0.48)
                            });
                        }
                    });
                const preparedItems = Array.isArray(prepared?.items) ? prepared.items : [];
                const failures = Array.isArray(prepared?.failures) ? prepared.failures : [];
                if (!preparedItems.length) {
                    throw new Error(failures[0]?.reason || 'Could not read the selected images for Composite.');
                }
                let workingDocument = normalizeCompositeDocument(store.getState().compositeDocument);
                const nextLayers = [];
                for (let index = 0; index < preparedItems.length; index += 1) {
                    const item = preparedItems[index];
                    setWorkspaceProgress('composite', {
                        active: true,
                        title: 'Adding Images',
                        message: `Placing "${item.name || `Image ${index + 1}`}" into Composite...`,
                        progress: 0.62 + ((index / Math.max(1, preparedItems.length)) * 0.28)
                    });
                    const layer = createCompositeImageLayerFromPreparedItem(item, workingDocument, viewportMetrics);
                    nextLayers.push(layer);
                    workingDocument = normalizeCompositeDocument({
                        ...workingDocument,
                        layers: [...workingDocument.layers, layer],
                        selection: { layerId: layer.id }
                    });
                    logProgressProcess('composite.layers', `Embedded image ${index + 1}/${preparedItems.length}.`, (index + 1) / Math.max(1, preparedItems.length), {
                        dedupeKey: `composite-add-image:${item.name}:${index}`
                    });
                    await maybeYieldToUi(index, 1);
                }
                updateCompositeDocument((documentState) => ({
                    ...normalizeCompositeDocument(documentState),
                    layers: [...normalizeCompositeDocument(documentState).layers, ...nextLayers],
                    selection: { layerId: nextLayers[nextLayers.length - 1]?.id || documentState.selection.layerId }
                }), {
                    renderComposite: true,
                    compositeAutosave: true,
                    compositeAutosaveReason: 'Queued Composite autosave after adding image layers.'
                });
                clearWorkspaceProgress('composite');
                logProcess('success', 'composite.layers', `Added ${nextLayers.length} image layer${nextLayers.length === 1 ? '' : 's'} to Composite.`);
                setNotice(
                    failures.length
                        ? `Added ${nextLayers.length} image layer${nextLayers.length === 1 ? '' : 's'} to Composite. ${failures.length} file${failures.length === 1 ? '' : 's'} could not be read.`
                        : `Added ${nextLayers.length} image layer${nextLayers.length === 1 ? '' : 's'} to Composite.`,
                    failures.length ? 'warning' : 'success',
                    5200
                );
                return nextLayers;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.layers', error?.message || 'Could not add the selected images to Composite.');
                setNotice(error?.message || 'Could not add the selected images to Composite.', 'error', 7000);
                return [];
            }
        },
        async replaceCompositeLayerWithImageFiles(layerId = null, files = []) {
            if (!layerId) return null;
            const sourceFiles = (files || []).filter((file) => isLikelyImageFile(file));
            if (!sourceFiles.length) {
                setNotice('Choose an image file to replace the selected Composite layer.', 'warning', 5000);
                return null;
            }
            await showWorkspaceProgress('composite', {
                title: 'Replacing Layer',
                message: 'Embedding the selected image for replacement...',
                progress: 0.12
            });
            try {
                const compositeState = normalizeCompositeDocument(store.getState().compositeDocument);
                const currentLayer = compositeState.layers.find((layer) => layer.id === layerId) || null;
                if (!currentLayer) {
                    throw new Error('Select one Composite layer before replacing it.');
                }
                if (currentLayer.locked) {
                    throw new Error('Unlock the selected Composite layer before replacing it.');
                }
                const replacementFile = sourceFiles[0];
                const prepared = backgroundTasks
                    ? await backgroundTasks.runTask('composite', 'prepare-image-files', { files: [replacementFile] }, {
                        createRequest: () => buildWorkerFileListRequest([replacementFile]),
                        priority: 'user-visible',
                        processId: 'composite.layers',
                        scope: 'section:composite',
                        onProgress(progress) {
                            setWorkspaceProgress('composite', {
                                active: true,
                                title: 'Replacing Layer',
                                message: progress?.message || 'Embedding the selected image for replacement...',
                                progress: 0.2 + ((Number(progress?.progress) || 0) * 0.56)
                            });
                        }
                    })
                    : await prepareCompositeImageFilesFallback([replacementFile], {
                        onProgress(progress) {
                            setWorkspaceProgress('composite', {
                                active: true,
                                title: 'Replacing Layer',
                                message: progress?.message || 'Embedding the selected image for replacement...',
                                progress: 0.2 + ((Number(progress?.progress) || 0) * 0.56)
                            });
                        }
                    });
                const preparedItem = Array.isArray(prepared?.items) ? prepared.items[0] || null : null;
                if (!preparedItem) {
                    throw new Error(prepared?.failures?.[0]?.reason || 'Could not read the selected image for replacement.');
                }
                const nextLayer = buildCompositeReplacementLayer(currentLayer, {
                    kind: 'image',
                    name: stripProjectExtension(preparedItem.name || 'Image') || 'Image',
                    source: {
                        originalLibraryId: null,
                        originalLibraryName: null,
                        originalProjectType: null
                    },
                    imageAsset: {
                        name: preparedItem.name || 'Image',
                        type: preparedItem.type || 'image/png',
                        imageData: String(preparedItem.imageData || ''),
                        width: Math.max(1, Number(preparedItem.width) || 1),
                        height: Math.max(1, Number(preparedItem.height) || 1)
                    }
                });
                updateCompositeDocument((documentState) => ({
                    ...normalizeCompositeDocument(documentState),
                    layers: normalizeCompositeDocument(documentState).layers.map((layer) => layer.id === layerId ? nextLayer : layer),
                    selection: { layerId }
                }), {
                    renderComposite: true,
                    compositeAutosave: true,
                    compositeAutosaveReason: 'Queued Composite autosave after replacing a layer with an image.'
                });
                clearWorkspaceProgress('composite');
                const extraNote = sourceFiles.length > 1 ? ' Used the first selected image only.' : '';
                logProcess('success', 'composite.layers', `Replaced "${currentLayer.name || 'Layer'}" with image "${preparedItem.name || 'Image'}".${extraNote}`);
                setNotice(`Replaced "${currentLayer.name || 'Layer'}" with "${preparedItem.name || 'Image'}".${extraNote}`, sourceFiles.length > 1 ? 'warning' : 'success', 5200);
                return nextLayer;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.layers', error?.message || 'Could not replace that Composite layer with the selected image.');
                setNotice(error?.message || 'Could not replace that Composite layer with the selected image.', 'error', 7000);
                return null;
            }
        },
        async openCompositeStateFile(file) {
            if (!file) return false;
            if (!await ensureProjectCanBeReplaced('composite', 'loading a Composite state file')) return false;
            try {
                await showWorkspaceProgress('composite', {
                    title: 'Loading Composite',
                    message: `Reading "${file.name}"...`,
                    progress: 0.12
                });
                const parsed = normalizeLegacyDocumentPayload(await readJsonFile(file));
                const validated = normalizeCompositeDocument(validateImportPayload(stripLibraryEnvelopeMetadata(parsed), 'composite-document'));
                clearCompositeAutosaveTimer();
                clearCompositeBridgeState();
                updateCompositeDocument(() => applyCompositeSettingsToDocument(validated, store.getState().settings), {
                    renderComposite: true,
                    skipCompositeAutosave: true
                });
                clearActiveLibraryOrigin('composite');
                commitActiveSection('composite');
                clearWorkspaceProgress('composite');
                logProcess('success', 'composite.workspace', `Loaded Composite state file "${file.name}".`);
                setNotice(`Loaded Composite state file "${file.name}".`, 'success', 4200);
                return true;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.workspace', error?.message || `Could not load "${file?.name || 'that Composite file'}".`);
                setNotice(error?.message || 'Could not load that Composite file.', 'error', 7000);
                return false;
            }
        },
        async saveCompositeState() {
            const compositeDocument = normalizeCompositeDocument(store.getState().compositeDocument);
            if (!compositeDocument.layers.length) {
                setNotice('Add one or more layers before saving a Composite JSON file.', 'warning', 6000);
                return null;
            }
            await showWorkspaceProgress('composite', {
                title: 'Saving Composite',
                message: 'Capturing the Composite preview and JSON payload...',
                progress: 0.12
            });
            try {
                const capture = await captureCompositeDocumentSnapshot(compositeDocument);
                setWorkspaceProgress('composite', {
                    active: true,
                    title: 'Saving Composite',
                    message: 'Writing the self-contained Composite JSON...',
                    progress: 0.82
                });
                const baseName = getSuggestedCompositeProjectName(compositeDocument) || 'Composite Project';
                const saveResult = await saveJsonLocally(capture.payload, `${baseName}.mns.json`, {
                    title: 'Save Composite JSON',
                    buttonLabel: 'Save JSON',
                    filters: [{ name: 'Composite JSON', extensions: ['json'] }]
                });
                if (wasSaveCancelled(saveResult)) {
                    clearWorkspaceProgress('composite');
                    logProcess('info', 'composite.workspace', 'Cancelled the Composite JSON save dialog.');
                    setNotice('Composite save cancelled.', 'info', 4200);
                    return null;
                }
                if (!didSaveFile(saveResult)) {
                    throw new Error(saveResult?.error || 'Could not save the Composite JSON.');
                }
                let syncedRecord = null;
                if (getActiveLibraryOrigin('composite')?.id) {
                    syncedRecord = await flushCompositeAutosave({
                        reason: 'Updating the linked Composite Library project after a local JSON save.'
                    });
                }
                clearWorkspaceProgress('composite');
                logProcess('success', 'composite.workspace', 'Saved the Composite JSON locally.');
                setNotice(
                    getActiveLibraryOrigin('composite')?.id && !syncedRecord
                        ? 'Composite JSON saved locally, but the linked Library project could not be updated.'
                        : 'Composite JSON saved locally.',
                    getActiveLibraryOrigin('composite')?.id && !syncedRecord ? 'warning' : 'success',
                    5200
                );
                return saveResult;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.workspace', error?.message || 'Could not save the Composite JSON.');
                setNotice(error?.message || 'Could not save the Composite JSON.', 'error', 7000);
                return null;
            }
        },
        async exportCompositePng() {
            const compositeDocument = normalizeCompositeDocument(store.getState().compositeDocument);
            if (!compositeDocument.layers.length) {
                setNotice('Add one or more layers before exporting a Composite PNG.', 'warning', 6000);
                return null;
            }
            await showWorkspaceProgress('composite', {
                title: 'Exporting Composite PNG',
                message: 'Rendering the Composite viewport to PNG...',
                progress: 0.16
            });
            try {
                let selectedBackend = null;
                const blob = await renderCompositePngBlob(compositeDocument, {
                    priority: 'user-visible',
                    processId: 'composite.export',
                    scope: 'section:composite',
                    onBackend(backend) {
                        selectedBackend = backend || null;
                    }
                });
                if (selectedBackend?.fallbackReason) {
                    logProcess('warning', 'composite.export', selectedBackend.fallbackReason, {
                        dedupeKey: `composite-export-backend-fallback:${selectedBackend.logKey || `${selectedBackend.preference}:${selectedBackend.mode}`}`,
                        dedupeWindowMs: 800
                    });
                } else if (selectedBackend?.decisionReason) {
                    logProcess('info', 'composite.export', selectedBackend.decisionReason, {
                        dedupeKey: `composite-export-backend:${selectedBackend.logKey || `${selectedBackend.preference}:${selectedBackend.mode}`}`,
                        dedupeWindowMs: 800
                    });
                } else if (selectedBackend?.label) {
                    logProcess('info', 'composite.export', `Composite export used ${selectedBackend.label}.`, {
                        dedupeKey: `composite-export-backend:${selectedBackend.logKey || `${selectedBackend.preference}:${selectedBackend.mode}`}`,
                        dedupeWindowMs: 800
                    });
                }
                const baseName = getSuggestedCompositeProjectName(compositeDocument) || 'composite-export';
                setWorkspaceProgress('composite', {
                    active: true,
                    title: 'Exporting Composite PNG',
                    message: `Writing "${baseName}.png"...`,
                    progress: 0.88
                });
                const saveResult = await saveBlobLocally(blob, `${baseName}.png`, {
                    title: 'Save Composite PNG',
                    buttonLabel: 'Save PNG',
                    filters: [{ name: 'PNG Image', extensions: ['png'] }]
                });
                clearWorkspaceProgress('composite');
                if (wasSaveCancelled(saveResult)) {
                    logProcess('info', 'composite.export', 'Cancelled the Composite PNG save dialog.');
                    setNotice('Composite PNG save cancelled.', 'info', 4200);
                    return null;
                }
                if (!didSaveFile(saveResult)) {
                    throw new Error(saveResult?.error || 'Could not save the Composite PNG.');
                }
                logProcess('success', 'composite.export', `Exported "${baseName}.png" from Composite.`);
                setNotice('Composite PNG export complete.', 'success', 4200);
                return saveResult;
            } catch (error) {
                clearWorkspaceProgress('composite');
                logProcess('error', 'composite.export', error?.message || 'Could not export the Composite PNG.');
                setNotice(error?.message || 'Could not export the Composite PNG.', 'error', 7000);
                return null;
            }
        },
        async updateOriginalEditorProjectFromComposite() {
            const bridge = getCompositeBridgeState();
            if (!bridge.active || !bridge.originalLibraryId) {
                setNotice('Select a linked Composite Editor layer before updating its original Library project.', 'warning', 6000);
                return false;
            }
            const confirmed = await requestAppConfirmDialog(view, {
                title: 'Update Original Editor Project',
                text: `Overwrite "${bridge.originalLibraryName || 'the original Editor project'}" in the Library with the current linked Editor document?`,
                confirmLabel: 'Update Original',
                cancelLabel: 'Cancel',
                isDanger: true
            });
            if (!confirmed) return false;
            try {
                const state = store.getState();
                let editorDocument = state.document;
                if (!engine.hasImage()) {
                    const synced = await syncStudioEngineToDocument(engine, state.document);
                    editorDocument = synced?.document || state.document;
                    updateDocument(() => editorDocument, { render: false });
                }
                const existingRecord = await getFromLibraryDB(bridge.originalLibraryId);
                if (!existingRecord || getLibraryProjectType(existingRecord) !== 'studio') {
                    throw new Error('The original Editor Library project could not be found.');
                }
                const capture = await captureStudioDocumentSnapshot(engine, editorDocument);
                const renderSize = resolveCompositeEditorLayerRenderSize({
                    payload: capture.payload,
                    preview: capture.preview
                });
                const baseResolution = getEditorCanvasResolution(capture.payload);
                const projectData = buildLibraryProjectRecord({
                    id: existingRecord.id,
                    timestamp: Date.now(),
                    name: existingRecord.name || bridge.originalLibraryName || getSuggestedProjectName(state.document),
                    blob: capture.blob,
                    payload: capture.payload,
                    tags: normalizeLibraryTags(existingRecord.tags || []),
                    projectType: 'studio',
                    hoverSource: capture.payload.source,
                    sourceWidth: Number(baseResolution.width || 0),
                    sourceHeight: Number(baseResolution.height || 0),
                    sourceArea: Number(baseResolution.width || 0) * Number(baseResolution.height || 0),
                    sourceCount: hasPersistableEditorSource(capture.payload.source) ? 1 : 0,
                    renderWidth: Number(capture.preview?.width || baseResolution.width || 0),
                    renderHeight: Number(capture.preview?.height || baseResolution.height || 0)
                });
                await saveToLibraryDB(projectData);
                await upsertDerivedStudioAsset(projectData);
                updateCompositeDocument((documentState) => ({
                    ...normalizeCompositeDocument(documentState),
                    layers: normalizeCompositeDocument(documentState).layers.map((layer) => layer.id === bridge.layerId
                        ? {
                            ...layer,
                            embeddedEditorDocument: capture.payload,
                            source: {
                                ...layer.source,
                                renderWidth: renderSize.width,
                                renderHeight: renderSize.height
                            }
                        }
                        : layer)
                }), {
                    renderComposite: true,
                    compositeAutosave: true,
                    compositeAutosaveReason: 'Queued Composite autosave after updating the linked original Editor project.'
                });
                notifyLibraryChanged();
                logProcess('success', 'composite.link', `Updated the original Editor Library project "${projectData.name}" from the linked Composite layer.`);
                setNotice(`Updated "${projectData.name}" in the Library.`, 'success', 5200);
                return true;
            } catch (error) {
                logProcess('error', 'composite.link', error?.message || 'Could not update the original Editor Library project.');
                setNotice(error?.message || 'Could not update the original Editor Library project.', 'error', 7000);
                return false;
            }
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
        async setEditorBaseDimensions(width, height) {
            const current = store.getState().document;
            const nextBase = normalizeEditorBase({
                ...current.base,
                width,
                height
            }, current.source);
            await commitEditorBaseDocument({
                ...current,
                base: nextBase
            });
        },
        async applyEditorBaseResolutionPreset(width, height) {
            return actions.setEditorBaseDimensions(width, height);
        },
        async swapEditorBaseDimensions() {
            const current = store.getState().document;
            const base = normalizeEditorBase(current.base, current.source);
            await commitEditorBaseDocument({
                ...current,
                base: normalizeEditorBase({
                    ...base,
                    width: base.height,
                    height: base.width
                }, current.source)
            });
        },
        async applyEditorBaseAspectPreset(width, height) {
            const current = store.getState().document;
            const nextBase = applyEditorBaseAspectPresetHelper(current.base, width, height);
            await commitEditorBaseDocument({
                ...current,
                base: nextBase
            });
        },
        async setEditorBaseBackgroundMode(mode) {
            const current = store.getState().document;
            const nextBase = normalizeEditorBase({
                ...current.base,
                backgroundMode: mode === 'solid' ? 'solid' : 'transparent'
            }, current.source);
            await commitEditorBaseDocument({
                ...current,
                base: nextBase
            });
        },
        async setEditorBaseBackgroundColor(color) {
            const current = store.getState().document;
            const nextBase = normalizeEditorBase({
                ...current.base,
                backgroundColor: color,
                backgroundMode: current.base?.backgroundMode === 'solid' ? 'solid' : 'transparent'
            }, current.source);
            await commitEditorBaseDocument({
                ...current,
                base: nextBase
            });
        },
        async removeEditorSourceImage() {
            const current = store.getState().document;
            if (!hasEditorSourceImage(current)) return false;
            paletteExtractionImage = null;
            paletteExtractionOwner = null;
            const committed = await commitEditorBaseDocument({
                ...current,
                source: normalizeEditorSource()
            });
            if (!committed) return false;
            setNotice('Removed the source image from the Editor canvas.', 'success', 4200);
            return true;
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
                if (layerId === 'dngDevelop' && !isDngSource(document.source)) {
                    return document;
                }
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
                if (layerId === 'textOverlay') {
                    next.params = centerTextLayerParams(document, next.params);
                }
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
        centerTextLayer(instanceId) {
            updateInstance(instanceId, (instance) => ({
                ...instance,
                params: centerTextLayerParams(store.getState().document, instance.params, instance.instanceId)
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
        getLayerInputMetrics(instanceId) {
            if (!instanceId) return null;
            return engine.getLayerInputMetrics(store.getState().document, instanceId);
        },
        getLayerInputPreview(instanceId) {
            if (!instanceId) return null;
            return engine.getLayerInputPreviewSnapshot(store.getState().document, instanceId);
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
        async copyDngDevelopDebugSettings() {
            const snapshot = buildDngDebugSnapshot(store.getState().document);
            if (!snapshot) {
                setNotice('Load a DNG source before copying DNG debug settings.', 'warning', 5200);
                return false;
            }
            try {
                await copyTextToClipboard(JSON.stringify(snapshot, null, 2));
                logProcess('success', 'editor.dng', 'Copied the current DNG settings snapshot to the clipboard.', {
                    dedupeKey: `editor-dng-copy:${snapshot.source.sourceSignature || snapshot.source.name || 'source'}`,
                    dedupeWindowMs: 300
                });
                setNotice('Copied the current DNG settings to the clipboard.', 'success', 4200);
                return true;
            } catch (error) {
                logProcess('error', 'editor.dng', error?.message || 'Could not copy the DNG settings snapshot.');
                setNotice(error?.message || 'Could not copy the DNG settings snapshot.', 'error', 7000);
                return false;
            }
        },
        updateControl(instanceId, key, rawValue, meta) {
            const currentDocument = store.getState().document;
            const currentInstance = currentDocument.layerStack.find((instance) => instance.instanceId === instanceId) || null;
            const layerId = String(currentInstance?.layerId || '');
            const nextDocument = normalizeStudioDocumentForDng({
                ...currentDocument,
                layerStack: currentDocument.layerStack.map((instance) => {
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
                    : currentDocument.palette
            });
            const nextMeta = meta || { render: true };
            if (layerId === 'dngDevelop' && isDngSource(currentDocument.source)) {
                const statusToken = beginDngPreviewRenderStatus({
                    title: 'Rendering',
                    message: 'Updating the DNG preview...',
                    delayMs: nextMeta.dngImmediateRefresh ? 0 : 120
                });
                updateDocument(() => nextDocument, {
                    render: false,
                    skipViewRender: nextMeta.skipViewRender ?? false
                });
                engine.requestRender(nextDocument, {
                    onComplete: () => endDngPreviewRenderStatus(statusToken)
                });
                return;
            }
            updateDocument(() => nextDocument, nextMeta);
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
            return actions.updateAppSetting('editor.defaultHighQualityPreview', !!enabled).then(async (result) => {
                const nextDocument = store.getState().document;
                if (isDngSource(nextDocument.source)) {
                    const statusToken = beginDngPreviewRenderStatus({
                        title: 'Rendering',
                        message: 'Rebuilding the DNG preview quality...',
                        delayMs: 120
                    });
                    engine.requestRender(nextDocument, {
                        onComplete: () => endDngPreviewRenderStatus(statusToken)
                    });
                }
                return result;
            });
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
            const captureOptions = options.captureOptions && typeof options.captureOptions === 'object'
                ? options.captureOptions
                : null;
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
            let currentDocument = adapter.getCurrentDocument(state);
            if (adapter.isEmpty(currentDocument) || !adapter.canSave(currentDocument)) {
                logProcess('warning', 'library.projects', adapter.emptyNotice || `Blocked ${adapter.label} save because the project is empty.`);
                showLibraryNotice(adapter.emptyNotice || `There is no ${adapter.label} project ready to save.`, 'warning');
                return null;
            }

            if (projectType === 'composite') {
                try {
                    const persistedGeneratedProjects = await persistGeneratedCompositeEditorProjects(currentDocument, {
                        updateStore: true,
                        log: !promptless
                    });
                    currentDocument = persistedGeneratedProjects.document;
                } catch (error) {
                    logProcess('error', 'composite.link', error?.message || 'Could not persist the generated Editor projects linked from Composite.');
                    showLibraryNotice(error?.message || 'Could not persist the generated Editor projects linked from Composite.', 'error', 7000);
                    return null;
                }
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
                const capture = await adapter.captureDocument(currentDocument, payloadParams, captureOptions);
                let captureBlob = capture?.blob || null;
                let capturePayload = capture?.payload || payloadParams;
                if (!captureBlob && String(capture?.payload?.preview?.imageData || '').startsWith('data:')) {
                    try {
                        captureBlob = await dataUrlToBlob(capture.payload.preview.imageData);
                    } catch (_error) {
                        captureBlob = null;
                    }
                }
                if (!captureBlob && existingRecord?.blob instanceof Blob) {
                    captureBlob = existingRecord.blob;
                }
                if (!capturePayload?.preview?.imageData && existingRecord?.payload?.preview?.imageData) {
                    capturePayload = {
                        ...capturePayload,
                        preview: cloneSerializable(existingRecord.payload.preview)
                    };
                }
                if (!suppressWorkspaceOverlay) {
                    setWorkspaceProgress(projectType, {
                        active: true,
                        title: 'Saving To Library',
                        message: `Writing "${name}" into the Library...`,
                        progress: 0.58
                    });
                }
                let studioDngAttachment = null;
                if (projectType === 'studio') {
                    const currentSource = normalizeEditorSource(currentDocument.source);
                    if (isDngSource(currentSource) && currentSource.rawData) {
                        studioDngAttachment = await saveStudioDngAttachment(saveId, currentSource);
                        if (studioDngAttachment) {
                            capturePayload = {
                                ...capturePayload,
                                source: normalizeEditorSource({
                                    ...capturePayload?.source,
                                    rawData: null,
                                    dng: {
                                        ...(capturePayload?.source?.dng || {}),
                                        attachmentId: studioDngAttachment.id
                                    }
                                })
                            };
                        }
                    }
                }
                const projectData = buildLibraryProjectRecord({
                    id: saveId,
                    timestamp: Date.now(),
                    name,
                    blob: captureBlob,
                    payload: capturePayload,
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
                return await getLibraryProjectRecordsByCursor({
                    mapRecord(entry) {
                        const payload = createLibraryProjectListPayload(entry);
                        const projectMeta = extractLibraryProjectMeta(payload);
                        const projectType = getLibraryProjectType(entry);
                        return {
                            ...entry,
                            payload,
                            projectType,
                            tags: normalizeLibraryTags(entry.tags || projectMeta.tags || []),
                            hoverSource: normalizeLibraryHoverSource(entry.hoverSource || projectMeta.hoverSource || payload?.source || null),
                            sourceWidth: Number(entry.sourceWidth
                                || entry.hoverSource?.width
                                || projectMeta.hoverSource?.width
                                || (projectType === 'studio' ? getEditorCanvasResolution(payload).width : 0)
                                || payload?.source?.width
                                || 0),
                            sourceHeight: Number(entry.sourceHeight
                                || entry.hoverSource?.height
                                || projectMeta.hoverSource?.height
                                || (projectType === 'studio' ? getEditorCanvasResolution(payload).height : 0)
                                || payload?.source?.height
                                || 0),
                            sourceAreaOverride: Number(entry.sourceAreaOverride || projectMeta.sourceArea || 0),
                            sourceCount: Number(
                                entry.sourceCount
                                || projectMeta.sourceCount
                                || (payload?.kind === 'composite-document' || payload?.mode === 'composite'
                                    ? payload?.layers?.length || 0
                                    : payload?.kind === 'stitch-document'
                                        ? payload?.inputs?.length || 0
                                        : ((isDngSource(payload?.source) || hasPersistableEditorSource(payload?.source)) ? 1 : 0))
                                || 0
                            )
                        };
                    }
                });
            } catch (_error) {
                return [];
            }
        },
        async prepareLibraryProjectsForExport(projects = []) {
            const sourceProjects = Array.isArray(projects) ? projects : [];
            const preparedProjects = [];
            for (const project of sourceProjects) {
                const record = project?.id ? await getFromLibraryDB(project.id).catch(() => null) : null;
                const baseRecord = isLibraryProjectRecord(record) ? record : project;
                if (!baseRecord || !isLibraryProjectRecord(baseRecord)) continue;
                let payload = baseRecord.payload;
                if (getLibraryProjectType(baseRecord) === 'studio') {
                    payload = await hydrateStudioDngPayloadFromAttachment(baseRecord.payload, baseRecord.id);
                }
                preparedProjects.push({
                    ...baseRecord,
                    payload
                });
            }
            return preparedProjects;
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
            await deleteLibraryAttachmentsByProjectId(id);
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
                await deleteLibraryAttachmentsByProjectId(id);
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
                await deleteLibraryAttachmentsByProjectId(entry.id);
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
                let parsedPayload = typeof payload === 'string'
                    ? JSON.parse(payload)
                    : payload;
                if (libraryId) {
                    const authoritativeRecord = await getFromLibraryDB(libraryId).catch(() => null);
                    if (isLibraryProjectRecord(authoritativeRecord) && authoritativeRecord.payload) {
                        parsedPayload = authoritativeRecord.payload;
                    }
                }
                const rawState = normalizeLegacyDocumentPayload(parsedPayload);
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
            const currentDocument = store.getState().document;
            const nextDocument = applyEditorSettingsToDocument({
                ...currentDocument,
                source: normalizeEditorSource(),
                base: createDefaultEditorBase(),
                layerStack: [],
                palette: [],
                selection: { layerInstanceId: null },
                workspace: { ...currentDocument.workspace, batchOpen: false, studioView: 'edit' },
                batch: createEmptyBatchState()
            }, store.getState().settings);
            const synced = await syncStudioEngineToDocument(engine, nextDocument);
            const syncedDocument = synced?.document || nextDocument;
            updateDocument(() => syncedDocument, { render: false });
            clearActiveLibraryOrigin('studio');
            engine.requestRender(syncedDocument);
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
                const currentDocument = store.getState().document;
                const shouldAskAboutCanvasOverride = !hasEditorSourceImage(currentDocument)
                    && !isDefaultEditorBase(currentDocument.base);
                const isDngImport = isDngFile(file);
                const currentSource = normalizeEditorSource(currentDocument.source);
                logProcess('info', 'editor.files', `Reading file bytes for "${file.name}".`, {
                    dedupeKey: `editor-load-image-read:${file.name}`,
                    dedupeWindowMs: 120
                });
                if (isDngImport) {
                    setEditorProgress({
                        active: true,
                        title: 'Loading DNG',
                        message: `Inspecting "${file.name}" and classifying the raw source...`,
                        progress: 0.26
                    });
                    const probeResult = await probeDngFileInBackground(file, {
                        processId: 'editor.dng',
                        priority: 'user-visible',
                        replaceKey: `editor-dng-probe:${file.name}`
                    });
                    const probe = probeResult?.probe || {};
                    if (Array.isArray(probe.warnings) && probe.warnings.length) {
                        probe.warnings.forEach((warning, index) => {
                            logProcess('warning', 'editor.dng', warning, {
                                dedupeKey: `editor-dng-warning:${file.name}:${index}`,
                                dedupeWindowMs: 400
                            });
                        });
                    }
                    setEditorProgress({
                        active: true,
                        title: 'Loading DNG',
                        message: `Embedding the original DNG payload for "${file.name}"...`,
                        progress: 0.46
                    });
                    const rawData = await fileToDataUrl(file);
                    const nextSource = normalizeEditorSource({
                        kind: DNG_SOURCE_KIND,
                        name: file.name,
                        type: file.type || 'image/x-adobe-dng',
                        imageData: null,
                        rawData,
                        rawMimeType: file.type || 'image/x-adobe-dng',
                        rawByteLength: Number(file.size || 0),
                        width: probe.width,
                        height: probe.height,
                        dng: normalizeDngSourceState({
                            sourceSignature: probeResult?.sourceSignature || '',
                            preset: getDngPresetForProbe(probe),
                            fidelity: probe.fidelity || 'partial',
                            warnings: probe.warnings || [],
                            probe
                        })
                    });
                    const existingDngLayer = getDngDevelopInstance(currentDocument);
                    const shouldResetDngLayerForImport = String(currentSource?.dng?.sourceSignature || '') !== String(nextSource?.dng?.sourceSignature || '')
                        || String(existingDngLayer?.meta?.dngSourceSignature || '') !== String(nextSource?.dng?.sourceSignature || '');
                    let nextBase = normalizeEditorBase({
                        ...currentDocument.base,
                        width: probe.width,
                        height: probe.height
                    }, nextSource);
                    if (shouldAskAboutCanvasOverride) {
                        const useImageResolution = await requestAppConfirmDialog(view, {
                            title: 'Canvas Resolution',
                            text: `The current Base canvas is ${currentDocument.base?.width || 0} x ${currentDocument.base?.height || 0}. Use "${file.name}" at ${probe.width || 0} x ${probe.height || 0} instead?`,
                            confirmLabel: 'Use Image Resolution',
                            cancelLabel: 'Keep Current Canvas'
                        });
                        if (!useImageResolution) {
                            nextBase = normalizeEditorBase(currentDocument.base, nextSource);
                        }
                    }
                    const nextDocument = applyEditorSettingsToDocument({
                        ...currentDocument,
                        source: nextSource,
                        base: nextBase,
                        layerStack: shouldResetDngLayerForImport
                            ? currentDocument.layerStack.filter((instance) => instance.layerId !== 'dngDevelop')
                            : currentDocument.layerStack,
                        view: { ...currentDocument.view, zoom: 1 },
                        workspace: { ...currentDocument.workspace, batchOpen: false },
                        export: {
                            ...(currentDocument.export || {}),
                            pngBitDepth: '16-bit'
                        },
                        batch: createEmptyBatchState()
                    }, store.getState().settings);
                    setEditorProgress({
                        active: true,
                        title: 'Loading DNG',
                        message: `Developing the initial preview for "${file.name}"...`,
                        progress: 0.68
                    });
                    const synced = await syncStudioEngineToDocument(engine, nextDocument, {
                        processId: 'editor.dng',
                        priority: 'user-visible',
                        replaceKey: `editor-dng-load:${file.name}`
                    });
                    updateDocument(() => synced.document, { render: false });
                    clearActiveLibraryOrigin('studio');
                    engine.requestRender(synced.document);
                    setEditorProgress({
                        active: true,
                        title: 'Loading DNG',
                        message: `Saving "${file.name}" into the Library for quick recall...`,
                        progress: 0.86
                    });
                    await actions.saveProjectToLibrary(stripProjectExtension(file.name), {
                        preferExisting: true,
                        projectType: 'studio',
                        suppressWorkspaceOverlay: true
                    });
                    clearWorkspaceProgress('studio');
                    logProcess('success', 'editor.files', `Loaded DNG "${file.name}" into the Editor.`);
                    setNotice(`Loaded ${file.name}.`, 'success', 4200);
                    return;
                }
                const dataUrl = await fileToDataUrl(file);
                setEditorProgress({
                    active: true,
                    title: 'Loading Image',
                    message: `Decoding "${file.name}" and preparing the Editor canvas...`,
                    progress: 0.42
                });
                const sourceImage = await loadImageFromDataUrl(dataUrl);
                const nextSource = normalizeEditorSource({
                    name: file.name,
                    type: file.type,
                    imageData: dataUrl,
                    width: sourceImage.width,
                    height: sourceImage.height
                });
                let nextBase = normalizeEditorBase({
                    ...currentDocument.base,
                    width: sourceImage.width,
                    height: sourceImage.height
                }, nextSource);
                if (shouldAskAboutCanvasOverride) {
                    const useImageResolution = await requestAppConfirmDialog(view, {
                        title: 'Canvas Resolution',
                        text: `The current Base canvas is ${currentDocument.base?.width || 0} x ${currentDocument.base?.height || 0}. Use "${file.name}" at ${sourceImage.width} x ${sourceImage.height} instead?`,
                        confirmLabel: 'Use Image Resolution',
                        cancelLabel: 'Keep Current Canvas'
                    });
                    if (!useImageResolution) {
                        nextBase = normalizeEditorBase(currentDocument.base, nextSource);
                    }
                }
                const nextDocument = applyEditorSettingsToDocument({
                    ...currentDocument,
                    source: nextSource,
                    base: nextBase,
                    view: { ...currentDocument.view, zoom: 1 },
                    workspace: { ...currentDocument.workspace, batchOpen: false },
                    batch: createEmptyBatchState()
                }, store.getState().settings);
                const synced = await syncStudioEngineToDocument(engine, nextDocument, { sourceImage });
                const syncedDocument = synced?.document || nextDocument;
                updateDocument(() => syncedDocument, { render: false });

                clearActiveLibraryOrigin('studio');
                engine.requestRender(syncedDocument);
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
                const embeddedSource = hasPersistableEditorSource(payload.source) ? normalizeEditorSource(payload.source) : null;
                const payloadWithoutPreview = stripStudioPreview(payload);
                const preservedSource = normalizeEditorSource(state.document.source);
                const hasExplicitSourceField = Object.prototype.hasOwnProperty.call(payloadWithoutPreview || {}, 'source');
                const nextSource = embeddedSource
                    ? (shouldLoadImage ? embeddedSource : preservedSource)
                    : hasExplicitSourceField
                        ? normalizeEditorSource(payloadWithoutPreview.source)
                        : preservedSource;
                const nextDocument = applyEditorSettingsToDocument({
                    ...state.document,
                    ...payloadWithoutPreview,
                    version: 'mns/v2',
                    kind: 'document',
                    mode: 'studio',
                    workspace: normalizeWorkspace('studio', payloadWithoutPreview.workspace || state.document.workspace, !!selection.layerInstanceId),
                    source: nextSource,
                    base: normalizeEditorBase(payloadWithoutPreview.base, embeddedSource || nextSource),
                    palette: payloadWithoutPreview.palette || state.document.palette,
                    layerStack: layerStack.map((instance) => applyEditorSettingsToLayerInstance(instance, store.getState().settings)),
                    selection,
                    view: normalizeViewState({ ...state.document.view, ...(payloadWithoutPreview.view || {}) }),
                    export: { ...state.document.export, ...(payloadWithoutPreview.export || {}) },
                    batch: createEmptyBatchState()
                }, store.getState().settings);
                clearActiveLibraryOrigin('studio');
                let sourceImage = null;
                if (shouldLoadImage && embeddedSource) {
                    setEditorProgress({
                        active: true,
                        title: 'Loading State',
                        message: isDngSource(embeddedSource)
                            ? `Restoring the embedded DNG source from "${file.name}"...`
                            : `Restoring the embedded source image from "${file.name}"...`,
                        progress: 0.54
                    });
                    logProcess('info', 'editor.files', `${isDngSource(embeddedSource) ? 'Restoring the embedded DNG source' : 'Restoring the embedded source image'} from "${file.name}".`, {
                        dedupeKey: `editor-state-embedded-source:${isDngSource(embeddedSource) ? 'dng' : 'raster'}:${file.name}`,
                        dedupeWindowMs: 120
                    });
                    if (!isDngSource(embeddedSource) && embeddedSource.imageData) {
                        sourceImage = await loadImageFromDataUrl(embeddedSource.imageData);
                    }
                }
                const synced = await syncStudioEngineToDocument(engine, nextDocument, { sourceImage });
                const syncedDocument = synced?.document || nextDocument;
                updateDocument(() => syncedDocument, { render: false });
                engine.requestRender(syncedDocument);

                if (shouldLoadImage && embeddedSource) {
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
                }
                clearWorkspaceProgress('studio');
                logProcess(droppedLayerCount ? 'warning' : 'success', 'editor.files', droppedLayerCount
                    ? `Loaded state file "${file.name}" and dropped ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                    : shouldLoadImage && embeddedSource
                        ? `Loaded state file "${file.name}" with its embedded image.`
                        : `Loaded state file "${file.name}".`);
                setNotice(
                    shouldLoadImage && !embeddedSource
                        ? `State loaded: ${file.name}. No embedded source image was included.${droppedLayerCount ? ` Removed ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.` : ''}`
                        : droppedLayerCount
                        ? `State loaded: ${file.name}. Removed ${droppedLayerCount} unsupported layer${droppedLayerCount === 1 ? '' : 's'}.`
                        : `State loaded: ${file.name}`,
                    (droppedLayerCount || (shouldLoadImage && !embeddedSource)) ? 'warning' : 'success'
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
            if (engine.hasImage()) {
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
            setEditorProgress({
                active: true,
                title: 'Saving State',
                message: 'Updating the linked Library project...',
                progress: 0.96
            });
            libraryProject = await actions.saveProjectToLibrary(
                stripProjectExtension(saveResult.fileName || state.document.source.name || getSuggestedProjectName(state.document) || 'noise-studio-state'),
                {
                    preferExisting: true,
                    promptless: true,
                    projectType: 'studio',
                    suppressWorkspaceOverlay: true,
                    suppressNotice: true
                }
            );

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
        setEditorExportBitDepth(value) {
            const normalized = String(value || '').trim().toLowerCase() === '16-bit' ? '16-bit' : '8-bit';
            updateDocument((document) => ({
                ...document,
                export: {
                    ...(document.export || {}),
                    pngBitDepth: normalized
                }
            }), { render: false });
        },
        async exportCurrent() {
            if (!engine.hasImage()) return setNotice('The Editor canvas is not ready yet.', 'warning');
            const state = store.getState();
            const source = normalizeEditorSource(state.document.source);
            const exportBitDepth = String(state.document.export?.pngBitDepth || '8-bit').trim().toLowerCase();
            const useDngPng16 = isDngSource(source) && exportBitDepth === '16-bit';
            await showWorkspaceProgress('studio', {
                title: 'Exporting PNG',
                message: useDngPng16
                    ? 'Rendering the current Editor canvas to 16-bit PNG...'
                    : 'Rendering the current Editor canvas to PNG...',
                progress: 0.16
            });
            logProcess('active', 'editor.export', useDngPng16
                ? 'Rendering the current Editor canvas to 16-bit PNG.'
                : 'Rendering the current Editor canvas to PNG.');
            try {
                const exportResult = useDngPng16
                    ? await engine.exportPng16(state.document)
                    : null;
                if (Array.isArray(exportResult?.warnings) && exportResult.warnings.length) {
                    exportResult.warnings.forEach((warning, index) => {
                        logProcess('warning', 'editor.export', warning, {
                            dedupeKey: `editor-export-dng-warning:${source.name || 'source'}:${index}`,
                            dedupeWindowMs: 400
                        });
                    });
                }
                const blob = useDngPng16
                    ? new Blob([
                        exportResult?.pngBytes instanceof ArrayBuffer
                            ? new Uint8Array(exportResult.pngBytes)
                            : (exportResult?.pngBytes instanceof Uint8Array ? exportResult.pngBytes : new Uint8Array())
                    ], { type: 'image/png' })
                    : await engine.exportPngBlob(state.document);
                const baseName = stripProjectExtension(state.document.source.name || getSuggestedProjectName(state.document) || 'editor-canvas');
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
        async exportThreeDViewportPng() {
            if (isThreeDRenderJobActive()) {
                logProcess('warning', '3d.export', 'Blocked viewport PNG save because a final 3D render is still active.');
                setNotice('Abort the active 3D render before saving the current viewport PNG.', 'warning', 6000);
                return null;
            }
            const documentState = store.getState().threeDDocument;
            const baseName = stripProjectExtension(getSuggestedThreeDProjectName(documentState) || '3d-scene') || '3d-scene';
            const fileName = `${baseName}-viewport.png`;
            await showWorkspaceProgress('3d', {
                title: 'Saving Viewport PNG',
                message: 'Capturing the current 3D viewport...',
                progress: 0.22
            });
            logProcess('active', '3d.export', `Capturing the current 3D viewport for "${fileName}".`);
            try {
                const capture = await view?.captureThreeDViewportPng?.();
                if (!(capture?.blob instanceof Blob)) {
                    throw new Error('Could not capture the current 3D viewport.');
                }
                setThreeDProgress({
                    active: true,
                    title: 'Saving Viewport PNG',
                    message: `Writing "${fileName}"...`,
                    progress: 0.88
                });
                const saveResult = await actions.persistThreeDRenderSave(capture.blob, fileName, {
                    documentState,
                    width: capture.width,
                    height: capture.height
                });
                clearWorkspaceProgress('3d');
                if (wasSaveCancelled(saveResult)) {
                    logProcess('info', '3d.export', 'Cancelled the current 3D viewport PNG save dialog.');
                    setNotice('Viewport PNG save cancelled.', 'info', 4200);
                    return null;
                }
                if (!didSaveFile(saveResult)) {
                    throw new Error(saveResult?.error || 'Could not save the current 3D viewport PNG.');
                }
                if (saveResult.libraryStatus === 'failed') {
                    logProcess('warning', '3d.export', `Saved the current 3D viewport PNG locally${describeSavedLocation(saveResult)}, but could not update the Assets Library.`);
                    setNotice('Viewport PNG saved locally, but the Assets Library copy could not be updated.', 'warning', 7000);
                    return saveResult;
                }
                logProcess('success', '3d.export', `Saved the current 3D viewport PNG${describeSavedLocation(saveResult)}.`);
                setNotice('Viewport PNG saved.', 'success');
                return saveResult;
            } catch (error) {
                clearWorkspaceProgress('3d');
                logProcess('error', '3d.export', error?.message || 'Could not save the current 3D viewport PNG.');
                setNotice(error?.message || 'Could not save the current 3D viewport PNG.', 'error', 7000);
                return null;
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
            if (!engine.hasImage()) return setNotice('The Editor canvas is not ready yet.', 'warning');
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
            const originalDocument = state.document;
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
                const synced = await syncStudioEngineToDocument(engine, originalDocument);
                const syncedDocument = synced?.document || originalDocument;
                updateDocument(() => syncedDocument, { render: false });
                engine.requestRender(syncedDocument);
            }
            setNotice('Batch export complete.', 'success');
        },
        async processLibraryPayloads(payloadsText, filenames, onProgress = null) {
            const state = store.getState();
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
                        const importedSource = normalizeEditorSource(projectData.payload?.source);
                        if (isDngSource(importedSource) && importedSource.rawData) {
                            const attachment = await saveStudioDngAttachment(projectData.id, importedSource);
                            if (attachment) {
                                projectData.payload = {
                                    ...projectData.payload,
                                    source: normalizeEditorSource({
                                        ...projectData.payload?.source,
                                        rawData: null,
                                        dng: {
                                            ...(projectData.payload?.source?.dng || {}),
                                            attachmentId: attachment.id
                                        }
                                    })
                                };
                                await saveToLibraryDB(projectData);
                            }
                        }
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

            try {
                await restoreActiveStudioRender();
            } catch (_error) {}

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
                return !hasEditorSourceImage(document)
                    && !(document?.layerStack || []).length
                    && isDefaultEditorBase(document?.base);
            },
            canSave(document) {
                return true;
            },
            emptyNotice: 'Set up the Base canvas, add layers, or load an image in the Editor before saving to the Library.',
            suggestName(document, nameOverride = null) {
                return getSuggestedProjectName(document, nameOverride);
            },
            serializeDocument(document) {
                return buildLibraryPayload(document);
            },
            validatePayload(rawPayload) {
                const normalized = stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload));
                const validated = validateImportPayload(normalized, 'document');
                return normalizeStudioDocumentForDng(applyEditorSettingsToDocument({
                    ...validated,
                    layerStack: reindexStack(registry, validated.layerStack || []).map((instance) => applyEditorSettingsToLayerInstance(instance, store.getState().settings))
                }, store.getState().settings));
            },
            async captureDocument(document, payload = null) {
                const basePayload = payload || buildLibraryPayload(document);
                let syncedDocument = document;
                if (!engine.hasImage()) {
                    const synced = await syncStudioEngineToDocument(engine, document);
                    syncedDocument = synced?.document || document;
                }
                const capture = await captureStudioDocumentSnapshot(engine, syncedDocument, basePayload);
                const finalPayload = capture.payload;
                const baseResolution = getEditorCanvasResolution(finalPayload);
                return {
                    payload: finalPayload,
                    blob: capture.blob,
                    summary: {
                        hoverSource: finalPayload.source,
                        sourceWidth: Number(baseResolution.width || 0),
                        sourceHeight: Number(baseResolution.height || 0),
                        sourceArea: Number(baseResolution.width || 0) * Number(baseResolution.height || 0),
                        sourceCount: hasPersistableEditorSource(finalPayload.source) ? 1 : 0,
                        renderWidth: Number(engine.runtime.renderWidth || baseResolution.width || 0),
                        renderHeight: Number(engine.runtime.renderHeight || baseResolution.height || 0)
                    }
                };
            },
            async prepareImportedProject(rawPayload) {
                const validated = this.validatePayload(rawPayload);
                const tempDoc = {
                    ...store.getState().document,
                    ...validated,
                    layerStack: validated.layerStack,
                    source: normalizeEditorSource(validated.source),
                    base: normalizeEditorBase(validated.base, validated.source)
                };
                const synced = await syncStudioEngineToDocument(engine, tempDoc);
                const syncedDocument = synced?.document || tempDoc;
                const capture = await captureStudioDocumentSnapshot(engine, syncedDocument, validated);
                const baseResolution = getEditorCanvasResolution(capture.payload);
                return {
                    payload: capture.payload,
                    blob: capture.blob,
                    summary: {
                        hoverSource: capture.payload.source,
                        sourceWidth: Number(baseResolution.width || 0),
                        sourceHeight: Number(baseResolution.height || 0),
                        sourceArea: Number(baseResolution.width || 0) * Number(baseResolution.height || 0),
                        sourceCount: hasPersistableEditorSource(capture.payload.source) ? 1 : 0,
                        renderWidth: Number(engine.runtime.renderWidth || baseResolution.width || 0),
                        renderHeight: Number(engine.runtime.renderHeight || baseResolution.height || 0)
                    }
                };
            },
            async restorePayload(rawPayload, libraryId = null, libraryName = null) {
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                const hydratedPayload = await hydrateStudioDngPayloadFromAttachment(rawPayload, libraryId);
                const validated = this.validatePayload(hydratedPayload);
                const runtimePayload = stripStudioPreview(validated);
                const baseDocument = store.getState().document;
                const nextDocument = normalizeStudioDocumentForDng(applyEditorSettingsToDocument({
                    ...baseDocument,
                    ...runtimePayload,
                    layerStack: runtimePayload.layerStack,
                    source: Object.prototype.hasOwnProperty.call(runtimePayload || {}, 'source')
                        ? normalizeEditorSource(runtimePayload.source)
                        : normalizeEditorSource(baseDocument.source),
                    base: normalizeEditorBase(runtimePayload.base, runtimePayload.source),
                    workspace: normalizeWorkspace('studio', runtimePayload.workspace || baseDocument.workspace, !!runtimePayload.selection?.layerInstanceId)
                }, store.getState().settings));
                const synced = await syncStudioEngineToDocument(engine, nextDocument);
                const syncedDocument = synced?.document || nextDocument;
                updateDocument(() => syncedDocument, { render: false });
                engine.requestRender(syncedDocument);
                setActiveLibraryOrigin('studio', libraryId, libraryName);
                commitActiveSection('editor');
                logProcess('success', 'library.projects', `Loaded "${libraryName || 'project'}" from the Library into Editor.`);
                setNotice(`Loaded "${libraryName || 'project'}" from Library.`, 'success');
                return true;
            }
        },
        {
            type: 'composite',
            label: 'Composite',
            getCurrentDocument(state) {
                return state.compositeDocument;
            },
            isEmpty(document) {
                return !normalizeCompositeDocument(document).layers.length;
            },
            canSave(document) {
                return normalizeCompositeDocument(document).layers.length > 0;
            },
            emptyNotice: 'Add one or more layers in Composite before saving to the Library.',
            suggestName(document, nameOverride = null) {
                return getSuggestedCompositeProjectName(document, nameOverride);
            },
            serializeDocument(document) {
                return buildCompositeLibraryPayload(document);
            },
            validatePayload(rawPayload) {
                const normalized = stripLibraryEnvelopeMetadata(normalizeLegacyDocumentPayload(rawPayload));
                return normalizeCompositeDocument(validateImportPayload(normalized, 'composite-document'));
            },
            async captureDocument(document, _payload = null, options = null) {
                const normalized = normalizeCompositeDocument(document);
                const capture = await captureCompositeDocumentSnapshot(normalized, options || undefined);
                return {
                    payload: capture.payload || buildCompositeLibraryPayload(normalized),
                    blob: capture.blob || null,
                    summary: {
                        ...summarizeCompositeDocument(capture.payload || normalized),
                        hoverSource: null
                    }
                };
            },
            async prepareImportedProject(rawPayload) {
                const validated = this.validatePayload(rawPayload);
                let capture = null;
                try {
                    capture = await captureCompositeDocumentSnapshot(validated);
                } catch (_error) {
                    capture = null;
                }
                const payload = capture?.payload || buildCompositeLibraryPayload(validated);
                return {
                    payload,
                    blob: capture?.blob || (payload.preview?.imageData ? await dataUrlToBlob(payload.preview.imageData) : null),
                    summary: {
                        ...summarizeCompositeDocument(payload),
                        hoverSource: null
                    }
                };
            },
            async restorePayload(rawPayload, libraryId = null, libraryName = null) {
                const validated = this.validatePayload(rawPayload);
                clearCompositeAutosaveTimer();
                clearCompositeBridgeState();
                updateCompositeDocument(() => applyCompositeSettingsToDocument(validated, store.getState().settings), {
                    renderComposite: true,
                    skipCompositeAutosave: true
                });
                setActiveLibraryOrigin('composite', libraryId, libraryName);
                commitActiveSection('composite');
                logProcess('success', 'library.projects', `Loaded "${libraryName || 'project'}" from the Library into Composite.`);
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
    const bootSynced = await syncStudioEngineToDocument(engine, store.getState().document);
    if (bootSynced?.document) {
        appStore.setState((state) => ({
            ...state,
            document: bootSynced.document
        }));
    }
    ensureCompositeEditorRenderEngineReady().catch((error) => {
        console.warn('Could not prewarm the hidden Composite Editor render engine.', error);
        compositeEditorRenderEngine = null;
        compositeEditorRenderCanvas = null;
        compositeEditorRenderReady = false;
        logProcess('warning', 'composite.render', error?.message || 'Could not prewarm the hidden Composite Editor render engine.');
    });
    bootMetrics.mark('editor-engine-ready', 'The Editor render engine finished booting.');
    setBootStage('background warmup', 'Scheduling background warmup jobs.');
    scheduleLibraryImageAssetPreviewWarmup();
    bootMetrics.mark('background-warmup-scheduled', 'Background warmup jobs are scheduled.');

    let lastSubscribedSection = store.getState().ui.activeSection;
    let pendingEditorRender = false;
    let pendingCompositeRender = false;
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
        if (meta.renderComposite) {
            if (activeSection === 'composite') {
                pendingCompositeRender = false;
            } else {
                pendingCompositeRender = true;
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
            if (activeSection === 'composite' && pendingCompositeRender) {
                pendingCompositeRender = false;
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
            : store.getState().ui.activeSection === 'composite'
                ? 'Add saved Editor projects or local images in Composite to start layering.'
            : store.getState().ui.activeSection === 'stitch'
                ? 'Add two or more images in Stitch to start building a composite.'
                : store.getState().ui.activeSection === '3d'
                    ? 'Load .glb models or add image planes to start building a 3D scene.'
                    : store.getState().ui.activeSection === 'logs'
                        ? 'Review live process cards here while the rest of the site works in the background.'
                    : 'Set the Base canvas, add layers, or load an image to start editing.',
        'info',
        6500
    );
});
