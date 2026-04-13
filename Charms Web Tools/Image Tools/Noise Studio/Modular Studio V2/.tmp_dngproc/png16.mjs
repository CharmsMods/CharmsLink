const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(bytes) {
    let value = 0xffffffff;
    for (let index = 0; index < bytes.length; index += 1) {
        value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
    }
    return (value ^ 0xffffffff) >>> 0;
}

function writeUint32(buffer, offset, value) {
    buffer[offset] = (value >>> 24) & 0xff;
    buffer[offset + 1] = (value >>> 16) & 0xff;
    buffer[offset + 2] = (value >>> 8) & 0xff;
    buffer[offset + 3] = value & 0xff;
}

function buildChunk(type, data = new Uint8Array(0)) {
    const typeBytes = new TextEncoder().encode(type);
    const chunk = new Uint8Array(12 + data.length);
    writeUint32(chunk, 0, data.length);
    chunk.set(typeBytes, 4);
    chunk.set(data, 8);
    const crcBuffer = new Uint8Array(typeBytes.length + data.length);
    crcBuffer.set(typeBytes, 0);
    crcBuffer.set(data, typeBytes.length);
    writeUint32(chunk, 8 + data.length, crc32(crcBuffer));
    return chunk;
}

async function compressDeflate(bytes) {
    if (typeof CompressionStream !== 'function') {
        throw new Error('PNG16 export requires CompressionStream support in this build.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
}

export async function encodePng16Rgba(width, height, rgba16) {
    const safeWidth = Math.max(1, Math.round(Number(width) || 1));
    const safeHeight = Math.max(1, Math.round(Number(height) || 1));
    const pixels = rgba16 instanceof Uint16Array ? rgba16 : new Uint16Array(rgba16 || []);
    const expectedLength = safeWidth * safeHeight * 4;
    if (pixels.length < expectedLength) {
        throw new Error('PNG16 export received too few pixels.');
    }

    const rowStride = 1 + (safeWidth * 8);
    const raw = new Uint8Array(rowStride * safeHeight);
    for (let y = 0; y < safeHeight; y += 1) {
        const rowOffset = y * rowStride;
        raw[rowOffset] = 0;
        let writeOffset = rowOffset + 1;
        let readOffset = y * safeWidth * 4;
        for (let x = 0; x < safeWidth; x += 1) {
            for (let channel = 0; channel < 4; channel += 1) {
                const value = pixels[readOffset + channel] || 0;
                raw[writeOffset] = (value >>> 8) & 0xff;
                raw[writeOffset + 1] = value & 0xff;
                writeOffset += 2;
            }
            readOffset += 4;
        }
    }

    const compressed = await compressDeflate(raw);
    const ihdr = new Uint8Array(13);
    writeUint32(ihdr, 0, safeWidth);
    writeUint32(ihdr, 4, safeHeight);
    ihdr[8] = 16;
    ihdr[9] = 6;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;

    const chunks = [
        PNG_SIGNATURE,
        buildChunk('IHDR', ihdr),
        buildChunk('IDAT', compressed),
        buildChunk('IEND')
    ];
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
        output.set(chunk, offset);
        offset += chunk.length;
    });
    return output;
}
