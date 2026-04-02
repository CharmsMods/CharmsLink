# OpenCV.js Worker Photo Stitch Upgrade

## Summary
- Replace the current photo-analysis path with a dedicated browser Worker that loads vendored local OpenCV.js/WASM assets; keep the existing JS screenshot path unchanged.
- Stop treating photo stitching as a rigid-first solve with a post-hoc fake warp. The new photo backend should solve a real global homography first, then optionally refine it into a local mesh using optical flow.
- Keep the current document/render/export model by materializing photo solutions into the existing placement + warp mesh structure, so the UI, save/load, hit-test, preview, and PNG export stay compatible.

## Implementation Changes
- **Worker/bootstrap**
  - Add a new classic worker `src/stitch/opencv-worker.js` plus vendored OpenCV assets under `src/vendor/opencv/`.
  - Load OpenCV in the worker via `Module.locateFile` and an explicit ready handshake; do not use a CDN.
  - In [engine.js](/E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/engine.js), dispatch by backend:
    - `sceneMode: screenshot` -> existing JS worker/path.
    - `sceneMode: photo` -> OpenCV worker.
    - `sceneMode: auto` -> lightweight local classifier picks screenshot vs photo before analysis; do not compare screenshot and photo scores directly anymore.
  - If OpenCV fails to initialize, return a clear analysis error for photo mode; do not silently fall back to the old photo matcher.

- **Photo pair solving**
  - Preprocess grayscale Mats in the worker at `analysisMaxDimension` unless full-resolution mode is enabled.
  - Detect ORB features with `maxFeatures`, compute binary descriptors, run BF KNN matching with Hamming distance, apply Lowe ratio filtering, then mutual consistency filtering.
  - Estimate pairwise homographies with `findHomography(..., RANSAC, reprojectionThreshold)` using `inlierThreshold` as the reprojection threshold.
  - Reject pair edges unless they satisfy all of these:
    - minimum inlier count
    - minimum inlier ratio
    - finite homography
    - minimum overlap area after projecting corners
    - bounded mean reprojection error
  - Pair diagnostics must include keypoints, raw matches, filtered matches, inliers, overlap ratio, and reprojection error.

- **Global candidate generation**
  - Replace photo candidate traversal with 3x3 homography graph composition instead of similarity-transform composition.
  - For each anchor image, compose image-to-anchor homographies across the best available path and build one global candidate.
  - Convert each image’s global homography into the existing placement model by:
    - fitting a similarity wrapper (`x/y/scale/rotation`) to projected grid points
    - storing residual deformation as warp mesh deltas
  - `perspective` candidates use homography only.
  - `mesh` candidates start from the same homography and then add local residual offsets from `calcOpticalFlowPyrLK` over overlap-support points.
  - Remove the current fallback “invented warp” heuristic. If flow support is weak, keep the homography-only candidate; if homography is weak, do not emit a warped photo candidate.

- **Warp materialization/rendering**
  - In [warp.js](/E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/warp.js), increase mesh density enough to approximate true perspective:
    - `perspective`: fixed 8x8 render mesh
    - `mesh`: `low 8x8`, `medium 12x12`, `high 16x16`
  - Build mesh points in analysis space from projected homography/flow coordinates, then convert them into local warp deltas for the current renderer/export path.
  - Keep existing blend modes, but rank photo candidates independently from screenshot candidates.

## Public Interfaces And Defaults
- In [document.js](/E:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/document.js):
  - Add hidden persisted setting `photoBackend: 'opencv-wasm'`.
  - Add ephemeral `analysis.backend: 'screenshot-js' | 'opencv-wasm'`.
  - Keep candidate `modelType` values `screenshot`, `perspective`, `mesh`, `manual`; reinterpret `perspective` as a true homography-derived candidate.
- Update default photo-oriented settings:
  - `analysisMaxDimension`: `960` default, UI range `256-2048`
  - `maxFeatures`: `1500` default, UI range `200-4000`
  - `matchRatio`: `0.75` default
  - `ransacIterations`: `2000` default
  - `inlierThreshold`: `4.5` default, UI step `0.5`
- Migration rule:
  - New documents use the new defaults.
  - Loaded legacy documents preserve explicit custom values.
  - If a loaded document exactly matches the old default tuple (`320 / 120 / 0.8 / 180 / 18`), upgrade it in memory to the new defaults and mark `photoBackend: 'opencv-wasm'`.
- Update Stitch help text so Warp/Advanced settings describe homography + mesh refinement, not the old “projective-like” fallback.

## Test Plan
- Worker boot:
  - local vendored OpenCV assets load correctly from the app root and from `?section=stitch`.
  - repeated analysis runs do not leak Mats, object URLs, or workers.
- Screenshot regression:
  - screenshot sets still choose the JS screenshot path and keep crisp rigid alignment with no added photo warp.
- Photo homography:
  - overlapping photos with rotation/perspective produce a `perspective` candidate with strong inlier support and visibly better alignment than the old rigid result.
- Photo mesh:
  - parallax-heavy overlaps produce a `mesh` candidate whose residual fit improves overlap error beyond the homography-only candidate.
- Failure behavior:
  - low-texture or weak-overlap photo sets return a low-confidence/manual result with a clear warning, not a fabricated warp.
  - OpenCV bootstrap failure surfaces an actionable error instead of hanging or silently switching math.
- Persistence/export:
  - save/load through Library preserves the new candidates.
  - export PNG matches the selected candidate’s rendered mesh.

## Assumptions
- “Full Replace” applies to the **photo backend** only; the screenshot backend remains the current JS implementation.
- The app continues to ship as a static no-bundler site, so OpenCV.js/WASM is committed locally rather than fetched from a CDN.
- Browser target is modern Worker + WASM capable browsers.
- OpenCV.js API assumptions are based on official docs for [Using OpenCV.js](https://docs.opencv.org/4.x/d0/d84/tutorial_js_usage.html), [Lucas-Kanade Optical Flow in OpenCV.js](https://docs.opencv.org/4.x/db/d7f/tutorial_js_lucas_kanade.html), and [Features2D + Homography](https://docs.opencv.org/4.x/d7/dff/tutorial_feature_homography.html).
