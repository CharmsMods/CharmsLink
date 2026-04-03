#include <cctype>
#include <cstdint>
#include <string>
#include <vector>

namespace {

constexpr char BASE64_TABLE[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

inline int decode_base64_char(uint8_t value) {
    if (value >= 'A' && value <= 'Z') return value - 'A';
    if (value >= 'a' && value <= 'z') return value - 'a' + 26;
    if (value >= '0' && value <= '9') return value - '0' + 52;
    if (value == '+') return 62;
    if (value == '/') return 63;
    return -1;
}

}  // namespace

extern "C" {

int32_t library_base64_encode_bound(int32_t input_length) {
    if (input_length <= 0) return 0;
    return ((input_length + 2) / 3) * 4;
}

int32_t library_base64_encode(
    const uint8_t* input,
    int32_t input_length,
    uint8_t* output
) {
    if (!input || !output || input_length < 0) return -1;
    int32_t write_index = 0;
    for (int32_t index = 0; index < input_length; index += 3) {
        const uint32_t first = input[index];
        const uint32_t second = (index + 1) < input_length ? input[index + 1] : 0;
        const uint32_t third = (index + 2) < input_length ? input[index + 2] : 0;
        const uint32_t block = (first << 16) | (second << 8) | third;
        output[write_index++] = static_cast<uint8_t>(BASE64_TABLE[(block >> 18) & 63]);
        output[write_index++] = static_cast<uint8_t>(BASE64_TABLE[(block >> 12) & 63]);
        output[write_index++] = static_cast<uint8_t>((index + 1) < input_length ? BASE64_TABLE[(block >> 6) & 63] : '=');
        output[write_index++] = static_cast<uint8_t>((index + 2) < input_length ? BASE64_TABLE[block & 63] : '=');
    }
    return write_index;
}

int32_t library_base64_decode_bound(int32_t input_length) {
    if (input_length <= 0) return 0;
    return ((input_length + 3) / 4) * 3;
}

int32_t library_base64_decode(
    const uint8_t* input,
    int32_t input_length,
    uint8_t* output,
    int32_t* status_out
) {
    if (status_out) *status_out = 0;
    if (!input || !output || input_length < 0) return -1;

    std::vector<uint8_t> compact;
    compact.reserve(static_cast<std::size_t>(input_length));
    for (int32_t index = 0; index < input_length; index += 1) {
        const uint8_t value = input[index];
        if (std::isspace(static_cast<unsigned char>(value))) continue;
        compact.push_back(value);
    }

    if (compact.empty()) {
        if (status_out) *status_out = 1;
        return 0;
    }
    if ((compact.size() % 4) != 0) {
        return -1;
    }

    int32_t write_index = 0;
    for (std::size_t index = 0; index < compact.size(); index += 4) {
        const uint8_t c0 = compact[index];
        const uint8_t c1 = compact[index + 1];
        const uint8_t c2 = compact[index + 2];
        const uint8_t c3 = compact[index + 3];
        const int v0 = decode_base64_char(c0);
        const int v1 = decode_base64_char(c1);
        if (v0 < 0 || v1 < 0) {
            return -1;
        }

        const bool pad2 = c2 == '=';
        const bool pad3 = c3 == '=';
        const int v2 = pad2 ? 0 : decode_base64_char(c2);
        const int v3 = pad3 ? 0 : decode_base64_char(c3);
        if ((!pad2 && v2 < 0) || (!pad3 && v3 < 0)) {
            return -1;
        }
        if (pad2 && !pad3) {
            return -1;
        }

        const uint32_t block = (static_cast<uint32_t>(v0) << 18)
            | (static_cast<uint32_t>(v1) << 12)
            | (static_cast<uint32_t>(v2) << 6)
            | static_cast<uint32_t>(v3);

        output[write_index++] = static_cast<uint8_t>((block >> 16) & 255);
        if (!pad2) {
            output[write_index++] = static_cast<uint8_t>((block >> 8) & 255);
        }
        if (!pad3) {
            output[write_index++] = static_cast<uint8_t>(block & 255);
        }
    }

    if (status_out) *status_out = 1;
    return write_index;
}

}  // extern "C"
