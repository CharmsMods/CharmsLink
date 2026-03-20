async function fetchShaderSource(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed to load shader '${url}' (${response.status}).`);
    return response.text();
}

function compileShader(gl, type, source, label) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`Shader compile error [${label}]: ${gl.getShaderInfoLog(shader)}`);
    }
    return shader;
}

function linkProgram(gl, vertexShader, fragmentShader, key) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(`Program link error [${key}]: ${gl.getProgramInfoLog(program)}`);
    }
    return program;
}

export async function bootstrapEngine(canvas, registry, callbacks = {}) {
    const gl = canvas.getContext('webgl2', {
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true
    });
    if (!gl) {
        throw new Error('WebGL2 is not supported in this browser.');
    }

    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    const vertexSource = await fetchShaderSource(registry.utilityPrograms.vertex);
    const layerPrograms = new Map();
    registry.layers.forEach((layer) => {
        if (layer.shader) layerPrograms.set(layer.programKey, layer.shader);
        (layer.extraPrograms || []).forEach((program) => layerPrograms.set(program.key, program.shader));
    });
    Object.entries(registry.utilityPrograms.programs).forEach(([key, shader]) => layerPrograms.set(key, shader));

    const fragmentSources = await Promise.all([...layerPrograms.entries()].map(async ([key, shader]) => [key, await fetchShaderSource(shader)]));
    const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource, 'vs-quad');
    const programs = {};

    fragmentSources.forEach(([key, source]) => {
        const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, source, key);
        programs[key] = linkProgram(gl, vertexShader, fragmentShader, key);
    });

    const quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 0, 0,
        1, -1, 1, 0,
        -1, 1, 0, 1,
        -1, 1, 0, 1,
        1, -1, 1, 0,
        1, 1, 1, 1
    ]), gl.STATIC_DRAW);

    Object.values(programs).forEach((program) => {
        gl.useProgram(program);
        const posLoc = gl.getAttribLocation(program, 'a_pos');
        const uvLoc = gl.getAttribLocation(program, 'a_uv');
        if (posLoc >= 0) {
            gl.enableVertexAttribArray(posLoc);
            gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 16, 0);
        }
        if (uvLoc >= 0) {
            gl.enableVertexAttribArray(uvLoc);
            gl.vertexAttribPointer(uvLoc, 2, gl.FLOAT, false, 16, 8);
        }
    });

    canvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        callbacks.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
        callbacks.onContextRestored?.();
    });

    return { gl, programs };
}
