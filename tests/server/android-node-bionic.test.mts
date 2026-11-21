import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  readBionicNodePin,
  readBionicPatches,
  applyBionicSourcePatches,
  ensureNdkPathVariable,
  bionicToolchainEnv,
  bionicMakeArgs,
  applyTrapHandlerPatch,
} from '../../tools/android/node-bionic.mts';

test('ANDROID-NODE-PIN: Bionic Node закреплён на том же теге, что SEA', () => {
  const pin = readBionicNodePin();

  assert.equal(pin.nodeTag, 'v24.21.0');
  assert.deepEqual(pin.abis, ['arm64-v8a', 'x86_64']);
  assert.equal(pin.apiLevel, 30);
  assert.match(pin.ndkSha256, /^[a-f0-9]{64}$/u);
  assert.equal(pin.outputName, 'libnode.so');
  assert.equal(pin.maxPageSize, 16384);
});

test('ANDROID-NODE-PATCH: патч execinfo закреплён и идемпотентен', async () => {
  const patches = readBionicPatches();
  const patch = patches[0];

  assert.ok(patch, 'обязателен патч execinfo');
  assert.equal(patch.file, 'deps/v8/src/base/debug/stack_trace_posix.cc');
  assert.ok(patch.from.includes('V8_LIBC_BSD'));
  assert.ok(patch.to.includes('!V8_LIBC_BIONIC'));

  const zlibPatch = patches.find((entry) => entry.file === 'deps/zlib/zlib.gyp');

  assert.ok(zlibPatch, 'zlib cpufeatures patch');
  assert.ok(zlibPatch.to.includes('cpu-features-android.c'));

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bionic-patch-'));

  for (const entry of patches) {
    const file = path.join(dir, entry.file);

    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `before\n${entry.from}\nafter\n`);
  }

  try {
    const first = await applyBionicSourcePatches(dir);
    const second = await applyBionicSourcePatches(dir);
    const text = await fs.readFile(path.join(dir, patch.file), 'utf8');

    assert.deepEqual(first, patches.map((entry) => entry.file));
    assert.deepEqual(second, []);
    assert.ok(text.includes(patch.to));
    assert.ok(!text.includes(patch.from));
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ANDROID-NODE-PATCH: отсутствующий контекст останавливает сборку', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bionic-patch-'));
  const patch = readBionicPatches()[0];

  assert.ok(patch, 'обязателен патч execinfo');

  const file = path.join(dir, patch.file);

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'upstream changed\n');

  try {
    await assert.rejects(applyBionicSourcePatches(dir), /bionic_node_patch_context_missing/u);
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ANDROID-NODE-GYPI: android_ndk_path закрепляется в config.gypi идемпотентно', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bionic-gypi-'));
  const file = path.join(dir, 'config.gypi');

  await fs.writeFile(file, '{\n  "variables": {\n    "target_arch": "arm64"\n  }\n}\n');

  try {
    await ensureNdkPathVariable(dir, '/ndk/path');
    await ensureNdkPathVariable(dir, '/ndk/path');

    const text = await fs.readFile(file, 'utf8');

    assert.ok(text.includes('"android_ndk_path": "/ndk/path"'));
    assert.equal(text.match(/android_ndk_path/gu)?.length, 1);
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ANDROID-NODE-GYPI: сломанный config.gypi отвергается', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bionic-gypi-'));

  await fs.writeFile(path.join(dir, 'config.gypi'), '{}\n');

  try {
    await assert.rejects(ensureNdkPathVariable(dir, '/ndk'), /bionic_node_config_gypi_invalid/u);
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('ANDROID-NODE-ENV: окружение make указывает на NDK clang своего ABI', () => {
  const arm = bionicToolchainEnv('/ndk', 'arm64-v8a', 30);
  const x86 = bionicToolchainEnv('/ndk', 'x86_64', 30);

  assert.equal(arm.CC, '/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android30-clang');
  assert.equal(x86.CXX, '/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android30-clang++');
  assert.ok(arm.PATH.startsWith('/ndk/toolchains/llvm/prebuilt/linux-x86_64/bin:'));
  // Командная строка LIBS=-latomic перетирала gyp-список библиотек цели
  // (-lm -ldl -llog) — target-линковка теряла liblog и падала на
  // __android_log_print. Библиотеки задаёт только gyp; атомики host-линковок
  // закрывает отдельный hostAtomicLib.
  assert.deepEqual(bionicMakeArgs(2), [
    '-j2', 'all', 'CC.host=gcc', 'CXX.host=g++', 'CFLAGS.host=-O2', 'CXXFLAGS.host=-O2 -std=gnu++20',
  ]);
  assert.deepEqual(bionicMakeArgs(8, '-O0'), [
    '-j8', 'all', 'CC.host=gcc', 'CXX.host=g++', 'CFLAGS.host=-O0', 'CXXFLAGS.host=-O0 -std=gnu++20',
  ]);
  assert.deepEqual(bionicMakeArgs(8, '-O1', '/ndk/bin/clang', '/ndk/bin/clang++'), [
    '-j8', 'all', 'CC.host=/ndk/bin/clang', 'CXX.host=/ndk/bin/clang++',
    'CFLAGS.host=-O1', 'CXXFLAGS.host=-O1 -std=gnu++20',
  ]);
  assert.ok(bionicMakeArgs(2).every((arg) => !arg.startsWith('LIBS=')));

  // NDK clang в host-режиме резолвит -latomic в пустой архив compiler-rt
  // (lib/clang/19/lib/linux/x86_64/libatomic.a, 150 байт) — mksnapshot падает
  // на __atomic_compare_exchange. Настоящая host-библиотека подключается
  // отдельным путём с --no-as-needed: LDFLAGS.host стоит до группы объектов,
  // без флага lld отбрасывает библиотеку как невостребованную.
  const withAtomic = bionicMakeArgs(
    8, '-O1', '/ndk/bin/clang', '/ndk/bin/clang++', '/usr/lib/libatomic.so.1',
  );

  assert.deepEqual(withAtomic, [
    '-j8', 'all', 'CC.host=/ndk/bin/clang', 'CXX.host=/ndk/bin/clang++',
    'CFLAGS.host=-O1', 'CXXFLAGS.host=-O1 -std=gnu++20',
    'LDFLAGS.host=-Wl,--no-as-needed /usr/lib/libatomic.so.1',
  ]);
});

test('ANDROID-NODE-TRAP: upstream-патч trap-handler применяется идемпотентно', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bionic-trap-'));
  const header = path.join(dir, 'deps/v8/src/trap-handler/trap-handler.h');
  const guard = '#if V8_HOST_ARCH_X64 && V8_TARGET_ARCH_X64\n'
    + '#define V8_TRAP_HANDLER_SUPPORTED true\n#else\n'
    + '#define V8_TRAP_HANDLER_SUPPORTED false\n#endif\n';

  await fs.mkdir(path.dirname(header), { recursive: true });
  await fs.writeFile(header, guard);

  try {
    const first = await applyTrapHandlerPatch(dir);
    const second = await applyTrapHandlerPatch(dir);
    const text = await fs.readFile(header, 'utf8');

    assert.equal(first, true);
    assert.equal(second, false);
    assert.ok(text.includes('#define V8_TRAP_HANDLER_SUPPORTED false'));
    assert.ok(!text.includes('#if V8_HOST_ARCH_X64'));
  }
  finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
