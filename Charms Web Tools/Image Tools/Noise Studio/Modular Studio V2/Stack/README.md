# Modular Studio: Stack

This directory contains the completely separated, native C++ application rebuild of Modular Studio V2.

## Compiling and Testing

This project uses CMake's `FetchContent` to magically download all required dependencies (GLFW, ImGui) safely during the build. **You do NOT need to install anything locally besides a C++ compiler and CMake.**

Open your terminal in this directory (`/Stack`) and run:

1. **Generate the Build Files:**
   ```powershell
   cmake -B build
   ```

2. **Compile the App:**
   ```powershell
   cmake --build build --config Release
   ```

3. **Run It:**
   ```powershell
   .\build\Release\ModularStudioStack.exe
   ```
   *(Note: Depending on your compiler, the executable might just be in `.\build\ModularStudioStack.exe`)*
