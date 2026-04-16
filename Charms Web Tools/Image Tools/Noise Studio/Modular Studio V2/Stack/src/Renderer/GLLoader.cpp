#include "GLLoader.h"
#include <iostream>

// ── Define the global function pointers (with trailing underscore) ────────────

GLuint  (APIENTRY *glCreateShader_)(GLenum) = nullptr;
void    (APIENTRY *glDeleteShader_)(GLuint) = nullptr;
void    (APIENTRY *glShaderSource_)(GLuint, GLsizei, const GLchar *const*, const GLint*) = nullptr;
void    (APIENTRY *glCompileShader_)(GLuint) = nullptr;
void    (APIENTRY *glGetShaderiv_)(GLuint, GLenum, GLint*) = nullptr;
void    (APIENTRY *glGetShaderInfoLog_)(GLuint, GLsizei, GLsizei*, GLchar*) = nullptr;

GLuint  (APIENTRY *glCreateProgram_)(void) = nullptr;
void    (APIENTRY *glDeleteProgram_)(GLuint) = nullptr;
void    (APIENTRY *glAttachShader_)(GLuint, GLuint) = nullptr;
void    (APIENTRY *glLinkProgram_)(GLuint) = nullptr;
void    (APIENTRY *glUseProgram_)(GLuint) = nullptr;
void    (APIENTRY *glGetProgramiv_)(GLuint, GLenum, GLint*) = nullptr;
void    (APIENTRY *glGetProgramInfoLog_)(GLuint, GLsizei, GLsizei*, GLchar*) = nullptr;

GLint   (APIENTRY *glGetUniformLocation_)(GLuint, const GLchar*) = nullptr;
void    (APIENTRY *glUniform1i_)(GLint, GLint) = nullptr;
void    (APIENTRY *glUniform1f_)(GLint, GLfloat) = nullptr;
void    (APIENTRY *glUniform2f_)(GLint, GLfloat, GLfloat) = nullptr;
void    (APIENTRY *glUniform3f_)(GLint, GLfloat, GLfloat, GLfloat) = nullptr;

void    (APIENTRY *glGenVertexArrays_)(GLsizei, GLuint*) = nullptr;
void    (APIENTRY *glDeleteVertexArrays_)(GLsizei, const GLuint*) = nullptr;
void    (APIENTRY *glBindVertexArray_)(GLuint) = nullptr;

void    (APIENTRY *glGenBuffers_)(GLsizei, GLuint*) = nullptr;
void    (APIENTRY *glDeleteBuffers_)(GLsizei, const GLuint*) = nullptr;
void    (APIENTRY *glBindBuffer_)(GLenum, GLuint) = nullptr;
void    (APIENTRY *glBufferData_)(GLenum, ptrdiff_t, const void*, GLenum) = nullptr;

void    (APIENTRY *glEnableVertexAttribArray_)(GLuint) = nullptr;
void    (APIENTRY *glVertexAttribPointer_)(GLuint, GLint, GLenum, GLboolean, GLsizei, const void*) = nullptr;

void    (APIENTRY *glGenFramebuffers_)(GLsizei, GLuint*) = nullptr;
void    (APIENTRY *glDeleteFramebuffers_)(GLsizei, const GLuint*) = nullptr;
void    (APIENTRY *glBindFramebuffer_)(GLenum, GLuint) = nullptr;
void    (APIENTRY *glFramebufferTexture2D_)(GLenum, GLenum, GLenum, GLuint, GLint) = nullptr;
void    (APIENTRY *glBlitFramebuffer_)(GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLint, GLbitfield, GLenum) = nullptr;
GLenum  (APIENTRY *glCheckFramebufferStatus_)(GLenum) = nullptr;

void    (APIENTRY *glActiveTexture_)(GLenum) = nullptr;

// ── Loader ────────────────────────────────────────────────────────────────────

// We must undef the macros temporarily so glfwGetProcAddress gets the real name strings
bool LoadGLFunctions() {
    bool ok = true;

    #define LOAD(var, name) \
        var = (decltype(var))glfwGetProcAddress(name); \
        if (!var) { std::cerr << "[GLLoader] Failed: " << name << "\n"; ok = false; }

    LOAD(glCreateShader_,          "glCreateShader");
    LOAD(glDeleteShader_,          "glDeleteShader");
    LOAD(glShaderSource_,          "glShaderSource");
    LOAD(glCompileShader_,         "glCompileShader");
    LOAD(glGetShaderiv_,           "glGetShaderiv");
    LOAD(glGetShaderInfoLog_,      "glGetShaderInfoLog");

    LOAD(glCreateProgram_,         "glCreateProgram");
    LOAD(glDeleteProgram_,         "glDeleteProgram");
    LOAD(glAttachShader_,          "glAttachShader");
    LOAD(glLinkProgram_,           "glLinkProgram");
    LOAD(glUseProgram_,            "glUseProgram");
    LOAD(glGetProgramiv_,          "glGetProgramiv");
    LOAD(glGetProgramInfoLog_,     "glGetProgramInfoLog");

    LOAD(glGetUniformLocation_,    "glGetUniformLocation");
    LOAD(glUniform1i_,             "glUniform1i");
    LOAD(glUniform1f_,             "glUniform1f");
    LOAD(glUniform2f_,             "glUniform2f");
    LOAD(glUniform3f_,             "glUniform3f");

    LOAD(glGenVertexArrays_,       "glGenVertexArrays");
    LOAD(glDeleteVertexArrays_,    "glDeleteVertexArrays");
    LOAD(glBindVertexArray_,       "glBindVertexArray");

    LOAD(glGenBuffers_,            "glGenBuffers");
    LOAD(glDeleteBuffers_,         "glDeleteBuffers");
    LOAD(glBindBuffer_,            "glBindBuffer");
    LOAD(glBufferData_,            "glBufferData");

    LOAD(glEnableVertexAttribArray_, "glEnableVertexAttribArray");
    LOAD(glVertexAttribPointer_,   "glVertexAttribPointer");

    LOAD(glGenFramebuffers_,       "glGenFramebuffers");
    LOAD(glDeleteFramebuffers_,    "glDeleteFramebuffers");
    LOAD(glBindFramebuffer_,       "glBindFramebuffer");
    LOAD(glFramebufferTexture2D_,  "glFramebufferTexture2D");
    LOAD(glBlitFramebuffer_,       "glBlitFramebuffer");
    LOAD(glCheckFramebufferStatus_, "glCheckFramebufferStatus");

    LOAD(glActiveTexture_,         "glActiveTexture");

    #undef LOAD

    if (ok) std::cout << "[GLLoader] All OpenGL 3.3 functions loaded successfully.\n";
    return ok;
}
