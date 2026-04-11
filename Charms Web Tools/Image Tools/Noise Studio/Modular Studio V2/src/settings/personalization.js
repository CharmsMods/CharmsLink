const HEX_COLOR_PATTERN = /^#([0-9a-f]{6})$/i;

export const DEFAULT_PERSONALIZATION_PALETTES = Object.freeze({
    light: Object.freeze({
        page: '#dcdcdc',
        surface: '#e0e0e0',
        surfaceSoft: '#ececec',
        text: '#2f2f2f',
        muted: '#666666',
        accent: '#4f72dd',
        success: '#296b46',
        warning: '#8d6517',
        danger: '#9f3939'
    }),
    dark: Object.freeze({
        page: '#262626',
        surface: '#2b2b2b',
        surfaceSoft: '#333333',
        text: '#f3f3f3',
        muted: '#c3c3c3',
        accent: '#b3c3ff',
        success: '#9fddb4',
        warning: '#f3d08d',
        danger: '#ffb4b4'
    })
});

const ROOT_PERSONALIZATION_VARIABLES = [
    '--bg',
    '--bg-soft',
    '--bg-muted',
    '--line',
    '--line-soft',
    '--text',
    '--muted',
    '--overlay'
];

const APP_SHELL_PERSONALIZATION_VARIABLES = [
    '--studio-neu-page',
    '--studio-neu-surface',
    '--studio-neu-surface-soft',
    '--studio-neu-text',
    '--studio-neu-muted',
    '--studio-neu-button-fill',
    '--studio-neu-button-fill-hover',
    '--studio-neu-button-fill-active',
    '--studio-neu-shadow-card',
    '--studio-neu-shadow-header',
    '--studio-neu-shadow-button',
    '--studio-neu-shadow-button-soft',
    '--studio-neu-shadow-button-pressed',
    '--studio-neu-shadow-inset',
    '--studio-neu-shadow-inset-soft',
    '--studio-accent',
    '--studio-success',
    '--studio-warning',
    '--studio-danger'
];

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toByte(value) {
    return clamp(Math.round(Number(value) || 0), 0, 255);
}

function hexToRgb(value, fallback = '#000000') {
    const normalized = normalizeHexColor(value, fallback).slice(1);
    return {
        r: Number.parseInt(normalized.slice(0, 2), 16),
        g: Number.parseInt(normalized.slice(2, 4), 16),
        b: Number.parseInt(normalized.slice(4, 6), 16)
    };
}

function rgbToHex({ r = 0, g = 0, b = 0 } = {}) {
    return `#${[toByte(r), toByte(g), toByte(b)].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}

function mixHex(base, target, weight = 0.5) {
    const safeWeight = clamp(Number(weight) || 0, 0, 1);
    const source = hexToRgb(base);
    const next = hexToRgb(target);
    return rgbToHex({
        r: source.r + ((next.r - source.r) * safeWeight),
        g: source.g + ((next.g - source.g) * safeWeight),
        b: source.b + ((next.b - source.b) * safeWeight)
    });
}

function withAlpha(color, alpha = 1) {
    const { r, g, b } = hexToRgb(color);
    return `rgba(${r}, ${g}, ${b}, ${clamp(Number(alpha) || 0, 0, 1).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')})`;
}

function buildShadowPair(offset, blur, dark, light) {
    return `${offset}px ${offset}px ${blur}px ${dark}, -${offset}px -${offset}px ${blur}px ${light}`;
}

function buildInsetShadowPair(offset, blur, dark, light) {
    return `inset ${offset}px ${offset}px ${blur}px ${dark}, inset -${offset}px -${offset}px ${blur}px ${light}`;
}

function buildPageGradient(page, theme = 'light') {
    if (theme === 'dark') {
        const glowStrong = withAlpha(mixHex(page, '#ffffff', 0.26), 0.72);
        const glowSoft = withAlpha(mixHex(page, '#ffffff', 0.14), 0.34);
        const top = mixHex(page, '#ffffff', 0.12);
        const bottom = mixHex(page, '#000000', 0.16);
        return `radial-gradient(circle at top left, ${glowStrong} 0%, ${glowSoft} 24%, rgba(0, 0, 0, 0) 44%), linear-gradient(180deg, ${top} 0%, ${bottom} 100%)`;
    }
    const glowStrong = withAlpha(mixHex(page, '#ffffff', 0.58), 0.88);
    const glowSoft = withAlpha(mixHex(page, '#ffffff', 0.32), 0.48);
    const top = mixHex(page, '#ffffff', 0.08);
    const bottom = mixHex(page, '#000000', 0.04);
    return `radial-gradient(circle at top left, ${glowStrong} 0%, ${glowSoft} 24%, rgba(255, 255, 255, 0) 44%), linear-gradient(180deg, ${top} 0%, ${bottom} 100%)`;
}

function buildThemeVariables(palette, theme = 'light') {
    const isDark = theme === 'dark';
    const page = normalizeHexColor(palette?.page, DEFAULT_PERSONALIZATION_PALETTES[theme].page);
    const surface = normalizeHexColor(palette?.surface, DEFAULT_PERSONALIZATION_PALETTES[theme].surface);
    const surfaceSoft = normalizeHexColor(palette?.surfaceSoft, DEFAULT_PERSONALIZATION_PALETTES[theme].surfaceSoft);
    const text = normalizeHexColor(palette?.text, DEFAULT_PERSONALIZATION_PALETTES[theme].text);
    const muted = normalizeHexColor(palette?.muted, DEFAULT_PERSONALIZATION_PALETTES[theme].muted);
    const accent = normalizeHexColor(palette?.accent, DEFAULT_PERSONALIZATION_PALETTES[theme].accent);
    const success = normalizeHexColor(palette?.success, DEFAULT_PERSONALIZATION_PALETTES[theme].success);
    const warning = normalizeHexColor(palette?.warning, DEFAULT_PERSONALIZATION_PALETTES[theme].warning);
    const danger = normalizeHexColor(palette?.danger, DEFAULT_PERSONALIZATION_PALETTES[theme].danger);

    const buttonFill = `linear-gradient(145deg, ${mixHex(surface, '#ffffff', isDark ? 0.1 : 0.24)} 0%, ${mixHex(surface, '#000000', isDark ? 0.12 : 0.03)} 100%)`;
    const buttonFillHover = `linear-gradient(145deg, ${mixHex(surface, '#ffffff', isDark ? 0.14 : 0.3)} 0%, ${mixHex(surface, '#000000', isDark ? 0.08 : 0.01)} 100%)`;
    const buttonFillActive = `linear-gradient(145deg, ${mixHex(surface, '#000000', isDark ? 0.12 : 0.08)} 0%, ${mixHex(surface, '#ffffff', isDark ? 0.12 : 0.08)} 100%)`;

    return {
        '--bg': surface,
        '--bg-soft': surfaceSoft,
        '--bg-muted': mixHex(surface, surfaceSoft, 0.5),
        '--line': mixHex(page, text, isDark ? 0.62 : 0.68),
        '--line-soft': mixHex(page, muted, isDark ? 0.44 : 0.36),
        '--text': text,
        '--muted': muted,
        '--overlay': withAlpha(page, isDark ? 0.9 : 0.88),
        '--studio-neu-page': buildPageGradient(page, theme),
        '--studio-neu-surface': surface,
        '--studio-neu-surface-soft': surfaceSoft,
        '--studio-neu-text': text,
        '--studio-neu-muted': muted,
        '--studio-neu-button-fill': buttonFill,
        '--studio-neu-button-fill-hover': buttonFillHover,
        '--studio-neu-button-fill-active': buttonFillActive,
        '--studio-neu-shadow-card': buildShadowPair(
            12,
            28,
            mixHex(surface, '#000000', isDark ? 0.42 : 0.14),
            mixHex(surface, '#ffffff', isDark ? 0.14 : 0.92)
        ),
        '--studio-neu-shadow-header': buildShadowPair(
            8,
            18,
            mixHex(surface, '#000000', isDark ? 0.36 : 0.11),
            mixHex(surface, '#ffffff', isDark ? 0.12 : 0.88)
        ),
        '--studio-neu-shadow-button': buildShadowPair(
            5,
            12,
            mixHex(surface, '#000000', isDark ? 0.34 : 0.11),
            mixHex(surface, '#ffffff', isDark ? 0.12 : 0.84)
        ),
        '--studio-neu-shadow-button-soft': buildShadowPair(
            3,
            8,
            mixHex(surface, '#000000', isDark ? 0.28 : 0.09),
            mixHex(surface, '#ffffff', isDark ? 0.12 : 0.8)
        ),
        '--studio-neu-shadow-button-pressed': buildInsetShadowPair(
            3,
            7,
            mixHex(surface, '#000000', isDark ? 0.28 : 0.08),
            mixHex(surface, '#ffffff', isDark ? 0.12 : 0.72)
        ),
        '--studio-neu-shadow-inset': buildInsetShadowPair(
            7,
            14,
            mixHex(surface, '#000000', isDark ? 0.34 : 0.1),
            mixHex(surface, '#ffffff', isDark ? 0.12 : 0.78)
        ),
        '--studio-neu-shadow-inset-soft': buildInsetShadowPair(
            3,
            7,
            mixHex(surface, '#000000', isDark ? 0.3 : 0.08),
            mixHex(surface, '#ffffff', isDark ? 0.12 : 0.7)
        ),
        '--studio-accent': accent,
        '--studio-success': success,
        '--studio-warning': warning,
        '--studio-danger': danger
    };
}

function clearVariables(element, variableNames = []) {
    if (!element) return;
    variableNames.forEach((name) => element.style.removeProperty(name));
}

function applyVariables(element, variables = {}) {
    if (!element) return;
    Object.entries(variables).forEach(([name, value]) => {
        element.style.setProperty(name, value);
    });
}

export function normalizeHexColor(value, fallback = '#000000') {
    const normalized = String(value || '').trim();
    if (HEX_COLOR_PATTERN.test(normalized)) return normalized.toLowerCase();
    return String(fallback || '#000000').trim().toLowerCase();
}

export function createDefaultPersonalizationSettings() {
    return {
        enabled: false,
        light: { ...DEFAULT_PERSONALIZATION_PALETTES.light },
        dark: { ...DEFAULT_PERSONALIZATION_PALETTES.dark }
    };
}

export function normalizePersonalizationPalette(source = {}, defaults = DEFAULT_PERSONALIZATION_PALETTES.light) {
    return {
        page: normalizeHexColor(source.page, defaults.page),
        surface: normalizeHexColor(source.surface, defaults.surface),
        surfaceSoft: normalizeHexColor(source.surfaceSoft, defaults.surfaceSoft),
        text: normalizeHexColor(source.text, defaults.text),
        muted: normalizeHexColor(source.muted, defaults.muted),
        accent: normalizeHexColor(source.accent, defaults.accent),
        success: normalizeHexColor(source.success, defaults.success),
        warning: normalizeHexColor(source.warning, defaults.warning),
        danger: normalizeHexColor(source.danger, defaults.danger)
    };
}

export function normalizePersonalizationSettings(source = {}) {
    const defaults = createDefaultPersonalizationSettings();
    const light = source?.light && typeof source.light === 'object' ? source.light : {};
    const dark = source?.dark && typeof source.dark === 'object' ? source.dark : {};
    return {
        enabled: source?.enabled === true,
        light: normalizePersonalizationPalette(light, defaults.light),
        dark: normalizePersonalizationPalette(dark, defaults.dark)
    };
}

export function getPersonalizationPalette(settings = {}, theme = 'light') {
    const personalization = normalizePersonalizationSettings(settings?.personalization || settings || {});
    return theme === 'dark' ? personalization.dark : personalization.light;
}

export function applyPersonalizationTheme(settings = {}, options = {}) {
    const root = options.root || document.documentElement;
    const appShell = options.appShell || document.querySelector('.app-shell');
    const personalization = normalizePersonalizationSettings(settings?.personalization || settings || {});

    if (!personalization.enabled) {
        clearVariables(root, ROOT_PERSONALIZATION_VARIABLES);
        clearVariables(appShell, APP_SHELL_PERSONALIZATION_VARIABLES);
        return;
    }

    const theme = settings?.general?.theme === 'dark' ? 'dark' : 'light';
    const variables = buildThemeVariables(theme === 'dark' ? personalization.dark : personalization.light, theme);
    applyVariables(root, Object.fromEntries(ROOT_PERSONALIZATION_VARIABLES.map((name) => [name, variables[name]])));
    applyVariables(appShell, Object.fromEntries(APP_SHELL_PERSONALIZATION_VARIABLES.map((name) => [name, variables[name]])));
}
