# Product Model

## 1. Purpose
This document explains the high-level architecture of Modular Studio V2 as a product. It outlines the core structure of the application, how its major sections are organized, and what each section is responsible for.

## 2. Scope
This file covers the 7 top-level sections of the app and their fundamental responsibilities. It explicitly excludes the internal runtimes (such as how the 3D scene is rendered or how Editor WebGL works), routing these details to their respective domain documents.

## 3. Verification State
- **Verified from Source:** 
  - `src/ui/workspaces/index.js`
  - `index.html`
- **Inferred Behavior:** N/A (Confirmed via workspace structure and routing constants).

## 4. Cross-System Dependencies
- **Entry Points:** Driven directly by `src/main.js` and `src/app/bootstrap.js`.
- **The Shell:** Managed by `src/ui/workspaces/index.js`, which relies on the state model (`state.ui.activeSection`) to switch views.

## 5. State Behavior
- **Saved (Durable):** None at this level. The active section is not a durable user preference and does not serialize into project payloads.
- **Runtime-only:** The currently active section (`state.ui.activeSection`) dictates what the user sees upon load, usually driven by URL parameters (e.g. `?section=library`), and disappears on fresh reloads.

---

## 6. Current Behavior 

Modular Studio V2 is a single-page application (SPA). All application tools, libraries, and engines live inside the same JavaScript runtime and are presented on the same HTML page over a unified shell. 

### The 7-Section Model
The product surfaces seven primary sections, accessible via the top-level app header:

1. **Library**
   - An integrated browsing surface backed by IndexedDB.
   - Responsible for unified storage of mixed project types (Editor, Composite, 3D, Stitch) and independent 3D/image assets.
2. **Editor**
   - The foundational WebGL image-processing engine.
   - Built around a persistent base canvas that accepts image sources (including raw `.dng` files) and applies a layer stack of adjustments, textures, and custom effects (such as text overlays).
3. **Composite**
   - A 2D composition engine for organizing generated assets.
   - Supports importing saved Editor projects, raw images, text, and flat shapes into a shared world-space, outputting bounded exports.
4. **3D**
   - A browser-based three.js scene workspace.
   - Supports `.glb`/`.gltf` importing, lighting, materials, rendering preview captures, and path tracing for physically based PNG exports.
5. **Stitch**
   - An overlap-first panorama processing tool.
   - Uses completely distinct rendering engines and worker processes (JS Canvas + OpenCV WASM) to correlate, warp, and blend arrays of images together into wide stitches.
6. **Logs**
   - A runtime diagnostics surface. 
   - Exposes in-memory process streams (like 'Workspace Boot', 'DNG Worker', 'Library Sync') allowing users to see what the app is doing asynchronously.
7. **Settings**
   - The app's preferences surface.
   - Maintains preferences outside of the single-document state, managing global behaviors like styling palettes, WebWorker constraints, UI density, and system limits.

### Single Runtime, Multiple Contexts
Although the application is a single page, the Editor and Stitch engines keep their own local drafts in memory simultaneously. If you open a project in the Editor, switch to the Stitch tab, build a panorama, and switch back to the Editor, the Editor's draft is preserved seamlessly. 
They do *not* force a "save before you switch" prompt, as they maintain isolated slices of `state.document` versus `state.stitchDocument`. Replacement prompts occur only if you try to load a *new* document into the same engine that already has unsaved work.

---

## 7. Open Questions & Verification Gaps
- None at this structural level. The top-level product arrangement is fully verified against the workspace manager.
