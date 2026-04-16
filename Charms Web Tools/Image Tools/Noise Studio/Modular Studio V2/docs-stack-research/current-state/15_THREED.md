# The 3D Engine

## 1. Purpose
This document describes the 3D section — a full interactive 3D scene editor and renderer built on Three.js and three-gpu-pathtracer. It is the most complex rendering engine in the application, supporting real-time rasterization, progressive path tracing, mesh wireframe view, and multiple camera modes. The 3D section uses the "Workstation Style" design language (see `27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md`).

## 2. Scope
This file covers `src/3d/document.js` (data model), `src/3d/engine.js` (rendering engine), and the supporting modules (`environment.js`, `text.js`, `viewMath.js`, `assetPreview.js`). UI details in `src/3d/ui.js` are covered at a high level. The MLT (material library template) subdirectory is noted but not deeply inspected.

## 3. Verification State
- **Verified from Source:**
  - `src/3d/document.js` (complete 501 lines: all constants, normalization functions, serialization, document creation, ID generation, summary)
  - `src/3d/engine.js` (first 800 lines: Three.js setup, path tracer integration, camera system, controls, lighting, asset loading pipeline, decoder setup)
  - `src/settings/defaults.js` → `threeD` settings block (preferences, defaults)
  - `src/settings/schema.js` → threeD normalization
  - `src/settings/apply.js` → `applyThreeDSettingsToDocument`, `createSettingsDrivenThreeDDocument`
- **Inferred Behavior:** The full scene sync pipeline (lines 800–2491 of engine.js) was not read. Item material application, background render jobs, and the full export pipeline are inferred from the constructor setup and document model.

## 4. Cross-System Dependencies
- **Three.js Ecosystem:** Depends on `three`, `three/addons` (OrbitControls, TransformControls, GLTFLoader, DRACOLoader, KTX2Loader, RGBELoader), `three-mesh-bvh` (accelerated raycasting), and `three-gpu-pathtracer` (WebGLPathTracer, DenoiseMaterial).
- **Library Storage:** 3D documents are saved as `3d-document` kind payloads to the Library.
- **Settings Integration:** Preferences (camera mode, navigation mode, FOV, near/far, gizmo scale, snap settings, viewport resolution cap) and defaults (path tracing bounces, samples, denoising) flow from `settings.threeD.*`.
- **Font/HDRI Assets:** 3D documents embed font and HDRI assets as data URLs in `document.assets.fonts[]` and `document.assets.hdris[]`. These are separate from the Library's asset store.
- **Log Engine:** The 3D engine emits asset pipeline messages (decoder status, loading progress) via `onAssetPipelineMessage` callback, which connects to the shared log system.

## 5. State Behavior
- **Saved (Durable):**
  - `document.scene.items[]` — The scene graph: models, image-planes, lights, primitives, text, shape-2d items. Each has transform (position, rotation, scale), visibility, lock, and kind-specific payloads.
  - `document.scene.backgroundColor`, `showGrid`, `showAxes`, `worldLight` (solid/gradient/HDRI environment).
  - `document.assets` — Embedded fonts and HDRIs as data URLs.
  - `document.view` — Camera position/target, FOV, projection, navigation mode, camera presets.
  - `document.render` — Render mode (raster/pathtrace/mesh), samples, bounces, exposure, tone mapping, output dimensions, denoise settings.
  - `document.workspace` — Active panel tabs per task view (layout/model/render).
  - `document.selection` — Selected item ID.
  - `document.preview` — Last rendered preview as imageData + dimensions.
- **Runtime-only:**
  - Three.js objects: `Scene`, `Camera`, `Renderer`, `PathTracer` instances and all GPU state.
  - Control state: orbit/fly mode, transform gizmo dragging, fly camera key/pointer state.
  - Asset caches: `sceneObjects` Map, `textureCache`, `hdriCache`, decoded GLTF objects.
  - Path tracer warmup/loading state, viewport denoise cadence timers.
  - `renderJob` status (active, running, complete, aborted, error) with timing metadata.
- **Derived/Cached:**
  - World environment textures (regenerated when worldLight parameters change).
  - Path tracer scene BVH (rebuilt on scene graph changes).
  - Object bounding boxes for selection and camera framing.

---

## 6. Current Behavior

### 6.1 Document Model (`src/3d/document.js`)
**[VERIFIED]** The document model defines an extensive set of enumerations:

| Category | Allowed Values |
|---|---|
| Item Kinds | `model`, `image-plane`, `light`, `primitive`, `text`, `shape-2d` |
| Light Types | `directional`, `point`, `spot` |
| Primitive Types | `cube`, `sphere`, `cone`, `cylinder` |
| Shape 2D Types | `square`, `circle` |
| Material Presets | `original`, `matte`, `metal`, `glass`, `emissive` |
| Render Modes | `raster`, `pathtrace`, `mesh` |
| Tone Mappings | `aces`, `neutral`, `none` |
| Camera Modes | `orbit`, `fly` |
| Projections | `perspective`, `orthographic` |
| Navigation Modes | `free`, `canvas` |
| Text Modes | `flat`, `extruded` |
| World Light Modes | `solid`, `gradient`, `hdri` |

Every field has strict normalization with type coercion, range clamping, and fallback defaults. The normalizer runs recursively over all sub-objects (items, materials, textures, lights, text, workspace).

**[VERIFIED]** The workspace model uses a task-view architecture: `layout`, `model`, `render`. Each task view has independent left/right panel tab selections (`WORKSPACE_LEFT_TABS`: outliner/add/views, `WORKSPACE_RIGHT_TABS`: selection/scene/render).

### 6.2 Scene Items
**[VERIFIED]** Each item has a common base:
- `id` — UUID with kind-specific prefix.
- `kind` — One of the item kinds.
- `name` — Display label.
- `visible`, `locked` — Boolean flags.
- `position`, `rotation`, `scale` — Vec3 transforms.

Kind-specific extensions:
- **Model:** `asset` (GLB/GLTF data URL, format, mime), `material` (preset, color, roughness, metalness, opacity, emissive, texture, glass properties).
- **Image Plane:** `asset` (image data URL, width, height), `material`.
- **Primitive:** `asset` (primitiveType), `material`.
- **Light:** `light` (lightType, targetItemId, color, intensity, distance, angle, penumbra, decay, castShadow).
- **Text:** `text` (content, mode flat/extruded, fontSource system/upload, color, opacity, glow, characterOverrides with per-char flipX/flipY, extrude geometry params, attachment to surface).
- **Shape 2D:** `shape2d` (type, color, opacity, glow).

### 6.3 Rendering Engine (`src/3d/engine.js`)
**[VERIFIED]** The engine is a class (`ThreeDEngine`) constructed with a container DOM element. Construction initializes:

1. **Three.js Renderer:** `WebGLRenderer` with antialiasing, alpha, preserveDrawingBuffer. Appended to the container with absolute positioning.
2. **Dual Cameras:** `PerspectiveCamera` and `OrthographicCamera`, switchable via `setActiveProjection()`.
3. **Path Tracer:** `WebGLPathTracer` from `three-gpu-pathtracer` with tile rendering (2×2), configurable bounces, transmissive bounces, and filter glossy factor.
4. **Denoise Pass:** `DenoiseMaterial` + `FullScreenQuad` for real-time viewport denoising with configurable sigma, threshold, kSigma.
5. **Controls:** `OrbitControls` for orbit mode, `TransformControls` for gizmo manipulation. Fly camera mode is implemented manually via pointer/key event handlers.
6. **Scene Fixtures:** Grid helper, axes helper, ambient light, directional key light — all registered as "editor objects" excluded from path tracing.
7. **Asset Loaders:** `GLTFLoader` with optional `DRACOLoader` and `KTX2Loader` for compressed formats, `RGBELoader` for HDRI files, `TextureLoader` for image textures.
8. **ResizeObserver:** Monitors container size for responsive viewport updates.

### 6.4 Camera System
**[VERIFIED]** Two camera modes:
- **Orbit:** Standard `OrbitControls` with damping. Middle-click dolly, right-click pan (in `free` navigation) or left-click pan (in `canvas` navigation).
- **Fly:** Custom FPS-style camera. Pointer-lock on right-click for look, WASD/QE for movement, configurable speed and sensitivity.

**[VERIFIED]** The `canvas` navigation mode replaces orbit rotation with pan, making the left mouse button pan instead of rotate. The `wheelMode` setting controls whether the scroll wheel performs `travel` (move camera forward/back) or `zoom` (dolly in/out).

Camera presets can be saved/restored. Each preset stores: position, target, FOV, projection, orthoZoom.

### 6.5 Render Modes
**[VERIFIED]** Three viewport render modes:
- **Raster:** Standard Three.js WebGL rendering with ambient + directional lights.
- **Pathtrace:** Progressive path tracing via `three-gpu-pathtracer`. Samples accumulate over frames with an adaptive cadence system (budget: 22ms per sample, cooldown: 16–96ms). Viewport denoising runs every 4 samples or 120ms.
- **Mesh:** Wireframe view using a shared `MeshBasicMaterial` with wireframe mode.

**[VERIFIED]** Viewport resolution is capped differently per mode: `EDIT_VIEW_MAX_PIXEL_RATIO = 1.25` for raster/mesh, `PATH_TRACE_VIEW_MAX_PIXEL_RATIO = 1` for path tracing. The `viewportHighResCap` setting can disable this cap.

### 6.6 Background Render Jobs
**[INFERRED]** The document model includes a `renderJob` object with fields: active, status (idle/running/complete/aborted/error), requestedSamples, currentSamples, outputWidth, outputHeight, startedAt, finishedAt, fileName, message. This suggests an asynchronous render-to-file workflow where the path tracer accumulates a target number of samples at a specified output resolution, then exports to PNG.

### 6.7 World Lighting
**[VERIFIED]** Three environment modes:
- **Solid:** Single color environment.
- **Gradient:** Multi-stop gradient mapped to an equirectangular environment texture via `createGradientEnvironmentTexture()`.
- **HDRI:** User-uploaded `.hdr` file loaded via `RGBELoader`, stored as `document.assets.hdris[]`.

The `backgroundVisible` flag controls whether the environment is visible as scene background or only used for lighting.

### 6.8 Text in 3D
**[VERIFIED]** Text items support two modes:
- **Flat:** 2D text rendered as a plane mesh (`createFlatTextObject()` in `src/3d/text.js`).
- **Extruded:** 3D text geometry with configurable depth, bevel size/thickness/segments (`createExtrudedTextObject()`). Requires an uploaded font (type: `upload` with assetId referencing `document.assets.fonts[]`). Falls back to flat mode if no uploaded font is available.

Text supports surface attachment: a `targetItemId` + local position/normal/tangent + offset, computed by `resolveAttachmentTransform()` in `src/3d/viewMath.js`.

### 6.9 Compressed Asset Pipeline
**[VERIFIED]** The engine initializes DRACO and KTX2 decoders at construction time:
- DRACO: `DRACOLoader` with decoder path pointing to `src/vendor/three/addons/libs/draco/`.
- KTX2: `KTX2Loader` with transcoder path pointing to `src/vendor/three/addons/libs/basis/`.
Both are optional and track availability in `decoderAvailability`.

---

## 7. Open Questions & Verification Gaps
- The full scene sync pipeline (how document changes map to Three.js object mutations) spans lines 800–2491 of `engine.js` and was not fully read. This includes material application, item add/remove/update, and animation.
- The background render job execution logic (how it differs from viewport path tracing) needs deeper verification.
- The `src/3d/mlt` subdirectory (material library/templates) was not inspected.
- The `src/3d/ui.js` (209KB) workspace UI was not deeply read. Panel layout, property editors, and toolbar interactions are inferred from the document model.
- `countLegacyThreeDBooleanCuts()` suggests a deprecated boolean CSG feature. Whether any UI still references this is unknown.
