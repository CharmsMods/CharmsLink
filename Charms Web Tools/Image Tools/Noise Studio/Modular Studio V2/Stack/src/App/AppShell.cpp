#include "AppShell.h"
#include "Renderer/GLLoader.h"
#include <GLFW/glfw3.h>
#include "imgui.h"
#include <imgui_internal.h>
#include "imgui_impl_glfw.h"
#include "imgui_impl_opengl3.h"
#include <iostream>

static void glfw_error_callback(int error, const char* description) {
    std::cerr << "GLFW Error " << error << ": " << description << "\n";
}

AppShell::AppShell() : m_Window(nullptr), m_IsRunning(false), m_FirstTimeLayout(true) {}

AppShell::~AppShell() {
    Shutdown();
}

bool AppShell::Initialize(const std::string& title, int width, int height) {
    glfwSetErrorCallback(glfw_error_callback);
    
    if (!glfwInit())
        return false;

    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 0);

    m_Window = glfwCreateWindow(width, height, title.c_str(), nullptr, nullptr);
    if (!m_Window) {
        glfwTerminate();
        return false;
    }

    glfwMakeContextCurrent(m_Window);
    glfwSwapInterval(1); 

    if (!LoadGLFunctions()) {
        std::cerr << "Failed to load OpenGL functions!\n";
        return false;
    }

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO(); (void)io;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.ConfigFlags |= ImGuiConfigFlags_DockingEnable;     
    io.ConfigFlags |= ImGuiConfigFlags_ViewportsEnable;   

    ImGui::StyleColorsDark();

    ImGui_ImplGlfw_InitForOpenGL(m_Window, true);
    ImGui_ImplOpenGL3_Init("#version 130");

    m_Editor.Initialize();
    m_Library.Initialize();

    m_IsRunning = true;
    return true;
}

void AppShell::Run() {
    while (!glfwWindowShouldClose(m_Window) && m_IsRunning) {
        glfwPollEvents();

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        RenderUI();

        ImGui::Render();
        int display_w, display_h;
        glfwGetFramebufferSize(m_Window, &display_w, &display_h);
        glViewport(0, 0, display_w, display_h);
        
        glClearColor(0.1f, 0.11f, 0.12f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);

        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());

        ImGuiIO& io = ImGui::GetIO();
        if (io.ConfigFlags & ImGuiConfigFlags_ViewportsEnable) {
            GLFWwindow* backup_current_context = glfwGetCurrentContext();
            ImGui::UpdatePlatformWindows();
            ImGui::RenderPlatformWindowsDefault();
            glfwMakeContextCurrent(backup_current_context);
        }

        glfwSwapBuffers(m_Window);
    }
}

void AppShell::RenderUI() {
    ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->WorkPos);
    ImGui::SetNextWindowSize(viewport->WorkSize);
    ImGui::SetNextWindowViewport(viewport->ID);

    // Root Fullscreen Window for Tabbed Workspace
    ImGuiWindowFlags window_flags = ImGuiWindowFlags_NoDocking | ImGuiWindowFlags_NoTitleBar 
                                   | ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoResize 
                                   | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoBringToFrontOnFocus 
                                   | ImGuiWindowFlags_NoNavFocus;
    
    ImGui::PushStyleVar(ImGuiStyleVar_WindowRounding, 0.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowBorderSize, 0.0f);
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0.0f, 0.0f));
    
    ImGui::Begin("ModularStudioMain", nullptr, window_flags);
    ImGui::PopStyleVar(3);

    // Program Context Tabs (Editor, Library, Composite, 3D)
    if (ImGui::BeginTabBar("ProgramContextTabs", ImGuiTabBarFlags_None)) {
        
        ImGuiTabItemFlags libFlags = (m_ActiveTab == 0) ? ImGuiTabItemFlags_SetSelected : ImGuiTabItemFlags_None;
        if (ImGui::BeginTabItem("Library", nullptr, libFlags)) {
            m_Library.RenderUI(&m_Editor, &m_ActiveTab);
            ImGui::EndTabItem();
        }

        ImGuiTabItemFlags editorFlags = (m_ActiveTab == 1) ? ImGuiTabItemFlags_SetSelected : ImGuiTabItemFlags_None;
        if (ImGui::BeginTabItem("Editor", nullptr, editorFlags)) {
            m_Editor.RenderUI();
            ImGui::EndTabItem();
        }

        // Reset the active tab so it doesn't force switch every frame
        // But only after we have used it in the current frame
        if (m_ActiveTab != -1) m_ActiveTab = -1;

        if (ImGui::BeginTabItem("Composite")) {
            ImGui::Text("Composition View - Multi-layer Scene Building (Coming Soon)");
            ImGui::EndTabItem();
        }

        if (ImGui::BeginTabItem("3D Studio")) {
            ImGui::Text("3D Studio - PBR Rendering and Model Tools (Coming Soon)");
            ImGui::EndTabItem();
        }

        ImGui::EndTabBar();
    }

    ImGui::End(); // End ModularStudioMain
}

void AppShell::Shutdown() {
    if (!m_Window) return;

    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();

    glfwDestroyWindow(m_Window);
    glfwTerminate();
    m_Window = nullptr;
}
