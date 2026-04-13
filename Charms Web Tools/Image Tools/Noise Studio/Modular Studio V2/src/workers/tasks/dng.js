import { decodeDngBuffer, probeDngBuffer } from '../../editor/dngProcessing.js';
import { reviveWorkerSingleFile } from '../filePayload.js';

function now() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
}

function collectTransfers(decodedSource = null) {
    const transfer = [];
    if (decodedSource?.rawRaster?.data instanceof Float32Array) {
        transfer.push(decodedSource.rawRaster.data.buffer);
    }
    if (decodedSource?.metadata?.linearizationTable instanceof Float32Array) {
        transfer.push(decodedSource.metadata.linearizationTable.buffer);
    }
    if (Array.isArray(decodedSource?.metadata?.gainMaps)) {
        decodedSource.metadata.gainMaps.forEach((entry) => {
            if (entry?.gains instanceof Float32Array) {
                transfer.push(entry.gains.buffer);
            }
        });
    }
    return transfer;
}

async function getSourceBuffer(payload = {}) {
    if (payload.buffer instanceof ArrayBuffer) {
        return payload.buffer;
    }
    if (payload.fileEntry) {
        const file = reviveWorkerSingleFile(payload.fileEntry, payload.file);
        if (file) {
            return file.arrayBuffer();
        }
        if (payload.fileEntry.buffer instanceof ArrayBuffer) {
            return payload.fileEntry.buffer;
        }
    }
    if (payload.file instanceof Blob) {
        return payload.file.arrayBuffer();
    }
    throw new Error('No DNG source buffer was provided.');
}

export const dngTaskHandlers = {
    async 'probe-dng-source'(payload = {}, context) {
        const startedAt = now();
        context.progress(0.1, 'Reading the DNG container...');
        const buffer = await getSourceBuffer(payload);
        context.assertNotCancelled();
        context.progress(0.55, 'Probing raw metadata...');
        const result = await probeDngBuffer(buffer);
        context.assertNotCancelled();
        context.log('info', `DNG probe completed in ${Math.round(now() - startedAt)}ms.`);
        context.progress(1, 'DNG probe complete.');
        return result;
    },
    async 'decode-dng-source'(payload = {}, context) {
        const startedAt = now();
        context.progress(0.08, 'Reading the DNG payload...');
        const buffer = await getSourceBuffer(payload);
        context.assertNotCancelled();
        const decodeStartedAt = now();
        context.progress(0.4, 'Decoding raw samples...');
        const decoded = await decodeDngBuffer(buffer);
        context.assertNotCancelled();
        const decodeMs = Math.round(now() - decodeStartedAt);
        context.log('info', `DNG decode completed in ${decodeMs}ms.`);
        context.progress(0.85, 'Preparing GPU upload payload...');
        return {
            payload: decoded,
            transfer: collectTransfers(decoded)
        };
    }
};
