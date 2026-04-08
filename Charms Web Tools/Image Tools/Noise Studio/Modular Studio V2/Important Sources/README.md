# Important Sources Guide

This folder holds the highest-value documentation for the current site.

## Read Order

1. `Whole Site Context.txt`
2. The relevant code files
3. The other files in this folder that match the feature you are touching
4. `Plan Files/` only if you need historical planning context

## File Roles

- `Whole Site Context.txt`
  - Main current-state handoff file.
  - If the site changes, this file should be updated.
  - If code and docs disagree, code wins and this file should be corrected.

- `Ideas and Fixes for ENTIRE site.md`
  - Mixed running backlog of bugs, ideas, and done-history.
  - Very valuable context, but not the authoritative source of current implementation details.

- `Composite Tab Fixes, written by me.md`
  - User-authored Composite notes/fixes.
  - Keep the wording close to the original voice when editing it.

- `Layer Math Documentation.md`
  - Reference math/behavior notes for implemented Editor layers.

- `Chat GPT Deep Research, 8 layer idea additions.md`
  - Research/idea source.
  - Verify against the live code before treating any part of it as current capability.

- `Personal Notes for a good website.md`
  - Quality/style principles rather than direct implementation truth.

## Rule

Current-state behavior should be documented in `Whole Site Context.txt`, not left only inside old plans or idea files.
