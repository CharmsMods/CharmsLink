import {
    COMPOSITE_MAX_ZOOM,
    COMPOSITE_MIN_ZOOM,
    computeCompositeDocumentBounds,
    getActiveCompositeLayers,
    getCompositeLayerSourceImage,
    normalizeCompositeDocument
} from './document.js';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function canvasToBlob(canvas, type = 'image/png') {
    if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type });
    }
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Could not encode the composite canvas.'));
        }, type);
    });
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = reject;
        image.src = String(dataUrl || '');
    });
}

export class CompositeEngine {
    constructor(options = {}) {
        this.options = options;
        this.layerAssets = new Map();
    }

    async ensureLayerAsset(layer) {
        let sourceKey = `layer|${layer.id}`;
        if (layer.kind === 'editor-project') {
            sourceKey = `editor|${layer.id}|${layer.embeddedEditorDocument?.preview?.updatedAt || layer.embeddedEditorDocument?.timestamp || 0}`;
        } else if (layer.kind === 'text') {
            sourceKey = `text|${layer.id}|${layer.textAsset?.text || ''}|${layer.textAsset?.fontFamily || ''}|${layer.textAsset?.fontSize || 0}|${layer.textAsset?.color || ''}`;
        } else if (layer.kind === 'square') {
            sourceKey = `square|${layer.id}|${layer.squareAsset?.color || ''}`;
        } else if (layer.kind === 'circle') {
            sourceKey = `circle|${layer.id}|${layer.circleAsset?.color || ''}`;
        } else if (layer.kind === 'triangle') {
            sourceKey = `triangle|${layer.id}|${layer.triangleAsset?.color || ''}`;
        } else if (layer.imageAsset) {
            sourceKey = `image|${layer.id}|${String(layer.imageAsset?.imageData || '').length}`;
        }
        
        const existing = this.layerAssets.get(layer.id);
        if (existing && existing.sourceKey === sourceKey) {
            return existing;
        }

        const source = getCompositeLayerSourceImage(layer);
        if (!source.imageData) {
            this.layerAssets.delete(layer.id);
            return null;
        }
        const image = await loadImageFromDataUrl(source.imageData);
        const next = {
            sourceKey,
            width: image.width,
            height: image.height,
            image
        };
        this.layerAssets.set(layer.id, next);
        return next;
    }

    async syncDocument(document) {
        const normalized = normalizeCompositeDocument(document);
        const liveLayerIds = new Set(normalized.layers.map((layer) => layer.id));
        for (const [layerId] of this.layerAssets.entries()) {
            if (!liveLayerIds.has(layerId)) {
                this.layerAssets.delete(layerId);
            }
        }
        await Promise.all(normalized.layers.map((layer) => this.ensureLayerAsset(layer).catch(() => null)));
    }

    computeViewport(document, outputWidth, outputHeight, mode = 'screen') {
        const normalized = normalizeCompositeDocument(document);
        const bounds = computeCompositeDocumentBounds(normalized);
        const safeWidth = Math.max(1, outputWidth || 1);
        const safeHeight = Math.max(1, outputHeight || 1);
        if (mode === 'export') {
            const isCustom = normalized.export.boundsMode === 'custom';
            const boundsWidth = isCustom ? Math.max(1, normalized.export.bounds.width) : Math.max(1, bounds.width || 1);
            const boundsHeight = isCustom ? Math.max(1, normalized.export.bounds.height) : Math.max(1, bounds.height || 1);
            const centerX = isCustom ? normalized.export.bounds.x + (boundsWidth * 0.5) : bounds.minX + ((bounds.width || 1) * 0.5);
            const centerY = isCustom ? normalized.export.bounds.y + (boundsHeight * 0.5) : bounds.minY + ((bounds.height || 1) * 0.5);
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
        return {
            bounds,
            outputWidth: safeWidth,
            outputHeight: safeHeight,
            centerWorld: {
                x: 0,
                y: 0
            },
            panX: Number(normalized.view.panX) || 0,
            panY: Number(normalized.view.panY) || 0,
            scale: clamp(Number(normalized.view.zoom) || 1, COMPOSITE_MIN_ZOOM, COMPOSITE_MAX_ZOOM)
        };
    }

    screenToWorld(document, containerWidth, containerHeight, clientX, clientY, containerLeft, containerTop) {
        const normalized = normalizeCompositeDocument(document);
        const screenX = clientX - containerLeft;
        const screenY = clientY - containerTop;
        const viewport = this.computeViewport(normalized, containerWidth || 1, containerHeight || 1, 'screen');
        return {
            x: ((screenX - ((containerWidth || 1) * 0.5) - viewport.panX) / Math.max(viewport.scale, 0.0001)) + viewport.centerWorld.x,
            y: ((screenY - ((containerHeight || 1) * 0.5) - viewport.panY) / Math.max(viewport.scale, 0.0001)) + viewport.centerWorld.y
        };
    }

    worldToScreen(document, containerWidth, containerHeight, worldX, worldY) {
        const normalized = normalizeCompositeDocument(document);
        const viewport = this.computeViewport(normalized, containerWidth || 1, containerHeight || 1, 'screen');
        const screenX = ((worldX - viewport.centerWorld.x) * viewport.scale) + ((containerWidth || 1) * 0.5) + viewport.panX;
        const screenY = ((worldY - viewport.centerWorld.y) * viewport.scale) + ((containerHeight || 1) * 0.5) + viewport.panY;
        return { x: screenX, y: screenY };
    }

    async drawDocumentToCanvas(document, canvas, mode = 'export') {
        const normalized = normalizeCompositeDocument(document);
        await this.syncDocument(normalized);
        const viewport = this.computeViewport(normalized, mode === 'export' ? 1 : canvas.width, mode === 'export' ? 1 : canvas.height, mode);
        const targetCanvas = canvas;
        targetCanvas.width = viewport.outputWidth;
        targetCanvas.height = viewport.outputHeight;
        const ctx = targetCanvas.getContext('2d', { alpha: true, willReadFrequently: false });
        ctx.clearRect(0, 0, targetCanvas.width, targetCanvas.height);
        if (normalized.export.background !== 'transparent') {
            ctx.fillStyle = normalized.export.background;
            ctx.fillRect(0, 0, targetCanvas.width, targetCanvas.height);
        }
        const layers = getActiveCompositeLayers(normalized);
        for (const layer of layers) {
            const asset = this.layerAssets.get(layer.id);
            if (!asset?.image) continue;
            ctx.save();
            ctx.translate((targetCanvas.width * 0.5) + viewport.panX, (targetCanvas.height * 0.5) + viewport.panY);
            ctx.scale(viewport.scale, viewport.scale);
            ctx.translate(-viewport.centerWorld.x, -viewport.centerWorld.y);
            const width = asset.width * (Number(layer.scaleX) || Number(layer.scale) || 1);
            const height = asset.height * (Number(layer.scaleY) || Number(layer.scale) || 1);
            ctx.translate(layer.x + (width * 0.5), layer.y + (height * 0.5));
            ctx.rotate(layer.rotation || 0);
            ctx.scale(layer.flipX ? -1 : 1, layer.flipY ? -1 : 1);
            ctx.globalAlpha = clamp(Number(layer.opacity) || 1, 0, 1);
            ctx.globalCompositeOperation = layer.blendMode === 'add' ? 'lighter'
                : layer.blendMode === 'soft-light' ? 'soft-light'
                : layer.blendMode === 'hard-light' ? 'hard-light'
                : layer.blendMode === 'color' ? 'color'
                : layer.blendMode === 'hue' ? 'hue'
                : layer.blendMode === 'multiply' ? 'multiply'
                : layer.blendMode === 'screen' ? 'screen'
                : layer.blendMode === 'overlay' ? 'overlay'
                : 'source-over';
            ctx.drawImage(asset.image, -(width * 0.5), -(height * 0.5), width, height);
            ctx.restore();
        }
        return {
            width: targetCanvas.width,
            height: targetCanvas.height
        };
    }

    async exportPngBlob(document) {
        const normalized = normalizeCompositeDocument(document);
        const isCustom = normalized.export.boundsMode === 'custom';
        const boundsWidth = isCustom ? normalized.export.bounds.width : Math.max(1, Math.ceil(computeCompositeDocumentBounds(document).width || 1));
        const boundsHeight = isCustom ? normalized.export.bounds.height : Math.max(1, Math.ceil(computeCompositeDocumentBounds(document).height || 1));
        const outputWidth = isCustom ? normalized.export.customResolution.width : boundsWidth;
        const outputHeight = isCustom ? normalized.export.customResolution.height : boundsHeight;

        const canvas = createCanvas(
            Math.max(1, outputWidth),
            Math.max(1, outputHeight)
        );
        await this.drawDocumentToCanvas(document, canvas, 'export');
        return canvasToBlob(canvas, 'image/png');
    }

    async capturePreview(document, maxEdge = 320) {
        const normalized = normalizeCompositeDocument(document);
        const isCustom = normalized.export.boundsMode === 'custom';
        const boundsWidth = isCustom ? normalized.export.bounds.width : Math.max(1, Math.ceil(computeCompositeDocumentBounds(document).width || 1));
        const boundsHeight = isCustom ? normalized.export.bounds.height : Math.max(1, Math.ceil(computeCompositeDocumentBounds(document).height || 1));
        const outputWidth = isCustom ? normalized.export.customResolution.width : boundsWidth;
        const outputHeight = isCustom ? normalized.export.customResolution.height : boundsHeight;
        
        const exportCanvas = createCanvas(
            Math.max(1, outputWidth),
            Math.max(1, outputHeight)
        );
        await this.drawDocumentToCanvas(document, exportCanvas, 'export');
        const width = exportCanvas.width || 1;
        const height = exportCanvas.height || 1;
        const scale = Math.min(1, maxEdge / Math.max(width, height, 1));
        const previewCanvas = createCanvas(
            Math.max(1, Math.round(width * scale)),
            Math.max(1, Math.round(height * scale))
        );
        const previewCtx = previewCanvas.getContext('2d');
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.drawImage(exportCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
        const blob = await canvasToBlob(previewCanvas, 'image/png');
        const reader = new FileReader();
        const imageData = await new Promise((resolve, reject) => {
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        return {
            imageData,
            width: previewCanvas.width,
            height: previewCanvas.height,
            updatedAt: Date.now()
        };
    }
}
