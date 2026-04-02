# Stitch Tooltips And Warp-Capable Photo Stitching

## Summary

- Add Stitch-only help icons/tooltips for every current and new Stitch setting/control.
- Keep the current screenshot pipeline, but turn Stitch into an adaptive engine that can choose between screenshot-style alignment and more advanced photo alignment automatically.
- Add automatic warp support in v1, including mesh-capable photo stitching, ranked candidate outcomes, and confidence-based gallery ordering.

## Key Changes

### Stitch help/tooltips

- Add a reusable Stitch help-icon/popover pattern in the Stitch UI layer, then author tooltip content only for Stitch in this pass.
- Attach help icons to all visible Stitch settings:
  - current analysis settings
  - current manual selection controls
  - all new photo/warp/blend/candidate settings introduced below
- Use hover on desktop, focus for keyboard, and click/tap for touch; only one help popover can be open at a time, and it closes on outside click or `Escape`.
- Keep the help text detailed and practical: what the setting changes, when to raise/lower it, and what tradeoff it introduces.

### Stitch document, settings, and saved payloads

- Extend the Stitch document settings to support adaptive matching and warp-aware rendering:
  - `sceneMode: 'auto' | 'screenshot' | 'photo'`
  - `warpMode: 'auto' | 'off' | 'perspective' | 'mesh'`
  - `meshDensity: 'low' | 'medium' | 'high'`
  - `blendMode: 'auto' | 'alpha' | 'feather' | 'seam'`
  - keep `maxCandidates` as the main outcome-count control
- Keep the existing low-level numeric tuning controls, but move them under an `Advanced` subgroup instead of making them the only settings surface.
- Extend Stitch candidates and per-image placements so they can carry:
  - `rank`
  - `confidence`
  - `modelType`
  - optional warp data
- Keep `x/y/scale/rotation` as a manual rigid wrapper even for warped candidates, so auto-warped results can still be nudged without exposing a full mesh editor.
- Persist warp geometry and ranking metadata through normal Stitch save/load and Library save/load/export/import.
- Do not persist derived seam masks or preview blobs; regenerate them at runtime.

### Adaptive analysis, warping, and ranking

- Keep the existing screenshot matcher as the fast path for clean UI captures and simple axis-aligned overlap.
- Add a photo-oriented worker path that does:
  - multi-scale feature detection and distribution across the image
  - stronger descriptor matching than the current lightweight patch matcher
  - multiple geometric hypotheses per pair instead of only one winner
  - homography estimation for planar/distant scenes
  - automatic local mesh refinement for harder photo cases with parallax or mild lens/perspective mismatch
- Build multiple global stitch candidates from the pair graph, not just one path per image set.
- Rank candidates by a combined confidence score that includes:
  - inlier support
  - reprojection error
  - overlap coverage
  - graph consistency across all images
  - seam/blend cost
  - warp smoothness / distortion penalty
- Use `sceneMode: auto` as the default:
  - screenshot-like sets prefer the current fast screenshot branch
  - photo-like sets prefer homography/mesh candidates
- Keep the ranked gallery and alternatives strip:
  - auto-apply rank `#1` after analysis
  - keep lower-ranked outcomes visible and selectable
  - show confidence and model type on gallery cards

### Render, export, and UI workflow

- Expand the Stitch renderer/export path so it can draw three transform families:
  - rigid
  - projective/perspective
  - mesh
- Use triangle tessellation for warped rendering on the stage, candidate previews, and exported PNGs so preview/export behavior stays aligned.
- Add a seam/blend pass:
  - `auto` chooses simple alpha for screenshot results
  - `auto` chooses seam + feather for photo results
- Reorganize the Stitch analysis panel into grouped sections:
  - `Detection`
  - `Warp`
  - `Blend`
  - `Candidates`
  - `Advanced`
- Keep the current selection panel for visibility, locking, order, and rigid wrapper adjustments.
- Do not add a full manual mesh editor in v1; warping is automatic only.

## Test Plan

- Tooltips:
  - every Stitch setting with a label has a help icon
  - help works on hover, focus, and touch
  - outside click and `Escape` close the popover cleanly
  - mobile layout stays usable
- Screenshot regression:
  - current basic screenshot cases still stitch correctly
  - screenshot candidates still rank above photo-style warp candidates when the input is clearly screen content
- Photo stitching:
  - 2-photo planar perspective overlap
  - 2-photo parallax-heavy overlap
  - 3+ photo panoramic chain
  - low-texture / ambiguous overlap that should still produce multiple ranked candidates or a warning
- Ranking:
  - multiple plausible outcomes are sorted consistently by confidence
  - top candidate auto-applies
  - switching to lower-ranked candidates updates stage, preview, and export correctly
- Warp parity:
  - stage render, gallery preview, export PNG, and Library thumbnail agree for warped results
- Persistence:
  - new warp-capable Stitch projects round-trip through normal save/load and Library export/import
  - older rigid-only Stitch projects still load without migration errors

## Assumptions And Defaults

- Tooltip authoring scope is Stitch only in this pass.
- The engine should optimize for many situations, not just one niche, so `sceneMode: auto` is the default and must preserve screenshot performance while adding photo support.
- Mesh support is included in v1, but it is automatic only.
- Ranked gallery remains the primary multi-outcome UI, and the highest-confidence result is auto-selected.
- Derived seam/blend runtime data is regenerated instead of stored in project payloads.
