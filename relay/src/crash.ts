import type { EventEmitter } from 'node:events';

/**
 * Завершает процесс при необработанной ошибке, позволяя Docker восстановить его.
 * Содержимое исключения не журналируется: в нём могут быть данные клиента.
 */
export function installCrashHandlers(
  proc: Pick<EventEmitter, 'on'>,
  {
    log,
    exit,
  }: {
    log: (event: string) => void;
    exit: (code: number) => void;
  },
) {
  const crash = () => {
    log('crash');
    exit(1);
  };

  proc.on('uncaughtException', crash);
  proc.on('unhandledRejection', crash);
}
