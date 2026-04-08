The goal:
to build a new top-level section called "Composite" (managed via `state.ui.activeSection = 'composite'` and a new `state.compositeDocument` store) that can take multiple images and layer them on top of each other, with options to adjust the opacity, blend mode, and position, rotation, and scale, for each image. 

Important build notes:
- The new tab should communicate with 3 other tabs all important it's functionality.

1st:
The Editor Tab, we are going to shift from the editor tab being it's own thing, to being a sub component of the new Composite tab. 
The way this will work:
The Editor tab currently outputs a rendered image from a pipeline, and that pipeline, original image, and settings, are all saved in a json file in the library (under `kind: 'document'`, `mode: 'studio'`). The new composite tab will have a button allowing the user to add any Editor projects to the canvas. When the user clicks on this button, a popup will appear (interfacing with the IndexedDB Library via the project adapter registry in `src/main.js`), with all Editor projects that currently exist in the library, and the user can pick and choose 1 or more editor projects to put on the canvas. To optimize this, the site can utilize the embedded `preview` PNG that Editor now auto-generates in its self-contained JSON payloads, or call the `src/engine/` WebGL render pipeline headlessly to render out each image before putting it on the canvas. When all images are loaded, the tab is ready for the user to start compositing.

Also talking about the Compositing tab being heavily connected to the Editor tab, any time the user clicks an object on the canvas on the composite tab, it will open the editor tab and load the editor tab's settings and pipeline to match the object that was clicked on IF that object was a editor project (by populating `state.document` with the project's payload and switching `state.ui.activeSection = 'editor'`). If its not an editor project, then just treat it like a normal object the user can use the settings on natively in Composite.

some notes for the specifics and safety of loading currently selected compositing canvas objects into the editor tab:
- When an object is clicked on, on the canvas, that means it's selected, and the site should prepare for the user to then click on the editor tab; if they do, the editor tab should then load, and then the composite object should be loaded into the editor tab's pipeline and canvas, and be editable like a normal editor project. Any time the user goes back to the composite tab, the editor sends the latest version of the image (along with the updated Editor JSON state) to the composite tab to be updated as the newest current version. The Editor and Composite state will need to track a shared `linkedNodeId` so updates map back to the right canvas layer.

2nd:
Project Independence and The Library:
It needs to be absolutely clear: A Composite project is one thing, and an Editor project is another entirely different thing. 

The composite tab should keep in sync with its own projects in the library (`src/ui/libraryPanel.js` and `src/main.js` IndexedDB interactions). To keep things up to date, the composite tab will listen for activity on itself, and if there isn't a lot of activity for a few seconds (using a debounced save hook), it automatically saves the current state of the project (as a self-contained `kind: 'composite-document'` type) to the library, overwriting the old version of that specific composite tab project.

Crucially, when an Editor project is loaded as an asset into the Composite tab, its entire JSON payload and any assets it relies on must be fully duplicated and embedded directly into the Composite document's payload (similar to how the 3D engine embeds models). This guarantees that the downloaded Composite JSON file is 100% self-contained and allows the full project to be recreated anywhere without missing dependencies. 

As a result of this embedding feature, if the user clicks the embedded Editor project and edits it in the Editor tab, the new updates only apply to the Composite project's copy. They DO NOT overwrite or affect the original Editor project sitting in the Library. They remain safely isolated unless the user explicitly clicks a UI option choosing to update the original Library project, or goes out of their way to save the newly edited version as a brand new independent Editor project.

3rd:
The Logs tab:
The composite should have ample logging just like the other tabs on the site, and should be able to communicate with the logs tab in the same reliable way. Following the site's architecture (`src/logs/engine.js`), Composite will need to register its own dedicated process streams (e.g., for canvas loading, headless rendering, switching to Editor, and auto-saving) and emit structured logs to be read in the top-level Logs tab.

4th:
Folder and Code Architecture:
The Composite tab should have its own dedicated engine and folder structure, keeping it properly isolated but integrated alongside the existing codebase. Following the pattern of the other tools (like `src/stitch/` or `src/3d/`), all core composite logic should live in a new `src/composite/` directory. This should include its own `document.js` (for schema and state definition), `engine.js` (for handling canvas rendering, layer positioning, and blending operations), and `ui.js` (for the tab's specific interface components). This guarantees the new engine doesn't tangle with the original webgl Editor (`src/engine/`) while still being easily hooked into the main shell via `src/main.js` and `src/ui/workspaces.js`.

5th:
Rendering Engine Strategy (GPU vs CPU):
Because the Composite tab intends to layer, scale, rotate, map opacity, and apply complex blend modes to multiple high-resolution images in real-time, it will heavily benefit from GPU rendering (WebGL) rather than relying on a CPU-bound Canvas 2D approach. Standard 2D canvas pixel manipulation forces the browser to ferry data back and forth between the CPU and GPU, which becomes a severe performance bottleneck. 

Since the original Editor tab (`src/engine/pipeline.js`) is already a highly optimized GPU engine (`NoiseStudioEngine`), the new Composite tab's `engine.js` should also be built around a WebGL pipeline. When an Editor project acts as a layer inside the Composite canvas, the Composite tab can instantiate a headless `NoiseStudioEngine` to process it. Because both systems would use WebGL, the rendered outputs can be kept in GPU memory (as textures) and passed directly into the Composite engine's final blending shaders. This skips the huge penalty of reading pixels back to the CPU, guaranteeing the UI stays blazing fast no matter how many Editor nodes are scattered across the composition.

UI Design of the new Composite Tab:
The composite tab should take heavy inspiration from both the design AND layout of the Editor tab, both functionally and visually, since the layout and functionality of the editor tab is already proven to work well. It should be initialized via a new factory (e.g., `createCompositeWorkspace`) within `src/ui/workspaces.js`, living alongside the other top-level modules like `createStitchWorkspace` and `createThreeDWorkspace`.

Specific UI architectural hooks based on the Editor's code structure:
- **Top Toolbar:** It will need its own dedicated `renderCompositeToolbar` func (mirroring `renderStudioToolbar`) housing the top-level actions like "Add Editor Project", "Export PNG", and "Save to Library".
- **Sidebar Tabs:** Built just like the Editor's `workspace-tabs` pattern (which flips between `Edit / Layer / Pipeline / Scopes`), the Composite tab will have its own scrollable context tabs to switch between things like `Layers` (for managing the canvas stack) and `Transforms` (for adjusting X/Y/Scale/Rotate/Opacity).
- **Layer Stack:** Using the exact same visual structure as the Editor's `renderPipeline()`, Composite layers should be displayed as a draggable vertical column of items so users can easily select, visually lock, and re-order their nodes.
- **Widgets:** It must reuse the exact same atomic form builders (like `rangeRow`, `renderColorRow`, and CSS classes) so that the black, white, and warm-grey workstation styling matches perfectly without duplicating CSS.

6th:
Advanced Compositing Controls & Workflows:
Beyond simple affine transforms (scale, rotation, position) and basic opacity, a modern high-end compositor requires deeper settings to truly seat elements together natively into a scene. Based on professional image compositors, the new tab should implement the following advanced controls, built to take advantage of the GPU pipeline:

- **Advanced Masking & Edge Matting:** Users need the ability to define clipping masks (where one Editor node acts as the visibility bounds for another), drawn alpha masks, and smooth feather/gradient boundaries to seamlessly blend the harsh edges of an imported node into the background.
- **Warping & Perspective:** Basic scaling isn't enough when placing an object onto an angled surface. The tab should include a Perspective Distort option (pinning 4 corners) and a Mesh/Grid Warp to map flat 2D Editor projects onto 3D-feeling environmental planes.
- **Deep Blending Options:** Beyond 'Opacity' and 'Auto', users will need a robust dropdown library of mathematical blend modes categorized by function: Lighten (Screen, Add), Darken (Multiply), Contrast (Overlay, Soft Light, Hard Light), and Component (Hue, Color).
- **"Blend If" / Luma Isolation:** Sliders allowing a layer to only appear in the Shadows, Midtones, or Highlights of the layer beneath it. This is critical for realistic compositing (e.g., embedding a graphic so it naturally maps into the texture grooves of a background wall without hiding the highlights).