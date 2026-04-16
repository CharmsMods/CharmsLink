#pragma once

#include <string>
#include "../Editor/EditorModule.h"
#include "../Library/LibraryModule.h"

struct GLFWwindow;

class AppShell {
public:
    AppShell();
    ~AppShell();

    bool Initialize(const std::string& title, int width, int height);
    void Run();
    void Shutdown();

private:
    void RenderUI();

    GLFWwindow* m_Window;
    bool m_IsRunning;
    bool m_FirstTimeLayout;
    int m_ActiveTab = 0; // 0 = Library, 1 = Editor
    EditorModule m_Editor;
    LibraryModule m_Library;
};
