#include "LibraryManager.h"
#include "Editor/EditorModule.h"
#include "Renderer/GLHelpers.h"
#include "Utils/Base64.h"
#include <fstream>
#include <iostream>
#include <ctime>

#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "ThirdParty/stb_image_write.h"
#include "ThirdParty/stb_image.h"

// (Removed namespace Library)

LibraryManager::LibraryManager() {
    m_LibraryPath = std::filesystem::current_path() / "Library";
    if (!std::filesystem::exists(m_LibraryPath)) {
        std::filesystem::create_directories(m_LibraryPath);
    }
    RefreshLibrary();
}

LibraryManager::~LibraryManager() {
    for (auto& p : m_Projects) {
        if (p->thumbnailTex) glDeleteTextures(1, &p->thumbnailTex);
        if (p->fullPreviewTex) glDeleteTextures(1, &p->fullPreviewTex);
    }
}

void LibraryManager::RefreshLibrary() {
    std::lock_guard<std::mutex> lock(m_ProjectsMutex);
    m_Projects.clear();

    for (const auto& entry : std::filesystem::directory_iterator(m_LibraryPath)) {
        if (entry.path().extension() == ".stack") {
            try {
                std::ifstream f(entry.path());
                json j = json::parse(f);

                auto project = std::make_shared<ProjectEntry>();
                project->fileName = entry.path().filename().string();
                project->projectName = j.value("name", "Untitled Project");
                project->timestamp = j.value("timestamp", "Unknown");
                project->thumbnailB64 = j.value("thumbnail", "");
                project->sourceWidth = j.value("width", 0);
                project->sourceHeight = j.value("height", 0);
                project->pipelineData = j.value("pipeline", json::array());

                InitializeThumbnail(project);
                m_Projects.push_back(project);
            } catch (...) {
                std::cerr << "Failed to parse project: " << entry.path() << std::endl;
            }
        }
    }
}

static void png_write_func(void* context, void* data, int size) {
    auto vec = (std::vector<unsigned char>*)context;
    unsigned char* bytes = (unsigned char*)data;
    vec->insert(vec->end(), bytes, bytes + size);
}

std::string LibraryManager::GenerateThumbnailB64(EditorModule* editor) {
    int w, h;
    auto fullPixels = editor->GetPipeline().GetOutputPixels(w, h);
    if (fullPixels.empty()) return "";

    // Target thumbnail size
    int thumbW = 400;
    int thumbH = (int)((float)h / w * thumbW);
    if (thumbH > 400) {
        thumbH = 400;
        thumbW = (int)((float)w / h * thumbH);
    }

    std::vector<unsigned char> thumbPixels(thumbW * thumbH * 4);
    
    // Resize (simpler for now: nearest neighbor)
    for (int y = 0; y < thumbH; y++) {
        for (int x = 0; x < thumbW; x++) {
            int srcX = (x * w) / thumbW;
            int srcY = (y * h) / thumbH;
            int srcIdx = (srcY * w + srcX) * 4;
            int dstIdx = (y * thumbW + x) * 4;
            for (int c = 0; c < 4; c++) thumbPixels[dstIdx + c] = fullPixels[srcIdx + c];
        }
    }

    std::vector<unsigned char> pngData;
    stbi_write_png_to_func(png_write_func, &pngData, thumbW, thumbH, 4, thumbPixels.data(), thumbW * 4);
    
    return Utils::Base64Encode(pngData);
}

void LibraryManager::AsyncSaveProject(const std::string& name, EditorModule* editor) {
    if (m_IsSaving) return;
    m_IsSaving = true;
    m_SaveProgress = 0.1f;

    // Capture state on main thread
    json pipeline = editor->SerializePipeline();
    
    // Capture Thumbnail on main thread (GL context required)
    std::string thumbB64 = GenerateThumbnailB64(editor);
    m_SaveProgress = 0.4f;

    // Capture Source Image on main thread
    int sw, sh;
    auto spixels = editor->GetPipeline().GetSourcePixels(sw, sh);
    std::vector<unsigned char> pngData;
    stbi_write_png_to_func(png_write_func, &pngData, sw, sh, 4, spixels.data(), sw * 4);
    std::string sourceB64 = Utils::Base64Encode(pngData);

    std::string timestamp = "";
    std::time_t now = std::time(nullptr);
    char buf[100];
    if (std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", std::localtime(&now))) {
        timestamp = buf;
    }

    // Run file I/O in worker
    std::thread([this, name, thumbB64, sourceB64, pipeline, timestamp, sw, sh]() {
        json j;
        j["name"] = name;
        j["timestamp"] = timestamp;
        j["thumbnail"] = thumbB64;
        j["source"] = sourceB64;
        j["width"] = sw;
        j["height"] = sh;
        j["pipeline"] = pipeline;
        
        std::string safeName = name;
        for (char& c : safeName) if (c == ' ' || c == '/' || c == '\\') c = '_';
        std::string fileName = safeName + "_" + std::to_string(std::time(nullptr)) + ".stack";
        
        std::ofstream f(m_LibraryPath / fileName);
        f << j.dump(4);
        
        {
            std::lock_guard<std::mutex> lock(m_ProjectsMutex);
            m_IsSaving = false;
            m_SaveProgress = 1.0f;
        }
    }).detach();
}

bool LibraryManager::LoadProject(const std::string& fileName, EditorModule* editor) {
    std::filesystem::path path = m_LibraryPath / fileName;
    if (!std::filesystem::exists(path)) return false;

    try {
        std::ifstream f(path);
        json j = json::parse(f);
        
        if (j.contains("source")) {
            auto data = Utils::Base64Decode(j["source"]);
            int w, h, ch;
            stbi_set_flip_vertically_on_load(1);
            unsigned char* pixels = stbi_load_from_memory(data.data(), (int)data.size(), &w, &h, &ch, 4);
            if (pixels) {
                editor->LoadSourceFromPixels(pixels, w, h, ch);
                stbi_image_free(pixels);
            }
        }

        if (j.contains("pipeline")) {
            editor->DeserializePipeline(j["pipeline"]);
        }
        
        return true;
    } catch (...) {
        return false;
    }
}

void LibraryManager::InitializeThumbnail(std::shared_ptr<ProjectEntry> project) {
    if (project->thumbnailB64.empty()) return;

    auto data = Utils::Base64Decode(project->thumbnailB64);
    int w, h, ch;
    stbi_set_flip_vertically_on_load(1);
    unsigned char* pixels = stbi_load_from_memory(data.data(), (int)data.size(), &w, &h, &ch, 4);
    if (pixels) {
        project->thumbnailTex = GLHelpers::CreateTextureFromPixels(pixels, w, h, 4);
        stbi_image_free(pixels);
    }
}

void LibraryManager::LoadFullPreviewTexture(std::shared_ptr<ProjectEntry> project) {
    if (!project || project->fullPreviewTex != 0) return;
    if (project->sourceImageB64.empty()) {
        // Fallback to loading the file again if b64 is empty for some reason
        // But usually it should be in the ProjectEntry
    }

    auto data = Utils::Base64Decode(project->sourceImageB64);
    int w, h, ch;
    stbi_set_flip_vertically_on_load(1);
    unsigned char* pixels = stbi_load_from_memory(data.data(), (int)data.size(), &w, &h, &ch, 4);
    if (pixels) {
        project->fullPreviewTex = GLHelpers::CreateTextureFromPixels(pixels, w, h, 4);
        stbi_image_free(pixels);
    }
}

