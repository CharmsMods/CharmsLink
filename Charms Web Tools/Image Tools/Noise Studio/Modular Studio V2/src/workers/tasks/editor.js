import { validateImportPayload } from '../../io/documents.js';
import { computeAnalysisVisualsJs, computeDiffPreviewJs, extractPaletteFromFileJs } from '../../editor/backgroundCompute.js';
import { exportDngBufferToPng16, prepareDngBuffer, probeDngBuffer } from '../../editor/dngProcessing.js';
import { getEditorWasmRuntime } from '../../wasm/editorRuntime.js';
import { reviveWorkerSingleFile } from '../filePayload.js';

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

let runtimeAnnouncement = '';

function markRuntimeAnnouncement(context, runtime) {
    const nextValue = runtime?.ok
        ? `${runtime.selection}:${Math.round(runtime.initMs || 0)}`
        : `fallback:${runtime?.reason || 'unavailable'}`;
    if (runtimeAnnouncement === nextValue) return;
    runtimeAnnouncement = nextValue;
    if (runtime?.ok) {
        context.log('info', `Editor WASM runtime ready (${runtime.selection}, ${Math.round(runtime.initMs || 0)}ms init).`);
    } else {
        context.log('warning', `Editor WASM unavailable, using JS fallback. ${runtime?.reason || ''}`.trim());
    }
}

function now() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function toHexColors(bytes, count) {
    const colors = [];
    for (let index = 0; index < count; index += 1) {
        const offset = index * 3;
        colors.push(`#${[bytes[offset], bytes[offset + 1], bytes[offset + 2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`);
    }
    return colors;
}

function computeAnalysisVisualsWithRuntime(runtime, payload = {}) {
    const api = runtime.api;
    const module = api.module;
    const pixels = payload.pixels instanceof Uint8Array ? payload.pixels : new Uint8Array(payload.pixels || []);
    const sourceWidth = Math.max(1, Number(payload.width) || 1);
    const sourceHeight = Math.max(1, Number(payload.height) || 1);
    const histogramWidth = Math.max(1, Number(payload.histogramWidth) || 512);
    const histogramHeight = Math.max(1, Number(payload.histogramHeight) || 220);
    const vectorscopeWidth = Math.max(1, Number(payload.vectorscopeWidth) || 360);
    const vectorscopeHeight = Math.max(1, Number(payload.vectorscopeHeight) || 360);
    const paradeWidth = Math.max(1, Number(payload.paradeWidth) || 620);
    const paradeHeight = Math.max(1, Number(payload.paradeHeight) || 220);
    const pixelPtr = api.malloc(pixels.length);
    const histogramPtr = api.malloc(histogramWidth * histogramHeight * 4);
    const vectorscopePtr = api.malloc(vectorscopeWidth * vectorscopeHeight * 4);
    const paradePtr = api.malloc(paradeWidth * paradeHeight * 4);
    const brightnessPtr = api.malloc(4);
    const saturationPtr = api.malloc(4);

    try {
        api.getHeapU8().set(pixels, pixelPtr);
        const histogramStatus = module._editor_compute_histogram_rgba(
            pixelPtr,
            sourceWidth,
            sourceHeight,
            histogramWidth,
            histogramHeight,
            histogramPtr,
            brightnessPtr
        );
        const vectorscopeStatus = module._editor_compute_vectorscope_rgba(
            pixelPtr,
            sourceWidth,
            sourceHeight,
            vectorscopeWidth,
            vectorscopeHeight,
            vectorscopePtr,
            saturationPtr
        );
        const paradeStatus = module._editor_compute_parade_rgba(
            pixelPtr,
            sourceWidth,
            sourceHeight,
            paradeWidth,
            paradeHeight,
            paradePtr
        );
        if (histogramStatus !== 1 || vectorscopeStatus !== 1 || paradeStatus !== 1) {
            throw new Error('Editor WASM analysis kernel returned an invalid status.');
        }
        const heapU8 = api.getHeapU8();
        const heap32 = api.getHeap32();
        return {
            histogram: {
                width: histogramWidth,
                height: histogramHeight,
                rgba: heapU8.slice(histogramPtr, histogramPtr + (histogramWidth * histogramHeight * 4))
            },
            vectorscope: {
                width: vectorscopeWidth,
                height: vectorscopeHeight,
                rgba: heapU8.slice(vectorscopePtr, vectorscopePtr + (vectorscopeWidth * vectorscopeHeight * 4))
            },
            parade: {
                width: paradeWidth,
                height: paradeHeight,
                rgba: heapU8.slice(paradePtr, paradePtr + (paradeWidth * paradeHeight * 4))
            },
            metrics: {
                averageBrightness: heap32[brightnessPtr >> 2] || 0,
                averageSaturation: heap32[saturationPtr >> 2] || 0,
                renderWidth: Math.max(1, Number(payload.renderWidth) || sourceWidth),
                renderHeight: Math.max(1, Number(payload.renderHeight) || sourceHeight)
            }
        };
    } finally {
        api.free(saturationPtr);
        api.free(brightnessPtr);
        api.free(paradePtr);
        api.free(vectorscopePtr);
        api.free(histogramPtr);
        api.free(pixelPtr);
    }
}

function computeDiffPreviewWithRuntime(runtime, payload = {}) {
    const api = runtime.api;
    const module = api.module;
    const basePixels = payload.basePixels instanceof Uint8ClampedArray
        ? payload.basePixels
        : new Uint8ClampedArray(payload.basePixels || []);
    const processedPixels = payload.processedPixels instanceof Uint8ClampedArray
        ? payload.processedPixels
        : new Uint8ClampedArray(payload.processedPixels || []);
    const total = Math.min(basePixels.length, processedPixels.length);
    const basePtr = api.malloc(total);
    const processedPtr = api.malloc(total);
    const outputPtr = api.malloc(total);

    try {
        api.getHeapU8().set(basePixels.subarray(0, total), basePtr);
        api.getHeapU8().set(processedPixels.subarray(0, total), processedPtr);
        const status = module._editor_compute_diff_preview(basePtr, processedPtr, total, outputPtr);
        if (status !== 1) {
            throw new Error('Editor WASM diff kernel returned an invalid status.');
        }
        const heapU8 = api.getHeapU8();
        return {
            width: Math.max(1, Number(payload.width) || 1),
            height: Math.max(1, Number(payload.height) || 1),
            rgba: new Uint8ClampedArray(heapU8.slice(outputPtr, outputPtr + total))
        };
    } finally {
        api.free(outputPtr);
        api.free(processedPtr);
        api.free(basePtr);
    }
}

function extractPaletteWithRuntime(runtime, payload = {}) {
    const api = runtime.api;
    const module = api.module;
    const pixels = payload.pixels instanceof Uint8ClampedArray
        ? payload.pixels
        : new Uint8ClampedArray(payload.pixels || []);
    const paletteSize = Math.max(2, Math.min(200, Math.round(Number(payload.count) || 8)));
    const pixelPtr = api.malloc(pixels.length);
    const outputPtr = api.malloc(paletteSize * 3);

    try {
        api.getHeapU8().set(pixels, pixelPtr);
        const actualCount = module._editor_extract_palette(
            pixelPtr,
            Math.max(1, Number(payload.width) || 1),
            Math.max(1, Number(payload.height) || 1),
            paletteSize,
            outputPtr
        );
        if (actualCount <= 0) {
            throw new Error('Editor WASM palette kernel returned no colors.');
        }
        return toHexColors(api.getHeapU8().slice(outputPtr, outputPtr + (actualCount * 3)), actualCount);
    } finally {
        api.free(outputPtr);
        api.free(pixelPtr);
    }
}

async function getRuntime(context) {
    const runtime = await getEditorWasmRuntime(context.capabilities || {});
    markRuntimeAnnouncement(context, runtime);
    return runtime;
}

export const editorTaskHandlers = {
    async 'read-studio-state-file'(payload = {}, context) {
        context.assertNotCancelled();
        const file = reviveWorkerSingleFile(payload.fileEntry, payload.file);
        if (!file) {
            throw new Error('No Studio state file was provided.');
        }
        context.log('info', `Parsing "${file.name}" in the background.`);
        const text = await file.text();
        context.assertNotCancelled();
        const parsed = JSON.parse(text);
        const normalized = normalizeLegacyDocumentPayload(parsed);
        return {
            payload: validateImportPayload(normalized, 'document')
        };
    },
    async 'compute-analysis-visuals'(payload = {}, context) {
        context.assertNotCancelled();
        const startedAt = now();
        const runtime = await getRuntime(context);
        context.assertNotCancelled();
        const usedWasm = !!runtime.ok;
        const result = usedWasm
            ? computeAnalysisVisualsWithRuntime(runtime, payload)
            : computeAnalysisVisualsJs(payload);
        const taskMs = Math.max(0, now() - startedAt);
        if (!usedWasm && runtime?.reason) {
            context.log('warning', `Editor analysis fell back to JS. ${runtime.reason}`);
        }
        context.log('info', `Computed Editor analysis visuals in ${Math.round(taskMs)}ms via ${usedWasm ? runtime.selection : 'js-fallback'}.`);
        const histogramBuffer = result.histogram.rgba.buffer.slice(result.histogram.rgba.byteOffset, result.histogram.rgba.byteOffset + result.histogram.rgba.byteLength);
        const vectorscopeBuffer = result.vectorscope.rgba.buffer.slice(result.vectorscope.rgba.byteOffset, result.vectorscope.rgba.byteOffset + result.vectorscope.rgba.byteLength);
        const paradeBuffer = result.parade.rgba.buffer.slice(result.parade.rgba.byteOffset, result.parade.rgba.byteOffset + result.parade.rgba.byteLength);
        return {
            payload: {
                histogram: { ...result.histogram, rgba: histogramBuffer },
                vectorscope: { ...result.vectorscope, rgba: vectorscopeBuffer },
                parade: { ...result.parade, rgba: paradeBuffer },
                metrics: result.metrics,
                runtime: {
                    selection: usedWasm ? runtime.selection : 'js-fallback',
                    initMs: runtime.initMs || 0,
                    taskMs,
                    fallbackReason: usedWasm ? '' : (runtime.reason || '')
                }
            },
            transfer: [histogramBuffer, vectorscopeBuffer, paradeBuffer]
        };
    },
    async 'compute-diff-preview'(payload = {}, context) {
        context.assertNotCancelled();
        const startedAt = now();
        const runtime = await getRuntime(context);
        context.assertNotCancelled();
        const usedWasm = !!runtime.ok;
        const result = usedWasm
            ? computeDiffPreviewWithRuntime(runtime, payload)
            : computeDiffPreviewJs(payload);
        const taskMs = Math.max(0, now() - startedAt);
        if (!usedWasm && runtime?.reason) {
            context.log('warning', `Editor diff preview fell back to JS. ${runtime.reason}`);
        }
        context.log('info', `Computed the Editor diff preview in ${Math.round(taskMs)}ms via ${usedWasm ? runtime.selection : 'js-fallback'}.`);
        const rgbaBuffer = result.rgba.buffer.slice(result.rgba.byteOffset, result.rgba.byteOffset + result.rgba.byteLength);
        return {
            payload: {
                width: result.width,
                height: result.height,
                rgba: rgbaBuffer,
                runtime: {
                    selection: usedWasm ? runtime.selection : 'js-fallback',
                    initMs: runtime.initMs || 0,
                    taskMs,
                    fallbackReason: usedWasm ? '' : (runtime.reason || '')
                }
            },
            transfer: [rgbaBuffer]
        };
    },
    async 'extract-palette-from-image'(payload = {}, context) {
        context.assertNotCancelled();
        const file = reviveWorkerSingleFile(payload.fileEntry, payload.file);
        if (!file) {
            throw new Error('No image was provided for palette extraction.');
        }
        const startedAt = now();
        const runtime = await getRuntime(context);
        context.assertNotCancelled();
        let palette = [];
        let selection = 'js-fallback';
        let fallbackReason = '';

        if (runtime.ok && typeof createImageBitmap === 'function' && typeof OffscreenCanvas === 'function') {
            const bitmap = await createImageBitmap(file);
            try {
                const width = Math.max(1, Number(bitmap.width) || 1);
                const height = Math.max(1, Number(bitmap.height) || 1);
                const sampleScale = Math.min(1, 320 / Math.max(width, height));
                const targetWidth = Math.max(1, Math.round(width * sampleScale));
                const targetHeight = Math.max(1, Math.round(height * sampleScale));
                const canvas = new OffscreenCanvas(targetWidth, targetHeight);
                const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
                if (!ctx) {
                    throw new Error('Could not create a palette extraction canvas.');
                }
                ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
                const pixels = ctx.getImageData(0, 0, targetWidth, targetHeight).data;
                palette = extractPaletteWithRuntime(runtime, {
                    pixels,
                    width: targetWidth,
                    height: targetHeight,
                    count: payload.count
                });
                selection = runtime.selection;
            } finally {
                bitmap.close?.();
            }
        } else {
            palette = await extractPaletteFromFileJs(file, payload.count, { deterministic: true });
            fallbackReason = runtime.ok
                ? 'Palette extraction canvas decoding was unavailable in this environment.'
                : (runtime.reason || 'Editor WASM runtime was unavailable.');
            context.log('warning', `Editor palette extraction fell back to JS. ${fallbackReason}`);
        }

        const taskMs = Math.max(0, now() - startedAt);
        context.log('info', `Extracted an Editor palette in ${Math.round(taskMs)}ms via ${selection}.`);
        return {
            palette,
            runtime: {
                selection,
                initMs: runtime.initMs || 0,
                taskMs,
                fallbackReason
            }
        };
    },
    async 'probe-dng-source'(payload = {}, context) {
        context.assertNotCancelled();
        const file = reviveWorkerSingleFile(payload.fileEntry, payload.file);
        if (!file) {
            throw new Error('No DNG file was provided for probing.');
        }
        context.log('active', `Probing DNG source "${file.name || 'source'}".`);
        context.progress(0.12, 'Reading the DNG source...');
        const buffer = await file.arrayBuffer();
        context.assertNotCancelled();
        context.progress(0.56, 'Inspecting TIFF / DNG metadata...');
        const result = await probeDngBuffer(buffer);
        context.assertNotCancelled();
        context.progress(1, 'DNG probe complete.');
        context.log('info', `Detected ${result?.probe?.compressionLabel || 'DNG'} source (${result?.probe?.width || 0} x ${result?.probe?.height || 0}, ${result?.probe?.classificationMode || 'unknown'}).`);
        return result;
    },
    async 'prepare-dng-source'(payload = {}, context) {
        context.assertNotCancelled();
        if (!(payload.buffer instanceof ArrayBuffer)) {
            throw new Error('No DNG byte buffer was provided for preparation.');
        }
        const previewQuality = payload.previewQuality === 'high' ? 'high' : 'fast';
        context.log('active', `Preparing DNG preview (${previewQuality}).`);
        context.progress(0.12, 'Parsing DNG metadata...');
        const prepared = await prepareDngBuffer(payload.buffer, payload.params, {
            previewQuality
        });
        context.assertNotCancelled();
        context.progress(1, 'DNG preview ready.');
        const rgba8 = prepared.rgba8 instanceof Uint8ClampedArray
            ? prepared.rgba8
            : new Uint8ClampedArray(prepared.rgba8 || []);
        const rgba8Buffer = rgba8.buffer.slice(rgba8.byteOffset, rgba8.byteOffset + rgba8.byteLength);
        return {
            payload: {
                ...prepared,
                rgba8: rgba8Buffer
            },
            transfer: [rgba8Buffer]
        };
    },
    async 'export-png16'(payload = {}, context) {
        context.assertNotCancelled();
        if (!(payload.buffer instanceof ArrayBuffer)) {
            throw new Error('No DNG byte buffer was provided for PNG export.');
        }
        context.log('active', 'Rendering DNG export to 16-bit PNG.');
        context.progress(0.14, 'Preparing the high-quality DNG render...');
        const exported = await exportDngBufferToPng16(payload.buffer, payload.params, {});
        context.assertNotCancelled();
        context.progress(1, '16-bit PNG export ready.');
        const pngBytes = exported.pngBytes instanceof Uint8Array
            ? exported.pngBytes
            : new Uint8Array(exported.pngBytes || []);
        const pngBuffer = pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength);
        return {
            payload: {
                ...exported,
                pngBytes: pngBuffer
            },
            transfer: [pngBuffer]
        };
    }
};
