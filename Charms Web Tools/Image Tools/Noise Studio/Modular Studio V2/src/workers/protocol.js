export const WORKER_MESSAGE_TYPES = Object.freeze({
    INIT: 'init',
    RUN: 'run',
    CANCEL: 'cancel'
});

export const WORKER_EVENT_TYPES = Object.freeze({
    READY: 'ready',
    PROGRESS: 'progress',
    LOG: 'log',
    RESULT: 'result',
    ERROR: 'error',
    CANCELLED: 'cancelled'
});
