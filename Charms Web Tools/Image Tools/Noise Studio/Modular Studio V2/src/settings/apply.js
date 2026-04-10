import { createDefaultViewState, normalizeViewState } from '../state/documentHelpers.js';
import { createEmptyCompositeDocument, normalizeCompositeDocument } from '../composite/document.js';
import { createEmptyThreeDDocument, normalizeThreeDDocument } from '../3d/document.js';
import { createEmptyStitchDocument, normalizeStitchDocument } from '../stitch/document.js';
import { normalizeEditorBase, normalizeEditorSource } from '../editor/baseCanvas.js';

export function applyGeneralThemeToEditorView(view = {}, settings = null) {
    const defaults = createDefaultViewState();
    const theme = settings?.general?.theme === 'dark' ? 'dark' : 'light';
    return normalizeViewState({
        ...defaults,
        ...view,
        theme
    });
}

export function applyEditorSettingsToDocument(document = {}, settings = null) {
    const nextView = normalizeViewState({
        ...(document?.view || {}),
        theme: settings?.general?.theme === 'dark' ? 'dark' : 'light',
        highQualityPreview: !!settings?.editor?.defaultHighQualityPreview,
        hoverCompareEnabled: settings?.editor?.hoverCompareOriginal !== false,
        isolateActiveLayerChain: !!settings?.editor?.isolateActiveLayerChain,
        layerPreviewsOpen: !!settings?.editor?.layerPreviewsOpen
    });
    return {
        ...document,
        source: normalizeEditorSource(document?.source),
        base: normalizeEditorBase(document?.base, document?.source),
        view: nextView
    };
}

export function applyEditorSettingsToLayerInstance(instance = {}, settings = null) {
    if (!instance || instance.layerId !== 'bgPatcher') return instance;
    return {
        ...instance,
        params: {
            ...(instance.params || {}),
            bgPatcherCheckerTone: settings?.editor?.transparencyCheckerTone === 'dark' ? 'black' : 'white'
        }
    };
}

export function applyCompositeSettingsToDocument(document = {}, settings = null) {
    const base = normalizeCompositeDocument(document);
    const preferences = settings?.composite?.preferences || {};
    return normalizeCompositeDocument({
        ...base,
        view: {
            ...base.view,
            zoomLocked: typeof preferences.zoomLocked === 'boolean'
                ? preferences.zoomLocked
                : base.view.zoomLocked,
            showChecker: typeof preferences.showChecker === 'boolean'
                ? preferences.showChecker
                : base.view.showChecker
        }
    });
}

export function createSettingsDrivenCompositeDocument(settings = null) {
    return applyCompositeSettingsToDocument(createEmptyCompositeDocument(), settings);
}

export function applyThemeToStitchDocument(document = {}, settings = null) {
    return normalizeStitchDocument({
        ...document,
        view: {
            ...(document.view || {}),
            theme: settings?.general?.theme === 'dark' ? 'dark' : 'light'
        }
    });
}

export function getStitchSettingsDefaults(settings = null) {
    return {
        ...(settings?.stitch?.defaults || {})
    };
}

export function applyStitchSettingsToDocument(document = {}, settings = null, mode = 'current') {
    const normalized = normalizeStitchDocument(document);
    const nextSettings = mode === 'new' || mode === 'apply-defaults'
        ? {
            ...normalized.settings,
            ...getStitchSettingsDefaults(settings)
        }
        : normalized.settings;
    return normalizeStitchDocument({
        ...normalized,
        settings: nextSettings,
        view: {
            ...normalized.view,
            theme: settings?.general?.theme === 'dark' ? 'dark' : 'light'
        }
    });
}

export function applyThreeDSettingsToDocument(document = {}, settings = null, mode = 'current') {
    const base = normalizeThreeDDocument(document);
    const prefs = settings?.threeD?.preferences || {};
    const defaults = settings?.threeD?.defaults || {};
    const next = {
        ...base,
        scene: {
            ...base.scene,
            showGrid: prefs.showGrid !== false,
            showAxes: !!prefs.showAxes
        },
        view: {
            ...base.view,
            cameraMode: prefs.cameraMode === 'fly' ? 'fly' : 'orbit',
            navigationMode: prefs.navigationMode === 'canvas' ? 'canvas' : 'free',
            wheelMode: prefs.wheelMode === 'zoom' ? 'zoom' : 'travel',
            snapTranslationStep: Number(prefs.snapTranslationStep ?? base.view.snapTranslationStep) || 0,
            snapRotationDegrees: Number(prefs.snapRotationDegrees ?? base.view.snapRotationDegrees) || 0,
            fov: Number(prefs.fov ?? base.view.fov) || base.view.fov,
            near: Number(prefs.near ?? base.view.near) || base.view.near,
            far: Number(prefs.far ?? base.view.far) || base.view.far,
            flyMoveSpeed: Number(prefs.flyMoveSpeed ?? base.view.flyMoveSpeed ?? 6) || 6,
            flyLookSensitivity: Number(prefs.flyLookSensitivity ?? base.view.flyLookSensitivity ?? 0.003) || 0.003,
            gizmoScale: Number(prefs.gizmoScale ?? base.view.gizmoScale ?? 1) || 1,
            viewportHighResCap: typeof prefs.viewportHighResCap === 'boolean'
                ? prefs.viewportHighResCap
                : (base.view.viewportHighResCap !== false)
        }
    };

    if (mode === 'new') {
        next.render = {
            ...next.render,
            samplesTarget: Number(defaults.samplesTarget ?? next.render.samplesTarget) || next.render.samplesTarget,
            bounces: Number(defaults.bounces ?? next.render.bounces) || next.render.bounces,
            transmissiveBounces: Number(defaults.transmissiveBounces ?? next.render.transmissiveBounces) || next.render.transmissiveBounces,
            filterGlossyFactor: Number(defaults.filterGlossyFactor ?? next.render.filterGlossyFactor) || 0,
            denoiseEnabled: !!defaults.denoiseEnabled,
            denoiseSigma: Number(defaults.denoiseSigma ?? next.render.denoiseSigma) || next.render.denoiseSigma,
            denoiseThreshold: Number(defaults.denoiseThreshold ?? next.render.denoiseThreshold) || next.render.denoiseThreshold,
            denoiseKSigma: Number(defaults.denoiseKSigma ?? next.render.denoiseKSigma) || next.render.denoiseKSigma,
            toneMapping: defaults.toneMapping || next.render.toneMapping
        };
    }

    return normalizeThreeDDocument(next);
}

export function createSettingsDrivenThreeDDocument(settings = null) {
    return applyThreeDSettingsToDocument(createEmptyThreeDDocument(), settings, 'new');
}

export function createSettingsDrivenStitchDocument(settings = null) {
    return applyStitchSettingsToDocument(
        createEmptyStitchDocument(settings?.general?.theme === 'dark' ? 'dark' : 'light'),
        settings,
        'new'
    );
}
