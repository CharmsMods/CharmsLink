# Stitch Regression Matrix

## Purpose
Use this matrix before and after Stitch changes so regressions are caught in screenshot routing, photo routing, preview generation, logs, and settings/defaults behavior.

## Scenario Sets

### 1. Screenshot-only set
- 3 to 5 rigid UI screenshots with clear overlap
- expected backend: `screenshot-js`
- expected outcome: ranked candidates, no photo runtime required, no photo runtime error

### 2. Easy photo pair
- 2 overlapping photos with stable perspective and moderate texture
- expected backend: `opencv-wasm`
- expected outcome: at least one valid ranked candidate, no hung state, detector logged

### 3. Hard photo pair
- 2 overlapping photos with perspective shift and light parallax
- expected backend: `opencv-wasm`
- expected outcome: at least one usable candidate or a clear low-confidence warning, no fabricated success state

### 4. Weak-overlap failure set
- 2 or more images with weak or effectively no usable overlap
- expected backend: `opencv-wasm` for forced photo or `auto` if classified as photo
- expected outcome: clear warning or failure, no endless active state, no misleading “ready” state

### 5. Mixed auto-mode set
- mix of screenshot-style and photo-style inputs
- expected backend: logged auto classifier decision with reason
- expected outcome: correct routing to screenshot or photo backend, consistent logs

## Validation Checklist

### Runtime
- broker-managed `stitch` tasks run and cancel correctly
- broker-managed `stitch-opencv` probe succeeds or fails with a clear reason
- supported detectors are visible in Settings diagnostics

### Logs
- `stitch.import` logs input preparation
- `stitch.analysis` logs start, progress, backend selection, and terminal state
- `stitch.preview` logs candidate preview generation
- `stitch.export` logs PNG export
- `stitch.settings` logs default changes and apply-defaults actions
- `stitch.worker` logs runtime probe and OpenCV runtime readiness/failure

### Settings
- new Stitch project picks up `settings.stitch.defaults`
- current Stitch project does not change when defaults change
- explicit apply-defaults updates the current project and invalidates stale analysis
- loaded/imported Stitch project keeps its stored settings until apply-defaults is invoked

### UI
- progress is shown through `analysis.progressMessage`, not `analysis.warning`
- warnings remain warnings only
- stale results do not repaint after rerun or settings change
- running analysis disables live actions that would corrupt state

### Export
- export overlay appears quickly
- export no longer looks frozen
- export logs land in `stitch.export`
