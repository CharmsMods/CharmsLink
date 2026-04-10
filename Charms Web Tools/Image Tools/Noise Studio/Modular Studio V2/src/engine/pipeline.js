import { bootstrapEngine } from './bootstrap.js';
import { renderLayer, renderMaskPreview, renderPreviewTexture } from './executors/index.js';
import { updateHistogram, updateVectorscope, updateParade } from '../analysis/scopes.js';
import { hasRenderableLayers } from '../state/documentHelpers.js';
import { getLayerPreviewViews } from './layerPreviewProviders.js';
import { applyCropTransformToPlacement, getCropTransformMetrics } from './cropTransformShared.js';

function createTexture(gl, source, width, height, highPrecision = false) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const internalFormat = highPrecision ? gl.RGBA16F : gl.SRGB8_ALPHA8;
    const format = gl.RGBA;
    const type = highPrecision ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    if (source && (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement || source instanceof ImageBitmap)) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, format, type, source);
    } else {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, source || null);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    }
    return texture;
}

function createFramebuffer(gl, texture) {
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    return fbo;
}

function makeFbo(gl, width, height, highPrecision = true) {
    const tex = createTexture(gl, null, width, height, highPrecision);
    return { tex, fbo: createFramebuffer(gl, tex) };
}

function clampScale(width, height, maxDim) {
    if (width <= maxDim && height <= maxDim) return 1;
    return Math.min(maxDim / width, maxDim / height);
}

function getSelectedBreakdownItems(layerDef) {
    const items = [];
    if (layerDef?.mask) {
        items.push({ key: 'mask', label: 'Mask' });
    }
    if (layerDef?.layerId === 'ca') {
        items.push({ key: 'falloff', label: 'Falloff' });
    }
    return items;
}

function drawImageContained(ctx, image, width, height) {
    ctx.clearRect(0, 0, width, height);
    if (!image || width <= 0 || height <= 0) return;

    const imageAspect = image.width / image.height;
    const canvasAspect = width / height;
    let drawWidth = width;
    let drawHeight = height;
    let offsetX = 0;
    let offsetY = 0;

    if (imageAspect > canvasAspect) {
        drawHeight = width / imageAspect;
        offsetY = (height - drawHeight) * 0.5;
    } else {
        drawWidth = height * imageAspect;
        offsetX = (width - drawWidth) * 0.5;
    }

    ctx.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

function drawImagePlaced(ctx, image, width, height, placement) {
    ctx.clearRect(0, 0, width, height);
    if (!image || width <= 0 || height <= 0) return;
    if (!placement) {
        drawImageContained(ctx, image, width, height);
        return;
    }
    ctx.drawImage(image, placement.x, placement.y, placement.w, placement.h);
}

function applyAlphaProtection(gl, runtime, inputTex, processedTex, outputFbo, mode) {
    if (!mode) return processedTex;
    const program = runtime.programs.alphaProtect;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_input'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, processedTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_processed'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'u_mode'), mode);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function isCanvasVisible(canvas) {
    if (!canvas) return false;
    if (typeof canvas.getClientRects !== 'function') return true;
    return canvas.getClientRects().length > 0;
}

function isAbortLike(error) {
    return !!error && (
        error.name === 'AbortError'
        || /abort/i.test(String(error?.message || error || ''))
    );
}

export class NoiseStudioEngine {
    constructor(registry, hooks = {}) {
        this.registry = registry;
        this.hooks = hooks;
        this.refs = {};
        this.runtime = {
            registry,
            gl: null,
            programs: {},
            textures: {},
            fbos: {},
            fboPools: {},
            layerResolutions: {},
            layerLayouts: {},
            thumbnailFBO: null,
            analysisFBO: null,
            thumbTempCanvas: null,
            thumbTempCtx: null,
            thumbPixelBuffer: null,
            thumbClampedBuffer: null,
            analysisPixelBuffer: null,
            analysisTempCanvas: null,
            analysisTempCtx: null,
            inputSampleCanvas: null,
            inputSampleCtx: null,
            inputSampleTex: null,
            inputSampleFbo: null,
            inputSampleRawPixels: null,
            inputSampleTopLeftPixels: null,
            inputSampleWidth: 0,
            inputSampleHeight: 0,
            inputSampleCacheKey: '',
            baseImage: null,
            sourceWidth: 1,
            sourceHeight: 1,
            renderWidth: 1,
            renderHeight: 1,
            currentPool: null,
            frameRenderCount: 0,
            lastFrameTime: 0,
            realtimeFps: 0,
            renderRequested: false,
            previewWindow: null,
            selectedLayerContext: null,
            selectedLayerOutput: null,
            timeSeconds: 0,
            initialRes: { w: 1, h: 1 },
            hasRenderableLayers: false,
            sourcePlacement: { x: 0, y: 0, w: 1, h: 1 }
        };
        this.analysisTaskVersion = 0;
        this.analysisAbortController = null;
        this.diffPreviewJobs = new WeakMap();
        this.diffPreviewCanvasKeys = new WeakMap();
        this.diffPreviewCanvasCounter = 0;
    }

    async init(canvas) {
        this.refs.canvas = canvas;
        const { gl, programs } = await bootstrapEngine(canvas, this.registry, {
            onContextLost: () => this.hooks.onNotice?.('GPU context lost. Reload the page to recover.', 'error'),
            onContextRestored: () => this.hooks.onNotice?.('GPU context restored. Rebuild the document to continue.', 'warning')
        });
        this.runtime.gl = gl;
        this.runtime.programs = programs;
        this.runtime.textures.white = createTexture(gl, new Uint8Array([255, 255, 255, 255]), 1, 1, false);
        this.runtime.textures.black = createTexture(gl, new Uint8Array([0, 0, 0, 255]), 1, 1, false);
        this.allocateStaticBuffers();
    }

    attachRefs(refs) {
        this.refs = { ...this.refs, ...refs };
    }

    allocateStaticBuffers() {
        const { gl } = this.runtime;
        const thumb = makeFbo(gl, 320, 320, false);
        this.runtime.thumbnailFBO = { ...thumb, w: 320, h: 320 };
        const analysis = makeFbo(gl, 256, 256, false);
        this.runtime.analysisFBO = { ...analysis, w: 256, h: 256 };
        this.runtime.thumbTempCanvas = document.createElement('canvas');
        this.runtime.thumbTempCanvas.width = 320;
        this.runtime.thumbTempCanvas.height = 320;
        this.runtime.thumbTempCtx = this.runtime.thumbTempCanvas.getContext('2d');
        this.runtime.thumbPixelBuffer = new Uint8Array(320 * 320 * 4);
        this.runtime.thumbClampedBuffer = new Uint8ClampedArray(320 * 320 * 4);
        this.runtime.thumbPixelBufferAlt = new Uint8Array(320 * 320 * 4);
        this.runtime.thumbClampedBufferAlt = new Uint8ClampedArray(320 * 320 * 4);
        this.runtime.thumbCompositeBuffer = new Uint8ClampedArray(320 * 320 * 4);
        this.runtime.analysisTempCanvas = document.createElement('canvas');
        this.runtime.analysisTempCanvas.width = 256;
        this.runtime.analysisTempCanvas.height = 256;
        this.runtime.analysisTempCtx = this.runtime.analysisTempCanvas.getContext('2d', { willReadFrequently: true });
        this.runtime.inputSampleCanvas = document.createElement('canvas');
        this.runtime.inputSampleCanvas.width = 1;
        this.runtime.inputSampleCanvas.height = 1;
        this.runtime.inputSampleCtx = this.runtime.inputSampleCanvas.getContext('2d', { willReadFrequently: true });
        this.runtime.inputSampleTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.runtime.inputSampleTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        this.runtime.inputSampleFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.runtime.inputSampleFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.runtime.inputSampleTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    async loadImageFromFile(file, sourceMeta = {}) {
        const image = await new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = (error) => {
                URL.revokeObjectURL(url);
                reject(error);
            };
            img.src = url;
        });
        await this.loadImage(image, {
            name: file.name,
            type: file.type,
            imageData: sourceMeta.imageData || null
        });
    }

    async loadImage(image, source) {
        const { gl } = this.runtime;
        this.runtime.baseImage = image;
        this.runtime.sourceWidth = image.width;
        this.runtime.sourceHeight = image.height;
        if (this.runtime.textures.base) {
            gl.deleteTexture(this.runtime.textures.base);
        }
        this.runtime.textures.base = createTexture(gl, image);
        this.runtime.fboPools = {};
        this.runtime.layerResolutions = {};
        this.runtime.layerLayouts = {};
        this.runtime.selectedLayerContext = null;
        this.runtime.selectedLayerOutput = null;
        this.hooks.onSourceLoaded?.({
            ...source,
            width: image.width,
            height: image.height
        });
    }

    hasImage() {
        return !!this.runtime.baseImage;
    }

    requestRender(documentState, options = {}) {
        if (!this.runtime.baseImage || this.runtime.renderRequested) return;
        this.runtime.renderRequested = true;
        requestAnimationFrame(() => {
            this.runtime.renderRequested = false;
            this.render(documentState, options);
        });
    }

    getPoolKey(width, height) {
        return `${width}x${height}`;
    }

    ensurePool(width, height) {
        const key = this.getPoolKey(width, height);
        if (!this.runtime.fboPools[key]) {
            const { gl } = this.runtime;
            this.runtime.fboPools[key] = {
                pingPong0: makeFbo(gl, width, height),
                pingPong1: makeFbo(gl, width, height),
                tempNoise: makeFbo(gl, width, height),
                blur1: makeFbo(gl, width, height),
                blur2: makeFbo(gl, width, height),
                preview: makeFbo(gl, width, height),
                chainCapture: makeFbo(gl, width, height),
                maskTotal: makeFbo(gl, width, height),
                writeIdx: 0
            };
        }
        return this.runtime.fboPools[key];
    }

    reallocateBuffers(documentState, fullRes = false) {
        const { gl } = this.runtime;
        const maxTexSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        const previewMax = documentState.view.highQualityPreview ? maxTexSize : Math.min(maxTexSize, 4096);
        const maxDim = fullRes ? maxTexSize : previewMax;

        const baseScale = clampScale(this.runtime.sourceWidth, this.runtime.sourceHeight, maxDim);
        let currentWidthFloat = this.runtime.sourceWidth * baseScale;
        let currentHeightFloat = this.runtime.sourceHeight * baseScale;
        let currentWidth = Math.max(1, Math.round(currentWidthFloat));
        let currentHeight = Math.max(1, Math.round(currentHeightFloat));
        let sourcePlacement = { x: 0, y: 0, w: currentWidthFloat, h: currentHeightFloat };
        this.runtime.initialRes = { w: currentWidth, h: currentHeight };

        const required = new Set([this.getPoolKey(currentWidth, currentHeight)]);
        this.runtime.layerResolutions = {};
        this.runtime.layerLayouts = {};

        for (const instance of documentState.layerStack) {
            if (!instance.visible || !instance.enabled) {
                this.runtime.layerResolutions[instance.instanceId] = { w: currentWidth, h: currentHeight };
                this.runtime.layerLayouts[instance.instanceId] = {
                    canvasWidth: currentWidth,
                    canvasHeight: currentHeight,
                    sourcePlacement: { ...sourcePlacement }
                };
                required.add(this.getPoolKey(currentWidth, currentHeight));
            } else {
                if (instance.layerId === 'scale') {
                    const scale = Math.max(0.1, parseFloat(instance.params.scaleMultiplier || 1));
                    sourcePlacement = {
                        x: sourcePlacement.x * scale,
                        y: sourcePlacement.y * scale,
                        w: sourcePlacement.w * scale,
                        h: sourcePlacement.h * scale
                    };
                    currentWidthFloat *= scale;
                    currentHeightFloat *= scale;
                    const clamp = clampScale(currentWidthFloat, currentHeightFloat, maxDim);
                    sourcePlacement = {
                        x: sourcePlacement.x * clamp,
                        y: sourcePlacement.y * clamp,
                        w: sourcePlacement.w * clamp,
                        h: sourcePlacement.h * clamp
                    };
                    currentWidthFloat *= clamp;
                    currentHeightFloat *= clamp;
                    currentWidth = Math.max(1, Math.round(currentWidthFloat));
                    currentHeight = Math.max(1, Math.round(currentHeightFloat));
                } else if (instance.layerId === 'expander') {
                    const requestedPadding = Math.max(0, Math.round(Number(instance.params.expanderPadding || 0)));
                    const maxPaddingX = Math.max(0, Math.floor((maxDim - currentWidthFloat) * 0.5));
                    const maxPaddingY = Math.max(0, Math.floor((maxDim - currentHeightFloat) * 0.5));
                    const appliedPadding = Math.max(0, Math.min(requestedPadding, maxPaddingX, maxPaddingY));
                    currentWidthFloat += appliedPadding * 2;
                    currentHeightFloat += appliedPadding * 2;
                    sourcePlacement = {
                        x: sourcePlacement.x + appliedPadding,
                        y: sourcePlacement.y + appliedPadding,
                        w: sourcePlacement.w,
                        h: sourcePlacement.h
                    };
                    currentWidth = Math.max(1, Math.round(currentWidthFloat));
                    currentHeight = Math.max(1, Math.round(currentHeightFloat));
                } else if (instance.layerId === 'cropTransform') {
                    const cropMetrics = getCropTransformMetrics(instance.params, currentWidthFloat, currentHeightFloat);
                    sourcePlacement = applyCropTransformToPlacement(sourcePlacement, cropMetrics);
                    currentWidthFloat = cropMetrics.cropWidthFloat;
                    currentHeightFloat = cropMetrics.cropHeightFloat;
                    currentWidth = cropMetrics.outputWidth;
                    currentHeight = cropMetrics.outputHeight;
                }
                this.runtime.layerResolutions[instance.instanceId] = { w: currentWidth, h: currentHeight };
                this.runtime.layerLayouts[instance.instanceId] = {
                    canvasWidth: currentWidth,
                    canvasHeight: currentHeight,
                    sourcePlacement: { ...sourcePlacement }
                };
                required.add(this.getPoolKey(currentWidth, currentHeight));
            }

            if (documentState.view.isolateActiveLayerChain && documentState.selection.layerInstanceId === instance.instanceId) {
                break;
            }
        }

        this.runtime.renderWidth = currentWidth;
        this.runtime.renderHeight = currentHeight;
        this.runtime.sourcePlacement = { ...sourcePlacement };

        [...required].forEach((key) => {
            const [w, h] = key.split('x').map(Number);
            this.ensurePool(w, h);
        });
    }

    updateFixedPoolRefs(pool) {
        this.runtime.currentPool = pool;
        this.runtime.fbos.tempNoise = pool.tempNoise.fbo;
        this.runtime.fbos.blur1 = pool.blur1.fbo;
        this.runtime.fbos.blur2 = pool.blur2.fbo;
        this.runtime.fbos.preview = pool.preview.fbo;
        this.runtime.fbos.chainCapture = pool.chainCapture.fbo;
        this.runtime.fbos.maskTotal = pool.maskTotal.fbo;
        this.runtime.textures.tempNoise = pool.tempNoise.tex;
        this.runtime.textures.blur1 = pool.blur1.tex;
        this.runtime.textures.blur2 = pool.blur2.tex;
        this.runtime.textures.preview = pool.preview.tex;
        this.runtime.textures.chainCapture = pool.chainCapture.tex;
        this.runtime.textures.maskTotal = pool.maskTotal.tex;
    }

    uploadBaseTexture(isExport) {
        const { gl } = this.runtime;
        const { w, h } = this.runtime.initialRes;
        if (!isExport || (w === this.runtime.sourceWidth && h === this.runtime.sourceHeight)) {
            return this.runtime.textures.base;
        }
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = w;
        tempCanvas.height = h;
        tempCanvas.getContext('2d').drawImage(this.runtime.baseImage, 0, 0, w, h);
        return createTexture(gl, tempCanvas);
    }

    syncSourcePreview(width = this.runtime.renderWidth, height = this.runtime.renderHeight) {
        if (!this.refs.sourcePreviewCanvas || !this.runtime.baseImage) return;
        const canvas = this.refs.sourcePreviewCanvas;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        drawImageContained(ctx, this.runtime.baseImage, canvas.width, canvas.height);
    }

    hasVisibleScopeTargets() {
        return isCanvasVisible(this.refs.histogramCanvas)
            || isCanvasVisible(this.refs.vectorscopeCanvas)
            || isCanvasVisible(this.refs.paradeCanvas);
    }

    renderRgbaBufferToCanvas(canvas, rgba, width, height) {
        if (!canvas || !rgba) return;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return;
        const bytes = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
        ctx.putImageData(new ImageData(bytes, width, height), 0, 0);
    }

    applyScopeMetrics(metrics = {}) {
        if (this.refs.avgBrightnessEl && Number.isFinite(metrics.averageBrightness)) {
            this.refs.avgBrightnessEl.textContent = `${Math.round(metrics.averageBrightness)}`;
        }
        if (this.refs.avgSaturationEl && Number.isFinite(metrics.averageSaturation)) {
            this.refs.avgSaturationEl.textContent = `${Math.round(metrics.averageSaturation)}%`;
        }
        if (this.refs.renderResolutionEl && Number.isFinite(metrics.renderWidth) && Number.isFinite(metrics.renderHeight)) {
            this.refs.renderResolutionEl.textContent = `${metrics.renderWidth} x ${metrics.renderHeight}`;
        }
    }

    applyScopeAnalysisResult(result = {}) {
        if (result.histogram) {
            this.renderRgbaBufferToCanvas(
                this.refs.histogramCanvas,
                result.histogram.rgba,
                result.histogram.width,
                result.histogram.height
            );
        }
        if (result.vectorscope) {
            this.renderRgbaBufferToCanvas(
                this.refs.vectorscopeCanvas,
                result.vectorscope.rgba,
                result.vectorscope.width,
                result.vectorscope.height
            );
        }
        if (result.parade) {
            this.renderRgbaBufferToCanvas(
                this.refs.paradeCanvas,
                result.parade.rgba,
                result.parade.width,
                result.parade.height
            );
        }
        this.applyScopeMetrics(result.metrics || {});
    }

    runScopeAnalysisFallback(pixels, width, height) {
        updateHistogram(
            this.refs.histogramCanvas,
            this.refs.avgBrightnessEl,
            this.refs.renderResolutionEl,
            pixels,
            width,
            height,
            this.runtime.renderWidth,
            this.runtime.renderHeight
        );
        updateVectorscope(
            this.refs.vectorscopeCanvas,
            this.refs.avgSaturationEl,
            pixels,
            width,
            height
        );
        updateParade(this.refs.paradeCanvas, pixels, width, height);
    }

    scheduleScopeAnalysis(pixels, width, height) {
        if (!pixels?.length || !this.hasVisibleScopeTargets()) return;
        const payload = {
            pixels,
            width,
            height,
            renderWidth: this.runtime.renderWidth,
            renderHeight: this.runtime.renderHeight,
            histogramWidth: Math.max(1, Number(this.refs.histogramCanvas?.width) || 512),
            histogramHeight: Math.max(1, Number(this.refs.histogramCanvas?.height) || 220),
            vectorscopeWidth: Math.max(1, Number(this.refs.vectorscopeCanvas?.width) || 360),
            vectorscopeHeight: Math.max(1, Number(this.refs.vectorscopeCanvas?.height) || 360),
            paradeWidth: Math.max(1, Number(this.refs.paradeCanvas?.width) || 620),
            paradeHeight: Math.max(1, Number(this.refs.paradeCanvas?.height) || 220)
        };
        const fallback = () => this.runScopeAnalysisFallback(pixels, width, height);
        const version = ++this.analysisTaskVersion;
        this.analysisAbortController?.abort?.();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        this.analysisAbortController = abortController;

        if (typeof this.hooks.computeAnalysisVisuals !== 'function') {
            fallback();
            return;
        }

        this.hooks.computeAnalysisVisuals(payload, {
            signal: abortController?.signal || null,
            priority: 'background',
            processId: 'editor.analysis',
            scope: 'section:editor',
            replaceKey: 'editor-analysis-visuals',
            replaceActive: true
        }).then((result) => {
            if (version !== this.analysisTaskVersion || abortController?.signal?.aborted) return;
            if (!result) {
                fallback();
                return;
            }
            this.applyScopeAnalysisResult(result);
        }).catch((error) => {
            if (version !== this.analysisTaskVersion || abortController?.signal?.aborted || isAbortLike(error)) return;
            fallback();
        });
    }

    getDiffPreviewTaskKey(canvas) {
        if (!canvas) return 'editor-diff-preview';
        let key = this.diffPreviewCanvasKeys.get(canvas);
        if (!key) {
            this.diffPreviewCanvasCounter += 1;
            key = `editor-diff-preview:${this.diffPreviewCanvasCounter}`;
            this.diffPreviewCanvasKeys.set(canvas, key);
        }
        return key;
    }

    applyDiffPreviewResult(canvas, rgba, width, height, aspect) {
        if (!canvas || !rgba) return;
        const bytes = rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba);
        const imageData = new ImageData(bytes, width, height);
        this.runtime.thumbTempCanvas.width = width;
        this.runtime.thumbTempCanvas.height = height;
        this.runtime.thumbTempCtx.putImageData(imageData, 0, 0);
        this.drawThumbnailCanvasToCanvas(canvas, aspect);
    }

    updateScopesFromCanvas(canvas) {
        if (!canvas || !this.refs.histogramCanvas && !this.refs.vectorscopeCanvas && !this.refs.paradeCanvas) return;
        if (!this.hasVisibleScopeTargets()) return;
        const width = this.runtime.analysisFBO.w;
        const height = this.runtime.analysisFBO.h;
        this.runtime.analysisTempCtx.clearRect(0, 0, width, height);
        this.runtime.analysisTempCtx.drawImage(canvas, 0, 0, width, height);
        const imageData = this.runtime.analysisTempCtx.getImageData(0, 0, width, height).data;
        if (!this.runtime.analysisPixelBuffer || this.runtime.analysisPixelBuffer.length !== imageData.length) {
            this.runtime.analysisPixelBuffer = new Uint8Array(imageData.length);
        }
        this.runtime.analysisPixelBuffer.set(imageData);
        this.scheduleScopeAnalysis(this.runtime.analysisPixelBuffer.slice(), width, height);
    }

    getActiveDisplayCanvas() {
        return this.runtime.hasRenderableLayers ? this.refs.canvas : (this.refs.sourcePreviewCanvas || this.refs.canvas);
    }

    getProcessedPreviewResolution() {
        const { gl } = this.runtime;
        return {
            w: Math.max(1, Number(gl?.drawingBufferWidth) || Number(this.refs.canvas?.width) || Number(this.runtime.renderWidth) || 1),
            h: Math.max(1, Number(gl?.drawingBufferHeight) || Number(this.refs.canvas?.height) || Number(this.runtime.renderHeight) || 1)
        };
    }

    getActivePreviewResolution() {
        if (this.runtime.hasRenderableLayers) {
            return this.getProcessedPreviewResolution();
        }
        const canvas = this.refs.sourcePreviewCanvas || this.refs.canvas;
        return {
            w: Math.max(1, Number(canvas?.width) || 1),
            h: Math.max(1, Number(canvas?.height) || 1)
        };
    }

    render(documentState, options = {}) {
        if (!this.runtime.baseImage) return;
        const isExport = !!options.isExport;
        const { gl } = this.runtime;
        this.runtime.timeSeconds = (performance.now() % 100000) / 1000;
        if (!isExport) {
            const now = performance.now();
            if (this.runtime.lastFrameTime > 0) {
                this.runtime.realtimeFps = 1000 / Math.max(1, now - this.runtime.lastFrameTime);
            }
            this.runtime.lastFrameTime = now;
            this.runtime.frameRenderCount += 1;
        }

        this.reallocateBuffers(documentState, isExport);
        this.runtime.hasRenderableLayers = hasRenderableLayers(this.registry, documentState);
        this.runtime.renderWidth = this.runtime.initialRes.w;
        this.runtime.renderHeight = this.runtime.initialRes.h;
        this.runtime.sourcePlacement = {
            x: 0,
            y: 0,
            w: this.runtime.initialRes.w,
            h: this.runtime.initialRes.h
        };

        if (!this.runtime.hasRenderableLayers) {
            this.runtime.selectedLayerContext = null;
            this.runtime.selectedLayerOutput = null;
            this.syncSourcePreview(this.runtime.initialRes.w, this.runtime.initialRes.h);
            if (!isExport) {
                this.updateScopesFromCanvas(this.refs.sourcePreviewCanvas);
                this.updateBreakdown(documentState);
                this.syncPopup();
                this.hooks.onMetrics?.({
                    fps: this.runtime.realtimeFps,
                    renderWidth: this.runtime.renderWidth,
                    renderHeight: this.runtime.renderHeight
                });
            }
            return;
        }

        Object.values(this.runtime.fboPools).forEach((pool) => {
            pool.writeIdx = 0;
        });

        const initialPool = this.ensurePool(this.runtime.initialRes.w, this.runtime.initialRes.h);
        gl.viewport(0, 0, this.runtime.initialRes.w, this.runtime.initialRes.h);
        const baseTex = this.uploadBaseTexture(isExport);
        renderPreviewTexture(gl, { ...this.runtime, currentPool: initialPool }, baseTex, initialPool.pingPong0.fbo, 0);
        if (isExport && baseTex !== this.runtime.textures.base) {
            gl.deleteTexture(baseTex);
        }

        let currentTex = initialPool.pingPong0.tex;
        let currentResolution = { w: this.runtime.initialRes.w, h: this.runtime.initialRes.h };
        let currentPlacement = {
            x: 0,
            y: 0,
            w: this.runtime.initialRes.w,
            h: this.runtime.initialRes.h
        };
        let alphaHandlingMode = 0;
        this.runtime.selectedLayerContext = null;
        this.runtime.selectedLayerOutput = null;

        for (const instance of documentState.layerStack) {
            if (!instance.visible) {
                if (documentState.view.isolateActiveLayerChain && documentState.selection.layerInstanceId === instance.instanceId) break;
                continue;
            }
            const layerDef = this.registry.byId[instance.layerId];
            if (!layerDef) {
                if (documentState.view.isolateActiveLayerChain && documentState.selection.layerInstanceId === instance.instanceId) break;
                continue;
            }
            const resolution = this.runtime.layerResolutions[instance.instanceId] || this.runtime.initialRes;
            const outputPlacement = this.runtime.layerLayouts[instance.instanceId]?.sourcePlacement || currentPlacement;
            const pool = this.ensurePool(resolution.w, resolution.h);
            this.updateFixedPoolRefs(pool);
            this.runtime.renderWidth = resolution.w;
            this.runtime.renderHeight = resolution.h;
            this.runtime.sourcePlacement = outputPlacement;
            gl.viewport(0, 0, resolution.w, resolution.h);

            if (documentState.selection.layerInstanceId === instance.instanceId) {
                this.runtime.selectedLayerContext = {
                    layerDef,
                    instance,
                    inputTex: currentTex,
                    resolution: { ...currentResolution },
                    inputPlacement: { ...currentPlacement },
                    inputCanvasPlacement: {
                        x: 0,
                        y: 0,
                        w: currentResolution.w,
                        h: currentResolution.h
                    },
                    pool
                };
            }

            const outputBuffer = pool.writeIdx === 0 ? pool.pingPong1 : pool.pingPong0;
            const inputTexture = currentTex;
            const inputResolution = { ...currentResolution };
            renderLayer(gl, this.runtime, layerDef, instance, currentTex, outputBuffer.fbo, documentState, {
                inputResolution
            });
            currentTex = outputBuffer.tex;
            if (instance.enabled && layerDef.layerId === 'alpha') {
                alphaHandlingMode = instance.params.alphaExcludeAll
                    ? 2
                    : instance.params.alphaExcludeTransparentOnly
                        ? 1
                        : 0;
            } else if (
                alphaHandlingMode &&
                instance.enabled &&
                !['scale', 'expander', 'alpha'].includes(layerDef.layerId)
            ) {
                applyAlphaProtection(gl, this.runtime, inputTexture, outputBuffer.tex, pool.preview.fbo, alphaHandlingMode);
                currentTex = pool.preview.tex;
            }
            if (this.runtime.selectedLayerContext && instance.enabled) {
                const selectedCanvasPlacement = this.runtime.selectedLayerContext.inputCanvasPlacement;
                if (selectedCanvasPlacement && layerDef.layerId === 'scale') {
                    const scaleX = resolution.w / Math.max(1, inputResolution.w || 1);
                    const scaleY = resolution.h / Math.max(1, inputResolution.h || 1);
                    selectedCanvasPlacement.x *= scaleX;
                    selectedCanvasPlacement.y *= scaleY;
                    selectedCanvasPlacement.w *= scaleX;
                    selectedCanvasPlacement.h *= scaleY;
                } else if (selectedCanvasPlacement && layerDef.layerId === 'expander') {
                    selectedCanvasPlacement.x += Math.max(0, (resolution.w - inputResolution.w) * 0.5);
                    selectedCanvasPlacement.y += Math.max(0, (resolution.h - inputResolution.h) * 0.5);
                } else if (selectedCanvasPlacement && layerDef.layerId === 'cropTransform') {
                    const cropMetrics = getCropTransformMetrics(instance.params, inputResolution.w, inputResolution.h);
                    const scaleX = resolution.w / Math.max(1, cropMetrics.cropWidthFloat);
                    const scaleY = resolution.h / Math.max(1, cropMetrics.cropHeightFloat);
                    selectedCanvasPlacement.x = (selectedCanvasPlacement.x - cropMetrics.leftPx) * scaleX;
                    selectedCanvasPlacement.y = (selectedCanvasPlacement.y - cropMetrics.topPx) * scaleY;
                    selectedCanvasPlacement.w *= scaleX;
                    selectedCanvasPlacement.h *= scaleY;
                }
            }
            currentResolution = { w: resolution.w, h: resolution.h };
            currentPlacement = { ...outputPlacement };
            pool.writeIdx = 1 - pool.writeIdx;

            if (documentState.selection.layerInstanceId === instance.instanceId) {
                renderPreviewTexture(gl, this.runtime, currentTex, pool.chainCapture.fbo, 0);
                this.runtime.selectedLayerOutput = pool.chainCapture.tex;
                this.runtime.selectedLayerContext.outputResolution = { w: resolution.w, h: resolution.h };
                this.runtime.selectedLayerContext.outputPlacement = { ...outputPlacement };
            }

            if (documentState.view.isolateActiveLayerChain && documentState.selection.layerInstanceId === instance.instanceId) {
                break;
            }
        }

        const finalWidth = this.runtime.renderWidth;
        const finalHeight = this.runtime.renderHeight;
        if (this.refs.canvas.width !== finalWidth || this.refs.canvas.height !== finalHeight) {
            this.refs.canvas.width = finalWidth;
            this.refs.canvas.height = finalHeight;
        }
        const previewResolution = this.getProcessedPreviewResolution();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, previewResolution.w, previewResolution.h);
        gl.useProgram(this.runtime.programs.final);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        gl.uniform1i(gl.getUniformLocation(this.runtime.programs.final, 'u_tex'), 0);
        gl.uniform2f(gl.getUniformLocation(this.runtime.programs.final, 'u_res'), previewResolution.w, previewResolution.h);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.flush();

        if (!isExport) {
            this.syncHoverPreview();
            this.updateScopes(currentTex);
            this.updateBreakdown(documentState);
            this.updateSubLayerPreview(documentState);
            this.runtime.renderWidth = finalWidth;
            this.runtime.renderHeight = finalHeight;
            this.syncPopup();
            this.hooks.onMetrics?.({
                fps: this.runtime.realtimeFps,
                renderWidth: finalWidth,
                renderHeight: finalHeight,
                displayWidth: previewResolution.w,
                displayHeight: previewResolution.h
            });
            if (documentState.layerStack.some((instance) => this.registry.byId[instance.layerId]?.animated && instance.enabled && instance.visible)) {
                this.requestRender(documentState);
            }
        } else {
            gl.finish();
        }
    }

    updateScopes(texture) {
        if (!this.refs.histogramCanvas && !this.refs.vectorscopeCanvas && !this.refs.paradeCanvas) return;
        if (!this.hasVisibleScopeTargets()) return;
        const { gl } = this.runtime;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.runtime.analysisFBO.fbo);
        gl.viewport(0, 0, this.runtime.analysisFBO.w, this.runtime.analysisFBO.h);
        renderPreviewTexture(gl, this.runtime, texture, this.runtime.analysisFBO.fbo, 0);
        if (!this.runtime.analysisPixelBuffer) {
            this.runtime.analysisPixelBuffer = new Uint8Array(this.runtime.analysisFBO.w * this.runtime.analysisFBO.h * 4);
        }
        gl.readPixels(0, 0, this.runtime.analysisFBO.w, this.runtime.analysisFBO.h, gl.RGBA, gl.UNSIGNED_BYTE, this.runtime.analysisPixelBuffer);
        this.scheduleScopeAnalysis(
            this.runtime.analysisPixelBuffer.slice(),
            this.runtime.analysisFBO.w,
            this.runtime.analysisFBO.h
        );
    }

    getThumbnailMetrics(resolution = null) {
        const width = Math.max(1, Number(resolution?.w) || this.runtime.renderWidth || 1);
        const height = Math.max(1, Number(resolution?.h) || this.runtime.renderHeight || 1);
        const aspect = width / height;
        let tw = 320;
        let th = 320;
        if (aspect > 1) {
            tw = 320;
            th = Math.max(1, Math.floor(320 / aspect));
        } else {
            tw = Math.max(1, Math.floor(320 * aspect));
            th = 320;
        }
        return { width, height, aspect, tw, th };
    }

    readTextureToThumbnailBuffer(texture, resolution = null, pixelBuffer = this.runtime.thumbPixelBuffer, clampedBuffer = this.runtime.thumbClampedBuffer) {
        if (!texture) return null;
        const { gl } = this.runtime;
        const target = this.runtime.thumbnailFBO;
        const { aspect, tw, th } = this.getThumbnailMetrics(resolution);

        gl.viewport(0, 0, tw, th);
        renderPreviewTexture(gl, this.runtime, texture, target.fbo, 0);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, pixelBuffer);

        for (let y = 0; y < th; y += 1) {
            const srcOffset = (th - 1 - y) * tw * 4;
            const dstOffset = y * tw * 4;
            clampedBuffer.set(pixelBuffer.subarray(srcOffset, srcOffset + tw * 4), dstOffset);
        }

        return { aspect, tw, th };
    }

    drawThumbnailCanvasToCanvas(canvas, aspect) {
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        const canvasAspect = canvas.width / canvas.height;
        let drawW = canvas.width;
        let drawH = canvas.height;
        let offsetX = 0;
        let offsetY = 0;

        if (aspect > canvasAspect) {
            drawH = canvas.width / aspect;
            offsetY = (canvas.height - drawH) * 0.5;
        } else {
            drawW = canvas.height * aspect;
            offsetX = (canvas.width - drawW) * 0.5;
        }

        ctx.drawImage(this.runtime.thumbTempCanvas, 0, 0, this.runtime.thumbTempCanvas.width, this.runtime.thumbTempCanvas.height, offsetX, offsetY, drawW, drawH);
    }

    drawTextureToThumbnail(texture, canvas, resolution = null) {
        if (!canvas || !texture) return;
        const metrics = this.readTextureToThumbnailBuffer(texture, resolution, this.runtime.thumbPixelBuffer, this.runtime.thumbClampedBuffer);
        if (!metrics) return;
        const { aspect, tw, th } = metrics;
        const imageData = new ImageData(new Uint8ClampedArray(this.runtime.thumbClampedBuffer.buffer, 0, tw * th * 4), tw, th);
        this.runtime.thumbTempCanvas.width = tw;
        this.runtime.thumbTempCanvas.height = th;
        this.runtime.thumbTempCtx.putImageData(imageData, 0, 0);
        this.drawThumbnailCanvasToCanvas(canvas, aspect);
    }

    drawChangedPixelsPreview(baseTexture, processedTexture, canvas, resolution = null) {
        if (!canvas || !baseTexture || !processedTexture) return;
        const metrics = this.readTextureToThumbnailBuffer(baseTexture, resolution, this.runtime.thumbPixelBuffer, this.runtime.thumbClampedBuffer);
        if (!metrics) return;
        const { aspect, tw, th } = metrics;
        this.readTextureToThumbnailBuffer(processedTexture, resolution, this.runtime.thumbPixelBufferAlt, this.runtime.thumbClampedBufferAlt);

        const total = tw * th * 4;
        const basePixels = this.runtime.thumbClampedBuffer.slice(0, total);
        const processedPixels = this.runtime.thumbClampedBufferAlt.slice(0, total);
        const fallback = () => {
            for (let offset = 0; offset < total; offset += 4) {
                const baseR = basePixels[offset];
                const baseG = basePixels[offset + 1];
                const baseB = basePixels[offset + 2];
                const nextR = processedPixels[offset];
                const nextG = processedPixels[offset + 1];
                const nextB = processedPixels[offset + 2];

                const baseLuma = (baseR * 0.2126) + (baseG * 0.7152) + (baseB * 0.0722);
                const nextLuma = (nextR * 0.2126) + (nextG * 0.7152) + (nextB * 0.0722);
                const diffMagnitude = Math.sqrt(
                    ((nextR - baseR) * (nextR - baseR))
                    + ((nextG - baseG) * (nextG - baseG))
                    + ((nextB - baseB) * (nextB - baseB))
                ) / 441.67295593;
                const overlayStrength = Math.min(1, diffMagnitude * 3.0);
                const tint = nextLuma >= baseLuma
                    ? [46, 214, 255]
                    : [255, 138, 64];
                const grayscale = Math.max(0, Math.min(255, Math.round((baseLuma * 0.88) + 12)));

                this.runtime.thumbCompositeBuffer[offset] = Math.round(grayscale + ((tint[0] - grayscale) * overlayStrength));
                this.runtime.thumbCompositeBuffer[offset + 1] = Math.round(grayscale + ((tint[1] - grayscale) * overlayStrength));
                this.runtime.thumbCompositeBuffer[offset + 2] = Math.round(grayscale + ((tint[2] - grayscale) * overlayStrength));
                this.runtime.thumbCompositeBuffer[offset + 3] = 255;
            }

            this.applyDiffPreviewResult(
                canvas,
                new Uint8ClampedArray(this.runtime.thumbCompositeBuffer.buffer.slice(0, total)),
                tw,
                th,
                aspect
            );
        };

        const activeJob = this.diffPreviewJobs.get(canvas);
        activeJob?.abortController?.abort?.();
        const abortController = typeof AbortController === 'function' ? new AbortController() : null;
        const job = {
            abortController,
            key: this.getDiffPreviewTaskKey(canvas)
        };
        this.diffPreviewJobs.set(canvas, job);

        if (typeof this.hooks.computeDiffPreview !== 'function') {
            fallback();
            return;
        }

        this.hooks.computeDiffPreview({
            basePixels,
            processedPixels,
            width: tw,
            height: th
        }, {
            signal: abortController?.signal || null,
            priority: 'background',
            processId: 'editor.preview',
            scope: 'section:editor',
            replaceKey: job.key,
            replaceActive: true
        }).then((result) => {
            if (this.diffPreviewJobs.get(canvas) !== job || abortController?.signal?.aborted) return;
            if (!result?.rgba) {
                fallback();
                return;
            }
            this.applyDiffPreviewResult(canvas, result.rgba, result.width || tw, result.height || th, aspect);
        }).catch((error) => {
            if (this.diffPreviewJobs.get(canvas) !== job || abortController?.signal?.aborted || isAbortLike(error)) return;
            fallback();
        });
    }

    syncHoverPreview() {
        if (!this.refs.hoverPreviewCanvas || !this.runtime.baseImage || !this.refs.canvas) return;
        const canvas = this.refs.hoverPreviewCanvas;
        const previewResolution = this.getProcessedPreviewResolution();
        if (canvas.width !== previewResolution.w || canvas.height !== previewResolution.h) {
            canvas.width = previewResolution.w;
            canvas.height = previewResolution.h;
        }
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        drawImagePlaced(ctx, this.runtime.baseImage, canvas.width, canvas.height, this.runtime.sourcePlacement);
    }

    renderCaFalloff(instance, pool) {
        const { gl } = this.runtime;
        const program = this.runtime.programs.radial;
        gl.bindFramebuffer(gl.FRAMEBUFFER, pool.preview.fbo);
        gl.viewport(0, 0, pool.preview.w || this.runtime.renderWidth, pool.preview.h || this.runtime.renderHeight);
        gl.useProgram(program);
        gl.uniform2f(gl.getUniformLocation(program, 'u_res'), this.runtime.renderWidth, this.runtime.renderHeight);
        gl.uniform2f(gl.getUniformLocation(program, 'u_center'), instance.params.caCenterX ?? 0.5, instance.params.caCenterY ?? 0.5);
        gl.uniform1f(gl.getUniformLocation(program, 'u_radius'), parseFloat(instance.params.caRadius || 50) / 1000.0);
        gl.uniform1f(gl.getUniformLocation(program, 'u_falloff'), parseFloat(instance.params.caFalloff || 50) / 1000.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return pool.preview.tex;
    }

    updateBreakdown(documentState) {
        if (!this.refs.breakdownContainer) return;
        if (!this.runtime.selectedLayerContext) {
            this.refs.breakdownContainer.innerHTML = '';
            return;
        }
        const { layerDef, instance, inputTex, resolution, pool } = this.runtime.selectedLayerContext;
        const items = getSelectedBreakdownItems(layerDef);
        const existing = new Map([...this.refs.breakdownContainer.querySelectorAll('[data-breakdown-key]')].map((node) => [node.dataset.breakdownKey, node]));

        items.forEach((item) => {
            if (existing.has(item.key)) return;
            const card = document.createElement('div');
            card.className = 'scope-card breakdown-card';
            card.dataset.breakdownKey = item.key;
            card.innerHTML = `<div class="scope-card-header">${item.label}</div><canvas width="320" height="180"></canvas>`;
            this.refs.breakdownContainer.appendChild(card);
        });

        [...this.refs.breakdownContainer.querySelectorAll('[data-breakdown-key]')].forEach((node) => {
            if (!items.some((item) => item.key === node.dataset.breakdownKey)) {
                node.remove();
            }
        });

        const chainCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"chain\"] canvas');
        if (chainCanvas) this.drawTextureToThumbnail(this.runtime.selectedLayerOutput, chainCanvas);

        this.updateFixedPoolRefs(pool);
        this.runtime.renderWidth = resolution.w;
        this.runtime.renderHeight = resolution.h;
        renderLayer(this.runtime.gl, this.runtime, layerDef, instance, inputTex, pool.preview.fbo, documentState, { force: true });
        const isolatedCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"isolated\"] canvas');
        if (isolatedCanvas) this.drawTextureToThumbnail(pool.preview.tex, isolatedCanvas);

        if (layerDef.mask) {
            const maskTex = renderMaskPreview(this.runtime.gl, this.runtime, layerDef, instance, inputTex, documentState);
            const maskCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"mask\"] canvas');
            this.drawTextureToThumbnail(maskTex || this.runtime.textures.white, maskCanvas);
        }
        if (layerDef.layerId === 'ca') {
            const falloffTex = this.renderCaFalloff(instance, pool);
            const falloffCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"falloff\"] canvas');
            this.drawTextureToThumbnail(falloffTex, falloffCanvas);
        }
    }

    updateSubLayerPreview(documentState) {
        if (!documentState.view.layerPreviewsOpen || !this.runtime.selectedLayerContext || !this.refs.subLayerCanvas) {
            return;
        }

        const canvas = this.refs.subLayerCanvas;
        const label = this.refs.subLayerLabel;
        const availableViews = getLayerPreviewViews(this, documentState, this.runtime.selectedLayerContext);

        if (!availableViews.length) {
            if (label) label.textContent = 'No preview views for this layer yet';
            this.drawTextureToThumbnail(this.runtime.textures.black, canvas);
            return;
        }

        const index = (documentState.view.layerPreviewIndex || 0) % availableViews.length;
        const activeView = availableViews[index];
        if (label) {
            label.textContent = availableViews.length > 1
                ? `${activeView.label} (${index + 1}/${availableViews.length})`
                : activeView.label;
        }
        if (typeof activeView.draw === 'function') {
            activeView.draw(canvas);
            return;
        }
        this.drawTextureToThumbnail(activeView.getTexture?.() || this.runtime.textures.black, canvas, activeView.resolution);
    }

    async exportPngBlob(documentState) {
        if (!hasRenderableLayers(this.registry, documentState)) {
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = this.runtime.sourceWidth;
            exportCanvas.height = this.runtime.sourceHeight;
            const ctx = exportCanvas.getContext('2d');
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(this.runtime.baseImage, 0, 0, exportCanvas.width, exportCanvas.height);
            return new Promise((resolve) => exportCanvas.toBlob(resolve, 'image/png'));
        }
        this.render(documentState, { isExport: true });
        const blob = await new Promise((resolve) => this.refs.canvas.toBlob(resolve, 'image/png'));
        this.render(documentState);
        return blob;
    }

    async openCompare(documentState, refs) {
        const processedLayers = hasRenderableLayers(this.registry, documentState);
        if (processedLayers) {
            this.render(documentState, { isExport: true });
        } else {
            this.runtime.hasRenderableLayers = false;
            this.runtime.renderWidth = this.runtime.sourceWidth;
            this.runtime.renderHeight = this.runtime.sourceHeight;
        }
        const originalCanvas = refs.originalCanvas || refs.compareOriginal;
        const processedCanvas = refs.processedCanvas || refs.compareProcessed;
        const infoEl = refs.infoEl || refs.compareInfo;
        if (!originalCanvas || !processedCanvas) return;
        originalCanvas.width = 640;
        originalCanvas.height = Math.round(640 / (this.runtime.sourceWidth / this.runtime.sourceHeight));
        processedCanvas.width = 640;
        processedCanvas.height = Math.round(640 / (this.runtime.renderWidth / this.runtime.renderHeight));
        originalCanvas.getContext('2d').drawImage(this.runtime.baseImage, 0, 0, originalCanvas.width, originalCanvas.height);
        processedCanvas.getContext('2d').drawImage(processedLayers ? this.getActiveDisplayCanvas() : this.runtime.baseImage, 0, 0, processedCanvas.width, processedCanvas.height);
        if (infoEl) {
            infoEl.textContent = `Base ${this.runtime.sourceWidth} x ${this.runtime.sourceHeight} | Render ${this.runtime.renderWidth} x ${this.runtime.renderHeight}`;
        }
        if (processedLayers) this.render(documentState);
    }

    exportComparison(mode, originalCanvas, processedCanvas) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (mode === 'side') {
            canvas.width = originalCanvas.width + processedCanvas.width;
            canvas.height = Math.max(originalCanvas.height, processedCanvas.height);
            ctx.drawImage(originalCanvas, 0, 0);
            ctx.drawImage(processedCanvas, originalCanvas.width, 0);
        } else {
            canvas.width = Math.max(originalCanvas.width, processedCanvas.width);
            canvas.height = originalCanvas.height + processedCanvas.height;
            ctx.drawImage(originalCanvas, 0, 0);
            ctx.drawImage(processedCanvas, 0, originalCanvas.height);
        }
        const link = document.createElement('a');
        link.download = `noise-studio-compare-${mode}.png`;
        link.href = canvas.toDataURL('image/png', 1.0);
        link.click();
    }

    openPopup() {
        if (this.runtime.previewWindow && !this.runtime.previewWindow.closed) {
            this.runtime.previewWindow.focus();
            return;
        }
        const popup = window.open('', 'NoiseStudioPreview', 'width=1400,height=900');
        if (!popup) {
            this.hooks.onNotice?.('Pop-up blocked. Allow pop-ups to use the detached preview.', 'warning');
            return;
        }
        popup.document.write('<!DOCTYPE html><html><head><title>Noise Studio Preview</title><style>html,body{margin:0;height:100%;background:#fff;display:grid;place-items:center}canvas{max-width:100%;max-height:100%;border:1px solid #111}</style></head><body><canvas id=\"popup-canvas\"></canvas></body></html>');
        popup.document.close();
        this.runtime.previewWindow = popup;
        this.syncPopup();
    }

    syncPopup() {
        if (!this.runtime.previewWindow || this.runtime.previewWindow.closed) {
            this.runtime.previewWindow = null;
            return;
        }
        const popupCanvas = this.runtime.previewWindow.document.getElementById('popup-canvas');
        const sourceCanvas = this.getActiveDisplayCanvas();
        if (!popupCanvas || !sourceCanvas) return;
        popupCanvas.width = sourceCanvas.width;
        popupCanvas.height = sourceCanvas.height;
        popupCanvas.getContext('2d').drawImage(sourceCanvas, 0, 0);
    }

    pickPixelAtUv(u, v) {
        const xRatio = Math.max(0, Math.min(1, u));
        const yRatio = Math.max(0, Math.min(1, v));
        if (!this.runtime.hasRenderableLayers && this.refs.sourcePreviewCanvas) {
            const canvas = this.refs.sourcePreviewCanvas;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(xRatio * canvas.width)));
            const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(yRatio * canvas.height)));
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            return {
                r: pixel[0],
                g: pixel[1],
                b: pixel[2],
                a: pixel[3],
                hex: `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
            };
        }
        const { gl } = this.runtime;
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const previewResolution = this.getProcessedPreviewResolution();
        const x = Math.max(0, Math.min(previewResolution.w - 1, Math.floor(xRatio * previewResolution.w)));
        const y = Math.max(0, Math.min(previewResolution.h - 1, Math.floor((1 - yRatio) * previewResolution.h)));
        const pixel = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return {
            r: pixel[0],
            g: pixel[1],
            b: pixel[2],
            a: pixel[3],
            hex: `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
        };
    }

    getSelectedLayerInputMetrics(instanceId = null) {
        const context = this.runtime.selectedLayerContext;
        if (!context?.inputTex || !context?.resolution) return null;
        if (instanceId && context.instance?.instanceId !== instanceId) return null;

        const width = Math.max(1, context.resolution.w || 1);
        const height = Math.max(1, context.resolution.h || 1);
        return {
            width,
            height,
            inputCanvasPlacement: { ...(context.inputCanvasPlacement || { x: 0, y: 0, w: width, h: height }) },
            finalResolution: this.getProcessedPreviewResolution()
        };
    }

    getLayerInputMetrics(documentState, instanceId) {
        const selectedMetrics = this.getSelectedLayerInputMetrics(instanceId);
        if (selectedMetrics) return selectedMetrics;

        const context = this.getLayerInputSampleContext(documentState, instanceId);
        if (!context?.resolution) return null;

        const width = Math.max(1, context.resolution.w || 1);
        const height = Math.max(1, context.resolution.h || 1);
        return {
            width,
            height,
            inputCanvasPlacement: { ...(context.inputCanvasPlacement || { x: 0, y: 0, w: width, h: height }) },
            finalResolution: {
                w: Math.max(1, context.finalResolution?.w || width),
                h: Math.max(1, context.finalResolution?.h || height)
            }
        };
    }

    ensureInputSampleBuffers(width, height) {
        const safeWidth = Math.max(1, Number(width) || 1);
        const safeHeight = Math.max(1, Number(height) || 1);
        const { gl } = this.runtime;
        if (!gl || !this.runtime.inputSampleTex || !this.runtime.inputSampleFbo) return null;
        if (this.runtime.inputSampleWidth === safeWidth && this.runtime.inputSampleHeight === safeHeight && this.runtime.inputSampleRawPixels && this.runtime.inputSampleTopLeftPixels) {
            return this.runtime;
        }
        this.runtime.inputSampleWidth = safeWidth;
        this.runtime.inputSampleHeight = safeHeight;
        this.runtime.inputSampleCacheKey = '';
        this.runtime.inputSampleRawPixels = new Uint8Array(safeWidth * safeHeight * 4);
        this.runtime.inputSampleTopLeftPixels = new Uint8ClampedArray(safeWidth * safeHeight * 4);
        this.runtime.inputSampleCanvas.width = safeWidth;
        this.runtime.inputSampleCanvas.height = safeHeight;
        gl.bindTexture(gl.TEXTURE_2D, this.runtime.inputSampleTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, safeWidth, safeHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.runtime.inputSampleFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.runtime.inputSampleTex, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return this.runtime;
    }

    refreshInputSampleSnapshot(texture, width, height, cacheKey) {
        const runtime = this.ensureInputSampleBuffers(width, height);
        const { gl } = this.runtime;
        if (!runtime || !gl || !texture) return null;
        if (this.runtime.inputSampleCacheKey === cacheKey) {
            return {
                width: this.runtime.inputSampleWidth,
                height: this.runtime.inputSampleHeight,
                pixels: this.runtime.inputSampleTopLeftPixels,
                canvas: this.runtime.inputSampleCanvas
            };
        }

        gl.viewport(0, 0, this.runtime.inputSampleWidth, this.runtime.inputSampleHeight);
        renderPreviewTexture(gl, this.runtime, texture, this.runtime.inputSampleFbo, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.runtime.inputSampleFbo);
        gl.readPixels(0, 0, this.runtime.inputSampleWidth, this.runtime.inputSampleHeight, gl.RGBA, gl.UNSIGNED_BYTE, this.runtime.inputSampleRawPixels);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        const rowSize = this.runtime.inputSampleWidth * 4;
        for (let y = 0; y < this.runtime.inputSampleHeight; y += 1) {
            const src = (this.runtime.inputSampleHeight - 1 - y) * rowSize;
            const dst = y * rowSize;
            this.runtime.inputSampleTopLeftPixels.set(
                this.runtime.inputSampleRawPixels.subarray(src, src + rowSize),
                dst
            );
        }

        const imageData = new ImageData(this.runtime.inputSampleTopLeftPixels, this.runtime.inputSampleWidth, this.runtime.inputSampleHeight);
        this.runtime.inputSampleCtx.putImageData(imageData, 0, 0);
        this.runtime.inputSampleCacheKey = cacheKey;

        return {
            width: this.runtime.inputSampleWidth,
            height: this.runtime.inputSampleHeight,
            pixels: this.runtime.inputSampleTopLeftPixels,
            canvas: this.runtime.inputSampleCanvas
        };
    }

    getLayerInputPreviewSnapshot(documentState, instanceId = null) {
        const selectedContext = this.runtime.selectedLayerContext;
        const context = selectedContext && (!instanceId || selectedContext.instance?.instanceId === instanceId)
            ? {
                ...selectedContext,
                finalResolution: this.getProcessedPreviewResolution()
            }
            : this.getLayerInputSampleContext(documentState, instanceId);
        if (!context?.inputTex || !context?.resolution) return null;

        const width = Math.max(1, context.resolution.w || 1);
        const height = Math.max(1, context.resolution.h || 1);
        const cacheKey = [
            selectedContext && context === selectedContext ? 'selected' : 'resolved',
            String(context.instance?.instanceId || instanceId || ''),
            String(this.runtime.frameRenderCount || 0),
            `${width}x${height}`
        ].join(':');
        const snapshot = this.refreshInputSampleSnapshot(context.inputTex, width, height, cacheKey);
        if (!snapshot) return null;

        return {
            ...snapshot,
            inputCanvasPlacement: { ...(context.inputCanvasPlacement || { x: 0, y: 0, w: width, h: height }) },
            finalResolution: {
                w: Math.max(1, context.finalResolution?.w || this.runtime.renderWidth || width),
                h: Math.max(1, context.finalResolution?.h || this.runtime.renderHeight || height)
            }
        };
    }

    getLayerInputSampleContext(documentState, instanceId) {
        if (!this.runtime.baseImage || !instanceId) return null;
        const targetIndex = documentState?.layerStack?.findIndex((instance) => instance.instanceId === instanceId) ?? -1;
        if (targetIndex === -1) return null;

        this.reallocateBuffers(documentState, false);
        this.runtime.hasRenderableLayers = hasRenderableLayers(this.registry, documentState);
        if (!this.runtime.hasRenderableLayers) return null;

        const nominalFinalResolution = {
            w: Math.max(1, this.runtime.renderWidth || 1),
            h: Math.max(1, this.runtime.renderHeight || 1)
        };
        const finalResolution = this.getProcessedPreviewResolution();
        const finalSourcePlacement = this.runtime.sourcePlacement ? { ...this.runtime.sourcePlacement } : null;
        const { gl } = this.runtime;

        Object.values(this.runtime.fboPools).forEach((pool) => {
            pool.writeIdx = 0;
        });

        const initialPool = this.ensurePool(this.runtime.initialRes.w, this.runtime.initialRes.h);
        gl.viewport(0, 0, this.runtime.initialRes.w, this.runtime.initialRes.h);
        const baseTex = this.uploadBaseTexture(false);
        renderPreviewTexture(gl, { ...this.runtime, currentPool: initialPool }, baseTex, initialPool.pingPong0.fbo, 0);

        let currentTex = initialPool.pingPong0.tex;
        let currentResolution = { w: this.runtime.initialRes.w, h: this.runtime.initialRes.h };
        let targetContext = null;

        for (let index = 0; index < documentState.layerStack.length; index += 1) {
            const instance = documentState.layerStack[index];
            if (!instance?.visible) continue;
            const layerDef = this.registry.byId[instance.layerId];
            if (!layerDef) continue;

            if (instance.instanceId === instanceId) {
                targetContext = {
                    inputTex: currentTex,
                    resolution: { ...currentResolution }
                };
                break;
            }

            const resolution = this.runtime.layerResolutions[instance.instanceId] || currentResolution;
            const pool = this.ensurePool(resolution.w, resolution.h);
            this.updateFixedPoolRefs(pool);
            this.runtime.renderWidth = resolution.w;
            this.runtime.renderHeight = resolution.h;
            gl.viewport(0, 0, resolution.w, resolution.h);

            const outputBuffer = pool.writeIdx === 0 ? pool.pingPong1 : pool.pingPong0;
            renderLayer(gl, this.runtime, layerDef, instance, currentTex, outputBuffer.fbo, documentState, {
                inputResolution: { ...currentResolution }
            });
            currentTex = outputBuffer.tex;
            currentResolution = { w: resolution.w, h: resolution.h };
            pool.writeIdx = 1 - pool.writeIdx;
        }

        if (!targetContext) {
            this.runtime.renderWidth = nominalFinalResolution.w;
            this.runtime.renderHeight = nominalFinalResolution.h;
            if (finalSourcePlacement) this.runtime.sourcePlacement = finalSourcePlacement;
            return null;
        }

        const inputCanvasPlacement = {
            x: 0,
            y: 0,
            w: targetContext.resolution.w,
            h: targetContext.resolution.h
        };
        let stageResolution = { ...targetContext.resolution };

        for (let index = targetIndex + 1; index < documentState.layerStack.length; index += 1) {
            const instance = documentState.layerStack[index];
            if (!instance?.visible) continue;
            const layerDef = this.registry.byId[instance.layerId];
            if (!layerDef) continue;
            const resolution = this.runtime.layerResolutions[instance.instanceId] || stageResolution;

            if (instance.enabled) {
                if (layerDef.layerId === 'scale') {
                    const scaleX = resolution.w / Math.max(1, stageResolution.w || 1);
                    const scaleY = resolution.h / Math.max(1, stageResolution.h || 1);
                    inputCanvasPlacement.x *= scaleX;
                    inputCanvasPlacement.y *= scaleY;
                    inputCanvasPlacement.w *= scaleX;
                    inputCanvasPlacement.h *= scaleY;
                } else if (layerDef.layerId === 'expander') {
                    inputCanvasPlacement.x += Math.max(0, (resolution.w - stageResolution.w) * 0.5);
                    inputCanvasPlacement.y += Math.max(0, (resolution.h - stageResolution.h) * 0.5);
                } else if (layerDef.layerId === 'cropTransform') {
                    const cropMetrics = getCropTransformMetrics(instance.params, stageResolution.w, stageResolution.h);
                    const scaleX = resolution.w / Math.max(1, cropMetrics.cropWidthFloat);
                    const scaleY = resolution.h / Math.max(1, cropMetrics.cropHeightFloat);
                    inputCanvasPlacement.x = (inputCanvasPlacement.x - cropMetrics.leftPx) * scaleX;
                    inputCanvasPlacement.y = (inputCanvasPlacement.y - cropMetrics.topPx) * scaleY;
                    inputCanvasPlacement.w *= scaleX;
                    inputCanvasPlacement.h *= scaleY;
                }
            }

            stageResolution = { w: resolution.w, h: resolution.h };
        }

        this.runtime.renderWidth = nominalFinalResolution.w;
        this.runtime.renderHeight = nominalFinalResolution.h;
        if (finalSourcePlacement) this.runtime.sourcePlacement = finalSourcePlacement;

        return {
            ...targetContext,
            inputCanvasPlacement,
            finalResolution
        };
    }

    pickLayerInputAtUv(documentState, instanceId, u, v) {
        const snapshot = this.getLayerInputPreviewSnapshot(documentState, instanceId);
        if (!snapshot?.pixels) return null;
        const width = Math.max(1, snapshot.width || 1);
        const height = Math.max(1, snapshot.height || 1);
        const normalizedU = Math.max(0, Math.min(1, Number(u) || 0));
        const normalizedV = Math.max(0, Math.min(1, Number(v) || 0));
        const finalWidth = Math.max(1, snapshot.finalResolution?.w || width);
        const finalHeight = Math.max(1, snapshot.finalResolution?.h || height);
        const previewX = normalizedU * finalWidth;
        const previewY = normalizedV * finalHeight;
        const placement = snapshot.inputCanvasPlacement || { x: 0, y: 0, w: width, h: height };

        if (
            placement.w <= 0
            || placement.h <= 0
            || previewX < placement.x
            || previewX > placement.x + placement.w
            || previewY < placement.y
            || previewY > placement.y + placement.h
        ) {
            return null;
        }

        const localU = (previewX - placement.x) / placement.w;
        const localV = (previewY - placement.y) / placement.h;
        const x = Math.max(0, Math.min(width - 1, Math.floor(localU * width)));
        const y = Math.max(0, Math.min(height - 1, Math.floor(localV * height)));
        const offset = ((y * width) + x) * 4;
        const pixel = [
            snapshot.pixels[offset] || 0,
            snapshot.pixels[offset + 1] || 0,
            snapshot.pixels[offset + 2] || 0,
            snapshot.pixels[offset + 3] || 0
        ];

        return {
            x,
            y,
            width,
            height,
            r: pixel[0],
            g: pixel[1],
            b: pixel[2],
            a: pixel[3],
            hex: `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
        };
    }

    pickSelectedLayerInputAtUv(instanceIdOrU, maybeU, maybeV) {
        let instanceId = null;
        let u = instanceIdOrU;
        let v = maybeU;

        if (typeof instanceIdOrU === 'string') {
            instanceId = instanceIdOrU;
            u = maybeU;
            v = maybeV;
        }
        const snapshot = this.getLayerInputPreviewSnapshot(null, instanceId);
        if (!snapshot?.pixels) return null;
        const width = Math.max(1, snapshot.width || 1);
        const height = Math.max(1, snapshot.height || 1);
        const normalizedU = Math.max(0, Math.min(1, Number(u) || 0));
        const normalizedV = Math.max(0, Math.min(1, Number(v) || 0));
        const inputCanvasPlacement = snapshot.inputCanvasPlacement || {
            x: 0,
            y: 0,
            w: width,
            h: height
        };
        const finalWidth = Math.max(1, snapshot.finalResolution?.w || this.runtime.renderWidth || this.refs.canvas?.width || width);
        const finalHeight = Math.max(1, snapshot.finalResolution?.h || this.runtime.renderHeight || this.refs.canvas?.height || height);
        const previewX = normalizedU * finalWidth;
        const previewY = normalizedV * finalHeight;

        if (
            inputCanvasPlacement.w <= 0
            || inputCanvasPlacement.h <= 0
            || previewX < inputCanvasPlacement.x
            || previewX > inputCanvasPlacement.x + inputCanvasPlacement.w
            || previewY < inputCanvasPlacement.y
            || previewY > inputCanvasPlacement.y + inputCanvasPlacement.h
        ) {
            return null;
        }

        const localU = (previewX - inputCanvasPlacement.x) / inputCanvasPlacement.w;
        const localV = (previewY - inputCanvasPlacement.y) / inputCanvasPlacement.h;
        const x = Math.max(0, Math.min(width - 1, Math.floor(localU * width)));
        const y = Math.max(0, Math.min(height - 1, Math.floor(localV * height)));
        const offset = ((y * width) + x) * 4;
        const pixel = [
            snapshot.pixels[offset] || 0,
            snapshot.pixels[offset + 1] || 0,
            snapshot.pixels[offset + 2] || 0,
            snapshot.pixels[offset + 3] || 0
        ];

        return {
            x,
            y,
            width,
            height,
            r: pixel[0],
            g: pixel[1],
            b: pixel[2],
            a: pixel[3],
            hex: `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`
        };
    }

    pickColorAtUv(u, v) {
        return this.pickPixelAtUv(u, v)?.hex || '#000000';
    }
}
