#pragma once
#include "ProjectData.h"
#include <vector>
#include <memory>
#include <future>
#include <mutex>
#include <filesystem>

class EditorModule;

class LibraryManager {
public:
    LibraryManager();
    ~LibraryManager();

    static LibraryManager& Get() {
        static LibraryManager instance;
        return instance;
    }

    // Project Management
    void RefreshLibrary();
    void AsyncSaveProject(const std::string& name, EditorModule* editor);
    bool LoadProject(const std::string& fileName, EditorModule* editor);
    void LoadFullPreviewTexture(std::shared_ptr<ProjectEntry> project);
    
    const std::vector<std::shared_ptr<ProjectEntry>>& GetProjects() const { return m_Projects; }
    bool IsSaving() const { return m_IsSaving; }
    float GetSaveProgress() const { return m_SaveProgress; }

private:
    void InitializeThumbnail(std::shared_ptr<ProjectEntry> project);
    std::string GenerateThumbnailB64(EditorModule* editor);
    
    std::vector<std::shared_ptr<ProjectEntry>> m_Projects;
    std::mutex m_ProjectsMutex;
    
    bool m_IsSaving = false;
    float m_SaveProgress = 0.0f;
    
    std::filesystem::path m_LibraryPath;
};
