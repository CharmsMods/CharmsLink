import { computeWarpBounds, normalizeWarpData } from './warp.js';

const DEFAULT_EXPORT_BACKGROUND = '#ffffff';
const DEFAULT_ANALYSIS_MAX_DIMENSION = 2048;
const DEFAULT_MAX_FEATURES = 4000;
const DEFAULT_MATCH_RATIO = 0.75;
const DEFAULT_RANSAC_ITERATIONS = 5000;
const DEFAULT_INLIER_THRESHOLD = 4.5;
const DEFAULT_MAX_CANDIDATES = 8;
const DEFAULT_PADDING = 32;
const INPUT_GAP = 48;
const SCENE_MODES = ['auto', 'screenshot', 'photo'];
const WARP_MODES = ['auto', 'off', 'perspective', 'mesh'];
const MESH_DENSITIES = ['low', 'medium', 'high'];
const WARP_DISTRIBUTIONS = ['anchored', 'balanced'];
const BLEND_MODES = ['auto', 'alpha', 'feather', 'seam'];
const FEATURE_DETECTORS = ['auto', 'orb', 'akaze', 'sift'];
const PHOTO_BACKENDS = ['opencv-wasm'];
const ANALYSIS_BACKENDS = ['screenshot-js', 'opencv-wasm'];
const STITCH_SIDEBAR_VIEWS = new Set(['inputs', 'analysis', 'selection', 'candidates']);
const LEGACY_DEFAULTS = Object.freeze({
    analysisMaxDimension: 320,
    maxFeatures: 120,
    matchRatio: 0.8,
    ransacIterations: 180,
    inlierThreshold: 18
});

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function roundValue(value, decimals = 3) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const factor = 10 ** decimals;
    return Math.round(numeric * factor) / factor;
}

function copyPlacement(placement = {}) {
    return {
        inputId: placement.inputId || '',
        x: roundValue(placement.x || 0),
        y: roundValue(placement.y || 0),
        scale: roundValue(Math.max(0.01, Number(placement.scale) || 1)),
        rotation: roundValue(Number(placement.rotation) || 0),
        visible: placement.visible !== false,
        locked: !!placement.locked,
        z: Number.isFinite(Number(placement.z)) ? Number(placement.z) : 0,
        opacity: roundValue(clamp(Number(placement.opacity) || 1, 0, 1)),
        warp: normalizeWarpData(placement.warp)
    };
}

function createDefaultPlacement(input, index = 0, override = {}) {
    return copyPlacement({
        inputId: input.id,
        x: override.x || 0,
        y: override.y || 0,
        scale: override.scale || 1,
        rotation: override.rotation || 0,
        visible: override.visible ?? true,
        locked: override.locked ?? false,
        z: override.z ?? index,
        opacity: override.opacity ?? 1
    });
}

export function createStitchViewState(view = {}) {
    return {
        theme: view.theme === 'dark' ? 'dark' : 'light',
        zoom: Math.max(0.2, Number(view.zoom) || 1),
        panX: Number(view.panX) || 0,
        panY: Number(view.panY) || 0,
        zoomLocked: !!view.zoomLocked,
        showLabels: view.showLabels !== false,
        showBounds: view.showBounds !== false
    };
}

export function createEmptyStitchDocument(theme = 'light') {
    return {
        version: 'mns/v2',
        kind: 'stitch-document',
        mode: 'stitch',
        workspace: {
            galleryOpen: false,
            alternativesOpen: true,
            sidebarView: 'inputs'
        },
        inputs: [],
        settings: {
            analysisMaxDimension: DEFAULT_ANALYSIS_MAX_DIMENSION,
            useFullResolutionAnalysis: true,
            sceneMode: 'auto',
            warpMode: 'mesh',
            meshDensity: 'high',
            warpDistribution: 'balanced',
            blendMode: 'auto',
            photoBackend: 'opencv-wasm',
            featureDetector: 'auto',
            maxFeatures: DEFAULT_MAX_FEATURES,
            matchRatio: DEFAULT_MATCH_RATIO,
            ransacIterations: DEFAULT_RANSAC_ITERATIONS,
            inlierThreshold: DEFAULT_INLIER_THRESHOLD,
            maxCandidates: DEFAULT_MAX_CANDIDATES
        },
        candidates: [],
        activeCandidateId: null,
        placements: [],
        selection: {
            inputId: null
        },
        view: createStitchViewState({ theme }),
        export: {
            padding: DEFAULT_PADDING,
            background: DEFAULT_EXPORT_BACKGROUND
        },
        analysis: {
            status: 'idle',
            warning: '',
            error: '',
            lastRunAt: 0,
            backend: '',
            diagnostics: [],
            previews: {}
        }
    };
}

function normalizeInput(input, index = 0) {
    const id = String(input?.id || `stitch-input-${index + 1}`);
    const width = Math.max(1, Number(input?.width || 1));
    const height = Math.max(1, Number(input?.height || 1));
    return {
        id,
        name: String(input?.name || `Input ${index + 1}`),
        type: String(input?.type || 'image/png'),
        imageData: String(input?.imageData || ''),
        width,
        height
    };
}

export function coerceStitchSettingValue(key, value) {
    if (key === 'useFullResolutionAnalysis') return !!value;
    if (key === 'sceneMode') return SCENE_MODES.includes(value) ? value : 'auto';
    if (key === 'warpMode') return WARP_MODES.includes(value) ? value : 'auto';
    if (key === 'meshDensity') return MESH_DENSITIES.includes(value) ? value : 'medium';
    if (key === 'warpDistribution') return WARP_DISTRIBUTIONS.includes(value) ? value : 'balanced';
    if (key === 'blendMode') return BLEND_MODES.includes(value) ? value : 'auto';
    if (key === 'photoBackend') return PHOTO_BACKENDS.includes(value) ? value : 'opencv-wasm';
    if (key === 'featureDetector') return FEATURE_DETECTORS.includes(value) ? value : 'auto';
    if (key === 'analysisMaxDimension') return clamp(Math.round(Number(value) || DEFAULT_ANALYSIS_MAX_DIMENSION), 128, 2048);
    if (key === 'maxFeatures') return clamp(Math.round(Number(value) || DEFAULT_MAX_FEATURES), 20, 4000);
    if (key === 'matchRatio') return clamp(Number(value) || DEFAULT_MATCH_RATIO, 0.4, 0.99);
    if (key === 'ransacIterations') return clamp(Math.round(Number(value) || DEFAULT_RANSAC_ITERATIONS), 40, 5000);
    if (key === 'inlierThreshold') return clamp(Number(value) || DEFAULT_INLIER_THRESHOLD, 0.5, 48);
    if (key === 'maxCandidates') return clamp(Math.round(Number(value) || DEFAULT_MAX_CANDIDATES), 1, 12);
    return value;
}

function hasLegacyDefaultAnalysisTuple(settings = {}) {
    return Number(settings?.analysisMaxDimension) === LEGACY_DEFAULTS.analysisMaxDimension
        && Number(settings?.maxFeatures) === LEGACY_DEFAULTS.maxFeatures
        && Number(settings?.matchRatio) === LEGACY_DEFAULTS.matchRatio
        && Number(settings?.ransacIterations) === LEGACY_DEFAULTS.ransacIterations
        && Number(settings?.inlierThreshold) === LEGACY_DEFAULTS.inlierThreshold;
}

function normalizeSettings(settings = {}) {
    const useUpgradedDefaults = settings?.photoBackend == null && hasLegacyDefaultAnalysisTuple(settings);
    return {
        analysisMaxDimension: coerceStitchSettingValue('analysisMaxDimension', useUpgradedDefaults ? DEFAULT_ANALYSIS_MAX_DIMENSION : settings.analysisMaxDimension),
        useFullResolutionAnalysis: coerceStitchSettingValue('useFullResolutionAnalysis', settings.useFullResolutionAnalysis),
        sceneMode: coerceStitchSettingValue('sceneMode', settings.sceneMode),
        warpMode: coerceStitchSettingValue('warpMode', settings.warpMode),
        meshDensity: coerceStitchSettingValue('meshDensity', settings.meshDensity),
        warpDistribution: coerceStitchSettingValue('warpDistribution', settings.warpDistribution),
        blendMode: coerceStitchSettingValue('blendMode', settings.blendMode),
        photoBackend: coerceStitchSettingValue('photoBackend', settings.photoBackend),
        featureDetector: coerceStitchSettingValue('featureDetector', settings.featureDetector),
        maxFeatures: coerceStitchSettingValue('maxFeatures', useUpgradedDefaults ? DEFAULT_MAX_FEATURES : settings.maxFeatures),
        matchRatio: coerceStitchSettingValue('matchRatio', useUpgradedDefaults ? DEFAULT_MATCH_RATIO : settings.matchRatio),
        ransacIterations: coerceStitchSettingValue('ransacIterations', useUpgradedDefaults ? DEFAULT_RANSAC_ITERATIONS : settings.ransacIterations),
        inlierThreshold: coerceStitchSettingValue('inlierThreshold', useUpgradedDefaults ? DEFAULT_INLIER_THRESHOLD : settings.inlierThreshold),
        maxCandidates: coerceStitchSettingValue('maxCandidates', settings.maxCandidates)
    };
}

function normalizeCandidates(candidates = []) {
    return (Array.isArray(candidates) ? candidates : []).map((candidate, index) => ({
        id: String(candidate?.id || `candidate-${index + 1}`),
        name: String(candidate?.name || `Candidate ${index + 1}`),
        score: Number(candidate?.score) || 0,
        confidence: clamp(Number(candidate?.confidence) || 0, 0, 1),
        rank: Math.max(1, Math.round(Number(candidate?.rank) || (index + 1))),
        source: String(candidate?.source || 'analysis'),
        modelType: String(candidate?.modelType || 'rigid'),
        blendMode: coerceStitchSettingValue('blendMode', candidate?.blendMode),
        coverage: clamp(Number(candidate?.coverage) || 0, 0, 1),
        placements: (Array.isArray(candidate?.placements) ? candidate.placements : []).map((placement) => copyPlacement(placement)),
        diagnostics: Array.isArray(candidate?.diagnostics) ? candidate.diagnostics : [],
        warning: String(candidate?.warning || '')
    }));
}

export function normalizeStitchDocument(document = {}) {
    const fallback = createEmptyStitchDocument(document?.view?.theme || 'light');
    const inputs = (Array.isArray(document.inputs) ? document.inputs : []).map((input, index) => normalizeInput(input, index));
    const placements = (Array.isArray(document.placements) ? document.placements : [])
        .map((placement) => copyPlacement(placement))
        .filter((placement) => inputs.some((input) => input.id === placement.inputId));

    const completePlacements = inputs.map((input, index) => {
        const existing = placements.find((placement) => placement.inputId === input.id);
        return existing ? copyPlacement({ ...existing, z: existing.z ?? index }) : createDefaultPlacement(input, index);
    });

    const candidates = normalizeCandidates(document.candidates);
    const activeCandidateId = candidates.some((candidate) => candidate.id === document.activeCandidateId)
        ? document.activeCandidateId
        : (candidates[0]?.id || null);

    return {
        ...fallback,
        ...document,
        version: 'mns/v2',
        kind: 'stitch-document',
        mode: 'stitch',
        workspace: {
            ...fallback.workspace,
            ...(document.workspace || {}),
            sidebarView: STITCH_SIDEBAR_VIEWS.has(String(document.workspace?.sidebarView || '').toLowerCase())
                ? String(document.workspace.sidebarView).toLowerCase()
                : fallback.workspace.sidebarView
        },
        inputs,
        settings: normalizeSettings(document.settings),
        candidates,
        activeCandidateId,
        placements: completePlacements,
        selection: {
            inputId: inputs.some((input) => input.id === document.selection?.inputId)
                ? document.selection.inputId
                : (inputs[0]?.id || null)
        },
        view: createStitchViewState(document.view),
        export: {
            padding: clamp(Math.round(Number(document.export?.padding) || DEFAULT_PADDING), 0, 512),
            background: typeof document.export?.background === 'string' && document.export.background
                ? document.export.background
                : DEFAULT_EXPORT_BACKGROUND
        },
        analysis: {
            status: ['idle', 'running', 'ready', 'error'].includes(document.analysis?.status) ? document.analysis.status : 'idle',
            warning: String(document.analysis?.warning || ''),
            error: String(document.analysis?.error || ''),
            lastRunAt: Number(document.analysis?.lastRunAt) || 0,
            backend: ANALYSIS_BACKENDS.includes(document.analysis?.backend) ? document.analysis.backend : '',
            diagnostics: Array.isArray(document.analysis?.diagnostics) ? document.analysis.diagnostics : [],
            previews: document.analysis?.previews && typeof document.analysis.previews === 'object'
                ? document.analysis.previews
                : {}
        }
    };
}

export function createStitchInputId() {
    return `stitch-input-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createStitchCandidateId() {
    return `stitch-candidate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function getPlacementByInput(document, inputId) {
    return document?.placements?.find((placement) => placement.inputId === inputId) || null;
}

export function getSelectedStitchInput(document) {
    return document?.inputs?.find((input) => input.id === document?.selection?.inputId) || null;
}

export function getActivePlacements(document) {
    const normalized = normalizeStitchDocument(document);
    return [...normalized.placements]
        .filter((placement) => normalized.inputs.some((input) => input.id === placement.inputId))
        .sort((a, b) => (a.z || 0) - (b.z || 0));
}

export function updatePlacement(document, inputId, patch) {
    const normalized = normalizeStitchDocument(document);
    return {
        ...normalized,
        placements: normalized.placements.map((placement) => placement.inputId === inputId ? copyPlacement({ ...placement, ...patch }) : placement)
    };
}

export function updateInputOrder(document, inputId, direction) {
    const normalized = normalizeStitchDocument(document);
    const placements = [...normalized.placements].sort((a, b) => (a.z || 0) - (b.z || 0));
    const index = placements.findIndex((placement) => placement.inputId === inputId);
    if (index === -1) return normalized;
    const targetIndex = clamp(index + direction, 0, placements.length - 1);
    if (targetIndex === index) return normalized;
    const [item] = placements.splice(index, 1);
    placements.splice(targetIndex, 0, item);
    return {
        ...normalized,
        placements: placements.map((placement, placementIndex) => copyPlacement({ ...placement, z: placementIndex }))
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

export function computePlacementBounds(input, placement) {
    if (placement?.warp) return computeWarpBounds(input, placement);
    const width = Math.max(1, Number(input?.width) || 1);
    const height = Math.max(1, Number(input?.height) || 1);
    const scale = Math.max(0.01, Number(placement?.scale) || 1);
    const rotation = Number(placement?.rotation) || 0;
    const corners = [
        rotatePoint(0, 0, rotation),
        rotatePoint(width * scale, 0, rotation),
        rotatePoint(0, height * scale, rotation),
        rotatePoint(width * scale, height * scale, rotation)
    ].map((corner) => ({
        x: corner.x + (Number(placement?.x) || 0),
        y: corner.y + (Number(placement?.y) || 0)
    }));
    const xs = corners.map((corner) => corner.x);
    const ys = corners.map((corner) => corner.y);
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
    };
}

export function computeCompositeBounds(document, placementsOverride = null) {
    const normalized = normalizeStitchDocument(document);
    const placements = Array.isArray(placementsOverride) ? placementsOverride.map((placement) => copyPlacement(placement)) : getActivePlacements(normalized);
    const visiblePlacements = placements.filter((placement) => placement.visible !== false);
    if (!visiblePlacements.length) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            width: 0,
            height: 0
        };
    }
    const boxes = visiblePlacements.map((placement) => {
        const input = normalized.inputs.find((item) => item.id === placement.inputId);
        return computePlacementBounds(input, placement);
    });
    const minX = Math.min(...boxes.map((box) => box.minX));
    const minY = Math.min(...boxes.map((box) => box.minY));
    const maxX = Math.max(...boxes.map((box) => box.maxX));
    const maxY = Math.max(...boxes.map((box) => box.maxY));
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}

export function buildManualLayoutCandidate(inputs, reason = '') {
    let cursorX = 0;
    const placements = inputs.map((input, index) => {
        const placement = createDefaultPlacement(input, index, {
            x: cursorX,
            y: 0,
            z: index
        });
        cursorX += input.width + INPUT_GAP;
        return placement;
    });
    return {
        id: createStitchCandidateId(),
        name: inputs.length > 1 ? 'Manual Layout' : 'Single Image',
        score: inputs.length ? 0.01 : 0,
        confidence: inputs.length ? 0.08 : 0,
        rank: 1,
        source: 'manual',
        modelType: 'manual',
        blendMode: 'alpha',
        coverage: inputs.length ? 1 : 0,
        placements,
        diagnostics: [],
        warning: reason || ''
    };
}

export function applyCandidateToDocument(document, candidateId) {
    const normalized = normalizeStitchDocument(document);
    const candidate = normalized.candidates.find((item) => item.id === candidateId);
    if (!candidate) return normalized;
    const placements = normalized.inputs.map((input, index) => {
        const existing = candidate.placements.find((placement) => placement.inputId === input.id);
        return existing ? copyPlacement({ ...existing, z: existing.z ?? index }) : createDefaultPlacement(input, index);
    });
    return {
        ...normalized,
        activeCandidateId: candidate.id,
        placements,
        selection: {
            inputId: normalized.selection.inputId && normalized.inputs.some((input) => input.id === normalized.selection.inputId)
                ? normalized.selection.inputId
                : (placements[0]?.inputId || null)
        }
    };
}

export function stripEphemeralStitchState(document) {
    const normalized = normalizeStitchDocument(document);
    return {
        version: 'mns/v2',
        kind: 'stitch-document',
        mode: 'stitch',
        workspace: {
            galleryOpen: false,
            alternativesOpen: normalized.workspace.alternativesOpen !== false,
            sidebarView: normalized.workspace.sidebarView || 'inputs'
        },
        inputs: normalized.inputs.map((input) => ({
            id: input.id,
            name: input.name,
            type: input.type,
            imageData: input.imageData,
            width: input.width,
            height: input.height
        })),
        settings: { ...normalized.settings },
        candidates: normalized.candidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            score: candidate.score,
            confidence: candidate.confidence,
            rank: candidate.rank,
            source: candidate.source,
            modelType: candidate.modelType,
            blendMode: candidate.blendMode,
            coverage: candidate.coverage,
            placements: candidate.placements.map((placement) => copyPlacement(placement)),
            diagnostics: candidate.diagnostics,
            warning: candidate.warning
        })),
        activeCandidateId: normalized.activeCandidateId,
        placements: normalized.placements.map((placement) => copyPlacement(placement)),
        selection: { ...normalized.selection },
        view: createStitchViewState(normalized.view),
        export: { ...normalized.export },
        analysis: {
            status: normalized.analysis.status,
            warning: normalized.analysis.warning,
            error: normalized.analysis.error,
            lastRunAt: normalized.analysis.lastRunAt,
            diagnostics: normalized.analysis.diagnostics,
            previews: {}
        }
    };
}

export function buildInitialPlacementsFromCandidate(document, candidatePlacements) {
    const normalized = normalizeStitchDocument(document);
    return normalized.inputs.map((input, index) => {
        const existing = candidatePlacements.find((placement) => placement.inputId === input.id);
        return existing ? copyPlacement({ ...existing, z: existing.z ?? index }) : createDefaultPlacement(input, index);
    });
}

export function getPrimaryStitchInput(document) {
    return normalizeStitchDocument(document).inputs[0] || null;
}

export function getAggregateInputArea(document) {
    return normalizeStitchDocument(document).inputs.reduce((total, input) => total + ((input.width || 0) * (input.height || 0)), 0);
}

export function summarizeStitchDocument(document) {
    const normalized = normalizeStitchDocument(document);
    const primary = getPrimaryStitchInput(normalized);
    const bounds = computeCompositeBounds(normalized);
    const activeCandidate = normalized.candidates.find((candidate) => candidate.id === normalized.activeCandidateId) || null;
    return {
        primarySource: primary ? {
            name: primary.name,
            type: primary.type,
            imageData: primary.imageData,
            width: primary.width,
            height: primary.height
        } : null,
        sourceWidth: primary?.width || 0,
        sourceHeight: primary?.height || 0,
        sourceArea: getAggregateInputArea(normalized),
        sourceCount: normalized.inputs.length,
        renderWidth: Math.max(0, Math.round(bounds.width)),
        renderHeight: Math.max(0, Math.round(bounds.height)),
        activeModelType: activeCandidate?.modelType || 'rigid',
        activeConfidence: Number(activeCandidate?.confidence || 0) || 0
    };
}
