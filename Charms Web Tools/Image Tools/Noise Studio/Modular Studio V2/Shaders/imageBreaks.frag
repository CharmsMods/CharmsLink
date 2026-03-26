#version 300 es
precision highp float;

uniform sampler2D u_tex;
uniform float u_cols;
uniform float u_rows;
uniform float u_shiftX;
uniform float u_shiftY;
uniform float u_shiftBlur;
uniform float u_seed;
uniform float u_sqDensity;
uniform float u_sqGrid;
uniform float u_sqDist;
uniform float u_sqBlur;

in vec2 v_uv;
out vec4 outColor;

// Simple random generator based on 2D coordinates
float hash12(vec2 p) {
    vec3 p3  = fract(vec3(p.xyx) * .1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    // Current UV coordinate
    vec2 uv = v_uv;
    
    // Calculate fractional block indices
    // Max protects against division by zero/zero rows issues visually
    float colIndex = floor(uv.x * max(1.0, u_cols));
    float rowIndex = floor(uv.y * max(1.0, u_rows));
    
    // Row shift (Horizontal glitching) - depends entirely on rowIndex so the whole row slides together
    float randX = hash12(vec2(rowIndex, u_seed)) * 2.0 - 1.0; 
    
    // Column shift (Vertical glitching) - depends entirely on colIndex so the whole column slides together
    float randY = hash12(vec2(colIndex, u_seed + 1.23)) * 2.0 - 1.0;

    // Optional: add a block-specific jitter if the user cranks up both X and Y shift dramatically?
    // We will stick to perfect row/col sliding as requested
    
    vec2 offset = vec2(
        randX * u_shiftX,
        randY * u_shiftY
    );
    
    vec2 shiftedUv = uv + offset;

    // Glitch Blocks pass
    if (u_sqDensity > 0.0) {
        vec2 sqIndex = floor(uv * max(1.0, u_sqGrid));
        float sqHash = hash12(sqIndex + u_seed * 13.37);
        
        // If the hash falls within the density threshold, apply random displacement to this square
        if (sqHash < u_sqDensity) {
            float bX = hash12(sqIndex + 42.0) * 2.0 - 1.0; // -1 to 1
            float bY = hash12(sqIndex + 99.0) * 2.0 - 1.0; // -1 to 1
            shiftedUv += vec2(bX, bY) * u_sqDist;
        }
    }

    // Wrap around coordinates to create the classic broken monitor look
    shiftedUv = fract(shiftedUv);

    // Dynamic Edge Blur Pass
    float blurRadius = 0.0;

    // 1. Shift Edge Blur Proximity
    if (u_shiftBlur > 0.0) {
        float shiftEdgeDist = 1.0;
        
        if (u_shiftX > 0.0) {
            // Horizontal shifting creates tears along the rows
            shiftEdgeDist = min(shiftEdgeDist, min(fract(uv.y * max(1.0, u_rows)), 1.0 - fract(uv.y * max(1.0, u_rows))));
        }
        if (u_shiftY > 0.0) {
            // Vertical shifting creates tears along the columns
            shiftEdgeDist = min(shiftEdgeDist, min(fract(uv.x * max(1.0, u_cols)), 1.0 - fract(uv.x * max(1.0, u_cols))));
        }
        
        if (shiftEdgeDist < 1.0) {
            float edgeThickness = 0.1 * u_shiftBlur; 
            if (shiftEdgeDist < edgeThickness) {
                float intensity = 1.0 - (shiftEdgeDist / edgeThickness);
                blurRadius = max(blurRadius, intensity * u_shiftBlur * 0.015);
            }
        }
    }

    // 2. Square Glitch Edge Blur Proximity
    if (u_sqDensity > 0.0 && u_sqBlur > 0.0) {
        vec2 sqIndex = floor(uv * max(1.0, u_sqGrid));
        float sqHash = hash12(sqIndex + u_seed * 13.37);
        
        // Only blur if we are physically inside a manifested glitch block
        if (sqHash < u_sqDensity) {
            float sqEdgeDist = min(
                min(fract(uv.x * max(1.0, u_sqGrid)), 1.0 - fract(uv.x * max(1.0, u_sqGrid))),
                min(fract(uv.y * max(1.0, u_sqGrid)), 1.0 - fract(uv.y * max(1.0, u_sqGrid)))
            );
            float sqThickness = 0.1 * u_sqBlur; 
            if (sqEdgeDist < sqThickness) {
                float intensity = 1.0 - (sqEdgeDist / sqThickness);
                blurRadius = max(blurRadius, intensity * u_sqBlur * 0.015);
            }
        }
    }

    // Apply Blur (9-tap) only if required to save GPU cycles
    if (blurRadius > 0.0) {
        vec4 color = vec4(0.0);
        float weight = 0.0;
        for(float x = -1.0; x <= 1.0; x++) {
            for(float y = -1.0; y <= 1.0; y++) {
                vec2 tapUv = fract(shiftedUv + vec2(x, y) * blurRadius);
                color += texture(u_tex, tapUv);
                weight += 1.0;
            }
        }
        outColor = color / weight;
    } else {
        outColor = texture(u_tex, shiftedUv);
    }
}
