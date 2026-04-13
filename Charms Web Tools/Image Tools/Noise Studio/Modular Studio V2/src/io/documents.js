import { saveJsonLocally } from './localSave.js';
import { normalizeEditorBase, normalizeEditorSource } from '../editor/baseCanvas.js';
import { isDngSource, stripDngSourceRawPayload } from '../editor/dngDevelopShared.js';

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
    includeRawDng = true,
    preview = null
} = {}) {
    const normalizedSource = normalizeEditorSource(state.source);
    const serializedSource = includeSource
        ? (isDngSource(normalizedSource) && includeRawDng === false
            ? stripDngSourceRawPayload(normalizedSource)
            : normalizedSource)
        : null;
    const payload = {
        version: 'mns/v2',
        kind: 'document',
        mode: 'studio',
        workspace: state.workspace,
        source: includeSource && (normalizedSource.imageData || normalizedSource.rawData) ? serializedSource : null,
        base: normalizeEditorBase(state.base, normalizedSource),
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
        includeRawDng: options.includeRawDng !== false,
        preview: options.preview || null
    });
}

export function serializeState(state, options = {}) {
    const normalizedOptions = typeof options === 'boolean'
        ? { includeSource: options }
        : (options || {});
    return buildStudioPayload(state, {
        includeSource: normalizedOptions.includeSource !== false,
        includeRawDng: normalizedOptions.includeRawDng !== false,
        preview: normalizedOptions.preview || null
    });
}

export async function downloadPreset(state) {
    return saveJsonLocally(serializePreset(state), 'noise-studio-preset.mns.json', {
        filters: [{ name: 'Noise Studio Preset', extensions: ['json'] }]
    });
}

export async function downloadDocument(state, options = {}) {
    return saveJsonLocally(serializeDocument(state, options), 'noise-studio-document.mns.json', {
        filters: [{ name: 'Noise Studio Document', extensions: ['json'] }]
    });
}

export async function downloadState(state, options = {}) {
    return saveJsonLocally(serializeState(state, options), 'noise-studio-state.mns.json', {
        filters: [{ name: 'Noise Studio State', extensions: ['json'] }]
    });
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
