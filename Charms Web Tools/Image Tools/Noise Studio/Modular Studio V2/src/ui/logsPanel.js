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

export function createLogsPanel(root, { logger = null } = {}) {
    root.innerHTML = `
        <style data-logs-panel-style>
            .logs-shell{position:relative;height:100%;min-height:0;display:grid;grid-template-rows:auto minmax(0,1fr);background:#090909;color:#f5f1e8;overflow:hidden}
            .logs-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid rgba(255,255,255,0.08);background:#111}
            .logs-title-block{display:flex;flex-direction:column;gap:3px}
            .logs-eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:rgba(245,241,232,.62)}
            .logs-title{margin:0;font-size:20px;line-height:1}
            .logs-subtitle{font-size:11px;color:rgba(245,241,232,.64)}
            .logs-toolbar-actions{display:flex;align-items:center;gap:8px}
            .logs-toolbar button{min-height:28px;padding:0 10px;border:1px solid rgba(255,255,255,0.16);background:#141414;color:#f5f1e8;border-radius:0;cursor:pointer}
            .logs-toolbar button:hover{background:#1b1b1b}
            .logs-count{font-size:11px;color:rgba(245,241,232,.64)}
            .logs-grid{min-height:0;overflow:auto;padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px;align-content:start}
            .logs-empty{display:grid;place-items:center;min-height:100%;padding:24px;color:rgba(245,241,232,.6);text-align:center;border:1px solid rgba(255,255,255,0.08);background:#0e0e0e}
            .log-card{position:relative;display:grid;grid-template-rows:auto auto minmax(0,1fr);min-height:260px;border:1px solid rgba(255,255,255,0.1);background:#101010}
            .log-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:12px 12px 10px;border-bottom:1px solid rgba(255,255,255,0.08)}
            .log-card-title{display:flex;flex-direction:column;gap:5px;min-width:0}
            .log-card-title strong{font-size:14px;line-height:1.2}
            .log-card-meta{display:flex;flex-wrap:wrap;gap:8px;font-size:10px;color:rgba(245,241,232,.62)}
            .log-status-chip{display:inline-flex;align-items:center;justify-content:center;min-width:62px;min-height:22px;padding:0 8px;border:1px solid rgba(255,255,255,0.12);font-size:10px;text-transform:uppercase;letter-spacing:.08em;background:#151515}
            .log-status-chip[data-status="active"]{border-color:rgba(255,223,168,.4);color:#ffe3a8}
            .log-status-chip[data-status="success"]{border-color:rgba(154,255,205,.36);color:#9affcd}
            .log-status-chip[data-status="warning"]{border-color:rgba(255,198,128,.42);color:#ffc680}
            .log-status-chip[data-status="error"]{border-color:rgba(255,145,145,.42);color:#ff9191}
            .log-progress{height:6px;background:#181818;border-bottom:1px solid rgba(255,255,255,0.08)}
            .log-progress-fill{height:100%;background:#f5f1e8;width:0%}
            .log-progress.is-hidden{visibility:hidden}
            .log-card-actions{display:flex;gap:6px}
            .log-card-actions button{min-height:24px;padding:0 8px;border:1px solid rgba(255,255,255,0.14);background:#161616;color:#f5f1e8;border-radius:0;cursor:pointer;font-size:10px}
            .log-card-actions button:hover{background:#1c1c1c}
            .log-lines{min-height:0;overflow:auto;padding:10px 12px 12px;display:flex;flex-direction:column;gap:8px}
            .log-line{display:grid;grid-template-columns:auto 1fr;gap:8px;align-items:start;font-size:11px;line-height:1.35}
            .log-line-time{color:rgba(245,241,232,.46);white-space:nowrap}
            .log-line-text{min-width:0;color:#f5f1e8;word-break:break-word}
            .log-line-meta{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}
            .log-line-repeat{display:inline-flex;align-items:center;justify-content:center;min-height:16px;padding:0 6px;border:1px solid rgba(255,255,255,0.12);background:#171717;color:rgba(245,241,232,.72);font-size:10px;letter-spacing:.04em;text-transform:uppercase}
            .log-line[data-level="warning"] .log-line-text{color:#ffd39a}
            .log-line[data-level="error"] .log-line-text{color:#ffb0b0}
            .log-line[data-level="success"] .log-line-text{color:#aff4c6}
            .log-card-footer{padding:0 12px 12px;font-size:10px;color:rgba(245,241,232,.58)}
            .logs-flash-layer{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:4}
            .logs-flash{position:absolute;inset:0;pointer-events:none}
            .logs-flash-bloom{position:absolute;left:var(--logs-flash-x);top:var(--logs-flash-y);width:34vmax;height:34vmax;border-radius:999px;transform:translate(-50%,-50%) scale(.12);filter:blur(2px)}
            .logs-flash-tint{position:absolute;inset:0;opacity:0}
            .logs-flash.is-success .logs-flash-bloom{background:radial-gradient(circle, rgba(82,214,142,.76) 0%, rgba(82,214,142,.44) 26%, rgba(255,226,170,.22) 48%, rgba(82,214,142,0) 74%);animation:logs-flash-bloom 900ms cubic-bezier(.18,.72,.22,.98) forwards}
            .logs-flash.is-success .logs-flash-tint{background:rgba(72,186,122,.18);animation:logs-flash-tint 820ms ease-out forwards}
            .logs-flash.is-error .logs-flash-bloom{background:radial-gradient(circle, rgba(245,94,94,.74) 0%, rgba(245,94,94,.42) 26%, rgba(255,188,188,.18) 48%, rgba(245,94,94,0) 74%);animation:logs-flash-bloom 900ms cubic-bezier(.18,.72,.22,.98) forwards}
            .logs-flash.is-error .logs-flash-tint{background:rgba(186,72,72,.16);animation:logs-flash-tint 820ms ease-out forwards}
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
                0%{background:#101010;border-color:rgba(255,255,255,.1);box-shadow:0 0 0 rgba(255,220,140,0)}
                22%{background:rgba(255,236,196,.16);border-color:rgba(255,223,168,.92);box-shadow:0 0 0 1px rgba(255,223,168,.26),0 0 28px rgba(255,223,168,.16)}
                100%{background:#101010;border-color:rgba(255,255,255,.1);box-shadow:0 0 0 rgba(255,220,140,0)}
            }
            @keyframes logs-card-error{
                0%{background:#101010;border-color:rgba(255,255,255,.1);box-shadow:0 0 0 rgba(255,124,124,0)}
                22%{background:rgba(255,166,166,.12);border-color:rgba(255,145,145,.9);box-shadow:0 0 0 1px rgba(255,145,145,.18),0 0 26px rgba(255,120,120,.14)}
                100%{background:#101010;border-color:rgba(255,255,255,.1);box-shadow:0 0 0 rgba(255,124,124,0)}
            }
            @media (max-width: 720px){
                .logs-toolbar{align-items:flex-start;flex-direction:column}
                .logs-grid{grid-template-columns:1fr;padding:12px}
            }
        </style>
        <section class="logs-shell">
            <div class="logs-flash-layer" data-logs-role="flash-layer"></div>
            <header class="logs-toolbar">
                <div class="logs-title-block">
                    <div class="logs-eyebrow">Process Monitor</div>
                    <h2 class="logs-title">Logs</h2>
                    <div class="logs-subtitle">Process cards track save, sync, load, render, and workspace activity across the whole site.</div>
                </div>
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

    function render() {
        renderQueued = false;
        pendingRender = false;
        const processes = Array.isArray(snapshot) ? snapshot : [];
        if (refs.count) {
            refs.count.textContent = `${processes.length} process${processes.length === 1 ? '' : 'es'}`;
        }
        if (!refs.grid) return;
        if (!processes.length) {
            refs.grid.innerHTML = `
                <div class="logs-empty">
                    <div>
                        <strong>No process cards yet.</strong><br>
                        Open Library, switch workspaces, save, load, import, or render to populate the Logs tab.
                    </div>
                </div>
            `;
            return;
        }
        refs.grid.innerHTML = processes.map((process) => {
            const progress = process.progress == null ? null : Math.max(0, Math.min(1, Number(process.progress) || 0));
            const compactedEntries = compactEntries(process.entries || []);
            const lines = compactedEntries.slice().reverse().map((entry) => `
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
        handleLogEvent(event) {
            if (!active || !event?.completed) return;
            if (event.status !== 'success' && event.status !== 'error') return;
            completionQueue.push(event);
            scheduleRender();
        }
    };
}
