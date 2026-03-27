function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
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

export function serializeDocument(state) {
    return {
        version: 'mns/v2',
        kind: 'document',
        mode: state.mode,
        workspace: state.workspace,
        source: state.source,
        palette: state.palette,
        layerStack: state.layerStack,
        selection: state.selection,
        view: state.view,
        export: state.export
    };
}

export function serializeState(state, includeImage = false) {
    return {
        version: 'mns/v2',
        kind: 'document',
        mode: 'studio',
        workspace: state.workspace,
        source: includeImage && state.source?.imageData ? state.source : null,
        palette: state.palette,
        layerStack: state.layerStack,
        selection: state.selection,
        view: state.view,
        export: state.export
    };
}

export function downloadPreset(state) {
    const blob = new Blob([JSON.stringify(serializePreset(state), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'noise-studio-preset.mns.json');
}

export function downloadDocument(state) {
    const blob = new Blob([JSON.stringify(serializeDocument(state), null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'noise-studio-document.mns.json');
}

export function downloadState(state, includeImage = false) {
    const blob = new Blob([JSON.stringify(serializeState(state, includeImage), null, 2)], { type: 'application/json' });
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
