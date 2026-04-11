# DNG Develop Layer Implementation Plan for Samsung DNG in a WebGL Editor

A lossless, high-control “DNG → developed image → PNG” workflow in a browser editor is feasible if you treat the DNG as a **TIFF-based container** whose pixel payload may be **mosaic CFA**, **already-demosaiced linear**, and/or **compressed (including JPEG XL)**—and then build a **parameterized, multi-pass GLSL “develop” layer** that stays in **high precision** (16-bit/float) until export. citeturn4view0turn6view2turn6view1turn6view4

[Download the implementation plan (text file)](sandbox:/mnt/data/DNG_Develop_Layer_Implementation_Plan.txt)

## What Samsung’s DNG-producing pipelines do and why it matters

Samsung’s outputs are not all the same kind of “raw,” even when they use the `.dng` container.

Samsung documents **Expert RAW** as producing **Linear DNG 16-bit** alongside a JPEG. citeturn21view0turn22view0 “Linear DNG” matters because it strongly suggests a pipeline where the phone has already done (at least) **demosaicing** (and potentially more) before writing the DNG—so a raw developer must **auto-detect linear vs mosaic** and avoid “double demosaic.” citeturn6view2turn21view0turn22view0

Samsung’s CamCyclopedia material also describes Expert RAW as **multi-frame processing at the RAW level**, explicitly calling it “Computational Raw (DNG)” and describing **noise reduction and dynamic-range improvement** produced via multi-frame processing (and even mentioning AI denoise on the RAW). citeturn11view1turn12view0 This implies that, for Expert RAW DNGs, your defaults should be conservative on denoise/sharpen unless the user explicitly wants additional processing, because some is likely already “baked in.” citeturn12view0turn11view1

Separately, Samsung’s semiconductor documentation describes a **high-resolution sensor pipeline** where raw output occurs **before** a **remosaic** step, followed by ISP and JPEG; it also describes an “E2E AI Remosaic” approach that runs remosaic and ISP more in parallel. citeturn19view0 This aligns with Samsung’s public sensor material describing **pixel binning** modes and a **remosaic-driven 1x1 mode** for ultra-high-resolution sensors. citeturn20view2 The implementation implication is that some DNGs—especially those tied to very high resolution / binned sensors—may require a **remosaic stage** (quad/nona Bayer → Bayer-like) **before** standard demosaic, or may already incorporate remosaic results depending on capture mode and device pipeline. citeturn19view0turn20view2

## DNG constraints that drive your decoder and pipeline

DNG is a documented format published by entity["organization","Adobe","software company"], and the current spec (v1.7.1.0) describes it as a TIFF-based structure with detailed tags covering geometry, color, and processing metadata. citeturn3view0turn4view0 For your editor layer, the most consequential DNG realities are:

DNG can store pixel data in different **photometric interpretations**, including **CFA mosaic** and **LinearRaw**. The spec explicitly notes that **LinearRaw can be used for CFA data that has already been de-mosaiced**, which is exactly the sort of thing you must detect to avoid incorrect processing paths. citeturn6view2turn6view2

DNG can use multiple compression schemes. The spec documents (among others) **Deflate**, **lossy JPEG**, and **JPEG XL**; it also defines a JPEG XL-specific parameter tag where **0.0 indicates lossless** and values above 0 indicate lossy. citeturn6view1turn6view1turn6view4 Practically, that means your “lossless” story cannot be “DNG is always uncompressed”; it must be “we decode exactly what is stored, and we can *detect* whether the stored payload is lossless.” citeturn6view1turn6view4

DNG supports “Opcode Lists,” which can specify post-demosaic steps such as lens correction warps; the spec explicitly positions these as a mechanism to move complex processing into the DNG reader. citeturn10view0turn10view2 For smartphones, this is relevant because distortion/CA/vignette correction is a major part of the “Samsung look,” and some of that may be encoded as opcodes or gain maps—or may remain proprietary and not expressed in the DNG. citeturn10view0turn10view2

DNG can provide a rigorous **noise model** via `NoiseProfile`, modeling shot + read noise with a two-parameter form, and it includes guidance on how to interpret remaining noise if noise reduction has already been applied. citeturn8view1turn8view2 This enables a higher quality and more principled denoise stage than “one slider for everything,” and it also enables your UI to surface “camera already denoised a lot; be careful.” citeturn8view1turn8view2

## Input taxonomy and auto-detection for Samsung and generic DNG

Your layer will only stay “extensively controllable” if it begins with a **deterministic classification** step that can also be overridden.

A robust classification can be built from DNG tags:

If the DNG’s raw IFD uses the CFA photometric interpretation, the spec requires use of `CFARepeatPatternDim` and `CFAPattern`, and defines how the CFA origin is established. citeturn6view2 This is your “mosaic pipeline” branch.

If the DNG indicates **LinearRaw**, the spec states it is intended for sensors that capture all components per pixel and “can also be used for CFA data that has already been de-mosaiced.” citeturn6view2 This is your “linear pipeline” branch, which should skip demosaic and focus on WB/color/tone/denoise/sharpen.

If the CFA repeat pattern is not 2×2 (common Bayer), you likely need a **remosaic stage**—the general need for this is supported by the quad-Bayer literature describing remosaicing + denoising as a necessary step to convert quad patterns into ISP-friendly Bayer patterns, especially under mixed noise. citeturn15search2turn14search7 This is your “quad/nona → Bayer → demosaic” branch.

If `RowInterleaveFactor`/`ColumnInterleaveFactor` are used, DNG can store mosaic data as multiple subimages for compression convenience, and the spec provides an example mapping of a Bayer mosaic into four monochrome subimages. citeturn6view4 This is an “unpack layout” sub-branch that must happen before any demosaic/remosaic.

If the DNG uses **JPEG XL** compression, the spec documents the conditions and required fields for JPEG XL in DNG, and your decoder must handle it; additionally, the JPEG XL core system is standardized by the entity["organization","International Organization for Standardization","standards body"] (ISO/IEC 18181-1:2024 is the current published edition). citeturn6view1turn18search9

This classification should produce an **auto-preset** (“Samsung Expert RAW Linear,” “Samsung Pro Mode Mosaic,” “Quad Bayer Mosaic,” etc.) but must also expose an override panel so the user can force interpretation. That matters because Samsung’s own documentation confirms multiple output behaviors across modes (e.g., Expert RAW’s computational linear DNG versus other RAW modes). citeturn11view1turn21view0

## Rendering pipeline design in GLSL with quality-preserving controls

The most important quality decision is **where precision is lost**. If you want a workflow that remains meaningfully “lossless” relative to the stored DNG samples and your chosen processing settings, you must:

Decode to the DNG’s stored numeric domain first (often 12–16 bit integer; sometimes 16-bit float) and keep intermediate buffers as **16F/32F textures** until final output transform. DNG explicitly supports floating-point image data, and it defines multiple compression methods that apply to 16-bit spaces, including JPEG XL. citeturn10view1turn6view1

Use metadata-driven normalization: subtract black levels, scale to white level, apply linearization table when present, then demosaic/remosaic. Android’s Camera2 documentation (relevant for “pure RAW_SENSOR DNGs” created by apps) highlights that black levels and white levels are critical for interpreting RAW, and it recommends using optical black regions/dynamic black level for accuracy when supported. citeturn16search3turn18search7

Drive denoise from a noise model rather than a fixed slider. DNG’s `NoiseProfile` encodes a two-parameter shot/read model and describes usage for unprocessed raw as well as residual noise when noise reduction has already been applied. citeturn8view1turn8view2

A practical, shader-friendly develop graph (mosaic case) is: raw normalization → optional remosaic → demosaic → WB + camera-to-XYZ + working conversion → denoise → highlight recovery + tone mapping → output transfer (sRGB/P3/linear) → optional output sharpening. This matches the natural separation between “sensor/format interpretation” stages and “look/creative” stages. citeturn6view2turn8view1turn8view0

For demosaic and denoise algorithm options, you can support multiple quality levels:

A commonly used “high quality but still structured” demosaic is a 5×5 linear interpolation approach that improves PSNR over bilinear while remaining computationally reasonable—suitable for GLSL or WASM kernels. citeturn13search0turn13search48 For “offline HQ,” you can add more advanced edge-aware or residual-interpolation variants (the literature contains many), but the 5×5 linear method is a good baseline given your desire for predictable tuning. citeturn13search0turn14search4

For denoise, your real-time-ish GLSL baseline can use edge-preserving filters like bilateral filtering and guided filtering; guided filtering is widely used as an edge-preserving operator and is explicitly proposed as an efficient alternative to bilateral in many imaging pipelines. citeturn13search11turn13search9 For “slow but best,” BM3D-style approaches are a known high-quality reference, but implementing them in pure GLSL is complex; they’re better as a worker/WASM optional path. citeturn13search2

To align with Samsung “computational RAW” cases (Expert RAW), your layer should be capable of running **without demosaic** (linear branch) and should default denoise/sharpen to “gentle,” because Samsung explicitly describes multi-frame noise reduction/HDR at capture time in Expert RAW contexts. citeturn12view0turn22view2

## Worker/WASM architecture, codecs, and lossless PNG export

Your browser pipeline needs two separate “hard” components: DNG decoding (including compression) and high-bit-depth export.

On decode: Android’s `DngCreator` is designed around `RAW_SENSOR` buffers and describes DNG as storing pixel data with minimal preprocessing and metadata sufficient for subsequent conversion. citeturn18search4turn18search7 That means third-party “true raw capture” DNGs will often be closer to textbook mosaic, but Samsung’s own DNGs can be linear/computational; your decoder must therefore prioritize DNG tags over assumptions. citeturn6view2turn12view0

You should implement decoding in a worker (and optionally WASM) because:

DNG can use JPEG XL compression, and the DNG spec allows it for both CFA and LinearRaw contexts, with additional parameters like decode speed/effort. citeturn6view1turn6view4 JPEG XL decoding in practice is commonly powered by `libjxl`, the reference implementation. citeturn17search2turn17search5 A worker/WASM boundary is also consistent with your app’s documented direction: background tasks should use the shared worker runtime and emit log/progress events. (This constraint is captured in the plan file, sourced from your provided architecture document.)

For broader DNG coverage, a dedicated raw library can help. LibRaw explicitly positions itself as a RAW decoding library supporting DNG among many formats, designed for embedding in raw converters. citeturn17search0 This can be a “future expansion” option if you later want robust support for a wide variety of cameras beyond Samsung—at the cost of integrating its opinions into your “expose everything as parameters” paradigm. citeturn17search0

If you choose to rely on the official DNG SDK from entity["organization","Adobe","software company"], note that Adobe describes the SDK as supporting reading/writing DNG and converting DNG data into forms that are easily displayed or processed by applications, and the download page is kept current with security-related updates. citeturn3view0turn18search8turn18search5 In practice, that strengthens the case for “use the SDK as a reference decoder for validation,” even if you don’t ship it in-browser. citeturn18search8turn3view0

On export: “lossless PNG” has two distinct meanings:

PNG encoding itself is lossless, but if you export via the typical browser canvas pipeline you will usually quantize into 8-bit per channel. To keep the developed result high-fidelity, your export must support 16-bit PNG where desired (and keep correct color-space tagging). Your plan should therefore include a WASM PNG encoder path rather than relying on browser canvas export. (The DNG spec’s emphasis on 16-bit integer and floating-point data, and Samsung’s own “16-bit linear DNG” messaging, are what make 16-bit PNG export valuable here.) citeturn6view1turn21view0turn22view0

## Deliverable plan file and milestones

The attached plan file is written as an implementation-oriented spec that follows your site’s existing patterns: registry-driven Editor layers, a provider-driven Layer-tab preview system, the shared worker runtime (with log/progress), and the Editor/Library WASM packaging constraints captured in your context document.

[Download the implementation plan (text file)](sandbox:/mnt/data/DNG_Develop_Layer_Implementation_Plan.txt)

The milestones are structured so you can validate the riskiest unknowns early by inspecting real DNGs:

Early validation focuses on (a) parsing/classification, (b) compression support (especially JPEG XL), and (c) confirming whether your “mosaic vs linear vs quad/nona” detector matches Samsung’s actual files, which is critical because Samsung explicitly supports multi-frame computational linear DNG in Expert RAW while also describing remosaic stages for high-res sensors. citeturn22view0turn19view0turn20view2turn12view0