# WASM Finalization And Performance Sweep, With 3D Cut Removal

## Summary
Finish the current WASM rollout as a reliability-first performance sweep: harden the existing `Editor` and `Library` WASM paths, complete the secure Library export/import pipeline, and do a smaller 3D performance pass focused on compressed asset loading only. The previous 3D subtraction/cut system is removed instead of optimized.

Chosen decisions locked for this plan:
- scope: `Full Perf Sweep`
- secure Library export fallback: `Ask Before Fallback`
- old 3D stored cuts: `Strip On Load`
- Stitch remains out of scope
- `ai_context.txt` must be updated at the end of each landed phase

## Key Changes

### 1. Editor + Library WASM hardening
- Add runtime self-tests during WASM init.
  - `editor`: tiny fixed-buffer smoke tests for scopes, diff preview, and palette extraction
  - `library`: fixed-payload base64 encode/decode round-trip
- Add versioned worker and WASM asset URLs.
  - use one shared app version token for worker URLs in `src/main.js`
  - apply the same token to `src/wasm/*.js` module loads so Edge/Electron do not keep stale workers or `.mjs` shims
- Make runtime selection explicit in logs and metrics.
  - `simd`, `baseline`, or `js-fallback`
  - init time, task time, queue wait, fallback reason
- Keep JS fallbacks for every WASM-backed task, but stop silent fallback behavior.
- Remove duplicated secure export/import helper logic from `src/ui/libraryPanel.js` once the shared worker-backed path is the single source of truth.

### 2. Library secure export/import completion
- Finish secure export as a two-path worker pipeline:
  - fast path: worker + WASM codec
  - compatibility path: worker + JS/native codec
- Implement `Ask Before Fallback`.
  - show a modal when the fast path is unavailable, self-test fails, the payload estimate is too large, or the fast path throws
  - if accepted, rerun with the compatibility path
  - if declined, cancel cleanly without logging a failure
- Move payload trimming into the shared export path, not only the UI layer.
  - strip transient project preview/render fields
  - strip asset preview-only blobs
  - keep preview regeneration through existing backfill
- Remove the new-export duplicate-copy path entirely.
  - new secure exports are always single-copy
  - secure imports remain backward-compatible with older duplicate-copy files
- Add stage-level export/import logs:
  - bundle normalized
  - estimated JSON size
  - compressed size
  - encrypted size
  - base64 started/completed
  - fallback prompt shown / accepted / declined
- Add payload-size guardrails before base64 packaging so large exports do not hit `Invalid string length` again.

### 3. Editor WASM completion
- Keep the existing worker-owned Editor compute boundary and finish parity on:
  - `compute-analysis-visuals`
  - `compute-diff-preview`
  - `extract-palette-from-image`
- Add result validation and stale-result guards.
  - no scope work when scopes are hidden
  - no repaint from cancelled or older jobs
  - deterministic palette output on repeated runs of the same image
- Add task telemetry that can be compared against JS fallback.
  - init time
  - queue wait
  - task runtime
  - fallback counts by task
- Keep main-thread DOM/canvas work in JS; WASM remains worker-owned only.

### 4. 3D cut removal and focused 3D performance pass
- Remove the 3D object-cutting feature entirely.
  - remove subtraction UI from the inspector and context menu
  - remove slice/reset actions, selection-state wiring, and engine subtraction code
  - remove the `three-bvh-csg` dependency path from the active 3D engine
- Apply `Strip On Load` for old scenes.
  - `normalizeThreeDDocument()` drops `booleanCuts` during load/import/restore
  - Library and JSON saves no longer write cut data
  - when old scenes lose stored cuts on load, show a clear one-time notice/log entry so the change is explicit
- Keep the 3D performance tranche limited to compressed asset loading.
  - integrate local vendored `DRACOLoader`
  - integrate local vendored `KTX2Loader`
  - wire them into the existing `GLTFLoader`
  - log decoder availability and actual compressed-path usage
- Do not add new 3D WASM/CSG work in this plan.

## Public Interfaces And Integration Changes
- New shared version token used by worker URLs and WASM asset URLs.
- `Library` secure export/import gets a user-facing compatibility fallback modal.
- 3D document normalization changes:
  - legacy `booleanCuts` are discarded on load
  - new saves/exports do not include cut data
- Existing `editor` and `app-library` worker tasks keep their public task names, but gain self-test, stricter fallback reporting, and task telemetry.

## Test Plan
- Editor:
  - scopes visible vs hidden
  - rapid slider changes with stale task replacement
  - changed-pixels preview under repeated updates
  - palette extraction repeated on the same image
  - compare `simd`, `baseline`, and `js-fallback` logs
- Library:
  - secure export in Edge with small and large payloads
  - fast path success
  - risky-path fallback prompt
  - fallback accepted and export succeeds
  - fallback declined and export cancels cleanly
  - secure import of new single-copy exports
  - secure import of older duplicate-copy exports
  - plain JSON export/import unchanged
- Cache/versioning:
  - after code changes, reload should not reuse stale worker scripts or stale WASM module shims
- 3D:
  - old saved scenes with cuts load with cuts removed and a clear notice/log
  - new UI has no cut/slice affordances
  - compressed glTF import works with DRACO
  - KTX2 textures load when present
  - fallback to normal loader behavior when decoder assets are unavailable

## Assumptions
- “Finalize the implementation” means reliability plus performance completion, not just adding more kernels.
- The review doc is useful input, but live runtime validation and export reliability take priority over its optimistic assessment.
- Generated WASM artifacts and local decoder assets remain vendored in-repo for browser and Electron compatibility.
- Stitch stays out of scope for this pass.
