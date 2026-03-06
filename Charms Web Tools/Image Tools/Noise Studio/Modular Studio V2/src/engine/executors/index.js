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

function renderNoise(gl, runtime, inputTex, outputFbo, documentState, ui) {
    gl.useProgram(runtime.programs.noise);
    gl.bindFramebuffer(gl.FRAMEBUFFER, runtime.fbos.tempNoise);
    gl.uniform1i(gl.getUniformLocation(runtime.programs.noise, 'u_type'), parseInt(ui.noiseType?.value || 0, 10));
    gl.uniform1f(gl.getUniformLocation(runtime.programs.noise, 'u_seed'), Math.random() * 100.0);
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

    const maskTex = renderMaskFromDefinition(gl, runtime, inputTex, runtime.registry.byId.noise, ui);
    gl.useProgram(runtime.programs.composite);
    gl.bindFramebuffer(gl.FRAMEBUFFER, outputFbo);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, maskTex || runtime.textures.white);
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
            renderNoise(gl, runtime, inputTex, outputFbo, documentState, ui);
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
