import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { downloadState, readJsonFile, validateImportPayload } from './io/documents.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { createWorkspaceUI } from './ui/workspaces.js';
import { clamp, createDefaultViewState, normalizeViewState, MAX_PREVIEW_ZOOM } from './state/documentHelpers.js';

const DB_NAME = 'ModularStudioDB';
const DB_VERSION = 1;
const STORE_NAME = 'LibraryProjects';

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'id' });
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
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

function makeProjectFingerprint(payload) {
    const src = payload.source?.name || payload.source?.imageData?.slice(0, 100) || '';
    const layers = (payload.layerStack || []).map(l => l.layerId + ':' + JSON.stringify(l.params)).join('|');
    return src + '::' + layers;
}

let activeLibraryId = null;
let activeLibraryName = null;

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
        ui: {
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

    let noticeTimer = null;
    let playbackTimer = null;
    let view = null;
    let paletteExtractionImage = null;
    let paletteExtractionOwner = null;

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

    const actions = {
        getState() {
            return store.getState();
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
            updateDocument((document) => ({
                ...document,
                view: {
                    ...document.view,
                    theme: enabled ? 'dark' : 'light'
                }
            }), { render: false });
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
                    workspace: normalizeWorkspace(document.mode, { ...document.workspace, studioView: 'layer' }, true)
                } : document;
            });
        },
        selectInstance(instanceId) {
            updateDocument((document) => ({ ...document, selection: { layerInstanceId: instanceId } }));
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
                return { ...document, layerStack: reindexStack(registry, layerStack), selection: { layerInstanceId: duplicate.instanceId } };
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
        async saveProjectToLibrary(nameOverride = null, forceNew = false) {
            const state = store.getState();
            if (!state.document.source?.imageData) {
                setNotice('No image loaded — nothing to save.', 'warning');
                return;
            }
            
            const payloadParams = {
                version: 2,
                kind: 'document',
                workspace: state.document.workspace,
                export: state.document.export,
                source: state.document.source,
                layerStack: state.document.layerStack
            };
            
            // Deduplication: fingerprint current payload and remove older matches
            const fingerprint = makeProjectFingerprint(payloadParams);
            try {
                const existing = await getAllFromLibraryDB();
                for (const entry of existing) {
                    if (entry.payload && makeProjectFingerprint(entry.payload) === fingerprint) {
                        // Exact match already in library
                        if (entry.id === activeLibraryId) {
                            setNotice('Already saved — no changes detected.', 'info');
                            return;
                        }
                        await deleteFromLibraryDB(entry.id);
                    }
                }
            } catch (e) { /* first run, no DB yet */ }
            
            let name;
            let saveId;
            
            if (!forceNew && activeLibraryId) {
                // Loaded from library — ask overwrite or new
                const choice = prompt(
                    `This project was loaded from "${activeLibraryName}".\n\nType a new name to save as a NEW entry, or leave as-is to OVERWRITE the existing one:`,
                    activeLibraryName
                );
                if (choice === null) return; // cancelled
                if (choice === activeLibraryName) {
                    // Overwrite
                    saveId = activeLibraryId;
                    name = activeLibraryName;
                } else {
                    // New entry
                    saveId = Date.now().toString(36) + Math.random().toString(36).substr(2);
                    name = choice;
                }
            } else {
                // Brand new or forced new
                name = nameOverride || state.document.source.name || 'Untitled';
                name = name.replace(/\.[^/.]+$/, '');
                const askedName = prompt('Name your project for the Library:', name);
                if (!askedName) return;
                name = askedName;
                saveId = Date.now().toString(36) + Math.random().toString(36).substr(2);
            }
            
            setNotice('Saving to Library...', 'info', 0);
            const blob = await engine.exportPngBlob(state.document);
            const projectData = {
                id: saveId,
                timestamp: Date.now(),
                name: name,
                blob: blob,
                payload: payloadParams
            };
            await saveToLibraryDB(projectData);
            activeLibraryId = saveId;
            activeLibraryName = name;
            setNotice(`Saved "${name}" to Library.`, 'success');
            if (window.libraryWindow && !window.libraryWindow.closed) window.libraryWindow.postMessage({ type: 'LIBRARY_DB_UPDATED' }, '*');
        },
        async newProject() {
            const state = store.getState();
            if (engine.hasImage()) {
                let name = state.document.source.name || 'Untitled';
                const askedName = prompt('Before starting a new project, name your current project for the Library:', name);
                if (askedName) {
                    await actions.saveProjectToLibrary(askedName);
                } else if (!confirm('Discard current project without saving to Library?')) {
                    return;
                }
            }
            updateDocument((document) => ({
                ...document,
                source: { width: 0, height: 0, name: '', imageData: null },
                layerStack: [],
                palette: [],
                selection: { layerInstanceId: null },
                workspace: { ...document.workspace, batchOpen: false },
                batch: createEmptyBatchState()
            }), { render: false });
            activeLibraryId = null;
            activeLibraryName = null;
            engine.requestRender(store.getState().document);
            setNotice('Started a new project.', 'success');
        },
        async openImageFile(file) {
            if (!file) return;
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
                
                engine.requestRender(store.getState().document);
                await actions.saveProjectToLibrary(file.name.replace(/\.[^/.]+$/, ''));
                
                setNotice(`Loaded ${file.name}.`, 'success');
            } catch (error) {
                setNotice(`Could not load image: ${error.message}`, 'error', 6000);
            }
        },
        async openStateFile(file) {
            if (!file) return;
            try {
                stopPlayback();
                paletteExtractionImage = null;
                paletteExtractionOwner = null;
                const payload = validateImportPayload(await readJsonFile(file), 'document');
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

                if (shouldLoadImage && embeddedSource) {
                    try {
                        const image = await loadImageFromDataUrl(embeddedSource.imageData);
                        await engine.loadImage(image, embeddedSource);
                        updateDocument((document) => ({ ...document, source: embeddedSource }), { render: false });
                        engine.requestRender(store.getState().document);
                        await actions.saveProjectToLibrary(file.name.replace(/\.[^/.]+$/, ''));
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
        async processLibraryPayloads(payloadsText, filenames) {
            if (!window.libraryWindow || window.libraryWindow.closed) return;
            const state = store.getState();
            const originalSource = state.document.source;
            setNotice(`Rendering ${payloadsText.length} variants to Library DB...`, 'info', 0);
            
            window.libraryWindow.postMessage({ type: 'START_RENDER', total: payloadsText.length }, '*');
            
            for (let i = 0; i < payloadsText.length; i++) {
                window.libraryWindow.postMessage({ type: 'UPDATE_PROGRESS', count: i, total: payloadsText.length, filename: filenames[i] }, '*');
                
                try {
                     const rawState = JSON.parse(payloadsText[i]);
                     const validated = validateImportPayload(rawState, rawState.kind || 'document');
                     if (!validated.source || !validated.source.imageData) continue;

                     const layerStack = reindexStack(registry, validated.layerStack || []);
                     const tempDoc = { ...state.document, ...validated, layerStack, source: validated.source };
                     const image = await loadImageFromDataUrl(validated.source.imageData);
                     await engine.loadImage(image, validated.source);
                     const blob = await engine.exportPngBlob(tempDoc);
                     
                     const projectData = {
                         id: Date.now().toString(36) + Math.random().toString(36).substr(2),
                         timestamp: Date.now(),
                         name: filenames[i],
                         blob: blob,
                         payload: validated
                     };
                     await saveToLibraryDB(projectData);
                } catch (err) {
                     console.error(`[Library] Error processing file ${filenames[i]}:`, err);
                }
            }

            if (originalSource && originalSource.imageData) {
                try {
                    const originalImage = await loadImageFromDataUrl(originalSource.imageData);
                    await engine.loadImage(originalImage, originalSource);
                } catch(e) {}
            }

            window.libraryWindow.postMessage({ type: 'LIBRARY_DB_UPDATED' }, '*');
            setNotice('Library renders saved to DB.', 'success', 3000);
        },

        openLibrary() {
            if (window.libraryWindow && !window.libraryWindow.closed) {
                window.libraryWindow.focus();
                return;
            }
            window.libraryWindow = window.open('', 'ModularStudioLibrary');
            if (window.libraryWindow.isLibraryInitialized) {
                window.libraryWindow.focus();
                return;
            }
            window.libraryWindow.isLibraryInitialized = true;
            const html = `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>Modular Studio Library</title>
                    <style>
                        body { margin: 0; background: #0b0c10; overflow: hidden; display: flex; flex-direction: column; height: 100vh; font-family: system-ui, sans-serif; color: #fff; }
                        .header { display: flex; align-items: center; padding: 12px 16px; background: #111; border-bottom: 1px solid #333; flex-shrink: 0; gap: 16px; flex-wrap: wrap; }
                        .header-title { font-weight: 600; font-size: 14px; margin-right: auto; line-height: 1; text-transform: uppercase; letter-spacing: 1px; }
                        .toolbar-btn { background: #222; border: 1px solid #444; color: #fff; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500; transition: all 0.2s; white-space: nowrap; }
                        .toolbar-btn:hover { background: #333; border-color: #555; }
                        .toolbar-btn.active { background: rgba(0,209,255,0.1); color: #00d1ff; border-color: #00d1ff; }
                        .content { flex: 1; overflow-y: auto; overflow-x: hidden; position: relative; }
                        .grid-view { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 2px; padding: 2px; }
                        .grid-view.hidden { display: none; }
                        .grid-item { position: relative; background: #000; overflow: hidden; display: flex; align-items: center; justify-content: center; height: 49vh; cursor: pointer; }
                        .fullscreen-view { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: #000; align-items: center; justify-content: center; cursor: pointer; user-select: none; }
                        .fullscreen-view.active { display: flex; }
                        .image-container { width: 100%; height: 100%; position: relative; overflow: hidden; display: flex; align-items: center; justify-content: center; }
                        .img-base, .img-hover { position: absolute; width: 100%; height: 100%; object-fit: contain; pointer-events: none; transition: opacity 0.3s ease; }
                        .img-hover { opacity: 0; z-index: 5; }
                        .img-base { opacity: 1; z-index: 1; }
                        body.hover-enabled .image-container:hover .img-hover { opacity: 1; }
                        body.hover-enabled .image-container:hover .img-base { opacity: 0; }
                        .label { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.7); font-size: 12px; padding: 4px 8px; border-radius: 4px; pointer-events: none; z-index: 10; }
                        .delete-btn { position: absolute; bottom: 8px; right: 8px; z-index: 20; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.2); color: #fff; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; font-size: 18px; line-height: 1; display: flex; align-items: center; justify-content: center; opacity: 0; transition: all 0.2s ease; padding: 0; }
                        .grid-item:hover .delete-btn { opacity: 1; }
                        .delete-btn:hover { background: rgba(255,60,60,0.8); border-color: #ff3c3c; transform: scale(1.15); }
                        .hover-hint { position: absolute; top: 8px; right: 8px; background: rgba(0,209,255,0.2); border: 1px solid rgba(0,209,255,0.5); font-size: 10px; padding: 4px 8px; border-radius: 4px; pointer-events: none; z-index: 10; opacity: 0; transition: opacity 0.3s ease; }
                        body.hover-enabled .grid-item:hover .hover-hint, body.hover-enabled .fullscreen-view:hover .hover-hint { opacity: 1; }
                        .fullscreen-label { position: absolute; top: 16px; left: 16px; background: rgba(0,0,0,0.7); font-size: 16px; padding: 8px 12px; border-radius: 4px; pointer-events: none; z-index: 10; }
                        
                        /* Loading Overlay */
                        .loading-overlay { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.9); z-index: 100; flex-direction: column; align-items: center; justify-content: center; }
                        .loading-overlay.active { display: flex; }
                        .progress-bar { width: 320px; height: 8px; background: #000; border: 1px solid #444; margin-top: 24px; border-radius: 4px; overflow: hidden; }
                        .progress-fill { height: 100%; background: #fff; width: 0%; transition: width 0.2s ease; }
                        h2 { margin: 0; font-weight: 500; font-size: 20px; color: rgba(255,255,255,0.9); }
                        p { margin: 8px 0 0; font-size: 14px; color: rgba(255,255,255,0.5); }

                        /* Custom Modal */
                        .modal-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.6); backdrop-filter: blur(4px); z-index: 200; align-items: center; justify-content: center; }
                        .modal-overlay.active { display: flex; }
                        .modal-box { background: #1a1b1f; border: 1px solid #333; border-radius: 8px; padding: 24px; max-width: 380px; width: 90%; box-shadow: 0 12px 40px rgba(0,0,0,0.5); }
                        .modal-text { font-size: 14px; line-height: 1.6; color: rgba(255,255,255,0.85); margin: 0 0 20px; }
                        .modal-actions { display: flex; gap: 10px; justify-content: flex-end; }
                        .modal-btn { padding: 8px 20px; border-radius: 4px; border: 1px solid #444; background: #222; color: #fff; font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s ease; }
                        .modal-btn:hover { background: #333; border-color: #555; }
                        .modal-btn.primary { background: rgba(0,209,255,0.15); border-color: #00d1ff; color: #00d1ff; }
                        .modal-btn.primary:hover { background: rgba(0,209,255,0.25); }
                        .modal-btn.danger { background: rgba(255,60,60,0.15); border-color: rgba(255,60,60,0.5); color: #ff6060; }
                        .modal-btn.danger:hover { background: rgba(255,60,60,0.25); }
                    </style>
                    <script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"><\/script>
                </head>
                <body class="hover-enabled">
                    <div class="header">
                        <div class="header-title">Studio Library</div>
                        <button class="toolbar-btn" id="btnUpload" style="background: rgba(0,209,255,0.1); border-color: #00d1ff; color: #00d1ff;">Upload JSON</button>
                        <button class="toolbar-btn active" id="btnHover">Hover Reveal Original</button>
                        <button class="toolbar-btn" id="btnFullscreen">Show Interactive Series</button>
                        <button class="toolbar-btn" id="btnDownloadSave" style="margin-left: auto;">Save Full Project</button>
                        <button class="toolbar-btn" id="btnExportZip">Export All JSONs</button>
                        <button class="toolbar-btn" id="btnClearAll" style="background: rgba(255,60,60,0.1); border-color: rgba(255,60,60,0.4); color: #ff6060;">Clear All</button>
                    </div>
                    <div class="content">
                        <!-- Grid View -->
                        <div class="grid-view" id="gridView"></div>
                        <!-- Fullscreen Interactive View -->
                        <div class="fullscreen-view" id="fullscreenView">
                            <div class="fullscreen-label" id="fsLabel"></div>
                            <div class="hover-hint">Hovering Original</div>
                            <div class="image-container">
                                <img src="" class="img-base" id="fsBase" />
                                <img src="" class="img-hover" id="fsHover" />
                            </div>
                        </div>
                        
                        <!-- Loading Overlay -->
                        <div class="loading-overlay" id="loadingOverlay">
                            <h2 id="statusText">Preparing engine...</h2>
                            <p id="countText">0 variants completed</p>
                            <div class="progress-bar"><div class="progress-fill" id="progressFill"></div></div>
                        </div>
                    </div>

                    <!-- Modal -->
                    <div class="modal-overlay" id="modalOverlay">
                        <div class="modal-box">
                            <div class="modal-text" id="modalText"></div>
                            <div class="modal-actions" id="modalActions"></div>
                        </div>
                    </div>

                    <script>
                        const DB_NAME = 'ModularStudioDB';
                        const STORE_NAME = 'LibraryProjects';
                        
                        const libraryChannel = new BroadcastChannel('ModularStudioLibraryChannel');

                        // --- Custom Modal System ---
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
                                    el.addEventListener('click', () => {
                                        overlay.classList.remove('active');
                                        resolve(btn.value);
                                    });
                                    actionsEl.appendChild(el);
                                });
                                overlay.classList.add('active');
                            });
                        }
                        function showAlert(message) {
                            return showModal(message, [{ label: 'OK', value: true, class: 'primary' }]);
                        }
                        function showConfirm(message) {
                            return showModal(message, [
                                { label: 'Cancel', value: false },
                                { label: 'Confirm', value: true, class: 'primary' }
                            ]);
                        }

                        // --- DB helpers ---
                        function getAllFromLibraryDB() {
                            return new Promise((resolve, reject) => {
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
                                request.onsuccess = (e) => {
                                    const db = e.target.result;
                                    const tx = db.transaction(STORE_NAME, 'readwrite');
                                    tx.objectStore(STORE_NAME).delete(id);
                                    tx.oncomplete = () => resolve();
                                };
                                request.onerror = () => resolve();
                            });
                        }

                        function clearAllFromLibraryDB() {
                            return new Promise((resolve) => {
                                const request = indexedDB.open(DB_NAME, 1);
                                request.onsuccess = (e) => {
                                    const db = e.target.result;
                                    const tx = db.transaction(STORE_NAME, 'readwrite');
                                    tx.objectStore(STORE_NAME).clear();
                                    tx.oncomplete = () => resolve();
                                };
                                request.onerror = () => resolve();
                            });
                        }

                        let libraryData = [];
                        
                        const gridView = document.getElementById('gridView');
                        const fullscreenView = document.getElementById('fullscreenView');
                        const fsLabel = document.getElementById('fsLabel');
                        const fsBase = document.getElementById('fsBase');
                        const fsHover = document.getElementById('fsHover');
                        const loadingOverlay = document.getElementById('loadingOverlay');
                        
                        let isHoverEnabled = true;
                        let isFullscreen = false;
                        let currentIndex = 0;

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
                                        <button class="delete-btn" data-delete-id="\${res.id}" title="Delete from Library">&times;</button>
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
                        
                        refreshLibrary(); // initial boot

                        btnUpload.addEventListener('click', () => {
                            const input = document.createElement('input');
                            input.type = 'file';
                            input.multiple = true;
                            input.accept = '.mns.json,.json';
                            input.onchange = async (e) => {
                                const files = Array.from(e.target.files);
                                if (!files.length) return;
                                const payloads = await Promise.all(files.map(f => f.text()));
                                
                                let unrolledPayloads = [];
                                let unrolledNames = [];
                                payloads.forEach((text, i) => {
                                    try {
                                        const parsed = JSON.parse(text);
                                        if (Array.isArray(parsed)) {
                                            parsed.forEach((item, subIdx) => {
                                                const savedName = item._libraryName || (files[i].name.replace('.json', '') + '-' + subIdx + '.json');
                                                unrolledPayloads.push(JSON.stringify(item));
                                                unrolledNames.push(savedName);
                                            });
                                        } else {
                                            unrolledPayloads.push(text);
                                            unrolledNames.push(files[i].name);
                                        }
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
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'modular_studio_library.json';
                            a.click();
                            URL.revokeObjectURL(url);
                        }

                        btnDownloadSave.addEventListener('click', () => {
                            if (!libraryData.length) return showAlert('Library is empty.');
                            triggerFullProjectDownload();
                        });

                        btnExportZip.addEventListener('click', async () => {
                            if (!libraryData.length) return showAlert('Library is empty.');
                            if (typeof JSZip === 'undefined') return showAlert('ZIP library failed to load. Check your connection.');
                            const zip = new JSZip();
                            libraryData.forEach((d) => {
                                const payload = { version: 2, kind: 'document', ...d.payload };
                                let filename = d.name || 'untitled';
                                if (!filename.endsWith('.json')) filename += '.mns.json';
                                zip.file(filename, JSON.stringify(payload, null, 2));
                            });
                            const content = await zip.generateAsync({ type: 'blob' });
                            const url = URL.createObjectURL(content);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'modular_studio_exports.zip';
                            a.click();
                            URL.revokeObjectURL(url);
                        });

                        btnClearAll.addEventListener('click', async () => {
                            if (!libraryData.length) return showAlert('Library is already empty.');
                            const save = await showConfirm('Would you like to save the full library before clearing?');
                            if (save) {
                                triggerFullProjectDownload();
                            }
                            const proceed = await showModal('Are you sure you want to clear the entire Library? This cannot be undone.', [
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
                            if (isFullscreen) {
                                gridView.classList.add('hidden');
                                fullscreenView.classList.add('active');
                                btnFullscreen.textContent = 'Show Grid';
                                updateFullscreen();
                            } else {
                                gridView.classList.remove('hidden');
                                fullscreenView.classList.remove('active');
                                btnFullscreen.textContent = 'Show Interactive Series';
                            }
                        });

                        fullscreenView.addEventListener('click', () => {
                            if (!libraryData.length) return;
                            currentIndex = (currentIndex + 1) % libraryData.length;
                            updateFullscreen();
                        });

                        gridView.addEventListener('click', async (e) => {
                            // Handle delete button
                            const deleteBtn = e.target.closest('.delete-btn');
                            if (deleteBtn) {
                                e.stopPropagation();
                                const id = deleteBtn.dataset.deleteId;
                                const proceed = await showModal('Remove this project from the Library?', [
                                    { label: 'Cancel', value: false },
                                    { label: 'Delete', value: true, class: 'danger' }
                                ]);
                                if (proceed) {
                                    await deleteFromLibraryDB(id);
                                    await refreshLibrary();
                                }
                                return;
                            }
                            // Handle load project
                            const item = e.target.closest('.grid-item');
                            if (!item) return;
                            const index = parseInt(item.dataset.index, 10);
                            const data = libraryData[index];
                            const load = await showConfirm('Load this image and settings to main studio?');
                            if (load) {
                                libraryChannel.postMessage({ type: 'LOAD_PROJECT', payload: data.payload, libraryId: data.id, libraryName: data.name });
                            }
                        });

                        function updateFullscreen() {
                            if (!libraryData.length) return;
                            if (currentIndex >= libraryData.length) currentIndex = 0;
                            const current = libraryData[currentIndex];
                            fsLabel.textContent = current.name + ' (' + (currentIndex + 1) + ' / ' + libraryData.length + ')';
                            fsBase.src = current.url;
                            if (current.hoverSrc) {
                                fsHover.src = current.hoverSrc;
                            } else {
                                fsHover.src = '';
                            }
                        }

                        window.addEventListener('message', (e) => {
                            if (!e.data || !e.data.type) return;
                            
                            if (e.data.type === 'START_RENDER') {
                                loadingOverlay.classList.add('active');
                                document.getElementById('statusText').textContent = 'Preparing engine...';
                                document.getElementById('countText').textContent = '0 / ' + e.data.total + ' variants completed';
                                document.getElementById('progressFill').style.width = '0%';
                            }
                            else if (e.data.type === 'UPDATE_PROGRESS') {
                                document.getElementById('statusText').textContent = 'Rendering ' + e.data.filename + '...';
                                document.getElementById('countText').textContent = e.data.count + ' / ' + e.data.total + ' variants completed';
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
            window.libraryWindow.document.open();
            window.libraryWindow.document.write(html);
            window.libraryWindow.document.close();
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
        }
    };

    const libraryChannel = new BroadcastChannel('ModularStudioLibraryChannel');
    libraryChannel.onmessage = async (e) => {
        if (!e.data || !e.data.type) return;
        if (e.data.type === 'RENDER_LIBRARY_FILES') {
            if (e.data.payloads && e.data.filenames) {
                actions.processLibraryPayloads(e.data.payloads, e.data.filenames);
            }
        } else if (e.data.type === 'LOAD_PROJECT') {
            const state = store.getState();
            if (state.document.source?.imageData) {
                await actions.saveProjectToLibrary((state.document.source.name || 'current').replace(/\.[^/.]+$/, ''), true);
            }
            
            try {
                const payloadStr = typeof e.data.payload === 'string' ? e.data.payload : JSON.stringify(e.data.payload);
                const rawState = JSON.parse(payloadStr);
                const validated = validateImportPayload(rawState, rawState.kind || 'document');
                if (validated.source && validated.source.imageData) {
                    const image = await loadImageFromDataUrl(validated.source.imageData);
                    await engine.loadImage(image, validated.source);
                }
                const layerStack = reindexStack(registry, validated.layerStack || []);
                updateDocument((document) => ({
                    ...document,
                    ...validated,
                    layerStack,
                    source: validated.source || document.source
                }), { render: true });
                
                // Track where this project came from
                activeLibraryId = e.data.libraryId || null;
                activeLibraryName = e.data.libraryName || null;
                
                setNotice(`Loaded "${activeLibraryName || 'project'}" from Library.`, 'success');
            } catch (err) {
                console.error(err);
                setNotice('Failed to load project from Library', 'error');
            }
        }
    };

    view = createWorkspaceUI(root, registry, actions);
    await engine.init(view.getRenderRefs().canvas);
    engine.attachRefs(view.getRenderRefs());

    store.subscribe((state, meta) => {
        if (!meta.skipViewRender) {
            view.render(state);
            engine.attachRefs(view.getRenderRefs());
        }
        if (meta.render && engine.hasImage()) engine.requestRender(state.document);
    });

    view.render(store.getState());
    engine.attachRefs(view.getRenderRefs());
    setNotice('Load an image to start editing.', 'info', 6500);
});
