import { WORKER_EVENT_TYPES, WORKER_MESSAGE_TYPES } from './protocol.js';

const PRIORITY_ORDER = {
    'critical-boot': 0,
    'user-visible': 1,
    background: 2,
    idle: 3
};

function abortError(message = 'Task cancelled.') {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
}

function now() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function priorityValue(priority) {
    return Object.prototype.hasOwnProperty.call(PRIORITY_ORDER, priority)
        ? PRIORITY_ORDER[priority]
        : PRIORITY_ORDER.background;
}

function sortQueue(queue) {
    queue.sort((left, right) => {
        const leftPriority = priorityValue(left.priority);
        const rightPriority = priorityValue(right.priority);
        if (leftPriority !== rightPriority) return leftPriority - rightPriority;
        return left.enqueuedAt - right.enqueuedAt;
    });
}

function createTaskId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

export function createBackgroundTaskBroker(options = {}) {
    const capabilities = { ...(options.capabilities || {}) };
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    const onTaskMetric = typeof options.onTaskMetric === 'function' ? options.onTaskMetric : null;
    const domains = new Map();

    function registerDomain(domain, config = {}) {
        if (!domain) return;
        domains.set(domain, {
            name: domain,
            config,
            queue: [],
            active: null,
            worker: null,
            workerReady: null,
            handleMessage: null,
            handleError: null
        });
    }

    function emitEvent(domainState, job, event) {
        if (!onEvent || !event) return;
        onEvent({
            domain: domainState.name,
            task: job?.task || event.task || '',
            processId: job?.processId || event.processId || null,
            ...event
        });
    }

    function emitMetric(metric) {
        onTaskMetric?.(metric);
    }

    function finalizeTask(domainState, job) {
        if (domainState.active?.id === job.id) {
            domainState.active = null;
        }
        if (job.abortHandler && job.signal) {
            job.signal.removeEventListener('abort', job.abortHandler);
        }
        queueNext(domainState);
    }

    function resolveActiveJob(domainState, message) {
        const active = domainState.active;
        if (active && active.id === message.id) return active;
        return null;
    }

    function ensureWorker(domainState) {
        if (domainState.workerReady) return domainState.workerReady;
        const { config } = domainState;
        if (!config.workerUrl || !capabilities.worker || !capabilities.moduleWorker) {
            return Promise.resolve(null);
        }
        domainState.workerReady = new Promise((resolve, reject) => {
            try {
                const worker = new Worker(config.workerUrl, { type: config.type || 'module' });
                domainState.worker = worker;
                let ready = false;

                domainState.handleMessage = (event) => {
                    const message = event.data || {};
                    if (!ready && message.type === WORKER_EVENT_TYPES.READY) {
                        ready = true;
                        resolve(worker);
                        return;
                    }

                    const job = resolveActiveJob(domainState, message);
                    if (!job) return;

                    if (message.type === WORKER_EVENT_TYPES.PROGRESS) {
                        job.onProgress?.({
                            progress: message.progress,
                            message: message.message,
                            payload: message.payload,
                            task: job.task,
                            domain: domainState.name
                        });
                        emitEvent(domainState, job, message);
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.LOG) {
                        job.onLog?.(message);
                        emitEvent(domainState, job, message);
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.RESULT) {
                        emitMetric({
                            domain: domainState.name,
                            task: job.task,
                            queueWaitMs: job.startedAt - job.enqueuedAt,
                            durationMs: now() - job.startedAt,
                            mode: 'worker'
                        });
                        finalizeTask(domainState, job);
                        job.resolve(message.payload);
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.CANCELLED) {
                        finalizeTask(domainState, job);
                        job.reject(abortError());
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.ERROR) {
                        emitMetric({
                            domain: domainState.name,
                            task: job.task,
                            queueWaitMs: job.startedAt - job.enqueuedAt,
                            durationMs: now() - job.startedAt,
                            mode: 'worker',
                            failed: true
                        });
                        finalizeTask(domainState, job);
                        job.reject(new Error(message.error || `Worker task "${job.task}" failed.`));
                    }
                };

                domainState.handleError = (event) => {
                    if (!ready) {
                        reject(event?.error || new Error(`Worker "${domainState.name}" failed to start.`));
                    } else if (domainState.active) {
                        const job = domainState.active;
                        finalizeTask(domainState, job);
                        job.reject(event?.error || new Error(`Worker "${domainState.name}" failed.`));
                    }
                };

                worker.addEventListener('message', domainState.handleMessage);
                worker.addEventListener('error', domainState.handleError);
                worker.postMessage({
                    type: WORKER_MESSAGE_TYPES.INIT,
                    domain: domainState.name,
                    capabilities
                });
            } catch (error) {
                reject(error);
            }
        }).catch((error) => {
            domainState.workerReady = null;
            if (domainState.worker) {
                try {
                    domainState.worker.terminate();
                } catch (_error) {
                    // Ignore cleanup failures.
                }
            }
            domainState.worker = null;
            throw error;
        });

        return domainState.workerReady;
    }

    async function runFallback(domainState, job) {
        const handler = domainState.config.fallback;
        if (typeof handler !== 'function') {
            throw new Error(`No fallback handler is registered for ${domainState.name}:${job.task}.`);
        }
        const context = {
            id: job.id,
            domain: domainState.name,
            task: job.task,
            processId: job.processId,
            capabilities,
            isCancelled() {
                return !!job.cancelled;
            },
            assertNotCancelled() {
                if (job.cancelled) throw abortError();
            },
            progress(progress, message = '', payload = null) {
                if (job.cancelled) return;
                const event = {
                    type: WORKER_EVENT_TYPES.PROGRESS,
                    progress,
                    message,
                    payload
                };
                job.onProgress?.({
                    progress,
                    message,
                    payload,
                    task: job.task,
                    domain: domainState.name
                });
                emitEvent(domainState, job, event);
            },
            log(level, message, payload = null) {
                if (job.cancelled) return;
                const event = {
                    type: WORKER_EVENT_TYPES.LOG,
                    level,
                    message,
                    payload
                };
                job.onLog?.(event);
                emitEvent(domainState, job, event);
            }
        };
        return handler(job.task, job.payload, context);
    }

    async function startTask(domainState, job) {
        domainState.active = job;
        job.startedAt = now();
        const useWorker = !!domainState.config.workerUrl
            && capabilities.worker
            && capabilities.moduleWorker
            && (typeof domainState.config.supportsTask !== 'function'
                || domainState.config.supportsTask(job.task, capabilities, job.payload));

        if (!useWorker) {
            try {
                const result = await runFallback(domainState, job);
                emitMetric({
                    domain: domainState.name,
                    task: job.task,
                    queueWaitMs: job.startedAt - job.enqueuedAt,
                    durationMs: now() - job.startedAt,
                    mode: 'fallback'
                });
                finalizeTask(domainState, job);
                job.resolve(result);
            } catch (error) {
                finalizeTask(domainState, job);
                job.reject(error);
            }
            return;
        }

        try {
            await ensureWorker(domainState);
            if (!domainState.worker) {
                const result = await runFallback(domainState, job);
                finalizeTask(domainState, job);
                job.resolve(result);
                return;
            }
            domainState.worker.postMessage({
                type: WORKER_MESSAGE_TYPES.RUN,
                id: job.id,
                task: job.task,
                processId: job.processId || null,
                payload: job.payload
            }, job.transfer || []);
        } catch (_error) {
            try {
                const result = await runFallback(domainState, job);
                emitMetric({
                    domain: domainState.name,
                    task: job.task,
                    queueWaitMs: job.startedAt - job.enqueuedAt,
                    durationMs: now() - job.startedAt,
                    mode: 'fallback'
                });
                finalizeTask(domainState, job);
                job.resolve(result);
            } catch (fallbackError) {
                finalizeTask(domainState, job);
                job.reject(fallbackError);
            }
        }
    }

    function queueNext(domainState) {
        if (domainState.active || !domainState.queue.length) return;
        const nextJob = domainState.queue.shift();
        if (!nextJob) return;
        if (nextJob.cancelled || nextJob.signal?.aborted) {
            nextJob.reject(abortError());
            queueNext(domainState);
            return;
        }
        startTask(domainState, nextJob);
    }

    function runTask(domain, task, payload, options = {}) {
        const domainState = domains.get(domain);
        if (!domainState) {
            return Promise.reject(new Error(`Worker domain "${domain}" is not registered.`));
        }

        const job = {
            id: createTaskId(),
            task,
            payload,
            transfer: options.transfer || [],
            priority: options.priority || 'background',
            processId: options.processId || null,
            onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
            onLog: typeof options.onLog === 'function' ? options.onLog : null,
            signal: options.signal || null,
            replaceKey: options.replaceKey ? String(options.replaceKey) : '',
            enqueuedAt: now(),
            startedAt: 0,
            cancelled: false,
            abortHandler: null,
            resolve: null,
            reject: null
        };

        return new Promise((resolve, reject) => {
            job.resolve = resolve;
            job.reject = reject;

            if (job.signal?.aborted) {
                reject(abortError());
                return;
            }

            if (job.replaceKey) {
                domainState.queue = domainState.queue.filter((queuedJob) => {
                    if (queuedJob.replaceKey !== job.replaceKey) return true;
                    queuedJob.cancelled = true;
                    queuedJob.reject(abortError('Replaced by a newer task.'));
                    return false;
                });
            }

            if (job.signal) {
                job.abortHandler = () => {
                    job.cancelled = true;
                    if (domainState.active?.id === job.id && domainState.worker) {
                        domainState.worker.postMessage({
                            type: WORKER_MESSAGE_TYPES.CANCEL,
                            id: job.id
                        });
                    } else {
                        domainState.queue = domainState.queue.filter((queuedJob) => queuedJob.id !== job.id);
                        reject(abortError());
                    }
                };
                job.signal.addEventListener('abort', job.abortHandler, { once: true });
            }

            domainState.queue.push(job);
            sortQueue(domainState.queue);
            queueNext(domainState);
        });
    }

    function destroy() {
        domains.forEach((domainState) => {
            domainState.queue.splice(0).forEach((job) => job.reject(abortError('Broker shut down.')));
            if (domainState.active) {
                domainState.active.reject(abortError('Broker shut down.'));
                domainState.active = null;
            }
            if (domainState.worker) {
                try {
                    domainState.worker.terminate();
                } catch (_error) {
                    // Ignore worker shutdown errors.
                }
            }
            domainState.worker = null;
            domainState.workerReady = null;
        });
    }

    return {
        registerDomain,
        runTask,
        destroy,
        getCapabilities() {
            return { ...capabilities };
        }
    };
}
