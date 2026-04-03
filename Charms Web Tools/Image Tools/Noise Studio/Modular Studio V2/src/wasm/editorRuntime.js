import { createOptionalEmscriptenRuntimeManager, validateEmscriptenExports } from './common.js';

const loadEditorRuntime = createOptionalEmscriptenRuntimeManager({
    label: 'Editor WASM',
    variants: [
        {
            selection: 'baseline',
            moduleUrl: new URL('../vendor/wasm/editor/editor-kernels.mjs', import.meta.url)
        },
        {
            selection: 'simd',
            moduleUrl: new URL('../vendor/wasm/editor/editor-kernels-simd.mjs', import.meta.url)
        }
    ],
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
