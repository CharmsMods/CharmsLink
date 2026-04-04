function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizePair(start, end) {
    let safeStart = clamp(Number(start) || 0, 0, 0.98);
    let safeEnd = clamp(Number(end) || 0, 0, 0.98);
    const total = safeStart + safeEnd;
    if (total > 0.98) {
        const scale = 0.98 / total;
        safeStart *= scale;
        safeEnd *= scale;
    }
    return { start: safeStart, end: safeEnd };
}

export function getCropTransformMetrics(params = {}, width = 1, height = 1) {
    const safeWidth = Math.max(1, Number(width) || 1);
    const safeHeight = Math.max(1, Number(height) || 1);
    const xFractions = normalizePair(Number(params.cropLeft ?? 0) / 100, Number(params.cropRight ?? 0) / 100);
    const yFractions = normalizePair(Number(params.cropTop ?? 0) / 100, Number(params.cropBottom ?? 0) / 100);
    const leftPx = safeWidth * xFractions.start;
    const rightPx = safeWidth * xFractions.end;
    const topPx = safeHeight * yFractions.start;
    const bottomPx = safeHeight * yFractions.end;
    const cropWidthFloat = Math.max(1, safeWidth - leftPx - rightPx);
    const cropHeightFloat = Math.max(1, safeHeight - topPx - bottomPx);

    return {
        leftPx,
        rightPx,
        topPx,
        bottomPx,
        cropWidthFloat,
        cropHeightFloat,
        outputWidth: Math.max(1, Math.round(cropWidthFloat)),
        outputHeight: Math.max(1, Math.round(cropHeightFloat)),
        hasCrop:
            leftPx > 0.0001
            || rightPx > 0.0001
            || topPx > 0.0001
            || bottomPx > 0.0001
    };
}

export function applyCropTransformToPlacement(placement, metrics) {
    if (!placement || !metrics) {
        return placement
            ? { ...placement }
            : { x: 0, y: 0, w: 1, h: 1 };
    }
    return {
        x: Number(placement.x || 0) - metrics.leftPx,
        y: Number(placement.y || 0) - metrics.topPx,
        w: Number(placement.w || 0),
        h: Number(placement.h || 0)
    };
}

export function isCropTransformIdentity(params = {}) {
    const metrics = getCropTransformMetrics(params, 1, 1);
    const rotation = Math.abs(Number(params.cropRotation ?? 0) || 0);
    return !metrics.hasCrop && rotation < 0.0001 && !params.cropFlipX && !params.cropFlipY;
}
