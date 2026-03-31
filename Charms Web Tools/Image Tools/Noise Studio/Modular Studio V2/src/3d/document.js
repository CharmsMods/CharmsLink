const MODEL_FORMATS = new Set(['glb', 'gltf']);
const ITEM_KINDS = new Set(['model', 'image-plane', 'light', 'primitive']);
const LIGHT_TYPES = new Set(['directional', 'point', 'spot']);
const PRIMITIVE_TYPES = new Set(['cube', 'sphere', 'cone', 'cylinder']);
const TONE_MAPPINGS = new Set(['aces', 'neutral', 'none']);
const MATERIAL_PRESETS = new Set(['original', 'matte', 'metal', 'glass', 'emissive']);
const RENDER_JOB_STATUSES = new Set(['idle', 'running', 'complete', 'aborted', 'error']);

function clampNumber(value, fallback = 0, min = -Infinity, max = Infinity) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Math.min(max, Math.max(min, numeric));
}

function normalizeVector3(value, fallback = [0, 0, 0]) {
    const source = Array.isArray(value) ? value : fallback;
    return [
        clampNumber(source[0], fallback[0]),
        clampNumber(source[1], fallback[1]),
        clampNumber(source[2], fallback[2])
    ];
}

function normalizeScale(value) {
    const normalized = normalizeVector3(value, [1, 1, 1]);
    return normalized.map((entry) => clampNumber(entry, 1, 0.0001));
}

function normalizeHexColor(value, fallback = '#ffffff') {
    const text = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

function createId(prefix = '3d') {
    if (globalThis.crypto?.randomUUID) {
        return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeModelAsset(asset, fallbackName = 'Model') {
    if (!asset || typeof asset !== 'object') return null;
    const format = MODEL_FORMATS.has(String(asset.format || '').toLowerCase())
        ? String(asset.format).toLowerCase()
        : 'glb';
    const dataUrl = typeof asset.dataUrl === 'string' && asset.dataUrl.startsWith('data:')
        ? asset.dataUrl
        : '';
    if (!dataUrl) return null;
    return {
        format,
        name: String(asset.name || fallbackName || 'Model'),
        mimeType: String(asset.mimeType || ''),
        dataUrl
    };
}

function normalizeImageAsset(asset, fallbackName = 'Image Plane') {
    if (!asset || typeof asset !== 'object') return null;
    const dataUrl = typeof asset.dataUrl === 'string' && asset.dataUrl.startsWith('data:')
        ? asset.dataUrl
        : '';
    if (!dataUrl) return null;
    return {
        format: 'image',
        name: String(asset.name || fallbackName || 'Image Plane'),
        mimeType: String(asset.mimeType || ''),
        dataUrl,
        width: Math.round(clampNumber(asset.width, 1, 1, 32768)),
        height: Math.round(clampNumber(asset.height, 1, 1, 32768))
    };
}

function normalizePrimitiveAsset(asset, fallbackName = 'Primitive') {
    if (!asset || typeof asset !== 'object') return null;
    const primitiveType = PRIMITIVE_TYPES.has(String(asset.primitiveType || '').toLowerCase())
        ? String(asset.primitiveType).toLowerCase()
        : 'cube';
    return {
        format: 'primitive',
        primitiveType,
        name: String(asset.name || fallbackName || 'Primitive')
    };
}

function normalizeTextureAsset(texture = {}) {
    const dataUrl = typeof texture?.dataUrl === 'string' && texture.dataUrl.startsWith('data:')
        ? texture.dataUrl
        : '';
    if (!dataUrl) return null;
    return {
        name: String(texture.name || 'Texture'),
        mimeType: String(texture.mimeType || ''),
        dataUrl,
        repeat: [
            clampNumber(texture.repeat?.[0], 1, 0.0001, 1000),
            clampNumber(texture.repeat?.[1], 1, 0.0001, 1000)
        ],
        offset: [
            clampNumber(texture.offset?.[0], 0, -1000, 1000),
            clampNumber(texture.offset?.[1], 0, -1000, 1000)
        ],
        rotation: clampNumber(texture.rotation, 0, -Math.PI * 8, Math.PI * 8)
    };
}

function createDefaultMaterial(kind = 'model') {
    return {
        preset: kind === 'model' ? 'original' : 'matte',
        color: '#ffffff',
        roughness: kind === 'image-plane' ? 1 : 0.65,
        metalness: 0,
        opacity: 1,
        emissiveColor: '#ffffff',
        emissiveIntensity: 0,
        ior: 1.5,
        transmission: 1,
        thickness: 0.35,
        attenuationColor: '#ffffff',
        attenuationDistance: 1.5,
        texture: null
    };
}

function normalizeMaterial(material, kind = 'model') {
    const defaults = createDefaultMaterial(kind);
    const preset = MATERIAL_PRESETS.has(String(material?.preset || '').toLowerCase())
        ? String(material.preset).toLowerCase()
        : defaults.preset;
    return {
        preset,
        color: normalizeHexColor(material?.color, defaults.color),
        roughness: clampNumber(material?.roughness, defaults.roughness, 0, 1),
        metalness: clampNumber(material?.metalness, defaults.metalness, 0, 1),
        opacity: clampNumber(material?.opacity, defaults.opacity, 0.01, 1),
        emissiveColor: normalizeHexColor(material?.emissiveColor, defaults.emissiveColor),
        emissiveIntensity: clampNumber(material?.emissiveIntensity, defaults.emissiveIntensity, 0, 100),
        ior: clampNumber(material?.ior, defaults.ior, 1, 3),
        transmission: clampNumber(material?.transmission, defaults.transmission, 0, 1),
        thickness: clampNumber(material?.thickness, defaults.thickness, 0, 100),
        attenuationColor: normalizeHexColor(material?.attenuationColor, defaults.attenuationColor),
        attenuationDistance: clampNumber(material?.attenuationDistance, defaults.attenuationDistance, 0.001, 100000),
        texture: normalizeTextureAsset(material?.texture)
    };
}

function normalizeLight(light = {}) {
    const lightType = LIGHT_TYPES.has(String(light.lightType || '').toLowerCase())
        ? String(light.lightType).toLowerCase()
        : 'directional';
    return {
        lightType,
        targetItemId: typeof light.targetItemId === 'string' && light.targetItemId.trim()
            ? light.targetItemId
            : null,
        color: normalizeHexColor(light.color, '#ffffff'),
        intensity: clampNumber(light.intensity, lightType === 'directional' ? 1.5 : 2, 0, 100),
        distance: clampNumber(light.distance, 50, 0, 10000),
        angle: clampNumber(light.angle, Math.PI / 6, 0.01, Math.PI / 2),
        penumbra: clampNumber(light.penumbra, 0.35, 0, 1),
        decay: clampNumber(light.decay, 1, 0, 10),
        castShadow: light.castShadow !== false
    };
}

function normalizeSceneItem(item, index = 0) {
    const rawKind = String(item?.kind || '').toLowerCase();
    const kind = ITEM_KINDS.has(rawKind) ? rawKind : 'model';
    const fallbackName = kind === 'light'
        ? 'Light'
        : kind === 'primitive'
            ? `Primitive ${index + 1}`
        : kind === 'image-plane'
            ? `Image Plane ${index + 1}`
            : `Model ${index + 1}`;
    const normalized = {
        id: String(item?.id || createId(kind)),
        kind,
        name: String(item?.name || fallbackName),
        visible: item?.visible !== false,
        locked: !!item?.locked,
        position: normalizeVector3(item?.position, [0, 0, 0]),
        rotation: normalizeVector3(item?.rotation, [0, 0, 0]),
        scale: normalizeScale(item?.scale)
    };

    if (kind === 'light') {
        normalized.light = normalizeLight(item?.light);
        return normalized;
    }

    normalized.material = normalizeMaterial(item?.material, kind);
    normalized.asset = kind === 'image-plane'
        ? normalizeImageAsset(item?.asset, normalized.name)
        : kind === 'primitive'
            ? normalizePrimitiveAsset(item?.asset, normalized.name)
            : normalizeModelAsset(item?.asset, normalized.name);
    return normalized;
}

function normalizeCameraPreset(preset, index = 0, fallbackView = null) {
    const baseView = fallbackView || createEmptyThreeDDocument().view;
    return {
        id: String(preset?.id || createId('camera')),
        name: String(preset?.name || `Camera ${index + 1}`),
        cameraPosition: normalizeVector3(preset?.cameraPosition, baseView.cameraPosition),
        cameraTarget: normalizeVector3(preset?.cameraTarget, baseView.cameraTarget),
        fov: clampNumber(preset?.fov, baseView.fov, 15, 120)
    };
}

function createDefaultRenderJob() {
    return {
        active: false,
        status: 'idle',
        requestedSamples: 0,
        currentSamples: 0,
        outputWidth: 0,
        outputHeight: 0,
        startedAt: 0,
        finishedAt: 0,
        fileName: '',
        message: ''
    };
}

function normalizeRenderJob(job = {}) {
    const defaults = createDefaultRenderJob();
    const status = RENDER_JOB_STATUSES.has(String(job?.status || '').toLowerCase())
        ? String(job.status).toLowerCase()
        : defaults.status;
    return {
        active: !!job?.active,
        status,
        requestedSamples: Math.round(clampNumber(job?.requestedSamples, defaults.requestedSamples, 0, 1000000)),
        currentSamples: Math.round(clampNumber(job?.currentSamples, defaults.currentSamples, 0, 1000000)),
        outputWidth: Math.round(clampNumber(job?.outputWidth, defaults.outputWidth, 0, 32768)),
        outputHeight: Math.round(clampNumber(job?.outputHeight, defaults.outputHeight, 0, 32768)),
        startedAt: Math.round(clampNumber(job?.startedAt, defaults.startedAt, 0)),
        finishedAt: Math.round(clampNumber(job?.finishedAt, defaults.finishedAt, 0)),
        fileName: String(job?.fileName || defaults.fileName),
        message: String(job?.message || defaults.message)
    };
}

export function isThreeDDocumentPayload(payload) {
    return !!payload && (
        payload.kind === '3d-document'
        || payload.mode === '3d'
        || payload.schema === '3d-document'
    );
}

export function createThreeDSceneItemId(prefix = 'item') {
    return createId(prefix);
}

export function createThreeDCameraPresetId(prefix = 'camera') {
    return createId(prefix);
}

export function createEmptyThreeDDocument() {
    return {
        version: 'mns/v2',
        kind: '3d-document',
        mode: '3d',
        scene: {
            items: [],
            backgroundColor: '#202020',
            showGrid: true,
            showAxes: true
        },
        selection: {
            itemId: null
        },
        view: {
            cameraMode: 'orbit',
            linkPlaneScale: true,
            snapTranslationStep: 0,
            snapRotationDegrees: 0,
            cameraPosition: [6, 4, 8],
            cameraTarget: [0, 0, 0],
            fov: 50,
            near: 0.1,
            far: 2000,
            presets: []
        },
        render: {
            mode: 'raster',
            samplesTarget: 256,
            currentSamples: 0,
            exposure: 1,
            toneMapping: 'aces',
            outputWidth: 1920,
            outputHeight: 1080,
            lastJobSamples: 256
        },
        renderJob: createDefaultRenderJob(),
        preview: {
            imageData: '',
            width: 0,
            height: 0,
            updatedAt: 0
        }
    };
}

export function normalizeThreeDDocument(document) {
    const base = createEmptyThreeDDocument();
    const source = document && typeof document === 'object' ? document : {};
    const items = Array.isArray(source?.scene?.items)
        ? source.scene.items
            .map((item, index) => normalizeSceneItem(item, index))
            .filter((item) => item.kind === 'light' || item.kind === 'primitive' || item.asset?.dataUrl)
        : [];
    const selectedId = items.some((item) => item.id === source?.selection?.itemId)
        ? source.selection.itemId
        : null;
    const toneMapping = TONE_MAPPINGS.has(String(source?.render?.toneMapping || '').toLowerCase())
        ? String(source.render.toneMapping).toLowerCase()
        : base.render.toneMapping;

    const view = {
        cameraMode: source?.view?.cameraMode === 'fly' ? 'fly' : 'orbit',
        linkPlaneScale: source?.view?.linkPlaneScale !== false,
        snapTranslationStep: clampNumber(source?.view?.snapTranslationStep, base.view.snapTranslationStep, 0, 1000),
        snapRotationDegrees: clampNumber(source?.view?.snapRotationDegrees, base.view.snapRotationDegrees, 0, 360),
        cameraPosition: normalizeVector3(source?.view?.cameraPosition, base.view.cameraPosition),
        cameraTarget: normalizeVector3(source?.view?.cameraTarget, base.view.cameraTarget),
        fov: clampNumber(source?.view?.fov, base.view.fov, 15, 120),
        near: clampNumber(source?.view?.near, base.view.near, 0.01, 100),
        far: clampNumber(source?.view?.far, base.view.far, 10, 10000)
    };

    return {
        version: 'mns/v2',
        kind: '3d-document',
        mode: '3d',
        scene: {
            items,
            backgroundColor: normalizeHexColor(source?.scene?.backgroundColor, base.scene.backgroundColor),
            showGrid: source?.scene?.showGrid !== false,
            showAxes: !!source?.scene?.showAxes
        },
        selection: {
            itemId: selectedId
        },
        view: {
            ...view,
            presets: Array.isArray(source?.view?.presets)
                ? source.view.presets.map((preset, index) => normalizeCameraPreset(preset, index, view))
                : []
        },
        render: {
            mode: source?.render?.mode === 'pathtrace' ? 'pathtrace' : 'raster',
            samplesTarget: Math.round(clampNumber(source?.render?.samplesTarget, base.render.samplesTarget, 1, 4096)),
            currentSamples: Math.round(clampNumber(source?.render?.currentSamples, 0, 0, 1000000)),
            exposure: clampNumber(source?.render?.exposure, base.render.exposure, 0.05, 10),
            toneMapping,
            outputWidth: Math.round(clampNumber(source?.render?.outputWidth, base.render.outputWidth, 16, 32768)),
            outputHeight: Math.round(clampNumber(source?.render?.outputHeight, base.render.outputHeight, 16, 32768)),
            lastJobSamples: Math.round(clampNumber(source?.render?.lastJobSamples, base.render.lastJobSamples, 1, 1000000))
        },
        renderJob: normalizeRenderJob(source?.renderJob),
        preview: {
            imageData: typeof source?.preview?.imageData === 'string' ? source.preview.imageData : '',
            width: Math.round(clampNumber(source?.preview?.width, 0, 0)),
            height: Math.round(clampNumber(source?.preview?.height, 0, 0)),
            updatedAt: Math.round(clampNumber(source?.preview?.updatedAt, 0, 0))
        }
    };
}

export function serializeThreeDDocument(document) {
    const normalized = normalizeThreeDDocument(document);
    return {
        version: normalized.version,
        kind: normalized.kind,
        mode: normalized.mode,
        scene: {
            ...normalized.scene,
            items: normalized.scene.items.map((item) => ({
                id: item.id,
                kind: item.kind,
                name: item.name,
                visible: item.visible,
                locked: item.locked,
                position: [...item.position],
                rotation: [...item.rotation],
                scale: [...item.scale],
                ...(item.kind === 'light'
                    ? { light: { ...item.light } }
                    : {
                        asset: { ...item.asset },
                        material: {
                            ...item.material,
                            texture: item.material?.texture
                                ? {
                                    ...item.material.texture,
                                    repeat: [...item.material.texture.repeat],
                                    offset: [...item.material.texture.offset]
                                }
                                : null
                        }
                    })
            }))
        },
        selection: { ...normalized.selection },
        view: {
            cameraMode: normalized.view.cameraMode,
            linkPlaneScale: normalized.view.linkPlaneScale,
            snapTranslationStep: normalized.view.snapTranslationStep,
            snapRotationDegrees: normalized.view.snapRotationDegrees,
            cameraPosition: [...normalized.view.cameraPosition],
            cameraTarget: [...normalized.view.cameraTarget],
            fov: normalized.view.fov,
            near: normalized.view.near,
            far: normalized.view.far,
            presets: normalized.view.presets.map((preset) => ({
                id: preset.id,
                name: preset.name,
                cameraPosition: [...preset.cameraPosition],
                cameraTarget: [...preset.cameraTarget],
                fov: preset.fov
            }))
        },
        render: {
            mode: normalized.render.mode,
            samplesTarget: normalized.render.samplesTarget,
            currentSamples: normalized.render.currentSamples,
            exposure: normalized.render.exposure,
            toneMapping: normalized.render.toneMapping,
            outputWidth: normalized.render.outputWidth,
            outputHeight: normalized.render.outputHeight,
            lastJobSamples: normalized.render.lastJobSamples
        },
        preview: { ...normalized.preview }
    };
}

export function summarizeThreeDDocument(document) {
    const normalized = normalizeThreeDDocument(document);
    const models = normalized.scene.items.filter((item) => item.kind === 'model');
    const imagePlanes = normalized.scene.items.filter((item) => item.kind === 'image-plane');
    const primitives = normalized.scene.items.filter((item) => item.kind === 'primitive');
    const lights = normalized.scene.items.filter((item) => item.kind === 'light');
    const previewWidth = Number(normalized.preview.width || 0);
    const previewHeight = Number(normalized.preview.height || 0);
    const assetCount = models.length + imagePlanes.length + primitives.length;
    return {
        itemCount: normalized.scene.items.length,
        assetCount,
        modelCount: models.length,
        imagePlaneCount: imagePlanes.length,
        primitiveCount: primitives.length,
        lightCount: lights.length,
        primarySource: null,
        sourceWidth: previewWidth,
        sourceHeight: previewHeight,
        sourceArea: previewWidth * previewHeight,
        sourceCount: assetCount,
        renderWidth: previewWidth,
        renderHeight: previewHeight
    };
}
