export function createProjectAdapterRegistry(adapterList = []) {
    const adapters = new Map(adapterList.map((adapter) => [adapter.type, adapter]));

    function getAdapter(type) {
        return adapters.get(type) || adapters.get('studio') || null;
    }

    function getAdapterForPayload(payload, fallbackType = null) {
        if (fallbackType && adapters.has(fallbackType)) {
            return adapters.get(fallbackType);
        }
        if (payload?.kind === 'stitch-document' || payload?.mode === 'stitch') {
            return adapters.get('stitch') || adapters.get('studio') || null;
        }
        return adapters.get('studio') || null;
    }

    function getAdapterForSection(section) {
        if (section === 'stitch') return getAdapter('stitch');
        return getAdapter('studio');
    }

    return {
        getAdapter,
        getAdapterForPayload,
        getAdapterForSection,
        list() {
            return [...adapters.values()];
        }
    };
}
