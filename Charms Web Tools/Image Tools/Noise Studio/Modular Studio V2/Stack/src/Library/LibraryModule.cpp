#include "LibraryModule.h"
#include "LibraryManager.h"
#include "Editor/EditorModule.h"
#include "ProjectData.h"
#include <imgui.h>
#include <imgui_internal.h>

// (Removed namespace Library)

LibraryModule::LibraryModule() {}
LibraryModule::~LibraryModule() {}

void LibraryModule::Initialize() {
    LibraryManager::Get().RefreshLibrary();
}

void LibraryModule::RenderUI(EditorModule* editor, int* activeTab) {
    // Top bar for Library actions
    ImGui::BeginChild("LibraryHeader", ImVec2(0, 50), true);
    if (ImGui::Button("Import JSON")) { /* TODO */ } ImGui::SameLine();
    if (ImGui::Button("Save Library")) { LibraryManager::Get().RefreshLibrary(); } ImGui::SameLine();
    if (ImGui::Button("Export ZIP")) { /* TODO */ } ImGui::SameLine();
    
    ImGui::SetNextItemWidth(200);
    ImGui::InputTextWithHint("##search", "Search projects...", m_SearchFilter, sizeof(m_SearchFilter));
    
    ImGui::EndChild();

    // Side bar for Tags/Filters
    ImGui::BeginChild("LibrarySidebar", ImVec2(200, 0), true);
    ImGui::Text("FILTERS");
    ImGui::Separator();
    if (ImGui::Selectable("All Projects", !m_ShowAssets)) m_ShowAssets = false;
    if (ImGui::Selectable("Assets", m_ShowAssets)) m_ShowAssets = true;
    ImGui::EndChild();

    ImGui::SameLine();

    // Main Grid Area
    ImGui::BeginChild("LibraryGrid", ImVec2(0, 0), false);
    
    float window_visible_x2 = ImGui::GetWindowPos().x + ImGui::GetWindowContentRegionMax().x;
    ImGuiStyle& style = ImGui::GetStyle();
    
    const auto& projects = LibraryManager::Get().GetProjects();
    for (size_t i = 0; i < projects.size(); i++) {
        ImGui::PushID((int)i);
        RenderProjectCard(*projects[i], editor);
        
        float last_button_x2 = ImGui::GetItemRectMax().x;
        float next_button_x2 = last_button_x2 + style.ItemSpacing.x + 220; // card spacing
        if (i + 1 < projects.size() && next_button_x2 < window_visible_x2)
            ImGui::SameLine();
            
        ImGui::PopID();
    }
    
    ImGui::EndChild();

    if (m_PreviewProject) {
        RenderPreviewPopup(editor, activeTab);
    }
}

void LibraryModule::RenderProjectCard(const ProjectEntry& project, EditorModule* editor) {
    ImGui::BeginGroup();
    
    float cardWidth = 220.0f;
    float aspect = (float)project.sourceWidth / project.sourceHeight;
    ImVec2 thumbSize(cardWidth, cardWidth / aspect);
    
    // Limit height to a reasonable square-ish max to keep grid tidy
    if (thumbSize.y > 300.0f) {
        thumbSize.y = 300.0f;
        thumbSize.x = 300.0f * aspect;
    }
    
    // Center image in the horizontal slot
    float x_offset = (cardWidth - thumbSize.x) * 0.5f;
    if (x_offset > 0) ImGui::SetCursorPosX(ImGui::GetCursorPosX() + x_offset);

    // Draw Thumbnail
    if (project.thumbnailTex) {
        ImGui::Image((void*)(intptr_t)project.thumbnailTex, thumbSize);
    } else {
        ImGui::Button("No Preview", thumbSize);
    }
    
    bool cardClicked = ImGui::IsItemClicked();

    // Draw Info
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImGui::GetColorU32(ImGuiCol_FrameBg));
    ImGui::BeginChild("CardInfo", ImVec2(cardWidth, 60), true, ImGuiWindowFlags_NoScrollbar);
    ImGui::Text("%s", project.projectName.c_str());
    ImGui::PushStyleColor(ImGuiCol_Text, ImVec4(0.6f, 0.6f, 0.6f, 1.0f));
    ImGui::Text("%dx%d", project.sourceWidth, project.sourceHeight);
    ImGui::Text("%s", project.timestamp.c_str());
    ImGui::PopStyleColor();
    ImGui::EndChild();
    ImGui::PopStyleColor();
    
    
    if (cardClicked || ImGui::IsItemClicked()) {
        // Find the shared_ptr in the manager's list to set as preview
        const auto& projects = LibraryManager::Get().GetProjects();
        for (const auto& p : projects) {
            if (p->fileName == project.fileName) {
                m_PreviewProject = p;
                LibraryManager::Get().LoadFullPreviewTexture(m_PreviewProject);
                break;
            }
        }
    }
    
    ImGui::EndGroup();
}

void LibraryModule::RenderPreviewPopup(EditorModule* editor, int* activeTab) {
    ImGuiViewport* viewport = ImGui::GetMainViewport();
    ImGui::SetNextWindowPos(viewport->Pos);
    ImGui::SetNextWindowSize(viewport->Size);
    
    ImGuiWindowFlags flags = ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoSavedSettings;
    
    ImGui::PushStyleColor(ImGuiCol_ChildBg, ImVec4(0.05f, 0.05f, 0.05f, 0.95f));
    ImGui::BeginChild("PreviewOverlay", viewport->Size, true, flags);
    
    // Centered Content
    float padding = 40.0f;
    ImVec2 contentSize = ImVec2(viewport->Size.x - padding * 2, viewport->Size.y - padding * 2);
    ImGui::SetCursorPos(ImVec2(padding, padding));
    
    ImGui::BeginGroup();
    
    // Header
    // ImGui::PushFont(ImGui::GetIO().Fonts->Fonts[0]); // Font handling can be brittle, skipping for now
    ImGui::TextColored(ImVec4(1, 1, 1, 1), "Project Preview: %s", m_PreviewProject->projectName.c_str());
    // ImGui::PopFont();
    ImGui::TextColored(ImVec4(0.6f, 0.6f, 0.6f, 1.0f), "Last Modified: %s | Dimensions: %dx%d", 
        m_PreviewProject->timestamp.c_str(), m_PreviewProject->sourceWidth, m_PreviewProject->sourceHeight);
    
    ImGui::Separator();
    ImGui::Spacing();

    // Large Preview
    float imgAreaHeight = contentSize.y - 120.0f; // Leave space for buttons
    ImVec2 imgSize;
    float aspect = (float)m_PreviewProject->sourceWidth / m_PreviewProject->sourceHeight;
    if (aspect > contentSize.x / imgAreaHeight) {
        imgSize = ImVec2(contentSize.x, contentSize.x / aspect);
    } else {
        imgSize = ImVec2(imgAreaHeight * aspect, imgAreaHeight);
    }
    
    ImGui::SetCursorPosX(padding + (contentSize.x - imgSize.x) * 0.5f);
    
    // Use Full Resolution Texture if available
    unsigned int displayTex = (m_PreviewProject->fullPreviewTex != 0) ? m_PreviewProject->fullPreviewTex : m_PreviewProject->thumbnailTex;
    
    if (displayTex) {
        ImGui::Image((void*)(intptr_t)displayTex, imgSize);
    } else {
        ImGui::Button("Loading high resolution preview...", imgSize);
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    // Footer Buttons
    float btnWidth = 200.0f;
    ImGui::SetCursorPosX(padding + (contentSize.x - (btnWidth * 2 + 20)) * 0.5f);
    
    if (ImGui::Button("LOAD PROJECT", ImVec2(btnWidth, 40))) {
        LibraryManager::Get().LoadProject(m_PreviewProject->fileName, editor);
        if (activeTab) *activeTab = 1; // Switch to Editor tab
        m_PreviewProject = nullptr;
    }
    
    ImGui::SameLine();
    
    if (ImGui::Button("BACK TO LIBRARY", ImVec2(btnWidth, 40))) {
        m_PreviewProject = nullptr;
    }

    ImGui::EndGroup();
    
    ImGui::EndChild();
    ImGui::PopStyleColor();
}
