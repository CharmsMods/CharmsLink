import { createVersionedAssetUrl } from '../appAssetVersion.js';
import { createOptionalEmscriptenRuntimeManager, validateEmscriptenExports } from './common.js';

async function validateLibraryRuntime(api) {
    const module = api.module;
    const sample = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const inputPtr = api.malloc(sample.length);
    const statusPtr = api.malloc(4);
    try {
        api.getHeapU8().set(sample, inputPtr);
        const encodedBound = module._library_base64_encode_bound(sample.length);
        const encodedPtr = api.malloc(encodedBound);
        try {
            const encodedLength = module._library_base64_encode(inputPtr, sample.length, encodedPtr);
            if (encodedLength <= 0) {
                throw new Error('Library WASM base64 encode self-test failed.');
            }
            const decodeBound = module._library_base64_decode_bound(encodedLength);
            const decodedPtr = api.malloc(decodeBound);
            try {
                const decodedLength = module._library_base64_decode(encodedPtr, encodedLength, decodedPtr, statusPtr);
                const status = api.getHeap32()[statusPtr >> 2] || 0;
                const decoded = api.getHeapU8().slice(decodedPtr, decodedPtr + decodedLength);
                if (status !== 1 || decodedLength !== sample.length || decoded.some((value, index) => value !== sample[index])) {
                    throw new Error('Library WASM base64 decode self-test failed.');
                }
            } finally {
                api.free(decodedPtr);
            }
        } finally {
            api.free(encodedPtr);
        }
    } finally {
        api.free(statusPtr);
        api.free(inputPtr);
    }
}

const loadLibraryRuntime = createOptionalEmscriptenRuntimeManager({
    label: 'Library WASM',
    variants: [
        {
            selection: 'baseline',
            moduleUrl: createVersionedAssetUrl('../vendor/wasm/library/library-codec.mjs', import.meta.url)
        },
        {
            selection: 'simd',
            moduleUrl: createVersionedAssetUrl('../vendor/wasm/library/library-codec-simd.mjs', import.meta.url)
        }
    ],
    validateApi: validateLibraryRuntime,
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
