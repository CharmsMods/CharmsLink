function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function getPointerRatio(clientX, clientY, rect, fallback = { x: 0.5, y: 0.5 }) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return fallback;
    return {
        x: clamp((clientX - rect.left) / rect.width, 0, 1),
        y: clamp((clientY - rect.top) / rect.height, 0, 1)
    };
}

export function computePreviewTransform(containerWidth, containerHeight, contentWidth, contentHeight, zoom = 1, pointer = { x: 0.5, y: 0.5 }) {
    if (!containerWidth || !containerHeight || !contentWidth || !contentHeight) {
        return {
            fitScale: 1,
            visualScale: 1,
            offsetX: 0,
            offsetY: 0,
            scaledWidth: contentWidth || 0,
            scaledHeight: contentHeight || 0
        };
    }

    const fitScale = Math.min(
        1,
        containerWidth / contentWidth,
        containerHeight / contentHeight
    );
    const visualScale = fitScale * Math.max(1, zoom || 1);
    const scaledWidth = contentWidth * visualScale;
    const scaledHeight = contentHeight * visualScale;
    const overflowX = Math.max(0, scaledWidth - containerWidth);
    const overflowY = Math.max(0, scaledHeight - containerHeight);
    const pointerX = clamp(pointer?.x ?? 0.5, 0, 1);
    const pointerY = clamp(pointer?.y ?? 0.5, 0, 1);

    return {
        fitScale,
        visualScale,
        offsetX: overflowX > 0 ? -overflowX * pointerX : (containerWidth - scaledWidth) * 0.5,
        offsetY: overflowY > 0 ? -overflowY * pointerY : (containerHeight - scaledHeight) * 0.5,
        scaledWidth,
        scaledHeight
    };
}

export function clientToImageUv(clientX, clientY, rect) {
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    const x = clamp((clientX - rect.left) / rect.width, 0, 1);
    const y = clamp((clientY - rect.top) / rect.height, 0, 1);
    return { x, y };
}
