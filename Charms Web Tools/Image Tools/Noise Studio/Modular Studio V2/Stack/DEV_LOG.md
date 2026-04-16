# Development Log

*This log safely tracks active completions, major structural shifts, and immediate next steps so that any developer/AI context block can pick up directly where the code was left off.*

## [Current Phase]
**Stage:** Dynamic Workflow & Modular Scoping
**Current Focus:** Implementing Library module and asset persistence layers.

---

### [2026-04-15] - Viewport Interaction & Pipeline Logic
- **Completed:** Implemented "Only Render Up To Active Layer" in the Canvas tab. This slices the processing pipeline in real-time based on the user's selection in the stack.
- **Completed:** Added Advanced Viewport Zoom. Users can scroll to zoom in/out (up to 100x magnification).
- **Completed:** Implemented "Smart Pan" where the zoomed-in view tracks the mouse position naturally, allowing for quick inspection of different image regions.
- **Completed:** Added "L" Hotkey to lock/unlock viewport transformation (Zoom level and Pan position).
- **Completed:** Implemented "Hover to Compare" logic in the viewport. When the user hovers over the canvas, the processed stack fades out smoothly to reveal the original source image.
- **Completed:** Implemented Intelligent Layer Naming. Adding multiple instances of a module (e.g. Blur) now automatically suffixes them with `(2)`, `(3)`, etc.
- **Completed:** Converted the rendering pipeline from hardcoded to fully dynamic. Users now start with an empty stack and add layers as needed.
- **Completed:** Implemented Drag-and-Drop layer reordering in the `PipelineTab`. Sequential order is updated in real-time on the GPU.
- **Completed:** Scaffolded the "Program Context Tabs" (Editor, Library, Composite, 3D Studio) at the root level.
- **Completed:** Scoped the Editor UI into a self-contained "Workspace" window with its own internal docking logic, separating its concerns from future modules.
- **Completed:** Updated `LayersTab` for high-efficiency workflow (flat listing of all modules with one-click injection).

### [2026-04-15] - Engine Pipeline & First Layers
- **Completed:** Implemented the `RenderPipeline` using sequential ping-pong Framebuffer Objects (FBOs). This strictly enforces the "Layer N+1 only sees Layer N" architecture.
- **Completed:** Integrated `stb_image` for native CPU image decoding and OpenGL texture creation.
- **Completed:** Implemented `GLLoader` a custom lightweight OpenGL extension loader using `glfwGetProcAddress` to eliminate external dependencies (GLAD/GLEW).
- **Completed:** Built functional UI for `CanvasTab` including a native Windows File Dialog (`comdlg32`) for image loading.
- **Completed:** Implemented the first 3 chronological rendering modules:
  1. `CropTransformLayer`: Crop, 360° Rotate, Flip H/V.
  2. `AdjustmentsLayer`: Brightness, Contrast, Saturation, Warmth, Sharpening.
  3. `VignetteLayer`: Intensity, Radius, Softness, Color.
- **Completed:** Wired the `SelectedTab` inspector to directly control live GPU uniforms for the active layer.
- **Completed:** Successfully compiled the full native application with real-time GPU processing.

### [2026-04-15] - Editor UI Layout Initialization
- **Completed:** Validated zero-setup CMake execution and GLFW/ImGui dockspace rendering natively with the user.
- **In Progress:** Structuring the core `Editor` module. Creating strictly partitioned class files for the layout (Sidebar, Viewport, and the 5 sub-tabs) to maintain high organization and prevent monoliths.
  
### [2026-04-15] - Engine Scaffolding
- **Completed:** Generated the completely separated `/Stack/` root directory.
- **Completed:** Created `AI_CONTEXT.md` and `DEV_LOG.md` strictly separating the codebase from the Web environment legacy code.
- **Completed:** Scaffolded a Zero-Setup `CMakeLists.txt` relying on `FetchContent` to safely download GLFW and ImGui natively via Git, eliminating local dependency configuration headaches.
- **Completed:** Built `main.cpp` entrypoint and mapped a decoupled `AppShell` architecture.
