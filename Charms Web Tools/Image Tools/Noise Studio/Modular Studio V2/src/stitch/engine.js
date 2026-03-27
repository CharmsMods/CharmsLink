import {
    applyCandidateToDocument,
    computeCompositeBounds,
    computePlacementBounds,
    getActivePlacements,
    getPlacementByInput,
    getSelectedStitchInput,
    normalizeStitchDocument
} from './document.js';
import { analyzePreparedStitchInputs } from './analysis.js';

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
            else reject(new Error('Could not encode the stitch canvas.'));
        }, type);
    });
}

function viewportScale(bounds, canvasWidth, canvasHeight, zoom = 1) {
    const padding = 28;
    if (!bounds.width || !bounds.height) return 1;
    const fitScale = Math.min(
        (Math.max(1, canvasWidth) - (padding * 2)) / Math.max(1, bounds.width),
        (Math.max(1, canvasHeight) - (padding * 2)) / Math.max(1, bounds.height)
    );
    return Math.max(0.05, fitScale * (zoom || 1));
}

function rotatePoint(x, y, radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (x * cos) - (y * sin),
        y: (x * sin) + (y * cos)
    };
}

export class StitchEngine {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.imageCache = new Map();
        this.renderRequested = false;
        this.worker = null;
        this.pendingRequests = new Map();
        this.runtime = {
            renderWidth: 0,
            renderHeight: 0,
            bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
            viewport: { scale: 1, offsetX: 0, offsetY: 0, width: 1, height: 1 }
        };
    }

    attachCanvas(canvas) {
        this.canvas = canvas || null;
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
    }

    async ensureWorker() {
        if (this.worker || typeof Worker !== 'function') return this.worker;
        try {
            this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
            this.worker.addEventListener('message', (event) => {
                const { requestId, result, error } = event.data || {};
                const pending = this.pendingRequests.get(requestId);
                if (!pending) return;
                this.pendingRequests.delete(requestId);
                if (error) pending.reject(new Error(error));
                else pending.resolve(result);
            });
        } catch (_error) {
            this.worker = null;
        }
        return this.worker;
    }

    async getImage(input) {
        if (!input?.id || !input.imageData) return null;
        const cached = this.imageCache.get(input.id);
        if (cached?.src === input.imageData && cached.image) {
            return cached.image;
        }
        if (cached?.src === input.imageData && cached.promise) {
            return cached.promise;
        }
        const promise = new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                this.imageCache.set(input.id, { src: input.imageData, image });
                resolve(image);
            };
            image.onerror = () => reject(new Error(`Could not load ${input.name || 'stitch image'}.`));
            image.src = input.imageData;
        });
        this.imageCache.set(input.id, { src: input.imageData, promise });
        return promise;
    }

    async ensureImages(document) {
        const normalized = normalizeStitchDocument(document);
        const liveIds = new Set(normalized.inputs.map((input) => input.id));
        for (const key of [...this.imageCache.keys()]) {
            if (!liveIds.has(key)) this.imageCache.delete(key);
        }
        await Promise.all(normalized.inputs.map((input) => this.getImage(input)));
    }

    resizeAttachedCanvas() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    computeViewport(document, canvasWidth, canvasHeight, placements = null) {
        const normalized = normalizeStitchDocument(document);
        const bounds = computeCompositeBounds(normalized, placements);
        const scale = viewportScale(bounds, canvasWidth, canvasHeight, normalized.view.zoom);
        const offsetX = ((canvasWidth - (bounds.width * scale)) * 0.5) - (bounds.minX * scale) + (normalized.view.panX || 0);
        const offsetY = ((canvasHeight - (bounds.height * scale)) * 0.5) - (bounds.minY * scale) + (normalized.view.panY || 0);
        return {
            bounds,
            scale,
            offsetX,
            offsetY,
            width: canvasWidth,
            height: canvasHeight
        };
    }

    drawDocumentToContext(ctx, document, options = {}) {
        const normalized = normalizeStitchDocument(document);
        const placements = options.placements || getActivePlacements(normalized);
        const viewport = options.viewport || this.computeViewport(normalized, ctx.canvas.width, ctx.canvas.height, placements);
        const background = options.background || (normalized.view.theme === 'dark' ? '#08090d' : '#f4f5f7');
        ctx.save();
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.imageSmoothingEnabled = true;

        placements
            .filter((placement) => placement.visible !== false)
            .sort((a, b) => (a.z || 0) - (b.z || 0))
            .forEach((placement) => {
                const input = normalized.inputs.find((item) => item.id === placement.inputId);
                const cached = this.imageCache.get(input?.id);
                const image = cached?.image;
                if (!input || !image) return;
                ctx.save();
                ctx.translate(viewport.offsetX + ((placement.x || 0) * viewport.scale), viewport.offsetY + ((placement.y || 0) * viewport.scale));
                ctx.rotate(placement.rotation || 0);
                ctx.scale((placement.scale || 1) * viewport.scale, (placement.scale || 1) * viewport.scale);
                ctx.globalAlpha = clamp(Number(placement.opacity) || 1, 0, 1);
                ctx.drawImage(image, 0, 0, input.width, input.height);

                if (normalized.view.showBounds || normalized.selection.inputId === input.id) {
                    ctx.lineWidth = Math.max(1 / Math.max(0.1, placement.scale * viewport.scale), 1.5 / Math.max(0.1, viewport.scale));
                    ctx.strokeStyle = normalized.selection.inputId === input.id ? '#00d0ff' : 'rgba(255,255,255,0.65)';
                    ctx.strokeRect(0, 0, input.width, input.height);
                }
                ctx.restore();

                if (normalized.view.showLabels) {
                    const box = computePlacementBounds(input, placement);
                    const labelX = viewport.offsetX + (box.minX * viewport.scale);
                    const labelY = viewport.offsetY + (box.minY * viewport.scale) - 8;
                    ctx.fillStyle = normalized.selection.inputId === input.id ? 'rgba(0, 26, 41, 0.86)' : 'rgba(10, 10, 14, 0.72)';
                    const label = input.name;
                    ctx.font = `${Math.max(12, 12 * (window.devicePixelRatio || 1))}px "Segoe UI", sans-serif`;
                    const width = ctx.measureText(label).width + 14;
                    ctx.fillRect(labelX, labelY - 18, width, 18);
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(label, labelX + 7, labelY - 5);
                }
            });

        ctx.restore();
        return viewport;
    }

    async render(document) {
        if (!this.canvas || !this.ctx) return;
        const normalized = normalizeStitchDocument(document);
        await this.ensureImages(normalized);
        this.resizeAttachedCanvas();
        const viewport = this.drawDocumentToContext(this.ctx, normalized);
        this.runtime.renderWidth = Math.max(0, Math.round(viewport.bounds.width));
        this.runtime.renderHeight = Math.max(0, Math.round(viewport.bounds.height));
        this.runtime.bounds = viewport.bounds;
        this.runtime.viewport = viewport;
    }

    requestRender(document) {
        if (this.renderRequested) return;
        this.renderRequested = true;
        requestAnimationFrame(() => {
            this.renderRequested = false;
            this.render(document).catch(() => {});
        });
    }

    async buildPreparedInputs(document) {
        const normalized = normalizeStitchDocument(document);
        await this.ensureImages(normalized);
        const maxDimension = normalized.settings.analysisMaxDimension || 320;
        const useFullResolution = !!normalized.settings.useFullResolutionAnalysis;
        return Promise.all(normalized.inputs.map(async (input) => {
            const image = await this.getImage(input);
            const scale = useFullResolution
                ? 1
                : Math.min(1, maxDimension / Math.max(image.naturalWidth || input.width || 1, image.naturalHeight || input.height || 1));
            const width = Math.max(32, Math.round((image.naturalWidth || input.width || 1) * scale));
            const height = Math.max(32, Math.round((image.naturalHeight || input.height || 1) * scale));
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0, width, height);
            const rgba = ctx.getImageData(0, 0, width, height).data;
            const gray = new Uint8ClampedArray(width * height);
            for (let index = 0; index < gray.length; index += 1) {
                const rgbaIndex = index * 4;
                gray[index] = Math.round((rgba[rgbaIndex] * 0.299) + (rgba[rgbaIndex + 1] * 0.587) + (rgba[rgbaIndex + 2] * 0.114));
            }
            return {
                id: input.id,
                name: input.name,
                width,
                height,
                originalWidth: input.width,
                originalHeight: input.height,
                gray
            };
        }));
    }

    async analyze(document) {
        const normalized = normalizeStitchDocument(document);
        const preparedInputs = await this.buildPreparedInputs(normalized);
        const worker = await this.ensureWorker();
        if (worker) {
            return new Promise((resolve, reject) => {
                const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
                this.pendingRequests.set(requestId, { resolve, reject });
                worker.postMessage({ requestId, document: normalized, preparedInputs });
            });
        }
        return analyzePreparedStitchInputs(normalized, preparedInputs);
    }

    async exportPngBlob(document, options = {}) {
        const normalized = normalizeStitchDocument(document);
        await this.ensureImages(normalized);
        const placements = options.placements || getActivePlacements(normalized);
        const bounds = computeCompositeBounds(normalized, placements);
        const padding = clamp(Math.round(Number(options.padding ?? normalized.export.padding ?? 32)), 0, 512);
        const width = Math.max(1, Math.round(bounds.width + (padding * 2)));
        const height = Math.max(1, Math.round(bounds.height + (padding * 2)));
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = options.background || normalized.export.background || '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;

        placements
            .filter((placement) => placement.visible !== false)
            .sort((a, b) => (a.z || 0) - (b.z || 0))
            .forEach((placement) => {
                const input = normalized.inputs.find((item) => item.id === placement.inputId);
                const image = this.imageCache.get(input?.id)?.image;
                if (!input || !image) return;
                ctx.save();
                ctx.translate(padding + (placement.x - bounds.minX), padding + (placement.y - bounds.minY));
                ctx.rotate(placement.rotation || 0);
                ctx.scale(placement.scale || 1, placement.scale || 1);
                ctx.globalAlpha = clamp(Number(placement.opacity) || 1, 0, 1);
                ctx.drawImage(image, 0, 0, input.width, input.height);
                ctx.restore();
            });

        return canvasToBlob(canvas, 'image/png');
    }

    async buildCandidatePreview(document, candidate, maxSide = 280) {
        if (!candidate) return '';
        const normalized = applyCandidateToDocument(document, candidate.id);
        await this.ensureImages(normalized);
        const placements = candidate.placements || getActivePlacements(normalized);
        const bounds = computeCompositeBounds(normalized, placements);
        const scale = bounds.width || bounds.height
            ? Math.min(maxSide / Math.max(1, bounds.width), maxSide / Math.max(1, bounds.height))
            : 1;
        const width = Math.max(120, Math.round(bounds.width * scale) + 28);
        const height = Math.max(120, Math.round(bounds.height * scale) + 28);
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = normalized.view.theme === 'dark' ? '#0b0c10' : '#f7f8fa';
        ctx.fillRect(0, 0, width, height);
        const viewport = {
            bounds,
            scale,
            offsetX: 14 - (bounds.minX * scale),
            offsetY: 14 - (bounds.minY * scale),
            width,
            height
        };
        this.drawDocumentToContext(ctx, normalized, {
            placements,
            viewport,
            background: normalized.view.theme === 'dark' ? '#0b0c10' : '#f7f8fa'
        });
        if (typeof canvas.convertToBlob === 'function') {
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            return URL.createObjectURL(blob);
        }
        return canvas.toDataURL('image/png');
    }

    async buildCandidatePreviewMap(document) {
        const normalized = normalizeStitchDocument(document);
        const previews = {};
        for (const candidate of normalized.candidates) {
            previews[candidate.id] = await this.buildCandidatePreview(normalized, candidate);
        }
        return previews;
    }

    screenToWorld(x, y) {
        const viewport = this.runtime.viewport;
        return {
            x: (x - viewport.offsetX) / Math.max(0.0001, viewport.scale),
            y: (y - viewport.offsetY) / Math.max(0.0001, viewport.scale)
        };
    }

    hitTest(document, canvasX, canvasY) {
        const normalized = normalizeStitchDocument(document);
        const world = this.screenToWorld(canvasX, canvasY);
        const placements = [...getActivePlacements(normalized)].sort((a, b) => (b.z || 0) - (a.z || 0));
        for (const placement of placements) {
            if (placement.visible === false) continue;
            const input = normalized.inputs.find((item) => item.id === placement.inputId);
            if (!input) continue;
            const translatedX = world.x - (placement.x || 0);
            const translatedY = world.y - (placement.y || 0);
            const unrotated = rotatePoint(translatedX, translatedY, -(placement.rotation || 0));
            const localX = unrotated.x / Math.max(0.01, placement.scale || 1);
            const localY = unrotated.y / Math.max(0.01, placement.scale || 1);
            if (localX >= 0 && localX <= input.width && localY >= 0 && localY <= input.height) {
                return {
                    inputId: input.id,
                    localX,
                    localY,
                    worldX: world.x,
                    worldY: world.y,
                    placement
                };
            }
        }
        return null;
    }

    getRuntimeMetrics(document) {
        const normalized = normalizeStitchDocument(document);
        const bounds = computeCompositeBounds(normalized);
        return {
            renderWidth: Math.max(0, Math.round(bounds.width)),
            renderHeight: Math.max(0, Math.round(bounds.height)),
            bounds
        };
    }
}
