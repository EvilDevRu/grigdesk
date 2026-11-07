import { createRequire } from 'node:module';

const entry = process.argv[2]!;
const binary = process.argv[3]!;
const desktopParent = process.env.GRIGDESK_DESKTOP_CHILD === '1';
let stopping = false;

/**
 * Внутренний IPC всегда принадлежит launcher, даже при standalone запуске.
 * Его потеря запрашивает штатный SIGTERM, без закрытия отвязанной фабрики по группе.
 */
function requestStop(): void {
  if (stopping) {
    return;
  }

  stopping = true;

  // Штатный desktop listener сам вызывает shutdown.begin на этом же disconnect.
  // Дополнительный SIGTERM был бы повторным сигналом и аварийно обрывал бы слив.
  if (desktopParent && process.listenerCount('disconnect') > 0) {
    return;
  }

  process.kill(process.pid, 'SIGTERM');
}

/**
 * До установки app shutdown signal обязан вызвать JS exit и снять data-home lock.
 * После установки штатного обработчика bootstrap оставляет завершение приложению.
 */
function earlySignal(signal: NodeJS.Signals): void {
  if (process.listenerCount(signal) === 1) {
    process.exit(0);
  }
}

process.on('SIGTERM', earlySignal.bind(null, 'SIGTERM'));
process.on('SIGINT', earlySignal.bind(null, 'SIGINT'));
process.once('disconnect', requestStop);

/**
 * Импорт приложения разрешается только после записи worker owner под package lock.
 * Listener disconnect установлен раньше ожидания ACK и любого импорта payload.
 */
async function start(): Promise<void> {
  if (!process.connected) {
    process.exit(0);
  }

  await new Promise<void>((resolve) => {
    const receive = (message: unknown) => {
      if (message && typeof message === 'object'
        && (message as { type?: unknown }).type === 'grigdesk:worker-start') {
        process.removeListener('message', receive);
        resolve();
      }
    };

    process.on('message', receive);
  });

  if (!process.connected || stopping) {
    process.exit(0);
  }

  process.argv = [process.execPath, entry];

  const payload = createRequire(entry)(entry) as { startPayloadServer(binary: string): Promise<void> };

  await payload.startPayloadServer(binary);
  process.channel?.unref();
}

void start().catch((error: unknown) => {
  process.stderr.write(`Серверный worker не запустился: ${(error as Error).message}\n`);
  process.exit(1);
});
