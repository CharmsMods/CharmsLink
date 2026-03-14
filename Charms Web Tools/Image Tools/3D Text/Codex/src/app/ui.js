export function initUI() {
  const el = {
    modelInput: document.getElementById('modelInput'),
    textureInput: document.getElementById('textureInput'),
    transmission: document.getElementById('transmission'),
    transmissionOut: document.getElementById('transmissionOut'),
    opacity: document.getElementById('opacity'),
    opacityRaw: document.getElementById('opacityRaw'),
    opacityPct: document.getElementById('opacityPct'),
    opacityNorm: document.getElementById('opacityNorm'),
    ior: document.getElementById('ior'),
    iorOut: document.getElementById('iorOut'),
    roughness: document.getElementById('roughness'),
    roughnessOut: document.getElementById('roughnessOut'),
    thickness: document.getElementById('thickness'),
    thicknessOut: document.getElementById('thicknessOut'),
    tintColor: document.getElementById('tintColor'),
    normalIntensity: document.getElementById('normalIntensity'),
    normalOut: document.getElementById('normalOut'),
    textureAlpha: document.getElementById('textureAlpha'),
    textureAlphaRaw: document.getElementById('textureAlphaRaw'),
    textureAlphaPct: document.getElementById('textureAlphaPct'),
    textureAlphaNorm: document.getElementById('textureAlphaNorm'),
    texScaleX: document.getElementById('texScaleX'),
    texScaleY: document.getElementById('texScaleY'),
    texOffsetX: document.getElementById('texOffsetX'),
    texOffsetY: document.getElementById('texOffsetY'),
    texRotation: document.getElementById('texRotation'),
    sampleCount: document.getElementById('sampleCount'),
    startBtn: document.getElementById('startBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    stopBtn: document.getElementById('stopBtn'),
    resetBtn: document.getElementById('resetBtn'),
    maxSamples: document.getElementById('maxSamples'),
    renderScale: document.getElementById('renderScale'),
    renderScaleOut: document.getElementById('renderScaleOut'),
    reduceScale: document.getElementById('reduceScale'),
    reduceGeometry: document.getElementById('reduceGeometry'),
    resolutionPreset: document.getElementById('resolutionPreset'),
    exportWidth: document.getElementById('exportWidth'),
    exportHeight: document.getElementById('exportHeight'),
    exportCurrent: document.getElementById('exportCurrent'),
    exportHighRes: document.getElementById('exportHighRes'),
    autoExport: document.getElementById('autoExport'),
    autoExportSamples: document.getElementById('autoExportSamples'),
    statusLog: document.getElementById('statusLog'),
    fileInfo: document.getElementById('fileInfo'),
    dropHint: document.getElementById('dropHint'),
    themeToggle: document.getElementById('themeToggle'),
    excludeMeshes: document.getElementById('excludeMeshes')
  };

  updateRangeOutput(el.transmission, el.transmissionOut);
  updateRangeOutput(el.ior, el.iorOut);
  updateRangeOutput(el.roughness, el.roughnessOut);
  updateRangeOutput(el.thickness, el.thicknessOut);
  updateRangeOutput(el.normalIntensity, el.normalOut);
  updateRangeOutput(el.renderScale, el.renderScaleOut);

  updateAlphaReadout(el.opacity.value, el.opacityRaw, el.opacityPct, el.opacityNorm);
  updateAlphaReadout(el.textureAlpha.value, el.textureAlphaRaw, el.textureAlphaPct, el.textureAlphaNorm);

  return {
    el,
    updateOpacity(value) {
      updateAlphaReadout(value, el.opacityRaw, el.opacityPct, el.opacityNorm);
    },
    updateTextureAlpha(value) {
      updateAlphaReadout(value, el.textureAlphaRaw, el.textureAlphaPct, el.textureAlphaNorm);
    },
    updateRangeOutputs() {
      updateRangeOutput(el.transmission, el.transmissionOut);
      updateRangeOutput(el.ior, el.iorOut);
      updateRangeOutput(el.roughness, el.roughnessOut);
      updateRangeOutput(el.thickness, el.thicknessOut);
      updateRangeOutput(el.normalIntensity, el.normalOut);
      updateRangeOutput(el.renderScale, el.renderScaleOut);
    },
    setSampleCount(value) {
      el.sampleCount.textContent = value.toString();
    },
    setFileInfo(text) {
      el.fileInfo.textContent = text;
    },
    logStatus(message) {
      const line = document.createElement('div');
      line.textContent = message;
      el.statusLog.prepend(line);
    },
    toggleDropHint(show) {
      el.dropHint.classList.toggle('hidden', !show);
    },
    bindKeyboardShortcuts(handlers) {
      window.addEventListener('keydown', (event) => {
        if (event.code === 'Space') {
          event.preventDefault();
          handlers.onTogglePause?.();
        }
        if (event.code === 'KeyS') {
          handlers.onScreenshot?.();
        }
        if (event.code === 'KeyR') {
          handlers.onReset?.();
        }
      });
    }
  };
}

function updateAlphaReadout(value, rawEl, pctEl, normEl) {
  const raw = Number(value);
  const pct = (raw / 255) * 100;
  const norm = raw / 255;
  rawEl.textContent = `Raw: ${raw}`;
  pctEl.textContent = `Percent: ${pct.toFixed(1)}%`;
  normEl.textContent = `Normalized: ${norm.toFixed(3)}`;
}

function updateRangeOutput(rangeEl, outputEl) {
  outputEl.textContent = Number(rangeEl.value).toFixed(2);
}
