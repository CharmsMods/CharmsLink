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

export function createCompositeLayerId(prefix = 'layer') {
    return createId(prefix);
}

export function getCompositeLayerSourceImage(layer = {}) {
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
    let kind = layer?.kind === 'image' ? 'image' : 'editor-project';
    const normalized = {
        id: String(layer?.id || createCompositeLayerId()),
        kind,
        name: String(layer?.name || (kind === 'image' ? `Image ${index + 1}` : `Editor Layer ${index + 1}`)),
        visible: layer?.visible !== false,
        locked: !!layer?.locked,
        z: Number.isFinite(Number(layer?.z)) ? Number(layer.z) : index,
        x: roundValue(Number(layer?.x) || 0),
        y: roundValue(Number(layer?.y) || 0),
        scale: roundValue(Math.max(0.01, Number(layer?.scale) || 1)),
        rotation: roundValue(Number(layer?.rotation) || 0),
        flipX: !!layer?.flipX,
        flipY: !!layer?.flipY,
        opacity: roundValue(clamp(Number(layer?.opacity) || 1, 0, 1)),
        blendMode: COMPOSITE_BLEND_MODES.has(String(layer?.blendMode || '').toLowerCase())
            ? String(layer.blendMode).toLowerCase()
            : 'normal',
        source: normalizeLayerSource(layer?.source),
        embeddedEditorDocument: kind === 'editor-project' ? normalizeEmbeddedEditorDocument(layer?.embeddedEditorDocument) : null,
        imageAsset: kind === 'image' ? normalizeImageAsset(layer?.imageAsset) : null
    };

    if (normalized.kind === 'editor-project' && !normalized.embeddedEditorDocument && normalized.imageAsset) {
        return {
            ...normalized,
            kind: 'image',
            imageAsset: normalizeImageAsset(layer?.imageAsset)
        };
    }
    if (normalized.kind === 'image' && !normalized.imageAsset && normalized.embeddedEditorDocument) {
        return {
            ...normalized,
            kind: 'editor-project'
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
    const scaledWidth = width * normalizedLayer.scale;
    const scaledHeight = height * normalizedLayer.scale;
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

export function summarizeCompositeDocument(document) {
    const normalized = normalizeCompositeDocument(document);
    const bounds = computeCompositeDocumentBounds(normalized);
    const editorLayerCount = normalized.layers.filter((layer) => layer.kind === 'editor-project').length;
    const imageLayerCount = normalized.layers.filter((layer) => layer.kind === 'image').length;
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
        imageLayerCount
    };
}
