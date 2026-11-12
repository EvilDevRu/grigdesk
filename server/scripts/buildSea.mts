import { execFile } from 'node:child_process';
import { cp, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { withWorkDirectory } from '../../shared/node/files.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { ensureNodeArchive, readNodeRuntime } from '../../shared/node/nodeRuntime.ts';
import { nodeArchive } from '../../shared/node/seaBuild.ts';
import { checkRuntime, writeReleaseManifest } from '../src/lib/releaseManifest.ts';
import { buildSeaBinary } from './sea/buildSteps.mts';
import { bundleServer } from './sea/bundle.mts';
import { collectLicenses } from './sea/dependencies.mts';
import { createReleaseArchive, parseBuildArgs, publishRelease } from './sea/release.mts';
import type { BuildArgs } from './sea/release.mts';
import { prepareRelease } from './sea/prepare.mts';
import { smokeRelease } from './sea/smoke.mts';
import { auditStage, normalizeStageModes } from './sea/stage.mts';

const run = promisify(execFile);
const sourceRoot = path.resolve(import.meta.dirname, '../..');

/**
 * Читает публичный JSON-контракт сборки из текущего дерева.
 */
async function json(relative: string) {
  return JSON.parse(await readFile(path.join(sourceRoot, relative), 'utf8'));
}

/**
 * Берёт только заранее сохранённый официальный Node; сборка не скачивает runtime.
 * Публикует копию атомарно; повреждённый cache допускает другой проверенный локальный вход.
 */
export async function cachedRuntime(cache: string, root = sourceRoot): Promise<string> {
  const runtime = readNodeRuntime(JSON.parse(await readFile(
    path.join(root, 'server/build/node-runtime.json'), 'utf8',
  )),
    'server/build/node-runtime.json');
  const archive = nodeArchive(runtime).name;

  return ensureNodeArchive(runtime, cache, {
    attempts: 1,
    download: async (_url, temporary) => {
      for (const tool of ['b24', 'relay']) {
        const candidate = path.join(root, tool, '.cache', archive);

        if (await sha256File(candidate).catch(() => '') === runtime.sha256) {
          await copyFile(candidate, temporary);

          return;
        }
      }

      throw new Error(`Нет проверенного архива ${archive} в cache, b24/.cache или relay/.cache`);
    },
  });
}

/**
 * Собирает два самостоятельных CLI имеющимися закреплёнными сборщиками.
 * Выход обоих инструментов направлен в staging, рабочие bin машины не затрагиваются.
 */
async function buildCli(directory: string, cache: string): Promise<void> {
  for (const tool of ['b24', 'relay']) {
    const args = [path.join(sourceRoot, tool, 'scripts/build.mts'), '--out-dir',
      path.join(directory, 'bin')];

    if (tool === 'b24') {
      args.push('--cache-dir', cache);
    }

    await run(process.execPath, args, {
      cwd: sourceRoot,
      env: { PATH: '/usr/bin:/bin' },
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }
}

/**
 * Готовит отдельный R, проверяет его состав и публикует только после boot smoke.
 * Кэш и HOME сборки находятся снаружи R; собственный граф объединён, npm остаётся внешним.
 */
export async function buildRelease(options: BuildArgs) {
  const runtime = readNodeRuntime(await json('server/build/node-runtime.json'),
    'server/build/node-runtime.json');
  const archive = await cachedRuntime(options.cacheDir);
  const version = (await readFile(path.join(sourceRoot, 'VERSION'), 'utf8')).trim();

  if (!/^[a-zA-Z0-9][a-zA-Z0-9.+-]*$/.test(version)) {
    throw new Error('Некорректная версия VERSION');
  }

  return withWorkDirectory(options.cacheDir, async (work) => {
    const result = await publishRelease({
      outDir: options.outDir,
      name: `grigdesk-server-${version}-linux-x64`,
      prepare: async (directory) => {
        const { helpers, dependencies, helpPackages } = await prepareRelease({
          sourceRoot,
          directory,
          archive,
          runtime,
          cacheDir: options.cacheDir,
          work,
        });

        await buildCli(directory, options.cacheDir);
        process.stdout.write('SEA: CJS, blob и postject\n');
        await buildSeaBinary({
          packageDir: path.join(sourceRoot, 'server'),
          entryPoint: path.join(sourceRoot, 'server/src/sea.ts'),
          target: path.join(directory, 'server/grigdesk-server'),
          cacheDir: options.cacheDir,
          bundle: async (outfile, workDir) => {
            await bundleServer({
              sourceRoot,
              workDir,
              outfile,
            });
          },
        });
        await collectLicenses(directory, { extraPackages: helpPackages });
        await cp(path.join(directory, 'licenses'), path.join(directory, 'server/help/site/licenses'), {
          recursive: true,
        });
        await normalizeStageModes(directory);

        const required = ['server/help/help.json', 'server/help/help.en.json',
          'server/help/site/help.en.json', 'server/help/site/index.html',
          'server/help/site/help.json', 'VERSION', 'server/grigdesk-server', 'runtime/node/bin/node',
          'server/package.json', 'server/node_modules/fastify/package.json',
          'server/runtime/esmBridge.cjs', 'licenses/NODE.txt', 'licenses/THIRD-PARTY.json',
          'bin/grigdesk-ctl', 'bin/b24', 'bin/grigdesk-relay', ...helpers.helpers.map(
            (helper) => `server/runtime/helpers/${helper.id}.mjs`,
          )];
        const files = await auditStage(directory, {
          required,
          sourceRoot,
          forbiddenRoots: [options.cacheDir, directory],
          executables: ['server/grigdesk-server', 'runtime/node/bin/node',
            'bin/grigdesk-ctl', 'bin/b24', 'bin/grigdesk-relay'],
        });
        const manifest = await writeReleaseManifest(directory, {
          version,
          runtime: {
            node: runtime.version,
            platform: 'linux',
            arch: 'x64',
            abi: dependencies.abi,
          },
          files,
        });
        const checked = await checkRuntime(directory, manifest.runtime);

        if (!checked.ok) {
          throw new Error(checked.errors.join('\n'));
        }

        return manifest;
      },
      smoke: async (directory) => {
        process.stdout.write('SEA: boot smoke с отдельным временным D\n');
        await smokeRelease(directory);
      },
      archive: async (directory, target) => {
        process.stdout.write('SEA: tar.xz\n');
        await createReleaseArchive(directory, target);
      },
    });

    return {
      ...result,
      sha256: await sha256File(result.archive),
      size: (await stat(result.archive)).size,
      runtime: runtime.version,
    };
  });
}

/**
 * CLI выводит итоговые пути и хеш архива; отказ не меняет опубликованный комплект.
 * Ошибки аргументов дают код 2 до сборки, остальные отказы дают код 1 с причиной.
 */
async function main(): Promise<void> {
  const parsed = parseBuildArgs(process.argv.slice(2), process.cwd(), sourceRoot);

  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;

    return;
  }

  try {
    const result = await buildRelease(parsed);

    await writeFile(path.join(parsed.outDir, 'build-result.json'), JSON.stringify(result, null, 2) + '\n');
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`Сборка GrigDesk SEA не удалась: ${(error as Error).stack}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1]
  && path.resolve(process.argv[1]) === path.join(sourceRoot, 'server/scripts/buildSea.mts')) {
  void main();
}
