export const LIBRARY_EXPORT_TYPE = 'noise-studio-library';
export const LIBRARY_EXPORT_FORMAT = 'library-json/v2';
export const LEGACY_LIBRARY_EXPORT_FORMAT = 'library-json/v1';
export const LIBRARY_SECURE_EXPORT_FORMAT = 'library-secure-json/v1';
export const LIBRARY_ASSET_FOLDER_FORMAT = 'library-assets-folder/v1';
export const LIBRARY_SECURE_KDF_ITERATIONS = 250000;
export const SECURE_LIBRARY_COMPATIBILITY_ERROR_CODE = 'secure-library-compatibility';
export const SECURE_LIBRARY_FAST_PATH_JSON_THRESHOLD = 16 * 1024 * 1024;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = new Int16Array(123).fill(-1);
for (let index = 0; index < BASE64_ALPHABET.length; index += 1) {
    BASE64_LOOKUP[BASE64_ALPHABET.charCodeAt(index)] = index;
}
BASE64_LOOKUP['='.charCodeAt(0)] = 0;

function emitStage(onStage, stage, meta = {}) {
    if (typeof onStage !== 'function') return;
    onStage(stage, meta);
}

function trimProjectPayloadForSecureExport(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    const cloned = JSON.parse(JSON.stringify(payload));
    if (cloned.preview && typeof cloned.preview === 'object') {
        delete cloned.preview.imageData;
        delete cloned.preview.width;
        delete cloned.preview.height;
        delete cloned.preview.updatedAt;
        if (!Object.keys(cloned.preview).length) {
            delete cloned.preview;
        }
    }
    if (cloned._libraryHoverSource && typeof cloned._libraryHoverSource === 'object') {
        delete cloned._libraryHoverSource.imageData;
        delete cloned._libraryHoverSource.updatedAt;
        if (!Object.keys(cloned._libraryHoverSource).length) {
            delete cloned._libraryHoverSource;
        }
    }
    if (cloned.render && typeof cloned.render === 'object') {
        delete cloned.render.currentSamples;
    }
    delete cloned.renderJob;
    return cloned;
}

function trimAssetForSecureExport(asset) {
    if (!asset || typeof asset !== 'object') return asset;
    const cloned = {
        ...asset
    };
    delete cloned.previewDataUrl;
    return cloned;
}

export function trimSecureLibraryExportBundle(bundle = {}) {
    const normalized = bundle && typeof bundle === 'object'
        ? JSON.parse(JSON.stringify(bundle))
        : {};
    if (Array.isArray(normalized.projects)) {
        normalized.projects = normalized.projects.map((project) => ({
            ...project,
            payload: trimProjectPayloadForSecureExport(project?.payload)
        }));
    }
    if (Array.isArray(normalized.assets)) {
        normalized.assets = normalized.assets.map((asset) => trimAssetForSecureExport(asset));
    }
    return normalized;
}

export function prepareSecureLibraryExportBundle(bundle = {}) {
    const trimmedBundle = trimSecureLibraryExportBundle(bundle);
    const bundleText = JSON.stringify(trimmedBundle);
    return {
        bundle: trimmedBundle,
        bundleText,
        estimatedJsonBytes: encodeTextUtf8(bundleText).byteLength
    };
}

export function createSecureLibraryCompatibilityError(message, details = {}) {
    const error = new Error(String(message || 'The secure Library fast path is unavailable.'));
    error.code = SECURE_LIBRARY_COMPATIBILITY_ERROR_CODE;
    error.fallbackEligible = true;
    error.fallbackReason = String(details.fallbackReason || error.message || '').trim();
    error.compatibilityMode = details.compatibilityMode || 'js';
    error.stage = details.stage || '';
    error.runtime = details.runtime || null;
    error.meta = details.meta || null;
    return error;
}

export function isSecureLibraryCompatibilityError(error) {
    return error?.code === SECURE_LIBRARY_COMPATIBILITY_ERROR_CODE && !!error?.fallbackEligible;
}

export function bytesToBase64Js(bytes) {
    const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (!input.length) return '';
    const parts = [];
    const chunkBytes = 3 * 4096;
    for (let offset = 0; offset < input.length; offset += chunkBytes) {
        const end = Math.min(input.length, offset + chunkBytes);
        let chunk = '';
        for (let index = offset; index < end; index += 3) {
            const first = input[index];
            const second = index + 1 < end ? input[index + 1] : 0;
            const third = index + 2 < end ? input[index + 2] : 0;
            const combined = (first << 16) | (second << 8) | third;
            chunk += BASE64_ALPHABET[(combined >> 18) & 63];
            chunk += BASE64_ALPHABET[(combined >> 12) & 63];
            chunk += index + 1 < end ? BASE64_ALPHABET[(combined >> 6) & 63] : '=';
            chunk += index + 2 < end ? BASE64_ALPHABET[combined & 63] : '=';
        }
        parts.push(chunk);
    }
    return parts.join('');
}

export function base64ToBytesJs(base64) {
    const normalized = String(base64 || '').replace(/\s+/g, '');
    if (!normalized) return new Uint8Array();
    if (normalized.length % 4 !== 0) {
        throw new Error('The secure Library payload is not valid base64.');
    }
    const padding = normalized.endsWith('==')
        ? 2
        : normalized.endsWith('=')
            ? 1
            : 0;
    const output = new Uint8Array(((normalized.length / 4) * 3) - padding);
    let writeIndex = 0;
    for (let index = 0; index < normalized.length; index += 4) {
        const c0 = BASE64_LOOKUP[normalized.charCodeAt(index)] ?? -1;
        const c1 = BASE64_LOOKUP[normalized.charCodeAt(index + 1)] ?? -1;
        const c2 = BASE64_LOOKUP[normalized.charCodeAt(index + 2)] ?? -1;
        const c3 = BASE64_LOOKUP[normalized.charCodeAt(index + 3)] ?? -1;
        if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
            throw new Error('The secure Library payload is not valid base64.');
        }
        const combined = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
        output[writeIndex] = (combined >> 16) & 255;
        writeIndex += 1;
        if (normalized[index + 2] !== '=') {
            output[writeIndex] = (combined >> 8) & 255;
            writeIndex += 1;
        }
        if (normalized[index + 3] !== '=') {
            output[writeIndex] = combined & 255;
            writeIndex += 1;
        }
    }
    return output;
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
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveLibraryKey(passphrase, saltBytes, iterations);
    const encryptedBytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivBytes }, key, bytes));
    return {
        copy: {
            salt: bytesToBase64(saltBytes, codec),
            iv: bytesToBase64(ivBytes, codec),
            data: bytesToBase64(encryptedBytes, codec)
        },
        encryptedBytes
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

export async function buildSecureLibraryExportRecord(bundle, {
    secureMode,
    passphrase = '',
    duplicateCopies = false,
    codec = null,
    onStage = null,
    preparedBundle = null
} = {}) {
    const prepared = preparedBundle || prepareSecureLibraryExportBundle(bundle);
    emitStage(onStage, 'bundle-normalized', {
        projectCount: Array.isArray(prepared.bundle?.projects) ? prepared.bundle.projects.length : 0,
        assetCount: Array.isArray(prepared.bundle?.assets) ? prepared.bundle.assets.length : 0
    });
    emitStage(onStage, 'bundle-json-estimate', {
        estimatedJsonBytes: prepared.estimatedJsonBytes
    });
    const compressed = await gzipText(prepared.bundleText);
    emitStage(onStage, 'compressed', {
        compressedBytes: compressed.length
    });

    if (secureMode === 'compressed') {
        emitStage(onStage, 'base64-started', {
            sourceBytes: compressed.length
        });
        const base64Data = bytesToBase64(compressed, codec);
        emitStage(onStage, 'base64-completed', {
            base64Length: base64Data.length
        });
        const record = {
            type: LIBRARY_EXPORT_TYPE,
            format: LIBRARY_SECURE_EXPORT_FORMAT,
            version: 1,
            name: prepared.bundle.name,
            exportedAt: new Date().toISOString(),
            mode: 'compressed',
            payloadFormat: LIBRARY_EXPORT_FORMAT,
            compression: 'gzip',
            encoding: 'base64',
            payload: {
                data: base64Data
            }
        };
        return {
            record,
            serializedText: JSON.stringify(record),
            meta: {
                mode: 'compressed',
                estimatedJsonBytes: prepared.estimatedJsonBytes,
                compressedBytes: compressed.length,
                base64Length: base64Data.length,
                copiesCount: 1,
                duplicateCopies: false
            }
        };
    }

    if (!crypto?.subtle) {
        throw new Error('This browser does not support encrypted Library exports.');
    }

    const copyCount = duplicateCopies ? 2 : 1;
    const copies = [];
    let encryptedBytesTotal = 0;
    for (let index = 0; index < copyCount; index += 1) {
        emitStage(onStage, 'encrypted-started', {
            copyIndex: index + 1,
            copyCount
        });
        const encrypted = await encryptLibraryBytes(compressed, passphrase, LIBRARY_SECURE_KDF_ITERATIONS, codec);
        encryptedBytesTotal += encrypted.encryptedBytes.length;
        copies.push(encrypted.copy);
        emitStage(onStage, 'encrypted-completed', {
            copyIndex: index + 1,
            copyCount,
            encryptedBytes: encrypted.encryptedBytes.length,
            base64Length: encrypted.copy.data.length
        });
    }
    const record = {
        type: LIBRARY_EXPORT_TYPE,
        format: LIBRARY_SECURE_EXPORT_FORMAT,
        version: 1,
        name: prepared.bundle.name,
        exportedAt: new Date().toISOString(),
        mode: 'encrypted',
        payloadFormat: LIBRARY_EXPORT_FORMAT,
        compression: 'gzip',
        encoding: 'base64',
        duplicateCopies: false,
        encryption: {
            algorithm: 'AES-GCM',
            kdf: 'PBKDF2',
            hash: 'SHA-256',
            iterations: LIBRARY_SECURE_KDF_ITERATIONS
        },
        payload: { copies }
    };
    return {
        record,
        serializedText: JSON.stringify(record),
        meta: {
            mode: 'encrypted',
            estimatedJsonBytes: prepared.estimatedJsonBytes,
            compressedBytes: compressed.length,
            encryptedBytes: encryptedBytesTotal,
            copiesCount: copies.length,
            duplicateCopies: false
        }
    };
}

export async function resolveSecureLibraryImportRecord(parsed, passphrase, { codec = null, onStage = null } = {}) {
    if (parsed?.mode === 'compressed') {
        emitStage(onStage, 'base64-started', {
            encodedLength: String(parsed?.payload?.data || '').length
        });
        const decoded = base64ToBytes(parsed?.payload?.data || '', codec);
        emitStage(onStage, 'base64-completed', {
            decodedBytes: decoded.length
        });
        const compressedText = await gunzipText(decoded);
        emitStage(onStage, 'decompressed', {
            recoveredJsonBytes: encodeTextUtf8(compressedText).byteLength
        });
        return {
            recoveredText: compressedText,
            failedCount: 0,
            copiesCount: 1,
            duplicateCopies: false,
            meta: {
                mode: 'compressed',
                decodedBytes: decoded.length,
                recoveredJsonBytes: encodeTextUtf8(compressedText).byteLength
            }
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
    let decodedBytesTotal = 0;
    let decryptedBytesTotal = 0;

    for (let index = 0; index < copies.length; index += 1) {
        const copy = copies[index];
        emitStage(onStage, 'copy-decrypt-started', {
            copyIndex: index + 1,
            copyCount: copies.length
        });
        try {
            const decodedData = base64ToBytes(copy?.data || '', codec);
            decodedBytesTotal += decodedData.length;
            const decompressedBytes = await decryptLibraryBytes(copy, passphrase, iterations, codec);
            decryptedBytesTotal += decompressedBytes.length;
            const recoveredText = await gunzipText(decompressedBytes);
            emitStage(onStage, 'copy-decrypt-completed', {
                copyIndex: index + 1,
                copyCount: copies.length,
                decodedBytes: decodedData.length,
                decryptedBytes: decompressedBytes.length
            });
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
        duplicateCopies: Boolean(parsed?.duplicateCopies || copies.length > 1),
        meta: {
            mode: 'encrypted',
            decodedBytes: decodedBytesTotal,
            decryptedBytes: decryptedBytesTotal,
            recoveredJsonBytes: encodeTextUtf8(recoveredText).byteLength
        }
    };
}

export function encodeTextUtf8(text) {
    return textEncoder.encode(String(text || ''));
}

export function decodeTextUtf8(bytes) {
    return textDecoder.decode(bytes);
}
