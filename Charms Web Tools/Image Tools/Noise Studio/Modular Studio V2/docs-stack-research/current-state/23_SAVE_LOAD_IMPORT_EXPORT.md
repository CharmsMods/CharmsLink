# Save, Load, Import, and Export Flow

## 1. Purpose
This document elaborates on how the application moves states, images, models, and metadata onto the device filesystem, and how it handles importing external data. 

## 2. Scope
This file covers JSON persistence to local disk, the dual nature of "embedded payloads" vs "separate attachments", and the import/export rules defined in `src/io/documents.js`. It does not cover the detailed schema structures of IndexedDB Library backend (reserved for `24_STORAGE`), but rather the behavioral flows and serialization mechanics.

## 3. Verification State
- **Verified from Source:** 
  - `src/io/documents.js`
  - `src/app/bootstrap.js` (Library tracking arrays and build rules)
- **Inferred Behavior:** Exact handling of massive DNG byte arrays when crashing browsers on heavy clone operations. Wait, the context file specifies DNG attachment behaviors explicitly. Validated via `buildStudioPayload` checks in `src/io/documents.js`.

## 4. Cross-System Dependencies
- **Workers:** File extraction and loading, specifically identifying `.dng`, might occur via `src/workers/dng.worker.js`. 
- **Adapters:** Depends on the adapters detailed in `22_PROJECT_ADAPTERS` to determine what data gets serialized.

## 5. State Behavior
- **Saved (Durable):** `noise-studio-state.mns.json` standard format output. If exported from Library, these JSON strings gain envelope metadata. 
- **Runtime-only:** Preview properties `analysis.previews` inside Stitch, rendering jobs in 3D. These are intentionally stripped out during conversion because ObjectURLs evaporate when memory is cleared.

---

## 6. Current Behavior 

### The Normal JSON Export Protocol
Regardless of engine, standard documents are downloaded to the user's hard drive as robust `.mns.json` files.
A robust Studio file ensures:
1. `state.document` is cleanly mirrored.
2. Base properties (Width/Height/Colors of canvas) are recorded.
3. Base64 strings of embedded images (`source.imageData`) are packed into the single text file.
4. A small base64 preview (`preview.imageData`) is attached purely so that if the user drags the file into a gallery/Library later, a rendered snapshot of the work exists without waking up an engine to re-render it.

During `load`, this data reconstructs the state object. The Engine evaluates the parameters, but intentionally ignores the `preview` base64. The actual readable layout comes from recalculating the `base` and the `layerStack`. Form matters, thumbnail does not affect the engine.

### The Attachment System and DNGs
While small `.jpg` base64 embeddings are manageable, raw `.dng` sensor dumps can be 14MB–50MB. Injecting these directly into the master `LibraryProjects` array causes immediate memory stalls during startup queries.

The architecture handles massive sources (like DNG) through dual pathways:
#### 1. Local Disk JS Export (Standalone `.mns.json` save)
When hitting "Export to JS", the `serializeState()` configuration dictates `includeRawDng: true`. The text payload absorbs the full massive raw bytes array, ensuring the output file travels reliably as one chunky, self-contained file (e.g., sharing over email).

#### 2. Library Save (IndexedDB save)
When clicking "Save to Library", the system uses `includeRawDng: false` inside the core model builder `buildStudioPayload`. 
Instead:
- The core record (`LibraryProjects`) receives the layer stack, edits, metadata, and proxy thumbnails. 
- The raw source bytes (`source.rawData`) are pushed to `LibraryProjectAttachments`, keyed by generating a unique database `attachmentId`.
- When the user loads the gallery card in Library UI, it remains light. 
- Only after clicking "Open Project in Editor" does `actions.loadLibraryProject()` resolve the attachment ID, fetch the 40MB raw array from the attachment store, and re-hydrate it onto the live `document.source` so the background worker can decode it.

### Composite Export and Memory Restraints
Composite files export their embedded Layer dependencies natively. A Composite project containing three Editor assets will serialize all three base64 arrays inside its JSON. 
As tracked in performance settings, large composite loads avoid "whole-payload stringify/parse clones" when loading through the Library wrapper so that hitting the memory limits doesn't crash the overlay UI view.

### The Security Envelope
When exporting *from* the Library Panel instead of directly from the workspace viewport, the `projectAdapters` inject metadata (Like original tags: `_libraryTags`, `_libraryProjectType`). When importing files into the browser, a filter script (`stripLibraryEnvelopeMetadata` & `stripProjectFingerprintMetadata`) actively scrubs this to clean the payload prior to execution or storage, preventing envelope data from mutating the target schema.

---

## 7. Open Questions & Verification Gaps
- How does the system handle "Missing Attachments" if a DNG payload is structurally lost during an edge-case browser termination event? (Does it revert to base raster? Does it error output cleanly?)
