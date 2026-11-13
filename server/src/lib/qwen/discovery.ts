import { isolatedFetch } from '../isolatedFetch.ts';
import { isRecord } from '../../../../shared/lib/objects.ts';
import { readQwenSnapshot, type QwenSnapshot } from './settings.ts';
import { selectedQwenService } from './services.ts';

interface DiscoveryEntry {
  at: number;
  snapshot?: QwenSnapshot;
  error?: string;
}

const discovered = new Map<string, DiscoveryEntry>();
const MAX_ENTRIES = 16;
const CACHE_MS = 60_000;

/**
 * Unix-время сервиса становится ISO-датой каталога; мусор и переполнение даты
 * не получают выдуманной свежести.
 */
function serviceCreatedAt(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 8_640_000_000_000) {
    return '';
  }

  return new Date(value * 1000).toISOString();
}

/**
 * Ответ сервиса ограничивается декларациями моделей, без копирования его настроек.
 * Явно нетекстовый вывод помечается признаком нечат-модели, а не выбрасывается:
 * запись остаётся видимой под «Показывать все модели» с причиной. Отсутствие
 * metadata не выдумывает capabilities.
 */
function automaticModels(body: unknown, baseUrl: string): Record<string, unknown>[] {
  if (!isRecord(body) || !Array.isArray(body.data) || body.data.length > 10_000) {
    throw new Error('Qwen: сервис вернул неверный каталог моделей');
  }

  const ids = new Set<string>();
  const models: Record<string, unknown>[] = [];

  for (const entry of body.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id
      || entry.id.length > 256 || /[\s\x00-\x1f\x7f]/u.test(entry.id) || ids.has(entry.id)) {
      continue;
    }

    const model: Record<string, unknown> = {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 256) : entry.id,
      baseUrl,
      envKey: 'DASHSCOPE_API_KEY',
    };
    const created = serviceCreatedAt(entry.created);

    if (created) {
      model.createdAt = created;
    }

    const architecture = isRecord(entry.architecture) ? entry.architecture : {};
    const outputs = architecture.output_modalities;

    if (Array.isArray(outputs) && !outputs.includes('text')) {
      model.nonChat = true;
      model.nonChatReason = 'Сервис объявил нетекстовый вывод модели';
    }

    ids.add(entry.id);
    models.push(model);
  }

  if (!models.length) {
    throw new Error('Qwen: сервис не вернул доступные модели чата');
  }

  return models;
}

/**
 * Первый каталог собирается без пользовательского settings.json и без prompt модели.
 * Ключ уходит только выбранному сервису; redirect и подбор другого адреса запрещены.
 */
export async function resolveQwenSnapshot(value: unknown, {
  refresh = false,
  signal,
  fetch: fetcher = isolatedFetch,
  service: selectedService,
}: {
  refresh?: boolean;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  service?: { label: string; baseUrl: string };
} = {}): Promise<QwenSnapshot> {
  signal?.throwIfAborted();

  const source = readQwenSnapshot(value);

  if (!source.automatic || !process.env.DASHSCOPE_API_KEY) {
    return source;
  }

  const service = selectedService || selectedQwenService();
  const previous = discovered.get(source.fingerprint);

  if (!refresh && previous?.snapshot && Date.now() - previous.at < CACHE_MS) {
    return previous.snapshot;
  }

  try {
    const response = await fetcher(`${service.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
      redirect: 'error',
      signal,
    });

    if (!response.ok) {
      throw new Error(`Qwen: каталог ${service.label} недоступен (HTTP ${response.status})`);
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      throw new Error('Qwen: сервис вернул неверный каталог моделей');
    }

    signal?.throwIfAborted();

    const snapshot = readQwenSnapshot(value, automaticModels(body, service.baseUrl));

    if (snapshot.fingerprint !== source.fingerprint) {
      throw new Error('Qwen: настройки доступа изменились; повторите обновление каталога');
    }

    discovered.set(source.fingerprint, { at: Date.now(), snapshot });

    return snapshot;
  } catch (error) {
    // Ответ и исключение HTTP-клиента могут содержать ключ: сохраняется только свой диагноз.
    // Устаревший каталог после неудачного явного обновления не выдаётся за свежий.
    const message = error instanceof Error && error.message.startsWith('Qwen:')
      ? error.message : 'Qwen: не удалось получить каталог; проверьте сервис, регион и соединение';

    discovered.set(source.fingerprint, { at: Date.now(), error: message });
    signal?.throwIfAborted();

    throw new Error(message);
  } finally {
    while (discovered.size > MAX_ENTRIES) {
      discovered.delete(discovered.keys().next().value!);
    }
  }
}

/**
 * Карточка показывает причину последнего discovery, даже если общий реестр сохранил копию.
 * Смена сервиса или ключа имеет другой fingerprint и не наследует прежний отказ.
 */
export function qwenDiscoveryError(value: unknown): string | undefined {
  try {
    return discovered.get(readQwenSnapshot(value).fingerprint)?.error;
  } catch {
    return undefined;
  }
}
