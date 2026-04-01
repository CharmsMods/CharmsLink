const MODEL_FORMATS = new Set(['glb', 'gltf']);
const FONT_FORMATS = new Set(['ttf', 'otf', 'woff', 'woff2']);
const HDRI_FORMATS = new Set(['hdr']);
const ITEM_KINDS = new Set(['model', 'image-plane', 'light', 'primitive', 'text', 'shape-2d']);
const LIGHT_TYPES = new Set(['directional', 'point', 'spot']);
const PRIMITIVE_TYPES = new Set(['cube', 'sphere', 'cone', 'cylinder']);
const SHAPE_2D_TYPES = new Set(['square', 'circle']);
const MATERIAL_PRESETS = new Set(['original', 'matte', 'metal', 'glass', 'emissive']);
const RENDER_MODES = new Set(['raster', 'pathtrace', 'mesh']);
const EXPORT_ENGINES = new Set(['pathtrace']);
const TONE_MAPPINGS = new Set(['aces', 'neutral', 'none']);
const CAMERA_MODES = new Set(['orbit', 'fly']);
const PROJECTIONS = new Set(['perspective', 'orthographic']);
const NAVIGATION_MODES = new Set(['free', 'canvas']);
const LOCKED_VIEWS = new Set(['front', 'back', 'left', 'right', 'top', 'bottom', 'current']);
const WHEEL_MODES = new Set(['travel', 'zoom']);
const TEXT_MODES = new Set(['flat', 'extruded']);
const FONT_SOURCE_TYPES = new Set(['upload', 'system']);
const WORLD_LIGHT_MODES = new Set(['solid', 'gradient', 'hdri']);
const RENDER_JOB_STATUSES = new Set(['idle', 'running', 'complete', 'aborted', 'error']);
const WORKSPACE_PANEL_TABS = new Set(['outliner', 'add', 'selection', 'scene', 'render', 'views']);
const WORKSPACE_TASK_VIEWS = new Set(['layout', 'model', 'render']);
const WORKSPACE_LEFT_TABS = new Set(['outliner', 'add', 'views']);
const WORKSPACE_RIGHT_TABS = new Set(['selection', 'scene', 'render']);

const DEFAULT_WORLD_LIGHT = {
    enabled: false,
    mode: 'solid',
    intensity: 1,
    backgroundVisible: true,
    rotation: 0,
    color: '#f7f4eb',
    gradientStops: [
        { position: 0, color: '#f7f4eb' },
        { position: 1, color: '#2b2722' }
    ],
    hdriAssetId: null
};

const DEFAULT_TEXT = {
    content: 'Text',
    mode: 'flat',
    fontSource: { type: 'system', assetId: null, family: 'Arial' },
    color: '#ffffff',
    opacity: 1,
    glow: { enabled: false, color: '#ffffff', intensity: 4 },
    characterOverrides: [],
    extrude: { depth: 0.2, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 },
    attachment: null
};

function num(value, fallback = 0, min = -Infinity, max = Infinity) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.min(max, Math.max(min, next));
}

function round(value, fallback = 0, min = -Infinity, max = Infinity) {
    return Math.round(num(value, fallback, min, max));
}

function hex(value, fallback = '#ffffff') {
    const text = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : fallback;
}

function vec3(value, fallback = [0, 0, 0], min = -Infinity, max = Infinity) {
    const source = Array.isArray(value) ? value : fallback;
    return [num(source[0], fallback[0], min, max), num(source[1], fallback[1], min, max), num(source[2], fallback[2], min, max)];
}

function scale3(value) {
    return vec3(value, [1, 1, 1], 0.0001);
}

function quat(value, fallback = null) {
    if (!Array.isArray(value) || value.length < 4) return fallback ? [...fallback] : null;
    const raw = [num(value[0], 0, -1, 1), num(value[1], 0, -1, 1), num(value[2], 0, -1, 1), num(value[3], 1, -1, 1)];
    const length = Math.hypot(...raw) || 1;
    return raw.map((entry) => entry / length);
}

function dataUrl(value) {
    return typeof value === 'string' && value.startsWith('data:') ? value : '';
}

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createId(prefix = '3d') {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeWorkspace(workspace = {}) {
    const taskView = WORKSPACE_TASK_VIEWS.has(String(workspace.taskView || '').toLowerCase()) ? String(workspace.taskView).toLowerCase() : 'layout';
    const panelFallback = taskView === 'model' ? 'selection' : taskView === 'render' ? 'render' : 'outliner';
    const mapPanel = (value, fallback) => {
        const next = String(value || '').toLowerCase();
        if (next === 'object' || next === 'material') return 'selection';
        return WORKSPACE_PANEL_TABS.has(next) ? next : fallback;
    };
    const mapPair = (pair = {}, fallback = {}) => {
        const left = WORKSPACE_LEFT_TABS.has(String(pair.leftTab || '').toLowerCase()) ? String(pair.leftTab).toLowerCase() : fallback.leftTab;
        const rawRight = String(pair.rightTab || '').toLowerCase();
        const right = rawRight === 'object' || rawRight === 'material'
            ? 'selection'
            : WORKSPACE_RIGHT_TABS.has(rawRight) ? rawRight : fallback.rightTab;
        return { leftTab: left, rightTab: right };
    };
    return {
        taskView,
        panelTab: mapPanel(workspace.panelTab, panelFallback),
        taskTabs: {
            layout: mapPair(workspace.taskTabs?.layout, { leftTab: 'outliner', rightTab: 'scene' }),
            model: mapPair(workspace.taskTabs?.model, { leftTab: 'add', rightTab: 'selection' }),
            render: mapPair(workspace.taskTabs?.render, { leftTab: 'views', rightTab: 'render' })
        }
    };
}

function normalizeAsset(asset, kind = 'font', index = 0) {
    if (!asset || typeof asset !== 'object') return null;
    const nextDataUrl = dataUrl(asset.dataUrl);
    if (!nextDataUrl) return null;
    const formats = kind === 'hdri' ? HDRI_FORMATS : FONT_FORMATS;
    return {
        id: String(asset.id || createId(kind)),
        name: String(asset.name || `${kind === 'hdri' ? 'HDRI' : 'Font'} ${index + 1}`),
        format: formats.has(String(asset.format || '').toLowerCase()) ? String(asset.format).toLowerCase() : (kind === 'hdri' ? 'hdr' : 'ttf'),
        mimeType: String(asset.mimeType || ''),
        dataUrl: nextDataUrl
    };
}

function normalizeTexture(texture = null) {
    if (!texture || typeof texture !== 'object') return null;
    const nextDataUrl = dataUrl(texture.dataUrl);
    if (!nextDataUrl) return null;
    return {
        name: String(texture.name || 'Texture'),
        mimeType: String(texture.mimeType || ''),
        dataUrl: nextDataUrl,
        repeat: [num(texture.repeat?.[0], 1, 0.0001), num(texture.repeat?.[1], 1, 0.0001)],
        offset: [num(texture.offset?.[0], 0), num(texture.offset?.[1], 0)],
        rotation: num(texture.rotation, 0, -Math.PI * 8, Math.PI * 8)
    };
}

function normalizeMaterial(material = {}, kind = 'model') {
    const presetDefault = kind === 'model' ? 'original' : 'matte';
    return {
        preset: MATERIAL_PRESETS.has(String(material.preset || '').toLowerCase()) ? String(material.preset).toLowerCase() : presetDefault,
        color: hex(material.color, '#ffffff'),
        roughness: num(material.roughness, kind === 'image-plane' ? 1 : 0.65, 0, 1),
        metalness: num(material.metalness, 0, 0, 1),
        opacity: num(material.opacity, 1, 0.01, 1),
        emissiveColor: hex(material.emissiveColor, '#ffffff'),
        emissiveIntensity: num(material.emissiveIntensity, 0, 0, 100),
        ior: num(material.ior, 1.5, 1, 3),
        transmission: num(material.transmission, 1, 0, 1),
        thickness: num(material.thickness, 0.35, 0, 100),
        attenuationColor: hex(material.attenuationColor, '#ffffff'),
        attenuationDistance: num(material.attenuationDistance, 1.5, 0.001, 100000),
        texture: normalizeTexture(material.texture)
    };
}

function normalizeLight(light = {}) {
    const lightType = LIGHT_TYPES.has(String(light.lightType || '').toLowerCase()) ? String(light.lightType).toLowerCase() : 'directional';
    return {
        lightType,
        targetItemId: typeof light.targetItemId === 'string' && light.targetItemId.trim() ? light.targetItemId : null,
        color: hex(light.color, '#ffffff'),
        intensity: num(light.intensity, lightType === 'directional' ? 1.5 : 2, 0, 100),
        distance: num(light.distance, 50, 0, 10000),
        angle: num(light.angle, Math.PI / 6, 0.01, Math.PI / 2),
        penumbra: num(light.penumbra, 0.35, 0, 1),
        decay: num(light.decay, 1, 0, 10),
        castShadow: light.castShadow !== false
    };
}

function normalizeGlow(glow = {}, fallback = '#ffffff') {
    return { enabled: !!glow.enabled, color: hex(glow.color, fallback), intensity: num(glow.intensity, 4, 0, 100) };
}

function normalizeText(text = {}) {
    const color = hex(text.color, DEFAULT_TEXT.color);
    const fontSourceType = FONT_SOURCE_TYPES.has(String(text.fontSource?.type || '').toLowerCase()) ? String(text.fontSource.type).toLowerCase() : 'system';
    const uploadedAssetId = fontSourceType === 'upload' && typeof text.fontSource?.assetId === 'string' && text.fontSource.assetId.trim()
        ? text.fontSource.assetId
        : null;
    const requestedMode = TEXT_MODES.has(String(text.mode || '').toLowerCase()) ? String(text.mode).toLowerCase() : DEFAULT_TEXT.mode;
    return {
        content: String(text.content ?? DEFAULT_TEXT.content),
        mode: requestedMode === 'extruded' && !(fontSourceType === 'upload' && uploadedAssetId) ? 'flat' : requestedMode,
        fontSource: {
            type: fontSourceType,
            assetId: uploadedAssetId,
            family: fontSourceType === 'system' ? String(text.fontSource?.family || 'Arial').trim() || 'Arial' : ''
        },
        color,
        opacity: num(text.opacity, 1, 0.01, 1),
        glow: normalizeGlow(text.glow, color),
        characterOverrides: (Array.isArray(text.characterOverrides) ? text.characterOverrides : []).map((entry) => ({
            index: round(entry?.index, 0, 0),
            flipX: !!entry?.flipX,
            flipY: !!entry?.flipY
        })).sort((a, b) => a.index - b.index),
        extrude: {
            depth: num(text.extrude?.depth, DEFAULT_TEXT.extrude.depth, 0.01, 10),
            bevelSize: num(text.extrude?.bevelSize, DEFAULT_TEXT.extrude.bevelSize, 0, 2),
            bevelThickness: num(text.extrude?.bevelThickness, DEFAULT_TEXT.extrude.bevelThickness, 0, 2),
            bevelSegments: round(text.extrude?.bevelSegments, DEFAULT_TEXT.extrude.bevelSegments, 1, 32)
        },
        attachment: text.attachment && typeof text.attachment === 'object' && text.attachment.targetItemId
            ? {
                targetItemId: String(text.attachment.targetItemId),
                localPosition: vec3(text.attachment.localPosition),
                localNormal: vec3(text.attachment.localNormal, [0, 0, 1]),
                localTangent: vec3(text.attachment.localTangent, [1, 0, 0]),
                offset: num(text.attachment.offset, 0.01, 0, 100)
            }
            : null
    };
}

function normalizeShape2D(shape = {}) {
    const color = hex(shape.color, '#ffffff');
    return {
        type: SHAPE_2D_TYPES.has(String(shape.type || '').toLowerCase()) ? String(shape.type).toLowerCase() : 'square',
        color,
        opacity: num(shape.opacity, 1, 0.01, 1),
        glow: normalizeGlow(shape.glow, color)
    };
}

function normalizeWorldLight(worldLight = {}, hdriIds = new Set()) {
    const mode = WORLD_LIGHT_MODES.has(String(worldLight.mode || '').toLowerCase()) ? String(worldLight.mode).toLowerCase() : DEFAULT_WORLD_LIGHT.mode;
    const hdriAssetId = typeof worldLight.hdriAssetId === 'string' && worldLight.hdriAssetId.trim() && hdriIds.has(worldLight.hdriAssetId)
        ? worldLight.hdriAssetId
        : null;
    return {
        enabled: !!worldLight.enabled,
        mode: mode === 'hdri' && !hdriAssetId ? 'solid' : mode,
        intensity: num(worldLight.intensity, DEFAULT_WORLD_LIGHT.intensity, 0, 100),
        backgroundVisible: worldLight.backgroundVisible !== false,
        rotation: num(worldLight.rotation, DEFAULT_WORLD_LIGHT.rotation, -Math.PI * 16, Math.PI * 16),
        color: hex(worldLight.color, DEFAULT_WORLD_LIGHT.color),
        gradientStops: (Array.isArray(worldLight.gradientStops) && worldLight.gradientStops.length ? worldLight.gradientStops : DEFAULT_WORLD_LIGHT.gradientStops)
            .map((stop, index, list) => ({ position: num(stop?.position, index / Math.max(1, list.length - 1), 0, 1), color: hex(stop?.color, '#ffffff') }))
            .sort((a, b) => a.position - b.position),
        hdriAssetId
    };
}

function normalizeItem(item = {}, index = 0) {
    const kind = ITEM_KINDS.has(String(item.kind || '').toLowerCase()) ? String(item.kind).toLowerCase() : 'model';
    const base = {
        id: String(item.id || createId(kind)),
        kind,
        name: String(item.name || (kind === 'light' ? 'Light' : kind === 'primitive' ? `Primitive ${index + 1}` : kind === 'image-plane' ? `Image Plane ${index + 1}` : kind === 'text' ? `Text ${index + 1}` : kind === 'shape-2d' ? `Shape ${index + 1}` : `Model ${index + 1}`)),
        visible: item.visible !== false,
        locked: !!item.locked,
        position: vec3(item.position),
        rotation: vec3(item.rotation),
        scale: scale3(item.scale)
    };
    if (kind === 'light') return { ...base, light: normalizeLight(item.light) };
    if (kind === 'text') return { ...base, text: normalizeText(item.text) };
    if (kind === 'shape-2d') return { ...base, shape2d: normalizeShape2D(item.shape2d) };
    const asset = kind === 'image-plane'
        ? { format: 'image', name: String(item.asset?.name || base.name), mimeType: String(item.asset?.mimeType || ''), dataUrl: dataUrl(item.asset?.dataUrl), width: round(item.asset?.width, 1, 1, 32768), height: round(item.asset?.height, 1, 1, 32768) }
        : kind === 'primitive'
            ? { format: 'primitive', primitiveType: PRIMITIVE_TYPES.has(String(item.asset?.primitiveType || '').toLowerCase()) ? String(item.asset.primitiveType).toLowerCase() : 'cube', name: String(item.asset?.name || base.name) }
            : { format: MODEL_FORMATS.has(String(item.asset?.format || '').toLowerCase()) ? String(item.asset.format).toLowerCase() : 'glb', name: String(item.asset?.name || base.name), mimeType: String(item.asset?.mimeType || ''), dataUrl: dataUrl(item.asset?.dataUrl) };
    return {
        ...base,
        asset,
        material: normalizeMaterial(item.material, kind),
        booleanCuts: (kind === 'model' || kind === 'primitive')
            ? (Array.isArray(item.booleanCuts) ? item.booleanCuts : []).map((cut, cutIndex) => isBooleanCutGeometry(cut?.geometry) ? ({ id: String(cut.id || createId('cut')), mode: 'subtract', sourceName: String(cut.sourceName || `Cut ${cutIndex + 1}`), createdAt: round(cut.createdAt, 0, 0), geometry: clone(cut.geometry) }) : null).filter(Boolean)
            : []
    };
}

function normalizePreset(preset = {}, index = 0, fallback = null) {
    const base = fallback || createEmptyThreeDDocument().view;
    return {
        id: String(preset.id || createId('camera')),
        name: String(preset.name || `Camera ${index + 1}`),
        cameraPosition: vec3(preset.cameraPosition, base.cameraPosition),
        cameraTarget: vec3(preset.cameraTarget, base.cameraTarget),
        fov: num(preset.fov, base.fov, 15, 120),
        projection: PROJECTIONS.has(String(preset.projection || '').toLowerCase()) ? String(preset.projection).toLowerCase() : base.projection,
        orthoZoom: num(preset.orthoZoom, base.orthoZoom, 0.05, 100)
    };
}

export function createEmptyThreeDDocument() {
    return {
        version: 'mns/v2',
        kind: '3d-document',
        mode: '3d',
        workspace: normalizeWorkspace(),
        assets: { fonts: [], hdris: [] },
        scene: { items: [], backgroundColor: '#202020', showGrid: true, showAxes: true, worldLight: clone(DEFAULT_WORLD_LIGHT) },
        selection: { itemId: null },
        view: {
            cameraMode: 'orbit',
            projection: 'perspective',
            navigationMode: 'free',
            lockedView: 'front',
            lockedRotation: null,
            orthoZoom: 1,
            wheelMode: 'travel',
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
            exportEngine: 'pathtrace',
            samplesTarget: 256,
            currentSamples: 0,
            exposure: 1,
            toneMapping: 'aces',
            outputWidth: 1920,
            outputHeight: 1080,
            lastJobSamples: 256,
            bounces: 10,
            transmissiveBounces: 10,
            filterGlossyFactor: 0,
            denoiseEnabled: false,
            denoiseSigma: 5,
            denoiseThreshold: 0.03,
            denoiseKSigma: 1
        },
        renderJob: { active: false, status: 'idle', requestedSamples: 0, currentSamples: 0, outputWidth: 0, outputHeight: 0, startedAt: 0, finishedAt: 0, fileName: '', message: '' },
        preview: { imageData: '', width: 0, height: 0, updatedAt: 0 }
    };
}

export function normalizeThreeDDocument(document) {
    const base = createEmptyThreeDDocument();
    const source = document && typeof document === 'object' ? document : {};
    const requestedRenderMode = String(source.render?.mode || '').toLowerCase();
    const requestedExportEngine = String(source.render?.exportEngine || '').toLowerCase();
    const hasExplicitRenderMode = source.render && Object.prototype.hasOwnProperty.call(source.render, 'mode');
    const normalizedRenderMode = RENDER_MODES.has(requestedRenderMode)
        ? requestedRenderMode
        : (hasExplicitRenderMode ? 'pathtrace' : 'raster');
    const normalizedExportEngine = EXPORT_ENGINES.has(requestedExportEngine) ? requestedExportEngine : 'pathtrace';
    const assets = {
        fonts: (Array.isArray(source.assets?.fonts) ? source.assets.fonts : []).map((asset, index) => normalizeAsset(asset, 'font', index)).filter(Boolean),
        hdris: (Array.isArray(source.assets?.hdris) ? source.assets.hdris : []).map((asset, index) => normalizeAsset(asset, 'hdri', index)).filter(Boolean)
    };
    const hdriIds = new Set(assets.hdris.map((asset) => asset.id));
    const fontIds = new Set(assets.fonts.map((asset) => asset.id));
    const items = (Array.isArray(source.scene?.items) ? source.scene.items : []).map(normalizeItem).filter((item) => item.kind === 'light' || item.kind === 'primitive' || item.kind === 'text' || item.kind === 'shape-2d' || item.asset?.dataUrl);
    const cleanedItems = items.map((item) => item.kind === 'text' && item.text.fontSource.type === 'upload' && !fontIds.has(item.text.fontSource.assetId)
        ? { ...item, text: { ...item.text, mode: item.text.mode === 'extruded' ? 'flat' : item.text.mode, fontSource: { type: 'system', assetId: null, family: 'Arial' } } }
        : item);
    const selectedId = cleanedItems.some((item) => item.id === source.selection?.itemId) ? source.selection.itemId : null;
    const view = {
        cameraMode: CAMERA_MODES.has(String(source.view?.cameraMode || '').toLowerCase()) ? String(source.view.cameraMode).toLowerCase() : base.view.cameraMode,
        projection: PROJECTIONS.has(String(source.view?.projection || '').toLowerCase()) ? String(source.view.projection).toLowerCase() : base.view.projection,
        navigationMode: NAVIGATION_MODES.has(String(source.view?.navigationMode || '').toLowerCase()) ? String(source.view.navigationMode).toLowerCase() : base.view.navigationMode,
        lockedView: LOCKED_VIEWS.has(String(source.view?.lockedView || '').toLowerCase()) ? String(source.view.lockedView).toLowerCase() : base.view.lockedView,
        lockedRotation: quat(source.view?.lockedRotation),
        orthoZoom: num(source.view?.orthoZoom, base.view.orthoZoom, 0.05, 100),
        wheelMode: WHEEL_MODES.has(String(source.view?.wheelMode || '').toLowerCase()) ? String(source.view.wheelMode).toLowerCase() : base.view.wheelMode,
        linkPlaneScale: source.view?.linkPlaneScale !== false,
        snapTranslationStep: num(source.view?.snapTranslationStep, 0, 0, 1000),
        snapRotationDegrees: num(source.view?.snapRotationDegrees, 0, 0, 360),
        cameraPosition: vec3(source.view?.cameraPosition, base.view.cameraPosition),
        cameraTarget: vec3(source.view?.cameraTarget, base.view.cameraTarget),
        fov: num(source.view?.fov, base.view.fov, 15, 120),
        near: num(source.view?.near, base.view.near, 0.01, 100),
        far: num(source.view?.far, base.view.far, 10, 10000),
        presets: (Array.isArray(source.view?.presets) ? source.view.presets : []).map((preset, index) => normalizePreset(preset, index, base.view))
    };
    return {
        version: 'mns/v2',
        kind: '3d-document',
        mode: '3d',
        workspace: normalizeWorkspace(source.workspace),
        assets,
        scene: {
            items: cleanedItems.map((item) => item.kind === 'text' && item.text.attachment && !cleanedItems.some((candidate) => candidate.id === item.text.attachment.targetItemId) ? ({ ...item, text: { ...item.text, attachment: null } }) : item),
            backgroundColor: hex(source.scene?.backgroundColor, base.scene.backgroundColor),
            showGrid: source.scene?.showGrid !== false,
            showAxes: !!source.scene?.showAxes,
            worldLight: normalizeWorldLight(source.scene?.worldLight, hdriIds)
        },
        selection: { itemId: selectedId },
        view,
        render: {
            mode: normalizedRenderMode,
            exportEngine: normalizedExportEngine,
            samplesTarget: round(source.render?.samplesTarget, 256, 1, 4096),
            currentSamples: round(source.render?.currentSamples, 0, 0, 1000000),
            exposure: num(source.render?.exposure, 1, 0.05, 10),
            toneMapping: TONE_MAPPINGS.has(String(source.render?.toneMapping || '').toLowerCase()) ? String(source.render.toneMapping).toLowerCase() : 'aces',
            outputWidth: round(source.render?.outputWidth, 1920, 16, 32768),
            outputHeight: round(source.render?.outputHeight, 1080, 16, 32768),
            lastJobSamples: round(source.render?.lastJobSamples, 256, 1, 1000000),
            bounces: round(source.render?.bounces, 10, 1, 64),
            transmissiveBounces: round(source.render?.transmissiveBounces, 10, 0, 64),
            filterGlossyFactor: num(source.render?.filterGlossyFactor, 0, 0, 2),
            denoiseEnabled: !!source.render?.denoiseEnabled,
            denoiseSigma: num(source.render?.denoiseSigma, 5, 0.1, 20),
            denoiseThreshold: num(source.render?.denoiseThreshold, 0.03, 0.0001, 1),
            denoiseKSigma: num(source.render?.denoiseKSigma, 1, 0.1, 5)
        },
        renderJob: {
            active: !!source.renderJob?.active,
            status: RENDER_JOB_STATUSES.has(String(source.renderJob?.status || '').toLowerCase()) ? String(source.renderJob.status).toLowerCase() : 'idle',
            requestedSamples: round(source.renderJob?.requestedSamples, 0, 0, 1000000),
            currentSamples: round(source.renderJob?.currentSamples, 0, 0, 1000000),
            outputWidth: round(source.renderJob?.outputWidth, 0, 0, 32768),
            outputHeight: round(source.renderJob?.outputHeight, 0, 0, 32768),
            startedAt: round(source.renderJob?.startedAt, 0, 0),
            finishedAt: round(source.renderJob?.finishedAt, 0, 0),
            fileName: String(source.renderJob?.fileName || ''),
            message: String(source.renderJob?.message || '')
        },
        preview: {
            imageData: typeof source.preview?.imageData === 'string' ? source.preview.imageData : '',
            width: round(source.preview?.width, 0, 0),
            height: round(source.preview?.height, 0, 0),
            updatedAt: round(source.preview?.updatedAt, 0, 0)
        }
    };
}

export function serializeThreeDDocument(document) {
    return clone(normalizeThreeDDocument(document));
}

export function isThreeDDocumentPayload(payload) {
    return !!payload && (payload.kind === '3d-document' || payload.mode === '3d' || payload.schema === '3d-document');
}

export function createThreeDSceneItemId(prefix = 'item') {
    return createId(prefix);
}

export function createThreeDCameraPresetId(prefix = 'camera') {
    return createId(prefix);
}

export function createThreeDAssetId(prefix = 'asset') {
    return createId(prefix);
}

export function summarizeThreeDDocument(document) {
    const normalized = normalizeThreeDDocument(document);
    const byKind = (kind) => normalized.scene.items.filter((item) => item.kind === kind).length;
    const previewWidth = Number(normalized.preview.width || 0);
    const previewHeight = Number(normalized.preview.height || 0);
    const assetCount = byKind('model') + byKind('image-plane') + byKind('primitive') + byKind('text') + byKind('shape-2d');
    return {
        itemCount: normalized.scene.items.length,
        assetCount,
        modelCount: byKind('model'),
        imagePlaneCount: byKind('image-plane'),
        primitiveCount: byKind('primitive'),
        textCount: byKind('text'),
        shapeCount: byKind('shape-2d'),
        lightCount: byKind('light'),
        primarySource: null,
        sourceWidth: previewWidth,
        sourceHeight: previewHeight,
        sourceArea: previewWidth * previewHeight,
        sourceCount: assetCount,
        renderWidth: previewWidth,
        renderHeight: previewHeight
    };
}
