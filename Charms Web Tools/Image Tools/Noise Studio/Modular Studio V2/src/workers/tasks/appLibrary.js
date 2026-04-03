import {
    buildSecureLibraryExportRecord,
    createSecureLibraryCompatibilityError,
    prepareSecureLibraryExportBundle,
    resolveSecureLibraryImportRecord,
    SECURE_LIBRARY_FAST_PATH_JSON_THRESHOLD
} from '../../library/secureTransfer.js';
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

function normalizeCompatibilityMode(value) {
    return String(value || '').toLowerCase() === 'js' ? 'js' : 'fast';
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

function logExportStage(context, stage, meta = {}) {
    if (stage === 'bundle-normalized') {
        context.log('info', `Library export bundle normalized (${meta.projectCount || 0} projects, ${meta.assetCount || 0} assets).`);
        return;
    }
    if (stage === 'bundle-json-estimate') {
        context.log('info', `Estimated secure Library export JSON size: ${Math.round((meta.estimatedJsonBytes || 0) / 1024)} KB.`);
        return;
    }
    if (stage === 'compressed') {
        context.log('info', `Compressed Library export payload to ${Math.round((meta.compressedBytes || 0) / 1024)} KB.`);
        return;
    }
    if (stage === 'base64-started') {
        context.log('active', 'Encoding the secure Library payload as base64.');
        return;
    }
    if (stage === 'base64-completed') {
        context.log('info', `Finished base64 packaging (${Math.round((meta.base64Length || 0) / 1024)} KB of JSON text).`);
        return;
    }
    if (stage === 'encrypted-started') {
        context.log('active', `Encrypting secure Library copy ${meta.copyIndex || 1} of ${meta.copyCount || 1}.`);
        return;
    }
    if (stage === 'encrypted-completed') {
        context.log('info', `Encrypted secure Library copy ${meta.copyIndex || 1} of ${meta.copyCount || 1} (${Math.round((meta.encryptedBytes || 0) / 1024)} KB).`);
    }
}

function logImportStage(context, stage, meta = {}) {
    if (stage === 'base64-started') {
        context.log('active', 'Decoding the secure Library payload from base64.');
        return;
    }
    if (stage === 'base64-completed') {
        context.log('info', `Decoded ${Math.round((meta.decodedBytes || 0) / 1024)} KB of secure Library payload data.`);
        return;
    }
    if (stage === 'decompressed') {
        context.log('info', `Recovered ${Math.round((meta.recoveredJsonBytes || 0) / 1024)} KB of Library JSON after decompression.`);
        return;
    }
    if (stage === 'copy-decrypt-started') {
        context.log('active', `Decrypting secure Library copy ${meta.copyIndex || 1} of ${meta.copyCount || 1}.`);
        return;
    }
    if (stage === 'copy-decrypt-completed') {
        context.log('info', `Recovered secure Library copy ${meta.copyIndex || 1} of ${meta.copyCount || 1}.`);
    }
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
        const compatibilityMode = normalizeCompatibilityMode(payload.compatibilityMode);
        const preparedBundle = prepareSecureLibraryExportBundle(payload.bundle);
        if (compatibilityMode !== 'js' && preparedBundle.estimatedJsonBytes > SECURE_LIBRARY_FAST_PATH_JSON_THRESHOLD) {
            throw createSecureLibraryCompatibilityError(
                'This secure Library export is large enough that the compatibility packaging path is safer.',
                {
                    stage: 'bundle-json-estimate',
                    fallbackReason: `Estimated secure export JSON size is ${Math.round(preparedBundle.estimatedJsonBytes / (1024 * 1024))} MB.`,
                    compatibilityMode: 'js',
                    meta: {
                        estimatedJsonBytes: preparedBundle.estimatedJsonBytes
                    }
                }
            );
        }

        let runtime = {
            ok: false,
            selection: 'js-fallback',
            initMs: 0,
            reason: 'Compatibility mode requested.'
        };
        let codec = null;
        if (compatibilityMode !== 'js') {
            runtime = await getRuntime(context);
            if (!runtime?.ok) {
                throw createSecureLibraryCompatibilityError(
                    'The Library WASM export path is unavailable for this session.',
                    {
                        stage: 'runtime-init',
                        fallbackReason: runtime?.reason || 'Library WASM could not be initialized.',
                        compatibilityMode: 'js',
                        runtime
                    }
                );
            }
            codec = createLibraryCodec(runtime);
        } else {
            context.log('warning', 'Using the Library export compatibility path (JS/native codecs).');
        }

        let record;
        try {
            record = await buildSecureLibraryExportRecord(payload.bundle, {
                secureMode: payload.secureMode,
                passphrase: payload.passphrase || '',
                duplicateCopies: false,
                codec,
                preparedBundle,
                onStage(stage, meta) {
                    logExportStage(context, stage, meta);
                }
            });
        } catch (error) {
            if (compatibilityMode !== 'js' && !error?.fallbackEligible) {
                throw createSecureLibraryCompatibilityError(
                    'The fast secure Library export path could not finish packaging this file.',
                    {
                        stage: 'packaging',
                        fallbackReason: error?.message || 'Unknown secure export error.',
                        compatibilityMode: 'js',
                        runtime
                    }
                );
            }
            throw error;
        }
        const taskMs = Math.max(0, now() - startedAt);
        context.log('info', `Built the secure Library export payload in ${Math.round(taskMs)}ms via ${runtime.ok ? runtime.selection : 'js-fallback'}.`);
        return {
            ...record,
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
        const compatibilityMode = normalizeCompatibilityMode(payload.compatibilityMode);
        let runtime = {
            ok: false,
            selection: 'js-fallback',
            initMs: 0,
            reason: 'Compatibility mode requested.'
        };
        let codec = null;
        if (compatibilityMode !== 'js') {
            runtime = await getRuntime(context);
            if (!runtime?.ok) {
                throw createSecureLibraryCompatibilityError(
                    'The Library WASM import path is unavailable for this session.',
                    {
                        stage: 'runtime-init',
                        fallbackReason: runtime?.reason || 'Library WASM could not be initialized.',
                        compatibilityMode: 'js',
                        runtime
                    }
                );
            }
            codec = createLibraryCodec(runtime);
        } else {
            context.log('warning', 'Using the Library import compatibility path (JS/native codecs).');
        }

        let resolved;
        try {
            resolved = await resolveSecureLibraryImportRecord(payload.parsed, payload.passphrase || '', {
                codec,
                onStage(stage, meta) {
                    logImportStage(context, stage, meta);
                }
            });
        } catch (error) {
            if (compatibilityMode !== 'js' && !error?.fallbackEligible) {
                throw createSecureLibraryCompatibilityError(
                    'The fast secure Library import path could not finish decoding this file.',
                    {
                        stage: 'decode',
                        fallbackReason: error?.message || 'Unknown secure import error.',
                        compatibilityMode: 'js',
                        runtime
                    }
                );
            }
            throw error;
        }
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
