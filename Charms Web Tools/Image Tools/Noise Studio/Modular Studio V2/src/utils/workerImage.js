import { blobToDataUrl, dataUrlToBlob } from './dataUrl.js';

function requireWorkerImageSupport() {
    if (typeof createImageBitmap !== 'function') {
        throw new Error('createImageBitmap is not available in this environment.');
    }
}

function requireWorkerPreviewSupport() {
    requireWorkerImageSupport();
    if (typeof OffscreenCanvas !== 'function') {
        throw new Error('OffscreenCanvas is not available in this environment.');
    }
}

async function sourceToBlob(source) {
    if (source instanceof Blob) return source;
    if (typeof source === 'string' && source.startsWith('data:')) {
        return dataUrlToBlob(source);
    }
    throw new Error('Unsupported image source.');
}

export async function readImageMetadata(source) {
    requireWorkerImageSupport();
    const blob = await sourceToBlob(source);
    const bitmap = await createImageBitmap(blob);
    try {
        return {
            width: Math.max(1, Number(bitmap.width) || 1),
            height: Math.max(1, Number(bitmap.height) || 1)
        };
    } finally {
        bitmap.close?.();
    }
}

export async function createImagePreviewData(source, options = {}) {
    requireWorkerPreviewSupport();
    const maxEdge = Math.max(1, Math.round(Number(options.maxEdge) || 192));
    const blob = await sourceToBlob(source);
    const bitmap = await createImageBitmap(blob);
    try {
        const sourceWidth = Math.max(1, Number(bitmap.width) || 1);
        const sourceHeight = Math.max(1, Number(bitmap.height) || 1);
        const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
        const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
        const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
        const canvas = new OffscreenCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d', { alpha: true });
        if (!ctx) {
            throw new Error('Could not create a 2D preview canvas.');
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        const previewBlob = await canvas.convertToBlob({ type: 'image/png' });
        return {
            width: sourceWidth,
            height: sourceHeight,
            previewWidth: targetWidth,
            previewHeight: targetHeight,
            previewDataUrl: await blobToDataUrl(previewBlob)
        };
    } finally {
        bitmap.close?.();
    }
}
