import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Следит за дочерним relay из отдельного event loop.
 * Отсутствие heartbeat убивает ребёнка и завершает контейнер для restart policy Docker.
 */
export function supervise(
  options: {
    childFile?: string;
    watchdogMs?: number;
  } = {},
): Promise<number> {
  const childFile = options.childFile ?? fileURLToPath(new URL('./main.ts', import.meta.url));
  const watchdogMs = options.watchdogMs ?? Number(process.env.RELAY_WATCHDOG_MS ?? 10000);

  if (!Number.isSafeInteger(watchdogMs) || watchdogMs <= 0 || watchdogMs > 60000) {
    return Promise.resolve(2);
  }

  return new Promise((resolve) => {
    const child = fork(childFile, [], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      execArgv: [],
    });
    let lastHeartbeat = performance.now();
    let stopping = false;
    let normalStop = false;
    let killer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Пересылает сигнал только собственному ребёнку и ограничивает ожидание.
     * SIGKILL после дедлайна не оставляет замороженный relay сиротой.
     */
    function stop(normal: boolean) {
      if (stopping) {
        return;
      }

      stopping = true;
      normalStop = normal;
      child.kill('SIGTERM');
      killer = setTimeout(() => child.kill('SIGKILL'), normal ? 4500 : 2000);
    }

    const signal = () => stop(true);

    process.on('SIGTERM', signal);
    process.on('SIGINT', signal);

    const watchdog = setInterval(
      () => {
        if (performance.now() - lastHeartbeat > watchdogMs) {
          stop(false);
        }
      },
      Math.min(1000, Math.max(20, watchdogMs / 3)),
    );

    child.on('message', (message) => {
      if (message && typeof message === 'object' && 't' in message && message.t === 'heartbeat') {
        lastHeartbeat = performance.now();
      }
    });

    /**
     * Снимает все таймеры и обработчики при завершении дочернего процесса.
     * Неожиданное завершение даже с нулём требует перезапуска контейнера.
     */
    function finish() {
      clearInterval(watchdog);
      clearTimeout(killer);
      process.off('SIGTERM', signal);
      process.off('SIGINT', signal);
      resolve(normalStop ? 0 : 1);
    }

    child.once('exit', finish);
    child.once('error', finish);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await supervise();
}
