import { updateHistogram, updateVectorscope, updateParade } from '../analysis/scopes.js';
import { extractPaletteFromPixels } from './palette.js';

function requireCanvasFactory() {
    if (typeof OffscreenCanvas === 'function') {
        return (width, height) => new OffscreenCanvas(width, height);
    }
    if (typeof document !== 'undefined' && document?.createElement) {
        return (width, height) => {
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            return canvas;
        };
    }
    throw new Error('No canvas implementation is available for background Editor rendering.');
}

function readCanvasBuffer(canvas) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
        throw new Error('Could not read the canvas buffer.');
    }
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return new Uint8ClampedArray(imageData.data);
}

function createCanvas(width, height) {
    const factory = requireCanvasFactory();
    return factory(Math.max(1, width), Math.max(1, height));
}

function normalizePixels(pixels) {
    return pixels instanceof Uint8Array
        ? pixels
        : new Uint8Array(pixels || []);
}

export function computeAnalysisVisualsJs(payload = {}) {
    const pixels = normalizePixels(payload.pixels);
    const width = Math.max(1, Number(payload.width) || 1);
    const height = Math.max(1, Number(payload.height) || 1);
    const histogramCanvas = createCanvas(payload.histogramWidth || 512, payload.histogramHeight || 220);
    const vectorscopeCanvas = createCanvas(payload.vectorscopeWidth || 360, payload.vectorscopeHeight || 360);
    const paradeCanvas = createCanvas(payload.paradeWidth || 620, payload.paradeHeight || 220);
    const histogramAverage = { textContent: '' };
    const renderResolution = { textContent: '' };
    const saturationAverage = { textContent: '' };

    updateHistogram(
        histogramCanvas,
        histogramAverage,
        renderResolution,
        pixels,
        width,
        height,
        Math.max(1, Number(payload.renderWidth) || width),
        Math.max(1, Number(payload.renderHeight) || height)
    );
    updateVectorscope(vectorscopeCanvas, saturationAverage, pixels, width, height);
    updateParade(paradeCanvas, pixels, width, height);

    return {
        histogram: {
            width: histogramCanvas.width,
            height: histogramCanvas.height,
            rgba: readCanvasBuffer(histogramCanvas)
        },
        vectorscope: {
            width: vectorscopeCanvas.width,
            height: vectorscopeCanvas.height,
            rgba: readCanvasBuffer(vectorscopeCanvas)
        },
        parade: {
            width: paradeCanvas.width,
            height: paradeCanvas.height,
            rgba: readCanvasBuffer(paradeCanvas)
        },
        metrics: {
            averageBrightness: Number.parseInt(histogramAverage.textContent || '0', 10) || 0,
            averageSaturation: Number.parseInt(String(saturationAverage.textContent || '0').replace(/%/g, ''), 10) || 0,
            renderWidth: Math.max(1, Number(payload.renderWidth) || width),
            renderHeight: Math.max(1, Number(payload.renderHeight) || height)
        }
    };
}

export function computeDiffPreviewJs(payload = {}) {
    const basePixels = payload.basePixels instanceof Uint8ClampedArray
        ? payload.basePixels
        : new Uint8ClampedArray(payload.basePixels || []);
    const processedPixels = payload.processedPixels instanceof Uint8ClampedArray
        ? payload.processedPixels
        : new Uint8ClampedArray(payload.processedPixels || []);
    const total = Math.min(basePixels.length, processedPixels.length);
    const output = new Uint8ClampedArray(total);

    for (let offset = 0; offset < total; offset += 4) {
        const baseR = basePixels[offset];
        const baseG = basePixels[offset + 1];
        const baseB = basePixels[offset + 2];
        const nextR = processedPixels[offset];
        const nextG = processedPixels[offset + 1];
        const nextB = processedPixels[offset + 2];
        const baseLuma = (baseR * 0.2126) + (baseG * 0.7152) + (baseB * 0.0722);
        const nextLuma = (nextR * 0.2126) + (nextG * 0.7152) + (nextB * 0.0722);
        const diffMagnitude = Math.sqrt(
            ((nextR - baseR) * (nextR - baseR))
            + ((nextG - baseG) * (nextG - baseG))
            + ((nextB - baseB) * (nextB - baseB))
        ) / 441.67295593;
        const overlayStrength = Math.min(1, diffMagnitude * 3);
        const tint = nextLuma >= baseLuma
            ? [46, 214, 255]
            : [255, 138, 64];
        const grayscale = Math.max(0, Math.min(255, Math.round((baseLuma * 0.88) + 12)));
        output[offset] = Math.round(grayscale + ((tint[0] - grayscale) * overlayStrength));
        output[offset + 1] = Math.round(grayscale + ((tint[1] - grayscale) * overlayStrength));
        output[offset + 2] = Math.round(grayscale + ((tint[2] - grayscale) * overlayStrength));
        output[offset + 3] = 255;
    }

    return {
        width: Math.max(1, Number(payload.width) || 1),
        height: Math.max(1, Number(payload.height) || 1),
        rgba: output
    };
}

export async function extractPaletteFromFileJs(file, count, options = {}) {
    if (!(file instanceof Blob)) {
        throw new Error('A file or blob is required for palette extraction.');
    }
    if (typeof createImageBitmap !== 'function') {
        throw new Error('createImageBitmap is not available for palette extraction.');
    }
    const bitmap = await createImageBitmap(file);
    try {
        const width = Math.max(1, Number(bitmap.width) || 1);
        const height = Math.max(1, Number(bitmap.height) || 1);
        const longestEdge = Math.max(width, height);
        const sampleScale = Math.min(1, 320 / longestEdge);
        const targetWidth = Math.max(1, Math.round(width * sampleScale));
        const targetHeight = Math.max(1, Math.round(height * sampleScale));
        const canvas = createCanvas(targetWidth, targetHeight);
        const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
        if (!ctx) {
            throw new Error('Could not create a palette extraction canvas.');
        }
        ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
        const pixels = ctx.getImageData(0, 0, targetWidth, targetHeight).data;
        return extractPaletteFromPixels(pixels, targetWidth, targetHeight, count, options);
    } finally {
        bitmap.close?.();
    }
}
