# Editor DNG Develop Layer

## Summary
- Add a new Editor base-stack layer named `DNG Develop` that is source-aware, single-instance, and only active for DNG-backed Editor documents.
- Extend the Editor source model so DNG projects preserve the original raw file, metadata, and develop settings instead of collapsing to a raster on first save/load.
- Implement the DNG path with the existing Editor worker/WASM architecture for probe, decode, progress, and 16-bit PNG export, and use the Editor GPU pipeline for the actual develop graph.

## Public Interfaces / Type Changes
- `document.source` becomes a discriminated source model:
  - Raster source keeps the current `imageData` flow.
  - DNG source adds a raw payload reference plus cached classification metadata and develop-relevant metadata.
- Add `layerId: 'dngDevelop'` to the layer registry as a `group: 'base'`, single-instance manual layer.
- Add Editor export bit depth with `8-bit` and `16-bit`; DNG-backed documents default to `16-bit`.
- Add a second Library attachment store for project-linked binary attachments so raw DNG can be stored without taking over the existing project preview blob slot.

## Implementation Changes
- Source ingest and persistence:
  - Update Editor file accept/detection to include `.dng`.
  - DNG import must bypass the current `Image()` / data-URL raster path and instead call a new Editor worker probe/decode flow.
  - Exported `.mns.json` documents remain self-contained by embedding the original DNG payload.
  - Library saves keep the current preview/render blob behavior, but store the original DNG in a new attachment record keyed to the project. Library load/export rehydrates that attachment back into the Editor payload.
  - Document normalization auto-inserts `DNG Develop` at the front of the base chain for DNG sources and removes/disables stale DNG layer state for non-DNG sources.

- Worker/WASM and runtime:
  - Add Editor worker tasks for `probe-dng-source`, `prepare-dng-source`, and `export-png16`.
  - Use bundled vendor-backed WASM decode components for durable coverage, especially JPEG XL, rather than a temporary in-house parser path.
  - Cache parsed DNG metadata and decoded raw/intermediate buffers by source signature in the Editor runtime.
  - Emit `editor.dng` and `editor.export` logs/progress during probe, decode, preview prep, and export.
  - Unsupported or partial DNG features must produce visible warnings in both the layer UI and Logs instead of silently pretending fidelity is complete.

- Layer UI and develop graph:
  - `DNG Develop` controls are grouped as:
    - `File Info`: make/model, dimensions, bit depth, compression, detected preset, fidelity status.
    - `Interpretation`: auto preset plus overrides for Linear, Bayer Mosaic, Quad/Nona Mosaic, and Interleaved layouts.
    - `Normalize`: auto/manual black level, auto/manual white level, linearization-table toggle, orientation toggle.
    - `Remosaic / Demosaic`: remosaic auto/on/off and demosaic quality `Fast` / `High`.
    - `Color / WB`: `As Shot` / `Custom`, temp, tint, camera-matrix toggle, working space `sRGB` / `Display P3` / `Linear`.
    - `Tone`: exposure, highlight recovery, tone mapping amount.
    - `Noise / Detail`: denoise `Auto` / `Off` / `Manual`, denoise strength, detail preservation, sharpen amount.
    - `Corrections`: opcode/gain-map apply toggles with warning badges when metadata exists but support is partial.
  - Default behavior:
    - Samsung/linear Expert RAW presets skip demosaic and use gentle denoise/sharpen defaults.
    - Mosaic presets auto-run remosaic when required, then use 5x5 demosaic in `High` mode.
    - Existing `High Quality Preview` toggles DNG live preview between `Fast` and `High`; export always uses `High`.
  - Engine path:
    - Add a new manual render path before the rest of the stack: unpack interleaved data, normalize, optional remosaic, optional demosaic, WB/camera transform, denoise, highlight/tone, output transfer, optional sharpening.
    - Keep the DNG graph in high precision textures until final export/writeout.
    - Non-DNG documents keep the current raster source path unchanged.

- Export and compatibility:
  - Replace canvas-based DNG 16-bit export with a worker/WASM PNG16 encoder path.
  - Keep existing 8-bit PNG export for ordinary raster projects and for users explicitly choosing 8-bit.
  - Composite/Library flows that consume Editor project previews continue to use preview/render PNGs, not raw DNG attachments.

## Test Plan
- Validate with fixture DNGs for:
  - Samsung Expert RAW Linear 16-bit
  - Bayer mosaic
  - Quad/Nona mosaic requiring remosaic
  - Row/column interleaved layout
  - Deflate-compressed DNG
  - JPEG XL-compressed DNG
  - DNG with opcode/gain-map metadata
  - Ordinary PNG/JPEG regression inputs
- Verify:
  - `.dng` import classifies correctly and auto-inserts `DNG Develop`
  - Linear files do not get double-demosaiced
  - Save/load `.mns.json` and Library round-trips preserve raw DNG plus develop settings
  - Preview quality toggle affects DNG quality only through the intended fast/high path
  - 16-bit PNG export writes the correct dimensions and bit depth
  - Logs/progress appear for probe, decode, and export
  - Non-DNG Editor behavior, Library previews, and Composite use of Editor project previews remain intact

## Assumptions / Defaults
- Use bundled vendor-backed WASM decoders instead of a short-lived in-house decode path.
- PNG, not JPEG, is the full-quality export target for this tranche.
- First implementation covers the durable format branches from the research note: linear, Bayer, quad/nona, interleaved, Deflate, and JPEG XL. If an opcode/correction path is parsed but not fully supported, the app must mark the file as partial-fidelity rather than silently degrading it.
