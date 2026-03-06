import { createStore } from './state/store.js';
import { loadRegistry, createLayerInstance, relabelInstance } from './registry/index.js';
import { downloadState, readJsonFile, validateImportPayload } from './io/documents.js';
import { NoiseStudioEngine } from './engine/pipeline.js';
import { createWorkspaceUI } from './ui/workspaces.js';

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

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
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
            view: { zoom: 1, highQualityPreview: false },
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
        if (!layer) return instance;
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
    });

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

function createPaletteFromImage(image, count) {
    const canvas = document.createElement('canvas');
    const size = 200;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, size, size);
    const pixels = ctx.getImageData(0, 0, size, size).data;
    const samples = [];
    for (let index = 0; index < pixels.length; index += 16) {
        const alpha = pixels[index + 3];
        if (alpha < 240) continue;
        samples.push({
            r: pixels[index],
            g: pixels[index + 1],
            b: pixels[index + 2]
        });
    }
    if (!samples.length) return ['#111111', '#f5f7fa'];
    const palette = [samples[Math.floor(Math.random() * samples.length)]];
    const distances = new Array(samples.length).fill(Infinity);
    const updateDistances = (picked) => {
        samples.forEach((sample, index) => {
            const dist = Math.sqrt((sample.r - picked.r) ** 2 + (sample.g - picked.g) ** 2 + (sample.b - picked.b) ** 2);
            if (dist < distances[index]) distances[index] = dist;
        });
    };
    updateDistances(palette[0]);
    while (palette.length < Math.min(count, 12, samples.length)) {
        let bestIndex = 0;
        let bestDistance = -1;
        distances.forEach((distance, index) => {
            if (distance > bestDistance) {
                bestDistance = distance;
                bestIndex = index;
            }
        });
        palette.push(samples[bestIndex]);
        updateDistances(samples[bestIndex]);
    }
    return palette.map((sample) => `#${[sample.r, sample.g, sample.b].map((value) => value.toString(16).padStart(2, '0')).join('')}`);
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
        updateControl(instanceId, key, rawValue, meta) {
            updateDocument((document) => ({
                ...document,
                layerStack: document.layerStack.map((instance) => {
                    if (instance.instanceId !== instanceId) return instance;
                    const current = instance.params[key];
                    const layer = registry.byId[instance.layerId];
                    const nextValue = coerceValue(current, rawValue);
                    return {
                        ...instance,
                        enabled: layer?.enableKey === key ? !!nextValue : instance.enabled,
                        params: { ...instance.params, [key]: nextValue }
                    };
                })
            }), meta);
        },
        setZoom(mode) {
            updateDocument((document) => {
                const current = document.view.zoom;
                const next = typeof mode === 'number' ? mode : mode === 'fit' ? 1 : current + (mode === 'in' ? 0.1 : -0.1);
                return { ...document, view: { ...document.view, zoom: clamp(next, 1, 4) } };
            }, { render: false });
        },
        setHighQualityPreview(enabled) {
            updateDocument((document) => ({ ...document, view: { ...document.view, highQualityPreview: enabled } }));
        },
        addPaletteColor() {
            updateDocument((document) => ({ ...document, palette: [...document.palette, '#ffffff'] }));
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
        armEyedropper(target) {
            store.setState((state) => ({ ...state, eyedropperTarget: target, notice: { text: 'Click the preview to sample a color.', type: 'info' } }), { render: false });
        },
        async extractPaletteFromFile(file) {
            if (!file) return;
            const dataUrl = await fileToDataUrl(file);
            const image = await loadImageFromDataUrl(dataUrl);
            updateDocument((document) => ({ ...document, palette: createPaletteFromImage(image, 8) }));
        },
        async openImageFile(file) {
            if (!file) return;
            try {
                stopPlayback();
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
                const payload = validateImportPayload(await readJsonFile(file), 'document');
                const layerStack = reindexStack(registry, payload.layerStack || []);
                const selection = payload.selection || { layerInstanceId: layerStack[0]?.instanceId || null };
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
                        view: { ...current.document.view, ...(payload.view || {}) },
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
                        setNotice(`State loaded: ${file.name}`, 'success');
                    } catch (error) {
                        setNotice(`State loaded, but the embedded image could not be restored: ${error.message}`, 'warning', 7000);
                    }
                    return;
                }

                if (shouldLoadImage && !embeddedSource) {
                    setNotice('State loaded, but the file did not contain an embedded image.', 'warning', 7000);
                    return;
                }

                setNotice(`State loaded: ${file.name}`, 'success');
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
            const canvasRect = view.getRenderRefs().canvas.getBoundingClientRect();
            if (state.eyedropperTarget) {
                const hex = engine.pickColor(event.clientX, event.clientY);
                if (state.eyedropperTarget.kind === 'palette') {
                    updateDocument((document) => ({ ...document, palette: [...document.palette, hex] }));
                } else if (state.eyedropperTarget.kind === 'control') {
                    const [instanceId, key] = state.eyedropperTarget.target.split(':');
                    actions.updateControl(instanceId, key, hex);
                }
                store.setState((current) => ({ ...current, eyedropperTarget: null, notice: null }), { render: false });
                return;
            }
            const current = state.document.layerStack.find((instance) => instance.instanceId === state.document.selection.layerInstanceId);
            if (current?.layerId === 'ca' && current.params.caPin) {
                const x = clamp((event.clientX - canvasRect.left) / canvasRect.width, 0, 1);
                const y = clamp(1 - ((event.clientY - canvasRect.top) / canvasRect.height), 0, 1);
                updateDocument((document) => ({
                    ...document,
                    layerStack: document.layerStack.map((instance) => instance.instanceId === current.instanceId ? { ...instance, params: { ...instance.params, caCenterX: x, caCenterY: y } } : instance)
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
