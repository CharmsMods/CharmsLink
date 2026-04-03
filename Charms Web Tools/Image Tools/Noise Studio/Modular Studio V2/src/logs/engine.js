function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(1, Math.max(0, numeric));
}

function normalizeLevel(level) {
    if (level === 'error' || level === 'warning' || level === 'success' || level === 'active') {
        return level;
    }
    return 'info';
}

function normalizeStatus(status, level) {
    if (status === 'idle' || status === 'active' || status === 'success' || status === 'warning' || status === 'error') {
        return status;
    }
    if (level === 'error') return 'error';
    if (level === 'warning') return 'warning';
    if (level === 'success') return 'success';
    return 'active';
}

function snapshotEntry(entry) {
    return {
        id: entry.id,
        timestamp: entry.timestamp,
        level: entry.level,
        status: entry.status,
        message: entry.message,
        progress: entry.progress
    };
}

function snapshotProcess(process) {
    return {
        id: process.id,
        label: process.label,
        status: process.status,
        level: process.level,
        progress: process.progress,
        updatedAt: process.updatedAt,
        startedAt: process.startedAt,
        lastMessage: process.lastMessage,
        counts: {
            total: process.counts.total,
            warning: process.counts.warning,
            error: process.counts.error
        },
        entries: process.entries.map(snapshotEntry)
    };
}

function snapshotWriteEvent(event) {
    return {
        type: event.type,
        processId: event.processId,
        label: event.label,
        status: event.status,
        level: event.level,
        progress: event.progress,
        previousStatus: event.previousStatus,
        previousLevel: event.previousLevel,
        previousProgress: event.previousProgress,
        completed: !!event.completed,
        entry: event.entry ? snapshotEntry(event.entry) : null,
        process: event.process ? snapshotProcess(event.process) : null
    };
}

export function createLogEngine(options = {}) {
    let recentLimit = Math.max(6, Math.round(Number(options.recentLimit) || 18));
    const requestedHistoryLimit = Number(options.historyLimit);
    let historyLimit = Number.isFinite(requestedHistoryLimit) && requestedHistoryLimit > 0
        ? Math.max(recentLimit, Math.round(requestedHistoryLimit))
        : 0;
    const listeners = new Set();
    const eventListeners = new Set();
    const processes = new Map();
    let publishQueued = false;
    let sequence = 0;

    function ensureProcess(processId, label) {
        const id = String(processId || '').trim();
        if (!id) return null;
        const existing = processes.get(id);
        if (existing) {
            if (label) existing.label = String(label);
            return existing;
        }
        const nextProcess = {
            id,
            label: String(label || id),
            status: 'idle',
            level: 'info',
            progress: null,
            updatedAt: 0,
            startedAt: 0,
            lastMessage: '',
            entries: [],
            history: [],
            counts: {
                total: 0,
                warning: 0,
                error: 0
            },
            awaitingCompletion: false,
            lastDedupeKey: '',
            lastDedupeAt: 0
        };
        processes.set(id, nextProcess);
        return nextProcess;
    }

    function emitEvent(event) {
        if (!eventListeners.size || !event) return;
        const snapshot = snapshotWriteEvent(event);
        eventListeners.forEach((listener) => {
            try {
                listener(snapshot);
            } catch (_error) {
                // Ignore subscriber errors so logging keeps working.
            }
        });
    }

    function schedulePublish() {
        if (publishQueued) return;
        publishQueued = true;
        const flush = () => {
            publishQueued = false;
            const snapshot = getSnapshot();
            listeners.forEach((listener) => {
                try {
                    listener(snapshot);
                } catch (_error) {
                    // Ignore subscriber errors so logging keeps working.
                }
            });
        };
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(flush);
            return;
        }
        setTimeout(flush, 0);
    }

    function write(processId, label, message, options = {}) {
        const process = ensureProcess(processId, label);
        if (!process) return null;
        const now = Date.now();
        const previousStatus = process.status;
        const previousLevel = process.level;
        const previousProgress = process.progress;
        const previousAwaitingCompletion = !!process.awaitingCompletion;
        const level = normalizeLevel(options.level);
        const status = normalizeStatus(options.status, level);
        const text = String(message || '').trim() || 'Status updated.';
        const progress = options.progress == null ? null : clamp01(options.progress);
        const dedupeWindowMs = Math.max(0, Number(options.dedupeWindowMs) || 0);
        const dedupeKey = String(
            options.dedupeKey
            || `${status}|${level}|${text}|${progress == null ? '' : Math.round(progress * 1000)}`
        );

        if (dedupeWindowMs > 0 && process.lastDedupeKey === dedupeKey && (now - process.lastDedupeAt) < dedupeWindowMs) {
            process.updatedAt = now;
            if (progress != null) process.progress = progress;
            schedulePublish();
            return snapshotProcess(process);
        }

        const entry = {
            id: `${process.id}:${++sequence}`,
            timestamp: now,
            level,
            status,
            message: text,
            progress
        };
        process.entries.push(entry);
        process.history.push(entry);
        if (process.entries.length > recentLimit) {
            process.entries.splice(0, process.entries.length - recentLimit);
        }
        if (historyLimit > 0 && process.history.length > historyLimit) {
            process.history.splice(0, process.history.length - historyLimit);
        }
        process.status = status;
        process.level = level;
        process.progress = options.clearProgress
            ? null
            : (progress != null ? progress : process.progress);
        process.updatedAt = now;
        process.startedAt = process.startedAt || now;
        process.lastMessage = text;
        process.counts.total += 1;
        if (level === 'warning') process.counts.warning += 1;
        if (level === 'error') process.counts.error += 1;
        const terminal = status === 'success' || status === 'warning' || status === 'error' || status === 'idle';
        const nextAwaitingCompletion = status === 'active' || progress != null
            ? true
            : terminal
                ? false
                : process.awaitingCompletion;
        const completed = previousAwaitingCompletion && (status === 'success' || status === 'error');
        process.awaitingCompletion = nextAwaitingCompletion;
        process.lastDedupeKey = dedupeKey;
        process.lastDedupeAt = now;
        emitEvent({
            type: 'write',
            processId: process.id,
            label: process.label,
            status,
            level,
            progress: process.progress,
            previousStatus,
            previousLevel,
            previousProgress,
            completed,
            entry,
            process
        });
        schedulePublish();
        return snapshotProcess(process);
    }

    function info(processId, label, message, options = {}) {
        return write(processId, label, message, {
            ...options,
            level: 'info',
            status: options.status || 'active'
        });
    }

    function active(processId, label, message, options = {}) {
        return write(processId, label, message, {
            ...options,
            level: 'active',
            status: 'active'
        });
    }

    function success(processId, label, message, options = {}) {
        return write(processId, label, message, {
            ...options,
            level: 'success',
            status: 'success',
            clearProgress: options.clearProgress !== false
        });
    }

    function warning(processId, label, message, options = {}) {
        return write(processId, label, message, {
            ...options,
            level: 'warning',
            status: 'warning'
        });
    }

    function error(processId, label, message, options = {}) {
        return write(processId, label, message, {
            ...options,
            level: 'error',
            status: 'error'
        });
    }

    function progress(processId, label, message, ratio, options = {}) {
        return write(processId, label, message, {
            ...options,
            level: options.level || 'active',
            status: options.status || 'active',
            progress: ratio
        });
    }

    function clearProcess(processId) {
        if (!processes.has(processId)) return;
        processes.delete(processId);
        schedulePublish();
    }

    function clearAll() {
        if (!processes.size) return;
        processes.clear();
        schedulePublish();
    }

    function trimStoredEntries() {
        processes.forEach((process) => {
            if (process.entries.length > recentLimit) {
                process.entries.splice(0, process.entries.length - recentLimit);
            }
            if (historyLimit > 0 && process.history.length > historyLimit) {
                process.history.splice(0, process.history.length - historyLimit);
            }
        });
    }

    function getSnapshot() {
        return [...processes.values()]
            .map(snapshotProcess)
            .sort((a, b) => {
                if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
                return a.label.localeCompare(b.label);
            });
    }

    function subscribe(listener) {
        if (typeof listener !== 'function') return () => {};
        listeners.add(listener);
        listener(getSnapshot());
        return () => listeners.delete(listener);
    }

    function subscribeEvents(listener) {
        if (typeof listener !== 'function') return () => {};
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
    }

    function exportProcessText(processId) {
        const process = processes.get(processId);
        if (!process) return '';
        const header = [
            `${process.label}`,
            `Process ID: ${process.id}`,
            `Status: ${process.status}`,
            `Updated: ${process.updatedAt ? new Date(process.updatedAt).toLocaleString() : 'Never'}`,
            ''
        ];
        const lines = process.history.map((entry) => {
            const time = new Date(entry.timestamp).toLocaleTimeString();
            const level = String(entry.level || 'info').toUpperCase();
            const progressLabel = entry.progress == null ? '' : ` (${Math.round(entry.progress * 100)}%)`;
            return `[${time}] ${level}${progressLabel} ${entry.message}`;
        });
        return [...header, ...lines].join('\n');
    }

    function configure(nextOptions = {}) {
        const nextRecentLimit = Object.prototype.hasOwnProperty.call(nextOptions, 'recentLimit')
            ? Math.max(6, Math.round(Number(nextOptions.recentLimit) || recentLimit))
            : recentLimit;
        const requestedNextHistoryLimit = Object.prototype.hasOwnProperty.call(nextOptions, 'historyLimit')
            ? Number(nextOptions.historyLimit)
            : historyLimit;
        const nextHistoryLimit = Number.isFinite(requestedNextHistoryLimit) && requestedNextHistoryLimit > 0
            ? Math.max(nextRecentLimit, Math.round(requestedNextHistoryLimit))
            : 0;
        const didChange = nextRecentLimit !== recentLimit || nextHistoryLimit !== historyLimit;
        recentLimit = nextRecentLimit;
        historyLimit = nextHistoryLimit;
        if (didChange) {
            trimStoredEntries();
            schedulePublish();
        }
    }

    return {
        write,
        info,
        active,
        success,
        warning,
        error,
        progress,
        clearProcess,
        clearAll,
        getSnapshot,
        subscribe,
        subscribeEvents,
        exportProcessText,
        configure,
        getConfig() {
            return {
                recentLimit,
                historyLimit
            };
        }
    };
}
