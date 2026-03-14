import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import * as THREE from 'three';

export function enableBVH() {
  THREE.Mesh.prototype.raycast = acceleratedRaycast;
  THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
  THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
}

export function buildBVHForScene(root) {
  root.traverse((child) => {
    if (child.isMesh && child.geometry) {
      if (!child.geometry.boundsTree) {
        child.geometry.computeBoundsTree();
      }
    }
  });
}

export function disposeBVHForScene(root) {
  root.traverse((child) => {
    if (child.isMesh && child.geometry && child.geometry.boundsTree) {
      child.geometry.disposeBoundsTree();
    }
  });
}
