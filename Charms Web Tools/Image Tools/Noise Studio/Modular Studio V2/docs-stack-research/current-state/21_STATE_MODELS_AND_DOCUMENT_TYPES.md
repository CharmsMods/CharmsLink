# State Models and Document Types

## 1. Purpose
This document describes the state management architecture, document type system, and how application state flows between sections, stores, and the Library. It covers the reactive store primitive, the per-section document normalizers, document type classification, and the project fingerprinting system used to detect unsaved changes.

## 2. Scope
Covers `src/state/store.js` (reactive store), `src/state/documentHelpers.js` (editor view state), the four section document normalizers (`src/editor/baseCanvas.js`, `src/composite/document.js`, `src/3d/document.js`, `src/stitch/document.js`), the document classification and routing logic in `src/app/bootstrap.js`, and the `src/io/documents.js` serialization layer.

## 3. Verification State
- **Verified from Source:**
  - `src/state/store.js` (complete 22 lines)
  - `src/state/documentHelpers.js` (complete 49 lines)
  - `src/app/bootstrap.js` lines 1–800 (document type classification, fingerprinting, library payload builders, origin tracking)
  - `src/io/documents.js` (complete 129 lines, previously verified)
  - `src/io/projectAdapters.js` (complete 56 lines, previously verified)
- **Inferred Behavior:** The full `bootstrap.js` (11,726 lines) was not entirely read; mid-file action handlers for all sections are inferred from the verified structure.

## 4. Cross-System Dependencies
- **Reactive Store → All UI:** Every section creates its own store via `createStore()`. UI components subscribe to store changes and re-render.
- **Document Normalizers → Library:** Each section's normalizer (`normalizeThreeDDocument`, `normalizeCompositeDocument`, `normalizeStitchDocument`) is called before saving and after loading to enforce schema correctness.
- **Project Adapters → Library Panel:** `ProjectAdapterRegistry` routes Library payloads to the correct section based on `inferProjectTypeFromPayload()`.
- **Fingerprinting → Unsaved Indicators:** `makeProjectFingerprint()` creates a stable string hash to detect whether a document has changed since last save.

## 5. State Behavior
- **Saved (Durable):** Serialized document state per section (see respective section docs). Saved to Library as IndexedDB records or exported as `.mns/.mnslib` files.
- **Runtime-only:** The reactive store itself, subscriber lists, active library origin tracking, DNG decoded source cache, GPU textures, analysis state.
- **Derived/Cached:** Project fingerprints (computed on demand from document state).

---

## 6. Current Behavior

### 6.1 Reactive Store Primitive (`src/state/store.js`)
**[VERIFIED]** The application uses a minimal custom reactive store — not Redux, Zustand, or any framework:
```
createStore(initialState) → { getState(), setState(updater, meta), subscribe(listener) }
```
- `setState` accepts either a new state object or an updater function `(prevState) => nextState`.
- If the updater returns `null` or the same reference, no notification fires.
- Subscribers are called synchronously with `(nextState, meta)` on every mutation.
- Returns an unsubscribe function from `subscribe()`.
- The store is a closure over a `Set` of listeners — no middleware, no devtools, no immer.

### 6.2 Editor View State (`src/state/documentHelpers.js`)
**[VERIFIED]** The Editor's view state model:
- `theme` (light/dark), `zoom` (1–100), `zoomLocked`, `highQualityPreview`, `hoverCompareEnabled`, `isolateActiveLayerChain`, `layerPreviewsOpen`, `layerPreviewIndex`.
- `normalizeViewState()` validates and clamps all fields.
- `isRenderableLayerInstance()` checks whether a layer instance should participate in rendering (visible + enabled conditions).
- `hasRenderableLayers()` returns whether the current document has any active layers.

### 6.3 Document Type System
**[VERIFIED]** Four document types exist, identified by payload shape:

| Type | Kind String | Detection Function | Version Envelope |
|---|---|---|---|
| Editor (Studio) | `'document'` | Default fallback | `mns/v2` |
| Composite | `'composite-document'` | `isCompositeDocumentPayload()` | `mns/v2` |
| 3D | `'3d-document'` | `isThreeDDocumentPayload()` | `mns/v2` |
| Stitch | `'stitch-document'` | `.kind === 'stitch-document'` | `mns/v2` |

**[VERIFIED]** `inferProjectTypeFromPayload(payload, fallbackType)` performs the classification:
1. If `fallbackType` is explicitly `'composite'`, `'3d'`, or `'stitch'`, returns that type immediately.
2. Otherwise inspects payload shape: `isCompositeDocumentPayload()` → `isThreeDDocumentPayload()` → stitch kind check → defaults to `'studio'`.

**[VERIFIED]** Legacy V1 migration: `normalizeLegacyDocumentPayload()` detects `version === 2` (numeric) and upgrades to `version: 'mns/v2'`, adding `kind: 'document'` if absent.

### 6.4 Library Payload Builders
**[VERIFIED]** Each section has a dedicated builder that prepares a document for Library storage:

| Builder | Section | What it strips/preserves |
|---|---|---|
| `buildLibraryPayload()` | Editor | Calls `serializeState()` with `includeSource=true`, `includeRawDng=false`, includes preview |
| `buildCompositeLibraryPayload()` | Composite | `serializeCompositeDocument(normalizeCompositeDocument(...))` |
| `buildStitchLibraryPayload()` | Stitch | `stripEphemeralStitchState()` — removes gallery state, analysis progress |
| `buildThreeDLibraryPayload()` | 3D | `serializeThreeDDocument(normalizeThreeDDocument(...))`, zeroes currentSamples, deletes renderJob |

### 6.5 Library Envelope Metadata
**[VERIFIED]** Before storing in Library, payloads are decorated with envelope metadata:
- `_libraryName` — User-assigned project name.
- `_libraryTags` — Tag array.
- `_libraryProjectType` — `'studio'`, `'composite'`, `'3d'`, or `'stitch'`.
- `_libraryHoverSource` — Preview image data for hover display.
- `_librarySourceArea` — Pixel area of primary source.
- `_librarySourceCount` — Count of input sources (for Stitch).

These are stripped by `stripLibraryEnvelopeMetadata()` before handing the payload to section engines.

### 6.6 Project Fingerprinting
**[VERIFIED]** `makeProjectFingerprint(payload)` generates a deterministic string via `stableSerialize()` (sorted-key JSON). Before hashing:
- Library envelope metadata is stripped.
- Preview data (imageData, dimensions, timestamps) is removed.
- DNG raw payloads are stripped (only sourceSignature remains).
- 3D render progress (currentSamples) and renderJob are removed.

This fingerprint is compared against the last-saved fingerprint to detect unsaved changes.

### 6.7 Active Library Origin Tracking
**[VERIFIED]** `activeLibraryOrigins` tracks, per project type, which Library project ID is currently being edited:
```
{ studio: { id, name }, composite: { id, name }, stitch: { id, name }, '3d': { id, name } }
```
When a project is loaded from Library, `setActiveLibraryOrigin()` records the original project ID and name. When saving back, the engine checks whether the origin matches to decide "update existing" vs. "save as new".

---

## 7. Open Questions & Verification Gaps
- How many simultaneous stores exist at runtime (one per section, or a single global store?). Inferred to be one per section from the architecture, but the exact instantiation pattern in `bootstrap.js` was not traced.
- Whether `meta` in `setState(updater, meta)` is used to carry change context (e.g., source='user' vs. source='settings') or is only for debugging.
- The full set of fields in the serialized Editor document state (handled by `serializeState()` in `src/io/documents.js`).
