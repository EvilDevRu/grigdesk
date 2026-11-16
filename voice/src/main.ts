import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import manifest from '../package.json' with { type: 'json' };
import { runVoice } from './app.ts';
import { VoiceError } from './contract.ts';
import { runWithStdin } from './process.ts';
import { createScriptResolver } from './python.ts';

/**
 * Читает явный текстовый путь; отсутствие файла представляется null.
 * Другие системные ошибки остаются исключениями и проходят безопасную границу CLI.
 */
async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

/**
 * Дожидается завершения записи в поток, включая ошибку закрытого pipe.
 * Вызывающий получает Promise, поэтому вывод не теряется при назначении exitCode.
 */
function writeTo(stream: NodeJS.WriteStream, value: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(value, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

/**
 * Связывает команду с ресурсами процесса без import.meta в будущем CJS SEA bundle.
 * Отмена распространяется в собственные операции, а скрипты очищаются после закрытия детей.
 */
async function main(): Promise<void> {
  const sourceDirectory = path.dirname(path.resolve(process.argv[1] ?? '.'));
  const resolver = createScriptResolver(sourceDirectory);
  const controller = new AbortController();
  const ignoreStreamError = (): void => undefined;
  const cancel = (): void => {
    controller.abort(new VoiceError('Операция отменена.'));
  };

  process.stdout.on('error', ignoreStreamError);
  process.stderr.on('error', ignoreStreamError);
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);

  try {
    process.exitCode = await runVoice(process.argv.slice(2), { version: manifest.version }, {
      env: process.env,
      getHome: () => os.homedir(),
      readText,
      readFile: (file) => fs.readFile(file),
      writeFile: (file, value) => fs.writeFile(file, value),
      writeStdout: (value) => writeTo(process.stdout, value),
      writeStderr: (value) => writeTo(process.stderr, value),
      fetch,
      spawn: runWithStdin,
      scriptPath: (name) => resolver.scriptPath(name),
      signal: controller.signal,
    });
  } catch {
    process.exitCode = 1;

    await writeTo(process.stderr, 'Не удалось завершить команду voice.\n').catch(() => undefined);
  } finally {
    try {
      await resolver.cleanup();
    } catch {
      process.exitCode = 1;

      await writeTo(process.stderr, 'Не удалось очистить временные скрипты voice.\n')
        .catch(() => undefined);
    }

    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
