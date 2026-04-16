# Project Adapters & Cross-Section Links

## 1. Purpose
This document details the registry system that allows the uniform Library UI and unified Save algorithms to handle the dramatically different data shapes of Editor, Composite, 3D, and Stitch projects. It also records how sections know where they "came from" to ensure clean overwrite/copy logic.

## 2. Scope
This file focuses on `src/io/projectAdapters.js`, the tracking of `activeLibraryOrigins` globally on `bootstrap.js`, and how different engines hand off drafts to the database.

## 3. Verification State
- **Verified from Source:** 
  - `src/io/projectAdapters.js`
  - `src/app/bootstrap.js`
- **Inferred Behavior:** N/A (Confirmed via direct file reading).

## 4. Cross-System Dependencies
- **Library Module:** Calls into the adapter registry upon any `save` or `import` request to process JSON.
- **Local Save / IO:** Relies on adapters to decide if the current draft is empty and block save-to-disk logic if it is.

## 5. State Behavior
- **Saved (Durable):** `_libraryProjectType`, `_libraryHoverSource`, `_libraryTags`, etc., are physically serialized into JSON files on manual disk exports so that if they are dragged back in later, the adapters know where to route them.
- **Runtime-only:** The `activeLibraryOrigins` object is held in closure memory in `bootstrap.js`, tracking `{ id, name }` for all four engines separately.
- **Derived/Cached:** Fingerprints used by Adapters to prevent duplicate saving.

---

## 6. Current Behavior 

### The Adapter Pattern
Because the Library system was unified, the Library codebase itself must remain ignorant of what constitutes a "valid" 3D scene versus a "valid" Stitch panorama. 
When the user clicks "Save to Library," the flow goes:
1. `actions.saveProjectToLibrary` checks the active UI section (e.g., `'composite'`).
2. It hits the `ProjectAdapterRegistry` via `getAdapterForSection('composite')`.
3. The *Composite Adapter* runs `getCurrentDraft()`, determining if the object has enough data to be worth saving.
4. The *Composite Adapter* executes `renderLibraryPreview()`, executing its own internal 2D HTML Canvas capture logic independent of WebGL. 
5. The unified layer receives a raw serialized `payload` string and a unified thumbnail `blob` back, attaching tags, IDs, and timestamps, and pushing it to IndexedDB.

When loading an old project:
1. A single payload string is pulled from DB or disk.
2. The logic heuristically probes it: `if (payload.kind === '3d-document') { type = '3d'; }`
3. It asks `getAdapterForPayload(payload)` for instructions.
4. The correctly resolved adapter hydrates the object into `state.threeDDocument` and alerts the view router to switch to `?section=3d`.

### Active Origins & Overwrite Context
Instead of assuming there is only "one document open," the system tracks `activeLibraryOrigins` consisting of:
- `studio: { id, name }`
- `composite: { id, name }`
- `stitch: { id, name }`
- `3d: { id, name }`

This is why, if you open an Editor project (say, 'My Nice Portrait'), the Studio origin ID locks to 'My Nice Portrait'. 
If you then switch to the Composite tab and open a Composite project ('My Poster Outline'), the Composite origin IDs lock to 'My Poster Outline'. 
You can switch back and forth. Hitting `Ctrl+S` on the Editor tab will overwrite 'My Nice Portrait' in the Library without disturbing 'My Poster Outline', because `ensureProjectCanBeReplaced` targets the specific adapter and its cached tracking ID, rather than blindly overwriting the "latest" document.

### The Composite Bridge
A special use case exists where `Composite` layers can be literal Editor Projects.
- When an Editor-backed layer within Composite is selected, clicking "Open in Editor" throws the layer's internal `mns/v2` payload into the `Editor` context immediately.
- This creates linked dependencies. Modifications inside Editor can update the Composite instance. 
- Overwriting that Composite project automatically syncs its mutated, embedded Editor documents. 

---

## 7. Open Questions & Verification Gaps
- Are project previews strictly `.png` blobs? Yes, as verified via references to HTML Canvas serialization points inside `buildLibraryPayload`.
