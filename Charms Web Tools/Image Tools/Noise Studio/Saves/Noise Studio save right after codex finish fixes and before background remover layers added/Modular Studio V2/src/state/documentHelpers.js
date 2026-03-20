export const MAX_PREVIEW_ZOOM = 8;

export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function createDefaultViewState() {
    return {
        theme: 'light',
        zoom: 1,
        highQualityPreview: false,
        hoverCompareEnabled: true
    };
}

export function normalizeViewState(view = {}) {
    const defaults = createDefaultViewState();
    const zoom = Number.isFinite(Number(view.zoom)) ? Number(view.zoom) : defaults.zoom;
    return {
        ...defaults,
        ...view,
        theme: view.theme === 'dark' ? 'dark' : 'light',
        zoom: clamp(zoom, 1, MAX_PREVIEW_ZOOM),
        highQualityPreview: !!view.highQualityPreview,
        hoverCompareEnabled: typeof view.hoverCompareEnabled === 'boolean'
            ? view.hoverCompareEnabled
            : defaults.hoverCompareEnabled
    };
}

export function isRenderableLayerInstance(registry, instance) {
    if (!instance) return false;
    const layer = registry.byId[instance.layerId];
    if (!layer || instance.visible === false) return false;
    return layer.enableKey ? instance.enabled !== false : true;
}

export function hasRenderableLayers(registry, documentState) {
    return (documentState?.layerStack || []).some((instance) => isRenderableLayerInstance(registry, instance));
}
