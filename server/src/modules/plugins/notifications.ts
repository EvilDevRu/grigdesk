import { decodePluginNotification } from '../../../../shared/plugins/pluginNotifications.ts';
import type {
  PluginNotification, PluginNotificationSnapshot,
} from '../../../../shared/plugins/pluginNotifications.ts';

export interface PluginNotificationSource {
  pluginId: string;
  generation: string;
  read(signal: AbortSignal): Promise<unknown>;
  isCurrent(): boolean;
}

const SNAPSHOT_TIMEOUT_MS = 5000;
const SNAPSHOT_MAX_ITEMS = 500;
const SNAPSHOT_MAX_BYTES = 1024 ** 2;

class SnapshotFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Снимок ограничивается до передачи в общую оболочку и содержит только show.
 * Ошибка одного элемента видима как отказ плагина, а не как пустая успешная история.
 */
function decodeSnapshot(value: unknown): PluginNotification[] {
  if (!Array.isArray(value)) {
    throw new SnapshotFailure('plugin_notifications_invalid');
  }

  const items = value.slice(-SNAPSHOT_MAX_ITEMS).map((item) => {
    const decoded = decodePluginNotification(item);

    if (!decoded || decoded.action !== 'show') {
      throw new SnapshotFailure('plugin_notifications_invalid');
    }

    return decoded;
  });

  if (Buffer.byteLength(JSON.stringify(items), 'utf8') > SNAPSHOT_MAX_BYTES) {
    throw new SnapshotFailure('plugin_notifications_too_large');
  }

  return items;
}

/**
 * Каждый hook получает собственный signal и не удерживает ответ после таймаута.
 * Поздний результат не возвращает исходы отозванного entry или предыдущего on/off.
 */
async function readSnapshot(
  source: PluginNotificationSource,
  signal?: AbortSignal,
): Promise<PluginNotificationSnapshot | null> {
  if (signal?.aborted || !source.isCurrent()) {
    return null;
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};

  try {
    const cancelled = new Promise<never>((resolve, reject) => {
      abort = () => {
        controller.abort(signal?.reason);
        reject(signal?.reason ?? new Error('plugin_notifications_aborted'));
      };

      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        const error = new SnapshotFailure('plugin_notifications_timeout');

        controller.abort(error);
        reject(error);
      }, SNAPSHOT_TIMEOUT_MS);
    });
    const value = await Promise.race([
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();

        return source.read(controller.signal);
      }),
      cancelled,
    ]);
    const items = decodeSnapshot(value);

    return signal?.aborted || !source.isCurrent() ? null : {
      pluginId: source.pluginId,
      generation: source.generation,
      items,
      error: null,
    };
  } catch (error) {
    if (signal?.aborted || !source.isCurrent()) {
      return null;
    }

    return {
      pluginId: source.pluginId,
      generation: source.generation,
      items: [],
      error: error instanceof SnapshotFailure ? error.code : 'plugin_notifications_failed',
    };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Два hook выполняются одновременно, остальные ждут свободный слот своего запроса.
 * Коллектор читает только переданные загруженные источники и никогда не импортирует пакет.
 */
export async function collectPluginNotifications(
  sources: readonly PluginNotificationSource[],
  signal?: AbortSignal,
): Promise<PluginNotificationSnapshot[]> {
  const results: Array<PluginNotificationSnapshot | null> = new Array(sources.length).fill(null);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < sources.length && !signal?.aborted) {
      const index = next++;

      results[index] = await readSnapshot(sources[index]!, signal);
    }
  }

  await Promise.all(Array.from({ length: Math.min(2, sources.length) }, () => worker()));

  return results.filter((row): row is PluginNotificationSnapshot => row !== null);
}
