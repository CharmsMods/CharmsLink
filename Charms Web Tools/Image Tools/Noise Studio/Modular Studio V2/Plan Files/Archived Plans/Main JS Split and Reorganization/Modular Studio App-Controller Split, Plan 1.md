# Modular Studio App-Controller Split

## Summary
- Treat `src/main.js` as an app controller that needs decomposition, not cleanup-in-place. It currently owns boot, settings runtime, logging, worker brokering, IndexedDB storage, Library backfills, DNG/composite helper services, a 205-method action surface, project adapters, and the store-to-view render loop.
- Include `src/ui/workspaces.js` and `src/ui/libraryPanel.js` in the same plan, because they are the main shell-side consumers of that controller boundary and they already carry adjacent orchestration/utility debt.
- End state: `src/main.js` becomes a thin entrypoint, cross-domain orchestration moves into a new `src/app/` layer, shell files become thin wrappers over smaller modules, and current payloads/DB schema/routing/log ids remain unchanged.

## Implementation Changes
1. Create an app runtime layer under `src/app/`.
- Add `bootstrapStudioApp({ root })`, `createAppContext()`, `registerWorkerDomains(context)`, `createProjectAdapters(context)`, and `wireStoreRendering(context)`.
- Move the `DOMContentLoaded` boot sequence, capability detection, logger/settings runtime, registry load, engine init, and store subscription out of `src/main.js`.
- Keep `src/main.js` limited to locating `#app` and calling `bootstrapStudioApp`.

2. Extract cross-domain services out of the entrypoint.
- Move IndexedDB/tag/attachment helpers plus Library asset preview/backfill logic into `src/library/` service modules. Keep `DB_NAME`, `DB_VERSION`, store names, and saved record shapes exactly as they are.
- Move DNG decode/cache/sync helpers, Composite render-backend resolution, and Composite Editor bridge/autosave logic into dedicated service modules owned by `src/editor/`, `src/composite/`, or `src/app/services` based on reuse.
- Consolidate duplicated data-url/blob/hash helpers onto `src/utils/dataUrl.js`, and update `main.js`, `libraryPanel.js`, and nearby callers to use the shared helpers instead of local copies.

3. Replace the monolithic inline controller with composed action factories.
- Build `createAppActions(context)` from `createSettingsActions`, `createNavigationActions`, `createEditorActions`, `createLibraryActions`, `createCompositeActions`, `createStitchActions`, and `createThreeDActions`.
- Preserve all current UI-facing action names during the split. This refactor changes ownership, not the public action contract.
- Keep `createProjectAdapterRegistry(...)` as the registry mechanism, but move the four inline adapter definitions into separate adapter modules that receive `context`.

4. Split the shell boundary without breaking imports.
- Keep `src/ui/workspaces.js` and `src/ui/libraryPanel.js` as thin compatibility wrappers first, then move their real code into folder-backed modules.
- Split `workspaces` into shell composition, editor preview/input wiring, app dialogs/status surfaces, and section-tab rendering. Keep `createWorkspaceUI(root, registry, actions, { stitchEngine, logger })` stable through early phases.
- Split `libraryPanel` into project rendering, asset rendering, import/export and secure-transfer flows, modal state, and preview/file helpers.
- After the split, reduce each panel to the smallest action subset it actually needs instead of passing the full app action bag everywhere.

5. Stage the migration in low-risk passes.
- Pass 1: thin `src/main.js`, introduce `src/app/` boot/context modules, and extract worker registration plus store/render wiring.
- Pass 2: move storage/backfill, adapter definitions, DNG/composite service helpers, and shared utility duplication.
- Pass 3: replace the inline `actions` object with composed factories while keeping existing method names.
- Pass 4: split `workspaces` and `libraryPanel`, then remove compatibility cruft once imports and behavior are stable.

## Test Plan
- Boot and routing smoke: default load plus `?section=library`, `composite`, `stitch`, `3d`, `logs`, and `settings`.
- Editor regression: base-canvas startup, image load, DNG load/decode, DNG preview refresh, JSON save/load, Library save/load, compare/export, and Logs emission.
- Composite regression: add/replace layers, open-in-Editor bridge, autosave flush on section switch, PNG export, Library save/load, and thumbnail fallback behavior.
- Stitch and 3D regression: Stitch import/analyze/export/save-load; 3D asset import, scene save/load, preview/render capture, asset drawer refresh, and asset backfill on Library restore.
- Settings/Library regression: settings persistence, personalization theming, Library maintenance actions, asset preview warmup/backfill, and no IndexedDB or payload compatibility break.
- Add a written manual regression checklist for this refactor; do not introduce a new test framework in the same change.

## Assumptions
- Keep direct browser ES modules and current Electron packaging. No bundler, aliasing system, or TypeScript migration is part of this refactor.
- Treat this as a behavior-preserving reorganization with only small opportunistic fixes that remove duplication or protect existing flows.
- Keep section ids, worker domain ids, process/log ids, adapter types, and save/load payload schemas stable through the split.
