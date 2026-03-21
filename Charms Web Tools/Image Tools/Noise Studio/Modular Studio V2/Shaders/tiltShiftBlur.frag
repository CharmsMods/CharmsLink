#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_dir; 
uniform float u_rad;
uniform int u_blurType; // 0=Gaussian, 1=Box, 2=Motion
uniform vec2 u_center;
uniform float u_focusRadius;
uniform float u_transition;
uniform float u_aspect;

void main() {
    vec4 original = texture(u_tex, v_uv);
    
    // WebGL convention maps 0,0 to bottom-left, but the UI pointer is top-left originating.
    vec2 pos = vec2(v_uv.x, 1.0 - v_uv.y);
    vec2 offsetFromCenter = pos - u_center;
    
    // Scale X by aspect ratio so the focus area remains perfectly circular
    offsetFromCenter.x *= u_aspect;
    
    float dist = length(offsetFromCenter);
    float fadeStart = u_focusRadius;
    float fadeEnd = u_focusRadius + max(0.001, u_transition);
    
    // Calculate the depth multiplier representing blur intensity [0.0 - 1.0]
    float blurScale = smoothstep(fadeStart, fadeEnd, dist);
    
    // If the pixel falls completely inside the unblurred focus center, return sharp immediately.
    if (blurScale < 0.01) {
        outColor = original;
        return;
    }
    
    vec4 color = vec4(0.0);
    float total = 0.0;
    
    if (u_blurType == 1) {
        // Box blur (32 taps, scales linearly)
        for(float i = -15.0; i <= 16.0; i++) {
            vec4 s = texture(u_tex, v_uv + u_dir * i * u_rad * blurScale * 0.5);
            color += s;
            total += 1.0;
        }
    } else if (u_blurType == 2) {
        // Motion blur (32 taps, directional scaling)
        for(float i = -15.0; i <= 16.0; i++) {
            float weight = 1.0 - abs(i) / 16.0;
            vec4 s = texture(u_tex, v_uv + u_dir * i * u_rad * blurScale * 1.0);
            color += s * weight;
            total += weight;
        }
    } else {
        // Variably-scaled Gaussian blur (32 taps)
        for(float i = -15.0; i <= 16.0; i++) {
            float weight = exp(-(i*i) / (2.0 * 5.0 * 5.0)); 
            vec4 s = texture(u_tex, v_uv + u_dir * i * u_rad * blurScale * 0.5);
            color += s * weight;
            total += weight;
        }
    }
    
    outColor = color / max(total, 0.001);
}
