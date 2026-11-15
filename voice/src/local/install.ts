import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { acquireDirectoryLock } from '../../../shared/node/directoryLock.ts';
import { VoiceError } from '../contract.ts';
import type { RunProcess } from '../process.ts';
import type { LocalPackage } from './catalogs.ts';
import { downloadChecked, sha256OfFile } from './download.ts';
import { synthesizePiperFile, synthesizeSileroFile } from './synthesize.ts';

export interface InstallSpec {
  package: LocalPackage;
  voiceDir: string;
  fetch: typeof fetch;
  run: RunProcess;
  scriptPath(name: 'piperSynth.py' | 'sileroSynth.py'): Promise<string>;
  bootstrapPython?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  downloadTimeoutMs?: number;
  commandTimeoutMs?: number;
  log(message: string): void | Promise<void>;
}

export interface InstallResult {
  engineId: 'piper' | 'silero';
  packageId: string;
  manifestPath: string;
}

interface PackageFile {
  name: string;
  sha256: string;
}

interface Layout {
  engine: string;
  runtimes: string;
  current: string;
  target: string;
  cacheFile: string;
  bytes: number;
  sha256: string;
  files: PackageFile[];
  manifest: Record<string, unknown>;
}

/**
 * Ограничивает имена из каталога одним сегментом до обращения к файловой системе.
 * Пины и зависимости не поступают от CLI; проверка защищает также ошибочную новую запись каталога.
 */
function validatePackage(pack: LocalPackage): void {
  const names = pack.engineId === 'piper'
    ? [pack.id, pack.modelName, pack.configName]
    : [pack.id, pack.fileName, ...pack.speakers.map((speaker) => speaker.id)];

  if (names.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name))) {
    throw new VoiceError('Каталог модели содержит недопустимое имя файла или пакета.');
  }

  if (pack.requirements.length === 0
    || pack.requirements.some((line) => !/^[a-zA-Z0-9_.-]+==[a-zA-Z0-9_.+-]+$/u.test(line))) {
    throw new VoiceError('Каждая зависимость движка должна иметь закреплённую версию.');
  }

  if (pack.engineId === 'silero' && pack.speakers.length === 0) {
    throw new VoiceError('Пакет Silero не содержит ни одного диктора.');
  }
}

/**
 * Составляет пути и manifest из одной записи каталога, а не из старого установленного состояния.
 * Файлы и manifest можно подготовить до публикации, сохраняя public readers неизменными.
 */
function layoutOf(pack: LocalPackage, voiceDir: string): Layout {
  const engine = path.join(voiceDir, 'engines', pack.engineId);
  const common = {
    engine,
    runtimes: path.join(engine, 'runtimes'),
    current: path.join(engine, 'venv'),
  };

  if (pack.engineId === 'piper') {
    return {
      ...common,
      target: path.join(engine, 'voices', pack.id),
      cacheFile: path.join(voiceDir, 'cache', `piper-${pack.id}.tar.gz`),
      bytes: pack.archiveBytes,
      sha256: pack.archiveSha256,
      files: [
        { name: pack.modelName, sha256: pack.modelSha256 },
        { name: pack.configName, sha256: pack.configSha256 },
      ],
      manifest: {
        id: pack.id,
        name: pack.name,
        language: pack.language,
        timbre: pack.timbre,
        model: pack.modelName,
        config: pack.configName,
        sampleRate: pack.sampleRate,
      },
    };
  }

  return {
    ...common,
    target: path.join(engine, 'models', pack.id),
    cacheFile: path.join(voiceDir, 'cache', `silero-${pack.id}.pt`),
    bytes: pack.fileBytes,
    sha256: pack.fileSha256,
    files: [{ name: pack.fileName, sha256: pack.fileSha256 }],
    manifest: {
      id: pack.id,
      name: pack.name,
      language: pack.language,
      file: pack.fileName,
      sampleRate: pack.sampleRate,
      speakers: pack.speakers,
    },
  };
}

/**
 * Отпечаток относится к окружению Python, а не к наличию скачанного архива модели.
 * Смена закреплённых зависимостей создаёт новую generation и никогда не запускает pip в активной.
 */
function runtimeFingerprint(pack: LocalPackage): string {
  const value = JSON.stringify({
    schemaVersion: 1,
    engineId: pack.engineId,
    requirements: [...pack.requirements],
    requirementsIndexUrl: pack.requirementsIndexUrl,
  });

  return createHash('sha256').update(value).digest('hex');
}

/**
 * Для теста срок стадии можно уменьшить одним параметром без подмены результата операции.
 * В обычном запуске venv, pip, import и синтез имеют собственные конечные пределы.
 */
function commandTimeout(spec: InstallSpec, ordinary: number): number {
  const value = spec.commandTimeoutMs ?? ordinary;

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new VoiceError('Срок дочерней команды должен быть положительным числом миллисекунд.');
  }

  return value;
}

/**
 * Проверяет импорты и версии внутри выбранного Python, а не наличие пути bin/python.
 * Последняя строка stdout имеет строгий JSON-контракт, пригодный для независимой fake-фикстуры.
 */
async function probeRuntime(spec: InstallSpec, python: string, signal: AbortSignal): Promise<void> {
  const names = spec.package.engineId === 'piper' ? ['piper', 'onnxruntime'] : ['torch'];
  const expected = Object.fromEntries(spec.package.requirements.map((entry) => entry.split('==')));
  const program = [
    'import importlib, importlib.metadata, json',
    `modules = ${JSON.stringify(names)}`,
    `packages = ${JSON.stringify(Object.keys(expected))}`,
    'for name in modules: importlib.import_module(name)',
    'versions = {name: importlib.metadata.version(name) for name in packages}',
    'print(json.dumps({"versions": versions}, sort_keys=True))',
  ].join('\n');
  const result = await spec.run(python, ['-c', program], {
    input: '',
    timeoutMs: commandTimeout(spec, spec.package.engineId === 'piper' ? 15_000 : 90_000),
    signal,
  });
  const value = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
    versions?: Record<string, unknown>;
  };

  if (!value.versions || Object.keys(value.versions).length !== Object.keys(expected).length
    || Object.entries(expected).some(([name, version]) => value.versions?.[name] !== version)) {
    throw new VoiceError('Состав Python-окружения не совпал с закреплёнными версиями.');
  }
}

/**
 * Принимает только symlink на собственную runtime generation с marker и живой import-проверкой.
 * Обычный каталог venv не удаляется: незнакомое старое состояние требует явного решения владельца.
 */
async function reusableRuntime(
  spec: InstallSpec,
  layout: Layout,
  signal: AbortSignal,
): Promise<string | null> {
  const info = await fs.lstat(layout.current).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return null;
    }

    throw error;
  });

  if (!info) {
    return null;
  }

  if (!info.isSymbolicLink()) {
    throw new VoiceError('Путь venv занят обычным каталогом; его автоматическая замена запрещена.');
  }

  try {
    const root = await fs.realpath(layout.runtimes);
    const runtime = await fs.realpath(layout.current);

    if (path.dirname(runtime) !== root) {
      throw new VoiceError('Ссылка venv указывает за пределы собственных runtime generations.');
    }

    const marker = JSON.parse(await fs.readFile(path.join(runtime, '.voice-runtime.json'), 'utf8')) as {
      schemaVersion?: unknown;
      fingerprint?: unknown;
    };

    if (marker.schemaVersion !== 1 || marker.fingerprint !== runtimeFingerprint(spec.package)) {
      return null;
    }

    await probeRuntime(spec, path.join(runtime, 'bin', 'python'), signal);

    return runtime;
  } catch (error) {
    signal.throwIfAborted();

    if (error instanceof VoiceError && /за пределы/u.test(error.message)) {
      throw error;
    }

    return null;
  }
}

/**
 * Извлекает закреплённые файлы Piper; bare и ./ members разрешаются по точному листингу.
 * Silero переносится как один pinned файл; public модель до приёмки не появляется.
 */
async function stageModel(
  spec: InstallSpec,
  layout: Layout,
  staging: string,
  signal: AbortSignal,
): Promise<void> {
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });

  if (spec.package.engineId === 'piper') {
    const listing = await spec.run('tar', ['-tzf', layout.cacheFile], {
      input: '',
      timeoutMs: commandTimeout(spec, 120_000),
      signal,
    });
    const members = listing.stdout.split('\n').filter(Boolean);
    const selected = [spec.package.modelName, spec.package.configName].map((name) => {
      const matches = members.filter((member) => member.replace(/^(?:\.\/)+/u, '') === name);

      if (matches.length !== 1) {
        throw new VoiceError('В архиве Piper нет однозначного закреплённого файла.');
      }

      return matches[0]!;
    });

    await spec.run('tar', [
      '-xzf', layout.cacheFile,
      '-C', staging,
      '--', ...selected,
    ], {
      input: '',
      timeoutMs: commandTimeout(spec, 120_000),
      signal,
    });
  } else {
    await fs.copyFile(layout.cacheFile, path.join(staging, spec.package.fileName));
  }

  for (const file of layout.files) {
    signal.throwIfAborted();

    const target = path.join(staging, file.name);
    const info = await fs.lstat(target);

    if (!info.isFile() || await sha256OfFile(target, signal) !== file.sha256) {
      throw new VoiceError(`Файл ${file.name} не совпал с закреплённой моделью.`);
    }
  }
}

/**
 * Создаёт новую generation по постоянному имени, чтобы абсолютные shebang venv не менялись.
 * Marker появляется только после pip и import/version probe; активное окружение не затрагивается.
 */
async function prepareRuntime(
  spec: InstallSpec,
  candidate: string,
  work: string,
  signal: AbortSignal,
): Promise<void> {
  await spec.run(spec.bootstrapPython ?? 'python3', ['-m', 'venv', candidate], {
    input: '',
    timeoutMs: commandTimeout(spec, 60_000),
    signal,
  });

  const requirements = path.join(work, 'requirements.txt');

  await fs.writeFile(requirements, `${spec.package.requirements.join('\n')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });

  const args = ['-m', 'pip', 'install', '-r', requirements];

  if (spec.package.requirementsIndexUrl) {
    args.push('--index-url', spec.package.requirementsIndexUrl);
  }

  const python = path.join(candidate, 'bin', 'python');

  await spec.run(python, args, {
    input: '',
    timeoutMs: commandTimeout(spec, 1_200_000),
    signal,
  });
  await probeRuntime(spec, python, signal);
  await fs.writeFile(path.join(candidate, '.voice-runtime.json'), JSON.stringify({
    schemaVersion: 1,
    fingerprint: runtimeFingerprint(spec.package),
  }), { mode: 0o600, flag: 'wx' });
}

/**
 * Приёмка обращается к staged model/config напрямую и не зависит от публичного voice.json.
 * Тот же адаптер проверяет действительный WAV и peak, поэтому mock accept не скрывает разрыв путей.
 */
async function acceptStaged(
  spec: InstallSpec,
  runtime: string,
  staging: string,
  work: string,
  signal: AbortSignal,
): Promise<void> {
  const common = {
    python: path.join(runtime, 'bin', 'python'),
    outputFile: path.join(work, 'accept.wav'),
    text: 'проверка связи',
    pace: 'normal' as const,
    spawn: spec.run,
    signal,
    timeoutMs: commandTimeout(spec, 300_000),
  };

  if (spec.package.engineId === 'piper') {
    await synthesizePiperFile({
      ...common,
      scriptPath: await spec.scriptPath('piperSynth.py'),
      modelFile: path.join(staging, spec.package.modelName),
      configFile: path.join(staging, spec.package.configName),
    });

    return;
  }

  const speaker = spec.package.speakers[0];

  if (!speaker) {
    throw new VoiceError('Пакет Silero не содержит диктора для приёмки.');
  }

  await synthesizeSileroFile({
    ...common,
    scriptPath: await spec.scriptPath('sileroSynth.py'),
    modelFile: path.join(staging, spec.package.fileName),
    speaker: speaker.id,
  });
}

/**
 * Публикует один полностью проверенный файл через собственный sibling, не оставляя partial в target.
 * Старое содержимое сохраняется при отказе копирования; после rename читатель видит целый файл.
 */
async function publishFile(source: string, target: string): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;

  try {
    await fs.copyFile(source, temporary, constants.COPYFILE_EXCL);
    await fs.chmod(temporary, 0o600);
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/**
 * Manifest публикуется после принятой модели, а готовая generation становится активной последней.
 * Собственные временные имена не пересекаются с читателями и не удаляют чужие runtime каталоги.
 */
async function publishInstallation(
  layout: Layout,
  staging: string,
  runtime: string,
  signal: AbortSignal,
  onPublished: () => void,
): Promise<string> {
  signal.throwIfAborted();
  await fs.mkdir(layout.target, { recursive: true, mode: 0o700 });

  for (const file of layout.files) {
    signal.throwIfAborted();
    await publishFile(path.join(staging, file.name), path.join(layout.target, file.name));
  }

  const manifest = path.join(layout.target, 'voice.json');
  const temporaryManifest = `${manifest}.${randomUUID()}.tmp`;
  const temporaryLink = `${layout.current}.${randomUUID()}.tmp`;

  try {
    signal.throwIfAborted();
    await fs.writeFile(temporaryManifest, `${JSON.stringify(layout.manifest)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await fs.rename(temporaryManifest, manifest);
    await fs.symlink(path.relative(layout.engine, runtime), temporaryLink);
    signal.throwIfAborted();
    await fs.rename(temporaryLink, layout.current);
    onPublished();

    return manifest;
  } finally {
    await fs.rm(temporaryManifest, { force: true });
    await fs.rm(temporaryLink, { force: true });
  }
}

/**
 * Установка сериализована общим directory lock: чужой owner и отказ захвата никогда не очищаются.
 * Каждая попытка владеет отдельными staging/runtime; полный архив не означает готового Python.
 */
export async function installLocalEngine(spec: InstallSpec): Promise<InstallResult> {
  validatePackage(spec.package);

  const totalTimeout = spec.timeoutMs ?? 1_800_000;

  if (!Number.isSafeInteger(totalTimeout) || totalTimeout <= 0) {
    throw new VoiceError('Общий срок установки должен быть положительным числом миллисекунд.');
  }

  const signal = AbortSignal.any([
    AbortSignal.timeout(totalTimeout),
    ...(spec.signal ? [spec.signal] : []),
  ]);
  const cache = path.join(spec.voiceDir, 'cache');

  signal.throwIfAborted();
  await fs.mkdir(cache, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(path.join(cache, 'install.lock'), { waitMs: 0 })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'directory_lock_busy') {
        throw new VoiceError('Установка уже идёт; повторите команду после её завершения.');
      }

      throw error;
    });
  const layout = layoutOf(spec.package, spec.voiceDir);
  let work: string | null = null;
  let candidate: string | null = null;
  let published = false;

  try {
    await spec.log(`Проверяю пакет ${spec.package.engineId}/${spec.package.id}.`);
    await downloadChecked({
      url: spec.package.url,
      file: layout.cacheFile,
      expectedBytes: layout.bytes,
      expectedSha256: layout.sha256,
      fetch: spec.fetch,
      signal,
      timeoutMs: spec.downloadTimeoutMs,
    });

    work = await fs.mkdtemp(path.join(cache, 'install-'));

    const staging = path.join(work, 'model');

    await stageModel(spec, layout, staging, signal);
    await fs.mkdir(layout.runtimes, { recursive: true, mode: 0o700 });

    let runtime = await reusableRuntime(spec, layout, signal);

    if (!runtime) {
      candidate = path.join(layout.runtimes, randomUUID());
      await spec.log('Создаю отдельное Python-окружение и ставлю закреплённые зависимости.');
      await prepareRuntime(spec, candidate, work, signal);
      runtime = candidate;
    }

    await spec.log('Проверяю модель контрольной фразой.');
    await acceptStaged(spec, runtime, staging, work, signal);

    const manifestPath = await publishInstallation(layout, staging, runtime, signal, () => {
      published = true;
    });

    return {
      engineId: spec.package.engineId,
      packageId: spec.package.id,
      manifestPath,
    };
  } catch (error) {
    if (signal.aborted) {
      throw new VoiceError(spec.signal?.aborted ? 'Установка отменена.' : 'Истёк общий срок установки.');
    }

    throw error;
  } finally {
    // RunProcess ждёт close; свой неактивный candidate уже не используется этим вызовом.
    // После SIGKILL finally не исполняется: orphan остаётся отдельной неопубликованной generation.
    try {
      if (candidate && !published) {
        await fs.rm(candidate, { recursive: true, force: true });
      }

      if (work) {
        await fs.rm(work, { recursive: true, force: true });
      }
    } finally {
      await lock.release();
    }
  }
}
