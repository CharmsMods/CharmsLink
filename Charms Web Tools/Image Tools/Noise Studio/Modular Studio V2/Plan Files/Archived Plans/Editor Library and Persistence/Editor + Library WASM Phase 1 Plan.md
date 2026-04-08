# Editor + Library WASM Phase 1 Plan

## Summary
Implement WebAssembly for the site in two domains only for now: `Editor` first, then `Library`, with all WASM execution living behind the existing `editor` and `app-library` worker domains. The chosen stack is **C++ + Emscripten**, using **modularized ES module output**, **direct C exports**, **no Embind**, and **no pthreads/shared memory** in this phase.

This plan is grounded in the local review in [WASM-PERFORMANCE-REVIEW.md](/E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/WASM-PERFORMANCE-REVIEW.md), the current worker/runtime architecture in the repo, and official docs on [WebAssembly](https://developer.mozilla.org/en-US/docs/WebAssembly), [instantiateStreaming](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/instantiateStreaming_static), [SharedArrayBuffer security requirements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer), [Emscripten modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html), and [Emscripten SIMD](https://emscripten.org/docs/porting/simd.html).

Implementation rule for every landed phase:
- append `ai_context.txt` with the new WASM module boundaries, build commands, capability gates, fallbacks, and any logging/telemetry changes

## Key Changes

### 1. Native build and packaging model
- Add two native source packages:
  - `native/editor-wasm/`
  - `native/library-wasm/`
- Add one repo-owned build entrypoint:
  - `scripts/build-wasm.mjs`
- Add package scripts:
  - `build:wasm`
  - `build:wasm:editor`
  - `build:wasm:library`
- Commit both the native C++ source and the generated browser artifacts to the repo.
  - reason: this repo currently has no Emscripten toolchain installed, no bundler, and must remain runnable in browser + Electron without requiring every contributor to rebuild WASM first
- Emit artifacts into versioned static paths under `src/vendor/wasm/`:
  - `src/vendor/wasm/editor/editor-kernels.mjs`
  - `src/vendor/wasm/editor/editor-kernels.wasm`
  - `src/vendor/wasm/editor/editor-kernels-simd.mjs`
  - `src/vendor/wasm/editor/editor-kernels-simd.wasm`
  - `src/vendor/wasm/library/library-codec.mjs`
  - `src/vendor/wasm/library/library-codec.wasm`
  - `src/vendor/wasm/library/library-codec-simd.mjs`
  - `src/vendor/wasm/library/library-codec-simd.wasm`
- Compile with:
  - common flags: `-O3`, `-sWASM=1`, `-sMODULARIZE=1`, `-sEXPORT_ES6=1`, `-sALLOW_MEMORY_GROWTH=1`, `-sFILESYSTEM=0`, `-sENVIRONMENT=web,worker`
  - SIMD builds add `-msimd128`
  - do not enable `-pthread` or shared memory in this phase
- Use direct `extern "C"` exports plus `_malloc` / `_free`; do not use Embind for the hot paths because the goal is low-overhead typed-array interop.

### 2. Shared WASM runtime integration
- Extend worker capability detection with:
  - `wasmSimd`
- Keep the current `wasm` boolean.
- Add small JS wrappers under a new `src/wasm/` runtime layer that:
  - lazy-load the correct Emscripten factory inside the worker
  - choose SIMD build when `wasmSimd === true`
  - fall back to the baseline build otherwise
  - pass `locateFile` so `.wasm` sits next to its `.mjs` and resolves correctly in browser dev servers and Electron `loadFile`
- Keep the existing worker broker as the only call surface.
  - no direct main-thread WASM calls in phase 1
- Keep JS fallbacks alive for every new WASM-backed task.
  - if worker unsupported, WASM unavailable, module load fails, or runtime validation fails, use the current JS implementation and log the fallback
- Add telemetry/logging for:
  - module selected: `simd`, `baseline`, or `js-fallback`
  - module init time
  - task runtime
  - fallback reason

### 3. Editor WASM tranche
Start with the CPU work that already matches the review and current codebase shape.

#### 3a. Scope analysis
- Replace the current pure-JS scope math path with one new editor worker task:
  - `compute-analysis-visuals`
- Input:
  - flat RGBA analysis buffer
  - source width/height
  - target canvas dimensions for histogram, vectorscope, and parade
- Output:
  - transferred RGBA buffers for all three visuals
  - numeric metrics:
    - histogram average brightness
    - vectorscope average saturation
    - render resolution passthrough
- Kernel behavior:
  - WASM computes histogram bins, vectorscope placement math, and parade point rasterization
  - WASM writes final RGBA raster buffers for each canvas so JS only does `putImageData`
- Main-thread boundary:
  - `gl.readPixels`, visibility checks, DOM updates, and `putImageData` stay in JS
  - only the CPU pixel analysis and raster generation move to worker + WASM
- Scheduling rule:
  - use a single replaceable in-flight task per scope refresh cycle
  - if a newer render arrives, cancel/replace the older task
  - if scopes are hidden, do not dispatch the task at all

#### 3b. Changed-pixels preview
- Replace the pure-JS diff loop in `drawChangedPixelsPreview()` with:
  - `compute-diff-preview`
- Input:
  - base thumbnail RGBA buffer
  - processed thumbnail RGBA buffer
  - thumbnail width/height
- Output:
  - one transferred RGBA composite buffer
- Kernel behavior:
  - WASM handles luma math, Euclidean diff magnitude, tinting, and final grayscale/tint blend
- Main-thread behavior:
  - JS still owns texture readback, canvas sizing, and final `putImageData`

#### 3c. Palette extraction
- Move palette extraction into the `editor` worker as:
  - `extract-palette-from-image`
- Worker JS stage:
  - decode image with `createImageBitmap`
  - render to `OffscreenCanvas`
  - read RGBA pixels
- WASM stage:
  - sample filtering
  - palette center selection
  - iterative clustering
  - weight/sort prep
- Important decision:
  - make palette extraction **deterministic** in the WASM phase instead of today’s random-first-center behavior
  - use a stable seed/init rule so repeated runs on the same image return the same palette
- Output:
  - final ordered hex palette array
- Fallback:
  - keep current JS palette extraction for non-WASM environments until parity is proven

### 4. Library WASM tranche
Only move the byte-heavy transforms that actually benefit from native code. Keep browser-native cryptography and compression where they already exist.

#### 4a. Secure export/import worker tasks
- Add two `app-library` worker tasks:
  - `build-secure-library-export-record`
  - `resolve-secure-library-import-record`
- Move the secure export/import orchestration out of the UI layer and into the worker.
- Main-thread/UI responsibilities remain:
  - dialogs
  - notices
  - progress overlays
  - final save/import wiring

#### 4b. What stays native JS
- Keep `JSON.stringify` / `JSON.parse` in JS
- Keep `CompressionStream` / `DecompressionStream` in JS
- Keep `crypto.subtle` AES-GCM and PBKDF2 in JS
- Do not move encryption itself to WASM in this phase because the platform already provides native crypto

#### 4c. What moves to WASM
- Replace JS base64 hot paths with the `library-codec` module:
  - compressed export payload bytes -> base64
  - encrypted copy bytes -> base64
  - secure import base64 payload -> bytes
- Do not broaden this to generic data URL utilities yet.
  - keep `utils/dataUrl.js` and other non-Library base64 paths unchanged in this phase
- C ABI contract:
  - encode path exposes a size-query helper and an encode function writing ASCII output into caller-provided memory
  - decode path exposes a max-output-size helper and a decode function that returns bytes-written or an error code for invalid input
- Worker integration rule:
  - the worker owns the WASM memory buffers and reuses them across requests to avoid repeated allocations

### 5. Rollout order
1. WASM build system, artifact layout, worker loaders, `wasmSimd` capability detection, and telemetry
2. Editor `compute-analysis-visuals`
3. Editor `compute-diff-preview`
4. Editor `extract-palette-from-image`
5. Library `build-secure-library-export-record`
6. Library `resolve-secure-library-import-record`

After each step:
- update `ai_context.txt`
- confirm the JS fallback still works
- confirm Logs/overlays report whether the task used SIMD WASM, baseline WASM, or JS fallback

## Public Interfaces And Integration Changes
- New worker capability:
  - `wasmSimd`
- New `editor` worker tasks:
  - `compute-analysis-visuals`
  - `compute-diff-preview`
  - `extract-palette-from-image`
- New `app-library` worker tasks:
  - `build-secure-library-export-record`
  - `resolve-secure-library-import-record`
- New build scripts:
  - `build:wasm`
  - `build:wasm:editor`
  - `build:wasm:library`

## Test Plan
- Build/packaging:
  - baseline and SIMD artifacts generate correctly
  - browser dev server can load `.wasm`
  - Electron `loadFile` can load the generated `.mjs` + `.wasm` pair through the worker runtime
- Editor scopes:
  - same image, same render state, same canvas sizes produce visually matching histogram/vectorscope/parade outputs between JS and WASM
  - average brightness and saturation stay within a one-unit tolerance
  - hidden scopes do not dispatch worker tasks
  - rapid slider changes replace stale tasks cleanly and do not freeze the UI
- Editor changed-pixels preview:
  - diff overlay visually matches current JS behavior on fixed thumbnail fixtures
  - repeated hover/preview updates cancel stale work correctly
- Editor palette extraction:
  - repeated runs on the same image return the same palette
  - JS fallback and WASM output stay close enough to be visually equivalent on fixed fixtures
- Library secure export/import:
  - compressed export and encrypted export both succeed with WASM enabled
  - large exports no longer spend time in repeated `String.fromCharCode(...chunk)` loops
  - secure import with valid key still round-trips correctly
  - invalid base64 and wrong-key paths still produce clear errors
  - plain JSON export/import remains unchanged
- Fallbacks:
  - no worker
  - no WASM
  - no SIMD
  - no `CompressionStream`
  - no `crypto.subtle`
  all keep the current JS behavior and log the fallback reason

## Assumptions And Defaults
- Toolchain choice is locked to `C++ + Emscripten`.
- This phase covers `Editor` and `Library` only.
  - no 3D WASM work
  - no Stitch WASM work beyond the existing OpenCV path
- Worker-owned WASM is the default architecture.
  - WASM does not run on the main thread in this phase
- No WebAssembly threads / shared memory in this phase.
  - browser shared-memory threading requires secure context + cross-origin isolation, which should be deferred until a later dedicated pass
- SIMD is an optimization tier, not a requirement.
  - ship both SIMD and baseline WASM builds
  - keep JS fallback as the final safety net
- Palette extraction becomes deterministic as part of the WASM migration.
- Generated WASM artifacts are committed to the repo alongside source until a later build-system pass changes that policy.
