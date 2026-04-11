function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatTime(value) {
    if (!value) return 'Never';
    try {
        return new Date(value).toLocaleTimeString();
    } catch (_error) {
        return 'Unknown';
    }
}

function formatStatusLabel(status) {
    if (status === 'error') return 'Error';
    if (status === 'warning') return 'Warning';
    if (status === 'success') return 'Done';
    if (status === 'active') return 'Active';
    return 'Idle';
}

function downloadTextFile(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function compactEntries(entries = []) {
    const compacted = [];
    for (const entry of entries) {
        const last = compacted[compacted.length - 1];
        if (
            last
            && last.level === entry.level
            && last.status === entry.status
            && last.message === entry.message
        ) {
            last.count += 1;
            last.lastTimestamp = entry.timestamp;
            last.id = entry.id;
            continue;
        }
        compacted.push({
            ...entry,
            count: 1,
            firstTimestamp: entry.timestamp,
            lastTimestamp: entry.timestamp
        });
    }
    return compacted;
}

function normalizePanelSettings(settings = {}) {
    return {
        maxUiCards: Math.max(0, Math.round(Number(settings.maxUiCards) || 0)),
        levelFilter: settings.levelFilter === 'warnings-errors' ? 'warnings-errors' : 'all',
        compactMessages: settings.compactMessages !== false,
        completionFlashEffects: settings.completionFlashEffects !== false
    };
}

function filterEntries(entries = [], levelFilter = 'all') {
    if (levelFilter !== 'warnings-errors') {
        return Array.isArray(entries) ? entries : [];
    }
    return (Array.isArray(entries) ? entries : []).filter((entry) => entry?.level === 'warning' || entry?.level === 'error');
}

export function createLogsPanel(root, { logger = null, settings = null } = {}) {
    root.innerHTML = `
        <style data-logs-panel-style>
            .logs-shell{position:relative;height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);gap:16px;padding:4px;background:transparent;color:var(--studio-neu-text);overflow:hidden}
            .logs-toolbar,.log-card{border:none;background:var(--studio-neu-surface);color:var(--studio-neu-text);box-shadow:var(--studio-neu-shadow-card)}
            .logs-toolbar{display:flex;align-items:center;justify-content:flex-end;gap:16px;padding:16px 18px;border-radius:22px;z-index:2}
            .logs-toolbar-actions{display:flex;align-items:center;gap:12px}
            .logs-toolbar button,.log-card-actions button{border:none;border-radius:999px;background:var(--studio-neu-button-fill);color:var(--studio-neu-text);box-shadow:var(--studio-neu-shadow-button);cursor:pointer;font-weight:700;transition:transform .18s ease, box-shadow .18s ease, background .18s ease, color .18s ease, opacity .18s ease}
            .logs-toolbar button{min-height:30px;padding:0 14px;font-size:12px}
            .log-card-actions button{min-height:26px;padding:0 10px;font-size:10px;box-shadow:var(--studio-neu-shadow-button-soft)}
            .logs-toolbar button:hover:not(:disabled),.log-card-actions button:hover:not(:disabled){background:var(--studio-neu-button-fill-hover);box-shadow:var(--studio-neu-shadow-button-soft);transform:translateY(-1px)}
            .logs-toolbar button:active:not(:disabled),.log-card-actions button:active:not(:disabled){background:var(--studio-neu-button-fill-active);box-shadow:var(--studio-neu-shadow-button-pressed);transform:translateY(0)}
            .logs-count{font-size:11px;color:var(--studio-neu-muted);font-weight:600}
            .logs-grid{min-height:0;overflow:auto;padding:4px;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:18px;align-content:start}
            .logs-empty{display:grid;place-items:center;min-height:100%;padding:24px;color:var(--studio-neu-muted);text-align:center;background:transparent;border:none;border-radius:0;box-shadow:none}
            .logs-empty strong{color:var(--studio-neu-text)}
            .log-card{position:relative;display:grid;grid-template-rows:auto auto minmax(0,1fr) auto;gap:12px;min-height:260px;padding:16px;border-radius:22px}
            .log-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:0}
            .log-card-title{display:flex;flex-direction:column;gap:5px;min-width:0}
            .log-card-title strong{font-size:14px;line-height:1.2;font-weight:700}
            .log-card-meta{display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:var(--studio-neu-muted);font-weight:600}
            .log-status-chip{display:inline-flex;align-items:center;justify-content:center;min-width:62px;min-height:24px;padding:0 10px;font-size:10px;text-transform:uppercase;letter-spacing:.08em;background:var(--studio-neu-surface);border:none;border-radius:999px;box-shadow:var(--studio-neu-shadow-inset-soft);font-weight:700}
            .log-status-chip[data-status="active"]{color:var(--studio-warning)}
            .log-status-chip[data-status="success"]{color:var(--studio-success)}
            .log-status-chip[data-status="warning"]{color:var(--studio-warning)}
            .log-status-chip[data-status="error"]{color:var(--studio-danger)}
            .log-progress{height:8px;background:var(--studio-neu-surface);box-shadow:var(--studio-neu-shadow-inset-soft);position:relative;border-radius:999px;overflow:hidden}
            .log-progress-fill{height:100%;background:linear-gradient(180deg,color-mix(in srgb, var(--studio-accent) 68%, white 32%) 0%,var(--studio-accent) 100%);width:0%;border-radius:999px}
            .log-progress.is-hidden{visibility:hidden;height:0}
            .log-card-actions{display:flex;gap:8px}
            .log-lines{min-height:0;overflow:auto;padding:8px 0 0;display:flex;flex-direction:column;gap:10px;background:transparent;box-shadow:none;margin:0;border:none;border-radius:0}
            .log-line{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:start;font-size:11px;line-height:1.4}
            .log-line-time{color:var(--studio-neu-muted);white-space:nowrap;font-weight:600}
            .log-line-text{min-width:0;color:var(--studio-neu-text);word-break:break-word}
            .log-line-meta{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
            .log-line-repeat{display:inline-flex;align-items:center;justify-content:center;min-height:18px;padding:0 8px;background:var(--studio-neu-button-fill);color:var(--studio-neu-text);font-size:10px;font-weight:700;border-radius:999px;box-shadow:var(--studio-neu-shadow-button-soft)}
            .log-line[data-level="warning"] .log-line-text{color:var(--studio-warning);font-weight:700}
            .log-line[data-level="error"] .log-line-text{color:var(--studio-danger);font-weight:700}
            .log-line[data-level="success"] .log-line-text{color:var(--studio-success);font-weight:700}
            .log-card-footer{padding:0 2px 2px;font-size:10px;color:var(--studio-neu-muted);border:none;font-weight:600}
            .logs-flash-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:4}
            .logs-flash{position:absolute;inset:0;pointer-events:none}
            .logs-flash-bloom{position:absolute;left:var(--logs-flash-x);top:var(--logs-flash-y);width:34vmax;height:34vmax;border-radius:999px;transform:translate(-50%,-50%) scale(.12);filter:blur(2px)}
            .logs-flash-tint{position:absolute;inset:0;opacity:0}
            .logs-flash.is-success .logs-flash-bloom{background:radial-gradient(circle, color-mix(in srgb, var(--studio-success) 40%, transparent) 0%, color-mix(in srgb, var(--studio-success) 20%, transparent) 26%, color-mix(in srgb, var(--studio-neu-surface) 10%, transparent) 48%, transparent 74%);animation:logs-flash-bloom 900ms cubic-bezier(.18,.72,.22,.98) forwards}
            .logs-flash.is-success .logs-flash-tint{background:color-mix(in srgb, var(--studio-success) 10%, transparent);animation:logs-flash-tint 820ms ease-out forwards}
            .logs-flash.is-error .logs-flash-bloom{background:radial-gradient(circle, color-mix(in srgb, var(--studio-danger) 40%, transparent) 0%, color-mix(in srgb, var(--studio-danger) 20%, transparent) 26%, color-mix(in srgb, var(--studio-neu-surface) 10%, transparent) 48%, transparent 74%);animation:logs-flash-bloom 900ms cubic-bezier(.18,.72,.22,.98) forwards}
            .logs-flash.is-error .logs-flash-tint{background:color-mix(in srgb, var(--studio-danger) 10%, transparent);animation:logs-flash-tint 820ms ease-out forwards}
            .log-card.is-success-flash{animation:logs-card-success 1100ms ease-out}
            .log-card.is-error-flash{animation:logs-card-error 1100ms ease-out}
            @keyframes logs-flash-bloom{
                0%{opacity:0;transform:translate(-50%,-50%) scale(.12)}
                20%{opacity:1}
                100%{opacity:0;transform:translate(-50%,-50%) scale(5.2)}
            }
            @keyframes logs-flash-tint{
                0%{opacity:0}
                18%{opacity:1}
                100%{opacity:0}
            }
            @keyframes logs-card-success{
                0%{background:var(--studio-neu-surface);box-shadow:var(--studio-neu-shadow-card);}
                22%{background:color-mix(in srgb, var(--studio-neu-surface) 78%, var(--studio-success) 22%);box-shadow:var(--studio-neu-shadow-card), inset 0 0 0 2px color-mix(in srgb, var(--studio-success) 32%, transparent),0 0 28px color-mix(in srgb, var(--studio-success) 18%, transparent)}
                100%{background:var(--studio-neu-surface);box-shadow:var(--studio-neu-shadow-card);}
            }
            @keyframes logs-card-error{
                0%{background:var(--studio-neu-surface);box-shadow:var(--studio-neu-shadow-card);}
                22%{background:color-mix(in srgb, var(--studio-neu-surface) 80%, var(--studio-danger) 20%);box-shadow:var(--studio-neu-shadow-card), inset 0 0 0 2px color-mix(in srgb, var(--studio-danger) 32%, transparent),0 0 26px color-mix(in srgb, var(--studio-danger) 18%, transparent)}
                100%{background:var(--studio-neu-surface);box-shadow:var(--studio-neu-shadow-card);}
            }
            @media (max-width: 720px){
                .logs-toolbar{align-items:flex-start;flex-direction:column}
                .logs-toolbar-actions{width:100%;justify-content:space-between}
                .logs-grid{grid-template-columns:1fr;padding:4px}
            }
        </style>
        <section class="logs-shell">
            <div class="logs-flash-layer" data-logs-role="flash-layer"></div>
            <header class="logs-toolbar">
                <div class="logs-toolbar-actions">
                    <span class="logs-count" data-logs-role="count">0 processes</span>
                    <button type="button" data-logs-action="clear-all">Clear All</button>
                </div>
            </header>
            <div class="logs-grid" data-logs-role="grid"></div>
        </section>
    `;

    const refs = {
        shell: root.querySelector('.logs-shell'),
        grid: root.querySelector('[data-logs-role="grid"]'),
        count: root.querySelector('[data-logs-role="count"]'),
        flashLayer: root.querySelector('[data-logs-role="flash-layer"]')
    };

    let active = false;
    let pendingRender = false;
    let renderQueued = false;
    let snapshot = Array.isArray(logger?.getSnapshot?.()) ? logger.getSnapshot() : [];
    let completionQueue = [];
    let panelSettings = normalizePanelSettings(settings);

    function render() {
        renderQueued = false;
        pendingRender = false;
        const sourceProcesses = Array.isArray(snapshot) ? snapshot : [];
        const filteredProcesses = sourceProcesses
            .map((process) => {
                const entries = filterEntries(process.entries || [], panelSettings.levelFilter);
                if (panelSettings.levelFilter === 'warnings-errors' && !entries.length) {
                    return null;
                }
                return {
                    ...process,
                    entries,
                    lastMessage: entries.length
                        ? entries[entries.length - 1]?.message || process.lastMessage || ''
                        : process.lastMessage || ''
                };
            })
            .filter(Boolean);
        const processes = panelSettings.maxUiCards > 0
            ? filteredProcesses.slice(0, panelSettings.maxUiCards)
            : filteredProcesses;
        if (refs.count) {
            const suffix = processes.length === 1 ? '' : 'es';
            refs.count.textContent = processes.length !== sourceProcesses.length
                ? `${processes.length}/${sourceProcesses.length} visible process${suffix}`
                : `${processes.length} process${suffix}`;
        }
        if (!refs.grid) return;
        if (!processes.length) {
            refs.grid.innerHTML = `
                <div class="logs-empty">
                    <div>
                        <strong>No process cards yet.</strong><br>
                        Run a task to populate this view.
                    </div>
                </div>
            `;
            return;
        }
        refs.grid.innerHTML = processes.map((process) => {
            const progress = process.progress == null ? null : Math.max(0, Math.min(1, Number(process.progress) || 0));
            const displayEntries = panelSettings.compactMessages
                ? compactEntries(process.entries || [])
                : (process.entries || []).map((entry) => ({
                    ...entry,
                    count: 1,
                    firstTimestamp: entry.timestamp,
                    lastTimestamp: entry.timestamp
                }));
            const lines = displayEntries.slice().reverse().map((entry) => `
                <div class="log-line" data-level="${escapeHtml(entry.level || 'info')}">
                    <span class="log-line-time">${escapeHtml(
                        entry.count > 1
                            ? `${formatTime(entry.firstTimestamp)} - ${formatTime(entry.lastTimestamp)}`
                            : formatTime(entry.firstTimestamp || entry.timestamp)
                    )}</span>
                    <span class="log-line-text">
                        <span class="log-line-meta">
                            <span>${escapeHtml(entry.message || '')}</span>
                            ${entry.count > 1 ? `<span class="log-line-repeat">x${escapeHtml(entry.count)}</span>` : ''}
                        </span>
                    </span>
                </div>
            `).join('');
            return `
                <article class="log-card" data-log-process-id="${escapeHtml(process.id)}">
                    <div class="log-card-header">
                        <div class="log-card-title">
                            <strong>${escapeHtml(process.label || process.id)}</strong>
                            <div class="log-card-meta">
                                <span>${escapeHtml(process.counts?.total || 0)} line${process.counts?.total === 1 ? '' : 's'}</span>
                                <span>${escapeHtml(formatTime(process.updatedAt))}</span>
                                ${process.counts?.warning ? `<span>${escapeHtml(process.counts.warning)} warning${process.counts.warning === 1 ? '' : 's'}</span>` : ''}
                                ${process.counts?.error ? `<span>${escapeHtml(process.counts.error)} error${process.counts.error === 1 ? '' : 's'}</span>` : ''}
                            </div>
                        </div>
                        <div style="display:flex;align-items:flex-start;gap:8px;">
                            <span class="log-status-chip" data-status="${escapeHtml(process.status || 'idle')}">${escapeHtml(formatStatusLabel(process.status))}</span>
                            <div class="log-card-actions">
                                <button type="button" data-logs-action="download-process">Download TXT</button>
                                <button type="button" data-logs-action="clear-process">Clear</button>
                            </div>
                        </div>
                    </div>
                    <div class="log-progress ${progress == null ? 'is-hidden' : ''}">
                        <div class="log-progress-fill" style="width:${progress == null ? 0 : Math.round(progress * 100)}%"></div>
                    </div>
                    <div class="log-lines">${lines}</div>
                    <div class="log-card-footer">${escapeHtml(process.lastMessage || '')}</div>
                </article>
            `;
        }).join('');
        drainCompletionQueue();
    }

    function triggerCardFlash(processId, tone) {
        if (!processId) return;
        const card = refs.grid?.querySelector(`[data-log-process-id="${CSS.escape(processId)}"]`);
        if (!card) return;
        const className = tone === 'error' ? 'is-error-flash' : 'is-success-flash';
        card.classList.remove('is-success-flash', 'is-error-flash');
        void card.offsetWidth;
        card.classList.add(className);
        setTimeout(() => {
            card.classList.remove(className);
        }, 1200);
    }

    function spawnScreenFlash(processId, tone) {
        if (!refs.flashLayer || !refs.grid || !refs.shell) return;
        const card = refs.grid.querySelector(`[data-log-process-id="${CSS.escape(processId)}"]`);
        if (!card) return;
        const shellRect = refs.shell.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const x = Math.round(cardRect.left - shellRect.left + (cardRect.width / 2));
        const y = Math.round(cardRect.top - shellRect.top + (cardRect.height / 2));
        const flash = root.ownerDocument.createElement('div');
        flash.className = `logs-flash ${tone === 'error' ? 'is-error' : 'is-success'}`;
        flash.style.setProperty('--logs-flash-x', `${x}px`);
        flash.style.setProperty('--logs-flash-y', `${y}px`);
        flash.innerHTML = `
            <div class="logs-flash-tint"></div>
            <div class="logs-flash-bloom"></div>
        `;
        refs.flashLayer.appendChild(flash);
        setTimeout(() => {
            flash.remove();
        }, 980);
    }

    function playCompletionEffect(event) {
        if (!panelSettings.completionFlashEffects) return;
        const tone = event?.status === 'error' ? 'error' : event?.status === 'success' ? 'success' : '';
        if (!tone || !event?.processId) return;
        spawnScreenFlash(event.processId, tone);
        triggerCardFlash(event.processId, tone);
    }

    function drainCompletionQueue() {
        if (!active || !completionQueue.length) return;
        const queued = completionQueue.slice();
        completionQueue = [];
        queued.forEach((event) => {
            playCompletionEffect(event);
        });
    }

    function scheduleRender() {
        if (!active) {
            pendingRender = true;
            return;
        }
        if (renderQueued) return;
        renderQueued = true;
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(render);
            return;
        }
        setTimeout(render, 0);
    }

    const unsubscribe = logger?.subscribe?.((nextSnapshot) => {
        snapshot = Array.isArray(nextSnapshot) ? nextSnapshot : [];
        scheduleRender();
    }) || (() => {});
    const unsubscribeEvents = logger?.subscribeEvents?.((event) => {
        if (!active || !event?.completed) return;
        if (event.status !== 'success' && event.status !== 'error') return;
        completionQueue.push(event);
        scheduleRender();
    }) || (() => {});

    root.addEventListener('click', (event) => {
        const actionNode = event.target.closest('[data-logs-action]');
        if (!actionNode) return;
        const action = actionNode.dataset.logsAction || '';
        const processCard = actionNode.closest('[data-log-process-id]');
        const processId = processCard?.dataset.logProcessId || '';
        if (action === 'clear-all') {
            logger?.clearAll?.();
            return;
        }
        if (!processId) return;
        if (action === 'clear-process') {
            logger?.clearProcess?.(processId);
            return;
        }
        if (action === 'download-process') {
            const text = logger?.exportProcessText?.(processId) || '';
            if (!text) return;
            const safeStem = processId.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'process-log';
            downloadTextFile(text, `${safeStem}.txt`);
        }
    });

    return {
        activate() {
            active = true;
            root.style.display = 'block';
            if (pendingRender || !refs.grid?.childElementCount) {
                render();
            } else {
                drainCompletionQueue();
            }
        },
        deactivate() {
            active = false;
            root.style.display = 'none';
            completionQueue = [];
        },
        destroy() {
            unsubscribe();
            unsubscribeEvents();
        },
        setSettings(nextSettings = {}) {
            panelSettings = normalizePanelSettings(nextSettings);
            scheduleRender();
        },
        handleLogEvent(event) {
            if (!active || !event?.completed) return;
            if (event.status !== 'success' && event.status !== 'error') return;
            completionQueue.push(event);
            scheduleRender();
        }
    };
}
