# Modular Studio App-Controller Regression Checklist

Use this checklist after the `src/main.js` to `src/app/` runtime split.

## Boot And Routing

- Load `index.html` with no query params and confirm the app opens in `Editor`.
- Load `index.html?section=library` and confirm the `Library` section opens without breaking first paint.
- Load `index.html?section=composite` and confirm the `Composite` section opens.
- Load `index.html?section=stitch` and confirm the `Stitch` section opens.
- Load `index.html?section=3d` and confirm the `3D` section opens.
- Load `index.html?section=logs` and confirm the `Logs` section opens.
- Load `index.html?section=settings` and confirm the `Settings` section opens.
- Confirm the Logs tab still receives startup/navigation cards.

## Editor

- Start with the default Base canvas and confirm Editor renders without a source image.
- Load a normal image and confirm preview render, scopes, compare, and export still work.
- Load a DNG file and confirm probe, decode, live DNG control changes, and render-status overlays still work.
- Save Editor JSON locally, reopen it, and confirm the document restores correctly.
- Save an Editor project to the Library, reload it from the Library, and confirm preview plus source state survive.
- Confirm Editor Library saves still emit Logs entries and still update the derived Editor asset path.

## Composite

- Start a new Composite project and add saved Editor projects and local images.
- Replace a selected Composite layer and confirm the layer updates without losing selection behavior.
- Open a linked Composite layer in Editor and confirm the bridge flow still returns changes to Composite.
- Leave Composite with unsaved autosave work and confirm autosave flush still happens on section switch.
- Export Composite PNG and confirm the worker/main-thread selection still behaves normally.
- Save Composite to the Library and confirm the saved thumbnail still falls back correctly when preview capture is limited.

## Stitch And 3D

- Import Stitch inputs, run analysis, inspect candidates, export PNG, and save/load through the Library.
- Confirm Stitch save/load still preserves the correct document while stripping runtime-only preview state.
- Start a new 3D scene, import model/image assets, and confirm scene controls still work.
- Save a 3D scene to the Library, reload it, and confirm scene restore plus asset backfill still complete.
- Capture 3D preview/render output and confirm the save path still works.

## Settings And Library

- Change theme and personalization settings and confirm the shared non-3D shell still updates live.
- Change Library, Editor, Composite, Stitch, 3D, and Logs settings and confirm persistence survives reload.
- Run each Library maintenance action and confirm notices plus Logs cards still appear.
- Confirm Asset Library image previews and Editor-derived asset backfills still run.
- Confirm no IndexedDB schema, project payload, attachment payload, or adapter type changed during the refactor.
