import {
    applyCandidateToDocument,
    computeCompositeBounds,
    computePlacementBounds,
    getActivePlacements,
    getPlacementByInput,
    getSelectedStitchInput,
    normalizeStitchDocument
} from './document.js';
import { analyzePreparedStitchInputs } from './analysis.js';
import { classifyPreparedInputs } from './classifier.js';
import { drawWarpedPlacement, hitTestWarpedPlacement } from './warp.js';

const SCREENSHOT_LEGACY_DEFAULTS = Object.freeze({
    analysisMaxDimension: 320,
    maxFeatures: 120,
    matchRatio: 0.8,
    ransacIterations: 180,
    inlierThreshold: 18
});
const OPENCV_BOOT_TIMEOUT_MS = 20000;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function createCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function canvasToBlob(canvas, type = 'image/png') {
    if (typeof canvas.convertToBlob === 'function') {
        return canvas.convertToBlob({ type });
    }
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Could not encode the stitch canvas.'));
        }, type);
    });
}

function viewportScale(bounds, canvasWidth, canvasHeight, zoom = 1) {
    const padding = 28;
    if (!bounds.width || !bounds.height) return 1;
    const fitScale = Math.min(
        (Math.max(1, canvasWidth) - (padding * 2)) / Math.max(1, bounds.width),
        (Math.max(1, canvasHeight) - (padding * 2)) / Math.max(1, bounds.height)
    );
    return Math.max(0.05, fitScale * (zoom || 1));
}

function rotatePoint(x, y, radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (x * cos) - (y * sin),
        y: (x * sin) + (y * cos)
    };
}

function createRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCandidateForPlacements(document, placements) {
    const normalized = normalizeStitchDocument(document);
    if (placements === normalized.placements) {
        return normalized.candidates.find((candidate) => candidate.id === normalized.activeCandidateId) || null;
    }
    return normalized.candidates.find((candidate) => candidate.placements === placements) || null;
}

const MAX_MULTI_BAND_LEVELS = 5;
const MIN_MULTI_BAND_DIMENSION = 24;
const MIN_BLEND_ALPHA = 2;
const MIN_GAIN_WEIGHT = 64;
const MIN_GAIN_MEAN = 10;
const GAIN_MIN = 0.72;
const GAIN_MAX = 1.4;
const CHANNEL_GAIN_MIX = 0.35;

function resolveBlendMode(document, placement, candidate = null) {
    const settingsBlend = document.settings?.blendMode || 'auto';
    const candidateBlend = candidate?.blendMode || settingsBlend;
    const requested = candidateBlend === 'auto' ? settingsBlend : candidateBlend;
    if (requested !== 'auto') return requested;
    return placement?.warp ? 'feather' : 'alpha';
}

function clampByte(value) {
    return Math.min(255, Math.max(0, Math.round(value)));
}

function smoothstep(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - (2 * t));
}

function buildBlendRegion(bounds, canvasWidth, canvasHeight) {
    const minX = clamp(Math.floor(Math.min(bounds.minX, bounds.maxX)), 0, Math.max(0, canvasWidth - 1));
    const minY = clamp(Math.floor(Math.min(bounds.minY, bounds.maxY)), 0, Math.max(0, canvasHeight - 1));
    const maxX = clamp(Math.ceil(Math.max(bounds.minX, bounds.maxX)), minX + 1, Math.max(1, canvasWidth));
    const maxY = clamp(Math.ceil(Math.max(bounds.minY, bounds.maxY)), minY + 1, Math.max(1, canvasHeight));
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}

function scaleImageAlpha(data, opacity = 1) {
    if (opacity >= 0.999) return;
    for (let index = 0; index < data.length; index += 4) {
        data[index + 3] = clampByte((data[index + 3] || 0) * opacity);
    }
}

function computeLuminance(r, g, b) {
    return (r * 0.299) + (g * 0.587) + (b * 0.114);
}

function computeEdgeStrengthMap(imageData, width, height) {
    const luminance = new Float32Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
        const offset = index * 4;
        luminance[index] = computeLuminance(
            imageData[offset] || 0,
            imageData[offset + 1] || 0,
            imageData[offset + 2] || 0
        );
    }

    const edge = new Float32Array(width * height);
    let maxValue = 1;
    for (let y = 0; y < height; y += 1) {
        const rowOffset = y * width;
        const prevRowOffset = Math.max(0, y - 1) * width;
        const nextRowOffset = Math.min(height - 1, y + 1) * width;
        for (let x = 0; x < width; x += 1) {
            const index = rowOffset + x;
            const left = luminance[rowOffset + Math.max(0, x - 1)] || 0;
            const right = luminance[rowOffset + Math.min(width - 1, x + 1)] || 0;
            const up = luminance[prevRowOffset + x] || 0;
            const down = luminance[nextRowOffset + x] || 0;
            const value = Math.abs(right - left) + Math.abs(down - up);
            edge[index] = value;
            if (value > maxValue) maxValue = value;
        }
    }
    const inverseMax = 1 / Math.max(1, maxValue);
    for (let index = 0; index < edge.length; index += 1) {
        edge[index] *= inverseMax;
    }
    return edge;
}

function analyzeBlendOverlap(baseData, layerData, width, height) {
    const overlapMask = new Uint8Array(width * height);
    let overlapCount = 0;
    let baseCount = 0;
    let layerCount = 0;
    let overlapMinX = width;
    let overlapMinY = height;
    let overlapMaxX = -1;
    let overlapMaxY = -1;

    for (let index = 0; index < width * height; index += 1) {
        const dataIndex = index * 4;
        const baseAlpha = baseData[dataIndex + 3] || 0;
        const layerAlpha = layerData[dataIndex + 3] || 0;
        const hasBase = baseAlpha > MIN_BLEND_ALPHA;
        const hasLayer = layerAlpha > MIN_BLEND_ALPHA;
        if (hasBase) baseCount += 1;
        if (hasLayer) layerCount += 1;
        if (!hasBase || !hasLayer) continue;
        overlapMask[index] = 1;
        overlapCount += 1;
        const x = index % width;
        const y = Math.floor(index / width);
        if (x < overlapMinX) overlapMinX = x;
        if (y < overlapMinY) overlapMinY = y;
        if (x > overlapMaxX) overlapMaxX = x;
        if (y > overlapMaxY) overlapMaxY = y;
    }

    return {
        overlapMask,
        overlapCount,
        baseCount,
        layerCount,
        overlapMinX,
        overlapMinY,
        overlapMaxX,
        overlapMaxY
    };
}

function determineBlendOrientation(overlapWidth, overlapHeight) {
    return overlapWidth >= overlapHeight ? 'vertical' : 'horizontal';
}

function determineBlendSide(width, height, overlap, orientation) {
    if (orientation === 'vertical') {
        const leftMargin = overlap.overlapMinX;
        const rightMargin = Math.max(0, (width - 1) - overlap.overlapMaxX);
        return rightMargin >= leftMargin ? 'right' : 'left';
    }
    const topMargin = overlap.overlapMinY;
    const bottomMargin = Math.max(0, (height - 1) - overlap.overlapMaxY);
    return bottomMargin >= topMargin ? 'bottom' : 'top';
}

function buildLinearSelectionMask(mask, overlapMask, width, height, overlap, orientation, side) {
    const overlapWidth = Math.max(1, (overlap.overlapMaxX - overlap.overlapMinX) + 1);
    const overlapHeight = Math.max(1, (overlap.overlapMaxY - overlap.overlapMinY) + 1);
    const widthSpan = Math.max(1, overlapWidth - 1);
    const heightSpan = Math.max(1, overlapHeight - 1);

    for (let y = overlap.overlapMinY; y <= overlap.overlapMaxY; y += 1) {
        for (let x = overlap.overlapMinX; x <= overlap.overlapMaxX; x += 1) {
            const index = (y * width) + x;
            if (!overlapMask[index]) continue;
            const t = orientation === 'vertical'
                ? (x - overlap.overlapMinX) / widthSpan
                : (y - overlap.overlapMinY) / heightSpan;
            const eased = smoothstep(t);
            mask[index] = side === 'right' || side === 'bottom' ? eased : (1 - eased);
        }
    }
}

function findContentAwareSeam(costs, overlapMask, width, height, orientation = 'vertical') {
    const huge = 1e9;
    if (orientation === 'vertical') {
        const accumulated = new Float32Array(width * height);
        const backtrack = new Int16Array(width * height);
        for (let x = 0; x < width; x += 1) {
            accumulated[x] = overlapMask[x] ? costs[x] : huge;
            backtrack[x] = -1;
        }
        for (let y = 1; y < height; y += 1) {
            const rowOffset = y * width;
            const prevOffset = (y - 1) * width;
            for (let x = 0; x < width; x += 1) {
                const index = rowOffset + x;
                if (!overlapMask[index]) {
                    accumulated[index] = huge;
                    backtrack[index] = -1;
                    continue;
                }
                let bestX = x;
                let bestCost = accumulated[prevOffset + x];
                if (x > 0 && accumulated[prevOffset + x - 1] < bestCost) {
                    bestCost = accumulated[prevOffset + x - 1];
                    bestX = x - 1;
                }
                if (x < width - 1 && accumulated[prevOffset + x + 1] < bestCost) {
                    bestCost = accumulated[prevOffset + x + 1];
                    bestX = x + 1;
                }
                accumulated[index] = costs[index] + bestCost;
                backtrack[index] = bestX;
            }
        }
        let bestX = -1;
        let bestCost = huge;
        const lastOffset = (height - 1) * width;
        for (let x = 0; x < width; x += 1) {
            const cost = accumulated[lastOffset + x];
            if (cost < bestCost) {
                bestCost = cost;
                bestX = x;
            }
        }
        if (bestX < 0 || bestCost >= huge * 0.5) return null;
        const seam = new Int16Array(height);
        seam[height - 1] = bestX;
        for (let y = height - 1; y > 0; y -= 1) {
            const nextX = seam[y];
            const previousX = backtrack[(y * width) + nextX];
            if (previousX < 0) return null;
            seam[y - 1] = previousX;
        }
        return seam;
    }

    const accumulated = new Float32Array(width * height);
    const backtrack = new Int16Array(width * height);
    for (let y = 0; y < height; y += 1) {
        const index = y * width;
        accumulated[index] = overlapMask[index] ? costs[index] : huge;
        backtrack[index] = -1;
    }
    for (let x = 1; x < width; x += 1) {
        for (let y = 0; y < height; y += 1) {
            const index = (y * width) + x;
            if (!overlapMask[index]) {
                accumulated[index] = huge;
                backtrack[index] = -1;
                continue;
            }
            let bestY = y;
            let bestCost = accumulated[(y * width) + x - 1];
            if (y > 0 && accumulated[((y - 1) * width) + x - 1] < bestCost) {
                bestCost = accumulated[((y - 1) * width) + x - 1];
                bestY = y - 1;
            }
            if (y < height - 1 && accumulated[((y + 1) * width) + x - 1] < bestCost) {
                bestCost = accumulated[((y + 1) * width) + x - 1];
                bestY = y + 1;
            }
            accumulated[index] = costs[index] + bestCost;
            backtrack[index] = bestY;
        }
    }
    let bestY = -1;
    let bestCost = huge;
    for (let y = 0; y < height; y += 1) {
        const index = (y * width) + (width - 1);
        const cost = accumulated[index];
        if (cost < bestCost) {
            bestCost = cost;
            bestY = y;
        }
    }
    if (bestY < 0 || bestCost >= huge * 0.5) return null;
    const seam = new Int16Array(width);
    seam[width - 1] = bestY;
    for (let x = width - 1; x > 0; x -= 1) {
        const nextY = seam[x];
        const previousY = backtrack[(nextY * width) + x];
        if (previousY < 0) return null;
        seam[x - 1] = previousY;
    }
    return seam;
}

function buildSeamSelectionMask(mask, baseData, layerData, overlapMask, width, height, overlap, orientation, side) {
    const overlapWidth = (overlap.overlapMaxX - overlap.overlapMinX) + 1;
    const overlapHeight = (overlap.overlapMaxY - overlap.overlapMinY) + 1;
    if (overlapWidth < 8 || overlapHeight < 8) return false;

    const costs = new Float32Array(width * height);
    const baseEdge = computeEdgeStrengthMap(baseData, width, height);
    const layerEdge = computeEdgeStrengthMap(layerData, width, height);

    for (let index = 0; index < width * height; index += 1) {
        if (!overlapMask[index]) continue;
        const dataIndex = index * 4;
        const diff = (
            Math.abs((baseData[dataIndex] || 0) - (layerData[dataIndex] || 0))
            + Math.abs((baseData[dataIndex + 1] || 0) - (layerData[dataIndex + 1] || 0))
            + Math.abs((baseData[dataIndex + 2] || 0) - (layerData[dataIndex + 2] || 0))
        ) / 255;
        const edgePenalty = (baseEdge[index] + layerEdge[index]) * 0.45;
        costs[index] = 1 + (diff * 0.75) + edgePenalty;
    }

    const seam = findContentAwareSeam(costs, overlapMask, width, height, orientation);
    if (!seam) return false;

    const feather = Math.max(3, Math.round(Math.min(overlapWidth, overlapHeight) * 0.04));
    for (let y = overlap.overlapMinY; y <= overlap.overlapMaxY; y += 1) {
        for (let x = overlap.overlapMinX; x <= overlap.overlapMaxX; x += 1) {
            const index = (y * width) + x;
            if (!overlapMask[index]) continue;
            let blend = 1;
            if (orientation === 'vertical') {
                const seamX = seam[y] || 0;
                const distance = x - seamX;
                if (side === 'right') {
                    if (distance <= -feather) blend = 0;
                    else if (distance < feather) blend = (distance + feather) / (feather * 2);
                } else {
                    if (distance >= feather) blend = 0;
                    else if (distance > -feather) blend = 1 - ((distance + feather) / (feather * 2));
                }
            } else {
                const seamY = seam[x] || 0;
                const distance = y - seamY;
                if (side === 'bottom') {
                    if (distance <= -feather) blend = 0;
                    else if (distance < feather) blend = (distance + feather) / (feather * 2);
                } else {
                    if (distance >= feather) blend = 0;
                    else if (distance > -feather) blend = 1 - ((distance + feather) / (feather * 2));
                }
            }
            mask[index] = clamp(blend, 0, 1);
        }
    }

    return true;
}

function buildSelectionMask(baseData, layerData, width, height, blendMode, overlap) {
    const mask = new Float32Array(width * height);
    for (let index = 0; index < width * height; index += 1) {
        const dataIndex = index * 4;
        const baseAlpha = baseData[dataIndex + 3] || 0;
        const layerAlpha = layerData[dataIndex + 3] || 0;
        mask[index] = layerAlpha > MIN_BLEND_ALPHA && baseAlpha <= MIN_BLEND_ALPHA ? 1 : 0;
    }

    if (!overlap.overlapCount || overlap.overlapMaxX < overlap.overlapMinX || overlap.overlapMaxY < overlap.overlapMinY) {
        return mask;
    }

    const overlapWidth = (overlap.overlapMaxX - overlap.overlapMinX) + 1;
    const overlapHeight = (overlap.overlapMaxY - overlap.overlapMinY) + 1;
    const orientation = determineBlendOrientation(overlapWidth, overlapHeight);
    const side = determineBlendSide(width, height, overlap, orientation);
    const applied = blendMode === 'seam'
        ? buildSeamSelectionMask(mask, baseData, layerData, overlap.overlapMask, width, height, overlap, orientation, side)
        : false;
    if (!applied) {
        buildLinearSelectionMask(mask, overlap.overlapMask, width, height, overlap, orientation, side);
    }
    return mask;
}

function computeGainCompensation(baseData, layerData, overlapMask) {
    const baseSum = [0, 0, 0];
    const layerSum = [0, 0, 0];
    let baseLuma = 0;
    let layerLuma = 0;
    let weightSum = 0;

    for (let index = 0; index < overlapMask.length; index += 1) {
        if (!overlapMask[index]) continue;
        const dataIndex = index * 4;
        const baseAlpha = (baseData[dataIndex + 3] || 0) / 255;
        const layerAlpha = (layerData[dataIndex + 3] || 0) / 255;
        const weight = Math.max(0.001, baseAlpha * layerAlpha);
        baseSum[0] += (baseData[dataIndex] || 0) * weight;
        baseSum[1] += (baseData[dataIndex + 1] || 0) * weight;
        baseSum[2] += (baseData[dataIndex + 2] || 0) * weight;
        layerSum[0] += (layerData[dataIndex] || 0) * weight;
        layerSum[1] += (layerData[dataIndex + 1] || 0) * weight;
        layerSum[2] += (layerData[dataIndex + 2] || 0) * weight;
        baseLuma += computeLuminance(baseData[dataIndex] || 0, baseData[dataIndex + 1] || 0, baseData[dataIndex + 2] || 0) * weight;
        layerLuma += computeLuminance(layerData[dataIndex] || 0, layerData[dataIndex + 1] || 0, layerData[dataIndex + 2] || 0) * weight;
        weightSum += weight;
    }

    if (weightSum < MIN_GAIN_WEIGHT) return [1, 1, 1];
    const baseMean = baseSum.map((value) => value / weightSum);
    const layerMean = layerSum.map((value) => value / weightSum);
    const baseLumaMean = baseLuma / weightSum;
    const layerLumaMean = layerLuma / weightSum;
    if (baseLumaMean < MIN_GAIN_MEAN || layerLumaMean < MIN_GAIN_MEAN) return [1, 1, 1];

    const lumaGain = clamp(baseLumaMean / Math.max(MIN_GAIN_MEAN, layerLumaMean), GAIN_MIN, GAIN_MAX);
    return baseMean.map((channelMean, channelIndex) => {
        const channelGain = clamp(channelMean / Math.max(MIN_GAIN_MEAN, layerMean[channelIndex]), GAIN_MIN, GAIN_MAX);
        return clamp((channelGain * CHANNEL_GAIN_MIX) + (lumaGain * (1 - CHANNEL_GAIN_MIX)), GAIN_MIN, GAIN_MAX);
    });
}

function applyGainToLayerData(data, gains) {
    if (gains.every((gain) => Math.abs(gain - 1) < 0.001)) return;
    for (let index = 0; index < data.length; index += 4) {
        if ((data[index + 3] || 0) <= MIN_BLEND_ALPHA) continue;
        data[index] = clampByte((data[index] || 0) * gains[0]);
        data[index + 1] = clampByte((data[index + 1] || 0) * gains[1]);
        data[index + 2] = clampByte((data[index + 2] || 0) * gains[2]);
    }
}

function composeCoverageAlpha(baseAlpha = 0, layerAlpha = 0) {
    const normalizedBase = clamp(baseAlpha, 0, 255) / 255;
    const normalizedLayer = clamp(layerAlpha, 0, 255) / 255;
    return clampByte((1 - ((1 - normalizedBase) * (1 - normalizedLayer))) * 255);
}

function imageDataToPremultipliedFloat(data) {
    const result = new Float32Array(data.length);
    for (let index = 0; index < data.length; index += 4) {
        const alpha = clamp(data[index + 3] || 0, 0, 255);
        const alphaScale = alpha / 255;
        result[index] = (data[index] || 0) * alphaScale;
        result[index + 1] = (data[index + 1] || 0) * alphaScale;
        result[index + 2] = (data[index + 2] || 0) * alphaScale;
        result[index + 3] = alpha;
    }
    return result;
}

function downsampleRgba(data, width, height) {
    const targetWidth = Math.max(1, Math.ceil(width / 2));
    const targetHeight = Math.max(1, Math.ceil(height / 2));
    const result = new Float32Array(targetWidth * targetHeight * 4);

    for (let y = 0; y < targetHeight; y += 1) {
        for (let x = 0; x < targetWidth; x += 1) {
            const sourceX = x * 2;
            const sourceY = y * 2;
            const targetIndex = ((y * targetWidth) + x) * 4;
            let count = 0;
            for (let offsetY = 0; offsetY < 2; offsetY += 1) {
                for (let offsetX = 0; offsetX < 2; offsetX += 1) {
                    const sampleX = sourceX + offsetX;
                    const sampleY = sourceY + offsetY;
                    if (sampleX >= width || sampleY >= height) continue;
                    const sourceIndex = ((sampleY * width) + sampleX) * 4;
                    result[targetIndex] += data[sourceIndex] || 0;
                    result[targetIndex + 1] += data[sourceIndex + 1] || 0;
                    result[targetIndex + 2] += data[sourceIndex + 2] || 0;
                    result[targetIndex + 3] += data[sourceIndex + 3] || 0;
                    count += 1;
                }
            }
            const scale = 1 / Math.max(1, count);
            result[targetIndex] *= scale;
            result[targetIndex + 1] *= scale;
            result[targetIndex + 2] *= scale;
            result[targetIndex + 3] *= scale;
        }
    }

    return { data: result, width: targetWidth, height: targetHeight };
}

function downsampleScalar(data, width, height) {
    const targetWidth = Math.max(1, Math.ceil(width / 2));
    const targetHeight = Math.max(1, Math.ceil(height / 2));
    const result = new Float32Array(targetWidth * targetHeight);

    for (let y = 0; y < targetHeight; y += 1) {
        for (let x = 0; x < targetWidth; x += 1) {
            const sourceX = x * 2;
            const sourceY = y * 2;
            let value = 0;
            let count = 0;
            for (let offsetY = 0; offsetY < 2; offsetY += 1) {
                for (let offsetX = 0; offsetX < 2; offsetX += 1) {
                    const sampleX = sourceX + offsetX;
                    const sampleY = sourceY + offsetY;
                    if (sampleX >= width || sampleY >= height) continue;
                    value += data[(sampleY * width) + sampleX] || 0;
                    count += 1;
                }
            }
            result[(y * targetWidth) + x] = value / Math.max(1, count);
        }
    }

    return { data: result, width: targetWidth, height: targetHeight };
}

function upsampleRgba(data, width, height, targetWidth, targetHeight) {
    const result = new Float32Array(targetWidth * targetHeight * 4);
    for (let y = 0; y < targetHeight; y += 1) {
        const sourceY = height === 1 || targetHeight === 1 ? 0 : (y * (height - 1)) / Math.max(1, targetHeight - 1);
        const y0 = Math.floor(sourceY);
        const y1 = Math.min(height - 1, y0 + 1);
        const yMix = sourceY - y0;
        for (let x = 0; x < targetWidth; x += 1) {
            const sourceX = width === 1 || targetWidth === 1 ? 0 : (x * (width - 1)) / Math.max(1, targetWidth - 1);
            const x0 = Math.floor(sourceX);
            const x1 = Math.min(width - 1, x0 + 1);
            const xMix = sourceX - x0;
            const targetIndex = ((y * targetWidth) + x) * 4;
            const topLeft = ((y0 * width) + x0) * 4;
            const topRight = ((y0 * width) + x1) * 4;
            const bottomLeft = ((y1 * width) + x0) * 4;
            const bottomRight = ((y1 * width) + x1) * 4;

            for (let channel = 0; channel < 4; channel += 1) {
                const top = ((data[topLeft + channel] || 0) * (1 - xMix)) + ((data[topRight + channel] || 0) * xMix);
                const bottom = ((data[bottomLeft + channel] || 0) * (1 - xMix)) + ((data[bottomRight + channel] || 0) * xMix);
                result[targetIndex + channel] = (top * (1 - yMix)) + (bottom * yMix);
            }
        }
    }
    return result;
}

function upsampleScalar(data, width, height, targetWidth, targetHeight) {
    const result = new Float32Array(targetWidth * targetHeight);
    for (let y = 0; y < targetHeight; y += 1) {
        const sourceY = height === 1 || targetHeight === 1 ? 0 : (y * (height - 1)) / Math.max(1, targetHeight - 1);
        const y0 = Math.floor(sourceY);
        const y1 = Math.min(height - 1, y0 + 1);
        const yMix = sourceY - y0;
        for (let x = 0; x < targetWidth; x += 1) {
            const sourceX = width === 1 || targetWidth === 1 ? 0 : (x * (width - 1)) / Math.max(1, targetWidth - 1);
            const x0 = Math.floor(sourceX);
            const x1 = Math.min(width - 1, x0 + 1);
            const xMix = sourceX - x0;
            const top = ((data[(y0 * width) + x0] || 0) * (1 - xMix)) + ((data[(y0 * width) + x1] || 0) * xMix);
            const bottom = ((data[(y1 * width) + x0] || 0) * (1 - xMix)) + ((data[(y1 * width) + x1] || 0) * xMix);
            result[(y * targetWidth) + x] = (top * (1 - yMix)) + (bottom * yMix);
        }
    }
    return result;
}

function buildGaussianPyramidRgba(data, width, height, levels) {
    const pyramid = [{ data, width, height }];
    while (pyramid.length < levels) {
        const previous = pyramid[pyramid.length - 1];
        if (previous.width <= 1 && previous.height <= 1) break;
        pyramid.push(downsampleRgba(previous.data, previous.width, previous.height));
    }
    return pyramid;
}

function buildGaussianPyramidScalar(data, width, height, levels) {
    const pyramid = [{ data, width, height }];
    while (pyramid.length < levels) {
        const previous = pyramid[pyramid.length - 1];
        if (previous.width <= 1 && previous.height <= 1) break;
        pyramid.push(downsampleScalar(previous.data, previous.width, previous.height));
    }
    return pyramid;
}

function buildLaplacianPyramidRgba(gaussianPyramid) {
    const pyramid = [];
    for (let level = 0; level < gaussianPyramid.length - 1; level += 1) {
        const current = gaussianPyramid[level];
        const next = gaussianPyramid[level + 1];
        const expanded = upsampleRgba(next.data, next.width, next.height, current.width, current.height);
        const band = new Float32Array(current.data.length);
        for (let index = 0; index < current.data.length; index += 1) {
            band[index] = (current.data[index] || 0) - (expanded[index] || 0);
        }
        pyramid.push({
            data: band,
            width: current.width,
            height: current.height
        });
    }
    pyramid.push(gaussianPyramid[gaussianPyramid.length - 1]);
    return pyramid;
}

function chooseMultiBandLevels(width, height) {
    let levels = 1;
    let minDimension = Math.min(width, height);
    while (levels < MAX_MULTI_BAND_LEVELS && minDimension >= MIN_MULTI_BAND_DIMENSION) {
        levels += 1;
        minDimension = Math.floor(minDimension / 2);
    }
    return levels;
}

function blendMultiBandImages(baseData, layerData, mask, width, height) {
    const levels = chooseMultiBandLevels(width, height);
    const basePyramid = buildLaplacianPyramidRgba(buildGaussianPyramidRgba(imageDataToPremultipliedFloat(baseData), width, height, levels));
    const layerPyramid = buildLaplacianPyramidRgba(buildGaussianPyramidRgba(imageDataToPremultipliedFloat(layerData), width, height, levels));
    const maskPyramid = buildGaussianPyramidScalar(mask, width, height, levels);

    const blended = basePyramid.map((level, index) => {
        const maskLevel = maskPyramid[Math.min(index, maskPyramid.length - 1)];
        const result = new Float32Array(level.data.length);
        for (let pixelIndex = 0; pixelIndex < maskLevel.data.length; pixelIndex += 1) {
            const blend = clamp(maskLevel.data[pixelIndex] || 0, 0, 1);
            const baseOffset = pixelIndex * 4;
            result[baseOffset] = ((basePyramid[index].data[baseOffset] || 0) * (1 - blend)) + ((layerPyramid[index].data[baseOffset] || 0) * blend);
            result[baseOffset + 1] = ((basePyramid[index].data[baseOffset + 1] || 0) * (1 - blend)) + ((layerPyramid[index].data[baseOffset + 1] || 0) * blend);
            result[baseOffset + 2] = ((basePyramid[index].data[baseOffset + 2] || 0) * (1 - blend)) + ((layerPyramid[index].data[baseOffset + 2] || 0) * blend);
            result[baseOffset + 3] = ((basePyramid[index].data[baseOffset + 3] || 0) * (1 - blend)) + ((layerPyramid[index].data[baseOffset + 3] || 0) * blend);
        }
        return {
            data: result,
            width: level.width,
            height: level.height
        };
    });

    let reconstructed = blended[blended.length - 1];
    for (let level = blended.length - 2; level >= 0; level -= 1) {
        const expanded = upsampleRgba(reconstructed.data, reconstructed.width, reconstructed.height, blended[level].width, blended[level].height);
        const result = new Float32Array(blended[level].data.length);
        for (let index = 0; index < result.length; index += 1) {
            result[index] = (blended[level].data[index] || 0) + (expanded[index] || 0);
        }
        reconstructed = {
            data: result,
            width: blended[level].width,
            height: blended[level].height
        };
    }

    const output = new Uint8ClampedArray(width * height * 4);
    for (let index = 0; index < output.length; index += 4) {
        const reconstructedAlpha = clamp(reconstructed.data[index + 3] || 0, 0, 255);
        const coverageAlpha = composeCoverageAlpha(baseData[index + 3] || 0, layerData[index + 3] || 0);
        const alpha = Math.max(reconstructedAlpha, coverageAlpha);
        if (alpha <= 0.001) {
            output[index] = 0;
            output[index + 1] = 0;
            output[index + 2] = 0;
            output[index + 3] = 0;
            continue;
        }
        const unpremultiply = 255 / alpha;
        output[index] = clampByte((reconstructed.data[index] || 0) * unpremultiply);
        output[index + 1] = clampByte((reconstructed.data[index + 1] || 0) * unpremultiply);
        output[index + 2] = clampByte((reconstructed.data[index + 2] || 0) * unpremultiply);
        output[index + 3] = clampByte(alpha);
    }
    return output;
}

function blendLayerIntoCompositeRegion(compositeCtx, layerCtx, region, blendMode, opacity = 1) {
    if (!region.width || !region.height) return false;
    const baseImage = compositeCtx.getImageData(region.minX, region.minY, region.width, region.height);
    const layerImage = layerCtx.getImageData(region.minX, region.minY, region.width, region.height);
    const baseData = baseImage.data;
    const layerData = layerImage.data;
    scaleImageAlpha(layerData, opacity);

    const overlap = analyzeBlendOverlap(baseData, layerData, region.width, region.height);
    if (!overlap.layerCount || !overlap.overlapCount) return false;

    const selectionMask = buildSelectionMask(baseData, layerData, region.width, region.height, blendMode, overlap);
    const gains = computeGainCompensation(baseData, layerData, overlap.overlapMask);
    applyGainToLayerData(layerData, gains);

    const blendedData = blendMultiBandImages(baseData, layerData, selectionMask, region.width, region.height);
    const output = compositeCtx.createImageData(region.width, region.height);
    output.data.set(blendedData);
    compositeCtx.putImageData(output, region.minX, region.minY);
    return true;
}

export class StitchEngine {
    constructor() {
        this.canvas = null;
        this.ctx = null;
        this.imageCache = new Map();
        this.renderRequested = false;
        this.worker = null;
        this.opencvWorker = null;
        this.opencvWorkerReady = null;
        this.pendingRequests = new Map();
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        this.compositeCanvas = null;
        this.compositeCtx = null;
        this.runtime = {
            renderWidth: 0,
            renderHeight: 0,
            bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 },
            viewport: { scale: 1, offsetX: 0, offsetY: 0, width: 1, height: 1 }
        };
    }

    attachCanvas(canvas) {
        this.canvas = canvas || null;
        this.ctx = this.canvas ? this.canvas.getContext('2d') : null;
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        this.compositeCanvas = null;
        this.compositeCtx = null;
    }

    getOffscreenContext(width, height) {
        if (!this.offscreenCanvas || this.offscreenCanvas.width !== width || this.offscreenCanvas.height !== height) {
            this.offscreenCanvas = createCanvas(width, height);
            this.offscreenCtx = this.offscreenCanvas.getContext('2d');
        }
        this.offscreenCtx.clearRect(0, 0, width, height);
        this.offscreenCtx.imageSmoothingEnabled = true;
        return this.offscreenCtx;
    }

    getCompositeContext(width, height) {
        if (!this.compositeCanvas || this.compositeCanvas.width !== width || this.compositeCanvas.height !== height) {
            this.compositeCanvas = createCanvas(width, height);
            this.compositeCtx = this.compositeCanvas.getContext('2d');
        }
        this.compositeCtx.clearRect(0, 0, width, height);
        this.compositeCtx.imageSmoothingEnabled = true;
        return this.compositeCtx;
    }

    async ensureWorker() {
        if (this.worker || typeof Worker !== 'function') return this.worker;
        try {
            this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
            this.worker.addEventListener('message', (event) => {
                const { requestId, result, error } = event.data || {};
                const pending = this.pendingRequests.get(requestId);
                if (!pending) return;
                this.pendingRequests.delete(requestId);
                if (error) pending.reject(new Error(error));
                else pending.resolve(result);
            });
        } catch (_error) {
            this.worker = null;
        }
        return this.worker;
    }

    async ensureOpenCvWorker() {
        if (this.opencvWorker) return this.opencvWorker;
        if (this.opencvWorkerReady) return this.opencvWorkerReady;
        if (typeof Worker !== 'function') return null;

        this.opencvWorkerReady = new Promise((resolve, reject) => {
            let settled = false;
            let bootTimer = null;
            try {
                console.info('[Stitch/OpenCV] Starting photo worker...');
                const worker = new Worker(new URL('./opencv-worker.js', import.meta.url));
                this.opencvWorker = worker;
                const fail = (error) => {
                    if (settled) return;
                    settled = true;
                    if (bootTimer) clearTimeout(bootTimer);
                    this.opencvWorkerReady = null;
                    this.opencvWorker = null;
                    console.error('[Stitch/OpenCV] Worker failed to initialize:', error || 'Unknown boot error');
                    try {
                        worker.terminate();
                    } catch (_error) {
                        // Ignore worker shutdown failures after init errors.
                    }
                    reject(new Error(error || 'OpenCV.js could not initialize for Stitch photo analysis.'));
                };

                bootTimer = setTimeout(() => {
                    fail(`OpenCV.js did not finish loading within ${Math.round(OPENCV_BOOT_TIMEOUT_MS / 1000)} seconds.`);
                }, OPENCV_BOOT_TIMEOUT_MS);

                worker.addEventListener('message', (event) => {
                    const { type, requestId, result, error, progress } = event.data || {};
                    if (type === 'ready') {
                        if (settled) return;
                        settled = true;
                        if (bootTimer) clearTimeout(bootTimer);
                        console.info('[Stitch/OpenCV] Worker ready.');
                        resolve(worker);
                        return;
                    }
                    if (type === 'init-error') {
                        fail(error || 'OpenCV.js could not initialize for Stitch photo analysis.');
                        return;
                    }
                    if (type === 'progress') {
                        const pending = this.pendingRequests.get(requestId);
                        if (pending?.onProgress) pending.onProgress(progress || event.data || {});
                        return;
                    }
                    const pending = this.pendingRequests.get(requestId);
                    if (!pending) return;
                    this.pendingRequests.delete(requestId);
                    if (error) pending.reject(new Error(error));
                    else pending.resolve(result);
                });

                worker.addEventListener('error', () => {
                    fail('OpenCV.js photo analysis failed to start. Reload the page and try again.');
                });
            } catch (_error) {
                this.opencvWorkerReady = null;
                this.opencvWorker = null;
                reject(new Error('OpenCV.js photo analysis could not start in this browser.'));
            }
        });

        return this.opencvWorkerReady;
    }

    async getImage(input) {
        if (!input?.id || !input.imageData) return null;
        const cached = this.imageCache.get(input.id);
        if (cached?.src === input.imageData && cached.image) {
            return cached.image;
        }
        if (cached?.src === input.imageData && cached.promise) {
            return cached.promise;
        }
        const promise = new Promise((resolve, reject) => {
            const image = new Image();
            image.onload = () => {
                this.imageCache.set(input.id, { src: input.imageData, image });
                resolve(image);
            };
            image.onerror = () => reject(new Error(`Could not load ${input.name || 'stitch image'}.`));
            image.src = input.imageData;
        });
        this.imageCache.set(input.id, { src: input.imageData, promise });
        return promise;
    }

    async ensureImages(document) {
        const normalized = normalizeStitchDocument(document);
        const liveIds = new Set(normalized.inputs.map((input) => input.id));
        for (const key of [...this.imageCache.keys()]) {
            if (!liveIds.has(key)) this.imageCache.delete(key);
        }
        await Promise.all(normalized.inputs.map((input) => this.getImage(input)));
    }

    resizeAttachedCanvas() {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const width = Math.max(1, Math.round(rect.width * dpr));
        const height = Math.max(1, Math.round(rect.height * dpr));
        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }
    }

    computeViewport(document, canvasWidth, canvasHeight, placements = null) {
        const normalized = normalizeStitchDocument(document);
        const bounds = computeCompositeBounds(normalized, placements);
        const scale = viewportScale(bounds, canvasWidth, canvasHeight, normalized.view.zoom);
        const offsetX = ((canvasWidth - (bounds.width * scale)) * 0.5) - (bounds.minX * scale) + (normalized.view.panX || 0);
        const offsetY = ((canvasHeight - (bounds.height * scale)) * 0.5) - (bounds.minY * scale) + (normalized.view.panY || 0);
        return {
            bounds,
            scale,
            offsetX,
            offsetY,
            width: canvasWidth,
            height: canvasHeight
        };
    }

    drawDocumentToContext(ctx, document, options = {}) {
        const normalized = normalizeStitchDocument(document);
        const placements = options.placements || getActivePlacements(normalized);
        const activeCandidate = options.candidate || getCandidateForPlacements(normalized, placements) || normalized.candidates.find((candidate) => candidate.id === normalized.activeCandidateId) || null;
        const viewport = options.viewport || this.computeViewport(normalized, ctx.canvas.width, ctx.canvas.height, placements);
        const background = options.background || (normalized.view.theme === 'dark' ? '#08090d' : '#f4f5f7');
        const toCanvasPoint = (worldPoint) => ({
            x: viewport.offsetX + (worldPoint.x * viewport.scale),
            y: viewport.offsetY + (worldPoint.y * viewport.scale)
        });
        const compositeCtx = this.getCompositeContext(ctx.canvas.width, ctx.canvas.height);
        compositeCtx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.save();
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.imageSmoothingEnabled = true;

        placements
            .filter((placement) => placement.visible !== false)
            .sort((a, b) => (a.z || 0) - (b.z || 0))
            .forEach((placement) => {
                const input = normalized.inputs.find((item) => item.id === placement.inputId);
                const cached = this.imageCache.get(input?.id);
                const image = cached?.image;
                if (!input || !image) return;
                const alpha = clamp(Number(placement.opacity) || 1, 0, 1);
                const blendMode = resolveBlendMode(normalized, placement, activeCandidate);
                if (blendMode === 'alpha') {
                    drawWarpedPlacement(compositeCtx, image, input, placement, (worldPoint) => toCanvasPoint(worldPoint), { alpha });
                } else {
                    const layerCtx = this.getOffscreenContext(ctx.canvas.width, ctx.canvas.height);
                    drawWarpedPlacement(layerCtx, image, input, placement, (worldPoint) => toCanvasPoint(worldPoint), { alpha: 1 });
                    const bounds = computePlacementBounds(input, placement);
                    const canvasBounds = {
                        minX: toCanvasPoint({ x: bounds.minX, y: bounds.minY }).x,
                        minY: toCanvasPoint({ x: bounds.minX, y: bounds.minY }).y,
                        maxX: toCanvasPoint({ x: bounds.maxX, y: bounds.maxY }).x,
                        maxY: toCanvasPoint({ x: bounds.maxX, y: bounds.maxY }).y
                    };
                    const region = buildBlendRegion(canvasBounds, ctx.canvas.width, ctx.canvas.height);
                    const blended = blendLayerIntoCompositeRegion(compositeCtx, layerCtx, region, blendMode, alpha);
                    if (!blended) {
                        compositeCtx.save();
                        compositeCtx.globalAlpha = alpha;
                        compositeCtx.drawImage(this.offscreenCanvas, 0, 0);
                        compositeCtx.restore();
                    }
                }

            });

        ctx.drawImage(this.compositeCanvas, 0, 0);
        placements
            .filter((placement) => placement.visible !== false)
            .sort((a, b) => (a.z || 0) - (b.z || 0))
            .forEach((placement) => {
                const input = normalized.inputs.find((item) => item.id === placement.inputId);
                if (!input) return;

                if (normalized.view.showBounds || normalized.selection.inputId === input.id) {
                    const box = computePlacementBounds(input, placement);
                    const min = toCanvasPoint({ x: box.minX, y: box.minY });
                    const max = toCanvasPoint({ x: box.maxX, y: box.maxY });
                    ctx.save();
                    ctx.lineWidth = Math.max(1, 1.5 / Math.max(0.1, viewport.scale));
                    ctx.strokeStyle = normalized.selection.inputId === input.id ? '#00d0ff' : 'rgba(255,255,255,0.65)';
                    ctx.strokeRect(min.x, min.y, Math.max(1, max.x - min.x), Math.max(1, max.y - min.y));
                    ctx.restore();
                }

                if (normalized.view.showLabels) {
                    const box = computePlacementBounds(input, placement);
                    const labelX = viewport.offsetX + (box.minX * viewport.scale);
                    const labelY = viewport.offsetY + (box.minY * viewport.scale) - 8;
                    ctx.fillStyle = normalized.selection.inputId === input.id ? 'rgba(0, 26, 41, 0.86)' : 'rgba(10, 10, 14, 0.72)';
                    const label = input.name;
                    ctx.font = `${Math.max(12, 12 * (window.devicePixelRatio || 1))}px "Segoe UI", sans-serif`;
                    const width = ctx.measureText(label).width + 14;
                    ctx.fillRect(labelX, labelY - 18, width, 18);
                    ctx.fillStyle = '#ffffff';
                    ctx.fillText(label, labelX + 7, labelY - 5);
                }
            });
        ctx.restore();
        return viewport;
    }

    async render(document) {
        if (!this.canvas || !this.ctx) return;
        const normalized = normalizeStitchDocument(document);
        await this.ensureImages(normalized);
        this.resizeAttachedCanvas();
        const viewport = this.drawDocumentToContext(this.ctx, normalized);
        this.runtime.renderWidth = Math.max(0, Math.round(viewport.bounds.width));
        this.runtime.renderHeight = Math.max(0, Math.round(viewport.bounds.height));
        this.runtime.bounds = viewport.bounds;
        this.runtime.viewport = viewport;
    }

    requestRender(document) {
        if (this.renderRequested) return;
        this.renderRequested = true;
        requestAnimationFrame(() => {
            this.renderRequested = false;
            this.render(document).catch(() => {});
        });
    }

    async buildPreparedInputs(document) {
        const normalized = normalizeStitchDocument(document);
        await this.ensureImages(normalized);
        const maxDimension = normalized.settings.analysisMaxDimension || 960;
        const useFullResolution = !!normalized.settings.useFullResolutionAnalysis;
        return Promise.all(normalized.inputs.map(async (input) => {
            const image = await this.getImage(input);
            const scale = useFullResolution
                ? 1
                : Math.min(1, maxDimension / Math.max(image.naturalWidth || input.width || 1, image.naturalHeight || input.height || 1));
            const width = Math.max(32, Math.round((image.naturalWidth || input.width || 1) * scale));
            const height = Math.max(32, Math.round((image.naturalHeight || input.height || 1) * scale));
            const canvas = createCanvas(width, height);
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(image, 0, 0, width, height);
            const rgba = ctx.getImageData(0, 0, width, height).data;
            const gray = new Uint8ClampedArray(width * height);
            for (let index = 0; index < gray.length; index += 1) {
                const rgbaIndex = index * 4;
                gray[index] = Math.round((rgba[rgbaIndex] * 0.299) + (rgba[rgbaIndex + 1] * 0.587) + (rgba[rgbaIndex + 2] * 0.114));
            }
            return {
                id: input.id,
                name: input.name,
                width,
                height,
                originalWidth: input.width,
                originalHeight: input.height,
                gray
            };
        }));
    }

    resolveAnalysisBackend(document, preparedInputs) {
        const sceneMode = document.settings?.sceneMode || 'auto';
        if (sceneMode === 'screenshot') {
            return {
                backend: 'screenshot-js',
                sceneMode: 'screenshot',
                diagnostics: []
            };
        }
        if (sceneMode === 'photo') {
            return {
                backend: 'opencv-wasm',
                sceneMode: 'photo',
                diagnostics: []
            };
        }
        const classification = classifyPreparedInputs(preparedInputs);
        return {
            backend: classification.sceneMode === 'photo' ? 'opencv-wasm' : 'screenshot-js',
            sceneMode: classification.sceneMode,
            diagnostics: classification.diagnostics || []
        };
    }

    runWorkerAnalysis(worker, payload, options = {}) {
        return new Promise((resolve, reject) => {
            const requestId = createRequestId();
            this.pendingRequests.set(requestId, {
                resolve,
                reject,
                onProgress: typeof options.onProgress === 'function' ? options.onProgress : null
            });
            worker.postMessage({ requestId, ...payload });
        });
    }

    buildAnalysisDocumentForBackend(document, backend, sceneMode) {
        const settings = {
            ...document.settings,
            sceneMode
        };
        if (backend === 'screenshot-js') {
            if (settings.analysisMaxDimension === 960) settings.analysisMaxDimension = SCREENSHOT_LEGACY_DEFAULTS.analysisMaxDimension;
            if (settings.maxFeatures === 1500) settings.maxFeatures = SCREENSHOT_LEGACY_DEFAULTS.maxFeatures;
            if (settings.matchRatio === 0.75) settings.matchRatio = SCREENSHOT_LEGACY_DEFAULTS.matchRatio;
            if (settings.ransacIterations === 2000) settings.ransacIterations = SCREENSHOT_LEGACY_DEFAULTS.ransacIterations;
            if (settings.inlierThreshold === 4.5) settings.inlierThreshold = SCREENSHOT_LEGACY_DEFAULTS.inlierThreshold;
        }
        return {
            ...document,
            settings
        };
    }

    async analyze(document, options = {}) {
        const normalized = normalizeStitchDocument(document);
        let routing = null;
        if ((normalized.settings?.sceneMode || 'auto') === 'auto') {
            const classifierDocument = {
                ...normalized,
                settings: {
                    ...normalized.settings,
                    analysisMaxDimension: Math.min(256, normalized.settings.analysisMaxDimension || 256),
                    useFullResolutionAnalysis: false
                }
            };
            const classifierInputs = await this.buildPreparedInputs(classifierDocument);
            routing = this.resolveAnalysisBackend(normalized, classifierInputs);
        } else {
            routing = this.resolveAnalysisBackend(normalized, []);
        }
        const analysisDocument = this.buildAnalysisDocumentForBackend(normalized, routing.backend, routing.sceneMode);
        const preparedInputs = await this.buildPreparedInputs(analysisDocument);

        if (routing.backend === 'opencv-wasm') {
            const worker = await this.ensureOpenCvWorker();
            if (!worker) {
                throw new Error('Photo analysis requires browser Worker and WebAssembly support for OpenCV.js.');
            }
            const result = await this.runWorkerAnalysis(worker, {
                type: 'analyze',
                document: analysisDocument,
                preparedInputs
            }, options);
            return {
                ...result,
                backend: 'opencv-wasm',
                diagnostics: [...routing.diagnostics, ...(result?.diagnostics || [])]
            };
        }

        const worker = await this.ensureWorker();
        const result = worker
            ? await this.runWorkerAnalysis(worker, { document: analysisDocument, preparedInputs }, options)
            : analyzePreparedStitchInputs(analysisDocument, preparedInputs);
        return {
            ...result,
            backend: 'screenshot-js',
            diagnostics: [...routing.diagnostics, ...(result?.diagnostics || [])]
        };
    }

    async exportPngBlob(document, options = {}) {
        const normalized = normalizeStitchDocument(document);
        await this.ensureImages(normalized);
        const placements = options.placements || getActivePlacements(normalized);
        const bounds = computeCompositeBounds(normalized, placements);
        const padding = clamp(Math.round(Number(options.padding ?? normalized.export.padding ?? 32)), 0, 512);
        const width = Math.max(1, Math.round(bounds.width + (padding * 2)));
        const height = Math.max(1, Math.round(bounds.height + (padding * 2)));
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = options.background || normalized.export.background || '#ffffff';
        ctx.fillRect(0, 0, width, height);
        ctx.imageSmoothingEnabled = true;

        // Reset offscreen canvas for export context size
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        this.compositeCanvas = null;
        this.compositeCtx = null;
        const activeCandidate = normalized.candidates.find((candidate) => candidate.id === normalized.activeCandidateId) || null;
        const toCanvasPoint = (worldPoint) => ({
            x: padding + (worldPoint.x - bounds.minX),
            y: padding + (worldPoint.y - bounds.minY)
        });
        const compositeCtx = this.getCompositeContext(width, height);

        placements
            .filter((placement) => placement.visible !== false)
            .sort((a, b) => (a.z || 0) - (b.z || 0))
            .forEach((placement) => {
                const input = normalized.inputs.find((item) => item.id === placement.inputId);
                const image = this.imageCache.get(input?.id)?.image;
                if (!input || !image) return;
                const alpha = clamp(Number(placement.opacity) || 1, 0, 1);
                const blendMode = resolveBlendMode(normalized, placement, activeCandidate);
                if (blendMode === 'alpha') {
                    drawWarpedPlacement(compositeCtx, image, input, placement, toCanvasPoint, { alpha });
                } else {
                    const layerCtx = this.getOffscreenContext(width, height);
                    drawWarpedPlacement(layerCtx, image, input, placement, toCanvasPoint, { alpha: 1 });
                    const placementBounds = computePlacementBounds(input, placement);
                    const canvasBounds = {
                        minX: padding + (placementBounds.minX - bounds.minX),
                        minY: padding + (placementBounds.minY - bounds.minY),
                        maxX: padding + (placementBounds.maxX - bounds.minX),
                        maxY: padding + (placementBounds.maxY - bounds.minY)
                    };
                    const region = buildBlendRegion(canvasBounds, width, height);
                    const blended = blendLayerIntoCompositeRegion(compositeCtx, layerCtx, region, blendMode, alpha);
                    if (!blended) {
                        compositeCtx.save();
                        compositeCtx.globalAlpha = alpha;
                        compositeCtx.drawImage(this.offscreenCanvas, 0, 0);
                        compositeCtx.restore();
                    }
                }
            });

        ctx.drawImage(this.compositeCanvas, 0, 0);

        return canvasToBlob(canvas, 'image/png');
    }

    async buildCandidatePreview(document, candidate, maxSide = 280) {
        if (!candidate) return '';
        const normalized = applyCandidateToDocument(document, candidate.id);
        await this.ensureImages(normalized);
        const placements = candidate.placements || getActivePlacements(normalized);
        const bounds = computeCompositeBounds(normalized, placements);
        const scale = bounds.width || bounds.height
            ? Math.min(maxSide / Math.max(1, bounds.width), maxSide / Math.max(1, bounds.height))
            : 1;
        const width = Math.max(120, Math.round(bounds.width * scale) + 28);
        const height = Math.max(120, Math.round(bounds.height * scale) + 28);
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = normalized.view.theme === 'dark' ? '#0b0c10' : '#f7f8fa';
        ctx.fillRect(0, 0, width, height);
        const viewport = {
            bounds,
            scale,
            offsetX: 14 - (bounds.minX * scale),
            offsetY: 14 - (bounds.minY * scale),
            width,
            height
        };
        this.drawDocumentToContext(ctx, normalized, {
            placements,
            candidate,
            viewport,
            background: normalized.view.theme === 'dark' ? '#0b0c10' : '#f7f8fa'
        });
        if (typeof canvas.convertToBlob === 'function') {
            const blob = await canvas.convertToBlob({ type: 'image/png' });
            return URL.createObjectURL(blob);
        }
        return canvas.toDataURL('image/png');
    }

    async buildCandidatePreviewMap(document) {
        const normalized = normalizeStitchDocument(document);
        const previews = {};
        for (const candidate of normalized.candidates) {
            previews[candidate.id] = await this.buildCandidatePreview(normalized, candidate);
        }
        return previews;
    }

    screenToWorld(x, y) {
        const viewport = this.runtime.viewport;
        return {
            x: (x - viewport.offsetX) / Math.max(0.0001, viewport.scale),
            y: (y - viewport.offsetY) / Math.max(0.0001, viewport.scale)
        };
    }

    hitTest(document, canvasX, canvasY) {
        const normalized = normalizeStitchDocument(document);
        const world = this.screenToWorld(canvasX, canvasY);
        const placements = [...getActivePlacements(normalized)].sort((a, b) => (b.z || 0) - (a.z || 0));
        for (const placement of placements) {
            if (placement.visible === false) continue;
            const input = normalized.inputs.find((item) => item.id === placement.inputId);
            if (!input) continue;
            if (placement.warp) {
                const hit = hitTestWarpedPlacement(input, placement, world.x, world.y);
                if (hit) {
                    return {
                        inputId: input.id,
                        localX: hit.localX,
                        localY: hit.localY,
                        worldX: world.x,
                        worldY: world.y,
                        placement
                    };
                }
                continue;
            }
            const translatedX = world.x - (placement.x || 0);
            const translatedY = world.y - (placement.y || 0);
            const unrotated = rotatePoint(translatedX, translatedY, -(placement.rotation || 0));
            const localX = unrotated.x / Math.max(0.01, placement.scale || 1);
            const localY = unrotated.y / Math.max(0.01, placement.scale || 1);
            if (localX >= 0 && localX <= input.width && localY >= 0 && localY <= input.height) {
                return {
                    inputId: input.id,
                    localX,
                    localY,
                    worldX: world.x,
                    worldY: world.y,
                    placement
                };
            }
        }
        return null;
    }

    getRuntimeMetrics(document) {
        const normalized = normalizeStitchDocument(document);
        const bounds = computeCompositeBounds(normalized);
        return {
            renderWidth: Math.max(0, Math.round(bounds.width)),
            renderHeight: Math.max(0, Math.round(bounds.height)),
            bounds
        };
    }
}
