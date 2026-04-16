#include "EditorModule.h"
#include "Layers/AdjustmentsLayer.h"
#include "Layers/CropTransformLayer.h"
#include "Layers/VignetteLayer.h"
#include "Layers/NoiseLayer.h"
#include "Layers/BlurLayer.h"
#include <algorithm>
#include <imgui.h>
#include <imgui_internal.h>

EditorModule::EditorModule() {}

EditorModule::~EditorModule() {}

void EditorModule::Initialize() {
    m_Pipeline.Initialize();
    m_Sidebar.Initialize();
    m_Viewport.Initialize();
    m_Scopes.Initialize();
    
    m_Layers.clear();
    m_SelectedLayerIndex = -1;
}

void EditorModule::AddLayer(LayerType type) {
    std::shared_ptr<LayerBase> newLayer = nullptr;

    switch (type) {
        case LayerType::Adjustments:   newLayer = std::make_shared<AdjustmentsLayer>(); break;
        case LayerType::CropTransform: newLayer = std::make_shared<CropTransformLayer>(); break;
        case LayerType::Blur:          newLayer = std::make_shared<BlurLayer>(); break;
        case LayerType::Noise:         newLayer = std::make_shared<NoiseLayer>(); break;
        case LayerType::Vignette:      newLayer = std::make_shared<VignetteLayer>(); break;
    }

    if (newLayer) {
        newLayer->InitializeGL();
        
        // Auto-naming for duplicates (e.g., Blur (2))
        const char* defaultName = newLayer->GetDefaultName();
        int count = 0;
        for (const auto& existing : m_Layers) {
            if (strcmp(existing->GetDefaultName(), defaultName) == 0) {
                count++;
            }
        }
        
        if (count > 0) {
            char suffix[64];
            snprintf(suffix, sizeof(suffix), "%s (%d)", defaultName, count + 1);
            newLayer->SetInstanceName(suffix);
        }

        m_Layers.push_back(newLayer);
        m_SelectedLayerIndex = (int)m_Layers.size() - 1;
    }
}

void EditorModule::RemoveLayer(int index) {
    if (index >= 0 && index < (int)m_Layers.size()) {
        m_Layers.erase(m_Layers.begin() + index);
        if (m_SelectedLayerIndex >= (int)m_Layers.size()) {
            m_SelectedLayerIndex = (int)m_Layers.size() - 1;
        }
    }
}

void EditorModule::MoveLayer(int from, int to) {
    if (from == to) return;
    if (from < 0 || from >= (int)m_Layers.size()) return;
    if (to < 0 || to >= (int)m_Layers.size()) return;

    if (from < to) {
        std::rotate(m_Layers.begin() + from, m_Layers.begin() + from + 1, m_Layers.begin() + to + 1);
    } else {
        std::rotate(m_Layers.begin() + to, m_Layers.begin() + from, m_Layers.begin() + from + 1);
    }

    // Update selection to follow the moved item
    if (m_SelectedLayerIndex == from) {
        m_SelectedLayerIndex = to;
    } else if (from < m_SelectedLayerIndex && to >= m_SelectedLayerIndex) {
        m_SelectedLayerIndex--;
    } else if (from > m_SelectedLayerIndex && to <= m_SelectedLayerIndex) {
        m_SelectedLayerIndex++;
    }
}

void EditorModule::RenderUI() {
    // 1. Run GPU pipeline
    if (m_Pipeline.HasSourceImage()) {
        if (m_RenderOnlyUpToActive && m_SelectedLayerIndex >= 0) {
            // Create a temporary slice of the layers up to and including the selected one
            std::vector<std::shared_ptr<LayerBase>> slicedLayers;
            for (int i = 0; i <= m_SelectedLayerIndex && i < (int)m_Layers.size(); ++i) {
                slicedLayers.push_back(m_Layers[i]);
            }
            m_Pipeline.Execute(slicedLayers);
        } else {
            m_Pipeline.Execute(m_Layers);
        }
    }

    // 2. Main Editor Workspace (Locked to Tab)
    // We use a child window so it occupies the tab's content space precisely and can't be dragged out.
    ImGuiWindowFlags flags = ImGuiWindowFlags_NoTitleBar | ImGuiWindowFlags_NoMove | ImGuiWindowFlags_NoResize 
                           | ImGuiWindowFlags_NoCollapse | ImGuiWindowFlags_NoBringToFrontOnFocus;
    
    ImGui::PushStyleVar(ImGuiStyleVar_WindowPadding, ImVec2(0, 0));
    ImGui::BeginChild("StackEditorWorkspace", ImVec2(0, 0), false, flags);
    ImGui::PopStyleVar();

    ImGuiID editorDockId = ImGui::GetID("EditorDockSpace");
    ImGui::DockSpace(editorDockId, ImVec2(0.0f, 0.0f), ImGuiDockNodeFlags_None);

    // Initial layout for the Editor's internal dockspace
    static bool first = true;
    if (first) {
        first = false;
        ImGui::DockBuilderRemoveNode(editorDockId);
        ImGui::DockBuilderAddNode(editorDockId, ImGuiDockNodeFlags_DockSpace);
        ImGui::DockBuilderSetNodeSize(editorDockId, ImGui::GetWindowSize());

        ImGuiID left, bottom;
        ImGuiID main = editorDockId;
        left = ImGui::DockBuilderSplitNode(main, ImGuiDir_Left, 0.25f, nullptr, &main);
        
        // Split the remaining 'main' area to put Scopes at the bottom
        bottom = ImGui::DockBuilderSplitNode(main, ImGuiDir_Down, 0.35f, nullptr, &main);

        ImGui::DockBuilderDockWindow("Inspector Panel Sidebar", left);
        ImGui::DockBuilderDockWindow("Canvas Viewport", main);
        ImGui::DockBuilderDockWindow("Scopes Panel", bottom);
        ImGui::DockBuilderFinish(editorDockId);
    }

    // 3. Render Editor Panels (they will dock into the EditorDockSpace)
    m_Sidebar.Render(this);
    m_Viewport.Render(this);
    m_Scopes.Render(this);

    ImGui::EndChild();
}

nlohmann::json EditorModule::SerializePipeline() {
    json j = json::array();
    for (auto& layer : m_Layers) {
        j.push_back(layer->Serialize());
    }
    return j;
}

void EditorModule::DeserializePipeline(const nlohmann::json& j) {
    m_Layers.clear();
    if (!j.is_array()) return;

    for (const auto& layerData : j) {
        std::string type = layerData.value("type", "");
        std::shared_ptr<LayerBase> newLayer = nullptr;

        if (type == "Adjustments")   newLayer = std::make_shared<AdjustmentsLayer>();
        else if (type == "Blur")      newLayer = std::make_shared<BlurLayer>();
        else if (type == "Noise")     newLayer = std::make_shared<NoiseLayer>();
        else if (type == "Vignette")  newLayer = std::make_shared<VignetteLayer>();
        else if (type == "CropTransform") newLayer = std::make_shared<CropTransformLayer>();

        if (newLayer) {
            newLayer->InitializeGL();
            newLayer->Deserialize(layerData);
            m_Layers.push_back(newLayer);
        }
    }
    if (!m_Layers.empty()) m_SelectedLayerIndex = 0;
}

void EditorModule::LoadSourceFromPixels(const unsigned char* data, int w, int h, int ch) {
    m_Pipeline.LoadSourceFromPixels(data, w, h, ch);
}
