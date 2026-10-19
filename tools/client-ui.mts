import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { API_VERSION } from '../shared/client/apiVersion.ts';
import { sealUiRelease, verifyUiRelease } from '../desktop/src/uiRelease.ts';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('..', import.meta.url));

type Runner = (command: string, args: string[], options: { cwd: string; maxBuffer: number }) =>
  Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

/**
 * Сборка в staging публикуется целиком, с номером API и проверенным manifest.
 * Ошибка web не трогает прежний пакет и никогда не пишет в рабочий web/dist.
 */
export async function prepareClientUi(options: {
  destination: string;
  root?: string;
  run?: Runner;
}): Promise<void> {
  const destination = path.resolve(options.destination);
  const root = options.root || repository;

  await mkdir(path.dirname(destination), { recursive: true });

  const staging = await mkdtemp(path.join(path.dirname(destination), '.client-ui-'));
  const output = path.join(staging, 'ui');
  const previous = path.join(staging, 'previous');
  let moved = false;
  let preserve = false;

  try {
    const result = await (options.run || execute)('npm', [
      '--prefix', path.join(root, 'web'), 'run', 'build', '--',
      '--outDir', output, '--emptyOutDir',
    ], { cwd: root, maxBuffer: 16 * 1024 * 1024 });

    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    await writeFile(path.join(output, 'api-version.json'), JSON.stringify(API_VERSION) + '\n');
    await sealUiRelease(output);
    await verifyUiRelease(output);

    try {
      await rename(destination, previous);
      moved = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    try {
      await rename(output, destination);
    } catch (error) {
      if (moved) {
        try {
          await rename(previous, destination);
        } catch {
          preserve = true;

          throw new Error(`Прежний интерфейс сохранён в ${previous}.`);
        }
      }

      throw error;
    }
  } finally {
    if (!preserve) {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 4 || process.argv[2] !== '--outDir') {
    throw new Error('Использование: client-ui.mts --outDir <каталог>.');
  }

  await prepareClientUi({ destination: process.argv[3]! });
}
