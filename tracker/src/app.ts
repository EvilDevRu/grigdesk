import type { DataHomeEnv } from '../../shared/runtime/dataHome.ts';
import { HELP_TEXT, parseArgs } from './args.ts';
import type { Command } from './args.ts';
import { runCommand } from './commands.ts';
import type { CommandIO } from './commands.ts';
import { resolveConnection } from './config.ts';
import type { ConfigIO } from './config.ts';
import { describeFailure } from './errors.ts';

export interface RuntimeInfo {
  version: string;
  license(): string;
}

export interface AppIO extends ConfigIO, CommandIO {
  env: DataHomeEnv;
  writeStdout(value: string | Uint8Array): Promise<void>;
  writeStderr(value: string): Promise<void>;
}

/**
 * Строка версии: приложение из manifest и Node исполняющего процесса.
 * Не читает настройки, stdin и сеть.
 */
export function versionLine(version: string): string {
  return `tracker ${version} (Node ${process.version}, ${process.platform} ${process.arch})\n`;
}

/**
 * Пишет причину отказа в stderr и возвращает код выхода.
 * Недоступный stderr не превращается в необработанное исключение.
 */
async function fail(io: AppIO, text: string, code: number): Promise<number> {
  try {
    await io.writeStderr(text);
  } catch {
    // stderr закрыт: код выхода остаётся единственным сигналом отказа.
  }

  return code;
}

/**
 * Готовит полный ответ команды до записи в stdout.
 * Локальные флаги не трогают настройки, API-команды читают их только здесь.
 */
async function produce(command: Command, runtime: RuntimeInfo, io: AppIO): Promise<string | Uint8Array> {
  switch (command.kind) {
    case 'help':
      return HELP_TEXT;
    case 'version':
      return versionLine(runtime.version);
    case 'license':
      return runtime.license();
    default:
      return await runCommand(command, await resolveConnection(io.env, io), io);
  }
}

/**
 * Выполняет tracker целиком и возвращает код выхода без эффектов при импорте.
 * Аргументы разбираются до настроек; при отказе stdout пуст, причина уходит в stderr.
 */
export async function runB24(argv: readonly string[], runtime: RuntimeInfo, io: AppIO): Promise<number> {
  let command: Command;

  try {
    command = parseArgs(argv);
  } catch (error) {
    return await fail(io, `${(error as Error).message}\n\n${HELP_TEXT}`, 2);
  }

  let output: string | Uint8Array;

  try {
    output = await produce(command, runtime, io);
  } catch (error) {
    const failure = describeFailure(error);

    return await fail(io, `${failure.message}\n`, failure.code);
  }

  try {
    await io.writeStdout(output);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPIPE') {
      return 0;
    }

    return await fail(io, 'Не удалось записать ответ.\n', 1);
  }

  return 0;
}
