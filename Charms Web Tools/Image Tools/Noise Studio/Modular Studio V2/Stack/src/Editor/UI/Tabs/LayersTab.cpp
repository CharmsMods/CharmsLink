#include "LayersTab.h"
#include "Editor/EditorModule.h"
#include <imgui.h>

void LayersTab::Initialize() {}

void LayersTab::Render(EditorModule* editor) {
    ImGui::Text("Available Modules");
    ImGui::TextDisabled("Click to add to the end of the pipeline");
    ImGui::Separator();
    ImGui::Spacing();

    // Plain listing of layers as buttons/selectables, grouped by category but always visible
    
    auto LayerButton = [&](const char* label, LayerType type) {
        if (ImGui::Button(label, ImVec2(-FLT_MIN, 0))) {
            editor->AddLayer(type);
        }
    };

    ImGui::TextColored(ImVec4(0.7f, 0.7f, 1.0f, 1.0f), "BASE");
    LayerButton("Crop / Rotate / Flip", LayerType::CropTransform);
    ImGui::Spacing();

    ImGui::TextColored(ImVec4(0.7f, 1.0f, 0.7f, 1.0f), "COLOR");
    LayerButton("Adjustments (Color/Contrast)", LayerType::Adjustments);
    ImGui::Spacing();

    ImGui::TextColored(ImVec4(1.0f, 0.7f, 0.7f, 1.0f), "TEXTURE");
    LayerButton("Blur (Box/Gaussian)", LayerType::Blur);
    LayerButton("Noise / Film Grain",   LayerType::Noise);
    ImGui::Spacing();

    ImGui::TextColored(ImVec4(1.0f, 1.0f, 0.7f, 1.0f), "OPTICS");
    LayerButton("Vignette", LayerType::Vignette);
    ImGui::Spacing();

    ImGui::Separator();
    ImGui::TextDisabled("Future Modules:");
    ImGui::BulletText("3-Way Color Grade");
    ImGui::BulletText("Lens Distortion");
    ImGui::BulletText("Cell Shading");
    ImGui::BulletText("Compression Damage");
}
