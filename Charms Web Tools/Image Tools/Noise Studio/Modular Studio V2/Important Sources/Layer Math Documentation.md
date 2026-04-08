# 📐 Modular Studio V2 - Layer Math Documentation

This document provides a mathematical overview of each layer available in Modular Studio V2, derived directly from the fragment shader implementations.

---

## 🛠️ 1. Core Adjustment Layers

### **Adjust / Adjust Masked**
- **What it does**: Standard color correction and balanced sharpening.
- **Core Math**:
    - **Saturation**: $RGB_{out} = \text{mix}(\text{Luma}, RGB_{in}, 1.0 + Sat)$
    - **Contrast**: $RGB_{out} = (RGB_{in} - 0.5) \cdot (1.0 + \frac{Cont}{100}) + 0.5$
    - **Brightness**: $RGB_{out} = RGB_{in} + \frac{Bright}{100}$
    - **Warmth**: Interpolates between Cool $(0.8, 0.9, 1.1)$ and Warm $(1.0, 0.9, 0.8)$.
    - **Sharpening (USM)**: $RGB_{out} = RGB_{in} + (RGB_{in} - RGB_{blurred}) \cdot \frac{Sharp}{15.0}$. Uses a $3\times3$ Laplacian-style blur kernel for the diffuse pass.

### **Color Grade**
- **What it does**: Lift/Gamma/Gain style color grading with smooth luma zone transitions.
- **Core Math**:
    - **Shadows**: $1.0 - \text{smoothstep}(0.0, 0.4, Luma)$
    - **Highlights**: $\text{smoothstep}(0.6, 1.0, Luma)$
    - **Midtones**: $1.0 - \max(\text{ShadowMask}, \text{HighlightMask})$
    - **Grading**: $RGB_{out} = RGB_{in} + \sum (\text{Offset}_{zone} \cdot \text{Mask}_{zone})$.

### **Invert**
- **What it does**: Value inversion for masks.
- **Core Math**: $V_{out} = 1.0 - V_{in}$.

---

## 🎨 2. Artistic & Stylization Layers

### **Analog (CRT / Tape)**
- **What it does**: Simulates vintage CRT curvature, tracking wobble, and chromatic bleed.
- **Core Math**:
    - **Curvature**: $UV_{out} = UV_{centered} \cdot (1.0 + \text{Curve} \cdot r^2 \cdot 2.0) + 0.5$.
    - **Wobble**: $UV_x += \sin(uv_y \cdot 20 + \text{Time} \cdot 5) \cdot 0.005 \cdot \text{Wobble}$.
    - **Bleed**: $R[uv + off], G[uv], B[uv - off]$.

### **Cell (Posterize / Toon)**
- **What it does**: Quantizes color levels and extracts outlines.
- **Core Math**:
    - **Quantization**: $V_{out} = \text{pow}(\frac{\text{floor}(V_{in}^\gamma \cdot \text{Levels})}{\text{Levels} - 1.0}, \frac{1}{\gamma})$.
    - **Edges**: Sobel Gradient Magnitude $G = \sqrt{Gx^2 + Gy^2}$ where $Gx, Gy$ are $3\times3$ convolution results.

### **Halftone**
- **What it does**: Simulates CMYK and RGB screen patterns.
- **Core Math**:
    - **Grid**: $\text{fract}(\text{Rotate}(UV, \text{Angle}) \cdot \frac{\text{Res}}{\text{Size}}) - 0.5$.
    - **Angles**: Uses standard offset angles (e.g., $0.26, 1.30, 0.785$ radians) to prevent moiré patterns.

### **Compression**
- **What it does**: Emulates digital artifacts from various compression schemes.
- **Core Math**:
    - **DCT (JPEG)**: Quantizes AC components while preserving block-center DC: $RGB_{out} = \text{floor}(RGB \cdot \text{Levels} + 0.5) / \text{Levels}$.
    - **Chroma Subsampling**: 4:2:0 emulation by sampling chroma at $1/\text{BlockSize}$ resolution while maintaining full-res Luma.
    - **Wavelet**: Frequency banding using Gaussian difference.

### **Corruption (Glitch)**
- **What it does**: Horizontal color smearing and block-level displacement.
- **Core Math**:
    - **Mosh**: $R[uv], G[uv - off], B[uv + off]$ for channel separation.
    - **Blocks**: Displaces UV based on $\text{floor}(UV \cdot S)$ granularity.

---

## 🌊 3. Filter & Blur Layers

### **Airy Bloom**
- **What it does**: Wave-diffraction bloom using the Airy Disk profile.
- **Core Math**:
    - **Diffraction**: $I(\theta) = \left[ \frac{2J_1(\pi r \alpha)}{\pi r \alpha} \right]^2$ (Bessel $J_1$).

### **Hankel Blur**
- **What it does**: Sophisticated circular blur using the 0th-order Bessel function ($J_0$).
- **Core Math**: Radial convolution weighted by $J_0(r)$.

### **Bilateral / Denoise**
- **What it does**: Edge-aware smoothing (Non-Local Means, Median, or Bilateral).
- **Core Math**:
    - **NLM**: $Weight = \exp(-\frac{\text{PatchDist}}{h^2})$.
    - **Median**: Partial sorting of $3\times3$ or $5\times5$ neighborhood luma.

### **Tilt-Shift Blur**
- **What it does**: Simulated shallow depth of field.
- **Core Math**: $\text{BlurIntensity} = \text{smoothstep}(\text{Radius}, \text{Radius} + \text{Transition}, \text{dist}(UV, \text{Center}))$.

---

## 🌌 4. Procedural & Mathematics

### **Noise**
- **What it does**: Multi-mode procedural texture generation.
- **Core Math**:
    - **Perlin**: Hash-based value noise with quintic interpolation: $6t^5 - 15t^4 + 10t^3$.
    - **Worley**: $D = \text{mix}(\text{Manhattan}(r), \text{Euclidean}(r), \text{ParamC})$.
    - **Blue Noise**: High-pass filtered White noise (Interleaved Gradient Noise basis).
    - **Anisotropic**: 1D stretch + directional rotation via $\text{mat2}$.

### **Edge (Sobel + Bloom)**
- **What it does**: High-fidelity line extraction with golden-angle bloom.
- **Core Math**:
    - **Golden Angle**: Samples neighbors using $2.39996$ radians increment for perfectly uniform circular sampling.

### **Glare Rays**
- **What it does**: Angular streaking from high-luminance points.
- **Core Math**: **Angular Streak**: $\text{Intensity} = \exp(-\text{diff}(\theta, \theta_{ray}) \cdot \text{sharpness})$.

---

## 🔧 5. Utilities & Masking

### **BG Patcher**
- **What it does**: Advanced chromatic masking and defringing.
- **Core Math**: 
    - **Defringe**: $\frac{RGB_{in} - \text{TargetColor} \cdot \alpha_{rem} \cdot \text{Amt}}{1.0 - \alpha_{rem} \cdot \text{Amt}}$.
    - **Anti-Aliasing**: Searches radius for foreground-to-background transition to generate synthetic alpha.

### **Final Output**
- **What it does**: Last-stage dither and gamma correction.
- **Core Math**:
    - **Triangular Dither**: $(hash(uv) + hash(uv + \epsilon) - 1.0) / 255.0$ added to linear RGB to eliminate 8-bit banding.
    - **Gamma**: $L^{1/2.2}$ for standard sRGB display.