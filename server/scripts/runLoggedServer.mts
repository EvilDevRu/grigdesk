import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { finished } from 'node:stream/promises';

import { RotatingLog } from '../../shared/node/rotatingLog.ts';
import { isDirectRun } from '../src/lib/helperEntry.ts';

/**
 * Отдельный потребитель вывода переживает отвязку ручного сервера от терминала.
 * Сигналы передаются серверу, завершение ждёт труб и записи последнего chunk.
 */
export async function main(argv = process.argv.slice(2)): Promise<number> {
  const [file, command, ...args] = argv;

  if (!file || !command) {
    throw new Error('Нужны путь журнала и команда сервера');
  }

  const log = new RotatingLog(file);
  const written = finished(log);

  // Ошибка диска может прийти раньше close ребёнка: Promise уже имеет handler,
  // а исход всё равно проверяется ниже после завершения труб.
  void written.catch(() => undefined);

  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  const forward = (signal: NodeJS.Signals) => child.kill(signal);
  const terminate = () => forward('SIGTERM');
  const interrupt = () => forward('SIGINT');

  process.on('SIGTERM', terminate);
  process.on('SIGINT', interrupt);
  log.on('error', terminate);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });

  try {
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => {
        resolve(status ?? (128 + (signal ? constants.signals[signal] : 0)));
      });
    });

    log.end();
    await written;

    return code;
  } finally {
    process.off('SIGTERM', terminate);
    process.off('SIGINT', interrupt);
    log.end();
    await written.catch(() => undefined);
  }
}

if (isDirectRun(import.meta.url)) {
  void main().then((code) => {
    process.exitCode = code;
  }, (error: unknown) => {
    process.stderr.write(`Журнал сервера недоступен: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
