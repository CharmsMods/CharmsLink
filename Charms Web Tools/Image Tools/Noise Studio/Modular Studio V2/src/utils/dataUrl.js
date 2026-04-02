function ensureMimeType(mimeType) {
    return String(mimeType || '').trim() || 'application/octet-stream';
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
    const response = await fetch(String(dataUrl || ''));
    if (!response.ok) {
        throw new Error(`Could not decode data URL (${response.status}).`);
    }
    return response.blob();
}
