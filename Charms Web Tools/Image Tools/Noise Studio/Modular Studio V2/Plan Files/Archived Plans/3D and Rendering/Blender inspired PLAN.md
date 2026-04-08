# Blender-Inspired 3D Workspace UI Overhaul

## Summary
- Replace the current floating 3D overlay with a structured dark workstation shell modeled after Blender’s core layout patterns: top workspaces, left scene browser, center viewport, right properties editor, and bottom status bar.
- Use a combined tab system, per your direction:
  - Top task tabs: `Layout`, `Model`, `Render`
  - Left data tabs: `Outliner`, `Add`, `Views`
  - Right data tabs: `Object`, `Material`, `Scene`, `Render`
- Keep the first pass minimal and professional by focusing on structure, density, and clarity rather than cloning every Blender area/editor behavior.
- Scope the Blender-like visual treatment to the 3D workspace only; do not restyle Editor, Library, or Stitch.
- Research basis: Blender’s [Workspaces](https://docs.blender.org/manual/en/4.0/interface/window_system/workspaces.html), [Properties Editor](https://docs.blender.org/manual/en/latest/editors/properties_editor.html), [3D Viewport](https://docs.blender.org/manual/en/latest/editors/3dview/index.html), [3D Viewport Sidebar](https://docs.blender.org/manual/en/latest/editors/3dview/sidebar.html), and [Status Bar](https://docs.blender.org/manual/en/latest/interface/window_system/status_bar.html).

## Public Interfaces / State Changes
- Add a persisted `workspace` section to `threeDDocument` in [src/3d/document.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/document.js) so 3D tabs behave like the Editor’s tab system.
- Use this exact shape:
```js
workspace: {
  taskView: 'layout',
  taskTabs: {
    layout: { leftTab: 'outliner', rightTab: 'scene' },
    model: { leftTab: 'add', rightTab: 'object' },
    render: { leftTab: 'views', rightTab: 'render' }
  }
}
```
- Add a new action in [src/main.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/main.js): `updateThreeDWorkspace(patch)` for `taskView` and `taskTabs` updates.
- Normalize and serialize `workspace` with defaults so older 3D documents load cleanly without migration prompts.

## Implementation Changes
- Rebuild the 3D shell in [src/3d/ui.js](E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/3d/ui.js) into five persistent regions:
  - Top workspace strip for `Layout`, `Model`, `Render`
  - Left sidebar with vertical tab rail and one active panel body
  - Center viewport with a thin header bar
  - Right properties sidebar with vertical tab rail and one active panel body
  - Bottom status bar for hints, progress, and stats
- Use task tabs as workspace presets, not hard feature gates:
  - `Layout` defaults to left `Outliner`, right `Scene`
  - `Model` defaults to left `Add`, right `Object`
  - `Render` defaults to left `Views`, right `Render`
  - Each task remembers its own last-used left/right tabs through `workspace.taskTabs`
- Map current controls into the new panels exactly like this:
  - `Outliner`: scene items list, selection, visibility/lock state, item type badges
  - `Add`: load models, add image planes, save to library, new scene, add lights, add primitives
  - `Views`: camera presets, reset view, frame selected, camera-mode help, viewport mode quick info
  - `Object`: name, transform, duplicate/delete/reset, boolean slice/reset, item-specific controls
  - `Material`: material preset, base/emissive/glass controls, textures
  - `Scene`: background, grid, axes, camera FOV, orbit/fly mode, snapping
  - `Render`: raster/pathtrace/mesh mode, samples, denoise, bounces, output size, render/abort, job state
- Keep transform mode buttons, render mode switch, sample readout, frame/reset, and fullscreen controls in the viewport header so the center area feels tool-driven instead of form-driven.
- Replace the current oversized status pill with a Blender-like bottom strip:
  - Left: contextual shortcut hints such as `1/2/3`, `F`, fly/orbit hint
  - Center: render/pathtrace/prep messages
  - Right: lightweight stats such as selected item, item count, sample count, render mode
- Keep the existing render takeover behavior and pathtrace loading overlay; only restyle/reposition them to fit the new shell.
- Do not add Blender-style area splitting, drag-to-create editors, or a timeline in this pass.

## Visual / UX Rules
- Use a 3D-only dark palette with restrained contrast:
  - Background `#1f2124`
  - Panel `#262a2f`
  - Panel-alt `#2d3137`
  - Border `#3a4048`
  - Text `#d8dbe0`
  - Muted `#98a1ab`
  - Accent `#6ea8ff`
- Replace glassmorphism, blur-heavy cards, and large rounded boxes with flatter panels, thin separators, compact tab rails, and tighter spacing.
- Base sizing:
  - Main text `12px`
  - Secondary labels `11px`
  - Tab labels `12px`
  - Controls `26-28px` tall
- Use subtle motion only:
  - `120-160ms` opacity/translate transitions for tab content and drawer changes
  - No large animated panels, bounce, or glossy effects
- Keep the viewport dominant at every size.
- Responsive behavior:
  - Wide windows: full 3-column layout
  - Medium windows: narrower left panel, right panel preserved
  - Small windows: only one sidebar body open at a time, with tab rails still visible
- Reuse the app’s existing tab/button behavior where practical, but style the 3D workspace as its own scoped workstation surface.

## Test Plan
- Verify all current 3D features remain reachable after the re-layout: import, create, select, transform, slice, edit materials, save camera presets, render, abort render.
- Verify task tab persistence:
  - switch `Layout -> Model -> Render -> Layout`
  - confirm each task restores its own remembered left/right tabs
- Verify save/load persistence:
  - save a 3D project with non-default task/side tabs
  - reload from Library
  - confirm the same 3D workspace tabs reopen
- Verify selection sync:
  - select in viewport
  - confirm Outliner highlights the same item
  - confirm right properties tab updates without manual refresh
- Verify status bar behavior:
  - idle scene
  - pathtrace warmup
  - active render
  - completed render
  - aborted render
- Verify smaller-window usability:
  - no unreachable controls
  - viewport remains usable
  - sidebars collapse cleanly without overlapping render overlays

## Assumptions / Defaults
- The 3D workspace is allowed to look distinctly Blender-inspired and dark even if the rest of the app stays visually different.
- Task tabs are persisted per 3D scene document, matching the Editor’s document-backed tab behavior.
- No drag-resizable splitters in v1; widths are preset and responsive.
- No new icon dependency; use inline SVG or existing lightweight UI primitives.
- Existing shortcuts such as `1/2/3`, `F`, and fly/orbit controls stay unchanged.
