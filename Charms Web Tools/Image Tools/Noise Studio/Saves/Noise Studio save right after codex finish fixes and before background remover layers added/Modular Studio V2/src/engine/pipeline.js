import { bootstrapEngine } from './bootstrap.js';
import { renderLayer, renderMaskPreview, renderPreviewTexture, getLegacyUI } from './executors/index.js';
import { updateHistogram, updateVectorscope, updateParade } from '../analysis/scopes.js';
import { hasRenderableLayers } from '../state/documentHelpers.js';

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
    const items = [
        { key: 'chain', label: 'Chain Result' },
        { key: 'isolated', label: 'Isolated Layer' }
    ];
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
            thumbnailFBO: null,
            analysisFBO: null,
            thumbTempCanvas: null,
            thumbTempCtx: null,
            thumbPixelBuffer: null,
            thumbClampedBuffer: null,
            analysisPixelBuffer: null,
            analysisTempCanvas: null,
            analysisTempCtx: null,
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
            hasRenderableLayers: false
        };
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
        const thumb = makeFbo(gl, 320, 180, false);
        this.runtime.thumbnailFBO = { ...thumb, w: 320, h: 180 };
        const analysis = makeFbo(gl, 256, 256, false);
        this.runtime.analysisFBO = { ...analysis, w: 256, h: 256 };
        this.runtime.thumbTempCanvas = document.createElement('canvas');
        this.runtime.thumbTempCanvas.width = 320;
        this.runtime.thumbTempCanvas.height = 180;
        this.runtime.thumbTempCtx = this.runtime.thumbTempCanvas.getContext('2d');
        this.runtime.thumbPixelBuffer = new Uint8Array(320 * 180 * 4);
        this.runtime.thumbClampedBuffer = new Uint8ClampedArray(320 * 180 * 4);
        this.runtime.analysisTempCanvas = document.createElement('canvas');
        this.runtime.analysisTempCanvas.width = 256;
        this.runtime.analysisTempCanvas.height = 256;
        this.runtime.analysisTempCtx = this.runtime.analysisTempCanvas.getContext('2d', { willReadFrequently: true });
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
        this.runtime.initialRes = { w: currentWidth, h: currentHeight };

        const required = new Set([this.getPoolKey(currentWidth, currentHeight)]);
        this.runtime.layerResolutions = {};

        documentState.layerStack.forEach((instance) => {
            if (!instance.visible || !instance.enabled) {
                this.runtime.layerResolutions[instance.instanceId] = { w: currentWidth, h: currentHeight };
                required.add(this.getPoolKey(currentWidth, currentHeight));
                return;
            }
            if (instance.layerId === 'scale') {
                const scale = Math.max(0.1, parseFloat(instance.params.scaleMultiplier || 1));
                currentWidthFloat *= scale;
                currentHeightFloat *= scale;
                const clamp = clampScale(currentWidthFloat, currentHeightFloat, maxDim);
                currentWidthFloat *= clamp;
                currentHeightFloat *= clamp;
                currentWidth = Math.max(1, Math.round(currentWidthFloat));
                currentHeight = Math.max(1, Math.round(currentHeightFloat));
            }
            this.runtime.layerResolutions[instance.instanceId] = { w: currentWidth, h: currentHeight };
            required.add(this.getPoolKey(currentWidth, currentHeight));
        });

        this.runtime.renderWidth = currentWidth;
        this.runtime.renderHeight = currentHeight;

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
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        drawImageContained(ctx, this.runtime.baseImage, canvas.width, canvas.height);
    }

    updateScopesFromCanvas(canvas) {
        if (!canvas || !this.refs.histogramCanvas && !this.refs.vectorscopeCanvas && !this.refs.paradeCanvas) return;
        const width = this.runtime.analysisFBO.w;
        const height = this.runtime.analysisFBO.h;
        this.runtime.analysisTempCtx.clearRect(0, 0, width, height);
        this.runtime.analysisTempCtx.drawImage(canvas, 0, 0, width, height);
        const imageData = this.runtime.analysisTempCtx.getImageData(0, 0, width, height).data;
        if (!this.runtime.analysisPixelBuffer || this.runtime.analysisPixelBuffer.length !== imageData.length) {
            this.runtime.analysisPixelBuffer = new Uint8Array(imageData.length);
        }
        this.runtime.analysisPixelBuffer.set(imageData);
        updateHistogram(
            this.refs.histogramCanvas,
            this.refs.avgBrightnessEl,
            this.refs.renderResolutionEl,
            this.runtime.analysisPixelBuffer,
            width,
            height,
            this.runtime.renderWidth,
            this.runtime.renderHeight
        );
        updateVectorscope(
            this.refs.vectorscopeCanvas,
            this.refs.avgSaturationEl,
            this.runtime.analysisPixelBuffer,
            width,
            height
        );
        updateParade(this.refs.paradeCanvas, this.runtime.analysisPixelBuffer, width, height);
    }

    getActiveDisplayCanvas() {
        return this.runtime.hasRenderableLayers ? this.refs.canvas : (this.refs.sourcePreviewCanvas || this.refs.canvas);
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
        this.runtime.selectedLayerContext = null;
        this.runtime.selectedLayerOutput = null;

        documentState.layerStack.forEach((instance) => {
            if (!instance.visible) return;
            const layerDef = this.registry.byId[instance.layerId];
            if (!layerDef) return;
            const resolution = this.runtime.layerResolutions[instance.instanceId] || this.runtime.initialRes;
            const pool = this.ensurePool(resolution.w, resolution.h);
            this.updateFixedPoolRefs(pool);
            this.runtime.renderWidth = resolution.w;
            this.runtime.renderHeight = resolution.h;
            gl.viewport(0, 0, resolution.w, resolution.h);

            if (documentState.selection.layerInstanceId === instance.instanceId) {
                this.runtime.selectedLayerContext = {
                    layerDef,
                    instance,
                    inputTex: currentTex,
                    resolution,
                    pool
                };
            }

            const outputBuffer = pool.writeIdx === 0 ? pool.pingPong1 : pool.pingPong0;
            renderLayer(gl, this.runtime, layerDef, instance, currentTex, outputBuffer.fbo, documentState);
            currentTex = outputBuffer.tex;
            pool.writeIdx = 1 - pool.writeIdx;

            if (documentState.selection.layerInstanceId === instance.instanceId) {
                renderPreviewTexture(gl, this.runtime, currentTex, pool.chainCapture.fbo, 0);
                this.runtime.selectedLayerOutput = pool.chainCapture.tex;
            }
        });

        const finalWidth = this.runtime.renderWidth;
        const finalHeight = this.runtime.renderHeight;
        if (this.refs.canvas.width !== finalWidth || this.refs.canvas.height !== finalHeight) {
            this.refs.canvas.width = finalWidth;
            this.refs.canvas.height = finalHeight;
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, finalWidth, finalHeight);
        gl.useProgram(this.runtime.programs.final);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        gl.uniform1i(gl.getUniformLocation(this.runtime.programs.final, 'u_tex'), 0);
        gl.uniform2f(gl.getUniformLocation(this.runtime.programs.final, 'u_res'), finalWidth, finalHeight);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.flush();

        if (!isExport) {
            this.syncHoverPreview();
            this.updateScopes(currentTex);
            this.updateBreakdown(documentState);
            this.runtime.renderWidth = finalWidth;
            this.runtime.renderHeight = finalHeight;
            this.syncPopup();
            this.hooks.onMetrics?.({
                fps: this.runtime.realtimeFps,
                renderWidth: finalWidth,
                renderHeight: finalHeight
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
        const { gl } = this.runtime;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.runtime.analysisFBO.fbo);
        gl.viewport(0, 0, this.runtime.analysisFBO.w, this.runtime.analysisFBO.h);
        renderPreviewTexture(gl, this.runtime, texture, this.runtime.analysisFBO.fbo, 0);
        if (!this.runtime.analysisPixelBuffer) {
            this.runtime.analysisPixelBuffer = new Uint8Array(this.runtime.analysisFBO.w * this.runtime.analysisFBO.h * 4);
        }
        gl.readPixels(0, 0, this.runtime.analysisFBO.w, this.runtime.analysisFBO.h, gl.RGBA, gl.UNSIGNED_BYTE, this.runtime.analysisPixelBuffer);
        updateHistogram(
            this.refs.histogramCanvas,
            this.refs.avgBrightnessEl,
            this.refs.renderResolutionEl,
            this.runtime.analysisPixelBuffer,
            this.runtime.analysisFBO.w,
            this.runtime.analysisFBO.h,
            this.runtime.renderWidth,
            this.runtime.renderHeight
        );
        updateVectorscope(
            this.refs.vectorscopeCanvas,
            this.refs.avgSaturationEl,
            this.runtime.analysisPixelBuffer,
            this.runtime.analysisFBO.w,
            this.runtime.analysisFBO.h
        );
        updateParade(this.refs.paradeCanvas, this.runtime.analysisPixelBuffer, this.runtime.analysisFBO.w, this.runtime.analysisFBO.h);
    }

    drawTextureToThumbnail(texture, canvas) {
        if (!canvas || !texture) return;
        const { gl } = this.runtime;
        const target = this.runtime.thumbnailFBO;
        renderPreviewTexture(gl, this.runtime, texture, target.fbo, 0);
        gl.readPixels(0, 0, target.w, target.h, gl.RGBA, gl.UNSIGNED_BYTE, this.runtime.thumbPixelBuffer);
        for (let y = 0; y < target.h; y += 1) {
            const srcOffset = (target.h - 1 - y) * target.w * 4;
            const dstOffset = y * target.w * 4;
            this.runtime.thumbClampedBuffer.set(this.runtime.thumbPixelBuffer.subarray(srcOffset, srcOffset + target.w * 4), dstOffset);
        }
        const imageData = new ImageData(this.runtime.thumbClampedBuffer, target.w, target.h);
        this.runtime.thumbTempCtx.putImageData(imageData, 0, 0);
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(this.runtime.thumbTempCanvas, 0, 0, target.w, target.h, 0, 0, canvas.width, canvas.height);
    }

    syncHoverPreview() {
        if (!this.refs.hoverPreviewCanvas || !this.runtime.baseImage || !this.refs.canvas) return;
        const canvas = this.refs.hoverPreviewCanvas;
        if (canvas.width !== this.refs.canvas.width || canvas.height !== this.refs.canvas.height) {
            canvas.width = this.refs.canvas.width;
            canvas.height = this.refs.canvas.height;
        }
        const ctx = canvas.getContext('2d', { alpha: false });
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        drawImageContained(ctx, this.runtime.baseImage, canvas.width, canvas.height);
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
        this.drawTextureToThumbnail(this.runtime.selectedLayerOutput, chainCanvas);

        this.updateFixedPoolRefs(pool);
        this.runtime.renderWidth = resolution.w;
        this.runtime.renderHeight = resolution.h;
        renderLayer(this.runtime.gl, this.runtime, layerDef, instance, inputTex, pool.preview.fbo, documentState, { force: true });
        const isolatedCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"isolated\"] canvas');
        this.drawTextureToThumbnail(pool.preview.tex, isolatedCanvas);

        if (layerDef.mask) {
            const maskTex = renderMaskPreview(this.runtime.gl, this.runtime, layerDef, instance, inputTex, documentState);
            const maskCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"mask\"] canvas');
            this.drawTextureToThumbnail(maskTex || this.runtime.textures.black, maskCanvas);
        }
        if (layerDef.layerId === 'ca') {
            const falloffTex = this.renderCaFalloff(instance, pool);
            const falloffCanvas = this.refs.breakdownContainer.querySelector('[data-breakdown-key=\"falloff\"] canvas');
            this.drawTextureToThumbnail(falloffTex, falloffCanvas);
        }
    }

    async exportPngBlob(documentState) {
        if (!hasRenderableLayers(this.registry, documentState)) {
            const exportCanvas = document.createElement('canvas');
            exportCanvas.width = this.runtime.sourceWidth;
            exportCanvas.height = this.runtime.sourceHeight;
            const ctx = exportCanvas.getContext('2d', { alpha: false });
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
        const aspect = this.runtime.sourceWidth / this.runtime.sourceHeight;
        originalCanvas.width = 640;
        originalCanvas.height = Math.round(640 / aspect);
        processedCanvas.width = 640;
        processedCanvas.height = Math.round(640 / aspect);
        originalCanvas.getContext('2d').drawImage(this.runtime.baseImage, 0, 0, originalCanvas.width, originalCanvas.height);
        processedCanvas.getContext('2d').drawImage(processedLayers ? this.getActiveDisplayCanvas() : this.runtime.baseImage, 0, 0, processedCanvas.width, processedCanvas.height);
        if (infoEl) {
            infoEl.textContent = `Source ${this.runtime.sourceWidth} x ${this.runtime.sourceHeight} | Render ${this.runtime.renderWidth} x ${this.runtime.renderHeight}`;
        }
        if (processedLayers) this.render(documentState);
    }

    exportComparison(mode, originalCanvas, processedCanvas) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (mode === 'side') {
            canvas.width = originalCanvas.width * 2;
            canvas.height = originalCanvas.height;
            ctx.drawImage(originalCanvas, 0, 0);
            ctx.drawImage(processedCanvas, originalCanvas.width, 0);
        } else {
            canvas.width = originalCanvas.width;
            canvas.height = originalCanvas.height * 2;
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

    pickColorAtUv(u, v) {
        const xRatio = Math.max(0, Math.min(1, u));
        const yRatio = Math.max(0, Math.min(1, v));
        if (!this.runtime.hasRenderableLayers && this.refs.sourcePreviewCanvas) {
            const canvas = this.refs.sourcePreviewCanvas;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            const x = Math.max(0, Math.min(canvas.width - 1, Math.floor(xRatio * canvas.width)));
            const y = Math.max(0, Math.min(canvas.height - 1, Math.floor(yRatio * canvas.height)));
            const pixel = ctx.getImageData(x, y, 1, 1).data;
            return `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
        }
        const { gl } = this.runtime;
        const x = Math.max(0, Math.min(this.refs.canvas.width - 1, Math.floor(xRatio * this.refs.canvas.width)));
        const y = Math.max(0, Math.min(this.refs.canvas.height - 1, Math.floor((1 - yRatio) * this.refs.canvas.height)));
        const pixel = new Uint8Array(4);
        gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return `#${[pixel[0], pixel[1], pixel[2]].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
    }
}
