import { getRegistryUrls, loadRegistryFromUrls } from '../../registry/shared.js';
import { bytesToHex, dataUrlToBlob, sampleHashString } from '../../utils/dataUrl.js';
import { createImagePreviewData, readImageMetadata } from '../../utils/workerImage.js';

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
    }
};
