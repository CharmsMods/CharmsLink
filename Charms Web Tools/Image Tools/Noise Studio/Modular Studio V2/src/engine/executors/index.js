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
