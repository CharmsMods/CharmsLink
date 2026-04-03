import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const emccCommand = process.platform === 'win32' ? 'emcc.bat' : 'emcc';
const emsdkRoot = process.env.EMSDK ? resolve(process.env.EMSDK) : resolve(repoRoot, 'tools/emsdk');
const emscriptenPython = process.env.EMSDK_PYTHON || process.env.PYTHON || 'python';
const emccPythonEntry = resolve(emsdkRoot, 'upstream/emscripten/emcc.py');

function runEmcc(args = [], options = {}) {
    if (process.platform === 'win32') {
        return spawnSync(emscriptenPython, [emccPythonEntry, ...args], {
            cwd: repoRoot,
            ...options
        });
    }
    return spawnSync(emccCommand, args, {
        cwd: repoRoot,
        ...options
    });
}

const commonFlags = [
    '-O3',
    '-std=c++17',
    '-sWASM=1',
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_ALL=1',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sFILESYSTEM=0',
    '-sENVIRONMENT=web,worker'
];

const targets = {
    editor: {
        source: resolve(repoRoot, 'native/editor-wasm/editor_kernels.cpp'),
        outputDir: resolve(repoRoot, 'src/vendor/wasm/editor'),
        exportName: 'createEditorKernelsModule',
        baseName: 'editor-kernels',
        exportedFunctions: [
            '_malloc',
            '_free',
            '_editor_compute_histogram_rgba',
            '_editor_compute_vectorscope_rgba',
            '_editor_compute_parade_rgba',
            '_editor_compute_diff_preview',
            '_editor_extract_palette'
        ]
    },
    library: {
        source: resolve(repoRoot, 'native/library-wasm/library_codec.cpp'),
        outputDir: resolve(repoRoot, 'src/vendor/wasm/library'),
        exportName: 'createLibraryCodecModule',
        baseName: 'library-codec',
        exportedFunctions: [
            '_malloc',
            '_free',
            '_library_base64_encode_bound',
            '_library_base64_encode',
            '_library_base64_decode_bound',
            '_library_base64_decode'
        ]
    }
};

function toEmscriptenArray(values = []) {
    return `[${values.map((value) => `'${value}'`).join(',')}]`;
}

function ensureEmccAvailable() {
    const result = runEmcc(['--version'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
        const reason = result.error?.message || result.stderr || 'emcc is not installed or is not on PATH.';
        console.error('WASM build failed: Emscripten was not found.');
        console.error(reason.trim());
        process.exit(1);
    }
}

function compileTarget(targetName, options = {}) {
    const config = targets[targetName];
    if (!config) {
        throw new Error(`Unknown WASM target "${targetName}". Expected "editor" or "library".`);
    }

    mkdirSync(config.outputDir, { recursive: true });
    const suffix = options.simd ? '-simd' : '';
    const outputFile = resolve(config.outputDir, `${config.baseName}${suffix}.mjs`);
    const args = [
        config.source,
        ...commonFlags,
        `-sEXPORT_NAME=${config.exportName}`,
        `-sEXPORTED_FUNCTIONS=${toEmscriptenArray(config.exportedFunctions)}`,
        '-o',
        outputFile
    ];

    if (options.simd) {
        args.splice(2, 0, '-msimd128');
    }

    console.log(`Building ${targetName}${options.simd ? ' (SIMD)' : ' (baseline)'}...`);
    const result = runEmcc(args, { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`emcc failed while building ${targetName}${options.simd ? ' SIMD' : ' baseline'} output.`);
    }
}

function main() {
    ensureEmccAvailable();
    const requestedTarget = process.argv[2] ? String(process.argv[2]).trim().toLowerCase() : '';
    const selectedTargets = requestedTarget
        ? [requestedTarget]
        : Object.keys(targets);

    for (const targetName of selectedTargets) {
        if (!targets[targetName]) {
            console.error(`Unknown target "${targetName}". Use "editor", "library", or omit the argument for both.`);
            process.exit(1);
        }
        compileTarget(targetName, { simd: false });
        compileTarget(targetName, { simd: true });
    }

    console.log('WASM build complete.');
}

main();
