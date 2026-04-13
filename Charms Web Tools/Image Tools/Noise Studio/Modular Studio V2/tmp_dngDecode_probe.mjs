import { encodePng16Rgba } from './png16.js';
import { decodeParsedDngMetadata, parseDngBuffer, decodeDngRaster } from './dngTiff.js';
import { buildDngPrepareHash, getDngPresetForProbe, normalizeDngDevelopParams } from './dngDevelopShared.js';

const parsedCache = new Map();
const rasterCache = new Map();
const XYZ_TO_SRGB_MATRIX = Object.freeze([
    3.2406, -1.5372, -0.4986,
    -0.9689, 1.8758, 0.0415,
    0.0557, -0.2040, 1.0570
]);
const XYZ_TO_DISPLAY_P3_MATRIX = Object.freeze([
    2.4934969119, -0.9313836179, -0.4027107845,
    -0.8294889696, 1.7626640603, 0.0236246858,
    0.0358458302, -0.0761723893, 0.9568845240
]);

function toNumberArray(value) {
    if (Array.isArray(value)) return value.map((entry) => Number(entry) || 0);
    if (value == null) return [];
    return [Number(value) || 0];
}

function transferFloatArray(value) {
    const source = value instanceof Float32Array
        ? value
        : new Float32Array(toNumberArray(value));
    const output = new Float32Array(source.length);
    output.set(source);
    return output;
}

function serializeGainMap(gainMap) {
    if (!gainMap || typeof gainMap !== 'object') return null;
    return {
        opcodeId: Number(gainMap.opcodeId || 9),
        plane: Number(gainMap.plane || 0),
        planes: Math.max(1, Number(gainMap.planes || 1)),
        rowPitch: Math.max(1, Number(gainMap.rowPitch || 1)),
        colPitch: Math.max(1, Number(gainMap.colPitch || 1)),
        top: Math.max(0, Number(gainMap.top || 0)),
        left: Math.max(0, Number(gainMap.left || 0)),
        bottom: Math.max(0, Number(gainMap.bottom || 0)),
        right: Math.max(0, Number(gainMap.right || 0)),
        mapPointsV: Math.max(1, Number(gainMap.mapPointsV || 1)),
        mapPointsH: Math.max(1, Number(gainMap.mapPointsH || 1)),
        mapSpacingV: Number(gainMap.mapSpacingV || 0),
        mapSpacingH: Number(gainMap.mapSpacingH || 0),
        mapOriginV: Number(gainMap.mapOriginV || 0),
        mapOriginH: Number(gainMap.mapOriginH || 0),
        mapPlanes: Math.max(1, Number(gainMap.mapPlanes || 1)),
        gains: transferFloatArray(gainMap.gains || [])
    };
}

function serializeOpcodeList(opcodeList = null) {
    const current = opcodeList && typeof opcodeList === 'object' ? opcodeList : {};
    return {
        count: Math.max(0, Number(current.count || 0)),
        unsupportedIds: Array.isArray(current.unsupportedIds)
            ? current.unsupportedIds.map((entry) => Number(entry) || 0).filter((entry) => entry > 0)
            : [],
        entries: Array.isArray(current.entries)
            ? current.entries.map((entry) => ({
                opcodeId: Number(entry?.opcodeId || 0),
                version: Number(entry?.version || 0),
                flags: Number(entry?.flags || 0),
                size: Number(entry?.size || 0),
                kind: String(entry?.kind || 'unknown'),
                parsed: entry?.kind === 'gain-map' ? serializeGainMap(entry?.parsed) : null
            }))
            : []
    };
}

function serializeDecodedDngSource(parsed, raster, signature) {
    const probe = {
        ...parsed.probe,
        preset: getDngPresetForProbe(parsed.probe)
    };
    const decoded = decodeParsedDngMetadata(parsed);
    const rawData = raster?.data instanceof Float32Array
        ? transferFloatArray(raster.data)
        : new Float32Array(0);
    const linearizationTable = decoded.linearizationTable.length
        ? transferFloatArray(decoded.linearizationTable)
        : null;

    return {
        sourceSignature: signature,
        probe,
        preset: probe.preset,
        fidelity: probe.fidelity,
        warnings: [...asArray(probe.warnings)],
        rawRaster: {
            width: Math.max(1, Number(raster?.width) || 1),
            height: Math.max(1, Number(raster?.height) || 1),
            samplesPerPixel: Math.max(1, Number(raster?.samplesPerPixel) || 1),
            bitsPerSample: Math.max(1, Number(raster?.bitsPerSample) || 16),
            sampleFormat: Math.max(1, Number(raster?.sampleFormat) || 1),
            data: rawData
        },
        metadata: {
            blackLevelRepeatDim: decoded.blackLevelRepeatDim,
            blackLevel: decoded.blackLevel,
            whiteLevel: decoded.whiteLevel,
            asShotNeutral: decoded.asShotNeutral,
            colorMatrix1: decoded.colorMatrix1,
            colorMatrix2: decoded.colorMatrix2,
            noiseProfile: decoded.noiseProfile,
            defaultCropOrigin: decoded.defaultCropOrigin,
            defaultCropSize: decoded.defaultCropSize,
            linearizationTable,
            opcodeList1: serializeOpcodeList(decoded.opcodeList1),
            opcodeList2: serializeOpcodeList(decoded.opcodeList2),
            opcodeList3: serializeOpcodeList(decoded.opcodeList3),
            gainMaps: decoded.gainMaps.map((entry) => serializeGainMap(entry)).filter(Boolean),
            hasProfileGainTableMap: !!(decoded.profileGainTableMap?.length)
        }
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function asArray(value) {
    return Array.isArray(value) ? value : (value == null ? [] : [value]);
}

function srgbEncode(linear) {
    const value = clamp(linear, 0, 1);
    if (value <= 0.0031308) return value * 12.92;
    return (1.055 * Math.pow(value, 1 / 2.4)) - 0.055;
}

function temperatureToRgb(temperatureKelvin) {
    const temp = clamp(Number(temperatureKelvin) || 6500, 1800, 50000) / 100;
    let red;
    let green;
    let blue;
    if (temp <= 66) {
        red = 255;
        green = 99.4708025861 * Math.log(temp) - 161.1195681661;
        blue = temp <= 19 ? 0 : (138.5177312231 * Math.log(temp - 10) - 305.0447927307);
    } else {
        red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
        green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
        blue = 255;
    }
    return [
        clamp(red, 0, 255) / 255,
        clamp(green, 0, 255) / 255,
        clamp(blue, 0, 255) / 255
    ];
}

function getPixelIndex(width, x, y, channels) {
    return ((y * width) + x) * channels;
}

function multiplyMatrix3Vector(matrix, vector) {
    return [
        (matrix[0] * vector[0]) + (matrix[1] * vector[1]) + (matrix[2] * vector[2]),
        (matrix[3] * vector[0]) + (matrix[4] * vector[1]) + (matrix[5] * vector[2]),
        (matrix[6] * vector[0]) + (matrix[7] * vector[1]) + (matrix[8] * vector[2])
    ];
}

function multiplyMatrix3(left, right) {
    return [
        (left[0] * right[0]) + (left[1] * right[3]) + (left[2] * right[6]),
        (left[0] * right[1]) + (left[1] * right[4]) + (left[2] * right[7]),
        (left[0] * right[2]) + (left[1] * right[5]) + (left[2] * right[8]),
        (left[3] * right[0]) + (left[4] * right[3]) + (left[5] * right[6]),
        (left[3] * right[1]) + (left[4] * right[4]) + (left[5] * right[7]),
        (left[3] * right[2]) + (left[4] * right[5]) + (left[5] * right[8]),
        (left[6] * right[0]) + (left[7] * right[3]) + (left[8] * right[6]),
        (left[6] * right[1]) + (left[7] * right[4]) + (left[8] * right[7]),
        (left[6] * right[2]) + (left[7] * right[5]) + (left[8] * right[8])
    ];
}

function invertMatrix3(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 9) return null;
    const [
        a, b, c,
        d, e, f,
        g, h, i
    ] = matrix.map((value) => Number(value) || 0);
    const A = (e * i) - (f * h);
    const B = -((d * i) - (f * g));
    const C = (d * h) - (e * g);
    const D = -((b * i) - (c * h));
    const E = (a * i) - (c * g);
    const F = -((a * h) - (b * g));
    const G = (b * f) - (c * e);
    const H = -((a * f) - (c * d));
    const I = (a * e) - (b * d);
    const determinant = (a * A) + (b * B) + (c * C);
    if (Math.abs(determinant) < 1e-8) return null;
    const inv = 1 / determinant;
    return [
        A * inv, D * inv, G * inv,
        B * inv, E * inv, H * inv,
        C * inv, F * inv, I * inv
    ];
}

function resolveInterpretationMode(params, probe) {
    const explicitMode = String(params?.dngInterpretationMode || 'auto');
    if (explicitMode !== 'auto') return explicitMode;
    const preset = String(params?.dngPreset || 'auto');
    if (preset === 'samsung-expert-raw-linear' || preset === 'generic-linear') return 'linear';
    if (preset === 'quad-bayer-mosaic') return 'quad';
    if (preset === 'interleaved-mosaic') return 'interleaved';
    return String(probe?.classificationMode || 'bayer') || 'bayer';
}

function estimateStoredRangeScale(raster, whiteLevel) {
    const normalizedWhiteLevel = Math.max(1, Number(whiteLevel) || 0);
    const bitsPerSample = Math.max(1, Math.min(24, Number(raster?.bitsPerSample) || 16));
    const containerMax = Math.max(1, (2 ** bitsPerSample) - 1);
    if (normalizedWhiteLevel >= containerMax * 0.75) return 1;
    const data = raster?.data;
    if (!(data instanceof Float32Array) || !data.length) return 1;

    const maxSamples = 8192;
    const step = Math.max(1, Math.floor(data.length / maxSamples));
    let observedMax = 0;
    for (let index = 0; index < data.length; index += step) {
        observedMax = Math.max(observedMax, Number(data[index]) || 0);
    }
    if (observedMax <= normalizedWhiteLevel * 1.5) return 1;

    const ratio = observedMax / normalizedWhiteLevel;
    const suggestedShift = Math.max(0, Math.round(Math.log2(Math.max(1, ratio))));
    const maxShift = Math.max(0, bitsPerSample - Math.ceil(Math.log2(normalizedWhiteLevel + 1)));
    const shift = Math.min(suggestedShift, maxShift);
    return shift > 0 ? (2 ** shift) : 1;
}

function averageNearbySameColor(raw, patternWidth, patternHeight, pattern, width, height, x, y, colorCode, radius) {
    let sum = 0;
    let count = 0;
    for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        const sampleY = y + offsetY;
        if (sampleY < 0 || sampleY >= height) continue;
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
            const sampleX = x + offsetX;
            if (sampleX < 0 || sampleX >= width) continue;
            const patternIndex = ((sampleY % patternHeight) * patternWidth) + (sampleX % patternWidth);
            if ((pattern[patternIndex] ?? 1) !== colorCode) continue;
            sum += raw[sampleY * width + sampleX] || 0;
            count += 1;
        }
    }
    return count ? (sum / count) : (raw[y * width + x] || 0);
}

function demosaicCfa(raw, width, height, probe, quality = 'high') {
    const patternWidth = Math.max(1, Number(probe?.cfaPatternWidth) || 2);
    const patternHeight = Math.max(1, Number(probe?.cfaPatternHeight) || 2);
    const pattern = asArray(probe?.cfaPattern).length
        ? asArray(probe.cfaPattern)
        : [0, 1, 1, 2];
    const radius = quality === 'fast' ? 1 : 2;
    const output = new Float32Array(width * height * 3);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const patternIndex = ((y % patternHeight) * patternWidth) + (x % patternWidth);
            const nativeColor = pattern[patternIndex] ?? 1;
            const outputIndex = ((y * width) + x) * 3;
            for (let channel = 0; channel < 3; channel += 1) {
                output[outputIndex + channel] = nativeColor === channel
                    ? (raw[y * width + x] || 0)
                    : averageNearbySameColor(raw, patternWidth, patternHeight, pattern, width, height, x, y, channel, radius);
            }
        }
    }

    return output;
}

function linearRasterToRgb(raster) {
    const { width, height, samplesPerPixel, data } = raster;
    const output = new Float32Array(width * height * 3);
    if (samplesPerPixel <= 1) {
        for (let index = 0; index < width * height; index += 1) {
            const value = data[index] || 0;
            const offset = index * 3;
            output[offset] = value;
            output[offset + 1] = value;
            output[offset + 2] = value;
        }
        return output;
    }
    for (let index = 0; index < width * height; index += 1) {
        const srcOffset = index * samplesPerPixel;
        const dstOffset = index * 3;
        output[dstOffset] = data[srcOffset] || 0;
        output[dstOffset + 1] = data[srcOffset + 1] || output[dstOffset];
        output[dstOffset + 2] = data[srcOffset + 2] || output[dstOffset + 1];
    }
    return output;
}

function applyLinearizationTable(raster, parsed, params) {
    if (params?.dngApplyLinearization === false) return raster;
    const table = asArray(parsed?.rawIfd?.tags?.LinearizationTable)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value >= 0);
    if (!table.length) return raster;
    const maxIndex = table.length - 1;
    const output = new Float32Array(raster.data.length);
    for (let index = 0; index < raster.data.length; index += 1) {
        const sample = clamp(Math.round(Number(raster.data[index]) || 0), 0, maxIndex);
        output[index] = table[sample] ?? raster.data[index];
    }
    return {
        ...raster,
        data: output
    };
}

function normalizeRgb(rgb, raster, parsed, params) {
    const blackLevels = asArray(parsed?.probe?.blackLevel);
    const whiteLevels = asArray(parsed?.probe?.whiteLevel);
    const autoBlack = params.dngAutoBlackLevel !== false;
    const autoWhite = params.dngAutoWhiteLevel !== false;
    const detectedBlackLevel = Number(blackLevels[0] || 0);
    const detectedWhiteLevel = autoWhite
        ? Number(whiteLevels[0] || ((1 << Math.min(24, raster.bitsPerSample || 16)) - 1))
        : Number(params.dngWhiteLevel || 65535);
    const storedRangeScale = autoWhite ? estimateStoredRangeScale(raster, detectedWhiteLevel) : 1;
    const blackLevel = autoBlack
        ? detectedBlackLevel
        : Number(params.dngBlackLevel || 0);
    const whiteLevel = autoWhite
        ? detectedWhiteLevel * storedRangeScale
        : Number(params.dngWhiteLevel || 65535);
    const scale = Math.max(1e-6, whiteLevel - blackLevel);
    const output = new Float32Array(rgb.length);
    for (let index = 0; index < rgb.length; index += 1) {
        output[index] = clamp((rgb[index] - blackLevel) / scale, 0, 4);
    }
    return output;
}

function getAsShotWhiteBalanceGains(parsed) {
    if (asArray(parsed?.probe?.asShotNeutral).length < 3) return [1, 1, 1];
    const neutral = asArray(parsed.probe.asShotNeutral)
        .slice(0, 3)
        .map((value) => Math.max(1e-6, Number(value) || 1));
    const green = neutral[1] || 1;
    return [
        green / neutral[0],
        1,
        green / neutral[2]
    ];
}

function getTemperatureTintGains(temperature, tint) {
    const temperatureRgb = temperatureToRgb(temperature);
    const tintShift = clamp(Number(tint || 0) / 100, -1, 1);
    return [
        1 / Math.max(1e-6, temperatureRgb[0]),
        1 / Math.max(1e-6, temperatureRgb[1] * (1 + tintShift * 0.35)),
        1 / Math.max(1e-6, temperatureRgb[2])
    ];
}

function getTemperatureTintShiftGains(temperature, tint) {
    const current = getTemperatureTintGains(temperature, tint);
    const neutral = getTemperatureTintGains(6500, 0);
    return [
        current[0] / Math.max(1e-6, neutral[0]),
        current[1] / Math.max(1e-6, neutral[1]),
        current[2] / Math.max(1e-6, neutral[2])
    ];
}

function applyWhiteBalance(rgb, parsed, params) {
    const output = new Float32Array(rgb.length);
    let gains = [1, 1, 1];
    if (params.dngWhiteBalanceMode === 'custom') {
        gains = getTemperatureTintGains(params.dngTemperature, params.dngTint);
    } else {
        const base = getAsShotWhiteBalanceGains(parsed);
        const shift = getTemperatureTintShiftGains(params.dngTemperature, params.dngTint);
        gains = [
            base[0] * shift[0],
            base[1] * shift[1],
            base[2] * shift[2]
        ];
    }
    for (let index = 0; index < rgb.length; index += 3) {
        output[index] = rgb[index] * gains[0];
        output[index + 1] = rgb[index + 1] * gains[1];
        output[index + 2] = rgb[index + 2] * gains[2];
    }
    return output;
}

function applyCameraColorTransform(rgb, probe, params) {
    if (params?.dngApplyCameraMatrix === false) return rgb;
    const colorMatrix = asArray(probe?.colorMatrix2).length >= 9
        ? asArray(probe.colorMatrix2).slice(0, 9)
        : asArray(probe?.colorMatrix1).length >= 9
            ? asArray(probe.colorMatrix1).slice(0, 9)
            : null;
    const cameraToXyz = invertMatrix3(colorMatrix);
    if (!cameraToXyz) return rgb;
    const xyzToTarget = params?.dngWorkingSpace === 'display-p3'
        ? XYZ_TO_DISPLAY_P3_MATRIX
        : XYZ_TO_SRGB_MATRIX;
    const transform = multiplyMatrix3(xyzToTarget, cameraToXyz);
    const output = new Float32Array(rgb.length);
    for (let index = 0; index < rgb.length; index += 3) {
        const [red, green, blue] = multiplyMatrix3Vector(transform, [
            rgb[index],
            rgb[index + 1],
            rgb[index + 2]
        ]);
        output[index] = Math.max(0, red);
        output[index + 1] = Math.max(0, green);
        output[index + 2] = Math.max(0, blue);
    }
    return output;
}

function blurRgb(rgb, width, height, radius) {
    const output = new Float32Array(rgb.length);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const sums = [0, 0, 0];
            let count = 0;
            for (let oy = -radius; oy <= radius; oy += 1) {
                const py = y + oy;
                if (py < 0 || py >= height) continue;
                for (let ox = -radius; ox <= radius; ox += 1) {
                    const px = x + ox;
                    if (px < 0 || px >= width) continue;
                    const index = getPixelIndex(width, px, py, 3);
                    sums[0] += rgb[index];
                    sums[1] += rgb[index + 1];
                    sums[2] += rgb[index + 2];
                    count += 1;
                }
            }
            const writeIndex = getPixelIndex(width, x, y, 3);
            output[writeIndex] = sums[0] / Math.max(1, count);
            output[writeIndex + 1] = sums[1] / Math.max(1, count);
            output[writeIndex + 2] = sums[2] / Math.max(1, count);
        }
    }
    return output;
}

function applyToneAndDetail(rgb, width, height, params, options = {}) {
    const exposureScale = Math.pow(2, Number(params.dngExposure || 0));
    const highlightStrength = clamp(Number(params.dngHighlightRecovery || 0) / 100, 0, 1);
    const toneAmount = clamp(Number(params.dngToneMappingAmount || 0) / 100, 0, 1);
    const partialFidelity = !!options.partialFidelity;
    let working = new Float32Array(rgb.length);
    for (let index = 0; index < rgb.length; index += 3) {
        let red = rgb[index] * exposureScale;
        let green = rgb[index + 1] * exposureScale;
        let blue = rgb[index + 2] * exposureScale;
        if (highlightStrength > 0) {
            if (red > 1) red = 1 + ((red - 1) / (1 + (red - 1) * (1 + highlightStrength * 3)));
            if (green > 1) green = 1 + ((green - 1) / (1 + (green - 1) * (1 + highlightStrength * 3)));
            if (blue > 1) blue = 1 + ((blue - 1) / (1 + (blue - 1) * (1 + highlightStrength * 3)));

            const peak = Math.max(red, green, blue);
            if (peak > 0.82) {
                const luminance = ((red + green + blue) / 3);
                const shoulder = clamp((peak - 0.82) / 0.8, 0, 1) * highlightStrength;
                const chromaCompression = shoulder * 0.55;
                red = luminance + ((red - luminance) * (1 - chromaCompression));
                green = luminance + ((green - luminance) * (1 - chromaCompression));
                blue = luminance + ((blue - luminance) * (1 - chromaCompression));
            }
        }
        if (partialFidelity) {
            const peak = Math.max(red, green, blue);
            const valley = Math.min(red, green, blue);
            const spread = peak - valley;
            if (peak > 0.78 && spread > 0.16) {
                const median = [red, green, blue].sort((left, right) => left - right)[1];
                const artifactSuppression = clamp((peak - 0.78) / 0.8, 0, 1)
                    * clamp((spread - 0.16) / 1.2, 0, 1)
                    * (0.18 + (highlightStrength * 0.34));
                red = median + ((red - median) * (1 - artifactSuppression));
                green = median + ((green - median) * (1 - artifactSuppression));
                blue = median + ((blue - median) * (1 - artifactSuppression));
            }
        }
        working[index] = toneAmount > 0
            ? ((1 - toneAmount) * red) + (toneAmount * (red / (1 + red)))
            : red;
        working[index + 1] = toneAmount > 0
            ? ((1 - toneAmount) * green) + (toneAmount * (green / (1 + green)))
            : green;
        working[index + 2] = toneAmount > 0
            ? ((1 - toneAmount) * blue) + (toneAmount * (blue / (1 + blue)))
            : blue;
    }

    const denoiseMode = String(params.dngDenoiseMode || 'auto');
    const denoiseStrength = clamp(Number(params.dngDenoiseStrength || 0) / 100, 0, 1);
    if ((denoiseMode === 'manual' || denoiseMode === 'auto') && denoiseStrength > 0.01) {
        const radius = denoiseStrength > 0.45 ? 2 : 1;
        const blurred = blurRgb(working, width, height, radius);
        const detailPreservation = clamp(Number(params.dngDetailPreservation || 0) / 100, 0, 1);
        for (let index = 0; index < working.length; index += 1) {
            working[index] = (working[index] * detailPreservation) + (blurred[index] * (1 - detailPreservation));
        }
    }

    const sharpenAmount = clamp(Number(params.dngSharpenAmount || 0) / 100, 0, 1);
    if (sharpenAmount > 0.01) {
        const blurred = blurRgb(working, width, height, 1);
        for (let index = 0; index < working.length; index += 1) {
            working[index] = clamp(working[index] + ((working[index] - blurred[index]) * sharpenAmount * 0.75), 0, 4);
        }
    }

    return working;
}

function applyOrientation(rgb, width, height, orientation) {
    const normalized = Math.round(Number(orientation) || 1);
    if (normalized === 1) {
        return { width, height, data: rgb };
    }
    const rotate90 = normalized === 6 || normalized === 8;
    const outputWidth = rotate90 ? height : width;
    const outputHeight = rotate90 ? width : height;
    const output = new Float32Array(outputWidth * outputHeight * 3);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const srcIndex = getPixelIndex(width, x, y, 3);
            let tx = x;
            let ty = y;
            if (normalized === 3) {
                tx = width - 1 - x;
                ty = height - 1 - y;
            } else if (normalized === 6) {
                tx = height - 1 - y;
                ty = x;
            } else if (normalized === 8) {
                tx = y;
                ty = width - 1 - x;
            } else if (normalized === 2) {
                tx = width - 1 - x;
            } else if (normalized === 4) {
                ty = height - 1 - y;
            }
            const dstIndex = getPixelIndex(outputWidth, tx, ty, 3);
            output[dstIndex] = rgb[srcIndex];
            output[dstIndex + 1] = rgb[srcIndex + 1];
            output[dstIndex + 2] = rgb[srcIndex + 2];
        }
    }
    return { width: outputWidth, height: outputHeight, data: output };
}

function convertToOutputs(rgb, width, height, workingSpace) {
    const rgba8 = new Uint8ClampedArray(width * height * 4);
    const rgba16 = new Uint16Array(width * height * 4);
    const useLinear = workingSpace === 'linear';
    for (let index = 0; index < width * height; index += 1) {
        const srcOffset = index * 3;
        const dstOffset = index * 4;
        for (let channel = 0; channel < 3; channel += 1) {
            const linear = clamp(rgb[srcOffset + channel], 0, 1);
            const encoded = useLinear ? linear : srgbEncode(linear);
            rgba8[dstOffset + channel] = clamp(Math.round(encoded * 255), 0, 255);
            rgba16[dstOffset + channel] = clamp(Math.round(encoded * 65535), 0, 65535);
        }
        rgba8[dstOffset + 3] = 255;
        rgba16[dstOffset + 3] = 65535;
    }
    return { rgba8, rgba16 };
}

function computeBufferSignature(bytes) {
    const source = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += Math.max(1, Math.floor(source.length / 8192) || 1)) {
        hash ^= source[index];
        hash = Math.imul(hash, 16777619);
    }
    hash ^= source.length;
    return `dng-${(hash >>> 0).toString(16).padStart(8, '0')}-${source.length}`;
}

async function getParsed(buffer) {
    const signature = computeBufferSignature(buffer);
    if (!parsedCache.has(signature)) {
        parsedCache.set(signature, parseDngBuffer(buffer));
    }
    const parsed = parsedCache.get(signature);
    return { parsed, signature };
}

async function getRaster(parsed, signature) {
    if (!rasterCache.has(signature)) {
        rasterCache.set(signature, await decodeDngRaster(parsed));
    }
    return rasterCache.get(signature);
}

export async function probeDngBuffer(buffer) {
    const { parsed, signature } = await getParsed(buffer);
    return {
        sourceSignature: signature,
        probe: {
            ...parsed.probe,
            preset: getDngPresetForProbe(parsed.probe)
        }
    };
}

export async function prepareDngBuffer(buffer, params = null, options = {}) {
    const { parsed, signature } = await getParsed(buffer);
    const rawRaster = await getRaster(parsed, signature);
    const probe = parsed.probe;
    const normalizedParams = normalizeDngDevelopParams(params, probe);
    const previewQuality = options.previewQuality === 'high' ? 'high' : 'fast';
    const interpretationMode = resolveInterpretationMode(normalizedParams, probe);
    const raster = applyLinearizationTable(rawRaster, parsed, normalizedParams);

    let rgb = interpretationMode === 'linear'
        ? linearRasterToRgb(raster)
        : demosaicCfa(raster.data, raster.width, raster.height, probe, previewQuality === 'high' ? normalizedParams.dngDemosaicQuality : 'fast');
    rgb = normalizeRgb(rgb, raster, parsed, normalizedParams);
    rgb = applyWhiteBalance(rgb, parsed, normalizedParams);
    rgb = applyCameraColorTransform(rgb, probe, normalizedParams);
    rgb = applyToneAndDetail(rgb, raster.width, raster.height, normalizedParams, {
        partialFidelity: probe.fidelity !== 'supported'
    });
    const oriented = normalizedParams.dngApplyOrientation !== false
        ? applyOrientation(rgb, raster.width, raster.height, probe.orientation)
        : { width: raster.width, height: raster.height, data: rgb };
    const outputs = convertToOutputs(oriented.data, oriented.width, oriented.height, normalizedParams.dngWorkingSpace);

    const warnings = [...asArray(probe.warnings)];
    if ((probe.classificationMode === 'quad' || probe.classificationMode === 'interleaved') && normalizedParams.dngRemosaicMode !== 'off') {
        warnings.push('This build keeps quad/interleaved files on the generalized mosaic path. Explicit remosaic is not fully modeled yet.');
    }

    return {
        sourceSignature: signature,
        paramsHash: buildDngPrepareHash(normalizedParams, { previewQuality }),
        probe: {
            ...probe,
            preset: getDngPresetForProbe(probe)
        },
        preset: getDngPresetForProbe(probe),
        fidelity: warnings.length ? (probe.fidelity === 'unsupported' ? 'unsupported' : 'partial') : probe.fidelity,
        warnings,
        width: oriented.width,
        height: oriented.height,
        rgba8: outputs.rgba8,
        rgba16: outputs.rgba16
    };
}

export async function decodeDngBuffer(buffer) {
    const { parsed, signature } = await getParsed(buffer);
    const rawRaster = await getRaster(parsed, signature);
    return serializeDecodedDngSource(parsed, rawRaster, signature);
}

export async function exportDngBufferToPng16(buffer, params = null, options = {}) {
    const prepared = await prepareDngBuffer(buffer, params, {
        ...options,
        previewQuality: 'high'
    });
    const pngBytes = await encodePng16Rgba(prepared.width, prepared.height, prepared.rgba16);
    return {
        ...prepared,
        pngBytes
    };
}
