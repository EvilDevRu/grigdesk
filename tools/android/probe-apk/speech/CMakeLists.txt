cmake_minimum_required(VERSION 3.22)
project(grigdesk_android_speech LANGUAGES C CXX)

set(BUILD_SHARED_LIBS OFF CACHE BOOL "")
set(GGML_NATIVE OFF CACHE BOOL "")
set(GGML_OPENMP OFF CACHE BOOL "")
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "")
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "")
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "")
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

add_subdirectory("${WHISPER_SOURCE}" whisper EXCLUDE_FROM_ALL)
add_library(grigdesk_whisper SHARED whisperBridge.cpp)
target_link_libraries(grigdesk_whisper PRIVATE whisper)
