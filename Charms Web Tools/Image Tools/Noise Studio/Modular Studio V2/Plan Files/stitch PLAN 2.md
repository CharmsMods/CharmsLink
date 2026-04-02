# Stitch Reliability And UX Hardening

## Summary
Tighten the Stitch tab around analysis state, worker recovery, stale-result invalidation, and import/remove workflows, then add a bounded usability pass for clearer status and stage navigation. Keep the existing screenshot/photo backends and candidate-generation logic; this plan improves orchestration and UX around them rather than rewriting the solver.

## Key Changes
- Harden analysis lifecycle in `src/main.js` and `src/stitch/engine.js`.
- Reject and clear all in-flight Stitch requests on worker `error`/`messageerror`, reset the affected worker instance, and allow the next run to recreate it cleanly.
- Add a dedicated ephemeral analysis progress field instead of reusing `analysis.warning` for live progress text.
- Guard `runStitchAnalysis()` against re-entry so only one run can be active at a time; disable the run controls while active.
- Invalidate analysis immediately on analysis-affecting changes.
- On settings changes and input add/remove, increment the Stitch analysis token before any async work, clear `candidates`, `activeCandidateId`, previews, and diagnostics, close the gallery, and leave the document in a clean “needs rerun” state.
- Keep candidate/gallery actions disabled whenever there are no fresh results.
- Make file ingest and destructive actions safer.
- Change image import to best-effort: process each selected file independently, keep valid images, skip failures, and show a summary notice with success/failure counts.
- Add confirmation before removing an input.
- Disable `Up`/`Down` buttons when an input is already at the boundary instead of showing no-op actions.
- Add bounded Stitch UX polish.
- Show neutral running/progress UI in the analysis card and toolbar instead of warning styling.
- Wire real Stitch canvas navigation: wheel zoom centered on cursor, middle-mouse or `Space`+drag panning, and keep `Fit View` as the reset to default framing.
- Prevent accidental stage edits while analysis is running so a fresh solve cannot unexpectedly overwrite a user action mid-run.

## Interfaces / State
- Extend `stitchDocument.analysis` with an ephemeral `progressMessage` field.
- Treat `progressMessage` like previews: runtime-only, reset on serialization/load/export.
- Do not change saved candidate payload shape or backend output schema.

## Test Plan
- Worker boot failure and post-boot worker crash both move Stitch from `running` to `error`, clear pending request state, and allow a later rerun.
- Rapid repeated clicks on Run Analysis only produce one active analysis job.
- Changing any Stitch setting while results exist clears stale candidates and disables gallery/actions until rerun.
- Adding multiple images with one invalid/corrupt file still imports the valid files and shows a partial-success notice.
- Removing an image asks for confirmation and then clears candidate state correctly.
- Boundary reorder buttons are disabled at top/bottom.
- Zoom, pan, and Fit View work on the Stitch canvas without breaking normal image selection/drag behavior.

## Assumptions
- “Do as much as you can” is interpreted as broad cleanup inside the Stitch tab, but not a rewrite of the matching/warp algorithms.
- Navigation polish is limited to desktop pointer interactions in this pass; touch gestures stay out of scope.
- Existing screenshot/photo backend selection and candidate ranking stay intact unless a reliability fix requires a small local adjustment.
