cmake_minimum_required(VERSION 3.20)
project(g4kernel C CXX ASM_MASM)   # ASM_MASM: thunk x64 cho proxy 1-file

# ---- Yeu cau: x64 (steamclient64.dll la x64). Cau hinh bang:  cmake -A x64 .. ----
if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
  message(FATAL_ERROR "Phai build x64. Chay: cmake -A x64 ..")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ---- MinHook (hook x64). Keo tu GitHub luc configure (can mang 1 lan). ----
# Luu y: tag v1.3.3 KHONG kem CMakeLists.txt -> FetchContent chi tai nguon,
# khong tao target. Ta tu bien dich MinHook tu nguon cua no thanh target "minhook".
include(FetchContent)
FetchContent_Declare(
  minhook
  GIT_REPOSITORY https://github.com/TsudaKageyu/minhook.git
  GIT_TAG        v1.3.3
)
FetchContent_MakeAvailable(minhook)

add_library(minhook STATIC
  "${minhook_SOURCE_DIR}/src/buffer.c"
  "${minhook_SOURCE_DIR}/src/hook.c"
  "${minhook_SOURCE_DIR}/src/trampoline.c"
  "${minhook_SOURCE_DIR}/src/hde/hde32.c"
  "${minhook_SOURCE_DIR}/src/hde/hde64.c"
)
target_include_directories(minhook PUBLIC "${minhook_SOURCE_DIR}/include")

add_library(g4kernel SHARED
  src/dllmain.cpp
  src/hooks.cpp
  src/dwmapi_thunks.asm       # thunk export (jmp toi ham that trong g_realProcs)
)

target_include_directories(g4kernel PRIVATE src "${minhook_SOURCE_DIR}/include")
target_link_libraries(g4kernel PRIVATE minhook bcrypt)

# Build ra thang dwmapi.dll. Export dinh nghia boi .def (tro vao thunk) -> proxy 1-file,
# khong forwarder, khong can dwmreal.dll.
set_target_properties(g4kernel PROPERTIES
  OUTPUT_NAME "dwmapi"
  LINK_FLAGS "/DEF:\"${CMAKE_CURRENT_SOURCE_DIR}/src/dwmapi_proxy.def\"")

if(MSVC)
  target_compile_options(g4kernel PRIVATE /W4 /permissive-)
endif()

# Sau khi build: copy ra thu muc dist/ cho de dong goi.
add_custom_command(TARGET g4kernel POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "${CMAKE_SOURCE_DIR}/dist"
  COMMAND ${CMAKE_COMMAND} -E copy "$<TARGET_FILE:g4kernel>" "${CMAKE_SOURCE_DIR}/dist/dwmapi.dll"
  COMMENT "Copied dwmapi.dll -> dist/"
)
