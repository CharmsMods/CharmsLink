# The Editor Pipeline

## 1. Purpose
This document explains the core architecture of the image-editing module (the original engine of the application). It details how the layered WebGL rendering pipeline functions, how sources are mapped to a base canvas, and how text and DNG files have been integrated into this stack.

## 2. Scope
This file specifically covers `src/engine/` processing bounds and the `Editor` workspace UI representations. It does not cover 3D rendering, Stitch panoramic operations, or Composite 2D layouts.

## 3. Verification State
- **Verified from Source:** 
  - `src/ui/workspaces/index.js` (Editor UI Tabs, DNG Control panel)
  - `src/editor/baseCanvas.js`
  - `src/editor/dngDevelopShared.js`
  - `src/editor/textLayerShared.js`
- **Inferred Behavior:** Exact WebGL loop evaluation and background worker message-passing boundaries. To be verified during deep `src/engine` passes. 

## 4. Cross-System Dependencies
- **DNG Processing:** relies heavily on `src/workers/dng.worker.js` for asynchronous parsing and decoding before shoving raw data back onto the UI thread for GPU rendering.
- **Project Payload:** The Editor produces standard `mns/v2` `studio`-mode documents, which are serialized and injected into the Library backend via the Project Adapters.

## 5. State Behavior
- **Saved (Durable):** `state.document.base`, `layerStack`, `palette`, and optionally `source` (including raw DNG embeddings) are saved to JSON / Library blobs.
- **Runtime-only:** Preview downscaling for large canvases, active overlay gizmos (like bounding boxes for text movement), and ephemeral compare outputs.
- **Derived/Cached:** The final rendered PNG exported to `state.document.preview` upon save, as well as worker-probed DNG signatures (`source.dng.probe`).

---

## 6. Current Behavior 

The Editor is a node-based, non-destructive WebGL filter stack masquerading as a linear layer list. 

### The Base Canvas 
Traditionally, an image editor assumes the "Source Image" owns the document dimensions. In Modular Studio V2, the Editor maintains a persistent **Base Canvas** (`state.document.base`).
- You can build text-only or generated-noise projects without any imported source image.
- When an image *is* loaded, the prompt will ask if the Base Canvas should assume the Source Image's dimensions or keep its own. If it keeps its own, the source image is fitted into the predefined space before the rest of the layer stack initiates.
- To change output sizes destructively, the Editor relies on `Crop / Transform` or `Resolution Scale` layers within the stack rather than destructive document resizes.

### Layer Stack & Operations
The UI displays these layers inside the **Layers** panel, grouped into categories (Base, Color, Texture, Optics, Stylize, Damage). 
- Every layer instance is completely self-contained in its parameters. 
- Editing a layer parameter forces the WebGL `NoiseStudioEngine` to re-execute from the changed layer down to the final base image.

### Text Overlays in WebGL
Unlike conventional software where text lives on an HTML/SVG layer above the canvas, `textOverlay` operates inside the Editor's rendering registry. 
- The text is rasterized into a full-preview-sized surface.
- That texture is then piped into the WebGL node chain, allowing downstream Editor layers (like `cropTransform` or `scale`) to perfectly manipulate the text along with the image. 
- On-canvas UX provides a bounding box for moving and rotating the text, which calculates inverse transforms under the hood so coordinates align correctly even when the live WebGL preview is temporarily downscaled for performance.

### DNG and Raw Files
If the user loads a `.dng` file:
1. `source.kind` becomes `'dng'` and the payload holds raw byte arrays.
2. The UI injects a `DNG Develop` "layer" at the bottom of the base stack.
3. The actual parsing (probe metadata, mosaicked buffer decode) happens off main-thread via Background Workers.
4. The decoded buffer is pushed into the GPU WebGL pipeline natively, so that white-balance, matrix shifts, interpretation mode, and 16-bit recovery occur locally and interactively, without blocking UI interaction.
5. `Canvas > Export` surfaces 16-bit PNG options uniquely for DNG pipelines.

---

## 7. Open Questions & Verification Gaps
- Exactly how the pipeline handles extremely large canvas limits. E.g., does it slice rendering, or does it refuse to let users scale past WebGL max texture limits? (Likely relies on graphics caps checked during Bootstrap).
