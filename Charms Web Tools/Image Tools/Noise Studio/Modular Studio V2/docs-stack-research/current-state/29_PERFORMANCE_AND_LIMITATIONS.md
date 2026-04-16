# Performance and Limitations

## 1. Purpose
This document catalogs the known performance constraints, throttling mechanisms, resolution caps, memory management strategies, and architectural limitations of the current web-based application. This information is critical for the native rebuild to determine which limitations are inherent to browser sandboxing versus design decisions that could be relaxed in a native environment.

## 2. Scope
Covers performance-related constants and strategies found across the codebase, the bootstrap metrics system, GPU texture limits, worker concurrency, IDB connection patterns, and rendering budget management.

## 3. Verification State
- **Verified from Source:**
  - `src/perf/bootstrapMetrics.js` (complete 67 lines)
  - `src/engine/pipeline.js` lines 1–800 (resolution capping, FBO pool allocation, render scheduling, preview resolution limits)
  - `src/workers/runtime.js` (complete 720 lines: concurrency limits, boot timeouts, retry limits)
  - `src/graphics/capabilities.js` (complete 64 lines: GPU limit detection)
  - `src/3d/engine.js` lines 1–800 (viewport pixel ratio caps, path trace cadence)
  - `src/stitch/engine.js` (complete: analysis dimension cap, multi-band pyramid level limits)
  - `src/settings/defaults.js` (complete: all configurable limits)
  - `src/app/bootstrap.js` lines 104–160 (IDB connection pattern)
- **Inferred Behavior:** The full Editor render loop body was not read; GPU memory pressure handling and texture eviction patterns are inferred.

## 4. Cross-System Dependencies
- **GPU Caps → All Renderers:** `MAX_TEXTURE_SIZE` from `detectGraphicsCapabilities()` limits the maximum working resolution for all GPU-based sections.
- **Worker Caps → All Sections:** `detectWorkerCapabilities()` determines whether WASM, module workers, SIMD, and OffscreenCanvas are available.
- **Settings → Limits:** Many limits are configurable via the Settings panel (worker count, preview resolution, analysis dimensions, etc.).

## 5. State Behavior
- **Saved (Durable):** User-configurable limits in settings (maxBackgroundWorkers, viewportHighResCap, analysisMaxDimension, etc.).
- **Runtime-only:** Bootstrap metrics, long task observations, worker task timing, FPS tracking, GPU parameters.
- **Derived/Cached:** None — limits are applied directly at decision points.

---

## 6. Current Behavior

### 6.1 Bootstrap Performance Metrics (`perf/bootstrapMetrics.js`)
**[VERIFIED]** `createBootstrapMetrics(options)` provides a lightweight instrumentation system:
- **Marks:** Named timestamped entries via `mark(name, detail)`.
- **Long Tasks:** Automatically detected via `PerformanceObserver` with `longtask` entry type (when supported). Each long task records name, duration, and start time.
- **Worker Task Metrics:** Tracks domain, task name, queue wait time, execution duration, mode (worker/fallback), and failure status.
- **Snapshot:** `snapshot()` returns a point-in-time copy of all marks, long tasks, and worker task data.

### 6.2 GPU and Texture Limits

**[VERIFIED]** Critical GPU constraints:

| Constant/Detection | Value | Impact |
|---|---|---|
| `MAX_TEXTURE_SIZE` | Hardware-dependent (typically 4096–16384) | Maximum single-axis dimension for any WebGL texture or FBO |
| `MAX_RENDERBUFFER_SIZE` | Hardware-dependent | Maximum renderbuffer dimension |
| `gpuSafeMaxEdge` | min(all GPU limits) | Conservative maximum for any GPU operation |
| `COMPOSITE_AUTO_WORKER_THRESHOLD_MEGAPIXELS` | 16 | Composites larger than 16MP auto-route to worker export |
| `COMPOSITE_AUTO_WORKER_THRESHOLD_EDGE` | 4096 | Composites with edge > 4096px auto-route to worker export |

**[VERIFIED]** Editor resolution capping (`pipeline.js`):
- In preview mode: textures capped at `min(MAX_TEXTURE_SIZE, 4096)` unless `highQualityPreview` is enabled.
- In full-res export mode: textures capped at `MAX_TEXTURE_SIZE`.
- Scale/expander/crop layers dynamically adjust resolution; all intermediate sizes are clamped.

**[VERIFIED]** 3D viewport resolution caps (`3d/engine.js`):
- `EDIT_VIEW_MAX_PIXEL_RATIO = 1.25` for raster/mesh mode.
- `PATH_TRACE_VIEW_MAX_PIXEL_RATIO = 1.0` for path tracing mode.
- `viewportHighResCap` setting can disable these caps.

### 6.3 Worker Concurrency Limits

**[VERIFIED]** Worker system constraints:

| Parameter | Default | Range | Source |
|---|---|---|---|
| `maxConcurrentTasks` | Infinity | 1–∞ | `createBackgroundTaskBroker(options)` |
| `maxBackgroundWorkers` | (from settings) | configurable | `settings.general.maxBackgroundWorkers` |
| `DEFAULT_BOOT_TIMEOUT_MS` | 12,000ms | min 1,000ms | Worker boot timeout |
| `MAX_RETIRED_DISPATCH_IDS` | 160 | fixed | Ring buffer preventing stale message processing |
| `maxCrashReplays` | 1 | 0+ | Per-job crash retry limit |

**[VERIFIED]** Only one task can be active per domain at any time (each domain has a single `active` slot). The global `maxConcurrentTasks` limits total concurrent active tasks across all 6+ domains.

### 6.4 Stitch Analysis Limits

**[VERIFIED]** Stitch algorithm constraints:

| Parameter | Default | Min | Max |
|---|---|---|---|
| `analysisMaxDimension` | 2048 | 128 | 2048 |
| `maxFeatures` | 4000 | 20 | 4000 |
| `matchRatio` | 0.75 | 0.4 | 0.99 |
| `ransacIterations` | 5000 | 40 | 5000 |
| `inlierThreshold` | 4.5 | 0.5 | 48 |
| `maxCandidates` | 8 | 1 | 12 |
| Laplacian pyramid levels | up to 5 | min dimension 24px | - |
| OpenCV boot timeout | 20,000ms | - | - |
| Gain compensation range | 0.72–1.4 | - | - |

### 6.5 Memory Management

**[VERIFIED]** FBO Pool Allocation (Editor):
- FBO pools are keyed by resolution string (`WxH`).
- Each pool contains 9 FBOs (pingPong0/1, tempNoise, blur1/2, preview, chainCapture, dngBase, maskTotal).
- Pools are allocated on demand but never explicitly deallocated during a session.
- Static buffers: thumbnail FBO (320×320, 8-bit), analysis FBO (256×256, 8-bit), pre-allocated pixel readback arrays.

**[VERIFIED]** Canvas readback buffers (`readbackPixels`, `readbackClamped`) are pre-allocated and resized on demand — avoids repeated allocation during export.

**[VERIFIED]** Worker file transfer: File payloads are converted to `ArrayBuffer` and transferred (zero-copy) to workers, but the original Blob remains un-GC'd until the transfer completes.

**[VERIFIED]** DNG decoded source cache: `dngDecodedSourceCache` (a `Map`) caches decoded DNG Float32Array rasters in main-thread memory. Old entries are cleared via `clearDngSourceResources()`.

### 6.6 Rendering Budget

**[VERIFIED]** 3D path tracing cadence:
- Per-sample budget: 22ms (target).
- Cooldown between samples: 16–96ms (adaptive).
- Viewport denoise trigger: every 4 samples or 120ms.
- This prevents the path tracer from monopolizing the main thread.

**[VERIFIED]** Editor render scheduling: `requestRender()` coalesces multiple render requests per `requestAnimationFrame` — only one `render()` call per frame.

### 6.7 IndexedDB Connection Overhead

**[VERIFIED]** Each IDB operation calls `initDB()` which opens a fresh `indexedDB.open()` connection. This is simple but incurs per-operation overhead:
- Each `open()` involves version checking by the browser's IDB implementation.
- Bulk operations (save all, clear all) make many sequential connections.
- The cursor-based scan (`getLibraryProjectRecordsByCursor`) benefits from a single connection for the full iteration.

### 6.8 Log Engine Throttling

**[VERIFIED]** Log system constraints:
- `recentLimit` (default 18): Maximum entries per process in the recent view.
- `historyLimit` (default 0 = unbounded): Maximum entries in full history.
- `maxUiCards` (default 18): Maximum process cards rendered.
- Deduplication window prevents identical consecutive messages from creating new entries.
- Publish batching via `requestAnimationFrame` — at most one snapshot push per frame.

### 6.9 Known Browser-Imposed Limitations

**[VERIFIED]** Limitations inherent to the web platform:

| Limitation | Impact | Native Rebuild Opportunity |
|---|---|---|
| WebGL2 `MAX_TEXTURE_SIZE` | Caps all GPU rendering to hardware limit (often 4096–16384) | Native GPU has no such artificial cap |
| Single WebGL context per canvas | Editor can't share GPU context with 3D engine | Native can use multiple render targets in one context |
| Web Worker communication via structured clone | Large payloads (DNG rasters) require explicit transfer | Native threads share memory directly |
| IDB performance | Blocking on large reads, no SQL queries, no indexes on payload content | Native SQLite/LMDB is orders of magnitude faster |
| WASM memory limit | ~2–4GB per WASM module depending on browser | Native has full OS memory access |
| No GPU compute (compute shaders) | All image processing uses fragment shaders or CPU | Native can use Vulkan/CUDA compute |
| localStorage limit | ~5–10MB per origin | Native has no such constraint |
| Canvas 2D performance | Single-threaded, no hardware-accelerated blending modes | Native can use GPU compositing |
| File system access | Limited to downloads folder (browser) or native dialog (Electron) | Full filesystem access |

---

## 7. Open Questions & Verification Gaps
- The exact GPU memory budget — whether any FBO eviction or LRU strategy exists when many resolution pools accumulate.
- Whether `requestAnimationFrame` is used for the main Editor render loop or only for coalescing — the main render could also be driven by document change events.
- Whether the `highQualityPreview` toggle changes anything beyond the texture size cap (e.g., filtering quality, mipmap generation).
- Full memory profile of a typical session — how much GPU and heap memory a complex Editor document with DNG + 20+ layers consumes.
- Whether `performance.measureUserAgentSpecificMemory()` or `performance.memory` is ever used for diagnostics.
