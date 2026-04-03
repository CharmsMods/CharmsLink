function clampByte(value) {
    return Math.max(0, Math.min(255, Math.round(Number(value) || 0)));
}

function clampCount(value, fallback = 8) {
    return Math.max(2, Math.min(200, Math.round(Number(value) || fallback)));
}

function createSamplingCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }
    if (typeof document !== 'undefined' && document?.createElement) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    throw new Error('No canvas implementation is available for palette extraction.');
}

function createStableSeedIndex(samples = []) {
    if (!samples.length) return 0;
    const weightedTotal = samples.reduce((total, sample, index) => total + (
        ((sample.r * 3) + (sample.g * 5) + (sample.b * 7) + ((index + 1) * 11)) % 104729
    ), 0);
    return Math.max(0, Math.min(samples.length - 1, weightedTotal % samples.length));
}

function sortPalette(samples = []) {
    return samples
        .map((sample) => ({
            hex: `#${[sample.r, sample.g, sample.b].map((value) => clampByte(value).toString(16).padStart(2, '0')).join('')}`,
            weight: (sample.r * 0.2126) + (sample.g * 0.7152) + (sample.b * 0.0722)
        }))
        .sort((left, right) => left.weight - right.weight)
        .map((sample) => sample.hex);
}

export function extractPaletteFromPixels(pixels, width, height, count, options = {}) {
    const rgba = pixels instanceof Uint8ClampedArray
        ? pixels
        : pixels instanceof Uint8Array
            ? new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength)
            : new Uint8ClampedArray(pixels || []);
    if (!rgba.length || width <= 0 || height <= 0) {
        return ['#111111', '#f5f7fa'];
    }

    const alphaThreshold = Math.max(0, Math.min(255, Number(options.alphaThreshold) || 240));
    const targetCount = clampCount(count, 8);
    const totalPixels = Math.max(1, width * height);
    const maxSamples = targetCount > 96 ? 10000 : 8000;
    const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / maxSamples)));
    const samples = [];

    for (let y = 0; y < height; y += stride) {
        for (let x = 0; x < width; x += stride) {
            const index = ((y * width) + x) * 4;
            const alpha = rgba[index + 3];
            if (alpha < alphaThreshold) continue;
            samples.push({
                r: rgba[index],
                g: rgba[index + 1],
                b: rgba[index + 2]
            });
        }
    }

    if (!samples.length) return ['#111111', '#f5f7fa'];

    const paletteSize = Math.min(targetCount, samples.length);
    const centers = [{ ...samples[createStableSeedIndex(samples)] }];
    const minDistances = new Array(samples.length).fill(Infinity);
    const distanceSq = (left, right) => {
        const dr = left.r - right.r;
        const dg = left.g - right.g;
        const db = left.b - right.b;
        return (dr * dr) + (dg * dg) + (db * db);
    };

    const refreshDistances = (center) => {
        for (let index = 0; index < samples.length; index += 1) {
            const distance = distanceSq(samples[index], center);
            if (distance < minDistances[index]) minDistances[index] = distance;
        }
    };

    refreshDistances(centers[0]);
    while (centers.length < paletteSize) {
        let bestIndex = 0;
        let bestDistance = -1;
        for (let index = 0; index < minDistances.length; index += 1) {
            if (minDistances[index] > bestDistance) {
                bestDistance = minDistances[index];
                bestIndex = index;
            }
        }
        centers.push({ ...samples[bestIndex] });
        refreshDistances(samples[bestIndex]);
    }

    for (let iteration = 0; iteration < 5; iteration += 1) {
        const totals = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));

        for (const sample of samples) {
            let bestIndex = 0;
            let bestDistance = Infinity;
            for (let index = 0; index < centers.length; index += 1) {
                const distance = distanceSq(sample, centers[index]);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    bestIndex = index;
                }
            }
            totals[bestIndex].r += sample.r;
            totals[bestIndex].g += sample.g;
            totals[bestIndex].b += sample.b;
            totals[bestIndex].count += 1;
        }

        let moved = false;
        for (let index = 0; index < centers.length; index += 1) {
            const total = totals[index];
            if (!total.count) continue;
            const next = {
                r: Math.round(total.r / total.count),
                g: Math.round(total.g / total.count),
                b: Math.round(total.b / total.count)
            };
            if (next.r !== centers[index].r || next.g !== centers[index].g || next.b !== centers[index].b) {
                moved = true;
            }
            centers[index] = next;
        }
        if (!moved) break;
    }

    return sortPalette(centers);
}

export function extractPaletteFromImageSource(image, count, options = {}) {
    if (!image) {
        return ['#111111', '#f5f7fa'];
    }
    const sourceWidth = Math.max(1, Number(image.width) || 1);
    const sourceHeight = Math.max(1, Number(image.height) || 1);
    const longestEdge = Math.max(sourceWidth, sourceHeight);
    const sampleScale = Math.min(1, 320 / longestEdge);
    const width = Math.max(1, Math.round(sourceWidth * sampleScale));
    const height = Math.max(1, Math.round(sourceHeight * sampleScale));
    const canvas = createSamplingCanvas(width, height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: true });
    if (!ctx) {
        throw new Error('Could not create a palette sampling canvas.');
    }
    ctx.drawImage(image, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height).data;
    return extractPaletteFromPixels(pixels, width, height, count, options);
}
