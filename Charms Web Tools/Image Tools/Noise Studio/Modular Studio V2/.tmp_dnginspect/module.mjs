import './UTIF.mjs';

function readNumericTag(ifd, key, fallback = 0) {
    const value = ifd?.[key];
    if (Array.isArray(value)) {
        return Number(value[0] || fallback) || fallback;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

function scoreIfd(ifd, probe = {}) {
    let score = 0;
    if (readNumericTag(ifd, 't259', 0) === Number(probe.compression || 0)) score += 20;
    if (readNumericTag(ifd, 't262', 0) === Number(probe.photometric || 0)) score += 12;
    if (readNumericTag(ifd, 'width', 0) === Number(probe.width || 0)) score += 8;
    if (readNumericTag(ifd, 'height', 0) === Number(probe.height || 0)) score += 8;
    if (readNumericTag(ifd, 't277', 0) === Number(probe.samplesPerPixel || 0)) score += 4;
    if (readNumericTag(ifd, 't258', 0) === Number(probe.bitsPerSample || 0)) score += 4;
    return score;
}

function chooseIfd(ifds = [], probe = {}) {
    return [...ifds].sort((left, right) => scoreIfd(right, probe) - scoreIfd(left, probe))[0] || null;
}

function ensureUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    }
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array();
}

export function decodeUtifJpegDng(buffer, probe = {}) {
    const UTIF = globalThis.UTIF;
    if (!UTIF?.decode || !UTIF?.decodeImage) {
        throw new Error('UTIF runtime is unavailable for JPEG-compressed DNG decode.');
    }
    const ifds = UTIF.decode(buffer);
    const targetIfd = chooseIfd(ifds, probe);
    if (!targetIfd) {
        throw new Error('Could not find a matching JPEG-compressed DNG image in the UTIF decode path.');
    }
    UTIF.decodeImage(buffer, targetIfd);
    return {
        width: readNumericTag(targetIfd, 'width', readNumericTag(targetIfd, 't256', 0)),
        height: readNumericTag(targetIfd, 'height', readNumericTag(targetIfd, 't257', 0)),
        bitsPerSample: readNumericTag(targetIfd, 't258', 0),
        samplesPerPixel: readNumericTag(targetIfd, 't277', 1),
        compression: readNumericTag(targetIfd, 't259', 0),
        data: ensureUint8Array(targetIfd.data)
    };
}

