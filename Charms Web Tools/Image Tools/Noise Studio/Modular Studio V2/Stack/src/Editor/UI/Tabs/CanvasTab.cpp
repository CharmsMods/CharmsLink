#include "CanvasTab.h"
#include "Editor/EditorModule.h"
#include <imgui.h>

// For the native file dialog, we use Windows API
#ifdef _WIN32
#include <windows.h>
#include <commdlg.h>
#endif

void CanvasTab::Initialize() {}

static std::string OpenFileDialog() {
#ifdef _WIN32
    char filename[MAX_PATH] = "";
    OPENFILENAMEA ofn;
    ZeroMemory(&ofn, sizeof(ofn));
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = NULL;
    ofn.lpstrFilter = "Image Files\0*.png;*.jpg;*.jpeg;*.bmp;*.tga;*.gif\0All Files\0*.*\0";
    ofn.lpstrFile = filename;
    ofn.nMaxFile = MAX_PATH;
    ofn.Flags = OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST | OFN_NOCHANGEDIR;
    ofn.lpstrTitle = "Load Source Image";

    if (GetOpenFileNameA(&ofn)) {
        return std::string(filename);
    }
#endif
    return "";
}

void CanvasTab::Render(EditorModule* editor) {
    auto& pipeline = editor->GetPipeline();

    ImGui::Text("Canvas Settings");
    ImGui::Separator();

    if (pipeline.HasSourceImage()) {
        ImGui::Text("Dimensions: %d x %d", pipeline.GetCanvasWidth(), pipeline.GetCanvasHeight());
        ImGui::Spacing();

        if (ImGui::Button("Replace Image...")) {
            std::string path = OpenFileDialog();
            if (!path.empty()) {
                pipeline.LoadSourceImage(path);
            }
        }
        ImGui::SameLine();
        ImGui::TextDisabled("(PNG, JPG, BMP, TGA)");
    } else {
        ImGui::TextWrapped("No source image loaded. Load an image to begin editing.");
        ImGui::Spacing();

        if (ImGui::Button("Load Image...")) {
            std::string path = OpenFileDialog();
            if (!path.empty()) {
                pipeline.LoadSourceImage(path);
            }
        }
    }

    ImGui::Spacing();
    ImGui::Separator();
    ImGui::Spacing();

    ImGui::Text("Global Rendering Options");
    bool onlyUpToActive = editor->IsRenderOnlyUpToActive();
    if (ImGui::Checkbox("Only Render Up To Active Layer", &onlyUpToActive)) {
        editor->SetRenderOnlyUpToActive(onlyUpToActive);
    }
    ImGui::TextDisabled("When enabled, the pipeline stops at the currently\nselected layer in the Pipeline tab.");
}
