self.__STITCH_OPENCV_STANDALONE__ = false;

const WORKER_MESSAGE_TYPES = {
    INIT: 'init',
    RUN: 'run',
    CANCEL: 'cancel'
};

const WORKER_EVENT_TYPES = {
    READY: 'ready',
    PROGRESS: 'progress',
    LOG: 'log',
    RESULT: 'result',
    ERROR: 'error',
    CANCELLED: 'cancelled'
};

const DOMAIN = 'stitch-opencv';
const cancelled = new Set();
let capabilities = {};
let runtime = null;
let runtimeBootstrapError = null;
let runtimeAnnouncement = '';

function normalizeProgress(value, payload) {
    const explicit = Number(value);
    if (Number.isFinite(explicit)) {
        return Math.max(0, Math.min(1, explicit));
    }
    const completed = Number(payload?.completed);
    const total = Number(payload?.total);
    if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
        return Math.max(0, Math.min(1, completed / total));
    }
    return null;
}

function post(type, payload) {
    self.postMessage({
        type,
        domain: DOMAIN,
        ...payload
    });
}

function postLog(request, level, message, payload = null, processIdOverride = null) {
    post(WORKER_EVENT_TYPES.LOG, {
        id: request.id,
        task: request.task,
        processId: processIdOverride || request.processId || null,
        level,
        message: String(message || ''),
        payload
    });
}

function postProgress(request, message, payload = null, progress = null) {
    post(WORKER_EVENT_TYPES.PROGRESS, {
        id: request.id,
        task: request.task,
        processId: request.processId || null,
        progress: normalizeProgress(progress, payload),
        message: String(message || ''),
        payload
    });
}

function createAvailabilitySummary(summary = {}, fallbackReason = '') {
    const homographyAvailable = !!summary?.runtime?.homography;
    const runtimeReason = String(
        fallbackReason
        || summary.error
        || (summary?.ready && !homographyAvailable ? 'The Stitch photo runtime loaded, but homography support is unavailable.' : '')
    );
    return {
        workerAvailable: true,
        wasmAvailable: !!capabilities.wasm,
        runtimeAvailable: !!summary.ready && !summary.error && homographyAvailable,
        supportedDetectors: Array.isArray(summary.supportedDetectors) ? summary.supportedDetectors : [],
        lastRuntimeSelection: summary.ready ? 'opencv-wasm' : '',
        lastFallbackReason: runtimeReason
    };
}

async function ensureRuntime(request) {
    if (runtimeBootstrapError) {
        throw new Error(runtimeBootstrapError?.message || 'The Stitch photo runtime could not be loaded.');
    }
    if (!runtime || typeof runtime.ensureReady !== 'function') {
        throw new Error('The Stitch photo runtime is unavailable in this build.');
    }
    const summary = await runtime.ensureReady();
    const signature = JSON.stringify({
        ready: !!summary?.ready,
        error: summary?.error || '',
        supportedDetectors: summary?.supportedDetectors || []
    });
    if (signature !== runtimeAnnouncement) {
        runtimeAnnouncement = signature;
        postLog(
            request,
            summary?.ready ? 'info' : 'warning',
            summary?.ready
                ? `Stitch photo runtime ready (${(summary.supportedDetectors || []).join(', ') || 'no detectors reported'}).`
                : (summary?.error || 'The Stitch photo runtime is unavailable.'),
            summary,
            'stitch.worker'
        );
    }
    return summary;
}

function bootstrapRuntime() {
    try {
        const search = self.location && self.location.search ? self.location.search : '';
        importScripts(`../stitch/opencv-worker.js${search}`);
        runtime = self.__STITCH_OPENCV_RUNTIME__ || null;
        if (!runtime) {
            runtimeBootstrapError = new Error('The Stitch photo runtime did not register its broker bridge.');
        }
    } catch (error) {
        runtimeBootstrapError = error instanceof Error
            ? error
            : new Error(String(error || 'The Stitch photo runtime could not be loaded.'));
    }
}

bootstrapRuntime();

self.addEventListener('message', async (event) => {
    const message = event.data || {};

    if (message.type === WORKER_MESSAGE_TYPES.INIT) {
        capabilities = { ...(message.capabilities || {}) };
        post(WORKER_EVENT_TYPES.READY, {});
        return;
    }

    if (message.type === WORKER_MESSAGE_TYPES.CANCEL) {
        cancelled.add(String(message.id || ''));
        return;
    }

    if (message.type !== WORKER_MESSAGE_TYPES.RUN) return;

    const request = {
        id: String(message.id || ''),
        task: String(message.task || ''),
        processId: message.processId || null,
        payload: message.payload || {}
    };

    try {
        if (request.task === 'self-test-photo-runtime') {
            const summary = await ensureRuntime(request);
            post(WORKER_EVENT_TYPES.RESULT, {
                id: request.id,
                task: request.task,
                processId: request.processId || null,
                payload: {
                    runtime: createAvailabilitySummary(summary),
                    summary
                }
            });
            return;
        }

        if (request.task !== 'analyze-photo') {
            throw new Error(`Worker task "${request.task}" is not registered for ${DOMAIN}.`);
        }

        const summary = await ensureRuntime(request);
        if (cancelled.has(request.id)) {
            post(WORKER_EVENT_TYPES.CANCELLED, {
                id: request.id,
                task: request.task,
                processId: request.processId || null,
                message: 'Task cancelled.'
            });
            return;
        }

        self.__STITCH_OPENCV_PROGRESS__ = ({ progress }) => {
            if (cancelled.has(request.id)) return;
            const label = String(progress?.label || '').trim();
            const detail = String(progress?.detail || '').trim();
            const messageText = [label, detail].filter(Boolean).join(' ') || 'Running Stitch photo analysis...';
            postProgress(request, messageText, progress, progress?.progress);
        };

        postLog(request, 'info', 'Running Stitch photo analysis in the broker-managed OpenCV runtime.', {
            backend: 'opencv-wasm'
        }, 'stitch.worker');

        const result = runtime.analyzePhotoDocument(
            request.payload.document,
            Array.isArray(request.payload.preparedInputs) ? request.payload.preparedInputs : [],
            request.id
        );

        if (cancelled.has(request.id)) {
            post(WORKER_EVENT_TYPES.CANCELLED, {
                id: request.id,
                task: request.task,
                processId: request.processId || null,
                message: 'Task cancelled.'
            });
            return;
        }

        post(WORKER_EVENT_TYPES.RESULT, {
            id: request.id,
            task: request.task,
            processId: request.processId || null,
            payload: {
                ...result,
                runtime: createAvailabilitySummary(summary)
            }
        });
    } catch (error) {
        post(WORKER_EVENT_TYPES.ERROR, {
            id: request.id,
            task: request.task,
            processId: request.processId || null,
            error: error?.message || `Worker task "${request.task}" failed.`,
            details: {
                runtime: createAvailabilitySummary({}, error?.message || ''),
                fallbackReason: error?.message || '',
                stage: request.task === 'self-test-photo-runtime' ? 'runtime-init' : 'photo-analysis'
            }
        });
    } finally {
        if (self.__STITCH_OPENCV_PROGRESS__) {
            self.__STITCH_OPENCV_PROGRESS__ = null;
        }
        cancelled.delete(request.id);
    }
});
