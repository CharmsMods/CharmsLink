const GROUP_ORDER = ['base', 'color', 'texture', 'optics', 'stylize', 'damage'];
const CONTROL_TYPES = new Set([
    'range',
    'select',
    'checkbox',
    'color',
    'message',
    'separator',
    'button',
    'actionRow',
    'swatchList',
    'paletteEditor',
    'conditionalGroup',
    'colorWheel3Way'
]);

function ensureUnique(set, value, label) {
    if (set.has(value)) {
        throw new Error(`Duplicate ${label}: ${value}`);
    }
    set.add(value);
}

function visitControls(controls, callback) {
    (controls || []).forEach((control) => {
        callback(control);
        if (control.type === 'conditionalGroup') {
            visitControls(control.controls || [], callback);
        }
        if (control.type === 'colorWheel3Way') {
            (control.items || []).forEach((item) => callback({ type: 'color', key: item.key, default: item.default }));
        }
    });
}

function collectDefaultParams(layer) {
    const params = {};

    visitControls(layer.controls, (control) => {
        if (!control || !control.type) return;
        if (control.type === 'range' || control.type === 'select' || control.type === 'checkbox' || control.type === 'color') {
            if (!control.key) return;
            if (control.type === 'select') {
                params[control.key] = control.default ?? control.options?.find((option) => option.selected)?.value ?? control.options?.[0]?.value ?? '';
                return;
            }
            params[control.key] = control.default ?? (control.type === 'checkbox' ? false : control.type === 'color' ? '#000000' : control.min ?? 0);
        }
    });

    if (layer.mask?.colorExclude) {
        params[layer.mask.colorExclude.enableKey] = false;
        params[layer.mask.colorExclude.colorKey] = '#000000';
        params[layer.mask.colorExclude.toleranceKey] = 10;
        params[layer.mask.colorExclude.fadeKey] = 20;
    }
    if (layer.mask?.lumaMask) {
        params[layer.mask.lumaMask.enableKey] = false;
        params[layer.mask.lumaMask.shadowThresholdKey] = 0;
        params[layer.mask.lumaMask.shadowFadeKey] = 0;
        params[layer.mask.lumaMask.highlightThresholdKey] = 1;
        params[layer.mask.lumaMask.highlightFadeKey] = 0;
    }
    if (layer.mask?.invertKey) {
        params[layer.mask.invertKey] = false;
    }
    if (layer.layerId === 'ca') {
        params.caCenterX = 0.5;
        params.caCenterY = 0.5;
    }

    return params;
}

function resolveEnabledState(layer, params, enabled) {
    if (layer.enableKey && typeof params?.[layer.enableKey] === 'boolean') {
        return params[layer.enableKey];
    }
    if (typeof enabled === 'boolean') return enabled;
    return layer.enableDefault !== false;
}

function validateRegistryData(registry, utilityPrograms) {
    if (!registry || !Array.isArray(registry.layers)) {
        throw new Error('Layer registry is missing or malformed.');
    }
    if (!utilityPrograms || !utilityPrograms.vertex || !utilityPrograms.programs) {
        throw new Error('Utility shader registry is missing or malformed.');
    }

    const layerIds = new Set();
    const programKeys = new Set(Object.keys(utilityPrograms.programs));

    registry.layers.forEach((layer) => {
        ensureUnique(layerIds, layer.layerId, 'layerId');
        if (!GROUP_ORDER.includes(layer.group)) {
            throw new Error(`Layer '${layer.layerId}' uses unsupported group '${layer.group}'.`);
        }
        if (!layer.executor || !['manual', 'shader'].includes(layer.executor)) {
            throw new Error(`Layer '${layer.layerId}' has unsupported executor '${layer.executor}'.`);
        }

        const controlKeys = new Set();
        visitControls(layer.controls, (control) => {
            if (!CONTROL_TYPES.has(control.type)) {
                throw new Error(`Layer '${layer.layerId}' uses unsupported control type '${control.type}'.`);
            }
            if (control.key) ensureUnique(controlKeys, control.key, `control key in ${layer.layerId}`);
        });

        if (layer.mask?.colorExclude) {
            ['enableKey', 'colorKey', 'toleranceKey', 'fadeKey'].forEach((key) => {
                if (!layer.mask.colorExclude[key]) {
                    throw new Error(`Layer '${layer.layerId}' is missing mask color field '${key}'.`);
                }
            });
        }
        if (layer.mask?.lumaMask) {
            ['enableKey', 'shadowThresholdKey', 'shadowFadeKey', 'highlightThresholdKey', 'highlightFadeKey'].forEach((key) => {
                if (!layer.mask.lumaMask[key]) {
                    throw new Error(`Layer '${layer.layerId}' is missing mask luma field '${key}'.`);
                }
            });
        }

        if (layer.programKey) {
            ensureUnique(programKeys, layer.programKey, 'program key');
        }
        (layer.extraPrograms || []).forEach((program) => {
            ensureUnique(programKeys, program.key, 'program key');
        });
    });
}

export async function loadRegistry() {
    const [registry, utilityPrograms] = await Promise.all([
        fetch('src/registry/layerRegistry.json').then((response) => {
            if (!response.ok) throw new Error(`Failed to load layer registry (${response.status})`);
            return response.json();
        }),
        fetch('src/registry/utilityPrograms.json').then((response) => {
            if (!response.ok) throw new Error(`Failed to load utility shader registry (${response.status})`);
            return response.json();
        })
    ]);

    validateRegistryData(registry, utilityPrograms);

    const layers = registry.layers.map((layer) => ({
        ...layer,
        defaults: collectDefaultParams(layer)
    }));
    const byId = Object.fromEntries(layers.map((layer) => [layer.layerId, layer]));

    return {
        version: registry.version,
        layers,
        byId,
        groups: GROUP_ORDER,
        utilityPrograms
    };
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
