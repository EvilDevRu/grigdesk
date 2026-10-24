import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { deepSeekPackagePaths } from '../../deepseek/scripts/paths.ts';
import { acquireDirectoryLock } from '../../shared/node/directoryLock.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';
import { sha256 } from '../../shared/node/hash.ts';

interface PreparationOptions {
  sourceDirectory?: string;
  install?: (directory: string, npmCache: string, logFile: string) => Promise<void>;
}

interface DependencyStamp {
  format: number;
  nodeVersion: string;
  abi: string;
  platform: string;
  arch: string;
  manifest: string;
  lock: string;
}

const run = promisify(execFile);
const PROBE_PACKAGES = ['typescript', 'esbuild', 'sharp', 'koffi', 'node-pty'];

/**
 * Exact lock проверяется для всех прямых пакетов, а native-модули загружает тот же Node, что тесты.
 * Наличие одной папки node_modules не доказывает завершённую установку и совместимость ABI.
 */
async function verifyDependencies(directory: string, expectedLock: Buffer): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'package.json'), 'utf8'));
  const lock = JSON.parse(expectedLock.toString('utf8'));
  const dependencies = Object.keys(manifest.dependencies ?? {});

  for (const name of dependencies) {
    const installed = JSON.parse(await fs.readFile(path.join(directory, 'node_modules', name,
      'package.json'), 'utf8'));
    const expected = lock.packages?.[`node_modules/${name}`]?.version;

    if (!expected || installed.version !== expected) {
      throw new Error(`Legacy-зависимость ${name} не соответствует exact lock`);
    }
  }

  const probe = `
    const { createRequire } = require('node:module');
    const load = createRequire(process.argv[1]);
    for (const name of JSON.parse(process.argv[2])) {
      load(name);
    }
  `;

  await run(process.execPath, ['-e', probe, path.join(directory, 'package.json'),
    JSON.stringify(PROBE_PACKAGES.filter((name) => dependencies.includes(name)))], {
    cwd: directory,
    env: { PATH: path.dirname(process.execPath) },
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
}

/**
 * Marker, точные manifests и загрузка native-пакетов проверяются перед каждым использованием prefix.
 * Повреждённый или незавершённый собственный кэш перестраивается автоматически под его lock.
 */
async function prepared(directory: string, stamp: DependencyStamp,
  manifest: Buffer, lock: Buffer): Promise<boolean> {
  try {
    const saved = JSON.parse(await fs.readFile(path.join(directory, '.prepared.json'), 'utf8'));
    const savedManifest = await fs.readFile(path.join(directory, 'package.json'));
    const savedLock = await fs.readFile(path.join(directory, 'package-lock.json'));

    if (JSON.stringify(saved) !== JSON.stringify(stamp)
      || !savedManifest.equals(manifest) || !savedLock.equals(lock)) {
      return false;
    }

    await verifyDependencies(directory, lock);

    return true;
  } catch {
    return false;
  }
}

/**
 * npm запускается текущим Node, lifecycle-скрипты получают его первым в PATH.
 * HOME и журналы принадлежат тестовому кэшу; пользовательский npmrc не читается.
 */
async function installDependencies(directory: string, npmCache: string, logFile: string): Promise<void> {
  const npm = await fs.realpath(path.join(path.dirname(process.execPath), 'npm'));
  const home = path.join(path.dirname(npmCache), 'legacy-build-home');
  const temporary = path.join(home, 'tmp');

  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });

  try {
    const result = await run(process.execPath, [npm, 'ci', '--include=dev', '--prefix', directory,
      '--cache', npmCache, '--prefer-offline', '--no-audit', '--no-fund'], {
      cwd: directory,
      env: {
        PATH: [path.dirname(process.execPath), process.env.PATH].filter(Boolean).join(path.delimiter),
        HOME: home,
        TMPDIR: temporary,
        NPM_CONFIG_USERCONFIG: '/dev/null',
        NODE_ENV: 'production',
        LANG: 'C.UTF-8',
      },
      timeout: 300000,
      maxBuffer: 4 * 1024 * 1024,
    });

    await fs.writeFile(logFile, result.stdout + result.stderr, { mode: 0o600 });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };

    await fs.writeFile(logFile, `${failure.message}\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`, {
      mode: 0o600,
    });

    throw error;
  }
}

/**
 * Холодный запуск сам готовит legacy prefix; ключ разделяет exact lock, Node, ABI и платформу.
 * Публикуется только проверенный staging, параллельные вызовы переиспользуют один результат.
 */
export async function prepareLegacyDeepSeekDependencies(
  artifactsRoot: string,
  options: PreparationOptions = {},
): Promise<string> {
  if (!path.isAbsolute(artifactsRoot)) {
    throw new Error('Legacy-кэш тестов DeepSeek требует абсолютный корень артефактов');
  }

  const source = options.sourceDirectory ?? deepSeekPackagePaths().runtimeDependenciesDir;
  const manifest = await fs.readFile(path.join(source, 'package.json'));
  const lockBytes = await fs.readFile(path.join(source, 'package-lock.json'));
  const stamp = {
    format: 1,
    nodeVersion: process.versions.node,
    abi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    manifest: sha256(manifest),
    lock: sha256(lockBytes),
  };
  const parent = path.join(artifactsRoot, 'deepseek-vendoring', 'legacy-dependencies');
  const directory = path.join(parent, sha256(JSON.stringify(stamp)));
  const logFile = `${directory}.log`;

  await fs.mkdir(parent, { recursive: true, mode: 0o700 });

  const lock = await acquireDirectoryLock(`${directory}.lock`, { waitMs: 900000 });

  try {
    if (await prepared(directory, stamp, manifest, lockBytes)) {
      return directory;
    }

    process.stderr.write(`Подготовка окружения теста миграции DeepSeek: Node ${stamp.nodeVersion}, `
      + `ABI ${stamp.abi}; журнал ${logFile}\n`);

    try {
      await withWorkDirectory(parent, async (work) => {
        await fs.writeFile(path.join(work, 'package.json'), manifest);
        await fs.writeFile(path.join(work, 'package-lock.json'), lockBytes);

        const npmCache = path.join(process.env.GRIGDESK_DEEPSEEK_NODE_CACHE
          ?? path.join(artifactsRoot, 'node-cache'), 'npm-cache');

        await (options.install ?? installDependencies)(work, npmCache, logFile);
        await verifyDependencies(work, lockBytes);
        await fs.writeFile(path.join(work, '.prepared.json'), JSON.stringify(stamp), { mode: 0o600 });
        await fs.rm(directory, { recursive: true, force: true });
        await fs.rename(work, directory);
      });
    } catch (error) {
      await fs.appendFile(logFile, `\n${String(error)}\n`, { mode: 0o600 });

      throw new Error('Автоподготовка окружения теста миграции DeepSeek не удалась '
        + `(Node ${stamp.nodeVersion}, ABI ${stamp.abi}); журнал ${logFile}`, { cause: error });
    }

    return directory;
  } finally {
    await lock.release();
  }
}
