# Site Bundler Modernization And Stability Refactor

## Summary
- Refactor the whole app into a modular, typed browser application served as a static HTTP build.
- Replace the current up-front runtime payload and CDN/vendor-script approach with build-time bundling plus lazy-loaded heavy tooling.
- Keep all existing tabs, but rebuild the bundler around a path-accurate asset graph so builds are more correct, more powerful, and less bug-prone.
- Deliver a single handoff file at [bundler site.txt](<E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Site Bundler/Current Bundler/bundler site.txt>) that documents what the site does, how it works, known limits, and the current site location.

## Implementation Changes
- Introduce a `src/` codebase with Vite + TypeScript, and ship a static `dist/` output. Keep the current brutalist UI direction, but stop hand-maintaining one 3k-line script.
- Remove runtime `lib/*.js` loading and the CDN toggle from the user flow. Use packaged dependencies (`clean-css`, `html-minifier-terser`, `terser`, `diff`, `jszip`, `file-saver`) with lazy imports and a dedicated worker module.
- Replace global mutable state with canonical models for assets, config, build results, session snapshots, and reference scans.

- Rebuild the bundler engine around a real asset graph:
  - Resolve references relative to the source asset’s directory first, then exact normalized paths, then explicit ambiguous-match warnings.
  - Support the asset types the scanner already implies: HTML, CSS, JS, images, fonts, audio/video, JSON, WASM, PDF, TXT/CSV/XML, manifests, and maps.
  - Store binary assets with MIME-aware metadata instead of treating almost everything as text or image-only data URLs.
  - Generate one authoritative `BuildResult` that drives preview, downloads, ZIP output, report metrics, and saved session state.

- Fix the concrete contradictions and bug paths found in the current site:
  - Stop excluding non-entry HTML pages before bundle assembly; preserve them as secondary output artifacts in bundle mode.
  - Snapshot output filenames at build time so post-build filename edits cannot create broken ZIPs or mismatched HTML references.
  - Preserve directory paths on rename/duplicate instead of flattening assets to the root.
  - Replace the current “unused means excluded” modal with a selectable review list so conservative reference detection cannot silently drop intended bundle inputs.
  - Make mode availability match real engine capability. Inline should not be disabled when the engine can auto-generate an entry wrapper, and batch should work for single-file minification.
  - Align the entry-point badge/help text with actual behavior instead of always implying “first HTML file wins.”

- Refactor each utility tab to match the same data model:
  - Extractor: extract inline CSS/JS, `srcset`, `<source>`, CSS `url()`, inline style URLs, and data URLs into a manifest-driven export set.
  - Folder Cleaner: keep the non-empty-folder copy behavior, but label and document it accurately, add a dry-run summary, and surface name-collision handling.
  - Image Converter: fix the `DataTransferItem.getAsFile` misuse, support click-to-upload folders, preserve paths predictably, and unify converted/passthrough ZIP rules.

- Update the UI copy and internal docs:
  - Rewrite the help modal and status text so they match actual entry selection, ZIP behavior, scan limits, and batch/link rules.
  - Add the handoff file with purpose, tab-by-tab behavior, supported asset types, session format, architecture summary, deployment notes, known issues, and the current path `E:\WEBSITE\CharmsLink\CharmsLink\Charms Web Tools\Site Bundler\Current Bundler`.

## Public Interfaces / Types
- `AssetRecord`: `id`, `kind`, `name`, `path`, `mime`, `textContent?`, `binaryContent?`, `source`.
- `BuildConfig`: `mode`, minify flags, comment/console policy, artifact names, ZIP policy, reference-rewrite policy.
- `ReferenceGraphEntry`: `sourceAssetId`, `rawRef`, `resolvedAssetId?`, `resolutionType`, `warning`.
- `BuildResult`: `artifacts[]`, `entryHtmlId`, `secondaryHtmlIds`, `previewDoc`, `report`, `warnings`.
- `SessionSnapshot`: source assets, config, and minimal reproducible build metadata only. Do not persist derived diff markup or duplicate artifact payloads.

## Test Plan
- Unit tests for path normalization, relative resolution, duplicate-basename handling, rename/path preservation, and filename snapshot behavior.
- Worker/service tests for HTML/CSS/JS minification, asset emission, ZIP rewriting, session save/load, and fallback behavior.
- Playwright end-to-end fixtures for single-file minify, inline bundle, multi-page bundle, batch ZIP with linked paths, missing references, extractor output, cleaner dry-run/execution, and image converter drag-drop/folder upload/export.
- Regression fixtures for the current contradictions: non-entry HTML being dropped, post-build filename edits breaking downloads, basename-based false matches, and converter item handling failures.

## Assumptions
- The refactor can assume HTTP/static-host execution for the built app; `file://` compatibility is not required.
- Whole-site coverage is in scope.
- Broader asset support is part of the bundler rewrite, not a separate future phase.
- Visual redesign is out of scope unless needed to clarify behavior or remove misleading UI.
