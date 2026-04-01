import * as THREE from 'three';

function hexToLinearColor(color, intensity = 1) {
    const srgb = new THREE.Color(color || '#ffffff');
    const linear = srgb.convertSRGBToLinear();
    linear.multiplyScalar(Math.max(0, Number(intensity) || 0));
    return linear;
}

function sortStops(stops = []) {
    const normalized = (Array.isArray(stops) ? stops : [])
        .map((entry) => ({
            position: Math.min(1, Math.max(0, Number(entry?.position) || 0)),
            color: String(entry?.color || '#ffffff')
        }))
        .sort((a, b) => a.position - b.position);

    if (!normalized.length) {
        return [
            { position: 0, color: '#f7f4eb' },
            { position: 1, color: '#26221d' }
        ];
    }

    if (normalized[0].position > 0) {
        normalized.unshift({ ...normalized[0], position: 0 });
    }
    if (normalized[normalized.length - 1].position < 1) {
        normalized.push({ ...normalized[normalized.length - 1], position: 1 });
    }
    return normalized;
}

function sampleGradient(stops, t, intensity) {
    if (stops.length === 1) {
        return hexToLinearColor(stops[0].color, intensity);
    }
    for (let index = 0; index < stops.length - 1; index += 1) {
        const current = stops[index];
        const next = stops[index + 1];
        if (t <= next.position || index === stops.length - 2) {
            const span = Math.max(0.000001, next.position - current.position);
            const alpha = Math.min(1, Math.max(0, (t - current.position) / span));
            const start = hexToLinearColor(current.color, intensity);
            const end = hexToLinearColor(next.color, intensity);
            return start.lerp(end, alpha);
        }
    }
    return hexToLinearColor(stops[stops.length - 1].color, intensity);
}

function finalizeTexture(texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

export function createSolidEnvironmentTexture(color = '#ffffff', intensity = 1) {
    const linear = hexToLinearColor(color, intensity);
    const data = new Float32Array(4 * 2 * 2);
    for (let index = 0; index < 4; index += 1) {
        const offset = index * 4;
        data[offset + 0] = linear.r;
        data[offset + 1] = linear.g;
        data[offset + 2] = linear.b;
        data[offset + 3] = 1;
    }
    const texture = new THREE.DataTexture(data, 2, 2, THREE.RGBAFormat, THREE.FloatType);
    return finalizeTexture(texture);
}

export function createGradientEnvironmentTexture(stops = [], intensity = 1, width = 256, height = 128) {
    const orderedStops = sortStops(stops);
    const data = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        const t = 1 - (y / Math.max(1, height - 1));
        const color = sampleGradient(orderedStops, t, intensity);
        for (let x = 0; x < width; x += 1) {
            const offset = ((y * width) + x) * 4;
            data[offset + 0] = color.r;
            data[offset + 1] = color.g;
            data[offset + 2] = color.b;
            data[offset + 3] = 1;
        }
    }
    const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat, THREE.FloatType);
    return finalizeTexture(texture);
}
