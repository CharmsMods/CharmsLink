function getDesktopBridge() {
    return globalThis.window?.desktopBridge || null;
}

export function getLocalSaveCapabilities() {
    const bridge = getDesktopBridge();
    return {
        isElectron: !!bridge?.isElectron,
        desktopBridge: !!bridge?.saveFile,
        browserDownload: !!globalThis.document
    };
}

function normalizeFileName(name, fallback = 'download') {
    const safe = String(name || fallback)
        .trim()
        .replace(/[<>:"/\\|?*]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '');
    return safe || fallback;
}

function normalizeSaveResult(result, fallbackName, fallbackSource) {
    if (!result || typeof result !== 'object') {
        return {
            status: 'failed',
            source: fallbackSource,
            fileName: fallbackName,
            error: 'The save operation returned an invalid result.'
        };
    }
    return {
        status: result.status || 'failed',
        source: result.source || fallbackSource,
        fileName: result.fileName || fallbackName,
        filePath: result.filePath || '',
        error: result.error || ''
    };
}

export async function saveBlobLocally(blob, filename, options = {}) {
    const safeName = normalizeFileName(filename, options.fallbackName || 'download');
    const bridge = options.preferDesktop === false ? null : getDesktopBridge();

    if (bridge?.saveFile) {
        try {
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const result = await bridge.saveFile({
                title: options.title || 'Save File',
                buttonLabel: options.buttonLabel || 'Save',
                suggestedName: safeName,
                filters: options.filters || [],
                data: bytes
            });
            return normalizeSaveResult(result, safeName, 'desktop-bridge');
        } catch (error) {
            return {
                status: 'failed',
                source: 'desktop-bridge',
                fileName: safeName,
                error: error?.message || 'Could not save that file.'
            };
        }
    }

    if (!globalThis.document) {
        return {
            status: 'failed',
            source: 'unavailable',
            fileName: safeName,
            error: 'Local file saving is not available in this environment.'
        };
    }

    const url = URL.createObjectURL(blob);
    try {
        const link = document.createElement('a');
        link.href = url;
        link.download = safeName;
        link.click();
        return {
            status: 'saved',
            source: 'browser-download',
            fileName: safeName,
            filePath: ''
        };
    } catch (error) {
        return {
            status: 'failed',
            source: 'browser-download',
            fileName: safeName,
            error: error?.message || 'Could not start that download.'
        };
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
}

export async function saveTextLocally(text, filename, options = {}) {
    const blob = new Blob([String(text ?? '')], {
        type: options.mimeType || 'text/plain;charset=utf-8'
    });
    return saveBlobLocally(blob, filename, options);
}

export async function saveJsonLocally(payload, filename, options = {}) {
    const pretty = options.pretty !== false;
    const spaces = pretty ? Math.max(0, Number(options.spaces ?? 2) || 2) : 0;
    const text = JSON.stringify(payload, null, spaces);
    return saveTextLocally(text, filename, {
        ...options,
        mimeType: 'application/json;charset=utf-8'
    });
}

export async function saveDataUrlLocally(dataUrl, filename, options = {}) {
    const response = await fetch(String(dataUrl || ''));
    const blob = await response.blob();
    return saveBlobLocally(blob, filename, {
        ...options,
        filters: options.filters || []
    });
}

export function didSaveFile(result) {
    return result?.status === 'saved';
}

export function wasSaveCancelled(result) {
    return result?.status === 'cancelled';
}
