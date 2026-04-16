# Modular Studio: Stack (Native Rebuild) - AI Context

## Project Goal
A high-performance C++ rewrite of Modular Studio V2, transitioning from a web-based Canvas/WebGL node architecture into a purely native OpenGL application using ImGui for the interface. 

## Architectural Directives
1. **Separation of Concerns:** 
   - UI (ImGui) is completely decoupled from rendering logic.
   - The Shell manages overarching states, routing between main modules (Editor, Library, Composite, 3D).
2. **Editor Linear Pipeline:**
   - The Editor acts as a chronological node-stack. Layer N+1 strictly processes the output of Layer N.
   - Textures and Framebuffers must be intelligently pooled/managed to avoid VRAM exhaustion.
3. **Dependencies:**
   - C++17 Standard
   - GLFW (Window & Input Context)
   - OpenGL 3 (Rendering Pipeline)
   - Dear ImGui (Docking branch for Workspace layout)
   - **GLLoader**: A custom built-in extension loader using `glfwGetProcAddress` (replaces GLAD/GLEW).
   - **stb_image**: Native image decoding.
   - *Note: External dependencies like GLFW and ImGui are managed transparently via CMake `FetchContent` to guarantee simple "one-click" building without local environment mess.*

## [Current Capabilities]
- **Image Pipeline**: Sequential ping-pong FBOs processing 2D textures.
- **Image Loading**: Supports PNG, JPG, BMP, TGA, GIF.
- **Layers**: 
  - `CropTransformLayer` (Spatial)
  - `AdjustmentsLayer` (Color/Contrast)
  - `BlurLayer` (Gaussian/Box)
  - `NoiseLayer` (Procedural Grain)
  - `VignetteLayer` (Finalization)
- **UI Architecture**: Fully docked sidebar/viewport architecture with real-time uniform binding.

## Build Instructions (For AI and User)
- Configure: `cmake -B build`
- Build: `cmake --build build --config Release`
- Run Application: `.\build\Release\ModularStudioStack.exe` (or `.\build\Debug\...` depending on VS generator).
