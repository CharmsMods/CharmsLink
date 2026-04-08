const COMPOSITE_SIDEBAR_VIEWS = new Set(['layers', 'transform', 'blend', 'export']);
const COMPOSITE_BLEND_MODES = new Set([
    'normal',
    'multiply',
    'screen',
    'add',
    'overlay',
    'soft-light',
    'hard-light',
    'hue',
    'color'
]);
const COMPOSITE_LAYER_KINDS = new Set(['image', 'editor-project', 'text', 'square']);
const COMPOSITE_RESIZE_MODES = new Set(['center-uniform', 'anchor-uniform', 'anchor-stretch']);
const COMPOSITE_STRETCH_LAYER_KINDS = new Set(['text', 'square']);

const textMetricsCache = new Map();
const generatedSourceCache = new Map();

let measurementCanvas = null;
let measurementContext = null;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function roundValue(value, decimals = 3) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const factor = 10 ** decimals;
    return Math.round(numeric * factor) / factor;
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createId(prefix = 'composite') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function normalizeHexColor(value, fallback = '#ffffff') {
    const raw = String(value || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    return fallback;
}

function normalizePreview(preview = null) {
    if (!preview || typeof preview !== 'object' || !preview.imageData) return null;
    return {
        imageData: String(preview.imageData || ''),
        width: Math.max(0, Math.round(Number(preview.width) || 0)),
        height: Math.max(0, Math.round(Number(preview.height) || 0)),
        updatedAt: Math.max(0, Math.round(Number(preview.updatedAt) || 0))
    };
}

function normalizeLayerSource(source = {}) {
    return {
        originalLibraryId: source?.originalLibraryId ? String(source.originalLibraryId) : null,
        originalLibraryName: source?.originalLibraryName ? String(source.originalLibraryName) : null,
        originalProjectType: source?.originalProjectType === 'studio' ? 'studio' : null
    };
}

function normalizeImageAsset(asset = {}) {
    if (!asset || typeof asset !== 'object' || !String(asset.imageData || '').startsWith('data:')) {
        return null;
    }
    return {
        name: String(asset.name || 'Image'),
        type: String(asset.type || 'image/png'),
        imageData: String(asset.imageData || ''),
        width: Math.max(1, Math.round(Number(asset.width) || 1)),
        height: Math.max(1, Math.round(Number(asset.height) || 1))
    };
}

function normalizeEmbeddedEditorDocument(document = null) {
    if (!document || typeof document !== 'object') return null;
    if (document.version === 'mns/v2' && document.kind === 'document' && document.mode === 'studio') {
        return document;
    }
    return {
        ...document,
        version: 'mns/v2',
        kind: 'document',
        mode: 'studio'
    };
}

function normalizeTextAsset(asset = {}) {
    const text = String(asset?.text ?? asset?.value ?? 'Text').replace(/\r\n/g, '\n');
    return {
        text: text.length ? text : 'Text',
        fontFamily: String(asset?.fontFamily || asset?.family || 'Arial').trim() || 'Arial',
        fontSize: Math.max(4, Math.round(Number(asset?.fontSize) || 96)),
        color: normalizeHexColor(asset?.color, '#ffffff')
    };
}

function normalizeSquareAsset(asset = {}) {
    return {
        color: normalizeHexColor(asset?.color, '#ffffff'),
        width: 2,
        height: 2
    };
}

function supportsCompositeStretching(kindOrLayer) {
    const kind = typeof kindOrLayer === 'string'
        ? String(kindOrLayer || '').toLowerCase()
        : String(kindOrLayer?.kind || '').toLowerCase();
    return COMPOSITE_STRETCH_LAYER_KINDS.has(kind);
}

function normalizeCompositeResizeMode(mode, kind = 'image') {
    const requested = String(mode || '').toLowerCase();
    if (!COMPOSITE_RESIZE_MODES.has(requested)) {
        return 'center-uniform';
    }
    if (requested === 'anchor-stretch' && !supportsCompositeStretching(kind)) {
        return 'center-uniform';
    }
    return requested;
}

function resolveCompositeLayerKind(layer = {}) {
    const requested = String(layer?.kind || '').toLowerCase();
    if (COMPOSITE_LAYER_KINDS.has(requested)) return requested;
    if (layer?.textAsset || typeof layer?.text === 'string') return 'text';
    if (layer?.squareAsset) return 'square';
    if (normalizeImageAsset(layer?.imageAsset)) return 'image';
    return 'editor-project';
}

function getTextMeasurementContext() {
    if (measurementContext) return measurementContext;
    if (typeof OffscreenCanvas === 'function') {
        measurementCanvas = new OffscreenCanvas(1, 1);
        measurementContext = measurementCanvas.getContext('2d');
        return measurementContext;
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        measurementCanvas = document.createElement('canvas');
        measurementCanvas.width = 1;
        measurementCanvas.height = 1;
        measurementContext = measurementCanvas.getContext('2d');
        return measurementContext;
    }
    return null;
}

function measureTextAsset(asset = {}) {
    const normalized = normalizeTextAsset(asset);
    const cacheKey = `${normalized.text}|${normalized.fontFamily}|${normalized.fontSize}`;
    const cached = textMetricsCache.get(cacheKey);
    if (cached) return cached;

    const lines = normalized.text.split('\n');
    const ctx = getTextMeasurementContext();
    let width = 0;
    let ascent = normalized.fontSize * 0.8;
    let descent = normalized.fontSize * 0.2;

    if (ctx) {
        ctx.font = `${normalized.fontSize}px ${normalized.fontFamily}`;
        for (const line of lines) {
            const metrics = ctx.measureText(line || ' ');
            width = Math.max(width, Number(metrics.width) || 0);
            ascent = Math.max(ascent, Number(metrics.actualBoundingBoxAscent) || 0);
            descent = Math.max(descent, Number(metrics.actualBoundingBoxDescent) || 0);
        }
    } else {
        width = Math.max(...lines.map((line) => Math.max(1, line.length) * normalized.fontSize * 0.62), normalized.fontSize * 0.62);
    }

    const lineHeight = Math.max(normalized.fontSize * 1.2, ascent + descent, 1);
    const measured = {
        width: Math.max(1, roundValue(Math.ceil(width || (normalized.fontSize * 0.62)))),
        height: Math.max(1, roundValue(Math.ceil(lineHeight * Math.max(1, lines.length)))),
        ascent: roundValue(ascent),
        descent: roundValue(descent),
        lineHeight: roundValue(lineHeight),
        lines
    };
    textMetricsCache.set(cacheKey, measured);
    return measured;
}

function svgToDataUrl(svgMarkup) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
}

function createTextLayerSource(asset = {}) {
    const normalized = normalizeTextAsset(asset);
    const metrics = measureTextAsset(normalized);
    const cacheKey = `text|${normalized.text}|${normalized.fontFamily}|${normalized.fontSize}|${normalized.color}`;
    const cached = generatedSourceCache.get(cacheKey);
    if (cached) return cached;

    const width = Math.max(1, Math.ceil(metrics.width));
    const height = Math.max(1, Math.ceil(metrics.height));
    const textMarkup = metrics.lines.map((line, index) => {
        const baselineY = roundValue(metrics.ascent + (index * metrics.lineHeight), 2);
        return `<text x="0" y="${baselineY}" xml:space="preserve">${escapeXml(line || ' ')}</text>`;
    }).join('');
    const svgMarkup = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <g fill="${escapeXml(normalized.color)}" font-family="${escapeXml(normalized.fontFamily)}" font-size="${normalized.fontSize}">
        ${textMarkup}
    </g>
</svg>`.trim();
    const next = {
        imageData: svgToDataUrl(svgMarkup),
        width,
        height
    };
    generatedSourceCache.set(cacheKey, next);
    return next;
}

function createSquareLayerSource(asset = {}) {
    const normalized = normalizeSquareAsset(asset);
    const cacheKey = `square|${normalized.color}`;
    const cached = generatedSourceCache.get(cacheKey);
    if (cached) return cached;

    const svgMarkup = `
<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2" viewBox="0 0 2 2">
    <rect x="0" y="0" width="2" height="2" fill="${escapeXml(normalized.color)}" />
</svg>`.trim();
    const next = {
        imageData: svgToDataUrl(svgMarkup),
        width: 2,
        height: 2
    };
    generatedSourceCache.set(cacheKey, next);
    return next;
}

export function createCompositeLayerId(prefix = 'layer') {
    return createId(prefix);
}

export function getCompositeLayerSourceImage(layer = {}) {
    const kind = resolveCompositeLayerKind(layer);
    if (kind === 'text') {
        return createTextLayerSource(layer?.textAsset);
    }
    if (kind === 'square') {
        return createSquareLayerSource(layer?.squareAsset);
    }
    const imageAsset = normalizeImageAsset(layer.imageAsset);
    if (imageAsset) {
        return {
            imageData: imageAsset.imageData,
            width: imageAsset.width,
            height: imageAsset.height
        };
    }
    const embedded = normalizeEmbeddedEditorDocument(layer.embeddedEditorDocument);
    const preview = normalizePreview(embedded?.preview);
    if (preview?.imageData) {
        return {
            imageData: preview.imageData,
            width: Math.max(1, preview.width || embedded?.source?.width || 1),
            height: Math.max(1, preview.height || embedded?.source?.height || 1)
        };
    }
    if (String(embedded?.source?.imageData || '').startsWith('data:')) {
        return {
            imageData: String(embedded.source.imageData),
            width: Math.max(1, Math.round(Number(embedded.source.width) || 1)),
            height: Math.max(1, Math.round(Number(embedded.source.height) || 1))
        };
    }
    return {
        imageData: '',
        width: 1,
        height: 1
    };
}

export function normalizeCompositeLayer(layer = {}, index = 0) {
    let kind = resolveCompositeLayerKind(layer);
    const fallbackScale = Math.max(0.01, Number(layer?.scale) || 1);
    const scaleX = roundValue(Math.max(0.01, Number.isFinite(Number(layer?.scaleX)) ? Number(layer.scaleX) : fallbackScale));
    const scaleY = roundValue(Math.max(0.01, Number.isFinite(Number(layer?.scaleY)) ? Number(layer.scaleY) : fallbackScale));
    const uniformScale = roundValue(Math.max(0.01, Number.isFinite(Number(layer?.scale)) ? Number(layer.scale) : Math.sqrt(scaleX * scaleY)));

    const normalized = {
        id: String(layer?.id || createCompositeLayerId()),
        kind,
        name: String(
            layer?.name
            || (kind === 'image'
                ? `Image ${index + 1}`
                : kind === 'editor-project'
                    ? `Editor Layer ${index + 1}`
                    : kind === 'text'
                        ? `Text ${index + 1}`
                        : `Square ${index + 1}`)
        ),
        visible: layer?.visible !== false,
        locked: !!layer?.locked,
        z: Number.isFinite(Number(layer?.z)) ? Number(layer.z) : index,
        x: roundValue(Number(layer?.x) || 0),
        y: roundValue(Number(layer?.y) || 0),
        scale: uniformScale,
        scaleX,
        scaleY,
        resizeMode: normalizeCompositeResizeMode(layer?.resizeMode, kind),
        rotation: roundValue(Number(layer?.rotation) || 0),
        flipX: !!layer?.flipX,
        flipY: !!layer?.flipY,
        opacity: roundValue(clamp(Number(layer?.opacity) || 1, 0, 1)),
        blendMode: COMPOSITE_BLEND_MODES.has(String(layer?.blendMode || '').toLowerCase())
            ? String(layer.blendMode).toLowerCase()
            : 'normal',
        source: normalizeLayerSource(layer?.source),
        embeddedEditorDocument: kind === 'editor-project' ? normalizeEmbeddedEditorDocument(layer?.embeddedEditorDocument) : null,
        imageAsset: kind === 'image' ? normalizeImageAsset(layer?.imageAsset) : null,
        textAsset: kind === 'text' ? normalizeTextAsset(layer?.textAsset || layer?.text) : null,
        squareAsset: kind === 'square' ? normalizeSquareAsset(layer?.squareAsset) : null
    };

    if (normalized.kind === 'editor-project' && !normalized.embeddedEditorDocument && normalized.imageAsset) {
        kind = 'image';
        return {
            ...normalized,
            kind,
            name: String(layer?.name || `Image ${index + 1}`),
            imageAsset: normalizeImageAsset(layer?.imageAsset),
            embeddedEditorDocument: null
        };
    }
    if (normalized.kind === 'image' && !normalized.imageAsset && normalized.embeddedEditorDocument) {
        kind = 'editor-project';
        return {
            ...normalized,
            kind,
            name: String(layer?.name || `Editor Layer ${index + 1}`),
            imageAsset: null
        };
    }
    return normalized;
}

export function createEmptyCompositeDocument() {
    return {
        version: 'mns/v2',
        kind: 'composite-document',
        mode: 'composite',
        workspace: {
            sidebarView: 'layers'
        },
        layers: [],
        selection: {
            layerId: null
        },
        view: {
            zoom: 1,
            panX: 0,
            panY: 0,
            zoomLocked: false,
            showChecker: true
        },
        export: {
            background: 'transparent',
            boundsMode: 'auto',
            bounds: { x: 0, y: 0, width: 1920, height: 1080 },
            customResolution: { width: 1920, height: 1080 }
        },
        preview: null
    };
}

export function normalizeCompositeDocument(document = {}) {
    const base = createEmptyCompositeDocument();
    const layers = (Array.isArray(document?.layers) ? document.layers : [])
        .map((layer, index) => normalizeCompositeLayer(layer, index))
        .sort((a, b) => (a.z || 0) - (b.z || 0))
        .map((layer, index) => ({ ...layer, z: index }));
    const requestedSelectionId = document?.selection?.layerId;
    const selectionId = layers.some((layer) => layer.id === requestedSelectionId)
        ? requestedSelectionId
        : (layers[layers.length - 1]?.id || null);
    return {
        version: 'mns/v2',
        kind: 'composite-document',
        mode: 'composite',
        workspace: {
            sidebarView: COMPOSITE_SIDEBAR_VIEWS.has(String(document?.workspace?.sidebarView || '').toLowerCase())
                ? String(document.workspace.sidebarView).toLowerCase()
                : base.workspace.sidebarView
        },
        layers,
        selection: {
            layerId: selectionId
        },
        view: {
            zoom: clamp(Number(document?.view?.zoom) || 1, 0.1, 32),
            panX: roundValue(Number(document?.view?.panX) || 0),
            panY: roundValue(Number(document?.view?.panY) || 0),
            zoomLocked: !!document?.view?.zoomLocked,
            showChecker: document?.view?.showChecker !== false
        },
        export: {
            background: document?.export?.background === 'transparent'
                ? 'transparent'
                : /^#[0-9a-fA-F]{6}$/.test(String(document?.export?.background || ''))
                    ? String(document.export.background).toLowerCase()
                    : 'transparent',
            boundsMode: document?.export?.boundsMode === 'custom' ? 'custom' : 'auto',
            bounds: {
                x: roundValue(Number(document?.export?.bounds?.x) || 0),
                y: roundValue(Number(document?.export?.bounds?.y) || 0),
                width: Math.max(1, roundValue(Number(document?.export?.bounds?.width) || 1920)),
                height: Math.max(1, roundValue(Number(document?.export?.bounds?.height) || 1080))
            },
            customResolution: {
                width: Math.max(1, Math.round(Number(document?.export?.customResolution?.width) || 1920)),
                height: Math.max(1, Math.round(Number(document?.export?.customResolution?.height) || 1080))
            }
        },
        preview: normalizePreview(document?.preview)
    };
}

export function serializeCompositeDocument(document) {
    return clone(normalizeCompositeDocument(document));
}

export function isCompositeDocumentPayload(payload) {
    return !!payload && (
        payload.kind === 'composite-document'
        || payload.mode === 'composite'
        || payload.schema === 'composite-document'
    );
}

export function getSelectedCompositeLayer(document) {
    const normalized = normalizeCompositeDocument(document);
    return normalized.layers.find((layer) => layer.id === normalized.selection.layerId) || null;
}

export function getCompositeLayerDimensions(layer) {
    const source = getCompositeLayerSourceImage(layer);
    return {
        width: Math.max(1, Number(source.width) || 1),
        height: Math.max(1, Number(source.height) || 1)
    };
}

export function getCompositeLayerScale(layer) {
    const normalized = normalizeCompositeLayer(layer);
    return {
        x: Math.max(0.01, Number(normalized.scaleX) || Number(normalized.scale) || 1),
        y: Math.max(0.01, Number(normalized.scaleY) || Number(normalized.scale) || 1),
        uniform: Math.max(0.01, Number(normalized.scale) || 1)
    };
}

export function getCompositeLayerRenderedSize(layer) {
    const source = getCompositeLayerDimensions(layer);
    const scale = getCompositeLayerScale(layer);
    return {
        width: roundValue(source.width * scale.x),
        height: roundValue(source.height * scale.y)
    };
}

export function getCompositeLayerResizeMode(layer) {
    return normalizeCompositeResizeMode(layer?.resizeMode, layer?.kind);
}

export function isCompositeLayerStretchCapable(layer) {
    return supportsCompositeStretching(layer?.kind || layer);
}

export function getCompositeViewCenterWorld(view = {}) {
    const zoom = clamp(Number(view?.zoom) || 1, 0.1, 32);
    return {
        x: roundValue(-(Number(view?.panX) || 0) / zoom),
        y: roundValue(-(Number(view?.panY) || 0) / zoom)
    };
}

export function computeCompositeViewBounds(view = {}, viewportWidth = 1, viewportHeight = 1) {
    const safeWidth = Math.max(1, Number(viewportWidth) || 1);
    const safeHeight = Math.max(1, Number(viewportHeight) || 1);
    const zoom = clamp(Number(view?.zoom) || 1, 0.1, 32);
    const center = getCompositeViewCenterWorld(view);
    const halfWidth = safeWidth * 0.5 / zoom;
    const halfHeight = safeHeight * 0.5 / zoom;
    return {
        minX: roundValue(center.x - halfWidth),
        minY: roundValue(center.y - halfHeight),
        maxX: roundValue(center.x + halfWidth),
        maxY: roundValue(center.y + halfHeight),
        width: roundValue(halfWidth * 2),
        height: roundValue(halfHeight * 2),
        centerX: center.x,
        centerY: center.y,
        zoom
    };
}

function rotatePoint(x, y, radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (x * cos) - (y * sin),
        y: (x * sin) + (y * cos)
    };
}

export function computeCompositeLayerBounds(layer) {
    const normalizedLayer = normalizeCompositeLayer(layer);
    const { width, height } = getCompositeLayerDimensions(normalizedLayer);
    const scaledWidth = width * normalizedLayer.scaleX;
    const scaledHeight = height * normalizedLayer.scaleY;
    const centerX = normalizedLayer.x + (scaledWidth * 0.5);
    const centerY = normalizedLayer.y + (scaledHeight * 0.5);
    const corners = [
        rotatePoint(-scaledWidth * 0.5, -scaledHeight * 0.5, normalizedLayer.rotation),
        rotatePoint(scaledWidth * 0.5, -scaledHeight * 0.5, normalizedLayer.rotation),
        rotatePoint(scaledWidth * 0.5, scaledHeight * 0.5, normalizedLayer.rotation),
        rotatePoint(-scaledWidth * 0.5, scaledHeight * 0.5, normalizedLayer.rotation)
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

export function getActiveCompositeLayers(document) {
    return normalizeCompositeDocument(document).layers
        .filter((layer) => layer.visible !== false)
        .sort((a, b) => (a.z || 0) - (b.z || 0));
}

export function computeCompositeDocumentBounds(document, layersOverride = null) {
    const layers = Array.isArray(layersOverride) ? layersOverride.map((layer, index) => normalizeCompositeLayer(layer, index)) : getActiveCompositeLayers(document);
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
    const bounds = layers.map((layer) => computeCompositeLayerBounds(layer));
    const minX = Math.min(...bounds.map((entry) => entry.minX));
    const minY = Math.min(...bounds.map((entry) => entry.minY));
    const maxX = Math.max(...bounds.map((entry) => entry.maxX));
    const maxY = Math.max(...bounds.map((entry) => entry.maxY));
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}

export function computeCompositeFramedView(bounds, viewportWidth = 1, viewportHeight = 1, options = {}) {
    const safeWidth = Math.max(1, Number(viewportWidth) || 1);
    const safeHeight = Math.max(1, Number(viewportHeight) || 1);
    const paddingPx = Math.max(0, Number(options.paddingPx) || 48);
    const minZoom = clamp(Number(options.minZoom) || 0.1, 0.01, 32);
    const maxZoom = clamp(Number(options.maxZoom) || 32, minZoom, 32);
    const width = Math.max(0, Number(bounds?.width) || 0);
    const height = Math.max(0, Number(bounds?.height) || 0);

    if (!(width > 0) || !(height > 0)) {
        return {
            zoom: 1,
            panX: 0,
            panY: 0,
            centerWorld: { x: 0, y: 0 }
        };
    }

    const availableWidth = Math.max(1, safeWidth - (paddingPx * 2));
    const availableHeight = Math.max(1, safeHeight - (paddingPx * 2));
    const zoom = clamp(Math.min(availableWidth / width, availableHeight / height), minZoom, maxZoom);
    const centerX = Number(bounds.minX || 0) + (width * 0.5);
    const centerY = Number(bounds.minY || 0) + (height * 0.5);
    return {
        zoom: roundValue(zoom),
        panX: roundValue(-(centerX * zoom)),
        panY: roundValue(-(centerY * zoom)),
        centerWorld: {
            x: roundValue(centerX),
            y: roundValue(centerY)
        }
    };
}

export function computeCompositeFittedLayerPlacement({
    document = null,
    sourceWidth = 1,
    sourceHeight = 1,
    viewportWidth = 1600,
    viewportHeight = 900,
    fit = 0.82,
    cascadeIndex = 0,
    cascadePx = 36,
    maxScale = 1
} = {}) {
    const normalized = normalizeCompositeDocument(document);
    const viewBounds = computeCompositeViewBounds(normalized.view, viewportWidth, viewportHeight);
    const safeSourceWidth = Math.max(1, Number(sourceWidth) || 1);
    const safeSourceHeight = Math.max(1, Number(sourceHeight) || 1);
    const fitRatio = clamp(Number(fit) || 0.82, 0.1, 1);
    const maximumScale = Math.max(0.01, Number(maxScale) || 1);
    const nextScale = clamp(Math.min(
        maximumScale,
        (viewBounds.width * fitRatio) / safeSourceWidth,
        (viewBounds.height * fitRatio) / safeSourceHeight
    ), 0.01, maximumScale);
    const scaledWidth = safeSourceWidth * nextScale;
    const scaledHeight = safeSourceHeight * nextScale;
    const zoom = viewBounds.zoom || 1;
    const offsetWorld = (Math.max(0, Number(cascadePx) || 36) / Math.max(zoom, 0.0001)) * Math.max(0, Number(cascadeIndex) || 0);
    const centerX = viewBounds.centerX + offsetWorld;
    const centerY = viewBounds.centerY + offsetWorld;
    return {
        x: roundValue(centerX - (scaledWidth * 0.5)),
        y: roundValue(centerY - (scaledHeight * 0.5)),
        scale: roundValue(nextScale)
    };
}

export function summarizeCompositeDocument(document) {
    const normalized = normalizeCompositeDocument(document);
    const bounds = computeCompositeDocumentBounds(normalized);
    const editorLayerCount = normalized.layers.filter((layer) => layer.kind === 'editor-project').length;
    const imageLayerCount = normalized.layers.filter((layer) => layer.kind === 'image').length;
    const textLayerCount = normalized.layers.filter((layer) => layer.kind === 'text').length;
    const squareLayerCount = normalized.layers.filter((layer) => layer.kind === 'square').length;
    return {
        primarySource: null,
        sourceWidth: Math.max(0, Math.round(bounds.width)),
        sourceHeight: Math.max(0, Math.round(bounds.height)),
        sourceArea: Math.max(0, Math.round(bounds.width * bounds.height)),
        sourceCount: normalized.layers.length,
        renderWidth: Math.max(0, Math.round(bounds.width)),
        renderHeight: Math.max(0, Math.round(bounds.height)),
        layerCount: normalized.layers.length,
        editorLayerCount,
        imageLayerCount,
        textLayerCount,
        squareLayerCount
    };
}
