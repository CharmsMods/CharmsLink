import * as THREE from 'three';
import { initRenderer, fitCameraToObject } from './app/renderer.js';
import { enableBVH, buildBVHForScene, disposeBVHForScene } from './app/bvh.js';
import { loadModelFromFile, disposeObject, sanitizeFileName } from './app/loaders.js';
import { SimplifyModifier } from 'three/addons/modifiers/SimplifyModifier.js';
import {
  applyGlassToScene,
  updateGlassMaterial,
  applyTextureOverlay,
  applyTextureTransform,
  updateOpacityChain
} from './app/materials.js';
import { initUI } from './app/ui.js';
import { exportCurrentPNG, exportHighRes } from './app/export.js';

const ui = initUI();

const state = {
  isPaused: true,
  isRendering: false,
  sampleCount: 0,
  maxSamples: 512,
  autoExport: false,
  autoExportThreshold: 512,
  autoExportTriggered: false,
  renderScale: 1,
  baseOpacity: 1,
  textureAlpha: 1,
  glassParams: {
    transmission: 1,
    opacity: 1,
    ior: 1.5,
    roughness: 0,
    thickness: 0.1,
    tintColor: '#ffffff',
    normalMapIntensity: 0
  },
  textureTransform: {
    scaleX: 1,
    scaleY: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0
  },
  currentModel: null,
  overlayTexture: null,
  excludeNames: new Set()
};

const canvas = document.getElementById('viewport');
const logStatus = (message) => ui.logStatus(message);

if (!('gpu' in navigator)) {
  logStatus('WebGPU not available. Using WebGL2 fallback.');
}

enableBVH();

let rendererApi;
try {
  rendererApi = initRenderer(canvas, logStatus);
} catch (error) {
  logStatus(error.message);
  throw error;
}

const { renderer, scene, camera, controls, pathTracer } = rendererApi;

controls.addEventListener('change', () => {
  if (state.isRendering) {
    pathTracer.reset();
    state.sampleCount = 0;
    ui.setSampleCount(0);
    logStatus('Camera moved. Samples reset.');
  }
});

function updateGlassParams() {
  if (!state.currentModel) return;
  state.glassParams.opacity = state.baseOpacity * state.textureAlpha;
  state.currentModel.traverse((child) => {
    if (child.isMesh && child.material && child.material.isMeshPhysicalMaterial) {
      updateGlassMaterial(child.material, state.glassParams);
    }
  });
  pathTracer.reset();
  state.sampleCount = 0;
}

function updateTextureSettings() {
  if (!state.currentModel) return;
  applyTextureOverlay(state.currentModel, state.overlayTexture, state.textureAlpha, state.textureTransform);
  applyTextureTransform(state.overlayTexture, state.textureTransform);
  updateOpacityChain(state.currentModel, state.baseOpacity, state.textureAlpha);
  pathTracer.reset();
  state.sampleCount = 0;
}

function setExcludeNames(value) {
  const names = value
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  state.excludeNames = new Set(names);
}

async function loadModel(file) {
  if (!file) return;
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['glb', 'gltf', 'obj', 'fbx', 'ply'].includes(extension)) {
    logStatus('Unsupported file type.');
    return;
  }
  if (file.size > 1024 * 1024 * 200) {
    logStatus('Large file detected. Loading may take a while.');
  }

  try {
    const { root, warnings, stats } = await loadModelFromFile(file, renderer);
    warnings.forEach((warning) => logStatus(warning));

    if (stats.skinned) {
      logStatus('Skinned meshes detected. Skinned animations are not supported for path tracing.');
    }

    if (stats.triangles > 2000000) {
      const proceed = window.confirm(`Model has ${stats.triangles.toLocaleString()} triangles. Continue?`);
      if (!proceed) return;
    } else if (stats.triangles > 1000000) {
      logStatus(`Warning: model has ${stats.triangles.toLocaleString()} triangles.`);
    }

    if (state.currentModel) {
      disposeBVHForScene(state.currentModel);
      disposeObject(state.currentModel);
      scene.remove(state.currentModel);
    }

    state.currentModel = root;
    setExcludeNames(ui.el.excludeMeshes.value);
    applyGlassToScene(root, state.glassParams, { excludeNames: state.excludeNames });
    if (state.overlayTexture) {
      applyTextureOverlay(root, state.overlayTexture, state.textureAlpha, state.textureTransform);
    }
    updateOpacityChain(root, state.baseOpacity, state.textureAlpha);
    buildBVHForScene(root);
    scene.add(root);

    fitCameraToObject(camera, controls, root);
    pathTracer.setScene(scene, camera);
    pathTracer.reset();
    state.sampleCount = 0;
    ui.setSampleCount(0);
    ui.setFileInfo(`${sanitizeFileName(file.name)} | ${stats.triangles.toLocaleString()} tris`);

    state.isPaused = false;
    startRendering();
    logStatus('Model loaded and converted to glass.');
  } catch (error) {
    logStatus(`Load error: ${error.message}`);
  }
}

async function loadTexture(file) {
  if (!file) return;
  const url = URL.createObjectURL(file);
  const texture = await new THREE.TextureLoader().loadAsync(url);
  URL.revokeObjectURL(url);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  state.overlayTexture = texture;
  updateTextureSettings();
  logStatus('Texture overlay applied.');
}

let rafId = null;

function renderLoop() {
  if (!state.isRendering) return;
  if (!state.isPaused) {
    pathTracer.renderSample();
    state.sampleCount = pathTracer.samples;
    ui.setSampleCount(state.sampleCount);

    if (state.autoExport && !state.autoExportTriggered && state.sampleCount >= state.autoExportThreshold) {
      state.autoExportTriggered = true;
      autoExport();
    }

    if (state.maxSamples > 0 && state.sampleCount >= state.maxSamples) {
      state.isPaused = true;
      logStatus('Max samples reached. Rendering paused.');
    }
  }

  controls.update();
  rafId = requestAnimationFrame(renderLoop);
}

function startRendering() {
  if (state.isRendering) return;
  state.isRendering = true;
  state.isPaused = false;
  rafId = requestAnimationFrame(renderLoop);
}

function stopRendering() {
  state.isRendering = false;
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function togglePause() {
  state.isPaused = !state.isPaused;
}

function resetSamples() {
  pathTracer.reset();
  state.sampleCount = 0;
  ui.setSampleCount(0);
  state.autoExportTriggered = false;
}

function reduceRenderScale() {
  const nextScale = Math.max(0.25, state.renderScale * 0.5);
  state.renderScale = nextScale;
  ui.el.renderScale.value = nextScale.toFixed(2);
  ui.updateRangeOutputs();
  rendererApi.setRenderScale(state.renderScale);
  resetSamples();
  logStatus(`Render scale reduced to ${nextScale.toFixed(2)}.`);
}

function reduceGeometry() {
  if (!state.currentModel) return;
  const modifier = new SimplifyModifier();
  state.currentModel.traverse((child) => {
    if (child.isMesh && child.geometry && child.geometry.attributes.position) {
      const count = child.geometry.attributes.position.count;
      const target = Math.max(4, Math.floor(count * 0.5));
      const simplified = modifier.modify(child.geometry, target);
      child.geometry.dispose();
      child.geometry = simplified;
    }
  });
  disposeBVHForScene(state.currentModel);
  buildBVHForScene(state.currentModel);
  resetSamples();
  logStatus('Geometry reduced by 50%.');
}

async function autoExport() {
  if (!state.currentModel) return;
  const width = Number(ui.el.exportWidth.value);
  const height = Number(ui.el.exportHeight.value);
  const samples = Number(ui.el.autoExportSamples.value);
  logStatus(`Auto exporting at ${width}x${height} after ${samples} samples.`);
  const wasPaused = state.isPaused;
  state.isPaused = true;
  await exportHighRes({
    renderer,
    pathTracer,
    camera,
    width,
    height,
    samples,
    onStatus: logStatus
  });
  state.isPaused = wasPaused;
}

ui.el.modelInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  loadModel(file);
});

ui.el.textureInput.addEventListener('change', (event) => {
  const file = event.target.files?.[0];
  loadTexture(file);
});

ui.el.excludeMeshes.addEventListener('change', (event) => {
  setExcludeNames(event.target.value);
  if (state.currentModel) {
    applyGlassToScene(state.currentModel, state.glassParams, { excludeNames: state.excludeNames });
    if (state.overlayTexture) {
      applyTextureOverlay(state.currentModel, state.overlayTexture, state.textureAlpha, state.textureTransform);
    }
    pathTracer.reset();
    state.sampleCount = 0;
  }
});

ui.el.transmission.addEventListener('input', (event) => {
  state.glassParams.transmission = Number(event.target.value);
  ui.updateRangeOutputs();
  updateGlassParams();
});

ui.el.opacity.addEventListener('input', (event) => {
  const raw = Number(event.target.value);
  state.baseOpacity = raw / 255;
  ui.updateOpacity(raw);
  if (state.currentModel) {
    updateOpacityChain(state.currentModel, state.baseOpacity, state.textureAlpha);
  }
  updateGlassParams();
});

ui.el.ior.addEventListener('input', (event) => {
  state.glassParams.ior = Number(event.target.value);
  ui.updateRangeOutputs();
  updateGlassParams();
});

ui.el.roughness.addEventListener('input', (event) => {
  state.glassParams.roughness = Number(event.target.value);
  ui.updateRangeOutputs();
  updateGlassParams();
});

ui.el.thickness.addEventListener('input', (event) => {
  state.glassParams.thickness = Number(event.target.value);
  ui.updateRangeOutputs();
  updateGlassParams();
});

ui.el.tintColor.addEventListener('input', (event) => {
  state.glassParams.tintColor = event.target.value;
  updateGlassParams();
});

ui.el.normalIntensity.addEventListener('input', (event) => {
  state.glassParams.normalMapIntensity = Number(event.target.value);
  ui.updateRangeOutputs();
  updateGlassParams();
});

ui.el.textureAlpha.addEventListener('input', (event) => {
  const raw = Number(event.target.value);
  state.textureAlpha = raw / 255;
  ui.updateTextureAlpha(raw);
  updateTextureSettings();
});

const textureMap = {
  texScaleX: 'scaleX',
  texScaleY: 'scaleY',
  texOffsetX: 'offsetX',
  texOffsetY: 'offsetY',
  texRotation: 'rotation'
};

Object.keys(textureMap).forEach((id) => {
  ui.el[id].addEventListener('input', (event) => {
    const value = Number(event.target.value);
    state.textureTransform[textureMap[id]] = value;
    updateTextureSettings();
  });
});

ui.el.startBtn.addEventListener('click', () => {
  state.isPaused = false;
  startRendering();
});

ui.el.pauseBtn.addEventListener('click', () => {
  togglePause();
});

ui.el.stopBtn.addEventListener('click', () => {
  stopRendering();
});

ui.el.resetBtn.addEventListener('click', () => {
  resetSamples();
});

ui.el.maxSamples.addEventListener('change', (event) => {
  state.maxSamples = Number(event.target.value);
});

ui.el.renderScale.addEventListener('input', (event) => {
  state.renderScale = Number(event.target.value);
  ui.updateRangeOutputs();
  rendererApi.setRenderScale(state.renderScale);
  resetSamples();
});

ui.el.reduceScale.addEventListener('click', () => {
  reduceRenderScale();
});

ui.el.reduceGeometry.addEventListener('click', () => {
  reduceGeometry();
});

ui.el.resolutionPreset.addEventListener('change', (event) => {
  const value = event.target.value;
  if (value !== 'custom') {
    ui.el.exportWidth.value = value;
    ui.el.exportHeight.value = value;
  }
});

ui.el.exportCurrent.addEventListener('click', async () => {
  if (!state.currentModel) return;
  await exportCurrentPNG(renderer, 'render_current.png');
});

ui.el.exportHighRes.addEventListener('click', async () => {
  if (!state.currentModel) return;
  const width = Number(ui.el.exportWidth.value);
  const height = Number(ui.el.exportHeight.value);
  const samples = Number(ui.el.maxSamples.value) || 1;
  const wasPaused = state.isPaused;
  state.isPaused = true;
  await exportHighRes({
    renderer,
    pathTracer,
    camera,
    width,
    height,
    samples,
    onStatus: logStatus
  });
  state.isPaused = wasPaused;
});

ui.el.autoExport.addEventListener('change', (event) => {
  state.autoExport = event.target.checked;
  state.autoExportTriggered = false;
});

ui.el.autoExportSamples.addEventListener('change', (event) => {
  state.autoExportThreshold = Number(event.target.value);
});

ui.el.themeToggle.addEventListener('click', () => {
  const current = document.body.getAttribute('data-theme');
  if (current === 'warm') {
    document.body.removeAttribute('data-theme');
  } else {
    document.body.setAttribute('data-theme', 'warm');
  }
});

document.addEventListener('dragover', (event) => {
  event.preventDefault();
  ui.toggleDropHint(true);
});

document.addEventListener('dragleave', () => {
  ui.toggleDropHint(false);
});

document.addEventListener('drop', (event) => {
  event.preventDefault();
  ui.toggleDropHint(false);
  const file = event.dataTransfer.files?.[0];
  loadModel(file);
});

canvas.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  logStatus('WebGL context lost. Try Reduce Render Scale 50% or Reduce Geometry 50%, then reload.');
  state.isRendering = false;
});

canvas.addEventListener('webglcontextrestored', () => {
  logStatus('WebGL context restored. Reload the page to continue.');
});

ui.bindKeyboardShortcuts({
  onTogglePause: () => togglePause(),
  onReset: () => resetSamples(),
  onScreenshot: () => exportCurrentPNG(renderer, 'render_current.png')
});

window.addEventListener('resize', () => {
  rendererApi.resize(window.innerWidth, window.innerHeight);
  pathTracer.reset();
  state.sampleCount = 0;
  ui.setSampleCount(0);
});

state.isRendering = true;
state.isPaused = true;
renderLoop();
