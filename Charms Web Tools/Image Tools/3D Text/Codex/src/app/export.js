import * as THREE from 'three';

export function downloadBlob(blob, filename) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

async function renderSamples(pathTracer, samples, onProgress) {
  for (let i = 0; i < samples; i += 1) {
    pathTracer.renderSample();
    if (onProgress) onProgress(i + 1, samples);
    if (i % 2 === 0) {
      await nextFrame();
    }
  }
}

async function canvasToBlob(canvas) {
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function captureTileBitmap(canvas) {
  if ('createImageBitmap' in window) {
    return await createImageBitmap(canvas);
  }
  const blob = await canvasToBlob(canvas);
  return await createImageBitmap(blob);
}

function createOutputCanvas(width, height) {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function outputCanvasToBlob(canvas) {
  if ('convertToBlob' in canvas) {
    return await canvas.convertToBlob({ type: 'image/png' });
  }
  return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

async function openTileDB() {
  if (!('indexedDB' in window)) {
    throw new Error('IndexedDB unavailable for tile storage.');
  }
  return await new Promise((resolve, reject) => {
    const request = indexedDB.open('tile-store', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('tiles')) {
        db.createObjectStore('tiles');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function storeTile(db, key, blob) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').put(blob, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadTile(db, key) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readonly');
    const request = tx.objectStore('tiles').get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function clearTiles(db) {
  return await new Promise((resolve, reject) => {
    const tx = db.transaction('tiles', 'readwrite');
    tx.objectStore('tiles').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function exportCurrentPNG(renderer, filename) {
  const blob = await canvasToBlob(renderer.domElement);
  if (!blob) throw new Error('Unable to export PNG.');
  downloadBlob(blob, filename);
}

export async function exportHighRes(options) {
  const {
    renderer,
    pathTracer,
    camera,
    width,
    height,
    samples,
    onStatus,
    onProgress
  } = options;

  const oldSize = renderer.getSize(new THREE.Vector2());
  const oldPixelRatio = renderer.getPixelRatio();
  const oldAspect = camera.aspect;
  const oldRenderScale = pathTracer.renderScale;

  const maxTextureSize = renderer.capabilities.maxTextureSize;
  const needsTiling = width > maxTextureSize || height > maxTextureSize;

  renderer.setPixelRatio(1);
  pathTracer.renderScale = 1;

  if (!needsTiling) {
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    pathTracer.reset();
    await renderSamples(pathTracer, samples, onProgress);

    const blob = await canvasToBlob(renderer.domElement);
    if (!blob) throw new Error('Unable to export PNG.');
    downloadBlob(blob, `render_${width}x${height}.png`);
  } else {
    const tilesX = Math.ceil(width / maxTextureSize);
    const tilesY = Math.ceil(height / maxTextureSize);
    const tileWidth = Math.ceil(width / tilesX);
    const tileHeight = Math.ceil(height / tilesY);

    onStatus?.(`Tile mode enabled (${tilesX} x ${tilesY}).`);

    let outputCanvas = null;
    let outputCtx = null;
    let useIDB = false;
    let db = null;

    try {
      outputCanvas = createOutputCanvas(width, height);
      outputCtx = outputCanvas.getContext('2d');
      outputCtx.imageSmoothingEnabled = false;
    } catch (error) {
      onStatus?.('Memory limit encountered. Storing tiles in IndexedDB.');
      useIDB = true;
      db = await openTileDB();
    }

    for (let y = 0; y < tilesY; y += 1) {
      for (let x = 0; x < tilesX; x += 1) {
        const offsetX = x * tileWidth;
        const offsetY = y * tileHeight;
        const w = Math.min(tileWidth, width - offsetX);
        const h = Math.min(tileHeight, height - offsetY);

        // Pixel-perfect tile rendering using camera view offsets.
        camera.setViewOffset(width, height, offsetX, offsetY, w, h);
        camera.updateProjectionMatrix();

        renderer.setSize(w, h, false);
        pathTracer.reset();
        await renderSamples(pathTracer, samples, onProgress);

        if (useIDB) {
          const blob = await canvasToBlob(renderer.domElement);
          await storeTile(db, `${x}_${y}`, blob);
        } else {
          try {
            const bitmap = await captureTileBitmap(renderer.domElement);
            outputCtx.drawImage(bitmap, offsetX, offsetY, w, h);
          } catch (error) {
            onStatus?.('Memory limit encountered during stitching. Switching to IndexedDB.');
            useIDB = true;
            db = await openTileDB();
            const blob = await canvasToBlob(renderer.domElement);
            await storeTile(db, `${x}_${y}`, blob);
          }
        }
      }
    }

    camera.clearViewOffset();

    if (useIDB) {
      if (!outputCanvas) {
        outputCanvas = createOutputCanvas(width, height);
        outputCtx = outputCanvas.getContext('2d');
        outputCtx.imageSmoothingEnabled = false;
      }

      for (let y = 0; y < tilesY; y += 1) {
        for (let x = 0; x < tilesX; x += 1) {
          const offsetX = x * tileWidth;
          const offsetY = y * tileHeight;
          const w = Math.min(tileWidth, width - offsetX);
          const h = Math.min(tileHeight, height - offsetY);
          const blob = await loadTile(db, `${x}_${y}`);
          if (blob) {
            const bitmap = await createImageBitmap(blob);
            outputCtx.drawImage(bitmap, offsetX, offsetY, w, h);
          }
        }
      }
      await clearTiles(db);
    }

    const finalBlob = await outputCanvasToBlob(outputCanvas);
    downloadBlob(finalBlob, `render_${width}x${height}.png`);
  }

  renderer.setSize(oldSize.x, oldSize.y, false);
  renderer.setPixelRatio(oldPixelRatio);
  camera.aspect = oldAspect;
  camera.updateProjectionMatrix();
  pathTracer.renderScale = oldRenderScale;
  pathTracer.reset();
}
