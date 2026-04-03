function detectOffscreenCanvasWebgl2() {
    if (typeof OffscreenCanvas !== 'function') return false;
    try {
        const canvas = new OffscreenCanvas(1, 1);
        return !!canvas.getContext('webgl2');
    } catch (_error) {
        return false;
    }
}

function detectModuleWorkerSupport() {
    if (typeof Worker !== 'function' || typeof URL?.createObjectURL !== 'function' || typeof Blob !== 'function') {
        return false;
    }
    let url = '';
    try {
        url = URL.createObjectURL(new Blob(['export default null;'], { type: 'text/javascript' }));
        const worker = new Worker(url, { type: 'module' });
        worker.terminate();
        return true;
    } catch (_error) {
        return false;
    } finally {
        if (url) URL.revokeObjectURL(url);
    }
}

function detectWasmSimdSupport() {
    if (typeof WebAssembly !== 'object' || typeof WebAssembly.validate !== 'function') {
        return false;
    }
    try {
        return WebAssembly.validate(new Uint8Array([
            0, 97, 115, 109, 1, 0, 0, 0,
            1, 5, 1, 96, 0, 1, 123,
            3, 2, 1, 0,
            10, 10, 1, 8, 0, 65, 0, 253, 15, 11
        ]));
    } catch (_error) {
        return false;
    }
}

export async function detectWorkerCapabilities() {
    return {
        worker: typeof Worker === 'function',
        moduleWorker: detectModuleWorkerSupport(),
        wasm: typeof WebAssembly === 'object',
        wasmSimd: detectWasmSimdSupport(),
        offscreenCanvas2d: typeof OffscreenCanvas === 'function',
        offscreenCanvasWebgl2: detectOffscreenCanvasWebgl2(),
        compressionStreams: typeof CompressionStream === 'function' && typeof DecompressionStream === 'function',
        fileSystemAccess: typeof window?.showOpenFilePicker === 'function' || typeof window?.showDirectoryPicker === 'function',
        createImageBitmap: typeof createImageBitmap === 'function'
    };
}
