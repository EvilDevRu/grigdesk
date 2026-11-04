import {
  RELEASE_CHANNEL_URLS, decodeChannelIndex, type ChannelEntry,
} from '../../../shared/runtime/releaseChannelContracts.ts';

interface ChannelOptions {
  urls?: readonly string[];
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const SOURCE_TIMEOUT_MS = 5000;
const DOCUMENT_LIMIT = 1024 * 1024;
const FRESH_MS = 5 * 60_000;
const COOLDOWN_MS = 30_000;

/**
 * Канал релизов читается по образцу каталога плагинов: HTTPS без redirects, короткий
 * таймаут, собственный лимит размера 1 MiB, fresh-кеш и cooldown после отказа.
 * Подпись здесь не проверяется: это забота публикатора и менеджера обновления.
 */
export class ReleaseChannelService {
  private readonly urls: readonly string[];

  private readonly fetcher: typeof globalThis.fetch;

  private readonly now: () => number;

  private cache: {
    entry: ChannelEntry | null;
    fetchedAt: number
  } | null = null;

  private retryAfter = 0;

  private flight: Promise<ChannelEntry | null> | null = null;

  constructor(options: ChannelOptions = {}) {
    this.urls = options.urls ?? RELEASE_CHANNEL_URLS;
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  /**
   * Параллельные запросы разделяют один сетевой полёт, включая принудительную проверку.
   * Ошибка не сохраняется в promise: после cooldown разрешена новая попытка.
   */
  async latest(force = false): Promise<ChannelEntry | null> {
    if (!this.flight) {
      this.flight = this.#read(force).finally(() => {
        this.flight = null;
      });
    }

    return this.flight;
  }

  /**
   * Читает первый исправный HTTPS-источник, ограничивая байты до разбора JSON.
   * Успех кешируется на пять минут, общий отказ включает паузу повторных запросов.
   */
  async #read(force: boolean): Promise<ChannelEntry | null> {
    const current = this.now();

    if (!force && this.cache && current - this.cache.fetchedAt < FRESH_MS) {
      return this.cache.entry;
    }
    if (current < this.retryAfter) {
      throw new Error('Канал релизов недоступен: повтор после паузы');
    }

    let lastError: unknown = null;

    for (const url of this.urls) {
      try {
        if (new URL(url).protocol !== 'https:') {
          throw new Error('Канал релизов требует HTTPS');
        }

        const response = await this.fetcher(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
          headers: { accept: 'application/json' },
        });

        if (!response.ok) {
          throw new Error(`Канал ответил ${response.status}`);
        }

        const reader = response.body?.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;

        if (!reader) {
          throw new Error('Канал вернул пустое тело ответа');
        }

        try {
          while (true) {
            const result = await reader.read();

            if (result.done) {
              break;
            }

            size += result.value.byteLength;

            if (size > DOCUMENT_LIMIT) {
              await reader.cancel();
              throw new Error('Ответ канала превышает лимит');
            }

            chunks.push(result.value);
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(size);
        let offset = 0;

        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }

        const text = new TextDecoder().decode(bytes);

        const index = decodeChannelIndex(JSON.parse(text));

        this.cache = {
          entry: index.latest,
          fetchedAt: this.now()
        };

        return index.latest;
      } catch (error) {
        lastError = error;
      }
    }

    this.retryAfter = this.now() + COOLDOWN_MS;
    throw lastError instanceof Error ? lastError : new Error('Канал релизов недоступен');
  }
}
