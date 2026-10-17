import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { build } from 'esbuild';
import { sealUiRelease } from '../src/uiRelease.ts';

const desktop = path.resolve(import.meta.dirname, '..');
const distribution = path.join(desktop, 'dist');
const splashFiles = ['index.html', 'style.css', 'illustration.png'];
const execute = promisify(execFile);

/**
 * Сначала собирает неизменяемый интерфейс в отдельном staging, не затрагивая рабочий web/dist.
 * Только готовый комплект заменяет desktop dist; отказ сохраняет предыдущую сборку.
 */
async function buildDesktop(): Promise<void> {
  // Staging рядом с desktop/dist: замена идёт через rename, а он работает только в пределах
  // одной файловой системы; папка данных может лежать на другом диске.
  const staging = await mkdtemp(path.join(desktop, '.dist-staging-'));
  const output = path.join(staging, 'dist');
  const previous = path.join(staging, 'previous');

  let preserveStaging = false;

  try {
    await mkdir(output);

    const result = await execute('npm', [
      '--prefix', path.join(desktop, '../web'), 'run', 'build', '--',
      '--outDir', path.join(output, 'ui'), '--emptyOutDir',
    ], { maxBuffer: 8 * 1024 * 1024 });

    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    await sealUiRelease(path.join(output, 'ui'));
    await build({
      entryPoints: [path.join(desktop, 'src/main.ts')],
      outfile: path.join(output, 'main.cjs'),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      external: ['electron'],
    });
    // Окно получает заранее сглаженный растр: уменьшение упаковочной иконки 512 px
    // самой панелью задач теряет сглаживание и делает дугу зубчатой.
    await copyFile(path.join(desktop, 'build/window-icon.png'), path.join(output, 'icon.png'));
    await mkdir(path.join(output, 'splash'));

    for (const name of splashFiles) {
      await copyFile(path.join(desktop, 'assets/splash', name),
        path.join(output, 'splash', name));
    }

    let moved = false;

    try {
      await rename(distribution, previous);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await rename(output, distribution);
    } catch (error) {
      if (moved) {
        try {
          await rename(previous, distribution);
        } catch (restoreError) {
          preserveStaging = true;

          throw new Error(`Предыдущая сборка сохранена в ${previous}`, { cause: restoreError });
        }
      }

      throw error;
    }
  } finally {
    if (!preserveStaging) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

await buildDesktop();
