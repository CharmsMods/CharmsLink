#version 300 es
precision highp float;
precision highp int;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_rawTex;
uniform sampler2D u_linearizationTex;
uniform sampler2D u_gainTex0;
uniform sampler2D u_gainTex1;
uniform sampler2D u_gainTex2;
uniform sampler2D u_gainTex3;
uniform sampler2D u_gainTex4;
uniform sampler2D u_gainTex5;
uniform sampler2D u_gainTex6;
uniform sampler2D u_gainTex7;

uniform vec2 u_outputRes;
uniform vec2 u_rawRes;
uniform int u_samplesPerPixel;
uniform int u_interpretationMode;
uniform int u_demosaicRadius;
uniform int u_patternLength;
uniform ivec2 u_patternDim;
uniform int u_pattern[16];
uniform ivec2 u_activeAreaOrigin;
uniform ivec2 u_blackRepeatDim;
uniform float u_blackLevel[16];
uniform bool u_applyLinearization;
uniform int u_linearizationSize;
uniform float u_whiteLevel;
uniform vec3 u_wbGains;
uniform bool u_applyCameraMatrix;
uniform mat3 u_colorTransform;
uniform float u_exposureScale;
uniform float u_highlightStrength;
uniform float u_toneAmount;
uniform bool u_partialFidelity;
uniform int u_gainMapCount;
uniform vec4 u_gainRegion[8];
uniform vec4 u_gainGrid[8];
uniform vec4 u_gainSpacing[8];
uniform vec4 u_gainMapInfo[8];
uniform bool u_applyOpcodeCorrections;
uniform bool u_applyGainMap;
uniform int u_orientation;
uniform vec2 u_cropOrigin;
uniform vec2 u_cropSize;

float clamp01(float value) {
    return clamp(value, 0.0, 1.0);
}

vec3 suppressMagentaHighlights(vec3 rgb, float strength) {
    float peak = max(max(rgb.r, rgb.g), rgb.b);
    float magentaBias = max(((rgb.r + rgb.b) * 0.5) - rgb.g, 0.0);
    if (peak <= 0.68 || magentaBias <= 0.025) {
        return rgb;
    }

    float luminance = dot(rgb, vec3(0.299, 0.587, 0.114));
    float normalizedBias = magentaBias / max(peak, 1e-6);
    float suppression = clamp((peak - 0.68) / 0.9, 0.0, 1.0)
        * clamp(normalizedBias * 2.35, 0.0, 1.0)
        * clamp(strength, 0.0, 1.0);
    float neutralTarget = mix(luminance, max(rgb.g, luminance), 0.28);
    return mix(rgb, vec3(neutralTarget), suppression);
}

vec2 inverseOrientCoord(vec2 orientedPx) {
    float width = max(1.0, u_cropSize.x);
    float height = max(1.0, u_cropSize.y);
    if (u_orientation == 3) {
        return vec2(width - 1.0 - orientedPx.x, height - 1.0 - orientedPx.y);
    }
    if (u_orientation == 6) {
        return vec2(orientedPx.y, height - 1.0 - orientedPx.x);
    }
    if (u_orientation == 8) {
        return vec2(width - 1.0 - orientedPx.y, orientedPx.x);
    }
    if (u_orientation == 2) {
        return vec2(width - 1.0 - orientedPx.x, orientedPx.y);
    }
    if (u_orientation == 4) {
        return vec2(orientedPx.x, height - 1.0 - orientedPx.y);
    }
    if (u_orientation == 5) {
        return vec2(orientedPx.y, orientedPx.x);
    }
    if (u_orientation == 7) {
        return vec2(width - 1.0 - orientedPx.y, height - 1.0 - orientedPx.x);
    }
    return orientedPx;
}

int patternValueAt(ivec2 sensorPx) {
    int patternWidth = max(1, u_patternDim.x);
    int patternHeight = max(1, u_patternDim.y);
    int activeX = sensorPx.x - u_activeAreaOrigin.x;
    int activeY = sensorPx.y - u_activeAreaOrigin.y;
    int wrappedX = int(mod(float(activeX), float(patternWidth)));
    int wrappedY = int(mod(float(activeY), float(patternHeight)));
    int index = clamp((wrappedY * patternWidth) + wrappedX, 0, max(0, u_patternLength - 1));
    return u_pattern[index];
}

float blackLevelAt(ivec2 sensorPx) {
    int repeatWidth = max(1, u_blackRepeatDim.x);
    int repeatHeight = max(1, u_blackRepeatDim.y);
    int wrappedX = int(mod(float(sensorPx.x), float(repeatWidth)));
    int wrappedY = int(mod(float(sensorPx.y), float(repeatHeight)));
    int index = clamp((wrappedY * repeatWidth) + wrappedX, 0, 15);
    return u_blackLevel[index];
}

float sampleLinearization(float sampleValue) {
    if (!u_applyLinearization || u_linearizationSize <= 0) return sampleValue;
    float clampedIndex = clamp(floor(sampleValue + 0.5), 0.0, float(u_linearizationSize - 1));
    float uvX = (clampedIndex + 0.5) / float(u_linearizationSize);
    return texture(u_linearizationTex, vec2(uvX, 0.5)).r;
}

float sampleGainTexture(int index, vec2 uv) {
    if (index == 0) return texture(u_gainTex0, uv).r;
    if (index == 1) return texture(u_gainTex1, uv).r;
    if (index == 2) return texture(u_gainTex2, uv).r;
    if (index == 3) return texture(u_gainTex3, uv).r;
    if (index == 4) return texture(u_gainTex4, uv).r;
    if (index == 5) return texture(u_gainTex5, uv).r;
    if (index == 6) return texture(u_gainTex6, uv).r;
    if (index == 7) return texture(u_gainTex7, uv).r;
    return 1.0;
}

float gainFactorAt(vec2 sensorPx, int plane) {
    if (!u_applyGainMap || u_gainMapCount <= 0) return 1.0;
    float resultGain = 1.0;
    for (int index = 0; index < 8; index += 1) {
        if (index >= u_gainMapCount) break;
        vec4 region = u_gainRegion[index];
        if (sensorPx.x < region.y || sensorPx.x >= region.w || sensorPx.y < region.x || sensorPx.y >= region.z) {
            continue;
        }
        vec4 mapInfo = u_gainMapInfo[index];
        int startPlane = int(mapInfo.x + 0.5);
        int planesCount = int(mapInfo.y + 0.5);
        int mapPlanes = int(mapInfo.z + 0.5);
        if (startPlane >= 0 && (plane < startPlane || plane >= startPlane + planesCount)) {
            continue;
        }
        int mapPlaneIdx = mapPlanes > 1 ? clamp(plane - max(0, startPlane), 0, mapPlanes - 1) : 0;
        
        vec4 grid = u_gainGrid[index];
        float mapHeight = max(1.0, grid.x);
        float mapWidth = max(1.0, grid.y);
        vec4 spacing = u_gainSpacing[index];
        float derivedSpacingX = (region.w - region.y) > 1.0 && mapWidth > 1.0
            ? (region.w - region.y - 1.0) / max(1.0, mapWidth - 1.0)
            : 1.0;
        float derivedSpacingY = (region.z - region.x) > 1.0 && mapHeight > 1.0
            ? (region.z - region.x - 1.0) / max(1.0, mapHeight - 1.0)
            : 1.0;
        float spacingX = max(1.0, abs(spacing.x) > 1e-4 ? spacing.x : derivedSpacingX);
        float spacingY = max(1.0, abs(spacing.y) > 1e-4 ? spacing.y : derivedSpacingY);
        float originX = region.y + spacing.z;
        float originY = region.x + spacing.w;
        float gridX = clamp((sensorPx.x - originX) / spacingX, 0.0, max(0.0, mapWidth - 1.0));
        float gridY = clamp((sensorPx.y - originY) / spacingY, 0.0, max(0.0, mapHeight - 1.0));
        
        float baseV = (gridY + 0.5) / mapHeight;
        float adjustedV = (baseV + float(mapPlaneIdx)) / float(mapPlanes);
        vec2 uv = vec2((gridX + 0.5) / mapWidth, adjustedV);
        resultGain *= max(1e-6, sampleGainTexture(index, uv));
    }
    return resultGain;
}

float normalizeRawSample(float rawValue, ivec2 sensorPx, int plane) {
    float linearized = sampleLinearization(rawValue);
    float black = blackLevelAt(sensorPx);
    float scale = max(1e-6, u_whiteLevel - black);
    float normalized = (linearized - black) / scale;
    float gain = gainFactorAt(vec2(sensorPx), plane);
    return normalized * gain;
}

vec4 sampleRawTexel(ivec2 sensorPx) {
    vec2 clampedPx = clamp(vec2(sensorPx), vec2(0.0), max(u_rawRes - 1.0, vec2(0.0)));
    vec2 texturePx = vec2(clampedPx.x, max(u_rawRes.y - 1.0, 0.0) - clampedPx.y);
    vec2 uv = (texturePx + 0.5) / max(u_rawRes, vec2(1.0));
    return texture(u_rawTex, uv);
}

float sampleMosaicScalar(ivec2 sensorPx, int plane) {
    vec4 raw = sampleRawTexel(sensorPx);
    return normalizeRawSample(raw.r, sensorPx, plane);
}

float averageNearbySameColor(ivec2 sensorPx, int plane);

float averagePlaneSample(ivec2 sensorPx, int plane, ivec2 offset) {
    ivec2 samplePx = sensorPx + offset;
    samplePx = ivec2(clamp(vec2(samplePx), vec2(0.0), max(u_rawRes - 1.0, vec2(0.0))));
    if (patternValueAt(samplePx) != plane) {
        return -1.0;
    }
    return sampleMosaicScalar(samplePx, plane);
}

float averagePlane2(ivec2 sensorPx, int plane, ivec2 offsetA, ivec2 offsetB) {
    float sum = 0.0;
    float count = 0.0;
    float first = averagePlaneSample(sensorPx, plane, offsetA);
    if (first >= 0.0) {
        sum += first;
        count += 1.0;
    }
    float second = averagePlaneSample(sensorPx, plane, offsetB);
    if (second >= 0.0) {
        sum += second;
        count += 1.0;
    }
    if (count <= 0.0) {
        return averageNearbySameColor(sensorPx, plane);
    }
    return sum / count;
}

float averagePlane4(ivec2 sensorPx, int plane, ivec2 offsetA, ivec2 offsetB, ivec2 offsetC, ivec2 offsetD) {
    float sum = 0.0;
    float count = 0.0;
    float samples[4] = float[4](
        averagePlaneSample(sensorPx, plane, offsetA),
        averagePlaneSample(sensorPx, plane, offsetB),
        averagePlaneSample(sensorPx, plane, offsetC),
        averagePlaneSample(sensorPx, plane, offsetD)
    );
    for (int index = 0; index < 4; index += 1) {
        if (samples[index] < 0.0) continue;
        sum += samples[index];
        count += 1.0;
    }
    if (count <= 0.0) {
        return averageNearbySameColor(sensorPx, plane);
    }
    return sum / count;
}

vec3 sampleBayerRgb(ivec2 sensorPx) {
    int nativePlane = patternValueAt(sensorPx);
    vec3 rgb = vec3(0.0);

    if (nativePlane == 0) {
        rgb.r = sampleMosaicScalar(sensorPx, 0);
        rgb.g = averagePlane4(sensorPx, 1, ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1));
        rgb.b = averagePlane4(sensorPx, 2, ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1), ivec2(1, 1));
        return rgb;
    }

    if (nativePlane == 2) {
        rgb.r = averagePlane4(sensorPx, 0, ivec2(-1, -1), ivec2(1, -1), ivec2(-1, 1), ivec2(1, 1));
        rgb.g = averagePlane4(sensorPx, 1, ivec2(-1, 0), ivec2(1, 0), ivec2(0, -1), ivec2(0, 1));
        rgb.b = sampleMosaicScalar(sensorPx, 2);
        return rgb;
    }

    rgb.g = sampleMosaicScalar(sensorPx, 1);
    ivec2 leftPx = ivec2(clamp(vec2(sensorPx + ivec2(-1, 0)), vec2(0.0), max(u_rawRes - 1.0, vec2(0.0))));
    ivec2 rightPx = ivec2(clamp(vec2(sensorPx + ivec2(1, 0)), vec2(0.0), max(u_rawRes - 1.0, vec2(0.0))));
    bool horizontalRed = patternValueAt(leftPx) == 0 || patternValueAt(rightPx) == 0;
    if (horizontalRed) {
        rgb.r = averagePlane2(sensorPx, 0, ivec2(-1, 0), ivec2(1, 0));
        rgb.b = averagePlane2(sensorPx, 2, ivec2(0, -1), ivec2(0, 1));
    } else {
        rgb.r = averagePlane2(sensorPx, 0, ivec2(0, -1), ivec2(0, 1));
        rgb.b = averagePlane2(sensorPx, 2, ivec2(-1, 0), ivec2(1, 0));
    }
    return rgb;
}

float averageNearbySameColor(ivec2 sensorPx, int plane) {
    float sum = 0.0;
    float count = 0.0;
    for (int offsetY = -2; offsetY <= 2; offsetY += 1) {
        if (abs(offsetY) > u_demosaicRadius) continue;
        for (int offsetX = -2; offsetX <= 2; offsetX += 1) {
            if (abs(offsetX) > u_demosaicRadius) continue;
            ivec2 samplePx = sensorPx + ivec2(offsetX, offsetY);
            samplePx = ivec2(clamp(vec2(samplePx), vec2(0.0), max(u_rawRes - 1.0, vec2(0.0))));
            if (patternValueAt(samplePx) != plane) continue;
            sum += sampleMosaicScalar(samplePx, plane);
            count += 1.0;
        }
    }
    if (count <= 0.0) {
        return sampleMosaicScalar(sensorPx, plane);
    }
    return sum / count;
}

vec3 sampleLinearRgb(ivec2 sensorPx) {
    vec4 raw = sampleRawTexel(sensorPx);
    if (u_samplesPerPixel <= 1) {
        float value = normalizeRawSample(raw.r, sensorPx, 0);
        return vec3(value);
    }
    return vec3(
        normalizeRawSample(raw.r, sensorPx, 0),
        normalizeRawSample(raw.g, sensorPx, 1),
        normalizeRawSample(raw.b, sensorPx, 2)
    );
}

vec3 sampleDevelopedRgb(vec2 orientedPx) {
    vec2 cropPx = inverseOrientCoord(orientedPx);
    ivec2 sensorPx = ivec2(floor(cropPx + u_cropOrigin + 0.5));
    sensorPx = ivec2(clamp(vec2(sensorPx), vec2(0.0), max(u_rawRes - 1.0, vec2(0.0))));

    vec3 rgb;
    if (u_interpretationMode == 0) {
        rgb = sampleLinearRgb(sensorPx);
    } else {
        if (u_patternDim.x == 2 && u_patternDim.y == 2) {
            rgb = sampleBayerRgb(sensorPx);
        } else {
            int nativePlane = patternValueAt(sensorPx);
            rgb = vec3(0.0);
            for (int channel = 0; channel < 3; channel += 1) {
                rgb[channel] = nativePlane == channel
                    ? sampleMosaicScalar(sensorPx, channel)
                    : averageNearbySameColor(sensorPx, channel);
            }
        }
    }

    if (u_applyCameraMatrix) {
        rgb = u_colorTransform * rgb;
    } else {
        rgb *= u_wbGains;
    }
    rgb *= u_exposureScale;
    
    // Clamp out negatives only after linear matrices/white-balance have resolved
    rgb = max(rgb, vec3(0.0));

    if (u_highlightStrength > 0.0) {
        rgb = mix(rgb, rgb / (vec3(1.0) + rgb), vec3(clamp(u_highlightStrength, 0.0, 1.0)));
        float peak = max(max(rgb.r, rgb.g), rgb.b);
        if (peak > 0.82) {
            float luminance = (rgb.r + rgb.g + rgb.b) / 3.0;
            float shoulder = clamp((peak - 0.82) / 0.8, 0.0, 1.0) * clamp(u_highlightStrength, 0.0, 1.0);
            float chromaCompression = shoulder * 0.55;
            rgb = vec3(luminance) + ((rgb - vec3(luminance)) * (1.0 - chromaCompression));
        }
    }

    if (u_partialFidelity) {
        float peak = max(max(rgb.r, rgb.g), rgb.b);
        float valley = min(min(rgb.r, rgb.g), rgb.b);
        float spread = peak - valley;
        if (peak > 0.78 && spread > 0.16) {
            float lowMid = max(min(rgb.r, rgb.g), min(max(rgb.r, rgb.g), rgb.b));
            float suppression = clamp((peak - 0.78) / 0.8, 0.0, 1.0)
                * clamp((spread - 0.16) / 1.2, 0.0, 1.0)
                * (0.18 + (clamp(u_highlightStrength, 0.0, 1.0) * 0.34));
            rgb = vec3(lowMid) + ((rgb - vec3(lowMid)) * (1.0 - suppression));
        }
    }

    if (u_toneAmount > 0.0) {
        rgb = mix(rgb, rgb / (vec3(1.0) + rgb), vec3(clamp(u_toneAmount, 0.0, 1.0)));
    }

    rgb = suppressMagentaHighlights(rgb, 0.32 + (clamp(u_highlightStrength, 0.0, 1.0) * 0.48));

    return clamp(rgb, 0.0, 4.0);
}

void main() {
    vec2 orientedPx = v_uv * max(u_outputRes - 1.0, vec2(0.0));
    vec3 rgb = sampleDevelopedRgb(orientedPx);
    outColor = vec4(rgb, 1.0);
}
