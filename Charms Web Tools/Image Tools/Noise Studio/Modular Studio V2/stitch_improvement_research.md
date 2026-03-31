# Stitch Accuracy Improvement Research

## Your Current Architecture (Summary)

Your stitch engine has **two analysis backends**:

| Backend | Detection | Matching | Alignment | Refinement |
|:---|:---|:---|:---|:---|
| **Screenshot** ([analysis.js](file:///e:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/analysis.js)) | Custom gradient peak detector + patch descriptors | Brute-force ratio + mutual filter | Translation/similarity RANSAC | None |
| **Photo** ([opencv-worker.js](file:///e:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/opencv-worker.js)) | ORB (OpenCV.js/WASM) | BF KNN + Lowe ratio + mutual | RANSAC homography + graph anchor composition | Lucas-Kanade optical flow → adaptive mesh residuals |

**Blending modes**: alpha, feather (linear gradient mask), seam (content-aware seam carving via dynamic programming).

**Key strengths already in place**: mutual matching, dense support seeding via `goodFeaturesToTrack`, adaptive mesh density, edge-aware flow weighting, regularized mesh edges, warp budget capping, content-aware seam blending.

---

## Improvement Areas (Ranked by Impact → Feasibility)

### 1. 🔴 Multi-Band Blending (Laplacian Pyramid)

**What it is**: The industry-standard blending technique for panoramic stitching. Instead of a single alpha/feather blend, images are decomposed into frequency bands (Laplacian pyramid), each blended at different widths, then reconstructed.

**Why it matters**: Your current feather and seam modes produce visible seams when images have different exposures, white balance, or when the overlap is narrow. Multi-band blending handles all of these naturally because:
- Low frequencies (smooth gradients, exposure) blend over a wide area
- High frequencies (sharp edges, texture) blend over a narrow area, preserving detail

**Proven success**: This is used in every major stitcher (OpenCV Stitcher, Hugin, AutoStitch, Google Photos). It is the single most impactful quality improvement for almost any stitching pipeline.

**Browser feasibility**: ✅ **High** — Can be implemented in pure JS on Canvas `ImageData` buffers. The algorithm is:
1. Build Gaussian pyramids for both images (repeated blur + downsample)
2. Compute Laplacian pyramids (difference between adjacent Gaussian levels)
3. Build Gaussian pyramid for the blend mask
4. Blend each Laplacian level using the corresponding mask level
5. Collapse (upsample + add) back to full resolution

> [!IMPORTANT]
> Laplacian levels contain **signed values** (negative pixel differences). Use `Float32Array` buffers, not `Uint8ClampedArray`, for the pyramid math. Only clamp back to 0-255 at the final reconstruction step.

**Estimated complexity**: Medium. ~200-300 lines of JS. The blur can use a separable Gaussian (two 1D passes) for performance.

---

### 2. 🟡 Gain Compensation (Exposure Matching)

**What it is**: Before blending, calculate a per-image brightness/contrast multiplier so overlapping regions have matching exposure.

**Why it matters**: Photos taken at slightly different times or angles often have different exposures. Even with multi-band blending, large exposure differences create visible bands. Gain compensation removes this at the source.

**Proven technique**: For each pair of overlapping images, compute the mean intensity ratio in the overlap region, then solve a global gain vector that minimizes the differences across all pairs.

**Browser feasibility**: ✅ **High** — Pure JS math on the grayscale data you already compute. The overlap regions are already identified by your homography pipeline.

**Estimated complexity**: Low. ~80-120 lines of JS added to the rendering path.

---

### 3. 🟡 Sub-Pixel Feature Refinement (`cornerSubPix`)

**What it is**: After `goodFeaturesToTrack` finds corners at integer pixel coordinates, `cv.cornerSubPix` iteratively refines each point to sub-pixel accuracy using local gradient information.

**Why it matters**: Your dense support seeding already uses `goodFeaturesToTrack` (in [buildDenseSupportSeeds](file:///e:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/opencv-worker.js#1316-1361)). The initial positions are integer-pixel, which means the optical flow starts from a quantized location. Sub-pixel refinement before running Lucas-Kanade flow gives more accurate initial positions, leading to tighter mesh corrections.

**Proven success**: Standard step in OpenCV calibration and tracking pipelines. Documented improvement in alignment accuracy of 0.1-0.5 pixels per point.

**Browser feasibility**: ✅ **High** — `cv.cornerSubPix` is already available in OpenCV.js. It's a single function call after `goodFeaturesToTrack`.

**Estimated complexity**: Very low. ~10 lines of code in [buildDenseSupportSeeds](file:///e:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/opencv-worker.js#1316-1361).

---

### 4. 🟡 AKAZE Feature Detector (Alternative/Supplement to ORB)

**What it is**: AKAZE uses a non-linear scale space (vs ORB's simpler FAST corners). It produces floating-point descriptors that are more discriminative, especially for blurry, low-texture, or noisy images.

**Why it matters**: ORB can struggle with:
- Low-texture natural scenes (sky, grass, water)
- Blurry or motion-affected photos
- Significant scale differences between input images

AKAZE handles these cases better, producing more reliable matches that lead to better homographies.

**Tradeoff**: AKAZE is **significantly slower** than ORB (often 3-10x). For browser use, this is a real concern.

**Browser feasibility**: ✅ **Available** — `cv.AKAZE_create()` is in the standard OpenCV.js build. No custom builds needed.

**Recommended approach**: Don't replace ORB entirely. Instead:
- Offer AKAZE as a user-selectable option (new `photoBackend` or `featureDetector` setting)
- Or use AKAZE as a **fallback**: when ORB produces too few matches (< threshold), automatically retry with AKAZE
- Or run both and merge the match sets

**Estimated complexity**: Medium. ~100-150 lines. The matching pipeline needs to differentiate binary (ORB/NORM_HAMMING) vs float (AKAZE/NORM_L2) descriptor types.

---

### 5. 🟢 SIFT Feature Detector

**What it is**: The gold standard for feature matching accuracy. Scale-invariant, rotation-invariant, robust to lighting changes.

**Why it matters**: SIFT would produce the highest-quality matches of any available detector, leading to the most accurate homographies.

**Browser feasibility**: ⚠️ **Requires custom OpenCV.js build** — SIFT is not in the default opencv.js distribution. You would need to compile OpenCV from source with SIFT whitelisted in `opencv_js.config.py`. Patent expired March 2020, so legally free. Build process has been reported as finicky by multiple developers.

**Recommendation**: Investigate only if AKAZE proves insufficient. The custom build requirement adds significant maintenance burden.

---

### 6. 🟢 WebGPU-Accelerated Blending

**What it is**: Use WebGPU compute shaders (WGSL) for the heavy pixel-processing operations: Gaussian blur, pyramid construction, warping, and blending.

**Why it matters**: Canvas 2D `getImageData`/`putImageData` is extremely slow for full-resolution blending. WebGPU compute shaders can process millions of pixels in parallel, making multi-band blending and gain compensation near-instant even on 4K+ images.

**Browser feasibility**: ✅ **Available in modern browsers** — Chrome, Edge, Firefox (behind flag). Not yet universal. Would need a Canvas 2D fallback path.

**Recommendation**: This is a future optimization, not a correctness improvement. Implement multi-band blending in JS/Canvas first, then migrate to WebGPU for speed once the algorithm is proven correct.

---

### 7. 🔵 Bundle Adjustment (Global Optimization)

**What it is**: Instead of composing pairwise homographies through a graph (your current anchor traversal approach), bundle adjustment simultaneously optimizes all camera parameters to minimize reprojection error across all image pairs globally.

**Why it matters**: Your current chain composition ([solveAnchorGraph](file:///e:/WEBSITE/CharmsLink/CharmsLink/Charms%20Web%20Tools/Image%20Tools/Noise%20Studio/Modular%20Studio%20V2/src/stitch/opencv-worker.js#887-939)) accumulates error — if image A→B has 1px error and B→C has 1px error, A→C can have ~2px error. Bundle adjustment distributes and minimizes this globally.

**Browser feasibility**: ⚠️ **Difficult** — Bundle adjustment requires sparse matrix solving (Levenberg-Marquardt optimization). OpenCV.js does not expose the bundle adjustment modules. You would need to either:
- Implement a JavaScript sparse optimizer (complex but possible)
- Compile a C++ optimizer to WASM (e.g., Ceres Solver via Emscripten)
- Use an approximate approach: iterative pairwise refinement

**Recommendation**: High effort, moderate reward for 2-3 image stitching. Most impactful for panoramas of 4+ images. Consider a simplified iterative approach first.

---

## Quick-Win Summary

| Improvement | Impact | Effort | Browser-Local | Priority |
|:---|:---|:---|:---|:---|
| Multi-band blending | 🔴 Very High | Medium | ✅ Pure JS | **#1** |
| Gain compensation | 🟡 High | Low | ✅ Pure JS | **#2** |
| `cornerSubPix` refinement | 🟡 Medium | Very Low | ✅ OpenCV.js | **#3** |
| AKAZE detector option | 🟡 Medium | Medium | ✅ OpenCV.js | **#4** |
| SIFT detector | 🟢 High | High (custom build) | ⚠️ Custom build | #5 |
| WebGPU blending | 🟢 High (speed) | High | ✅ Modern browsers | #6 |
| Bundle adjustment | 🔵 Medium | Very High | ⚠️ Custom WASM | #7 |

## Additional Small Wins Inside Your Existing Code

These require minimal code changes but have documented online success:

1. **Increase optical flow window size**: Your current `21×21` is standard. Some stitching pipelines use `31×31` for large-displacement scenes — tradeoff is blur tolerance vs accuracy for small features.

2. **FLANN matcher instead of BF**: For large feature sets (>2000 features), FLANN is significantly faster than brute-force KNN. Available in OpenCV.js as `cv.FlannBasedMatcher`. Mainly a speed improvement.

3. **Normalized Cross-Correlation for overlap scoring**: Your screenshot backend uses raw pixel/edge difference metrics. NCC/ZNCC would be more robust to exposure variations between screenshots (e.g., dark mode vs light mode captures).

4. **Cylindrical/spherical projection**: For wide-angle panoramas (>90° FOV), planar homography stitching produces increasing distortion at edges. Projecting into cylindrical or spherical coordinates before matching distributes distortion evenly. Only relevant for very wide panoramas.
