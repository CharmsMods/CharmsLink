# WASM Finalization And Performance Sweep

## Summary
Finish the current WASM rollout as a **full performance sweep**, but keep the implementation order disciplined: stabilize and harden the existing `Editor` and `Library` WASM paths first, then land the first 3D performance tranche. The current review is directionally useful, but the live code still needs reliability work around secure Library export, stale worker/module caching, and runtime validation before the WASM layer can be treated as “done.”

Chosen defaults for this plan:
- scope: `Full Perf Sweep`
- secure Library export fallback: `Ask Before Fallback`
- decoder/WASM assets stay locally vendored and browser/Electron compatible
- Stitch remains out of scope

## Key Changes

### 1. Editor + Library WASM hardening
- Add a **runtime self-test** at WASM init for both domains.
  - `editor`: smoke-test histogram/diff/palette kernels on tiny fixed buffers before marking the runtime usable.
  - `library`: smoke-test base64 encode/decode round-trip on a fixed byte payload.
  - If self-test fails, mark the runtime as unavailable for that session and log the reason.
- Add **asset versioning / cache busting** for worker URLs and WASM module URLs.
  - Append a shared app build/version token to worker URLs in `main.js`.
  - Append the same token to `moduleUrl` loading in `src/wasm/*.js`.
  - Goal: no stale Edge/browser worker or `.mjs` reuse after a deployment.
- Make WASM runtime selection and fallback behavior explicit in the Logs flow.
  - Log `simd`, `baseline`, or `js-fallback`.
  - Log whether fallback happened because of capability mismatch, runtime init failure, self-test failure, large payload policy, or task-time exception.
- Remove remaining dead or duplicated secure-export logic from the UI layer so the heavy path lives in one place.
  - `libraryPanel.js` should not keep parallel base64/compression helpers for the secure export/import path once the worker-backed shared path is finalized.

### 2. Library secure export/import completion
- Finish the `Library` secure export path as a **two-mode pipeline**:
  - fast path: worker + WASM codec
  - safe path: worker + JS/native codec
- Implement **Ask Before Fallback** exactly:
  - if the fast path is risky or fails, pause and show a modal explaining that the export can continue using a slower compatibility path
  - if the user confirms, rerun with the safe path
  - if the user cancels, stop cleanly without showing a failure state
- Define “risky” conditions up front:
  - WASM runtime unavailable
  - WASM runtime self-test failed
  - export payload estimate exceeds the fast-path threshold
  - fast-path packaging throws during gzip/encrypt/base64
- Add **stage-level secure export logs**:
  - bundle normalized
  - bundle JSON size estimate
  - compressed size
  - encrypted size
  - base64 packaging started/completed
  - fallback prompt shown / accepted / declined
- Finish **payload trimming** in the shared export path, not only the UI helper path.
  - project exports strip transient preview/render fields
  - asset exports strip preview-only blobs
  - imported previews continue to regenerate through existing backfill paths
- Preserve backward compatibility for older secure exports.
  - imports must still accept older duplicated-copy payloads even though new exports are single-copy only

### 3. Editor WASM completion
- Keep the current worker-owned Editor compute boundary and finish the parity pass.
  - `compute-analysis-visuals`
  - `compute-diff-preview`
  - `extract-palette-from-image`
- Add **result validation tolerances** for the first pass.
  - histogram/vectorscope/parade outputs must stay visually equivalent to the JS path
  - palette extraction stays deterministic across repeated runs on the same image
- Add **stale-result and hidden-scope guards** everywhere the Editor dispatches background analysis.
  - no scope work when scopes are hidden
  - no palette/diff/scopes repaint from older aborted jobs
- Add **performance telemetry** that can be compared before/after.
  - init time
  - task runtime
  - queue wait time
  - fallback count per task
- Keep JS fallbacks intact for all Editor tasks, but make fallback reasons inspectable instead of silent.

### 4. 3D first performance tranche
- Add compressed-asset loading support to the current `GLTFLoader` path.
  - integrate `DRACOLoader`
  - integrate `KTX2Loader`
  - vendor the decoder/transcoder assets locally so browser and Electron both work without CDN dependencies
  - log decoder availability and actual compressed-path usage
- Move boolean/CSG work toward a worker-owned WASM path.
  - add a `three` worker task for CSG evaluation
  - use a WASM-backed engine such as `Manifold3D` for heavy mesh boolean work
  - keep `three-bvh-csg` as the fallback path until parity is proven
- Ship the 3D CSG change behind a capability/runtime gate at first.
  - if the WASM CSG runtime is unavailable or fails validation, use the current JS CSG implementation
  - keep the user-visible workflow unchanged while swapping the compute backend
- Add 3D performance logging and timing around:
  - model decode/import
  - compressed texture/model decompression
  - CSG evaluation duration
  - fallback reason if the fast path is skipped

## Public Interfaces And Integration Changes
- New shared version token for worker and WASM asset URLs.
- `Library` secure export/import gains a user-facing **compatibility fallback modal** when the fast path is risky or fails.
- `three` worker gains a dedicated CSG task for boolean evaluation.
- `GLTFLoader` initialization gains local `DRACOLoader` and `KTX2Loader` setup.
- Existing `editor` and `app-library` worker tasks stay the same externally, but gain runtime self-test and stricter fallback rules internally.

## Test Plan
- Editor:
  - scopes visible vs hidden
  - rapid slider changes with stale task replacement
  - changed-pixels preview under repeated updates
  - palette extraction repeated on the same image
  - compare `simd`, `baseline`, and `js-fallback` logs
- Library:
  - secure export in Edge with small and large payloads
  - secure export fast path success
  - risky-path prompt shown
  - fallback accepted and export succeeds
  - fallback declined and export cancels cleanly
  - secure import of new single-copy exports
  - secure import of older duplicate-copy exports
  - plain JSON export/import unchanged
- Cache/versioning:
  - deploy/reload path should not reuse stale worker scripts or stale WASM modules
  - versioned worker/WASM URLs should force fresh loads after changes
- 3D:
  - compressed glTF import with DRACO
  - texture/transcoder path with KTX2 when present
  - fallback to plain loader when decoder assets are unavailable
  - CSG parity against current behavior on known scenes
  - heavy boolean operation should no longer freeze the UI as badly on supported systems

## Assumptions
- “Finalize the implementation” means **reliability + performance completion**, not only adding more kernels.
- The current review’s “flawless execution” assessment is not accepted as a final implementation criterion; live runtime validation and export reliability win over review optimism.
- Generated WASM artifacts remain committed, and local vendored decoder/WASM assets remain the default distribution model.
- Stitch stays out of this plan.
