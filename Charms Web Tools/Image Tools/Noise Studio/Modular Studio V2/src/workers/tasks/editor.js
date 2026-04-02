import { validateImportPayload } from '../../io/documents.js';

function normalizeLegacyDocumentPayload(payload) {
    if (!payload || typeof payload !== 'object') return payload;
    if (payload.version === 2 || payload.version === '2') {
        return {
            mode: payload.mode || 'studio',
            ...payload,
            version: 'mns/v2',
            kind: payload.kind || 'document'
        };
    }
    return payload;
}

export const editorTaskHandlers = {
    async 'read-studio-state-file'(payload = {}, context) {
        context.assertNotCancelled();
        const file = payload.file;
        if (!(file instanceof File)) {
            throw new Error('No Studio state file was provided.');
        }
        context.log('info', `Parsing "${file.name}" in the background.`);
        const text = await file.text();
        context.assertNotCancelled();
        const parsed = JSON.parse(text);
        const normalized = normalizeLegacyDocumentPayload(parsed);
        return {
            payload: validateImportPayload(normalized, 'document')
        };
    }
};
