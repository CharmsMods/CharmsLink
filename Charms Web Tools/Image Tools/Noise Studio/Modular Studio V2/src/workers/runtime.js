import { WORKER_EVENT_TYPES, WORKER_MESSAGE_TYPES } from './protocol.js';

const PRIORITY_ORDER = {
    'critical-boot': 0,
    'user-visible': 1,
    background: 2,
    idle: 3
};

const DEFAULT_BOOT_TIMEOUT_MS = 12000;
const MAX_RETIRED_DISPATCH_IDS = 160;

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

function createDispatchId(job) {
    job.attempt = (job.attempt || 0) + 1;
    job.dispatchId = `${job.id}:${job.attempt}`;
    return job.dispatchId;
}

function matchesScope(job, scope) {
    if (!scope || !job?.scope) return false;
    if (job.scope === scope) return true;
    return job.scope.startsWith(`${scope}:`);
}

function rememberRetiredDispatch(domainState, dispatchId) {
    if (!dispatchId) return;
    domainState.retiredDispatchIds.add(dispatchId);
    domainState.retiredDispatchOrder.push(dispatchId);
    if (domainState.retiredDispatchOrder.length > MAX_RETIRED_DISPATCH_IDS) {
        const staleId = domainState.retiredDispatchOrder.shift();
        if (staleId) {
            domainState.retiredDispatchIds.delete(staleId);
        }
    }
}

function workerSupports(domainState, task, capabilities, payload) {
    const workerType = String(domainState.config.type || 'module').toLowerCase();
    const requiresModuleWorker = workerType !== 'classic';
    return !!domainState.config.workerUrl
        && capabilities.worker
        && (!requiresModuleWorker || capabilities.moduleWorker)
        && (typeof domainState.config.supportsTask !== 'function'
            || domainState.config.supportsTask(task, capabilities, payload));
}

export function createBackgroundTaskBroker(options = {}) {
    const capabilities = { ...(options.capabilities || {}) };
    const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;
    const onTaskMetric = typeof options.onTaskMetric === 'function' ? options.onTaskMetric : null;
    const domains = new Map();
    let maxConcurrentTasks = Number.isFinite(Number(options.maxConcurrentTasks)) && Number(options.maxConcurrentTasks) > 0
        ? Math.max(1, Math.round(Number(options.maxConcurrentTasks)))
        : Number.POSITIVE_INFINITY;

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
            handleError: null,
            handleMessageError: null,
            bootTimer: null,
            retiredDispatchIds: new Set(),
            retiredDispatchOrder: []
        });
    }

    function emitEvent(domainState, job, event) {
        if (!onEvent || !event) return;
        onEvent({
            domain: domainState.name,
            task: job?.task || event.task || '',
            processId: job?.processId || event.processId || null,
            scope: job?.scope || null,
            ...event
        });
    }

    function emitMetric(metric) {
        onTaskMetric?.(metric);
    }

    function getActiveTaskCount() {
        let count = 0;
        domains.forEach((domainState) => {
            if (domainState.active) count += 1;
        });
        return count;
    }

    function settleJob(job, method, value) {
        if (!job || job.settled) return false;
        job.settled = true;
        if (job.abortHandler && job.signal) {
            job.signal.removeEventListener('abort', job.abortHandler);
        }
        if (method === 'resolve') job.resolve?.(value);
        if (method === 'reject') job.reject?.(value);
        return true;
    }

    function clearWorkerState(domainState) {
        if (domainState.bootTimer) {
            clearTimeout(domainState.bootTimer);
            domainState.bootTimer = null;
        }
        if (domainState.worker && domainState.handleMessage) {
            domainState.worker.removeEventListener('message', domainState.handleMessage);
        }
        if (domainState.worker && domainState.handleError) {
            domainState.worker.removeEventListener('error', domainState.handleError);
        }
        if (domainState.worker && domainState.handleMessageError) {
            domainState.worker.removeEventListener('messageerror', domainState.handleMessageError);
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
        domainState.handleMessage = null;
        domainState.handleError = null;
        domainState.handleMessageError = null;
    }

    function queueNext(domainState) {
        if (domainState.active || !domainState.queue.length) return;
        if (getActiveTaskCount() >= maxConcurrentTasks) return;
        const nextJob = domainState.queue.shift();
        if (!nextJob) return;
        if (nextJob.cancelled || nextJob.signal?.aborted || nextJob.settled) {
            settleJob(nextJob, 'reject', abortError());
            queueNext(domainState);
            return;
        }
        startTask(domainState, nextJob);
    }

    function finalizeTask(domainState, job) {
        if (!job) return;
        rememberRetiredDispatch(domainState, job.dispatchId);
        if (domainState.active?.id === job.id) {
            domainState.active = null;
        } else {
            domainState.queue = domainState.queue.filter((queuedJob) => queuedJob.id !== job.id);
        }
        drainQueues();
    }

    function requeueTaskFront(domainState, job) {
        if (!job || job.settled) return;
        rememberRetiredDispatch(domainState, job.dispatchId);
        job.dispatchId = '';
        job.startedAt = 0;
        job.cancelled = false;
        if (domainState.active?.id === job.id) {
            domainState.active = null;
        }
        domainState.queue.unshift(job);
        sortQueue(domainState.queue);
        drainQueues();
    }

    function retireJob(domainState, job, reason = 'Task cancelled.', options = {}) {
        if (!job) return false;
        const wasActive = domainState.active?.id === job.id;
        job.cancelled = true;
        rememberRetiredDispatch(domainState, job.dispatchId);
        if (wasActive) {
            domainState.active = null;
        } else {
            domainState.queue = domainState.queue.filter((queuedJob) => queuedJob.id !== job.id);
        }
        if (options.emitEvent !== false) {
            emitEvent(domainState, job, {
                type: WORKER_EVENT_TYPES.CANCELLED,
                id: job.dispatchId || job.id,
                task: job.task,
                processId: job.processId || null,
                message: reason
            });
        }
        const shouldRestartWorker = wasActive
            && options.restartWorker !== false
            && !!domainState.worker;
        if (shouldRestartWorker) {
            clearWorkerState(domainState);
        } else if (wasActive && options.sendCancel !== false && domainState.worker && job.dispatchId) {
            try {
                domainState.worker.postMessage({
                    type: WORKER_MESSAGE_TYPES.CANCEL,
                    id: job.dispatchId
                });
            } catch (_error) {
                // Ignore cancellation-post failures while shutting down a task.
            }
        }
        settleJob(job, 'reject', options.error || abortError(reason));
        drainQueues();
        return true;
    }

    function drainQueues() {
        if (getActiveTaskCount() >= maxConcurrentTasks) return;
        let madeProgress = true;
        while (madeProgress && getActiveTaskCount() < maxConcurrentTasks) {
            madeProgress = false;
            domains.forEach((domainState) => {
                if (domainState.active || !domainState.queue.length) return;
                if (getActiveTaskCount() >= maxConcurrentTasks) return;
                madeProgress = true;
                queueNext(domainState);
            });
        }
    }

    async function createWorkerRequest(job) {
        const dynamicRequest = typeof job.createRequest === 'function'
            ? await job.createRequest({
                id: job.id,
                task: job.task,
                payload: job.payload,
                attempt: job.attempt,
                processId: job.processId || null,
                isCancelled() {
                    return !!job.cancelled || !!job.settled;
                },
                assertNotCancelled() {
                    if (job.cancelled || job.settled) {
                        throw abortError();
                    }
                }
            })
            : null;
        if (job.cancelled || job.settled) {
            throw abortError();
        }
        const hasPayload = !!dynamicRequest && Object.prototype.hasOwnProperty.call(dynamicRequest, 'payload');
        const dynamicTransfer = Array.isArray(dynamicRequest?.transfer) ? dynamicRequest.transfer : [];
        return {
            payload: hasPayload ? dynamicRequest.payload : job.payload,
            transfer: [...(job.transfer || []), ...dynamicTransfer]
        };
    }

    function replayJobAfterWorkerFailure(domainState, job, error) {
        const replayAllowed = !!job.replayOnWorkerCrash && job.replayCount < job.maxCrashReplays;
        if (!replayAllowed) {
            retireJob(domainState, job, error?.message || `Worker "${domainState.name}" failed.`, {
                error: error || new Error(`Worker "${domainState.name}" failed.`),
                sendCancel: false
            });
            emitMetric({
                domain: domainState.name,
                task: job.task,
                queueWaitMs: job.startedAt ? job.startedAt - job.enqueuedAt : 0,
                durationMs: job.startedAt ? now() - job.startedAt : 0,
                mode: 'worker',
                failed: true
            });
            return;
        }

        job.replayCount += 1;
        emitEvent(domainState, job, {
            type: WORKER_EVENT_TYPES.LOG,
            id: job.dispatchId || job.id,
            task: job.task,
            processId: job.processId || null,
            level: 'warning',
            message: `Worker "${domainState.name}" failed. Retrying ${job.task} (attempt ${job.replayCount + 1}).`
        });
        requeueTaskFront(domainState, job);
    }

    function handleWorkerFailure(domainState, error, options = {}) {
        const activeJob = domainState.active;
        clearWorkerState(domainState);
        if (options.duringBoot) {
            throw error;
        }
        if (activeJob) {
            replayJobAfterWorkerFailure(domainState, activeJob, error);
        }
    }

    function ensureWorker(domainState) {
        if (domainState.workerReady) return domainState.workerReady;
        const workerType = String(domainState.config.type || 'module').toLowerCase();
        const requiresModuleWorker = workerType !== 'classic';
        if (!domainState.config.workerUrl || !capabilities.worker || (requiresModuleWorker && !capabilities.moduleWorker)) {
            return Promise.resolve(null);
        }

        const bootTimeoutMs = Math.max(1000, Number(domainState.config.bootTimeoutMs) || DEFAULT_BOOT_TIMEOUT_MS);

        domainState.workerReady = new Promise((resolve, reject) => {
            let worker = null;
            let ready = false;
            try {
                worker = new Worker(domainState.config.workerUrl, { type: requiresModuleWorker ? 'module' : 'classic' });
                domainState.worker = worker;

                const failBoot = (error) => {
                    if (ready) return;
                    clearWorkerState(domainState);
                    reject(error);
                };

                domainState.bootTimer = setTimeout(() => {
                    failBoot(new Error(`Worker "${domainState.name}" did not become ready within ${bootTimeoutMs}ms.`));
                }, bootTimeoutMs);

                domainState.handleMessage = (event) => {
                    const message = event.data || {};
                    if (!ready && message.type === WORKER_EVENT_TYPES.READY) {
                        ready = true;
                        if (domainState.bootTimer) {
                            clearTimeout(domainState.bootTimer);
                            domainState.bootTimer = null;
                        }
                        resolve(worker);
                        return;
                    }

                    const activeJob = domainState.active;
                    if (!activeJob || activeJob.dispatchId !== message.id || domainState.retiredDispatchIds.has(message.id)) {
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.PROGRESS) {
                        activeJob.onProgress?.({
                            progress: message.progress,
                            message: message.message,
                            payload: message.payload,
                            task: activeJob.task,
                            domain: domainState.name
                        });
                        emitEvent(domainState, activeJob, message);
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.LOG) {
                        activeJob.onLog?.(message);
                        emitEvent(domainState, activeJob, message);
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.RESULT) {
                        emitMetric({
                            domain: domainState.name,
                            task: activeJob.task,
                            queueWaitMs: activeJob.startedAt - activeJob.enqueuedAt,
                            durationMs: now() - activeJob.startedAt,
                            mode: 'worker'
                        });
                        finalizeTask(domainState, activeJob);
                        settleJob(activeJob, 'resolve', message.payload);
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.CANCELLED) {
                        finalizeTask(domainState, activeJob);
                        settleJob(activeJob, 'reject', abortError(message.message || 'Task cancelled.'));
                        return;
                    }

                    if (message.type === WORKER_EVENT_TYPES.ERROR) {
                        const error = new Error(message.error || `Worker task "${activeJob.task}" failed.`);
                        if (message.details && typeof message.details === 'object') {
                            Object.assign(error, message.details);
                        }
                        emitMetric({
                            domain: domainState.name,
                            task: activeJob.task,
                            queueWaitMs: activeJob.startedAt - activeJob.enqueuedAt,
                            durationMs: now() - activeJob.startedAt,
                            mode: 'worker',
                            failed: true
                        });
                        finalizeTask(domainState, activeJob);
                        settleJob(activeJob, 'reject', error);
                    }
                };

                domainState.handleError = (event) => {
                    const error = event?.error || new Error(`Worker "${domainState.name}" failed.`);
                    if (!ready) {
                        failBoot(error);
                        return;
                    }
                    handleWorkerFailure(domainState, error);
                };

                domainState.handleMessageError = () => {
                    const error = new Error(`Worker "${domainState.name}" sent an unreadable message.`);
                    if (!ready) {
                        failBoot(error);
                        return;
                    }
                    handleWorkerFailure(domainState, error);
                };

                worker.addEventListener('message', domainState.handleMessage);
                worker.addEventListener('error', domainState.handleError);
                worker.addEventListener('messageerror', domainState.handleMessageError);
                worker.postMessage({
                    type: WORKER_MESSAGE_TYPES.INIT,
                    domain: domainState.name,
                    capabilities
                });
            } catch (error) {
                clearWorkerState(domainState);
                reject(error);
            }
        }).catch((error) => {
            clearWorkerState(domainState);
            domainState.workerReady = null;
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
            id: job.dispatchId || job.id,
            domain: domainState.name,
            task: job.task,
            processId: job.processId,
            capabilities,
            isCancelled() {
                return !!job.cancelled;
            },
            assertNotCancelled() {
                if (job.cancelled || job.settled) throw abortError();
            },
            progress(progress, message = '', payload = null) {
                if (job.cancelled || job.settled) return;
                const event = {
                    type: WORKER_EVENT_TYPES.PROGRESS,
                    id: job.dispatchId || job.id,
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
                if (job.cancelled || job.settled) return;
                const event = {
                    type: WORKER_EVENT_TYPES.LOG,
                    id: job.dispatchId || job.id,
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
        createDispatchId(job);

        const useWorker = workerSupports(domainState, job.task, capabilities, job.payload);

        if (!useWorker) {
            try {
                const result = await runFallback(domainState, job);
                if (job.settled || job.cancelled) return;
                emitMetric({
                    domain: domainState.name,
                    task: job.task,
                    queueWaitMs: job.startedAt - job.enqueuedAt,
                    durationMs: now() - job.startedAt,
                    mode: 'fallback'
                });
                finalizeTask(domainState, job);
                settleJob(job, 'resolve', result);
            } catch (error) {
                if (job.settled) return;
                finalizeTask(domainState, job);
                settleJob(job, 'reject', error);
            }
            return;
        }

        try {
            await ensureWorker(domainState);
            if (!domainState.worker) {
                const result = await runFallback(domainState, job);
                if (job.settled || job.cancelled) return;
                finalizeTask(domainState, job);
                settleJob(job, 'resolve', result);
                return;
            }
            const request = await createWorkerRequest(job);
            if (job.settled || job.cancelled) return;
            domainState.worker.postMessage({
                type: WORKER_MESSAGE_TYPES.RUN,
                id: job.dispatchId,
                task: job.task,
                processId: job.processId || null,
                payload: request.payload
            }, request.transfer);
        } catch (_error) {
            if (job.settled) return;
            try {
                const result = await runFallback(domainState, job);
                if (job.settled || job.cancelled) return;
                emitMetric({
                    domain: domainState.name,
                    task: job.task,
                    queueWaitMs: job.startedAt - job.enqueuedAt,
                    durationMs: now() - job.startedAt,
                    mode: 'fallback'
                });
                finalizeTask(domainState, job);
                settleJob(job, 'resolve', result);
            } catch (fallbackError) {
                if (job.settled) return;
                finalizeTask(domainState, job);
                settleJob(job, 'reject', fallbackError);
            }
        }
    }

    function runTask(domain, task, payload, options = {}) {
        const domainState = domains.get(domain);
        if (!domainState) {
            return Promise.reject(new Error(`Worker domain "${domain}" is not registered.`));
        }

        const job = {
            id: createTaskId(),
            dispatchId: '',
            task,
            payload,
            transfer: options.transfer || [],
            priority: options.priority || 'background',
            processId: options.processId || null,
            scope: options.scope ? String(options.scope) : '',
            onProgress: typeof options.onProgress === 'function' ? options.onProgress : null,
            onLog: typeof options.onLog === 'function' ? options.onLog : null,
            signal: options.signal || null,
            replaceKey: options.replaceKey ? String(options.replaceKey) : '',
            replaceActive: options.replaceActive !== false,
            replayOnWorkerCrash: options.replayOnWorkerCrash !== false,
            createRequest: typeof options.createRequest === 'function' ? options.createRequest : null,
            maxCrashReplays: Math.max(0, Number(options.maxCrashReplays) || 1),
            attempt: 0,
            replayCount: 0,
            enqueuedAt: now(),
            startedAt: 0,
            cancelled: false,
            settled: false,
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
                    retireJob(domainState, queuedJob, 'Replaced by a newer queued task.', {
                        sendCancel: false
                    });
                    return false;
                });
                if (job.replaceActive && domainState.active?.replaceKey === job.replaceKey) {
                    retireJob(domainState, domainState.active, 'Replaced by a newer active task.');
                }
            }

            if (job.signal) {
                job.abortHandler = () => {
                    retireJob(domainState, job, 'Task aborted by caller.');
                };
                job.signal.addEventListener('abort', job.abortHandler, { once: true });
            }

            domainState.queue.push(job);
            sortQueue(domainState.queue);
            drainQueues();
        });
    }

    function cancelTasks(options = {}) {
        const scope = options.scope ? String(options.scope) : '';
        const domain = options.domain ? String(options.domain) : '';
        const reason = options.reason || 'Task cancelled.';
        const includeActive = options.includeActive !== false;

        domains.forEach((domainState) => {
            if (domain && domainState.name !== domain) return;
            domainState.queue.slice().forEach((job) => {
                if (scope && !matchesScope(job, scope)) return;
                retireJob(domainState, job, reason, { sendCancel: false });
            });
            if (includeActive && domainState.active) {
                if (scope && !matchesScope(domainState.active, scope)) return;
                retireJob(domainState, domainState.active, reason);
            }
        });
    }

    function destroy() {
        domains.forEach((domainState) => {
            domainState.queue.slice().forEach((job) => {
                retireJob(domainState, job, 'Broker shut down.', { sendCancel: false });
            });
            if (domainState.active) {
                retireJob(domainState, domainState.active, 'Broker shut down.');
            }
            clearWorkerState(domainState);
        });
    }

    return {
        registerDomain,
        runTask,
        configure(nextOptions = {}) {
            if (Object.prototype.hasOwnProperty.call(nextOptions, 'maxConcurrentTasks')) {
                const requested = Number(nextOptions.maxConcurrentTasks);
                maxConcurrentTasks = Number.isFinite(requested) && requested > 0
                    ? Math.max(1, Math.round(requested))
                    : Number.POSITIVE_INFINITY;
                drainQueues();
            }
        },
        cancelTasks,
        cancelScope(scope, options = {}) {
            cancelTasks({
                ...options,
                scope
            });
        },
        cancelDomain(domain, options = {}) {
            cancelTasks({
                ...options,
                domain
            });
        },
        destroy,
        getCapabilities() {
            return { ...capabilities };
        },
        getConfig() {
            return {
                maxConcurrentTasks: Number.isFinite(maxConcurrentTasks) ? maxConcurrentTasks : 0
            };
        }
    };
}
