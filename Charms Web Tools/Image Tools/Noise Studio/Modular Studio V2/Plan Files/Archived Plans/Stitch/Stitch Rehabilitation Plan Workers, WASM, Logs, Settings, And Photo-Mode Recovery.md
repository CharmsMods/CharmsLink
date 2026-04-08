# Stitch Rehabilitation Plan: Workers, WASM, Logs, Settings, And Photo-Mode Recovery

## Summary
Bring the Stitch tab up to production shape by fixing the architecture first, then photo-mode correctness, then performance and integration polish. The current codebase already has the right pieces, but they are split badly: screenshot analysis uses the shared broker, photo analysis still uses a separate legacy OpenCV worker, progress is written into `analysis.warning`, Settings has no real Stitch ownership, and preview/input preparation is still heavier than it needs to be.

Chosen policy from this planning pass:
- Stitch remains **workspace-first**.
- The Stitch tab keeps its live controls.
- Settings only owns **defaults, diagnostics, and app-wide behavior**, not the active Stitch document.

Research basis for the worker/WASM decisions:
- [MDN Web Workers](https://developer.mozilla.org/en-US/docs/Web/API/Worker)
- [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [MDN createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/createImageBitmap)
- [Emscripten modularized output](https://emscripten.org/docs/compiling/Modularized-Output.html)
- [Emscripten SIMD](https://emscripten.org/docs/porting/simd.html)
- [OpenCV.js usage](https://docs.opencv.org/4.x/d0/d84/tutorial_js_usage.html)
- [OpenCV feature + homography flow](https://docs.opencv.org/4.x/d7/dff/tutorial_feature_homography.html)
- [OpenCV Lucas-Kanade optical flow](https://docs.opencv.org/4.x/db/d7f/tutorial_js_lucas_kanade.html)

## Key Changes
### Phase 0: Reproduction, Instrumentation, And State Cleanup
- Add a Stitch regression matrix before changing behavior:
  - screenshot-only set
  - easy photo pair
  - hard photo pair with perspective/parallax
  - weak-overlap failure set
  - mixed auto-mode set
- Stop reusing `analysis.warning` for progress.
  - add runtime-only `analysis.progressMessage`
  - add runtime-only `analysis.runId`
  - keep `warning` for actual soft warnings only
- Harden invalidation in `main.js`:
  - any input add/remove, analysis-affecting setting change, or rerun increments the run token
  - stale results never repaint the document
  - candidate/gallery actions disable immediately when results are invalidated
- Add stage timings and backend metadata to Stitch diagnostics so failures can be pinned to boot, prepare, classify, solve, preview, or export.

### Phase 1: Worker And WASM Architecture Unification
- Keep two Stitch worker domains, but move both onto the shared broker:
  - `stitch`
  - `stitch-opencv`
- `stitch` owns:
  - `prepare-input-files`
  - `prepare-analysis-inputs`
  - `classify-scene-mode`
  - `analyze-screenshot`
  - `build-candidate-previews`
- `stitch-opencv` owns:
  - `self-test-photo-runtime`
  - `analyze-photo`
- Replace the current direct `ensureOpenCvWorker()` path in `engine.js` with broker-driven dispatch.
- Convert the photo/OpenCV runtime to a versioned, broker-compatible module-worker path.
  - no more separate ad hoc request map in the engine for photo mode
  - same cancellation, restart, retry, and metric behavior as the rest of the app
- Add an explicit OpenCV/WASM self-test at worker init:
  - runtime boot
  - feature detector availability
  - homography path availability
  - optical-flow path availability
- Fallback policy:
  - screenshot path keeps same-thread JS fallback
  - photo path does **not** silently fall back to fake/manual JS analysis
  - if photo runtime is unavailable, the user gets a clear actionable error and logs explain why

### Phase 2: Photo-Mode Recovery
- Treat photo mode as the primary functional repair target.
- Keep the current OpenCV homography + optional mesh-refinement design, but repair orchestration before touching math thresholds.
- Move prepared-input normalization fully out of the engine hot path and into worker tasks:
  - decode
  - resize
  - grayscale conversion
  - classifier prep
- Make photo analysis stage-driven and explicit:
  - runtime boot
  - input prep
  - detector selection
  - match filtering
  - homography validation
  - optional flow refinement
  - candidate ranking
  - preview generation
- Fix failure semantics:
  - weak photo support returns a real low-confidence/manual result with a clear warning
  - runtime failure returns an error
  - no hung active state
  - no fabricated mesh candidate when homography support is weak
- Auto mode keeps the current screenshot-vs-photo classification idea, but classification must run through the broker and log the chosen backend and reason.
- Feature-detector policy:
  - keep `auto`, `orb`, `akaze`, `sift`
  - hide or disable `sift` if the loaded OpenCV build does not actually support it
  - log the actual detector used for the run

### Phase 3: Full Logs Integration
- Split Stitch logging into real process channels:
  - `stitch.import`
  - `stitch.analysis`
  - `stitch.preview`
  - `stitch.export`
  - `stitch.settings`
  - `stitch.worker`
- Every long-running Stitch action must emit start, progress, completion, and failure logs.
- Progress messages from workers go to the log engine and overlays directly; they do not mutate warning state.
- Preview generation, candidate finalization, backend selection, and photo-runtime fallback/error paths must all be visible in the Logs tab.
- Successful and failed Stitch runs should participate cleanly in the existing log completion effects without duplicate or misleading entries.

### Phase 4: Settings Tab Integration
- Add a real `settings.stitch` schema with two groups:
  - `defaults`
  - `diagnostics`
- `defaults` mirrors the current Stitch analysis controls for **new Stitch documents only**:
  - scene mode
  - blend mode
  - warp mode
  - mesh density
  - warp distribution
  - analysis size
  - full-resolution analysis
  - feature detector
  - max features
  - match ratio
  - RANSAC iterations
  - inlier threshold
  - max candidates
- `diagnostics` is read-only:
  - worker availability
  - WASM/OpenCV runtime availability
  - supported detectors
  - last runtime selection and fallback reason
- Precedence rule:
  - live Stitch tab controls remain primary for the active project
  - Settings defaults apply on new project creation and explicit reset-to-default flows
  - loaded/imported Stitch projects keep their own persisted settings unless the user explicitly applies app defaults
- Every settings change, import, reset, and default-application action logs through `stitch.settings`.

### Phase 5: Performance Sweep
- Move Stitch input preparation off the interaction path using worker-owned `createImageBitmap` + `OffscreenCanvas` when supported.
- Replace current engine-side sequential preview generation with brokered preview jobs:
  - cancellable
  - replaceable on rerun
  - low-priority after analysis completes
  - proper object-URL cleanup on invalidation
- Keep the final canvas render/export path in JS for this pass, but add cooperative yields and stage logging so export no longer looks frozen.
- WASM policy for Stitch:
  - OpenCV.js remains the only required WASM backend in this pass
  - do **not** add custom Stitch-only WASM kernels unless profiling later proves the screenshot path or preview generation still dominates after workerization
- Acceptance target:
  - screenshot mode remains responsive
  - photo mode is correct and recoverable
  - no main-thread-looking freeze during import, analysis, preview build, or export

## Public Interfaces / State Changes
- `stitchDocument.analysis` gains runtime-only:
  - `progressMessage`
  - `runId`
- New settings slice:
  - `settings.stitch.defaults`
  - `settings.stitch.diagnostics`
- Broker task surface:
  - `stitch.prepare-input-files`
  - `stitch.prepare-analysis-inputs`
  - `stitch.classify-scene-mode`
  - `stitch.analyze-screenshot`
  - `stitch.build-candidate-previews`
  - `stitch-opencv.self-test-photo-runtime`
  - `stitch-opencv.analyze-photo`
- Photo/OpenCV worker becomes a broker-managed, versioned worker asset instead of a standalone engine-owned worker.
- `ai_context.txt` must be updated after each landed phase with:
  - Stitch worker ownership
  - WASM/runtime requirements
  - settings precedence
  - new log process IDs
  - photo-mode failure rules

## Test Plan
- Screenshot regression:
  - screenshot mode still routes to the screenshot backend
  - auto mode still classifies screenshot sets correctly
  - no photo runtime required for screenshot-only work
- Photo recovery:
  - easy photo set produces ranked candidates successfully
  - hard photo set produces at least one valid candidate or a clear low-confidence/manual warning
  - weak-overlap set fails cleanly without hanging
  - detector availability is honored and logged
- Worker reliability:
  - cancelling an active run by rerunning or changing settings invalidates stale results
  - worker boot failure surfaces a clear error and allows a later rerun
  - worker crash resets broker state and the next run recreates the worker
- Logs:
  - import, analysis, preview, export, and settings actions all appear in Logs with progress and terminal states
  - successful and failed Stitch events trigger the existing log-tab effects correctly
- Settings:
  - new Stitch project picks up Settings defaults
  - loaded Stitch project preserves its own stored settings
  - explicit apply-defaults action updates the active Stitch project and logs it
- Performance:
  - importing multiple images no longer blocks the UI during decode/prep
  - preview generation is cancellable and does not stall the tab
  - export shows real progress and does not look frozen

## Assumptions And Defaults
- Stitch stays workspace-first; Settings does not replace the live Stitch controls.
- Screenshot analysis remains the current JS-based backend unless profiling later proves it needs a separate WASM pass.
- OpenCV.js remains the Stitch photo-mode WASM dependency for this implementation.
- There is no silent photo-mode fallback to a fake JS solver; unsupported photo runs must fail explicitly.
- The plan prioritizes correctness and recoverability before tuning photo-analysis thresholds or adding new solver features.
