function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function round(value, decimals = 4) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const factor = 10 ** decimals;
    return Math.round(numeric * factor) / factor;
}

function analyzePreparedInput(preparedInput) {
    const width = Math.max(1, Number(preparedInput?.width) || 1);
    const height = Math.max(1, Number(preparedInput?.height) || 1);
    const gray = preparedInput?.gray instanceof Uint8ClampedArray ? preparedInput.gray : null;
    if (!gray || gray.length < (width * height)) {
        return {
            name: preparedInput?.name || preparedInput?.id || 'Input',
            sampleCount: 0,
            edgeRatio: 0,
            flatRatio: 0,
            axisAlignedEdgeRatio: 0,
            entropy: 0
        };
    }

    const histogram = new Array(16).fill(0);
    const step = Math.max(1, Math.round(Math.max(width, height) / 120));
    let sampleCount = 0;
    let edgeCount = 0;
    let flatCount = 0;
    let axisAlignedEdgeWeight = 0;

    for (let y = 1; y < height - 1; y += step) {
        for (let x = 1; x < width - 1; x += step) {
            const index = (y * width) + x;
            const center = gray[index];
            const left = gray[index - 1];
            const right = gray[index + 1];
            const top = gray[index - width];
            const bottom = gray[index + width];
            const gx = right - left;
            const gy = bottom - top;
            const magnitude = Math.abs(gx) + Math.abs(gy);
            const localVariation = Math.abs(center - left)
                + Math.abs(center - right)
                + Math.abs(center - top)
                + Math.abs(center - bottom);

            histogram[Math.min(15, Math.floor(center / 16))] += 1;
            sampleCount += 1;

            if (localVariation < 24) flatCount += 1;
            if (magnitude > 28) {
                edgeCount += 1;
                axisAlignedEdgeWeight += Math.max(Math.abs(gx), Math.abs(gy)) / Math.max(1, magnitude);
            }
        }
    }

    const entropy = histogram.reduce((total, bucket) => {
        if (!bucket || !sampleCount) return total;
        const probability = bucket / sampleCount;
        return total - (probability * Math.log2(probability));
    }, 0);

    return {
        name: preparedInput?.name || preparedInput?.id || 'Input',
        sampleCount,
        edgeRatio: edgeCount / Math.max(1, sampleCount),
        flatRatio: flatCount / Math.max(1, sampleCount),
        axisAlignedEdgeRatio: axisAlignedEdgeWeight / Math.max(1, edgeCount),
        entropy: entropy / Math.log2(16)
    };
}

export function classifyPreparedInputs(preparedInputs = []) {
    const summaries = preparedInputs.map((preparedInput) => analyzePreparedInput(preparedInput));
    if (!summaries.length) {
        return {
            sceneMode: 'screenshot',
            diagnostics: [{
                pair: 'scene',
                method: 'auto-classifier',
                score: 1,
                matches: 0,
                coverage: 0,
                details: 'No prepared inputs were available. Falling back to the screenshot backend.'
            }]
        };
    }

    const aggregate = summaries.reduce((totals, summary) => ({
        sampleCount: totals.sampleCount + summary.sampleCount,
        edgeRatio: totals.edgeRatio + summary.edgeRatio,
        flatRatio: totals.flatRatio + summary.flatRatio,
        axisAlignedEdgeRatio: totals.axisAlignedEdgeRatio + summary.axisAlignedEdgeRatio,
        entropy: totals.entropy + summary.entropy
    }), {
        sampleCount: 0,
        edgeRatio: 0,
        flatRatio: 0,
        axisAlignedEdgeRatio: 0,
        entropy: 0
    });

    const count = Math.max(1, summaries.length);
    const flatRatio = aggregate.flatRatio / count;
    const edgeRatio = aggregate.edgeRatio / count;
    const axisAlignedEdgeRatio = aggregate.axisAlignedEdgeRatio / count;
    const entropy = aggregate.entropy / count;
    const screenshotScore = clamp(
        (flatRatio * 0.42)
        + (axisAlignedEdgeRatio * 0.33)
        + ((1 - entropy) * 0.2)
        + (Math.max(0, 0.08 - edgeRatio) * 0.6),
        0,
        1
    );
    const sceneMode = screenshotScore >= 0.53 ? 'screenshot' : 'photo';

    return {
        sceneMode,
        diagnostics: [{
            pair: 'scene',
            method: 'auto-classifier',
            score: round(sceneMode === 'screenshot' ? screenshotScore : (1 - screenshotScore), 4),
            matches: summaries.length,
            coverage: round(flatRatio, 4),
            screenshotScore: round(screenshotScore, 4),
            photoScore: round(1 - screenshotScore, 4),
            flatRatio: round(flatRatio, 4),
            edgeRatio: round(edgeRatio, 4),
            axisAlignedEdgeRatio: round(axisAlignedEdgeRatio, 4),
            entropy: round(entropy, 4),
            details: sceneMode === 'screenshot'
                ? 'Auto mode chose the screenshot backend because the inputs look flatter and more axis-aligned.'
                : 'Auto mode chose the photo backend because the inputs look more textured and less screen-like.'
        }]
    };
}
