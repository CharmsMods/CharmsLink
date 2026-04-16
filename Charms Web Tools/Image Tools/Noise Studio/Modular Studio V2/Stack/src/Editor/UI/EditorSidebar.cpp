#include "EditorSidebar.h"
#include "Editor/EditorModule.h"
#include "Library/LibraryManager.h"
#include <imgui.h>

EditorSidebar::EditorSidebar() {}
EditorSidebar::~EditorSidebar() {}

void EditorSidebar::Initialize() {
    m_LayersTab.Initialize();
    m_CanvasTab.Initialize();
    m_SelectedTab.Initialize();
    m_PipelineTab.Initialize();
}

void EditorSidebar::Render(EditorModule* editor) {
    ImGui::Begin("Inspector Panel Sidebar");

    if (ImGui::Button("SAVE TO LIBRARY", ImVec2(-1, 0))) {
        LibraryManager::Get().AsyncSaveProject("New Project", editor);
    }
    ImGui::Separator();

    if (ImGui::BeginTabBar("SidebarTabs")) {
        
        if (ImGui::BeginTabItem("Layers")) {
            m_LayersTab.Render(editor);
            ImGui::EndTabItem();
        }

        if (ImGui::BeginTabItem("Canvas")) {
            m_CanvasTab.Render(editor);
            ImGui::EndTabItem();
        }

        if (ImGui::BeginTabItem("Selected")) {
            m_SelectedTab.Render(editor);
            ImGui::EndTabItem();
        }

        if (ImGui::BeginTabItem("Pipeline")) {
            m_PipelineTab.Render(editor);
            ImGui::EndTabItem();
        }

        ImGui::EndTabBar();
    }

    ImGui::End();
}
