import { decodeUtifJpegDng } from './module.mjs';

const TIFF_LITTLE_ENDIAN = 0x4949;
const TIFF_BIG_ENDIAN = 0x4d4d;
const TIFF_MAGIC = 42;
const PHOTOMETRIC_CFA = 32803;
const PHOTOMETRIC_LINEAR_RAW = 34892;
const COMPRESSION_NONE = 1;
const COMPRESSION_JPEG = 7;
const COMPRESSION_DEFLATE = 8;
const COMPRESSION_ADOBE_DEFLATE = 32946;
const SAMPLE_FORMAT_UINT = 1;
const SAMPLE_FORMAT_INT = 2;
const SAMPLE_FORMAT_FLOAT = 3;

const TYPE_SIZES = Object.freeze({
    1: 1,
    2: 1,
    3: 2,
    4: 4,
    5: 8,
    6: 1,
    7: 1,
    8: 2,
    9: 4,
    10: 8,
    11: 4,
    12: 8
});

const TAGS = Object.freeze({
    256: 'ImageWidth',
    257: 'ImageLength',
    258: 'BitsPerSample',
    259: 'Compression',
    262: 'PhotometricInterpretation',
    271: 'Make',
    272: 'Model',
    273: 'StripOffsets',
    274: 'Orientation',
    277: 'SamplesPerPixel',
    278: 'RowsPerStrip',
    279: 'StripByteCounts',
    284: 'PlanarConfiguration',
    322: 'TileWidth',
    323: 'TileLength',
    324: 'TileOffsets',
    325: 'TileByteCounts',
    330: 'SubIFDs',
    339: 'SampleFormat',
    50706: 'DNGVersion',
    50707: 'DNGBackwardVersion',
    50708: 'UniqueCameraModel',
    50710: 'CFAPlaneColor',
    50712: 'LinearizationTable',
    50713: 'BlackLevelRepeatDim',
    50714: 'BlackLevel',
    50717: 'WhiteLevel',
    50718: 'DefaultScale',
    50719: 'DefaultCropOrigin',
    50720: 'DefaultCropSize',
    50721: 'ColorMatrix1',
    50722: 'ColorMatrix2',
    50723: 'CameraCalibration1',
    50724: 'CameraCalibration2',
    50728: 'AsShotNeutral',
    50730: 'BaselineExposure',
    50731: 'BaselineNoise',
    50732: 'BaselineSharpness',
    50734: 'LinearResponseLimit',
    51008: 'OpcodeList1',
    51009: 'OpcodeList2',
    51010: 'OpcodeList3',
    51041: 'NoiseProfile',
    50733: 'BayerGreenSplit',
    33421: 'CFARepeatPatternDim',
    33422: 'CFAPattern',
    50711: 'CFALayout',
    50727: 'AnalogBalance',
    50729: 'AsShotWhiteXY',
    51043: 'TimeCodes',
    51044: 'FrameRate',
    51081: 'ProfileGainTableMap',
    50784: 'ForwardMatrix1',
    50785: 'ForwardMatrix2',
    50778: 'CalibrationIlluminant1',
    50779: 'CalibrationIlluminant2',
    50780: 'BestQualityScale',
    50782: 'AliasLayerMetadata',
    50781: 'RawDataUniqueID',
    50715: 'RowInterleaveFactor',
    50716: 'ColumnInterleaveFactor'
});

const COMPRESSION_LABELS = Object.freeze({
    [COMPRESSION_NONE]: 'Uncompressed',
    [COMPRESSION_JPEG]: 'JPEG',
    [COMPRESSION_DEFLATE]: 'Deflate',
    [COMPRESSION_ADOBE_DEFLATE]: 'Adobe Deflate',
    52546: 'JPEG XL'
});

function clampPositiveInteger(value, fallback = 0) {
    const numeric = Math.round(Number(value) || 0);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function toArray(value) {
    if (Array.isArray(value)) return value;
    if (value === undefined || value === null) return [];
    return [value];
}

function createReader(buffer) {
    const source = buffer instanceof ArrayBuffer
        ? buffer
        : (ArrayBuffer.isView(buffer)
            ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
            : new ArrayBuffer(0));
    const view = new DataView(source);
    const endianMarker = view.getUint16(0, false);
    const littleEndian = endianMarker === TIFF_LITTLE_ENDIAN;
    if (!littleEndian && endianMarker !== TIFF_BIG_ENDIAN) {
        throw new Error('The file is not a TIFF/DNG stream.');
    }
    const magic = view.getUint16(2, littleEndian);
    if (magic !== TIFF_MAGIC) {
        throw new Error('This DNG uses an unsupported TIFF variant.');
    }
    return {
        buffer: source,
        view,
        littleEndian,
        readU8(offset) { return view.getUint8(offset); },
        readI8(offset) { return view.getInt8(offset); },
        readU16(offset) { return view.getUint16(offset, littleEndian); },
        readI16(offset) { return view.getInt16(offset, littleEndian); },
        readU32(offset) { return view.getUint32(offset, littleEndian); },
        readI32(offset) { return view.getInt32(offset, littleEndian); },
        readF32(offset) { return view.getFloat32(offset, littleEndian); },
        readF64(offset) { return view.getFloat64(offset, littleEndian); },
        slice(offset, length) {
            const safeOffset = Math.max(0, offset | 0);
            const safeLength = Math.max(0, length | 0);
            return new Uint8Array(source.slice(safeOffset, safeOffset + safeLength));
        }
    };
}

function readScalar(reader, type, offset) {
    switch (type) {
        case 1:
        case 7:
            return reader.readU8(offset);
        case 2:
            return String.fromCharCode(reader.readU8(offset));
        case 3:
            return reader.readU16(offset);
        case 4:
            return reader.readU32(offset);
        case 5:
            return reader.readU32(offset) / Math.max(1, reader.readU32(offset + 4));
        case 6:
            return reader.readI8(offset);
        case 8:
            return reader.readI16(offset);
        case 9:
            return reader.readI32(offset);
        case 10:
            return reader.readI32(offset) / Math.max(1, reader.readI32(offset + 4));
        case 11:
            return reader.readF32(offset);
        case 12:
            return reader.readF64(offset);
        default:
            return 0;
    }
}

function readTagValue(reader, type, count, rawOffset, entryOffset) {
    const typeSize = TYPE_SIZES[type];
    if (!typeSize) return null;
    const byteLength = typeSize * count;
    const start = byteLength <= 4 ? entryOffset + 8 : rawOffset;
    if (type === 2) {
        const bytes = reader.slice(start, count);
        return new TextDecoder().decode(bytes).replace(/\0+$/, '');
    }
    const values = [];
    for (let index = 0; index < count; index += 1) {
        values.push(readScalar(reader, type, start + (index * typeSize)));
    }
    return count === 1 ? values[0] : values;
}

function readIfd(reader, offset) {
    const count = reader.readU16(offset);
    const entries = [];
    for (let index = 0; index < count; index += 1) {
        const entryOffset = offset + 2 + (index * 12);
        const tag = reader.readU16(entryOffset);
        const type = reader.readU16(entryOffset + 2);
        const valueCount = reader.readU32(entryOffset + 4);
        const rawOffset = reader.readU32(entryOffset + 8);
        const value = readTagValue(reader, type, valueCount, rawOffset, entryOffset);
        entries.push({
            tag,
            key: TAGS[tag] || `Tag${tag}`,
            type,
            count: valueCount,
            rawOffset,
            value
        });
    }
    const nextOffset = reader.readU32(offset + 2 + (count * 12));
    return {
        offset,
        count,
        entries,
        nextOffset,
        tags: Object.fromEntries(entries.map((entry) => [entry.key, entry.value]))
    };
}

function collectIfds(reader, offset, output = [], visited = new Set()) {
    let current = clampPositiveInteger(offset, 0);
    while (current > 0 && !visited.has(current)) {
        visited.add(current);
        const ifd = readIfd(reader, current);
        output.push(ifd);
        toArray(ifd.tags.SubIFDs).forEach((subOffset) => {
            const safeOffset = clampPositiveInteger(subOffset, 0);
            if (safeOffset > 0 && !visited.has(safeOffset)) {
                collectIfds(reader, safeOffset, output, visited);
            }
        });
        current = clampPositiveInteger(ifd.nextOffset, 0);
    }
    return output;
}

function scoreIfd(ifd) {
    const tags = ifd?.tags || {};
    let score = 0;
    if (tags.PhotometricInterpretation === PHOTOMETRIC_CFA || tags.PhotometricInterpretation === PHOTOMETRIC_LINEAR_RAW) score += 10;
    if (tags.StripOffsets || tags.TileOffsets) score += 8;
    if (tags.StripByteCounts || tags.TileByteCounts) score += 6;
    if (tags.ImageWidth && tags.ImageLength) score += 4;
    return score;
}

function chooseRawIfd(ifds = []) {
    return [...ifds].sort((left, right) => scoreIfd(right) - scoreIfd(left))[0] || null;
}

function mapCompressionLabel(compression) {
    return COMPRESSION_LABELS[compression] || `Compression ${compression || 0}`;
}

function classifyProbe(rawIfd, rootIfd) {
    const tags = rawIfd?.tags || {};
    const rootTags = rootIfd?.tags || {};
    const patternDim = toArray(tags.CFARepeatPatternDim).map((value) => clampPositiveInteger(value, 0));
    const patternWidth = patternDim[0] || 0;
    const patternHeight = patternDim[1] || 0;
    const photometric = Number(tags.PhotometricInterpretation || 0);
    const rowInterleaveFactor = clampPositiveInteger(tags.RowInterleaveFactor, 0);
    const columnInterleaveFactor = clampPositiveInteger(tags.ColumnInterleaveFactor, 0);
    const classificationMode = photometric === PHOTOMETRIC_LINEAR_RAW
        ? 'linear'
        : (rowInterleaveFactor > 1 || columnInterleaveFactor > 1)
            ? 'interleaved'
            : (patternWidth > 2 || patternHeight > 2)
                ? 'quad'
                : 'bayer';
    const compression = Number(tags.Compression || COMPRESSION_NONE);
    const warnings = [];
    let fidelity = 'supported';
    if (![COMPRESSION_NONE, COMPRESSION_JPEG, COMPRESSION_DEFLATE, COMPRESSION_ADOBE_DEFLATE].includes(compression)) {
        fidelity = compression === 52546 ? 'partial' : 'unsupported';
        warnings.push(`This build does not decode ${mapCompressionLabel(compression)} DNG payloads yet.`);
    }
    if (rowInterleaveFactor > 1 || columnInterleaveFactor > 1) {
        fidelity = fidelity === 'unsupported' ? fidelity : 'partial';
        warnings.push('Interleaved DNG layouts are detected, but only the standard packed raster path is implemented in this build.');
    }
    if (tags.OpcodeList1 || tags.OpcodeList2 || tags.OpcodeList3) {
        fidelity = fidelity === 'unsupported' ? fidelity : 'partial';
        warnings.push('This DNG includes opcode corrections. The controls are exposed, but opcode execution is not fully implemented yet.');
    }
    if (tags.ProfileGainTableMap) {
        fidelity = fidelity === 'unsupported' ? fidelity : 'partial';
        warnings.push('This DNG includes a gain map. The toggle is exposed, but gain-map correction is not fully implemented yet.');
    }
    return {
        make: String(tags.Make || rootTags.Make || ''),
        model: String(tags.Model || rootTags.Model || rootTags.UniqueCameraModel || ''),
        width: clampPositiveInteger(tags.DefaultCropSize?.[0], clampPositiveInteger(tags.ImageWidth, 0)),
        height: clampPositiveInteger(tags.DefaultCropSize?.[1], clampPositiveInteger(tags.ImageLength, 0)),
        storedWidth: clampPositiveInteger(tags.ImageWidth, 0),
        storedHeight: clampPositiveInteger(tags.ImageLength, 0),
        bitDepth: Math.max(...toArray(tags.BitsPerSample).map((value) => clampPositiveInteger(value, 0)), 0),
        bitsPerSample: toArray(tags.BitsPerSample),
        samplesPerPixel: clampPositiveInteger(tags.SamplesPerPixel, 1),
        sampleFormat: clampPositiveInteger(tags.SampleFormat, SAMPLE_FORMAT_UINT),
        compression,
        compressionLabel: mapCompressionLabel(compression),
        photometric,
        classificationMode,
        cfaPatternWidth: patternWidth,
        cfaPatternHeight: patternHeight,
        cfaPattern: toArray(tags.CFAPattern),
        rowInterleaveFactor,
        columnInterleaveFactor,
        orientation: clampPositiveInteger(tags.Orientation, 1),
        blackLevel: toArray(tags.BlackLevel),
        whiteLevel: toArray(tags.WhiteLevel),
        asShotNeutral: toArray(tags.AsShotNeutral),
        colorMatrix1: toArray(tags.ColorMatrix1),
        colorMatrix2: toArray(tags.ColorMatrix2),
        hasLinearizationTable: Array.isArray(tags.LinearizationTable) && tags.LinearizationTable.length > 0,
        hasOpcodeList: !!(tags.OpcodeList1 || tags.OpcodeList2 || tags.OpcodeList3),
        hasGainMap: !!tags.ProfileGainTableMap,
        fidelity,
        warnings
    };
}

function readPackedUintSamples(bytes, count, bitsPerSample) {
    if (bitsPerSample === 8) {
        return Float32Array.from(bytes.subarray(0, count));
    }
    if (bitsPerSample === 16) {
        const samples = new Float32Array(count);
        for (let index = 0; index < count; index += 1) {
            const offset = index * 2;
            samples[index] = ((bytes[offset] || 0) << 8) | (bytes[offset + 1] || 0);
        }
        return samples;
    }
    const samples = new Float32Array(count);
    const mask = (1 << bitsPerSample) - 1;
    let bitOffset = 0;
    for (let index = 0; index < count; index += 1) {
        let value = 0;
        for (let bit = 0; bit < bitsPerSample; bit += 1) {
            const byteIndex = (bitOffset + bit) >> 3;
            const bitIndex = 7 - ((bitOffset + bit) & 7);
            value = (value << 1) | (((bytes[byteIndex] || 0) >> bitIndex) & 1);
        }
        samples[index] = value & mask;
        bitOffset += bitsPerSample;
    }
    return samples;
}

async function inflateBytes(bytes) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('Deflate-compressed DNG files require DecompressionStream support in this build.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function decodeSegmentBytes(bytes, compression) {
    if (compression === COMPRESSION_NONE) return bytes;
    if (compression === COMPRESSION_DEFLATE || compression === COMPRESSION_ADOBE_DEFLATE) {
        return inflateBytes(bytes);
    }
    throw new Error(`Unsupported DNG compression: ${mapCompressionLabel(compression)}.`);
}

export function parseDngBuffer(buffer) {
    const reader = createReader(buffer);
    const firstIfdOffset = reader.readU32(4);
    const ifds = collectIfds(reader, firstIfdOffset);
    const rootIfd = ifds[0] || null;
    const rawIfd = chooseRawIfd(ifds);
    if (!rawIfd) {
        throw new Error('This DNG does not expose a readable raw image IFD.');
    }
    return {
        reader,
        ifds,
        rootIfd,
        rawIfd,
        probe: classifyProbe(rawIfd, rootIfd)
    };
}

export async function decodeDngRaster(parsed) {
    const rawIfd = parsed?.rawIfd;
    const tags = rawIfd?.tags || {};
    const width = clampPositiveInteger(tags.ImageWidth, 0);
    const height = clampPositiveInteger(tags.ImageLength, 0);
    const samplesPerPixel = clampPositiveInteger(tags.SamplesPerPixel, 1);
    const bitsPerSample = clampPositiveInteger(toArray(tags.BitsPerSample)[0], 16);
    const sampleFormat = clampPositiveInteger(toArray(tags.SampleFormat)[0], SAMPLE_FORMAT_UINT);
    const planarConfiguration = clampPositiveInteger(tags.PlanarConfiguration, 1);
    if (!width || !height) {
        throw new Error('This DNG is missing image dimensions.');
    }
    if (planarConfiguration !== 1) {
        throw new Error('Planar DNG layouts are not supported in this build.');
    }
    if (sampleFormat !== SAMPLE_FORMAT_UINT) {
        throw new Error('Only unsigned-integer DNG sample formats are supported in this build.');
    }

    const reader = parsed.reader;
    const compression = Number(tags.Compression || COMPRESSION_NONE);
    const stripOffsets = toArray(tags.StripOffsets);
    const stripByteCounts = toArray(tags.StripByteCounts);
    const tileOffsets = toArray(tags.TileOffsets);
    const tileByteCounts = toArray(tags.TileByteCounts);
    const output = new Float32Array(width * height * samplesPerPixel);

    if (compression === COMPRESSION_JPEG) {
        const decoded = decodeUtifJpegDng(reader.buffer, {
            width,
            height,
            bitsPerSample,
            samplesPerPixel,
            compression,
            photometric: Number(tags.PhotometricInterpretation || 0)
        });
        const decodedBitsPerSample = clampPositiveInteger(decoded.bitsPerSample, bitsPerSample);
        const decodedSamplesPerPixel = clampPositiveInteger(decoded.samplesPerPixel, samplesPerPixel);
        const samples = readPackedUintSamples(
            decoded.data,
            width * height * decodedSamplesPerPixel,
            decodedBitsPerSample
        );
        output.set(samples.subarray(0, output.length), 0);
        return {
            width,
            height,
            samplesPerPixel: decodedSamplesPerPixel,
            bitsPerSample: decodedBitsPerSample,
            sampleFormat,
            data: output
        };
    }

    if (stripOffsets.length && stripByteCounts.length) {
        const rowsPerStrip = clampPositiveInteger(tags.RowsPerStrip, height);
        for (let stripIndex = 0; stripIndex < stripOffsets.length; stripIndex += 1) {
            const rowStart = stripIndex * rowsPerStrip;
            const segmentRows = Math.max(0, Math.min(rowsPerStrip, height - rowStart));
            const bytes = reader.slice(Number(stripOffsets[stripIndex] || 0), Number(stripByteCounts[stripIndex] || 0));
            const decoded = await decodeSegmentBytes(bytes, compression);
            const samples = readPackedUintSamples(decoded, width * segmentRows * samplesPerPixel, bitsPerSample);
            output.set(samples, rowStart * width * samplesPerPixel);
        }
    } else if (tileOffsets.length && tileByteCounts.length) {
        const tileWidth = clampPositiveInteger(tags.TileWidth, width);
        const tileHeight = clampPositiveInteger(tags.TileLength, height);
        let tileIndex = 0;
        for (let tileTop = 0; tileTop < height; tileTop += tileHeight) {
            for (let tileLeft = 0; tileLeft < width; tileLeft += tileWidth) {
                const bytes = reader.slice(Number(tileOffsets[tileIndex] || 0), Number(tileByteCounts[tileIndex] || 0));
                const decoded = await decodeSegmentBytes(bytes, compression);
                const samples = readPackedUintSamples(decoded, tileWidth * tileHeight * samplesPerPixel, bitsPerSample);
                const drawWidth = Math.min(tileWidth, width - tileLeft);
                const drawHeight = Math.min(tileHeight, height - tileTop);
                for (let row = 0; row < drawHeight; row += 1) {
                    const srcOffset = row * tileWidth * samplesPerPixel;
                    const dstOffset = ((tileTop + row) * width + tileLeft) * samplesPerPixel;
                    output.set(samples.subarray(srcOffset, srcOffset + (drawWidth * samplesPerPixel)), dstOffset);
                }
                tileIndex += 1;
            }
        }
    } else {
        throw new Error('This DNG does not expose strip or tile byte ranges.');
    }

    return {
        width,
        height,
        samplesPerPixel,
        bitsPerSample,
        sampleFormat,
        data: output
    };
}

