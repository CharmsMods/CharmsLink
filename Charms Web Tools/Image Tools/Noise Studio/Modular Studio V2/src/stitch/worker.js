import { analyzePreparedStitchInputs } from './analysis.js';

self.addEventListener('message', (event) => {
    const { requestId, document, preparedInputs } = event.data || {};
    try {
        const result = analyzePreparedStitchInputs(document, preparedInputs);
        self.postMessage({ requestId, result });
    } catch (error) {
        self.postMessage({ requestId, error: error?.message || 'Stitch analysis failed.' });
    }
});
