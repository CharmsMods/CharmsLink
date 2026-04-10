const DEFAULT_TEXT_CONTENT = 'Text';
const DEFAULT_FONT_FAMILY = 'Arial';
const DEFAULT_FONT_SIZE = 96;
const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_TEXT_OPACITY = 1;
const DEFAULT_TEXT_ROTATION = 0;

export const EDITOR_TEXT_FONT_OPTIONS = [
    'Arial',
    'Helvetica',
    'Verdana',
    'Tahoma',
    'Trebuchet MS',
    'Georgia',
    'Times New Roman',
    'Garamond',
    'Courier New',
    'Impact',
    'Brush Script MT',
    'system-ui'
];

let measurementCanvas = null;
let measurementContext = null;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function roundValue(value, decimals = 3) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const factor = 10 ** decimals;
    return Math.round(numeric * factor) / factor;
}

function normalizeHexColor(value, fallback = DEFAULT_TEXT_COLOR) {
    const raw = String(value || '').trim();
    if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
    if (/^[0-9a-fA-F]{6}$/.test(raw)) return `#${raw.toLowerCase()}`;
    return fallback;
}

function getMeasurementContext() {
    if (measurementContext) return measurementContext;
    if (typeof OffscreenCanvas === 'function') {
        measurementCanvas = new OffscreenCanvas(1, 1);
        measurementContext = measurementCanvas.getContext('2d');
        return measurementContext;
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        measurementCanvas = document.createElement('canvas');
        measurementCanvas.width = 1;
        measurementCanvas.height = 1;
        measurementContext = measurementCanvas.getContext('2d');
        return measurementContext;
    }
    return null;
}

export function normalizeEditorTextParams(params = {}) {
    const textContent = String(params.textContent ?? DEFAULT_TEXT_CONTENT).replace(/\r\n/g, '\n');
    return {
        textContent: textContent.length ? textContent : DEFAULT_TEXT_CONTENT,
        textFontFamily: String(params.textFontFamily || DEFAULT_FONT_FAMILY).trim() || DEFAULT_FONT_FAMILY,
        textFontSize: clamp(Math.round(Number(params.textFontSize) || DEFAULT_FONT_SIZE), 4, 4096),
        textColor: normalizeHexColor(params.textColor, DEFAULT_TEXT_COLOR),
        textOpacity: clamp(Number(params.textOpacity ?? DEFAULT_TEXT_OPACITY), 0, 1),
        textRotation: roundValue(Number(params.textRotation) || DEFAULT_TEXT_ROTATION, 3),
        textX: roundValue(Number(params.textX) || 0),
        textY: roundValue(Number(params.textY) || 0)
    };
}

export function measureEditorTextLayout(params = {}) {
    const normalized = normalizeEditorTextParams(params);
    const lines = normalized.textContent.split('\n');
    const ctx = getMeasurementContext();
    let width = 0;
    let ascent = normalized.textFontSize * 0.8;
    let descent = normalized.textFontSize * 0.2;

    if (ctx) {
        ctx.font = `${normalized.textFontSize}px "${normalized.textFontFamily}"`;
        for (const line of lines) {
            const metrics = ctx.measureText(line || ' ');
            width = Math.max(width, Number(metrics.width) || 0);
            ascent = Math.max(ascent, Number(metrics.actualBoundingBoxAscent) || 0);
            descent = Math.max(descent, Number(metrics.actualBoundingBoxDescent) || 0);
        }
    } else {
        width = Math.max(...lines.map((line) => Math.max(1, line.length) * normalized.textFontSize * 0.62), normalized.textFontSize * 0.62);
    }

    const lineHeight = Math.max(normalized.textFontSize * 1.2, ascent + descent, 1);
    return {
        ...normalized,
        width: Math.max(1, roundValue(Math.ceil(width || (normalized.textFontSize * 0.62)))),
        height: Math.max(1, roundValue(Math.ceil(lineHeight * Math.max(1, lines.length)))),
        ascent: roundValue(ascent),
        descent: roundValue(descent),
        lineHeight: roundValue(lineHeight),
        lines
    };
}

export function getEditorTextBounds(params = {}) {
    const layout = measureEditorTextLayout(params);
    return {
        x: layout.textX,
        y: layout.textY,
        width: layout.width,
        height: layout.height,
        right: layout.textX + layout.width,
        bottom: layout.textY + layout.height
    };
}

export function drawEditorTextToCanvas(canvas, params = {}) {
    if (!canvas) return null;
    const layout = measureEditorTextLayout(params);
    canvas.width = Math.max(1, Math.ceil(layout.width));
    canvas.height = Math.max(1, Math.ceil(layout.height));
    const context = canvas.getContext('2d', { alpha: true });
    if (!context) return layout;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = `${layout.textFontSize}px "${layout.textFontFamily}"`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    context.fillStyle = layout.textColor;
    layout.lines.forEach((line, index) => {
        const baselineY = layout.ascent + (index * layout.lineHeight);
        context.fillText(line || ' ', 0, baselineY);
    });
    return layout;
}
