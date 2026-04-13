# GPU DNG Develop Migration (WebGL2)

## Summary
- Replace the current DNG CPU `prepare -> RGBA preview -> upload as base image` flow with a true GPU DNG source mode inside the existing Editor WebGL2 pipeline.
- Keep TIFF/container parsing and compressed-raster decode on the CPU/worker side, but move the full develop graph, exact live preview, and 16-bit export render to GPU.
- Finish the currently partial DNG branches in the same tranche: real remosaic/interleaved handling, real orientation/linearization behavior, real opcode execution, and real gain-map application.
- Update [Whole Site Context.txt](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/Important%20Sources/Whole%20Site%20Context.txt) as part of the implementation, because it is now out of date for DNG once this lands.

## Public Interfaces / Runtime Model
- Persisted `document.source` stays discriminated (`raster` vs `dng`) and stays self-contained for local JSON and attachment-backed for Library saves. Do not persist decoded raw buffers or GPU state.
- `dngDevelop` stays the first `base` layer and remains single-instance, but it stops being a no-op/manual placeholder and becomes the real GPU source-develop stage.
- The Editor export UI stays `8-bit PNG` / `16-bit PNG`. DNG-backed documents keep defaulting to `16-bit`, but the implementation switches from CPU prepare/export to GPU render + PNG16 encode.
- Add a dedicated DNG worker domain separate from the existing generic `editor` worker tasks. The existing `editor` domain keeps analysis/diff/palette work; the new DNG domain owns probe/decode/export and holds warm DNG state.

## Implementation Changes
### 1. Split CPU decode from GPU develop
- Replace the current `prepareDngBuffer(...)` runtime role with a decode-only path that returns raw raster data plus normalized metadata needed by the GPU graph:
  - raw sample buffer(s)
  - stored width/height
  - default crop/orientation
  - CFA/interleave layout
  - black/white levels
  - linearization table
  - color matrices / white-balance metadata
  - noise profile
  - parsed opcode lists
  - parsed gain-map data
- Keep probe/decode keyed by `sourceSignature` and cache decoded DNG payloads in runtime memory only.
- Move the existing CPU develop logic out of the runtime path and keep it only as a hidden reference renderer for regression testing during the migration.

### 2. Make the Editor engine source-aware for DNG
- Extend the Editor engine in `src/engine/pipeline.js` and `src/engine/executors/index.js` so it can render from either:
  - a raster `baseImage`, or
  - a decoded DNG source texture set plus DNG metadata
- Remove the requirement that DNG preview first become a `canvas`/`ImageData` source image. The DNG document should render even when no `runtime.baseImage` exists.
- Update `hasImage()`, hover-original, compare view, scopes, thumbnails, selected-layer previews, and Library preview capture so DNG-backed documents use the current DNG-develop base output instead of assuming a DOM image source.
- Extend resolution/layout math so `dngDevelop` can change effective source dimensions before later `scale`, `expander`, and `cropTransform` layers. Orientation and default crop must be part of the DNG source stage, not baked into the saved raster preview.

### 3. Implement the DNG GPU graph as the real layer executor
- Add DNG shader programs and a DNG runtime cache under the existing WebGL2 engine, not a second rendering stack.
- The required pass order is:
  1. unpack row/column interleaved raw layout when present
  2. apply `OpcodeList1` in raw-file order
  3. apply linearization LUT
  4. black/white normalization into linear reference values
  5. apply `OpcodeList2`
  6. optional quad/nona remosaic into Bayer-like layout
  7. demosaic, or linear pass-through for linear DNGs
  8. white balance (`As Shot` plus exact `Temperature`/`Tint` offsets, or `Custom`)
  9. camera matrix / working-space transform
  10. apply gain map in linear scene-referred space
  11. apply `OpcodeList3`
  12. denoise / detail preservation
  13. exposure, highlight recovery, tone mapping
  14. sharpening
  15. orientation and default crop output stage
  16. final transfer/output packing for the rest of the Editor chain
- Use float/half-float textures throughout the DNG graph. Raw input textures may be single-channel float textures; working/output buffers should stay in the existing high-precision framebuffer system.
- Live preview must stay exact while dragging. Do not add a progressive-quality drag path and do not add an Apply button.

### 4. Finish the currently partial controls now
- `Temperature`, `Tint`, `Apply Orientation`, remosaic modes, working-space changes, and camera-matrix toggles must become real GPU-affecting controls.
- `Apply Opcode Corrections` and `Apply Gain Map` must stop being UI-only placeholders. The implementation must:
  - inventory the opcode IDs present in the supported fixture set and current Samsung sample files before cutting over runtime
  - implement every opcode ID found in that set before rollout
  - hard-fail unsupported opcode IDs with a visible unsupported-file warning instead of silently producing partial output
- `supportsOpcodeCorrections`, `supportsGainMapCorrections`, and `supportsRemosaic` should now reflect actual runtime support, not placeholder booleans.

### 5. Export, worker behavior, and testing ergonomics
- Keep main-thread GPU rendering for live Editor preview.
- Add a dedicated DNG GPU export worker using `OffscreenCanvas` + WebGL2 when available so 16-bit export and Library snapshot generation do not stall the UI.
- If worker-side WebGL2 is unavailable, use a temporary main-thread GPU export path. Do not fall back to CPU develop.
- Keep PNG16 encoding CPU-side after GPU readback; the GPU responsibility is the full develop/render path, not the final DEFLATE packaging step.
- Change cancellation behavior for the dedicated DNG worker domain so replacing an active DNG task does not restart the worker process. Warm shader programs, decoded DNG caches, and GPU resources must survive replace-on-newer-task behavior.
- Add stage timing to `editor.dng` / `editor.export` logs for:
  - probe
  - decode
  - GPU upload
  - preview render
  - export render
  - readback
  - PNG16 encode
- Keep the in-canvas `Rendering` badge, but drive it from the new GPU path instead of the old CPU prepare path.

## Test Plan
- Validate these fixture classes end-to-end:
  - Samsung Expert RAW linear 16-bit
  - Samsung Pro Mode mosaic
  - generic Bayer mosaic
  - quad/nona mosaic requiring remosaic
  - row/column interleaved layout
  - Deflate-compressed DNG
  - JPEG-compressed DNG
  - JPEG XL-compressed DNG
  - DNGs carrying opcode metadata
  - DNGs carrying `ProfileGainTableMap`
  - ordinary PNG/JPEG Editor projects for regression
- Verify live preview behavior:
  - every DNG control visibly affects the preview when applicable
  - exact live preview updates without converting the DNG into a CPU-prepared raster first
  - `Rendering` status appears during heavy DNG rebuilds, but replacement tasks no longer log as hard errors
- Verify output correctness against the retained CPU reference renderer before removing it from runtime:
  - preview parity: at least 99% of pixels within ±2 8-bit values per channel
  - 16-bit export parity: at least 99% of pixels within ±64 code values per channel, excluding the outermost 1 px warp/crop border
  - no obvious magenta highlight artifact regressions on the Samsung fixtures
- Verify product flows:
  - DNG Library save/load still preserves raw payload + develop settings
  - DNG Library previews and auto-save dialogs no longer white-screen Electron
  - 16-bit PNG export still writes correct dimensions/bit depth
  - non-DNG Editor preview/export behavior remains unchanged

## Assumptions / Defaults
- Use the existing WebGL2 engine, not WebGPU. That matches the current architecture and runtime capability model.
- Runtime is GPU-only after decode: CPU/WASM still parses TIFF/compression, but no CPU develop fallback remains in the shipped DNG preview/export path.
- The old CPU develop implementation is retained only as a hidden regression oracle until GPU parity is proven, then it can be archived.
- Update [Whole Site Context.txt](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/Important%20Sources/Whole%20Site%20Context.txt) in the same implementation tranche.
- Source grounding used for the plan’s stage ordering and worker/export feasibility:
  - [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
  - [MDN OffscreenCanvas.convertToBlob](https://developer.mozilla.org/docs/Web/API/OffscreenCanvas/convertToBlob)
  - [MDN WebGL `texImage2D`](https://developer.mozilla.org/en-US/docs/Web/API/WebGLRenderingContext/texImage2D)
  - [Library of Congress TIFF/DNG tag reference](https://www.loc.gov/preservation/digital/formats/content/tiff_tags.shtml)
