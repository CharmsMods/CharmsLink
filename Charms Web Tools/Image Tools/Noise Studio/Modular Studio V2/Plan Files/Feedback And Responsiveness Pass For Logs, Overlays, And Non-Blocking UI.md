# Feedback And Responsiveness Pass For Logs, Overlays, And Non-Blocking UI

## Summary
Add a first-pass user-feedback layer across the app so long-running work feels active instead of frozen. This pass keeps the current architecture, extends the logging system to emit completion events, adds missing non-blocking loading overlays where the UI currently goes quiet, and adds small scheduling/yield improvements so overlays and log updates can paint before heavier work runs.

## Key Changes
- Logging core: extend the shared log engine to publish discrete write/completion events in addition to snapshots. Each event should include previous process status/progress, new entry data, and a derived `completed` flag when a process transitions from active/progress into `success` or `error`.
- Logs page feedback: when the Logs section is active and a `completed` success/error event arrives, animate a radial page wash from the matching process card’s center. Success uses a green page wash plus a light-gold card highlight; error uses a red page wash plus a soft red card highlight. Both effects fade automatically and do not block interaction.
- Logs tab feedback: when the active section is not `logs`, subscribe to the same completion events and apply a temporary green or red pulse to the Logs tab button, then fade it back to normal. Keep this pulse state outside normal rerender churn so it survives shell rerenders.
- Editor overlays and logs: add a reusable non-blocking overlay over the editor preview area for `openImageFile`, `openStateFile`, `saveState`, `exportCurrent`, `loadFolder`, and editor-initiated `saveProjectToLibrary`. Add missing phase logs around file read, embedded image restore, preview capture, auto-save, and batch-folder scan progress so the Logs tab reflects what the user is waiting on.
- Stitch overlays and logs: add a stage overlay for Stitch image import, analysis, export, and Stitch save-to-library. Drive analysis progress from the existing `onProgress` callback and `analysis.status/warning`, so both top-toolbar and in-panel triggers show consistent feedback. Add more explicit logs for import start/count, preview generation, candidate finalization, and export/save completion or failure.
- 3D overlays and logs: keep the current path-trace/render overlay, but add the same style of non-blocking overlay for model import, image-plane import, font import, HDRI import, and 3D save-to-library. Add finer-grained logs for file decode, scene-item creation, asset backfill/sync, and post-import completion so the Logs tab reflects real progress instead of only start/end.
- Library overlay gaps: keep the existing Library overlay system and reuse it for project loads initiated from the Library. Show a visible “loading project into Editor/Stitch/3D” phase before the section switch completes, and make sure that load path emits start and terminal logs consistently.
- Responsiveness pass: add a small `nextPaint`/UI-yield helper and use it before heavy async work starts, plus periodic cooperative yields inside longer sequential loops such as Stitch input creation, 3D file imports, Library import/export loops, preview backfills, and similar multi-item passes. The goal is not a refactor to workers yet, only to let the shell paint overlays/progress and stay responsive.

## Interface Changes
- Add a write-event subscription API to the logging engine, alongside the existing snapshot subscription.
- Keep existing log snapshot/export behavior intact so current Logs cards, downloads, and process history still work.
- Introduce a shared overlay contract for workspace UIs: title, message, optional progress, non-blocking by default, and explicit clear on success/error/abort.

## Test Plan
- Logs active: trigger a successful long-running action and a failing long-running action; verify the radial wash starts from the correct process card, success flashes green plus gold card highlight, and failure flashes red plus red card highlight.
- Logs inactive: complete one success and one error from Editor, Stitch, Library, and 3D; verify the Logs tab pulses the correct tone once and returns to normal.
- Editor: load image, load state with embedded image, load state without embedded image, save state, export PNG, and scan a batch folder; verify the overlay appears quickly, logs advance through phases, and the overlay clears on both success and failure.
- Stitch: add images, run analysis with visible progress, export PNG, and save to Library; verify overlay text tracks analysis phases, the gallery/result state still opens correctly, and completion flashes trigger only once.
- Library: initial load still uses the existing overlay, import/export still behave the same, and loading a Library project into each engine shows visible progress instead of a silent pause.
- 3D: import models, image planes, fonts, HDRI, save to Library, and run a path-trace render; verify the new generic overlay coexists cleanly with the existing render/path-trace overlay and that background render behavior remains unchanged.
- Stress/regression: switch sections during long tasks, open Logs mid-process, clear process cards after completion, and repeat the same operation twice; verify no stuck overlays, no stuck tab pulse, and no duplicate completion flashes from deduped log lines.

## Assumptions
- Overlays are non-blocking by default with `pointer-events:none`; only the existing intentional 3D render lock behavior remains blocking.
- Success/error flash effects fire only for processes that were actually in-flight first, not for standalone success notices like simple navigation or immediate one-shot actions.
- Error card highlight uses a soft red tint even though only the success card tint was explicitly specified.
- This pass does not introduce new Web Worker or WASM processing; it only adds cooperative yielding and feedback improvements ahead of the later performance pass.
