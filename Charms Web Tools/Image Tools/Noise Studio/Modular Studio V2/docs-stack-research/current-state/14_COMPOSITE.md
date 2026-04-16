# The Composite Engine

## 1. Purpose
This document describes the Composite section — a 2D layer compositor that allows users to combine multiple images (including Editor project outputs) into a single arranged output. It is architecturally simpler than the Editor's WebGL pipeline, using 2D Canvas for rendering, and focuses on spatial placement, ordering, and opacity rather than non-destructive filter processing.

## 2. Scope
This file covers `src/composite/document.js` (data model), `src/composite/engine.js` (rendering pipeline), and `src/composite/ui.js` (workspace UI). It does not cover the Editor's internal layer stack or the 3D/Stitch engines.

## 3. Verification State
- **Verified from Source:**
  - `src/composite/document.js` (full document model, layer normalization, ID generation, bounds computation, summarize function)
  - `src/composite/engine.js` (rendering loop, layer asset management, canvas drawing, export pipeline)
  - `src/composite/ui.js` (workspace layout, sidebar tabs, stage interaction, layer list management)
  - `src/settings/defaults.js` → `composite` settings block (preferences, diagnostics)
  - `src/settings/apply.js` → `applyCompositeSettingsToDocument`, `createSettingsDrivenCompositeDocument`
- **Inferred Behavior:** Worker-based offscreen rendering path (the worker threshold and fallback logic exist in settings but the dedicated composite worker file was not read in this pass).

## 4. Cross-System Dependencies
- **Editor Bridge:** Composite layers can embed Editor project outputs. When a layer references an Editor project from the Library, the Composite engine loads that project, renders it to a flat image, and composites it as a layer. This creates a linked dependency: changes to the Editor project can be reflected in the Composite document.
- **Library Storage:** Composite documents are saved to the Library as `composite-document` kind payloads.
- **Settings Integration:** Composite behavior is configured via `settings.composite.preferences` (showChecker, zoomLocked, exportBackend) and `settings.composite.diagnostics` (GPU capability probing: maxTextureSize, maxRenderbufferSize, webgl availability, worker thresholds).
- **Project Adapters:** The Composite adapter is registered in `src/io/projectAdapters.js` for routing payloads with `kind: 'composite-document'` or `mode: 'composite'`.

## 5. State Behavior
- **Saved (Durable):**
  - `document.layers[]` — Each layer records: `id`, `name`, `kind` (image/editor-project), `visible`, `locked`, `opacity`, `position` (x, y), `scale`, `rotation`, `z` (stacking order), and `asset` (the image data URL or project reference).
  - `document.view` — Zoom, pan, showChecker, zoomLocked.
  - `document.workspace` — Active sidebar tab, panel open/collapsed state.
  - `document.canvas` — Background color, width, height.
  - `document.selection` — Currently selected layer ID.
- **Runtime-only:**
  - Decoded `Image`/`ImageBitmap` objects cached by the engine's asset map.
  - Viewport scale, pan offsets, canvas element references.
  - Drag state for layer repositioning on the stage.
- **Derived/Cached:**
  - Composite bounds computed from all visible layer positions and sizes.
  - Preview image generated on save for Library thumbnails.

---

## 6. Current Behavior

### 6.1 Document Model (`src/composite/document.js`)
**[VERIFIED]** The document schema follows the standard `mns/v2` envelope:
```
{
  version: 'mns/v2',
  kind: 'composite-document',
  mode: 'composite',
  workspace: { ... },
  canvas: { width, height, backgroundColor },
  layers: [ ... ],
  selection: { layerId },
  view: { zoom, panX, panY, showChecker, zoomLocked }
}
```

Each layer is normalized through a `normalizeLayer()` function that enforces types and ranges for all properties. The `id` field uses `composite-` prefixed UUIDs.

### 6.2 Rendering Engine (`src/composite/engine.js`)
**[VERIFIED]** The engine is a class (`CompositeEngine`) that:
1. Attaches to a `<canvas>` element in the workspace DOM.
2. Maintains a `Map` of loaded image assets, keyed by layer ID.
3. On each render pass:
   - Clears the canvas and draws the background color.
   - Iterates over visible layers sorted by z-index.
   - For each layer, applies position/scale/rotation transforms via the 2D Canvas API.
   - Draws the cached image with the layer's opacity.
4. Supports an export path that renders to a fresh offscreen canvas at full resolution without viewport transforms.

The engine uses `OffscreenCanvas` when available, falling back to standard `<canvas>`.

### 6.3 Layer Management
**[VERIFIED]** Layers support:
- **Reordering:** Z-index based, with move-up/move-down operations.
- **Visibility toggle:** `visible` boolean per layer.
- **Lock toggle:** `locked` boolean prevents transform changes.
- **Opacity:** Per-layer opacity from 0 to 1.
- **Transform:** Position (x, y), scale, rotation.
- **Asset types:** Raw image (data URL embedded), or Editor project reference (linked from Library).

### 6.4 Workspace UI (`src/composite/ui.js`)
**[VERIFIED]** The Composite workspace uses the "Neumorphic Shell" design language (see `27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md`). The UI includes:
- **Stage area:** The main canvas viewport with zoom/pan controls.
- **Sidebar tabs:** Layer list, canvas settings, export controls.
- **Layer cards:** Each shows a thumbnail, name, visibility/lock toggles, and opacity slider.
- **Stage interaction:** Click-to-select, drag-to-move on the canvas stage. 

### 6.5 Export
**[VERIFIED]** Export produces a PNG blob rendered at the canvas's defined width/height. The `exportBackend` setting controls whether rendering happens on the main thread (`'main-thread'`), a background worker (`'worker'`), or automatically selected (`'auto'`). Auto mode uses worker rendering when the image exceeds the `autoWorkerThresholdMegapixels` or `autoWorkerThresholdEdge` limits defined in `settings.composite.diagnostics`.

### 6.6 Settings Application
**[VERIFIED]** `applyCompositeSettingsToDocument()` in `src/settings/apply.js` merges `settings.composite.preferences` (showChecker, zoomLocked) into a composite document. `createSettingsDrivenCompositeDocument()` creates a new empty document pre-configured from current settings.

---

## 7. Open Questions & Verification Gaps
- The Composite worker file (if it exists as a separate `worker.js`) was not read. The worker-based export path's implementation details need deeper verification.
- The exact mechanism for loading Editor project references as layers (lazy vs. eager, caching strategy) needs verification against `src/composite/engine.js`'s full asset resolution logic.
- Whether Composite supports importing non-Editor project types (e.g., 3D renders, Stitch outputs) as layers.
