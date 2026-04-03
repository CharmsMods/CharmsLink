import { createOptionalEmscriptenRuntimeManager, validateEmscriptenExports } from './common.js';

const loadLibraryRuntime = createOptionalEmscriptenRuntimeManager({
    label: 'Library WASM',
    variants: [
        {
            selection: 'baseline',
            moduleUrl: new URL('../vendor/wasm/library/library-codec.mjs', import.meta.url)
        },
        {
            selection: 'simd',
            moduleUrl: new URL('../vendor/wasm/library/library-codec-simd.mjs', import.meta.url)
        }
    ],
    createApi(module) {
        validateEmscriptenExports(module, [
            '_malloc',
            '_free',
            '_library_base64_encode_bound',
            '_library_base64_encode',
            '_library_base64_decode_bound',
            '_library_base64_decode'
        ], 'Library WASM');
        if (!module.HEAPU8) {
            throw new Error('Library WASM heap views are not available on the generated module.');
        }
        return {
            module,
            malloc: module._malloc.bind(module),
            free: module._free.bind(module),
            getHeapU8() {
                if (!module.HEAPU8) {
                    throw new Error('Library WASM heap view is unavailable.');
                }
                return module.HEAPU8;
            },
            getHeap32() {
                if (module.HEAP32) return module.HEAP32;
                const heapU8 = module.HEAPU8;
                if (!heapU8) {
                    throw new Error('Library WASM heap view is unavailable.');
                }
                return new Int32Array(heapU8.buffer);
            }
        };
    }
});

export async function getLibraryWasmRuntime(capabilities = {}) {
    if (!capabilities?.wasm) {
        return {
            ok: false,
            selection: 'js-fallback',
            initMs: 0,
            reason: 'WebAssembly is not available in this environment.'
        };
    }
    return loadLibraryRuntime({
        preferSimd: !!capabilities?.wasmSimd
    });
}
