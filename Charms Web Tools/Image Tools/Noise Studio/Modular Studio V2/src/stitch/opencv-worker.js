const PHOTO_BACKEND = 'opencv-wasm'
const INPUT_GAP = 48
const MIN_PAIR_INLIERS = 12
const MIN_PAIR_INLIER_RATIO = 0.18
const MIN_PAIR_OVERLAP_RATIO = 0.08
const MAX_PAIR_REPROJECTION_MULTIPLIER = 2.8
const MAX_FLOW_POINTS = 1200
const MIN_FLOW_SUPPORT = 12
const MAX_FLOW_ERROR = 24
const BOOT_TIMEOUT_MS = 20000
const MESH_SUPPORT_PAD = 0.08
const MESH_LOCALITY_FALLOFF = 0.32
const MESH_EDGE_PIN_DISTANCE = 0.18
const MIN_DENSE_FEATURE_QUALITY = 0.008
const MIN_DENSE_POINT_SPACING = 6
const MIN_SUPPORT_DETAIL_STRENGTH = 0.08
const MAX_LOCAL_WARP_FRACTION = 0.015
const MAX_LOCAL_WARP_PIXELS = 28

let cvReady = false
let cvInitError = null
let readyPosted = false
let candidateCounter = 0
let bootTimeoutHandle = 0

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value))
}

function round(value, decimals = 4) {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) return 0
    const factor = 10 ** decimals
    return Math.round(numeric * factor) / factor
}

function computeMedian(values = []) {
    if (!Array.isArray(values) || !values.length) return 0
    const sorted = values
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right)
    if (!sorted.length) return 0
    const middle = Math.floor(sorted.length * 0.5)
    if (sorted.length % 2 === 1) return sorted[middle]
    return (sorted[middle - 1] + sorted[middle]) * 0.5
}

function computeMad(values = [], median = computeMedian(values)) {
    if (!Array.isArray(values) || !values.length) return 0
    return computeMedian(values.map((value) => Math.abs((Number(value) || 0) - median)))
}

function derivePreparedCorrectionLimit(improvements, settings) {
    const median = computeMedian(improvements)
    const mad = computeMad(improvements, median)
    return clamp(
        (median * 2.4) + (mad * 4.5) + 1.25,
        Math.max(2, (Number(settings.inlierThreshold) || 4.5) * 0.8),
        Math.max(10, (Number(settings.inlierThreshold) || 4.5) * 3.2)
    )
}

function deriveWorldWarpBudget(record, magnitudes = []) {
    const maxDimension = Math.max(record?.originalWidth || 1, record?.originalHeight || 1)
    const median = computeMedian(magnitudes)
    const mad = computeMad(magnitudes, median)
    return clamp(
        (median * 2.2) + (mad * 3.4) + 0.75,
        3,
        Math.min(MAX_LOCAL_WARP_PIXELS, Math.max(8, maxDimension * MAX_LOCAL_WARP_FRACTION))
    )
}

function createCandidateId() {
    candidateCounter += 1
    return `stitch-candidate-${Date.now().toString(36)}-${candidateCounter.toString(36)}`
}

function logDebug(message, extra = null) {
    if (extra == null) console.info(`[Stitch/OpenCV] ${message}`)
    else console.info(`[Stitch/OpenCV] ${message}`, extra)
}

function logError(message, extra = null) {
    if (extra == null) console.error(`[Stitch/OpenCV] ${message}`)
    else console.error(`[Stitch/OpenCV] ${message}`, extra)
}

function emitProgress(requestId, label, detail = '', extras = {}) {
    const progress = {
        label,
        detail,
        ...extras
    }
    logDebug(detail ? `${label} ${detail}` : label)
    self.postMessage({ type: 'progress', requestId, progress })
}

function createIdentityHomography() {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1]
}

function multiplyHomographies(a, b) {
    return [
        (a[0] * b[0]) + (a[1] * b[3]) + (a[2] * b[6]),
        (a[0] * b[1]) + (a[1] * b[4]) + (a[2] * b[7]),
        (a[0] * b[2]) + (a[1] * b[5]) + (a[2] * b[8]),
        (a[3] * b[0]) + (a[4] * b[3]) + (a[5] * b[6]),
        (a[3] * b[1]) + (a[4] * b[4]) + (a[5] * b[7]),
        (a[3] * b[2]) + (a[4] * b[5]) + (a[5] * b[8]),
        (a[6] * b[0]) + (a[7] * b[3]) + (a[8] * b[6]),
        (a[6] * b[1]) + (a[7] * b[4]) + (a[8] * b[7]),
        (a[6] * b[2]) + (a[7] * b[5]) + (a[8] * b[8])
    ]
}

function invertHomography(matrix) {
    const determinant = (
        (matrix[0] * ((matrix[4] * matrix[8]) - (matrix[5] * matrix[7])))
        - (matrix[1] * ((matrix[3] * matrix[8]) - (matrix[5] * matrix[6])))
        + (matrix[2] * ((matrix[3] * matrix[7]) - (matrix[4] * matrix[6])))
    )
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-9) return null
    const inverseDeterminant = 1 / determinant
    return [
        (((matrix[4] * matrix[8]) - (matrix[5] * matrix[7])) * inverseDeterminant),
        (((matrix[2] * matrix[7]) - (matrix[1] * matrix[8])) * inverseDeterminant),
        (((matrix[1] * matrix[5]) - (matrix[2] * matrix[4])) * inverseDeterminant),
        (((matrix[5] * matrix[6]) - (matrix[3] * matrix[8])) * inverseDeterminant),
        (((matrix[0] * matrix[8]) - (matrix[2] * matrix[6])) * inverseDeterminant),
        (((matrix[2] * matrix[3]) - (matrix[0] * matrix[5])) * inverseDeterminant),
        (((matrix[3] * matrix[7]) - (matrix[4] * matrix[6])) * inverseDeterminant),
        (((matrix[1] * matrix[6]) - (matrix[0] * matrix[7])) * inverseDeterminant),
        (((matrix[0] * matrix[4]) - (matrix[1] * matrix[3])) * inverseDeterminant)
    ]
}

function applyHomography(matrix, x, y) {
    const denominator = (matrix[6] * x) + (matrix[7] * y) + matrix[8]
    if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return null
    const projectedX = ((matrix[0] * x) + (matrix[1] * y) + matrix[2]) / denominator
    const projectedY = ((matrix[3] * x) + (matrix[4] * y) + matrix[5]) / denominator
    if (!Number.isFinite(projectedX) || !Number.isFinite(projectedY)) return null
    return { x: projectedX, y: projectedY }
}

function createScaleHomography(scaleX, scaleY) {
    return [scaleX, 0, 0, 0, scaleY, 0, 0, 0, 1]
}

function convertPreparedHomographyToOriginal(preparedHomography, sourceRecord, targetRecord) {
    const sourceScale = createScaleHomography(sourceRecord.scaleX, sourceRecord.scaleY)
    const targetInverseScale = createScaleHomography(
        1 / Math.max(0.0001, targetRecord.scaleX),
        1 / Math.max(0.0001, targetRecord.scaleY)
    )
    return multiplyHomographies(targetInverseScale, multiplyHomographies(preparedHomography, sourceScale))
}

function getMeshGridDimensions(type = 'mesh', density = 'medium') {
    if (type === 'perspective') return { cols: 8, rows: 8 }
    if (density === 'low') return { cols: 8, rows: 8 }
    if (density === 'high') return { cols: 16, rows: 16 }
    return { cols: 12, rows: 12 }
}

function rotatePoint(x, y, radians) {
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    return {
        x: (x * cos) - (y * sin),
        y: (x * sin) + (y * cos)
    }
}

function localPointToWorld(localX, localY, placement) {
    const scale = Math.max(0.01, Number(placement?.scale) || 1)
    const rotation = Number(placement?.rotation) || 0
    const rotated = rotatePoint(localX * scale, localY * scale, rotation)
    return {
        x: rotated.x + (Number(placement?.x) || 0),
        y: rotated.y + (Number(placement?.y) || 0)
    }
}

function worldVectorToLocalDelta(dx, dy, placement) {
    const unrotated = rotatePoint(dx, dy, -(Number(placement?.rotation) || 0))
    const scale = Math.max(0.01, Number(placement?.scale) || 1)
    return {
        x: unrotated.x / scale,
        y: unrotated.y / scale
    }
}

function fitSimilarity(sourcePoints, targetPoints) {
    if (!sourcePoints.length || sourcePoints.length !== targetPoints.length) {
        return { x: 0, y: 0, scale: 1, rotation: 0 }
    }

    const sourceCentroid = sourcePoints.reduce((sum, point) => ({
        x: sum.x + point.x,
        y: sum.y + point.y
    }), { x: 0, y: 0 })
    sourceCentroid.x /= sourcePoints.length
    sourceCentroid.y /= sourcePoints.length

    const targetCentroid = targetPoints.reduce((sum, point) => ({
        x: sum.x + point.x,
        y: sum.y + point.y
    }), { x: 0, y: 0 })
    targetCentroid.x /= targetPoints.length
    targetCentroid.y /= targetPoints.length

    let numeratorA = 0
    let numeratorB = 0
    let denominator = 0

    for (let index = 0; index < sourcePoints.length; index += 1) {
        const source = sourcePoints[index]
        const target = targetPoints[index]
        const centeredSourceX = source.x - sourceCentroid.x
        const centeredSourceY = source.y - sourceCentroid.y
        const centeredTargetX = target.x - targetCentroid.x
        const centeredTargetY = target.y - targetCentroid.y
        numeratorA += (centeredSourceX * centeredTargetX) + (centeredSourceY * centeredTargetY)
        numeratorB += (centeredSourceX * centeredTargetY) - (centeredSourceY * centeredTargetX)
        denominator += (centeredSourceX * centeredSourceX) + (centeredSourceY * centeredSourceY)
    }

    if (denominator < 1e-6) {
        return {
            x: round(targetCentroid.x, 3),
            y: round(targetCentroid.y, 3),
            scale: 1,
            rotation: 0
        }
    }

    const a = numeratorA / denominator
    const b = numeratorB / denominator
    const rotation = Math.atan2(b, a)
    const scale = Math.max(0.01, Math.hypot(a, b))
    const transformedCentroid = rotatePoint(sourceCentroid.x * scale, sourceCentroid.y * scale, rotation)

    return {
        x: round(targetCentroid.x - transformedCentroid.x, 3),
        y: round(targetCentroid.y - transformedCentroid.y, 3),
        scale: round(scale, 5),
        rotation: round(rotation, 6)
    }
}

function createManualLayoutCandidate(imageRecords, reason = '') {
    let cursorX = 0
    const placements = imageRecords.map((record, index) => {
        const placement = {
            inputId: record.id,
            x: round(cursorX, 3),
            y: 0,
            scale: 1,
            rotation: 0,
            visible: true,
            locked: false,
            z: index,
            opacity: 1
        }
        cursorX += record.originalWidth + INPUT_GAP
        return placement
    })
    return {
        id: createCandidateId(),
        name: imageRecords.length > 1 ? 'Manual Layout' : 'Single Image',
        source: 'manual',
        modelType: 'manual',
        blendMode: 'alpha',
        score: imageRecords.length ? 0.05 : 0,
        confidence: imageRecords.length ? 0.08 : 0,
        rank: 1,
        coverage: imageRecords.length ? 1 : 0,
        placements,
        diagnostics: [],
        warning: reason || ''
    }
}

function buildGrayMat(preparedInput) {
    const mat = new cv.Mat(preparedInput.height, preparedInput.width, cv.CV_8UC1)
    mat.data.set(preparedInput.gray)
    return mat
}

function computeGradientStrengthMap(gray, width, height) {
    const gradient = new Float32Array(width * height)
    let maxValue = 1
    for (let y = 0; y < height; y += 1) {
        const rowOffset = y * width
        const prevRowOffset = Math.max(0, y - 1) * width
        const nextRowOffset = Math.min(height - 1, y + 1) * width
        for (let x = 0; x < width; x += 1) {
            const index = rowOffset + x
            const left = gray[rowOffset + Math.max(0, x - 1)] || 0
            const right = gray[rowOffset + Math.min(width - 1, x + 1)] || 0
            const up = gray[prevRowOffset + x] || 0
            const down = gray[nextRowOffset + x] || 0
            const value = Math.abs(right - left) + Math.abs(down - up)
            gradient[index] = value
            if (value > maxValue) maxValue = value
        }
    }
    const inverseMax = 1 / Math.max(1, maxValue)
    for (let index = 0; index < gradient.length; index += 1) {
        gradient[index] = clamp(gradient[index] * inverseMax, 0, 1)
    }
    return gradient
}

function sampleGradientStrength(record, x, y) {
    const gradient = record?.gradient
    if (!gradient?.length) return 0.5
    const ix = clamp(Math.round(x), 0, Math.max(0, record.width - 1))
    const iy = clamp(Math.round(y), 0, Math.max(0, record.height - 1))
    return clamp(gradient[(iy * record.width) + ix] || 0, 0, 1)
}

function extractKeypoints(vector) {
    const result = []
    const size = vector.size()
    for (let index = 0; index < size; index += 1) {
        const keypoint = vector.get(index)
        result.push({
            x: Number(keypoint.pt?.x || 0),
            y: Number(keypoint.pt?.y || 0),
            response: Number(keypoint.response || 0)
        })
        if (typeof keypoint.delete === 'function') keypoint.delete()
    }
    return result
}

function createImageRecords(document, preparedInputs, settings) {
    const inputById = new Map((Array.isArray(document?.inputs) ? document.inputs : []).map((input, index) => [input.id || `input-${index + 1}`, input]))
    const records = []
    const orb = new cv.ORB()
    orb.setMaxFeatures(Math.max(200, Number(settings.maxFeatures) || 4000))

    try {
        preparedInputs.forEach((preparedInput, index) => {
            const input = inputById.get(preparedInput.id) || document?.inputs?.[index] || {}
            const mat = buildGrayMat(preparedInput)
            const emptyMask = new cv.Mat()
            const keypointVector = new cv.KeyPointVector()
            const descriptors = new cv.Mat()
            orb.detectAndCompute(mat, emptyMask, keypointVector, descriptors)
            emptyMask.delete()

            const originalWidth = Math.max(1, Number(input.width || preparedInput.originalWidth || preparedInput.width || 1))
            const originalHeight = Math.max(1, Number(input.height || preparedInput.originalHeight || preparedInput.height || 1))
            const keypoints = extractKeypoints(keypointVector)
            keypointVector.delete()

            records.push({
                id: preparedInput.id,
                name: preparedInput.name || input.name || `Input ${index + 1}`,
                index,
                width: preparedInput.width,
                height: preparedInput.height,
                originalWidth,
                originalHeight,
                scaleX: preparedInput.width / Math.max(1, originalWidth),
                scaleY: preparedInput.height / Math.max(1, originalHeight),
                gray: preparedInput.gray,
                gradient: computeGradientStrengthMap(preparedInput.gray, preparedInput.width, preparedInput.height),
                mat,
                descriptors,
                keypoints
            })
        })
    } finally {
        orb.delete()
    }

    return records
}

function destroyImageRecords(imageRecords) {
    imageRecords.forEach((record) => {
        if (record?.mat?.delete) record.mat.delete()
        if (record?.descriptors?.delete) record.descriptors.delete()
    })
}

function collectRatioMatches(knnMatches, ratio) {
    const kept = []
    const rawMatches = knnMatches.size()

    for (let queryIndex = 0; queryIndex < rawMatches; queryIndex += 1) {
        const inner = knnMatches.get(queryIndex)
        const innerSize = inner.size()
        if (innerSize >= 2) {
            const best = inner.get(0)
            const second = inner.get(1)
            if (best.distance <= (second.distance * ratio)) {
                kept.push({
                    queryIdx: best.queryIdx,
                    trainIdx: best.trainIdx,
                    distance: best.distance
                })
            }
            if (typeof best.delete === 'function') best.delete()
            if (typeof second.delete === 'function') second.delete()
            for (let extraIndex = 2; extraIndex < innerSize; extraIndex += 1) {
                const extra = inner.get(extraIndex)
                if (typeof extra.delete === 'function') extra.delete()
            }
        } else {
            for (let matchIndex = 0; matchIndex < innerSize; matchIndex += 1) {
                const match = inner.get(matchIndex)
                if (typeof match.delete === 'function') match.delete()
            }
        }
        inner.delete()
    }

    return { rawMatches, kept }
}

function buildMutualMatches(sourceRecord, targetRecord, matcher, settings) {
    const sourceMatches = new cv.DMatchVectorVector()
    const targetMatches = new cv.DMatchVectorVector()

    try {
        matcher.knnMatch(sourceRecord.descriptors, targetRecord.descriptors, sourceMatches, 2)
        matcher.knnMatch(targetRecord.descriptors, sourceRecord.descriptors, targetMatches, 2)
        const forward = collectRatioMatches(sourceMatches, Number(settings.matchRatio) || 0.75)
        const reverse = collectRatioMatches(targetMatches, Number(settings.matchRatio) || 0.75)
        const reverseLookup = new Map(reverse.kept.map((match) => [match.queryIdx, match.trainIdx]))
        const mutual = forward.kept.filter((match) => reverseLookup.get(match.trainIdx) === match.queryIdx)
        return {
            rawMatches: forward.rawMatches,
            filteredMatches: mutual.length,
            matches: mutual
        }
    } finally {
        sourceMatches.delete()
        targetMatches.delete()
    }
}

function createPointMat(points, field) {
    const flat = []
    points.forEach((point) => {
        flat.push(point[field].x, point[field].y)
    })
    return cv.matFromArray(points.length, 1, cv.CV_32FC2, flat)
}

function extractPointsFromMat(pointMat) {
    const data = pointMat?.data32F || []
    const points = []
    for (let index = 0; index < data.length; index += 2) {
        points.push({
            x: Number(data[index] || 0),
            y: Number(data[index + 1] || 0)
        })
    }
    return points
}

function matToHomographyArray(matrix) {
    const data = matrix.data64F || matrix.data32F || matrix.data
    return Array.from(data.slice(0, 9), (value) => Number(value))
}

function fitPerspectiveFromCorners(sourceCorners, targetCorners) {
    if (!Array.isArray(sourceCorners) || !Array.isArray(targetCorners) || sourceCorners.length !== 4 || targetCorners.length !== 4) {
        return null
    }
    const sourceFlat = []
    const targetFlat = []
    sourceCorners.forEach((point) => {
        sourceFlat.push(point.x, point.y)
    })
    targetCorners.forEach((point) => {
        targetFlat.push(point.x, point.y)
    })
    const sourceMat = cv.matFromArray(4, 1, cv.CV_32FC2, sourceFlat)
    const targetMat = cv.matFromArray(4, 1, cv.CV_32FC2, targetFlat)
    let homography = null
    try {
        homography = cv.getPerspectiveTransform(sourceMat, targetMat)
        if (!homography || homography.empty()) return null
        const result = matToHomographyArray(homography)
        return invertHomography(result) ? result : null
    } finally {
        sourceMat.delete()
        targetMat.delete()
        if (homography?.delete) homography.delete()
    }
}

function polygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0
    let total = 0
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index]
        const next = points[(index + 1) % points.length]
        total += (current.x * next.y) - (next.x * current.y)
    }
    return Math.abs(total) * 0.5
}

function clipAgainstVertical(points, boundaryX, keepGreater) {
    const output = []
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index]
        const previous = points[(index + points.length - 1) % points.length]
        const currentInside = keepGreater ? current.x >= boundaryX : current.x <= boundaryX
        const previousInside = keepGreater ? previous.x >= boundaryX : previous.x <= boundaryX

        if (currentInside !== previousInside) {
            const deltaX = current.x - previous.x
            const t = Math.abs(deltaX) < 1e-9 ? 0 : ((boundaryX - previous.x) / deltaX)
            output.push({
                x: boundaryX,
                y: previous.y + ((current.y - previous.y) * t)
            })
        }
        if (currentInside) output.push(current)
    }
    return output
}

function clipAgainstHorizontal(points, boundaryY, keepGreater) {
    const output = []
    for (let index = 0; index < points.length; index += 1) {
        const current = points[index]
        const previous = points[(index + points.length - 1) % points.length]
        const currentInside = keepGreater ? current.y >= boundaryY : current.y <= boundaryY
        const previousInside = keepGreater ? previous.y >= boundaryY : previous.y <= boundaryY

        if (currentInside !== previousInside) {
            const deltaY = current.y - previous.y
            const t = Math.abs(deltaY) < 1e-9 ? 0 : ((boundaryY - previous.y) / deltaY)
            output.push({
                x: previous.x + ((current.x - previous.x) * t),
                y: boundaryY
            })
        }
        if (currentInside) output.push(current)
    }
    return output
}

function clipPolygonToRect(points, rect) {
    let clipped = points
    clipped = clipAgainstVertical(clipped, rect.minX, true)
    if (!clipped.length) return clipped
    clipped = clipAgainstVertical(clipped, rect.maxX, false)
    if (!clipped.length) return clipped
    clipped = clipAgainstHorizontal(clipped, rect.minY, true)
    if (!clipped.length) return clipped
    return clipAgainstHorizontal(clipped, rect.maxY, false)
}

function computeProjectedOverlapRatio(sourceRecord, targetRecord, homographyPrepared) {
    const projectedCorners = [
        applyHomography(homographyPrepared, 0, 0),
        applyHomography(homographyPrepared, sourceRecord.width, 0),
        applyHomography(homographyPrepared, sourceRecord.width, sourceRecord.height),
        applyHomography(homographyPrepared, 0, sourceRecord.height)
    ]
    if (projectedCorners.some((point) => !point)) {
        return {
            overlapRatio: 0,
            projectedArea: 0,
            intersectionArea: 0
        }
    }

    const clipped = clipPolygonToRect(projectedCorners, {
        minX: 0,
        minY: 0,
        maxX: targetRecord.width,
        maxY: targetRecord.height
    })
    const projectedArea = polygonArea(projectedCorners)
    const intersectionArea = polygonArea(clipped)
    const sourceArea = sourceRecord.width * sourceRecord.height
    const targetArea = targetRecord.width * targetRecord.height
    const denominator = Math.max(1, Math.min(sourceArea, targetArea, projectedArea || sourceArea))
    return {
        overlapRatio: clamp(intersectionArea / denominator, 0, 1),
        projectedArea,
        intersectionArea
    }
}

function computeMeanReprojectionError(homographyPrepared, inlierPairs) {
    if (!inlierPairs.length) return Number.POSITIVE_INFINITY
    const total = inlierPairs.reduce((sum, pair) => {
        const projected = applyHomography(homographyPrepared, pair.source.x, pair.source.y)
        if (!projected) return sum + 1e6
        return sum + Math.hypot(projected.x - pair.target.x, projected.y - pair.target.y)
    }, 0)
    return total / inlierPairs.length
}

function findHomographyWithMask(sourceMat, targetMat, settings) {
    const mask = new cv.Mat()
    let homography = null
    try {
        homography = cv.findHomography(
            sourceMat,
            targetMat,
            cv.RANSAC,
            Number(settings.inlierThreshold) || 4.5,
            mask,
            Math.max(200, Number(settings.ransacIterations) || 5000),
            0.995
        )
    } catch (_error) {
        homography = cv.findHomography(
            sourceMat,
            targetMat,
            cv.RANSAC,
            Number(settings.inlierThreshold) || 4.5,
            mask
        )
    }
    return { homography, mask }
}

function solvePairEdge(sourceRecord, targetRecord, matcher, settings) {
    const baseDiagnostics = {
        pair: `${sourceRecord.id} -> ${targetRecord.id}`,
        method: 'opencv-homography',
        sourceKeypoints: sourceRecord.keypoints.length,
        targetKeypoints: targetRecord.keypoints.length
    }

    if ((sourceRecord.descriptors.rows || 0) < 4 || (targetRecord.descriptors.rows || 0) < 4) {
        return {
            accepted: false,
            diagnostics: {
                ...baseDiagnostics,
                rawMatches: 0,
                filteredMatches: 0,
                inliers: 0,
                coverage: 0,
                overlapRatio: 0,
                reprojectionError: 0,
                accepted: false,
                reason: 'Not enough ORB descriptors were detected.'
            }
        }
    }

    const matchResult = buildMutualMatches(sourceRecord, targetRecord, matcher, settings)
    if (matchResult.matches.length < 4) {
        return {
            accepted: false,
            diagnostics: {
                ...baseDiagnostics,
                rawMatches: matchResult.rawMatches,
                filteredMatches: matchResult.filteredMatches,
                inliers: 0,
                coverage: 0,
                overlapRatio: 0,
                reprojectionError: 0,
                accepted: false,
                reason: 'Too few filtered matches remained after ratio and mutual checks.'
            }
        }
    }

    const candidatePairs = matchResult.matches.map((match) => ({
        source: sourceRecord.keypoints[match.queryIdx],
        target: targetRecord.keypoints[match.trainIdx],
        distance: match.distance
    })).filter((pair) => pair.source && pair.target)

    if (candidatePairs.length < 4) {
        return {
            accepted: false,
            diagnostics: {
                ...baseDiagnostics,
                rawMatches: matchResult.rawMatches,
                filteredMatches: matchResult.filteredMatches,
                inliers: 0,
                coverage: 0,
                overlapRatio: 0,
                reprojectionError: 0,
                accepted: false,
                reason: 'Too few valid point pairs were available after keypoint lookup.'
            }
        }
    }

    const sourceMat = createPointMat(candidatePairs, 'source')
    const targetMat = createPointMat(candidatePairs, 'target')
    const { homography, mask } = findHomographyWithMask(sourceMat, targetMat, settings)
    sourceMat.delete()
    targetMat.delete()

    if (!homography || homography.empty() || homography.rows < 3 || homography.cols < 3) {
        if (homography?.delete) homography.delete()
        mask.delete()
        return {
            accepted: false,
            diagnostics: {
                ...baseDiagnostics,
                rawMatches: matchResult.rawMatches,
                filteredMatches: matchResult.filteredMatches,
                inliers: 0,
                coverage: 0,
                overlapRatio: 0,
                reprojectionError: 0,
                accepted: false,
                reason: 'RANSAC could not fit a stable homography.'
            }
        }
    }

    const homographyPrepared = matToHomographyArray(homography)
    homography.delete()
    const inversePrepared = invertHomography(homographyPrepared)

    if (!inversePrepared) {
        mask.delete()
        return {
            accepted: false,
            diagnostics: {
                ...baseDiagnostics,
                rawMatches: matchResult.rawMatches,
                filteredMatches: matchResult.filteredMatches,
                inliers: 0,
                coverage: 0,
                overlapRatio: 0,
                reprojectionError: 0,
                accepted: false,
                reason: 'The fitted homography was not invertible.'
            }
        }
    }

    const maskData = mask.data || []
    const inlierPairs = candidatePairs.filter((_pair, index) => maskData[index])
    mask.delete()

    const inlierRatio = inlierPairs.length / Math.max(1, candidatePairs.length)
    const overlap = computeProjectedOverlapRatio(sourceRecord, targetRecord, homographyPrepared)
    const reprojectionError = computeMeanReprojectionError(homographyPrepared, inlierPairs)
    const maxAllowedError = Math.max(6, (Number(settings.inlierThreshold) || 4.5) * MAX_PAIR_REPROJECTION_MULTIPLIER)

    let reason = ''
    if (inlierPairs.length < MIN_PAIR_INLIERS) {
        reason = 'Too few inliers survived RANSAC.'
    } else if (inlierRatio < MIN_PAIR_INLIER_RATIO) {
        reason = 'The inlier ratio was too weak for a reliable edge.'
    } else if (overlap.overlapRatio < MIN_PAIR_OVERLAP_RATIO) {
        reason = 'The projected overlap area was too small.'
    } else if (!Number.isFinite(reprojectionError) || reprojectionError > maxAllowedError) {
        reason = 'The mean reprojection error was too large.'
    }

    const homographyOriginal = convertPreparedHomographyToOriginal(homographyPrepared, sourceRecord, targetRecord)
    const inverseOriginal = invertHomography(homographyOriginal)

    if (!reason && !inverseOriginal) {
        reason = 'The original-resolution homography was not invertible.'
    }

    const diagnostics = {
        ...baseDiagnostics,
        rawMatches: matchResult.rawMatches,
        filteredMatches: matchResult.filteredMatches,
        inliers: inlierPairs.length,
        coverage: round(inlierRatio, 4),
        overlapRatio: round(overlap.overlapRatio, 4),
        reprojectionError: round(reprojectionError, 4),
        accepted: !reason,
        reason: reason || 'Accepted'
    }

    if (reason) {
        return {
            accepted: false,
            diagnostics
        }
    }

    const score = (
        (inlierPairs.length * 3.25)
        + (inlierRatio * 90)
        + (overlap.overlapRatio * 84)
        - (reprojectionError * 8.5)
    )

    return {
        accepted: true,
        edge: {
            id: `${sourceRecord.id}::${targetRecord.id}`,
            sourceId: sourceRecord.id,
            targetId: targetRecord.id,
            score,
            inliers: inlierPairs.length,
            inlierRatio,
            overlapRatio: overlap.overlapRatio,
            reprojectionError,
            homographyPrepared,
            inversePrepared,
            homographyOriginal,
            inverseOriginal,
            inlierPairs: inlierPairs.map((pair) => ({
                source: { x: pair.source.x, y: pair.source.y },
                target: { x: pair.target.x, y: pair.target.y }
            }))
        },
        diagnostics: {
            ...diagnostics,
            score: round(score, 4)
        }
    }
}

function buildPairEdges(imageRecords, settings, requestId = '') {
    const matcher = new cv.BFMatcher(cv.NORM_HAMMING, false)
    const diagnostics = []
    const acceptedEdges = []
    const totalPairs = (imageRecords.length * (imageRecords.length - 1)) / 2
    let pairIndex = 0

    try {
        for (let sourceIndex = 0; sourceIndex < imageRecords.length; sourceIndex += 1) {
            for (let targetIndex = sourceIndex + 1; targetIndex < imageRecords.length; targetIndex += 1) {
                const sourceRecord = imageRecords[sourceIndex]
                const targetRecord = imageRecords[targetIndex]
                pairIndex += 1
                emitProgress(
                    requestId,
                    'Matching photo pairs...',
                    `${sourceRecord.name} vs ${targetRecord.name}`,
                    { phase: 'pairs', completed: pairIndex - 1, total: totalPairs }
                )
                const result = solvePairEdge(sourceRecord, targetRecord, matcher, settings)
                diagnostics.push(result.diagnostics)
                if (result.accepted && result.edge) acceptedEdges.push(result.edge)
                emitProgress(
                    requestId,
                    'Matched photo pairs',
                    `${pairIndex}/${totalPairs} complete`,
                    { phase: 'pairs', completed: pairIndex, total: totalPairs }
                )
            }
        }
    } finally {
        matcher.delete()
    }

    return { acceptedEdges, diagnostics }
}

function buildAdjacency(imageRecords, acceptedEdges) {
    const adjacency = new Map(imageRecords.map((record) => [record.id, []]))
    acceptedEdges.forEach((edge) => {
        adjacency.get(edge.sourceId)?.push({
            toId: edge.targetId,
            pairId: edge.id,
            score: edge.score,
            inliers: edge.inliers,
            overlapRatio: edge.overlapRatio,
            homographyToCurrent: edge.inverseOriginal
        })
        adjacency.get(edge.targetId)?.push({
            toId: edge.sourceId,
            pairId: edge.id,
            score: edge.score,
            inliers: edge.inliers,
            overlapRatio: edge.overlapRatio,
            homographyToCurrent: edge.homographyOriginal
        })
    })
    return adjacency
}

function solveAnchorGraph(anchorId, adjacency) {
    const states = new Map()
    states.set(anchorId, {
        inputId: anchorId,
        homographyToAnchor: createIdentityHomography(),
        scoreSum: 0,
        scoreFloor: 0,
        priority: 0,
        depth: 0,
        parentEdgeId: null,
        visited: new Set([anchorId])
    })

    const queue = [anchorId]
    const maxDepth = Math.max(0, adjacency.size - 1)
    const maxExpansions = Math.max(32, adjacency.size * adjacency.size * 8)
    let expansions = 0
    while (queue.length) {
        expansions += 1
        if (expansions > maxExpansions) break
        queue.sort((leftId, rightId) => (states.get(rightId)?.priority || 0) - (states.get(leftId)?.priority || 0))
        const currentId = queue.shift()
        const current = states.get(currentId)
        if (!current) continue
        if (current.depth >= maxDepth) continue
        const edges = adjacency.get(currentId) || []
        edges.forEach((edge) => {
            if (current.visited?.has(edge.toId)) return
            const composed = multiplyHomographies(current.homographyToAnchor, edge.homographyToCurrent)
            if (!invertHomography(composed)) return
            const scoreFloor = current.depth ? Math.min(current.scoreFloor, edge.score) : edge.score
            const scoreSum = current.scoreSum + edge.score
            const depth = current.depth + 1
            const priority = scoreSum + (scoreFloor * 0.35) + (edge.overlapRatio * 32) + (edge.inliers * 0.16) - (depth * 1.5)
            const existing = states.get(edge.toId)
            if (existing && existing.priority >= priority) return
            states.set(edge.toId, {
                inputId: edge.toId,
                homographyToAnchor: composed,
                scoreSum,
                scoreFloor,
                priority,
                depth,
                parentEdgeId: edge.pairId,
                visited: new Set([...(current.visited || []), edge.toId])
            })
            queue.push(edge.toId)
        })
    }

    return states
}

function computeHomographyBounds(record, homography) {
    const corners = [
        applyHomography(homography, 0, 0),
        applyHomography(homography, record.originalWidth, 0),
        applyHomography(homography, record.originalWidth, record.originalHeight),
        applyHomography(homography, 0, record.originalHeight)
    ].filter(Boolean)
    if (corners.length < 4) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0
        }
    }
    return {
        minX: Math.min(...corners.map((point) => point.x)),
        minY: Math.min(...corners.map((point) => point.y)),
        maxX: Math.max(...corners.map((point) => point.x)),
        maxY: Math.max(...corners.map((point) => point.y))
    }
}

function buildBalancedWorldHomography(anchorRecord, referenceState, referenceRecord) {
    if (!anchorRecord || !referenceState || !referenceRecord) return null
    const inverseReference = invertHomography(referenceState.homographyToAnchor)
    if (!inverseReference) return null

    const refCorners = [
        { x: 0, y: 0 },
        { x: referenceRecord.originalWidth, y: 0 },
        { x: referenceRecord.originalWidth, y: referenceRecord.originalHeight },
        { x: 0, y: referenceRecord.originalHeight }
    ]
    const projRefCorners = refCorners.map((pt) => applyHomography(referenceState.homographyToAnchor, pt.x, pt.y)).filter(Boolean)
    if (projRefCorners.length < 4) return null

    const minRefX = Math.min(...projRefCorners.map((pt) => pt.x))
    const maxRefX = Math.max(...projRefCorners.map((pt) => pt.x))
    const minRefY = Math.min(...projRefCorners.map((pt) => pt.y))
    const maxRefY = Math.max(...projRefCorners.map((pt) => pt.y))

    const overlapMinX = Math.max(0, minRefX)
    const overlapMaxX = Math.min(anchorRecord.originalWidth, maxRefX)
    const overlapMinY = Math.max(0, minRefY)
    const overlapMaxY = Math.min(anchorRecord.originalHeight, maxRefY)

    if (overlapMaxX <= overlapMinX || overlapMaxY <= overlapMinY) return null

    const centerX = (overlapMinX + overlapMaxX) * 0.5
    const centerY = (overlapMinY + overlapMaxY) * 0.5
    const basisSize = Math.max(100, Math.min(anchorRecord.originalWidth, anchorRecord.originalHeight) * 0.2)

    const anchorCorners = [
        { x: centerX - basisSize, y: centerY - basisSize },
        { x: centerX + basisSize, y: centerY - basisSize },
        { x: centerX + basisSize, y: centerY + basisSize },
        { x: centerX - basisSize, y: centerY + basisSize }
    ]

    const midpointCorners = anchorCorners.map((corner) => {
        const referenceCorner = applyHomography(inverseReference, corner.x, corner.y)
        if (!referenceCorner) return null
        return {
            x: (corner.x + referenceCorner.x) * 0.5,
            y: (corner.y + referenceCorner.y) * 0.5
        }
    })
    if (midpointCorners.some((corner) => !corner)) return null
    return fitPerspectiveFromCorners(anchorCorners, midpointCorners)
}

function createCandidateStates(anchorRecord, states, settings, recordsById) {
    if (settings.warpDistribution !== 'balanced' || states.size <= 1) return states
    const referenceState = [...states.values()]
        .filter((state) => state.inputId !== anchorRecord.id)
        .sort((left, right) => {
            if ((right.priority || 0) !== (left.priority || 0)) return (right.priority || 0) - (left.priority || 0)
            return (left.depth || 0) - (right.depth || 0)
        })[0]
    if (!referenceState) return states
    const referenceRecord = recordsById?.get(referenceState.inputId)
    const balanceHomography = buildBalancedWorldHomography(anchorRecord, referenceState, referenceRecord)
    if (!balanceHomography) return states

    const adjustedStates = new Map()
    for (const [inputId, state] of states.entries()) {
        const adjustedHomography = multiplyHomographies(balanceHomography, state.homographyToAnchor)
        if (!invertHomography(adjustedHomography)) return states
        adjustedStates.set(inputId, {
            ...state,
            homographyToAnchor: adjustedHomography
        })
    }
    return adjustedStates
}

function createGridTargetPoints(record, homography, type, density, residualGrid = null) {
    const { cols, rows } = residualGrid?.cols && residualGrid?.rows
        ? { cols: residualGrid.cols, rows: residualGrid.rows }
        : getMeshGridDimensions(type, density)
    const points = []
    for (let row = 0; row < rows; row += 1) {
        const v = rows > 1 ? row / (rows - 1) : 0
        for (let col = 0; col < cols; col += 1) {
            const u = cols > 1 ? col / (cols - 1) : 0
            const sourceX = u * record.originalWidth
            const sourceY = v * record.originalHeight
            const projected = applyHomography(homography, sourceX, sourceY) || { x: sourceX, y: sourceY }
            const residual = residualGrid?.nodes?.[points.length] || { x: 0, y: 0, weight: 0 }
            points.push({
                u,
                v,
                sourceX,
                sourceY,
                worldX: projected.x + (residual.x || 0),
                worldY: projected.y + (residual.y || 0),
                supportWeight: clamp(residual.weight || 0, 0, 1)
            })
        }
    }
    return { cols, rows, points }
}

function buildPlacementFromGrid(record, grid, type, density, allowWarp = true) {
    const sourcePoints = grid.points.map((point) => ({ x: point.sourceX, y: point.sourceY }))
    const targetPoints = grid.points.map((point) => ({ x: point.worldX, y: point.worldY }))
    const similarity = fitSimilarity(sourcePoints, targetPoints)
    const placement = {
        inputId: record.id,
        x: similarity.x,
        y: similarity.y,
        scale: similarity.scale,
        rotation: similarity.rotation,
        visible: true,
        locked: false,
        z: record.index,
        opacity: 1
    }

    if (!allowWarp) return placement

    const warpPoints = []
    let maxResidual = 0
    for (let index = 0; index < grid.points.length; index += 1) {
        const point = grid.points[index]
        const approximate = localPointToWorld(point.sourceX, point.sourceY, placement)
        const delta = worldVectorToLocalDelta(point.worldX - approximate.x, point.worldY - approximate.y, placement)
        const magnitude = Math.hypot(delta.x, delta.y)
        maxResidual = Math.max(maxResidual, magnitude)
        warpPoints.push({
            u: round(point.u, 4),
            v: round(point.v, 4),
            dx: round(delta.x, 4),
            dy: round(delta.y, 4),
            weight: round(type === 'mesh' ? point.supportWeight : Math.max(0.4, point.supportWeight || 0.65), 4)
        })
    }

    if (maxResidual < 0.12) return placement

    return {
        ...placement,
        warp: {
            type,
            density: density || 'medium',
            cols: grid.cols,
            rows: grid.rows,
            strength: 1,
            smoothness: type === 'mesh' ? 0.56 : 0.34,
            points: warpPoints
        }
    }
}

function createResidualAccumulator(record, density, dimensions = null, options = {}) {
    const { cols, rows } = dimensions || getMeshGridDimensions('mesh', density)
    return {
        record,
        cols,
        rows,
        maxResidual: Number.isFinite(Number(options.maxResidual)) ? Number(options.maxResidual) : null,
        support: {
            minU: 1,
            minV: 1,
            maxU: 0,
            maxV: 0,
            totalWeight: 0
        },
        nodes: Array.from({ length: cols * rows }, () => ({
            sumX: 0,
            sumY: 0,
            weight: 0
        }))
    }
}

function addResidualSample(accumulator, localPoint, residualX, residualY, weight = 1) {
    const u = clamp(localPoint.x / Math.max(1, accumulator.record.originalWidth), 0, 1)
    const v = clamp(localPoint.y / Math.max(1, accumulator.record.originalHeight), 0, 1)
    const sampleWeight = Math.max(0.0001, Number(weight) || 0.0001)
    accumulator.support.minU = Math.min(accumulator.support.minU, u)
    accumulator.support.minV = Math.min(accumulator.support.minV, v)
    accumulator.support.maxU = Math.max(accumulator.support.maxU, u)
    accumulator.support.maxV = Math.max(accumulator.support.maxV, v)
    accumulator.support.totalWeight += sampleWeight
    const scaledX = u * (accumulator.cols - 1)
    const scaledY = v * (accumulator.rows - 1)
    const minCol = Math.floor(scaledX)
    const minRow = Math.floor(scaledY)
    const maxCol = Math.min(accumulator.cols - 1, minCol + 1)
    const maxRow = Math.min(accumulator.rows - 1, minRow + 1)
    const tx = scaledX - minCol
    const ty = scaledY - minRow
    const targets = [
        { col: minCol, row: minRow, influence: (1 - tx) * (1 - ty) },
        { col: maxCol, row: minRow, influence: tx * (1 - ty) },
        { col: minCol, row: maxRow, influence: (1 - tx) * ty },
        { col: maxCol, row: maxRow, influence: tx * ty }
    ]

    targets.forEach((target) => {
        const node = accumulator.nodes[(target.row * accumulator.cols) + target.col]
        const totalWeight = target.influence * sampleWeight
        node.sumX += residualX * totalWeight
        node.sumY += residualY * totalWeight
        node.weight += totalWeight
    })
}

function distanceOutsideRange(value, min, max) {
    if (value < min) return min - value
    if (value > max) return value - max
    return 0
}

function getExpandedSupportBounds(accumulator) {
    if ((accumulator.support?.totalWeight || 0) <= 0) {
        return {
            minU: 0,
            minV: 0,
            maxU: 1,
            maxV: 1
        }
    }
    const padU = Math.max(MESH_SUPPORT_PAD, accumulator.cols > 1 ? (1 / (accumulator.cols - 1)) : MESH_SUPPORT_PAD)
    const padV = Math.max(MESH_SUPPORT_PAD, accumulator.rows > 1 ? (1 / (accumulator.rows - 1)) : MESH_SUPPORT_PAD)
    return {
        minU: clamp(accumulator.support.minU - padU, 0, 1),
        minV: clamp(accumulator.support.minV - padV, 0, 1),
        maxU: clamp(accumulator.support.maxU + padU, 0, 1),
        maxV: clamp(accumulator.support.maxV + padV, 0, 1)
    }
}

function computeSupportLocalityFactor(u, v, bounds) {
    const dx = distanceOutsideRange(u, bounds.minU, bounds.maxU)
    const dy = distanceOutsideRange(v, bounds.minV, bounds.maxV)
    const distance = Math.hypot(dx, dy)
    if (distance <= 1e-6) return 1
    return Math.pow(clamp(1 - (distance / MESH_LOCALITY_FALLOFF), 0, 1), 1.6)
}

function computeEdgePinFactor(u, v, supportStrength, localityFactor) {
    const borderDistance = Math.min(u, 1 - u, v, 1 - v)
    const borderRelax = Math.pow(clamp(borderDistance / MESH_EDGE_PIN_DISTANCE, 0, 1), 0.85)
    const borderFloor = Math.max(Math.sqrt(supportStrength), 0.18 + (borderRelax * 0.82))
    return clamp(Math.max(borderFloor, localityFactor * 0.36), 0, 1)
}

function finalizeResidualAccumulator(accumulator) {
    const defaultLimit = Math.min(
        MAX_LOCAL_WARP_PIXELS,
        Math.max(8, Math.max(accumulator.record.originalWidth, accumulator.record.originalHeight) * MAX_LOCAL_WARP_FRACTION)
    )
    const maxResidual = Math.max(2, Number(accumulator.maxResidual) || defaultLimit)
    const rawNodes = accumulator.nodes.map((node) => {
        if (!node.weight) return { x: 0, y: 0, weight: 0 }
        let x = node.sumX / node.weight
        let y = node.sumY / node.weight
        const magnitude = Math.hypot(x, y)
        if (magnitude > maxResidual) {
            const scale = maxResidual / magnitude
            x *= scale
            y *= scale
        }
        return { x, y, weight: node.weight }
    })

    if ((accumulator.support?.totalWeight || 0) <= 0) {
        return rawNodes.map(() => ({ x: 0, y: 0, weight: 0 }))
    }

    const maxWeight = Math.max(1e-6, ...rawNodes.map((node) => node.weight))
    const supportBounds = getExpandedSupportBounds(accumulator)
    const smoothedNodes = rawNodes.map((node, index) => {
        const row = Math.floor(index / accumulator.cols)
        const col = index % accumulator.cols
        let sumX = node.x * (node.weight ? 2 : 1)
        let sumY = node.y * (node.weight ? 2 : 1)
        let total = node.weight ? 2 : 1
        for (let y = Math.max(0, row - 1); y <= Math.min(accumulator.rows - 1, row + 1); y += 1) {
            for (let x = Math.max(0, col - 1); x <= Math.min(accumulator.cols - 1, col + 1); x += 1) {
                if (x === col && y === row) continue
                const neighbor = rawNodes[(y * accumulator.cols) + x]
                if (!neighbor.weight) continue
                sumX += neighbor.x * 0.35
                sumY += neighbor.y * 0.35
                total += 0.35
            }
        }
        return {
            x: sumX / total,
            y: sumY / total,
            weight: node.weight
        }
    })

    return smoothedNodes.map((node, index) => {
        const row = Math.floor(index / accumulator.cols)
        const col = index % accumulator.cols
        const u = accumulator.cols > 1 ? col / (accumulator.cols - 1) : 0
        const v = accumulator.rows > 1 ? row / (accumulator.rows - 1) : 0
        const supportStrength = clamp(node.weight / maxWeight, 0, 1)
        const localityFactor = computeSupportLocalityFactor(u, v, supportBounds)
        const spillFactor = Math.max(supportStrength, localityFactor * 0.82)
        const edgePinFactor = computeEdgePinFactor(u, v, supportStrength, localityFactor)
        const attenuation = clamp(Math.max(supportStrength, spillFactor * edgePinFactor), 0, 1)
        return {
            x: round(node.x * attenuation, 4),
            y: round(node.y * attenuation, 4),
            weight: round(Math.max(supportStrength, attenuation * 0.85), 4)
        }
    })
}

function createOverlapMask(sourceRecord, targetRecord, homographyPrepared) {
    const inversePrepared = invertHomography(homographyPrepared)
    if (!inversePrepared) return null
    const sourceCorners = [
        applyHomography(inversePrepared, 0, 0),
        applyHomography(inversePrepared, targetRecord.width, 0),
        applyHomography(inversePrepared, targetRecord.width, targetRecord.height),
        applyHomography(inversePrepared, 0, targetRecord.height)
    ]
    if (sourceCorners.some((point) => !point)) return null

    const mask = cv.Mat.zeros(sourceRecord.height, sourceRecord.width, cv.CV_8UC1)
    const polygon = cv.matFromArray(4, 1, cv.CV_32SC2, sourceCorners.flatMap((point) => ([
        Math.round(point.x),
        Math.round(point.y)
    ])))
    const color = new cv.Scalar(255, 255, 255, 255)
    try {
        cv.fillConvexPoly(mask, polygon, color, cv.LINE_AA, 0)
        return mask
    } finally {
        polygon.delete()
        if (typeof color.delete === 'function') color.delete()
    }
}

function addSeedPoint(points, buckets, point, spacing, maxPoints, width, height) {
    if (!point || points.length >= maxPoints) return
    const x = Number(point.x)
    const y = Number(point.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const bucketX = Math.round(x / Math.max(1, spacing))
    const bucketY = Math.round(y / Math.max(1, spacing))
    const key = `${bucketX}:${bucketY}`
    if (buckets.has(key)) return
    buckets.add(key)
    points.push({ x, y })
}

function buildDenseSupportSeeds(edge, sourceRecord, targetRecord, settings) {
    const maxSeedPoints = clamp(
        Math.round(Math.min(MAX_FLOW_POINTS, Math.max(180, (Number(settings.maxFeatures) || 4000) * 0.3))),
        MIN_FLOW_SUPPORT,
        MAX_FLOW_POINTS
    )
    const spacing = Math.max(
        MIN_DENSE_POINT_SPACING,
        Math.round(Math.min(sourceRecord.width, sourceRecord.height) / 90)
    )
    const points = []
    const buckets = new Set()

    edge.inlierPairs.forEach((pair) => {
        addSeedPoint(points, buckets, pair.source, spacing, maxSeedPoints, sourceRecord.width, sourceRecord.height)
    })

    let overlapMask = null
    let corners = null
    try {
        overlapMask = createOverlapMask(sourceRecord, targetRecord, edge.homographyPrepared)
        if (overlapMask) {
            corners = new cv.Mat()
            cv.goodFeaturesToTrack(
                sourceRecord.mat,
                corners,
                Math.max(0, maxSeedPoints - points.length),
                MIN_DENSE_FEATURE_QUALITY,
                spacing,
                overlapMask,
                5,
                false,
                0.04
            )
            extractPointsFromMat(corners).forEach((point) => {
                addSeedPoint(points, buckets, point, spacing, maxSeedPoints, sourceRecord.width, sourceRecord.height)
            })
        }
    } finally {
        if (corners?.delete) corners.delete()
        if (overlapMask?.delete) overlapMask.delete()
    }

    return points
}

function chooseAdaptiveGridDimensions(density, sampleCount, averageResidual) {
    const base = getMeshGridDimensions('mesh', density)
    let bonus = 0
    if (sampleCount > 80) bonus += 2
    if (sampleCount > 180) bonus += 2
    if (sampleCount > 320) bonus += 4
    if (averageResidual > 1.2) bonus += 2
    if (averageResidual > 2.5) bonus += 2
    const maxSide = density === 'high'
        ? 28
        : (density === 'medium' ? 22 : 16)
    return {
        cols: clamp(base.cols + bonus, base.cols, maxSide),
        rows: clamp(base.rows + bonus, base.rows, maxSide)
    }
}

function convertPreparedPointToOriginal(point, record) {
    return {
        x: point.x / Math.max(0.0001, record.scaleX),
        y: point.y / Math.max(0.0001, record.scaleY)
    }
}

function chooseResidualWeights(sourceState, targetState, distribution = 'balanced') {
    if (distribution === 'balanced') {
        return {
            source: 0.5,
            target: 0.5
        }
    }
    if (sourceState.depth === 0 && targetState.depth > 0) {
        return { source: 0, target: 1 }
    }
    if (targetState.depth === 0 && sourceState.depth > 0) {
        return { source: 1, target: 0 }
    }
    if (sourceState.depth > targetState.depth) {
        return { source: 1, target: 0 }
    }
    if (targetState.depth > sourceState.depth) {
        return { source: 0, target: 1 }
    }
    return { source: 0.5, target: 0.5 }
}

function computeFlowSupport(edge, recordsById, settings) {
    const sourceRecord = recordsById.get(edge.sourceId)
    const targetRecord = recordsById.get(edge.targetId)
    if (!sourceRecord || !targetRecord) return { count: 0, samples: [] }
    if (edge.inlierPairs.length < MIN_FLOW_SUPPORT) return { count: 0, samples: [] }

    const supportPoints = buildDenseSupportSeeds(edge, sourceRecord, targetRecord, settings)
    const sourceFlat = []
    const targetFlat = []
    const supportWeights = []

    supportPoints.forEach((point) => {
        const predicted = applyHomography(edge.homographyPrepared, point.x, point.y)
        if (!predicted) return
        if (predicted.x < 0 || predicted.y < 0 || predicted.x >= targetRecord.width || predicted.y >= targetRecord.height) return
        const sourceWeight = sampleGradientStrength(sourceRecord, point.x, point.y)
        const targetWeight = sampleGradientStrength(targetRecord, predicted.x, predicted.y)
        const detailStrength = Math.max(sourceWeight, targetWeight)
        if (detailStrength < MIN_SUPPORT_DETAIL_STRENGTH) return
        const featureWeight = clamp(0.35 + ((sourceWeight + targetWeight) * 0.65), 0.2, 1.8)
        sourceFlat.push(point.x, point.y)
        targetFlat.push(predicted.x, predicted.y)
        supportWeights.push(featureWeight)
    })

    const pointCount = Math.min(sourceFlat.length / 2, targetFlat.length / 2, supportWeights.length)
    if (pointCount < MIN_FLOW_SUPPORT) return { count: 0, samples: [] }

    const prevPoints = cv.matFromArray(pointCount, 1, cv.CV_32FC2, sourceFlat.slice(0, pointCount * 2))
    const nextPoints = cv.matFromArray(pointCount, 1, cv.CV_32FC2, targetFlat.slice(0, pointCount * 2))
    const status = new cv.Mat()
    const error = new cv.Mat()
    const windowSize = new cv.Size(21, 21)
    const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT | cv.TermCriteria_EPS, 30, 0.01)

    try {
        cv.calcOpticalFlowPyrLK(
            sourceRecord.mat,
            targetRecord.mat,
            prevPoints,
            nextPoints,
            status,
            error,
            windowSize,
            3,
            criteria,
            cv.OPTFLOW_USE_INITIAL_FLOW,
            0.0001
        )

        const nextData = nextPoints.data32F || []
        const prevData = prevPoints.data32F || []
        const statusData = status.data || []
        const errorData = error.data32F || []
        const rawSamples = []

        for (let index = 0; index < pointCount; index += 1) {
            if (!statusData[index]) continue
            if (!Number.isFinite(errorData[index]) || errorData[index] > MAX_FLOW_ERROR) continue
            const sourcePrepared = {
                x: prevData[index * 2],
                y: prevData[(index * 2) + 1]
            }
            const trackedPrepared = {
                x: nextData[index * 2],
                y: nextData[(index * 2) + 1]
            }
            const predictedPrepared = applyHomography(edge.homographyPrepared, sourcePrepared.x, sourcePrepared.y)
            if (!predictedPrepared || !Number.isFinite(trackedPrepared.x) || !Number.isFinite(trackedPrepared.y)) continue
            rawSamples.push({
                sourcePrepared,
                trackedPrepared,
                predictedPrepared,
                featureWeight: supportWeights[index] || 1,
                improvement: Math.hypot(
                    trackedPrepared.x - predictedPrepared.x,
                    trackedPrepared.y - predictedPrepared.y
                )
            })
        }

        const preparedCorrectionLimit = derivePreparedCorrectionLimit(rawSamples.map((sample) => sample.improvement), settings)
        const samples = rawSamples.filter((sample) => sample.improvement <= preparedCorrectionLimit)

        return {
            count: samples.length,
            samples,
            preparedCorrectionLimit
        }
    } finally {
        prevPoints.delete()
        nextPoints.delete()
        status.delete()
        error.delete()
        if (typeof criteria.delete === 'function') criteria.delete()
        if (typeof windowSize.delete === 'function') windowSize.delete()
    }
}

function buildMeshResiduals(states, acceptedEdges, recordsById, settings, flowCache) {
    const sampleSets = new Map()
    let supportCount = 0
    let improvementSum = 0

    acceptedEdges.forEach((edge) => {
        if (!states.has(edge.sourceId) || !states.has(edge.targetId)) return
        const cacheKey = edge.id
        const flow = flowCache.get(cacheKey) || computeFlowSupport(edge, recordsById, settings)
        flowCache.set(cacheKey, flow)
        if (flow.count < MIN_FLOW_SUPPORT) return

        const sourceState = states.get(edge.sourceId)
        const targetState = states.get(edge.targetId)
        const sourceRecord = recordsById.get(edge.sourceId)
        const targetRecord = recordsById.get(edge.targetId)
        const weights = chooseResidualWeights(sourceState, targetState, settings.warpDistribution)
        const originalScaleFactor = Math.max(
            1,
            0.25 * (
                (1 / Math.max(0.0001, sourceRecord.scaleX))
                + (1 / Math.max(0.0001, sourceRecord.scaleY))
                + (1 / Math.max(0.0001, targetRecord.scaleX))
                + (1 / Math.max(0.0001, targetRecord.scaleY))
            )
        )
        const worldResidualLimit = clamp(
            (flow.preparedCorrectionLimit || 0) * originalScaleFactor * 2.1,
            3,
            Math.min(
                MAX_LOCAL_WARP_PIXELS,
                Math.max(
                    8,
                    Math.max(
                        sourceRecord.originalWidth,
                        sourceRecord.originalHeight,
                        targetRecord.originalWidth,
                        targetRecord.originalHeight
                    ) * MAX_LOCAL_WARP_FRACTION
                )
            )
        )

        flow.samples.forEach((sample) => {
            const sourceOriginal = convertPreparedPointToOriginal(sample.sourcePrepared, sourceRecord)
            const targetOriginal = convertPreparedPointToOriginal(sample.trackedPrepared, targetRecord)
            const sourceWorld = applyHomography(sourceState.homographyToAnchor, sourceOriginal.x, sourceOriginal.y)
            const targetWorld = applyHomography(targetState.homographyToAnchor, targetOriginal.x, targetOriginal.y)
            if (!sourceWorld || !targetWorld) return

            const residualX = targetWorld.x - sourceWorld.x
            const residualY = targetWorld.y - sourceWorld.y
            const residualMagnitude = Math.hypot(residualX, residualY)
            if (residualMagnitude < 0.25) return
            if (residualMagnitude > worldResidualLimit) return
            const correctionWeight = clamp(
                1.15 - ((sample.improvement || 0) / Math.max(1, flow.preparedCorrectionLimit || 1)),
                0.15,
                1.1
            )
            const sampleWeight = clamp((sample.featureWeight || 1) * correctionWeight, 0.08, 2.2)

            if (weights.source > 0) {
                const sampleSet = sampleSets.get(edge.sourceId) || {
                    record: sourceRecord,
                    samples: [],
                    residualMagnitudes: []
                }
                sampleSet.samples.push({
                    localPoint: sourceOriginal,
                    residualX: residualX * weights.source,
                    residualY: residualY * weights.source,
                    weight: sampleWeight
                })
                sampleSet.residualMagnitudes.push(residualMagnitude * weights.source)
                sampleSets.set(edge.sourceId, sampleSet)
            }

            if (weights.target > 0) {
                const sampleSet = sampleSets.get(edge.targetId) || {
                    record: targetRecord,
                    samples: [],
                    residualMagnitudes: []
                }
                sampleSet.samples.push({
                    localPoint: targetOriginal,
                    residualX: -residualX * weights.target,
                    residualY: -residualY * weights.target,
                    weight: sampleWeight
                })
                sampleSet.residualMagnitudes.push(residualMagnitude * weights.target)
                sampleSets.set(edge.targetId, sampleSet)
            }

            supportCount += 1
            improvementSum += residualMagnitude + sample.improvement
        })
    })

    const grids = new Map()
    let distortionPenalty = 0
    let distortionSamples = 0
    sampleSets.forEach((sampleSet, inputId) => {
        const averageResidual = sampleSet.residualMagnitudes.length
            ? (sampleSet.residualMagnitudes.reduce((sum, value) => sum + value, 0) / sampleSet.residualMagnitudes.length)
            : 0
        const dimensions = chooseAdaptiveGridDimensions(settings.meshDensity, sampleSet.samples.length, averageResidual)
        const warpBudget = deriveWorldWarpBudget(sampleSet.record, sampleSet.residualMagnitudes)
        const accumulator = createResidualAccumulator(sampleSet.record, settings.meshDensity, dimensions, { maxResidual: warpBudget })
        sampleSet.samples.forEach((sample) => {
            addResidualSample(accumulator, sample.localPoint, sample.residualX, sample.residualY, sample.weight)
        })
        const nodes = finalizeResidualAccumulator(accumulator)
        const weightedNodes = nodes.filter((node) => node.weight > 0)
        if (!weightedNodes.length) return
        distortionPenalty += weightedNodes.reduce((sum, node) => sum + Math.hypot(node.x, node.y), 0)
        distortionSamples += weightedNodes.length
        grids.set(inputId, {
            cols: accumulator.cols,
            rows: accumulator.rows,
            nodes,
            supportSamples: sampleSet.samples.length,
            averageResidual
        })
    })

    return {
        grids,
        supportCount,
        averageImprovement: supportCount ? (improvementSum / supportCount) : 0,
        distortionPenalty: distortionSamples ? (distortionPenalty / distortionSamples) : 0
    }
}

function buildCandidate(anchorRecord, imageRecords, states, acceptedEdges, recordsById, settings, type, flowCache, allowWarp = true) {
    const candidateStates = createCandidateStates(anchorRecord, states, settings, recordsById)
    const usedEdges = [...candidateStates.values()]
        .map((state) => state.parentEdgeId)
        .filter(Boolean)
        .map((pairId) => acceptedEdges.find((edge) => edge.id === pairId))
        .filter(Boolean)

    const meshResiduals = type === 'mesh'
        ? buildMeshResiduals(candidateStates, acceptedEdges, recordsById, settings, flowCache)
        : { grids: new Map(), supportCount: 0, averageImprovement: 0, distortionPenalty: 0 }

    if (type === 'mesh' && meshResiduals.supportCount < MIN_FLOW_SUPPORT) return null

    const solvedBounds = [...candidateStates.values()].reduce((bounds, state) => {
        const record = recordsById.get(state.inputId)
        const candidateBounds = computeHomographyBounds(record, state.homographyToAnchor)
        return {
            minX: Math.min(bounds.minX, candidateBounds.minX),
            minY: Math.min(bounds.minY, candidateBounds.minY),
            maxX: Math.max(bounds.maxX, candidateBounds.maxX),
            maxY: Math.max(bounds.maxY, candidateBounds.maxY)
        }
    }, {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY
    })

    let manualCursorX = Number.isFinite(solvedBounds.maxX) ? solvedBounds.maxX + INPUT_GAP : 0
    const placements = imageRecords.map((record) => {
        const state = candidateStates.get(record.id)
        if (!state) {
            const placement = {
                inputId: record.id,
                x: round(manualCursorX, 3),
                y: 0,
                scale: 1,
                rotation: 0,
                visible: true,
                locked: false,
                z: record.index,
                opacity: 1
            }
            manualCursorX += record.originalWidth + INPUT_GAP
            return placement
        }
        const residualGrid = meshResiduals.grids.get(record.id) || null
        const grid = createGridTargetPoints(
            record,
            state.homographyToAnchor,
            type,
            settings.meshDensity,
            residualGrid
        )
        return {
            ...buildPlacementFromGrid(record, grid, type, settings.meshDensity, allowWarp),
            z: record.index
        }
    })

    const coverage = candidateStates.size / Math.max(1, imageRecords.length)
    const averageOverlap = usedEdges.length
        ? usedEdges.reduce((sum, edge) => sum + edge.overlapRatio, 0) / usedEdges.length
        : 0
    const averageInliers = usedEdges.length
        ? usedEdges.reduce((sum, edge) => sum + edge.inliers, 0) / usedEdges.length
        : 0
    const averageReprojection = usedEdges.length
        ? usedEdges.reduce((sum, edge) => sum + edge.reprojectionError, 0) / usedEdges.length
        : 0

    const score = (
        (coverage * 128)
        + (averageOverlap * 82)
        + (averageInliers * 2.2)
        - (averageReprojection * 7.5)
        + (type === 'mesh'
            ? ((meshResiduals.supportCount * 0.18) + (meshResiduals.averageImprovement * 4.5) - (meshResiduals.distortionPenalty * 0.22))
            : 0)
        + Math.max(0, usedEdges.length - 1) * 3
    )

    const diagnostics = [
        `${candidateStates.size}/${imageRecords.length} images solved from ${anchorRecord.name}`,
        `${usedEdges.length} supporting homography edge${usedEdges.length === 1 ? '' : 's'}`
    ]
    if (settings.warpDistribution === 'balanced' && candidateStates !== states) diagnostics.push('Balanced world frame')
    if (type === 'mesh') {
        diagnostics.push(`${meshResiduals.supportCount} optical-flow supports`)
        diagnostics.push(settings.warpDistribution === 'balanced' ? 'Balanced deformation sharing' : 'Anchored deformation sharing')
        const meshSummaries = [...meshResiduals.grids.values()].map((grid) => `${grid.cols}x${grid.rows}`).join(', ')
        if (meshSummaries) diagnostics.push(`Adaptive mesh grids: ${meshSummaries}`)
    }

    return {
        id: createCandidateId(),
        name: `${type === 'mesh' ? 'Mesh' : 'Perspective'} ${anchorRecord.name}`,
        source: 'analysis',
        modelType: type,
        blendMode: settings.blendMode === 'auto'
            ? (type === 'mesh' ? 'seam' : 'feather')
            : settings.blendMode,
        score,
        confidence: 0,
        rank: 1,
        coverage: round(coverage, 4),
        placements,
        diagnostics,
        warning: candidateStates.size < imageRecords.length ? 'Some images fell back to manual placement.' : ''
    }
}

function dedupeCandidates(candidates) {
    const seen = new Set()
    const result = []
    candidates.forEach((candidate) => {
        const key = JSON.stringify(candidate.placements.map((placement) => ([
            placement.inputId,
            Math.round((placement.x || 0) * 10),
            Math.round((placement.y || 0) * 10),
            Math.round((placement.scale || 1) * 1000),
            Math.round((placement.rotation || 0) * 1000),
            placement.warp?.type || '',
            placement.warp?.cols || 0,
            placement.warp?.rows || 0,
            placement.warp?.points ? placement.warp.points.slice(0, 10).map((point) => ([
                Math.round(point.dx * 10),
                Math.round(point.dy * 10)
            ])) : []
        ])))
        if (seen.has(key)) return
        seen.add(key)
        result.push(candidate)
    })
    return result
}

function rankCandidates(candidates) {
    const sorted = [...candidates].sort((left, right) => right.score - left.score)
    const maxScore = sorted[0]?.score || 1
    const minScore = sorted[sorted.length - 1]?.score || 0
    return sorted.map((candidate, index) => {
        const normalizedScore = maxScore === minScore
            ? 1
            : ((candidate.score - minScore) / Math.max(0.0001, maxScore - minScore))
        const rankFactor = sorted.length <= 1 ? 1 : (1 - (index / (sorted.length - 1)))
        return {
            ...candidate,
            rank: index + 1,
            confidence: round(clamp((normalizedScore * 0.5) + ((candidate.coverage || 0) * 0.3) + (rankFactor * 0.2), 0, 1), 4)
        }
    })
}

function normalizeSettings(settings = {}) {
    return {
        blendMode: typeof settings.blendMode === 'string' ? settings.blendMode : 'auto',
        meshDensity: ['low', 'medium', 'high'].includes(settings.meshDensity) ? settings.meshDensity : 'medium',
        warpMode: ['auto', 'off', 'perspective', 'mesh'].includes(settings.warpMode) ? settings.warpMode : 'auto',
        warpDistribution: ['anchored', 'balanced'].includes(settings.warpDistribution) ? settings.warpDistribution : 'balanced',
        maxFeatures: Math.max(200, Number(settings.maxFeatures) || 4000),
        matchRatio: clamp(Number(settings.matchRatio) || 0.75, 0.4, 0.99),
        ransacIterations: Math.max(200, Number(settings.ransacIterations) || 5000),
        inlierThreshold: clamp(Number(settings.inlierThreshold) || 4.5, 1, 48),
        maxCandidates: clamp(Math.round(Number(settings.maxCandidates) || 8), 1, 12)
    }
}

function buildWarning(topCandidate, meshRequested, meshBuilt) {
    if (!topCandidate) return 'No photo candidates were generated.'
    if (topCandidate.source === 'manual') return 'No strong photo overlaps passed homography validation. Falling back to manual layout.'
    if (topCandidate.warning) return topCandidate.warning
    if (meshRequested && !meshBuilt) return 'Homography candidates are ready, but mesh refinement did not find enough stable flow support.'
    return ''
}

function analyzePhotoDocument(document, preparedInputs, requestId = '') {
    const settings = normalizeSettings(document?.settings || {})
    emitProgress(requestId, 'Preparing photo analysis...', `${preparedInputs.length} image${preparedInputs.length === 1 ? '' : 's'}`)
    if (preparedInputs.length <= 1) {
        const manualCandidate = createManualLayoutCandidate(preparedInputs.map((preparedInput, index) => ({
            id: preparedInput.id,
            originalWidth: preparedInput.originalWidth || preparedInput.width,
            originalHeight: preparedInput.originalHeight || preparedInput.height,
            index
        })), preparedInputs.length ? '' : 'Add two or more images to analyze a stitch.')
        return {
            backend: PHOTO_BACKEND,
            candidates: [manualCandidate],
            warning: preparedInputs.length ? 'Only one image was available, so no overlap analysis ran.' : 'Add images to begin stitching.',
            diagnostics: []
        }
    }

    emitProgress(requestId, 'Extracting ORB features...', '', { phase: 'features', completed: 0, total: preparedInputs.length })
    const imageRecords = createImageRecords(document, preparedInputs, settings)
    const recordsById = new Map(imageRecords.map((record) => [record.id, record]))
    emitProgress(
        requestId,
        'Extracted ORB features',
        imageRecords.map((record) => `${record.name}: ${record.keypoints.length}`).join(' | '),
        { phase: 'features', completed: preparedInputs.length, total: preparedInputs.length }
    )

    try {
        const pairResult = buildPairEdges(imageRecords, settings, requestId)
        const acceptedEdges = pairResult.acceptedEdges
        if (!acceptedEdges.length) {
            return {
                backend: PHOTO_BACKEND,
                candidates: [createManualLayoutCandidate(imageRecords, 'No photo overlaps passed homography validation.')],
                warning: 'No photo overlaps passed homography validation. Falling back to manual layout.',
                diagnostics: pairResult.diagnostics
            }
        }

        emitProgress(requestId, 'Building photo candidates...', `${acceptedEdges.length} accepted edge${acceptedEdges.length === 1 ? '' : 's'}`)
        const adjacency = buildAdjacency(imageRecords, acceptedEdges)
        const flowCache = new Map()
        const candidates = []
        const buildPerspective = settings.warpMode === 'auto' || settings.warpMode === 'perspective'
        const buildMesh = settings.warpMode === 'auto' || settings.warpMode === 'mesh'
        const allowPerspectiveWarp = settings.warpMode !== 'off'
        let meshBuilt = false

        imageRecords.forEach((anchorRecord, anchorIndex) => {
            emitProgress(
                requestId,
                'Solving photo anchor...',
                `${anchorRecord.name} (${anchorIndex + 1}/${imageRecords.length})`,
                { phase: 'candidates', completed: anchorIndex, total: imageRecords.length }
            )
            const states = solveAnchorGraph(anchorRecord.id, adjacency)
            let meshCandidate = null
            if (buildPerspective) {
                emitProgress(
                    requestId,
                    'Building perspective candidate...',
                    `${anchorRecord.name} (${anchorIndex + 1}/${imageRecords.length})`,
                    { phase: 'candidates', completed: anchorIndex, total: imageRecords.length }
                )
            }
            const perspectiveCandidate = buildPerspective
                ? buildCandidate(
                    anchorRecord,
                    imageRecords,
                    states,
                    acceptedEdges,
                    recordsById,
                    settings,
                    'perspective',
                    flowCache,
                    allowPerspectiveWarp
                )
                : null
            if (perspectiveCandidate) candidates.push(perspectiveCandidate)
            if (buildMesh) {
                emitProgress(
                    requestId,
                    'Refining mesh candidate...',
                    `${anchorRecord.name} (${anchorIndex + 1}/${imageRecords.length})`,
                    { phase: 'candidates', completed: anchorIndex, total: imageRecords.length }
                )
                meshCandidate = buildCandidate(
                    anchorRecord,
                    imageRecords,
                    states,
                    acceptedEdges,
                    recordsById,
                    settings,
                    'mesh',
                    flowCache,
                    true
                )
                if (meshCandidate) {
                    meshBuilt = true
                    candidates.push(meshCandidate)
                }
            }

            const builtKinds = []
            if (perspectiveCandidate) builtKinds.push('perspective')
            if (buildMesh) builtKinds.push(meshCandidate ? 'mesh' : 'mesh skipped')
            emitProgress(
                requestId,
                'Built photo anchor candidate',
                `${anchorRecord.name}: ${builtKinds.join(', ') || 'no candidate'}`,
                { phase: 'candidates', completed: anchorIndex + 1, total: imageRecords.length }
            )
        })

        candidates.push(createManualLayoutCandidate(imageRecords, 'Manual fallback layout.'))
        const ranked = rankCandidates(dedupeCandidates(candidates)).slice(0, settings.maxCandidates)
        const warning = buildWarning(ranked[0], buildMesh, meshBuilt)
        emitProgress(
            requestId,
            'Finalizing photo candidates...',
            `${ranked.length} candidate${ranked.length === 1 ? '' : 's'} ready`,
            { phase: 'finalize', completed: ranked.length, total: ranked.length }
        )

        return {
            backend: PHOTO_BACKEND,
            candidates: ranked,
            warning,
            diagnostics: pairResult.diagnostics
                .sort((left, right) => {
                    if (left.accepted !== right.accepted) return left.accepted ? -1 : 1
                    return (right.score || 0) - (left.score || 0)
                })
                .concat(ranked.map((candidate) => ({
                    pair: `candidate:${candidate.name}`,
                    method: candidate.modelType,
                    score: round(candidate.score, 4),
                    matches: candidate.placements.length,
                    coverage: round(candidate.coverage || 0, 4),
                    accepted: true
                })))
        }
    } finally {
        destroyImageRecords(imageRecords)
    }
}

function postReadyOnce() {
    if (readyPosted) return
    if (bootTimeoutHandle) {
        clearTimeout(bootTimeoutHandle)
        bootTimeoutHandle = 0
    }
    readyPosted = true
    cvReady = true
    logDebug('Runtime ready.')
    self.postMessage({ type: 'ready' })
}

function postInitError(error) {
    if (cvInitError) return
    if (bootTimeoutHandle) {
        clearTimeout(bootTimeoutHandle)
        bootTimeoutHandle = 0
    }
    cvInitError = error?.message || String(error) || 'OpenCV.js could not initialize.'
    logError('Initialization failed.', cvInitError)
    self.postMessage({ type: 'init-error', error: cvInitError })
}

try {
    bootTimeoutHandle = setTimeout(() => {
        if (!cvReady && !cvInitError) {
            postInitError(new Error(`OpenCV.js did not finish booting within ${Math.round(BOOT_TIMEOUT_MS / 1000)} seconds.`))
        }
    }, BOOT_TIMEOUT_MS)
    logDebug('Loading vendored OpenCV.js...')
    importScripts('../vendor/opencv/opencv.js')
    if (!self.cv || typeof self.cv !== 'object') {
        throw new Error('OpenCV.js did not expose a global cv object.')
    }
    const previousOnRuntimeInitialized = self.cv.onRuntimeInitialized
    self.cv.onRuntimeInitialized = () => {
        if (typeof previousOnRuntimeInitialized === 'function') {
            try {
                previousOnRuntimeInitialized()
            } catch (error) {
                logError('Existing onRuntimeInitialized handler threw an error.', error)
            }
        }
        postReadyOnce()
    }
    if (typeof self.cv.then === 'function') {
        self.cv.then(
            () => postReadyOnce(),
            (error) => postInitError(error)
        )
    } else if (typeof self.cv.Mat === 'function' && typeof self.cv.getBuildInformation === 'function') {
        postReadyOnce()
    }
    logDebug('OpenCV.js imported, waiting for runtime...')
} catch (error) {
    postInitError(error)
}

self.addEventListener('message', (event) => {
    const { type, requestId, document, preparedInputs } = event.data || {}
    if (type !== 'analyze') return
    if (cvInitError) {
        self.postMessage({ requestId, error: cvInitError })
        return
    }
    if (!cvReady) {
        self.postMessage({ requestId, error: 'OpenCV.js is still loading for Stitch photo analysis.' })
        return
    }

    try {
        const result = analyzePhotoDocument(document, preparedInputs || [], requestId)
        self.postMessage({ requestId, result })
    } catch (error) {
        self.postMessage({ requestId, error: error?.message || 'OpenCV.js photo analysis failed.' })
    }
})
