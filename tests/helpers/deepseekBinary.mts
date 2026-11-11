import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { decodeDeepSeekRuntimeInfo, type DeepSeekRuntimeInfo } from '../../shared/chat/deepSeekBinary.ts';
import { canonicalJson } from '../../shared/lib/canonicalJson.ts';
import {
  cleanupArtifacts, DEFAULT_ARTIFACT_RETENTION_MS, DEFAULT_KEEP_GENERATIONS,
  parseArtifactRetention, parseKeepGenerations,
} from '../../shared/node/artifactsCleanup.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { glmCompatibilityHash } from '../../shared/node/glmCompatibility.ts';
import { removePrivateTree } from '../../shared/node/files.ts';
import { sha256, sha256File } from '../../shared/node/hash.ts';
import { nodeArchive } from '../../shared/node/seaBuild.ts';
import { artifactsPath } from '../../shared/runtime/dataHome.ts';
import { binaryPackageInputs } from '../../deepseek/scripts/binaryInputs.mts';
import { deepSeekBuildInputs } from '../../deepseek/scripts/buildRuntime.mts';
import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';
import {
  readPreparedRuntimeDependencies,
  type PreparedRuntimeDependencies,
} from '../../deepseek/scripts/prepareRuntimeDeps.mts';

const run = promisify(execFile);
const repository = fileURLToPath(new URL('../..', import.meta.url));

export interface TestDeepSeekBinary {
  binary: string;
  cacheDir: string;
  info: DeepSeekRuntimeInfo;
  payloadFile: string;
}

/**
 * Metadata и полный verify исполняются на готовом ELF с пустым PATH и без пользовательского HOME.
 * Один cache принадлежит candidate и переиспользуется всеми его настоящими процессами.
 */
async function checked(binary: string, cacheDir: string, payloadFile: string): Promise<TestDeepSeekBinary> {
  const metadata = await run(binary, ['--runtime-info', '--json'], {
    env: { PATH: '' },
    timeout: 30000,
  });
  const info = decodeDeepSeekRuntimeInfo(JSON.parse(metadata.stdout));
  const verified = await run(binary, ['--cache-dir', cacheDir, '--verify', '--json'], {
    env: { PATH: '' },
    timeout: 120000,
  });
  const proof = JSON.parse(verified.stdout);

  if (metadata.stderr || verified.stderr || proof.packageId !== info.packageId || proof.verified !== true) {
    throw new Error('Настоящий test DeepSeek binary не подтвердил integrity');
  }

  return {
    binary,
    cacheDir,
    info,
    payloadFile,
  };
}

/**
 * Сборка видит только приватную копию пакета и shared; server и исходное дерево ей не нужны.
 * После публикации ELF копия удаляется до первого запуска candidate тестом.
 */
async function buildCandidate(
  directory: string,
  cache: string,
  args: string[],
  testCompatibility?: object,
): Promise<string> {
  const source = await fs.mkdtemp(path.join(directory, 'source-'));
  const log = path.join(directory, 'build.log');

  try {
    await fs.cp(path.join(repository, 'deepseek'), path.join(source, 'deepseek'), {
      recursive: true,
      filter: (file) => !['node_modules', '.cache', '.git'].includes(path.basename(file)),
    });
    await fs.cp(path.join(repository, 'shared'), path.join(source, 'shared'), { recursive: true });
    await fs.symlink(path.join(repository, 'deepseek/node_modules'),
      path.join(source, 'deepseek/node_modules'));

    if (testCompatibility) {
      await fs.writeFile(path.join(source, 'deepseek/compatibility/glm.json'),
        JSON.stringify(testCompatibility), { mode: 0o600 });
    }

    const result = await run(process.execPath, [path.join(source, 'deepseek/scripts/buildBinary.mts'),
      '--out-dir', path.join(directory, 'bin'), '--node-cache-dir', cache, ...args], {
      cwd: directory,
      timeout: 900000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        NODE_OPTIONS: '--max-old-space-size=1024',
      },
    });

    await fs.writeFile(log, result.stderr, { mode: 0o600 });

    const manifest = JSON.parse(result.stdout);

    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });

    return path.join(cache, 'payloads', manifest.payload.sha256, 'payload.zip');
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    const details = `${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`;

    await fs.writeFile(log, details, {
      mode: 0o600,
    });

    throw new Error(`Сборка test DeepSeek binary отказала; журнал ${log}\n${details.slice(-8192)}`, {
      cause: error,
    });
  } finally {
    await fs.rm(source, { recursive: true, force: true });
  }
}

/**
 * CI может хранить suite fixtures внутри темы, а общий pinned cache выбирать отдельно.
 * Явный root относится только к тестовым артефактам и не меняет default runtime приложения.
 */
export function deepSeekTestArtifactsRoot(): string {
  const directory = process.env.GRIGDESK_TEST_DEEPSEEK_ROOT
    ?? path.join(artifactsPath({ env: process.env, home: os.homedir() }), 'deepseek-binary');

  if (!path.isAbsolute(directory) || path.resolve(directory) === path.parse(directory).root) {
    throw new Error('Test DeepSeek root должен быть абсолютным');
  }

  return path.resolve(directory);
}

/**
 * Source-проверки и binary candidate читают один явно подготовленный prefix pinned Node.
 * Общий verifier проверяет stamp и exact lock; helper не устанавливает зависимости.
 */
export async function testDeepSeekRuntimeDependencies(): Promise<
  PreparedRuntimeDependencies & { cacheDir: string }
> {
  const root = deepSeekTestArtifactsRoot();
  const cacheDir = process.env.GRIGDESK_DEEPSEEK_NODE_CACHE ?? path.join(root, 'node-cache');
  const dependencies = await readPreparedRuntimeDependencies(cacheDir);

  return { ...dependencies, cacheDir };
}

/**
 * Ключ включает собственный пакет и проверенные входы generation, без UI и ABI Node сервера.
 * Зависимости должны быть явно подготовлены; helper не запускает npm и не загружает архив.
 */
async function candidateRoot(): Promise<{ directory: string; cache: string }> {
  const root = deepSeekTestArtifactsRoot();
  const dependencies = await testDeepSeekRuntimeDependencies();
  const cache = dependencies.cacheDir;
  const pinFile = path.join(repository, 'deepseek/build/node-runtime.json');
  const pin = JSON.parse(await fs.readFile(pinFile, 'utf8'));

  const archiveValid = await sha256File(path.join(cache, nodeArchive(pin).name))
    .then((digest) => digest === pin.sha256, () => false);

  if (!archiveValid) {
    throw new Error('Подготовьте архив pinned Node: npm --prefix deepseek run prepare:runtime -- '
      + `--node-cache-dir ${cache}`);
  }

  const generation = await deepSeekBuildInputs(deepSeekPackagePaths().vendorDir, dependencies.directory);
  const identity = sha256(canonicalJson({
    package: await binaryPackageInputs(),
    generation: { source: generation.source, hashes: generation.hashes },
    worker: { version: dependencies.version, abi: dependencies.abi },
  }));
  const directory = path.join(root, 'test-builds', identity);

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  return { directory, cache };
}

/**
 * После SIGKILL собственная source-копия могла остаться уже рядом с опубликованным ELF.
 * Уборка выполняется только под build lock и касается точных имён mkdtemp этого helper.
 */
async function removeAbandonedSourceCopies(directory: string): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && /^source-[A-Za-z0-9]{6}$/u.test(entry.name)) {
      await removePrivateTree(path.join(directory, entry.name));
    }
  }
}

/**
 * Несуществующий cache разрешается через ближайшего существующего предка без создания папок.
 * Так ссылка внутри test root на внешний cache не разрешает helper менять внешнее дерево.
 */
async function resolvedTestPath(directory: string): Promise<string> {
  try {
    return await fs.realpath(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(directory) === directory) {
      throw error;
    }

    return path.join(await resolvedTestPath(path.dirname(directory)), path.basename(directory));
  }
}

/**
 * Один настоящий candidate собирается под lock и использует общий прогретый test cache.
 * Явный override тоже проходит metadata и полный verify, без обхода integrity.
 */
export async function ensureTestDeepSeekBinary(): Promise<TestDeepSeekBinary> {
  const root = deepSeekTestArtifactsRoot();
  const retention = process.env.GRIGDESK_TEST_DEEPSEEK_RETENTION;
  const generations = process.env.GRIGDESK_TEST_DEEPSEEK_KEEP_GENERATIONS;
  const olderThanMs = retention === undefined
    ? DEFAULT_ARTIFACT_RETENTION_MS : parseArtifactRetention(retention);
  const keepGenerations = generations === undefined
    ? DEFAULT_KEEP_GENERATIONS : parseKeepGenerations(generations);
  const explicit = process.env.GRIGDESK_TEST_DEEPSEEK_BINARY;
  let directory: string;
  let cache: string;
  let explicitBinary = '';
  let explicitPayload = '';

  if (explicit) {
    explicitBinary = path.resolve(explicit);
    directory = process.env.GRIGDESK_TEST_DEEPSEEK_CACHE_DIR
      ?? path.join(root, 'explicit-cache', sha256(explicitBinary));
    explicitPayload = process.env.GRIGDESK_TEST_DEEPSEEK_PAYLOAD ?? '';
    cache = '';

    if (!path.isAbsolute(directory) || explicitPayload && !path.isAbsolute(explicitPayload)) {
      throw new Error('Test cache и payload требуют абсолютные пути');
    }
  } else {
    ({ directory, cache } = await candidateRoot());
  }

  const canonicalRoot = await resolvedTestPath(root);
  const canonicalDirectory = await resolvedTestPath(directory);
  const relative = path.relative(canonicalRoot, canonicalDirectory);
  const internal = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
  const lockPath = `${internal ? canonicalDirectory : canonicalRoot}.lock`;
  const protectedPaths = [canonicalDirectory];

  if (cache) {
    protectedPaths.push(path.resolve(cache), await resolvedTestPath(cache));
  }

  for (const file of [explicitBinary, explicitPayload].filter(Boolean)) {
    protectedPaths.push(file, await resolvedTestPath(file));
  }

  await fs.mkdir(internal ? path.dirname(canonicalDirectory) : canonicalRoot, {
    recursive: true,
    mode: 0o700,
  });

  const lock = await acquireDirectoryLock(lockPath, { waitMs: 900000 });

  try {
    if (internal) {
      await fs.mkdir(canonicalDirectory, { recursive: true, mode: 0o700 });
      await fs.utimes(canonicalDirectory, new Date(), new Date());
    }

    const report = await cleanupArtifacts({
      root: canonicalRoot,
      scope: 'deepseek-tests',
      olderThanMs,
      keepGenerations,
      heldLock: { path: lockPath, owner: lock.owner },
      protectedPaths,
    });
    const deleted = report.entries.filter((entry) => entry.status === 'deleted');

    if (deleted.length) {
      process.stderr.write(`Уборка DeepSeek: удалено каталогов ${deleted.length}, `
        + `байт ${report.freedBytes}\n`);
    }

    if (report.errorCount) {
      const errors = report.entries.filter((entry) => entry.status === 'error')
        .map((entry) => `${entry.path}: ${entry.reason}`).join('; ');

      process.stderr.write(`Ошибка уборки DeepSeek: ${errors}\n`);

      throw new Error(`Уборка DeepSeek отказала: ${errors}`);
    }

    if (explicit) {
      return await checked(explicitBinary, directory, explicitPayload);
    }

    await removeAbandonedSourceCopies(directory);

    const binary = path.join(directory, 'bin/deepseek');
    const exists = await fs.access(binary).then(() => true, () => false);
    const payloadFile = exists
      ? path.join(cache, 'payloads', JSON.parse(await fs.readFile(
        path.join(directory, 'manifest.json'), 'utf8',
      )).payload.sha256, 'payload.zip')
      : await buildCandidate(directory, cache, []);

    return await checked(binary, path.join(directory, 'cache'), payloadFile);
  } finally {
    await lock.release();
  }
}

/**
 * B переиспользует архив A с иной версией поставки, generation не пересобирается.
 * Оба ELF имеют один прогретый cache root, но разные packages по packageId.
 */
export async function ensureTestDeepSeekBinaryPair(): Promise<{
  a: TestDeepSeekBinary;
  b: TestDeepSeekBinary;
}> {
  const a = await ensureTestDeepSeekBinary();

  if (!a.payloadFile) {
    throw new Error('Пара A/B требует payload локального candidate; снимите explicit binary override');
  }

  const directory = path.join(a.cacheDir, 'test-variants', 'version-b');
  const { cache } = await candidateRoot();

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(`${directory}.lock`, { waitMs: 900000 });

  try {
    await removeAbandonedSourceCopies(directory);

    const binary = path.join(directory, 'bin/deepseek');

    if (!await fs.access(binary).then(() => true, () => false)) {
      await buildCandidate(directory, cache, ['--binary-version', `${a.info.binaryVersion}-test-b`,
        '--payload', a.payloadFile]);
    }

    return { a, b: await checked(binary, a.cacheDir, a.payloadFile) };
  } finally {
    await lock.release();
  }
}

/**
 * Положительный и отрицательный выпуски задают admission в приватной копии builder.
 * Допуск production больше не определяет исход отрицательного теста установщика.
 */
async function ensureTestDeepSeekAdmission(admitted: boolean): Promise<TestDeepSeekBinary> {
  const base = await ensureTestDeepSeekBinary();
  const plugin = base.info.glm.inputs.llmPiAi;

  if (!plugin || !base.payloadFile) {
    throw new Error('Тестовый admitted ELF требует реальный plugin и локальный payload');
  }

  const compatibility = {
    format: 1,
    profileRevision: base.info.glm.profileRevision,
    policyRevision: base.info.glm.policyRevision,
    admission: admitted ? [{
      mode: 'api',
      compatibility: glmCompatibilityHash({ ...base.info.glm.inputs, llmPiAi: plugin }, 'api', {
        profile: base.info.glm.profileRevision,
        policy: base.info.glm.policyRevision,
      }),
    }] : [],
  };
  const variant = admitted ? 'install-admitted' : 'install-unadmitted';
  const directory = path.join(base.cacheDir, 'test-variants', base.info.packageId, variant);
  const { cache } = await candidateRoot();

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(`${directory}.lock`, { waitMs: 900000 });

  try {
    await removeAbandonedSourceCopies(directory);

    const binary = path.join(directory, 'bin/deepseek');

    if (!await fs.access(binary).then(() => true, () => false)) {
      await buildCandidate(directory, cache, [
        '--binary-version', `${base.info.binaryVersion}-test-${variant}`, '--payload', base.payloadFile,
      ], compatibility);
    }

    return await checked(binary, base.cacheDir, base.payloadFile);
  } finally {
    await lock.release();
  }
}

/**
 * Настоящий положительный ELF имеет вычисленный допуск именно своего payload.
 * Производственный файл compatibility не изменяется во время подготовки фикстуры.
 */
export async function ensureTestAdmittedDeepSeekBinary(): Promise<TestDeepSeekBinary> {
  return ensureTestDeepSeekAdmission(true);
}

/**
 * Отрицательный ELF явно не содержит admission независимо от допуска рабочей поставки.
 * Он нужен для проверки отказа установщика после успешной живой приёмки production.
 */
export async function ensureTestUnadmittedDeepSeekBinary(): Promise<TestDeepSeekBinary> {
  return ensureTestDeepSeekAdmission(false);
}

/**
 * Обе версии несут настоящий api admission только внутри тестовой копии поставки.
 * Разные packageId проходят тот же installer, что использует владелец при замене и откате.
 */
export async function ensureTestAdmittedDeepSeekBinaryPair(): Promise<{
  a: TestDeepSeekBinary;
  b: TestDeepSeekBinary;
}> {
  const a = await ensureTestAdmittedDeepSeekBinary();
  const directory = path.join(a.cacheDir, 'test-variants', 'install-admitted-b');
  const { cache } = await candidateRoot();
  const compatibility = {
    format: 1,
    profileRevision: a.info.glm.profileRevision,
    policyRevision: a.info.glm.policyRevision,
    admission: a.info.glm.admission,
  };

  await fs.mkdir(directory, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(`${directory}.lock`, { waitMs: 900000 });

  try {
    await removeAbandonedSourceCopies(directory);

    const binary = path.join(directory, 'bin/deepseek');

    if (!await fs.access(binary).then(() => true, () => false)) {
      await buildCandidate(directory, cache, [
        '--binary-version', `${a.info.binaryVersion}-test-b`, '--payload', a.payloadFile,
      ], compatibility);
    }

    return { a, b: await checked(binary, a.cacheDir, a.payloadFile) };
  } finally {
    await lock.release();
  }
}

/**
 * Общие compiled тесты получают конфигурацию ELF и его проверенный распакованный payload.
 * Generation нужна только для closure/fixtures; production запускается исключительно через binary.
 */
export async function testDeepSeekBinarySelection() {
  const candidate = await ensureTestDeepSeekBinary();
  const packageRoot = path.join(candidate.cacheDir, 'packages', candidate.info.packageId);

  return {
    candidate,
    generation: path.join(packageRoot, 'generation'),
    worker: path.join(packageRoot, 'node'),
    config: {
      deepseekRuntimeMode: 'binary' as const,
      deepseekBin: candidate.binary,
      deepseekCacheDir: candidate.cacheDir,
    },
  };
}


if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.length > 1 || args.length === 1 && args[0] !== '--prepare-suite') {
    throw new Error('Использование: deepseekBinary.mts [--prepare-suite]');
  }

  const candidate = await ensureTestDeepSeekBinary();

  if (args[0] === '--prepare-suite') {
    await ensureTestDeepSeekBinaryPair();
    await ensureTestAdmittedDeepSeekBinaryPair();
  }

  process.stdout.write(`${JSON.stringify(candidate)}\n`);
}
