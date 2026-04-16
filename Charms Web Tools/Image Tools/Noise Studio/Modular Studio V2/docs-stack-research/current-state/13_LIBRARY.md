# The Library System

## 1. Purpose
This document describes how the Library panel (`src/ui/libraryPanel/index.js`) and its backing storage layer function as the persistent project repository for the application. The Library is the sole durable store for saved projects across all section types (Editor, Composite, 3D, Stitch). It also manages an independent Asset store used by sections like 3D (fonts, HDRIs) and provides tag-based organization, bulk import/export, and secure encrypted transfer.

## 2. Scope
This file covers the Library panel UI, the IndexedDB-backed project and asset stores, the tag system, and the import/export pipelines including secure (encrypted) and legacy JSON formats. It does not cover the individual document schemas (see `12_EDITOR.md`, `14_COMPOSITE.md`, `15_THREED.md`, `16_STITCH.md`) or the serialization envelope itself (see `23_SAVE_LOAD_IMPORT_EXPORT.md`).

## 3. Verification State
- **Verified from Source:**
  - `src/ui/libraryPanel/index.js` (full 4092-line panel, confirmed: tag management, export scopes, preview rendering, import pipeline)
  - `src/library/secureTransfer.js` (encryption/decryption envelope, format constants)
  - `src/settings/defaults.js` → `library` settings block (autoLoadOnStartup, storagePressureThreshold, defaultViewLayout, defaultSortKey, secureExportByDefault, requireTagOnImport, assetPreviewQuality)
  - `src/settings/schema.js` → normalizeAppSettings library section
  - `src/io/projectAdapters.js` → registry routing for load-from-library
- **Inferred Behavior:** The exact IndexedDB database name, object store schemas, and version migration logic are handled in `src/app/bootstrap.js` database initialization (previously verified) but the low-level IDB API wrapper was not re-read in this pass. The preview backfill mechanism is inferred from recent bugfix context (conversation 705c066a).

## 4. Cross-System Dependencies
- **Project Adapters:** When a project is loaded from the Library, the Project Adapter Registry (`src/io/projectAdapters.js`) routes the raw JSON payload to the correct section based on `kind` / `mode` / `schema` fields.
- **Save Pipeline:** Every section's "Save" action writes through `src/io/documents.js` serialization, which then stores the result into the Library's IndexedDB object store.
- **Settings Integration:** Library behavior is configured via `settings.library.*`, including `autoLoadOnStartup`, `storagePressureThreshold`, `defaultViewLayout`, `defaultSortKey`, `defaultSortDirection`, `assetPreviewQuality`, `secureExportByDefault`, and `requireTagOnImport`.
- **3D Asset Preview:** The Library panel imports `createThreeDAssetPreview` from `src/3d/assetPreview.js` to render thumbnail previews for 3D projects.
- **Secure Transfer:** Import and export use `src/library/secureTransfer.js` for AES-GCM encrypted `.mnslib` files.

## 5. State Behavior
- **Saved (Durable):**
  - Project entries stored in IndexedDB, each containing the full document JSON plus metadata (name, tags, timestamps, project type, source dimensions, render dimensions).
  - Asset entries stored in a separate IndexedDB object store, each containing binary data (data URLs) plus metadata.
  - Tag lists per project/asset are persisted as arrays of strings within each record.
- **Runtime-only:**
  - The current sort order, view layout (`grid` / `list`), active search filter, and tag filter state.
  - Hover preview thumbnails and expanded card details.
  - Import/export progress indicators and modal state.
  - Storage pressure ratio computed from `navigator.storage.estimate()`.
- **Derived/Cached:**
  - Preview thumbnails are generated at save time and may be backfilled asynchronously on load for older records that lack them.
  - Sort order is computed from the full project list using the active sort key/direction.

---

## 6. Current Behavior

### 6.1 Project List and Browsing
The Library panel renders a scrollable list of project cards. Each card displays:
- A thumbnail preview (PNG data URL stored in the project record).
- The project name (editable inline).
- The document type badge (Editor, Composite, 3D, Stitch).
- Timestamps (created, last modified).
- Source and render dimensions.
- Tag pills.

**[VERIFIED]** The panel supports two view layouts: `grid` and `list`, controlled by `settings.library.defaultViewLayout`. Sort can be by `timestamp`, `name`, `source-area`, or `render-area`, each in `asc` or `desc` direction.

### 6.2 Tag System
Tags are plain string arrays stored per-project. The panel provides:
- A tag sidebar filter that shows all distinct tags across the library.
- Inline tag editing per card.
- A `requireTagOnImport` setting that, when enabled, forces the user to tag incoming projects at import time.
- Tags are preserved through import/export cycles.

### 6.3 Import Pipeline
The Library supports several import paths:

1. **Single JSON file** — A raw project document (`.json`). The panel detects the document type via `isThreeDPayload()`, checks for `kind`/`mode`/`schema` identifiers, and routes through the Project Adapter Registry.
2. **Secure Library Export (`.mnslib`)** — An AES-GCM encrypted archive. Format identifier: `LIBRARY_SECURE_EXPORT_FORMAT`. The panel prompts for a passphrase, decrypts using the `secureTransfer.js` module, and bulk-inserts projects.
3. **Legacy Library Export (`.json`)** — Unencrypted JSON with `kind: 'noise-studio-library'` envelope. Format identifier: `LEGACY_LIBRARY_EXPORT_FORMAT`.
4. **Asset Folder Format** — A structured JSON containing both projects and asset blobs. Format identifier: `LIBRARY_ASSET_FOLDER_FORMAT`.

**[VERIFIED]** The import flow parses files, applies tag requirements if configured, normalizes each project through the appropriate document normalizer, generates preview thumbnails, and writes to IndexedDB.

### 6.4 Export Pipeline
Export supports three scopes:
- `library` — Projects only, with tags.
- `assets` — Assets only, with tags.
- `library + assets` — Full package.

**[VERIFIED]** When `settings.library.secureExportByDefault` is `true`, the export uses AES-GCM encryption via `secureTransfer.js`, producing `.mnslib` files. Otherwise, plain JSON is exported. The export envelope includes metadata: `exportedAt`, `exportedFrom`, and `kind`.

Export uses the browser's File Save API (`saveJsonLocally`, `saveDataUrlLocally`, `saveTextLocally` from `src/io/localSave.js`).

### 6.5 Secure Transfer Protocol
`src/library/secureTransfer.js` (16,682 bytes) implements:
- **Encryption:** AES-GCM with a user-provided passphrase. The passphrase is derived into a CryptoKey via PBKDF2.
- **Format Constants:** `LIBRARY_EXPORT_FORMAT`, `LIBRARY_EXPORT_TYPE`, `LIBRARY_SECURE_EXPORT_FORMAT`, `LEGACY_LIBRARY_EXPORT_FORMAT`, `LIBRARY_ASSET_FOLDER_FORMAT`.
- **Compatibility Error Detection:** `isSecureLibraryCompatibilityError()` identifies when decryption fails due to browser crypto API limitations.

### 6.6 Storage Pressure
The Library monitors browser storage usage via `navigator.storage.estimate()`. When the usage ratio exceeds `settings.library.storagePressureThreshold` (default 0.8), the UI surfaces a warning. This threshold is configurable in Settings.

### 6.7 Preview Generation
**[VERIFIED]** For most project types, previews are PNG data URLs generated at save time. For 3D projects, the Library calls `createThreeDAssetPreview()` to render a static thumbnail of the scene. Preview quality is governed by `settings.library.assetPreviewQuality` which accepts `'performance'`, `'balanced'`, or `'quality'`.

**[INFERRED]** Preview backfill was decoupled from the main data retrieval flow to prevent blocking (per conversation 705c066a fix). Projects saved before preview generation was implemented may have their previews generated lazily on first load.

---

## 7. Open Questions & Verification Gaps
- The exact IndexedDB database name, version number, and object store schema were not re-read in this pass. These are set up in `src/app/bootstrap.js`.
- The precise mechanism for preview backfill scheduling (idle callback vs. explicit queue) needs verification against the current code.
- Whether the Library enforces any maximum project count or total storage size limit beyond the browser-imposed quota.
- The asset store's relationship with 3D font/HDRI assets embedded in documents vs. standalone assets needs deeper verification.
