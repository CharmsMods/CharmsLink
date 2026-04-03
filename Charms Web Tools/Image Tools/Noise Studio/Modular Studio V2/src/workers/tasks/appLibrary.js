import { buildSecureLibraryExportRecord, resolveSecureLibraryImportRecord } from '../../library/secureTransfer.js';
import { getRegistryUrls, loadRegistryFromUrls } from '../../registry/shared.js';
import { bytesToHex, dataUrlToBlob, sampleHashString } from '../../utils/dataUrl.js';
import { createImagePreviewData, readImageMetadata } from '../../utils/workerImage.js';
import { getLibraryWasmRuntime } from '../../wasm/libraryRuntime.js';

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
    if (globalThis.crypto?.subtle) {
        try {
            const blob = await dataUrlToBlob(normalizedDataUrl);
            const buffer = await blob.arrayBuffer();
            const digest = await crypto.subtle.digest('SHA-256', buffer);
            return `${normalizedType}:${normalizedFormat}:${normalizedMimeType}:${bytesToHex(new Uint8Array(digest))}`;
        } catch (_error) {
            // Fall back to a string hash when byte hashing is unavailable.
        }
    }
    return `${normalizedType}:${normalizedFormat}:${normalizedMimeType}:${sampleHashString(normalizedDataUrl)}`;
}

async function prepareImageAsset(payload = {}) {
    const fingerprint = await computeLibraryAssetFingerprint(payload);
    const dataUrl = String(payload.dataUrl || '');
    if (!dataUrl || normalizeLibraryAssetType(payload.assetType) !== 'image') {
        return {
            fingerprint,
            previewDataUrl: String(payload.previewDataUrl || ''),
            width: Math.max(0, Number(payload.width) || 0),
            height: Math.max(0, Number(payload.height) || 0)
        };
    }
    const preview = await createImagePreviewData(dataUrl, {
        maxEdge: payload.maxEdge
    });
    return {
        fingerprint,
        previewDataUrl: preview.previewDataUrl,
        width: preview.width,
        height: preview.height
    };
}

async function readImageAssetMetadata(payload = {}) {
    const dataUrl = String(payload.dataUrl || '');
    if (!dataUrl) {
        return {
            width: 0,
            height: 0
        };
    }
    return readImageMetadata(dataUrl);
}

let runtimeAnnouncement = '';

function now() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function markRuntimeAnnouncement(context, runtime) {
    const nextValue = runtime?.ok
        ? `${runtime.selection}:${Math.round(runtime.initMs || 0)}`
        : `fallback:${runtime?.reason || 'unavailable'}`;
    if (runtimeAnnouncement === nextValue) return;
    runtimeAnnouncement = nextValue;
    if (runtime?.ok) {
        context.log('info', `Library WASM runtime ready (${runtime.selection}, ${Math.round(runtime.initMs || 0)}ms init).`);
    } else {
        context.log('warning', `Library WASM unavailable, using JS fallback. ${runtime?.reason || ''}`.trim());
    }
}

function createLibraryCodec(runtime) {
    if (!runtime?.ok) return null;
    const api = runtime.api;
    const module = api.module;
    const textEncoder = new TextEncoder();
    const textDecoder = typeof TextDecoder === 'function'
        ? new TextDecoder('utf-8')
        : null;
    return {
        encodeBytesToBase64(bytes) {
            const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
            const inputPtr = api.malloc(input.length);
            try {
                api.getHeapU8().set(input, inputPtr);
                const bound = module._library_base64_encode_bound(input.length);
                const outputPtr = api.malloc(bound);
                try {
                    const written = module._library_base64_encode(inputPtr, input.length, outputPtr);
                    if (written <= 0) {
                        throw new Error('Library WASM base64 encoder returned no bytes.');
                    }
                    const view = api.getHeapU8().subarray(outputPtr, outputPtr + written);
                    if (textDecoder) {
                        return textDecoder.decode(view);
                    }
                    let text = '';
                    const chunkSize = 0x8000;
                    for (let offset = 0; offset < view.length; offset += chunkSize) {
                        text += String.fromCharCode(...view.subarray(offset, offset + chunkSize));
                    }
                    return text;
                } finally {
                    api.free(outputPtr);
                }
            } finally {
                api.free(inputPtr);
            }
        },
        decodeBase64ToBytes(base64) {
            const encoded = textEncoder.encode(String(base64 || ''));
            const inputPtr = api.malloc(encoded.length);
            const statusPtr = api.malloc(4);
            try {
                api.getHeapU8().set(encoded, inputPtr);
                const bound = module._library_base64_decode_bound(encoded.length);
                const outputPtr = api.malloc(bound);
                try {
                    const written = module._library_base64_decode(inputPtr, encoded.length, outputPtr, statusPtr);
                    const status = api.getHeap32()[statusPtr >> 2] || 0;
                    if (status !== 1 || written < 0) {
                        throw new Error('Library WASM base64 decoder rejected the payload.');
                    }
                    return api.getHeapU8().slice(outputPtr, outputPtr + written);
                } finally {
                    api.free(outputPtr);
                }
            } finally {
                api.free(statusPtr);
                api.free(inputPtr);
            }
        }
    };
}

async function getRuntime(context) {
    const runtime = await getLibraryWasmRuntime(context.capabilities || {});
    markRuntimeAnnouncement(context, runtime);
    return runtime;
}

export const appLibraryTaskHandlers = {
    async 'load-registry'(payload = {}, context) {
        context.log('info', 'Loading registry metadata in the background.');
        return loadRegistryFromUrls({
            registryUrl: payload.registryUrl || getRegistryUrls().registryUrl,
            utilityProgramsUrl: payload.utilityProgramsUrl || getRegistryUrls().utilityProgramsUrl
        });
    },
    async 'prepare-asset-record'(payload = {}, context) {
        context.assertNotCancelled();
        context.log('info', `Preparing ${normalizeLibraryAssetType(payload.assetType)} asset metadata.`);
        return prepareImageAsset(payload);
    },
    async 'fingerprint-asset'(payload = {}, context) {
        context.assertNotCancelled();
        return {
            fingerprint: await computeLibraryAssetFingerprint(payload)
        };
    },
    async 'read-image-metadata'(payload = {}, context) {
        context.assertNotCancelled();
        return readImageAssetMetadata(payload);
    },
    async 'build-secure-library-export-record'(payload = {}, context) {
        context.assertNotCancelled();
        const startedAt = now();
        const runtime = await getRuntime(context);
        const codec = createLibraryCodec(runtime);
        const record = await buildSecureLibraryExportRecord(payload.bundle, {
            secureMode: payload.secureMode,
            passphrase: payload.passphrase || '',
            duplicateCopies: !!payload.duplicateCopies,
            codec
        });
        const taskMs = Math.max(0, now() - startedAt);
        context.log('info', `Built the secure Library export payload in ${Math.round(taskMs)}ms via ${runtime.ok ? runtime.selection : 'js-fallback'}.`);
        return {
            record,
            runtime: {
                selection: runtime.ok ? runtime.selection : 'js-fallback',
                initMs: runtime.initMs || 0,
                taskMs,
                fallbackReason: runtime.ok ? '' : (runtime.reason || '')
            }
        };
    },
    async 'resolve-secure-library-import-record'(payload = {}, context) {
        context.assertNotCancelled();
        const startedAt = now();
        const runtime = await getRuntime(context);
        const codec = createLibraryCodec(runtime);
        const resolved = await resolveSecureLibraryImportRecord(payload.parsed, payload.passphrase || '', {
            codec
        });
        const taskMs = Math.max(0, now() - startedAt);
        context.log('info', `Resolved the secure Library import payload in ${Math.round(taskMs)}ms via ${runtime.ok ? runtime.selection : 'js-fallback'}.`);
        return {
            ...resolved,
            runtime: {
                selection: runtime.ok ? runtime.selection : 'js-fallback',
                initMs: runtime.initMs || 0,
                taskMs,
                fallbackReason: runtime.ok ? '' : (runtime.reason || '')
            }
        };
    }
};
