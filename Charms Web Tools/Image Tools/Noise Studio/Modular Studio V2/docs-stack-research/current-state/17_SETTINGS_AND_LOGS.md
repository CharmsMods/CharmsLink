# Settings and Logs Systems

## 1. Purpose
This document describes the application-wide Settings system and the Log Engine. Settings governs persistent user preferences and runtime diagnostics for all sections. The Log Engine provides a centralized, process-oriented logging facility used by all engines and background workers to surface status, progress, and errors to the UI.

## 2. Scope
This file covers `src/settings/defaults.js` (default values), `src/settings/schema.js` (normalization), `src/settings/persistence.js` (localStorage read/write), `src/settings/apply.js` (applying settings to section documents), `src/settings/personalization.js` (Neumorphic UI theming), and `src/logs/engine.js` (log engine). It does not cover individual section behaviors — those are documented in their respective files.

## 3. Verification State
- **Verified from Source:**
  - `src/settings/defaults.js` (complete 126 lines: `createDefaultAppSettings()`, schema version, storage key)
  - `src/settings/schema.js` (complete 261 lines: `normalizeAppSettings()`, `normalizeSettingsCategory()`, `stripDiagnosticsFromSettings()`, all category normalizers)
  - `src/settings/persistence.js` (complete 76 lines: localStorage load/save/clear, export/import payload builders)
  - `src/settings/apply.js` (complete 159 lines: per-section settings application functions)
  - `src/settings/personalization.js` (275 lines, previously verified: Neumorphic CSS variable derivation)
  - `src/logs/engine.js` (complete 384 lines: `createLogEngine()`, process/entry model, deduplication, event emission, export)
- **Inferred Behavior:** None — all files in this scope were fully read.

## 4. Cross-System Dependencies
- **All Sections:** Every section reads from `settings.*` at document creation time and on settings change. Settings flow into documents via `applyEditorSettingsToDocument()`, `applyCompositeSettingsToDocument()`, `applyThreeDSettingsToDocument()`, `applyStitchSettingsToDocument()`.
- **Bootstrap:** Settings are loaded during app bootstrap via `loadPersistedAppSettings()` and injected into the application context.
- **Personalization → CSS:** `src/settings/personalization.js` computes derived CSS custom properties for the Neumorphic shell from the user's chosen hue, saturation, and lightness.
- **Log Engine → UI:** The log engine's snapshot subscriber pushes sorted process lists to the Logs workspace panel for rendering as status cards.
- **Log Engine → Engines:** All engines (3D, Stitch, Composite) and the task broker emit log entries via the log engine's `write()`/`info()`/`error()`/`progress()` methods.

## 5. State Behavior

### Settings
- **Saved (Durable):** The entire settings object (minus diagnostics) is persisted to `localStorage` under key `'noise-studio:app-settings:v1'`. Diagnostics are stripped before saving via `stripDiagnosticsFromSettings()`.
- **Runtime-only:** `settings.diagnostics` (detectedCpuCores, workerCapabilities, assetVersion, workerLimitApplied, storageEstimate), `settings.composite.diagnostics`, `settings.stitch.diagnostics`. These are probed at boot time and injected via the `options` parameter of `normalizeAppSettings()`.
- **Derived/Cached:** None — settings are applied directly; no intermediate cache.

### Logs
- **Saved (Durable):** Nothing. The log engine is entirely runtime-only.
- **Runtime-only:** All log processes, entries, history, listener subscriptions, and event subscriptions.
- **Derived/Cached:** Snapshots generated on demand via `getSnapshot()` and distributed to subscribers.

---

## 6. Current Behavior

### 6.1 Settings Schema & Defaults (`defaults.js`, `schema.js`)

**[VERIFIED]** The settings schema version is `1`. The full category structure:

| Category | Key Settings |
|---|---|
| `general` | `theme` (light/dark), `saveImageOnSave`, `maxBackgroundWorkers` |
| `library` | `autoLoadOnStartup`, `storagePressureThreshold` (0.8), `defaultViewLayout` (grid/list), `defaultSortKey` (timestamp/name/source-area/render-area), `defaultSortDirection` (asc/desc), `assetPreviewQuality` (performance/balanced/quality), `secureExportByDefault`, `requireTagOnImport` |
| `editor` | `defaultHighQualityPreview`, `hoverCompareOriginal`, `isolateActiveLayerChain`, `layerPreviewsOpen`, `autoExtractPaletteOnLoad`, `transparencyCheckerTone` (light/dark) |
| `composite.preferences` | `showChecker`, `zoomLocked`, `exportBackend` (auto/worker/main-thread) |
| `composite.diagnostics` | GPU caps: `maxTextureSize`, `maxRenderbufferSize`, `webglAvailable`, `webgl2Available`, `gpuSafeMaxEdge`, `autoWorkerThresholdMegapixels`, `autoWorkerThresholdEdge` |
| `stitch.defaults` | All algorithm tuning parameters (see `16_STITCH.md`) |
| `stitch.diagnostics` | `workerAvailable`, `wasmAvailable`, `runtimeAvailable`, `supportedDetectors`, `lastRuntimeSelection`, `lastFallbackReason` |
| `threeD.preferences` | Camera/navigation/view settings (see `15_THREED.md`) |
| `threeD.defaults` | Path tracing defaults: `samplesTarget`, `bounces`, `transmissiveBounces`, `filterGlossyFactor`, denoise settings, `toneMapping` |
| `logs` | `recentLimit` (18, range 6–200), `historyLimit` (0, range 0–2000), `autoClearSuccessMs`, `maxUiCards` (18, range 0–100), `completionFlashEffects`, `levelFilter` (all/warnings-errors), `compactMessages` |
| `personalization` | Hue, saturation, lightness, and other Neumorphic derivation inputs |
| `diagnostics` | `detectedCpuCores`, `workerCapabilities`, `assetVersion`, `workerLimitApplied`, `storageEstimate` |

**[VERIFIED]** `normalizeAppSettings()` accepts a raw candidate object and an `options` parameter for injecting runtime diagnostics. Every field is validated with type-appropriate normalization: `normalizeChoice()` for enums, `normalizeFiniteNumber()` for floats, `normalizeInteger()` for integers, explicit boolean checks for booleans.

### 6.2 Settings Persistence (`persistence.js`)

**[VERIFIED]** Storage mechanism:
1. **Load:** `loadPersistedAppSettings()` reads from `localStorage`, parses JSON, normalizes via `normalizeAppSettings()`. Falls back to defaults on missing/corrupt data.
2. **Save:** `persistAppSettings()` strips diagnostics, serializes to JSON, writes to `localStorage`.
3. **Clear:** `clearPersistedAppSettings()` removes the key from `localStorage`.
4. **Export:** `buildSettingsExportPayload()` wraps normalized settings in a `kind: 'noise-studio-settings'` envelope with `exportedAt` and `exportedFrom` metadata.
5. **Import:** `parseImportedSettingsPayload()` accepts a JSON string or object, extracts the `settings` sub-object (or the root if no envelope), and normalizes.

**[VERIFIED]** localStorage is wrapped in a `canUseLocalStorage()` guard that catches SecurityError in restricted contexts (e.g., sandboxed iframes).

### 6.3 Settings Application (`apply.js`)

**[VERIFIED]** Settings are applied to section documents via dedicated functions:

| Function | Target | What it applies |
|---|---|---|
| `applyEditorSettingsToDocument()` | Editor document | Theme, highQualityPreview, hoverCompare, isolateActiveLayerChain, layerPreviewsOpen |
| `applyEditorSettingsToLayerInstance()` | Individual layer instance | `bgPatcherCheckerTone` from `transparencyCheckerTone` |
| `applyCompositeSettingsToDocument()` | Composite document | showChecker, zoomLocked |
| `applyThreeDSettingsToDocument()` | 3D document | Camera prefs, view settings; on `mode='new'` also applies render defaults |
| `applyStitchSettingsToDocument()` | Stitch document | Theme; on `mode='new'` or `'apply-defaults'` also applies algorithm defaults |
| `applyThemeToStitchDocument()` | Stitch document | Theme only |

**[VERIFIED]** Factory functions exist for creating new settings-driven documents: `createSettingsDrivenCompositeDocument()`, `createSettingsDrivenThreeDDocument()`, `createSettingsDrivenStitchDocument()`.

### 6.4 Personalization System (`personalization.js`)

**[VERIFIED]** (Previously documented in `27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md`.) The personalization system mathematically derives CSS custom properties from base inputs (hue, saturation, lightness). These properties control the Neumorphic shell appearance: background surfaces, shadow pairs, accent colors, and text contrast.

### 6.5 Log Engine (`engine.js`)

**[VERIFIED]** The log engine is a factory function `createLogEngine(options)` that returns a process-oriented logging interface. It is entirely in-memory with no persistence.

**Architecture:**
- **Processes:** Named by `processId` (e.g., `'3d.assets'`, `'stitch.analysis'`). Each process tracks:
  - `id`, `label`, `status` (idle/active/success/warning/error), `level` (info/active/success/warning/error).
  - `progress` (0–1 ratio, nullable).
  - `entries[]` (recent, capped at `recentLimit`).
  - `history[]` (full, capped at `historyLimit` if > 0, otherwise unbounded).
  - `counts` (total, warning, error).
  - `startedAt`, `updatedAt`, `lastMessage`.
  - `awaitingCompletion` — Tracks whether the process transitioned through active/progress states, used to detect completion events.
- **Entries:** Each entry has: `id` (`processId:sequence`), `timestamp`, `level`, `status`, `message`, `progress`.

**API:**
| Method | Purpose |
|---|---|
| `write(processId, label, message, options)` | Core write. Handles deduplication, entry creation, status transitions, completion detection. |
| `info(id, label, msg, opts)` | Convenience: level=info, status=active |
| `active(id, label, msg, opts)` | Convenience: level=active, status=active |
| `success(id, label, msg, opts)` | Convenience: level=success, status=success, clears progress |
| `warning(id, label, msg, opts)` | Convenience: level=warning, status=warning |
| `error(id, label, msg, opts)` | Convenience: level=error, status=error |
| `progress(id, label, msg, ratio, opts)` | Convenience: sets progress ratio |
| `clearProcess(processId)` | Removes a process entirely |
| `clearAll()` | Removes all processes |
| `subscribe(listener)` | Subscribes to snapshot updates (batched via `requestAnimationFrame`) |
| `subscribeEvents(listener)` | Subscribes to individual write events (synchronous) |
| `exportProcessText(processId)` | Exports a process's full history as plain text |
| `configure(nextOptions)` | Updates `recentLimit` and `historyLimit` at runtime |

**Deduplication:** Each `write()` call computes a `dedupeKey` from `status|level|message|progress`. If the same key is written again within `dedupeWindowMs`, only the timestamp and progress are updated without creating a new entry. This prevents log spam from high-frequency progress updates.

**Publish batching:** Snapshot updates to subscribers are batched via `requestAnimationFrame` (or `setTimeout(0)` in non-browser contexts). Only one publish is queued per frame regardless of write frequency.

**Completion detection:** A process is considered "completed" when it transitions from `awaitingCompletion=true` to a terminal status (`success`/`error`). The `completed` flag in write events enables UI effects like completion flash animations.

### 6.6 Log Settings

**[VERIFIED]** Log behavior is configured via `settings.logs`:
- `recentLimit` (default 18, range 6–200): Max entries per process in the recent view.
- `historyLimit` (default 0, range 0–2000): Max entries in full history. 0 = unbounded.
- `autoClearSuccessMs` (default 0, range 0–3600000): Auto-clear successful processes after this delay. 0 = never.
- `maxUiCards` (default 18, range 0–100): Maximum process cards shown in the UI.
- `completionFlashEffects` (default true): Enable/disable visual effects on process completion.
- `levelFilter` (default `'all'`): `'all'` or `'warnings-errors'`.
- `compactMessages` (default true): Whether to use compact message display.

---

## 7. Open Questions & Verification Gaps
- How `autoClearSuccessMs` is actually consumed — the log engine accepts `recentLimit` and `historyLimit` in its constructor but doesn't appear to implement auto-clear internally. This is likely handled by the UI layer.
- How `maxUiCards` and `levelFilter` are applied — likely in the Logs workspace UI renderer, not in the engine itself.
- The exact timing and trigger for runtime diagnostics probing (CPU cores, worker capabilities, storage estimate) during bootstrap.
- Whether `maxBackgroundWorkers` in `settings.general` is actually enforced by the task broker, and how it relates to the broker's `maxConcurrentTasks` configuration.
