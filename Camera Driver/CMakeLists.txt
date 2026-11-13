cmake_minimum_required(VERSION 3.20)
project(GadgetCamStudioCamera CXX)
set(CMAKE_CXX_STANDARD 17)
# Static runtime: Windows' camera service must load the component without any extra installs.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
add_compile_definitions(UNICODE _UNICODE NOMINMAX _WIN32_WINNT=0x0A00)

add_library(GcsCamSource SHARED GcsCamSource.cpp GcsCamSource.def)
target_link_libraries(GcsCamSource PRIVATE mf mfplat mfuuid ole32 advapi32 uuid)

add_executable(gcs-vcam gcs-vcam.cpp)
target_link_libraries(gcs-vcam PRIVATE mfplat mfuuid ole32 advapi32)
