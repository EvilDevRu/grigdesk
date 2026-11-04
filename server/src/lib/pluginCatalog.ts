import { isDeepStrictEqual } from 'node:util';

import {
  decodeCatalogIndex, decodeCatalogDetail,
  type CatalogDetail, type CatalogIndex, type CatalogIndexResponse,
} from '../../../shared/plugins/pluginCatalogContracts.ts';
import { detailMatchesIndex } from '../../../shared/plugins/pluginCatalogPolicy.ts';

interface CatalogOptions {
  urls?: readonly string[];
  applicationVersion: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

const LOCAL_CATALOG_ORIGIN = 'http://127.0.0.1:4174';
const CATALOG_INDEX_URLS = [
  'https://grigdesk.com/api/plugins/v1/index.json',
  'https://grigdesk.ru/api/plugins/v1/index.json',
  `${LOCAL_CATALOG_ORIGIN}/api/plugins/v1/index.json`,
] as const;
const SOURCE_TIMEOUT_MS = 5000;
const DETAIL_TIMEOUT_MS = 12000;
// Сайт ограничивает README 256 тыс. символов: в UTF-8 вместе с заметками это около 1 MiB.
// Индекс и карточка получают один предел с запасом, чтобы допустимая карточка не отвергалась.
const DOCUMENT_LIMIT = 2 * 1024 * 1024;

export class CatalogReadError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super('Каталог плагинов недоступен или изменился. Обновите каталог.');
    this.statusCode = statusCode;
  }
}

/**
 * Каталог читается по HTTPS; HTTP разрешён только для локального резервного сайта.
 * Redirect запрещён, поэтому адрес каждой карточки остаётся на выбранном origin/base.
 */
function indexUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);

    if (url.username || url.password || url.search || url.hash
      || (url.protocol !== 'https:' && url.origin !== LOCAL_CATALOG_ORIGIN)
      || !/\/api\/plugins\/v1\/index\.json$/u.test(url.pathname)) {
      return null;
    }

    return url;
  } catch {
    return null;
  }
}

export class PluginCatalogService {
  private readonly options: CatalogOptions;
  private readonly urls: readonly URL[];
  private readonly now: () => number;
  private cache: {
    catalog: CatalogIndex;
    source: URL;
    fetchedAt: number;
  } | null = null;
  private indexFlight: Promise<void> | null = null;
  private retryAfter = 0;
  private closed = false;
  private readonly controllers = new Set<AbortController>();
  private readonly details = new Map<string, CatalogDetail>();
  private readonly detailFlights = new Map<string, {
    snapshot: CatalogIndex;
    flight: Promise<CatalogDetail>;
  }>();

  constructor(options: CatalogOptions) {
    this.options = options;
    this.urls = (options.urls ?? CATALOG_INDEX_URLS)
      .map(indexUrl).filter((url): url is URL => url !== null);
    this.now = options.now ?? Date.now;
  }

  /**
   * Индекс запрашивается лениво и одним flight, boot не зависит от публичной сети.
   * Неудача сохраняет последний проверенный снимок и ставит короткий cooldown.
   */
  async index(force = false): Promise<CatalogIndexResponse> {
    if (this.closed) {
      throw new CatalogReadError(503);
    }

    if (!this.urls.length) {
      return this.response('unavailable');
    }

    const fresh = this.cache && this.retryAfter === 0
      && this.now() - this.cache.fetchedAt < 300000;

    if ((!fresh || force) && this.now() >= this.retryAfter) {
      this.indexFlight ??= this.refresh().finally(() => {
        this.indexFlight = null;
      });
      await this.indexFlight;
    }

    if (this.closed) {
      throw new CatalogReadError(503);
    }

    if (!this.cache || this.now() - this.cache.fetchedAt > 86400000) {
      return this.response('unavailable');
    }

    return this.response(this.retryAfter === 0 ? 'fresh' : 'stale');
  }

  /**
   * Detail заказывается только для ID из принятого индекса, а не произвольного URL окна.
   * Один ID имеет один flight на снимок: запрос нового снимка не ждёт чтение прежнего,
   * а старый index snapshot не получает позднюю карточку.
   */
  async detail(id: string): Promise<CatalogDetail> {
    const deadline = Date.now() + DETAIL_TIMEOUT_MS;
    const result = await this.index();
    const snapshot = result.catalog ? this.cache?.catalog ?? null : null;
    const entry = snapshot?.plugins.find((item) => item.id === id);

    if (!snapshot || !entry) {
      throw new CatalogReadError(snapshot ? 404 : 502);
    }

    const cached = this.details.get(id);

    if (cached) {
      return structuredClone(cached);
    }

    let pending = this.detailFlights.get(id);

    if (pending?.snapshot !== snapshot) {
      const flight = this.readDetail(id, snapshot, entry.details, deadline).finally(() => {
        if (this.detailFlights.get(id)?.flight === flight) {
          this.detailFlights.delete(id);
        }
      });

      pending = {
        snapshot,
        flight,
      };
      this.detailFlights.set(id, pending);
    }

    return structuredClone(await pending.flight);
  }

  /**
   * Close отменяет только собственную сеть и ждёт завершения flight до выхода.
   * Кеш и опубликованный результат после начала закрытия уже не изменяются.
   */
  async close(): Promise<void> {
    this.closed = true;

    for (const controller of this.controllers) {
      controller.abort();
    }

    await Promise.allSettled([
      this.indexFlight,
      ...[...this.detailFlights.values()].map((pending) => pending.flight),
    ]);
    this.details.clear();
    this.cache = null;
  }

  /**
   * Публичный JSON ограничен во время чтения stream, включая ответ без Content-Length.
   * Deadline охватывает fetch и тело; никакие cookies и credentials сайта не передаются.
   */
  private async read(
    url: URL,
    limit: number,
    deadline = Date.now() + SOURCE_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.closed) {
      throw new CatalogReadError(503);
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      throw new CatalogReadError(502);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    this.controllers.add(controller);

    try {
      const response = await (this.options.fetch ?? globalThis.fetch)(url, {
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });

      const type = response.headers.get('content-type')?.toLowerCase() ?? '';

      if (!response.ok || !type.startsWith('application/json') || !response.body) {
        // Отвергнутое тело никто не читает: cancel освобождает соединение сразу, а не по GC.
        await response.body?.cancel().catch(() => undefined);

        throw new CatalogReadError(502);
      }

      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;

      try {
        while (true) {
          const chunk = await reader.read();

          if (chunk.done) {
            break;
          }

          length += chunk.value.byteLength;

          if (length > limit || this.closed) {
            await reader.cancel();

            throw new CatalogReadError(502);
          }

          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }

      const bytes = Buffer.concat(chunks, length);

      return JSON.parse(bytes.toString('utf8')) as unknown;
    } finally {
      clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }

  /**
   * Каждый refresh начинает с основного сайта и пробует резервный при любом отказе чтения.
   * Принятый снимок и его источник публикуются вместе; общий отказ сохраняет прежний кеш.
   */
  private async refresh(): Promise<void> {
    for (const source of this.urls) {
      if (this.closed) {
        return;
      }

      try {
        const catalog = decodeCatalogIndex(await this.read(source, DOCUMENT_LIMIT));

        if (this.closed) {
          return;
        }

        this.cache = {
          catalog,
          source,
          fetchedAt: this.now(),
        };
        this.details.clear();
        this.retryAfter = 0;

        return;
      } catch {
        // Ошибки сети, HTTP и JSON одинаково переводят чтение на следующий сайт.
        // Непроверенный ответ не меняет снимок или успешное время его получения.
      }
    }

    if (!this.closed) {
      this.retryAfter = this.now() + 30000;
    }
  }

  /**
   * Ответ сохраняет declared freshness; отсутствующий снимок всегда null.
   * Returned DTO — копия, которую consumer не может использовать для изменения кеша.
   */
  private response(state: CatalogIndexResponse['state']): CatalogIndexResponse {
    const available = state === 'fresh' || state === 'stale';

    return {
      state,
      applicationVersion: this.options.applicationVersion,
      fetchedAt: available ? new Date(this.cache!.fetchedAt).toISOString() : null,
      catalog: available ? structuredClone(this.cache!.catalog) : null,
    };
  }

  /**
   * Карточка сначала читается с сайта принятого индекса; резерв сверяет весь тот же снимок.
   * Смена снимка и close запрещают позднюю публикацию или дальнейшие запросы к зеркалам.
   */
  private async readDetail(
    id: string,
    snapshot: CatalogIndex,
    document: string,
    deadline: number,
  ): Promise<CatalogDetail> {
    this.assertSnapshot(snapshot);

    const active = this.cache!.source;
    const sources = [active, ...this.urls.filter((url) => url.href !== active.href)];
    let changed = false;

    for (const source of sources) {
      const attemptDeadline = Math.min(deadline, Date.now() + SOURCE_TIMEOUT_MS);

      try {
        if (source !== active) {
          const candidate = decodeCatalogIndex(
            await this.read(source, DOCUMENT_LIMIT, attemptDeadline),
          );

          if (!isDeepStrictEqual(candidate, snapshot)) {
            throw new CatalogReadError(409);
          }
        }

        const address = new URL(document, source);
        const detail = decodeCatalogDetail(
          await this.read(address, DOCUMENT_LIMIT, attemptDeadline),
        );

        this.assertSnapshot(snapshot);

        if (!detailMatchesIndex(snapshot, detail, id)) {
          throw new CatalogReadError(409);
        }

        this.cache!.source = source;
        this.details.set(id, detail);

        if (this.details.size > 16) {
          this.details.delete(this.details.keys().next().value!);
        }

        return detail;
      } catch (error) {
        this.assertSnapshot(snapshot);
        changed ||= error instanceof CatalogReadError && error.statusCode === 409;
      }
    }

    throw new CatalogReadError(changed ? 409 : 502);
  }

  /**
   * Принадлежность снимку проверяется перед публикацией и перед переходом на другой сайт.
   * Отмена сервиса отличается от обновления индекса и не запускает резервные чтения.
   */
  private assertSnapshot(snapshot: CatalogIndex): void {
    if (this.closed) {
      throw new CatalogReadError(503);
    }

    if (this.cache?.catalog !== snapshot) {
      throw new CatalogReadError(409);
    }
  }
}
