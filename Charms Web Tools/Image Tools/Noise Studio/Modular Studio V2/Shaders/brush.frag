#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform vec2 u_res;
uniform vec2 u_start;
uniform vec2 u_end;
uniform float u_radius;
uniform float u_hardness;
uniform vec4 u_color;

float sdCapsule(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a;
    float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
    return length(pa - ba * h) - r;
}

void main() {
    float d = sdCapsule(v_uv * u_res, u_start * u_res, u_end * u_res, u_radius);
    float falloff = u_radius * (1.0 - u_hardness);
    float alpha = 1.0 - smoothstep(-falloff, 0.001, d);
    outColor = vec4(u_color.rgb * alpha, alpha);
}
