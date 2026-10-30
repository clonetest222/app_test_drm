cmake_minimum_required(VERSION 3.20)
project(g4loader C CXX ASM_MASM)   # ASM_MASM: thunk x64 cho proxy 1-file

# ---- x64 bat buoc (steam.exe nap dwmapi x64 trong bin) ----
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Phai build x64. Chay: cmake -A x64 ..")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(g4loader SHARED
  src/dllmain.cpp
  src/dwmapi_thunks.asm       # thunk export: jmp qua g_realProcs[]
)
target_include_directories(g4loader PRIVATE src)

# Build ra dwmapi.dll; export do .def dinh nghia (tro vao thunk) -> proxy 1-file.
set_target_properties(g4loader PROPERTIES
  OUTPUT_NAME "dwmapi"
  LINK_FLAGS "/DEF:\"${CMAKE_CURRENT_SOURCE_DIR}/src/dwmapi_proxy.def\"")

if(MSVC)
  target_compile_options(g4loader PRIVATE /W4 /permissive-)
endif()

# Sau build: copy ra dist/
add_custom_command(TARGET g4loader POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_SOURCE_DIR}/dist"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:g4loader>" "${CMAKE_SOURCE_DIR}/dist/dwmapi.dll"
  COMMENT "Copied dwmapi.dll -> dist/")
