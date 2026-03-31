
set(CMAKE_BUILD_TYPE "Release")

set(BUILD_SHARED_LIBS "OFF")

set(CMAKE_C_FLAGS "-s WASM=1 -s SINGLE_FILE=1 -s USE_PTHREADS=0 -s SINGLE_FILE=1 -s EXPORTED_FUNCTIONS="['_malloc', '_free']"   -fsigned-char -W -Wall -Wreturn-type -Wnon-virtual-dtor -Waddress -Wsequence-point -Wformat -Wformat-security -Wmissing-declarations -Wmissing-prototypes -Wstrict-prototypes -Wundef -Winit-self -Wpointer-arith -Wshadow -Wsign-promo -Wuninitialized -Winconsistent-missing-override -Wno-delete-non-virtual-dtor -Wno-unnamed-type-template-args -Wno-comment -Wno-deprecated-enum-enum-conversion -Wno-deprecated-anon-enum-enum-conversion -fdiagnostics-show-option -Qunused-arguments -ffunction-sections -fdata-sections  -fvisibility=hidden -fvisibility-inlines-hidden")

set(CMAKE_C_FLAGS_DEBUG "-g  -O0 -DDEBUG -D_DEBUG")

set(CMAKE_C_FLAGS_RELEASE "-O3 -DNDEBUG  -DNDEBUG")

set(CMAKE_CXX_FLAGS "-s WASM=1 -s SINGLE_FILE=1 -s USE_PTHREADS=0 -s SINGLE_FILE=1 -s EXPORTED_FUNCTIONS="['_malloc', '_free']"   -fsigned-char -W -Wall -Wreturn-type -Wnon-virtual-dtor -Waddress -Wsequence-point -Wformat -Wformat-security -Wmissing-declarations -Wmissing-prototypes -Wstrict-prototypes -Wundef -Winit-self -Wpointer-arith -Wshadow -Wsign-promo -Wuninitialized -Winconsistent-missing-override -Wno-delete-non-virtual-dtor -Wno-unnamed-type-template-args -Wno-comment -Wno-deprecated-enum-enum-conversion -Wno-deprecated-anon-enum-enum-conversion -fdiagnostics-show-option -Qunused-arguments -ffunction-sections -fdata-sections  -fvisibility=hidden -fvisibility-inlines-hidden")

set(CMAKE_CXX_FLAGS_DEBUG "-g  -O0 -DDEBUG -D_DEBUG")

set(CMAKE_CXX_FLAGS_RELEASE "-O3 -DNDEBUG  -DNDEBUG")

set(CV_GCC "")

set(CV_CLANG "1")

set(ENABLE_NOISY_WARNINGS "OFF")

set(CMAKE_MODULE_LINKER_FLAGS "  -Wl,--gc-sections")

set(CMAKE_INSTALL_PREFIX "/usr/local")

set(OPENCV_PYTHON_INSTALL_PATH "")

set(OpenCV_SOURCE_DIR "C:/Users/djhbi/AppData/Local/Temp/codex-opencv-sift-build/opencv-4.x")

set(OPENCV_FORCE_PYTHON_LIBS "")

set(OPENCV_PYTHON_SKIP_LINKER_EXCLUDE_LIBS "")

set(OPENCV_PYTHON_BINDINGS_DIR "E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator")

set(cv2_custom_hdr "E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_custom_headers.h")

set(cv2_generated_files "E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_enums.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_funcs.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_include.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_modules.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_modules_content.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_types.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_generated_types_content.h;E:/WEBSITE/CharmsLink/CharmsLink/Charms Web Tools/Image Tools/Noise Studio/Modular Studio V2/.opencv-build/sift/opencv-build/modules/python_bindings_generator/pyopencv_signatures.json")
