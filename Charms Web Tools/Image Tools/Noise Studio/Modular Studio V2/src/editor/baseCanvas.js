import { createEmptyDngSourceState, DNG_SOURCE_KIND, isDngSource, normalizeDngSourceState } from './dngDevelopShared.js';

const DEFAULT_EDITOR_BASE_WIDTH = 1024;
const DEFAULT_EDITOR_BASE_HEIGHT = 1024;
const MAX_EDITOR_BASE_DIMENSION = 32768;

export const EDITOR_BASE_RESOLUTION_PRESETS = [
    { id: 'sq-512', label: '512', width: 512, height: 512 },
    { id: 'sq-1024', label: '1024', width: 1024, height: 1024 },
    { id: 'hd', label: 'HD', width: 1280, height: 720 },
    { id: 'fhd', label: '1080p', width: 1920, height: 1080 },
    { id: '4k', label: '4K', width: 3840, height: 2160 },
    { id: 'ig', label: '1080 Square', width: 1080, height: 1080 }
];

export const EDITOR_BASE_ASPECT_PRESETS = [
    { id: '1:1', label: '1:1', width: 1, height: 1 },
    { id: '4:3', label: '4:3', width: 4, height: 3 },
    { id: '3:2', label: '3:2', width: 3, height: 2 },
    { id: '16:9', label: '16:9', width: 16, height: 9 },
    { id: '9:16', label: '9:16', width: 9, height: 16 }
];

function clampDimension(value, fallback) {
    const numeric = Math.round(Number(value) || 0);
    if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
    return Math.min(MAX_EDITOR_BASE_DIMENSION, Math.max(1, numeric));
}

function normalizeHexColor(color, fallback = '#000000') {
    const value = String(color || fallback).trim();
    return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
}

export function normalizeEditorSource(source = null) {
    if (!source || typeof source !== 'object') {
        return {
            kind: 'raster',
            name: '',
            type: '',
            imageData: null,
            rawData: null,
            rawMimeType: '',
            rawByteLength: 0,
            dng: createEmptyDngSourceState(),
            width: 0,
            height: 0
        };
    }
    const kind = isDngSource(source) ? DNG_SOURCE_KIND : 'raster';
    return {
        kind,
        name: String(source.name || ''),
        type: String(source.type || ''),
        imageData: source.imageData ? String(source.imageData) : null,
        rawData: kind === DNG_SOURCE_KIND && source.rawData ? String(source.rawData) : null,
        rawMimeType: kind === DNG_SOURCE_KIND ? String(source.rawMimeType || source.type || 'image/x-adobe-dng') : '',
        rawByteLength: kind === DNG_SOURCE_KIND ? Math.max(0, Math.round(Number(source.rawByteLength) || 0)) : 0,
        dng: kind === DNG_SOURCE_KIND ? normalizeDngSourceState(source.dng) : createEmptyDngSourceState(),
        width: Math.max(0, Math.round(Number(source.width) || 0)),
        height: Math.max(0, Math.round(Number(source.height) || 0))
    };
}

export function createDefaultEditorBase() {
    return {
        width: DEFAULT_EDITOR_BASE_WIDTH,
        height: DEFAULT_EDITOR_BASE_HEIGHT,
        backgroundMode: 'transparent',
        backgroundColor: '#000000'
    };
}

export function normalizeEditorBase(base = null, source = null) {
    const normalizedSource = normalizeEditorSource(source);
    const defaults = createDefaultEditorBase();
    const hasSource = !!normalizedSource.imageData || (normalizedSource.kind === DNG_SOURCE_KIND && !!normalizedSource.rawData)
        || (normalizedSource.width > 0 && normalizedSource.height > 0);
    const fallbackWidth = hasSource
        ? clampDimension(normalizedSource.width || defaults.width, defaults.width)
        : defaults.width;
    const fallbackHeight = hasSource
        ? clampDimension(normalizedSource.height || defaults.height, defaults.height)
        : defaults.height;

    return {
        width: clampDimension(base?.width, fallbackWidth),
        height: clampDimension(base?.height, fallbackHeight),
        backgroundMode: base?.backgroundMode === 'solid' ? 'solid' : 'transparent',
        backgroundColor: normalizeHexColor(base?.backgroundColor, defaults.backgroundColor)
    };
}

export function hasEditorCanvas(documentState = {}) {
    const base = normalizeEditorBase(documentState?.base, documentState?.source);
    return base.width > 0 && base.height > 0;
}

export function hasEditorSourceImage(documentState = {}) {
    const source = normalizeEditorSource(documentState?.source);
    return !!source.imageData || (source.kind === DNG_SOURCE_KIND && !!source.rawData);
}

export function getEditorCanvasResolution(documentState = {}) {
    const base = normalizeEditorBase(documentState?.base, documentState?.source);
    return {
        width: base.width,
        height: base.height
    };
}

export function getEditorCanvasLabel(documentState = {}) {
    const source = normalizeEditorSource(documentState?.source);
    return source.name || 'Blank Canvas';
}

export function isDefaultEditorBase(base = null) {
    const normalized = normalizeEditorBase(base, null);
    const defaults = createDefaultEditorBase();
    return normalized.width === defaults.width
        && normalized.height === defaults.height
        && normalized.backgroundMode === defaults.backgroundMode
        && normalized.backgroundColor === defaults.backgroundColor;
}

export function applyEditorBaseAspectPreset(base = null, ratioWidth = 1, ratioHeight = 1) {
    const normalized = normalizeEditorBase(base, null);
    const safeRatioWidth = Math.max(1, Math.round(Number(ratioWidth) || 1));
    const safeRatioHeight = Math.max(1, Math.round(Number(ratioHeight) || 1));
    const ratio = safeRatioWidth / safeRatioHeight;
    const maxEdge = Math.max(normalized.width, normalized.height);

    if (ratio >= 1) {
        return {
            ...normalized,
            width: clampDimension(maxEdge, normalized.width),
            height: clampDimension(Math.round(maxEdge / ratio), normalized.height)
        };
    }

    return {
        ...normalized,
        width: clampDimension(Math.round(maxEdge * ratio), normalized.width),
        height: clampDimension(maxEdge, normalized.height)
    };
}

export function computeContainedPlacement(containerWidth, containerHeight, sourceWidth, sourceHeight) {
    const safeContainerWidth = Math.max(1, Number(containerWidth) || 1);
    const safeContainerHeight = Math.max(1, Number(containerHeight) || 1);
    const safeSourceWidth = Math.max(1, Number(sourceWidth) || 1);
    const safeSourceHeight = Math.max(1, Number(sourceHeight) || 1);
    const imageAspect = safeSourceWidth / safeSourceHeight;
    const canvasAspect = safeContainerWidth / safeContainerHeight;

    let drawWidth = safeContainerWidth;
    let drawHeight = safeContainerHeight;
    let offsetX = 0;
    let offsetY = 0;

    if (imageAspect > canvasAspect) {
        drawHeight = safeContainerWidth / imageAspect;
        offsetY = (safeContainerHeight - drawHeight) * 0.5;
    } else {
        drawWidth = safeContainerHeight * imageAspect;
        offsetX = (safeContainerWidth - drawWidth) * 0.5;
    }

    return {
        x: offsetX,
        y: offsetY,
        width: drawWidth,
        height: drawHeight
    };
}

export function createEditorBaseSurface(documentState = {}, sourceImage = null) {
    const source = normalizeEditorSource(documentState?.source);
    const base = normalizeEditorBase(documentState?.base, source);
    const canvas = document.createElement('canvas');
    canvas.width = base.width;
    canvas.height = base.height;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (base.backgroundMode === 'solid') {
        ctx.fillStyle = base.backgroundColor;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const image = sourceImage && Number(sourceImage.width) > 0 && Number(sourceImage.height) > 0
        ? sourceImage
        : null;
    if (image) {
        const placement = computeContainedPlacement(canvas.width, canvas.height, image.width, image.height);
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image, placement.x, placement.y, placement.width, placement.height);
    }

    return canvas;
}
