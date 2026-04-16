#pragma once

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight OpenGL 3.3 Core Function Loader
// Uses glfwGetProcAddress to load GL extension functions beyond OpenGL 1.1.
// ─────────────────────────────────────────────────────────────────────────────

#include <GLFW/glfw3.h>
#include <stddef.h>

// ── GL Types ─────────────────────────────────────────────────────────────────

#ifndef APIENTRY
  #ifdef _WIN32
    #define APIENTRY __stdcall
  #else
    #define APIENTRY
  #endif
#endif

typedef char           GLchar;
typedef ptrdiff_t      GLintptr;
typedef ptrdiff_t      GLsizeiptr;

// ── GL Constants ─────────────────────────────────────────────────────────────

#ifndef GL_FRAGMENT_SHADER
#define GL_FRAGMENT_SHADER                0x8B30
#endif
#ifndef GL_VERTEX_SHADER
#define GL_VERTEX_SHADER                  0x8B31
#endif
#ifndef GL_COMPILE_STATUS
#define GL_COMPILE_STATUS                 0x8B81
#endif
#ifndef GL_LINK_STATUS
#define GL_LINK_STATUS                    0x8B82
#endif
#ifndef GL_ARRAY_BUFFER
#define GL_ARRAY_BUFFER                   0x8892
#endif
#ifndef GL_STATIC_DRAW
#define GL_STATIC_DRAW                    0x88E4
#endif
#ifndef GL_FRAMEBUFFER
#define GL_FRAMEBUFFER                    0x8D40
#endif
#ifndef GL_COLOR_ATTACHMENT0
#define GL_COLOR_ATTACHMENT0              0x8CE0
#endif
#ifndef GL_FRAMEBUFFER_COMPLETE
#define GL_FRAMEBUFFER_COMPLETE           0x8CD5
#endif
#ifndef GL_FRAMEBUFFER_BINDING
#define GL_FRAMEBUFFER_BINDING            0x8CA6
#endif
#ifndef GL_READ_FRAMEBUFFER
#define GL_READ_FRAMEBUFFER               0x8CA8
#endif
#ifndef GL_DRAW_FRAMEBUFFER
#define GL_DRAW_FRAMEBUFFER               0x8CA9
#endif
#ifndef GL_READ_FRAMEBUFFER_BINDING
#define GL_READ_FRAMEBUFFER_BINDING       0x8CAA
#endif
#ifndef GL_DRAW_FRAMEBUFFER_BINDING
#define GL_DRAW_FRAMEBUFFER_BINDING       0x8919
#endif
#ifndef GL_TEXTURE0
#define GL_TEXTURE0                       0x84C0
#endif
#ifndef GL_CLAMP_TO_EDGE
#define GL_CLAMP_TO_EDGE                  0x812F
#endif
#ifndef GL_RED
#define GL_RED                            0x1903
#endif
#ifndef GL_RGB
#define GL_RGB                            0x1907
#endif

// ── GL Function Pointer Types ────────────────────────────────────────────────
// We use GLADloadproc-style void* casts to avoid typedef collisions with gl.h

// Shaders
extern GLuint  (APIENTRY *glCreateShader_)(GLenum type);
extern void    (APIENTRY *glDeleteShader_)(GLuint shader);
extern void    (APIENTRY *glShaderSource_)(GLuint shader, GLsizei count, const GLchar *const* string, const GLint* length);
extern void    (APIENTRY *glCompileShader_)(GLuint shader);
extern void    (APIENTRY *glGetShaderiv_)(GLuint shader, GLenum pname, GLint* params);
extern void    (APIENTRY *glGetShaderInfoLog_)(GLuint shader, GLsizei bufSize, GLsizei* length, GLchar* infoLog);

// Programs
extern GLuint  (APIENTRY *glCreateProgram_)(void);
extern void    (APIENTRY *glDeleteProgram_)(GLuint program);
extern void    (APIENTRY *glAttachShader_)(GLuint program, GLuint shader);
extern void    (APIENTRY *glLinkProgram_)(GLuint program);
extern void    (APIENTRY *glUseProgram_)(GLuint program);
extern void    (APIENTRY *glGetProgramiv_)(GLuint program, GLenum pname, GLint* params);
extern void    (APIENTRY *glGetProgramInfoLog_)(GLuint program, GLsizei bufSize, GLsizei* length, GLchar* infoLog);

// Uniforms
extern GLint   (APIENTRY *glGetUniformLocation_)(GLuint program, const GLchar* name);
extern void    (APIENTRY *glUniform1i_)(GLint location, GLint v0);
extern void    (APIENTRY *glUniform1f_)(GLint location, GLfloat v0);
extern void    (APIENTRY *glUniform2f_)(GLint location, GLfloat v0, GLfloat v1);
extern void    (APIENTRY *glUniform3f_)(GLint location, GLfloat v0, GLfloat v1, GLfloat v2);

// VAOs
extern void    (APIENTRY *glGenVertexArrays_)(GLsizei n, GLuint* arrays);
extern void    (APIENTRY *glDeleteVertexArrays_)(GLsizei n, const GLuint* arrays);
extern void    (APIENTRY *glBindVertexArray_)(GLuint array);

// VBOs
extern void    (APIENTRY *glGenBuffers_)(GLsizei n, GLuint* buffers);
extern void    (APIENTRY *glDeleteBuffers_)(GLsizei n, const GLuint* buffers);
extern void    (APIENTRY *glBindBuffer_)(GLenum target, GLuint buffer);
extern void    (APIENTRY *glBufferData_)(GLenum target, ptrdiff_t size, const void* data, GLenum usage);

// Vertex Attribs
extern void    (APIENTRY *glEnableVertexAttribArray_)(GLuint index);
extern void    (APIENTRY *glVertexAttribPointer_)(GLuint index, GLint size, GLenum type, GLboolean normalized, GLsizei stride, const void* pointer);

// FBOs
extern void    (APIENTRY *glGenFramebuffers_)(GLsizei n, GLuint* framebuffers);
extern void    (APIENTRY *glDeleteFramebuffers_)(GLsizei n, const GLuint* framebuffers);
extern void    (APIENTRY *glBindFramebuffer_)(GLenum target, GLuint framebuffer);
extern void    (APIENTRY *glFramebufferTexture2D_)(GLenum target, GLenum attachment, GLenum textarget, GLuint texture, GLint level);
extern void    (APIENTRY *glBlitFramebuffer_)(GLint srcX0, GLint srcY0, GLint srcX1, GLint srcY1, GLint dstX0, GLint dstY0, GLint dstX1, GLint dstY1, GLbitfield mask, GLenum filter);
extern GLenum  (APIENTRY *glCheckFramebufferStatus_)(GLenum target);

// Textures
extern void    (APIENTRY *glActiveTexture_)(GLenum texture);

// ── Convenience macros so the rest of the code uses normal GL names ──────────

#define glCreateShader          glCreateShader_
#define glDeleteShader          glDeleteShader_
#define glShaderSource          glShaderSource_
#define glCompileShader         glCompileShader_
#define glGetShaderiv           glGetShaderiv_
#define glGetShaderInfoLog      glGetShaderInfoLog_
#define glCreateProgram         glCreateProgram_
#define glDeleteProgram         glDeleteProgram_
#define glAttachShader          glAttachShader_
#define glLinkProgram           glLinkProgram_
#define glUseProgram            glUseProgram_
#define glGetProgramiv          glGetProgramiv_
#define glGetProgramInfoLog     glGetProgramInfoLog_
#define glGetUniformLocation    glGetUniformLocation_
#define glUniform1i             glUniform1i_
#define glUniform1f             glUniform1f_
#define glUniform2f             glUniform2f_
#define glUniform3f             glUniform3f_
#define glGenVertexArrays       glGenVertexArrays_
#define glDeleteVertexArrays    glDeleteVertexArrays_
#define glBindVertexArray       glBindVertexArray_
#define glGenBuffers            glGenBuffers_
#define glDeleteBuffers         glDeleteBuffers_
#define glBindBuffer            glBindBuffer_
#define glBufferData            glBufferData_
#define glEnableVertexAttribArray glEnableVertexAttribArray_
#define glVertexAttribPointer   glVertexAttribPointer_
#define glGenFramebuffers       glGenFramebuffers_
#define glDeleteFramebuffers    glDeleteFramebuffers_
#define glBindFramebuffer       glBindFramebuffer_
#define glFramebufferTexture2D  glFramebufferTexture2D_
#define glBlitFramebuffer       glBlitFramebuffer_
#define glCheckFramebufferStatus glCheckFramebufferStatus_
#define glActiveTexture         glActiveTexture_

// Call this AFTER glfwMakeContextCurrent()
bool LoadGLFunctions();
