# Reading Order

This guide suggests the best path to absorb the Modular Studio V2 documentation set, moving from high-level app models down to specific subsystems and data lifecycles.

## 1. Top-Level Understanding First
Begin here to understand what the application *is*, how it starts up, and how it delegates control:
1. **[10_PRODUCT_MODEL.md](current-state/10_PRODUCT_MODEL.md)** (The 7-section single page app model)
2. **[20_RUNTIME_BOOTSTRAP_AND_SHELL.md](current-state/20_RUNTIME_BOOTSTRAP_AND_SHELL.md)** (Entry points, context wiring, routing)
3. **[27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md](current-state/27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md)** (The app's physical structure, responsive logic, and component identity as architecture)

## 2. Core Functional Systems
Once the skeleton is clear, read about the core workflow engines. Start with the oldest and heaviest system:
4. **[12_EDITOR.md](current-state/12_EDITOR.md)** (WebGL engine, DNG, layer stack)
5. **[14_COMPOSITE.md](current-state/14_COMPOSITE.md)** (2D engine, layer relationships)
6. **[15_THREED.md](current-state/15_THREED.md)** (Three.js integration, path tracing jobs)
7. **[16_STITCH.md](current-state/16_STITCH.md)** (OpenCV workers, candidates, mesh solvers)
8. **[13_LIBRARY.md](current-state/13_LIBRARY.md)** (Integrated browser UI, IndexedDB querying)

## 3. Data Flow and Inter-System Communication
After understanding individual engines, read how they talk to each other and sync with storage:
9. **[22_PROJECT_ADAPTERS_AND_CROSS_SECTION_LINKS.md](current-state/22_PROJECT_ADAPTERS_AND_CROSS_SECTION_LINKS.md)** (Origins, adapters, cross-boundary transitions)
10. **[23_SAVE_LOAD_IMPORT_EXPORT.md](current-state/23_SAVE_LOAD_IMPORT_EXPORT.md)** (Blobs vs payloads vs JSON strings, and import sequences)
11. **[24_STORAGE_AND_INDEXEDDB.md](current-state/24_STORAGE_AND_INDEXEDDB.md)** (Library backend models)
12. **[21_STATE_MODELS_AND_DOCUMENT_TYPES.md](current-state/21_STATE_MODELS_AND_DOCUMENT_TYPES.md)** (Raw JSON schema structure)

## 4. Sub-System Details & Debugging
If you need specifics on execution paths or limits:
13. **[25_RENDERING_AND_PROCESSING.md](current-state/25_RENDERING_AND_PROCESSING.md)**
14. **[26_WORKERS_AND_BACKGROUND_TASKS.md](current-state/26_WORKERS_AND_BACKGROUND_TASKS.md)**
15. **[17_SETTINGS_AND_LOGS.md](current-state/17_SETTINGS_AND_LOGS.md)**
16. **[28_ELECTRON_AND_DESKTOP_BEHAVIOR.md](current-state/28_ELECTRON_AND_DESKTOP_BEHAVIOR.md)**
17. **[29_PERFORMANCE_AND_LIMITATIONS.md](current-state/29_PERFORMANCE_AND_LIMITATIONS.md)**

## 5. Migration to Native
Finally, review the native rebuild strategies *only* after fully understanding the current state.
- Start with **[40_STACK_REBUILD_GOALS.md](../native-rebuild-notes/40_STACK_REBUILD_GOALS.md)** and proceed through the `native-rebuild-notes` directory.
