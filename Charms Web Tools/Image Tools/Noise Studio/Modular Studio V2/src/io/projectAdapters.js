export function createProjectAdapterRegistry(adapterList = []) {
    const adapters = new Map(adapterList.map((adapter) => [adapter.type, adapter]));

    function isThreeDPayload(payload) {
        return !!payload && (
            payload.kind === '3d-document'
            || payload.mode === '3d'
            || payload.schema === '3d-document'
        );
    }

    function getAdapter(type) {
        return adapters.get(type) || adapters.get('studio') || null;
    }

    function getAdapterForPayload(payload, fallbackType = null) {
        if (fallbackType && adapters.has(fallbackType)) {
            return adapters.get(fallbackType);
        }
        if (isThreeDPayload(payload)) {
            return adapters.get('3d') || adapters.get('studio') || null;
        }
        if (payload?.kind === 'stitch-document' || payload?.mode === 'stitch') {
            return adapters.get('stitch') || adapters.get('studio') || null;
        }
        return adapters.get('studio') || null;
    }

    function getAdapterForSection(section) {
        if (section === '3d') return getAdapter('3d');
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
