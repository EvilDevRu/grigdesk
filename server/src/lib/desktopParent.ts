export const DESKTOP_CHILD_ENV = 'COCKPIT_DESKTOP_CHILD';
export const DESKTOP_RESTART_EXIT_CODE = 75;

export interface ParentChannel {
  readonly connected: boolean;
  readonly channel?: { unref(): void } | null;
  once(event: 'disconnect', listener: () => void): unknown;
}

export interface DesktopParent {
  readonly connected: boolean;
  bindShutdown(begin: (reason: string) => Promise<void>): void;
}

/**
 * Признаёт владельцем только приложение с маркером и живым IPC-каналом.
 * Канал несёт признак жизни, его разрыв завершает дочерний сервер.
 */
export function attachDesktopParent(input: {
  env: Record<string, string | undefined>;
  channel: ParentChannel | null;
  exit: (code: number) => void;
}): DesktopParent | null {
  const enabled = input.env[DESKTOP_CHILD_ENV] === '1';
  const channel = input.channel;

  delete input.env[DESKTOP_CHILD_ENV];

  if (!enabled || !channel?.connected) {
    return null;
  }

  let beginShutdown: ((reason: string) => Promise<void>) | null = null;

  channel.channel?.unref();
  channel.once('disconnect', () => {
    if (beginShutdown) {
      void beginShutdown('приложение Кокпита закрылось');
    } else {
      input.exit(0);
    }
  });

  return {
    get connected() {
      return channel.connected;
    },
    bindShutdown(begin) {
      beginShutdown = begin;
    },
  };
}
