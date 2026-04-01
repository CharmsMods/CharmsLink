import * as THREE from 'three';

const uploadedFontFaceCache = new Map();
const uploadedFontDataCache = new Map();

const measureCanvas = globalThis.document?.createElement?.('canvas') || null;
const measureContext = measureCanvas ? measureCanvas.getContext('2d') : null;

async function dataUrlToArrayBuffer(dataUrl) {
    const response = await fetch(dataUrl);
    return response.arrayBuffer();
}

function getTextAsset(documentState, assetId) {
    if (!assetId) return null;
    return documentState?.assets?.fonts?.find((asset) => asset.id === assetId) || null;
}

function getCharacterOverrideMap(overrides = []) {
    const map = new Map();
    (Array.isArray(overrides) ? overrides : []).forEach((entry) => {
        const index = Number(entry?.index);
        if (!Number.isFinite(index) || index < 0) return;
        map.set(index, {
            flipX: !!entry?.flipX,
            flipY: !!entry?.flipY
        });
    });
    return map;
}

function createTextMaterial({ color = '#ffffff', opacity = 1, glow = null, map = null, transparent = true } = {}) {
    return new THREE.MeshStandardMaterial({
        color: new THREE.Color(color || '#ffffff'),
        emissive: new THREE.Color(glow?.enabled ? (glow.color || color || '#ffffff') : '#000000'),
        emissiveIntensity: glow?.enabled ? Math.max(0, Number(glow.intensity) || 0) : 0,
        opacity: Math.min(1, Math.max(0.01, Number(opacity) || 1)),
        transparent,
        alphaTest: map ? 0.001 : 0,
        map,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide
    });
}

async function ensureUploadedFontFace(fontAsset) {
    if (!fontAsset?.id || !fontAsset?.dataUrl) {
        throw new Error('This text item is missing its uploaded font asset.');
    }
    if (!uploadedFontFaceCache.has(fontAsset.id)) {
        uploadedFontFaceCache.set(fontAsset.id, (async () => {
            const family = `MnsUploadedFont_${fontAsset.id.replace(/[^a-z0-9_-]/gi, '_')}`;
            const face = new FontFace(family, `url(${fontAsset.dataUrl})`);
            await face.load();
            globalThis.document?.fonts?.add?.(face);
            try {
                await globalThis.document?.fonts?.ready;
            } catch {
                // Browsers that do not expose FontFaceSet.ready can still use the loaded face.
            }
            return family;
        })());
    }
    return uploadedFontFaceCache.get(fontAsset.id);
}

async function ensureUploadedOpentypeFont(fontAsset) {
    if (!fontAsset?.id || !fontAsset?.dataUrl) {
        throw new Error('This text item is missing its uploaded font asset.');
    }
    if (!globalThis.opentype?.parse) {
        throw new Error('The uploaded font parser is not available.');
    }
    if (!uploadedFontDataCache.has(fontAsset.id)) {
        uploadedFontDataCache.set(fontAsset.id, (async () => {
            const buffer = await dataUrlToArrayBuffer(fontAsset.dataUrl);
            return globalThis.opentype.parse(buffer);
        })());
    }
    return uploadedFontDataCache.get(fontAsset.id);
}

async function resolveFontFamily(textConfig, documentState) {
    if (textConfig?.fontSource?.type === 'upload') {
        const fontAsset = getTextAsset(documentState, textConfig.fontSource.assetId);
        if (!fontAsset) {
            throw new Error('The uploaded font for this text item is missing from the document.');
        }
        return ensureUploadedFontFace(fontAsset);
    }
    return String(textConfig?.fontSource?.family || 'Arial').trim() || 'Arial';
}

function createGlyphCanvas(char, family, color = '#ffffff') {
    const fontSize = 256;
    const padding = 80;
    const lineHeight = Math.round(fontSize * 1.3);
    const canvas = globalThis.document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = `${fontSize}px "${family}"`;
    const metrics = context.measureText(char || ' ');
    const advance = Math.max(1, Math.ceil(metrics.width || fontSize * 0.4));
    canvas.width = Math.max(2, advance + (padding * 2));
    canvas.height = Math.max(2, lineHeight + (padding * 2));

    const draw = canvas.getContext('2d');
    draw.clearRect(0, 0, canvas.width, canvas.height);
    draw.font = `${fontSize}px "${family}"`;
    draw.textAlign = 'left';
    draw.textBaseline = 'middle';
    draw.fillStyle = color;
    draw.fillText(char, padding, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    if ('colorSpace' in texture) {
        texture.colorSpace = THREE.SRGBColorSpace;
    }
    texture.userData = {
        ...(texture.userData || {}),
        threeDOwnedTexture: true
    };
    texture.needsUpdate = true;

    return {
        texture,
        advance: advance / fontSize,
        width: canvas.width / fontSize,
        height: canvas.height / fontSize
    };
}

function centerGroup(group) {
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    group.children.forEach((child) => {
        child.position.sub(center);
    });
}

function opentypePathToShapePath(path) {
    const shapePath = new THREE.ShapePath();
    (path?.commands || []).forEach((command) => {
        if (command.type === 'M') {
            shapePath.moveTo(command.x, command.y);
        } else if (command.type === 'L') {
            shapePath.lineTo(command.x, command.y);
        } else if (command.type === 'Q') {
            shapePath.quadraticCurveTo(command.x1, command.y1, command.x, command.y);
        } else if (command.type === 'C') {
            shapePath.bezierCurveTo(command.x1, command.y1, command.x2, command.y2, command.x, command.y);
        } else if (command.type === 'Z') {
            shapePath.currentPath?.closePath?.();
        }
    });
    return shapePath;
}

function applyCharacterFlip(node, override = null) {
    if (!override) return;
    node.scale.set(override.flipX ? -1 : 1, override.flipY ? -1 : 1, 1);
}

export async function createFlatTextObject(item, documentState) {
    const textConfig = item?.text || {};
    const family = await resolveFontFamily(textConfig, documentState);
    const content = String(textConfig.content || 'Text');
    const group = new THREE.Group();
    const overrideMap = getCharacterOverrideMap(textConfig.characterOverrides);

    let cursorX = 0;
    let cursorY = 0;
    let characterIndex = 0;
    let lineAdvance = 1.3;

    for (const char of Array.from(content)) {
        if (char === '\n') {
            cursorX = 0;
            cursorY -= lineAdvance;
            characterIndex += 1;
            continue;
        }

        if (measureContext) {
            measureContext.font = `256px "${family}"`;
            const metrics = measureContext.measureText(char || ' ');
            lineAdvance = Math.max(lineAdvance, 1.3);
            const advance = Math.max(0.18, Number(metrics.width || 0) / 256);

            if (char.trim()) {
                const glyph = createGlyphCanvas(char, family);
                const geometry = new THREE.PlaneGeometry(glyph.width, glyph.height);
                const material = createTextMaterial({
                    color: textConfig.color,
                    opacity: textConfig.opacity,
                    glow: textConfig.glow,
                    map: glyph.texture,
                    transparent: true
                });
                const mesh = new THREE.Mesh(geometry, material);
                mesh.position.set(cursorX + (advance * 0.5), cursorY, 0);
                mesh.castShadow = false;
                mesh.receiveShadow = false;
                mesh.userData.threeDOriginalMaterialTemplate = material.clone();
                applyCharacterFlip(mesh, overrideMap.get(characterIndex));
                group.add(mesh);
            }

            cursorX += advance;
            characterIndex += 1;
        }
    }

    centerGroup(group);
    group.name = item?.name || 'Text';
    return group;
}

export async function createExtrudedTextObject(item, documentState) {
    const textConfig = item?.text || {};
    const fontAsset = getTextAsset(documentState, textConfig.fontSource?.assetId);
    if (!fontAsset) {
        throw new Error('Extruded text requires an uploaded font.');
    }

    const font = await ensureUploadedOpentypeFont(fontAsset);
    const content = String(textConfig.content || 'Text');
    const group = new THREE.Group();
    const overrideMap = getCharacterOverrideMap(textConfig.characterOverrides);
    const sharedMaterial = createTextMaterial({
        color: textConfig.color,
        opacity: textConfig.opacity,
        glow: textConfig.glow,
        transparent: Number(textConfig.opacity) < 1
    });
    const scale = 1 / Math.max(1, Number(font.unitsPerEm) || 1000);
    const depth = Math.max(0.01, Number(textConfig.extrude?.depth) || 0.2);
    const bevelSize = Math.max(0, Number(textConfig.extrude?.bevelSize) || 0);
    const bevelThickness = Math.max(0, Number(textConfig.extrude?.bevelThickness) || 0);
    const bevelSegments = Math.max(1, Math.round(Number(textConfig.extrude?.bevelSegments) || 2));

    let cursorX = 0;
    let cursorY = 0;
    let characterIndex = 0;
    const characters = Array.from(content);

    for (let index = 0; index < characters.length; index += 1) {
        const char = characters[index];
        if (char === '\n') {
            cursorX = 0;
            cursorY -= 1.2;
            characterIndex += 1;
            continue;
        }

        const glyph = font.charToGlyph(char);
        const nextGlyph = index + 1 < characters.length ? font.charToGlyph(characters[index + 1]) : null;
        const advance = ((glyph.advanceWidth || font.unitsPerEm || 1000) + (nextGlyph ? font.getKerningValue(glyph, nextGlyph) : 0)) * scale;

        if (char.trim()) {
            const path = glyph.getPath(cursorX, cursorY, 1);
            const shapePath = opentypePathToShapePath(path);
            const shapes = shapePath.toShapes(true);
            if (shapes.length) {
                const geometry = new THREE.ExtrudeGeometry(shapes, {
                    depth,
                    bevelEnabled: bevelSize > 0 || bevelThickness > 0,
                    bevelSize,
                    bevelThickness,
                    bevelSegments,
                    curveSegments: 12
                });
                geometry.translate(0, 0, -(depth * 0.5));
                const mesh = new THREE.Mesh(geometry, sharedMaterial.clone());
                mesh.castShadow = true;
                mesh.receiveShadow = true;
                mesh.userData.threeDOriginalMaterialTemplate = mesh.material.clone();
                applyCharacterFlip(mesh, overrideMap.get(characterIndex));
                group.add(mesh);
            }
        }

        cursorX += advance;
        characterIndex += 1;
    }

    centerGroup(group);
    group.name = item?.name || 'Text';
    return group;
}
