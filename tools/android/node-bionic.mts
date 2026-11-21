import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { sha256File } from '../../shared/node/hash.ts';

const execute = promisify(execFile);
const lockPath = path.resolve(import.meta.dirname, 'ndk.lock.json');
const hex64 = /^[a-f0-9]{64}$/u;
const hex40 = /^[a-f0-9]{40}$/u;
const nodeTagPattern = /^v[0-9]+\.[0-9]+\.[0-9]+$/u;
const httpsUrl = /^https:\/\/[^\s]+$/u;
const buildLogLimit = 128 * 1024 * 1024;
const pinKeys = [
  'format', 'nodeTag', 'nodeSourceUrl', 'nodeSourceSha256', 'ndkVersion', 'ndkUrl',
  'ndkSizeBytes', 'ndkSha1', 'ndkSha256', 'apiLevel', 'abis', 'outputName', 'maxPageSize',
].sort();

// Bionic при API 30 не предоставляет execinfo.h/backtrace, а v8config.h определяет
// V8_LIBC_BSD=1 для __BIONIC__ — guard HAVE_EXECINFO_H ошибочно включает glibc-путь.
// Патч исключает Bionic из guard; V8 использует свой fallback без backtrace.
// Второй патч: gyp-сборка Node 24.21.0 не компилирует NDK cpu-features.c, а
// zlib/cpu_features.c ссылается на android_getCpuFeatures (ARMV8_OS_ANDROID).
// Сборщик копирует cpu-features.c в дерево zlib (gyp make-генератор не строит
// правил для абсолютных внешних источников), патч добавляет относительный источник.
const bionicPatches = [
  {
    file: 'deps/v8/src/base/debug/stack_trace_posix.cc',
    from: '#if V8_LIBC_GLIBC || V8_LIBC_BSD || V8_LIBC_UCLIBC || V8_OS_SOLARIS\n'
      + '#define HAVE_EXECINFO_H 1\n#endif',
    to: '#if (V8_LIBC_GLIBC || V8_LIBC_BSD || V8_LIBC_UCLIBC || V8_OS_SOLARIS) && !V8_LIBC_BIONIC\n'
      + '#define HAVE_EXECINFO_H 1\n#endif',
  },
  {
    file: 'deps/zlib/zlib.gyp',
    from: '            [\'OS=="mac" or OS=="ios" or OS=="freebsd" or OS=="android"\', {\n'
      + '              # Mac, Android and the BSDs don\'t have fopen64, ftello64, or\n'
      + '              # fseeko64. We use fopen, ftell, and fseek instead on these\n'
      + '              # systems.\n'
      + '              \'defines\': [\n'
      + '                \'USE_FILE32API\'\n'
      + '              ],\n'
      + '            }],',
    to: '            [\'OS=="mac" or OS=="ios" or OS=="freebsd" or OS=="android"\', {\n'
      + '              # Mac, Android and the BSDs don\'t have fopen64, ftello64, or\n'
      + '              # fseeko64. We use fopen, ftell, and fseek instead on these\n'
      + '              # systems.\n'
      + '              \'defines\': [\n'
      + '                \'USE_FILE32API\'\n'
      + '              ],\n'
      + '            }],\n'
      + '            [\'OS=="android"\', {\n'
      + '              \'sources\': [ \'<(ZLIB_ROOT)/cpu-features-android.c\' ],\n'
      + '            }],',
  },
];

export interface BionicNodePin {
  format: 1;
  nodeTag: string;
  nodeSourceUrl: string;
  nodeSourceSha256: string;
  ndkVersion: string;
  ndkUrl: string;
  ndkSizeBytes: number;
  ndkSha1: string;
  ndkSha256: string;
  apiLevel: number;
  abis: readonly ['arm64-v8a', 'x86_64'];
  outputName: string;
  maxPageSize: number;
}

export interface BionicBuildOptions {
  abi: 'arm64-v8a' | 'x86_64';
  ndkDir: string;
  sourceDir: string;
  outDir: string;
  ndkArchive?: string;
  nodeArchive?: string;
  jobs?: number;
  skipConfigure?: boolean;
  hostOptimization?: string;
  hostCc?: string;
  hostCxx?: string;
}

export interface BionicBuildResult {
  abi: string;
  binary: string;
  machine: string;
  interpreter: string;
  minLoadAlign: number;
  sha256: string;
  patches: string[];
}

export interface AndroidElfInfo {
  machine: string;
  interpreter: string;
  minLoadAlign: number;
}

/**
 * Читает закреплённые параметры сборки Bionic Node из ndk.lock.json.
 * Decoder закрытый: лишний ключ, неверный тип или сломанный pin отвергают сборку
 * до обращения к NDK и исходникам, а не после повреждённого артефакта.
 */
export function readBionicNodePin(): BionicNodePin {
  const raw: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('bionic_node_pin_invalid');
  }

  const value = raw as Record<string, unknown>;

  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(pinKeys)) {
    throw new Error('bionic_node_pin_invalid');
  }

  if (value.format !== 1
    || typeof value.nodeTag !== 'string' || !nodeTagPattern.test(value.nodeTag)
    || typeof value.nodeSourceUrl !== 'string' || !httpsUrl.test(value.nodeSourceUrl)
    || typeof value.nodeSourceSha256 !== 'string' || !hex64.test(value.nodeSourceSha256)
    || typeof value.ndkVersion !== 'string' || value.ndkVersion !== 'r28c'
    || typeof value.ndkUrl !== 'string' || !httpsUrl.test(value.ndkUrl)
    || typeof value.ndkSizeBytes !== 'number' || !Number.isSafeInteger(value.ndkSizeBytes)
    || value.ndkSizeBytes <= 0
    || typeof value.ndkSha1 !== 'string' || !hex40.test(value.ndkSha1)
    || typeof value.ndkSha256 !== 'string' || !hex64.test(value.ndkSha256)
    || value.apiLevel !== 30
    || JSON.stringify(value.abis) !== JSON.stringify(['arm64-v8a', 'x86_64'])
    || value.outputName !== 'libnode.so'
    || value.maxPageSize !== 16384) {
    throw new Error('bionic_node_pin_invalid');
  }

  return {
    format: 1,
    nodeTag: value.nodeTag,
    nodeSourceUrl: value.nodeSourceUrl,
    nodeSourceSha256: value.nodeSourceSha256,
    ndkVersion: value.ndkVersion,
    ndkUrl: value.ndkUrl,
    ndkSizeBytes: value.ndkSizeBytes,
    ndkSha1: value.ndkSha1,
    ndkSha256: value.ndkSha256,
    apiLevel: value.apiLevel,
    abis: ['arm64-v8a', 'x86_64'],
    outputName: value.outputName,
    maxPageSize: value.maxPageSize,
  };
}

/**
 * Возвращает закреплённые патчи Bionic-совместимости исходников Node.
 * Каждый патч точный: контекст обязан совпасть, иначе сборка отказывает,
 * а не молча пропускает несовместимость.
 */
export function readBionicPatches() {
  return bionicPatches.map((patch) => ({ ...patch }));
}

/**
 * Применяет закреплённые патчи к дереву исходников идемпотентно: уже patched
 * файл пропускается, отсутствующий контекст останавливает сборку до configure.
 */
export async function applyBionicSourcePatches(sourceDir: string): Promise<string[]> {
  const applied: string[] = [];

  for (const patch of bionicPatches) {
    const file = path.join(sourceDir, patch.file);
    let text: string;

    try {
      text = await fs.readFile(file, 'utf8');
    }
    catch {
      throw new Error('bionic_node_patch_context_missing');
    }

    if (text.includes(patch.to)) {
      continue;
    }

    if (!text.includes(patch.from)) {
      throw new Error('bionic_node_patch_context_missing');
    }

    await fs.writeFile(file, text.replace(patch.from, patch.to));
    applied.push(patch.file);
  }

  return applied;
}

/**
 * Выключает trap-handler на Android безусловно — результат upstream-патча
 * android-patches/trap-handler.h.patch (nodejs/node#36287), применённый
 * программно: контекст hunk расходится с заголовком Node 24.21.0, а линковка
 * node иначе падает на undefined TryHandleSignal/RegisterDefaultTrapHandler.
 * Идемпотентно: уже пропатченный заголовок (без исходного guard-блока) пропускается.
 */
export async function applyTrapHandlerPatch(sourceDir: string): Promise<boolean> {
  const file = path.join(sourceDir, 'deps', 'v8', 'src', 'trap-handler', 'trap-handler.h');
  const text = await fs.readFile(file, 'utf8');
  const start = text.indexOf('#if V8_HOST_ARCH_X64 && V8_TARGET_ARCH_X64');

  if (start < 0) {
    return false;
  }

  const endMarker = '#define V8_TRAP_HANDLER_SUPPORTED false\n#endif';
  const end = text.indexOf(endMarker, start);

  if (end < 0) {
    throw new Error('bionic_node_trap_handler_context_missing');
  }

  const patched = text.slice(0, start)
    + '#define V8_TRAP_HANDLER_SUPPORTED false'
    + text.slice(end + endMarker.length);

  await fs.writeFile(file, patched);

  return true;
}

/**
 * Копирует NDK cpu-features.c в дерево zlib под закреплённым именем:
 * gyp make-генератор не строит правил для абсолютных внешних источников,
 * а zlib/cpu_features.c требует android_getCpuFeatures на Android.
 */
async function copyNdkCpuFeatures(sourceDir: string, ndkDir: string): Promise<void> {
  const from = path.join(ndkDir, 'sources', 'android', 'cpufeatures', 'cpu-features.c');
  const to = path.join(sourceDir, 'deps', 'zlib', 'cpu-features-android.c');

  await fs.copyFile(from, to);
}

/**
 * Закрепляет android_ndk_path в config.gypi: android-configure передаёт переменную
 * только -D-ключом, а регенерация makefile при изменении gyp-файлов читает
 * config.gypi — без записи gyp отказывает (Undefined variable android_ndk_path).
 */
export async function ensureNdkPathVariable(sourceDir: string, ndkDir: string): Promise<void> {
  const file = path.join(sourceDir, 'config.gypi');
  const text = await fs.readFile(file, 'utf8');

  if (text.includes('"android_ndk_path"')) {
    return;
  }

  const anchor = '"variables": {';

  if (!text.includes(anchor)) {
    throw new Error('bionic_node_config_gypi_invalid');
  }

  const resolved = path.resolve(ndkDir);

  await fs.writeFile(file, text.replace(anchor, `${anchor}\n    "android_ndk_path": "${resolved}",`));
}

/**
 * Перепроверяет SHA-256 архива (и размер для NDK) по lock при каждом чтении.
 * Подменённый архив обязан отказывать до распаковки, а не после сломанной сборки.
 */
async function assertArchivePin(file: string, expectedSha256: string, expectedSize?: number) {
  const stat = await fs.stat(file);

  if (expectedSize !== undefined && stat.size !== expectedSize) {
    throw new Error('bionic_node_archive_size_invalid');
  }

  const actual = await sha256File(file);

  if (actual !== expectedSha256) {
    throw new Error('bionic_node_archive_sha256_invalid');
  }
}

/**
 * Читает readelf и отвергает ELF, не пригодный для упаковки в Android APK:
 * чужая машина, не PIE, нулевой entry, отсутствие linker64 или LOAD-выравнивание
 * меньше 16 КиБ (устройства с 16K-страницами).
 */
export async function inspectAndroidElf(
  binary: string,
  abi: string,
  maxPageSize: number,
): Promise<AndroidElfInfo> {
  const { stdout } = await execute('readelf', ['-h', '-l', '-W', binary], {
    maxBuffer: buildLogLimit,
  });
  const expectedMachine = abi === 'arm64-v8a' ? 'AArch64' : 'X86-64';
  const machine = /Machine:\s+(.+)/u.exec(stdout)?.[1].trim() ?? '';
  const type = /Type:\s+(\S+)/u.exec(stdout)?.[1] ?? '';
  const entry = /Entry point address:\s+(0x[0-9a-f]+)/u.exec(stdout)?.[1] ?? '';
  const interpreter = /\[Requesting program interpreter: ([^\]]+)\]/u.exec(stdout)?.[1] ?? '';

  if (!machine.includes(expectedMachine) || type !== 'DYN' || entry === '' || entry === '0x0') {
    throw new Error('bionic_node_elf_machine_invalid');
  }

  if (interpreter !== '/system/bin/linker64') {
    throw new Error('bionic_node_elf_linker_invalid');
  }

  const aligns = [...stdout.matchAll(/^\s+LOAD\s+.*\s(0x[0-9a-f]+)\s*$/gmu)]
    .map((match) => Number.parseInt(match[1], 16));
  // 16 КиБ требуется только arm64 (устройства с 16K-страницами);
  // Android x86_64 использует 4K-страницы — там достаточно 0x1000.
  const minAlign = abi === 'arm64-v8a' ? maxPageSize : 4096;

  if (aligns.length === 0 || aligns.some((align) => align < minAlign)) {
    throw new Error('bionic_node_elf_alignment_invalid');
  }

  return {
    machine,
    interpreter,
    minLoadAlign: Math.min(...aligns),
  };
}

/**
 * Устраняет коллизию host/target правил сгенерированных makefile: gyp пишет
 * host-инструмент (icupkg, torque, mksnapshot…) и его target-двойник в один
 * путь $(builddir)/<tool>, и target-линковка (ARM) затирает host-бинарь —
 * действия сборки падают с 126 на x86-хосте. Host-выход уводится в
 * <tool>-host, target-правило заменяется копией host-бинаря. Патч применяется
 * после configure; gyp-файлы к этому моменту уже пропатчены, регенерации нет.
 */
export async function fixHostToolCollisions(sourceDir: string): Promise<number> {
  const outDir = path.join(sourceDir, 'out');
  const hostFiles: string[] = [];
  const allMkFiles: string[] = [];
  const gypiText = await fs.readFile(path.join(sourceDir, 'config.gypi'), 'utf8');
  const targetArch = /"target_arch": "([a-z0-9]+)"/u.exec(gypiText)?.[1] ?? '';
  const hostArch = process.arch === 'arm64' ? 'arm64' : 'x64';

  // Рекурсивно собирает все *.host.mk сгенерированного дерева out:
  // коллизии host/target возможны в любом подкаталоге (icu, v8, node).
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await walk(full);
      }
      else if (entry.name.endsWith('.host.mk')) {
        hostFiles.push(full);
        allMkFiles.push(full);
      }
      else if (entry.name.endsWith('.mk')) {
        allMkFiles.push(full);
      }
    }
  };

  await walk(outDir);

  // Генераторы (torque, mksnapshot, bytecode-builtins-list…) в gyp make зависят
  // от своего бинаря как от обычного prerequisite: перелинковка бинаря
  // перезапускает действие и регенерирует заголовки, что инвалидирует
  // host/target объекты по кругу. Переводим бинари в order-only (после '|'):
  // порядок сборки сохраняется, mtime бинаря больше не триггерит действие.
  // Имена инструментов берутся из .stamp и cmd_-строк по закрытому списку.
  const generatorToolNames = [
    'torque', 'mksnapshot', 'bytecode_builtins_list_generator', 'gen-regexp-special-case',
    'icupkg', 'genccode', 'genrb', 'gendict', 'gennorm2', 'genbrk', 'gencfu', 'gencnval',
    'gensprep', 'iculslocs', 'makeconv', 'pkgdata', 'gencmn', 'derb', 'uconv',
    'character_data_generator', 'node_js2c',
  ];
  const generatorTool = new RegExp(`\\$\\(builddir\\)/(?:${generatorToolNames.join('|')})\\b`, 'gu');

  for (const mkFile of allMkFiles) {
    const text = await fs.readFile(mkFile, 'utf8');
    const next = text.replace(/^[^\n]*$/gmu, (line) => {
      // Рецепты (tab/пробел в начале) и присваивания ( '=' до ':', включая
      // cmd_-строки с ':' внутри LD_LIBRARY_PATH) не являются правилами —
      // их трогать нельзя, иначе команда действия ломается.
      if (/^\s/u.test(line)) {
        return line;
      }

      const colon = line.indexOf(':');
      const equals = line.indexOf('=');

      if (colon < 0 || (equals >= 0 && equals < colon)) {
        return line;
      }

      const targetPart = line.slice(0, colon + 1);
      let prereqs = line.slice(colon + 1);
      const tools = [...prereqs.matchAll(generatorTool)].map((m) => m[0]);

      if (tools.length === 0) {
        return line;
      }

      prereqs = prereqs.replace(generatorTool, '').replace(/ {2,}/gu, ' ');

      const unique = [...new Set(tools)];

      prereqs = prereqs.includes('|')
        ? `${prereqs} ${unique.join(' ')}`
        : `${prereqs} | ${unique.join(' ')}`;

      return targetPart + prereqs;
    });

    if (next !== text) {
      await fs.writeFile(mkFile, next);
    }
  }

  let fixed = 0;

  for (const hostFile of hostFiles) {
    const original = await fs.readFile(hostFile, 'utf8');
    let host = original;

    // Host-объекты не должны получать target-флаги (ARM -mbranch-protection и
    // подобные): GYP_CFLAGS/GYP_CXXFLAGS в gyp make общие для host/target.
    host = host.replace(/ \$\(CFLAGS_\$\(BUILDTYPE\)\) \$\(CFLAGS_(?:CC|C)_\$\(BUILDTYPE\)\)/gu, '');

    // configure определяет host_arch через CC (target-clang) и записывает его
    // равным target; heap/base/asm обязан собираться под host-архитектуру
    // (mksnapshot исполняется на хосте), а codegen target-архитектуры остаётся.
    if (targetArch && targetArch !== hostArch) {
      host = host.replaceAll(`heap/base/asm/${targetArch}/`, `heap/base/asm/${hostArch}/`);
    }

    const target = /^TARGET := (\S+)$/mu.exec(host)?.[1];

    if (!target || !host.includes(`$(builddir)/${target}:`)) {
      if (host !== original) {
        await fs.writeFile(hostFile, host);
      }

      continue;
    }

    const targetFile = hostFile.replace(/\.host\.mk$/u, '.target.mk');

    try {
      await fs.access(targetFile);
    }
    catch {
      if (host !== original) {
        await fs.writeFile(hostFile, host);
      }

      continue;
    }

    await fs.writeFile(hostFile, host.replaceAll(`$(builddir)/${target}`, `$(builddir)/${target}-host`));
    await fs.writeFile(targetFile, [
      '# Probe patch: host-only tool; target rule copies the host binary.',
      'TOOLSET := target',
      `TARGET := ${target}`,
      `$(builddir)/${target}: $(builddir)/${target}-host`,
      '\tcp $< $@',
      '',
    ].join('\n'));
    fixed += 1;
  }

  return fixed;
}

/**
 * Аргументы make: host-инструменты (icupkg, torque, mksnapshot) обязаны
 * собираться host-компилятором. Configure с CC-окружением запекает target-clang
 * и в CC.host, поэтому host-компилятор переопределяется на командной строке make
 * (командные переменные сильнее ?= в сгенерированном Makefile).
 */
export function bionicMakeArgs(
  jobs: number,
  hostOptimization = '-O2',
  hostCc = 'gcc',
  hostCxx = 'g++',
): string[] {
  return [
    `-j${jobs}`, 'all', `CC.host=${hostCc}`, `CXX.host=${hostCxx}`,
    `CFLAGS.host=${hostOptimization}`, `CXXFLAGS.host=${hostOptimization} -std=gnu++20`,
    // NDK clang не подключает libatomic автоматически; v8 wasm требует
    // 16-байтные атомики (__atomic_compare_exchange) при host-линковке.
    // LIBS в cmd_link стоит после объектов — символы разрешаются;
    // LDFLAGS.host стоял бы до группы и lld отбрасывал бы библиотеку.
    'LIBS=-latomic',
  ];
}

/**
 * Окружение кросс-сборки как в upstream android_configure.py: CC/CXX указывают
 * на NDK clang нужного ABI/API, PATH содержит toolchain bin. Передаётся и в
 * configure, и в make: регенерация makefile с --ignore-environment иначе
 * теряет компилятор и уводит сборку в host-gcc.
 */
export function bionicToolchainEnv(ndkDir: string, abi: string, apiLevel: number) {
  const bin = path.join(ndkDir, 'toolchains', 'llvm', 'prebuilt', 'linux-x86_64', 'bin');
  const prefix = abi === 'arm64-v8a' ? 'aarch64-linux-android' : 'x86_64-linux-android';

  return {
    ...process.env,
    CC: path.join(bin, `${prefix}${apiLevel}-clang`),
    CXX: path.join(bin, `${prefix}${apiLevel}-clang++`),
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
  };
}

/**
 * Кросс-собирает Node закреплённого тега под один Android ABI в чистом дереве
 * исходников и проверяет ELF до упаковки. Выход именуется libnode.so: W^X при
 * targetSdk 36 разрешает исполнение только из nativeLibraryDir APK.
 */
export async function buildBionicNode(options: BionicBuildOptions): Promise<BionicBuildResult> {
  const pin = readBionicNodePin();

  if (!pin.abis.includes(options.abi)) {
    throw new Error('bionic_node_abi_unsupported');
  }

  if (options.ndkArchive) {
    await assertArchivePin(options.ndkArchive, pin.ndkSha256, pin.ndkSizeBytes);
  }

  if (options.nodeArchive) {
    await assertArchivePin(options.nodeArchive, pin.nodeSourceSha256);
  }

  const arch = options.abi === 'arm64-v8a' ? 'arm64' : 'x86_64';
  const jobs = options.jobs ?? 2;
  const hostOptimization = options.hostOptimization ?? '-O2';
  const configure = path.join(options.sourceDir, 'android-configure');

  // v8 помечает функции always_inline; при -O0 g++ отказывает их инлайнить.
  if (hostOptimization === '-O0') {
    throw new Error('bionic_node_host_opt_invalid');
  }

  await copyNdkCpuFeatures(options.sourceDir, options.ndkDir);
  await applyTrapHandlerPatch(options.sourceDir);

  const patches = await applyBionicSourcePatches(options.sourceDir);

  await fs.access(configure);
  await fs.access(path.join(options.ndkDir, 'source.properties'));

  const buildEnv = bionicToolchainEnv(options.ndkDir, options.abi, pin.apiLevel);

  if (!options.skipConfigure) {
    await execute(configure, [options.ndkDir, String(pin.apiLevel), arch], {
      cwd: options.sourceDir,
      maxBuffer: buildLogLimit,
      env: buildEnv,
    });
  }

  await ensureNdkPathVariable(options.sourceDir, options.ndkDir);
  await fixHostToolCollisions(options.sourceDir);

  // config.gypi изменён после configure; без более свежего out/Makefile make
  // регенерирует gyp и затирает патч коллизий host/target правил.
  const makefile = path.join(options.sourceDir, 'out', 'Makefile');

  await fs.utimes(makefile, new Date(), new Date());

  const gypi = await fs.stat(path.join(options.sourceDir, 'config.gypi'));

  if (gypi.size === 0) {
    throw new Error('bionic_node_configure_empty');
  }

  await execute('make', bionicMakeArgs(
    jobs,
    hostOptimization,
    options.hostCc ?? 'gcc',
    options.hostCxx ?? 'g++',
  ), {
    cwd: options.sourceDir,
    maxBuffer: buildLogLimit,
    env: buildEnv,
  });

  const binary = path.join(options.sourceDir, 'out', 'Release', 'node');
  const elf = await inspectAndroidElf(binary, options.abi, pin.maxPageSize);
  const target = path.join(options.outDir, options.abi, pin.outputName);

  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(binary, target);
  await fs.chmod(target, 0o755);

  return {
    abi: options.abi,
    binary: target,
    machine: elf.machine,
    interpreter: elf.interpreter,
    minLoadAlign: elf.minLoadAlign,
    sha256: await sha256File(target),
    patches,
  };
}

/**
 * CLI пробной кросс-сборки: один ABI за вызов, все пути передаются явно,
 * pin берётся только из lock. Результат печатается JSON для журнала пробы.
 */
async function main() {
  const args = process.argv.slice(2);

  // Достаёт значение именованного аргумента CLI: обязательный без значения
  // останавливает сборку до запуска, необязательный даёт undefined.
  const option = (name: string, required: boolean) => {
    const index = args.indexOf(name);

    if (index === -1 || index + 1 >= args.length) {
      if (required) {
        throw new Error(`bionic_node_cli_missing_${name}`);
      }

      return undefined;
    }

    return args[index + 1];
  };
  const abi = option('--abi', true);

  if (abi !== 'arm64-v8a' && abi !== 'x86_64') {
    throw new Error('bionic_node_abi_unsupported');
  }

  const jobsRaw = option('--jobs', false);
  const result = await buildBionicNode({
    abi,
    ndkDir: option('--ndk-dir', true) as string,
    sourceDir: option('--source-dir', true) as string,
    outDir: option('--out-dir', true) as string,
    ndkArchive: option('--ndk-archive', false),
    nodeArchive: option('--node-archive', false),
    jobs: jobsRaw ? Number.parseInt(jobsRaw, 10) : 2,
    skipConfigure: args.includes('--skip-configure'),
    hostOptimization: option('--host-opt', false),
    hostCc: option('--host-cc', false),
    hostCxx: option('--host-cxx', false),
  });

  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}