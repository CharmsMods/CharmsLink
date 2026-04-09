import {
    getActiveCompositeLayers,
    getCompositeLayerSourceImage,
    normalizeCompositeDocument
} from '../../composite/document.js';
import { blobToDataUrl, dataUrlToBlob } from '../../utils/dataUrl.js';
import { readImageMetadata } from '../../utils/workerImage.js';
import { reviveWorkerFileEntries } from '../filePayload.js';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function rotatePoint(x, y, radians = 0) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (x * cos) - (y * sin),
        y: (x * sin) + (y * cos)
    };
}

function isLikelyImageFile(file) {
    const mimeType = String(file?.type || '').toLowerCase();
    if (mimeType.startsWith('image/')) return true;
    return /\.(png|apng|jpe?g|webp|gif|bmp|tiff?|avif|ico|svg)$/i.test(String(file?.name || ''));
}

function mapCanvasBlendMode(mode) {
    if (mode === 'add') return 'lighter';
    if (mode === 'soft-light') return 'soft-light';
    if (mode === 'hard-light') return 'hard-light';
    if (mode === 'color') return 'color';
    if (mode === 'hue') return 'hue';
    if (mode === 'multiply') return 'multiply';
    if (mode === 'screen') return 'screen';
    if (mode === 'overlay') return 'overlay';
    return 'source-over';
}

function computeLayerBoundsFromAsset(layer, asset) {
    const scaleX = Number(layer?.scaleX) || Number(layer?.scale) || 1;
    const scaleY = Number(layer?.scaleY) || Number(layer?.scale) || 1;
    const scaledWidth = Math.max(1, Number(asset?.width) || 1) * scaleX;
    const scaledHeight = Math.max(1, Number(asset?.height) || 1) * scaleY;
    const centerX = Number(layer?.x || 0) + (scaledWidth * 0.5);
    const centerY = Number(layer?.y || 0) + (scaledHeight * 0.5);
    const corners = [
        rotatePoint(-scaledWidth * 0.5, -scaledHeight * 0.5, Number(layer?.rotation) || 0),
        rotatePoint(scaledWidth * 0.5, -scaledHeight * 0.5, Number(layer?.rotation) || 0),
        rotatePoint(scaledWidth * 0.5, scaledHeight * 0.5, Number(layer?.rotation) || 0),
        rotatePoint(-scaledWidth * 0.5, scaledHeight * 0.5, Number(layer?.rotation) || 0)
    ].map((point) => ({
        x: point.x + centerX,
        y: point.y + centerY
    }));
    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys),
        width: Math.max(0, Math.max(...xs) - Math.min(...xs)),
        height: Math.max(0, Math.max(...ys) - Math.min(...ys))
    };
}

function computeDocumentBoundsFromBitmaps(layers = [], bitmaps = new Map()) {
    if (!layers.length) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            width: 0,
            height: 0
        };
    }
    const boundsList = layers.map((layer) => computeLayerBoundsFromAsset(layer, bitmaps.get(layer.id)));
    const minX = Math.min(...boundsList.map((entry) => entry.minX));
    const minY = Math.min(...boundsList.map((entry) => entry.minY));
    const maxX = Math.max(...boundsList.map((entry) => entry.maxX));
    const maxY = Math.max(...boundsList.map((entry) => entry.maxY));
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}

function computeExportViewport(document, bounds) {
    const normalized = normalizeCompositeDocument(document);
    const isCustom = normalized.export.boundsMode === 'custom';
    const boundsWidth = isCustom ? Math.max(1, normalized.export.bounds.width) : Math.max(1, bounds.width || 1);
    const boundsHeight = isCustom ? Math.max(1, normalized.export.bounds.height) : Math.max(1, bounds.height || 1);
    const centerX = isCustom
        ? normalized.export.bounds.x + (boundsWidth * 0.5)
        : bounds.minX + ((bounds.width || 1) * 0.5);
    const centerY = isCustom
        ? normalized.export.bounds.y + (boundsHeight * 0.5)
        : bounds.minY + ((bounds.height || 1) * 0.5);
    const renderWidth = isCustom ? normalized.export.customResolution.width : Math.max(1, Math.ceil(bounds.width || 1));
    const renderHeight = isCustom ? normalized.export.customResolution.height : Math.max(1, Math.ceil(bounds.height || 1));
    return {
        bounds,
        outputWidth: Math.max(1, renderWidth),
        outputHeight: Math.max(1, renderHeight),
        centerWorld: {
            x: centerX,
            y: centerY
        },
        panX: 0,
        panY: 0,
        scale: renderWidth / boundsWidth
    };
}

async function loadLayerBitmaps(document, context) {
    const normalized = normalizeCompositeDocument(document);
    const layers = getActiveCompositeLayers(normalized);
    const bitmaps = new Map();
    for (let index = 0; index < layers.length; index += 1) {
        context.assertNotCancelled();
        const layer = layers[index];
        const source = getCompositeLayerSourceImage(layer);
        if (!source.imageData) continue;
        const blob = await dataUrlToBlob(source.imageData);
        const bitmap = await createImageBitmap(blob);
        bitmaps.set(layer.id, {
            bitmap,
            width: Math.max(1, Number(source.width) || Number(bitmap.width) || 1),
            height: Math.max(1, Number(source.height) || Number(bitmap.height) || 1)
        });
    }
    return {
        normalized,
        layers,
        bitmaps
    };
}

async function renderCompositeToCanvas(document, context) {
    const { normalized, layers, bitmaps } = await loadLayerBitmaps(document, context);
    const bounds = computeDocumentBoundsFromBitmaps(layers, bitmaps);
    const viewport = computeExportViewport(normalized, bounds);
    const canvas = new OffscreenCanvas(viewport.outputWidth, viewport.outputHeight);
    const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: false });
    if (!ctx) {
        throw new Error('Could not create a Composite 2D worker canvas.');
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (normalized.export.background !== 'transparent') {
        ctx.fillStyle = normalized.export.background;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    try {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.translate((canvas.width * 0.5) + viewport.panX, (canvas.height * 0.5) + viewport.panY);
        ctx.scale(viewport.scale, viewport.scale);
        ctx.translate(-viewport.centerWorld.x, -viewport.centerWorld.y);
        for (const layer of layers) {
            context.assertNotCancelled();
            const asset = bitmaps.get(layer.id);
            if (!asset?.bitmap) continue;
            ctx.save();
            const width = asset.width * (Number(layer.scaleX) || Number(layer.scale) || 1);
            const height = asset.height * (Number(layer.scaleY) || Number(layer.scale) || 1);
            ctx.translate(layer.x + (width * 0.5), layer.y + (height * 0.5));
            ctx.rotate(layer.rotation || 0);
            ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
            ctx.globalAlpha = clamp(Number(layer.opacity) || 1, 0, 1);
            ctx.globalCompositeOperation = mapCanvasBlendMode(layer.blendMode);
            ctx.drawImage(asset.bitmap, -(width * 0.5), -(height * 0.5), width, height);
            ctx.restore();
        }
        return {
            canvas,
            width: canvas.width,
            height: canvas.height
        };
    } finally {
        bitmaps.forEach((asset) => asset.bitmap?.close?.());
    }
}

export const compositeTaskHandlers = {
    async 'prepare-image-files'(payload = {}, context) {
        const sourceFiles = reviveWorkerFileEntries(payload.fileEntries, payload.files).filter((file) => isLikelyImageFile(file));
        const items = [];
        const failures = [];

        for (let index = 0; index < sourceFiles.length; index += 1) {
            context.assertNotCancelled();
            const file = sourceFiles[index];
            try {
                context.progress(
                    sourceFiles.length ? index / sourceFiles.length : 0,
                    `Reading "${file.name}" for Composite.`,
                    {
                        index,
                        total: sourceFiles.length,
                        file: { name: file.name, type: file.type }
                    }
                );
                const [imageData, metadata] = await Promise.all([
                    blobToDataUrl(file),
                    readImageMetadata(file)
                ]);
                items.push({
                    name: String(file.name || 'Image'),
                    type: String(file.type || 'image/png'),
                    imageData,
                    width: Math.max(1, Number(metadata.width) || 1),
                    height: Math.max(1, Number(metadata.height) || 1)
                });
                context.progress(
                    sourceFiles.length ? (index + 0.9) / sourceFiles.length : 0.9,
                    `Prepared "${file.name}" for Composite.`,
                    {
                        index: index + 1,
                        total: sourceFiles.length,
                        file: { name: file.name, type: file.type }
                    }
                );
            } catch (error) {
                failures.push({
                    name: String(file?.name || 'Unnamed image'),
                    reason: error?.message || 'Could not read this image.'
                });
            }
        }

        return { items, failures };
    },
    async 'render-preview'(payload = {}, context) {
        context.assertNotCancelled();
        const maxEdge = Math.max(1, Math.round(Number(payload.maxEdge) || 320));
        context.log('info', 'Rendering a Composite preview in the background worker.');
        const rendered = await renderCompositeToCanvas(payload.document, context);
        context.assertNotCancelled();
        const scale = Math.min(1, maxEdge / Math.max(rendered.width, rendered.height, 1));
        const previewWidth = Math.max(1, Math.round(rendered.width * scale));
        const previewHeight = Math.max(1, Math.round(rendered.height * scale));
        const previewCanvas = new OffscreenCanvas(previewWidth, previewHeight);
        const previewCtx = previewCanvas.getContext('2d', { alpha: true });
        if (!previewCtx) {
            throw new Error('Could not create a Composite preview canvas.');
        }
        previewCtx.imageSmoothingEnabled = true;
        previewCtx.imageSmoothingQuality = 'high';
        previewCtx.clearRect(0, 0, previewWidth, previewHeight);
        previewCtx.drawImage(rendered.canvas, 0, 0, previewWidth, previewHeight);
        const blob = await previewCanvas.convertToBlob({ type: 'image/png' });
        return {
            imageData: await blobToDataUrl(blob),
            width: previewWidth,
            height: previewHeight,
            updatedAt: Date.now()
        };
    },
    async 'render-export-png'(payload = {}, context) {
        context.assertNotCancelled();
        context.log('info', 'Rendering a Composite PNG in the background worker.');
        const rendered = await renderCompositeToCanvas(payload.document, context);
        context.assertNotCancelled();
        const blob = await rendered.canvas.convertToBlob({ type: 'image/png' });
        const buffer = await blob.arrayBuffer();
        return {
            payload: {
                buffer,
                mimeType: 'image/png',
                width: rendered.width,
                height: rendered.height
            },
            transfer: [buffer]
        };
    }
};
