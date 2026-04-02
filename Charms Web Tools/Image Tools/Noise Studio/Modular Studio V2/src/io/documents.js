function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
}

function normalizeStudioPreview(preview) {
    if (!preview || typeof preview !== 'object' || !preview.imageData) {
        return null;
    }
    return {
        imageData: String(preview.imageData || ''),
        width: Math.max(0, Number(preview.width) || 0),
        height: Math.max(0, Number(preview.height) || 0),
        updatedAt: Math.max(0, Number(preview.updatedAt) || 0)
    };
}

function buildStudioPayload(state, {
    includeSource = true,
    preview = null
} = {}) {
    const payload = {
        version: 'mns/v2',
        kind: 'document',
        mode: 'studio',
        workspace: state.workspace,
        source: includeSource && state.source?.imageData ? state.source : null,
        palette: state.palette,
        layerStack: state.layerStack,
        selection: state.selection,
        view: state.view,
        export: state.export
    };
    const normalizedPreview = normalizeStudioPreview(preview);
    if (normalizedPreview) {
        payload.preview = normalizedPreview;
    }
    return payload;
}

export function serializePreset(state) {
    return {
        version: 'mns/v2',
        kind: 'preset',
        mode: state.mode,
        workspace: state.workspace,
        palette: state.palette,
        layerStack: state.layerStack,
        selection: state.selection,
        view: state.view,
        export: state.export
    };
}

export function serializeDocument(state, options = {}) {
    return buildStudioPayload({
        ...state,
        mode: 'studio'
    }, {
        includeSource: true,
        preview: options.preview || null
    });
}

export function serializeState(state, options = {}) {
    const normalizedOptions = typeof options === 'boolean'
        ? { includeSource: options }
        : (options || {});
    return buildStudioPayload(state, {
        includeSource: normalizedOptions.includeSource !== false,
        preview: normalizedOptions.preview || null
    });
}

export function downloadPreset(state) {
    const blob = new Blob([JSON.stringify(serializePreset(state), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'noise-studio-preset.mns.json');
}

export function downloadDocument(state, options = {}) {
    const blob = new Blob([JSON.stringify(serializeDocument(state, options), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'noise-studio-document.mns.json');
}

export function downloadState(state, options = {}) {
    const blob = new Blob([JSON.stringify(serializeState(state, options), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'noise-studio-state.mns.json');
}

export function readJsonFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            try {
                resolve(JSON.parse(String(reader.result)));
            } catch (error) {
                reject(error);
            }
        };
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

export function validateImportPayload(payload, expectedKind) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('The selected file is not a valid Modular Studio state file.');
    }
    if (payload.version !== 'mns/v2') {
        throw new Error('Unsupported file version. Only mns/v2 state files are supported.');
    }
    if (payload.kind !== expectedKind) {
        throw new Error(`Expected a ${expectedKind} state file, received '${payload.kind || 'unknown'}'.`);
    }
    return payload;
}
