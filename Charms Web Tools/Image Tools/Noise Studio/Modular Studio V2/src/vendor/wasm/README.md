This directory holds generated Emscripten browser artifacts for the Editor and Library WASM runtimes.

Expected outputs:

- `editor/editor-kernels.mjs`
- `editor/editor-kernels.wasm`
- `editor/editor-kernels-simd.mjs`
- `editor/editor-kernels-simd.wasm`
- `library/library-codec.mjs`
- `library/library-codec.wasm`
- `library/library-codec-simd.mjs`
- `library/library-codec-simd.wasm`

Build commands:

- `npm run build:wasm`
- `npm run build:wasm:editor`
- `npm run build:wasm:library`

Notes:

- The app runtime falls back to the JS worker implementations when these artifacts are missing or cannot be loaded.
- This repository now includes the native source and the build entrypoint, but the real artifacts must be generated with Emscripten (`emcc`) before the WASM path becomes active.
- Placeholder `.mjs` stubs are committed so the runtime can fail cleanly and log a JS fallback reason instead of producing noisy missing-module errors.
