# Tranche 2: Dialog Reliability, Dual-Save Persistence, Library Import Closure, And Logs Compaction

## Summary
Keep the next tranche reliability-first. The highest-value remaining cluster is Electron-safe dialogs, the remaining Library import/load trust gaps, the 3D right-click/context-menu reliability issue, and the new dual-save behavior you chose: successful local render/state saves should also update Library data. This tranche should not include ray tracing, settings-tab work, render-worker refactors, or the heavier 3D freeze investigation yet.

## Key Changes
### 1. Replace native `prompt` / `confirm` flows with an in-app dialog service
- Add one shared app-level modal/prompt/confirm service mounted in the main shell, not per-panel one-offs.
- Replace the remaining native dialog calls used by:
  - 3D camera preset naming
  - 3D item rename from the context menu
  - Library save naming / overwrite flows in the main app
  - unsaved-project save/discard confirmation flows
- Make these dialogs work the same in browser and Electron, with explicit `confirm`, `cancel`, and validation-error states.
- Treat this as the likely fix for “camera preset save doesn’t work in Electron,” because the actual preset persistence code already exists and the current weak point is the native prompt path.

### 2. Harden 3D right-click/custom context menus for Electron
- Keep the existing custom context-menu system; do not switch to native Electron menus in this tranche.
- Audit the current `contextmenu` event path in the 3D canvas and hierarchy, then make it reliable in Electron builds.
- Add a keyboard fallback for the same actions, using `Shift+F10` on the current selection.
- Add one visible non-right-click fallback trigger for the selected item if needed, so the feature remains reachable even if the browser/Electron event path misbehaves.
- Do not move wider site settings into context menus yet; this tranche only stabilizes the current 3D context-menu behavior.

### 3. Implement dual-save behavior for successful local render/state saves
- Add an explicit two-phase save workflow: local save first, Library side-effect second.
- For 3D final render PNG saves:
  - after a successful local PNG save, create or update a Library asset record automatically
  - if the local save is cancelled, skip the Library write
  - if the local save succeeds but the Library write fails, surface a partial-success notice and log both outcomes
- For state/scene JSON saves:
  - after a successful local Editor state JSON save, create or update the matching Editor Library project automatically
  - after a successful local 3D scene JSON save, create or update the matching 3D Library project automatically
- Add a promptless Library-save path for these auto-saves:
  - reuse the active Library origin when present
  - otherwise reuse an exact matching entry when found
  - otherwise create a new entry with the current suggested project name
- Keep Stitch out of this auto-state-save scope for now, since there is not an equivalent local state JSON save flow already in place.

### 4. Close the remaining Library import/load trust gaps
- Turn Library import/load into a verified pipeline with explicit final counts:
  - saved
  - updated
  - skipped as duplicates
  - rejected as invalid
- After import, wait for DB writes, tag updates, derived asset work, and the visible panel refresh before reporting success.
- If an import appears to “do nothing,” tell the user exactly why:
  - everything was a duplicate
  - files were invalid
  - active filters hid the new items
- Re-test and tighten the 3D project restore path so scene-item asset backfill is treated as part of load completion, not background best-effort cleanup.

### 5. Compact repeated Logs-tab lines in the UI only
- Keep raw process history unchanged for TXT export.
- In the Logs tab display only, collapse consecutive identical entries when:
  - same process
  - same level/status
  - same message
  - no different entry appears in between
- Show the compacted line with:
  - first timestamp
  - last timestamp
  - repeat count
- Keep card-level totals based on raw history, so TXT export and process counts still match the underlying log stream.
- Do not compact non-consecutive repeats.

## Test Plan
- Electron and browser:
  - save camera preset
  - rename 3D item
  - unsaved-project save/discard dialog
  - Library save naming and overwrite flows
- Dual-save workflows:
  - successful Editor state JSON local save also updates/creates the Editor Library project
  - successful 3D scene JSON local save also updates/creates the 3D Library project
  - successful 3D render PNG local save also updates/creates a Library asset
  - cancelled local save does not perform the Library side-effect
  - partial-success path logs correctly when local save succeeds but Library write fails
- Library import/load:
  - import with all-new entries
  - import with all duplicates
  - mixed valid/invalid import
  - load a 3D Library project and verify assets appear in the Assets Library before success completes
- 3D context menu:
  - right-click in canvas
  - right-click in hierarchy
  - keyboard fallback on selected item
  - Electron packaged build specifically
- Logs compaction:
  - consecutive duplicate lines collapse
  - duplicate line interrupted by a different line does not collapse
  - TXT export remains raw and uncollapsed

## Assumptions And Defaults
- Chosen direction: `Reliability First`.
- Chosen dual-save policy: `Auto-save Renders + State`.
- Dual-save in this tranche means:
  - 3D final render PNG -> local save + Library asset
  - Editor state JSON -> local save + Editor Library project
  - 3D scene JSON -> local save + 3D Library project
- The 3D freeze/crash-on-return investigation is deferred to the following tranche unless a blocker appears during this work.
- [ai_context.txt](/E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/ai_context.txt) should be updated at the end of each landed phase.
- [plans current.md](/E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/Plan%20Files/plans%20current.md) should be updated once we leave Plan Mode and execute the tranche.
