import { createVersionedAssetUrl } from '../appAssetVersion.js';
import { createOptionalEmscriptenRuntimeManager, validateEmscriptenExports } from './common.js';

async function validateEditorRuntime(api) {
    const module = api.module;
    const samplePixels = new Uint8Array([
        255, 0, 0, 255,
        0, 255, 0, 255,
        0, 0, 255, 255,
        255, 255, 255, 255
    ]);
    const pixelPtr = api.malloc(samplePixels.length);
    const histogramPtr = api.malloc(16 * 8 * 4);
    const vectorscopePtr = api.malloc(16 * 16 * 4);
    const paradePtr = api.malloc(24 * 8 * 4);
    const brightnessPtr = api.malloc(4);
    const saturationPtr = api.malloc(4);
    const diffBasePtr = api.malloc(8);
    const diffProcessedPtr = api.malloc(8);
    const diffOutputPtr = api.malloc(8);
    const palettePtr = api.malloc(12);

    try {
        api.getHeapU8().set(samplePixels, pixelPtr);
        api.getHeapU8().set(new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]), diffBasePtr);
        api.getHeapU8().set(new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]), diffProcessedPtr);
        const histogramStatus = module._editor_compute_histogram_rgba(pixelPtr, 2, 2, 16, 8, histogramPtr, brightnessPtr);
        const vectorscopeStatus = module._editor_compute_vectorscope_rgba(pixelPtr, 2, 2, 16, 16, vectorscopePtr, saturationPtr);
        const paradeStatus = module._editor_compute_parade_rgba(pixelPtr, 2, 2, 24, 8, paradePtr);
        const diffStatus = module._editor_compute_diff_preview(diffBasePtr, diffProcessedPtr, 8, diffOutputPtr);
        const paletteCount = module._editor_extract_palette(pixelPtr, 2, 2, 4, palettePtr);
        if (histogramStatus !== 1 || vectorscopeStatus !== 1 || paradeStatus !== 1 || diffStatus !== 1 || paletteCount <= 0) {
            throw new Error('Editor WASM self-test failed.');
        }
    } finally {
        api.free(palettePtr);
        api.free(diffOutputPtr);
        api.free(diffProcessedPtr);
        api.free(diffBasePtr);
        api.free(saturationPtr);
        api.free(brightnessPtr);
        api.free(paradePtr);
        api.free(vectorscopePtr);
        api.free(histogramPtr);
        api.free(pixelPtr);
    }
}

const loadEditorRuntime = createOptionalEmscriptenRuntimeManager({
    label: 'Editor WASM',
    variants: [
        {
            selection: 'baseline',
            moduleUrl: createVersionedAssetUrl('../vendor/wasm/editor/editor-kernels.mjs', import.meta.url)
        },
        {
            selection: 'simd',
            moduleUrl: createVersionedAssetUrl('../vendor/wasm/editor/editor-kernels-simd.mjs', import.meta.url)
        }
    ],
    validateApi: validateEditorRuntime,
    createApi(module) {
        validateEmscriptenExports(module, [
            '_malloc',
            '_free',
            '_editor_compute_histogram_rgba',
            '_editor_compute_vectorscope_rgba',
            '_editor_compute_parade_rgba',
            '_editor_compute_diff_preview',
            '_editor_extract_palette'
        ], 'Editor WASM');
        if (!module.HEAPU8) {
            throw new Error('Editor WASM heap views are not available on the generated module.');
        }
        return {
            module,
            malloc: module._malloc.bind(module),
            free: module._free.bind(module),
            getHeapU8() {
                if (!module.HEAPU8) {
                    throw new Error('Editor WASM heap view is unavailable.');
                }
                return module.HEAPU8;
            },
            getHeap32() {
                if (module.HEAP32) return module.HEAP32;
                const heapU8 = module.HEAPU8;
                if (!heapU8) {
                    throw new Error('Editor WASM heap view is unavailable.');
                }
                return new Int32Array(heapU8.buffer);
            }
        };
    }
});

export async function getEditorWasmRuntime(capabilities = {}) {
    if (!capabilities?.wasm) {
        return {
            ok: false,
            selection: 'js-fallback',
            initMs: 0,
            reason: 'WebAssembly is not available in this environment.'
        };
    }
    return loadEditorRuntime({
        preferSimd: !!capabilities?.wasmSimd
    });
}
