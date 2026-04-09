import { createDefaultAppSettings, SETTINGS_SCHEMA_VERSION } from './defaults.js';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeFiniteNumber(value, fallback, min = -Infinity, max = Infinity) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return clamp(numeric, min, max);
}

function normalizeInteger(value, fallback, min = -Infinity, max = Infinity) {
    return Math.round(normalizeFiniteNumber(value, fallback, min, max));
}

function normalizeChoice(value, fallback, allowed) {
    return allowed.has(value) ? value : fallback;
}

function normalizeWorkerCapabilities(source = {}) {
    if (!source || typeof source !== 'object') return {};
    return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, !!value]));
}

function normalizeStringArray(source = []) {
    return Array.from(new Set((Array.isArray(source) ? source : [])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)));
}

function normalizeDiagnostics(source = {}, defaults) {
    return {
        detectedCpuCores: normalizeInteger(source.detectedCpuCores, defaults.detectedCpuCores, 0, 512),
        workerCapabilities: normalizeWorkerCapabilities(source.workerCapabilities || {}),
        assetVersion: String(source.assetVersion || defaults.assetVersion || ''),
        workerLimitApplied: normalizeInteger(source.workerLimitApplied, defaults.workerLimitApplied, 0, 512),
        storageEstimate: source.storageEstimate && typeof source.storageEstimate === 'object'
            ? {
                usage: normalizeFiniteNumber(source.storageEstimate.usage, 0, 0),
                quota: normalizeFiniteNumber(source.storageEstimate.quota, 0, 0),
                ratio: normalizeFiniteNumber(source.storageEstimate.ratio, 0, 0, 1)
            }
            : null
    };
}

function normalizeCompositeDiagnostics(source = {}, defaults) {
    return {
        workerAvailable: typeof source.workerAvailable === 'boolean'
            ? source.workerAvailable
            : defaults.workerAvailable,
        offscreenCanvas2d: typeof source.offscreenCanvas2d === 'boolean'
            ? source.offscreenCanvas2d
            : defaults.offscreenCanvas2d,
        createImageBitmap: typeof source.createImageBitmap === 'boolean'
            ? source.createImageBitmap
            : defaults.createImageBitmap,
        webglAvailable: typeof source.webglAvailable === 'boolean'
            ? source.webglAvailable
            : defaults.webglAvailable,
        webgl2Available: typeof source.webgl2Available === 'boolean'
            ? source.webgl2Available
            : defaults.webgl2Available,
        maxTextureSize: normalizeInteger(source.maxTextureSize, defaults.maxTextureSize, 0, 131072),
        maxRenderbufferSize: normalizeInteger(source.maxRenderbufferSize, defaults.maxRenderbufferSize, 0, 131072),
        maxViewportWidth: normalizeInteger(source.maxViewportWidth, defaults.maxViewportWidth, 0, 131072),
        maxViewportHeight: normalizeInteger(source.maxViewportHeight, defaults.maxViewportHeight, 0, 131072),
        gpuSafeMaxEdge: normalizeInteger(source.gpuSafeMaxEdge, defaults.gpuSafeMaxEdge, 0, 131072),
        autoWorkerThresholdMegapixels: normalizeFiniteNumber(
            source.autoWorkerThresholdMegapixels,
            defaults.autoWorkerThresholdMegapixels,
            0.1,
            1048576
        ),
        autoWorkerThresholdEdge: normalizeInteger(
            source.autoWorkerThresholdEdge,
            defaults.autoWorkerThresholdEdge,
            1,
            131072
        )
    };
}

export function normalizeSettingsCategory(category) {
    const normalized = String(category || '').trim().toLowerCase();
    if (normalized === 'general' || normalized === 'library' || normalized === 'editor' || normalized === 'composite' || normalized === 'stitch' || normalized === '3d' || normalized === 'logs') {
        return normalized;
    }
    return 'general';
}

export function normalizeAppSettings(candidate = {}, options = {}) {
    const defaults = createDefaultAppSettings();
    const general = candidate.general && typeof candidate.general === 'object' ? candidate.general : {};
    const library = candidate.library && typeof candidate.library === 'object' ? candidate.library : {};
    const editor = candidate.editor && typeof candidate.editor === 'object' ? candidate.editor : {};
    const composite = candidate.composite && typeof candidate.composite === 'object' ? candidate.composite : {};
    const compositePreferences = composite.preferences && typeof composite.preferences === 'object' ? composite.preferences : {};
    const compositeDiagnostics = options.compositeDiagnostics
        || (composite.diagnostics && typeof composite.diagnostics === 'object' ? composite.diagnostics : {});
    const stitch = candidate.stitch && typeof candidate.stitch === 'object' ? candidate.stitch : {};
    const stitchDefaults = stitch.defaults && typeof stitch.defaults === 'object' ? stitch.defaults : {};
    const stitchDiagnostics = options.stitchDiagnostics
        || (stitch.diagnostics && typeof stitch.diagnostics === 'object' ? stitch.diagnostics : {});
    const threeD = candidate.threeD && typeof candidate.threeD === 'object' ? candidate.threeD : {};
    const threeDPreferences = threeD.preferences && typeof threeD.preferences === 'object' ? threeD.preferences : {};
    const threeDDefaults = threeD.defaults && typeof threeD.defaults === 'object' ? threeD.defaults : {};
    const logs = candidate.logs && typeof candidate.logs === 'object' ? candidate.logs : {};
    const diagnosticsSource = options.diagnostics || candidate.diagnostics || {};

    return {
        version: SETTINGS_SCHEMA_VERSION,
        general: {
            theme: normalizeChoice(String(general.theme || '').toLowerCase(), defaults.general.theme, new Set(['light', 'dark'])),
            saveImageOnSave: !!general.saveImageOnSave,
            maxBackgroundWorkers: normalizeInteger(general.maxBackgroundWorkers, defaults.general.maxBackgroundWorkers, 0, 64)
        },
        library: {
            autoLoadOnStartup: !!library.autoLoadOnStartup,
            storagePressureThreshold: normalizeFiniteNumber(library.storagePressureThreshold, defaults.library.storagePressureThreshold, 0.1, 0.98),
            defaultViewLayout: normalizeChoice(String(library.defaultViewLayout || '').toLowerCase(), defaults.library.defaultViewLayout, new Set(['grid', 'list'])),
            defaultSortKey: normalizeChoice(String(library.defaultSortKey || '').toLowerCase(), defaults.library.defaultSortKey, new Set(['timestamp', 'name', 'source-area', 'render-area'])),
            defaultSortDirection: normalizeChoice(String(library.defaultSortDirection || '').toLowerCase(), defaults.library.defaultSortDirection, new Set(['asc', 'desc'])),
            assetPreviewQuality: normalizeChoice(String(library.assetPreviewQuality || '').toLowerCase(), defaults.library.assetPreviewQuality, new Set(['performance', 'balanced', 'quality'])),
            secureExportByDefault: typeof library.secureExportByDefault === 'boolean'
                ? library.secureExportByDefault
                : defaults.library.secureExportByDefault,
            requireTagOnImport: !!library.requireTagOnImport
        },
        editor: {
            defaultHighQualityPreview: !!editor.defaultHighQualityPreview,
            hoverCompareOriginal: typeof editor.hoverCompareOriginal === 'boolean'
                ? editor.hoverCompareOriginal
                : defaults.editor.hoverCompareOriginal,
            isolateActiveLayerChain: !!editor.isolateActiveLayerChain,
            layerPreviewsOpen: !!editor.layerPreviewsOpen,
            autoExtractPaletteOnLoad: !!editor.autoExtractPaletteOnLoad,
            transparencyCheckerTone: normalizeChoice(String(editor.transparencyCheckerTone || '').toLowerCase(), defaults.editor.transparencyCheckerTone, new Set(['light', 'dark']))
        },
        composite: {
            preferences: {
                showChecker: typeof compositePreferences.showChecker === 'boolean'
                    ? compositePreferences.showChecker
                    : defaults.composite.preferences.showChecker,
                zoomLocked: typeof compositePreferences.zoomLocked === 'boolean'
                    ? compositePreferences.zoomLocked
                    : defaults.composite.preferences.zoomLocked,
                exportBackend: normalizeChoice(
                    String(compositePreferences.exportBackend || '').toLowerCase(),
                    defaults.composite.preferences.exportBackend,
                    new Set(['auto', 'worker', 'main-thread'])
                )
            },
            diagnostics: normalizeCompositeDiagnostics(compositeDiagnostics, defaults.composite.diagnostics)
        },
        stitch: {
            defaults: {
                sceneMode: normalizeChoice(String(stitchDefaults.sceneMode || '').toLowerCase(), defaults.stitch.defaults.sceneMode, new Set(['auto', 'screenshot', 'photo'])),
                blendMode: normalizeChoice(String(stitchDefaults.blendMode || '').toLowerCase(), defaults.stitch.defaults.blendMode, new Set(['auto', 'alpha', 'feather', 'seam'])),
                warpMode: normalizeChoice(String(stitchDefaults.warpMode || '').toLowerCase(), defaults.stitch.defaults.warpMode, new Set(['auto', 'off', 'perspective', 'mesh'])),
                meshDensity: normalizeChoice(String(stitchDefaults.meshDensity || '').toLowerCase(), defaults.stitch.defaults.meshDensity, new Set(['low', 'medium', 'high'])),
                warpDistribution: normalizeChoice(String(stitchDefaults.warpDistribution || '').toLowerCase(), defaults.stitch.defaults.warpDistribution, new Set(['anchored', 'balanced'])),
                analysisMaxDimension: normalizeInteger(stitchDefaults.analysisMaxDimension, defaults.stitch.defaults.analysisMaxDimension, 256, 2048),
                useFullResolutionAnalysis: typeof stitchDefaults.useFullResolutionAnalysis === 'boolean'
                    ? stitchDefaults.useFullResolutionAnalysis
                    : defaults.stitch.defaults.useFullResolutionAnalysis,
                featureDetector: normalizeChoice(String(stitchDefaults.featureDetector || '').toLowerCase(), defaults.stitch.defaults.featureDetector, new Set(['auto', 'orb', 'akaze', 'sift'])),
                maxFeatures: normalizeInteger(stitchDefaults.maxFeatures, defaults.stitch.defaults.maxFeatures, 200, 4000),
                matchRatio: normalizeFiniteNumber(stitchDefaults.matchRatio, defaults.stitch.defaults.matchRatio, 0.4, 0.99),
                ransacIterations: normalizeInteger(stitchDefaults.ransacIterations, defaults.stitch.defaults.ransacIterations, 100, 5000),
                inlierThreshold: normalizeFiniteNumber(stitchDefaults.inlierThreshold, defaults.stitch.defaults.inlierThreshold, 1, 48),
                maxCandidates: normalizeInteger(stitchDefaults.maxCandidates, defaults.stitch.defaults.maxCandidates, 1, 12)
            },
            diagnostics: {
                workerAvailable: typeof stitchDiagnostics.workerAvailable === 'boolean'
                    ? stitchDiagnostics.workerAvailable
                    : defaults.stitch.diagnostics.workerAvailable,
                wasmAvailable: typeof stitchDiagnostics.wasmAvailable === 'boolean'
                    ? stitchDiagnostics.wasmAvailable
                    : defaults.stitch.diagnostics.wasmAvailable,
                runtimeAvailable: typeof stitchDiagnostics.runtimeAvailable === 'boolean'
                    ? stitchDiagnostics.runtimeAvailable
                    : defaults.stitch.diagnostics.runtimeAvailable,
                supportedDetectors: normalizeStringArray(stitchDiagnostics.supportedDetectors || defaults.stitch.diagnostics.supportedDetectors),
                lastRuntimeSelection: String(stitchDiagnostics.lastRuntimeSelection || defaults.stitch.diagnostics.lastRuntimeSelection || ''),
                lastFallbackReason: String(stitchDiagnostics.lastFallbackReason || defaults.stitch.diagnostics.lastFallbackReason || '')
            }
        },
        threeD: {
            preferences: {
                cameraMode: normalizeChoice(String(threeDPreferences.cameraMode || '').toLowerCase(), defaults.threeD.preferences.cameraMode, new Set(['orbit', 'fly'])),
                navigationMode: normalizeChoice(String(threeDPreferences.navigationMode || '').toLowerCase(), defaults.threeD.preferences.navigationMode, new Set(['free', 'canvas'])),
                flyMoveSpeed: normalizeFiniteNumber(threeDPreferences.flyMoveSpeed, defaults.threeD.preferences.flyMoveSpeed, 0.25, 64),
                flyLookSensitivity: normalizeFiniteNumber(threeDPreferences.flyLookSensitivity, defaults.threeD.preferences.flyLookSensitivity, 0.0005, 0.03),
                fov: normalizeFiniteNumber(threeDPreferences.fov, defaults.threeD.preferences.fov, 15, 120),
                wheelMode: normalizeChoice(String(threeDPreferences.wheelMode || '').toLowerCase(), defaults.threeD.preferences.wheelMode, new Set(['travel', 'zoom'])),
                near: normalizeFiniteNumber(threeDPreferences.near, defaults.threeD.preferences.near, 0.01, 100),
                far: normalizeFiniteNumber(threeDPreferences.far, defaults.threeD.preferences.far, 10, 10000),
                showGrid: typeof threeDPreferences.showGrid === 'boolean'
                    ? threeDPreferences.showGrid
                    : defaults.threeD.preferences.showGrid,
                showAxes: !!threeDPreferences.showAxes,
                gizmoScale: normalizeFiniteNumber(threeDPreferences.gizmoScale, defaults.threeD.preferences.gizmoScale, 0.4, 4),
                snapTranslationStep: normalizeFiniteNumber(threeDPreferences.snapTranslationStep, defaults.threeD.preferences.snapTranslationStep, 0, 1000),
                snapRotationDegrees: normalizeFiniteNumber(threeDPreferences.snapRotationDegrees, defaults.threeD.preferences.snapRotationDegrees, 0, 360),
                viewportHighResCap: typeof threeDPreferences.viewportHighResCap === 'boolean'
                    ? threeDPreferences.viewportHighResCap
                    : defaults.threeD.preferences.viewportHighResCap
            },
            defaults: {
                samplesTarget: normalizeInteger(threeDDefaults.samplesTarget, defaults.threeD.defaults.samplesTarget, 1, 4096),
                bounces: normalizeInteger(threeDDefaults.bounces, defaults.threeD.defaults.bounces, 1, 64),
                transmissiveBounces: normalizeInteger(threeDDefaults.transmissiveBounces, defaults.threeD.defaults.transmissiveBounces, 0, 64),
                filterGlossyFactor: normalizeFiniteNumber(threeDDefaults.filterGlossyFactor, defaults.threeD.defaults.filterGlossyFactor, 0, 1),
                denoiseEnabled: !!threeDDefaults.denoiseEnabled,
                denoiseSigma: normalizeFiniteNumber(threeDDefaults.denoiseSigma, defaults.threeD.defaults.denoiseSigma, 0.5, 12),
                denoiseThreshold: normalizeFiniteNumber(threeDDefaults.denoiseThreshold, defaults.threeD.defaults.denoiseThreshold, 0.0001, 1),
                denoiseKSigma: normalizeFiniteNumber(threeDDefaults.denoiseKSigma, defaults.threeD.defaults.denoiseKSigma, 0.1, 5),
                toneMapping: normalizeChoice(String(threeDDefaults.toneMapping || '').toLowerCase(), defaults.threeD.defaults.toneMapping, new Set(['aces', 'neutral', 'none']))
            }
        },
        logs: {
            recentLimit: normalizeInteger(logs.recentLimit, defaults.logs.recentLimit, 6, 200),
            historyLimit: normalizeInteger(logs.historyLimit, defaults.logs.historyLimit, 0, 2000),
            autoClearSuccessMs: normalizeInteger(logs.autoClearSuccessMs, defaults.logs.autoClearSuccessMs, 0, 60 * 60 * 1000),
            maxUiCards: normalizeInteger(logs.maxUiCards, defaults.logs.maxUiCards, 0, 100),
            completionFlashEffects: typeof logs.completionFlashEffects === 'boolean'
                ? logs.completionFlashEffects
                : defaults.logs.completionFlashEffects,
            levelFilter: normalizeChoice(String(logs.levelFilter || '').toLowerCase(), defaults.logs.levelFilter, new Set(['all', 'warnings-errors'])),
            compactMessages: typeof logs.compactMessages === 'boolean'
                ? logs.compactMessages
                : defaults.logs.compactMessages
        },
        diagnostics: normalizeDiagnostics(diagnosticsSource, defaults.diagnostics)
    };
}

export function stripDiagnosticsFromSettings(settings = {}) {
    const normalized = normalizeAppSettings(settings);
    return {
        version: normalized.version,
        general: normalized.general,
        library: normalized.library,
        editor: normalized.editor,
        composite: {
            preferences: normalized.composite.preferences
        },
        stitch: {
            defaults: normalized.stitch.defaults
        },
        threeD: normalized.threeD,
        logs: normalized.logs
    };
}
