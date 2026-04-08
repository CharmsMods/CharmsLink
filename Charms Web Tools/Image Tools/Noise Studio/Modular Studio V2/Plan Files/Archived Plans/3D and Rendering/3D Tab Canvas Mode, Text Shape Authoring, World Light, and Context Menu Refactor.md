# 3D Tab Canvas Mode, Text/Shape Authoring, World Light, and Context Menu Refactor

## Summary
- Add a new 2D-in-3D authoring mode to the 3D tab so the scene can behave like a canvas: the camera can be `Perspective` or `Orthographic`, rotation can be locked to `Front / Back / Left / Right / Top / Bottom / Current`, panning stays enabled, and wheel behavior becomes canvas-friendly.
- Add new authoring primitives for `Text` and `2D Shapes`, with flat text for UI/mockup work and uploaded-font extruded text for 3D signage/title work.
- Add scene-level `World Light` support with solid color, unlimited-stop gradient, and uploaded HDRI environment lighting so renders no longer fall back to a black void.
- Make right-click object context menus the default object-interaction pattern in the 3D viewport. Quick object actions move there; sliders and dense numeric editing stay in the left dock.

## Public Interfaces / Document Changes
- Extend 3D view state with a canvas-navigation model:
```js
view: {
  projection: 'perspective' | 'orthographic',
  navigationMode: 'free' | 'canvas',
  lockedView: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'current',
  lockedRotation: [x, y, z, w] | null,
  orthoZoom: number,
  wheelMode: 'travel' | 'zoom'
}
```
- Add scene-level world environment state:
```js
scene: {
  worldLight: {
    enabled: boolean,
    mode: 'solid' | 'gradient' | 'hdri',
    intensity: number,
    backgroundVisible: boolean,
    rotation: number,
    color: string,
    gradientStops: Array<{ position: number, color: string }>,
    hdriAssetId: string | null
  }
}
```
- Add new item kinds:
  - `text`
  - `shape-2d`
- Add text item schema:
```js
text: {
  content: string,
  mode: 'flat' | 'extruded',
  fontSource: {
    type: 'upload' | 'system',
    assetId?: string,
    family?: string
  },
  color: string,
  opacity: number,
  glow: { enabled: boolean, color: string, intensity: number },
  characterOverrides: Array<{ index: number, flipX: boolean, flipY: boolean }>,
  extrude: { depth: number, bevelSize: number, bevelThickness: number, bevelSegments: number },
  attachment: {
    targetItemId: string,
    localPosition: [number, number, number],
    localNormal: [number, number, number],
    localTangent: [number, number, number],
    offset: number
  } | null
}
```
- Add 2D shape schema:
```js
shape2d: {
  type: 'square' | 'circle',
  color: string,
  opacity: number,
  glow: { enabled: boolean, color: string, intensity: number }
}
```
- Add new 3D actions for:
  - camera projection / canvas lock / locked view / wheel mode
  - add text / add 2D shape
  - update text / update 2D shape
  - attach text to surface / detach text
  - update world light / import HDRI
- Keep viewport context-menu open state UI-local only; do not persist menu state in the document.

## Implementation Changes
- Rework the camera layer in the engine so the viewport can switch between perspective and orthographic without rebuilding the entire workspace.
- Implement `canvas` navigation mode:
  - rotation is frozen
  - panning moves parallel to the active canvas plane
  - wheel behavior defaults to `travel` in perspective and `zoom` in orthographic
  - `Alt + Wheel` performs travel when orthographic is active
  - locking to `current` captures the current camera rotation and then freezes it
- Define the active canvas plane from the locked view:
  - `front/back` => XY plane
  - `left/right` => YZ plane
  - `top/bottom` => XZ plane
  - `current` => plane perpendicular to the captured camera normal at the current target depth
- Spawn new flat text and 2D shapes on the active canvas plane and orient them to the locked view automatically.
- Vendor and use `opentype.js` for uploaded font parsing. Use it for flat uploaded-font text and all extruded text geometry. Use browser/system font families only for flat text, rendered as transparent text planes.
- Restrict extruded/beveled text to uploaded fonts only. If a flat system-font text item is switched to `extruded`, require the user to pick an uploaded font first.
- Implement per-character flip as sparse per-index overrides. Store only changed characters, not one record per glyph by default.
- Define `glow` in v1 as emissive color/intensity shared by raster and path tracing. Do not add screen-space bloom in this pass so preview and final render stay consistent.
- Implement text surface attachment by raycasting to a model or primitive, storing the anchor in the target’s local space, and recomputing the text transform from that anchor each frame. If the target is deleted, bake the text’s current world transform and clear the attachment.
- Add `square` and `circle` as flat mesh items. Rectangle and ellipse behavior comes from normal transform scaling rather than separate item types.
- Implement world lighting as a unified environment pipeline:
  - `solid` builds a constant environment texture
  - `gradient` builds a generated equirectangular texture from unlimited color stops
  - `hdri` uses uploaded `.hdr` assets via `RGBELoader`
  - the resolved environment feeds raster background/environment and the path tracer background/environment
- Keep `World Light` in the dock as a scene-level editor, not an outliner object. Put all world-light editing in the `Scene` tab.
- Refactor the left dock to a smaller, more consolidated tab set:
  - `Outliner`
  - `Add`
  - `Selection`
  - `Scene`
  - `Render`
  - `Views`
- Move quick object actions into viewport context menus:
  - duplicate, rename, delete, hide/show, lock/unlock, reset transform
  - text-only: attach/detach, flat/extruded mode switch
  - shape-only: square/circle switch
  - solid-only: slice/reset cuts
  - material preset quick picks and simple toggles
- Keep sliders, numeric inputs, long forms, font pickers, gradient-stop editors, and bevel controls in the `Selection` or `Scene` dock tabs, behind foldouts where possible.
- Make right-click the universal context-menu trigger. Move fly-look activation to `Alt + Right Drag` so plain right-click is no longer overloaded.
- Implement nested context menus as a stack of anchored menus. Clicking outside, pressing `Escape`, or switching selection closes the full stack.

## Test Plan
- Camera and canvas mode:
  - switch between perspective and orthographic
  - lock to each preset view plus `current`
  - confirm rotation is frozen, pan works, and wheel behavior matches the selected mode
  - confirm `Alt + Right Drag` still enables fly-look in free fly mode
- Text:
  - add flat text with uploaded font
  - add flat text with system font
  - add extruded text with uploaded font
  - verify extruded mode is blocked until an uploaded font is chosen
  - verify per-character flip, opacity, emissive glow, and save/load persistence
- Surface attachment:
  - attach text to a primitive and a model surface
  - move/rotate/scale the target and confirm the text follows
  - delete the target and confirm the text remains in place as a detached item
- Shapes:
  - add square and circle in canvas mode
  - scale them into rectangle/ellipse forms
  - confirm raster/path-trace visibility and save/load persistence
- World light:
  - test solid, multi-stop gradient, and HDRI modes
  - confirm raster preview and exported render both avoid black-void backgrounds when enabled
  - confirm environment changes reset samples only when the world-light state actually changes
- Context menus:
  - right-click selected and unselected objects
  - open nested submenus
  - confirm outside click and `Escape` close the menu stack
  - verify no sliders appear directly inside menus
- Regression checks:
  - outliner, transforms, cuts, path tracing, render PNG, and existing model/image/light flows remain reachable
  - switching site tabs still preserves accumulated path-trace samples when the 3D document has not changed

## Assumptions / Defaults
- This ships in three passes:
  1. camera/canvas mode + context-menu foundation + dock consolidation
  2. flat text + 2D shapes + surface attachment
  3. extruded text + world light + HDRI + render integration
- Flat text supports both uploaded fonts and browser/system font families. Extruded text supports uploaded fonts only.
- V1 glow is emissive-only, not bloom-based.
- V1 HDRI support accepts uploaded `.hdr` files.
- World Light is treated as scene state, not a transformable scene object.
- The 3D dock remains the home for global scene/render controls and dense property editing; the viewport context menu becomes the standard place for quick object actions.
