## Composite Tab Rework Plan

### Summary

Rework Composite around a cheap live interaction model, not around heavier raster work. Keep the current feature scope you chose to preserve: Editor-backed layers stay linked, the "update original Editor project" bridge stays, and export stays inline inside the Composite tab.

The saved `composite-document` JSON shape should stay compatible. The rework should change interaction architecture, export workflow, and background processing, not the core payload format.

### Key Changes

#### 1. Live interaction architecture

- Keep the live viewport as a DOM image stack with CSS transforms and blend modes.
- Introduce a local `compositeSession` inside the Composite workspace for drag, pan, zoom, export-bounds editing, and pixel-match arming.
- Pointer and wheel gestures must update only local session state during the gesture, render through `requestAnimationFrame`, and commit once on pointer-up or short gesture-idle.
- Do not write to the global app store on every pointer move.
- Do not rerender Composite side panels during active gestures.
- `Frame` must become a real fit-to-visible-layers action, not a hard reset to `zoom: 1, pan: 0,0`.

#### 2. Composite store/action cleanup

- Remove the Composite deep-change check based on whole-document `stableSerialize(previous) !== stableSerialize(next)` from the interaction path.
- Replace it with explicit autosave intent on committed Composite actions.
- Autosave should remain supported for Library-linked Composite projects, but only after committed durable changes, never during active drag/pan/bounds-resize.
- Fix `setCompositeSidebarView()` so it accepts all four valid views: `layers`, `transform`, `blend`, `export`.
- Keep local interaction state, export-step state, and pixel-match armed state ephemeral and out of persisted payloads.

#### 3. Layer ingest and viewport behavior

- New layers must spawn fit-to-viewport, centered, and immediately readable.
- First added layer should center in view and scale to fit comfortably inside the visible stage.
- Later added layers should use the same fit logic with a small cascade offset, not stack huge full-size rasters off-screen.
- Editor-backed layer display rasters must come from a fresh hidden Editor capture as the authoritative Composite preview. Library preview/blob can be used only as a temporary placeholder if needed.
- The upside-down Editor-layer issue should be treated as a preview-source consistency bug: normalize all Editor-backed Composite layers through one capture path before final display state is trusted.
- On-canvas direct manipulation in this pass should remain move-only. Scale, rotation, opacity, and blend stay in the sidebar controls.

#### 4. Inline export-mode rebuild

- Export remains inside the Composite tab.
- When `Export` is active, layer editing is locked out. Only stage pan/zoom and export-bounds move/resize are interactive.
- Export panel becomes a clear staged flow:
  - bounds mode: `auto` or `custom`
  - aspect preset: `16:9`, `3:4`, `4:3`, `9:16`, `1:1`, or freeform/custom
  - resolution mode: manual width/height or pixel-match
- Fix the broken export controls:
  - export tab must actually open
  - output width/height inputs must use dedicated export handlers, not the layer-number handler
  - preset changes must update custom bounds deterministically
- Pixel-match rules:
  - only available for visible layers fully contained inside the current custom export bounds
  - clicking an eligible layer computes output resolution from that layer’s intrinsic source size and its transformed size in world space
  - if the layer is only partially inside bounds, pixel-match is disabled with a visible status reason
- `auto` export mode should keep the current “contain all visible layers” behavior.

#### 5. Background work

- Do not add WASM to Composite in this pass. The current bottleneck is state/render orchestration, not math throughput.
- Add a `composite` background worker domain for heavy non-interaction work when module workers + OffscreenCanvas 2D are available.
- Worker tasks should cover:
  - local-image ingest prep and metadata read
  - Composite preview raster generation
  - final Composite PNG export raster generation
- Fallback must remain the current main-thread raster path when worker capabilities are unavailable.
- Live drag/pan/viewport response should not depend on the worker; it must stay responsive even in fallback mode.

### Interfaces / Internal Contracts

- No required breaking change to persisted `composite-document` payloads.
- Internal action contract changes:
  - `setCompositeSidebarView('export')` must be valid
  - Composite commit actions must explicitly decide whether autosave is scheduled
  - gesture-time updates stay local to the Composite workspace and are not store actions
- Add a Composite worker task interface for image prep, preview render, and export render, with main-thread fallback using the same normalized document math.

### Test Plan

Because the repo has no real app test runner today, verification should be manual plus small pure-helper checks where practical.

Manual scenarios:
- Open Composite, switch to `Export`, and confirm the export panel and bounds overlay both work.
- Add a very large local image and a saved Editor project. Both should appear upright, centered, and initially fit on screen.
- Drag layers, pan the stage, zoom, and resize/move export bounds with 3–5 large layers loaded. No multi-second stalls, no UI freeze, no autosave/log spam during the active gesture.
- Confirm transform sidebar controls still work after the local-session rewrite.
- Confirm export width/height controls now change output resolution correctly.
- Confirm each aspect preset produces the correct bounds ratio.
- Confirm pixel-match only arms on eligible layers inside bounds and computes the expected output size.
- Save Composite JSON, save to Library, reload from Library, and export PNG after the rewrite.
- Open an Editor-backed Composite layer in Editor, make an edit, return to Composite, and confirm the linked layer preview refreshes correctly.
- Verify worker-supported environments use background preview/export paths, and worker-disabled fallback still works correctly.

Pure-helper checks:
- layer fit-to-viewport calculation
- export preset ratio calculation
- pixel-match resolution calculation
- frame-to-bounds camera/view math

### Assumptions And Defaults

- Preserve the current Editor-link bridge, including update-original-project behavior.
- Keep export as an inline Composite mode, not a fullscreen overlay or modal wizard.
- Keep the current blend-mode set.
- Keep move-on-canvas as the only direct layer manipulation in this pass; do not expand scope into on-canvas rotate/scale handles yet.
- Keep autosave behavior for Library-linked Composite projects, but only after committed changes.
- Treat workerization as export/preview assistance only, not as the primary fix for live responsiveness.
