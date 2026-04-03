function perfNow() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

export function createBootstrapMetrics(options = {}) {
    const marks = [];
    const longTasks = [];
    const workerTasks = [];
    const onLongTask = typeof options.onLongTask === 'function' ? options.onLongTask : null;
    let longTaskObserver = null;
    const supportedEntryTypes = typeof PerformanceObserver === 'function' && Array.isArray(PerformanceObserver.supportedEntryTypes)
        ? PerformanceObserver.supportedEntryTypes
        : [];
    const supportsLongTask = supportedEntryTypes.includes('longtask');

    if (typeof PerformanceObserver === 'function' && supportsLongTask) {
        try {
            longTaskObserver = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    const nextEntry = {
                        name: entry.name,
                        duration: entry.duration,
                        startTime: entry.startTime
                    };
                    longTasks.push(nextEntry);
                    onLongTask?.(nextEntry);
                });
            });
            longTaskObserver.observe({ entryTypes: ['longtask'] });
        } catch (_error) {
            longTaskObserver = null;
        }
    }

    return {
        mark(name, detail = '') {
            const entry = {
                name: String(name || ''),
                detail: String(detail || ''),
                time: perfNow()
            };
            marks.push(entry);
            return entry;
        },
        trackWorkerTask(metric = {}) {
            workerTasks.push({
                domain: metric.domain || '',
                task: metric.task || '',
                queueWaitMs: Number(metric.queueWaitMs) || 0,
                durationMs: Number(metric.durationMs) || 0,
                mode: metric.mode || 'worker',
                failed: !!metric.failed
            });
        },
        snapshot() {
            return {
                marks: [...marks],
                longTasks: [...longTasks],
                workerTasks: [...workerTasks]
            };
        },
        destroy() {
            longTaskObserver?.disconnect();
        }
    };
}
