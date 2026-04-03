import { analyzePreparedStitchInputs } from '../../stitch/analysis.js';
import { classifyPreparedInputs } from '../../stitch/classifier.js';
import { createStitchInputId } from '../../stitch/document.js';
import { normalizeStitchDocument } from '../../stitch/document.js';
import { StitchEngine } from '../../stitch/engine.js';
import { blobToDataUrl } from '../../utils/dataUrl.js';
import { readImageMetadata } from '../../utils/workerImage.js';
import { reviveWorkerFileEntries } from '../filePayload.js';

const workerStitchEngine = new StitchEngine();

function isLikelyImageFile(file) {
    const mimeType = String(file?.type || '').toLowerCase();
    if (mimeType.startsWith('image/')) return true;
    return /\.(png|apng|jpe?g|webp|gif|bmp|tiff?|avif|ico|svg)$/i.test(String(file?.name || ''));
}

export const stitchTaskHandlers = {
    async 'analyze-screenshot'(payload = {}, context) {
        context.assertNotCancelled();
        context.log('info', 'Running screenshot Stitch analysis in the shared worker runtime.');
        return analyzePreparedStitchInputs(payload.document, payload.preparedInputs);
    },
    async 'prepare-analysis-inputs'(payload = {}, context) {
        context.assertNotCancelled();
        const normalized = normalizeStitchDocument(payload.document);
        context.log('info', `Preparing ${normalized.inputs.length} Stitch analysis input${normalized.inputs.length === 1 ? '' : 's'} in the shared worker runtime.`);
        context.progress(0.08, `Decoding ${normalized.inputs.length} Stitch image${normalized.inputs.length === 1 ? '' : 's'}...`, {
            phase: 'prepare-inputs',
            completed: 0,
            total: normalized.inputs.length
        });
        const preparedInputs = await workerStitchEngine.buildPreparedInputs(normalized);
        context.assertNotCancelled();
        context.progress(0.92, `Prepared ${preparedInputs.length} Stitch analysis input${preparedInputs.length === 1 ? '' : 's'}.`, {
            phase: 'prepare-inputs',
            completed: preparedInputs.length,
            total: preparedInputs.length
        });
        return {
            payload: preparedInputs,
            transfer: preparedInputs
                .map((preparedInput) => preparedInput?.gray?.buffer)
                .filter((buffer) => buffer instanceof ArrayBuffer)
        };
    },
    async 'classify-scene-mode'(payload = {}, context) {
        context.assertNotCancelled();
        const preparedInputs = Array.isArray(payload.preparedInputs) ? payload.preparedInputs : [];
        const classification = classifyPreparedInputs(preparedInputs);
        const summary = classification.sceneMode === 'photo'
            ? 'Auto mode selected the photo backend.'
            : 'Auto mode selected the screenshot backend.';
        context.log('info', summary, classification.diagnostics?.[0] || null);
        return classification;
    },
    async 'build-candidate-previews'(payload = {}, context) {
        context.assertNotCancelled();
        const normalized = normalizeStitchDocument(payload.document);
        const candidates = Array.isArray(normalized.candidates) ? normalized.candidates : [];
        context.log('info', `Building ${candidates.length} Stitch candidate preview${candidates.length === 1 ? '' : 's'} in the shared worker runtime.`);
        const previews = {};
        for (let index = 0; index < candidates.length; index += 1) {
            context.assertNotCancelled();
            const candidate = candidates[index];
            context.progress(
                candidates.length ? index / candidates.length : 0,
                `Rendering preview ${index + 1} of ${candidates.length} for "${candidate.name || `Candidate ${index + 1}`}".`,
                {
                    phase: 'candidate-preview',
                    completed: index,
                    total: candidates.length,
                    candidateId: candidate.id || ''
                }
            );
            previews[candidate.id] = await workerStitchEngine.buildCandidatePreview(normalized, candidate);
        }
        context.progress(1, `Rendered ${candidates.length} Stitch candidate preview${candidates.length === 1 ? '' : 's'}.`, {
            phase: 'candidate-preview',
            completed: candidates.length,
            total: candidates.length
        });
        return previews;
    },
    async 'prepare-input-files'(payload = {}, context) {
        const sourceFiles = reviveWorkerFileEntries(payload.fileEntries, payload.files)
            .filter((file) => isLikelyImageFile(file));
        const inputs = [];
        const failures = [];

        for (let index = 0; index < sourceFiles.length; index += 1) {
            context.assertNotCancelled();
            const file = sourceFiles[index];
            try {
                context.progress(
                    sourceFiles.length ? index / sourceFiles.length : 0,
                    `Reading "${file.name}" for Stitch.`,
                    {
                        index,
                        total: sourceFiles.length,
                        file: { name: file.name, type: file.type },
                        progress: sourceFiles.length ? index / sourceFiles.length : 0
                    }
                );
                const [imageData, metadata] = await Promise.all([
                    blobToDataUrl(file),
                    readImageMetadata(file)
                ]);
                context.progress(
                    sourceFiles.length ? (index + 0.75) / sourceFiles.length : 0.75,
                    `Prepared "${file.name}" for Stitch.`,
                    {
                        index,
                        total: sourceFiles.length,
                        file: { name: file.name, type: file.type },
                        progress: sourceFiles.length ? (index + 0.75) / sourceFiles.length : 0.75
                    }
                );
                inputs.push({
                    id: createStitchInputId(),
                    name: file.name,
                    type: file.type,
                    imageData,
                    width: metadata.width,
                    height: metadata.height
                });
            } catch (error) {
                failures.push({
                    name: String(file?.name || 'Unnamed image'),
                    reason: error?.message || 'Could not read this image.'
                });
            }
        }

        return { inputs, failures };
    }
};
