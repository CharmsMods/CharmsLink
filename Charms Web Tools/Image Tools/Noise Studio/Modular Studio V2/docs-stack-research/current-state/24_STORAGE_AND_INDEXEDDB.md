# Storage and IndexedDB

## 1. Purpose
This document describes the durable data storage layer — how the application uses IndexedDB as its primary project repository and localStorage for lightweight settings persistence. It covers the database schema, CRUD operations, record types, attachment system, and storage estimation.

## 2. Scope
Covers `src/app/bootstrap.js` (IndexedDB initialization, all DB helper functions), `src/settings/persistence.js` (localStorage settings), and the relationship between the Library's IndexedDB schema and the section document models.

## 3. Verification State
- **Verified from Source:**
  - `src/app/bootstrap.js` lines 104–282 (DB_NAME, DB_VERSION, STORE_NAME, ATTACHMENT_STORE_NAME, initDB, saveToLibraryDB, getFromLibraryDB, deleteFromLibraryDB, clearAllFromLibraryDB, getAllFromLibraryDB, getLibraryProjectRecordsByCursor, saveLibraryAttachment, getLibraryAttachment, getLibraryAttachmentsByProjectId, deleteLibraryAttachment, deleteLibraryAttachmentsByProjectId)
  - `src/app/bootstrap.js` lines 366–433 (tag normalization, meta record, tag catalog discovery)
  - `src/settings/persistence.js` (complete 76 lines, previously verified)
- **Inferred Behavior:** None — all storage code in scope was fully read.

## 4. Cross-System Dependencies
- **Library Panel → IDB:** The Library panel calls these IDB helpers to list, load, save, delete, and export projects.
- **All Sections → IDB:** Every section saves to and loads from the same `LibraryProjects` object store via project-type-specific payload builders.
- **Attachments → DNG Pipeline:** DNG raw data (too large for inline embedding) is stored in the `LibraryProjectAttachments` store, keyed by `attachmentId` and indexed by `projectId`.
- **Settings → localStorage:** Application settings persist via a separate localStorage key (`noise-studio:app-settings:v1`).
- **Storage Estimation → Settings Diagnostics:** `navigator.storage.estimate()` values are injected into `settings.diagnostics.storageEstimate`.

## 5. State Behavior
- **Saved (Durable):**
  - IndexedDB `ModularStudioDB` (version 3): `LibraryProjects` store (all projects + library meta), `LibraryProjectAttachments` store (DNG blobs, keyed by attachment ID).
  - localStorage key `noise-studio:app-settings:v1` (all settings minus diagnostics).
- **Runtime-only:** IDBDatabase handles (lazily opened per operation), in-memory project lists and caches.
- **Derived/Cached:** Tag catalogs (union of meta record tags + all project tags, recomputed on discovery).

---

## 6. Current Behavior

### 6.1 Database Schema
**[VERIFIED]** The IndexedDB database has the following structure:

| Property | Value |
|---|---|
| Database Name | `ModularStudioDB` |
| Database Version | `3` |
| Object Store 1 | `LibraryProjects` — keyPath: `id` |
| Object Store 2 | `LibraryProjectAttachments` — keyPath: `id`, indexes: `projectId` (non-unique), `kind` (non-unique) |

### 6.2 Database Initialization (`initDB`)
**[VERIFIED]** `initDB()` opens the database with version 3. The `onupgradeneeded` handler:
1. Creates `LibraryProjects` store if missing (keyPath: `id`).
2. Creates `LibraryProjectAttachments` store if missing (keyPath: `id`), with indexes on `projectId` and `kind`.

**[VERIFIED]** A repair fallback exists: if `onsuccess` fires but the expected stores don't exist, the function closes the database and reopens at `version + 1`, repeating the upgrade handler. This self-heals corrupted or partially-migrated databases.

**[VERIFIED]** The `onblocked` callback rejects with a descriptive error when another tab holds a connection. The database does not use explicit transactions for schema migration beyond the standard IDB upgrade flow.

### 6.3 CRUD Operations
**[VERIFIED]** All helpers lazily call `initDB()` per operation (no singleton connection):

| Function | Operation | Details |
|---|---|---|
| `saveToLibraryDB(project)` | `put` on `LibraryProjects` | Auto-generates `id` if missing (timestamp + random base36) |
| `getFromLibraryDB(id)` | `get` on `LibraryProjects` | Returns `null` if not found |
| `deleteFromLibraryDB(id)` | `delete` on `LibraryProjects` | |
| `clearAllFromLibraryDB()` | `clear` on `LibraryProjects` | Wipes all projects |
| `getAllFromLibraryDB()` | `getAll` on `LibraryProjects` | Returns full array |
| `getLibraryProjectRecordsByCursor(options)` | Cursor iteration with filter/map | Skips meta and asset records; supports per-record filtering and transformation |

### 6.4 Attachment System
**[VERIFIED]** Large binary payloads (DNG raw rasters) are stored separately in `LibraryProjectAttachments`:

| Function | Operation |
|---|---|
| `saveLibraryAttachment(record)` | `put` — record must have `id`, `projectId`, `kind` |
| `getLibraryAttachment(id)` | `get` by primary key |
| `getLibraryAttachmentsByProjectId(projectId)` | `getAll` via `projectId` index |
| `deleteLibraryAttachment(id)` | `delete` by primary key |
| `deleteLibraryAttachmentsByProjectId(projectId)` | Loads all by `projectId`, then deletes each sequentially |

**[VERIFIED]** Attachment IDs are formatted as `attachment-{timestamp+random}`. The `kind` index enables queries by attachment type (e.g., `'dng-source'`) but this index-based query is not used in the verified code — only `projectId` queries were observed.

### 6.5 Record Types in LibraryProjects
**[VERIFIED]** The `LibraryProjects` store contains three types of records, distinguished by inspection:

| Record Type | Detection | Fields |
|---|---|---|
| **Library Meta** | `id === '__library_meta__'` or `kind === 'library-meta'` | `id`, `kind`, `tags[]` |
| **Library Asset** | `kind === 'library-asset'` or `recordType === 'asset'` | Asset-specific fields (model/image/font data) |
| **Project** | Everything else (after filtering meta and assets) | `id`, `payload`, `tags`, `name`, `timestamp`, `projectType`, `preview`, etc. |

`isLibraryProjectRecord()` returns true only for records that are neither meta nor asset records.

### 6.6 Tag System
**[VERIFIED]** Tags are stored in two places:
1. **Per-project:** Each project record's `tags` array.
2. **Library meta record:** A unified `tags` catalog in the `__library_meta__` record.

`loadLibraryTagCatalogFromDB()` computes the full tag catalog as the union of:
- Tags from the meta record.
- Tags discovered from all project records.

`registerLibraryTags(tags)` merges new tags into both the catalog and the meta record. Tags are case-insensitive-deduplicated (preserving original case) via `normalizeLibraryTags()`.

### 6.7 Settings Persistence (localStorage)
**[VERIFIED]** (Detailed in `17_SETTINGS_AND_LOGS.md`.) Key details:
- Key: `noise-studio:app-settings:v1`.
- Read: `loadPersistedAppSettings()` — parse JSON, normalize via schema, inject runtime diagnostics.
- Write: `persistAppSettings()` — strip diagnostics, serialize as JSON.
- Clear: `clearPersistedAppSettings()` — removes key entirely.
- Guarded by `canUseLocalStorage()` for sandboxed iframe environments.

### 6.8 Storage Estimation
**[VERIFIED]** At bootstrap, the application calls `navigator.storage.estimate()` to probe available and used storage. The result is injected into `settings.diagnostics.storageEstimate` and used by the Library panel's storage pressure monitoring system (threshold default: 80% usage, configurable via `settings.library.storagePressureThreshold`).

### 6.9 Connection Lifecycle
**[VERIFIED]** Each IDB operation opens a fresh connection via `initDB()`. There is no connection pooling, no singleton `IDBDatabase` reference kept across operations. This is safe but means each operation pays the `indexedDB.open()` cost. For bulk operations like cursor scanning (`getLibraryProjectRecordsByCursor`), the connection is held open for the duration of the cursor traversal.

---

## 7. Open Questions & Verification Gaps
- Whether `navigator.storage.persist()` is called at any point to request durable storage (preventing browser eviction).
- The size distribution of typical projects in IDB — how large are Editor payloads with embedded images vs. Stitch payloads with multiple data URLs?
- Whether the `kind` index on `LibraryProjectAttachments` is ever queried directly (no usage observed), or if it's reserved for future use.
- Whether bulk operations (e.g., clearing all + reimporting) use a single transaction for atomicity or sequential individual transactions.
