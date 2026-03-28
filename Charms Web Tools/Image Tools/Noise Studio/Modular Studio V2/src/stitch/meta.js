export const STITCH_ANALYSIS_GROUPS = [
    {
        id: 'detection',
        title: 'Detection',
        fields: [
            {
                key: 'sceneMode',
                label: 'Scene Mode',
                type: 'select',
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'screenshot', label: 'Screenshot' },
                    { value: 'photo', label: 'Photo' }
                ],
                help: 'Auto inspects the inputs and prefers the screenshot matcher for UI captures, or the photo matcher when the set looks more like real photography. Force Screenshot when the images are rigid screen grabs. Force Photo when you want the engine to spend more effort on non-rigid alignment.'
            },
            {
                key: 'blendMode',
                label: 'Blend Mode',
                type: 'select',
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'alpha', label: 'Alpha' },
                    { value: 'feather', label: 'Feather' },
                    { value: 'seam', label: 'Seam' }
                ],
                help: 'Auto keeps screenshots crisp with direct alpha compositing and uses softer edge treatment for photo-style candidates. Alpha keeps every source fully opaque. Feather softens borders. Seam uses a stronger fade to hide boundary mismatches at the cost of some edge sharpness.'
            }
        ]
    },
    {
        id: 'warp',
        title: 'Warp',
        fields: [
            {
                key: 'warpMode',
                label: 'Warp Mode',
                type: 'select',
                options: [
                    { value: 'auto', label: 'Auto' },
                    { value: 'off', label: 'Off' },
                    { value: 'perspective', label: 'Perspective' },
                    { value: 'mesh', label: 'Mesh' }
                ],
                help: 'Auto keeps the screenshot backend rigid, and lets the photo backend generate true homography candidates with optional mesh refinement. Off disables all warp generation. Perspective uses a homography-derived warp mesh. Mesh starts from the same homography and adds local optical-flow refinement for harder overlaps or mild parallax.'
            },
            {
                key: 'meshDensity',
                label: 'Mesh Density',
                type: 'select',
                options: [
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' }
                ],
                help: 'Controls how many control points a mesh candidate gets. Low is faster and smoother. Medium is the default balance. High can rescue tougher photo seams, but it is heavier and can overfit weak matches.'
            },
            {
                key: 'warpDistribution',
                label: 'Warp Distribution',
                type: 'select',
                options: [
                    { value: 'balanced', label: 'Balanced' },
                    { value: 'anchored', label: 'Anchored' }
                ],
                help: 'Controls how the photo mesh solver shares deformation across the solved images. Balanced spreads the correction across both images so one source does not absorb the entire bend. Anchored keeps more of the correction on the image farther from the anchor frame, which can be useful when you want one image to stay closer to its original shape.'
            }
        ]
    },
    {
        id: 'candidates',
        title: 'Candidates',
        fields: [
            {
                key: 'maxCandidates',
                label: 'Max Candidates',
                type: 'number',
                min: 1,
                max: 12,
                step: 1,
                help: 'The analysis can keep more than one plausible stitch result. Higher values give you a richer ranked gallery, but they also increase analysis time and preview generation work.'
            }
        ]
    },
    {
        id: 'advanced',
        title: 'Advanced',
        fields: [
            {
                key: 'analysisMaxDimension',
                label: 'Analysis Size',
                type: 'number',
                min: 256,
                max: 2048,
                step: 16,
                help: 'Sets the working resolution for the analysis pass when full-resolution mode is off. Photo stitching benefits from more detail here because ORB matching, homography solving, and flow refinement all depend on visible overlap structure.'
            },
            {
                key: 'useFullResolutionAnalysis',
                label: 'Use Full Resolution',
                type: 'checkbox',
                help: 'Skips the analysis downscale and keeps the matcher on the original image sizes. This can improve difficult screenshots or very high-detail photo overlaps, but it is slower and uses more memory.'
            },
            {
                key: 'maxFeatures',
                label: 'Max Features',
                type: 'number',
                min: 200,
                max: 4000,
                step: 25,
                help: 'Controls how many ORB features the photo backend keeps from each image. Higher values help difficult overlaps and perspective changes, but they also add solve time and may admit more repetitive-texture matches.'
            },
            {
                key: 'matchRatio',
                label: 'Match Ratio',
                type: 'number',
                min: 0.4,
                max: 0.99,
                step: 0.01,
                help: 'This is the nearest-neighbor match strictness. Lower values reject more ambiguous matches. Higher values keep more possible correspondences, which can help low-texture images but may also admit false matches.'
            },
            {
                key: 'ransacIterations',
                label: 'RANSAC',
                type: 'number',
                min: 100,
                max: 5000,
                step: 50,
                help: 'How many random hypothesis attempts the homography fitter gets. More iterations can stabilize difficult photo alignment, but they increase solve time.'
            },
            {
                key: 'inlierThreshold',
                label: 'Threshold',
                type: 'number',
                min: 1,
                max: 48,
                step: 0.5,
                help: 'The reprojection error tolerance used when deciding whether a match supports a homography. Smaller values are stricter and sharper. Larger values are looser and can help noisy or warped photo overlaps.'
            }
        ]
    }
];

export const STITCH_SELECTION_FIELDS = [
    {
        key: 'x',
        label: 'Position X',
        help: 'Moves the selected image horizontally in the stitch world. Use this when a candidate is almost correct and only needs a manual nudge.'
    },
    {
        key: 'y',
        label: 'Position Y',
        help: 'Moves the selected image vertically in the stitch world. This is useful for quick alignment cleanup after auto-analysis.'
    },
    {
        key: 'scale',
        label: 'Scale',
        help: 'Applies a rigid scale wrapper to the selected image. This is best for simple correction. If you need the overlap to bend or taper differently across the image, use a warped candidate instead of forcing scale too far.'
    },
    {
        key: 'rotation',
        label: 'Rotation (deg)',
        help: 'Rotates the selected image around its origin. Small adjustments are useful when the candidate is close, but large correction usually means a different ranked candidate will fit better.'
    }
];

export const STITCH_SELECTION_ACTION_HELP = {
    reset: 'Restores the selected image to the active candidate placement, including any stored warp metadata for that image.',
    visibility: 'Temporarily hides or shows the selected image without deleting it from the stitch.',
    lock: 'Locks or unlocks the selected image for stage dragging. Locking is helpful once an image is in a good spot.'
};
