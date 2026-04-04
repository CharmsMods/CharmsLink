#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_inputRes;
uniform vec2 u_outputRes;
uniform vec2 u_cropOffset;
uniform vec2 u_cropSize;
uniform float u_rotationDegrees;
uniform int u_flipX;
uniform int u_flipY;

mat2 rotationMatrix(float radiansValue) {
    float c = cos(radiansValue);
    float s = sin(radiansValue);
    return mat2(c, -s, s, c);
}

void main() {
    vec2 safeInputRes = max(u_inputRes, vec2(1.0));
    vec2 safeOutputRes = max(u_outputRes, vec2(1.0));
    vec2 safeCropSize = max(u_cropSize, vec2(1.0));
    vec2 localPixel = (v_uv * safeOutputRes) * (safeCropSize / safeOutputRes);
    vec2 centered = localPixel - (safeCropSize * 0.5);
    if (u_flipX == 1) centered.x *= -1.0;
    if (u_flipY == 1) centered.y *= -1.0;
    centered = rotationMatrix(radians(-u_rotationDegrees)) * centered;
    vec2 samplePixel = u_cropOffset + (safeCropSize * 0.5) + centered;
    vec2 sampleUv = samplePixel / safeInputRes;
    if (any(lessThan(sampleUv, vec2(0.0))) || any(greaterThan(sampleUv, vec2(1.0)))) {
        outColor = vec4(0.0);
        return;
    }

    outColor = texture(u_tex, sampleUv);
}
