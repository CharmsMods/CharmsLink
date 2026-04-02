const STYLE_KEY = 'data-shared-progress-overlay-style';

function injectStyles(doc) {
    if (!doc || doc.querySelector(`[${STYLE_KEY}]`)) return;
    const style = doc.createElement('style');
    style.setAttribute(STYLE_KEY, '');
    style.textContent = `
        .shared-progress-overlay{
            position:absolute;
            inset:0;
            z-index:var(--shared-progress-z, 5);
            display:none;
            align-items:center;
            justify-content:center;
            padding:18px;
            background:var(--shared-progress-backdrop, rgba(8, 10, 14, 0.52));
            pointer-events:none;
        }
        .shared-progress-overlay.is-active{
            display:flex;
        }
        .shared-progress-overlay[data-blocking="true"]{
            pointer-events:auto;
        }
        .shared-progress-overlay-card{
            min-width:min(320px, 100%);
            max-width:min(520px, 100%);
            display:flex;
            flex-direction:column;
            gap:10px;
            padding:14px 16px;
            border:1px solid var(--shared-progress-border, rgba(255,255,255,0.16));
            background:var(--shared-progress-panel, rgba(10, 10, 10, 0.94));
            color:var(--shared-progress-text, #f5f1e8);
            box-shadow:0 18px 34px rgba(0,0,0,0.26);
        }
        .shared-progress-overlay-head{
            display:flex;
            align-items:center;
            gap:12px;
        }
        .shared-progress-overlay-spinner{
            width:16px;
            height:16px;
            flex:0 0 auto;
            border-radius:50%;
            border:2px solid var(--shared-progress-spinner-track, rgba(255,255,255,0.18));
            border-top-color:var(--shared-progress-accent, rgba(255,223,168,0.92));
            animation:shared-progress-spin 0.8s linear infinite;
        }
        .shared-progress-overlay-copy{
            display:flex;
            flex-direction:column;
            gap:4px;
            min-width:0;
        }
        .shared-progress-overlay-title{
            font-size:13px;
            font-weight:600;
            line-height:1.2;
        }
        .shared-progress-overlay-message{
            font-size:11px;
            line-height:1.45;
            color:var(--shared-progress-muted, rgba(245,241,232,0.72));
            overflow-wrap:anywhere;
        }
        .shared-progress-overlay-progress{
            display:flex;
            flex-direction:column;
            gap:6px;
        }
        .shared-progress-overlay-progress.is-hidden{
            display:none;
        }
        .shared-progress-overlay-progress-track{
            position:relative;
            width:100%;
            height:6px;
            overflow:hidden;
            border:1px solid var(--shared-progress-border-soft, rgba(255,255,255,0.12));
            background:var(--shared-progress-track, rgba(255,255,255,0.08));
        }
        .shared-progress-overlay-progress-fill{
            position:absolute;
            inset:0 auto 0 0;
            width:0%;
            background:var(--shared-progress-fill, linear-gradient(90deg, rgba(255,223,168,0.26), rgba(255,223,168,0.9)));
            transition:width 180ms ease;
        }
        .shared-progress-overlay-progress-label{
            font-size:10px;
            color:var(--shared-progress-muted, rgba(245,241,232,0.72));
            letter-spacing:0.04em;
            text-transform:uppercase;
        }
        @keyframes shared-progress-spin{
            from{transform:rotate(0deg)}
            to{transform:rotate(360deg)}
        }
    `;
    doc.head.appendChild(style);
}

function clamp01(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.min(1, Math.max(0, numeric));
}

export function createProgressOverlayController(host, options = {}) {
    if (!host) {
        return {
            show() {},
            hide() {},
            set() {},
            getState() {
                return { active: false };
            }
        };
    }

    const doc = host.ownerDocument || document;
    injectStyles(doc);

    const computedPosition = typeof getComputedStyle === 'function'
        ? getComputedStyle(host).position
        : '';
    if (!computedPosition || computedPosition === 'static') {
        host.style.position = 'relative';
    }

    const overlay = doc.createElement('div');
    overlay.className = 'shared-progress-overlay';
    overlay.dataset.blocking = 'false';
    if (options.zIndex != null) {
        overlay.style.setProperty('--shared-progress-z', String(options.zIndex));
    }
    if (options.backdrop) {
        overlay.style.setProperty('--shared-progress-backdrop', options.backdrop);
    }
    if (options.panelBackground) {
        overlay.style.setProperty('--shared-progress-panel', options.panelBackground);
    }
    if (options.borderColor) {
        overlay.style.setProperty('--shared-progress-border', options.borderColor);
    }
    if (options.borderSoftColor) {
        overlay.style.setProperty('--shared-progress-border-soft', options.borderSoftColor);
    }
    if (options.textColor) {
        overlay.style.setProperty('--shared-progress-text', options.textColor);
    }
    if (options.mutedColor) {
        overlay.style.setProperty('--shared-progress-muted', options.mutedColor);
    }
    if (options.spinnerTrackColor) {
        overlay.style.setProperty('--shared-progress-spinner-track', options.spinnerTrackColor);
    }
    if (options.accentColor) {
        overlay.style.setProperty('--shared-progress-accent', options.accentColor);
    }
    if (options.progressFill) {
        overlay.style.setProperty('--shared-progress-fill', options.progressFill);
    }

    overlay.innerHTML = `
        <div class="shared-progress-overlay-card">
            <div class="shared-progress-overlay-head">
                <div class="shared-progress-overlay-spinner" aria-hidden="true"></div>
                <div class="shared-progress-overlay-copy">
                    <strong class="shared-progress-overlay-title"></strong>
                    <span class="shared-progress-overlay-message"></span>
                </div>
            </div>
            <div class="shared-progress-overlay-progress is-hidden">
                <div class="shared-progress-overlay-progress-track" aria-hidden="true">
                    <div class="shared-progress-overlay-progress-fill"></div>
                </div>
                <div class="shared-progress-overlay-progress-label"></div>
            </div>
        </div>
    `;

    host.appendChild(overlay);

    const refs = {
        overlay,
        title: overlay.querySelector('.shared-progress-overlay-title'),
        message: overlay.querySelector('.shared-progress-overlay-message'),
        progress: overlay.querySelector('.shared-progress-overlay-progress'),
        progressFill: overlay.querySelector('.shared-progress-overlay-progress-fill'),
        progressLabel: overlay.querySelector('.shared-progress-overlay-progress-label')
    };

    let state = {
        active: false,
        title: String(options.defaultTitle || 'Working'),
        message: String(options.defaultMessage || 'Please wait...'),
        progress: null,
        progressLabel: '',
        blocking: false
    };

    function apply() {
        refs.overlay.classList.toggle('is-active', !!state.active);
        refs.overlay.dataset.blocking = state.blocking ? 'true' : 'false';
        refs.title.textContent = state.title || options.defaultTitle || 'Working';
        refs.message.textContent = state.message || options.defaultMessage || 'Please wait...';

        const progress = state.progress == null ? null : clamp01(state.progress);
        refs.progress.classList.toggle('is-hidden', progress == null);
        refs.progressFill.style.width = `${Math.round((progress == null ? 0 : progress) * 100)}%`;
        refs.progressLabel.textContent = progress == null
            ? ''
            : (state.progressLabel || `${Math.round(progress * 100)}%`);
    }

    function set(nextState = {}) {
        state = {
            ...state,
            ...nextState,
            active: !!nextState.active
        };
        if (!state.active) {
            state = {
                ...state,
                progress: null,
                progressLabel: '',
                blocking: false
            };
        }
        apply();
    }

    function show(nextState = {}) {
        set({ ...nextState, active: true });
    }

    function hide() {
        set({ active: false });
    }

    apply();

    return {
        show,
        hide,
        set,
        getState() {
            return { ...state };
        }
    };
}
