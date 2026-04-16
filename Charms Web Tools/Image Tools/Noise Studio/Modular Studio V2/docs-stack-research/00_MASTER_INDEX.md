# Modular Studio V2 - Architecture Documentation Master Index

## Purpose
This documentation set provides a highly accurate, non-code explanation of how Modular Studio V2 currently works, including its systems, design behavior, and data models. It serves as the definitive source of truth for the present state of the application to aid future AI sessions in safely fully refactoring the web-based app into a native C++ rebuild dubbed `Stack`. 

## How to Read This Set
- **Factual Current State Over Everything:** The `/current-state/` folder documents the app exactly as it functions based on direct repository inspection.
- **Rebuild Needs Separated:** Any recommendations or evaluations regarding transition to native C++ are strictly isolated in `/native-rebuild-notes/`. 
- **Code is Authoritative:** If these documents and the codebase disagree, the source code is the correct truth, and the contradictions should be tracked in the `/audit-tracking/91_CONTRADICTIONS_AND_VERIFICATION_GAPS.md` file.

Please review `01_READING_ORDER.md` to see the recommended pipeline for understanding these documents, and `02_VERIFICATION_RULES.md` for understanding how to maintain the accuracy of this knowledge base.

## Documentation Standard Header Template
All current-state files use the following format:
1. **Purpose:** High-level description of what the file covers.
2. **Scope:** System boundaries included and excluded.
3. **Verification State:** Exact files audited and inferred behaviors that need checking.
4. **Cross-System Dependencies:** Relationships to other modules (inputs/outputs).
5. **State Behavior:** Differentiates between *Saved (Durable)*, *Runtime-only*, and *Derived/Cached*.
6. **Current Behavior:** The factual, detailed explanation of the system.
7. **Open Questions & Verification Gaps:** Uncertainties pending future passes.

## Included Guides and Coverage

### Phase 2 Verified Priority Files
*These files represent the foundational systems audited first.*
- **[10_PRODUCT_MODEL.md](current-state/10_PRODUCT_MODEL.md):** The core 7-section single-page app structure and the foundational responsibilities of each section.
- **[20_RUNTIME_BOOTSTRAP_AND_SHELL.md](current-state/20_RUNTIME_BOOTSTRAP_AND_SHELL.md):** Application entry, context wiring, engine initialization, and top-level workspace rendering.
- **[12_EDITOR.md](current-state/12_EDITOR.md):** The legacy WebGL image processing engine, text overlays, DNG develop layer, and its relationship to the canvas.
- **[22_PROJECT_ADAPTERS_AND_CROSS_SECTION_LINKS.md](current-state/22_PROJECT_ADAPTERS_AND_CROSS_SECTION_LINKS.md):** How different sections hand off payloads into the shared Library and track origins.
- **[23_SAVE_LOAD_IMPORT_EXPORT.md](current-state/23_SAVE_LOAD_IMPORT_EXPORT.md):** How data flows out into files, back into the Studio, and the difference between embedded payloads and local binary files.
- **[27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md](current-state/27_DESIGN_SYSTEM_AND_UI_BEHAVIOR.md):** The shared neumorphic shell, layout behaviors, panel behaviors, styling systems, and UI architecture.

### Phase 3 Section-Specific Files
*These files document the individual section engines and cross-cutting systems.*
- **[13_LIBRARY.md](current-state/13_LIBRARY.md):** IndexedDB project/asset store, tag management, secure import/export, preview generation, storage pressure monitoring.
- **[14_COMPOSITE.md](current-state/14_COMPOSITE.md):** 2D layer compositor for multi-image arrangement using Canvas 2D rendering.
- **[15_THREED.md](current-state/15_THREED.md):** Three.js scene editor with raster/pathtrace/mesh render modes, dual camera system, GLTF/DRACO/KTX2 asset pipeline, world lighting, 3D text.
- **[16_STITCH.md](current-state/16_STITCH.md):** Panoramic image stitching with dual-backend analysis (JS screenshot / OpenCV WASM photo), mesh warping, multi-band blending with seam carving.
- **[17_SETTINGS_AND_LOGS.md](current-state/17_SETTINGS_AND_LOGS.md):** Application-wide settings schema, localStorage persistence, per-section settings application, Neumorphic personalization, process-oriented log engine.

### Phase 4 Deep System-Level Files
*These files document the foundational infrastructure underpinning all sections.*
- **[21_STATE_MODELS_AND_DOCUMENT_TYPES.md](current-state/21_STATE_MODELS_AND_DOCUMENT_TYPES.md):** Reactive store primitive, document type classification, per-section normalizers, library payload builders, project fingerprinting, origin tracking.
- **[24_STORAGE_AND_INDEXEDDB.md](current-state/24_STORAGE_AND_INDEXEDDB.md):** IndexedDB schema (ModularStudioDB v3), CRUD operations, attachment system for DNG blobs, record types, tag catalog, localStorage settings, storage estimation.
- **[25_RENDERING_AND_PROCESSING.md](current-state/25_RENDERING_AND_PROCESSING.md):** Editor WebGL2 pipeline, Composite Canvas 2D, 3D Three.js path tracing, Stitch multi-band blending, GPU capabilities detection, WASM acceleration (Editor + Library runtimes).
- **[26_WORKERS_AND_BACKGROUND_TASKS.md](current-state/26_WORKERS_AND_BACKGROUND_TASKS.md):** Background task broker architecture, 6 worker domains with all registered tasks, message protocol, worker lifecycle, cancellation/scope/replay, capabilities detection.
- **[28_ELECTRON_AND_DESKTOP_BEHAVIOR.md](current-state/28_ELECTRON_AND_DESKTOP_BEHAVIOR.md):** Electron main process, preload context bridge, native save/open dialogs, renderer-side detection, feature comparison vs. browser.
- **[29_PERFORMANCE_AND_LIMITATIONS.md](current-state/29_PERFORMANCE_AND_LIMITATIONS.md):** GPU texture caps, worker concurrency, FBO pool allocation, memory management, rendering budgets, IDB overhead, browser-imposed limitations with native rebuild implications.

### Audit & Tracking
- **[91_CONTRADICTIONS_AND_VERIFICATION_GAPS.md](audit-tracking/91_CONTRADICTIONS_AND_VERIFICATION_GAPS.md):** Running list of discrepancies between old context files and live code.

*(Note: The native-rebuild-notes/ files will be generated in subsequent batches once all current-state documentation is complete.)*

## Updating the Documentation
Whenever you modify a section of the codebase:
1. Identify the corresponding `current-state` file.
2. Update the `Verification State` header.
3. Validate and adjust the documentation to reflect the new factual behavior.
4. If a systemic change occurs (like changing project payload shapes), assure `21_STATE_MODELS_AND_DOCUMENT_TYPES.md` is updated.
