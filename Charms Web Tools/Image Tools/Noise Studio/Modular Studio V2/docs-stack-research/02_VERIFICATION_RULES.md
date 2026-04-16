# Verification Rules

This document dictates how the current-state documentation in this directory is generated and maintained. It guarantees the integrity of the factual knowledge base.

## 1. Code is Authoritative
When answering "How does this feature work?", the application's source code is the only source of absolute truth.
- Previous context files (e.g. `Whole Site Context.txt`) or historical AI plans are **clues**, not facts.
- If a context document states "Feature X works via Method Y", but inspecting the `src/` directory reveals it actually uses "Method Z", the truth is **Method Z**.
- Differences must be documented in `audit-tracking/91_CONTRADICTIONS_AND_VERIFICATION_GAPS.md`.

## 2. No Aspirational Behavior in `current-state`
The `current-state/` files must remain strictly factual.
- Do not describe a system *as it should be*. 
- Do not add features that *would make sense* to add.
- If a system has known bugs or incomplete logic (e.g., "Standalone opcode corrections are not actually executed yet"), document the incomplete logic explicitly instead of hiding it.
- All recommendations for the future must be placed in the `/native-rebuild-notes/` directory.

## 3. Explicit Verification Headers
Every current-state file uses a standard header block:
- **Verified from Source:** Lists explicit file paths (e.g., `src/ui/workspaces/index.js`) that were read to confirm the behavior described in the document.
- **Inferred Behavior:** If an assumption is made because a deep file inspection wasn't performed, it must be listed here. This explicitly calls out what needs later verification.
- **Open Questions & Verification Gaps:** Lists unanswered questions.

## 4. Differentiate State Types
Documentation of models or behavior must explicitly differentiate:
- **Saved (Durable):** Persists in JSON or IndexedDB payload.
- **Runtime-only:** Ephemeral data that evaporates when the user hits F5.
- **Derived/Cached:** Computed runtime data that is cached for performance but could theoretically be rebuilt from Saved data.

## 5. Architectural Treatment of UI
For Modular Studio V2, UI and Layout are deeply intertwined with the engine's functionality (e.g., Composite relies on viewport sizes for export bounded frames; Editor text overlays are interactively bound to canvas ratios). 
Therefore, UI layout structure, panel behaviors, and design routing MUST be treated as critical application architecture, not surface-level details.
