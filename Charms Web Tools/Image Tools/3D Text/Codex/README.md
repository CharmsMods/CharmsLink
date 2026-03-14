# Glass Path Tracer (Client-Side)

A production-focused, client-side single-page app that loads 3D models, converts them to physically-based glass, path-traces them progressively in the browser, and exports high-resolution PNG renders.

## Highlights
- Client-only pipeline (no server): load, convert, path-trace, export.
- GLB/GLTF primary support, plus OBJ/FBX/PLY (limited PBR fidelity).
- Progressive GPU path tracing with live sample counter and pause/reset.
- Glass controls: transmission, opacity (0–255), IOR, roughness, thickness/absorption, tint, normal intensity.
- Texture overlay with alpha, scale, offset, rotation.
- High-resolution export with automatic tiled rendering when size exceeds GPU limits.
- Keyboard shortcuts: Space (pause/resume), S (export current), R (reset samples).

## Run Locally (No Build Step)
Serve the `src/` folder with any static server and open `src/index.html`.

Example commands (pick one):
- `python -m http.server` (run inside `src/`, then open http://localhost:8000)
- `npx http-server` (run inside `src/`)

> Note: Local file URLs (`file://`) are blocked by browser module security. Use a local server.

## Optional Decoders
- Draco: place Draco decoder files at `/draco/` and leave the loader path as-is.
- Basis/KTX2: place BasisU transcoder files at `/basis/`.

## Limitations
- Best PBR fidelity is with GLB/GLTF. OBJ/FBX/PLY load but may lose material details.
- Skinned animations are not supported for path tracing.

## File Layout
```
src/
  index.html
  main.js
  styles.css
  app/
    renderer.js
    loaders.js
    materials.js
    ui.js
    export.js
    bvh.js
    worker/
examples/
README.md
LICENSE
package.json
__tests__/
```

## License
MIT
