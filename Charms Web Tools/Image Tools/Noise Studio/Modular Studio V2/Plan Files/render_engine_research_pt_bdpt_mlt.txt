RENDER ENGINE RESEARCH DOCUMENT
Path Tracing (PT), Bidirectional Path Tracing (BDPT), Metropolis Light Transport (MLT)

--------------------------------------------------
OVERVIEW
--------------------------------------------------
This document explains three major rendering integrators:

1. Path Tracing (PT)
2. Bidirectional Path Tracing (BDPT)
3. Metropolis Light Transport (MLT)

Focus:
- How they work (technical)
- Real-world behavior
- Strengths / weaknesses
- Practical implementation notes
- Integration into a shared renderer

--------------------------------------------------
1. PATH TRACING (PT)
--------------------------------------------------

CORE IDEA:
Trace rays from the camera into the scene.
Each bounce samples a new direction using the material BSDF.

Pipeline:
camera ray -> intersect -> bounce -> bounce -> eventually hit light or environment

Key Components:
- BSDF sampling
- Throughput accumulation
- Russian Roulette termination
- Next Event Estimation (optional but critical)
- Multiple Importance Sampling (MIS)

WHY IT WORKS:
Unbiased estimator of the rendering equation.

REAL-WORLD EXPERIENCE:
Pros:
- Simple to implement
- Stable and predictable
- Works well for diffuse scenes
- Good baseline renderer

Cons:
- Caustics are extremely noisy or missing
- Convergence is slow for complex lighting
- Glass and specular paths are poorly sampled

COMMON FIXES:
- NEE (direct light sampling)
- MIS
- HDRI environment lighting
- Denoising

--------------------------------------------------
2. BIDIRECTIONAL PATH TRACING (BDPT)
--------------------------------------------------

CORE IDEA:
Generate paths from BOTH:
- Camera
- Light sources

Then connect them.

Pipeline:
camera subpath + light subpath -> connect vertices -> evaluate contribution

Technical Concepts:
- Path vertices (store position, normal, throughput, PDF)
- Path connection strategies
- MIS across strategies

WHY IT WORKS:
It explicitly samples paths that normal PT rarely finds.

Example:
light -> glass -> floor -> camera

PT:
unlikely

BDPT:
light path already goes through glass
camera path hits floor
connection forms valid path

REAL-WORLD EXPERIENCE:
Pros:
- Much better caustics than PT
- Handles difficult lighting paths
- More consistent convergence

Cons:
- Much more complex
- Requires correct PDF tracking
- Debugging is difficult
- Still not perfect for extremely sharp caustics

COMMON ISSUES:
- Incorrect MIS weights = brightness errors
- Missing PDFs = bias
- Memory overhead for path storage

--------------------------------------------------
3. METROPOLIS LIGHT TRANSPORT (MLT)
--------------------------------------------------

CORE IDEA:
Instead of random sampling, mutate existing good paths.

Pipeline:
1. Generate initial valid path
2. Mutate path slightly
3. Accept/reject mutation
4. Accumulate contribution

Key Concepts:
- Markov Chain Monte Carlo (MCMC)
- Mutation strategies (small step, large step)
- Acceptance probability

WHY IT WORKS:
Caustics are rare but important.
MLT focuses sampling around them once found.

REAL-WORLD EXPERIENCE:
Pros:
- Extremely good at caustics
- Efficient for very complex lighting
- Can outperform BDPT in hard scenes

Cons:
- Very complex to implement
- Hard to debug
- Produces structured noise
- Needs careful tuning
- Not real-time friendly

COMMON ISSUES:
- Chains get stuck
- Poor exploration if mutation is weak
- Flickering in animations

--------------------------------------------------
COMPARISON
--------------------------------------------------

PT:
- Simple
- General purpose
- Weak caustics

BDPT:
- Balanced improvement
- Good for most scenes
- Moderate complexity

MLT:
- Specialized for hard lighting
- Best caustics
- Very high complexity

--------------------------------------------------
REAL SOFTWARE USAGE
--------------------------------------------------

Blender Cycles:
- Uses Path Tracing + NEE + MIS
- Does NOT expose BDPT or MLT

pbrt:
- Exposes PT, BDPT, MLT as separate integrators

LuxCore:
- Has Path and Bidirectional engines
- Can combine with Metropolis sampling

--------------------------------------------------
IMPLEMENTATION STRATEGY (FOR YOUR RENDERER)
--------------------------------------------------

ARCHITECTURE:

Shared Core:
- BVH
- Materials / BSDF
- Ray tracing
- Environment lighting
- Random generator
- Accumulation buffer

Integrators:
- PT module
- BDPT module
- MLT module

Engine Selection:
renderer.engine = PT | BDPT | MLT

--------------------------------------------------
RECOMMENDED BUILD ORDER
--------------------------------------------------

1. Improve Path Tracer:
   - Add NEE
   - Add MIS
   - Improve specular/refraction

2. Implement BDPT:
   - Add path vertex storage
   - Add light path generation
   - Add connection logic
   - Add MIS weighting

3. (Optional) Implement MLT:
   - Add path mutation system
   - Add Markov chains
   - Add acceptance logic

--------------------------------------------------
FINAL NOTES
--------------------------------------------------

- PT is your foundation
- BDPT is the most practical upgrade
- MLT is advanced and optional

Most real-time systems:
- Use PT
- Fake caustics
- Avoid full BDPT/MLT

--------------------------------------------------
END OF DOCUMENT
