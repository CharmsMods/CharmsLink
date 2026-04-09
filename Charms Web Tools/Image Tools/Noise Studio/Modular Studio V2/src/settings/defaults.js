export const SETTINGS_SCHEMA_VERSION = 1;
export const SETTINGS_STORAGE_KEY = 'noise-studio:app-settings:v1';

export function createDefaultAppSettings() {
    return {
        version: SETTINGS_SCHEMA_VERSION,
        general: {
            theme: 'light',
            saveImageOnSave: false,
            maxBackgroundWorkers: 0
        },
        library: {
            autoLoadOnStartup: true,
            storagePressureThreshold: 0.8,
            defaultViewLayout: 'grid',
            defaultSortKey: 'timestamp',
            defaultSortDirection: 'desc',
            assetPreviewQuality: 'balanced',
            secureExportByDefault: true,
            requireTagOnImport: false
        },
        editor: {
            defaultHighQualityPreview: false,
            hoverCompareOriginal: true,
            isolateActiveLayerChain: false,
            layerPreviewsOpen: false,
            autoExtractPaletteOnLoad: false,
            transparencyCheckerTone: 'light'
        },
        composite: {
            preferences: {
                showChecker: true,
                zoomLocked: false,
                exportBackend: 'auto'
            },
            diagnostics: {
                workerAvailable: false,
                offscreenCanvas2d: false,
                createImageBitmap: false,
                webglAvailable: false,
                webgl2Available: false,
                maxTextureSize: 0,
                maxRenderbufferSize: 0,
                maxViewportWidth: 0,
                maxViewportHeight: 0,
                gpuSafeMaxEdge: 0,
                autoWorkerThresholdMegapixels: 16,
                autoWorkerThresholdEdge: 4096
            }
        },
        stitch: {
            defaults: {
                sceneMode: 'auto',
                blendMode: 'auto',
                warpMode: 'mesh',
                meshDensity: 'high',
                warpDistribution: 'balanced',
                analysisMaxDimension: 2048,
                useFullResolutionAnalysis: true,
                featureDetector: 'auto',
                maxFeatures: 4000,
                matchRatio: 0.75,
                ransacIterations: 5000,
                inlierThreshold: 4.5,
                maxCandidates: 8
            },
            diagnostics: {
                workerAvailable: false,
                wasmAvailable: false,
                runtimeAvailable: false,
                supportedDetectors: [],
                lastRuntimeSelection: '',
                lastFallbackReason: ''
            }
        },
        threeD: {
            preferences: {
                cameraMode: 'orbit',
                navigationMode: 'free',
                flyMoveSpeed: 6,
                flyLookSensitivity: 0.003,
                fov: 50,
                wheelMode: 'travel',
                near: 0.1,
                far: 2000,
                showGrid: true,
                showAxes: true,
                gizmoScale: 1,
                snapTranslationStep: 0,
                snapRotationDegrees: 0,
                viewportHighResCap: true
            },
            defaults: {
                samplesTarget: 256,
                bounces: 10,
                transmissiveBounces: 10,
                filterGlossyFactor: 0,
                denoiseEnabled: false,
                denoiseSigma: 5,
                denoiseThreshold: 0.03,
                denoiseKSigma: 1,
                toneMapping: 'aces'
            }
        },
        logs: {
            recentLimit: 18,
            historyLimit: 0,
            autoClearSuccessMs: 0,
            maxUiCards: 18,
            completionFlashEffects: true,
            levelFilter: 'all',
            compactMessages: true
        },
        diagnostics: {
            detectedCpuCores: 0,
            workerCapabilities: {},
            assetVersion: '',
            workerLimitApplied: 0,
            storageEstimate: null
        }
    };
}
