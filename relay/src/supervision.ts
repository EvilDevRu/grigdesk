import { spawn } from 'node:child_process';

/**
 * Читает срок сторожа отдельно от конфигурации TLS.
 * Числовую допустимость проверяет общий запуск до создания ребёнка.
 */
export function watchdogFromEnv(env: Record<string, string | undefined>): number {
  return Number(env.RELAY_WATCHDOG_MS ?? 10000);
}

/**
 * Следит за рабочей частью из отдельного event loop и передаёт ей сигналы.
 * Каждый выход снимает таймеры, а зависший ребёнок принудительно завершается.
 */
export function superviseProcess({ command, args, watchdogMs }: {
  command: string;
  args: readonly string[];
  watchdogMs: number;
}): Promise<number> {
  if (!Number.isSafeInteger(watchdogMs) || watchdogMs <= 0 || watchdogMs > 60000) {
    return Promise.resolve(2);
  }

  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let lastHeartbeat = performance.now();
    let stopping = false;
    let finished = false;
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
      if (finished) {
        return;
      }

      finished = true;
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
