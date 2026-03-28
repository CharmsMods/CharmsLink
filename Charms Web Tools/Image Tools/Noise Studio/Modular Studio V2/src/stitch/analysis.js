import { buildManualLayoutCandidate, buildInitialPlacementsFromCandidate, createStitchCandidateId, normalizeStitchDocument } from './document.js';
import { getMeshGridDimensions, localPointToWorld, worldPointToLocal, worldVectorToLocalDelta } from './warp.js';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function buildGradient(gray, width, height) {
    const magnitude = new Float32Array(width * height);
    for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
            const idx = (y * width) + x;
            const gx = (
                -gray[idx - width - 1] + gray[idx - width + 1]
                - (2 * gray[idx - 1]) + (2 * gray[idx + 1])
                - gray[idx + width - 1] + gray[idx + width + 1]
            );
            const gy = (
                -gray[idx - width - 1] - (2 * gray[idx - width]) - gray[idx - width + 1]
                + gray[idx + width - 1] + (2 * gray[idx + width]) + gray[idx + width + 1]
            );
            magnitude[idx] = Math.hypot(gx, gy);
        }
    }
    return magnitude;
}

function extractFeatures(preparedInput, settings) {
    const { width, height, gray } = preparedInput;
    const magnitude = buildGradient(gray, width, height);
    const border = 6;
    const minDistance = 10;
    const maxFeatures = settings.maxFeatures || 120;
    const candidates = [];

    for (let y = border; y < height - border; y += 1) {
        for (let x = border; x < width - border; x += 1) {
            const idx = (y * width) + x;
            const score = magnitude[idx];
            if (score < 50) continue;
            let isPeak = true;
            for (let oy = -1; oy <= 1 && isPeak; oy += 1) {
                for (let ox = -1; ox <= 1; ox += 1) {
                    if (!ox && !oy) continue;
                    if (magnitude[idx + ox + (oy * width)] > score) {
                        isPeak = false;
                        break;
                    }
                }
            }
            if (isPeak) {
                candidates.push({ x, y, score });
            }
        }
    }

    candidates.sort((a, b) => b.score - a.score);
    const selected = [];
    for (const candidate of candidates) {
        const tooClose = selected.some((feature) => Math.hypot(feature.x - candidate.x, feature.y - candidate.y) < minDistance);
        if (tooClose) continue;
        selected.push({
            ...candidate,
            descriptor: buildDescriptor(gray, width, height, candidate.x, candidate.y)
        });
        if (selected.length >= maxFeatures) break;
    }
    return selected;
}

function buildDescriptor(gray, width, height, centerX, centerY) {
    const radius = 6;
    const descriptor = [];
    let sum = 0;
    let count = 0;
    for (let gy = 0; gy < 4; gy += 1) {
        for (let gx = 0; gx < 4; gx += 1) {
            const sampleX = clamp(Math.round(centerX - radius + ((gx + 0.5) * ((radius * 2) / 4))), 0, width - 1);
            const sampleY = clamp(Math.round(centerY - radius + ((gy + 0.5) * ((radius * 2) / 4))), 0, height - 1);
            const value = gray[(sampleY * width) + sampleX];
            descriptor.push(value);
            sum += value;
            count += 1;
        }
    }
    const mean = count ? sum / count : 0;
    let variance = 0;
    for (let index = 0; index < descriptor.length; index += 1) {
        descriptor[index] -= mean;
        variance += descriptor[index] * descriptor[index];
    }
    const norm = Math.sqrt(variance) || 1;
    return descriptor.map((value) => value / norm);
}

function descriptorDistance(a, b) {
    let distance = 0;
    for (let index = 0; index < a.length; index += 1) {
        const delta = a[index] - b[index];
        distance += delta * delta;
    }
    return distance;
}

function matchFeatureSets(aFeatures, bFeatures, settings) {
    if (!aFeatures.length || !bFeatures.length) return [];
    const ratioLimit = settings.matchRatio || 0.8;
    const forwardMatches = [];

    for (const feature of aFeatures) {
        let best = null;
        let second = null;
        for (const other of bFeatures) {
            const distance = descriptorDistance(feature.descriptor, other.descriptor);
            if (!best || distance < best.distance) {
                second = best;
                best = { feature, other, distance };
            } else if (!second || distance < second.distance) {
                second = { feature, other, distance };
            }
        }
        if (best && second && best.distance < second.distance * ratioLimit) {
            forwardMatches.push(best);
        }
    }

    const reverseMap = new Map();
    for (const other of bFeatures) {
        let best = null;
        for (const feature of aFeatures) {
            const distance = descriptorDistance(other.descriptor, feature.descriptor);
            if (!best || distance < best.distance) {
                best = { feature, distance };
            }
        }
        if (best) reverseMap.set(other, best.feature);
    }

    return forwardMatches
        .filter((match) => reverseMap.get(match.other) === match.feature)
        .map((match) => ({
            a: { x: match.feature.x, y: match.feature.y },
            b: { x: match.other.x, y: match.other.y },
            distance: match.distance
        }));
}

function buildPatchDescriptor(gray, magnitude, width, height, centerX, centerY) {
    const radius = 10;
    const gridSize = 5;
    const luminance = [];
    const edges = [];
    let lumSum = 0;
    let edgeSum = 0;

    for (let gy = 0; gy < gridSize; gy += 1) {
        for (let gx = 0; gx < gridSize; gx += 1) {
            const sampleX = clamp(Math.round(centerX - radius + ((gx + 0.5) * ((radius * 2) / gridSize))), 0, width - 1);
            const sampleY = clamp(Math.round(centerY - radius + ((gy + 0.5) * ((radius * 2) / gridSize))), 0, height - 1);
            const idx = (sampleY * width) + sampleX;
            const lum = gray[idx];
            const edge = magnitude[idx];
            luminance.push(lum);
            edges.push(edge);
            lumSum += lum;
            edgeSum += edge;
        }
    }

    const lumMean = lumSum / Math.max(1, luminance.length);
    const edgeMean = edgeSum / Math.max(1, edges.length);
    let lumVariance = 0;
    let edgeVariance = 0;
    for (let index = 0; index < luminance.length; index += 1) {
        const lum = luminance[index] - lumMean;
        const edge = edges[index] - edgeMean;
        luminance[index] = lum;
        edges[index] = edge;
        lumVariance += lum * lum;
        edgeVariance += edge * edge;
    }

    const lumNorm = Math.sqrt(lumVariance) || 1;
    const edgeNorm = Math.sqrt(edgeVariance) || 1;
    const descriptor = [
        ...luminance.map((value) => value / lumNorm),
        ...edges.map((value) => value / edgeNorm)
    ];

    return {
        descriptor,
        variance: Math.sqrt(lumVariance / Math.max(1, luminance.length)),
        edgeEnergy: edgeMean
    };
}

function buildTranslationProfile(preparedInput, settings) {
    const { width, height, gray } = preparedInput;
    const magnitude = buildGradient(gray, width, height);
    const maxAnchors = clamp(Math.round(Math.max((settings.maxFeatures || 120) * 5, 220)), 80, 640);
    const border = 12;
    const approxStep = clamp(Math.round(Math.sqrt((width * height) / Math.max(1, maxAnchors))), 6, 24);
    const anchors = [];

    for (let y = border; y < height - border; y += approxStep) {
        for (let x = border; x < width - border; x += approxStep) {
            const patch = buildPatchDescriptor(gray, magnitude, width, height, x, y);
            if (patch.edgeEnergy < 16 && patch.variance < 10) continue;
            anchors.push({
                x,
                y,
                descriptor: patch.descriptor,
                weight: patch.edgeEnergy + (patch.variance * 0.75)
            });
        }
    }

    anchors.sort((a, b) => b.weight - a.weight);
    return {
        width,
        height,
        gray,
        magnitude,
        anchors: anchors.slice(0, maxAnchors)
    };
}

function getPreparedSpaceScale(source, target) {
    const sourceScaleX = source.width / Math.max(1, source.originalWidth || source.width);
    const sourceScaleY = source.height / Math.max(1, source.originalHeight || source.height);
    const targetScaleX = target.width / Math.max(1, target.originalWidth || target.width);
    const targetScaleY = target.height / Math.max(1, target.originalHeight || target.height);
    return {
        x: targetScaleX / Math.max(0.0001, sourceScaleX),
        y: targetScaleY / Math.max(0.0001, sourceScaleY)
    };
}

function matchTranslationAnchors(sourceAnchors, targetAnchors, settings, scale) {
    if (!sourceAnchors.length || !targetAnchors.length) return [];
    const ratioLimit = Math.min(0.94, Math.max(0.68, (settings.matchRatio || 0.8) + 0.08));
    const maxDistance = 1.12;
    const forwardMatches = [];

    for (const anchor of sourceAnchors) {
        let best = null;
        let second = null;
        for (const other of targetAnchors) {
            const distance = descriptorDistance(anchor.descriptor, other.descriptor);
            if (!best || distance < best.distance) {
                second = best;
                best = { anchor, other, distance };
            } else if (!second || distance < second.distance) {
                second = { anchor, other, distance };
            }
        }
        if (!best || best.distance > maxDistance) continue;
        if (second && best.distance >= second.distance * ratioLimit) continue;
        forwardMatches.push(best);
    }

    const reverseMap = new Map();
    for (const other of targetAnchors) {
        let best = null;
        for (const anchor of sourceAnchors) {
            const distance = descriptorDistance(other.descriptor, anchor.descriptor);
            if (!best || distance < best.distance) {
                best = { anchor, distance };
            }
        }
        if (best) reverseMap.set(other, best.anchor);
    }

    return forwardMatches
        .filter((match) => reverseMap.get(match.other) === match.anchor)
        .map((match) => ({
            a: { x: match.anchor.x, y: match.anchor.y },
            b: { x: match.other.x, y: match.other.y },
            dx: match.other.x - (match.anchor.x * scale.x),
            dy: match.other.y - (match.anchor.y * scale.y),
            distance: match.distance,
            weight: (match.anchor.weight + match.other.weight) / Math.max(0.05, match.distance + 0.05)
        }));
}

function rankTranslationMatches(matches, settings) {
    if (matches.length < 4) return [];
    const binSize = clamp(Math.round((settings.inlierThreshold || 18) * 0.45), 4, 14);
    const bins = new Map();

    for (const match of matches) {
        const keyX = Math.round(match.dx / binSize);
        const keyY = Math.round(match.dy / binSize);
        const key = `${keyX},${keyY}`;
        const bucket = bins.get(key) || { matches: [], weight: 0, sumDx: 0, sumDy: 0 };
        bucket.matches.push(match);
        bucket.weight += match.weight;
        bucket.sumDx += match.dx * match.weight;
        bucket.sumDy += match.dy * match.weight;
        bins.set(key, bucket);
    }

    const radius = Math.max(6, binSize * 1.6);
    const rankedBuckets = [...bins.values()]
        .sort((a, b) => (b.weight - a.weight) || (b.matches.length - a.matches.length))
        .slice(0, 10);
    const ranked = [];

    for (const bucket of rankedBuckets) {
        let centroidX = bucket.sumDx / Math.max(0.0001, bucket.weight);
        let centroidY = bucket.sumDy / Math.max(0.0001, bucket.weight);
        let clustered = matches.filter((match) => Math.hypot(match.dx - centroidX, match.dy - centroidY) <= radius);
        if (clustered.length < 4) continue;

        let weight = 0;
        let sumDx = 0;
        let sumDy = 0;
        clustered.forEach((match) => {
            weight += match.weight;
            sumDx += match.dx * match.weight;
            sumDy += match.dy * match.weight;
        });
        centroidX = sumDx / Math.max(0.0001, weight);
        centroidY = sumDy / Math.max(0.0001, weight);
        clustered = clustered.filter((match) => Math.hypot(match.dx - centroidX, match.dy - centroidY) <= radius);

        const spread = clustered.length
            ? clustered.reduce((sum, match) => sum + Math.hypot(match.dx - centroidX, match.dy - centroidY), 0) / clustered.length
            : Infinity;

        if (ranked.some((entry) => Math.hypot(entry.dx - centroidX, entry.dy - centroidY) < Math.max(4, binSize))) {
            continue;
        }

        ranked.push({
            dx: centroidX,
            dy: centroidY,
            matches: clustered,
            spread,
            weight
        });
    }

    return ranked;
}

function computeOverlapMetrics(sourceProfile, targetProfile, transform) {
    const mappedMinX = transform.tx;
    const mappedMinY = transform.ty;
    const mappedMaxX = transform.tx + (sourceProfile.width * transform.scale);
    const mappedMaxY = transform.ty + (sourceProfile.height * transform.scale);
    const overlapMinX = Math.max(0, Math.floor(mappedMinX));
    const overlapMinY = Math.max(0, Math.floor(mappedMinY));
    const overlapMaxX = Math.min(targetProfile.width, Math.ceil(mappedMaxX));
    const overlapMaxY = Math.min(targetProfile.height, Math.ceil(mappedMaxY));
    const overlapWidth = overlapMaxX - overlapMinX;
    const overlapHeight = overlapMaxY - overlapMinY;
    if (overlapWidth < 24 || overlapHeight < 24) return null;

    const sampleBudgetStep = Math.sqrt((overlapWidth * overlapHeight) / 2600);
    const step = clamp(Math.round(sampleBudgetStep), 1, 24);
    const edgeThreshold = 18;
    let samples = 0;
    let totalWeight = 0;
    let sourceGraySum = 0;
    let targetGraySum = 0;
    let sourceGraySq = 0;
    let targetGraySq = 0;
    let grayCross = 0;
    let sourceEdgeSum = 0;
    let targetEdgeSum = 0;
    let sourceEdgeSq = 0;
    let targetEdgeSq = 0;
    let edgeCross = 0;
    let grayDifferenceWeighted = 0;
    let pixelMatchWeight = 0;
    let edgeUnionWeight = 0;
    let edgeMatchWeight = 0;

    for (let y = overlapMinY; y < overlapMaxY; y += step) {
        for (let x = overlapMinX; x < overlapMaxX; x += step) {
            const sourceX = clamp(Math.round((x - transform.tx) / Math.max(0.0001, transform.scale)), 0, sourceProfile.width - 1);
            const sourceY = clamp(Math.round((y - transform.ty) / Math.max(0.0001, transform.scale)), 0, sourceProfile.height - 1);
            const sourceIndex = (sourceY * sourceProfile.width) + sourceX;
            const targetIndex = (y * targetProfile.width) + x;
            const sourceGray = sourceProfile.gray[sourceIndex];
            const targetGray = targetProfile.gray[targetIndex];
            const sourceEdge = sourceProfile.magnitude[sourceIndex];
            const targetEdge = targetProfile.magnitude[targetIndex];
            const strongestEdge = Math.max(sourceEdge, targetEdge);
            const edgeWeight = Math.min(2.65, 0.14 + ((strongestEdge / 90) ** 1.35) * 2.25);
            const grayDifference = Math.abs(sourceGray - targetGray);
            const grayTolerance = 7 + (strongestEdge * 0.06);
            const sourceStrong = sourceEdge >= edgeThreshold;
            const targetStrong = targetEdge >= edgeThreshold;

            samples += 1;
            totalWeight += edgeWeight;
            sourceGraySum += sourceGray * edgeWeight;
            targetGraySum += targetGray * edgeWeight;
            sourceGraySq += sourceGray * sourceGray * edgeWeight;
            targetGraySq += targetGray * targetGray * edgeWeight;
            grayCross += sourceGray * targetGray * edgeWeight;
            sourceEdgeSum += sourceEdge * edgeWeight;
            targetEdgeSum += targetEdge * edgeWeight;
            sourceEdgeSq += sourceEdge * sourceEdge * edgeWeight;
            targetEdgeSq += targetEdge * targetEdge * edgeWeight;
            edgeCross += sourceEdge * targetEdge * edgeWeight;
            grayDifferenceWeighted += grayDifference * edgeWeight;
            if (grayDifference <= grayTolerance) {
                pixelMatchWeight += edgeWeight;
            }
            if (sourceStrong || targetStrong) {
                edgeUnionWeight += edgeWeight;
                if (sourceStrong && targetStrong) {
                    const edgeBalance = 1 - Math.min(1, Math.abs(sourceEdge - targetEdge) / Math.max(12, strongestEdge));
                    const grayAgreement = 1 - Math.min(1, grayDifference / 36);
                    edgeMatchWeight += edgeWeight * Math.max(0, (edgeBalance * 0.55) + (grayAgreement * 0.45));
                }
            }
        }
    }

    if (!samples || !totalWeight) return null;

    const computeWeightedCorrelation = (sumA, sumB, sqA, sqB, cross) => {
        const numerator = cross - ((sumA * sumB) / Math.max(0.0001, totalWeight));
        const varianceA = Math.max(0, sqA - ((sumA * sumA) / Math.max(0.0001, totalWeight)));
        const varianceB = Math.max(0, sqB - ((sumB * sumB) / Math.max(0.0001, totalWeight)));
        const denominator = Math.sqrt(varianceA * varianceB) || 1;
        return numerator / denominator;
    };

    const grayCorrelation = computeWeightedCorrelation(sourceGraySum, targetGraySum, sourceGraySq, targetGraySq, grayCross);
    const edgeCorrelation = computeWeightedCorrelation(sourceEdgeSum, targetEdgeSum, sourceEdgeSq, targetEdgeSq, edgeCross);
    const grayDifference = grayDifferenceWeighted / Math.max(0.0001, totalWeight);
    const pixelMatchRatio = pixelMatchWeight / Math.max(0.0001, totalWeight);
    const edgeMatchRatio = edgeUnionWeight ? (edgeMatchWeight / edgeUnionWeight) : 0;
    const edgeCoverage = edgeUnionWeight / Math.max(0.0001, totalWeight);
    const overlapArea = overlapWidth * overlapHeight;
    const sourceArea = sourceProfile.width * sourceProfile.height * transform.scale * transform.scale;
    const targetArea = targetProfile.width * targetProfile.height;
    const overlapRatio = overlapArea / Math.max(1, Math.min(sourceArea, targetArea));

    return {
        samples,
        overlapRatio,
        similarity: (((grayCorrelation + 1) * 0.5) * 0.3)
            + (((edgeCorrelation + 1) * 0.5) * 0.25)
            + (pixelMatchRatio * 0.28)
            + (edgeMatchRatio * 0.17),
        grayCorrelation,
        edgeCorrelation,
        grayDifference,
        pixelMatchRatio,
        edgeMatchRatio,
        edgeCoverage
    };
}

function resizePlaneNearest(plane, width, height, targetWidth, targetHeight) {
    if (width === targetWidth && height === targetHeight) return plane;
    const next = new Uint8ClampedArray(targetWidth * targetHeight);
    for (let y = 0; y < targetHeight; y += 1) {
        const sourceY = clamp(Math.round((y / Math.max(1, targetHeight - 1)) * Math.max(0, height - 1)), 0, height - 1);
        for (let x = 0; x < targetWidth; x += 1) {
            const sourceX = clamp(Math.round((x / Math.max(1, targetWidth - 1)) * Math.max(0, width - 1)), 0, width - 1);
            next[(y * targetWidth) + x] = plane[(sourceY * width) + sourceX];
        }
    }
    return next;
}

function buildSearchProfile(preparedInput, settings) {
    const maxSide = settings.useFullResolutionAnalysis
        ? Math.max(preparedInput.width || 1, preparedInput.height || 1)
        : Math.max(220, Math.round((settings.analysisMaxDimension || 320) * 0.8));
    const scale = Math.min(1, maxSide / Math.max(preparedInput.width || 1, preparedInput.height || 1));
    const width = Math.max(48, Math.round((preparedInput.width || 1) * scale));
    const height = Math.max(48, Math.round((preparedInput.height || 1) * scale));
    const gray = resizePlaneNearest(preparedInput.gray, preparedInput.width, preparedInput.height, width, height);
    return {
        width,
        height,
        originalWidth: preparedInput.originalWidth || preparedInput.width,
        originalHeight: preparedInput.originalHeight || preparedInput.height,
        gray,
        magnitude: buildGradient(gray, width, height)
    };
}

function scoreOverlapMetrics(overlap) {
    if (!overlap) return -Infinity;
    return (overlap.similarity * 128)
        + (overlap.overlapRatio * 34)
        + (overlap.pixelMatchRatio * 52)
        + (overlap.edgeMatchRatio * 40)
        + (overlap.edgeCoverage * 18)
        + (overlap.grayCorrelation * 10)
        + (overlap.edgeCorrelation * 8)
        - (overlap.grayDifference * 0.16);
}

function scoreScreenshotOverlap(overlap) {
    if (!overlap) return -Infinity;
    return scoreOverlapMetrics(overlap)
        + (overlap.pixelMatchRatio * 28)
        + (overlap.edgeMatchRatio * 18)
        + (overlap.edgeCoverage * 12);
}

function buildPlacementTransform(dx, dy) {
    return {
        scale: 1,
        rotation: 0,
        tx: -dx,
        ty: -dy
    };
}

function searchScreenshotTransform(sourceSearch, targetSearch, settings) {
    const widthSimilarity = Math.abs(sourceSearch.width - targetSearch.width) / Math.max(1, Math.max(sourceSearch.width, targetSearch.width));
    const heightSimilarity = Math.abs(sourceSearch.height - targetSearch.height) / Math.max(1, Math.max(sourceSearch.height, targetSearch.height));
    if (widthSimilarity > 0.28 || heightSimilarity > 0.28) return null;

    const coarseAxisStep = clamp(
        Math.round(Math.min(sourceSearch.width, sourceSearch.height, targetSearch.width, targetSearch.height) / 18),
        6,
        settings.useFullResolutionAnalysis ? 96 : 24
    );
    const coarseCrossStep = clamp(
        Math.round(Math.min(sourceSearch.width, sourceSearch.height, targetSearch.width, targetSearch.height) / 42),
        2,
        settings.useFullResolutionAnalysis ? 48 : 12
    );
    const crossLimitX = Math.max(12, Math.round(Math.min(sourceSearch.width, targetSearch.width) * 0.45));
    const crossLimitY = Math.max(12, Math.round(Math.min(sourceSearch.height, targetSearch.height) * 0.45));
    const minOverlapY = Math.max(24, Math.round(Math.min(sourceSearch.height, targetSearch.height) * 0.18));
    const maxOverlapY = Math.min(sourceSearch.height, targetSearch.height) - 12;
    const minOverlapX = Math.max(24, Math.round(Math.min(sourceSearch.width, targetSearch.width) * 0.18));
    const maxOverlapX = Math.min(sourceSearch.width, targetSearch.width) - 12;
    const coarseCandidates = [];

    function pushCandidate(dx, dy, orientation) {
        const transform = buildPlacementTransform(dx, dy);
        const overlap = computeOverlapMetrics(sourceSearch, targetSearch, transform);
        if (!overlap || overlap.overlapRatio < 0.12) return;
        coarseCandidates.push({
            dx,
            dy,
            orientation,
            transform,
            overlap,
            score: scoreScreenshotOverlap(overlap)
        });
    }

    for (let overlapY = minOverlapY; overlapY <= maxOverlapY; overlapY += coarseAxisStep) {
        const dyBelow = sourceSearch.height - overlapY;
        const dyAbove = -(targetSearch.height - overlapY);
        for (let dx = -crossLimitX; dx <= crossLimitX; dx += coarseCrossStep) {
            pushCandidate(dx, dyBelow, 'below');
            pushCandidate(dx, dyAbove, 'above');
        }
    }

    for (let overlapX = minOverlapX; overlapX <= maxOverlapX; overlapX += coarseAxisStep) {
        const dxRight = sourceSearch.width - overlapX;
        const dxLeft = -(targetSearch.width - overlapX);
        for (let dy = -crossLimitY; dy <= crossLimitY; dy += coarseCrossStep) {
            pushCandidate(dxRight, dy, 'right');
            pushCandidate(dxLeft, dy, 'left');
        }
    }

    coarseCandidates.sort((a, b) => b.score - a.score);
    const seedCandidates = [];
    for (const candidate of coarseCandidates) {
        if (seedCandidates.some((item) => Math.hypot(item.dx - candidate.dx, item.dy - candidate.dy) < Math.max(coarseCrossStep * 1.5, 6))) {
            continue;
        }
        seedCandidates.push(candidate);
        if (seedCandidates.length >= 8) break;
    }
    if (!seedCandidates.length) return null;

    const refineStage = (candidates, step, radiusX, radiusY) => {
        const refined = [];
        for (const candidate of candidates) {
            for (let dy = candidate.dy - radiusY; dy <= candidate.dy + radiusY; dy += step) {
                for (let dx = candidate.dx - radiusX; dx <= candidate.dx + radiusX; dx += step) {
                    const transform = buildPlacementTransform(dx, dy);
                    const overlap = computeOverlapMetrics(sourceSearch, targetSearch, transform);
                    if (!overlap || overlap.overlapRatio < 0.12) continue;
                    refined.push({
                        dx,
                        dy,
                        orientation: candidate.orientation,
                        transform,
                        overlap,
                        score: scoreScreenshotOverlap(overlap)
                    });
                }
            }
        }
        refined.sort((a, b) => b.score - a.score);
        const deduped = [];
        for (const entry of refined) {
            if (deduped.some((item) => Math.hypot(item.dx - entry.dx, item.dy - entry.dy) < Math.max(step * 1.5, 3))) {
                continue;
            }
            deduped.push(entry);
            if (deduped.length >= 8) break;
        }
        return deduped;
    };

    const midStep = Math.max(2, Math.floor(coarseCrossStep / 2));
    const fineStep = Math.max(1, Math.floor(midStep / 2));
    const midCandidates = refineStage(seedCandidates, midStep, coarseAxisStep, coarseAxisStep);
    const fineCandidates = refineStage(midCandidates.length ? midCandidates : seedCandidates, fineStep, Math.max(8, coarseCrossStep * 2), Math.max(8, coarseCrossStep * 2));
    const microCandidates = refineStage((fineCandidates.length ? fineCandidates : midCandidates).slice(0, 2), 1, Math.max(3, fineStep * 2), Math.max(3, fineStep * 2));
    const best = (microCandidates[0] || fineCandidates[0] || midCandidates[0] || seedCandidates[0]) || null;
    if (!best) return null;
    if (best.overlap.pixelMatchRatio < 0.52 && (best.overlap.similarity < 0.58 || best.overlap.edgeMatchRatio < 0.38)) return null;
    if (best.overlap.edgeCoverage < 0.06 && best.overlap.pixelMatchRatio < 0.62) return null;

    return {
        transform: best.transform,
        overlap: best.overlap,
        score: best.score,
        method: 'screenshot'
    };
}

function searchTranslationTransform(sourceSearch, targetSearch, settings) {
    const scale = getPreparedSpaceScale(sourceSearch, targetSearch);
    const transformScale = (scale.x + scale.y) * 0.5;
    const mappedWidth = sourceSearch.width * transformScale;
    const mappedHeight = sourceSearch.height * transformScale;
    const coarseStep = clamp(
        Math.round(Math.min(targetSearch.width, targetSearch.height) / 14),
        8,
        settings.useFullResolutionAnalysis ? 96 : 24
    );
    const minOverlapRatio = 0.14;
    const coarseCandidates = [];

    for (let ty = -mappedHeight + 24; ty <= targetSearch.height - 24; ty += coarseStep) {
        for (let tx = -mappedWidth + 24; tx <= targetSearch.width - 24; tx += coarseStep) {
            const transform = { scale: transformScale, rotation: 0, tx, ty };
            const overlap = computeOverlapMetrics(sourceSearch, targetSearch, transform);
            if (!overlap || overlap.overlapRatio < minOverlapRatio) continue;
            coarseCandidates.push({
                transform,
                overlap,
                score: scoreOverlapMetrics(overlap)
            });
        }
    }

    coarseCandidates.sort((a, b) => b.score - a.score);
    const seedCandidates = coarseCandidates.slice(0, 8);
    if (!seedCandidates.length) return null;

    const refineStage = (candidates, step, radius) => {
        const refined = [];
        for (const candidate of candidates) {
            for (let ty = candidate.transform.ty - radius; ty <= candidate.transform.ty + radius; ty += step) {
                for (let tx = candidate.transform.tx - radius; tx <= candidate.transform.tx + radius; tx += step) {
                    const transform = { scale: transformScale, rotation: 0, tx, ty };
                    const overlap = computeOverlapMetrics(sourceSearch, targetSearch, transform);
                    if (!overlap || overlap.overlapRatio < minOverlapRatio) continue;
                    refined.push({
                        transform,
                        overlap,
                        score: scoreOverlapMetrics(overlap)
                    });
                }
            }
        }
        refined.sort((a, b) => b.score - a.score);
        const deduped = [];
        for (const entry of refined) {
            if (deduped.some((item) => Math.hypot(item.transform.tx - entry.transform.tx, item.transform.ty - entry.transform.ty) < Math.max(2, step))) {
                continue;
            }
            deduped.push(entry);
            if (deduped.length >= 8) break;
        }
        return deduped;
    };

    const midStep = Math.max(2, Math.floor(coarseStep / 4));
    const fineStep = Math.max(1, Math.floor(midStep / 4));
    const midCandidates = refineStage(seedCandidates, midStep, Math.max(midStep * 3, coarseStep * 1.5));
    const fineCandidates = refineStage(midCandidates.length ? midCandidates : seedCandidates, fineStep, Math.max(6, midStep * 1.5));
    const microSeed = fineCandidates.length ? fineCandidates.slice(0, 2) : (midCandidates.length ? midCandidates.slice(0, 2) : seedCandidates.slice(0, 2));
    const microCandidates = refineStage(microSeed, 1, Math.max(3, fineStep * 2));
    const best = (microCandidates[0] || fineCandidates[0] || midCandidates[0] || seedCandidates[0]) || null;
    if (!best) return null;
    if (best.overlap.similarity < 0.46 && best.overlap.pixelMatchRatio < 0.48) return null;
    if (best.overlap.edgeCoverage < 0.08 && best.overlap.pixelMatchRatio < 0.58) return null;

    return {
        transform: best.transform,
        overlap: best.overlap,
        score: best.score
    };
}

function computeSimilarityFromPairs(pairA, pairB) {
    const ap = {
        x: pairB.a.x - pairA.a.x,
        y: pairB.a.y - pairA.a.y
    };
    const bp = {
        x: pairB.b.x - pairA.b.x,
        y: pairB.b.y - pairA.b.y
    };
    const aLen = Math.hypot(ap.x, ap.y);
    const bLen = Math.hypot(bp.x, bp.y);
    if (aLen < 4 || bLen < 4) return null;
    const scale = bLen / aLen;
    const rotation = Math.atan2(bp.y, bp.x) - Math.atan2(ap.y, ap.x);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = pairA.b.x - (((pairA.a.x * cos) - (pairA.a.y * sin)) * scale);
    const ty = pairA.b.y - (((pairA.a.x * sin) + (pairA.a.y * cos)) * scale);
    return { scale, rotation, tx, ty };
}

function getTransformComponents(transform = {}) {
    const translationX = Number.isFinite(Number(transform.tx))
        ? Number(transform.tx)
        : (Number.isFinite(Number(transform.x)) ? Number(transform.x) : 0);
    const translationY = Number.isFinite(Number(transform.ty))
        ? Number(transform.ty)
        : (Number.isFinite(Number(transform.y)) ? Number(transform.y) : 0);
    return {
        scale: Number.isFinite(Number(transform.scale)) ? Number(transform.scale) : 1,
        rotation: Number.isFinite(Number(transform.rotation)) ? Number(transform.rotation) : 0,
        tx: translationX,
        ty: translationY
    };
}

function applyTransform(point, transform) {
    const normalized = getTransformComponents(transform);
    const cos = Math.cos(normalized.rotation);
    const sin = Math.sin(normalized.rotation);
    return {
        x: (((point.x * cos) - (point.y * sin)) * normalized.scale) + normalized.tx,
        y: (((point.x * sin) + (point.y * cos)) * normalized.scale) + normalized.ty
    };
}

function invertTransform(transform) {
    const normalized = getTransformComponents(transform);
    const inverseScale = 1 / (normalized.scale || 1);
    const inverseRotation = -(normalized.rotation || 0);
    const cos = Math.cos(inverseRotation);
    const sin = Math.sin(inverseRotation);
    const translatedX = -(normalized.tx || 0) * inverseScale;
    const translatedY = -(normalized.ty || 0) * inverseScale;
    return {
        scale: inverseScale,
        rotation: inverseRotation,
        tx: (translatedX * cos) - (translatedY * sin),
        ty: (translatedX * sin) + (translatedY * cos)
    };
}

function composeTransforms(base, next) {
    const baseTransform = getTransformComponents(base);
    const nextTransform = getTransformComponents(next);
    const appliedOrigin = applyTransform({ x: nextTransform.tx, y: nextTransform.ty }, baseTransform);
    return {
        scale: baseTransform.scale * nextTransform.scale,
        rotation: baseTransform.rotation + nextTransform.rotation,
        tx: appliedOrigin.x,
        ty: appliedOrigin.y
    };
}

function evaluateTransform(matches, transform, threshold) {
    const inliers = [];
    for (const match of matches) {
        const projected = applyTransform(match.a, transform);
        const error = Math.hypot(projected.x - match.b.x, projected.y - match.b.y);
        if (error <= threshold) {
            inliers.push({ ...match, error });
        }
    }
    return inliers;
}

function runRansac(matches, settings) {
    if (matches.length < 3) return null;
    const iterations = settings.ransacIterations || 180;
    const threshold = settings.inlierThreshold || 18;
    let best = null;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const first = matches[Math.floor(Math.random() * matches.length)];
        let second = matches[Math.floor(Math.random() * matches.length)];
        if (first === second) {
            second = matches[(matches.indexOf(first) + 1) % matches.length];
        }
        const transform = computeSimilarityFromPairs(first, second);
        if (!transform) continue;
        const inliers = evaluateTransform(matches, transform, threshold);
        if (!best || inliers.length > best.inliers.length) {
            best = { transform, inliers };
        }
    }
    if (!best || best.inliers.length < 3) return null;

    const refined = computeLeastSquaresTransform(best.inliers);
    const finalTransform = refined || best.transform;
    const finalInliers = evaluateTransform(matches, finalTransform, threshold);
    return {
        transform: finalTransform,
        inliers: finalInliers,
        score: finalInliers.length + (finalInliers.length / Math.max(1, matches.length))
    };
}

function computeLeastSquaresTransform(inliers) {
    if (!inliers.length) return null;
    let ax = 0;
    let ay = 0;
    let bx = 0;
    let by = 0;
    for (const match of inliers) {
        ax += match.a.x;
        ay += match.a.y;
        bx += match.b.x;
        by += match.b.y;
    }
    ax /= inliers.length;
    ay /= inliers.length;
    bx /= inliers.length;
    by /= inliers.length;

    let sxx = 0;
    let sxy = 0;
    let syx = 0;
    let syy = 0;
    for (const match of inliers) {
        const pax = match.a.x - ax;
        const pay = match.a.y - ay;
        const pbx = match.b.x - bx;
        const pby = match.b.y - by;
        sxx += (pax * pbx) + (pay * pby);
        sxy += (pax * pby) - (pay * pbx);
        syx += (pax * pax) + (pay * pay);
        syy += (pbx * pbx) + (pby * pby);
    }
    if (!syx || !syy) return null;
    const scale = Math.sqrt(syy / syx);
    const rotation = Math.atan2(sxy, sxx);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const tx = bx - (((ax * cos) - (ay * sin)) * scale);
    const ty = by - (((ax * sin) + (ay * cos)) * scale);
    return { scale, rotation, tx, ty };
}

function convertTransformToOriginalSpace(edge, source, target) {
    const sourceFactor = source.originalWidth / source.width;
    const targetFactor = target.originalWidth / target.width;
    return {
        scale: edge.transform.scale * (targetFactor / sourceFactor),
        rotation: edge.transform.rotation,
        tx: edge.transform.tx * targetFactor,
        ty: edge.transform.ty * targetFactor
    };
}

function buildSimilarityPairEdge(source, target, featuresById, settings) {
    const matches = matchFeatureSets(featuresById.get(source.id) || [], featuresById.get(target.id) || [], settings);
    const result = runRansac(matches, settings);
    if (!result) return null;
    return {
        fromId: source.id,
        toId: target.id,
        matches: result.inliers.length,
        score: result.score,
        coverage: result.inliers.length / Math.max(1, Math.min(featuresById.get(source.id)?.length || 1, featuresById.get(target.id)?.length || 1)),
        transform: convertTransformToOriginalSpace(result, source, target),
        method: 'similarity'
    };
}

function buildTranslationPairEdge(source, target, sourceProfile, targetProfile, settings) {
    const sourceSearch = buildSearchProfile(source, settings);
    const targetSearch = buildSearchProfile(target, settings);
    const screenshotResult = searchScreenshotTransform(sourceSearch, targetSearch, settings);
    const translationResult = searchTranslationTransform(sourceSearch, targetSearch, settings);
    const searchResult = (() => {
        if (screenshotResult && translationResult) {
            const screenshotStrength = screenshotResult.overlap.pixelMatchRatio + screenshotResult.overlap.edgeMatchRatio;
            const translationStrength = translationResult.overlap.pixelMatchRatio + translationResult.overlap.edgeMatchRatio;
            return screenshotResult.score >= translationResult.score * 0.92 || screenshotStrength >= translationStrength + 0.08
                ? screenshotResult
                : translationResult;
        }
        return screenshotResult || translationResult || null;
    })();
    if (searchResult) {
        return {
            fromId: source.id,
            toId: target.id,
            matches: Math.max(4, Math.round(searchResult.overlap.overlapRatio * 100)),
            score: searchResult.score,
            coverage: searchResult.overlap.overlapRatio,
            transform: convertTransformToOriginalSpace({ transform: searchResult.transform }, sourceSearch, targetSearch),
            similarity: searchResult.overlap.similarity,
            pixelMatch: searchResult.overlap.pixelMatchRatio,
            edgeMatch: searchResult.overlap.edgeMatchRatio,
            method: searchResult.method || 'translation'
        };
    }

    const scale = getPreparedSpaceScale(source, target);
    const transformScale = (scale.x + scale.y) * 0.5;
    const matches = matchTranslationAnchors(sourceProfile.anchors, targetProfile.anchors, settings, scale);
    const ranked = rankTranslationMatches(matches, settings);
    let best = null;

    for (const candidate of ranked) {
        const transform = {
            scale: transformScale,
            rotation: 0,
            tx: candidate.dx,
            ty: candidate.dy
        };
        const overlap = computeOverlapMetrics(sourceProfile, targetProfile, transform);
        if (!overlap || overlap.samples < 36 || (overlap.similarity < 0.42 && overlap.pixelMatchRatio < 0.4)) continue;
        const score = (candidate.matches.length * 2.1)
            + (overlap.similarity * 95)
            + (overlap.pixelMatchRatio * 42)
            + (overlap.edgeMatchRatio * 26)
            + (overlap.overlapRatio * 34)
            - (candidate.spread * 1.5)
            - (overlap.grayDifference * 0.12);
        if (!best || score > best.score) {
            best = { candidate, overlap, transform, score };
        }
    }

    if (!best) return null;

    return {
        fromId: source.id,
        toId: target.id,
        matches: best.candidate.matches.length,
        score: best.score,
        coverage: best.overlap.overlapRatio,
        transform: convertTransformToOriginalSpace({ transform: best.transform }, source, target),
        similarity: best.overlap.similarity,
        pixelMatch: best.overlap.pixelMatchRatio,
        edgeMatch: best.overlap.edgeMatchRatio,
        method: 'translation'
    };
}

function buildPairEdges(preparedInputs, settings) {
    const featuresById = new Map(preparedInputs.map((input) => [input.id, extractFeatures(input, settings)]));
    const translationProfiles = new Map(preparedInputs.map((input) => [input.id, buildTranslationProfile(input, settings)]));
    const edges = [];
    for (let index = 0; index < preparedInputs.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < preparedInputs.length; otherIndex += 1) {
            const source = preparedInputs[index];
            const target = preparedInputs[otherIndex];
            const translationEdge = buildTranslationPairEdge(
                source,
                target,
                translationProfiles.get(source.id),
                translationProfiles.get(target.id),
                settings
            );
            const similarityEdge = buildSimilarityPairEdge(source, target, featuresById, settings);
            const chosen = (() => {
                if (translationEdge && similarityEdge) {
                    return translationEdge.score >= similarityEdge.score * 0.9
                        ? translationEdge
                        : similarityEdge;
                }
                return translationEdge || similarityEdge || null;
            })();
            if (chosen) edges.push(chosen);
        }
    }
    return edges;
}

function createIdentityPlacement(input, z = 0) {
    return {
        inputId: input.id,
        x: 0,
        y: 0,
        scale: 1,
        rotation: 0,
        visible: true,
        locked: false,
        z,
        opacity: 1
    };
}

function transformToPlacement(transform, inputId, z = 0) {
    return {
        inputId,
        x: transform.tx,
        y: transform.ty,
        scale: transform.scale,
        rotation: transform.rotation,
        visible: true,
        locked: false,
        z,
        opacity: 1
    };
}

function buildAdjacency(edges) {
    const map = new Map();
    function pushEdge(fromId, toId, transform, score, matches, coverage) {
        if (!map.has(fromId)) map.set(fromId, []);
        map.get(fromId).push({ fromId, toId, transform, score, matches, coverage });
    }
    for (const edge of edges) {
        // `edge.transform` maps source-local coordinates into target-local coordinates.
        // Placement traversal needs the opposite: target-local into global when starting
        // from a known source placement, so the forward traversal uses the inverse.
        pushEdge(edge.fromId, edge.toId, invertTransform(edge.transform), edge.score, edge.matches, edge.coverage);
        pushEdge(edge.toId, edge.fromId, edge.transform, edge.score, edge.matches, edge.coverage);
    }
    return map;
}

function buildEdgeLookup(edges) {
    const lookup = new Map();
    for (const edge of edges) {
        lookup.set(`${edge.fromId}->${edge.toId}`, edge);
        lookup.set(`${edge.toId}->${edge.fromId}`, {
            ...edge,
            fromId: edge.toId,
            toId: edge.fromId,
            transform: invertTransform(edge.transform)
        });
    }
    return lookup;
}

function getPreparedInputMap(preparedInputs) {
    return new Map(preparedInputs.map((input) => [
        input.id,
        input.magnitude ? input : { ...input, magnitude: buildGradient(input.gray, input.width, input.height) }
    ]));
}

function summarizePreparedContent(preparedInput) {
    const magnitude = preparedInput.magnitude || buildGradient(preparedInput.gray, preparedInput.width, preparedInput.height);
    const histogram = new Array(16).fill(0);
    let samples = 0;
    let flat = 0;
    let textured = 0;
    for (let y = 1; y < preparedInput.height - 1; y += 2) {
        for (let x = 1; x < preparedInput.width - 1; x += 2) {
            const index = (y * preparedInput.width) + x;
            const gray = preparedInput.gray[index];
            const edge = magnitude[index];
            histogram[Math.max(0, Math.min(15, gray >> 4))] += 1;
            if (edge < 10) flat += 1;
            if (edge > 24) textured += 1;
            samples += 1;
        }
    }
    let entropy = 0;
    histogram.forEach((count) => {
        if (!count) return;
        const probability = count / Math.max(1, samples);
        entropy -= probability * Math.log2(probability);
    });
    return {
        entropy,
        flatRatio: flat / Math.max(1, samples),
        texturedRatio: textured / Math.max(1, samples)
    };
}

function inferSceneMode(settings, edges, preparedInputs) {
    if (settings.sceneMode === 'screenshot' || settings.sceneMode === 'photo') return settings.sceneMode;
    let screenshotScore = 0;
    let photoScore = 0;
    for (const edge of edges) {
        if (edge.method === 'screenshot') {
            screenshotScore += (edge.score || 0) + ((edge.pixelMatch || 0) * 80) + ((edge.edgeMatch || 0) * 60);
            if ((edge.pixelMatch || 0) < 0.9 || (edge.similarity || 0) < 0.9) {
                photoScore += ((1 - (edge.pixelMatch || 0)) * 120) + ((1 - (edge.similarity || 0)) * 80);
            }
        } else {
            photoScore += (edge.score || 0) + ((edge.coverage || 0) * 42);
        }
        const rotationAmount = Math.abs(edge.transform?.rotation || 0);
        const scaleDelta = Math.abs((edge.transform?.scale || 1) - 1);
        if (rotationAmount > 0.02 || scaleDelta > 0.03) {
            photoScore += 28;
        }
    }
    const contentSummaries = preparedInputs.map((input) => summarizePreparedContent(input));
    const averageEntropy = averageCandidateScore(contentSummaries.map((summary) => summary.entropy), 0);
    const averageFlatRatio = averageCandidateScore(contentSummaries.map((summary) => summary.flatRatio), 0);
    const averageTexturedRatio = averageCandidateScore(contentSummaries.map((summary) => summary.texturedRatio), 0);
    const averagePixelMatch = averageCandidateScore(edges.map((edge) => edge.pixelMatch || 0), 0);
    const averageSimilarity = averageCandidateScore(edges.map((edge) => edge.similarity || 0), 0);
    photoScore += (averageEntropy * 18) + ((1 - averageFlatRatio) * 90) + (averageTexturedRatio * 44);
    screenshotScore += (averageFlatRatio * 92) + ((1 - averageTexturedRatio) * 30);
    if (averageFlatRatio < 0.56 && averageTexturedRatio > 0.32 && averagePixelMatch < 0.92 && averageSimilarity < 0.9) {
        photoScore += 140;
    }
    return screenshotScore >= photoScore * 1.12 ? 'screenshot' : 'photo';
}

function averageCandidateScore(entries, fallback = 0) {
    if (!entries.length) return fallback;
    return entries.reduce((sum, entry) => sum + entry, 0) / entries.length;
}

function getPlacementById(placements, inputId) {
    return placements.find((placement) => placement.inputId === inputId) || null;
}

function getOverlapBounds(sourceInput, sourcePlacement, targetInput, targetPlacement) {
    const sourceCorners = [
        localPointToWorld(0, 0, sourcePlacement),
        localPointToWorld(sourceInput.width, 0, sourcePlacement),
        localPointToWorld(0, sourceInput.height, sourcePlacement),
        localPointToWorld(sourceInput.width, sourceInput.height, sourcePlacement)
    ];
    const targetCorners = [
        localPointToWorld(0, 0, targetPlacement),
        localPointToWorld(targetInput.width, 0, targetPlacement),
        localPointToWorld(0, targetInput.height, targetPlacement),
        localPointToWorld(targetInput.width, targetInput.height, targetPlacement)
    ];
    const sourceMinX = Math.min(...sourceCorners.map((corner) => corner.x));
    const sourceMaxX = Math.max(...sourceCorners.map((corner) => corner.x));
    const sourceMinY = Math.min(...sourceCorners.map((corner) => corner.y));
    const sourceMaxY = Math.max(...sourceCorners.map((corner) => corner.y));
    const targetMinX = Math.min(...targetCorners.map((corner) => corner.x));
    const targetMaxX = Math.max(...targetCorners.map((corner) => corner.x));
    const targetMinY = Math.min(...targetCorners.map((corner) => corner.y));
    const targetMaxY = Math.max(...targetCorners.map((corner) => corner.y));
    const minX = Math.max(sourceMinX, targetMinX);
    const maxX = Math.min(sourceMaxX, targetMaxX);
    const minY = Math.max(sourceMinY, targetMinY);
    const maxY = Math.min(sourceMaxY, targetMaxY);
    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}

function samplePreparedValue(prepared, x, y, plane = 'gray') {
    const ix = clamp(Math.round(x), 0, prepared.width - 1);
    const iy = clamp(Math.round(y), 0, prepared.height - 1);
    return prepared[plane][(iy * prepared.width) + ix];
}

function measurePatchDifference(sourcePrepared, targetPrepared, sourceX, sourceY, targetX, targetY, patchRadius) {
    if (
        sourceX < patchRadius || sourceY < patchRadius
        || sourceX >= sourcePrepared.width - patchRadius || sourceY >= sourcePrepared.height - patchRadius
        || targetX < patchRadius || targetY < patchRadius
        || targetX >= targetPrepared.width - patchRadius || targetY >= targetPrepared.height - patchRadius
    ) {
        return Infinity;
    }

    let total = 0;
    let samples = 0;
    for (let oy = -patchRadius; oy <= patchRadius; oy += 2) {
        for (let ox = -patchRadius; ox <= patchRadius; ox += 2) {
            const sourceGray = samplePreparedValue(sourcePrepared, sourceX + ox, sourceY + oy, 'gray');
            const targetGray = samplePreparedValue(targetPrepared, targetX + ox, targetY + oy, 'gray');
            const sourceEdge = samplePreparedValue(sourcePrepared, sourceX + ox, sourceY + oy, 'magnitude');
            const targetEdge = samplePreparedValue(targetPrepared, targetX + ox, targetY + oy, 'magnitude');
            total += Math.abs(sourceGray - targetGray) + (Math.abs(sourceEdge - targetEdge) * 0.45);
            samples += 1;
        }
    }
    return total / Math.max(1, samples);
}

function searchLocalWarpDelta(sourceInput, sourcePlacement, sourcePrepared, targetInput, targetPlacement, targetPrepared, localX, localY, maxSearch, patchRadius) {
    const sourceScaleX = sourcePrepared.width / Math.max(1, sourceInput.width || sourcePrepared.originalWidth || sourcePrepared.width);
    const sourceScaleY = sourcePrepared.height / Math.max(1, sourceInput.height || sourcePrepared.originalHeight || sourcePrepared.height);
    const targetScaleX = targetPrepared.width / Math.max(1, targetInput.width || targetPrepared.originalWidth || targetPrepared.width);
    const targetScaleY = targetPrepared.height / Math.max(1, targetInput.height || targetPrepared.originalHeight || targetPrepared.height);
    const sourcePreparedX = localX * sourceScaleX;
    const sourcePreparedY = localY * sourceScaleY;
    const predictedWorld = localPointToWorld(localX, localY, sourcePlacement);
    const predictedTargetLocal = worldPointToLocal(predictedWorld.x, predictedWorld.y, targetPlacement);
    const predictedTargetX = predictedTargetLocal.x * targetScaleX;
    const predictedTargetY = predictedTargetLocal.y * targetScaleY;
    const searchRadius = Math.max(1, Math.round(maxSearch * Math.min(targetScaleX, targetScaleY)));
    const baseScore = measurePatchDifference(sourcePrepared, targetPrepared, sourcePreparedX, sourcePreparedY, predictedTargetX, predictedTargetY, patchRadius);
    if (!Number.isFinite(baseScore)) return null;

    let bestScore = baseScore;
    let bestOffsetX = 0;
    let bestOffsetY = 0;
    for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
        for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
            const score = measurePatchDifference(
                sourcePrepared,
                targetPrepared,
                sourcePreparedX,
                sourcePreparedY,
                predictedTargetX + dx,
                predictedTargetY + dy,
                patchRadius
            );
            if (score < bestScore) {
                bestScore = score;
                bestOffsetX = dx;
                bestOffsetY = dy;
            }
        }
    }

    const improvement = baseScore - bestScore;
    if (improvement <= 0.4) return null;

    const bestTargetLocal = {
        x: (predictedTargetX + bestOffsetX) / Math.max(0.0001, targetScaleX),
        y: (predictedTargetY + bestOffsetY) / Math.max(0.0001, targetScaleY)
    };
    const bestWorld = localPointToWorld(bestTargetLocal.x, bestTargetLocal.y, targetPlacement);
    const worldDelta = {
        x: bestWorld.x - predictedWorld.x,
        y: bestWorld.y - predictedWorld.y
    };
    const localDelta = worldVectorToLocalDelta(worldDelta.x, worldDelta.y, sourcePlacement);
    const deltaMagnitude = Math.hypot(localDelta.x, localDelta.y);
    return {
        dx: localDelta.x,
        dy: localDelta.y,
        weight: clamp((improvement / 16) * (1 - Math.min(1, deltaMagnitude / Math.max(8, maxSearch * 2.5))), 0, 1),
        improvement
    };
}

function smoothWarpPoints(points, cols, rows) {
    return points.map((point, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const neighbors = [];
        for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
            for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                const nextCol = col + offsetX;
                const nextRow = row + offsetY;
                if (nextCol < 0 || nextRow < 0 || nextCol >= cols || nextRow >= rows) continue;
                neighbors.push(points[(nextRow * cols) + nextCol]);
            }
        }
        const neighborWeight = neighbors.reduce((sum, neighbor) => sum + (neighbor.weight || 0), 0);
        if (neighborWeight < 0.05) return point;
        return {
            ...point,
            dx: neighbors.reduce((sum, neighbor) => sum + (neighbor.dx * (neighbor.weight || 0)), 0) / neighborWeight,
            dy: neighbors.reduce((sum, neighbor) => sum + (neighbor.dy * (neighbor.weight || 0)), 0) / neighborWeight,
            weight: point.weight
        };
    });
}

function buildFallbackWarpPoints(input, placement, candidatePlacements, edgeLookup, type, density) {
    const grid = getMeshGridDimensions(density, type);
    let influenceX = 0;
    let influenceY = 0;
    let neighbors = 0;
    for (const neighborPlacement of candidatePlacements) {
        if (neighborPlacement.inputId === placement.inputId) continue;
        const edge = edgeLookup.get(`${placement.inputId}->${neighborPlacement.inputId}`) || edgeLookup.get(`${neighborPlacement.inputId}->${placement.inputId}`);
        if (!edge) continue;
        influenceX += clamp((neighborPlacement.x - placement.x) / Math.max(1, input.width), -1, 1);
        influenceY += clamp((neighborPlacement.y - placement.y) / Math.max(1, input.height), -1, 1);
        neighbors += 1;
    }
    if (!neighbors) return null;
    const averageX = influenceX / neighbors;
    const averageY = influenceY / neighbors;
    const magnitude = type === 'mesh' ? 6 : 4;
    const points = [];
    for (let row = 0; row < grid.rows; row += 1) {
        const v = grid.rows > 1 ? row / (grid.rows - 1) : 0;
        for (let col = 0; col < grid.cols; col += 1) {
            const u = grid.cols > 1 ? col / (grid.cols - 1) : 0;
            const centeredU = (u - 0.5) * 2;
            const centeredV = (v - 0.5) * 2;
            points.push({
                u,
                v,
                dx: averageX * centeredU * magnitude * (type === 'mesh' ? (1 - (Math.abs(centeredV) * 0.25)) : 1),
                dy: averageY * centeredV * magnitude * (type === 'mesh' ? (1 - (Math.abs(centeredU) * 0.25)) : 1),
                weight: 0.18
            });
        }
    }
    return {
        type,
        density,
        cols: grid.cols,
        rows: grid.rows,
        strength: 0.24,
        smoothness: type === 'mesh' ? 0.72 : 0.84,
        support: 0.18,
        averageWeight: 0.18,
        points
    };
}

function buildWarpForPlacement(input, placement, candidatePlacements, inputsById, preparedById, edgeLookup, settings, type = 'mesh') {
    const sourcePrepared = preparedById.get(input.id);
    if (!sourcePrepared) return null;
    const density = type === 'perspective' ? 'low' : settings.meshDensity;
    const grid = getMeshGridDimensions(density, type);
    const basePoints = [];
    let supportedPoints = 0;
    let totalWeight = 0;

    for (let row = 0; row < grid.rows; row += 1) {
        const v = grid.rows > 1 ? row / (grid.rows - 1) : 0;
        for (let col = 0; col < grid.cols; col += 1) {
            const u = grid.cols > 1 ? col / (grid.cols - 1) : 0;
            const localX = u * input.width;
            const localY = v * input.height;
            const deltas = [];
            for (const neighborPlacement of candidatePlacements) {
                if (neighborPlacement.inputId === placement.inputId) continue;
                const edge = edgeLookup.get(`${placement.inputId}->${neighborPlacement.inputId}`) || edgeLookup.get(`${neighborPlacement.inputId}->${placement.inputId}`);
                if (!edge) continue;
                const neighborInput = inputsById.get(neighborPlacement.inputId);
                const targetPrepared = preparedById.get(neighborPlacement.inputId);
                if (!neighborInput || !targetPrepared) continue;
                const overlap = getOverlapBounds(input, placement, neighborInput, neighborPlacement);
                if (overlap.width < Math.max(32, input.width * 0.12) || overlap.height < Math.max(32, input.height * 0.12)) continue;
                const sample = searchLocalWarpDelta(
                    input,
                    placement,
                    sourcePrepared,
                    neighborInput,
                    neighborPlacement,
                    targetPrepared,
                    localX,
                    localY,
                    type === 'mesh' ? 28 : 14,
                    type === 'mesh' ? 6 : 8
                );
                if (sample && sample.weight > 0) {
                    deltas.push(sample);
                }
            }
            if (!deltas.length) {
                basePoints.push({ u, v, dx: 0, dy: 0, weight: 0 });
                continue;
            }
            supportedPoints += 1;
            const pointWeight = deltas.reduce((sum, delta) => sum + delta.weight, 0);
            totalWeight += pointWeight;
            basePoints.push({
                u,
                v,
                dx: clamp(deltas.reduce((sum, delta) => sum + (delta.dx * delta.weight), 0) / Math.max(0.0001, pointWeight), -24, 24),
                dy: clamp(deltas.reduce((sum, delta) => sum + (delta.dy * delta.weight), 0) / Math.max(0.0001, pointWeight), -24, 24),
                weight: clamp(pointWeight / Math.max(1, deltas.length), 0, 1)
            });
        }
    }

    if (supportedPoints < Math.max(3, grid.cols)) {
        return buildFallbackWarpPoints(input, placement, candidatePlacements, edgeLookup, type, density);
    }
    const smoothed = smoothWarpPoints(basePoints, grid.cols, grid.rows);
    const averageWeight = totalWeight / Math.max(1, supportedPoints);
    return {
        type,
        density,
        cols: grid.cols,
        rows: grid.rows,
        strength: clamp(averageWeight * 1.5, 0.25, 3),
        smoothness: type === 'mesh' ? 0.68 : 0.82,
        support: supportedPoints / Math.max(1, basePoints.length),
        averageWeight,
        points: smoothed
    };
}

function buildWarpVariantFromCandidate(baseCandidate, document, preparedById, inputsById, edgeLookup, settings, type = 'mesh') {
    const placements = baseCandidate.placements.map((placement) => {
        const input = inputsById.get(placement.inputId);
        if (!input) return placement;
        const warp = buildWarpForPlacement(input, placement, baseCandidate.placements, inputsById, preparedById, edgeLookup, settings, type);
        if (!warp) return placement;
        return {
            ...placement,
            warp
        };
    });
    const supportedPlacements = placements.filter((placement) => placement.warp);
    if (!supportedPlacements.length) return null;
    const support = averageCandidateScore(supportedPlacements.map((placement) => placement.warp.support), 0);
    const weight = averageCandidateScore(supportedPlacements.map((placement) => placement.warp.averageWeight), 0);
    const distortionPenalty = averageCandidateScore(
        supportedPlacements.map((placement) => averageCandidateScore(
            (placement.warp.points || []).map((point) => Math.hypot(point.dx, point.dy)),
            0
        )),
        0
    );
    return {
        ...baseCandidate,
        id: createStitchCandidateId(),
        name: `${type === 'mesh' ? 'Mesh' : 'Perspective'} ${baseCandidate.name}`,
        modelType: type,
        blendMode: settings.blendMode === 'auto' ? (type === 'mesh' ? 'seam' : 'feather') : settings.blendMode,
        placements: buildInitialPlacementsFromCandidate(document, placements),
        diagnostics: [...(baseCandidate.diagnostics || []), `${type} warp support ${(support * 100).toFixed(0)}%`],
        score: baseCandidate.score + (support * 36) + (weight * 22) - (distortionPenalty * (type === 'mesh' ? 0.28 : 0.18)),
        warning: baseCandidate.warning || ''
    };
}

function enrichRigidCandidate(candidate, sceneMode, settings) {
    const blendMode = settings.blendMode === 'auto'
        ? (sceneMode === 'screenshot' ? 'alpha' : 'feather')
        : settings.blendMode;
    return {
        ...candidate,
        modelType: sceneMode === 'screenshot' ? 'screenshot' : 'rigid',
        blendMode,
        score: candidate.score + (candidate.coverage * 18) + (sceneMode === 'screenshot' ? 18 : 9)
    };
}

function rankCandidates(candidates) {
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const maxScore = sorted[0]?.score || 1;
    const minScore = sorted[sorted.length - 1]?.score || 0;
    return sorted.map((candidate, index) => {
        const normalizedScore = maxScore === minScore ? 1 : ((candidate.score - minScore) / Math.max(0.0001, maxScore - minScore));
        const rankFactor = sorted.length <= 1 ? 1 : (1 - (index / (sorted.length - 1)));
        return {
            ...candidate,
            rank: index + 1,
            confidence: clamp((normalizedScore * 0.45) + ((candidate.coverage || 0) * 0.3) + (rankFactor * 0.25), 0, 1)
        };
    });
}

function buildCandidateFromAnchor(document, adjacency, anchorId, scoreMap = new Map()) {
    const normalized = normalizeStitchDocument(document);
    const queue = [{ inputId: anchorId, placement: createIdentityPlacement(normalized.inputs.find((input) => input.id === anchorId), 0), score: 1 }];
    const placements = new Map();
    const diagnostics = [];
    placements.set(anchorId, queue[0].placement);

    while (queue.length) {
        queue.sort((a, b) => b.score - a.score);
        const current = queue.shift();
        const edges = adjacency.get(current.inputId) || [];
        edges.sort((a, b) => b.score - a.score);
        for (const edge of edges) {
            if (placements.has(edge.toId)) continue;
            const sourcePlacement = placements.get(current.inputId);
            const composed = composeTransforms(sourcePlacement, edge.transform);
            const targetIndex = normalized.inputs.findIndex((input) => input.id === edge.toId);
            const placement = transformToPlacement(composed, edge.toId, targetIndex);
            placements.set(edge.toId, placement);
            queue.push({ inputId: edge.toId, placement, score: edge.score });
            diagnostics.push(`${current.inputId} -> ${edge.toId} (${edge.matches} inliers)`);
            scoreMap.set(edge.toId, edge.score);
        }
    }

    let cursorX = 0;
    const orderedPlacements = [];
    for (let index = 0; index < normalized.inputs.length; index += 1) {
        const input = normalized.inputs[index];
        if (placements.has(input.id)) {
            orderedPlacements.push({ ...placements.get(input.id), z: index });
            continue;
        }
        orderedPlacements.push({
            inputId: input.id,
            x: cursorX,
            y: 0,
            scale: 1,
            rotation: 0,
            visible: true,
            locked: false,
            z: index,
            opacity: 1
        });
        cursorX += input.width + 64;
    }

    const totalScore = [...scoreMap.values()].reduce((sum, value) => sum + value, 0);
    const placedCount = [...placements.keys()].length;
    return {
        id: createStitchCandidateId(),
        name: `Anchor ${normalized.inputs.find((input) => input.id === anchorId)?.name || anchorId}`,
        score: totalScore + placedCount,
        source: 'analysis',
        confidence: 0,
        rank: 1,
        modelType: 'rigid',
        blendMode: 'auto',
        coverage: placedCount / Math.max(1, normalized.inputs.length),
        placements: buildInitialPlacementsFromCandidate(normalized, orderedPlacements),
        diagnostics,
        warning: placedCount < normalized.inputs.length ? 'Some images fell back to manual placement.' : ''
    };
}

function dedupeCandidates(candidates) {
    const seen = new Set();
    const result = [];
    for (const candidate of candidates) {
        const key = JSON.stringify(candidate.placements.map((placement) => [
            placement.inputId,
            Math.round(placement.x),
            Math.round(placement.y),
            Math.round((placement.scale || 1) * 1000),
            Math.round((placement.rotation || 0) * 1000),
            placement.warp?.type || '',
            placement.warp?.cols || 0,
            placement.warp?.rows || 0,
            placement.warp?.points ? placement.warp.points.slice(0, 6).map((point) => [
                Math.round(point.dx * 10),
                Math.round(point.dy * 10)
            ]) : []
        ]));
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(candidate);
    }
    return result;
}

export function analyzePreparedStitchInputs(document, preparedInputs) {
    const normalized = normalizeStitchDocument(document);
    if (preparedInputs.length <= 1) {
        const manualCandidate = buildManualLayoutCandidate(normalized.inputs, preparedInputs.length ? '' : 'Add two or more images to analyze a stitch.');
        return {
            candidates: [manualCandidate],
            warning: preparedInputs.length ? 'Only one image was available, so no overlap analysis was run.' : 'Add images to begin stitching.',
            diagnostics: []
        };
    }

    const edges = buildPairEdges(preparedInputs, normalized.settings);
    if (!edges.length) {
        const manualCandidate = buildManualLayoutCandidate(normalized.inputs, 'No strong overlap matches were found.');
        return {
            candidates: [manualCandidate],
            warning: 'No strong overlap matches were found. Falling back to manual layout.',
            diagnostics: []
        };
    }

    const sceneMode = inferSceneMode(normalized.settings, edges, preparedInputs);
    const adjacency = buildAdjacency(edges);
    const edgeLookup = buildEdgeLookup(edges);
    const preparedById = getPreparedInputMap(preparedInputs);
    const inputsById = new Map(normalized.inputs.map((input) => [input.id, input]));
    const rigidCandidates = normalized.inputs.map((input) => enrichRigidCandidate(buildCandidateFromAnchor(normalized, adjacency, input.id, new Map()), sceneMode, normalized.settings));
    const candidates = [...rigidCandidates];

    if (sceneMode === 'photo' && normalized.settings.warpMode !== 'off') {
        const baseForWarp = rigidCandidates.slice(0, Math.min(3, rigidCandidates.length));
        for (const baseCandidate of baseForWarp) {
            if (normalized.settings.warpMode === 'auto' || normalized.settings.warpMode === 'perspective') {
                const perspectiveVariant = buildWarpVariantFromCandidate(
                    baseCandidate,
                    normalized,
                    preparedById,
                    inputsById,
                    edgeLookup,
                    normalized.settings,
                    'perspective'
                );
                if (perspectiveVariant) candidates.push(perspectiveVariant);
            }
            if (normalized.settings.warpMode === 'auto' || normalized.settings.warpMode === 'mesh') {
                const meshVariant = buildWarpVariantFromCandidate(
                    baseCandidate,
                    normalized,
                    preparedById,
                    inputsById,
                    edgeLookup,
                    normalized.settings,
                    'mesh'
                );
                if (meshVariant) candidates.push(meshVariant);
            }
        }
    }

    candidates.push(buildManualLayoutCandidate(normalized.inputs, 'Manual fallback layout.'));
    const deduped = rankCandidates(dedupeCandidates(candidates))
        .slice(0, normalized.settings.maxCandidates || 6);

    return {
        candidates: deduped,
        warning: deduped[0]?.source === 'manual'
            ? 'The strongest result still needed manual placement.'
            : (sceneMode === 'photo'
                ? 'Photo mode generated ranked rigid and warped candidates.'
                : ''),
        diagnostics: edges
            .sort((a, b) => b.score - a.score)
            .map((edge) => ({
                pair: `${edge.fromId} -> ${edge.toId}`,
                method: edge.method || 'similarity',
                score: edge.score,
                matches: edge.matches,
                coverage: edge.coverage,
                similarity: edge.similarity,
                pixelMatch: edge.pixelMatch,
                edgeMatch: edge.edgeMatch
            }))
            .concat([{ pair: 'scene', method: sceneMode, score: deduped[0]?.score || 0, matches: deduped.length, coverage: deduped[0]?.coverage || 0 }])
    };
}
