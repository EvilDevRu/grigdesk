import os from 'node:os';
import path from 'node:path';

import { dataHome, dataPath } from '../../shared/runtime/dataHome.ts';
import { installBinary, type InstallOptions } from './binary/installSteps.mts';

/**
 * Candidate и target задаются явно, сборка не становится установкой автоматически.
 * Неизвестные и повторные аргументы отвергаются до каких-либо файловых эффектов.
 */
function parseArguments(args: string[]): InstallOptions {
  const flags = new Map<string, string>();
  const allowed = ['--binary', '--target', '--releases-dir'];

  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    const value = args[index + 1];

    if (!allowed.includes(name) || flags.has(name) || !value || value.startsWith('--')) {
      throw new Error('Некорректные аргументы установщика');
    }

    flags.set(name, path.resolve(value));
  }

  if (!flags.has('--binary') || !flags.has('--target')) {
    throw new Error('Не заданы обязательные пути установщика');
  }

  return {
    binary: flags.get('--binary')!,
    target: flags.get('--target')!,
    releasesDir: flags.get('--releases-dir') ?? path.join(
      dataPath(dataHome({ env: process.env, home: os.homedir() }), 'serverRuntime'), 'releases',
    ),
  };
}

/**
 * Ошибка аргументов имеет код 2, отказ установки имеет код 1.
 * Успех сообщает SHA и backup, не меняя descriptor и не перезапуская сервер.
 */
async function main(): Promise<void> {
  let options: InstallOptions;

  try {
    options = parseArguments(process.argv.slice(2));
  } catch {
    process.stderr.write('Использование: install:binary -- --binary <ELF> --target <путь> '
      + '[--releases-dir <каталог>]\n');
    process.exitCode = 2;

    return;
  }

  try {
    process.stdout.write(`${JSON.stringify(await installBinary(options))}\n`);
  } catch (error) {
    process.stderr.write(`Установка сервера не выполнена: ${(error as Error).message}\n`);
    process.exitCode = 1;
  }
}

await main();
