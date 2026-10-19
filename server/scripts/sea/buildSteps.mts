import { execFile } from 'node:child_process';
import type { ExecFileOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { promisify } from 'node:util';

import { build as esbuildBuild } from 'esbuild';

import { withWorkDirectory } from '../../../shared/node/files.ts';
import { sha256File } from '../../../shared/node/hash.ts';
import {
  ensureNodeArchive,
  readNodeRuntime,
  SEA_FUSE,
} from '../../../shared/node/nodeRuntime.ts';
import type { NodeRuntime } from '../../../shared/node/nodeRuntime.ts';
import { nodeArchive, seaConfig } from '../../../shared/node/seaBuild.ts';
import { downloadFile } from '../../../shared/node/seaBuild.ts';

/**
 * Шаги выпуска SEA-бинарника сервера.
 *
 * Общий код кэша и публикации живёт в shared/node/nodeRuntime.ts; здесь остаются
 * сборка CJS-бандла, подготовка blob закреплённым Node, внедрение postject и
 * проверка пробой до атомарной публикации.
 */

export const SEA_REQUIRE_BANNER = "require = require('node:module').createRequire("
  + "require('node:path').join(require('node:path').dirname("
  + "require('node:fs').realpathSync(process.execPath)), 'package.json'));";

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  file: string,
  args: readonly string[],
  options?: ExecFileOptions,
) => Promise<CommandResult>;

type Esbuild = typeof esbuildBuild;

export interface SeaBuildInput {
  packageDir: string;
  entryPoint: string;
  target: string;
  cacheDir: string;
  banner?: string;
  probe?: (binary: string) => Promise<void>;
  download?: (url: string, file: string) => Promise<void>;
  run?: CommandRunner;
  platform?: string;
  arch?: string;
  esbuild?: Esbuild;
  runtimeManifest?: string;
  bundle?: (outfile: string, work: string) => Promise<void>;
}

export interface SeaBuildResult {
  binary: string;
  size: number;
  sha256: string;
}

const execFileAsync = promisify(execFile);

/**
 * Запускает внешнюю утилиту сборки и возвращает текстовые потоки.
 * Ошибка процесса не подавляется: её текст увидит шаг сборки.
 */
async function defaultRun(file: string, args: readonly string[], options?: ExecFileOptions):
  Promise<CommandResult> {
  const result = await execFileAsync(file, [...args], options);

  return {
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
}

/**
 * Находит CLI postject по его package.json внутри зависимостей сервера.
 * Поле bin бывает строкой или объектом с именем команды.
 */
export async function postjectCli(packageDir: string): Promise<string> {
  const postject = path.join(packageDir, 'node_modules/postject');
  const manifest = JSON.parse(await readFile(path.join(postject, 'package.json'), 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.postject;

  if (typeof bin !== 'string' || bin === '') {
    throw new Error('postject не установлен: в package.json нет поля bin');
  }

  return path.resolve(postject, bin);
}

/**
 * Достаёт из проверенного архива только исполняемый файл Node и его лицензию.
 * Каталоги раскрываются системным tar; ошибка tar остаётся отказом сборки.
 */
export async function extractNodeFiles(runtime: NodeRuntime, archive: string, work: string,
  run: CommandRunner): Promise<void> {
  const { directory } = nodeArchive(runtime);

  await run('tar', [
    '-xJf', archive, '-C', work, '--strip-components=1',
    `${directory}/bin/node`, `${directory}/LICENSE`,
  ]);
  await chmod(path.join(work, 'bin/node'), 0o755);
}

/**
 * Готовит blob закреплённым Node по общему sea-config и проверяет его наличие.
 * Внедрение blob в копию Node выполняет отдельный шаг postject.
 */
export async function makeSeaBlob(work: string, run: CommandRunner): Promise<void> {
  const node = path.join(work, 'bin/node');

  await writeFile(path.join(work, 'sea-config.json'), JSON.stringify(seaConfig()));
  await run(node, ['--experimental-sea-config', 'sea-config.json'], {
    cwd: work,
  });
  await stat(path.join(work, 'sea-prep.blob'));
}

/**
 * Собирает бандл, внедряет blob и публикует бинарник только после успешной пробы.
 *
 * Новая копия готовится рядом с целью: проба видит настоящий R и его соседей,
 * а прежний файл не меняется до атомарного rename. Любая ошибка удаляет
 * временную копию и оставляет прежнюю версию нетронутой.
 */
export async function buildSeaBinary(input: SeaBuildInput): Promise<SeaBuildResult> {
  if ((input.platform ?? process.platform) !== 'linux' || (input.arch ?? process.arch) !== 'x64') {
    throw new Error('Сборка SEA поддерживает только Linux x64');
  }

  const manifestPath = input.runtimeManifest
    ?? path.join(input.packageDir, 'build/node-runtime.json');
  const runtime = readNodeRuntime(
    JSON.parse(await readFile(manifestPath, 'utf8')),
    'server/build/node-runtime.json',
  );
  const run = input.run ?? defaultRun;
  const archive = await ensureNodeArchive(runtime, input.cacheDir, {
    download: input.download ?? downloadFile,
  });
  const postject = await postjectCli(input.packageDir);
  const targetDirectory = path.dirname(input.target);

  await mkdir(targetDirectory, {
    recursive: true
  });

  await withWorkDirectory(input.cacheDir, async (work) => {
    const esbuild = input.esbuild ?? esbuildBuild;
    const result = input.bundle ? undefined : await esbuild({
      entryPoints: [input.entryPoint],
      outfile: path.join(work, 'bundle.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      packages: 'external',
      banner: input.banner ? { js: input.banner } : undefined,
      logLevel: 'silent',
    });

    if (result && result.warnings.length > 0) {
      throw new Error(result.warnings.map((warning) => warning.text).join('\n'));
    }

    if (input.bundle) {
      await input.bundle(path.join(work, 'bundle.cjs'), work);
    }

    await extractNodeFiles(runtime, archive, work, run);
    await makeSeaBlob(work, run);

    const staged = path.join(targetDirectory,
      `.${path.basename(input.target)}-${randomUUID()}.tmp`);

    try {
      await copyFile(path.join(work, 'bin/node'), staged);
      await chmod(staged, 0o755);
      await run(process.execPath, [
        postject, staged, 'NODE_SEA_BLOB', path.join(work, 'sea-prep.blob'),
        '--sentinel-fuse', SEA_FUSE,
      ], {
        cwd: work,
        maxBuffer: 4 * 1024 * 1024,
      });
      await chmod(staged, 0o755);

      if (input.probe) {
        await input.probe(staged);
      }

      await rename(staged, input.target);
    } finally {
      await rm(staged, {
        force: true
      });
    }
  });

  return {
    binary: input.target,
    size: (await stat(input.target)).size,
    sha256: await sha256File(input.target),
  };
}
