You are helping debug a custom WebGL2 DNG renderer for a browser/Electron image editor.

I need a deep technical research report focused on Samsung and MotionCam DNG behavior, with citations and implementation guidance, not a generic photography explanation.

Context:

- The app already parses TIFF/DNG metadata, decodes JPEG-compressed DNG rasters on CPU, and renders live DNG preview on GPU.
- The current problems are not about performance anymore. They are about correctness.
- I need guidance grounded in the DNG spec and in any trustworthy technical sources about Samsung Expert RAW / Samsung camera DNGs / MotionCam DNGs.

Please research and answer these questions:

1. DNG color pipeline correctness
- Confirm the correct role and direction of these DNG tags in a raw-processing pipeline:
  - `ColorMatrix1`
  - `ColorMatrix2`
  - `ForwardMatrix1`
  - `ForwardMatrix2`
  - `CameraCalibration1`
  - `CameraCalibration2`
  - `AnalogBalance`
  - `AsShotNeutral`
  - `AsShotWhiteXY`
  - `BaselineExposure`
  - `LinearResponseLimit`
- For a practical renderer, what is the correct stage order for:
  - black/white normalization
  - white balance
  - camera-space to XYZ / display transform
  - gain-map application
  - opcode execution
  - tone mapping
- Explain which steps differ between:
  - a standard Bayer raw DNG
  - a linear DNG that already contains 3 channels per pixel

2. Samsung-specific DNG behavior
- For Samsung Galaxy S24 DNGs:
  - what is known about `Expert RAW` DNGs versus native camera app DNGs?
  - are the 12 MP and 50 MP DNGs typically linear RGB or mosaic raw?
  - are Samsung DNGs known to embed gain maps or opcode-based corrections?
  - are some Samsung DNGs already partially processed before being written?
- Based on known Samsung behavior, should a renderer default to:
  - applying camera matrices
  - applying gain maps
  - treating temperature/tint as offsets around `AsShotNeutral`
  - treating linear Expert RAW files as already demosaiced / partially color-processed

3. MotionCam DNG behavior
- What does MotionCam generally write into its DNGs on Samsung phones?
- Are MotionCam DNGs expected to be closer to true mosaic raw than Samsung's own camera app or Expert RAW files?
- Are there known differences in:
  - compression
  - CFA interpretation
  - color transforms
  - gain maps
  - opcode usage

4. Opcode and gain-map semantics
- I need a focused explanation of DNG opcode ID `9`, especially in Samsung-related files.
- When a DNG contains multiple opcode-9 entries with different `top/left` offsets, what do those usually represent?
- If a file contains four gain maps with phase-like offsets, is that likely:
  - per-color-plane data
  - per-CFA-phase data
  - something else
- For linear RGB DNGs that still contain opcode-9 gain maps, how should they be interpreted?
- If the current renderer multiplies only one channel when `plane == 0`, is that likely wrong? Explain why.

5. Artifact diagnosis
- The current renderer shows these artifacts:
  - magenta/pink highlight traces on bright edges in Samsung 12 MP linear DNGs
  - green/purple banding or edge coloration on MotionCam Samsung Bayer DNGs
  - gain-map enabled renders can blow out badly
  - turning off camera matrix often makes the overall color look more reasonable
- For each artifact, give the most likely causes ranked by probability:
  - incorrect color-matrix direction or missing adaptation math
  - wrong interpretation of `AsShotNeutral`
  - missing `CameraCalibration` / `AnalogBalance`
  - incorrect gain-map interpretation
  - poor Bayer demosaic quality
  - applying transforms in the wrong order
  - linear DNGs being treated as if they still need the same processing as mosaic raw

6. Practical implementation guidance
- I need concrete, engineering-level recommendations for a browser/Electron WebGL2 renderer.
- Recommend safe default behavior for these control toggles on Samsung files:
  - `Apply Camera Matrix`
  - `Apply Gain Map`
  - `Apply Opcode Corrections`
  - `White Balance: As Shot`
  - `Temperature / Tint`
- Recommend which controls should be hidden, disabled, or marked experimental until the pipeline is more correct.
- Recommend a staged implementation order for improving correctness:
  1. highest-value fix
  2. second fix
  3. third fix

Known sample metadata from local files:

Sample A
- file name: `20260412_175809.dng`
- app/source: Samsung native camera app
- dimensions: `4080 x 3060`
- make/model: `samsung / Galaxy S24`
- classification: `linear`
- photometric: `34892`
- compression: `JPEG`
- bits per sample: `[12, 12, 12]`
- samples per pixel: `3`
- `AsShotNeutral`: `[0.513671875, 1, 0.576171875]`
- `WhiteLevel`: `[4095, 4095, 4095]`
- `BlackLevel`: all zero
- four opcode-9 gain maps
- each gain map is `1 x 1`
- offsets vary by `top/left = 0/1`
- current visible artifact: pink/magenta highlight traces on bright edges

Sample B
- file name: `20260412_175815.dng`
- app/source: Samsung native camera app
- dimensions: `8160 x 6120`
- make/model: `samsung / Galaxy S24`
- classification: `linear`
- photometric: `34892`
- compression: `JPEG`
- bits per sample: `[12, 12, 12]`
- samples per pixel: `3`
- `AsShotNeutral`: `[0.50390625, 1, 0.5712890625]`
- `WhiteLevel`: `[4095, 4095, 4095]`
- `BlackLevel`: all zero
- four opcode-9 gain maps
- each gain map is `1 x 1`
- offsets vary by `top/left = 0/1`

Sample C
- file name: `IMG_260412_181057.dng`
- app/source: MotionCam
- device: Samsung SM-S921U
- dimensions: `4080 x 3060`
- classification: `bayer`
- photometric: `32803`
- compression: `JPEG`
- bits per sample: `[16]`
- samples per pixel: `1`
- CFA pattern width/height: `2 x 2`
- CFA pattern: `[1, 2, 0, 1]`
- CFA plane colors: `[0, 1, 2]`
- `AsShotNeutral`: `[0.508789, 1, 0.583008]`
- `WhiteLevel`: `[4095]`
- `BlackLevel`: approximately `[256.265625, 256.265625, 256.265625, 256.265625]`
- four opcode-9 gain maps
- each gain map is `17 x 13`
- offsets vary by `top/left = 0/1`
- current visible artifact: green/purple banding and severe instability when gain map is enabled

Current renderer assumptions that may be wrong:

- `AsShotNeutral` is converted into simple RGB gains as:
  - `green / redNeutral`
  - `1`
  - `green / blueNeutral`
- Temperature/tint in `As Shot` mode are implemented as extra offsets around a `6500K` neutral baseline.
- Camera matrix path currently inverts `ColorMatrix1/2` and applies the result directly to white-balanced RGB.
- Gain maps are currently treated too simplistically and may only affect one color plane when `plane == 0`.
- Standalone opcode execution is not implemented yet.
- Bayer demosaic is currently fairly simple and may not be robust enough for difficult edges.

Deliverable requirements:

- Use sectioned headings.
- Cite sources inline.
- Be explicit about what is certain versus inferred.
- End with:
  - `Most Likely Root Causes`
  - `Best Immediate Fixes`
  - `Longer-Term Correct Pipeline`
