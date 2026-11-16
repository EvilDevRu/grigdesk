import { execFile } from 'node:child_process';
import { chmod, copyFile, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';

import { downloadFile, nodeArchive, seaConfig } from '../../shared/node/seaBuild.ts';
import { sha256File } from '../../shared/node/hash.ts';
import { withWorkDirectory } from '../../shared/node/files.ts';

import {
  assertUntracked,
  ensureNodeArchive,
  parseBuildArgs,
  publishFile,
  readNodeRuntime,
  SEA_FUSE,
} from './buildSteps.mts';
import type { BuildOptions } from './buildSteps.mts';

const run = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, '..');

/**
 * Находит CLI postject по package.json внутри зависимостей voice.
 * Поле bin бывает строкой или объектом с именем команды.
 */
async function postjectCli(): Promise<string> {
  const postject = path.join(packageDir, 'node_modules/postject');
  const manifest = JSON.parse(await readFile(path.join(postject, 'package.json'), 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin.postject;

  return path.resolve(postject, bin);
}

/**
 * Собирает bundle, внедряет blob в закреплённый официальный Node и проверяет версию.
 * Публикация в outDir разрешена только после проверки с пустым окружением.
 */
export async function buildBinary(options: BuildOptions): Promise<void> {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('сборка поддерживает только Linux x64');
  }

  const manifest = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const runtime = readNodeRuntime(
    JSON.parse(await readFile(path.join(packageDir, 'build/node-runtime.json'), 'utf8')),
  );
  const archive = await ensureNodeArchive(runtime, options.cacheDir, { download: downloadFile });
  const { directory } = nodeArchive(runtime);
  const postject = await postjectCli();
  const target = path.join(options.outDir, 'voice');

  await assertUntracked(target);

  await withWorkDirectory(options.cacheDir, async (work) => {
    const result = await build({
      entryPoints: [path.join(packageDir, 'src/main.ts')],
      outfile: path.join(work, 'bundle.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      logLevel: 'silent',
    });

    if (result.warnings.length > 0) {
      throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
    }

    await run('tar', [
      '-xJf', archive, '-C', work, '--strip-components=1',
      `${directory}/bin/node`, `${directory}/LICENSE`,
    ]);

    const assets = {
      'piperSynth.py': 'piperSynth.py',
      'sileroSynth.py': 'sileroSynth.py',
    };

    for (const name of Object.keys(assets)) {
      await copyFile(path.join(packageDir, 'python', name), path.join(work, name));
    }

    await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig(assets)));
    await run(path.join(work, 'bin/node'), ['--experimental-sea-config', 'sea-config.json'], { cwd: work });
    await copyFile(path.join(work, 'bin/node'), path.join(work, 'voice'));
    await run(process.execPath, [
      postject, 'voice', 'NODE_SEA_BLOB', 'sea-prep.blob', '--sentinel-fuse', SEA_FUSE,
    ], {
      cwd: work,
      maxBuffer: 4 * 1024 * 1024,
    });
    await chmod(path.join(work, 'voice'), 0o755);

    const version = await run(path.join(work, 'voice'), ['version'], {
      env: {},
      timeout: 10000,
    });
    const expected = `voice ${manifest.version} (Node v${runtime.version}, linux x64)\n`;

    if (version.stdout !== expected || version.stderr !== '') {
      throw new Error('версия готового voice не совпадает с manifest');
    }

    await publishFile(path.join(work, 'voice'), target);
  });

  process.stdout.write(`${target}\n${(await stat(target)).size} байт\nsha256 ${await sha256File(target)}\n`);
}

/**
 * Оболочка командной строки: аргументы проверяются до эффектов.
 * Ошибка аргументов — код 2, ошибка сборки — код 1 и русская причина.
 */
async function main(): Promise<void> {
  const parsed = parseBuildArgs(process.argv.slice(2), process.cwd(), packageDir);

  if ('error' in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    process.exitCode = 2;

    return;
  }

  try {
    await buildBinary(parsed);
  } catch (error) {
    process.stderr.write(`Сборка voice не удалась: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.join(packageDir, 'scripts/build.mts')) {
  void main();
}
