export const LIBRARY_EXPORT_TYPE = 'noise-studio-library';
export const LIBRARY_EXPORT_FORMAT = 'library-json/v2';
export const LEGACY_LIBRARY_EXPORT_FORMAT = 'library-json/v1';
export const LIBRARY_SECURE_EXPORT_FORMAT = 'library-secure-json/v1';
export const LIBRARY_ASSET_FOLDER_FORMAT = 'library-assets-folder/v1';
export const LIBRARY_SECURE_KDF_ITERATIONS = 250000;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function bytesToBase64Js(bytes) {
    let binary = '';
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
}

export function base64ToBytesJs(base64) {
    const binary = atob(String(base64 || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

export function bytesToBase64(bytes, codec = null) {
    if (codec?.encodeBytesToBase64) {
        return codec.encodeBytesToBase64(bytes);
    }
    return bytesToBase64Js(bytes);
}

export function base64ToBytes(base64, codec = null) {
    if (codec?.decodeBase64ToBytes) {
        return codec.decodeBase64ToBytes(base64);
    }
    return base64ToBytesJs(base64);
}

export async function gzipText(text) {
    if (typeof CompressionStream !== 'function') {
        throw new Error('This browser does not support compressed Library exports yet.');
    }
    const stream = new Blob([text], { type: 'application/json' })
        .stream()
        .pipeThrough(new CompressionStream('gzip'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

export async function gunzipText(bytes) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('This browser does not support compressed Library imports yet.');
    }
    const stream = new Blob([bytes], { type: 'application/gzip' })
        .stream()
        .pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).text();
}

export async function deriveLibraryKey(passphrase, salt, iterations = LIBRARY_SECURE_KDF_ITERATIONS) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        textEncoder.encode(String(passphrase || '')),
        'PBKDF2',
        false,
        ['deriveKey']
    );
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt,
            iterations,
            hash: 'SHA-256'
        },
        keyMaterial,
        {
            name: 'AES-GCM',
            length: 256
        },
        false,
        ['encrypt', 'decrypt']
    );
}

export async function encryptLibraryBytes(bytes, passphrase, iterations = LIBRARY_SECURE_KDF_ITERATIONS, codec = null) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveLibraryKey(passphrase, salt, iterations);
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes);
    return {
        salt: bytesToBase64(salt, codec),
        iv: bytesToBase64(iv, codec),
        data: bytesToBase64(new Uint8Array(encrypted), codec)
    };
}

export async function decryptLibraryBytes(copy, passphrase, iterations = LIBRARY_SECURE_KDF_ITERATIONS, codec = null) {
    const salt = base64ToBytes(copy?.salt || '', codec);
    const iv = base64ToBytes(copy?.iv || '', codec);
    const data = base64ToBytes(copy?.data || '', codec);
    const key = await deriveLibraryKey(passphrase, salt, iterations);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return new Uint8Array(decrypted);
}

export async function buildSecureLibraryExportRecord(bundle, { secureMode, passphrase = '', duplicateCopies = false, codec = null } = {}) {
    const bundleText = JSON.stringify(bundle);
    const compressed = await gzipText(bundleText);
    if (secureMode === 'compressed') {
        return {
            type: LIBRARY_EXPORT_TYPE,
            format: LIBRARY_SECURE_EXPORT_FORMAT,
            version: 1,
            name: bundle.name,
            exportedAt: new Date().toISOString(),
            mode: 'compressed',
            payloadFormat: LIBRARY_EXPORT_FORMAT,
            compression: 'gzip',
            encoding: 'base64',
            payload: {
                data: bytesToBase64(compressed, codec)
            }
        };
    }

    if (!crypto?.subtle) {
        throw new Error('This browser does not support encrypted Library exports.');
    }

    const copyCount = duplicateCopies ? 2 : 1;
    const copies = [];
    for (let index = 0; index < copyCount; index += 1) {
        copies.push(await encryptLibraryBytes(compressed, passphrase, LIBRARY_SECURE_KDF_ITERATIONS, codec));
    }
    return {
        type: LIBRARY_EXPORT_TYPE,
        format: LIBRARY_SECURE_EXPORT_FORMAT,
        version: 1,
        name: bundle.name,
        exportedAt: new Date().toISOString(),
        mode: 'encrypted',
        payloadFormat: LIBRARY_EXPORT_FORMAT,
        compression: 'gzip',
        encoding: 'base64',
        duplicateCopies,
        encryption: {
            algorithm: 'AES-GCM',
            kdf: 'PBKDF2',
            hash: 'SHA-256',
            iterations: LIBRARY_SECURE_KDF_ITERATIONS
        },
        payload: { copies }
    };
}

export async function resolveSecureLibraryImportRecord(parsed, passphrase, { codec = null } = {}) {
    if (parsed?.mode === 'compressed') {
        const compressedText = await gunzipText(base64ToBytes(parsed?.payload?.data || '', codec));
        return {
            recoveredText: compressedText,
            failedCount: 0,
            copiesCount: 1,
            duplicateCopies: false
        };
    }

    if (parsed?.mode !== 'encrypted') {
        throw new Error('This secure Library format is not recognized.');
    }
    if (!crypto?.subtle) {
        throw new Error('This browser cannot decrypt secure Library files.');
    }

    const copies = Array.isArray(parsed?.payload?.copies) ? parsed.payload.copies : [];
    if (!copies.length) {
        throw new Error('This secure Library file does not contain any encrypted copies.');
    }

    const iterations = Number(parsed?.encryption?.iterations || LIBRARY_SECURE_KDF_ITERATIONS) || LIBRARY_SECURE_KDF_ITERATIONS;
    const successes = [];
    let failedCount = 0;

    for (const copy of copies) {
        try {
            const decompressedBytes = await decryptLibraryBytes(copy, passphrase, iterations, codec);
            const recoveredText = await gunzipText(decompressedBytes);
            successes.push(recoveredText);
        } catch (_error) {
            failedCount += 1;
        }
    }

    if (!successes.length) {
        throw new Error('Could not decrypt this secure Library file with that key.');
    }

    const recoveredText = successes[0];
    if (successes.some((entry) => entry !== recoveredText)) {
        throw new Error('This secure Library file contains mismatched encrypted copies and could not be trusted automatically.');
    }

    return {
        recoveredText,
        failedCount,
        copiesCount: copies.length,
        duplicateCopies: Boolean(parsed?.duplicateCopies || copies.length > 1)
    };
}

export function encodeTextUtf8(text) {
    return textEncoder.encode(String(text || ''));
}

export function decodeTextUtf8(bytes) {
    return textDecoder.decode(bytes);
}
