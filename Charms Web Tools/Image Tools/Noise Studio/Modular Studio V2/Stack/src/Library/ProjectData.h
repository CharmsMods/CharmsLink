#pragma once
#include <string>
#include <vector>
#include "ThirdParty/json.hpp"

struct ProjectEntry {
    std::string fileName;
    std::string projectName;
    std::string timestamp;
    std::string thumbnailB64; // Small PNG preview
    
    // Metadata
    int sourceWidth = 0;
    int sourceHeight = 0;
    
    // The actual binary image is only loaded when the project is opened
    std::string sourceImageB64; // Full resolution source
    nlohmann::json pipelineData; // Layers and settings
    
    // GL Textures (runtime only)
    unsigned int thumbnailTex = 0;
    unsigned int fullPreviewTex = 0;
};
