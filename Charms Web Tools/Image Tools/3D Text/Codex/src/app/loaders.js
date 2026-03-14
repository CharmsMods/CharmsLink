import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';

export function sanitizeFileName(name) {
  return name.replace(/[^a-z0-9-_\.]/gi, '_');
}

function createGLTFLoader(renderer) {
  const loader = new GLTFLoader();
  const draco = new DRACOLoader();
  // Place Draco decoder files at /draco/ if needed.
  draco.setDecoderPath('/draco/');
  loader.setDRACOLoader(draco);

  const ktx2 = new KTX2Loader();
  // Place BasisU transcoder files at /basis/ if needed.
  ktx2.setTranscoderPath('/basis/');
  if (renderer) {
    ktx2.detectSupport(renderer);
    loader.setKTX2Loader(ktx2);
  }

  return loader;
}

export async function loadModelFromFile(file, renderer) {
  const extension = file.name.split('.').pop().toLowerCase();
  const warnings = [];
  let root = null;

  if (extension === 'glb' || extension === 'gltf') {
    const loader = createGLTFLoader(renderer);
    // const gltf = await loader.loadAsync(fileURLOrFileBlob);
    const url = URL.createObjectURL(file);
    const gltf = await loader.loadAsync(url);
    URL.revokeObjectURL(url);
    root = gltf.scene;
  } else if (extension === 'obj') {
    const loader = new OBJLoader();
    const url = URL.createObjectURL(file);
    root = await loader.loadAsync(url);
    URL.revokeObjectURL(url);
    warnings.push('OBJ loaded. PBR materials and UV conventions may be limited compared to GLTF/GLB.');
  } else if (extension === 'fbx') {
    const loader = new FBXLoader();
    const url = URL.createObjectURL(file);
    root = await loader.loadAsync(url);
    URL.revokeObjectURL(url);
    warnings.push('FBX loaded. PBR material mapping is best with GLTF/GLB.');
  } else if (extension === 'ply') {
    const loader = new PLYLoader();
    const buffer = await file.arrayBuffer();
    const geometry = loader.parse(buffer);
    geometry.computeVertexNormals();
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
    root = new THREE.Mesh(geometry, material);
    warnings.push('PLY loaded. Materials are basic; GLTF/GLB recommended for full PBR.');
  } else {
    throw new Error('Unsupported file type.');
  }

  const stats = analyzeScene(root);
  return { root, warnings, stats };
}

export function analyzeScene(root) {
  let triangles = 0;
  let meshes = 0;
  let skinned = false;

  root.traverse((child) => {
    if (child.isMesh && child.geometry) {
      meshes += 1;
      const geom = child.geometry;
      if (geom.index) {
        triangles += geom.index.count / 3;
      } else if (geom.attributes.position) {
        triangles += geom.attributes.position.count / 3;
      }
    }
    if (child.isSkinnedMesh) {
      skinned = true;
    }
  });

  return { triangles: Math.round(triangles), meshes, skinned };
}

export function disposeObject(object) {
  object.traverse((child) => {
    if (child.isMesh) {
      if (child.geometry) child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((mat) => mat.dispose());
      } else if (child.material) {
        child.material.dispose();
      }
    }
  });
}
