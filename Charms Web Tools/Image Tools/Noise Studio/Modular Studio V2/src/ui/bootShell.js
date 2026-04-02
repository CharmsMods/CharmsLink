const STAGE_PROGRESS = {
    'boot shell': 0.12,
    'registry bootstrap': 0.32,
    'workspace init': 0.58,
    'editor engine init': 0.82,
    'background warmup': 0.96
};

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function createBootShell(root, options = {}) {
    if (!root) {
        return {
            setStage() {},
            destroy() {}
        };
    }

    root.innerHTML = `
        <div class="boot-shell">
            <div class="boot-shell-card">
                <div class="boot-shell-eyebrow">${escapeHtml(options.eyebrow || 'Modular Studio V2')}</div>
                <h1 class="boot-shell-title">${escapeHtml(options.title || 'Starting workspace')}</h1>
                <p class="boot-shell-detail" id="bootShellDetail">${escapeHtml(options.detail || 'Preparing the app shell...')}</p>
                <div class="boot-shell-progress">
                    <div class="boot-shell-progress-fill" id="bootShellProgressFill"></div>
                </div>
                <div class="boot-shell-stage" id="bootShellStage">boot shell</div>
            </div>
        </div>
    `;

    const stageEl = root.querySelector('#bootShellStage');
    const detailEl = root.querySelector('#bootShellDetail');
    const progressFillEl = root.querySelector('#bootShellProgressFill');

    function setStage(stage, detail = '') {
        if (stageEl) stageEl.textContent = stage;
        if (detailEl && detail) detailEl.textContent = detail;
        if (progressFillEl) {
            const progress = STAGE_PROGRESS[stage] ?? 0.08;
            progressFillEl.style.width = `${Math.round(progress * 100)}%`;
        }
    }

    return {
        setStage,
        destroy() {
            root.innerHTML = '';
        }
    };
}
