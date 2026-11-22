#!/usr/bin/env bash
# Проба 3 плана grigdesk-additional-platforms-tdd.md: кросс-сборка userland движка
# под Android Bionic (NDK r28c, API 30). Цепочка: zlib -> openssl -> libffi,
# затем bash, coreutils (flock/timeout/nohup), git, python3 (host-python заранее).
# Каждый компонент пишет свой лог; отказ одного не останавливает остальные.
# Выход: <out>/<abi>/lib<name>.so. SHA-исходники сверяются до распаковки.
set -uo pipefail

ROOT=${1:?каталог пробных исходников}
NDK=${2:?распакованный NDK r28c}
OUT=${3:?каталог выхода lib*.so}
JOBS=${4:-4}

TC="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
SYSROOT="$TC/sysroot"
LOG="$ROOT/logs"
mkdir -p "$LOG" "$OUT"
export PATH="$TC/bin:$PATH"
export ANDROID_NDK_ROOT="$NDK"
export ANDROID_NDK_HOME="$NDK"

FAILED=()

note() {
  printf '%s\n' "$*" | tee -a "$LOG/summary.log"
}

fail() {
  FAILED+=("$1")
  note "FAILED: $1 (лог $LOG/$1.log)"
}

verify_sources() {
  (cd "$ROOT" && sha256sum --check --strict sources.sha256) || exit 1
}

unpack() {
  local tarball=$1 dir=$2
  mkdir -p "$dir"
  case "$tarball" in
    *.tar.xz) tar -xJf "$ROOT/$tarball" -C "$dir" --strip-components=1 ;;
    *.tar.gz) tar -xzf "$ROOT/$tarball" -C "$dir" --strip-components=1 ;;
  esac
}

build_host_python() {
  if [[ -x "$ROOT/build/host-python/bin/python3.12" ]]; then
    return 0
  fi

  unpack Python-3.12.8.tar.xz "$ROOT/build/host-python-src"
  (
    cd "$ROOT/build/host-python-src" \
      && ./configure --prefix="$ROOT/build/host-python" --without-ensurepip \
      && make -j"$JOBS" \
      && make install
  ) > "$LOG/host-python.log" 2>&1 || fail host-python
}

build_deps() {
  local abi=$1 host=$2
  local B="$ROOT/build/$abi"
  local P="$B/sysroot"
  local CC="$TC/bin/${host}30-clang"
  local AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib"
  local CF="--sysroot=$SYSROOT -fPIC -O2 -I$P/include"
  local LF="--sysroot=$SYSROOT -L$P/lib"

  mkdir -p "$B" "$P"

  if [[ ! -f "$P/lib/libz.a" ]]; then
    unpack zlib-1.3.1.tar.xz "$B/zlib"
    (
      cd "$B/zlib" \
        && CHOST="$host" CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CF" \
          ./configure --prefix="$P" --static \
        && make -j"$JOBS" \
        && make install
    ) > "$LOG/$abi-zlib.log" 2>&1 || fail "$abi-zlib"
  fi

  if [[ ! -f "$P/lib/libssl.a" ]]; then
    local ossl_arch=arm64
    [[ $abi == x86_64 ]] && ossl_arch=x86_64

    unpack openssl-3.0.15.tar.gz "$B/openssl"
    (
      cd "$B/openssl" \
        && ./Configure "android-$ossl_arch" --prefix="$P" no-shared no-tests \
          -D__ANDROID_API__=30 \
        && make -j"$JOBS" \
        && make install_sw
    ) > "$LOG/$abi-openssl.log" 2>&1 || fail "$abi-openssl"
  fi

  if [[ ! -f "$P/lib/libffi.a" ]]; then
    unpack libffi-3.4.6.tar.gz "$B/libffi"
    (
      cd "$B/libffi" \
        && CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CF" LDFLAGS="$LF" \
          ./configure --host="$host" --build=x86_64-pc-linux-gnu --prefix="$P" \
            --disable-shared --enable-static \
        && make -j"$JOBS" \
        && make install
    ) > "$LOG/$abi-libffi.log" 2>&1 || fail "$abi-libffi"
  fi
}

build_bash() {
  local abi=$1 host=$2
  local B="$ROOT/build/$abi"
  local CC="$TC/bin/${host}30-clang"
  local AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib"
  # Старый termcap bash не включает unistd.h; clang 19 делает неявные
  # объявления ошибкой. Функции в Bionic есть — снимаем только эту диагностику.
  local CF="--sysroot=$SYSROOT -fPIC -O2 -Wno-implicit-function-declaration"
  local LF="--sysroot=$SYSROOT"

  [[ -f "$OUT/$abi/libbash.so" ]] && return 0

  unpack bash-5.2.37.tar.gz "$B/bash"
  (
    cd "$B/bash" \
      && CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CF" LDFLAGS="$LF" CC_FOR_BUILD=gcc \
        ./configure --host="$host" --build=x86_64-pc-linux-gnu --prefix="$B/bash-install" \
          --without-bash-malloc --disable-nls \
          bash_cv_func_mkdtemp=yes bash_cv_func_setpgrp_void=yes \
          bash_cv_sys_signal_handler=posix ac_cv_func_mmap_fixed_mapped=yes \
      && make -j"$JOBS" \
      && make install
  ) > "$LOG/$abi-bash.log" 2>&1 || { fail "$abi-bash"; return 0; }

  cp "$B/bash-install/bin/bash" "$OUT/$abi/libbash.so"
}

build_coreutils() {
  local abi=$1 host=$2
  local B="$ROOT/build/$abi"
  local CC="$TC/bin/${host}30-clang"
  local AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib"
  # gnulib nstrftime вызывает mktime_z без объявления в кросс-конфигурации;
  # реализация есть в lib/mktime.c — снимаем диагностику неявного объявления.
  local CF="--sysroot=$SYSROOT -fPIC -O2 -Wno-implicit-function-declaration"
  local LF="--sysroot=$SYSROOT"

  [[ -f "$OUT/$abi/libflock.so" ]] && return 0

  unpack coreutils-9.5.tar.xz "$B/coreutils"
  # Движку нужны только timeout/nohup (flock — util-linux, отдельный компонент);
  # date/ls требуют Bionic-патчей timezone_t и в пробу не входят.
  (
    cd "$B/coreutils" \
      && CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CF" LDFLAGS="$LF" \
        ./configure --host="$host" --build=x86_64-pc-linux-gnu \
          --prefix="$B/coreutils-install" --disable-nls --disable-acl \
          fu_cv_sys_stat_statfs2_bsize=yes gl_cv_func_printf_directive_n=yes \
      && make -j"$JOBS" src/timeout src/nohup
  ) > "$LOG/$abi-coreutils.log" 2>&1 || { fail "$abi-coreutils"; return 0; }

  for utility in timeout nohup; do
    cp "$B/coreutils/src/$utility" "$OUT/$abi/lib$utility.so"
  done
}

build_flock() {
  local abi=$1 host=$2
  local B="$ROOT/build/$abi"
  local CC="$TC/bin/${host}30-clang"
  local AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib"
  local CF="--sysroot=$SYSROOT -fPIC -O2 -Wno-implicit-function-declaration"
  local LF="--sysroot=$SYSROOT"

  [[ -f "$OUT/$abi/libflock.so" ]] && return 0

  unpack util-linux-2.40.2.tar.xz "$B/util-linux"
  (
    cd "$B/util-linux" \
      && CC="$CC" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CF" LDFLAGS="$LF" \
        ./configure --host="$host" --build=x86_64-pc-linux-gnu \
          --disable-liblastlog2 \
          --without-ncurses --without-tinfo --disable-nls --without-python \
          ul_cv_have_timer=yes \
      && make -j"$JOBS" flock
  ) > "$LOG/$abi-flock.log" 2>&1 || { fail "$abi-flock"; return 0; }

  cp "$B/util-linux/flock" "$OUT/$abi/libflock.so" || { fail "$abi-flock"; return 0; }
}

build_git() {
  local abi=$1 host=$2
  local B="$ROOT/build/$abi"
  local P="$B/sysroot"
  local CC="$TC/bin/${host}30-clang"
  local AR="$TC/bin/llvm-ar"
  local CF="--sysroot=$SYSROOT -fPIC -O2 -I$P/include"
  local LF="--sysroot=$SYSROOT -L$P/lib"

  # Повторная сборка должна пересчитать GIT-CFLAGS: старый ELF мог читать пустой pw_gecos.
  if [[ ! -f "$B/git/Makefile" ]]; then
    unpack git-2.47.1.tar.xz "$B/git" || { fail "$abi-git"; return 0; }
  fi
  (
    cd "$B/git" \
      && make -j"$JOBS" CC="$CC" AR="$AR" CFLAGS="$CF" LDFLAGS="$LF" \
        NO_CURL=1 NO_EXPAT=1 NO_GETTEXT=1 NO_TCLTK=1 NO_PERL=1 NO_PYTHON=1 NO_OPENSSL=1 \
        NO_PTHREADS=1 NO_GECOS_IN_PWENT=1 NEEDS_LIBRT= \
        prefix="$B/git-install" install
  ) > "$LOG/$abi-git.log" 2>&1 || { fail "$abi-git"; return 0; }

  cp "$B/git-install/bin/git" "$OUT/$abi/libgit.so"
}

build_python() {
  local abi=$1 host=$2
  local B="$ROOT/build/$abi"
  local P="$B/sysroot"
  local CC="$TC/bin/${host}30-clang"
  local CXX="$TC/bin/${host}30-clang++"
  local AR="$TC/bin/llvm-ar" RANLIB="$TC/bin/llvm-ranlib"
  local CF="--sysroot=$SYSROOT -fPIC -O2 -I$P/include"
  local LF="--sysroot=$SYSROOT -L$P/lib"

  [[ -f "$OUT/$abi/libpython3.so" ]] && return 0

  unpack Python-3.12.8.tar.xz "$B/python3"
  (
    cd "$B/python3" \
      && CC="$CC" CXX="$CXX" AR="$AR" RANLIB="$RANLIB" CFLAGS="$CF" LDFLAGS="$LF" \
        ./configure --host="$host" --build=x86_64-pc-linux-gnu \
          --prefix="$B/python3-install" \
          --with-build-python="$ROOT/build/host-python/bin/python3.12" \
          --with-openssl="$P" --without-ensurepip \
          ac_cv_file__dev_ptmx=yes ac_cv_file__dev_ptc=no \
          ac_cv_func_getaddrinfo=yes ac_cv_func_getnameinfo=yes \
          ac_cv_buggy_getaddrinfo=no \
      && make -j"$JOBS" \
      && make install
  ) > "$LOG/$abi-python3.log" 2>&1 || { fail "$abi-python3"; return 0; }

  cp "$B/python3-install/bin/python3.12" "$OUT/$abi/libpython3.so"
}

build_abi() {
  local abi=$1 host=$2

  note "=== ABI $abi ==="
  mkdir -p "$OUT/$abi"
  build_deps "$abi" "$host"
  build_bash "$abi" "$host"
  build_coreutils "$abi" "$host"
  build_flock "$abi" "$host"
  build_git "$abi" "$host"
  build_python "$abi" "$host"
}

verify_sources
build_host_python
build_abi arm64-v8a aarch64-linux-android
build_abi x86_64 x86_64-linux-android

note "=== Итог ==="
if ((${#FAILED[@]})); then
  note "Отказы: ${FAILED[*]}"
else
  note "Все компоненты собраны"
fi
ls -la "$OUT/arm64-v8a" "$OUT/x86_64" 2>/dev/null | tee -a "$LOG/summary.log"
