import { renderLayer, renderMaskPreview, renderNoiseSourcePreview } from './executors/index.js';

function getPreviewResolution(context, runtime) {
    const candidate = context?.outputResolution || context?.resolution || runtime?.initialRes || { w: 1, h: 1 };
    return {
        w: Math.max(1, Number(candidate.w) || 1),
        h: Math.max(1, Number(candidate.h) || 1)
    };
}

function snapshotPreviewRuntime(runtime) {
    return {
        currentPool: runtime.currentPool,
        renderWidth: runtime.renderWidth,
        renderHeight: runtime.renderHeight,
        sourcePlacement: runtime.sourcePlacement ? { ...runtime.sourcePlacement } : null,
        fbos: {
            tempNoise: runtime.fbos.tempNoise,
            blur1: runtime.fbos.blur1,
            blur2: runtime.fbos.blur2,
            preview: runtime.fbos.preview,
            chainCapture: runtime.fbos.chainCapture,
            maskTotal: runtime.fbos.maskTotal
        },
        textures: {
            tempNoise: runtime.textures.tempNoise,
            blur1: runtime.textures.blur1,
            blur2: runtime.textures.blur2,
            preview: runtime.textures.preview,
            chainCapture: runtime.textures.chainCapture,
            maskTotal: runtime.textures.maskTotal
        }
    };
}

function restorePreviewRuntime(engine, snapshot) {
    const { runtime } = engine;
    runtime.currentPool = snapshot.currentPool;
    runtime.renderWidth = snapshot.renderWidth;
    runtime.renderHeight = snapshot.renderHeight;
    runtime.sourcePlacement = snapshot.sourcePlacement ? { ...snapshot.sourcePlacement } : runtime.sourcePlacement;
    runtime.fbos.tempNoise = snapshot.fbos.tempNoise;
    runtime.fbos.blur1 = snapshot.fbos.blur1;
    runtime.fbos.blur2 = snapshot.fbos.blur2;
    runtime.fbos.preview = snapshot.fbos.preview;
    runtime.fbos.chainCapture = snapshot.fbos.chainCapture;
    runtime.fbos.maskTotal = snapshot.fbos.maskTotal;
    runtime.textures.tempNoise = snapshot.textures.tempNoise;
    runtime.textures.blur1 = snapshot.textures.blur1;
    runtime.textures.blur2 = snapshot.textures.blur2;
    runtime.textures.preview = snapshot.textures.preview;
    runtime.textures.chainCapture = snapshot.textures.chainCapture;
    runtime.textures.maskTotal = snapshot.textures.maskTotal;
}

function renderWithSelectedLayerPool(engine, context, task) {
    const { runtime } = engine;
    const { gl } = runtime;
    if (!context?.pool || !gl) return runtime.textures.black;

    const snapshot = snapshotPreviewRuntime(runtime);
    const resolution = getPreviewResolution(context, runtime);

    try {
        engine.updateFixedPoolRefs(context.pool);
        runtime.renderWidth = resolution.w;
        runtime.renderHeight = resolution.h;
        if (context.outputPlacement) {
            runtime.sourcePlacement = { ...context.outputPlacement };
        }
        gl.viewport(0, 0, resolution.w, resolution.h);
        return task(gl, runtime) || runtime.textures.black;
    } finally {
        restorePreviewRuntime(engine, snapshot);
    }
}

function createTextureView(key, label, resolution, getTexture) {
    return { key, label, resolution, getTexture };
}

function createChangedPixelsView(key, label, resolution, draw) {
    return { key, label, resolution, draw };
}

function renderSelectedLayerOutput(engine, context, documentState) {
    return renderWithSelectedLayerPool(
        engine,
        context,
        (gl, runtime) => {
            renderLayer(
                gl,
                runtime,
                context.layerDef,
                context.instance,
                context.inputTex,
                context.pool.preview.fbo,
                documentState,
                {
                    force: true,
                    inputResolution: context.resolution
                }
            );
            return context.pool.preview.tex;
        }
    );
}

function buildStandardTextureViews(engine, documentState, context, config = {}) {
    const resolution = getPreviewResolution(context, engine.runtime);
    const views = [...(config.leadingViews || [])];

    views.push(createTextureView(
        config.outputKey || 'layer-output',
        config.outputLabel || 'Layer Output',
        resolution,
        () => renderSelectedLayerOutput(engine, context, documentState)
    ));

    views.push(createChangedPixelsView(
        config.changeKey || 'changed-pixels',
        config.changeLabel || 'Changed Pixels',
        resolution,
        (canvas) => {
            const processedTexture = renderSelectedLayerOutput(engine, context, documentState);
            engine.drawChangedPixelsPreview(context.inputTex, processedTexture, canvas, resolution);
        }
    ));

    if (config.includeMask ?? !!context.layerDef.mask) {
        views.push(createTextureView(
            config.maskKey || 'effect-mask',
            config.maskLabel || 'Effect Mask',
            resolution,
            () => renderWithSelectedLayerPool(
                engine,
                context,
                (gl, runtime) => renderMaskPreview(gl, runtime, context.layerDef, context.instance, context.inputTex, documentState) || runtime.textures.white
            )
        ));
    }

    return views;
}

function buildNoisePreviewViews(engine, documentState, context) {
    const resolution = getPreviewResolution(context, engine.runtime);
    return buildStandardTextureViews(engine, documentState, context, {
        leadingViews: [
            createTextureView(
                'noise-isolated',
                'Isolated Noise',
                resolution,
                () => renderWithSelectedLayerPool(
                    engine,
                    context,
                    (gl, runtime) => renderNoiseSourcePreview(gl, runtime, context.instance, documentState)
                )
            ),
            createTextureView(
                'noise-mask',
                'Noise Mask',
                resolution,
                () => renderWithSelectedLayerPool(
                    engine,
                    context,
                    (gl, runtime) => renderMaskPreview(gl, runtime, context.layerDef, context.instance, context.inputTex, documentState) || runtime.textures.white
                )
            )
        ],
        outputLabel: 'Noise Composite',
        changeLabel: 'Changed Pixels',
        includeMask: false
    });
}

function buildBlurPreviewViews(engine, documentState, context) {
    return buildStandardTextureViews(engine, documentState, context, {
        changeLabel: 'Blurred Pixels',
        includeMask: true
    });
}

function buildHankelBlurPreviewViews(engine, documentState, context) {
    return buildStandardTextureViews(engine, documentState, context, {
        outputLabel: 'Hankel Output',
        changeLabel: 'Blurred Pixels',
        includeMask: true
    });
}

function buildTiltShiftPreviewViews(engine, documentState, context) {
    return buildStandardTextureViews(engine, documentState, context, {
        outputLabel: 'Tilt-Shift Output',
        changeLabel: 'Focus Falloff'
    });
}

function buildBilateralPreviewViews(engine, documentState, context) {
    return buildStandardTextureViews(engine, documentState, context, {
        outputLabel: 'Filtered Output',
        changeLabel: 'Edge-Preserving Change',
        includeMask: true
    });
}

function buildDenoisePreviewViews(engine, documentState, context) {
    return buildStandardTextureViews(engine, documentState, context, {
        outputLabel: 'Denoised Output',
        changeLabel: 'Removed Noise',
        includeMask: true
    });
}

const LAYER_PREVIEW_PROVIDERS = {
    noise: buildNoisePreviewViews,
    blur: buildBlurPreviewViews,
    hankelBlur: buildHankelBlurPreviewViews,
    tiltShiftBlur: buildTiltShiftPreviewViews,
    bilateral: buildBilateralPreviewViews,
    denoise: buildDenoisePreviewViews
};

export function getLayerPreviewViews(engine, documentState, context = engine.runtime.selectedLayerContext) {
    if (!context?.layerDef?.layerId) return [];
    const provider = LAYER_PREVIEW_PROVIDERS[context.layerDef.layerId];
    return provider ? provider(engine, documentState, context) : [];
}
