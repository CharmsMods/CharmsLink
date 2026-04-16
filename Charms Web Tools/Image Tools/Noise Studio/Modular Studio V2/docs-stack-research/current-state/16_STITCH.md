# The Stitch Engine (Panoramic Image Stitching)

## 1. Purpose
This document describes the Stitch section — a panoramic image stitching tool that aligns and blends multiple input images into a single composite output. It includes a multi-backend analysis pipeline (screenshot-optimized JavaScript vs. OpenCV/WASM for photographic scenes), a candidate ranking system for alignment results, and an advanced multi-band blending compositor with seam-carving and gain compensation. The Stitch section uses the "Workstation Style" design language.

## 2. Scope
This file covers `src/stitch/document.js` (data model), `src/stitch/engine.js` (rendering and analysis), `src/stitch/warp.js` (mesh/perspective warping), `src/stitch/classifier.js` (scene mode auto-classification), `src/stitch/analysis.js` (screenshot alignment), `src/stitch/opencv-worker.js` (photo alignment via WASM), and `src/stitch/worker.js` (lightweight delegation worker). It does not cover the UI (`src/stitch/ui.js`, 57KB).

## 3. Verification State
- **Verified from Source:**
  - `src/stitch/document.js` (complete 522 lines: all constants, normalization, placement management, bounds computation, candidate management, ephemeral stripping, summarize)
  - `src/stitch/engine.js` (complete 1528 lines: full rendering pipeline, analysis orchestration, blending, export, candidate previews, hit testing)
  - `src/stitch/warp.js` (complete 306 lines: mesh grid normalization, warp point computation, affine triangle solving, warped drawing)
  - `src/stitch/classifier.js` (complete 142 lines: edge/flat/entropy analysis, scene mode scoring)
  - `src/settings/defaults.js` → `stitch` settings block
  - `src/settings/schema.js` → stitch normalization
  - `src/settings/apply.js` → `applyStitchSettingsToDocument`, `applyThemeToStitchDocument`, `createSettingsDrivenStitchDocument`
- **Inferred Behavior:** The `analysis.js` (70KB) screenshot analysis algorithm and `opencv-worker.js` (128KB) photo analysis pipeline were noted by size but not deeply read.

## 4. Cross-System Dependencies
- **Background Task Broker:** The Stitch engine uses the `taskBroker` (from `src/workers/runtime.js`) for offloading analysis to background workers. It registers tasks in the `'stitch'` and `'stitch-opencv'` domains.
- **OpenCV WASM:** Photo mode analysis uses a dedicated OpenCV worker (`src/stitch/opencv-worker.js`) that loads OpenCV.js via WebAssembly. Boot timeout is 20 seconds.
- **Library Storage:** Stitch documents are saved as `stitch-document` kind payloads.
- **Settings Integration:** Stitch defaults flow from `settings.stitch.defaults` (sceneMode, blendMode, warpMode, meshDensity, warpDistribution, analysisMaxDimension, featureDetector, maxFeatures, matchRatio, ransacIterations, inlierThreshold, maxCandidates). Diagnostics track runtime availability (worker, WASM, supported detectors).

## 5. State Behavior
- **Saved (Durable):**
  - `document.inputs[]` — Each input image: id, name, type (mime), imageData (data URL), width, height.
  - `document.settings` — All algorithm tuning parameters.
  - `document.candidates[]` — Ranked alignment results, each containing placements, score, confidence, model type, diagnostics.
  - `document.activeCandidateId` — Which candidate is currently applied.
  - `document.placements[]` — Active placement per input: position (x, y), scale, rotation, z-order, opacity, warp data.
  - `document.selection` — Selected input ID.
  - `document.view` — Theme, zoom, panX, panY, zoomLocked, showLabels, showBounds.
  - `document.export` — Padding, background color.
  - `document.workspace` — galleryOpen, alternativesOpen, sidebarView.
- **Runtime-only:**
  - Image cache (`imageCache` Map), decoded `Image`/`ImageBitmap` objects.
  - Offscreen canvases for blending and compositing.
  - Analysis state (status, progressMessage, runId, backend).
  - Viewport transform state.
  - Worker/OpenCV worker handles and pending request maps.
- **Derived/Cached:**
  - Composite bounds computed from visible placements.
  - Candidate preview thumbnails generated on demand.
  - Analysis diagnostics with runtime timing.

---

## 6. Current Behavior

### 6.1 Document Model (`src/stitch/document.js`)
**[VERIFIED]** The document follows the `mns/v2` envelope with `kind: 'stitch-document'`.

Algorithm tuning parameters with their defaults and ranges:

| Parameter | Default | Range |
|---|---|---|
| `analysisMaxDimension` | 2048 | 128–2048 |
| `maxFeatures` | 4000 | 20–4000 |
| `matchRatio` | 0.75 | 0.4–0.99 |
| `ransacIterations` | 5000 | 40–5000 |
| `inlierThreshold` | 4.5 | 0.5–48 |
| `maxCandidates` | 8 | 1–12 |
| `sceneMode` | `auto` | auto, screenshot, photo |
| `warpMode` | `mesh` | auto, off, perspective, mesh |
| `meshDensity` | `high` | low, medium, high |
| `warpDistribution` | `balanced` | anchored, balanced |
| `blendMode` | `auto` | auto, alpha, feather, seam |
| `featureDetector` | `auto` | auto, orb, akaze, sift |

**[VERIFIED]** Legacy document migration: The normalizer detects documents saved with older V1 defaults (analysisMaxDimension=320, maxFeatures=120, etc.) and upgrades them to V2 defaults when the `photoBackend` field is absent.

### 6.2 Placement System
**[VERIFIED]** Each placement maps an input to a position in world space:
- `inputId` — References the corresponding input.
- `x, y` — World-space position.
- `scale` — Uniform scale factor (min 0.01).
- `rotation` — Radians.
- `z` — Z-order for stacking.
- `opacity` — 0–1.
- `warp` — Optional mesh/perspective warp data (see 6.6).

Placements are enforced to be complete: every input gets a placement, orphaned placements are pruned, and missing placements receive defaults.

### 6.3 Candidate System
**[VERIFIED]** Analysis produces multiple candidate alignments, each scored and ranked:
- `id`, `name`, `score`, `confidence` (0–1), `rank`.
- `source` — `'analysis'` or `'manual'`.
- `modelType` — `'rigid'` or `'manual'` (or other analysis-derived types).
- `blendMode` — Per-candidate blend mode override.
- `coverage` — Fraction of input area covered.
- `placements[]` — The specific arrangement for this candidate.
- `diagnostics[]`, `warning` — Optional analysis metadata.

**[VERIFIED]** `applyCandidateToDocument()` applies a candidate's placements to the live document. `buildManualLayoutCandidate()` creates a side-by-side manual fallback when analysis fails or for single images.

### 6.4 Scene Classification (`src/stitch/classifier.js`)
**[VERIFIED]** When `sceneMode` is `auto`, the classifier analyzes prepared inputs to determine `screenshot` vs. `photo`:
- Samples grayscale pixel gradients at stride intervals.
- Computes: `edgeRatio`, `flatRatio`, `axisAlignedEdgeRatio`, `entropy` (normalized histogram entropy over 16 bins).
- Scoring formula: `screenshotScore = (flatRatio * 0.42) + (axisAlignedEdgeRatio * 0.33) + ((1 - entropy) * 0.2) + (max(0, 0.08 - edgeRatio) * 0.6)`.
- Threshold: `screenshotScore >= 0.53` → screenshot backend, else photo backend.

### 6.5 Analysis Pipeline (`src/stitch/engine.js`)
**[VERIFIED]** The full analysis flow:
1. **Scene classification** (if auto mode): Build low-res inputs (max 256px), classify scene type.
2. **Prepare analysis inputs:** Resize inputs to `analysisMaxDimension`, extract grayscale buffer.
3. **Route to backend:**
   - `screenshot-js`: Uses `src/stitch/analysis.js` (JavaScript feature matching).
   - `opencv-wasm`: Uses `src/stitch/opencv-worker.js` (OpenCV WASM with ORB/AKAZE/SIFT detectors).
4. **Return candidates** with placements, scores, diagnostics, and timing metrics.

**[VERIFIED]** Both backends delegate to the `taskBroker` when available, using `'stitch'` domain for screenshot and `'stitch-opencv'` domain for photo analysis. The OpenCV worker has a 20-second boot timeout and sends `ready`/`init-error`/`progress` messages.

### 6.6 Warp System (`src/stitch/warp.js`)
**[VERIFIED]** Warping deforms input images to correct for perspective or lens distortion. Two types:
- **Perspective:** Fixed 8×8 grid.
- **Mesh:** Variable-density grid (low=8×8, medium=12×12, high=16×16).

Each warp point carries:
- `u, v` — Normalized source coordinates (0–1).
- `dx, dy` — Displacement in local pixel space.
- `weight` — Confidence/anchor weight.

Rendering uses per-grid-cell affine triangle decomposition: each cell is split into two triangles, each solved for an affine transform via `solveTriangleAffine()`, then drawn with `ctx.clip()` + `ctx.transform()` + `ctx.drawImage()`.

### 6.7 Blending System (`src/stitch/engine.js`)
**[VERIFIED]** Three blend modes:
- **Alpha (`alpha`):** Simple alpha compositing. Fast, no overlap handling.
- **Feather (`feather`):** Linear gradient blending in the overlap region. Uses overlap analysis to determine blend orientation (vertical/horizontal) and side (left/right or top/bottom), then applies smoothstep-eased blending.
- **Seam (`seam`):** Content-aware seam carving. Computes a cost map from color differences + edge strength, finds the minimum-cost seam via dynamic programming, then feathers around the seam path.

**[VERIFIED]** On top of all modes except alpha, the engine applies:
- **Gain Compensation:** Analyzes the overlap region to compute per-channel gain factors (luminance-weighted), clamped to 0.72–1.4, mixing channel gain with luminance gain at 35%/65% ratio.
- **Multi-band Blending:** Laplacian pyramid decomposition (up to 5 levels, minimum dimension 24px), per-level blending using mask pyramids, reconstruction. This produces seamless color transitions across the blend boundary.

### 6.8 Export
**[VERIFIED]** `exportPngBlob()` renders the full composite at native resolution (no viewport transform), applies the configured padding and background color, runs the full blend pipeline, and produces a PNG blob via `canvas.convertToBlob()` or `canvas.toBlob()`.

### 6.9 Ephemeral State Stripping
**[VERIFIED]** `stripEphemeralStitchState()` produces a save-safe copy of the document by:
- Resetting `galleryOpen` to false.
- Clearing analysis `progressMessage`, `runId`, and `previews`.
- Preserving all candidates, placements, settings, and analysis diagnostics/warnings.

---

## 7. Open Questions & Verification Gaps
- `src/stitch/analysis.js` (70KB): The full JavaScript screenshot analysis algorithm (feature detection, matching, homography estimation) was not deeply read.
- `src/stitch/opencv-worker.js` (128KB): The OpenCV WASM integration, supported feature detectors, and homography computation were not deeply read.
- `src/stitch/meta.js` (9KB): Purpose unknown — likely metadata extraction or input preparation helpers.
- `src/stitch/ui.js` (57KB): The full Stitch workspace UI was not read.
- Whether the `useFullResolutionAnalysis` flag bypasses the dimension scaling entirely or uses a different path.
- The interaction between `warpDistribution` (`anchored` vs. `balanced`) and how warp points are generated from analysis results.
