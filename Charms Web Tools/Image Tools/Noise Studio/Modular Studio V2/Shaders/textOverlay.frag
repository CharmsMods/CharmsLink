#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_base;
uniform sampler2D u_overlay;
uniform vec2 u_res;
uniform vec2 u_overlayPos;
uniform vec2 u_overlaySize;
uniform float u_opacity;
uniform float u_rotationDegrees;

mat2 rotationMatrix(float radiansValue) {
    float c = cos(radiansValue);
    float s = sin(radiansValue);
    return mat2(c, -s, s, c);
}

void main() {
    vec4 base = texture(u_base, v_uv);
    vec2 safeRes = max(u_res, vec2(1.0));
    vec2 safeSize = max(u_overlaySize, vec2(1.0));
    vec2 pixel = v_uv * safeRes;
    vec2 center = u_overlayPos + (safeSize * 0.5);
    vec2 localPixel = rotationMatrix(radians(u_rotationDegrees)) * (pixel - center);
    vec2 samplePixel = localPixel + (safeSize * 0.5);

    if (
        samplePixel.x < 0.0
        || samplePixel.y < 0.0
        || samplePixel.x > safeSize.x
        || samplePixel.y > safeSize.y
    ) {
        outColor = base;
        return;
    }

    vec2 overlayUv = samplePixel / safeSize;
    vec4 overlay = texture(u_overlay, overlayUv);
    float alpha = clamp(overlay.a * u_opacity, 0.0, 1.0);
    vec3 rgb = (overlay.rgb * alpha) + (base.rgb * (1.0 - alpha));
    float outAlpha = alpha + (base.a * (1.0 - alpha));
    outColor = vec4(rgb, outAlpha);
}
