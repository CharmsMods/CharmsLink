import * as THREE from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// Inject BVH implementations into Three.js primitives
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

export function applyBVH(object) {
    object.traverse((child) => {
        if (child.isMesh) {
            // Check triangle count
            const triCount = child.geometry.index ? 
                child.geometry.index.count / 3 : 
                child.geometry.attributes.position.count / 3;
                
            if (triCount > 2000000) {
                console.warn(`Mesh ${child.name} is extremely dense (${triCount} tris). BVH generation may take a while.`);
                window.showError(`Warning: Dense mesh detected (${(triCount/1000000).toFixed(1)}M tris). Generation may hang.`, 8000);
            }

            // Generate BVH for raycasting/path-tracing geometry
            child.geometry.computeBoundsTree();
        }
    });
}
