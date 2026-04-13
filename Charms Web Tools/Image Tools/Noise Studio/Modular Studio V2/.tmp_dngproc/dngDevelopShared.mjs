const PRESET_LABELS = {
    auto: 'Auto',
    'samsung-expert-raw-linear': 'Samsung Expert RAW Linear',
    'samsung-pro-mode-mosaic': 'Samsung Pro Mode Mosaic',
    'quad-bayer-mosaic': 'Quad Bayer Mosaic',
    'interleaved-mosaic': 'Interleaved Mosaic',
    'generic-linear': 'Generic Linear DNG',
    'generic-mosaic': 'Generic Mosaic DNG'
};

export const DNG_SOURCE_KIND = 'dng';
export const DNG_ATTACHMENT_KIND = 'editor-source-dng';
export const DNG_UNSUPPORTED_TEXT = 'Unsupported in this build';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function finiteNumber(value, fallback) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeEnum(value, allowed, fallback) {
    const normalized = String(value || '').trim().toLowerCase();
    return allowed.includes(normalized) ? normalized : fallback;
}

function normalizeBoolean(value, fallback = true) {
    if (value === true || value === false) return value;
    return fallback;
}

export function isDngSource(source = null) {
    return String(source?.kind || '').trim().toLowerCase() === DNG_SOURCE_KIND;
}

export function createEmptyDngSourceState() {
    return {
        sourceSignature: '',
        attachmentId: '',
        lastPreparedParamsHash: '',
        lastPreparedAt: 0,
        prepareQuality: 'fast',
        preset: 'auto',
        fidelity: 'partial',
        warnings: [],
        probe: null
    };
}

export function normalizeDngSourceState(dng = null) {
    if (!dng || typeof dng !== 'object') {
        return createEmptyDngSourceState();
    }
    return {
        sourceSignature: String(dng.sourceSignature || ''),
        attachmentId: String(dng.attachmentId || ''),
        lastPreparedParamsHash: String(dng.lastPreparedParamsHash || ''),
        lastPreparedAt: Math.max(0, Number(dng.lastPreparedAt) || 0),
        prepareQuality: normalizeEnum(dng.prepareQuality, ['fast', 'high'], 'fast'),
        preset: String(dng.preset || 'auto') || 'auto',
        fidelity: normalizeEnum(dng.fidelity, ['supported', 'partial', 'unsupported'], 'partial'),
        warnings: Array.isArray(dng.warnings) ? dng.warnings.map((entry) => String(entry || '')).filter(Boolean) : [],
        probe: dng.probe && typeof dng.probe === 'object'
            ? JSON.parse(JSON.stringify(dng.probe))
            : null
    };
}

export function createDefaultDngDevelopParams() {
    return {
        dngDevelopEnable: true,
        dngPreset: 'auto',
        dngInterpretationMode: 'auto',
        dngAutoBlackLevel: true,
        dngBlackLevel: 0,
        dngAutoWhiteLevel: true,
        dngWhiteLevel: 65535,
        dngApplyLinearization: true,
        dngApplyOrientation: true,
        dngRemosaicMode: 'auto',
        dngDemosaicQuality: 'high',
        dngWhiteBalanceMode: 'as-shot',
        dngTemperature: 6500,
        dngTint: 0,
        dngApplyCameraMatrix: true,
        dngWorkingSpace: 'srgb',
        dngExposure: 0,
        dngHighlightRecovery: 22,
        dngToneMappingAmount: 18,
        dngDenoiseMode: 'auto',
        dngDenoiseStrength: 14,
        dngDetailPreservation: 62,
        dngSharpenAmount: 10,
        dngApplyOpcodeCorrections: true,
        dngApplyGainMap: true
    };
}

function getPresetDefaults(probe = null) {
    const defaults = createDefaultDngDevelopParams();
    const preset = getDngPresetForProbe(probe);
    if (preset === 'samsung-expert-raw-linear' || preset === 'generic-linear') {
        return {
            ...defaults,
            dngPreset: preset,
            dngInterpretationMode: probe?.classificationMode === 'linear' ? 'linear' : defaults.dngInterpretationMode,
            dngWhiteBalanceMode: 'as-shot',
            dngDemosaicQuality: 'high',
            dngDenoiseMode: 'auto',
            dngDenoiseStrength: 10,
            dngSharpenAmount: 6,
            dngToneMappingAmount: 14
        };
    }
    if (preset === 'samsung-pro-mode-mosaic') {
        return {
            ...defaults,
            dngPreset: preset,
            dngDemosaicQuality: 'high',
            dngDenoiseStrength: 16,
            dngSharpenAmount: 8,
            // Samsung Pro Mode mosaic files are currently more stable without the
            // approximate camera-matrix path enabled by default.
            dngApplyCameraMatrix: false
        };
    }
    if (preset === 'quad-bayer-mosaic' || preset === 'interleaved-mosaic') {
        return {
            ...defaults,
            dngPreset: preset,
            dngInterpretationMode: preset === 'interleaved-mosaic' ? 'interleaved' : 'quad',
            dngRemosaicMode: 'auto',
            dngDemosaicQuality: 'high',
            dngDenoiseStrength: 18,
            dngSharpenAmount: 10
        };
    }
    return {
        ...defaults,
        dngPreset: preset
    };
}

export function getDngPresetLabel(preset) {
    return PRESET_LABELS[String(preset || 'auto')] || PRESET_LABELS.auto;
}

export function getDngPresetForProbe(probe = null) {
    const make = String(probe?.make || '').toLowerCase();
    const model = String(probe?.model || '').toLowerCase();
    const classificationMode = String(probe?.classificationMode || '').toLowerCase();
    const patternWidth = Math.max(0, Number(probe?.cfaPatternWidth) || 0);
    const patternHeight = Math.max(0, Number(probe?.cfaPatternHeight) || 0);
    const interleaved = !!probe?.rowInterleaveFactor || !!probe?.columnInterleaveFactor;
    if (classificationMode === 'linear') {
        if (make.includes('samsung') || model.includes('expert raw')) {
            return 'samsung-expert-raw-linear';
        }
        return 'generic-linear';
    }
    if (interleaved) return 'interleaved-mosaic';
    if (patternWidth > 2 || patternHeight > 2) return 'quad-bayer-mosaic';
    if (make.includes('samsung')) return 'samsung-pro-mode-mosaic';
    return 'generic-mosaic';
}

export function normalizeDngDevelopParams(params = null, probe = null) {
    const defaults = getPresetDefaults(probe);
    const source = params && typeof params === 'object' ? params : {};
    return {
        dngDevelopEnable: normalizeBoolean(source.dngDevelopEnable, defaults.dngDevelopEnable),
        dngPreset: String(source.dngPreset || defaults.dngPreset || 'auto') || 'auto',
        dngInterpretationMode: normalizeEnum(source.dngInterpretationMode, ['auto', 'linear', 'bayer', 'quad', 'interleaved'], defaults.dngInterpretationMode),
        dngAutoBlackLevel: normalizeBoolean(source.dngAutoBlackLevel, defaults.dngAutoBlackLevel),
        dngBlackLevel: clamp(finiteNumber(source.dngBlackLevel, defaults.dngBlackLevel), -65535, 65535),
        dngAutoWhiteLevel: normalizeBoolean(source.dngAutoWhiteLevel, defaults.dngAutoWhiteLevel),
        dngWhiteLevel: clamp(finiteNumber(source.dngWhiteLevel, defaults.dngWhiteLevel), 1, 65535),
        dngApplyLinearization: normalizeBoolean(source.dngApplyLinearization, defaults.dngApplyLinearization),
        dngApplyOrientation: normalizeBoolean(source.dngApplyOrientation, defaults.dngApplyOrientation),
        dngRemosaicMode: normalizeEnum(source.dngRemosaicMode, ['auto', 'off', 'on'], defaults.dngRemosaicMode),
        dngDemosaicQuality: normalizeEnum(source.dngDemosaicQuality, ['fast', 'high'], defaults.dngDemosaicQuality),
        dngWhiteBalanceMode: normalizeEnum(source.dngWhiteBalanceMode, ['as-shot', 'custom'], defaults.dngWhiteBalanceMode),
        dngTemperature: clamp(finiteNumber(source.dngTemperature, defaults.dngTemperature), 1800, 50000),
        dngTint: clamp(finiteNumber(source.dngTint, defaults.dngTint), -100, 100),
        dngApplyCameraMatrix: normalizeBoolean(source.dngApplyCameraMatrix, defaults.dngApplyCameraMatrix),
        dngWorkingSpace: normalizeEnum(source.dngWorkingSpace, ['srgb', 'display-p3', 'linear'], defaults.dngWorkingSpace),
        dngExposure: clamp(finiteNumber(source.dngExposure, defaults.dngExposure), -10, 10),
        dngHighlightRecovery: clamp(finiteNumber(source.dngHighlightRecovery, defaults.dngHighlightRecovery), 0, 100),
        dngToneMappingAmount: clamp(finiteNumber(source.dngToneMappingAmount, defaults.dngToneMappingAmount), 0, 100),
        dngDenoiseMode: normalizeEnum(source.dngDenoiseMode, ['auto', 'off', 'manual'], defaults.dngDenoiseMode),
        dngDenoiseStrength: clamp(finiteNumber(source.dngDenoiseStrength, defaults.dngDenoiseStrength), 0, 100),
        dngDetailPreservation: clamp(finiteNumber(source.dngDetailPreservation, defaults.dngDetailPreservation), 0, 100),
        dngSharpenAmount: clamp(finiteNumber(source.dngSharpenAmount, defaults.dngSharpenAmount), 0, 100),
        dngApplyOpcodeCorrections: normalizeBoolean(source.dngApplyOpcodeCorrections, defaults.dngApplyOpcodeCorrections),
        dngApplyGainMap: normalizeBoolean(source.dngApplyGainMap, defaults.dngApplyGainMap)
    };
}

export function buildDngPrepareHash(params = null, options = {}) {
    const normalized = normalizeDngDevelopParams(params);
    return JSON.stringify({
        ...normalized,
        previewQuality: options.previewQuality === 'high' ? 'high' : 'fast'
    });
}

export function stripDngSourceRawPayload(source = null) {
    if (!isDngSource(source)) return source;
    return {
        ...source,
        rawData: null
    };
}
