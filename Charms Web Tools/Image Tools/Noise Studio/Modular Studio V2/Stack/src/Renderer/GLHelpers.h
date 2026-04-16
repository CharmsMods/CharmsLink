#pragma once

// Use our own OpenGL loader instead of ImGui's partial one
#include "Renderer/GLLoader.h"

#include <string>

namespace GLHelpers {
    // Load a file's entire contents into a string (for shader source loading)
    std::string ReadFile(const std::string& path);

    // Compile a single shader stage from source string
    unsigned int CompileShader(unsigned int type, const char* source);

    // Link a vertex + fragment shader into a program, returns program ID
    unsigned int CreateShaderProgram(const char* vertexSrc, const char* fragmentSrc);

    // Create a simple RGBA texture from CPU pixel data
    unsigned int CreateTextureFromPixels(const unsigned char* data, int width, int height, int channels);

    // Create an empty RGBA texture for FBO attachment
    unsigned int CreateEmptyTexture(int width, int height);

    // Create a Framebuffer Object with a color texture attachment, returns FBO ID
    unsigned int CreateFBO(unsigned int colorTexture);
}
