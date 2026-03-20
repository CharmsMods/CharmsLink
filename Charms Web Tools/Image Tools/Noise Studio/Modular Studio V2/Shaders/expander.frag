#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform vec2 u_inputRes;
uniform vec2 u_outputRes;
uniform vec4 u_fill;

void main() {
    vec2 pixelCoord = v_uv * u_outputRes;
    vec2 inset = max((u_outputRes - u_inputRes) * 0.5, vec2(0.0));
    vec2 maxCoord = inset + u_inputRes;

    if (
        pixelCoord.x >= inset.x &&
        pixelCoord.y >= inset.y &&
        pixelCoord.x < maxCoord.x &&
        pixelCoord.y < maxCoord.y
    ) {
        vec2 sampleUv = (pixelCoord - inset) / max(u_inputRes, vec2(1.0));
        outColor = texture(u_tex, sampleUv);
        return;
    }

    outColor = u_fill;
}
