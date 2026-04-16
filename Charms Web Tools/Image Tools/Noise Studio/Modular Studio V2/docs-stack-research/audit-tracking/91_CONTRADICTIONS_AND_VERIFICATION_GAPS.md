# Contradictions and Verification Gaps

## 1. Purpose
This document tracks inconsistencies discovered when auditing the code against legacy documentation or assumptions, as well as listing out systems that require deeper investigative passes.

## 2. Document Conventions
When logging an entry, record:
- **Topic:** The system or subsystem in question.
- **Context File Claim:** What old documentation says happens.
- **Audited Truth:** What the code *actually* does.
- **Verification Priority:** Low/Medium/High for future passes.

---

## Active Discrepancies

*None recorded during Phase 2 layout generation.*

### Phase 3 Verified Findings
- **3D Path Tracing Denoise (resolved):** Confirmed denoise runs via WebGL. `DenoiseMaterial` from `three-gpu-pathtracer` is rendered through a `FullScreenQuad` pass on the GPU renderer. Not CPU-based.
- **OpenCV WASM Fallbacks (partially resolved):** Confirmed the OpenCV worker has a 20-second boot timeout (`OPENCV_BOOT_TIMEOUT_MS`). If boot fails, `ensureOpenCvWorker()` rejects with an error. The `analyze()` method in `StitchEngine` will throw if photo analysis is requested and the worker fails — it does NOT silently fall back to screenshot-js. The engine *does* fall back to JS analysis when `sceneMode` is explicitly set to `'screenshot'` or when the auto-classifier selects it.

### Phase 4 Verified Findings
- **Library IndexedDB Schema (resolved):** Confirmed: database name `ModularStudioDB`, version 3, object store `LibraryProjects` (keyPath: `id`), attachment store `LibraryProjectAttachments` (keyPath: `id`, indexes: `projectId`, `kind`). Self-healing upgrade handler exists that re-opens at version+1 if stores are missing.
- **DNG Worker Buffer Marshalling (resolved):** Confirmed `dng.worker.js` uses `getSourceBuffer()` to accept either raw `ArrayBuffer` in payload, or revive a file entry to get the buffer. Returns decoded data as `Float32Array` with transferables listing all relevant buffers (raw raster, linearization table, gain maps). Zero-copy transfer via `postMessage` transferable arrays.
- **Composite Worker Export (resolved):** Confirmed `composite.worker.js` exists as a full worker domain with tasks: `prepare-image-files`, `render-preview`, `render-export-png`. All rendering uses `OffscreenCanvas` with Canvas 2D context. Full layer composition logic (position, rotation, scale, opacity, blend modes) is replicated in the worker.
- **`maxBackgroundWorkers` ↔ Task Broker (resolved):** Confirmed `broker.configure({ maxConcurrentTasks })` exists and is the API for adjusting concurrency at runtime. The settings value `settings.general.maxBackgroundWorkers` is wired to this via the bootstrap.
- **Reactive Store Architecture (verified):** Confirmed the store is a minimal closure-based observable — `createStore(initialState)` → `{ getState, setState, subscribe }`. No middleware, no devtools, no immer. Subscribers called synchronously.
- **WASM Runtime Manager (verified):** Confirmed `createOptionalEmscriptenRuntimeManager()` provides cached, variant-ordered loading with SIMD preference. Two runtimes: Editor (histogram/vectorscope/parade/diff/palette) and Library (base64 encode/decode). Self-test validation on load.
- **Electron Integration (verified):** Confirmed as a thin wrapper. Only two IPC channels (`desktop-save-file`, `desktop-show-open-dialog`). Context isolation enabled, node integration disabled. No custom protocol, menu, or auto-updater.

## Verification Backlog

### High Priority
- **WebGL Editor Pipeline evaluation order:** Deep read of `src/engine/executors/index.js` (90KB) needed to map how layer programs execute, uniform binding, ping-pong FBO swapping.
- **Full Render Loop Body:** `src/engine/pipeline.js` lines 800+ — the actual `render()` method iterating the layer stack.
- **Stitch Analysis Algorithm (JS):** `src/stitch/analysis.js` (70KB) — full feature detection, matching, and homography estimation logic not yet read.

### Medium Priority
- **3D Full Scene Sync Pipeline:** `src/3d/engine.js` lines 800–2491 — how document mutations map to Three.js object add/update/remove, material application, asset loading lifecycle.
- **3D Background Render Jobs:** How the `renderJob` state model is executed (separate canvas? worker? queued in animate loop?).
- **Library Preview Backfill:** Exact mechanism (idle callback vs. explicit queue) and scheduling for generating missing thumbnails on load.
- **Stitch OpenCV Worker:** `src/stitch/opencv-worker.js` (128KB) — full OpenCV integration, supported detectors, homography pipeline.
- **`autoClearSuccessMs` consumption:** The log engine doesn't implement auto-clear internally — is this consumed by the Logs UI or somewhere else?
- **Layer Preview Providers:** `src/engine/layerPreviewProviders.js` (8KB) — how per-layer thumbnail previews are generated from the GPU pipeline readback.
- **FBO/Texture Eviction:** Whether any GPU memory management (LRU, eviction) exists when many resolution pools accumulate.
- **stitch-opencv domain registration:** Whether the OpenCV worker uses the standard task broker or has its own independent management in the Stitch engine.

### Low Priority
- **Composite Auto Bounds logic:** Review `src/composite/document.js` to mathematically confirm the bounding box generation handles extreme rotated text offsets properly.
- **3D Boolean Cuts Legacy:** `countLegacyThreeDBooleanCuts()` exists in `document.js` — is any UI still referencing this deprecated feature?
- **3D MLT Subdirectory:** `src/3d/mlt/` — purpose and contents unknown.
- **Stitch `meta.js`:** `src/stitch/meta.js` (9KB) — purpose unknown, likely metadata extraction.
- **Library Asset Store vs. 3D Embedded Assets:** Relationship between standalone Library assets and fonts/HDRIs embedded in 3D documents needs clarification.
- **`kind` index usage on LibraryProjectAttachments:** Index exists but no query-by-kind was observed in the verified code; possibly reserved for future use.
- **`navigator.storage.persist()` usage:** Whether durable storage is ever requested to prevent browser eviction of IDB data.

