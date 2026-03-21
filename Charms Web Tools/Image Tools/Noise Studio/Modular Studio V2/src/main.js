import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { downloadState, readJsonFile, validateImportPayload } from './io/documents.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { createWorkspaceUI } from './ui/workspaces.js';
import { clamp, createDefaultViewState, normalizeViewState, MAX_PREVIEW_ZOOM } from './state/documentHelpers.js';

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
