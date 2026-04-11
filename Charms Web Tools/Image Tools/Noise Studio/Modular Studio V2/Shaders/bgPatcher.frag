#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform sampler2D u_floodMask;
uniform sampler2D u_brushMask;
uniform vec3 u_targetColor;
uniform float u_targetAlpha;
uniform float u_tolerance;
uniform float u_smoothing;
uniform float u_defringe;
uniform float u_edgeShift;
uniform int u_showMask;
uniform int u_keepSelectedRange;
uniform int u_aaEnabled;
uniform float u_antialias;
uniform int u_numProtected;
uniform vec3 u_protectedColors[8];
uniform float u_protectedTolerances[8];
uniform int u_useFloodMask;
uniform int u_useBrushMask;
uniform int u_patchEnabled;
uniform int u_numPatches;
uniform vec4 u_patchRects[32];
uniform vec3 u_patchColors[32];
uniform vec2 u_resolution;

float getSelectionMask(vec2 uv, vec3 sampleRgb) {
    float dist = distance(sampleRgb, u_targetColor);
    float selection = 1.0 - smoothstep(u_tolerance, u_tolerance + u_smoothing + 0.001, dist);

    if (u_useFloodMask == 1) {
        float floodValue = texture(u_floodMask, vec2(uv.x, 1.0 - uv.y)).r;
        if (floodValue < 0.5) {
            selection = 0.0;
        }
    }

    return clamp(selection, 0.0, 1.0);
}

float applyRemovalOverrides(vec2 uv, vec3 sampleRgb, float removalMask) {
    float mask = removalMask;

    if (u_numProtected > 0) {
        for (int index = 0; index < 8; index += 1) {
            if (index >= u_numProtected) break;
            float protectedDistance = distance(sampleRgb, u_protectedColors[index]);
            float protectedTolerance = max(u_protectedTolerances[index], 0.01);
            float protectedMask = smoothstep(protectedTolerance, protectedTolerance + 0.05, protectedDistance);
            mask = min(mask, protectedMask);
        }
    }

    if (u_useBrushMask == 1) {
        vec4 brushVal = texture(u_brushMask, vec2(uv.x, 1.0 - uv.y));
        mask = mix(mask, 1.0, brushVal.r);
        mask = mix(mask, 0.0, brushVal.g);
    }

    return clamp(mask, 0.0, 1.0);
}

float getMask(vec2 uv) {
    vec3 sampleRgb = texture(u_tex, uv).rgb;
    float selectionMask = getSelectionMask(uv, sampleRgb);
    float removalMask = u_keepSelectedRange == 1 ? (1.0 - selectionMask) : selectionMask;
    return applyRemovalOverrides(uv, sampleRgb, removalMask);
}

void main() {
    vec2 safeResolution = max(u_resolution, vec2(1.0));
    vec2 texel = 1.0 / safeResolution;
    vec2 pixelCoord = vec2(v_uv.x * safeResolution.x, (1.0 - v_uv.y) * safeResolution.y);
    vec4 color = texture(u_tex, v_uv);

    if (u_patchEnabled == 1) {
        for (int index = 0; index < 32; index += 1) {
            if (index >= u_numPatches) break;
            vec4 rect = u_patchRects[index];
            if (
                pixelCoord.x >= rect.x &&
                pixelCoord.y >= rect.y &&
                pixelCoord.x < rect.x + rect.z &&
                pixelCoord.y < rect.y + rect.w
            ) {
                outColor = vec4(u_patchColors[index], 1.0);
                return;
            }
        }
    }

    float centerMask = getMask(v_uv);
    float mask = centerMask;

    if (u_edgeShift > 0.0) {
        float maxMask = mask;
        float averageMask = mask;
        float count = 1.0;

        const int MAX_EDGE_RADIUS = 10;
        for (int y = -MAX_EDGE_RADIUS; y <= MAX_EDGE_RADIUS; y += 1) {
            for (int x = -MAX_EDGE_RADIUS; x <= MAX_EDGE_RADIUS; x += 1) {
                if (x == 0 && y == 0) continue;
                float radius = length(vec2(float(x), float(y)));
                if (radius <= u_edgeShift) {
                    float sampleMask = getMask(v_uv + vec2(float(x), float(y)) * texel);
                    maxMask = max(maxMask, sampleMask);
                    averageMask += sampleMask;
                    count += 1.0;
                }
            }
        }

        averageMask /= count;
        float chokedMask = mix(maxMask, averageMask, 0.5);
        mask = mix(centerMask, chokedMask, min(u_edgeShift, 1.0));
    }

    float dist = distance(color.rgb, u_targetColor);
    float newAlpha = mix(color.a, u_targetAlpha, mask);
    float removedAlpha = max(color.a - newAlpha, 0.0);
    float effectiveDefringe = u_keepSelectedRange == 1 ? 0.0 : u_defringe;
    vec3 defringedColor = clamp(
        (color.rgb - u_targetColor * removedAlpha * effectiveDefringe) / max(1.0 - removedAlpha * effectiveDefringe, 0.0001),
        0.0,
        1.0
    );

    float finalAlpha = newAlpha;
    vec3 finalRgb = defringedColor;

    if (u_aaEnabled == 1 && u_antialias > 0.0 && centerMask > 0.001) {
        float closestDistance = u_antialias + 1.0;
        vec3 spreadColor = vec3(0.0);
        float weightSum = 0.0;

        const int MAX_AA_RADIUS = 10;
        for (int y = -MAX_AA_RADIUS; y <= MAX_AA_RADIUS; y += 1) {
            for (int x = -MAX_AA_RADIUS; x <= MAX_AA_RADIUS; x += 1) {
                float radius = length(vec2(float(x), float(y)));
                if (radius > 0.0 && radius <= u_antialias) {
                    vec2 sampleUv = v_uv + vec2(float(x), float(y)) * texel;
                    float sampleMask = getMask(sampleUv);
                    float foreground = 1.0 - sampleMask;

                    if (foreground > 0.01) {
                        if (radius < closestDistance) closestDistance = radius;

                        float distanceWeight = smoothstep(u_antialias, 0.0, radius);
                        float weight = foreground * distanceWeight;

                        vec4 sampleColor = texture(u_tex, sampleUv);
                        float sampleNewAlpha = mix(sampleColor.a, u_targetAlpha, sampleMask);
                        float sampleRemovedAlpha = max(sampleColor.a - sampleNewAlpha, 0.0);
                        vec3 sampleDefringed = clamp(
                            (sampleColor.rgb - u_targetColor * sampleRemovedAlpha * effectiveDefringe) / max(1.0 - sampleRemovedAlpha * effectiveDefringe, 0.0001),
                            0.0,
                            1.0
                        );

                        spreadColor += sampleDefringed * weight;
                        weightSum += weight;
                    }
                }
            }
        }

        if (weightSum > 0.0) {
            spreadColor /= weightSum;
            float generatedAlpha = smoothstep(u_antialias, 0.0, closestDistance);
            float compositedAlpha = generatedAlpha + finalAlpha * (1.0 - generatedAlpha);
            if (compositedAlpha > 0.0001) {
                finalRgb = (spreadColor * generatedAlpha + finalRgb * finalAlpha * (1.0 - generatedAlpha)) / compositedAlpha;
            }
            finalAlpha = compositedAlpha;
        }
    }

    if (u_showMask == 1) {
        float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
        if (mask > 0.001) {
            outColor = dist > 0.4
                ? vec4(0.0, 1.0, 1.0, 1.0)
                : vec4(1.0, 0.0, 1.0, 1.0);
            return;
        }
        outColor = vec4(vec3(luma), 1.0);
        return;
    }

    outColor = vec4(finalRgb, finalAlpha);
}
