#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_input;
uniform sampler2D u_sourceTex;
uniform vec2 u_canvasRes;
uniform vec4 u_placement;
uniform float u_denoiseStrength;
uniform float u_detailPreservation;
uniform float u_sharpenAmount;
uniform int u_denoiseEnabled;

vec3 sampleSource(vec2 localUv) {
    return texture(u_sourceTex, clamp(localUv, 0.0, 1.0)).rgb;
}

vec3 blurSource(vec2 localUv, int radius) {
    vec2 texSize = vec2(textureSize(u_sourceTex, 0));
    vec2 texel = vec2(1.0) / max(texSize, vec2(1.0));
    vec3 sum = vec3(0.0);
    float count = 0.0;
    for (int offsetY = -2; offsetY <= 2; offsetY += 1) {
        if (abs(offsetY) > radius) continue;
        for (int offsetX = -2; offsetX <= 2; offsetX += 1) {
            if (abs(offsetX) > radius) continue;
            sum += sampleSource(localUv + vec2(float(offsetX), float(offsetY)) * texel);
            count += 1.0;
        }
    }
    return sum / max(1.0, count);
}

void main() {
    vec4 base = texture(u_input, v_uv);
    vec2 canvasPx = v_uv * u_canvasRes;
    if (
        canvasPx.x < u_placement.x
        || canvasPx.x > (u_placement.x + u_placement.z)
        || canvasPx.y < u_placement.y
        || canvasPx.y > (u_placement.y + u_placement.w)
        || u_placement.z <= 0.0
        || u_placement.w <= 0.0
    ) {
        outColor = base;
        return;
    }

    vec2 localUv = (canvasPx - u_placement.xy) / u_placement.zw;
    vec3 color = sampleSource(localUv);

    if (u_denoiseEnabled > 0 && u_denoiseStrength > 0.01) {
        int radius = u_denoiseStrength > 0.45 ? 2 : 1;
        vec3 blurred = blurSource(localUv, radius);
        color = mix(blurred, color, clamp(u_detailPreservation, 0.0, 1.0));
    }

    if (u_sharpenAmount > 0.01) {
        vec3 blurredSmall = blurSource(localUv, 1);
        color = clamp(color + ((color - blurredSmall) * u_sharpenAmount * 0.75), 0.0, 4.0);
    }

    outColor = vec4(color, 1.0);
}
