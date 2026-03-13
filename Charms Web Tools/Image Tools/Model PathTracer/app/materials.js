import * as THREE from 'three';
import { resetSamples } from './renderer.js';

// Default material settings binded to UI later
export const defaultMaterialSettings = {
    transmission: 0.0,        // Opaque by default — user can increase for glass
    opacity: 255, // UI slider 0-255
    ior: 1.5,
    roughness: 0.3,           // Slightly rough for a natural appearance
    thickness: 1.0,
    tintColor: '#ffffff',
    overrideMaterial: true,    // Whether to replace model materials with glass/custom
    
    // Texture specific
    textureAlpha: 255, // 0-255
    texScale: 1.0,
    texOffsetX: 0.0,
    texOffsetY: 0.0,
    texRot: 0.0
};

export function createGlassMaterial(state) {
    const s = state.guiSettings || defaultMaterialSettings;
    
    // Convert 0-255 to 0.0-1.0
    const opacity01 = Math.max(0, Math.min(1, s.opacity / 255.0));
    const finalOpacity = opacity01 * (s.textureAlpha / 255.0);

    const mat = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(s.tintColor),
        transmission: s.transmission,
        opacity: finalOpacity,
        transparent: true,
        roughness: s.roughness,
        ior: s.ior,
        thickness: s.thickness,
        side: THREE.FrontSide, // three-gpu-pathtracer optimizes front side glass better initially
    });

    if (state.uploadedTexture) {
        mat.map = state.uploadedTexture;
    }

    return mat;
}

export function applyTexture(model, tex, state) {
    model.traverse((child) => {
        if (child.isMesh && child.material) {
            child.material.map = tex;
            child.material.needsUpdate = true;
        }
    });
}

export function updateMaterials(state) {
    if (!state.model) return;

    const s = state.guiSettings;
    const opacity01 = s.opacity / 255.0;
    const finalOpacity = opacity01 * (s.textureAlpha / 255.0);

    state.model.traverse((child) => {
        if (child.isMesh && child.material) {
            const m = child.material;
            m.transmission = s.transmission;
            m.opacity = finalOpacity;
            m.roughness = s.roughness;
            m.ior = s.ior;
            m.thickness = s.thickness;
            m.color.set(s.tintColor);
            
            // Texture transforms
            if (m.map) {
                m.map.repeat.setScalar(s.texScale);
                m.map.offset.set(s.texOffsetX, s.texOffsetY);
                m.map.rotation = s.texRot;
                m.map.needsUpdate = true;
            }
            m.needsUpdate = true;
        }
    });

    state.pathTracer.updateMaterials();
    resetSamples(state.pathTracer);
}
