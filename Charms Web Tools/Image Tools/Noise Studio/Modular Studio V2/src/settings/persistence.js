import { SETTINGS_STORAGE_KEY } from './defaults.js';
import { normalizeAppSettings, stripDiagnosticsFromSettings } from './schema.js';

function canUseLocalStorage() {
    try {
        return !!globalThis.localStorage;
    } catch (_error) {
        return false;
    }
}

export function loadPersistedAppSettings(options = {}) {
    if (!canUseLocalStorage()) {
        return normalizeAppSettings({}, options);
    }
    try {
        const raw = globalThis.localStorage.getItem(SETTINGS_STORAGE_KEY);
        if (!raw) {
            return normalizeAppSettings({}, options);
        }
        const parsed = JSON.parse(raw);
        return normalizeAppSettings(parsed, options);
    } catch (_error) {
        return normalizeAppSettings({}, options);
    }
}

export function persistAppSettings(settings) {
    if (!canUseLocalStorage()) return false;
    try {
        globalThis.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(stripDiagnosticsFromSettings(settings)));
        return true;
    } catch (_error) {
        return false;
    }
}

export function clearPersistedAppSettings() {
    if (!canUseLocalStorage()) return false;
    try {
        globalThis.localStorage.removeItem(SETTINGS_STORAGE_KEY);
        return true;
    } catch (_error) {
        return false;
    }
}

export function buildSettingsExportPayload(settings, metadata = {}) {
    const normalized = stripDiagnosticsFromSettings(settings);
    return {
        kind: 'noise-studio-settings',
        version: normalized.version,
        exportedAt: new Date().toISOString(),
        exportedFrom: String(metadata.exportedFrom || 'Settings Tab'),
        settings: normalized
    };
}

export function parseImportedSettingsPayload(payload, options = {}) {
    const parsedPayload = typeof payload === 'string'
        ? JSON.parse(payload)
        : payload;
    if (!parsedPayload || typeof parsedPayload !== 'object') {
        throw new Error('That settings file is empty or invalid.');
    }
    const source = parsedPayload.settings && typeof parsedPayload.settings === 'object'
        ? parsedPayload.settings
        : parsedPayload.kind === 'noise-studio-settings'
            ? {}
            : parsedPayload;
    if (parsedPayload.kind === 'noise-studio-settings' && !parsedPayload.settings) {
        throw new Error('That settings export is missing its settings payload.');
    }
    return normalizeAppSettings(source, options);
}
