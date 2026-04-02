# MLT Engine for the 3D Tab

## Summary
- Add a new `mlt` render mode beside the existing PT mode, and implement it as a separate renderer subtree under [src/3d/mlt](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/mlt), while keeping [src/3d/engine.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/engine.js) as the top-level orchestrator.
- Use `PSSMLT` / Kelemen-style MLT on top of a custom unidirectional PT kernel, not Veach-style path-space MLT and not BDPT. That matches the current browser stack much better and is the only realistic way to ship MLT here without turning the renderer into a debugging trap.
- Keep the existing `three-gpu-pathtracer` PT path intact for `pathtrace`; do not try to wedge MLT into that vendor codepath.
- Keyboard mapping becomes `1 = Raster`, `2 = Path Trace`, `3 = MLT`, `4 = Mesh`. All toolbar buttons, dropdowns, HUD labels, hints, and status text update to match.
- MLT ships for both viewport preview and `Render PNG`, with the existing render-takeover behavior preserved so only one heavy render path is active at a time.
- Research basis: [Veach & Guibas 1997](https://graphics.stanford.edu/papers/metro/), [PBRT MLT chapter](https://www.pbr-book.org/3ed-2018/Light_Transport_III_Bidirectional_Methods/Metropolis_Light_Transport), [Mitsuba PSSMLT docs](https://www.mitsuba-renderer.org/releases/0.4.4/documentation_lowres.pdf), and a recent [WebGPU parallel MLT prototype writeup](https://www.davidtemplin.name/parallel-metropolis-light-transport/). The local research doc’s “shared core + separate integrators” recommendation should be followed.

## Public Interfaces
- Extend [src/3d/document.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/document.js) so `render.mode` accepts `'mlt'` in addition to `raster`, `pathtrace`, and `mesh`.
- Add a persisted export selector so preview mode and final engine are not accidentally tied together:
```js
render: {
  mode: 'raster' | 'pathtrace' | 'mlt' | 'mesh',
  exportEngine: 'pathtrace' | 'mlt',
  mlt: {
    chainCount: number,
    bootstrapSamples: number,
    largeStepProbability: number,
    mutationSigma: number,
    previewResolutionScale: number,
    seed: number
  }
}
```
- Keep `bounces`, `transmissiveBounces`, `samplesTarget`, `exposure`, `toneMapping`, output size, denoise, and world light shared between PT and MLT unless a setting is explicitly PT-only.
- Add one explicit action for nested MLT settings rather than overloading shallow render patches:
  - `updateThreeDMltSettings(patch)`
- Keep `updateThreeDRenderSettings(patch)` for `mode`, `exportEngine`, and existing top-level render fields.
- Do not persist live Markov-chain state or film buffers. Accumulation stays runtime-only inside the engine so documents stay portable.

## Implementation Changes
- Build the new engine as a separate subsystem:
  - `controller.js`: main-thread wrapper that [src/3d/engine.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/engine.js) talks to
  - `worker.js`: module worker entry so MLT does not block the UI
  - `sceneSnapshot.js`: flatten the current 3D scene into transferable geometry, materials, lights, textures, camera, and world-light data
  - `pathKernel.js`: custom unidirectional PT sampler used by MLT
  - `pssmlt.js`: bootstrap, primary-sample state, mutation, acceptance, and chain management
  - `film.js`: floating-point accumulation, preview tonemap conversion, and PNG-ready output
- Base the worker scene on a flattened world-space snapshot, not live `three.js` scene objects. Bake visible renderable geometry into one merged triangle set with triangle-to-material mapping, then build one BVH in the worker for intersection. Rebuild that snapshot only when geometry or material topology changes.
- Support the current normalized scene feature set in MLT:
  - primitives, imported models, image planes, 2D shapes, flat/extruded text, direct lights, emissive materials, and world light
  - matte, metal, glass, emissive, and approximated `original` materials
  - base-color textures and opacity handling from current normalized material data
- The custom PT kernel inside MLT must include BSDF sampling, Russian roulette, next-event estimation, MIS, direct-light sampling for analytic lights, emissive-triangle sampling, and environment sampling for solid, gradient, and HDRI world light. Do not ship an MLT core that only mutates blind BSDF-only paths.
- Use a unidirectional PSSMLT design, not MMLT and not BDPT. The mutation layer should mirror the PBRT-style primary-sample workflow:
  - lazy primary-sample vector expansion
  - backup/restore on proposed mutations
  - symmetric small-step mutation with wraparound in `[0,1)`
  - full-regeneration large steps
  - Metropolis acceptance using scalar path importance
  - weighted splats with bootstrap normalization, not “accepted samples only”
- Use luminance of the current path contribution as the scalar importance for acceptance and normalization, while splatting full RGB contribution to the film.
- Run multiple independent chains in the worker and interleave their steps each frame. Default scheduling should use a time budget per animation frame so preview stays responsive instead of blocking on fixed giant batches.
- Keep per-integrator runtime caches in memory. If the user switches between PT and MLT or moves to another site tab and comes back, PT and MLT should resume from their last accumulation state if scene, camera, and relevant render settings have not changed.
- Invalidation rules must be explicit:
  - camera moves, projection changes, and view changes reset the MLT chains and film but reuse geometry/BVH
  - light, world-light, tone, or material changes rebuild sampling tables and reset accumulation
  - geometry, boolean cuts, text extrusion changes, model loads, and topology changes rebuild the full scene snapshot and BVH
- In the viewport, `mlt` mode should display its own progressive film canvas and only keep editor overlays and hit-testing alive above it. Do not render the full raster scene underneath every frame.
- Update [src/3d/ui.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/ui.js) so the render UI exposes full experimental MLT controls, but only inside an `MLT` foldout when preview mode or export engine is `mlt`. The foldout should contain:
  - `Chain Count`
  - `Bootstrap Samples`
  - `Large Step Probability`
  - `Mutation Sigma`
  - `Preview Resolution Scale`
  - `Seed`
- Keep the viewport HUD tiny. For MLT, add small corner chips for `spp`, `accept %`, and `chains`; keep all other details in the Render tab and render dialog.
- `Render PNG` should gain an explicit `Engine` selector with `Path Trace` and `MLT`, defaulting to the current preview mode if it is one of those, otherwise defaulting to the last used physically-based engine. `Mesh` stays preview-only and is never a final export engine.
- Background rendering should dispatch by `exportEngine`:
  - `pathtrace` keeps the current `WebGLPathTracer` export path
  - `mlt` uses the worker-based MLT integrator at the requested output resolution
- Update status/loading copy so MLT has its own messages such as `Bootstrapping MLT`, `Mutating chains`, and `Rendering with MLT`. Reuse the current viewport takeover and job progress UI.
- Update `ai_context.txt` after implementation so the new engine architecture, hotkeys, export behavior, and experimental controls are documented for handoff.

## Test Plan
- Hotkeys and UI:
  - `1/2/3/4` switch to `Raster / Path Trace / MLT / Mesh`
  - render-mode dropdown, toolbar buttons, HUD chips, and help text all match
- Preview behavior:
  - switching to `mlt` shows the MLT film, not raster underneath
  - switching away and back resumes accumulation if nothing changed
  - switching to `Editor`, `Library`, or `Stitch` and back does not reset MLT or PT samples when the 3D document is unchanged
- Export behavior:
  - `Render PNG` can export with either PT or MLT
  - MLT export takes over the viewport, reports progress, can be aborted, and restores the editor view cleanly
  - mesh mode never becomes the export engine
- Correctness:
  - a simple Cornell-style scene rendered long enough in PT and MLT should match mean brightness and general color balance within a small tolerance
  - a hard-lighting or glass-caustic scene should show earlier recognizable caustic structure in MLT than PT at the same sample budget
  - HDRI, solid world light, and gradient world light all contribute correctly in MLT with no black-void fallback
- Feature coverage:
  - text, 2D shapes, primitives, imported models, image planes, emissive materials, and boolean-cut geometry all appear in MLT
  - orthographic and perspective cameras both work in MLT preview and export
  - current tone mapping and exposure behave the same way in PT and MLT output paths
- Robustness:
  - worker teardown on tab close and engine destroy leaves no orphan render loop
  - repeated mode switches, aborted exports, and scene edits do not leak canvases, workers, or stale buffers
  - unsupported source-material details under `original` are approximated consistently instead of crashing the MLT path

## Assumptions and Defaults
- `PSSMLT` is the v1 target. No BDPT, no MMLT, and no path-space mutation work in this update.
- MLT is explicitly experimental and specialized. PT remains the default general-purpose engine; MLT is for hard-lighting scenes, not for replacing PT everywhere.
- Default MLT settings:
  - `chainCount: 64`
  - `bootstrapSamples: 8192`
  - `largeStepProbability: 0.3`
  - `mutationSigma: 0.015625`
  - `previewResolutionScale: 0.5`
  - `seed: 0` where `0` means auto-seeded
- `bounces` and `transmissiveBounces` remain the shared depth controls for both PT and MLT.
- Denoising stays PT-only in v1 unless the MLT path later gains the auxiliary buffers needed to make denoising worthwhile.
- If a scene feature cannot be represented by the custom MLT kernel, the renderer should fall back to a documented approximation, not silently skip light transport or crash.
