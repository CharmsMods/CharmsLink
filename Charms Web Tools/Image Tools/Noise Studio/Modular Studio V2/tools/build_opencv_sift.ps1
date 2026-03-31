param(
    [Parameter(Mandatory = $true)]
    [string]$OpenCvSourceDir,

    [Parameter(Mandatory = $true)]
    [string]$EmsdkDir,

    [string]$BuildRoot = '',

    [string]$OutputJs = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Split-Path $PSScriptRoot -Parent)
$BuildRoot = if ($BuildRoot) { $BuildRoot } else { Join-Path $repoRoot '.opencv-build\sift' }
$OutputJs = if ($OutputJs) { $OutputJs } else { Join-Path $repoRoot 'src\vendor\opencv\opencv.js' }
$openCvSourceDir = (Resolve-Path $OpenCvSourceDir).Path
$emsdkDir = (Resolve-Path $EmsdkDir).Path
$buildRoot = [System.IO.Path]::GetFullPath($BuildRoot)
$outputJs = [System.IO.Path]::GetFullPath($OutputJs)

$generator = Join-Path $PSScriptRoot 'generate_opencv_sift_config.py'
$sourceConfig = Join-Path $openCvSourceDir 'platforms\js\opencv_js.config.py'
$buildScript = Join-Path $openCvSourceDir 'platforms\js\build_js.py'
$jsCMakeLists = Join-Path $openCvSourceDir 'modules\js\CMakeLists.txt'
$configPath = Join-Path $buildRoot 'opencv_js.sift.config.py'
$opencvBuildDir = Join-Path $buildRoot 'opencv-build'
$emscriptenDir = Join-Path $emsdkDir 'upstream\emscripten'
$llvmBinDir = Join-Path $emsdkDir 'upstream\bin'
$emsdkPython = Join-Path $emsdkDir 'python\3.13.3_64bit\python.exe'
$emsdkNodeDir = Join-Path $emsdkDir 'node\22.16.0_64bit\bin'
$emsdkNode = Join-Path $emsdkNodeDir 'node.exe'
$cmakeDir = Join-Path $emsdkDir 'cmake\4.2.0-rc3_64bit\bin'
$mingwDir = Join-Path $emsdkDir 'mingw\7.1.0_64bit\bin'
$emConfig = Join-Path $emsdkDir '.emscripten'
$makeExe = Join-Path $buildRoot 'make.exe'

if (!(Test-Path $generator)) { throw "Missing config generator: $generator" }
if (!(Test-Path $sourceConfig)) { throw "Could not find OpenCV JS config: $sourceConfig" }
if (!(Test-Path $buildScript)) { throw "Could not find OpenCV build_js.py: $buildScript" }
if (!(Test-Path $jsCMakeLists)) { throw "Could not find OpenCV JS CMakeLists: $jsCMakeLists" }
if (!(Test-Path $emscriptenDir)) { throw "Could not find Emscripten directory: $emscriptenDir" }
if (!(Test-Path $emsdkPython)) { throw "Could not find emsdk Python: $emsdkPython" }
if (!(Test-Path $emsdkNode)) { throw "Could not find emsdk Node: $emsdkNode" }
if (!(Test-Path $cmakeDir)) { throw "Could not find emsdk CMake bin dir: $cmakeDir" }
if (!(Test-Path $mingwDir)) { throw "Could not find emsdk MinGW bin dir: $mingwDir" }
if (!(Test-Path $emConfig)) { throw "Could not find emsdk .emscripten config: $emConfig" }

New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null

$mingwMake = Join-Path $mingwDir 'mingw32-make.exe'
Copy-Item -LiteralPath $mingwMake -Destination $makeExe -Force

$jsCmakeContents = Get-Content -LiteralPath $jsCMakeLists -Raw
$demanglePattern = '(?ms)^[ \t]*# See https://github\.com/opencv/opencv/issues/27513\r?\n^[ \t]*# DEMANGLE_SUPPRT is deprecated at Emscripten 3\.1\.54 and later\.\r?\n^[ \t]*if\(NOT EMSCRIPTEN_VERSION OR EMSCRIPTEN_VERSION VERSION_LESS "3\.1\.54"\)\r?\n^[ \t]*set\(EMSCRIPTEN_LINK_FLAGS "\$\{EMSCRIPTEN_LINK_FLAGS\} -s DEMANGLE_SUPPORT=1"\)\r?\n^[ \t]*endif\(\)\r?\n'
$patchedJsCmakeContents = [System.Text.RegularExpressions.Regex]::Replace(
    $jsCmakeContents,
    $demanglePattern,
    "# Removed deprecated DEMANGLE_SUPPORT linker flag for modern Emscripten toolchains.`r`n"
)
if ($patchedJsCmakeContents -ne $jsCmakeContents) {
    Set-Content -LiteralPath $jsCMakeLists -Value $patchedJsCmakeContents -NoNewline
}

& $emsdkPython $generator --input $sourceConfig --output $configPath

$env:EM_CONFIG = $emConfig
$env:EMSDK = $emsdkDir
$env:EMSCRIPTEN = $emscriptenDir
$env:EMSCRIPTEN_ROOT = $emscriptenDir
$env:EMSDK_NODE = $emsdkNode
$env:EMSDK_PYTHON = $emsdkPython
$env:CMAKE_GENERATOR = 'MinGW Makefiles'
$env:CC = (Join-Path $emscriptenDir 'emcc.bat')
$env:CXX = (Join-Path $emscriptenDir 'em++.bat')
$env:AR = (Join-Path $emscriptenDir 'emar.bat')
$env:RANLIB = (Join-Path $emscriptenDir 'emranlib.bat')

$makeExeForward = $makeExe.Replace('\', '/')
$env:PATH = @(
    $buildRoot
    $cmakeDir
    $mingwDir
    $emscriptenDir
    $llvmBinDir
    $emsdkNodeDir
    $emsdkDir
    $env:PATH
) -join ';'

& $emsdkPython $buildScript $opencvBuildDir `
    --build_wasm `
    --config $configPath `
    --emscripten_dir $emscriptenDir `
    --build_flags "-s SINGLE_FILE=1" `
    --cmake_option="-DCMAKE_MAKE_PROGRAM=$makeExeForward" `
    --cmake_option=-DCMAKE_CXX_STANDARD=17 `
    --cmake_option=-DBUILD_TESTS=OFF `
    --cmake_option=-DBUILD_PERF_TESTS=OFF `
    --cmake_option=-DBUILD_EXAMPLES=OFF `
    --cmake_option=-DBUILD_DOCS=OFF `
    --cmake_option=-DBUILD_opencv_apps=OFF

$builtJs = Join-Path $opencvBuildDir 'bin\opencv.js'
if (!(Test-Path $builtJs)) { throw "Build completed without producing $builtJs" }

New-Item -ItemType Directory -Force -Path (Split-Path $outputJs -Parent) | Out-Null
Copy-Item -LiteralPath $builtJs -Destination $outputJs -Force

Write-Output $outputJs
