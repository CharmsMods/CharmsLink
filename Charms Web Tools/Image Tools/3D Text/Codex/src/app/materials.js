import * as THREE from 'three';

export function thicknessToAttenuationDistance(thickness) {
  if (thickness <= 0) return 1e6;
  return Math.max(0.01, 1 / thickness);
}

export function createGlassMaterial(params = {}) {
  const tint = new THREE.Color(params.tintColor || '#ffffff');
  const material = new THREE.MeshPhysicalMaterial({
    color: tint,
    transmission: params.transmission ?? 1,
    opacity: params.opacity ?? 1,
    roughness: params.roughness ?? 0,
    ior: params.ior ?? 1.5,
    thickness: params.thickness ?? 0.1,
    metalness: 0,
    transparent: true,
    side: THREE.DoubleSide
  });

  material.attenuationColor = tint;
  material.attenuationDistance = thicknessToAttenuationDistance(params.thickness ?? 0);
  material.normalScale = new THREE.Vector2(params.normalMapIntensity ?? 0, params.normalMapIntensity ?? 0);
  material.userData.baseOpacity = params.opacity ?? 1;

  return material;
}

export function updateGlassMaterial(material, params = {}) {
  if (!material || !material.isMeshPhysicalMaterial) return;
  const tint = new THREE.Color(params.tintColor || '#ffffff');
  material.color.copy(tint);
  material.attenuationColor.copy(tint);
  material.transmission = params.transmission ?? material.transmission;
  material.opacity = params.opacity ?? material.opacity;
  material.ior = params.ior ?? material.ior;
  material.roughness = params.roughness ?? material.roughness;
  material.thickness = params.thickness ?? material.thickness;
  material.attenuationDistance = thicknessToAttenuationDistance(params.thickness ?? 0);
  const normalIntensity = params.normalMapIntensity ?? 0;
  material.normalScale.set(normalIntensity, normalIntensity);
  material.needsUpdate = true;
}

export function applyGlassToScene(root, params, options = {}) {
  const exclude = options.excludeNames || new Set();
  const materials = [];
  root.traverse((child) => {
    if (child.isMesh) {
      if (exclude.has(child.name)) return;
      if (child.material && child.material.isMeshPhysicalMaterial) {
        child.material.dispose();
      }
      const material = createGlassMaterial(params);
      child.material = material;
      materials.push(material);
    }
  });
  return materials;
}

export function applyTextureOverlay(root, texture, textureAlpha, transform) {
  root.traverse((child) => {
    if (child.isMesh && child.material && child.material.isMeshPhysicalMaterial) {
      child.material.map = texture || null;
      child.material.alphaMap = texture || null;
      child.material.transparent = true;
      if (texture) {
        texture.wrapS = THREE.RepeatWrapping;
        texture.wrapT = THREE.RepeatWrapping;
        applyTextureTransform(texture, transform);
      }
      child.material.opacity = (child.material.userData.baseOpacity ?? child.material.opacity) * textureAlpha;
      child.material.needsUpdate = true;
    }
  });
}

export function applyTextureTransform(texture, transform = {}) {
  if (!texture) return;
  texture.repeat.set(transform.scaleX ?? 1, transform.scaleY ?? 1);
  texture.offset.set(transform.offsetX ?? 0, transform.offsetY ?? 0);
  texture.rotation = transform.rotation ?? 0;
  texture.center.set(0.5, 0.5);
  texture.needsUpdate = true;
}

export function cacheBaseOpacity(root, opacity) {
  root.traverse((child) => {
    if (child.isMesh && child.material && child.material.isMeshPhysicalMaterial) {
      child.material.userData.baseOpacity = opacity;
    }
  });
}

export function updateOpacityChain(root, baseOpacity, textureAlpha) {
  root.traverse((child) => {
    if (child.isMesh && child.material && child.material.isMeshPhysicalMaterial) {
      child.material.userData.baseOpacity = baseOpacity;
      child.material.opacity = baseOpacity * textureAlpha;
      child.material.needsUpdate = true;
    }
  });
}
