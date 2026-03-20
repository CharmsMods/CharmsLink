#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_input;
uniform sampler2D u_processed;
uniform int u_mode;

void main() {
    vec4 inputColor = texture(u_input, v_uv);
    vec4 processedColor = texture(u_processed, v_uv);

    bool protectPixel = false;
    if (u_mode == 1) {
        protectPixel = inputColor.a <= 0.001;
    } else if (u_mode == 2) {
        protectPixel = inputColor.a < 0.999;
    }

    outColor = protectPixel ? inputColor : processedColor;
}
