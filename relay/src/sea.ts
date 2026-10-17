import { getAsset } from 'node:sea';

import { HELP_TEXT, parseCommand, versionLine } from './cli.ts';
import { checkHealth, runRelay } from './runtime.ts';
import { superviseProcess, watchdogFromEnv } from './supervision.ts';

// Значение подставляется esbuild из версии manifest посредника.
declare const RELAY_VERSION: string;

/**
 * Печатает локальную справку и лицензию с корректным закрытием короткого pipe.
 * Потребитель может закончить чтение раньше, не вызывая трассу EPIPE.
 */
function print(text: string): void {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') {
      process.exit(0);
    }

    throw error;
  });
  process.stdout.write(text);
}

/**
 * Выбирает режим файла до чтения TLS-настроек и запуска сети.
 * Рабочую часть вправе создавать только родитель с открытым IPC-каналом.
 */
async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));

  switch (command.kind) {
    case 'run':
      process.exitCode = await superviseProcess({
        command: process.execPath,
        args: ['--worker'],
        watchdogMs: watchdogFromEnv(process.env),
      });
      break;
    case 'worker':
      if (typeof process.send !== 'function') {
        process.stderr.write('Внутренний режим запускает сам посредник.\n');
        process.exitCode = 2;
      } else {
        await runRelay(process.env);
      }
      break;
    case 'health':
      process.exitCode = await checkHealth(process.env.RELAY_PORT);
      break;
    case 'help':
      print(HELP_TEXT);
      break;
    case 'version':
      print(`${versionLine(RELAY_VERSION, process.version, process.platform, process.arch)}\n`);
      break;
    case 'license':
      print(getAsset('NODE-LICENSE', 'utf8'));
      break;
    case 'error':
      process.stderr.write(`${command.message}\n`);
      process.exitCode = 2;
      break;
  }
}

void main().catch(() => {
  process.exitCode = 1;
});
