import { createHash } from 'node:crypto';

import { recordOrEmpty } from '../../../../../shared/lib/objects.ts';

import { MobileInputError } from '../errors.ts';
import type { ActionTokens } from '../actionTokens.ts';
import type { MobileChatPort } from '../../chat/mobileHistory.ts';
import type { TextPage } from '../contract.ts';

export type Payload = Record<string, unknown>;
export type InternalResult = {
  statusCode: number;
  body: unknown;
};
export type FacadeDeps = {
  callApi: (method: string, path: string, body?: unknown) => Promise<InternalResult>;
  callRaw?: (
    method: string,
    path: string,
  ) => Promise<{
    statusCode: number;
    payload: Buffer;
    headers: Record<string, unknown>;
  }>;
  chat: MobileChatPort;
  tokens: ActionTokens;
  apkDirectory: string;
  subscribe: (listener: (name: string, payload: unknown) => void) => () => void;
};

/**
 * Читает только объектный DTO внутреннего API и переводит общий отказ по контракту v1.
 * 401/403 внутреннего токена означают ошибку адаптера, а не отзыв телефона.
 */
export async function upstream(
  deps: Pick<FacadeDeps, 'callApi'>,
  method: string,
  url: string,
  body?: unknown,
): Promise<Payload> {
  const result = await deps.callApi(method, url, body);
  const payload = recordOrEmpty(result.body);

  if (result.statusCode >= 400) {
    const auth = [401, 403].includes(result.statusCode);
    const changed =
      result.statusCode === 409 &&
      [
        'state_changed',
        'attempt_changed',
        'gate_not_current',
        'gate_rejected',
        'catalog_changed',
        'run_exists',
      ].includes(String(payload.error));

    throw new MobileInputError(
      auth ? 'upstream_auth' : changed ? 'state_changed' : `upstream_${result.statusCode}`,
      text(payload.message, 4000) || 'Внутренний запрос Кокпита не выполнен.',
      auth ? 502 : result.statusCode,
    );
  }

  return payload;
}

/**
 * Текст ограничивается по UTF-16 без разрыва surrogate pair на конце.
 * Полный текст решений публикуется страницами отдельно, без молчаливого обрезания.
 */
export function text(value: unknown, maximum = 32768): string {
  const valueText = typeof value === 'string' ? value : value == null ? '' : String(value);
  const result = valueText.slice(0, maximum);

  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}

/**
 * Канонический путь не допускает экранированных разделителей и выхода за ресурс.
 * Чатовые id и task id проверяются до формирования внутреннего URL.
 */
export function resourceId(value: unknown, numeric = false): string {
  if (
    typeof value !== 'string' ||
    !(numeric ? /^[1-9][0-9]{0,18}$/ : /^[A-Za-z0-9_-]{1,64}$/).test(value)
  ) {
    throw new MobileInputError('bad_request', 'Неверный идентификатор ресурса.');
  }

  return value;
}

/**
 * Пагинация не принимает отрицательные, дробные или неоднозначные числовые строки.
 * Верхний предел задаёт бюджет ответа и защищает память адаптера.
 */
export function count(value: unknown, fallback: number, maximum = 100): number {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    !Number.isSafeInteger(Number(value)) ||
    Number(value) > maximum
  ) {
    throw new MobileInputError('bad_request', 'Неверные параметры страницы.');
  }

  return Number(value);
}

/**
 * Список связывает cursor с конкретным составом, не отдавая неограниченную выборку.
 * Изменение снимка требует перечитать первую страницу вместо потери или повторов элементов.
 */
export function paginate<T>(values: T[], query: Payload, itemOverhead = 0) {
  const limit = count(query.limit, 100);
  const revision = createHash('sha256')
    .update(
      JSON.stringify(values, (key, value) =>
        key.endsWith('Token') || key === 'actions' ? undefined : value,
      ),
    )
    .digest('hex');
  let offset = 0;

  if (!limit) {
    throw new MobileInputError('bad_request', 'Размер страницы должен быть от 1 до 100.');
  }
  if (query.cursor !== undefined) {
    try {
      if (typeof query.cursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(query.cursor)) {
        throw new Error('bad_cursor');
      }

      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));

      if (
        cursor.revision !== revision ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0
      ) {
        throw new Error('stale_cursor');
      }

      offset = cursor.offset;
    } catch {
      throw new MobileInputError(
        'list_changed',
        'Список изменился; обновите первую страницу.',
        409,
      );
    }
  }

  const items: T[] = [];
  let bytes = 4096;

  for (const value of values.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(JSON.stringify(value)) + itemOverhead;

    if (bytes + size > 2 * 1024 * 1024) {
      break;
    }

    bytes += size;
    items.push(value);
  }

  if (!items.length && offset < values.length) {
    throw new MobileInputError('response_too_large', 'Элемент слишком большой для телефона.', 503);
  }

  const hasMore = offset + items.length < values.length;
  const nextCursor = hasMore
    ? Buffer.from(
        JSON.stringify({
          revision,
          offset: offset + items.length,
        }),
      ).toString('base64url')
    : null;

  return {
    items,
    hasMore,
    nextCursor,
  };
}

/**
 * Полный документ режется только по явному offset и immutable contentRevision.
 * Финальная страница подтверждает прочтение всей последовательности тем же устройством.
 */
export class TextPages {
  private reads = new Map<
    string,
    {
      revision: string;
      identityKey: string;
      offset: number;
      at: number;
    }
  >();
  private tokens: ActionTokens;

  constructor(tokens: ActionTokens) {
    this.tokens = tokens;
  }

  /**
   * Предпросмотр нужен для отбора страницы и её byte budget, без подтверждения чтения.
   * Скрытое пагинацией ожидание не получает прогресс чтения или readToken.
   */
  preview(source: string): TextPage {
    const part = text(source);
    const hasMore = part.length < source.length;

    return {
      text: part,
      contentRevision: createHash('sha256').update(source).digest('hex'),
      hasMore,
      nextOffset: hasMore ? part.length : null,
      readToken: null,
    };
  }

  /**
   * Решение принимает только прочитанный до конца immutable документ того же ожидания.
   * Новый текст или новая identity требует последовательного чтения заново.
   */
  isRead(device: string, resource: string, source: string, identity: Payload) {
    const read = this.reads.get(`${device}:${resource}`);
    const revision = createHash('sha256').update(source).digest('hex');
    const identityKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');

    return (
      !!read &&
      read.revision === revision &&
      read.identityKey === identityKey &&
      read.offset >= source.length &&
      Date.now() - read.at <= 10 * 60 * 1000
    );
  }

  /**
   * Подтверждение чтения связано также с immutable ожиданием, которому принадлежит текст.
   * Смена документа или ожидания инвалидирует ранее прочитанные страницы.
   */
  page(
    device: string,
    resource: string,
    source: string,
    query: Payload,
    identity: Payload = {},
  ): TextPage {
    const revision = createHash('sha256').update(source).digest('hex');
    const identityKey = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const offset = count(query.offset, 0, source.length);
    const key = `${device}:${resource}`;

    for (const [id, reading] of this.reads) {
      if (Date.now() - reading.at > 600000) {
        this.reads.delete(id);
      }
    }

    if (this.reads.size >= 4096 && !this.reads.has(key)) {
      throw new MobileInputError('busy', 'Открыто слишком много документов.', 503);
    }
    if (offset && query.contentRevision !== revision) {
      throw new MobileInputError(
        'content_changed',
        'Документ изменился; прочитайте его заново.',
        409,
      );
    }

    const previous = this.reads.get(key);

    if (
      offset &&
      (!previous ||
        previous.revision !== revision ||
        previous.identityKey !== identityKey ||
        previous.offset < offset)
    ) {
      throw new MobileInputError('content_not_read', 'Прочитайте документ последовательно.', 409);
    }

    const part = text(source.slice(offset));
    const hasMore = offset + part.length < source.length;

    this.reads.set(key, {
      revision,
      identityKey,
      offset: Math.max(
        previous?.revision === revision && previous.identityKey === identityKey
          ? previous.offset
          : 0,
        offset + part.length,
      ),
      at: Date.now(),
    });

    return {
      text: part,
      contentRevision: revision,
      hasMore,
      nextOffset: hasMore ? offset + part.length : null,
      readToken: hasMore
        ? null
        : this.tokens.issue(device, resource, 'read', {
            ...identity,
            contentRevision: revision,
          }),
    };
  }
}
