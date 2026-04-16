# Design System and UI Behavior

## 1. Purpose
This document explains the current styling systems, layout behaviors, and architectural division of the user interface across Modular Studio V2. It treats visual design, panel structures, and workspace layout as code-driven architecture, not just cosmetic opinions.

## 2. Scope
This file covers the global CSS variable token system, user-driven personalization, responsive behaviors, and the explicit structural differences between the "Neumorphic Shell" and the "Workstation Style" workspaces.

## 3. Verification State
- **Verified from Source:** 
  - `src/settings/personalization.js`
  - `style_context.txt`
  - `Whole Site Context.txt` (Settings & Personalization mapping)
- **Inferred Behavior:** Layout exactness of `Stitch` and `3D` DOM hierarchies is partly inferred from the style rules in `style_context.txt`. Needs explicit DOM-tree checking during the CSS-refactor passes.

## 4. Cross-System Dependencies
- **Settings Store:** Global colors are derived from `state.settings.personalization` and injected into the document root via `applyPersonalizationTheme()`.
- **Workspace Router:** `src/ui/workspaces/index.js` holds the class target `.app-shell`, which catches the `--studio-neu-*` CSS boundary variables for everything except 3D.
- **Engine Logic:** In Composite, canvas hit-test boundaries mathematically rely on the surrounding panel dimensions, tightly coupling UI layout to export geometry.

## 5. State Behavior
- **Saved (Durable):** Personalization defaults (Light / Dark hex codes) exist in global `state.settings` and are loaded from IndexedDB on boot.
- **Runtime-only:** Sidebar tab openness, modal states, and overlay selections evaporate on page reload.
- **Derived/Cached:** The actual CSS drop-shadows and gradient strings are algebraically derived inside `personalization.js` by linearly interpolating the user's base hex colors (e.g. `mixHex(surface, '#ffffff', 0.14)`).

---

## 6. Current Behavior 

Modular Studio V2 currently straddles two distinct structural UI languages. The split is intentional, as the newer toolkits (3D, Stitch) adopted a denser "Technical Workstation" paradigm.

### System A: The Shared Neumorphic Shell
**Applies to:** `Editor`, `Composite`, `Library`, `Logs`, `Settings`.
- **Identity:** "Soft" interfaces built around physical shading, drop-shadows, and inset highlights.
- **The Token System:** `src/settings/personalization.js` translates a user's choice of base hex codes (`page`, `surface`, `accent`, etc.) into a massive sheet of computed variables. For example, it computes `--studio-neu-shadow-card` and `--studio-neu-button-fill-hover` mathematically. 
- **Application Boundary:** These variables are injected onto the `.app-shell` element.
- **Panel Layout:** Generally uses heavy, static side panels for layers/tool properties, meaning tools consume permanent layout acreage even when you aren't sliding their inputs.

### System B: The Workstation Style
**Applies to:** `3D`, `Stitch`.
- **Identity:** Dense, flat, monochrome. Pure backgrounds (`#000000`, `#050505`), pure white text, and a rigid warm-grey accent (`#b8b2a3`). Strictly anti-gloss, anti-neumorphism.
- **Progressive Disclosure:** Advanced settings hide inside foldouts. Secondary workflows (like Stitch Candidate Galleries, or 3D Render Export configurations) open as modal overlays instead of living in permanent stage space.
- **The Left-Dock UI Structure:** Tooling uses a single, tabbed, scrollable dock on the left rather than dual sidebars. The main canvas/viewport maintains maximal visual real estate.
- **HUD Chips instead of Toolbars:** Information overlays (confidence, sample count) float in the corners of the viewport as tiny padded boxes, replacing heavy, full-width status bars.

### Dynamic Design Principles
- The design intends to achieve responsiveness not by blindly stacking everything on small screens, but by scaling down the dock and keeping the stage visible at all times.
- State changes (like clicking a palette) are subtle. The app avoids bubbly transition animations in favor of thin border-color shifts or background-fill highlights (`rgba(184,178,163, 0.14)` active fill).
- Both models share the assumption that active dialog boxes disable inputs to background workspaces. The app uses a modal input-blocking architecture while shared prompts (e.g., save replacement) are resolving.

---

## 7. Open Questions & Verification Gaps
- Are there legacy panels inside `Editor` still bypassing the `--studio-neu-*` tokens and using hardcoded HTML hexes?
- How does `Stitch` completely circumvent the `.app-shell` `.studio-neu` background propagation if it's rendered by the same top-level manager?
