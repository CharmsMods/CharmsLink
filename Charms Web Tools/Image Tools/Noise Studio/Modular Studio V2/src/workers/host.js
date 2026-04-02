import { WORKER_EVENT_TYPES, WORKER_MESSAGE_TYPES } from './protocol.js';

function createAbortError(message = 'Task cancelled.') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function normalizeProgress(value) {
    if (value == null) return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return null;
    return Math.min(1, Math.max(0, numeric));
}

export function createWorkerDomainHost(domain, handlers = {}) {
    const cancelled = new Set();
    let capabilities = {};

    function post(type, payload = {}, transfer = []) {
        self.postMessage({
            type,
            domain,
            ...payload
        }, transfer);
    }

    function createContext(request) {
        return {
            id: request.id,
            domain,
            task: request.task,
            processId: request.processId || null,
            capabilities,
            isCancelled() {
                return cancelled.has(request.id);
            },
            assertNotCancelled() {
                if (cancelled.has(request.id)) {
                    throw createAbortError();
                }
            },
            progress(progress, message = '', payload = null) {
                if (cancelled.has(request.id)) return;
                post(WORKER_EVENT_TYPES.PROGRESS, {
                    id: request.id,
                    task: request.task,
                    processId: request.processId || null,
                    progress: normalizeProgress(progress),
                    message: String(message || ''),
                    payload
                });
            },
            log(level, message, payload = null) {
                if (cancelled.has(request.id)) return;
                post(WORKER_EVENT_TYPES.LOG, {
                    id: request.id,
                    task: request.task,
                    processId: request.processId || null,
                    level: String(level || 'info'),
                    message: String(message || ''),
                    payload
                });
            }
        };
    }

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
            payload: message.payload
        };
        const handler = handlers[request.task];
        if (!handler) {
            post(WORKER_EVENT_TYPES.ERROR, {
                id: request.id,
                task: request.task,
                processId: request.processId || null,
                error: `Worker task "${request.task}" is not registered for ${domain}.`
            });
            return;
        }

        try {
            const result = await handler(request.payload, createContext(request));
            if (cancelled.has(request.id)) {
                post(WORKER_EVENT_TYPES.CANCELLED, {
                    id: request.id,
                    task: request.task,
                    processId: request.processId || null
                });
                return;
            }
            if (result && typeof result === 'object' && Array.isArray(result.transfer)) {
                post(WORKER_EVENT_TYPES.RESULT, {
                    id: request.id,
                    task: request.task,
                    processId: request.processId || null,
                    payload: result.payload
                }, result.transfer);
                return;
            }
            post(WORKER_EVENT_TYPES.RESULT, {
                id: request.id,
                task: request.task,
                processId: request.processId || null,
                payload: result
            });
        } catch (error) {
            if (cancelled.has(request.id) || error?.name === 'AbortError') {
                post(WORKER_EVENT_TYPES.CANCELLED, {
                    id: request.id,
                    task: request.task,
                    processId: request.processId || null
                });
                return;
            }
            post(WORKER_EVENT_TYPES.ERROR, {
                id: request.id,
                task: request.task,
                processId: request.processId || null,
                error: error?.message || `Worker task "${request.task}" failed.`
            });
        } finally {
            cancelled.delete(request.id);
        }
    });

}
