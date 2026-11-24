import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  componentNodeRuntimeManifest, ensureNodeArchive, readTargetNodeRuntime, seaHostTarget, type NodeRuntime,
} from '../../shared/node/nodeRuntime.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { downloadFile } from '../../shared/node/seaBuild.ts';
import { deepSeekPackagePaths } from './paths.ts';

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));

export interface PreparedRuntimeDependencies {
  directory: string;
  node: string;
  version: string;
  abi: string;
  nodeSha256: string;
}

function runtimeCache(cacheDir: string, pin: NodeRuntime) {
  return path.join(cacheDir, `${pin.platform}-${pin.sha256}`);
}

/**
 * Готовность dependencies доказывается stamp того же pinned Node и точными package/lock.
 * Отсутствующая подготовка даёт команду, а обычная сборка не запускает npm незаметно.
 */
export async function readPreparedRuntimeDependencies(
  cacheDir: string,
): Promise<PreparedRuntimeDependencies> {
  const target = seaHostTarget();
  const pin = await readTargetNodeRuntime(componentNodeRuntimeManifest(packageDir, target), target);
  const root = runtimeCache(cacheDir, pin);
  const directory = path.join(root, 'runtime-deps-node24');
  const node = path.join(root, 'node-runtime/bin/node');

  try {
    const stamp = JSON.parse(await readFile(path.join(directory, '.prepared.json'), 'utf8'));

    if (stamp.version !== pin.version || stamp.archiveSha256 !== pin.sha256
      || (target === 'darwin-arm64' || stamp.target !== undefined) && stamp.target !== target
      || typeof stamp.abi !== 'string' || stamp.nodeSha256 !== await sha256File(node)) {
      throw new Error('stamp');
    }

    for (const name of ['package.json', 'package-lock.json']) {
      const expected = await sha256File(path.join(deepSeekPackagePaths().runtimeDependenciesDir, name));

      if (stamp[name] !== expected || await sha256File(path.join(directory, name)) !== expected) {
        throw new Error('lock');
      }
    }

    await readFile(path.join(directory, 'node_modules/typescript/package.json'));
    await readFile(path.join(directory, 'node_modules/esbuild/package.json'));

    return {
      directory,
      node,
      version: stamp.version,
      abi: stamp.abi,
      nodeSha256: stamp.nodeSha256,
    };
  } catch {
    throw new Error('Подготовьте dependencies pinned Node: npm --prefix deepseek run prepare:runtime -- '
      + `--node-cache-dir ${cacheDir}`);
  }
}

/**
 * Явная подготовка устанавливает exact runtime lock обычным pinned Node в отдельный prefix.
 * Legacy dependencies не изменяются; HOME, npm cache и временные файлы принадлежат сборке.
 */
export async function prepareRuntimeDependencies(cacheDir: string): Promise<PreparedRuntimeDependencies> {
  const target = seaHostTarget();
  const pin = await readTargetNodeRuntime(componentNodeRuntimeManifest(packageDir, target), target);
  const archive = await ensureNodeArchive(pin, cacheDir, { download: downloadFile });
  const root = runtimeCache(cacheDir, pin);
  const nodeRoot = path.join(root, 'node-runtime');
  const directory = path.join(root, 'runtime-deps-node24');

  try {
    return await readPreparedRuntimeDependencies(cacheDir);
  } catch {
    // Этот явный шаг вправе переустановить свой prefix; обычный build лишь отказывает.
  }

  const nodeExists = await readFile(path.join(nodeRoot, 'bin/node')).then(() => true, () => false);

  if (!nodeExists) {
    await withWorkDirectory(root, async (work) => {
      await run('tar', ['-xJf', archive, '--strip-components=1'], { cwd: work });
      await rename(work, nodeRoot);
    });
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const stamp: Record<string, string> = {};

  for (const name of ['package.json', 'package-lock.json']) {
    const source = path.join(deepSeekPackagePaths().runtimeDependenciesDir, name);

    await copyFile(source, path.join(directory, name));
    stamp[name] = await sha256File(source);
  }

  const home = path.join(root, 'build-home');
  const temporary = path.join(root, 'tmp');

  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(temporary, { recursive: true, mode: 0o700 });

  const node = path.join(nodeRoot, 'bin/node');
  const environment = {
    HOME: home,
    PATH: `${path.join(nodeRoot, 'bin')}:/usr/bin:/bin`,
    TMPDIR: temporary,
    XDG_CACHE_HOME: path.join(root, 'build-cache'),
    NPM_CONFIG_USERCONFIG: '/dev/null',
    NODE_ENV: 'production',
    LANG: 'C.UTF-8',
  };
  const identitySource = 'JSON.stringify({ version: process.versions.node, abi: process.versions.modules, '
    + 'platform: process.platform, arch: process.arch })';
  const identity = JSON.parse((await run(node, ['--print', identitySource], {
    env: environment,
  })).stdout);

  if (identity.version !== pin.version || typeof identity.abi !== 'string'
    || seaHostTarget(identity.platform, identity.arch) !== target) {
    throw new Error('Версия подготовленного Node не совпадает с pin');
  }

  const npm = path.join(nodeRoot, 'lib/node_modules/npm/bin/npm-cli.js');
  const result = await run(node, [npm, 'ci', '--include=dev', '--prefix', directory,
    '--cache', path.join(root, 'npm-cache'), '--prefer-offline', '--no-audit', '--no-fund'], {
    env: environment,
    timeout: 300000,
    maxBuffer: 4 * 1024 * 1024,
  });

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  await writeFile(path.join(directory, '.prepared.json'), JSON.stringify({
    ...stamp,
    version: identity.version,
    abi: identity.abi,
    nodeSha256: await sha256File(node),
    archiveSha256: pin.sha256,
    target,
  }), { mode: 0o600 });

  return readPreparedRuntimeDependencies(cacheDir);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const valid = args.length === 0 || args.length === 2 && args[0] === '--node-cache-dir' && args[1];

  if (!valid) {
    process.stderr.write('Использование: prepareRuntimeDeps.mts [--node-cache-dir <каталог>]\n');
    process.exitCode = 2;
  } else {
    const cache = path.resolve(args[1] ?? path.join(packageDir, '.cache'));

    await prepareRuntimeDependencies(cache).then((prepared) => {
      process.stdout.write(`${JSON.stringify(prepared)}\n`);
    }, (error: unknown) => {
      process.stderr.write(`Подготовка DeepSeek не удалась: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
  }
}
