#pragma once
#include "App/IAppModule.h"
#include <memory>

class LibraryModule : public IAppModule {
public:
    LibraryModule();
    ~LibraryModule() override;

    void Initialize() override;
    void RenderUI() override {} // Dummy for IAppModule
    void RenderUI(class EditorModule* editor, int* activeTab = nullptr);
    const char* GetName() override { return "Library"; }

private:
    void RenderProjectCard(const struct ProjectEntry& project, class EditorModule* editor);
    void RenderPreviewPopup(class EditorModule* editor, int* activeTab = nullptr);
    
    std::shared_ptr<struct ProjectEntry> m_PreviewProject = nullptr;
    bool m_ShowAssets = false;
    char m_SearchFilter[128] = "";
};
