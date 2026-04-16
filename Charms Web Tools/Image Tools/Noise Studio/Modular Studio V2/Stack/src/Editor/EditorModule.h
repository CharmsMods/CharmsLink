#pragma once

#include "UI/EditorSidebar.h"
#include "UI/EditorViewport.h"
#include "Renderer/RenderPipeline.h"
#include "Layers/LayerBase.h"
#include <vector>
#include <memory>
#include <string>

#include "UI/EditorScopes.h"

// Available Layer Types for the Factory
enum class LayerType {
    Adjustments,
    CropTransform,
    Blur,
    Noise,
    Vignette
};

// The main coordinator for the Editor context.
class EditorModule {
public:
    EditorModule();
    ~EditorModule();

    void Initialize();
    
    // Called every frame by the AppShell
    void RenderUI();

    RenderPipeline& GetPipeline() { return m_Pipeline; }
    std::vector<std::shared_ptr<LayerBase>>& GetLayers() { return m_Layers; }

    // Dynamic Layer Management
    void AddLayer(LayerType type);
    void RemoveLayer(int index);
    void MoveLayer(int from, int to);

    // Persistence & Serialization
    nlohmann::json SerializePipeline();
    void DeserializePipeline(const nlohmann::json& j);
    void LoadSourceFromPixels(const unsigned char* data, int w, int h, int ch);

    int GetSelectedLayerIndex() const { return m_SelectedLayerIndex; }
    void SetSelectedLayerIndex(int idx) { m_SelectedLayerIndex = idx; }

    float GetHoverFade() const { return m_HoverFade; }
    void  SetHoverFade(float f) { m_HoverFade = f; }

    bool IsRenderOnlyUpToActive() const { return m_RenderOnlyUpToActive; }
    void SetRenderOnlyUpToActive(bool b) { m_RenderOnlyUpToActive = b; }

private:
    EditorSidebar m_Sidebar;
    EditorViewport m_Viewport;
    EditorScopes m_Scopes;
    RenderPipeline m_Pipeline;

    std::vector<std::shared_ptr<LayerBase>> m_Layers;
    int m_SelectedLayerIndex = -1;
    float m_HoverFade = 0.0f;
    bool m_RenderOnlyUpToActive = false;
};
