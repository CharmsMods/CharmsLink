First-pass structured review archive plan for the June 2026 repo cleanup.

Intent:
- Move clearly legacy, deprecated, save, and old-version folders out of active areas.
- Preserve original context by mirroring the source path under this archive root.
- Leave active, current, official, and live-linked site roots in place.

Archive policy used:
- Keep anything that appears current, official, or directly used by the repo root hub.
- Move only folders with strong legacy signals on the first pass.
- Leave ambiguous folders such as experimental but possibly still useful work for a later review pass.

Clearly legacy candidates identified for move into this archive:
- OLD SITE BEFORE BRUTALISM
- Charms Web Tools/Image Tools/Noise Studio/Old Noise Studio Versions
- Charms Web Tools/Image Tools/Noise Studio/Saves
- Charms Web Tools/Image Tools/Background Remover/Old Background Remover Versions
- Charms Web Tools/Image Tools/Image Corruption/Old Image Corruption
- Charms Web Tools/Venge Modding/BEFORE BRUTAL UPDATE
- Charms Web Tools/Venge Modding/Modding Repository V2 (Official)/OLD PURPLE SITE
- Charms Web Tools/Extra Stuff Not on display

Ambiguous folders intentionally left in place for now:
- new landing idea
- Studio Results
- Loading Animation
- Image Tools Landing/Dev
- Charms Web Tools/Site Bundler/Bundler dev/V9

Notes:
- The shell-based move step is currently blocked by an intermittent Windows sandbox refresh failure.
- Once shell moves are available, each folder above should be moved here while preserving its original relative parent path.
