# Electron and Desktop Behavior

## 1. Purpose
This document describes the Electron desktop wrapper that allows the web application to run as a native desktop app. It covers the main process, preload bridge, renderer-side detection, and how desktop capabilities augment the browser-only feature set.

## 2. Scope
Covers `electron-main.js` (main process), `preload.js` (context bridge), `src/io/localSave.js` (desktop-aware save layer), and any references to `window.desktopBridge` in the renderer.

## 3. Verification State
- **Verified from Source:**
  - `electron-main.js` (complete 141 lines)
  - `preload.js` (complete 33 lines)
  - `src/io/localSave.js` (complete 132 lines)
- **Inferred Behavior:** How section engines detect Electron at runtime is limited to the `getDesktopBridge()` check in `localSave.js` and any renderer-side `window.desktopBridge` usage.

## 4. Cross-System Dependencies
- **Local Save → Electron:** `saveBlobLocally()` checks for `window.desktopBridge.saveFile` and routes to the native save dialog when available.
- **File Import → Electron:** `window.desktopBridge.showOpenDialog` enables native file-open dialogs.
- **Capabilities → Settings:** `getLocalSaveCapabilities()` exposes `isElectron`, `desktopBridge`, and `browserDownload` booleans for runtime feature detection.

## 5. State Behavior
- **Saved (Durable):** Same as browser (IndexedDB + localStorage), plus native filesystem access for exported files.
- **Runtime-only:** Electron `BrowserWindow` instance, IPC channel handles.
- **Derived/Cached:** None.

---

## 6. Current Behavior

### 6.1 Electron Main Process (`electron-main.js`)
**[VERIFIED]** The Electron app uses version `^41.1.0` (from `package-lock.json`). The main process:

**Window creation:**
- Creates a single `BrowserWindow` (1200×800, titled "Studio").
- Uses `ico.ico` as the window icon.
- Web preferences: `nodeIntegration: false`, `contextIsolation: true`, `preload: preload.js`.
- Loads `index.html` directly via `mainWindow.loadFile('index.html')`.

**IPC Handlers:**
| Channel | Purpose |
|---|---|
| `desktop-save-file` | Shows a native save dialog, writes bytes to the chosen file path |
| `desktop-show-open-dialog` | Shows a native open dialog, returns selected file paths |

**Save file handler:**
- Receives: `title`, `buttonLabel`, `suggestedName`, `filters` (file type filters), `data` (Uint8Array).
- Sanitizes the filename (strips dangerous characters, collapses whitespace).
- Defaults the save path to the user's Downloads folder.
- Writes bytes using `fs/promises.writeFile` with `Buffer.from(bytes)`.
- Returns `{ status: 'saved', source: 'desktop-bridge', filePath, fileName }` or `{ status: 'cancelled' }` or `{ status: 'failed', error }`.

**Open dialog handler:**
- Receives: `title`, `buttonLabel`, `defaultPath`, `filters`, `multiple` (boolean).
- Returns `{ status: 'selected', filePaths }` or `{ status: 'cancelled', filePaths: [] }`.

**Monitoring:**
- Logs renderer console messages with level labels (verbose/info/warning/error).
- Logs `render-process-gone` crashes.
- Logs `unresponsive` window events.
- Logs `did-fail-load` page load failures.

### 6.2 Preload Bridge (`preload.js`)
**[VERIFIED]** The preload script uses `contextBridge.exposeInMainWorld('desktopBridge', ...)` to expose a safe API:

```
window.desktopBridge = {
    isElectron: true,
    platform: process.platform,        // 'win32', 'darwin', 'linux'
    capabilities: {
        saveDialog: true,
        openDialog: true,
        fileWrites: true
    },
    saveFile(options) → IPC 'desktop-save-file',
    showOpenDialog(options) → IPC 'desktop-show-open-dialog'
}
```

Data serialization: The `saveFile` method ensures `data` is a `Uint8Array` before sending over IPC. The `showOpenDialog` method passes filter options and multi-selection flag.

### 6.3 Renderer-Side Detection (`localSave.js`)
**[VERIFIED]** The application detects Electron at runtime:
```
function getDesktopBridge() {
    return globalThis.window?.desktopBridge || null;
}
```

`saveBlobLocally(blob, filename, options)` uses a two-tier strategy:
1. **Desktop bridge available (Electron):** Reads the blob into a `Uint8Array`, calls `bridge.saveFile()` with the native save dialog. Returns the result (with `filePath` from the OS).
2. **Browser fallback:** Creates a temporary object URL, creates an invisible `<a>` link with `download` attribute, clicks it. Returns `{ status: 'saved', source: 'browser-download', fileName }`. Revokes the URL after 2 seconds.

The `options.preferDesktop` parameter allows callers to explicitly bypass the desktop bridge.

### 6.4 Feature Differences: Electron vs. Browser

| Feature | Browser | Electron |
|---|---|---|
| File Export | Browser download (no path control) | Native save dialog with chosen path |
| File Import | `<input type="file">` or drag-drop | Native open dialog + `<input>` fallback |
| IndexedDB | Browser-scoped | App-scoped (persistent across sessions) |
| localStorage | Browser-scoped | App-scoped |
| WebGL/Workers | Browser-dependent | Chromium-consistent |
| Window Title | Browser tab title | Custom window title ("Studio") |
| File Path Feedback | Not available | Full OS path returned from save |

### 6.5 No Custom Protocol or Deep Integration
**[VERIFIED]** The Electron wrapper is intentionally thin:
- No custom protocol handlers (e.g., `app://`).
- No menu bar customization.
- No auto-updater.
- No tray icon.
- No file association registration.
- No `shell.openPath()` or `shell.openExternal()` usage.
- DevTools are available but commented out by default.

The entire application logic runs in the renderer process using the same web codebase. Electron only adds native file dialogs and direct filesystem writes.

---

## 7. Open Questions & Verification Gaps
- Whether there are any additional IPC channels defined elsewhere (e.g., in the renderer) beyond the two in `electron-main.js`.
- Whether `navigator.storage.persist()` is called in Electron mode to prevent data eviction.
- How the 3D engine's `electron` mention in `ui.js` info-banner ("embedded `.glb`... for both browser and Electron builds") affects asset handling — likely just a UI hint, not behavior change.
- Whether `electron-builder` configuration (in `package.json` or a separate config) defines any platform-specific packaging, signing, or resource inclusion.
