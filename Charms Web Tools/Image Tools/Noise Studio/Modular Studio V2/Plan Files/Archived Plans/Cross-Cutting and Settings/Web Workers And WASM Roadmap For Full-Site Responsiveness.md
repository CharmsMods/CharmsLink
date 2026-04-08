# Web Workers And WASM Roadmap For Full-Site Responsiveness

## Summary
Adopt an aggressive end-state roadmap that moves all non-UI background work into Web Workers, then prototypes worker-owned renderers for Editor and 3D once the safe wins are in place. The target architecture is a hybrid domain-worker model with one shared worker protocol, shared logging/progress integration, and broad browser/Electron fallback behavior.

The current codebase already gives us the right starting point: Stitch has a working worker/WASM pattern, the store is synchronous, Editor boot still blocks on registry + shader/bootstrap work, and a lot of quiet site-load and Library work lives in `src/main.js`. The plan below makes startup feel responsive first, then expands toward fully worker-managed compute and eventually worker-managed rendering.

## Interfaces And Architecture Changes
- Introduce a shared worker runtime layer with a single message contract for every domain worker:
  - `ready`
  - `progress`
  - `log`
  - `result`
  - `error`
  - `cancelled`
- Standardize task requests as:
  - `runTask(domain, task, payload, { transfer, signal, priority, processId, overlayTarget })`
- Standardize worker events as:
  - `{ id, type, domain, task, progress?, message?, logLevel?, processId?, payload?, error? }`
- Add a capability registry that is computed once at startup and passed to workers:
  - `moduleWorker`
  - `worker`
  - `wasm`
  - `offscreenCanvas2d`
  - `offscreenCanvasWebgl2`
  - `compressionStreams`
  - `fileSystemAccess`
  - `createImageBitmap`
- Keep the existing log engine as the single source of truth. Workers never write directly to UI; they emit `log` and `progress` events and the main thread forwards them into the current logging engine.
- Add a background task broker with explicit priorities:
  - `critical-boot`
  - `user-visible`
  - `background`
  - `idle`
- Use dedicated domain workers under that broker:
  - `app-library-worker`
  - `editor-worker`
  - `stitch-worker`
  - `stitch-opencv-worker`
  - `three-worker`
- Update `ai_context.txt` at the end of every landed phase with:
  - new worker ownership boundaries
  - capability gates and fallbacks
  - which tasks remain main-thread only
  - any new boot sequencing and logging requirements

## Implementation Plan
### Phase 0: Baseline Measurement And Boot Split
- Add performance instrumentation before moving work:
  - `PerformanceObserver` for long tasks
  - startup timestamps for `DOMContentLoaded`, shell painted, registry ready, UI ready, Editor engine ready, first interactive, first idle work
  - per-worker task duration and queue wait metrics
- Split startup into explicit stages:
  - `boot shell`
  - `registry bootstrap`
  - `workspace init`
  - `editor engine init`
  - `background warmup`
- Change boot order so a minimal shell and loading state render before registry validation and engine bootstrap complete.
- Move registry fetch + parse + validate + normalization into `app-library-worker`.
- Keep the current full workspace creation gated on registry availability, but render a lightweight shell immediately so the app no longer looks frozen during bootstrap.
- Record baseline numbers for current boot on browser and Electron before any further workerization.

### Phase 1: Shared Worker Runtime And Scheduling
- Build the shared bridge first, then migrate existing Stitch workers onto it instead of keeping multiple incompatible worker patterns.
- Give every task:
  - cancellation support
  - log/process id
  - progress updates
  - transfer-list support for typed arrays, `ArrayBuffer`, and `ImageBitmap`
- Make every background task opt into a priority queue so idle work never competes with user-triggered work.
- Default behavior:
  - user actions can preempt idle tasks
  - repeated tasks replace older queued tasks for the same resource
  - section switches cancel no-longer-relevant background work
- Keep the current same-thread fallback path for every workerized feature so GitHub Pages, local hosting, and Electron remain supported even when a capability is missing.

### Phase 2: Quiet Site-Load And Library Background Processing
- Move these current quiet/background jobs into `app-library-worker` first:
  - Library project scan and tag-catalog merge
  - project fingerprint matching
  - asset fingerprint generation
  - image thumbnail generation
  - image dimension reads
  - secure gzip/compression and AES/PBKDF2 flows
  - ZIP/folder manifest assembly and import normalization
- Convert the current backfill chain into queued worker jobs:
  - Editor project preview backfill planning
  - derived Editor asset backfill planning
  - image-asset preview backfill
- Keep main-thread preview capture only for the subset of records that truly require the live Editor or 3D engine.
- Add persisted backfill checkpoints so page reloads do not restart full warmup scans from zero.
- Delay all noncritical warm tasks until:
  - the shell is painted
  - the active section is stable
  - a short quiet window has passed
- Acceptance rule for this phase:
  - no background Library warmup may create visible startup jank after first paint.

### Phase 3: Editor Workerization
- Move these Editor tasks into `editor-worker`:
  - palette extraction
  - histogram/vectorscope/parade computation
  - state JSON parse/normalize/validation
  - folder scan manifest building
  - batch export bookkeeping
  - lightweight image metadata extraction
- Keep these main-thread for now:
  - `engine.init`
  - `engine.loadImage`
  - live WebGL render
  - `exportPngBlob`
  - preview capture used for Library save/import
- For scopes, send transferred pixel buffers from the main thread and return precomputed draw data instead of rerunning CPU loops in the UI thread.
- For palette extraction, move the canvas sampling and clustering entirely into the worker using `ImageBitmap` plus `OffscreenCanvas` 2D where supported.
- Aggressive renderer track:
  - prototype an `editor-render-worker` that owns the Editor WebGL pipeline on an `OffscreenCanvas`
  - keep the current main-thread Editor engine as the fallback path
  - only flip to worker-owned Editor rendering after parity on export, picking, scopes, and compare tools is proven

### Phase 4: Stitch Consolidation
- Refit the existing screenshot worker and OpenCV WASM worker to the shared worker protocol.
- Move Stitch input preparation into workers:
  - file decode
  - image dimension reads
  - preview map generation
  - candidate preview bitmap generation
- Use `createImageBitmap` and `OffscreenCanvas` when supported to avoid repeated main-thread `Image` decode work.
- Keep OpenCV WASM as the photo-analysis backend and document it as the first-class example of the site’s worker/WASM pattern.
- WASM note:
  - no new Stitch WASM work is needed initially beyond OpenCV, unless profiling later shows screenshot-mode JS analysis is still hot.

### Phase 5: 3D Asset And Scene Workerization
- Move non-renderer 3D work into `three-worker` first:
  - model file read/arrayBuffer prep
  - glTF JSON inspection and metadata extraction
  - font parsing/validation
  - HDR metadata extraction
  - asset fingerprinting
  - scene signature generation
  - Library import/export normalization for 3D payloads
- Keep live Three.js scene hydration and viewport rendering on the main thread in the first 3D phase.
- Split 3D import into two steps:
  - worker-side decode/prep
  - main-thread scene instantiation
- Aggressive renderer track for 3D:
  - prototype worker-owned 3D viewport rendering with `OffscreenCanvas`
  - move path-trace export orchestration into that worker only after viewport parity is stable
  - keep current main-thread 3D renderer as fallback until object selection, transform tools, drag-drop, and render export all match behavior
- WASM note:
  - boolean geometry prep, mesh simplification, and other geometry-heavy transforms are explicit WASM candidates if worker JS still produces hotspots.

### Phase 6: Adapter And Save/Load Refactor
- Extend project adapters so worker-prepared imports can avoid unnecessary main-thread work:
  - `prepareImportedProject` may return `requiresMainThreadPreviewCapture`
  - `captureDocument` may separate `serialize`, `preview`, and `summary`
- Keep Studio and 3D preview capture main-thread-bound until their renderer migrations land.
- Move the non-render parts of save/load/import/export into workers:
  - JSON serialization
  - import validation
  - metadata extraction
  - asset dedupe decisions
  - secure export packaging
- Revisit IndexedDB ownership after the first worker phases:
  - default to main-thread DB writes initially
  - move DB reads/writes into `app-library-worker` only after the task protocol and failure handling are proven stable

### Phase 7: WASM Follow-Through
- Treat WASM as a selective accelerator, not a blanket rewrite.
- Priority WASM candidates:
  - Editor scopes kernels if worker JS still causes measurable cost
  - Editor palette clustering if sampling remains hot
  - 3D geometry preprocess and boolean helpers if profiling justifies it
- Non-candidates by default:
  - hashing, because `crypto.subtle` is already native
  - gzip, because `CompressionStream` is already native where supported
- Any WASM addition must remain locally vendored and load through relative paths that work on GitHub Pages, local hosting, and Electron.

## Test Plan And Acceptance Criteria
- Startup:
  - shell becomes visible before registry validation and Editor engine init finish
  - no idle backfill starts before first paint
  - background work after first paint produces no sustained long-task spikes
- Worker protocol:
  - cancellation, replacement, error propagation, retry, and logging work the same across all domain workers
- Editor:
  - image load, state load, save, export, folder scan, palette extraction, scopes, and batch flows remain behaviorally identical
- Library:
  - plain import/export, secure import/export, ZIP export, asset folder import/export, and preview backfills behave the same with worker failures and fallbacks covered
- Stitch:
  - screenshot analysis, OpenCV photo analysis, preview generation, export, and Library save/load remain correct with worker restarts and cancellation
- 3D:
  - model/image/font/HDRI import, save/load, Library asset sync, and path-trace export remain correct while worker-prepped asset flows are enabled
- Renderer migration prototypes:
  - Editor worker renderer and 3D worker renderer must each ship behind capability flags and be benchmarked against current behavior before default enablement
- Environment coverage:
  - browser-hosted app
  - Electron `loadFile` build
  - capability fallbacks for no worker, no WASM, no OffscreenCanvas WebGL2, and no `CompressionStream`

## Assumptions And Defaults
- Chosen direction:
  - aggressive end-state
  - hybrid domain workers with shared protocol
- Default compatibility policy:
  - broad fallback support remains mandatory for browser and Electron
- Current Stitch worker/WASM flow is the base pattern to reuse, not replace.
- The synchronous store remains in place for this roadmap; workers reduce compute on the main thread first, and store architecture changes are out of scope unless profiling later proves they are the blocker.
- `ai_context.txt` must be updated with every implementation phase, and any phase that adds worker responsibilities without updating that file is incomplete.
- Logging and progress overlays remain mandatory for all new worker tasks, including queued background work that the user does not directly trigger.
