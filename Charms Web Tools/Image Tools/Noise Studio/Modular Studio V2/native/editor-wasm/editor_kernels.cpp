#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <vector>

namespace {

inline int clamp_int(int value, int minimum, int maximum) {
    return std::max(minimum, std::min(maximum, value));
}

inline float clamp_float(float value, float minimum, float maximum) {
    return std::max(minimum, std::min(maximum, value));
}

inline std::size_t pixel_offset(int width, int x, int y) {
    return static_cast<std::size_t>((y * width + x) * 4);
}

inline void fill_rgba(uint8_t* output, int width, int height, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
    if (!output || width <= 0 || height <= 0) return;
    const std::size_t total = static_cast<std::size_t>(width) * static_cast<std::size_t>(height);
    for (std::size_t index = 0; index < total; index += 1) {
        const std::size_t offset = index * 4;
        output[offset] = r;
        output[offset + 1] = g;
        output[offset + 2] = b;
        output[offset + 3] = a;
    }
}

inline void blend_pixel(uint8_t* output, int width, int height, int x, int y, uint8_t r, uint8_t g, uint8_t b, float alpha) {
    if (!output || x < 0 || y < 0 || x >= width || y >= height) return;
    const float clamped_alpha = clamp_float(alpha, 0.0f, 1.0f);
    const std::size_t offset = pixel_offset(width, x, y);
    output[offset] = static_cast<uint8_t>(std::round(output[offset] + ((r - output[offset]) * clamped_alpha)));
    output[offset + 1] = static_cast<uint8_t>(std::round(output[offset + 1] + ((g - output[offset + 1]) * clamped_alpha)));
    output[offset + 2] = static_cast<uint8_t>(std::round(output[offset + 2] + ((b - output[offset + 2]) * clamped_alpha)));
    output[offset + 3] = 255;
}

void draw_grid(uint8_t* output, int width, int height, int steps, uint8_t r, uint8_t g, uint8_t b, float alpha) {
    if (!output || width <= 0 || height <= 0 || steps <= 1) return;
    for (int step = 1; step < steps; step += 1) {
        const int x = static_cast<int>(std::round((static_cast<float>(width) / steps) * step));
        const int y = static_cast<int>(std::round((static_cast<float>(height) / steps) * step));
        for (int py = 0; py < height; py += 1) {
            blend_pixel(output, width, height, clamp_int(x, 0, width - 1), py, r, g, b, alpha);
        }
        for (int px = 0; px < width; px += 1) {
            blend_pixel(output, width, height, px, clamp_int(y, 0, height - 1), r, g, b, alpha);
        }
    }
}

void draw_ring(uint8_t* output, int width, int height, float radius, uint8_t r, uint8_t g, uint8_t b, float alpha) {
    if (!output || width <= 0 || height <= 0 || radius <= 0.0f) return;
    const float center_x = static_cast<float>(width) * 0.5f;
    const float center_y = static_cast<float>(height) * 0.5f;
    const int segments = 720;
    for (int index = 0; index < segments; index += 1) {
        const float angle = (static_cast<float>(index) / segments) * 6.28318530718f;
        const int x = static_cast<int>(std::round(center_x + (std::cos(angle) * radius)));
        const int y = static_cast<int>(std::round(center_y + (std::sin(angle) * radius)));
        blend_pixel(output, width, height, x, y, r, g, b, alpha);
    }
}

inline float compute_luma(uint8_t r, uint8_t g, uint8_t b) {
    return (static_cast<float>(r) * 0.2126f)
        + (static_cast<float>(g) * 0.7152f)
        + (static_cast<float>(b) * 0.0722f);
}

struct PaletteSample {
    float r;
    float g;
    float b;
    float weight;
};

inline float squared_distance(const PaletteSample& a, const PaletteSample& b) {
    const float dr = a.r - b.r;
    const float dg = a.g - b.g;
    const float db = a.b - b.b;
    return (dr * dr) + (dg * dg) + (db * db);
}

std::vector<PaletteSample> collect_palette_samples(const uint8_t* pixels, int width, int height) {
    std::vector<PaletteSample> samples;
    if (!pixels || width <= 0 || height <= 0) return samples;
    const int longest_edge = std::max(width, height);
    const int stride = std::max(1, longest_edge / 160);
    samples.reserve(static_cast<std::size_t>((width / stride) + 1) * static_cast<std::size_t>((height / stride) + 1));
    for (int y = 0; y < height; y += stride) {
        for (int x = 0; x < width; x += stride) {
            const std::size_t offset = pixel_offset(width, x, y);
            const uint8_t alpha = pixels[offset + 3];
            if (alpha < 8) continue;
            const float weight = alpha / 255.0f;
            samples.push_back({
                static_cast<float>(pixels[offset]),
                static_cast<float>(pixels[offset + 1]),
                static_cast<float>(pixels[offset + 2]),
                weight
            });
        }
    }
    if (samples.empty()) {
        samples.push_back({255.0f, 255.0f, 255.0f, 1.0f});
    }
    return samples;
}

std::vector<PaletteSample> initialize_palette_centers(const std::vector<PaletteSample>& samples, int palette_size) {
    std::vector<PaletteSample> centers;
    if (samples.empty() || palette_size <= 0) return centers;
    const std::size_t seed = (samples.size() * 2654435761u) % samples.size();
    centers.push_back(samples[seed]);
    while (static_cast<int>(centers.size()) < palette_size) {
        float best_distance = -1.0f;
        std::size_t best_index = centers.size() % samples.size();
        for (std::size_t sample_index = 0; sample_index < samples.size(); sample_index += 1) {
            float nearest = squared_distance(samples[sample_index], centers[0]);
            for (std::size_t center_index = 1; center_index < centers.size(); center_index += 1) {
                nearest = std::min(nearest, squared_distance(samples[sample_index], centers[center_index]));
            }
            if (nearest > best_distance) {
                best_distance = nearest;
                best_index = sample_index;
            }
        }
        centers.push_back(samples[best_index]);
    }
    return centers;
}

}  // namespace

extern "C" {

int editor_compute_histogram_rgba(
    const uint8_t* pixels,
    int width,
    int height,
    int output_width,
    int output_height,
    uint8_t* output_rgba,
    int32_t* average_brightness_out
) {
    if (!pixels || !output_rgba || output_width <= 0 || output_height <= 0 || width <= 0 || height <= 0) return 0;
    fill_rgba(output_rgba, output_width, output_height, 255, 255, 255, 255);
    draw_grid(output_rgba, output_width, output_height, 8, 17, 17, 17, 0.08f);

    std::array<uint32_t, 256> histogram = {};
    uint64_t total_luma = 0;
    uint64_t sample_count = 0;
    const int sample_rate = std::max(1, (width * height) / 12000);
    for (int pixel_index = 0; pixel_index < width * height; pixel_index += sample_rate) {
        const std::size_t offset = static_cast<std::size_t>(pixel_index) * 4;
        const int luminance = clamp_int(static_cast<int>(std::round(compute_luma(pixels[offset], pixels[offset + 1], pixels[offset + 2]))), 0, 255);
        histogram[static_cast<std::size_t>(luminance)] += 1;
        total_luma += static_cast<uint64_t>(luminance);
        sample_count += 1;
    }

    uint32_t max_value = 0;
    for (const uint32_t value : histogram) {
        max_value = std::max(max_value, value);
    }

    for (int index = 0; index < 256; index += 1) {
        const float x0 = (static_cast<float>(index) / 255.0f) * output_width;
        const float bar_width = std::max(1.0f, static_cast<float>(output_width) / 256.0f);
        const float normalized = max_value ? (static_cast<float>(histogram[static_cast<std::size_t>(index)]) / static_cast<float>(max_value)) : 0.0f;
        const int bar_height = clamp_int(static_cast<int>(std::round(normalized * output_height)), 0, output_height);
        for (int py = output_height - bar_height; py < output_height; py += 1) {
            for (int px = static_cast<int>(x0); px < static_cast<int>(std::ceil(x0 + bar_width)); px += 1) {
                blend_pixel(output_rgba, output_width, output_height, px, py, 17, 17, 17, 0.88f);
            }
        }
    }

    if (average_brightness_out) {
        *average_brightness_out = static_cast<int32_t>(sample_count ? std::llround(static_cast<double>(total_luma) / static_cast<double>(sample_count)) : 0);
    }
    return 1;
}

int editor_compute_vectorscope_rgba(
    const uint8_t* pixels,
    int width,
    int height,
    int output_width,
    int output_height,
    uint8_t* output_rgba,
    int32_t* average_saturation_out
) {
    if (!pixels || !output_rgba || output_width <= 0 || output_height <= 0 || width <= 0 || height <= 0) return 0;
    fill_rgba(output_rgba, output_width, output_height, 255, 255, 255, 255);
    const float radius = std::min(output_width, output_height) * 0.45f;
    for (int ring = 1; ring <= 4; ring += 1) {
        draw_ring(output_rgba, output_width, output_height, (radius / 4.0f) * ring, 17, 17, 17, 0.1f);
    }

    const float center_x = static_cast<float>(output_width) * 0.5f;
    const float center_y = static_cast<float>(output_height) * 0.5f;
    const int sample_rate = std::max(1, (width * height) / 16000);
    double saturation_sum = 0.0;
    int sample_count = 0;

    for (int pixel_index = 0; pixel_index < width * height; pixel_index += sample_rate) {
        const std::size_t offset = static_cast<std::size_t>(pixel_index) * 4;
        const float r = pixels[offset] / 255.0f;
        const float g = pixels[offset + 1] / 255.0f;
        const float b = pixels[offset + 2] / 255.0f;
        const float maximum = std::max(r, std::max(g, b));
        const float minimum = std::min(r, std::min(g, b));
        const float delta = maximum - minimum;
        const float saturation = maximum == 0.0f ? 0.0f : delta / maximum;
        float hue = 0.0f;
        if (delta != 0.0f) {
            if (maximum == r) hue = ((g - b) / delta + (g < b ? 6.0f : 0.0f)) / 6.0f;
            else if (maximum == g) hue = ((b - r) / delta + 2.0f) / 6.0f;
            else hue = ((r - g) / delta + 4.0f) / 6.0f;
        }
        const float angle = hue * 6.28318530718f - 1.57079632679f;
        const int x = static_cast<int>(std::round(center_x + (std::cos(angle) * radius * saturation)));
        const int y = static_cast<int>(std::round(center_y + (std::sin(angle) * radius * saturation)));
        for (int oy = 0; oy < 2; oy += 1) {
            for (int ox = 0; ox < 2; ox += 1) {
                blend_pixel(output_rgba, output_width, output_height, x + ox, y + oy, pixels[offset], pixels[offset + 1], pixels[offset + 2], 0.12f);
            }
        }
        saturation_sum += saturation;
        sample_count += 1;
    }

    if (average_saturation_out) {
        *average_saturation_out = static_cast<int32_t>(std::llround((saturation_sum / std::max(1, sample_count)) * 100.0));
    }
    return 1;
}

int editor_compute_parade_rgba(
    const uint8_t* pixels,
    int width,
    int height,
    int output_width,
    int output_height,
    uint8_t* output_rgba
) {
    if (!pixels || !output_rgba || output_width <= 0 || output_height <= 0 || width <= 0 || height <= 0) return 0;
    fill_rgba(output_rgba, output_width, output_height, 255, 255, 255, 255);
    draw_grid(output_rgba, output_width, output_height, 6, 17, 17, 17, 0.08f);

    const float section_width = static_cast<float>(output_width) / 3.0f;
    const float actual_width = section_width - 16.0f;
    const int sample_rate = std::max(1, (width * height) / 20000);
    for (int pixel_index = 0; pixel_index < width * height; pixel_index += sample_rate) {
        const int x = pixel_index % width;
        const std::size_t offset = static_cast<std::size_t>(pixel_index) * 4;
        const int red_x = static_cast<int>(std::round((static_cast<float>(x) / width) * actual_width + 8.0f));
        const int green_x = static_cast<int>(std::round(section_width + (static_cast<float>(x) / width) * actual_width + 8.0f));
        const int blue_x = static_cast<int>(std::round(section_width * 2.0f + (static_cast<float>(x) / width) * actual_width + 8.0f));
        const int red_y = clamp_int(static_cast<int>(std::round(output_height - ((pixels[offset] / 255.0f) * output_height))), 0, output_height - 1);
        const int green_y = clamp_int(static_cast<int>(std::round(output_height - ((pixels[offset + 1] / 255.0f) * output_height))), 0, output_height - 1);
        const int blue_y = clamp_int(static_cast<int>(std::round(output_height - ((pixels[offset + 2] / 255.0f) * output_height))), 0, output_height - 1);
        blend_pixel(output_rgba, output_width, output_height, red_x, red_y, 255, 85, 85, 0.12f);
        blend_pixel(output_rgba, output_width, output_height, green_x, green_y, 102, 255, 145, 0.12f);
        blend_pixel(output_rgba, output_width, output_height, blue_x, blue_y, 82, 160, 255, 0.12f);
    }
    return 1;
}

int editor_compute_diff_preview(
    const uint8_t* base_pixels,
    const uint8_t* processed_pixels,
    int total_bytes,
    uint8_t* output_rgba
) {
    if (!base_pixels || !processed_pixels || !output_rgba || total_bytes <= 0 || (total_bytes % 4) != 0) return 0;
    for (int offset = 0; offset < total_bytes; offset += 4) {
        const uint8_t base_r = base_pixels[offset];
        const uint8_t base_g = base_pixels[offset + 1];
        const uint8_t base_b = base_pixels[offset + 2];
        const uint8_t next_r = processed_pixels[offset];
        const uint8_t next_g = processed_pixels[offset + 1];
        const uint8_t next_b = processed_pixels[offset + 2];
        const float base_luma = compute_luma(base_r, base_g, base_b);
        const float next_luma = compute_luma(next_r, next_g, next_b);
        const float dr = static_cast<float>(next_r) - static_cast<float>(base_r);
        const float dg = static_cast<float>(next_g) - static_cast<float>(base_g);
        const float db = static_cast<float>(next_b) - static_cast<float>(base_b);
        const float diff_magnitude = std::sqrt((dr * dr) + (dg * dg) + (db * db)) / 441.67295593f;
        const float overlay_strength = clamp_float(diff_magnitude * 3.0f, 0.0f, 1.0f);
        const uint8_t tint_r = next_luma >= base_luma ? 46 : 255;
        const uint8_t tint_g = next_luma >= base_luma ? 214 : 138;
        const uint8_t tint_b = next_luma >= base_luma ? 255 : 64;
        const float grayscale = clamp_float(std::round((base_luma * 0.88f) + 12.0f), 0.0f, 255.0f);
        output_rgba[offset] = static_cast<uint8_t>(std::round(grayscale + ((static_cast<float>(tint_r) - grayscale) * overlay_strength)));
        output_rgba[offset + 1] = static_cast<uint8_t>(std::round(grayscale + ((static_cast<float>(tint_g) - grayscale) * overlay_strength)));
        output_rgba[offset + 2] = static_cast<uint8_t>(std::round(grayscale + ((static_cast<float>(tint_b) - grayscale) * overlay_strength)));
        output_rgba[offset + 3] = 255;
    }
    return 1;
}

int editor_extract_palette(
    const uint8_t* pixels,
    int width,
    int height,
    int palette_size,
    uint8_t* output_rgb
) {
    if (!pixels || !output_rgb || width <= 0 || height <= 0 || palette_size <= 0) return 0;
    std::vector<PaletteSample> samples = collect_palette_samples(pixels, width, height);
    const int actual_count = std::min<int>(palette_size, static_cast<int>(samples.size()));
    std::vector<PaletteSample> centers = initialize_palette_centers(samples, actual_count);
    std::vector<int> assignments(samples.size(), 0);

    for (int iteration = 0; iteration < 8; iteration += 1) {
        std::vector<PaletteSample> sums(actual_count, {0.0f, 0.0f, 0.0f, 0.0f});
        for (std::size_t sample_index = 0; sample_index < samples.size(); sample_index += 1) {
            float best_distance = squared_distance(samples[sample_index], centers[0]);
            int best_cluster = 0;
            for (int cluster_index = 1; cluster_index < actual_count; cluster_index += 1) {
                const float distance = squared_distance(samples[sample_index], centers[cluster_index]);
                if (distance < best_distance) {
                    best_distance = distance;
                    best_cluster = cluster_index;
                }
            }
            assignments[sample_index] = best_cluster;
            sums[best_cluster].r += samples[sample_index].r * samples[sample_index].weight;
            sums[best_cluster].g += samples[sample_index].g * samples[sample_index].weight;
            sums[best_cluster].b += samples[sample_index].b * samples[sample_index].weight;
            sums[best_cluster].weight += samples[sample_index].weight;
        }

        for (int cluster_index = 0; cluster_index < actual_count; cluster_index += 1) {
            if (sums[cluster_index].weight <= 0.0f) {
                centers[cluster_index] = samples[(cluster_index * 977u) % samples.size()];
                continue;
            }
            centers[cluster_index].r = sums[cluster_index].r / sums[cluster_index].weight;
            centers[cluster_index].g = sums[cluster_index].g / sums[cluster_index].weight;
            centers[cluster_index].b = sums[cluster_index].b / sums[cluster_index].weight;
            centers[cluster_index].weight = sums[cluster_index].weight;
        }
    }

    std::sort(centers.begin(), centers.end(), [](const PaletteSample& left, const PaletteSample& right) {
        if (left.weight != right.weight) return left.weight > right.weight;
        const float left_luma = (left.r * 0.2126f) + (left.g * 0.7152f) + (left.b * 0.0722f);
        const float right_luma = (right.r * 0.2126f) + (right.g * 0.7152f) + (right.b * 0.0722f);
        return left_luma > right_luma;
    });

    for (int index = 0; index < actual_count; index += 1) {
        output_rgb[index * 3] = static_cast<uint8_t>(clamp_int(static_cast<int>(std::round(centers[index].r)), 0, 255));
        output_rgb[index * 3 + 1] = static_cast<uint8_t>(clamp_int(static_cast<int>(std::round(centers[index].g)), 0, 255));
        output_rgb[index * 3 + 2] = static_cast<uint8_t>(clamp_int(static_cast<int>(std::round(centers[index].b)), 0, 255));
    }

    return actual_count;
}

}  // extern "C"
