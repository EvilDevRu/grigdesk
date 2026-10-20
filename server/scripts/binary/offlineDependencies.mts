import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { InstallDependenciesInput } from '../sea/dependencies.mts';

const run = promisify(execFile);

/**
 * Подготовленные приватные пакеты копируются строго по production части lock.
 * Версия каждого пакета сверяется до копирования, dev и вложние лишние npm исключены.
 */
export async function copyProductionDependencies(input: {
  sourceRoot: string;
  stageRoot: string;
}): Promise<void> {
  const source = path.join(input.sourceRoot, 'server');
  const target = path.join(input.stageRoot, 'server');
  const lock = JSON.parse(await readFile(path.join(source, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, {
      version?: string;
      dev?: boolean;
      link?: boolean;
    }>;
  };

  await mkdir(target, { recursive: true });

  for (const [relative, entry] of Object.entries(lock.packages).sort()) {
    if (!relative || entry.dev) {
      continue;
    }

    if (entry.link || !relative.startsWith('node_modules/')
      || relative.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error(`Некорректный production lock: ${relative}`);
    }

    const directory = path.join(source, relative);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));

    if (manifest.version !== entry.version) {
      throw new Error(`Версия приватного пакета не совпала с lock: ${relative}`);
    }

    await cp(directory, path.join(target, relative), {
      recursive: true,
      dereference: false,
      filter: (file) => !path.relative(directory, file).split(path.sep).includes('node_modules'),
    });
  }

  for (const name of ['package.json', 'package-lock.json']) {
    await copyFile(path.join(source, name), path.join(target, name));
  }
}

/**
 * Native пересобираются офлайн своим Node и его заголовками, без npm install.
 * Ошибка любого binding останавливает сборку; optional fallback не скрывает отсутствие crypto.
 */
export async function prepareOfflineDependencies(input: InstallDependenciesInput): Promise<void> {
  await copyProductionDependencies(input);

  const runtime = path.join(input.stageRoot, 'runtime/node');
  const node = path.join(runtime, 'bin/node');
  const modules = path.join(input.stageRoot, 'server/node_modules');
  const gyp = path.join(runtime, 'lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js');
  const home = path.join(input.cacheDir, 'native-home');
  const flags = [input.sourceRoot, input.stageRoot, input.cacheDir]
    .map((root) => `-ffile-prefix-map=${root}=/grigdesk-build`).concat('-g0').join(' ');
  const env = {
    PATH: `${path.join(runtime, 'bin')}:/usr/bin:/bin`,
    HOME: home,
    PYTHONDONTWRITEBYTECODE: '1',
    CFLAGS: flags,
    CXXFLAGS: flags,
  };

  await mkdir(home, { recursive: true });

  const cpu = path.join(modules, 'cpu-features');
  const checked = await run(node, ['buildcheck.js'], {
    cwd: cpu,
    env,
    timeout: 60000,
  });

  await writeFile(path.join(cpu, 'buildcheck.gypi'), checked.stdout);

  for (const directory of [cpu, path.join(modules, 'ssh2/lib/protocol/crypto')]) {
    const result = await run(node, [gyp, 'rebuild', `--nodedir=${runtime}`,
      `--devdir=${home}`, '--real_openssl_major=3'], {
      cwd: directory,
      env,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
    });

    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
  }
}
