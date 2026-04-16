# Runtime Bootstrap and Shell

## 1. Purpose
This document explains how Modular Studio V2 starts up, initializes its various engines, coordinates the globally shared context, and routes user navigation to the correct section workspace. 

## 2. Scope
This file covers the main JavaScript entry points (`src/main.js`), the primary application builder (`src/app/bootstrap.js`), context distribution (`src/app/context.js`), and top-level workspace creation (`src/ui/workspaces/index.js`). It excludes the internal state behavior of individual sections (e.g., Editor layout details), except for how the Shell toggles their visibility.

## 3. Verification State
- **Verified from Source:** 
  - `src/main.js`
  - `src/app/bootstrap.js`
  - `src/app/context.js`
  - `src/ui/workspaces/index.js`
- **Inferred Behavior:** N/A (Confirmed via direct file reading).

## 4. Cross-System Dependencies
- **Settings Store:** Bootstrap requires loading the serialized global settings from IndexedDB/localStorage before it can configure the background workers or initial UI parameters.
- **Project Adapters:** Bootstrapping creates an adapter registry to allow Library code to pass projects into correct engines.
- **Workers:** Bootstrap spins up the task broker and identifies whether the active browser supports features like `OffscreenCanvas` and WASM required for 3D/Stitch.
- **Log Engine:** The `bootstrapStudioApp` function binds heavily into `src/logs/engine.js` so "process streams" display startup sequences in the real Logs panel.

## 5. State Behavior
- **Saved (Durable):** None managed directly by the Shell itself; the Shell relies completely on `state.ui.activeSection`.
- **Runtime-only:** The `createAppContext()` provides an ephemeral, mutating singleton map containing references to `store`, `actions`, `registry`, `view`, `db`, `logger`, `workers`, and `dngRuntime`.
- **Derived/Cached:** Capability detection (e.g., "Does this monitor support P3?", "Does this browser support Web Worker Canvas?") is performed once at startup and locked in memory.

---

## 6. Current Behavior 

### The Entry Flow
The application launch sequence avoids placing everything in a single massive controller file.
1. `index.html` loads early scripts (e.g., JSZip) and sets up a `#app` div.
2. `src/main.js` executes immediately upon `DOMContentLoaded`, acting as a very thin wrapper that invokes `bootstrapStudioApp({ root: el })` from `src/app/bootstrap.js`.

### Context Assembly
A central `createAppContext(initial)` object is manufactured. As different domains initialize (Store, Graphics Probes, Worker detection, Editor Engine), their references are injected into this merged context. The result is that actions bound deep inside the UI components can reference `context.actions` or `context.registry` without large cyclic import chains.

### Bootstrap Sequence
`bootstrapStudioApp` runs an explicit launch pipeline, creating log cards along the way:
1. **Capabilities Probe:** Measures Graphics Limits (WebGL Max Texture Size, etc.) and Worker limits.
2. **Settings Hydration:** Reads global preferences (Theme, Export limits) and applies them.
3. **Database Spin-up:** Opens the IndexedDB Library database.
4. **Context Building:** Creates the Redux-like global `store`. Injects the adapter registry for all 4 project types. Spawns background worker instances.
5. **Initial State Resolve:** Looks at the URL param `?section=X`. If `?section=library` is passed, the UI begins there. Otherwise, it points to `Editor`.
6. **Shell Render:** Passes the assembled state into `createWorkspaceUI()`, inserting the main container layout into `#app`.

### Workspace UI Routing
`src/ui/workspaces/index.js` manages the actual shell. 
It functions as a mega-component that builds out the top navigation bar. Based on `state.ui.activeSection`, it displays or hides major panels:
- Editor (`#editor-workspace`)
- Composite (`#composite-workspace`)
- Library (`#library-loader-wrapper`)
- Stitch (`#stitch-workspace`)
- 3D (`#three-d-workspace`)
- Settings (`#settings-workspace`)
- Logs (`#logs-workspace`)

**Critical Off-Screen Behavior:**
When you switch an `activeSection`, the router does NOT destroy the DOM of the previous section, nor does it wipe out the in-memory engine canvas. It visually hides it (or moves it off-screen) using CSS blocks. Wait states are deployed:
- Pausing `3D` viewport rendering while you are browsing the `Library`.
- Deferring WebGL `Editor` updates when inside `Stitch`.
These intentional pausing rules are managed centrally by the shell checks so you don't bleed background performance.

---

## 7. Open Questions & Verification Gaps
- None at this level. The bootstrap split from `main.js` and context assembly logic matches the context file exactly.
