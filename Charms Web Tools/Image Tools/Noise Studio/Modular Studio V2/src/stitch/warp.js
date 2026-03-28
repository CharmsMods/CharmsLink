function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
}

export function getMeshGridDimensions(density = 'medium', type = 'mesh') {
    if (type === 'perspective') return { cols: 8, rows: 8 };
    if (density === 'low') return { cols: 8, rows: 8 };
    if (density === 'high') return { cols: 16, rows: 16 };
    return { cols: 12, rows: 12 };
}

function createDefaultWarpPoints(cols, rows) {
    const points = [];
    for (let row = 0; row < rows; row += 1) {
        const v = rows > 1 ? row / (rows - 1) : 0;
        for (let col = 0; col < cols; col += 1) {
            const u = cols > 1 ? col / (cols - 1) : 0;
            points.push({ u, v, dx: 0, dy: 0, weight: 0 });
        }
    }
    return points;
}

export function normalizeWarpData(warp = null) {
    if (!warp || typeof warp !== 'object') return null;
    const type = warp.type === 'perspective' ? 'perspective' : (warp.type === 'mesh' ? 'mesh' : null);
    if (!type) return null;
    const density = ['low', 'medium', 'high'].includes(warp.density) ? warp.density : 'medium';
    const defaults = getMeshGridDimensions(density, type);
    const cols = Math.max(2, Math.round(toNumber(warp.cols, defaults.cols)));
    const rows = Math.max(2, Math.round(toNumber(warp.rows, defaults.rows)));
    const fallbackPoints = createDefaultWarpPoints(cols, rows);
    const points = Array.isArray(warp.points) ? warp.points : [];
    const normalizedPoints = fallbackPoints.map((fallback, index) => {
        const point = points[index] || {};
        return {
            u: clamp(toNumber(point.u, fallback.u), 0, 1),
            v: clamp(toNumber(point.v, fallback.v), 0, 1),
            dx: toNumber(point.dx, 0),
            dy: toNumber(point.dy, 0),
            weight: clamp(toNumber(point.weight, 0), 0, 1)
        };
    });
    return {
        type,
        density,
        cols,
        rows,
        strength: clamp(toNumber(warp.strength, 1), 0, 4),
        smoothness: clamp(toNumber(warp.smoothness, 0.5), 0, 1),
        points: normalizedPoints
    };
}

function rotatePoint(x, y, radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: (x * cos) - (y * sin),
        y: (x * sin) + (y * cos)
    };
}

function rotateVector(x, y, radians) {
    return rotatePoint(x, y, radians);
}

export function localPointToWorld(localX, localY, placement) {
    const scale = Math.max(0.01, toNumber(placement?.scale, 1));
    const rotation = toNumber(placement?.rotation, 0);
    const rotated = rotatePoint(localX * scale, localY * scale, rotation);
    return {
        x: rotated.x + toNumber(placement?.x, 0),
        y: rotated.y + toNumber(placement?.y, 0)
    };
}

export function worldPointToLocal(worldX, worldY, placement) {
    const translatedX = worldX - toNumber(placement?.x, 0);
    const translatedY = worldY - toNumber(placement?.y, 0);
    const unrotated = rotatePoint(translatedX, translatedY, -toNumber(placement?.rotation, 0));
    const scale = Math.max(0.01, toNumber(placement?.scale, 1));
    return {
        x: unrotated.x / scale,
        y: unrotated.y / scale
    };
}

export function worldVectorToLocalDelta(dx, dy, placement) {
    const unrotated = rotateVector(dx, dy, -toNumber(placement?.rotation, 0));
    const scale = Math.max(0.01, toNumber(placement?.scale, 1));
    return {
        x: unrotated.x / scale,
        y: unrotated.y / scale
    };
}

function getWarpPointByIndex(points, cols, col, row) {
    const index = (row * cols) + col;
    return points[index] || { u: cols > 1 ? col / (cols - 1) : 0, v: rows > 1 ? row / (rows - 1) : 0, dx: 0, dy: 0, weight: 0 };
}

export function getPlacementMeshPoints(input, placement) {
    const width = Math.max(1, toNumber(input?.width, 1));
    const height = Math.max(1, toNumber(input?.height, 1));
    const warp = normalizeWarpData(placement?.warp);
    const cols = warp?.cols || 2;
    const rows = warp?.rows || 2;
    const points = warp?.points || createDefaultWarpPoints(cols, rows);
    const mesh = [];
    for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
            const point = getWarpPointByIndex(points, cols, col, row);
            const sourceX = point.u * width;
            const sourceY = point.v * height;
            const warpedLocalX = sourceX + (point.dx * warp.strength);
            const warpedLocalY = sourceY + (point.dy * warp.strength);
            const world = localPointToWorld(warpedLocalX, warpedLocalY, placement);
            mesh.push({
                u: point.u,
                v: point.v,
                dx: point.dx,
                dy: point.dy,
                weight: point.weight || 0,
                sourceX,
                sourceY,
                localX: warpedLocalX,
                localY: warpedLocalY,
                worldX: world.x,
                worldY: world.y
            });
        }
    }
    return { cols, rows, points: mesh };
}

export function computeWarpBounds(input, placement) {
    const mesh = getPlacementMeshPoints(input, placement);
    const xs = mesh.points.map((point) => point.worldX);
    const ys = mesh.points.map((point) => point.worldY);
    if (!xs.length || !ys.length) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    return {
        minX: Math.min(...xs),
        minY: Math.min(...ys),
        maxX: Math.max(...xs),
        maxY: Math.max(...ys)
    };
}

function triangleContainsPoint(px, py, ax, ay, bx, by, cx, cy) {
    const denominator = ((by - cy) * (ax - cx)) + ((cx - bx) * (ay - cy));
    if (!denominator) return null;
    const alpha = (((by - cy) * (px - cx)) + ((cx - bx) * (py - cy))) / denominator;
    const beta = (((cy - ay) * (px - cx)) + ((ax - cx) * (py - cy))) / denominator;
    const gamma = 1 - alpha - beta;
    if (alpha < -0.0001 || beta < -0.0001 || gamma < -0.0001) return null;
    return { alpha, beta, gamma };
}

export function hitTestWarpedPlacement(input, placement, worldX, worldY) {
    const mesh = getPlacementMeshPoints(input, placement);
    for (let row = 0; row < mesh.rows - 1; row += 1) {
        for (let col = 0; col < mesh.cols - 1; col += 1) {
            const topLeft = mesh.points[(row * mesh.cols) + col];
            const topRight = mesh.points[(row * mesh.cols) + col + 1];
            const bottomLeft = mesh.points[((row + 1) * mesh.cols) + col];
            const bottomRight = mesh.points[((row + 1) * mesh.cols) + col + 1];
            const first = triangleContainsPoint(worldX, worldY, topLeft.worldX, topLeft.worldY, topRight.worldX, topRight.worldY, bottomLeft.worldX, bottomLeft.worldY);
            if (first) {
                return {
                    localX: (topLeft.sourceX * first.alpha) + (topRight.sourceX * first.beta) + (bottomLeft.sourceX * first.gamma),
                    localY: (topLeft.sourceY * first.alpha) + (topRight.sourceY * first.beta) + (bottomLeft.sourceY * first.gamma)
                };
            }
            const second = triangleContainsPoint(worldX, worldY, bottomLeft.worldX, bottomLeft.worldY, topRight.worldX, topRight.worldY, bottomRight.worldX, bottomRight.worldY);
            if (second) {
                return {
                    localX: (bottomLeft.sourceX * second.alpha) + (topRight.sourceX * second.beta) + (bottomRight.sourceX * second.gamma),
                    localY: (bottomLeft.sourceY * second.alpha) + (topRight.sourceY * second.beta) + (bottomRight.sourceY * second.gamma)
                };
            }
        }
    }
    return null;
}

function solveTriangleAffine(source, target) {
    const denominator = (source[0].x * (source[1].y - source[2].y))
        + (source[1].x * (source[2].y - source[0].y))
        + (source[2].x * (source[0].y - source[1].y));
    if (!denominator) return null;
    const a = (
        (target[0].x * (source[1].y - source[2].y))
        + (target[1].x * (source[2].y - source[0].y))
        + (target[2].x * (source[0].y - source[1].y))
    ) / denominator;
    const b = (
        (target[0].y * (source[1].y - source[2].y))
        + (target[1].y * (source[2].y - source[0].y))
        + (target[2].y * (source[0].y - source[1].y))
    ) / denominator;
    const c = (
        (target[0].x * (source[2].x - source[1].x))
        + (target[1].x * (source[0].x - source[2].x))
        + (target[2].x * (source[1].x - source[0].x))
    ) / denominator;
    const d = (
        (target[0].y * (source[2].x - source[1].x))
        + (target[1].y * (source[0].x - source[2].x))
        + (target[2].y * (source[1].x - source[0].x))
    ) / denominator;
    const e = (
        (target[0].x * ((source[1].x * source[2].y) - (source[2].x * source[1].y)))
        + (target[1].x * ((source[2].x * source[0].y) - (source[0].x * source[2].y)))
        + (target[2].x * ((source[0].x * source[1].y) - (source[1].x * source[0].y)))
    ) / denominator;
    const f = (
        (target[0].y * ((source[1].x * source[2].y) - (source[2].x * source[1].y)))
        + (target[1].y * ((source[2].x * source[0].y) - (source[0].x * source[2].y)))
        + (target[2].y * ((source[0].x * source[1].y) - (source[1].x * source[0].y)))
    ) / denominator;
    return { a, b, c, d, e, f };
}

export function drawWarpedPlacement(ctx, image, input, placement, toCanvasPoint, { alpha = 1 } = {}) {
    const warp = normalizeWarpData(placement?.warp);
    if (!warp) {
        const topLeft = toCanvasPoint(localPointToWorld(0, 0, placement));
        const topRight = toCanvasPoint(localPointToWorld(Math.max(1, toNumber(input?.width, 1)), 0, placement));
        const bottomLeft = toCanvasPoint(localPointToWorld(0, Math.max(1, toNumber(input?.height, 1)), placement));
        const affine = solveTriangleAffine(
            [{ x: 0, y: 0 }, { x: Math.max(1, toNumber(input?.width, 1)), y: 0 }, { x: 0, y: Math.max(1, toNumber(input?.height, 1)) }],
            [topLeft, topRight, bottomLeft]
        );
        if (!affine) return;
        ctx.save();
        ctx.globalAlpha = alpha;
        ctx.transform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
        ctx.drawImage(image, 0, 0, Math.max(1, toNumber(input?.width, 1)), Math.max(1, toNumber(input?.height, 1)));
        ctx.restore();
        return;
    }

    const mesh = getPlacementMeshPoints(input, placement);
    for (let row = 0; row < mesh.rows - 1; row += 1) {
        for (let col = 0; col < mesh.cols - 1; col += 1) {
            const topLeft = mesh.points[(row * mesh.cols) + col];
            const topRight = mesh.points[(row * mesh.cols) + col + 1];
            const bottomLeft = mesh.points[((row + 1) * mesh.cols) + col];
            const bottomRight = mesh.points[((row + 1) * mesh.cols) + col + 1];
            const triangles = [
                [
                    { x: topLeft.sourceX, y: topLeft.sourceY },
                    { x: topRight.sourceX, y: topRight.sourceY },
                    { x: bottomLeft.sourceX, y: bottomLeft.sourceY }
                ],
                [
                    { x: bottomLeft.sourceX, y: bottomLeft.sourceY },
                    { x: topRight.sourceX, y: topRight.sourceY },
                    { x: bottomRight.sourceX, y: bottomRight.sourceY }
                ]
            ];
            const destinations = [
                [
                    toCanvasPoint({ x: topLeft.worldX, y: topLeft.worldY }),
                    toCanvasPoint({ x: topRight.worldX, y: topRight.worldY }),
                    toCanvasPoint({ x: bottomLeft.worldX, y: bottomLeft.worldY })
                ],
                [
                    toCanvasPoint({ x: bottomLeft.worldX, y: bottomLeft.worldY }),
                    toCanvasPoint({ x: topRight.worldX, y: topRight.worldY }),
                    toCanvasPoint({ x: bottomRight.worldX, y: bottomRight.worldY })
                ]
            ];
            triangles.forEach((triangle, index) => {
                const destination = destinations[index];
                const affine = solveTriangleAffine(triangle, destination);
                if (!affine) return;
                ctx.save();
                ctx.globalAlpha = alpha;
                const cx = (destination[0].x + destination[1].x + destination[2].x) / 3;
                const cy = (destination[0].y + destination[1].y + destination[2].y) / 3;
                ctx.beginPath();
                for (let i = 0; i < 3; i += 1) {
                    const dx = destination[i].x - cx;
                    const dy = destination[i].y - cy;
                    const mag = Math.hypot(dx, dy) || 1;
                    ctx[i === 0 ? 'moveTo' : 'lineTo'](destination[i].x + (dx / mag * 0.5), destination[i].y + (dy / mag * 0.5));
                }
                ctx.closePath();
                ctx.clip();
                ctx.transform(affine.a, affine.b, affine.c, affine.d, affine.e, affine.f);
                ctx.drawImage(image, 0, 0, Math.max(1, toNumber(input?.width, 1)), Math.max(1, toNumber(input?.height, 1)));
                ctx.restore();
            });
        }
    }
}
