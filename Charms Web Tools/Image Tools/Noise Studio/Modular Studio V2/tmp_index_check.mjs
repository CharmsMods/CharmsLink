import { getCropTransformMetrics, isCropTransformIdentity } from '../cropTransformShared.js';
import { drawEditorTextToCanvas, measureEditorTextLayout, normalizeEditorTextParams } from '../../editor/textLayerShared.js';
import { computeContainedPlacement } from '../../editor/baseCanvas.js';
import { computeDngDevelopGeometry, normalizeDngDevelopParams } from '../../editor/dngDevelopShared.js';
import { getEditorCanvasResolution } from '../../editor/baseCanvas.js';

function toLegacyField(value) {
    if (typeof value === 'boolean') {
        return { value: value ? '1' : '0', checked: value };
    }
    return { value: String(value), checked: !!value };
}

function hexToRgb(hex) {
    if (!hex || typeof hex !== 'string') return { r: 0, g: 0, b: 0 };
    return {
        r: parseInt(hex.slice(1, 3), 16) / 255,
        g: parseInt(hex.slice(3, 5), 16) / 255,
        b: parseInt(hex.slice(5, 7), 16) / 255
    };
}

function hexToRgb255(hex) {
    if (!hex || typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) {
        return { r: 0, g: 0, b: 0 };
    }
    return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16)
    };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function normalizeRgbaColor(color) {
    if (!color || typeof color !== 'object') {
        return { r: 1, g: 1, b: 1, a: 1 };
    }
    return {
        r: clamp(Number(color.r ?? 255), 0, 255) / 255,
        g: clamp(Number(color.g ?? 255), 0, 255) / 255,
        b: clamp(Number(color.b ?? 255), 0, 255) / 255,
        a: clamp(Number(color.a ?? 255), 0, 255) / 255
    };
}

function ensureBgPatcherState(gl, runtime, instanceId, width, height) {
    if (!runtime.bgPatcherStates) runtime.bgPatcherStates = {};
    const key = `${width}x${height}`;
    let state = runtime.bgPatcherStates[instanceId];

    if (!state) {
        state = runtime.bgPatcherStates[instanceId] = {
            sizeKey: '',
            floodMaskArray: null,
            floodQueue: null,
            rawReadback: null,
            topLeftPixels: null,
            protectedColorData: new Float32Array(8 * 3),
            protectedToleranceData: new Float32Array(8),
            patchRectData: new Float32Array(32 * 4),
            patchColorData: new Float32Array(32 * 3),
            floodMaskTex: gl.createTexture(),
            readbackTex: gl.createTexture(),
            readbackFbo: gl.createFramebuffer(),
            brushMaskTex: gl.createTexture(),
            brushMaskFbo: gl.createFramebuffer()
        };
        gl.bindTexture(gl.TEXTURE_2D, state.floodMaskTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

        gl.bindTexture(gl.TEXTURE_2D, state.readbackTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.readbackFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.readbackTex, 0);

        gl.bindTexture(gl.TEXTURE_2D, state.brushMaskTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindFramebuffer(gl.FRAMEBUFFER, state.brushMaskFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, state.brushMaskTex, 0);
    }

    if (state.sizeKey !== key) {
        state.sizeKey = key;
        state.floodMaskArray = new Uint8Array(width * height);
        state.floodQueue = new Uint32Array(width * height);
        state.rawReadback = new Uint8Array(width * height * 4);
        state.topLeftPixels = new Uint8Array(width * height * 4);

        gl.bindTexture(gl.TEXTURE_2D, state.readbackTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

        gl.bindTexture(gl.TEXTURE_2D, state.brushMaskTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        state.brushDirty = true;
    }

    return state;
}

function readTexturePixelsTopLeft(gl, runtime, texture, width, height, state) {
    bindCopy(gl, runtime, texture, state.readbackFbo, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, state.readbackFbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, state.rawReadback);

    const rowSize = width * 4;
    for (let y = 0; y < height; y += 1) {
        const src = (height - 1 - y) * rowSize;
        const dst = y * rowSize;
        state.topLeftPixels.set(state.rawReadback.subarray(src, src + rowSize), dst);
    }

    return state.topLeftPixels;
}

function updateBgPatcherFloodMask(gl, runtime, inputTex, instance, inputResolution, documentState) {
    const width = Math.max(1, inputResolution?.w || runtime.renderWidth);
    const height = Math.max(1, inputResolution?.h || runtime.renderHeight);
    
    const state = ensureBgPatcherState(gl, runtime, instance.instanceId, width, height);

    const params = instance.params || {};
    const floodEnabled = !!params.bgPatcherFloodFill;
    const sampleX = Math.round(Number(params.bgPatcherSampleX ?? -1));
    const sampleY = Math.round(Number(params.bgPatcherSampleY ?? -1));
    const targetColorHex = params.bgPatcherTargetColor || '#000000';
    const target = hexToRgb255(targetColorHex);
    const tolerance = Math.max(0, Number(params.bgPatcherTolerance || 0));
    const smoothing = Math.max(0, Number(params.bgPatcherSmoothing || 0));

    const targetIndex = documentState?.layerStack?.findIndex((inst) => inst.instanceId === instance.instanceId) ?? -1;
    const upstreamStack = targetIndex > 0 ? documentState.layerStack.slice(0, targetIndex) : [];
    const upstreamHash = upstreamStack.map(inst => `${inst.instanceId}:${inst.visible}:${inst.enabled}:${JSON.stringify(inst.params || {})}`).join('|') + `|${documentState?.source?.width || 0}x${documentState?.source?.height || 0}`;

    const currentParamsStr = JSON.stringify({
        floodEnabled, sampleX, sampleY, samples: params.bgPatcherSamples, targetColorHex, tolerance, smoothing, 
        protectedColors: params.bgPatcherProtectedColors
    });

    const isDirty = (
        !state.lastParamsStr ||
        state.texWidth !== width ||
        state.texHeight !== height ||
        state.lastParamsStr !== currentParamsStr ||
        state.lastUpstreamHash !== upstreamHash
    );

    if (!isDirty && state.floodMaskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, state.floodMaskTex);
        gl.activeTexture(gl.TEXTURE0);
        return state;
    }

    state.lastParamsStr = currentParamsStr;
    state.lastUpstreamHash = upstreamHash;
    state.texWidth = width;
    state.texHeight = height;

    const allSamples = (params.bgPatcherSamples || []).map(s => ({ x: Math.round(Number(s.x)), y: Math.round(Number(s.y)) }));
    if (sampleX >= 0 && sampleY >= 0) allSamples.unshift({ x: sampleX, y: sampleY });
    const validSamples = allSamples.filter(s => s.x >= 0 && s.y >= 0 && s.x < width && s.y < height);

    if (!floodEnabled || validSamples.length === 0) {
        state.floodMaskArray.fill(255);
    } else {
        const pixels = readTexturePixelsTopLeft(gl, runtime, inputTex, width, height, state);
        state.floodMaskArray.fill(0);

        const maxDistance = ((tolerance / 100) * 1.5) + ((smoothing / 100) * 1.5) + 0.001;
        const maxDistanceSq = Math.pow(maxDistance * 255, 2);
        const protectedColors = (params.bgPatcherProtectedColors || []).slice(0, 8).map((entry) => {
            const color = hexToRgb255(entry?.color || '#000000');
            return {
                r: color.r,
                g: color.g,
                b: color.b,
                maxSq: Math.pow(Math.max((Number(entry?.tolerance ?? 0) / 100) * 1.5, 0.01) * 255, 2)
            };
        });

        let head = 0;
        let tail = 0;
        for (const sample of validSamples) {
            const startIndex = (sample.y * width) + sample.x;
            if (state.floodMaskArray[startIndex] === 0) {
                state.floodQueue[tail++] = startIndex;
                state.floodMaskArray[startIndex] = 255;
            }
        }

        const tryFlood = (pixelIndex) => {
            if (state.floodMaskArray[pixelIndex] !== 0) return;
            const offset = pixelIndex * 4;

            for (let index = 0; index < protectedColors.length; index += 1) {
                const protectedColor = protectedColors[index];
                const dr = pixels[offset] - protectedColor.r;
                const dg = pixels[offset + 1] - protectedColor.g;
                const db = pixels[offset + 2] - protectedColor.b;
                if ((dr * dr) + (dg * dg) + (db * db) <= protectedColor.maxSq) {
                    state.floodMaskArray[pixelIndex] = 1;
                    return;
                }
            }

            const dr = pixels[offset] - target.r;
            const dg = pixels[offset + 1] - target.g;
            const db = pixels[offset + 2] - target.b;
            if ((dr * dr) + (dg * dg) + (db * db) <= maxDistanceSq) {
                state.floodMaskArray[pixelIndex] = 255;
                state.floodQueue[tail++] = pixelIndex;
            } else {
                state.floodMaskArray[pixelIndex] = 1;
            }
        };

        while (head < tail) {
            const index = state.floodQueue[head++];
            const x = index % width;
            const y = Math.floor(index / width);

            if (x + 1 < width) tryFlood(index + 1);
            if (x - 1 >= 0) tryFlood(index - 1);
            if (y + 1 < height) tryFlood(index + width);
            if (y - 1 >= 0) tryFlood(index - width);
        }

        for (let index = 0; index < state.floodMaskArray.length; index += 1) {
            if (state.floodMaskArray[index] !== 255) state.floodMaskArray[index] = 0;
        }
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.floodMaskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, width, height, 0, gl.RED, gl.UNSIGNED_BYTE, state.floodMaskArray);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.activeTexture(gl.TEXTURE0);
    return state;
}

function buildLegacyUI(documentState, currentInstance, registry) {
    const fallbackFields = new Map();

    documentState.layerStack.forEach((instance) => {
        const layer = registry.byId[instance.layerId];
        if (!layer) return;
        if (layer.enableKey) fallbackFields.set(layer.enableKey, toLegacyField(instance.enabled));
        Object.entries(instance.params || {}).forEach(([key, value]) => {
            if (!fallbackFields.has(key)) fallbackFields.set(key, toLegacyField(value));
        });
    });

    const currentLayer = registry.byId[currentInstance.layerId];
    return new Proxy({}, {
        get(_target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (currentLayer?.enableKey === prop) return toLegacyField(currentInstance.enabled);
            if (prop in (currentInstance.params || {})) return toLegacyField(currentInstance.params[prop]);
            return fallbackFields.get(prop);
        }
    });
}

function bindCopy(gl, runtime, texture, outputFbo, channel = 0) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.useProgram(runtime.programs.copy);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.copy, 'u_tex'), 0);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.copy, 'u_channel'), channel);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function createTextLayerCanvas(width, height) {
    if (typeof OffscreenCanvas === 'function') {
        return new OffscreenCanvas(width, height);
    }
    if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        return canvas;
    }
    return null;
}

function getLogicalEditorResolutionThroughInstance(documentState, stopInstanceId = null) {
    const baseResolution = getEditorCanvasResolution(documentState);
    let width = Math.max(1, Number(baseResolution.width) || 1);
    let height = Math.max(1, Number(baseResolution.height) || 1);

    for (const stackItem of documentState?.layerStack || []) {
        if (stackItem.visible !== false && stackItem.enabled !== false) {
            if (stackItem.layerId === 'scale') {
                const factor = Math.max(0.1, parseFloat(stackItem.params?.scaleMultiplier || 1));
                width = Math.max(1, Math.round(width * factor));
                height = Math.max(1, Math.round(height * factor));
            } else if (stackItem.layerId === 'expander') {
                const padding = Math.max(0, Math.round(Number(stackItem.params?.expanderPadding || 0)));
                width += padding * 2;
                height += padding * 2;
            } else if (stackItem.layerId === 'cropTransform') {
                const cropMetrics = getCropTransformMetrics(stackItem.params, width, height);
                width = Math.max(1, cropMetrics.outputWidth || width);
                height = Math.max(1, cropMetrics.outputHeight || height);
            }
        }

        if (stopInstanceId && stackItem.instanceId === stopInstanceId) {
            break;
        }
    }

    return { width, height };
}

function ensureTextLayerAsset(gl, runtime, instance) {
    if (!runtime.textLayerAssets) runtime.textLayerAssets = {};
    const params = normalizeEditorTextParams(instance.params || {});
    const textureKey = `${params.textContent}|${params.textFontFamily}|${params.textFontSize}|${params.textColor}`;
    let asset = runtime.textLayerAssets[instance.instanceId];
    if (!asset) {
        asset = runtime.textLayerAssets[instance.instanceId] = {
            texture: gl.createTexture(),
            canvas: null,
            key: '',
            layout: null,
            surfaceTexture: gl.createTexture(),
            surfaceCanvas: null,
            surfaceKey: ''
        };
        gl.bindTexture(gl.TEXTURE_2D, asset.texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, asset.surfaceTexture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    if (asset.key !== textureKey || !asset.layout) {
        const layout = measureEditorTextLayout(params);
        asset.canvas = asset.canvas || createTextLayerCanvas(Math.max(1, Math.ceil(layout.width)), Math.max(1, Math.ceil(layout.height)));
        if (!asset.canvas) return null;
        asset.layout = drawEditorTextToCanvas(asset.canvas, params);
        asset.key = textureKey;
        gl.bindTexture(gl.TEXTURE_2D, asset.texture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, asset.canvas);
    }

    return {
        texture: asset.texture,
        layout: asset.layout,
        params,
        surfaceTexture: asset.surfaceTexture,
        surfaceCanvas: asset.surfaceCanvas,
        surfaceKey: asset.surfaceKey,
        asset
    };
}

function ensureTextLayerSurfaceAsset(gl, runtime, instance, documentState, inputResolution) {
    const glyphAsset = ensureTextLayerAsset(gl, runtime, instance);
    if (!glyphAsset?.asset || !glyphAsset?.layout) return null;
    const logicalResolution = getLogicalEditorResolutionThroughInstance(documentState || {}, instance.instanceId);
    const scaleX = inputResolution.w / Math.max(1, logicalResolution.width || inputResolution.w || 1);
    const scaleY = inputResolution.h / Math.max(1, logicalResolution.height || inputResolution.h || 1);
    const renderWidth = Math.max(1, glyphAsset.layout.width * scaleX);
    const renderHeight = Math.max(1, glyphAsset.layout.height * scaleY);
    const renderX = glyphAsset.params.textX * scaleX;
    const renderY = glyphAsset.params.textY * scaleY;
    const surfaceKey = [
        glyphAsset.asset.key,
        `${inputResolution.w}x${inputResolution.h}`,
        `${logicalResolution.width}x${logicalResolution.height}`,
        renderX,
        renderY,
        renderWidth,
        renderHeight,
        glyphAsset.params.textRotation || 0
    ].join('|');

    if (glyphAsset.asset.surfaceKey !== surfaceKey || !glyphAsset.asset.surfaceCanvas) {
        const surfaceCanvas = glyphAsset.asset.surfaceCanvas
            && glyphAsset.asset.surfaceCanvas.width === inputResolution.w
            && glyphAsset.asset.surfaceCanvas.height === inputResolution.h
            ? glyphAsset.asset.surfaceCanvas
            : createTextLayerCanvas(Math.max(1, inputResolution.w), Math.max(1, inputResolution.h));
        if (!surfaceCanvas) return null;
        surfaceCanvas.width = Math.max(1, inputResolution.w);
        surfaceCanvas.height = Math.max(1, inputResolution.h);
        const context = surfaceCanvas.getContext('2d', { alpha: true });
        if (!context) return null;
        context.clearRect(0, 0, surfaceCanvas.width, surfaceCanvas.height);
        context.save();
        context.translate(renderX + (renderWidth * 0.5), renderY + (renderHeight * 0.5));
        context.rotate((-(glyphAsset.params.textRotation || 0) * Math.PI) / 180);
        context.drawImage(
            glyphAsset.asset.canvas,
            -renderWidth * 0.5,
            -renderHeight * 0.5,
            renderWidth,
            renderHeight
        );
        context.restore();

        glyphAsset.asset.surfaceCanvas = surfaceCanvas;
        glyphAsset.asset.surfaceKey = surfaceKey;
        gl.bindTexture(gl.TEXTURE_2D, glyphAsset.asset.surfaceTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, surfaceCanvas);
    }

    return {
        texture: glyphAsset.asset.surfaceTexture,
        layout: glyphAsset.layout,
        params: glyphAsset.params
    };
}

function ensureMaskBuffers(gl, runtime) {
    if (runtime.fbos.maskTotal) return;
    runtime.fbos.maskTotal = runtime.currentPool.maskTotal.fbo;
    runtime.textures.maskTotal = runtime.currentPool.maskTotal.tex;
}

function renderMaskFromDefinition(gl, runtime, inputTex, layerDef, ui) {
    const mask = layerDef.mask;
    if (!mask) return null;
    const useLuma = mask.lumaMask ? ui[mask.lumaMask.enableKey]?.checked : false;
    const useColor = mask.colorExclude ? ui[mask.colorExclude.enableKey]?.checked : false;
    if (!useLuma && !useColor) return null;

    ensureMaskBuffers(gl, runtime);
    gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.maskTotal);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.ZERO);

    if (useLuma && mask.lumaMask) {
        gl.useProgram(runtime.programs.mask);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(gl.getUniformLocation(runtime.programs.mask, 'u_tex'), 0);
        gl.uniform1i(gl.getUniformLocation(runtime.programs.mask, 'u_useS'), 1);
        gl.uniform1f(gl.getUniformLocation(runtime.programs.mask, 'u_sth'), parseFloat(ui[mask.lumaMask.shadowThresholdKey]?.value || 0));
        gl.uniform1f(gl.getUniformLocation(runtime.programs.mask, 'u_sfa'), parseFloat(ui[mask.lumaMask.shadowFadeKey]?.value || 0));
        gl.uniform1i(gl.getUniformLocation(runtime.programs.mask, 'u_useH'), 1);
        gl.uniform1f(gl.getUniformLocation(runtime.programs.mask, 'u_hth'), parseFloat(ui[mask.lumaMask.highlightThresholdKey]?.value || 1));
        gl.uniform1f(gl.getUniformLocation(runtime.programs.mask, 'u_hfa'), parseFloat(ui[mask.lumaMask.highlightFadeKey]?.value || 0));
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    if (useColor && mask.colorExclude) {
        const rgb = hexToRgb(ui[mask.colorExclude.colorKey]?.value || '#000000');
        gl.useProgram(runtime.programs.colorMask);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(gl.getUniformLocation(runtime.programs.colorMask, 'u_tex'), 0);
        gl.uniform3f(gl.getUniformLocation(runtime.programs.colorMask, 'u_targetColor'), rgb.r, rgb.g, rgb.b);
        gl.uniform1f(gl.getUniformLocation(runtime.programs.colorMask, 'u_tolerance'), parseFloat(ui[mask.colorExclude.toleranceKey]?.value || 10) / 100.0);
        gl.uniform1f(gl.getUniformLocation(runtime.programs.colorMask, 'u_fade'), parseFloat(ui[mask.colorExclude.fadeKey]?.value || 20) / 100.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    gl.disable(gl.BLEND);

    if (mask.invertKey && ui[mask.invertKey]?.checked) {
        gl.useProgram(runtime.programs.invert);
        gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.blur1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, runtime.textures.maskTotal);
        gl.uniform1i(gl.getUniformLocation(runtime.programs.invert, 'u_tex'), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        bindCopy(gl, runtime, runtime.textures.blur1, runtime.fbos.maskTotal, 0);
    }

    return runtime.textures.maskTotal;
}

function bindGenericUniforms(gl, program, layerDef, instance, ui, runtime) {
    const w = runtime.renderWidth;
    const h = runtime.renderHeight;

    if (gl.getUniformLocation(program, 'u_res')) {
        gl.uniform2f(gl.getUniformLocation(program, 'u_res'), w, h);
    }
    if (gl.getUniformLocation(program, 'u_time')) {
        gl.uniform1f(gl.getUniformLocation(program, 'u_time'), runtime.timeSeconds);
    }

    (layerDef.bindings || []).forEach((binding) => {
        const loc = gl.getUniformLocation(program, binding.uniform);
        if (!loc) return;
        const field = ui[binding.key];
        if (binding.type === 'int') {
            gl.uniform1i(loc, parseInt(field?.value || 0, 10));
            return;
        }
        if (binding.type === 'bool' || binding.type === 'boolean') {
            gl.uniform1i(loc, field?.checked ? 1 : 0);
            return;
        }
        if (binding.type === 'rgb' || binding.type === 'color') {
            const rgb = hexToRgb(field?.value || '#000000');
            gl.uniform3f(loc, rgb.r, rgb.g, rgb.b);
            return;
        }
        let value = parseFloat(field?.value || 0);
        if (binding.divideBy) value /= binding.divideBy;
        gl.uniform1f(loc, value);
    });

    if (instance.layerId === 'ca') {
        const centerLoc = gl.getUniformLocation(program, 'u_center');
        if (centerLoc) {
            gl.uniform2f(centerLoc, instance.params.caCenterX ?? 0.5, instance.params.caCenterY ?? 0.5);
        }
    }
}

function renderGenericLayer(gl, runtime, layerDef, instance, inputTex, outputFbo, documentState, ui) {
    const maskTex = renderMaskFromDefinition(gl, runtime, inputTex, layerDef, ui);
    const program = runtime.programs[layerDef.programKey];
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    bindGenericUniforms(gl, program, layerDef, instance, ui, runtime);
    if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        const maskLoc = gl.getUniformLocation(program, 'u_mask');
        if (maskLoc) gl.uniform1i(maskLoc, 1);
        const useMaskLoc = gl.getUniformLocation(program, 'u_useMask');
        if (useMaskLoc) gl.uniform1i(useMaskLoc, 1);
    } else {
        const useMaskLoc = gl.getUniformLocation(program, 'u_useMask');
        if (useMaskLoc) gl.uniform1i(useMaskLoc, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderAdjust(gl, runtime, inputTex, outputFbo, ui) {
    let maskTex = null;
    const useLuma = ui.adjLumaMask?.checked;
    const useColor = ui.adjColorExclude?.checked;
    if (useLuma || useColor) {
        maskTex = renderMaskFromDefinition(gl, runtime, inputTex, { mask: runtime.registry.byId.adjust.mask }, ui);
    }

    const program = maskTex && runtime.programs.adjustMasked ? runtime.programs.adjustMasked : runtime.programs.adjust;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_bright'), parseFloat(ui.brightness?.value || 0));
    gl.uniform1f(gl.getUniformLocation(program, 'u_cont'), parseFloat(ui.contrast?.value || 0));
    gl.uniform1f(gl.getUniformLocation(program, 'u_sat'), parseFloat(ui.saturationAdj?.value || 0) / 100.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_hdrTol'), 0.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_hdrAmt'), 0.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_warmth'), parseFloat(ui.warmth?.value || 0));
    gl.uniform1f(gl.getUniformLocation(program, 'u_sharp'), parseFloat(ui.sharpen?.value || 0));
    gl.uniform1f(gl.getUniformLocation(program, 'u_sharpThresh'), parseFloat(ui.sharpenThreshold?.value || 5));
    gl.uniform2f(gl.getUniformLocation(program, 'u_step'), 1 / runtime.renderWidth, 1 / runtime.renderHeight);
    if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 1);
        const useMaskLoc = gl.getUniformLocation(program, 'u_useMask');
        if (useMaskLoc) gl.uniform1i(useMaskLoc, 1);
    } else {
        const useMaskLoc = gl.getUniformLocation(program, 'u_useMask');
        if (useMaskLoc) gl.uniform1i(useMaskLoc, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderHdr(gl, runtime, inputTex, outputFbo, ui) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.useProgram(runtime.programs.adjust);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.adjust, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_bright'), 0.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_cont'), 0.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_sat'), 0.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_warmth'), 0.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_sharp'), 0.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_hdrTol'), parseFloat(ui.hdrTolerance?.value || 0));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.adjust, 'u_hdrAmt'), parseFloat(ui.hdrAmount?.value || 0));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function hashNoiseSeed(seedBasis) {
    let hash = 2166136261;
    for (let index = 0; index < seedBasis.length; index += 1) {
        hash ^= seedBasis.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) / 4294967295) * 1000.0;
}

function getNoiseSeed(documentState, instance, runtime) {
    const seedBasis = JSON.stringify({
        source: {
            name: documentState?.source?.name || '',
            width: runtime.sourceWidth || documentState?.source?.width || 0,
            height: runtime.sourceHeight || documentState?.source?.height || 0
        },
        layerId: instance?.layerId || 'noise',
        instanceId: instance?.instanceId || '',
        layerOrdinal: Math.max(1, Number(instance?.meta?.instanceIndex) || 1),
        params: instance?.params || {}
    });
    return hashNoiseSeed(seedBasis);
}

function renderNoiseTexture(gl, runtime, ui, seed) {
    gl.useProgram(runtime.programs.noise);
    gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.tempNoise);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.noise, 'u_type'), parseInt(ui.noiseType?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.noise, 'u_seed'), seed);
    gl.uniform2f(gl.getUniformLocation(runtime.programs.noise, 'u_res'), runtime.renderWidth, runtime.renderHeight);
    gl.uniform2f(gl.getUniformLocation(runtime.programs.noise, 'u_origRes'), runtime.sourceWidth, runtime.sourceHeight);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.noise, 'u_scale'), parseFloat(ui.noiseSize?.value || 0));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.noise, 'u_paramA'), parseFloat(ui.noiseParamA?.value || 0) / 100.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.noise, 'u_paramB'), parseFloat(ui.noiseParamB?.value || 0) / 100.0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.noise, 'u_paramC'), parseFloat(ui.noiseParamC?.value || 0) / 100.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    let noiseTex = runtime.textures.tempNoise;
    const blurAmt = parseFloat(ui.blurriness?.value || 0) / 100.0;
    if (blurAmt > 0) {
        gl.useProgram(runtime.programs.blur);
        gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.blur1);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, runtime.textures.tempNoise);
        gl.uniform1i(gl.getUniformLocation(runtime.programs.blur, 'u_tex'), 0);
        gl.uniform2f(gl.getUniformLocation(runtime.programs.blur, 'u_dir'), 1.0 / runtime.renderWidth, 0.0);
        gl.uniform1f(gl.getUniformLocation(runtime.programs.blur, 'u_rad'), blurAmt * 2.0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.blur2);
        gl.bindTexture(gl.TEXTURE_2D, runtime.textures.blur1);
        gl.uniform2f(gl.getUniformLocation(runtime.programs.blur, 'u_dir'), 0.0, 1.0 / runtime.renderHeight);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        noiseTex = runtime.textures.blur2;
    }

    return noiseTex;
}

export function renderNoiseSourcePreview(gl, runtime, instance, documentState) {
    const ui = buildLegacyUI(documentState, instance, runtime.registry);
    return renderNoiseTexture(gl, runtime, ui, getNoiseSeed(documentState, instance, runtime));
}

function renderNoise(gl, runtime, inputTex, outputFbo, documentState, ui, instance) {
    const noiseTex = renderNoiseTexture(gl, runtime, ui, getNoiseSeed(documentState, instance, runtime));
    const maskTex = renderMaskFromDefinition(gl, runtime, inputTex, runtime.registry.byId.noise, ui) || runtime.textures.white;
    gl.useProgram(runtime.programs.composite);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, maskTex);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.composite, 'u_base'), 0);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.composite, 'u_noise'), 1);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.composite, 'u_mask'), 2);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.composite, 'u_mode'), parseInt(ui.blendMode?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.composite, 'u_opacity'), parseFloat(ui.opacity?.value || 0));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.composite, 'u_str'), parseFloat(ui.strength?.value || 0));
    gl.uniform1i(gl.getUniformLocation(runtime.programs.composite, 'u_nType'), parseInt(ui.noiseType?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.composite, 'u_satStr'), parseFloat(ui.satStrength?.value || 0));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.composite, 'u_satImp'), parseFloat(ui.satPerNoise?.value || 0));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.composite, 'u_skinProt'), parseFloat(ui.skinProtection?.value || 0));
    gl.uniform1i(gl.getUniformLocation(runtime.programs.composite, 'u_ignA'), ui.ignoreAlphaToggle?.checked ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.composite, 'u_ignAstr'), parseFloat(ui.ignoreAlphaStrength?.value || 0));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderBlur(gl, runtime, inputTex, outputFbo, ui) {
    const blurAmt = parseFloat(ui.blurAmount?.value || 0) / 100.0;
    if (blurAmt <= 0) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    const maskTex = renderMaskFromDefinition(gl, runtime, inputTex, runtime.registry.byId.blur, ui);
    const program = maskTex && runtime.programs.maskedBlur ? runtime.programs.maskedBlur : runtime.programs.blur;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.blur2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_dir'), 1.0 / runtime.renderWidth, 0.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_rad'), blurAmt * 2.0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_blurType'), parseInt(ui.blurType?.value || 0, 10));
    if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, runtime.textures.blur2);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_dir'), 0.0, 1.0 / runtime.renderHeight);
    gl.uniform1f(gl.getUniformLocation(program, 'u_rad'), blurAmt * 2.0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_blurType'), parseInt(ui.blurType?.value || 0, 10));
    if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderCell(gl, runtime, inputTex, outputFbo, ui) {
    const program = runtime.programs.cell;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_res'), runtime.renderWidth, runtime.renderHeight);
    gl.uniform1i(gl.getUniformLocation(program, 'u_levels'), parseInt(ui.cellLevels?.value || 4, 10));
    gl.uniform1f(gl.getUniformLocation(program, 'u_bias'), parseFloat(ui.cellBias?.value || 0));
    gl.uniform1f(gl.getUniformLocation(program, 'u_gamma'), parseFloat(ui.cellGamma?.value || 1));
    gl.uniform1i(gl.getUniformLocation(program, 'u_quantMode'), parseInt(ui.cellQuantMode?.value || 0, 10));
    gl.uniform1i(gl.getUniformLocation(program, 'u_bandMap'), parseInt(ui.cellBandMap?.value || 0, 10));
    gl.uniform1i(gl.getUniformLocation(program, 'u_edgeMethod'), parseInt(ui.cellEdgeMethod?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(program, 'u_edgeStr'), parseFloat(ui.cellEdgeStr?.value || 1));
    gl.uniform1f(gl.getUniformLocation(program, 'u_edgeThick'), parseFloat(ui.cellEdgeThick?.value || 1));
    gl.uniform1i(gl.getUniformLocation(program, 'u_colorPreserve'), ui.cellColorPreserve?.checked ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_edgeEnable'), ui.cellEdgeEnable?.checked ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderDither(gl, runtime, inputTex, outputFbo, documentState, ui) {
    const maskTex = renderMaskFromDefinition(gl, runtime, inputTex, runtime.registry.byId.dither, ui);
    const program = maskTex && runtime.programs.maskedDither ? runtime.programs.maskedDither : runtime.programs.dither;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_type'), parseInt(ui.ditherType?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(program, 'u_bitDepth'), parseFloat(ui.ditherBitDepth?.value || 4));
    gl.uniform1f(gl.getUniformLocation(program, 'u_strength'), parseFloat(ui.ditherStrength?.value || 100) / 100.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_scale'), parseFloat(ui.ditherScale?.value || 1));
    gl.uniform2f(gl.getUniformLocation(program, 'u_res'), runtime.renderWidth, runtime.renderHeight);
    gl.uniform1f(gl.getUniformLocation(program, 'u_seed'), Math.random() * 100.0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_gamma'), ui.ditherGamma?.checked ? 1 : 0);
    const usePalette = ui.ditherUsePalette?.checked ? 1 : 0;
    gl.uniform1i(gl.getUniformLocation(program, 'u_usePalette'), usePalette);
    if (usePalette) {
        const flat = new Float32Array(256 * 3);
        documentState.palette.forEach((hex, index) => {
            const rgb = hexToRgb(hex);
            flat[index * 3] = rgb.r;
            flat[index * 3 + 1] = rgb.g;
            flat[index * 3 + 2] = rgb.b;
        });
        gl.uniform3fv(gl.getUniformLocation(program, 'u_customPalette'), flat);
        gl.uniform1f(gl.getUniformLocation(program, 'u_paletteSize'), documentState.palette.length);
    } else {
        gl.uniform1f(gl.getUniformLocation(program, 'u_paletteSize'), parseFloat(ui.ditherPaletteSize?.value || 4));
    }
    if (maskTex) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, maskTex);
        gl.uniform1i(gl.getUniformLocation(program, 'u_mask'), 1);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderCompression(gl, runtime, inputTex, outputFbo, ui) {
    const iterations = Math.max(1, parseInt(ui.compressionIterations?.value || 1, 10));
    const program = runtime.programs.compression;
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'u_method'), parseInt(ui.compressionMethod?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(program, 'u_quality'), parseFloat(ui.compressionQuality?.value || 50));
    gl.uniform1f(gl.getUniformLocation(program, 'u_blockSize'), parseFloat(ui.compressionBlockSize?.value || 8));
    gl.uniform1f(gl.getUniformLocation(program, 'u_blend'), parseFloat(ui.compressionBlend?.value || 100) / 100.0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_res'), runtime.renderWidth, runtime.renderHeight);
    if (iterations <= 1) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, inputTex);
        gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        return;
    }

    let readTex = inputTex;
    for (let index = 0; index < iterations; index += 1) {
        const isLast = index === iterations - 1;
        const writeFbo = isLast ? outputFbo : (index % 2 === 0 ? runtime.fbos.blur1 : runtime.fbos.blur2);
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTex);
        gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        if (!isLast) {
            readTex = index % 2 === 0 ? runtime.textures.blur1 : runtime.textures.blur2;
        }
    }
}

function renderPalette(gl, runtime, inputTex, outputFbo, documentState, ui) {
    const program = runtime.programs.palette;
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_blend'), parseFloat(ui.paletteBlend?.value || 100) / 100.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_smoothing'), parseFloat(ui.paletteSmoothing?.value || 0));
    gl.uniform1i(gl.getUniformLocation(program, 'u_smoothingType'), parseInt(ui.paletteSmoothingType?.value || 0, 10));
    gl.uniform2f(gl.getUniformLocation(program, 'u_res'), runtime.renderWidth, runtime.renderHeight);
    const size = Math.min(documentState.palette.length, 256);
    gl.uniform1i(gl.getUniformLocation(program, 'u_paletteSize'), size);
    const flat = new Float32Array(256 * 3);
    for (let index = 0; index < size; index += 1) {
        const rgb = hexToRgb(documentState.palette[index]);
        flat[index * 3] = rgb.r;
        flat[index * 3 + 1] = rgb.g;
        flat[index * 3 + 2] = rgb.b;
    }
    gl.uniform3fv(gl.getUniformLocation(program, 'u_palette'), flat);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderExpander(gl, runtime, inputTex, outputFbo, instance, options = {}) {
    const inputResolution = options.inputResolution || { w: runtime.renderWidth, h: runtime.renderHeight };
    if (runtime.renderWidth === inputResolution.w && runtime.renderHeight === inputResolution.h) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    const program = runtime.programs.expander;
    const color = normalizeRgbaColor(instance.params?.expanderColor);

    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_inputRes'), inputResolution.w, inputResolution.h);
    gl.uniform2f(gl.getUniformLocation(program, 'u_outputRes'), runtime.renderWidth, runtime.renderHeight);
    gl.uniform4f(gl.getUniformLocation(program, 'u_fill'), color.r, color.g, color.b, color.a);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderCropTransform(gl, runtime, inputTex, outputFbo, instance, options = {}) {
    const inputResolution = options.inputResolution || { w: runtime.renderWidth, h: runtime.renderHeight };
    if (isCropTransformIdentity(instance?.params) && runtime.renderWidth === inputResolution.w && runtime.renderHeight === inputResolution.h) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    const cropMetrics = getCropTransformMetrics(instance?.params, inputResolution.w, inputResolution.h);
    const program = runtime.programs.cropTransform;

    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_inputRes'), inputResolution.w, inputResolution.h);
    gl.uniform2f(gl.getUniformLocation(program, 'u_outputRes'), runtime.renderWidth, runtime.renderHeight);
    gl.uniform2f(gl.getUniformLocation(program, 'u_cropOffset'), cropMetrics.leftPx, cropMetrics.bottomPx);
    gl.uniform2f(gl.getUniformLocation(program, 'u_cropSize'), cropMetrics.cropWidthFloat, cropMetrics.cropHeightFloat);
    gl.uniform1f(gl.getUniformLocation(program, 'u_rotationDegrees'), parseFloat(instance?.params?.cropRotation || 0));
    gl.uniform1i(gl.getUniformLocation(program, 'u_flipX'), instance?.params?.cropFlipX ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_flipY'), instance?.params?.cropFlipY ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderBgPatcher(gl, runtime, inputTex, outputFbo, instance, options = {}, documentState) {
    const inputResolution = options.inputResolution || { w: runtime.renderWidth, h: runtime.renderHeight };
    const params = instance.params || {};
    const program = runtime.programs.bgPatcher;
    const floodState = updateBgPatcherFloodMask(gl, runtime, inputTex, instance, inputResolution, documentState);
    const targetSource = hexToRgb(params.bgPatcherTargetColor || '#000000');
    const protectedColors = (params.bgPatcherProtectedColors || []).slice(0, 8);
    const patches = (params.bgPatcherPatches || []).slice(0, 32);

    floodState.protectedColorData.fill(0);
    floodState.protectedToleranceData.fill(0);
    protectedColors.forEach((entry, index) => {
        const color = hexToRgb(entry?.color || '#000000');
        floodState.protectedColorData[index * 3] = color.r;
        floodState.protectedColorData[(index * 3) + 1] = color.g;
        floodState.protectedColorData[(index * 3) + 2] = color.b;
        floodState.protectedToleranceData[index] = Math.max((Number(entry?.tolerance ?? 0) / 100) * 1.5, 0.01);
    });

    floodState.patchRectData.fill(0);
    floodState.patchColorData.fill(0);
    patches.forEach((patch, index) => {
        const color = hexToRgb(patch?.color || '#ff0000');
        const size = Math.max(1, Number(patch?.size ?? 64));
        floodState.patchRectData[index * 4] = Math.max(0, Number(patch?.x ?? 0));
        floodState.patchRectData[(index * 4) + 1] = Math.max(0, Number(patch?.y ?? 0));
        floodState.patchRectData[(index * 4) + 2] = size;
        floodState.patchRectData[(index * 4) + 3] = size;
        floodState.patchColorData[index * 3] = color.r;
        floodState.patchColorData[(index * 3) + 1] = color.g;
        floodState.patchColorData[(index * 3) + 2] = color.b;
    });

    const activeStrokes = params.bgPatcherBrushStrokes || [];
    const strokes = params.bgPatcherBrushLiveStroke ? [...activeStrokes, params.bgPatcherBrushLiveStroke] : activeStrokes;
    const strokesHash = JSON.stringify(strokes);
    if (floodState.lastStrokesHash !== strokesHash || floodState.brushDirty) {
        floodState.lastStrokesHash = strokesHash;
        floodState.brushDirty = false;
        const brushProgram = runtime.programs.brush;
        gl.bindFramebuffer(gl.FRAMEBUFFER, floodState.brushMaskFbo);
        gl.viewport(0, 0, inputResolution.w, inputResolution.h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        if (brushProgram && strokes.length > 0) {
            gl.useProgram(brushProgram);
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

            strokes.forEach(stroke => {
                if (!stroke.path || stroke.path.length < 2) return;
                const r = stroke.mode === 'remove' ? 1.0 : 0.0;
                const g = stroke.mode === 'keep' ? 1.0 : 0.0;
                gl.uniform4f(gl.getUniformLocation(brushProgram, 'u_color'), r, g, 0, 1.0);
                gl.uniform1f(gl.getUniformLocation(brushProgram, 'u_radius'), Math.max(1, Number(stroke.radius ?? 20)));
                gl.uniform1f(gl.getUniformLocation(brushProgram, 'u_hardness'), clamp(Number(stroke.hardness ?? 50), 0, 100) / 100.0);
                gl.uniform2f(gl.getUniformLocation(brushProgram, 'u_res'), inputResolution.w, inputResolution.h);

                for (let i = 1; i < stroke.path.length; i++) {
                    const p1 = stroke.path[i - 1];
                    const p2 = stroke.path[i];
                    gl.uniform2f(gl.getUniformLocation(brushProgram, 'u_start'), p1.x / inputResolution.w, p1.y / inputResolution.h);
                    gl.uniform2f(gl.getUniformLocation(brushProgram, 'u_end'), p2.x / inputResolution.w, p2.y / inputResolution.h);
                    gl.drawArrays(gl.TRIANGLES, 0, 6);
                }
            });
            gl.disable(gl.BLEND);
        }
    }

    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.viewport(0, 0, inputResolution.w, inputResolution.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, floodState.floodMaskTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_floodMask'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, floodState.brushMaskTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_brushMask'), 2);
    
    gl.activeTexture(gl.TEXTURE0);

    gl.uniform3f(gl.getUniformLocation(program, 'u_targetColor'), targetSource.r, targetSource.g, targetSource.b);
    gl.uniform1f(gl.getUniformLocation(program, 'u_targetAlpha'), 1 - (clamp(Number(params.bgPatcherOpacity || 0), 0, 100) / 100));
    gl.uniform1f(gl.getUniformLocation(program, 'u_tolerance'), (clamp(Number(params.bgPatcherTolerance || 0), 0, 100) / 100) * 1.5);
    gl.uniform1f(gl.getUniformLocation(program, 'u_smoothing'), (clamp(Number(params.bgPatcherSmoothing || 0), 0, 100) / 100) * 1.5);
    gl.uniform1f(gl.getUniformLocation(program, 'u_defringe'), clamp(Number(params.bgPatcherDefringe || 0), 0, 100) / 100);
    gl.uniform1f(gl.getUniformLocation(program, 'u_edgeShift'), clamp(Number(params.bgPatcherEdgeShift || 0), 0, 10));
    gl.uniform1i(gl.getUniformLocation(program, 'u_showMask'), params.bgPatcherShowMask ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_keepSelectedRange'), params.bgPatcherKeepSelectedRange ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_aaEnabled'), params.bgPatcherAaEnabled ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_antialias'), clamp(Number(params.bgPatcherAaRadius || 0), 0, 10));
    gl.uniform1i(gl.getUniformLocation(program, 'u_numProtected'), protectedColors.length);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_protectedColors'), floodState.protectedColorData);
    gl.uniform1fv(gl.getUniformLocation(program, 'u_protectedTolerances'), floodState.protectedToleranceData);
    gl.uniform1i(gl.getUniformLocation(program, 'u_useFloodMask'), params.bgPatcherFloodFill ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_useBrushMask'), params.bgPatcherBrushEnabled ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_patchEnabled'), params.bgPatcherPatchEnabled ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_numPatches'), patches.length);
    gl.uniform4fv(gl.getUniformLocation(program, 'u_patchRects'), floodState.patchRectData);
    gl.uniform3fv(gl.getUniformLocation(program, 'u_patchColors'), floodState.patchColorData);
    gl.uniform2f(gl.getUniformLocation(program, 'u_resolution'), inputResolution.w, inputResolution.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderTiltShiftBlur(gl, runtime, inputTex, outputFbo, instance, options = {}) {
    const inputResolution = options.inputResolution || { w: runtime.renderWidth, h: runtime.renderHeight };
    const params = instance.params || {};
    const blurAmt = parseFloat(params.tiltShiftAmount ?? 10) / 100.0;
    
    if (blurAmt <= 0) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    const program = runtime.programs.tiltShiftBlur;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.blur2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    
    gl.uniform1i(gl.getUniformLocation(program, 'u_blurType'), parseInt(params.tiltShiftType || 0, 10));
    gl.uniform2f(gl.getUniformLocation(program, 'u_center'), parseFloat(params.tiltShiftCenterX ?? 0.5), parseFloat(params.tiltShiftCenterY ?? 0.5));
    gl.uniform1f(gl.getUniformLocation(program, 'u_focusRadius'), parseFloat(params.tiltShiftRadius ?? 30) / 100.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_transition'), parseFloat(params.tiltShiftTransition ?? 30) / 100.0);
    gl.uniform1f(gl.getUniformLocation(program, 'u_aspect'), inputResolution.w / inputResolution.h);
    gl.uniform1f(gl.getUniformLocation(program, 'u_rad'), blurAmt * 2.0);

    // Pass 1: Horizontal Blur
    gl.uniform2f(gl.getUniformLocation(program, 'u_dir'), 1.0 / inputResolution.w, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Pass 2: Vertical Blur
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, runtime.textures.blur2);
    gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
    gl.uniform2f(gl.getUniformLocation(program, 'u_dir'), 0.0, 1.0 / inputResolution.h);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function renderTextOverlay(gl, runtime, inputTex, outputFbo, instance, options = {}) {
    const inputResolution = options.inputResolution || { w: runtime.renderWidth, h: runtime.renderHeight };
    const asset = ensureTextLayerSurfaceAsset(gl, runtime, instance, options.documentState || {}, inputResolution);
    if (!asset?.texture) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    gl.useProgram(runtime.programs.textOverlay);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.viewport(0, 0, inputResolution.w, inputResolution.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.textOverlay, 'u_base'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, asset.texture);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.textOverlay, 'u_overlay'), 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform2f(gl.getUniformLocation(runtime.programs.textOverlay, 'u_res'), inputResolution.w, inputResolution.h);
    gl.uniform2f(gl.getUniformLocation(runtime.programs.textOverlay, 'u_overlayPos'), 0, 0);
    gl.uniform2f(gl.getUniformLocation(runtime.programs.textOverlay, 'u_overlaySize'), inputResolution.w, inputResolution.h);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.textOverlay, 'u_opacity'), asset.params.textOpacity);
    gl.uniform1f(gl.getUniformLocation(runtime.programs.textOverlay, 'u_rotationDegrees'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

const XYZ_TO_SRGB_MATRIX = Object.freeze([
    3.2406, -1.5372, -0.4986,
    -0.9689, 1.8758, 0.0415,
    0.0557, -0.2040, 1.0570
]);

const XYZ_TO_DISPLAY_P3_MATRIX = Object.freeze([
    2.4934969119, -0.9313836179, -0.4027107845,
    -0.8294889696, 1.7626640603, 0.0236246858,
    0.0358458302, -0.0761723893, 0.9568845240
]);

function invertMatrix3(matrix) {
    if (!Array.isArray(matrix) || matrix.length < 9) return null;
    const [
        a, b, c,
        d, e, f,
        g, h, i
    ] = matrix.map((value) => Number(value) || 0);
    const A = (e * i) - (f * h);
    const B = -((d * i) - (f * g));
    const C = (d * h) - (e * g);
    const D = -((b * i) - (c * h));
    const E = (a * i) - (c * g);
    const F = -((a * h) - (b * g));
    const G = (b * f) - (c * e);
    const H = -((a * f) - (c * d));
    const I = (a * e) - (b * d);
    const determinant = (a * A) + (b * B) + (c * C);
    if (Math.abs(determinant) < 1e-8) return null;
    const inverse = 1 / determinant;
    return [
        A * inverse, D * inverse, G * inverse,
        B * inverse, E * inverse, H * inverse,
        C * inverse, F * inverse, I * inverse
    ];
}

function multiplyMatrix3(left, right) {
    return [
        (left[0] * right[0]) + (left[1] * right[3]) + (left[2] * right[6]),
        (left[0] * right[1]) + (left[1] * right[4]) + (left[2] * right[7]),
        (left[0] * right[2]) + (left[1] * right[5]) + (left[2] * right[8]),
        (left[3] * right[0]) + (left[4] * right[3]) + (left[5] * right[6]),
        (left[3] * right[1]) + (left[4] * right[4]) + (left[5] * right[7]),
        (left[3] * right[2]) + (left[4] * right[5]) + (left[5] * right[8]),
        (left[6] * right[0]) + (left[7] * right[3]) + (left[8] * right[6]),
        (left[6] * right[1]) + (left[7] * right[4]) + (left[8] * right[7]),
        (left[6] * right[2]) + (left[7] * right[5]) + (left[8] * right[8])
    ];
}

function temperatureToRgb(temperatureKelvin) {
    const temp = clamp(Number(temperatureKelvin) || 6500, 1800, 50000) / 100;
    let red;
    let green;
    let blue;
    if (temp <= 66) {
        red = 255;
        green = 99.4708025861 * Math.log(temp) - 161.1195681661;
        blue = temp <= 19 ? 0 : (138.5177312231 * Math.log(temp - 10) - 305.0447927307);
    } else {
        red = 329.698727446 * Math.pow(temp - 60, -0.1332047592);
        green = 288.1221695283 * Math.pow(temp - 60, -0.0755148492);
        blue = 255;
    }
    return [
        clamp(red, 0, 255) / 255,
        clamp(green, 0, 255) / 255,
        clamp(blue, 0, 255) / 255
    ];
}

function getTemperatureTintGains(temperature, tint) {
    const temperatureRgb = temperatureToRgb(temperature);
    const tintShift = clamp(Number(tint || 0) / 100, -1, 1);
    return [
        1 / Math.max(1e-6, temperatureRgb[0]),
        1 / Math.max(1e-6, temperatureRgb[1] * (1 + tintShift * 0.35)),
        1 / Math.max(1e-6, temperatureRgb[2])
    ];
}

function getTemperatureTintShiftGains(temperature, tint) {
    const current = getTemperatureTintGains(temperature, tint);
    const neutral = getTemperatureTintGains(6500, 0);
    return [
        current[0] / Math.max(1e-6, neutral[0]),
        current[1] / Math.max(1e-6, neutral[1]),
        current[2] / Math.max(1e-6, neutral[2])
    ];
}

function getAsShotWhiteBalanceGains(source) {
    const neutral = Array.isArray(source?.metadata?.asShotNeutral) && source.metadata.asShotNeutral.length >= 3
        ? source.metadata.asShotNeutral
        : (Array.isArray(source?.probe?.asShotNeutral) ? source.probe.asShotNeutral : []);
    if (neutral.length < 3) return [1, 1, 1];
    const safeNeutral = neutral.slice(0, 3).map((value) => Math.max(1e-6, Number(value) || 1));
    const green = safeNeutral[1] || 1;
    return [
        green / safeNeutral[0],
        1,
        green / safeNeutral[2]
    ];
}

function resolveDngWhiteBalanceGains(source, params) {
    if (params.dngWhiteBalanceMode === 'custom') {
        return getTemperatureTintGains(params.dngTemperature, params.dngTint);
    }
    const base = getAsShotWhiteBalanceGains(source);
    const shift = getTemperatureTintShiftGains(params.dngTemperature, params.dngTint);
    return [
        base[0] * shift[0],
        base[1] * shift[1],
        base[2] * shift[2]
    ];
}

function resolveDngColorTransform(source, params) {
    if (params.dngApplyCameraMatrix === false || params.dngWorkingSpace === 'linear') {
        return {
            apply: false,
            matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1]
        };
    }
    const colorMatrix = Array.isArray(source?.metadata?.colorMatrix2) && source.metadata.colorMatrix2.length >= 9
        ? source.metadata.colorMatrix2.slice(0, 9)
        : Array.isArray(source?.metadata?.colorMatrix1) && source.metadata.colorMatrix1.length >= 9
            ? source.metadata.colorMatrix1.slice(0, 9)
            : Array.isArray(source?.probe?.colorMatrix2) && source.probe.colorMatrix2.length >= 9
                ? source.probe.colorMatrix2.slice(0, 9)
                : Array.isArray(source?.probe?.colorMatrix1) && source.probe.colorMatrix1.length >= 9
                    ? source.probe.colorMatrix1.slice(0, 9)
                    : null;
    const cameraToXyz = invertMatrix3(colorMatrix);
    if (!cameraToXyz) {
        return {
            apply: false,
            matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1]
        };
    }
    const xyzToTarget = params.dngWorkingSpace === 'display-p3'
        ? XYZ_TO_DISPLAY_P3_MATRIX
        : XYZ_TO_SRGB_MATRIX;
    return {
        apply: true,
        matrix: multiplyMatrix3(xyzToTarget, cameraToXyz)
    };
}

function resolveDngInterpretationMode(source, params) {
    const explicitMode = String(params?.dngInterpretationMode || 'auto');
    if (explicitMode !== 'auto') return explicitMode;
    const preset = String(params?.dngPreset || source?.preset || 'auto');
    if (preset === 'samsung-expert-raw-linear' || preset === 'generic-linear') return 'linear';
    if (preset === 'quad-bayer-mosaic') return 'quad';
    if (preset === 'interleaved-mosaic') return 'interleaved';
    return String(source?.probe?.classificationMode || 'bayer') || 'bayer';
}

function estimateStoredRangeScale(source) {
    if (Number.isFinite(source?.storedRangeScale) && source.storedRangeScale > 0) {
        return source.storedRangeScale;
    }
    const raster = source?.rawRaster || {};
    const whiteLevels = Array.isArray(source?.metadata?.whiteLevel) ? source.metadata.whiteLevel : [];
    const normalizedWhiteLevel = Math.max(1, Number(whiteLevels[0]) || 0);
    const bitsPerSample = Math.max(1, Math.min(24, Number(raster?.bitsPerSample) || 16));
    const containerMax = Math.max(1, (2 ** bitsPerSample) - 1);
    if (normalizedWhiteLevel >= containerMax * 0.75) {
        source.storedRangeScale = 1;
        return 1;
    }
    const data = raster?.data;
    if (!(data instanceof Float32Array) || !data.length) {
        source.storedRangeScale = 1;
        return 1;
    }
    const maxSamples = 8192;
    const step = Math.max(1, Math.floor(data.length / maxSamples));
    let observedMax = 0;
    for (let index = 0; index < data.length; index += step) {
        observedMax = Math.max(observedMax, Number(data[index]) || 0);
    }
    if (observedMax <= normalizedWhiteLevel * 1.5) {
        source.storedRangeScale = 1;
        return 1;
    }
    const ratio = observedMax / normalizedWhiteLevel;
    const suggestedShift = Math.max(0, Math.round(Math.log2(Math.max(1, ratio))));
    const maxShift = Math.max(0, bitsPerSample - Math.ceil(Math.log2(normalizedWhiteLevel + 1)));
    const shift = Math.min(suggestedShift, maxShift);
    source.storedRangeScale = shift > 0 ? (2 ** shift) : 1;
    return source.storedRangeScale;
}

function bindOptionalTexture(gl, texture, unit, fallbackTexture) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture || fallbackTexture);
}

function renderDngDevelop(gl, runtime, inputTex, outputFbo, instance, documentState, options = {}) {
    const source = runtime.dngSource;
    if (!source?.rawTexture) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    const params = normalizeDngDevelopParams(instance?.params, source?.probe);
    if (params.dngDevelopEnable === false) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    const inputResolution = options.inputResolution || { w: runtime.renderWidth, h: runtime.renderHeight };
    const geometry = computeDngDevelopGeometry(source, params);
    const placement = computeContainedPlacement(inputResolution.w, inputResolution.h, geometry.width, geometry.height);
    const developedWidth = Math.max(1, Math.round(placement.width));
    const developedHeight = Math.max(1, Math.round(placement.height));
    const sourcePool = runtime.ensureRenderPool(developedWidth, developedHeight);

    const developProgram = runtime.programs.dngDevelop;
    const compositeProgram = runtime.programs.dngComposite;
    const interpretationMode = resolveDngInterpretationMode(source, params);
    const previewQuality = documentState?.view?.highQualityPreview ? params.dngDemosaicQuality : 'fast';
    const wbGains = resolveDngWhiteBalanceGains(source, params);
    const colorTransform = resolveDngColorTransform(source, params);
    const blackRepeatDim = Array.isArray(source?.metadata?.blackLevelRepeatDim) && source.metadata.blackLevelRepeatDim.length >= 2
        ? source.metadata.blackLevelRepeatDim
        : Array.isArray(source?.probe?.blackLevelRepeatDim) && source.probe.blackLevelRepeatDim.length >= 2
            ? source.probe.blackLevelRepeatDim
            : [1, 1];
    const detectedBlack = Array.isArray(source?.metadata?.blackLevel) && source.metadata.blackLevel.length
        ? source.metadata.blackLevel
        : (Array.isArray(source?.probe?.blackLevel) ? source.probe.blackLevel : [0]);
    const manualBlack = Number(params.dngBlackLevel || 0);
    const blackLevels = new Float32Array(16);
    for (let index = 0; index < 16; index += 1) {
        blackLevels[index] = params.dngAutoBlackLevel !== false
            ? Number(detectedBlack[index] ?? detectedBlack[0] ?? 0)
            : manualBlack;
    }
    const detectedWhite = Array.isArray(source?.metadata?.whiteLevel) && source.metadata.whiteLevel.length
        ? Number(source.metadata.whiteLevel[0] || 0)
        : Number(source?.probe?.whiteLevel?.[0] || 0);
    const whiteLevel = params.dngAutoWhiteLevel !== false
        ? Math.max(1, detectedWhite * estimateStoredRangeScale(source))
        : Math.max(1, Number(params.dngWhiteLevel || 65535));
    const pattern = Array.isArray(source?.probe?.cfaPattern) && source.probe.cfaPattern.length
        ? source.probe.cfaPattern
        : [0, 1, 1, 2];
    const patternArray = new Int32Array(16);
    patternArray.fill(1);
    pattern.slice(0, 16).forEach((value, index) => {
        patternArray[index] = Math.max(0, Math.min(2, Number(value) || 0));
    });

    gl.useProgram(developProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, sourcePool.preview.fbo);
    gl.viewport(0, 0, developedWidth, developedHeight);
    bindOptionalTexture(gl, source.rawTexture, 0, runtime.textures.black);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_rawTex'), 0);
    bindOptionalTexture(gl, source.linearizationTexture, 1, runtime.textures.black);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_linearizationTex'), 1);
    gl.uniform2f(gl.getUniformLocation(developProgram, 'u_outputRes'), developedWidth, developedHeight);
    gl.uniform2f(gl.getUniformLocation(developProgram, 'u_rawRes'), source.rawTextureWidth, source.rawTextureHeight);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_samplesPerPixel'), Math.max(1, Number(source?.rawRaster?.samplesPerPixel) || 1));
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_interpretationMode'), interpretationMode === 'linear' ? 0 : 1);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_demosaicRadius'), previewQuality === 'high' ? 2 : 1);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_patternLength'), Math.max(1, pattern.length));
    gl.uniform2i(
        gl.getUniformLocation(developProgram, 'u_patternDim'),
        Math.max(1, Number(source?.probe?.cfaPatternWidth) || 2),
        Math.max(1, Number(source?.probe?.cfaPatternHeight) || 2)
    );
    gl.uniform1iv(gl.getUniformLocation(developProgram, 'u_pattern'), patternArray);
    gl.uniform2i(
        gl.getUniformLocation(developProgram, 'u_blackRepeatDim'),
        Math.max(1, Number(blackRepeatDim[0]) || 1),
        Math.max(1, Number(blackRepeatDim[1]) || 1)
    );
    gl.uniform1fv(gl.getUniformLocation(developProgram, 'u_blackLevel'), blackLevels);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_applyLinearization'), params.dngApplyLinearization !== false && source.linearizationSize > 0 ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_linearizationSize'), Math.max(0, Number(source.linearizationSize) || 0));
    gl.uniform1f(gl.getUniformLocation(developProgram, 'u_whiteLevel'), whiteLevel);
    gl.uniform3f(gl.getUniformLocation(developProgram, 'u_wbGains'), wbGains[0], wbGains[1], wbGains[2]);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_applyCameraMatrix'), colorTransform.apply ? 1 : 0);
    gl.uniformMatrix3fv(gl.getUniformLocation(developProgram, 'u_colorTransform'), false, new Float32Array(colorTransform.matrix));
    gl.uniform1f(gl.getUniformLocation(developProgram, 'u_exposureScale'), Math.pow(2, Number(params.dngExposure || 0)));
    gl.uniform1f(gl.getUniformLocation(developProgram, 'u_highlightStrength'), clamp(Number(params.dngHighlightRecovery || 0) / 100, 0, 1));
    gl.uniform1f(gl.getUniformLocation(developProgram, 'u_toneAmount'), clamp(Number(params.dngToneMappingAmount || 0) / 100, 0, 1));
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_partialFidelity'), source?.fidelity !== 'supported' ? 1 : 0);
    const gainMaps = Array.isArray(source.gainMapTextures) ? source.gainMapTextures : [];
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_gainMapCount'), Math.min(8, gainMaps.length));
    const gainRegion = new Float32Array(8 * 4);
    const gainGrid = new Float32Array(8 * 4);
    const gainSpacing = new Float32Array(8 * 4);
    const gainMapInfo = new Float32Array(8 * 4);
    for (let index = 0; index < 8; index += 1) {
        const entry = gainMaps[index];
        bindOptionalTexture(gl, entry?.texture || null, 2 + index, runtime.textures.white);
        gl.uniform1i(gl.getUniformLocation(developProgram, `u_gainTex${index}`), 2 + index);
        if (!entry) continue;
        gainRegion[(index * 4)] = Number(entry.top || 0);
        gainRegion[(index * 4) + 1] = Number(entry.left || 0);
        gainRegion[(index * 4) + 2] = Number(entry.bottom || 0);
        gainRegion[(index * 4) + 3] = Number(entry.right || 0);
        gainGrid[(index * 4)] = Math.max(1, Number(entry.mapPointsV) || entry.height || 1);
        gainGrid[(index * 4) + 1] = Math.max(1, Number(entry.mapPointsH) || entry.width || 1);
        gainGrid[(index * 4) + 2] = Math.max(1, Number(entry.rowPitch) || 1);
        gainGrid[(index * 4) + 3] = Math.max(1, Number(entry.colPitch) || 1);
        gainSpacing[(index * 4)] = Number(entry.mapSpacingH || 0);
        gainSpacing[(index * 4) + 1] = Number(entry.mapSpacingV || 0);
        gainSpacing[(index * 4) + 2] = Number(entry.mapOriginH || 0);
        gainSpacing[(index * 4) + 3] = Number(entry.mapOriginV || 0);
        gainMapInfo[(index * 4)] = Number(entry.plane ?? -1);
        gainMapInfo[(index * 4) + 1] = Number(entry.planes || 1);
        gainMapInfo[(index * 4) + 2] = Number(entry.mapPlanes || 1);
        gainMapInfo[(index * 4) + 3] = 0;
    }
    gl.uniform4fv(gl.getUniformLocation(developProgram, 'u_gainRegion'), gainRegion);
    gl.uniform4fv(gl.getUniformLocation(developProgram, 'u_gainGrid'), gainGrid);
    gl.uniform4fv(gl.getUniformLocation(developProgram, 'u_gainSpacing'), gainSpacing);
    gl.uniform4fv(gl.getUniformLocation(developProgram, 'u_gainMapInfo'), gainMapInfo);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_applyOpcodeCorrections'), params.dngApplyOpcodeCorrections !== false ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_applyGainMap'), params.dngApplyGainMap !== false ? 1 : 0);
    gl.uniform1i(gl.getUniformLocation(developProgram, 'u_orientation'), Math.round(Number(geometry.orientation) || 1));
    gl.uniform2f(gl.getUniformLocation(developProgram, 'u_cropOrigin'), Number(geometry.cropLeft || 0), Number(geometry.cropTop || 0));
    gl.uniform2f(gl.getUniformLocation(developProgram, 'u_cropSize'), Number(geometry.cropWidth || source?.probe?.width || developedWidth), Number(geometry.cropHeight || source?.probe?.height || developedHeight));
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    gl.useProgram(compositeProgram);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.viewport(0, 0, inputResolution.w, inputResolution.h);
    bindOptionalTexture(gl, inputTex, 0, runtime.textures.black);
    gl.uniform1i(gl.getUniformLocation(compositeProgram, 'u_input'), 0);
    bindOptionalTexture(gl, sourcePool.preview.tex, 1, runtime.textures.black);
    gl.uniform1i(gl.getUniformLocation(compositeProgram, 'u_sourceTex'), 1);
    gl.uniform2f(gl.getUniformLocation(compositeProgram, 'u_canvasRes'), inputResolution.w, inputResolution.h);
    gl.uniform4f(gl.getUniformLocation(compositeProgram, 'u_placement'), placement.x, placement.y, placement.width, placement.height);
    const denoiseMode = String(params.dngDenoiseMode || 'auto');
    const denoiseStrength = clamp(Number(params.dngDenoiseStrength || 0) / 100, 0, 1);
    const denoiseEnabled = (denoiseMode === 'auto' || denoiseMode === 'manual') && denoiseStrength > 0.01;
    gl.uniform1f(gl.getUniformLocation(compositeProgram, 'u_denoiseStrength'), denoiseStrength);
    gl.uniform1f(gl.getUniformLocation(compositeProgram, 'u_detailPreservation'), clamp(Number(params.dngDetailPreservation || 0) / 100, 0, 1));
    gl.uniform1f(gl.getUniformLocation(compositeProgram, 'u_sharpenAmount'), clamp(Number(params.dngSharpenAmount || 0) / 100, 0, 1));
    gl.uniform1i(gl.getUniformLocation(compositeProgram, 'u_denoiseEnabled'), denoiseEnabled ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
}

function isEnabled(instance, layerDef) {
    return layerDef.enableKey ? instance.enabled : true;
}

export function renderLayer(gl, runtime, layerDef, instance, inputTex, outputFbo, documentState, options = {}) {
    const ui = buildLegacyUI(documentState, instance, runtime.registry);
    if (!isEnabled(instance, layerDef) && !options.force) {
        bindCopy(gl, runtime, inputTex, outputFbo, 0);
        return;
    }

    if (layerDef.executor === 'shader') {
        renderGenericLayer(gl, runtime, layerDef, instance, inputTex, outputFbo, documentState, ui);
        return;
    }

    switch (layerDef.layerId) {
        case 'dngDevelop':
            renderDngDevelop(gl, runtime, inputTex, outputFbo, instance, documentState, options);
            break;
        case 'scale':
        case 'alpha':
            bindCopy(gl, runtime, inputTex, outputFbo, 0);
            break;
        case 'adjust':
            renderAdjust(gl, runtime, inputTex, outputFbo, ui);
            break;
        case 'hdr':
            renderHdr(gl, runtime, inputTex, outputFbo, ui);
            break;
        case 'noise':
            renderNoise(gl, runtime, inputTex, outputFbo, documentState, ui, instance);
            break;
        case 'blur':
            renderBlur(gl, runtime, inputTex, outputFbo, ui);
            break;
        case 'cell':
            renderCell(gl, runtime, inputTex, outputFbo, ui);
            break;
        case 'dither':
            renderDither(gl, runtime, inputTex, outputFbo, documentState, ui);
            break;
        case 'compression':
            renderCompression(gl, runtime, inputTex, outputFbo, ui);
            break;
        case 'palette':
            renderPalette(gl, runtime, inputTex, outputFbo, documentState, ui);
            break;
        case 'bgPatcher':
            renderBgPatcher(gl, runtime, inputTex, outputFbo, instance, options, documentState);
            break;
        case 'expander':
            renderExpander(gl, runtime, inputTex, outputFbo, instance, options);
            break;
        case 'cropTransform':
            renderCropTransform(gl, runtime, inputTex, outputFbo, instance, options);
            break;
        case 'textOverlay':
            renderTextOverlay(gl, runtime, inputTex, outputFbo, instance, {
                ...options,
                documentState
            });
            break;
        case 'tiltShiftBlur':
            renderTiltShiftBlur(gl, runtime, inputTex, outputFbo, instance, options);
            break;
        default:
            bindCopy(gl, runtime, inputTex, outputFbo, 0);
            break;
    }
}

export function renderPreviewTexture(gl, runtime, texture, outputFbo = null, channel = 0) {
    bindCopy(gl, runtime, texture, outputFbo, channel);
}

export function renderMaskPreview(gl, runtime, layerDef, instance, inputTex, documentState) {
    const ui = buildLegacyUI(documentState, instance, runtime.registry);
    return renderMaskFromDefinition(gl, runtime, inputTex, layerDef, ui);
}

export function getLegacyUI(documentState, instance, registry) {
    return buildLegacyUI(documentState, instance, registry);
}
