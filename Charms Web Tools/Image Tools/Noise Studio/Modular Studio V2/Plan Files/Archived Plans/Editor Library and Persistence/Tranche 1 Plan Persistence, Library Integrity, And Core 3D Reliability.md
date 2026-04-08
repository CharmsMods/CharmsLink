# Tranche 1 Plan: Persistence, Library Integrity, And Core 3D Reliability

## Summary
The first tranche should focus on bugs that can lose work, silently fail, or make the app feel untrustworthy. That means Electron save/load parity, Library import/export correctness, and the 3D-to-Library pipeline come before new rendering features, deeper worker/GPU work, or UI redesign. Small UX fixes are included only when they directly improve trust and diagnosability.

Every landed subphase in this tranche should update `ai_context.txt` with the new persistence rules, Electron/browser differences, and any changed logging behavior.

## Key Changes
### 1. Electron file I/O foundation
- Add a preload + IPC desktop bridge in the Electron shell so the app can explicitly open/save files instead of relying on browser download behavior inside `loadFile`.
- Standardize all local-save flows behind one shared save/export service used by:
  - Editor PNG export
  - Editor JSON/state save
  - Stitch PNG export
  - Library JSON export
  - 3D render PNG export
  - 3D scene JSON export
- Return a single result shape from save operations: `saved`, `cancelled`, or `failed`, with path/source metadata for logging.
- Treat cancelled save dialogs as non-errors and make success/failure visible in both notices and logs.

### 2. Save/load and Library integrity fixes
- Fix Electron cases where renders, Editor JSON/state files, and Library exports appear to save but do not reliably land on disk.
- Fix the current Library export overflow path by removing pretty-printed export JSON for large bundles and generating compact payloads for disk export.
- Fix the 3D “Save to Library” no-op so it always produces a visible overlay/log path and either creates/updates a Library project or emits a clear error.
- Add explicit local JSON download support for 3D scenes so 3D matches the other workspaces’ persistence options.
- Fix the Electron Library load/import refresh bug so imported entries are written, refreshed, and shown immediately, with useful terminal logs when dedupe or validation prevents visible additions.

### 3. 3D scene and viewport correctness
- Fix post-load asset backfill so loading a 3D scene from the Library scans scene items and registers missing assets in the Assets Library.
- Fix rotation snapping and grid snapping in the 3D viewport so the toggles actually control behavior.
- Auto-clear sticky render-status text like `Render Aborted` after the normal notice timeout.
- Add render duration logging for successful and failed/aborted 3D renders.

### 4. Trust-building UI cleanup tied to these flows
- Remove the extra transient third status bar and move that message surface into the universal header to the right of the Logs button.
- When the Logs button pulses red/green while hidden, also show the most recent completion/error message in that header slot.
- Make the startup/Library loading overlay describe real stages instead of vague generic text.
- Change the Library sort/tag expansion panel to overlay on top of the UI instead of pushing layout sideways.

## Interfaces And Boundaries
- New Electron-only interface: a preload-exposed desktop bridge for file dialogs, file writes, and capability checks. Browser builds keep existing browser-native paths.
- New shared save/export contract: every export path must go through the same service and emit the same structured result and log lifecycle.
- New header status surface: a single inline message area next to Logs replaces the current third bar.
- Explicitly not part of this tranche:
  - ray tracing mode
  - multi-camera rendering
  - viewport-PNG rendering feature work beyond fixing existing save/export paths
  - deeper 3D render worker/GPU refactors
  - right-click-first UI redesign
  - settings tab migration
  - startup boot-selector flow
  - CPU core detection work
  - offline/CDN vendoring
  - volumetrics/fog
  - codebase reorganization

## Test Plan
- Browser and Electron matrix for all save/export paths listed above.
- Library export/import tests for Library-only, Assets-only, and combined bundles, including very large payloads.
- Load a 3D Library project with embedded assets and confirm missing assets appear in the Assets Library after restore.
- Save a 3D scene to the Library and verify visible success/error messaging, Logs entries, and immediate appearance in the Library list.
- Verify snap toggles in the 3D viewport affect actual transform behavior.
- Verify render completion logs include elapsed time and aborted-render messaging clears automatically.
- Verify the third bar is gone, header messaging appears beside Logs, and the Logs-button pulse still works when Logs is hidden.

## Assumptions And Defaults
- Electron persistence parity is a higher priority than new rendering features.
- No major database/schema migration is included in this tranche; this is a correctness and integration pass on top of the current data model.
- The current worker plan remains in place; this tranche should not expand into render-worker or WASM work unless required to fix a blocker listed above.
- Context-menu exploration is deferred until after the Electron desktop bridge is stable, because broader right-click UI changes would otherwise couple to unresolved platform behavior.
