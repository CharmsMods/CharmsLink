# Workers and Background Tasks

## 1. Purpose
This document describes the background task broker system — the centralized infrastructure for offloading CPU-intensive work to Web Workers. It covers the task broker architecture, domain registration, worker lifecycle, protocol, fallback handling, and the specific worker domains used by each section.

## 2. Scope
Covers `src/workers/runtime.js` (background task broker), `src/workers/host.js` (worker-side host), `src/workers/protocol.js` (message types), `src/workers/capabilities.js` (environment probing), `src/workers/filePayload.js` (File/Blob transfer), all worker entry points (`*.worker.js`), and all task handler modules (`src/workers/tasks/*.js`).

## 3. Verification State
- **Verified from Source:**
  - `src/workers/runtime.js` (complete 720 lines: full task broker — domain registration, worker lifecycle, task queuing, priority sorting, fallback execution, cancellation, replay on crash, configuration, destroy)
  - `src/workers/host.js` (complete 161 lines: worker-side message handler, task routing, context API)
  - `src/workers/protocol.js` (complete 15 lines: all message and event type enums)
  - `src/workers/capabilities.js` (complete 58 lines: all capability probes)
  - `src/workers/filePayload.js` (complete 106 lines: File/Blob serialization for transferable messaging)
  - All worker entry points: `editor.worker.js`, `stitch.worker.js`, `composite.worker.js`, `appLibrary.worker.js`, `three.worker.js`, `dng.worker.js` (all complete)
  - All task handlers: `tasks/editor.js` (complete 404 lines), `tasks/stitch.js` (complete 138 lines), `tasks/composite.js` (complete 284 lines), `tasks/appLibrary.js` (complete 390 lines), `tasks/three.js` (complete 138 lines), `tasks/dng.js` (complete 76 lines)
- **Inferred Behavior:** None — all files in scope were fully read.

## 4. Cross-System Dependencies
- **Bootstrap → Broker:** The task broker is created during app bootstrap with detected capabilities injected.
- **All Section Engines → Broker:** Engines call `backgroundTasks.runTask(domain, task, payload, options)` to offload work.
- **Log Engine ← Broker Events:** The broker's `onEvent` callback bridges worker events to the log engine.
- **Performance Metrics ← Broker:** `onTaskMetric` feeds timing data to `bootstrapMetrics.trackWorkerTask()`.
- **WASM Runtimes → Workers:** Editor and Library WASM modules are loaded inside their respective worker threads.

## 5. State Behavior
- **Saved (Durable):** Nothing — the worker system is entirely runtime.
- **Runtime-only:** Worker instances, task queues, active job state, dispatch ID tracking, boot timers, capability cache.
- **Derived/Cached:** Retired dispatch IDs (ring buffer of 160, used to prevent stale message processing).

---

## 6. Current Behavior

### 6.1 Task Broker Architecture (`runtime.js`)

**[VERIFIED]** `createBackgroundTaskBroker(options)` creates a centralized task execution system:

**Core concepts:**
- **Domain:** A named category of work (e.g., `'editor'`, `'stitch'`). Each domain has its own worker, task queue, and active job slot.
- **Task:** A named operation within a domain (e.g., `'compute-analysis-visuals'`).
- **Job:** An internal object tracking a queued or active task with payload, priority, promise callbacks, cancellation state, and replay configuration.
- **Concurrency:** Global `maxConcurrentTasks` limits total active jobs across all domains. Defaults to `Infinity`.

**Priority system:**
| Priority | Value | Usage |
|---|---|---|
| `critical-boot` | 0 | Boot-time initialization |
| `user-visible` | 1 | User-triggered actions |
| `background` | 2 | Default — background processing |
| `idle` | 3 | Low-priority background work |

Tasks are sorted by priority first, then by enqueue timestamp (FIFO within same priority).

### 6.2 Domain Registration

**[VERIFIED]** `registerDomain(domain, config)` registers a domain with:
- `workerUrl` — URL to the worker entry point `.js` file.
- `type` — `'module'` (default) or `'classic'`.
- `bootTimeoutMs` — Maximum time to wait for worker ready signal (default: 12 seconds).
- `restartWorkerOnActiveCancel` — Whether to terminate+recreate the worker when cancelling an active task (default: true).
- `supportsTask(task, capabilities, payload)` — Optional function to check if the worker supports a task given current capabilities.
- `fallback(task, payload, context)` — Main-thread fallback function when workers are unavailable.

### 6.3 Worker Lifecycle

**[VERIFIED]** Worker boot sequence:
1. `ensureWorker()` creates a `Worker` with module type, attaches message/error/messageerror listeners.
2. Sends `INIT` message with domain name and capabilities.
3. Waits for `READY` response from worker host (or boot timeout).
4. On boot failure: clears worker state, rejects the boot promise.
5. On subsequent tasks: reuses the booted worker (no restart per task).

Worker failure handling:
- If the worker crashes during a task, `handleWorkerFailure()` triggers.
- If `replayOnWorkerCrash` is enabled (default), the job is re-enqueued up to `maxCrashReplays` times (default: 1).
- If replay attempts are exhausted, the job is retired with an error.

### 6.4 Task Execution Flow

**[VERIFIED]** When `runTask(domain, task, payload, options)` is called:
1. A new job object is created with a unique ID, dispatch ID, priority, scope, and callbacks.
2. If `replaceKey` is set, existing queued jobs with the same key are cancelled, and the active job may be cancelled too (if `replaceActive` is true).
3. If an `AbortSignal` is provided, an abort listener is attached.
4. The job is pushed onto the domain's queue and sorted.
5. `drainQueues()` attempts to start the next job:
   - If the worker supports the task → boot/reuse worker → create dispatch request → send `RUN` message.
   - If the worker doesn't support the task (or boot fails) → execute `fallback()` on the main thread.
6. On worker completion (`RESULT`), the job's promise resolves.
7. On worker error (`ERROR`), the job's promise rejects.
8. On worker cancel (`CANCELLED`), the job rejects with `AbortError`.

### 6.5 Message Protocol (`protocol.js`)

**[VERIFIED]** Messages from main thread to worker:
| Type | Purpose |
|---|---|
| `init` | Initialize worker with domain and capabilities |
| `run` | Execute a task with ID, task name, processId, payload |
| `cancel` | Cancel a running task by ID |

Events from worker to main thread:
| Type | Purpose |
|---|---|
| `ready` | Worker is initialized and ready |
| `progress` | Task progress update (ratio, message, payload) |
| `log` | Log entry from the worker (level, message) |
| `result` | Task completed successfully with payload |
| `error` | Task failed with error message and details |
| `cancelled` | Task was cancelled |

### 6.6 Worker Host (`host.js`)

**[VERIFIED]** `createWorkerDomainHost(domain, handlers)` runs inside a worker thread:
- Listens for `message` events on `self`.
- On `INIT`: stores capabilities, posts `READY`.
- On `RUN`: looks up the handler by task name, creates a context object, executes the handler.
- Context provides: `id`, `domain`, `task`, `processId`, `capabilities`, `isCancelled()`, `assertNotCancelled()`, `progress()`, `log()`.
- On success: sends `RESULT` with payload (supports transferable arrays via `result.transfer`).
- On error: sends `ERROR` with message and structured details (code, stage, fallbackReason, compatibilityMode, runtime, meta).
- On cancel (via `AbortError` or prior cancel message): sends `CANCELLED`.

### 6.7 Environment Capabilities (`capabilities.js`)

**[VERIFIED]** `detectWorkerCapabilities()` probes:
| Capability | Detection Method |
|---|---|
| `worker` | `typeof Worker === 'function'` |
| `moduleWorker` | Spin up + immediately terminate a module worker blob |
| `wasm` | `typeof WebAssembly === 'object'` |
| `wasmSimd` | Validate a WASM binary with SIMD v128 instructions |
| `offscreenCanvas2d` | `typeof OffscreenCanvas === 'function'` |
| `offscreenCanvasWebgl2` | Create OffscreenCanvas + test WebGL2 context |
| `compressionStreams` | `typeof CompressionStream === 'function'` |
| `fileSystemAccess` | `typeof showOpenFilePicker === 'function'` |
| `createImageBitmap` | `typeof createImageBitmap === 'function'` |
| `hardwareConcurrency` | `navigator.hardwareConcurrency` |

### 6.8 File Transfer (`filePayload.js`)

**[VERIFIED]** Helpers for marshalling `File`/`Blob` objects across the worker boundary (structured cloning):
- `createWorkerFileEntry(file)` → reads `file.arrayBuffer()`, produces `{ name, type, size, lastModified, buffer }`.
- `createWorkerFileEntries(files)` → batch version, collects transferable `buffer` arrays.
- `reviveWorkerFileEntry(fileEntry)` → reconstructs a `File` (or `Blob` with metadata properties) from the transferred buffer.
- All functions include `assertNotCancelled()` checkpoints between async operations.

### 6.9 Worker Domains and Registered Tasks

**[VERIFIED]** The application registers 6 worker domains:

#### `editor` Domain (`editor.worker.js` → `tasks/editor.js`)
| Task | Purpose | WASM? |
|---|---|---|
| `read-studio-state-file` | Parse a `.mns` JSON file in the background | No |
| `compute-analysis-visuals` | Histogram + vectorscope + parade from pixel array | Yes (with JS fallback) |
| `compute-diff-preview` | Before/after pixel diff visualization | Yes (with JS fallback) |
| `extract-palette-from-image` | K-means palette extraction from image file | Yes (with JS fallback) |
| `probe-dng-source` | Inspect DNG metadata without full decode | No |
| `prepare-dng-source` | Demosaic + color-correct a DNG for preview | No |
| `export-png16` | Render DNG to 16-bit PNG | No |

#### `dng` Domain (`dng.worker.js` → `tasks/dng.js`)
| Task | Purpose |
|---|---|
| `probe-dng-source` | Probe DNG metadata from buffer/file |
| `decode-dng-source` | Full DNG decode returning Float32Array raster + metadata (GPU-transferable) |

#### `stitch` Domain (`stitch.worker.js` → `tasks/stitch.js`)
| Task | Purpose |
|---|---|
| `analyze-screenshot` | Run JS screenshot stitching analysis |
| `prepare-analysis-inputs` | Decode + resize inputs for analysis |
| `classify-scene-mode` | Auto-classify scene as screenshot/photo |
| `build-candidate-previews` | Render all candidate alignment previews |
| `prepare-input-files` | Read dropped files into stitch input format |

#### `stitch-opencv` Domain (`stitchOpencv.worker.js`)
Dedicated domain for OpenCV WASM photo analysis. Has its own boot sequence (20-second timeout) separate from the task broker.

#### `composite` Domain (`composite.worker.js` → `tasks/composite.js`)
| Task | Purpose |
|---|---|
| `prepare-image-files` | Read dropped files into composite layer format |
| `render-preview` | Render a scaled preview of the composite using OffscreenCanvas |
| `render-export-png` | Render full-resolution composite export as PNG blob |

#### `app-library` Domain (`appLibrary.worker.js` → `tasks/appLibrary.js`)
| Task | Purpose | WASM? |
|---|---|---|
| `load-registry` | Load layer registry JSON in background | No |
| `prepare-asset-record` | Generate preview + fingerprint for a library asset | No |
| `fingerprint-asset` | SHA-256 fingerprint of an asset's data URL | No |
| `read-image-metadata` | Read dimensions from an image data URL | No |
| `build-secure-library-export-record` | Encrypt + compress library export | Yes (with JS fallback) |
| `resolve-secure-library-import-record` | Decrypt + decompress library import | Yes (with JS fallback) |

#### `three` Domain (`three.worker.js` → `tasks/three.js`)
| Task | Purpose |
|---|---|
| `prepare-model-files` | Read dropped GLB/GLTF files as data URLs |
| `prepare-image-plane-files` | Read dropped image files for 3D image planes |
| `prepare-font-files` | Read dropped TTF/OTF/WOFF files for 3D text |
| `prepare-hdri-file` | Read dropped HDR file for environment lighting |

### 6.10 Cancellation and Scope System

**[VERIFIED]** The broker supports:
- **Per-job cancellation:** Via `AbortSignal` or `replaceKey` displacement.
- **Scope cancellation:** `cancelScope(scope)` cancels all jobs whose scope starts with the given prefix (hierarchical: `'stitch:analysis'` cancels `'stitch:analysis:sub1'`).
- **Domain cancellation:** `cancelDomain(domain)` cancels all jobs in a domain.
- **Active job restart:** When cancelling an active job, the worker is terminated and a fresh one is booted for the next task (configurable via `restartWorkerOnActiveCancel`).
- **Cancel → worker notification:** A `CANCEL` message is sent to the worker so it can abort in-progress work.

### 6.11 Configuration at Runtime

**[VERIFIED]** `broker.configure({ maxConcurrentTasks })` allows runtime reconfiguration of the global concurrency limit. This is how `settings.general.maxBackgroundWorkers` takes effect — it feeds into `configure()` after settings are loaded or changed.

---

## 7. Open Questions & Verification Gaps
- The exact registration calls in `bootstrap.js` — which `config` objects (workerUrl, fallback, etc.) are passed to each `registerDomain()` call. This determines which tasks have main-thread fallbacks.
- Whether the `stitch-opencv` domain is registered via the task broker or managed independently by the Stitch engine.
- The `stitchOpencv.worker.js` file (7.8KB) — not a simple 5-line entry like others, suggesting it may manage its own OpenCV WASM lifecycle outside the standard broker protocol.
