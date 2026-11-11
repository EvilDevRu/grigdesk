import { spawn, type ChildProcess } from 'node:child_process';

// Сторож не выполняет DNS и не зависит от event loop наблюдаемого процесса.
// Проверка ppid привязывает сигнал к собственному родителю, а не найденному по PID процессу.
export const PROCESS_WATCHDOG = String.raw`
import { createReadStream } from 'node:fs';

const options = JSON.parse(process.argv[1]);
const owner = options.ownerPid;
let armed = false;

const terminate = () => process.kill(process.pid, 'SIGKILL');

process.on('uncaughtException', terminate);
process.on('unhandledRejection', terminate);
process.stderr.on('error', terminate);

/**
 * Абсолютный срок переводится в один monotonic timer при постановке.
 * Последующая коррекция часов хоста не продлевает уже начатую остановку.
 */
function arm(deadline, phase) {
  if (armed) {
    return;
  }

  armed = true;
  setTimeout(() => {
    if (process.ppid !== owner) {
      process.kill(process.pid, 'SIGKILL');
      return;
    }

    // Сигнал предшествует журналу: заполненная труба stderr не задерживает выход.
    process.kill(owner, 'SIGKILL');

    try {
      process.stderr.write(JSON.stringify({
        event: 'shutdown.watchdog',
        phase,
        outcome: 'deadline',
      }) + '\n');
    } catch {}
  }, Math.max(0, deadline - Date.now()));
}

if (options.deadline) {
  arm(options.deadline, options.phase);
}

if (options.launcherPipe) {
  const launcher = createReadStream(null, { fd: 4, autoClose: false });
  const lost = () => {
    arm(Date.now() + options.graceMs, 'launcher-disconnected');
  };

  launcher.on('end', lost);
  launcher.on('error', lost);
  launcher.resume();
}

setInterval(() => {
  if (process.ppid !== owner) {
    process.kill(process.pid, 'SIGKILL');
  }
}, 20);
`;

/**
 * Независимый Node ограничивает ожидание фактического выхода своего родителя.
 * Канал launcher передаётся отдельным fd: его потеря видна даже при native cleanup worker.
 */
export function startProcessWatchdog(options: {
  node: string;
  deadline?: number;
  phase: string;
  launcherPipe?: boolean;
  graceMs?: number;
}): ChildProcess {
  const child = spawn(options.node, [
    '--input-type=module', '--eval', PROCESS_WATCHDOG,
    JSON.stringify({ ...options, ownerPid: process.pid }),
  ], {
    stdio: options.launcherPipe
      ? ['ignore', 'ignore', 'inherit', 'ignore', 4]
      : ['ignore', 'ignore', 'inherit'],
    env: {},
  });

  // Отказ защиты не позволяет продолжить неограниченную остановку с ложным успехом.
  child.once('error', () => process.kill(process.pid, 'SIGKILL'));
  child.once('exit', () => process.kill(process.pid, 'SIGKILL'));
  child.unref();

  return child;
}
