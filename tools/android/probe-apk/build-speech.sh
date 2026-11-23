#!/usr/bin/env bash
# Собирает LGPL FFmpeg и whisper.cpp для nativeLibraryDir пробного APK.
# Исходники upstream и каталог сборки задаёт вызывающий скрипт.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
ndk="${ANDROID_NDK_HOME:?Укажите Android NDK}"
whisper="$(realpath "${1:?Укажите исходники whisper.cpp}")"
ffmpeg="$(realpath "${2:?Укажите исходники FFmpeg}")"
build="$(realpath -m "${3:?Укажите рабочий каталог сборки}")"
abi="${4:-arm64-v8a}"
libs="${5:-$here/jniLibs/$abi}"
jobs="${GRIGDESK_ANDROID_BUILD_JOBS:-4}"
llvm="$ndk/toolchains/llvm/prebuilt/linux-x86_64/bin"

case "$abi" in
  arm64-v8a) arch=aarch64; target=aarch64-linux-android ;;
  x86_64) arch=x86_64; target=x86_64-linux-android ;;
  *) exit 2 ;;
esac

mkdir -p "$libs" "$build/ffmpeg"

cd "$build/ffmpeg"
"$ffmpeg/configure" --target-os=android --arch="$arch" --enable-cross-compile \
  --cc="$llvm/${target}30-clang" --cxx="$llvm/${target}30-clang++" \
  --ar="$llvm/llvm-ar" --ranlib="$llvm/llvm-ranlib" --nm="$llvm/llvm-nm" --strip="$llvm/llvm-strip" \
  --extra-ldflags=-Wl,-z,max-page-size=16384 --enable-pic --disable-shared --enable-static \
  --disable-autodetect --disable-network --disable-doc --disable-debug --disable-ffplay \
  --disable-hwaccels --disable-devices --disable-encoders --disable-x86asm \
  --enable-encoder=aac,pcm_s16le,mjpeg,png,mpeg4 \
  --disable-muxers --enable-muxer=wav,mp3,adts,mp4,matroska,webm,image2,image2pipe,pcm_s16le,null \
  --disable-decoders --enable-decoder=aac,aac_fixed,ac3,eac3,alac,ape,flac,mp3,mp3float,opus,vorbis \
  --enable-decoder=pcm*,h264,hevc,mpeg2video,mpeg4,vp8,vp9,av1,mjpeg,png,gif,wmav1,wmav2 \
  --disable-demuxers --enable-demuxer=aac,ac3,ape,asf,avi,flac,matroska,mov,mp3,mpegps,mpegts,ogg,wav \
  --enable-demuxer=gif,image2,image2pipe

# Декодер речи запрашивает `-f s16le`, но в configure этот muxer называется pcm_s16le.
# Не упаковываем FFmpeg, который не может вернуть декодированный PCM в Python.
grep -qx 'CONFIG_PCM_S16LE_MUXER=yes' ffbuild/config.mak
make -j "$jobs" ffmpeg ffprobe
install -m 755 ffmpeg "$libs/libffmpeg.so"
install -m 755 ffprobe "$libs/libffprobe.so"

cmake -S "$here/speech" -B "$build/whisper" -G Ninja \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE="$ndk/build/cmake/android.toolchain.cmake" \
  -DANDROID_ABI="$abi" -DANDROID_PLATFORM=30 -DANDROID_STL=c++_static -DWHISPER_SOURCE="$whisper"
cmake --build "$build/whisper" --parallel "$jobs" --target grigdesk_whisper
install -m 755 "$build/whisper/libgrigdesk_whisper.so" "$libs/"
