function ensureMimeType(mimeType) {
    return String(mimeType || '').trim() || 'application/octet-stream';
}

function parseDataUrl(dataUrl) {
    const source = String(dataUrl || '');
    if (!source.startsWith('data:')) return null;
    const commaIndex = source.indexOf(',');
    if (commaIndex < 0) {
        throw new Error('Invalid data URL.');
    }
    const meta = source.slice(5, commaIndex);
    const payload = source.slice(commaIndex + 1);
    const parts = meta.split(';').filter(Boolean);
    const isBase64 = parts.some((part) => part.toLowerCase() === 'base64');
    const mimeType = ensureMimeType(parts.find((part) => part.toLowerCase() !== 'base64') || 'application/octet-stream');
    return {
        mimeType,
        isBase64,
        payload
    };
}

function base64ToUint8Array(base64) {
    const normalized = String(base64 || '').replace(/\s+/g, '');
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function decodeDataUrlBytes(parsed) {
    if (parsed.isBase64) {
        return base64ToUint8Array(parsed.payload);
    }
    const decoded = parsed.payload.includes('%')
        ? decodeURIComponent(parsed.payload)
        : parsed.payload;
    return new TextEncoder().encode(decoded);
}

export function bytesToHex(bytes) {
    return Array.from(bytes || [], (value) => value.toString(16).padStart(2, '0')).join('');
}

export function sampleHashString(text) {
    const source = String(text || '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
        hash ^= source.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

export function arrayBufferToBase64(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || 0);
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
        const chunk = bytes.subarray(index, index + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export function arrayBufferToDataUrl(buffer, mimeType = 'application/octet-stream') {
    return `data:${ensureMimeType(mimeType)};base64,${arrayBufferToBase64(buffer)}`;
}

export async function blobToDataUrl(blob) {
    const source = blob || new Blob([]);
    const buffer = await source.arrayBuffer();
    return arrayBufferToDataUrl(buffer, source.type || 'application/octet-stream');
}

export async function fileToDataUrl(file) {
    return blobToDataUrl(file);
}

export async function dataUrlToBlob(dataUrl) {
    const parsed = parseDataUrl(dataUrl);
    if (parsed) {
        return new Blob([decodeDataUrlBytes(parsed)], { type: parsed.mimeType });
    }
    const response = await fetch(String(dataUrl || ''));
    if (!response.ok) {
        throw new Error(`Could not decode data URL (${response.status}).`);
    }
    return response.blob();
}

export async function dataUrlToArrayBuffer(dataUrl) {
    return (await dataUrlToBlob(dataUrl)).arrayBuffer();
}

export async function dataUrlToText(dataUrl) {
    return (await dataUrlToBlob(dataUrl)).text();
}
