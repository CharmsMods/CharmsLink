import { createThreeDAssetId, createThreeDSceneItemId } from '../../3d/document.js';
import { blobToDataUrl } from '../../utils/dataUrl.js';
import { readImageMetadata } from '../../utils/workerImage.js';

function stripProjectExtension(name) {
    return String(name || '').replace(/\.[^/.]+$/, '');
}

function getThreeDFileExtension(name) {
    return String(name || '').split('.').pop()?.toLowerCase() || '';
}

export const threeTaskHandlers = {
    async 'prepare-model-files'(payload = {}, context) {
        const sourceFiles = (payload.files || []).filter((file) => {
            const extension = getThreeDFileExtension(file?.name);
            return extension === 'glb' || extension === 'gltf';
        });
        const items = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            context.assertNotCancelled();
            const file = sourceFiles[index];
            const extension = getThreeDFileExtension(file?.name);
            context.progress(sourceFiles.length ? index / sourceFiles.length : 0, `Reading model "${file.name}".`, {
                index,
                total: sourceFiles.length,
                file: { name: file.name, type: file.type },
                progress: sourceFiles.length ? index / sourceFiles.length : 0
            });
            const dataUrl = await blobToDataUrl(file);
            items.push({
                id: createThreeDSceneItemId('model'),
                kind: 'model',
                name: stripProjectExtension(file.name) || 'Model',
                visible: true,
                locked: false,
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                asset: {
                    format: extension,
                    name: file.name,
                    mimeType: file.type || '',
                    dataUrl
                }
            });
        }
        return { items };
    },
    async 'prepare-image-plane-files'(payload = {}, context) {
        const sourceFiles = (payload.files || []).filter((file) => String(file?.type || '').startsWith('image/'));
        const items = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            context.assertNotCancelled();
            const file = sourceFiles[index];
            context.progress(sourceFiles.length ? index / sourceFiles.length : 0, `Reading image plane "${file.name}".`, {
                index,
                total: sourceFiles.length,
                file: { name: file.name, type: file.type },
                progress: sourceFiles.length ? index / sourceFiles.length : 0
            });
            const [dataUrl, metadata] = await Promise.all([
                blobToDataUrl(file),
                readImageMetadata(file)
            ]);
            items.push({
                id: createThreeDSceneItemId('image-plane'),
                kind: 'image-plane',
                name: stripProjectExtension(file.name) || 'Image Plane',
                visible: true,
                locked: false,
                position: [0, 0, 0],
                rotation: [0, 0, 0],
                scale: [1, 1, 1],
                asset: {
                    format: 'image',
                    name: file.name,
                    mimeType: file.type || '',
                    dataUrl,
                    width: metadata.width,
                    height: metadata.height
                }
            });
        }
        return { items };
    },
    async 'prepare-font-files'(payload = {}, context) {
        const sourceFiles = (payload.files || []).filter((file) => ['ttf', 'otf', 'woff', 'woff2'].includes(getThreeDFileExtension(file?.name)));
        const assets = [];
        for (let index = 0; index < sourceFiles.length; index += 1) {
            context.assertNotCancelled();
            const file = sourceFiles[index];
            const extension = getThreeDFileExtension(file?.name);
            context.progress(sourceFiles.length ? index / sourceFiles.length : 0, `Reading font "${file.name}".`, {
                index,
                total: sourceFiles.length,
                file: { name: file.name, type: file.type },
                progress: sourceFiles.length ? index / sourceFiles.length : 0
            });
            const dataUrl = await blobToDataUrl(file);
            assets.push({
                id: createThreeDAssetId('font'),
                name: stripProjectExtension(file.name) || 'Font',
                format: extension,
                mimeType: file.type || '',
                dataUrl
            });
        }
        return { assets };
    },
    async 'prepare-hdri-file'(payload = {}, context) {
        const file = payload.file;
        if (!(file instanceof File)) return { asset: null };
        const extension = getThreeDFileExtension(file?.name);
        if (extension !== 'hdr') return { asset: null };
        context.assertNotCancelled();
        context.progress(0.2, `Reading HDRI "${file.name}".`, {
            index: 0,
            total: 1,
            file: { name: file.name, type: file.type },
            progress: 0.2
        });
        const dataUrl = await blobToDataUrl(file);
        return {
            asset: {
                id: createThreeDAssetId('hdri'),
                name: stripProjectExtension(file.name) || 'HDRI',
                format: extension,
                mimeType: file.type || '',
                dataUrl
            }
        };
    }
};
