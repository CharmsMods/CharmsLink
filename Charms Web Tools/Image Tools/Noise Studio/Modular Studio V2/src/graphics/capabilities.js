function createProbeCanvas() {
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        return document.createElement('canvas');
    }
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(1, 1);
    }
    return null;
}

function getContextWithName(canvas, name) {
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    try {
        const context = canvas.getContext(name, {
            alpha: true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false,
            premultipliedAlpha: false
        });
        return context ? { context, name } : null;
    } catch (_error) {
        return null;
    }
}

export function detectGraphicsCapabilities() {
    const fallback = {
        webglAvailable: false,
        webgl2Available: false,
        maxTextureSize: 0,
        maxRenderbufferSize: 0,
        maxViewportWidth: 0,
        maxViewportHeight: 0,
        gpuSafeMaxEdge: 0
    };
    const canvas = createProbeCanvas();
    const resolved = getContextWithName(canvas, 'webgl2')
        || getContextWithName(canvas, 'webgl')
        || getContextWithName(canvas, 'experimental-webgl');
    if (!resolved?.context) {
        return fallback;
    }
    const gl = resolved.context;
    const maxTextureSize = Math.max(0, Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 0);
    const maxRenderbufferSize = Math.max(0, Number(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE)) || 0);
    const viewportDims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const maxViewportWidth = Math.max(0, Number(Array.isArray(viewportDims) ? viewportDims[0] : viewportDims?.[0]) || 0);
    const maxViewportHeight = Math.max(0, Number(Array.isArray(viewportDims) ? viewportDims[1] : viewportDims?.[1]) || 0);
    const finiteLimits = [maxTextureSize, maxRenderbufferSize, maxViewportWidth, maxViewportHeight].filter((value) => value > 0);
    const loseContext = gl.getExtension?.('WEBGL_lose_context');
    loseContext?.loseContext?.();
    return {
        webglAvailable: true,
        webgl2Available: resolved.name === 'webgl2',
        maxTextureSize,
        maxRenderbufferSize,
        maxViewportWidth,
        maxViewportHeight,
        gpuSafeMaxEdge: finiteLimits.length ? Math.min(...finiteLimits) : 0
    };
}
