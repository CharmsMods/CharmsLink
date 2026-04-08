# Modular Studio V2: 3D Scene Tab — Build Plan

## 1) Product goal
Intregrate a browser-based 3D scene editor and renderer as a fourth top-level section in **Modular Studio V2**, alongside **Editor**, **Library**, and **Stitch**.

The 3D section will feature two working modes:

- **Setup mode** (Raster): High-performance scene assembly and interaction.
- **Render mode** (Path Tracing): High-quality final output with progressive sampling.

The workspace will follow the Studio aesthetic: **full-screen viewport first**, with **minimal floating controls** layered on top of the scene.

## 2) Core scope
The app should support:

- Loading multiple 3D models at once.
- At minimum: **.glb / .gltf**.
- Optional additional loaders for common formats: **.obj, .fbx, .stl, .ply**.
- Per-object transforms:
  - position
  - rotation
  - scale
  - reset each transform axis group back to default
- Object selection in the scene.
- Camera movement.
- A “center camera on selected object” action.
- Scene lights that can be added, removed, selected, moved in 3D, and edited.
- A renderer toggle between raster mode and path tracing mode.
- A path-tracing sample counter and render controls.

## 3) Recommended technical foundation

### Rendering / scene framework
Use a browser 3D engine that already solves the hard platform parts:

- Scene graph
- Asset loading
- Camera controls
- Ray picking
- Gizmo-based transforms
- Lighting helpers
- WebGL rendering for setup mode

### Integration Architecture
To fit into the existing Modular Studio V2 ecosystem (see `ai_context.txt`):

- **New Section**: Registered as `'3d'` in `state.ui.activeSection`.
- **Workspace**: Implemented in `src/ui/workspaces.js` and `src/3d/ui.js`.
- **Project Adapter**: A new `3d` adapter in `src/io/projectAdapters.js` to allow saving 3D scenes, light setups, and camera presets directly to the integrated **Library**.
- **Engine**: A dedicated `src/3d/engine.js` managing the three.js/path-tracing instance.

## 4) File format support strategy

### Tier 1: first-class support
1. **glTF / GLB**
   - This should be the main supported format.
   - Best interoperability and best match for modern web pipelines.
   - Native support for common PBR material data.

### Tier 2: secondary support
2. **OBJ**
3. **FBX**
4. **STL**
5. **PLY**

These should be treated as import formats, not the primary authoring format. Internally, normalize them into a common scene representation so the editor behaves consistently.

## 5) Scene model and object hierarchy
Represent every loaded asset as a top-level **SceneItem** with:

- unique ID
- display name
- source file type
- root transform node
- children mesh nodes
- material references
- bounding box / bounding sphere cache
- visibility flag
- selection flag
- lock flag
- render-layer / grouping tag

Each imported model should be wrapped in a parent transform node so the user can reset the whole object cleanly without destroying the actual mesh data.

## 6) Camera system

### Navigation modes
Use one camera, with Orbit-style interaction for normal scene inspection.

Camera features:
- orbit around target
- pan
- zoom / dolly
- frame selected object
- reset view
- optional focal distance display

### Center-on-object behavior
When the user chooses “center on selected object”:
- compute the object bounds
- move the orbit target to the object center
- reposition the camera so the object fits comfortably in frame
- preserve view direction when possible

### Helpful camera UI
- FOV slider
- near/far plane controls
- orbit target readout
- reset camera button
- frame selected button

## 7) Object selection and transforms

### Selection
Selection should work by clicking in the viewport using ray picking.

When an object is selected:
- highlight it
- show transform gizmo
- show object inspector controls
- show quick actions: frame, hide, duplicate, delete, reset transforms

### Transform editing
Provide three transform modes:
- move
- rotate
- scale

Expose both gizmo controls and numeric input fields.

### Reset transforms
Each object should support:
- reset position to 0, 0, 0
- reset rotation to 0, 0, 0
- reset scale to 1, 1, 1
- optional “reset all transforms” button

## 8) Lights system
Support a small but complete light toolset.

### Light types to start with
- directional light
- point light
- spot light
- hemisphere light
- environment lighting via HDRI / background map

### Light editing actions
Each light should be selectable and editable like an object:
- move in 3D space
- rotate if directional or spot
- change intensity
- change color temperature / color
- change shadow softness if supported
- toggle shadows on/off
- duplicate
- delete
- reset transform

### Light helpers
Use visible helpers for setup mode:
- gizmo icon
- light direction indicator
- cone/frustum for spot lights
- shadow/frustum helper when useful

## 9) Raster mode
This is the working mode for scene assembly.

### Raster mode responsibilities
- fast frame rate
- live object manipulation
- live light manipulation
- live camera movement
- material preview
- drag-and-drop loading
- selection and inspector UI

### Raster mode quality settings
- anti-aliasing
- shadow quality
- tone mapping
- exposure
- environment intensity
- background on/off
- grid on/off
- axis helper on/off

Raster mode should always update immediately when the user changes transforms or lights.

## 10) Path tracing mode
This is the high-quality render mode.

### Path tracing responsibilities
- accumulate samples across frames
- display current sample count
- optionally render at a lower interactive resolution while converging
- allow restart/reset when scene or camera changes
- support toggling back to raster mode instantly

### Path tracing controls to expose
- sample count target
- current accumulated samples
- bounce count
- render scale
- denoise toggle if implemented later
- environment intensity
- tone mapping/exposure
- tile rendering toggle or tile count for responsiveness
- start / pause / reset render
- “render from current camera” button

### Important path tracing behavior
Any change to the scene that affects lighting, geometry, materials, or camera should trigger a reset of accumulation.

That includes:
- camera move
- object transform change
- light added/removed
- light moved
- material edited
- object loaded/unloaded
- environment map changed

## 11) Practical path tracing architecture
The path-traced renderer should not be a separate disconnected system. It should read from the same scene state as raster mode.

Recommended approach:
- Use the same scene graph and asset registry.
- Build the path tracer from scene data on mode switch.
- Keep a dedicated render state for:
  - accumulated samples
  - reset state
  - resolution scaling
  - current render target

### Key implementation rule
The path tracer should only become active when the user switches to render mode; raster mode should remain the editing ground truth.

## 12) Suggested settings panel structure
Keep the UI small and floating. Group controls into narrow floating panels.

### Panel A: Scene
- load model
- import multiple files
- scene name
- background toggle
- environment map picker
- grid toggle
- axis helper toggle
- reset whole scene

### Panel B: Objects
- object list
- search/filter objects
- selection
- visibility toggle
- lock toggle
- duplicate
- delete
- reset transform
- position / rotation / scale fields
- frame selected

### Panel C: Lights
- add light
- light list
- type selector
- color
- intensity
- distance / angle / penumbra depending on type
- cast shadows toggle
- reset light transform

### Panel D: Camera
- orbit/pan mode info
- FOV
- near/far
- frame selected
- reset camera
- center camera on object
- save view preset

### Panel E: Renderer
- raster / path trace toggle
- sample target
- current samples
- bounce count
- render scale
- pause/resume accumulation
- reset accumulation
- exposure
- tone mapping

### Technical Integration Detail
- **Store**: Uses a new `state.threeDDocument` field (following the `stitchDocument` pattern).
- **Communication**: Section switching will be handled by `actions.setActiveSection('3d')`.
- **Loading**: Drag-and-dropping `.glb` files into the 3D workspace will trigger the loader.

## 14) Interaction model

### Mouse / touch behavior
- click to select
- drag gizmo to move/rotate/scale
- drag empty space to orbit camera
- wheel to zoom
- modifier keys for panning / alternate actions

### Shortcuts
- W / E / R for move / rotate / scale
- F to frame selected
- Delete to remove selected object
- Ctrl/Cmd+Z for undo
- Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z for redo
- R for reset selected transforms depending on focus context

## 15) Undo / redo
This should be included early because scene editing becomes painful without it.

Track undoable actions:
- load object
- delete object
- add light
- delete light
- transform change
- camera preset save/load
- selection changes if needed
- mode changes optionally

## 16) Implementation phases

### Phase 1 — foundation
- full-screen viewport
- scene/store structure
- camera controls
- raster renderer
- file loading for glTF/GLB
- object picking
- selected object inspector

### Phase 2 — editing
- transform gizmos
- reset transforms
- multiple model support
- object list
- light creation/editing
- camera framing
- undo/redo

### Phase 3 — renderer modes
- raster/path-trace toggle
- accumulation state
- sample count display
- reset on scene changes
- performance controls

### Phase 4 — quality and polish
- environment lighting
- helpers / overlays
- preset system
- export scene state
- better format support beyond glTF
- path tracing optimizations

## 17) Biggest risks

### Path tracing risks
- performance drops on complex meshes
- memory pressure from large textures/models
- slow convergence on glossy or noisy scenes
- material feature mismatches between raster and path-traced rendering
- need for BVH acceleration for ray queries

### Editing risks
- transform state drifting between UI and scene
- selection confusion between objects and lights
- camera controls fighting with gizmos
- mode-switch bugs if raster and path-traced scenes are not kept in sync

## 18) Recommendation for the first version
Ship this in a narrow but solid first release:

- glTF / GLB support first
- multiple model loading
- selection and transform editing
- light add/remove/move
- orbit camera + frame selected
- raster mode
- path tracing mode with sample count and reset
- floating overlay UI

That gives you a usable editor without overbuilding the import pipeline too early.

## 19) Best implementation choice
For a browser app with this feature set, the most realistic route is:

- **three.js** for the editor layer and raster mode.
- **Integrated Project Adapter** for Library persistence.
- **Shared scene state** (`threeDDocument`) so both render modes stay in sync.

That combination gives you the highest chance of getting a working result without reinventing the entire 3D stack.

