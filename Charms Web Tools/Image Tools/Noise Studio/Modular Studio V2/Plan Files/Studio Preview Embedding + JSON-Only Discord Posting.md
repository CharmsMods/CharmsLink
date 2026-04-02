# Studio Preview Embedding + JSON-Only Discord Posting

## Summary
- Add a Studio `preview` object to saved Editor payloads, matching the existing 3D preview shape: `imageData`, `width`, `height`, `updatedAt`.
- Make Editor `Save` JSON self-contained by always embedding both the original `source` image and the current rendered `preview` image.
- Keep website load/import backward-compatible: older Studio files without `preview` still load, and new `preview` data is treated as optional metadata.
- Change the bot to accept one JSON upload plus `author`, with an optional `decryption_key`, and support Editor-only JSON posting in this update.

## Implementation Changes
- Website save serialization in [documents.js](E:\WEBSITE\CharmsLink\CharmsLink\Charms Web Tools\Image Tools\Noise Studio\Modular Studio V2\src\io\documents.js) and [main.js](E:\WEBSITE\CharmsLink\CharmsLink\Charms Web Tools\Image Tools\Noise Studio\Modular Studio V2\src\main.js):
  - Introduce one shared Studio payload builder that can embed a freshly captured rendered preview.
  - Make Editor `Save` async so it can export the current PNG once, convert it to data URL, and write it into `payload.preview`.
  - Always embed `payload.source` for Editor `Save`; the existing `Save Image` toggle becomes obsolete and should be removed from the toolbar.
  - Update Editor Library saves so the stored Studio payload also includes `payload.preview`, while keeping the existing Library blob/derived-asset flow intact.
  - Preserve backward compatibility by leaving validation permissive and treating `preview` as optional on import/load.
  - Strip Studio `preview` from project fingerprinting so Library duplicate reuse and overwrite prompts still compare semantic document state, not derived PNG bytes.
  - Add/update Logs entries on the Editor save and Library save paths, and keep the website change generic with no bot references.
- Website UI behavior:
  - Remove the Editor `Save Image` toggle because Editor saves are now always self-contained.
  - Leave `Load Image` behavior unchanged.
- Bot command in [post-project.js](E:\WEBSITE\CharmsLink\CharmBot\commands\post-project.js):
  - Replace `before_image` and `after_image` with a single `project_file` upload plus optional `decryption_key`; keep `author` required.
  - Add a parser helper that accepts:
    - plain Editor project JSON
    - single-project Library JSON exports with `_library*` metadata
    - `noise-studio-library` `library-json/v2` bundles only when they contain exactly one Editor project
    - `noise-studio-library` `library-secure-json/v1` files in both `compressed` and `encrypted` modes
  - Match the site’s secure format exactly: gzip base64 payloads, and PBKDF2-SHA256 + AES-GCM decryption using the stored `iterations`, `salt`, `iv`, and `data`.
  - Reject Stitch, 3D, asset-only, and multi-project bundle uploads with clear ephemeral errors in this version.
  - Extract the before image from `source.imageData`, the after image from `preview.imageData`, keep the JSON attached, and preserve the current author-tagging embed flow.
- Docs:
  - Update the existing site context file and bot context file after the code changes to describe the new Studio `preview` field, self-contained Editor saves, supported bot input formats, and encrypted-file handling.

## Test Plan
- Website manual checks:
  - Save an Editor JSON and confirm it contains both `source.imageData` and `preview.imageData`.
  - Load an older Editor JSON without `preview` and confirm normal restore.
  - Load a new Editor JSON with `preview` and confirm normal restore.
  - Save an Editor project to Library, export it back out, and confirm the exported payload still includes `preview`.
  - Re-save an unchanged Editor project to Library and confirm duplicate reuse/overwrite behavior still works.
- Bot manual checks:
  - Plain Editor save JSON posts successfully.
  - Single-project Library export posts successfully.
  - Secure `compressed` Library export posts successfully without a key.
  - Secure `encrypted` Library export posts successfully with the correct `decryption_key` and fails cleanly with a wrong or missing key.
  - Multi-project bundles, Stitch/3D uploads, and JSONs missing `source` or `preview` fail with clear guidance.

## Assumptions
- Bot scope for this update is Editor-only.
- `author` remains a required command option.
- Larger Editor JSON files are acceptable now that saves always embed both images.
- If Discord command registration still returns `401 Unauthorized`, rollout will also require fixing the local `.env` credentials before rerunning `node register-commands.js`.
