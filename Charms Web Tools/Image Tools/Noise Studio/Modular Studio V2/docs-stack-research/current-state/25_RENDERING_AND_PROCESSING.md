# Rendering and Processing Pipelines

## 1. Purpose
This document describes the rendering architecture across all sections — how visual output is produced from document state. It covers the Editor's WebGL2 rendering pipeline, the Composite's Canvas 2D engine, the 3D path-tracing engine, and the Stitch blending compositor. It also covers the shared WASM acceleration layer and GPU capabilities detection.

## 2. Scope
Covers `src/engine/bootstrap.js` (WebGL2 initialization), `src/engine/pipeline.js` (NoiseStudioEngine class), `src/engine/executors/` (layer executors), `src/composite/engine.js`, `src/3d/engine.js`, `src/stitch/engine.js`, `src/graphics/capabilities.js` (GPU probing), and `src/wasm/` (Emscripten WASM runtimes).

## 3. Verification State
- **Verified from Source:**
  - `src/engine/bootstrap.js` (complete 94 lines: WebGL2 context, shader compilation, program linking, quad VBO)
  - `src/engine/pipeline.js` lines 1–800 (NoiseStudioEngine class, constructor, init, texture management, DNG source loading, pool allocation, render scheduling, scope analysis blit, resize logic)
  - `src/graphics/capabilities.js` (complete 64 lines: WebGL/WebGL2 probe, max texture/renderbuffer/viewport detection)
  - `src/wasm/common.js` (complete 97 lines: Emscripten runtime manager with SIMD variant selection)
  - `src/wasm/editorRuntime.js` (complete 110 lines: Editor WASM with histogram/vectorscope/parade/diff/palette kernels)
  - `src/wasm/libraryRuntime.js` (complete 99 lines: Library WASM with base64 encode/decode kernels)
  - `src/composite/engine.js` (369 lines, previously verified)
  - `src/stitch/engine.js` (1528 lines, previously verified)
  - `src/3d/engine.js` (800 of 2491 lines, previously verified)
- **Inferred Behavior:** The full render pass logic in `pipeline.js` (lines 800–2000), the layer executor implementations in `src/engine/executors/index.js` (90KB), and the scope analysis computation are inferred from the constructor setup and document model.

## 4. Cross-System Dependencies
- **WebGL2 → Editor:** The Editor's `NoiseStudioEngine` requires WebGL2 with `EXT_color_buffer_float` and `OES_texture_float_linear` extensions.
- **WASM → Workers:** Editor and Library WASM runtimes are loaded inside their respective workers; they provide accelerated kernels that fall back to JavaScript if WASM/SIMD is unavailable.
- **GPU Caps → Settings:** `detectGraphicsCapabilities()` results flow into `settings.composite.diagnostics` (maxTextureSize, gpuSafeMaxEdge, etc.) and influence export thresholds.
- **Canvas 2D → Composite/Stitch:** Both the Composite and Stitch engines use Canvas 2D for their rendering (not WebGL).
- **Three.js → 3D:** The 3D engine has its own independent WebGL renderer via Three.js (separate from the Editor's WebGL2 context).

## 5. State Behavior
- **Saved (Durable):** None — rendering pipelines are entirely runtime state.
- **Runtime-only:** WebGL contexts, GPU programs, texture pools, FBO pools, path tracer state, WASM module instances, canvas surfaces.
- **Derived/Cached:** FBO pools keyed by resolution (`WxH`), layer resolution maps, thumbnail/analysis static FBOs, WASM runtime caches (keyed by SIMD preference).

---

## 6. Current Behavior

### 6.1 Editor WebGL2 Pipeline

#### Bootstrap (`engine/bootstrap.js`)
**[VERIFIED]** `bootstrapEngine(canvas, registry, callbacks)` initializes:
1. Creates a `WebGL2RenderingContext` with `antialias: false`, `premultipliedAlpha: false`, `preserveDrawingBuffer: true`.
2. Enables extensions: `EXT_color_buffer_float`, `OES_texture_float_linear`.
3. Sets `UNPACK_FLIP_Y_WEBGL = true` globally.
4. Fetches the shared vertex shader source and all fragment shader sources (from registry layer definitions + utility programs).
5. Compiles all shaders, links all programs.
6. Creates a fullscreen quad VBO (2 triangles, 4 vertices with position + UV attributes).
7. Sets up attribute pointers for all programs.
8. Registers `webglcontextlost` and `webglcontextrestored` event handlers.

#### Engine Class (`engine/pipeline.js`)
**[VERIFIED]** `NoiseStudioEngine` maintains:
- `runtime.gl` — WebGL2 context.
- `runtime.programs` — Named GPU programs keyed by `programKey` from registry.
- `runtime.textures` — Named textures (base image, white/black sentinel pixels, per-FBO pool textures).
- `runtime.fboPools` — Resolution-keyed pools of framebuffer objects, each containing: `pingPong0`, `pingPong1`, `tempNoise`, `blur1`, `blur2`, `preview`, `chainCapture`, `dngBase`, `maskTotal`.
- `runtime.layerResolutions` — Per-layer-instance resolution map (computed by walking the layer stack and applying scale/expander/crop transforms).
- Static analysis buffers: thumbnail FBO (320×320), analysis FBO (256×256).

#### Render Scheduling
**[VERIFIED]** `requestRender(documentState, options)` uses `requestAnimationFrame` to coalesce multiple render requests per frame. Multiple calls within the same frame merge options, with callbacks chained. The actual `render()` call happens once per frame.

#### Resolution Reallocation
**[VERIFIED]** `reallocateBuffers(documentState, fullRes)` walks the layer stack top-to-bottom, computing cumulative resolution changes:
- **Scale layers** multiply the running resolution by their scale factor.
- **Expander layers** add uniform padding (clamped to `MAX_TEXTURE_SIZE`).
- **CropTransform layers** crop and potentially rotate the running resolution.
- **DngDevelop layers** recompute source placement geometry.

Each layer instance gets an entry in `layerResolutions` and `layerLayouts`, and the corresponding FBO pool is allocated.

### 6.2 Composite Canvas 2D Rendering
**[VERIFIED]** (See `14_COMPOSITE.md`.) The Composite engine draws layers sequentially onto a 2D canvas, applying position, rotation, scale, opacity, and blend mode per layer. Export can route to a background worker (`composite.worker.js`) that uses `OffscreenCanvas` for rendering.

### 6.3 3D Three.js Rendering
**[VERIFIED]** (See `15_THREED.md`.) Three render modes:
- **Raster:** Standard Three.js WebGL rendering.
- **Pathtrace:** Progressive accumulation via `three-gpu-pathtracer` with adaptive cadence and viewport denoising.
- **Mesh:** Wireframe overlay.

### 6.4 Stitch Multi-Band Blending
**[VERIFIED]** (See `16_STITCH.md`.) The Stitch engine renders composites via Canvas 2D with advanced blending algorithms (alpha, feather, seam) layered with gain compensation and Laplacian pyramid multi-band blending.

### 6.5 GPU Capabilities Detection (`graphics/capabilities.js`)
**[VERIFIED]** `detectGraphicsCapabilities()` creates a disposable canvas, obtains the best available WebGL context (WebGL2 → WebGL → experimental-webgl), and queries:
- `MAX_TEXTURE_SIZE`
- `MAX_RENDERBUFFER_SIZE`
- `MAX_VIEWPORT_DIMS` (width and height)
- Derived: `gpuSafeMaxEdge = min(all positive limits)`
- Convenience booleans: `webglAvailable`, `webgl2Available`

After probing, the context is intentionally destroyed via `WEBGL_lose_context`.

### 6.6 WASM Acceleration Layer

#### Common Runtime Manager (`wasm/common.js`)
**[VERIFIED]** `createOptionalEmscriptenRuntimeManager(config)` creates a lazy, cached loader for Emscripten WASM modules:
- Accepts multiple **variants** (e.g., `baseline`, `simd`) with different `.mjs` module URLs.
- Variant selection is ordered by preference: `preferSimd=true` tries SIMD first, then baseline; `preferSimd=false` does the reverse.
- Each variant is tried in order; on failure, the next variant is attempted.
- Successful loads are cached by preference key (`prefer-simd` or `prefer-baseline`).
- On failure of all variants, returns `{ ok: false, selection: 'js-fallback', reason: ... }`.
- Uses `locateFile()` override to resolve `.wasm` asset URLs relative to the `.mjs` module URL.

#### Editor WASM (`wasm/editorRuntime.js`)
**[VERIFIED]** Provides 5 accelerated kernels via Emscripten-compiled C:
1. `_editor_compute_histogram_rgba` — RGBA histogram generation.
2. `_editor_compute_vectorscope_rgba` — Vectorscope visualization.
3. `_editor_compute_parade_rgba` — RGB parade visualization.
4. `_editor_compute_diff_preview` — Before/after pixel diff rendering.
5. `_editor_extract_palette` — K-means color palette extraction.

All operate on raw pixel arrays passed via `malloc`/`free` on the Emscripten heap. The runtime self-tests at load time with a 2×2 pixel sample.

#### Library WASM (`wasm/libraryRuntime.js`)
**[VERIFIED]** Provides 4 accelerated kernels for binary codec operations:
1. `_library_base64_encode_bound` — Output size estimate.
2. `_library_base64_encode` — Raw bytes → base64 text.
3. `_library_base64_decode_bound` — Output size estimate.
4. `_library_base64_decode` — base64 text → raw bytes.

Used by secure Library export/import to avoid JavaScript string overhead for large payloads. Falls back to native `btoa`/`atob` or streaming if WASM is unavailable.

---

## 7. Open Questions & Verification Gaps
- The full layer executor implementations in `src/engine/executors/index.js` (90KB) — how each layer type maps to GPU programs, uniform binding, multi-pass rendering.
- The `render()` method in `NoiseStudioEngine` — the main render loop body, including layer stack iteration, ping-pong FBO swapping, scope analysis computation.
- The `src/engine/layerPreviewProviders.js` (8KB) — how per-layer thumbnail previews are generated from the GPU pipeline.
- The `src/engine/cropTransformShared.js` (2KB) — shared math for crop+rotation geometry used by both Editor and layers.
- The exact scope analysis pipeline: how histogram/vectorscope/parade are computed from the rendered output (GPU readback → WASM or JS fallback).
