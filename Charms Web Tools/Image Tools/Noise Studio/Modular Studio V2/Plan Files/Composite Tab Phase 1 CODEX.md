# Composite Tab Phase 1

**Summary**
- Add a new top-level `Composite` section keyed by `state.ui.activeSection = 'composite'` and place it immediately to the right of `Editor` in the section switcher.
- Implement Composite as a first-class project type with its own document store `state.compositeDocument`, Library/local save-load flows, PNG export, logging, and workspace lifecycle. Wire it through the [main app module](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/main.js), [workspace shell](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/ui/workspaces.js), [Library panel](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/ui/libraryPanel.js), and a new [composite module folder](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/composite).
- Keep `Editor` as a separate top-level tab in phase 1, but treat it as the linked editing surface for editor-backed composite layers. Phase 1 includes an explicit `Update Original Editor Project` action. Masking, perspective/mesh warp, and Blend If stay in phase 2.

**Implementation Changes**
- Add a new persisted document type:
```ts
type CompositeDocument = {
  version: 'mns/v2';
  kind: 'composite-document';
  mode: 'composite';
  workspace: { sidebarView: 'layers' | 'transform' | 'blend' };
  layers: CompositeLayer[];
  selection: { layerId: string | null };
  view: { zoom: number; panX: number; panY: number; zoomLocked: boolean; showChecker: boolean };
  export: { background: 'transparent' | '#rrggbb' };
  preview: { imageData: string; width: number; height: number; updatedAt: number } | null;
};
type CompositeLayer = {
  id: string;
  kind: 'editor-project' | 'image';
  name: string;
  visible: boolean;
  locked: boolean;
  z: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  blendMode: 'normal' | 'multiply' | 'screen' | 'add' | 'overlay' | 'soft-light' | 'hard-light' | 'hue' | 'color';
  source: { originalLibraryId: string | null; originalLibraryName: string | null; originalProjectType: 'studio' | null };
  embeddedEditorDocument?: StudioDocument;
  imageAsset?: { name: string; type: string; imageData: string; width: number; height: number };
};
```
- Add runtime-only bridge state in `state.ui`, e.g. `compositeEditorBridge = { active, layerId, originalLibraryId, originalLibraryName }`. This is the source of truth for Editor round-trip sync and is not persisted.
- Build a new WebGL compositor engine that renders textured quads in layer order, supports selection by topmost visible pixel alpha, applies translate/scale/rotate/opacity/blend mode, frames the viewport to visible bounds, and exports the visible bounds as PNG.
- Give Composite its own hidden `NoiseStudioEngine` render service for editor-backed layers. Use it to load embedded Editor payloads, rerender them off-DOM, and refresh Composite textures. Do not reuse the live Editor engine instance.
- Build a new Composite workspace factory that follows the current repo pattern: the new feature owns its own UI module, and the shell only mounts/activates/deactivates it. Reuse Editor styling by moving the private control-row helpers into a shared UI helper module instead of duplicating them.
- Composite UI layout:
  - toolbar: `New Project`, `Add Editor Project`, `Add Images`, `Export PNG`, `Load`, `Save`, `Save to Library`
  - sidebar tabs: `Layers`, `Transform`, `Blend`
  - `Layers`: draggable stack with select, visibility, lock, remove, reorder
  - `Transform`: X, Y, Scale, Rotation, Opacity
  - `Blend`: grouped blend-mode selector plus fit/frame actions
- Add source ingest flows:
  - `Add Editor Project`: open a Composite-local picker modal listing Library `studio` entries only, allow multi-select, deep-clone each chosen payload, keep its original Library id/name in `layer.source`, use embedded `preview` for instant thumbnails, then queue hidden rerenders to refresh runtime textures.
  - `Add Images`: local raster file picker only in phase 1; embed data URLs directly into the Composite document.
- Add section/store/action wiring for `composite`: URL sync, initial section resolution, project replacement prompts, progress overlay routing, new-project action, local JSON load/save, and nav order `Editor, Composite, Library, Stitch, 3D, Settings, Logs`.
- Add a Composite adapter and payload inference so Library save/load/import/export can detect `kind === 'composite-document'` or `mode === 'composite'`, capture a flattened PNG blob plus embedded preview, and summarize metadata as `Canvas Size` + `Layer Count`.
- Implement Editor round-trip in `actions.setActiveSection`:
  - leaving `Composite` for `Editor` with an editor-backed selected layer loads that embedded payload into `state.document`, clears `activeLibraryOrigins.studio`, sets `ui.compositeEditorBridge`, and switches to `editor`
  - returning from `Editor` to `Composite` with an active bridge captures the latest Editor payload + preview and patches only the linked composite layer
  - selecting a non-editor layer does not cause Editor to load it
  - show `Update Original Editor Project` only when the bridge has an original Library id; this action confirms, overwrites that original Editor Library entry, refreshes its preview/blob, and leaves ordinary Editor `Save To Library` isolated so it still saves independently unless the explicit write-back action is used
- Implement Composite persistence rules:
  - Composite JSON and Library saves are fully self-contained; every editor-backed layer stores the full embedded Editor document payload, including source image and preview
  - auto-save starts only after the project already has a Composite Library origin, either from loading an existing Composite project or after the first manual `Save to Library`
  - debounce overwrite at `2500ms`, flush on explicit save and section switch away from Composite, and never auto-create a first Library entry
  - inserting the same Editor Library project multiple times creates independent embedded copies with unique layer ids
- Update the Library UI so Composite is a first-class type in labels, empty-state copy, source/count labels, load-target copy, preview/detail rendering, and import/export inference. Composite detail cards should show flattened preview, layer count, editor-linked layer count, and per-layer summaries.
- Add Composite log streams: `composite.workspace`, `composite.layers`, `composite.render`, `composite.link`, `composite.export`, and `composite.autosave`.

**Test Plan**
- Navigation and shell: `Composite` appears immediately to the right of `Editor`, `?section=composite` opens it, and Composite activation/deactivation/progress overlays behave like other sections.
- Core compositing: add multiple Editor projects and local images, reorder them, toggle visibility/lock, select by clicking visible pixels, and verify transform/blend/opacity updates render correctly and export the visible bounds.
- Editor linkage: select an editor-backed layer, switch to `Editor`, edit it, return to `Composite`, and verify only that linked layer updates. Repeat with two copies of the same original Editor project and confirm they stay independent inside Composite.
- Original-project write-back: use `Update Original Editor Project`, confirm overwrite, verify the original Library entry updates, and confirm ordinary Editor `Save To Library` still does not overwrite it automatically.
- Persistence: first manual `Save To Library` creates a Composite project; later edits auto-save after idle; brand-new unsaved Composite projects do not auto-create themselves. Reload saved Composite JSON and Library entries in a fresh session and verify no original Editor project is required.
- Library and logs: Composite projects display correct labels/details in Library, load into Composite instead of Editor, and emit Composite-specific logs for ingest, rerender, export, autosave, and editor handoff.
- Failure cases: missing original Editor project during write-back, invalid Composite JSON import, failed hidden rerender, empty export, and switching to `Editor` with a non-editor layer selected all fail with notices/logs and do not corrupt either document store.

**Assumptions**
- The visible tab label is `Composite`, the persisted project type is `composite`, and `Editor` remains a separate top-level tab in phase 1.
- Phase 1 source types are only Library `Editor` projects and local raster image files. Library asset ingestion, masking/matting, perspective distort, mesh warp, and Blend If are phase 2.
- Composite uses an auto-bounds canvas model in v1: there is no fixed stored canvas size, export size is the visible layer bounds, and the default PNG background is transparent.
- Phase 1 does not add a dedicated `Settings > Composite` category and does not auto-create Assets Library entries from Composite renders.
