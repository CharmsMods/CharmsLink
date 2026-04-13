# Deep Technical Research Report on Samsung and MotionCam DNG Behavior for a WebGL2 Renderer

The correctness issues you’re seeing are most consistent with (a) an incomplete/incorrect implementation of the DNG “camera → XYZ” math (especially how white balance interacts with `ColorMatrix*`, `CameraCalibration*`, and `AnalogBalance`), and (b) a wrong interpretation/application of DNG opcode `9` (`GainMap`), especially in the common “four maps / 2×2 phase offsets” pattern. citeturn13view1turn9view0turn34view0

  
## Key answers tied to your questions

Your renderer should treat Samsung Pro/native “RAW” (like your Samples A/B) as **LinearRaw** (“already demosaiced” is explicitly allowed by spec), but still in **camera-native color space** unless proven otherwise, and should therefore still run a DNG color transform to XYZ / display space. citeturn12view0turn13view1

For MotionCam Bayer DNGs (Sample C), the presence of a **4-channel-style gain map pattern** is exactly what Android’s Camera2 API describes for lens shading correction: `[R, Geven, Godd, B]`. That maps cleanly to “four opcode-9 entries with 0/1 offsets” in DNG, and it should be applied **after black subtraction / normalization but before demosaic** (i.e., in an OpcodeList2-like stage). citeturn34view0turn10view3turn18view0

Your current GainMap logic (“only multiply one channel when `plane == 0`”) is very likely wrong because the DNG GainMap opcode defines a **plane range** (`Plane`, `Planes`) and also defines how `MapPlanes` expands to multiple affected planes (“use the last map plane for remaining planes”). There is no “plane==0 means only channel 0” semantics in the opcode definition. citeturn9view0

  
## DNG color pipeline correctness

### Role and direction of the requested tags

This section is grounded in Adobe’s DNG Specification (v1.7.1.0), Chapter 6 and the tag definitions.

**`ColorMatrix1`, `ColorMatrix2`**  
These matrices map **XYZ → reference camera native space**, each under its specified calibration illuminant. Importantly, the spec defines the direction explicitly as XYZ-to-camera (not camera-to-XYZ). `ColorMatrix1` is required for all non-monochrome DNG files. citeturn17view0turn13view0

**`CameraCalibration1`, `CameraCalibration2`**  
These are **reference-camera-native → individual-camera-native** calibration matrices (again per calibration illuminant). They are stored separately to allow swapping `ColorMatrix*` while preserving per-unit calibration. citeturn17view0turn18view0

**`AnalogBalance`**  
A per-channel gain vector describing gain already applied to stored raw values (ideally analog). In Chapter 6 math, it becomes a diagonal matrix `AB` used in the XYZ↔camera transform. citeturn16view0turn13view0

**`ForwardMatrix1`, `ForwardMatrix2`**  
These are defined as mapping **white-balanced camera colors → XYZ D50**. If present, DNG provides a different (recommended) camera-to-XYZ pipeline that embeds white balance via a diagonal matrix in camera space rather than doing chromatic adaptation later in XYZ. citeturn7view0turn13view1

**`AsShotNeutral`**  
A white-balance encoding “as the coordinates of a perfectly neutral color in linear reference space values” (camera-space linear reference values). It is mutually exclusive with `AsShotWhiteXY`. citeturn15view0turn13view1

**`AsShotWhiteXY`**  
A white-balance encoding as CIE xy chromaticity coordinates, mutually exclusive with `AsShotNeutral`. citeturn15view0turn13view0

**`BaselineExposure`**  
An EV offset used to shift the “zero point” of exposure compensation for a given camera model. This is explicitly about where a raw converter’s exposure slider should start for a reasonable default. citeturn15view0

**`LinearResponseLimit`**  
A fraction of encoding range above which sensor response may become significantly non-linear, causing **highlight color shifts** unless compensated. The spec does not mandate a single compensation method, but it clearly warns that failing to compensate can cause highlight hue issues. citeturn6view3turn6view4

### Spec-correct matrix pipeline and where white balance lives

The DNG spec defines the interpolated matrices:

- `CM` = interpolated `ColorMatrix*` (n×3)  
- `CC` = interpolated `CameraCalibration*` (n×n), or identity depending on signature matching  
- `AB` = diagonal from `AnalogBalance` (n×n) citeturn13view0turn18view0

It then defines the core mapping:

**XYZ → camera(reference/individual)**
- `XYZtoCamera = AB * CC * CM` citeturn13view0

This has two immediate consequences for correctness:

1. If you are currently inverting `ColorMatrix*` alone and applying it to RGB, you are missing the `AB * CC` part unless you folded it elsewhere. A lot of “matrix looks wrong” symptoms come from omitting `AnalogBalance` and/or `CameraCalibration`. citeturn13view0turn16view0

2. `AsShotNeutral` is not “just RGB gains” in an absolute sense. It is defined in “linear reference space values” and the spec’s preferred pipeline (when ForwardMatrices exist) embeds the as-shot neutral into the camera→XYZ transform via a computed diagonal matrix `D`. citeturn15view0turn13view1

### Correct stage order for a practical renderer

The DNG spec gives a normative model for “mapping stored raw values into linear reference values”:

1. Linearization (`LinearizationTable` if present)  
2. Black subtraction (`BlackLevel` + deltas)  
3. Rescaling (“normalization”) to logical 0…1 using `WhiteLevel - maxBlack`  
4. Clipping (clip >1; preserve negatives early is recommended) citeturn18view0

Then, opcodes are applied in lists that are defined by stage:

- `OpcodeList1`: applied to raw image **as read directly from file**  
- `OpcodeList2`: applied **just after mapping to linear reference values**  
- `OpcodeList3`: applied **just after demosaicing** citeturn10view3

A practical (and spec-aligned) stage order therefore looks like this:

**For CFA/Bayer DNG (PhotometricInterpretation=32803)**  
- Decode samples (integer domain; possibly tiled).  
- Apply `OpcodeList1` (if you support it). citeturn10view3  
- Map to linear reference values (linearization → black subtract → normalize). citeturn18view0  
- Apply `OpcodeList2` (this is where GainMap is typically placed for lens shading). citeturn10view3turn9view0  
- Crop/mask handling with `ActiveArea` must be consistent with CFA origin expectations; the CFA origin is defined relative to the top-left of `ActiveArea`. citeturn12view0  
- Demosaic.  
- Apply `OpcodeList3` (post-demosaic corrections). citeturn10view3  
- Compute camera→XYZ D50 transform using Chapter 6 (prefer ForwardMatrix path if present). citeturn13view1turn7view0  
- Convert XYZ D50 → working RGB / display RGB.  
- Apply exposure (`BaselineExposure` as the spec-defined “move the zero point”) and then tone mapping / display rendering. citeturn15view0  

**For LinearRaw DNG (PhotometricInterpretation=34892, SamplesPerPixel>1)**  
The spec explicitly says LinearRaw “can also be used for CFA data that has already been de-mosaiced.” citeturn12view0  
So you should *not* demosaic, but you still do:
- Decode planes.  
- Map to linear reference values per plane (normalization is per sample plane). citeturn18view0  
- Apply relevant opcode lists (in practice: you may see `OpcodeList2` and/or `OpcodeList3`). citeturn10view3  
- Apply the Chapter 6 color transform (still camera-native unless a file clearly states otherwise, which typical DNG raw IFDs do not). citeturn12view0turn13view1  

### What differs between “standard Bayer raw DNG” and “linear DNG with 3 channels”

The core differences that matter for correctness in your renderer:

- **Where artifacts can be introduced**: Bayer pipelines are extremely sensitive to CFA alignment (`ActiveArea` offsets), pre-demosaic gain maps, and demosaic quality. LinearRaw pipelines skip demosaic, so if you see “demosaic-like” zippering on a linear file, it is more likely from (a) gain map misuse, (b) clipping behavior after a matrix, or (c) compression artifacts. citeturn12view0turn9view0

- **Whether 4-phase operations still make sense**: In Bayer, “four maps with 0/1 offsets” naturally corresponds to R / Gr / Gb / B phases. In LinearRaw 3-channel data, four-phase correction is suspicious unless you confirm the opcode is intended for a checkerboard application (more on this in the opcode section). citeturn9view0turn34view0

- **White balance implementation**: For CFA, doing WB “pre-demosaic” can reduce color artifacts, but the spec’s “ForwardMatrix path” effectively embeds WB via `D` and `Inverse(AB*CC)` in a defined way. For LinearRaw, WB is simply per-plane scaling, but it still must be consistent with the Chapter 6 reference space definitions. citeturn13view1turn16view0

  
## Opcode and gain-map semantics

### What opcode ID 9 is, precisely

DNG opcode **ID 9 = `GainMap`**. It “multiplies a specified area and plane range of an image by a gain map.” The opcode includes:

- Affected rectangle (`Top`, `Left`, `Bottom`, `Right`)  
- Affected plane range (`Plane`, `Planes`)  
- Subsampling via `RowPitch` and `ColPitch` (“only every RowPitch rows starting at Top”, similarly for columns)  
- The gain map grid size (`MapPointsV`, `MapPointsH`), map origin and spacing in relative coordinates, and `MapPlanes`. citeturn9view0

Two details from the spec are especially relevant to your bugs:

- `Plane` and `Planes` define **a range** of planes. They do not mean “this is the color channel.” citeturn9view0  
- If `Planes > MapPlanes`, “the last gain map plane is used for remaining planes being modified.” This implies common valid cases where a single gain map plane applies to multiple image planes. citeturn9view0  

### Why “four GainMaps with top/left 0/1 offsets” usually means CFA-phase correction

A very common way to represent lens shading for an RGGB Bayer sensor is to apply different gains to each of the four CFA phases. Android Camera2 explicitly models lens shading correction this way: the shading map has **four color channels** in order `[R, Geven, Godd, B]` (two separate greens). citeturn34view0

In DNG GainMap terms, the natural encoding is:

- Four separate `GainMap` opcodes  
- Each opcode targets only every other row/column with `RowPitch=2`, `ColPitch=2`  
- Each starts at a different phase using (`Top`,`Left`) = (0,0), (0,1), (1,0), (1,1) (or equivalent depending on which phase you map to which offset)

This matches your observation:

- Sample A/B: 4 GainMaps, with varying top/left offsets 0/1  
- Sample C: 4 GainMaps, offsets 0/1, and the maps are low-res (17×13), which is in-family with typical lens shading map resolution (Android notes these maps are usually far smaller than the full image). citeturn9view0turn34view0

### Interpreting “four gain maps with phase-like offsets” in practice

Given the above, the highest-probability interpretation is:

- **For Bayer/CFA (Sample C)**: these are per-CFA-phase shading corrections (R / two greens / B). That directly agrees with Android’s lens shading model and with DNG’s ability to address periodic subsets of pixels using `RowPitch`/`ColPitch`. citeturn34view0turn9view0

- **For LinearRaw 3-channel (Samples A/B)**: this is ambiguous. Four-phase lens shading is *naturally* a CFA concept. For it to be meaningful on 3-channel-per-pixel data, the opcode would have to be intentionally applying a 2×2 spatial modulation to already-demosaiced RGB pixels (which can easily create edge coloration if misapplied or if combined with clipping). There are real-world reasons a writer *might* still do this (e.g., carrying forward a sensor-phase correction), but you should treat it as “requires validation.” citeturn12view0turn9view0

### Linear RGB DNGs that still contain opcode-9 GainMaps

Spec-wise, there is nothing that forbids a GainMap on LinearRaw; the opcode operates on “an image” with planes, and LinearRaw can have 3 planes. citeturn9view0turn12view0

Engineering-wise, the key questions are:

- Does the opcode target **all pixels** (RowPitch=1, ColPitch=1) and `Planes=3`? That’s compatible with “apply per-color-plane shading” to RGB.  
- Or does it target a **2×2 subset** (RowPitch=2, ColPitch=2) and you see four entries? That looks like CFA-phase shading being carried into a LinearRaw file, and you should not assume the same meaning as “RGB plane shading” without reference testing. citeturn9view0

### Why your “multiply only one channel when plane==0” is likely wrong

Based on the opcode definition:

- `Plane` is the **first plane index** of the affected range, and `Planes` is the **count**. citeturn9view0  
- Therefore, `Plane==0` is simply the common case “start at the first plane,” not “this is channel 0 only.”  
- It is also common for a GainMap to specify multiple planes (e.g. `Planes=3`) and provide fewer map planes (e.g. `MapPlanes=1`), with the spec-defined behavior “repeat the last map plane for remaining planes.” If you only apply to channel 0 in that case, you will create exactly the kind of color casts/banding you describe. citeturn9view0

  
## Samsung-specific DNG behavior for Galaxy S24

### What is reasonably known (with clear certainty vs. inference)

**Certain from the DNG spec + your samples**  
Your S24 Samples A/B are `PhotometricInterpretation = 34892 (LinearRaw)` and `SamplesPerPixel = 3`. The DNG spec states LinearRaw “can also be used for CFA data that has already been de-mosaiced.” So “linear, 3-channel-per-pixel” is fully consistent with “already demosaiced.” citeturn12view0

**Supported by third-party technical observation (not Samsung-official, but credible as a signal)**  
Adobe community experts discussing Galaxy S24 DNGs have described them as “linear DNG (not a raw file)” and complained about heavy JPEG-like artifacts/banding in the raw data payload. Treat this as an observation about what the files *look like in practice* to downstream software, not a normative spec statement. citeturn21view1

**Samsung-official positioning (marketing/support docs; may lag implementation details)**  
Samsung support documentation states Expert RAW saves JPEG plus “RAW (Linear DNG 16-bit)” and positions it as HDR-capable capture intended for later editing. citeturn21view3

**Inference about computational photography / partial processing**  
Multiple independent community technical discussions around Samsung Expert RAW/Pro DNGs characterize them as “linear DNG” outputs that behave like an intermediate result rather than untouched sensor mosaic—often requiring large exposure offsets and not matching expectations from classic Bayer raws. This is plausible given Expert RAW’s HDR focus, but it is not guaranteed for every mode/version. citeturn19view0turn21view2

### Expert RAW vs native camera app “RAW” on recent Samsung devices

What you can treat as most likely, based on multiple sources plus your samples:

- Samsung’s Pro/native “RAW” and Expert RAW often produce **LinearRaw** DNGs (already demosaiced). Your S24 native camera samples confirm this for at least 12 MP and 50 MP outputs. citeturn12view0turn19view0  
- Expert RAW is explicitly framed as HDR-oriented and (at least in some updates) has been associated with newer DNG compression payloads such as JPEG XL in DNG 1.7 (noting that this is version-dependent and tooling support varies). citeturn21view2turn24view0  

### Are 12 MP and 50 MP Samsung DNGs typically linear RGB or mosaic raw?

For your Galaxy S24 **native camera app** samples: they are **linear 3-channel** (already demosaiced). That’s not a guess; it follows directly from the combination of `PhotometricInterpretation=LinearRaw` and `SamplesPerPixel=3`, which is a representation the DNG spec explicitly allows for demosaiced CFA data. citeturn12view0

For Samsung Expert RAW: multiple community reports discuss it as “linear DNG,” consistent with Samsung’s own description of Expert RAW output as “Linear DNG.” citeturn21view3turn19view0

### Are Samsung DNGs known to embed gain maps or opcode-based corrections?

Your own samples contain “four opcode-9 gain maps.” That is a strong indicator Samsung is embedding GainMap opcodes. The DNG spec defines GainMap as opcode ID 9 and describes how it is applied. citeturn9view0

Separately, smartphone RAW DNGs broadly (not just Samsung) are known to embed lens shading maps as GainMap opcodes in `OpcodeList2`; this is consistent with Android’s lens shading model being a per-channel gain map meant to be applied to RAW if you want to match non-RAW output shading. citeturn10view3turn34view0

### Renderer defaults that best match “known Samsung behavior”

Given the uncertainty around how “raw” Samsung LinearRaw truly is, I recommend defaults based on *file structure and opcode semantics*, not app name:

- **Apply camera matrices**: default ON, but only using the spec-correct Chapter 6 math (include `AnalogBalance` and `CameraCalibration`, and prefer `ForwardMatrix` if present). citeturn13view1turn16view0  
- **Apply gain maps**:  
  - default ON for CFA raws (where the four-map pattern is clearly meaningful),  
  - default OFF (or “experimental”) for LinearRaw 3-channel files if the GainMaps appear to be CFA-phase style (four entries, 0/1 offsets, RowPitch/ColPitch likely 2). This is because applying a CFA-phase gain map to already-demosaiced RGB can easily produce artificial edge coloration if misinterpreted. citeturn9view0turn12view0  
- **Temperature/tint**: do not treat this as “offset around 6500K.” Use Chapter 6’s mapping between xy and camera neutral, i.e. treat the slider as moving a target white point and recomputing a camera-neutral vector through `XYZtoCamera`. citeturn13view0  

  
## MotionCam DNG behavior on Samsung phones

### What MotionCam is trying to do (more “true raw” oriented)

MotionCam describes itself (via its Google Play listing) as capturing RAW video and replacing the stock camera software with its own computational photography algorithms. While this doesn’t enumerate exact DNG tags, it aligns with your observation that MotionCam outputs a CFA Bayer DNG in Sample C (1 sample/pixel + CFA pattern). citeturn37view0

### MotionCam output vs Samsung stock/Expert RAW output

Based on your sample metadata:

- **MotionCam Sample C** is a classic CFA raw container: `PhotometricInterpretation=32803 (CFA)`, `SamplesPerPixel=1`, and explicit CFA pattern. That is much closer to “true mosaic raw” than Samsung’s LinearRaw 3-channel outputs in Samples A/B. citeturn12view0  
- The CFA origin is defined relative to `ActiveArea`. If MotionCam’s DNG contains masked pixels and you ignore `ActiveArea`, you can easily shift the CFA phase by 1 pixel and create systematic green/magenta edge errors. citeturn12view0  

### MotionCam gain maps and why they look “Android-like”

Your Sample C has four GainMap opcodes with offsets 0/1 and map size 17×13.

Android Camera2 defines lens shading correction as a low-resolution floating-point map for each Bayer channel, with channel order `[R, Geven, Godd, B]`, and states it should always be applied to RAW images if you want shading appearance to match processed outputs. This maps directly to the “4 maps for a Bayer sensor” pattern you’re seeing. citeturn34view0

### Known differences to expect vs Samsung stock camera DNGs

From an engineering standpoint, treating MotionCam DNGs as “closer to camera2 raw” implies you should expect:

- **More reliance on metadata correctness** (`BlackLevel`, `ActiveArea` affecting CFA origin, lens shading gain maps). citeturn18view0turn12view0turn34view0  
- **Less in-camera demosaic / HDR stacking baked into the raster**, compared with Samsung LinearRaw outputs that are already 3-channel and widely reported/observed as intermediate computational outputs. citeturn12view0turn21view1turn21view3  

  
## Artifact diagnosis based on your samples and current implementation

Below, I rank the likely causes you listed for each artifact. Where I’m inferring (because we don’t have the full opcode parameter blocks or a known-good reference render), I label it clearly.

### Magenta/pink highlight traces on bright edges in Samsung 12 MP LinearRaw (Sample A)

Most likely causes, in descending probability:

1. **Incorrect gain-map interpretation** (especially treating CFA-phase GainMaps as RGB-plane gains, or applying only one plane due to the `plane==0` mislogic). Even a subtle 2×2 modulation combined with clipping in highlight edges can manifest as magenta fringing when green is suppressed or clipped relative to red/blue. citeturn9view0turn34view0  
2. **Incorrect color-matrix usage in highlight regions due to premature clipping** (inference): if your pipeline clamps to [0,1] immediately after matrix/WB, any negative/overshoot produced by the matrix can become a hard-channel clip that shows as colored edges. The DNG spec explicitly recommends preserving negative values early in the pipeline. citeturn18view0turn13view1  
3. **Missing `AnalogBalance` and/or `CameraCalibration` in the matrix path**: your current description suggests you invert `ColorMatrix1/2` and apply directly to “white-balanced RGB,” but Chapter 6 defines `XYZtoCamera = AB * CC * CM`. Omitting `AB` and `CC` can produce systematic hue errors that become very visible near clipping. citeturn13view0turn16view0  
4. **Wrong interpretation of `AsShotNeutral`** (medium likelihood): your “green / redNeutral” approach is a common simplification, but the spec’s preferred path (with ForwardMatrix) embeds WB via `D` computed from camera neutral and `Inverse(AB*CC)`. If you are also treating temperature/tint as offsets around a fixed 6500K baseline, your WB math may be inconsistent with the DNG model. citeturn13view1turn15view0  
5. **Incorrect color-matrix direction** (lower likelihood): the spec defines ColorMatrix as XYZ→camera, so inverting it to get camera→XYZ is directionally consistent *if* combined correctly with `AB` and `CC`. A pure direction flip alone is less likely than an incomplete pipeline. citeturn17view0turn13view1  
6. **LinearResponseLimit not handled** (lower likelihood but plausible contributor): the spec warns of highlight color shifts near saturation if not compensated. This could interact with Samsung’s processing, but without knowing the tag value in Sample A, it’s a secondary hypothesis. citeturn6view3  
7. **“Linear DNG treated as mosaic raw”** (depends on your code): if any CFA-phase logic, demosaic logic, or opcode-list staging assumes CFA, it can create edge artifacts on a linear image. This becomes more likely if you’re applying 4-phase gain maps to 3-channel data incorrectly. citeturn12view0turn9view0  

### Green/purple banding or edge coloration on MotionCam Samsung Bayer DNGs (Sample C)

Most likely causes:

1. **Incorrect gain-map interpretation/application** (very high likelihood), because the artifact becomes “severe instability” when gain map is enabled. A small error in mapping (wrong phase indexing, wrong `RowPitch/ColPitch` handling, wrong endian float, wrong map origin/spacing) produces exactly this kind of colored banding. citeturn9view0turn34view0  
2. **Applying transforms in the wrong order**: pre-demosaic shading correction should happen after black subtraction/rescaling but before demosaic (stage analogous to OpcodeList2). Running shading correction post-demosaic can work approximately in some cases, but it will fail badly when the gain map is truly phase-dependent. citeturn10view3turn18view0  
3. **Wrong CFA interpretation / CFA origin misalignment** (high likelihood): the spec states the CFA origin is the top-left of `ActiveArea`. If you ignore `ActiveArea` (or crop at the wrong time), you can shift Bayer phases, producing strong green/magenta issues at edges and in fine detail. citeturn12view0  
4. **Poor Bayer demosaic quality** (moderate): a simple demosaic will produce zippering and false color at hard edges, but it usually does not create “severe instability when gain map enabled” unless the gain map is already wrong.  
5. **Missing `CameraCalibration` / `AnalogBalance`** (lower): these affect overall color accuracy more than phase banding. citeturn13view0turn16view0  

### “Gain-map enabled renders can blow out badly”

Most likely causes:

1. **Wrong GainMap numeric decode or map coordinate math**: if you misread the 32-bit floats in the opcode payload, or treat relative coordinates incorrectly, you can easily apply gains that are far too large. DNG opcodes are stored big-endian regardless of file byte order, which is a common pitfall if you parse yourself (the spec emphasizes opcode lists are always big-endian). citeturn10view3turn9view0  
2. **Applying GainMap at the wrong point relative to normalization/clipping**: per the spec, opcodes in List2/3 operate in 0..1 logical space and clip after each opcode. If you apply gain maps before normalization, the intended scaling basis is wrong; if you apply after a matrix and then clip, highlights can “slam” into 1.0. citeturn10view3turn18view0turn9view0  
3. **Only applying gain to one plane**: if you boost only one channel, saturated regions will clip asymmetrically, often looking like “blown out badly” with strong tints. citeturn9view0  
4. **Missing BaselineExposure handling** (moderate): if the file expects a baseline EV shift and you instead apply gain maps/WB without that offset, you can push values into clipping too early. citeturn15view0  

### “Turning off camera matrix often makes overall color look more reasonable”

Most likely causes:

1. **Missing `AnalogBalance`/`CameraCalibration` or wrong Chapter 6 assembly**: applying `Inverse(ColorMatrix)` alone is not the full model; Chapter 6’s `XYZtoCamera = AB * CC * CM` is explicit. If you invert the wrong thing (or omit `AB/CC`), the matrix result will look “worse” than raw camera space. citeturn13view0turn16view0  
2. **White balance math inconsistent with the DNG model**: treating temperature/tint as offsets around 6500K rather than recomputing camera neutral via `XYZtoCamera` will produce non-DNG-consistent changes, and the matrix can amplify the error. citeturn13view0turn15view0  
3. **Premature clipping after matrix**: matrices commonly produce negative components; if you clamp too early, colors break in ways that resemble “bad matrix.” The spec explicitly recommends preserving negative values early. citeturn18view0  

  
## Practical implementation guidance for a WebGL2/Electron renderer

This section is written as concrete engineering guidance for your pipeline and UI toggles.

### Safe defaults for Samsung files (given your current state)

Because you are debugging correctness, the defaults should minimize “obviously broken” output while still aligning with the spec when possible.

**Apply Camera Matrix**  
- Default: ON  
- But: implement it *only* via Chapter 6 assembly (include `AnalogBalance` and `CameraCalibration`, and prefer `ForwardMatrix` if available). Until that is done, this toggle should be marked **experimental** on Samsung LinearRaw files, because user-visible “better with matrix off” is a strong indicator the current math is incomplete. citeturn13view0turn7view0turn16view0  

**Apply Gain Map**  
- Default for MotionCam CFA: ON (it is the expected lens shading correction model; Android explicitly says it should be applied to RAW if you want to match processed shading). citeturn34view0turn9view0  
- Default for Samsung LinearRaw with “4 phase” pattern: OFF or “experimental,” *until* you verify that the gain maps are intended to operate in LinearRaw space and you correctly interpret per-phase semantics.  
  - Rationale: applying a CFA-phase correction to already-demosaiced RGB is high-risk and matches your observed edge artifacts. citeturn12view0turn9view0  

**Apply Opcode Corrections**  
- Default: ON for CFA files; OFF (or experimental) for Samsung LinearRaw until you implement robust opcode parsing (big-endian) and staging. Opcode lists are always big-endian and clip after each opcode; mismatching this can catastrophically break output. citeturn10view3  

**White Balance: As Shot**  
- Default: ON  
- Implementation note: treat `AsShotNeutral` as a camera-neutral vector *in the DNG Chapter 6 sense*, not as an arbitrary RGB gain set. If you are currently doing `gainR = green/redNeutral`, `gainB = green/blueNeutral`, that’s a workable approximation for quick viewing, but it should be replaced by a Chapter 6-consistent computation as part of your “camera→XYZ D50” matrix assembly (especially if `ForwardMatrix` exists). citeturn15view0turn13view1  

**Temperature / Tint**  
- Default: disabled unless you can correctly map temp/tint → xy → camera neutral using `XYZtoCamera`.  
- Why: Chapter 6 explicitly defines how to translate an xy white point to a camera neutral vector using `XYZtoCamera = AB * CC * CM`, and the inverse direction requires iteration. A “6500K baseline offset” approach is not the DNG model and can easily create inconsistent results, especially on Samsung linear files. citeturn13view0turn13view1  

### Controls to hide/disable/mark experimental until correctness improves

- Hide/disable **Temperature/Tint** in “As Shot” mode until you implement a proper xy/camera-neutral mapping. citeturn13view0  
- Mark **Apply Gain Map** as experimental for Samsung LinearRaw until you have validated the meaning of the 4-map pattern on already-demosaiced data.  
- Mark **Apply Camera Matrix** as experimental until you incorporate `AnalogBalance` + `CameraCalibration` and implement the ForwardMatrix pipeline correctly. citeturn13view0turn7view0  

### Staged implementation order for improving correctness

#### Highest-value fix

Implement **GainMap opcode (ID 9) exactly per spec**, including:

- big-endian parsing of opcode lists,  
- correct handling of `Plane`/`Planes` (range),  
- correct handling of `RowPitch`/`ColPitch`,  
- correct handling of `MapOrigin`/`MapSpacing` (relative coords),  
- correct handling of `MapPlanes` expansion (“repeat last plane”). citeturn10view3turn9view0  

This is the fastest path to stabilizing MotionCam Bayer DNGs and addressing your “blows out badly” symptom.

#### Second fix

Implement the **Chapter 6 camera→XYZ D50 transform** properly:

- Assemble `XYZtoCamera = AB * CC * CM`. citeturn13view0turn16view0  
- Prefer ForwardMatrix path if present: `CameraToXYZ_D50 = FM * D * Inverse(AB * CC)` where `D` is computed from camera neutral. citeturn13view1turn7view0  
- Otherwise: `CameraToXYZ = Inverse(XYZtoCamera)` (or pseudo-inverse), then apply chromatic adaptation matrix `CA` (linear Bradford recommended) to D50. citeturn13view1  

This directly targets your “camera matrix off looks better” symptom.

#### Third fix

Fix **CFA alignment and staging** for MotionCam Bayer:

- Ensure the CFA origin is correctly aligned to `ActiveArea` (“origin … is the top-left corner of the ActiveArea rectangle”). citeturn12view0  
- Ensure GainMaps (if CFA-phase) are applied **before demosaic** on linear reference values (OpcodeList2 stage). citeturn10view3turn18view0  
- Then improve demosaic quality only after the above are correct (otherwise demosaic tuning will be chasing upstream errors).

  
## Closing synthesis

### Most Likely Root Causes

1. **GainMap opcode misinterpretation**, especially the meaning of `Plane/Planes`, and/or incorrect handling of the 2×2 CFA-phase mapping (offsets 0/1 with row/col pitch). This explains MotionCam instability, blowouts, and plausibly Samsung edge tinting if you’re applying CFA-phase maps to LinearRaw. citeturn9view0turn34view0  
2. **Incomplete Chapter 6 color pipeline**: applying `Inverse(ColorMatrix*)` without incorporating `AnalogBalance` and `CameraCalibration` (and without the ForwardMatrix path when present) will produce non-physical colors that may look “better” when the matrix is disabled simply because the wrong transform is removed. citeturn13view0turn16view0turn7view0  
3. **Wrong staging/clipping**, especially clipping too early (after matrix or gain map) and/or ignoring the spec’s recommendation to preserve negative values early. This can create edge tints and highlight color breaks. citeturn18view0turn10view3  
4. **CFA phase misalignment** for MotionCam due to `ActiveArea` origin or crop order mistakes, producing green/purple edge coloration that no demosaic can fully hide. citeturn12view0  

### Best Immediate Fixes

- Implement opcode-list parsing and GainMap opcode 9 **byte-order correctly** (opcode lists are big-endian) and apply GainMap using the full parameter set (`Plane/Planes`, pitches, MapPlanes expansion). citeturn10view3turn9view0  
- For MotionCam CFA inputs, apply GainMap after black subtraction/normalization and before demosaic; for Samsung LinearRaw, temporarily default GainMap OFF when it looks like CFA-phase style (four maps with 0/1 offsets) until validated. citeturn10view3turn18view0turn12view0  
- Rebuild your camera-matrix path to follow Chapter 6 exactly (`XYZtoCamera = AB * CC * CM`, and use ForwardMatrix pipeline if present). citeturn13view0turn13view1turn7view0  

### Longer-Term Correct Pipeline

A robust “correctness-first” pipeline for your renderer should be:

- **Decode raster** (lossless/lossy per DNG compression), keep full precision.  
- **OpcodeList1** on raw-as-read (optional but spec-defined). citeturn10view3  
- **Map to linear reference values**: LinearizationTable → black subtraction → rescaling → clip-high; preserve negatives at least through early stages. citeturn18view0  
- **OpcodeList2** on linear reference values (this is where lens shading GainMaps typically belong for CFA). citeturn10view3turn9view0  
- **Crop/alignment**: ensure CFA origin is correct relative to `ActiveArea`. citeturn12view0  
- **Demosaic** (CFA only).  
- **OpcodeList3** post-demosaic. citeturn10view3  
- **Color pipeline (Chapter 6)**: build camera→XYZ D50 using `AB`, `CC`, `CM`, and prefer `ForwardMatrix` methods when available. citeturn13view0turn13view1turn7view0  
- **Exposure / tone mapping**: incorporate `BaselineExposure` as the model-defined exposure offset, then do your tone mapping and output transform. citeturn15view0