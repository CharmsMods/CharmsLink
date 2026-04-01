import * as THREE from 'three';

export const LOCKED_VIEW_OPTIONS = ['front', 'back', 'left', 'right', 'top', 'bottom', 'current'];
export const PROJECTION_OPTIONS = ['perspective', 'orthographic'];
export const NAVIGATION_OPTIONS = ['free', 'canvas'];
export const WHEEL_MODE_OPTIONS = ['travel', 'zoom'];

const PRESET_VIEW_DEFS = {
    front: { position: [0, 0, 1], up: [0, 1, 0] },
    back: { position: [0, 0, -1], up: [0, 1, 0] },
    left: { position: [1, 0, 0], up: [0, 1, 0] },
    right: { position: [-1, 0, 0], up: [0, 1, 0] },
    top: { position: [0, 1, 0], up: [0, 0, -1] },
    bottom: { position: [0, -1, 0], up: [0, 0, 1] }
};

function createPresetQuaternion(position, up) {
    const helper = new THREE.Object3D();
    helper.position.fromArray(position);
    helper.up.fromArray(up);
    helper.lookAt(0, 0, 0);
    return helper.quaternion.clone();
}

const PRESET_VIEW_QUATERNIONS = Object.fromEntries(
    Object.entries(PRESET_VIEW_DEFS).map(([key, value]) => [
        key,
        createPresetQuaternion(value.position, value.up)
    ])
);

function normalizeVector3Array(value, fallback = [0, 0, 0]) {
    if (!Array.isArray(value) || value.length < 3) return [...fallback];
    return [
        Number.isFinite(Number(value[0])) ? Number(value[0]) : fallback[0],
        Number.isFinite(Number(value[1])) ? Number(value[1]) : fallback[1],
        Number.isFinite(Number(value[2])) ? Number(value[2]) : fallback[2]
    ];
}

export function quaternionToArray(quaternion) {
    const q = quaternion || new THREE.Quaternion();
    return [q.x, q.y, q.z, q.w];
}

export function quaternionArrayToQuaternion(value, fallback = null) {
    const source = Array.isArray(value) && value.length >= 4 ? value : null;
    if (!source) {
        return fallback ? fallback.clone() : null;
    }
    const quaternion = new THREE.Quaternion(
        Number(source[0]) || 0,
        Number(source[1]) || 0,
        Number(source[2]) || 0,
        Number(source[3]) || 1
    );
    if (quaternion.lengthSq() < 0.000001) {
        return fallback ? fallback.clone() : new THREE.Quaternion();
    }
    quaternion.normalize();
    return quaternion;
}

export function createCameraQuaternionFromPose(cameraPosition = [0, 0, 8], cameraTarget = [0, 0, 0], up = [0, 1, 0]) {
    const helper = new THREE.Object3D();
    helper.position.fromArray(normalizeVector3Array(cameraPosition, [0, 0, 8]));
    helper.up.fromArray(normalizeVector3Array(up, [0, 1, 0]));
    helper.lookAt(...normalizeVector3Array(cameraTarget, [0, 0, 0]));
    return helper.quaternion.clone();
}

export function getLockedViewQuaternion(lockedView = 'front', lockedRotation = null, cameraPose = null) {
    if (lockedView === 'current') {
        const explicit = quaternionArrayToQuaternion(lockedRotation, null);
        if (explicit) return explicit;
        if (cameraPose) {
            return createCameraQuaternionFromPose(cameraPose.cameraPosition, cameraPose.cameraTarget);
        }
    }
    return (PRESET_VIEW_QUATERNIONS[lockedView] || PRESET_VIEW_QUATERNIONS.front).clone();
}

export function getLockedViewForward(lockedView = 'front', lockedRotation = null, cameraPose = null) {
    return new THREE.Vector3(0, 0, -1).applyQuaternion(
        getLockedViewQuaternion(lockedView, lockedRotation, cameraPose)
    ).normalize();
}

export function alignCameraToLockedView(view = {}) {
    const target = new THREE.Vector3(...normalizeVector3Array(view.cameraTarget, [0, 0, 0]));
    const sourcePosition = new THREE.Vector3(...normalizeVector3Array(view.cameraPosition, [0, 0, 8]));
    const distance = Math.max(sourcePosition.distanceTo(target), 0.5);
    const quaternion = getLockedViewQuaternion(view.lockedView, view.lockedRotation, view);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();
    const nextPosition = target.clone().sub(forward.multiplyScalar(distance));
    return {
        cameraPosition: nextPosition.toArray(),
        cameraTarget: target.toArray(),
        lockedRotation: quaternionToArray(quaternion)
    };
}

export function getCanvasFacingEuler(view = {}) {
    const quaternion = getLockedViewQuaternion(view.lockedView, view.lockedRotation, view);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');
    return [euler.x, euler.y, euler.z];
}

export function createCanvasSpawnTransform(view = {}) {
    return {
        position: normalizeVector3Array(view.cameraTarget, [0, 0, 0]),
        rotation: getCanvasFacingEuler(view)
    };
}

export function composeItemMatrix(item = {}) {
    const position = new THREE.Vector3(...normalizeVector3Array(item.position, [0, 0, 0]));
    const rotation = new THREE.Euler(...normalizeVector3Array(item.rotation, [0, 0, 0]), 'XYZ');
    const scale = new THREE.Vector3(...normalizeVector3Array(item.scale, [1, 1, 1])).set(
        Math.max(0.0001, Number(item.scale?.[0] ?? 1)),
        Math.max(0.0001, Number(item.scale?.[1] ?? 1)),
        Math.max(0.0001, Number(item.scale?.[2] ?? 1))
    );
    return new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale);
}

function getSafeTangent(normal) {
    const tangent = Math.abs(normal.y) < 0.99
        ? new THREE.Vector3(0, 1, 0).cross(normal)
        : new THREE.Vector3(1, 0, 0).cross(normal);
    if (tangent.lengthSq() < 0.000001) {
        tangent.set(1, 0, 0);
    }
    return tangent.normalize();
}

function buildQuaternionFromBasis(normal, tangent) {
    const zAxis = normal.clone().normalize();
    const xAxis = tangent.clone().normalize();
    if (xAxis.lengthSq() < 0.000001) {
        xAxis.copy(getSafeTangent(zAxis));
    }
    const yAxis = zAxis.clone().cross(xAxis).normalize();
    if (yAxis.lengthSq() < 0.000001) {
        yAxis.copy(new THREE.Vector3(0, 1, 0));
    }
    xAxis.copy(yAxis.clone().cross(zAxis).normalize());
    const matrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
    return new THREE.Quaternion().setFromRotationMatrix(matrix);
}

export function createAttachmentFromWorldHit(targetItem, hitPoint, worldNormal, worldTangent = null, offset = 0.01) {
    if (!targetItem) return null;
    const matrix = composeItemMatrix(targetItem);
    const inverse = matrix.clone().invert();
    const toLocalNormal = new THREE.Matrix3().getNormalMatrix(inverse);

    const point = hitPoint.clone().applyMatrix4(inverse);
    const normal = worldNormal.clone().applyMatrix3(toLocalNormal).normalize();
    const tangent = (worldTangent ? worldTangent.clone() : getSafeTangent(worldNormal))
        .applyMatrix3(toLocalNormal)
        .normalize();

    return {
        targetItemId: targetItem.id,
        localPosition: point.toArray(),
        localNormal: normal.toArray(),
        localTangent: tangent.toArray(),
        offset: Math.max(0, Number(offset) || 0)
    };
}

export function resolveAttachmentTransform(targetItem, attachment = null) {
    if (!targetItem || !attachment?.targetItemId) return null;
    const matrix = composeItemMatrix(targetItem);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);

    const localPosition = new THREE.Vector3(...normalizeVector3Array(attachment.localPosition, [0, 0, 0]));
    const worldNormal = new THREE.Vector3(...normalizeVector3Array(attachment.localNormal, [0, 0, 1]))
        .applyMatrix3(normalMatrix)
        .normalize();
    const worldTangent = new THREE.Vector3(...normalizeVector3Array(attachment.localTangent, [1, 0, 0]))
        .applyMatrix3(normalMatrix)
        .normalize();

    if (worldTangent.lengthSq() < 0.000001) {
        worldTangent.copy(getSafeTangent(worldNormal));
    }

    const worldPosition = localPosition
        .clone()
        .applyMatrix4(matrix)
        .add(worldNormal.clone().multiplyScalar(Math.max(0, Number(attachment.offset) || 0)));
    const quaternion = buildQuaternionFromBasis(worldNormal, worldTangent);
    const euler = new THREE.Euler().setFromQuaternion(quaternion, 'XYZ');

    return {
        position: worldPosition.toArray(),
        rotation: [euler.x, euler.y, euler.z]
    };
}
