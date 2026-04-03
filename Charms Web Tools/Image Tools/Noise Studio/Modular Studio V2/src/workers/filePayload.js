function isBlobLike(value) {
    return typeof Blob === 'function' && value instanceof Blob;
}

function normalizeArrayBuffer(buffer) {
    if (buffer instanceof ArrayBuffer) return buffer;
    if (ArrayBuffer.isView(buffer)) {
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    }
    return new ArrayBuffer(0);
}

function defineBlobMetadata(target, name, lastModified) {
    try {
        Object.defineProperty(target, 'name', {
            configurable: true,
            enumerable: true,
            value: name
        });
        Object.defineProperty(target, 'lastModified', {
            configurable: true,
            enumerable: true,
            value: lastModified
        });
    } catch (_error) {
        target.name = name;
        target.lastModified = lastModified;
    }
}

export async function createWorkerFileEntry(file, options = {}) {
    if (!isBlobLike(file)) {
        throw new Error('A Blob or File is required to build a worker file payload.');
    }
    options.assertNotCancelled?.();
    const buffer = await file.arrayBuffer();
    options.assertNotCancelled?.();
    return {
        name: String(file?.name || ''),
        type: String(file?.type || ''),
        size: Math.max(0, Number(file?.size) || buffer.byteLength || 0),
        lastModified: Math.max(0, Number(file?.lastModified) || 0),
        buffer
    };
}

export async function createWorkerFileEntries(files = [], options = {}) {
    const fileEntries = [];
    const transfer = [];
    for (const file of files || []) {
        if (!isBlobLike(file)) continue;
        options.assertNotCancelled?.();
        const fileEntry = await createWorkerFileEntry(file, options);
        options.assertNotCancelled?.();
        fileEntries.push(fileEntry);
        transfer.push(fileEntry.buffer);
    }
    return { fileEntries, transfer };
}

export async function createWorkerSingleFileEntry(file, options = {}) {
    if (!isBlobLike(file)) {
        return {
            fileEntry: null,
            transfer: []
        };
    }
    const fileEntry = await createWorkerFileEntry(file, options);
    return {
        fileEntry,
        transfer: [fileEntry.buffer]
    };
}

export function reviveWorkerFileEntry(fileEntry) {
    if (!fileEntry || typeof fileEntry !== 'object') return null;
    const buffer = normalizeArrayBuffer(fileEntry.buffer);
    const name = String(fileEntry.name || 'file');
    const type = String(fileEntry.type || '');
    const lastModified = Math.max(0, Number(fileEntry.lastModified) || 0);
    if (typeof File === 'function') {
        return new File([buffer], name, {
            type,
            lastModified
        });
    }
    const blob = new Blob([buffer], {
        type: type || 'application/octet-stream'
    });
    defineBlobMetadata(blob, name, lastModified);
    return blob;
}

export function reviveWorkerFileEntries(fileEntries = [], fallbackFiles = []) {
    if (Array.isArray(fileEntries) && fileEntries.length) {
        return fileEntries.map((entry) => reviveWorkerFileEntry(entry)).filter(Boolean);
    }
    return Array.isArray(fallbackFiles)
        ? fallbackFiles.filter((file) => isBlobLike(file))
        : [];
}

export function reviveWorkerSingleFile(fileEntry, fallbackFile = null) {
    return reviveWorkerFileEntry(fileEntry) || (isBlobLike(fallbackFile) ? fallbackFile : null);
}
