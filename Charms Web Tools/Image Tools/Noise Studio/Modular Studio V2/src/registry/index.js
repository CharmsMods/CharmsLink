import { GROUP_ORDER, getRegistryUrls, loadRegistryFromUrls } from './shared.js';

function resolveEnabledState(layer, params, enabled) {
    if (layer.enableKey && typeof params?.[layer.enableKey] === 'boolean') {
        return params[layer.enableKey];
    }
    if (typeof enabled === 'boolean') return enabled;
    return layer.enableDefault !== false;
}

export async function loadRegistry(options = {}) {
    const urls = {
        ...getRegistryUrls(import.meta.url),
        ...(options.urls || {})
    };
    return loadRegistryFromUrls({
        registryUrl: urls.registryUrl,
        utilityProgramsUrl: urls.utilityProgramsUrl
    });
}

export function createLayerInstance(registry, layerId, existingStack) {
    const layer = registry.byId[layerId];
    if (!layer) throw new Error(`Unknown layer '${layerId}'.`);
    const existing = existingStack.filter((item) => item.layerId === layerId).length;
    const instanceIndex = existing + 1;
    const params = structuredClone(layer.defaults || {});
    return {
        instanceId: `${layerId}:${instanceIndex}`,
        layerId,
        label: layer.label,
        enabled: resolveEnabledState(layer, params),
        visible: true,
        params,
        meta: {
            instanceIndex
        }
    };
}

export function getLayerInstancesByGroup(registry, layerStack) {
    return registry.groups.map((group) => ({
        group,
        layers: registry.layers.filter((layer) => layer.group === group).map((layer) => ({
            layer,
            instances: layerStack.filter((instance) => instance.layerId === layer.layerId)
        }))
    }));
}

export function relabelInstance(instance, registry, siblings) {
    const layer = registry.byId[instance.layerId];
    const index = siblings.findIndex((item) => item.instanceId === instance.instanceId);
    return {
        ...instance,
        label: layer ? layer.label : instance.layerId,
        meta: {
            ...instance.meta,
            instanceIndex: index + 1
        }
    };
}
