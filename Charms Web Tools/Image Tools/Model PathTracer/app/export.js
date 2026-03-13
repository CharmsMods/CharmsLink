import * as THREE from 'three';

export async function exportPNG(state) {
    if (!state.renderer || !state.pathTracer) return;
    
    const w = state.guiSettings.ExportRes;
    const h = state.guiSettings.ExportRes; // assuming square for now, or could bind W/H
    
    // Temporary pause
    const wasPaused = state.paused;
    state.paused = true;
    window.showLoading(`Exporting ${w}x${h}...`);
    
    const maxTexSize = state.renderer.capabilities.maxTextureSize;
    
    // Delay to let UI update
    await new Promise(r => setTimeout(r, 100));

    try {
        if (w <= maxTexSize && h <= maxTexSize) {
            await doStandardExport(state, w, h);
        } else {
            await doTiledExport(state, w, h, maxTexSize);
        }
    } catch (e) {
        console.error(e);
        window.showError("Export failed: " + e.message);
    } finally {
        window.hideLoading();
        state.paused = wasPaused;
    }
}

async function doStandardExport(state, w, h) {
    const r = state.renderer;
    const c = state.camera;
    
    const oldW = r.domElement.width / r.getPixelRatio();
    const oldH = r.domElement.height / r.getPixelRatio();
    const oldAspect = c.aspect;
    
    // Resize
    c.aspect = w / h;
    c.updateProjectionMatrix();
    r.setSize(w, h);
    
    // For path tracer, it already renders to a texture. If we change size, 
    // it normally drops accumulation. We might need to either re-render N samples here, 
    // or just capture the screen if we're saving the current on-screen buffer.
    // The spec asks for canonical ThreeJS resize -> render -> blob.
    // Let's force a quick sample render at this resolution.
    state.pathTracer.updateCamera();
    
    // Note: Rendering high res path tracing instantly takes too long. 
    // If the user wants an instant export, we should just dump the canvas as is.
    // However, if they want a *new* resolution, we have to accumulate.
    // We'll do a simple quick render.
    for(let i=0; i < state.guiSettings.MaxSamples; i++) {
        state.pathTracer.renderSample();
    }
    
    // Actually render the path tracer output to the canvas
    r.render(state.scene, c);

    // Extract Blob
    const blob = await new Promise(res => r.domElement.toBlob(res, 'image/png'));
    downloadBlob(blob, 'render.png');
    
    // Restore
    r.setSize(oldW, oldH);
    c.aspect = oldAspect;
    c.updateProjectionMatrix();
    state.pathTracer.updateCamera(); // reset
}

async function doTiledExport(state, w, h, maxTexSize) {
    // Tiling fallback
    window.showError("Tiled rendering for oversized textures not fully implemented in this MVP.", 4000);
}

function downloadBlob(blob, filename) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
}

// Bind to window for auto export calls
window.exportPNG = (res) => {
    // Dirty globbing state from global scope for simplicity if called from auto-export timeout
    const ev = new CustomEvent('doExport', { detail: res });
    window.dispatchEvent(ev);
}
