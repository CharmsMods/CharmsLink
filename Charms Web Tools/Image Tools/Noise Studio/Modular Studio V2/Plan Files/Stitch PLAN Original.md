# Add `Stitch` as a Third Engine with Shared Library Support

## Summary

- Add a new top-level section button, `Stitch`, beside `Editor` and `Library`.
- Keep the current Studio editor and the new Stitch engine as separate in-memory drafts, so switching tabs does not trigger save/discard prompts and the user can work in both at once.
- Build Stitch as its own organized subsystem under a new `src/stitch/` area, with its own document model, analysis engine, renderer, and UI.
- Keep Stitch projects in the same Library as Studio projects, using the same IndexedDB store and Library UI, but with engine-aware save/load/preview dispatch.
- Plan v1 as overlap-first stitching with pure JS/Canvas on the CPU, candidate gallery first, then a Stitch editor with an alternatives list and basic manual correction tools.

## Key Changes

### App shell and state model

- Extend `ui.activeSection` from `editor | library` to `editor | library | stitch`.
- Keep the existing `state.document` branch as the Studio document.
- Add a separate `state.stitchDocument` branch for the Stitch engine so Studio and Stitch drafts can coexist.
- Update the main section shell in `src/ui/workspaces.js` to render:
  - the current Studio workspace when `activeSection === 'editor'`
  - the integrated Library when `activeSection === 'library'`
  - a new Stitch workspace when `activeSection === 'stitch'`
- Do not treat Editor↔Stitch tab switches as project replacement events. Replacement prompts should happen only inside the same engine when loading/replacing that engine’s current draft.

### Stitch engine architecture

- Create a new `src/stitch/` subsystem with four responsibilities:
  - document/state helpers
  - analysis/candidate generation
  - composite rendering/export
  - Stitch-specific UI helpers
- Use a pure JS/Canvas analysis pipeline for v1:
  - downscale inputs for analysis
  - grayscale/edge preprocessing
  - feature/corner extraction with simple patch descriptors
  - pairwise matching with ratio filtering
  - RANSAC fit of a similarity transform only: translation, rotation, uniform scale
  - candidate generation from the strongest transform graph
- Run analysis in a Web Worker when available, with same-thread fallback.
- Keep v1 out of scope for perspective warp, mesh warp, or arbitrary nonuniform stretch.
- Use a resolution-free editing surface in Stitch:
  - world-space placements while editing
  - fit-to-view camera for preview
  - export/save rasterization based on the visible stitched bounding box

### Stitch UX and workflow

- Stitch toolbar/workspace should support:
  - new stitch project
  - add/remove images
  - run or rerun analysis
  - candidate gallery
  - save to Library
  - export stitched PNG
- Candidate flow:
  - after analysis, show a compare gallery of generated layouts
  - entering the editor opens the chosen candidate
  - keep an alternatives list/strip in the editor so the user can switch candidates without rerunning
- Basic manual correction in v1:
  - select image on canvas
  - drag position
  - adjust rotation
  - adjust uniform scale
  - lock/unlock
  - show/hide
  - change stacking order
  - reset selected image to candidate transform
  - reset whole candidate to original auto result
- If analysis cannot build a stable candidate set, fall back to a manual arrangement starting layout and surface a warning rather than failing silently.

### Shared Library integration

- Introduce a small engine-adapter layer so Library persistence is not hard-coded to the Studio engine.
- Each engine adapter should provide:
  - serialize project payload
  - validate/import payload
  - render preview blob for Library storage
  - restore payload into the correct engine draft
  - provide Library hover-source metadata
  - provide source/render metrics and suggested naming
- Keep the same IndexedDB store and Library bundle formats, but make records engine-aware.
- Stitch Library behavior:
  - save into the same Library grid as Studio projects
  - loading from Library auto-switches to the `Stitch` section
  - single-project JSON export/import works for Stitch too
  - Library bundle export/import preserves Stitch projects alongside Studio ones
- For Library `Compare Source` on Stitch projects:
  - use the first uploaded source image as the hover source
- For Library source-size sorting on Stitch projects:
  - store primary source width/height from the first image for hover/display compatibility
  - also store an aggregate source-area override based on total input pixel area so size sorting remains meaningful for multi-image projects
- Add a lightweight engine/type marker on Library records so the Library can route loads correctly and optionally display the project type later.

## Public Interfaces and Saved Payloads

- Add a new saved payload kind for Stitch, for example:
  - `version: 'mns/v2'`
  - `kind: 'stitch-document'`
  - `mode: 'stitch'`
- Stitch payload should include:
  - `workspace`
  - `inputs[]` with embedded image data and metadata
  - `settings` for analysis behavior
  - `candidates[]` with scored placements and bounds
  - `activeCandidateId`
  - current edited placements/state
  - `view`
  - `export`
- Keep Studio payloads unchanged.
- Extend generic Library record/export metadata so multi-engine projects can preserve:
  - project type
  - hover-source image metadata
  - aggregate source-area override
  - source count
- Update Library import/save dispatch so `processLibraryPayloads(...)` and Library load are adapter-based rather than Studio-engine-only.

## Test Plan

- Section switching:
  - switching Editor↔Stitch never prompts to save/discard
  - Studio draft remains intact after working in Stitch
  - Stitch draft remains intact after returning from Editor or Library
- Stitch analysis:
  - 2-image overlap case produces at least one valid candidate
  - 3+ image overlap case produces a ranked candidate gallery
  - failed/weak matches fall back to manual arrangement with warning
- Stitch editor:
  - choose candidate from gallery and reopen alternatives list in editor
  - manual move/rotate/scale/lock/visibility/order changes persist in the draft
  - reset selected image and reset candidate both work
- Library:
  - saving a Stitch project creates a normal Library card with preview blob
  - Library hover compare uses the first Stitch input image
  - loading a Stitch project from Library restores it into Stitch and switches tabs automatically
  - plain Library JSON export/import preserves Stitch projects
  - secure Library export/import preserves Stitch projects
- Regression:
  - existing Studio save/load/export behavior still works
  - existing Studio Library cards still render and load correctly
  - existing Library sort/filter/tag flows still work with mixed Studio/Stitch projects

## Assumptions and Defaults

- Separate in-memory drafts are required for Studio and Stitch.
- Stitch v1 is overlap-first, not collage-first.
- Stitch v1 uses pure JS/Canvas and CPU-side analysis, not OpenCV/WASM and not WebGL-first solving.
- Candidate UX is gallery first, then editor with an alternatives list.
- Manual correction in v1 is basic transform editing only.
- Library `Compare Source` for Stitch uses the first uploaded image.
- V1 transform solving is similarity-only; perspective warp and mesh warp are deferred.
