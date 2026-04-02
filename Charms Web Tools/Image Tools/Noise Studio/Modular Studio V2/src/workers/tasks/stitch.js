import { analyzePreparedStitchInputs } from '../../stitch/analysis.js';
import { createStitchInputId } from '../../stitch/document.js';
import { blobToDataUrl } from '../../utils/dataUrl.js';
import { readImageMetadata } from '../../utils/workerImage.js';

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
    async 'prepare-input-files'(payload = {}, context) {
        const sourceFiles = (payload.files || []).filter((file) => isLikelyImageFile(file));
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
