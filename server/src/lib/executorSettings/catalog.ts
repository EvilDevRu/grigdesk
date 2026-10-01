// Каталог привязан к контексту будущего запуска, а не только версии CLI.
// Общий кэш коалесцирует чтения и сохраняет последний безопасный снимок при сбое.

import type { NativeSettingsCapability, NativeSettingsContext, NativeSettingsSnapshot } from './types.ts';
import type { NormalizedSettingNode } from './types.ts';
import { normalizeJsonSchema } from './jsonSchema.ts';
import { normalizeSchemastery } from './schemastery.ts';
import { settingsFingerprint } from './fingerprint.ts';

export interface NativeSettingsCatalogRead {
  context: NativeSettingsContext;
  state: 'ready' | 'partial' | 'stale' | 'unavailable';
  schemaRevision: string | null;
  fields: NormalizedSettingNode[];
  snapshot: NativeSettingsSnapshot | null;
  generation: number;
}

interface CatalogCacheEntry {
  at: number;
  generation: number;
  result?: NativeSettingsCatalogRead;
  pending?: Promise<NativeSettingsCatalogRead>;
}

/**
 * Ревизия включает доступность редактора и обнаруженные ключи типизированного словаря.
 * Текущие значения и время discovery не меняют отпечаток структуры сами по себе.
 */
function fieldRevision(node: NormalizedSettingNode): unknown {
  return {
    id: node.id,
    path: node.path,
    kind: node.kind,
    constraints: node.constraints,
    writable: node.writable,
    reason: node.reason,
    owner: node.owner,
    channelId: node.channelId,
    secret: node.secret,
    children: node.children?.map(fieldRevision),
    items: node.items ? fieldRevision(node.items) : undefined,
  };
}

export class ProviderSettingsCatalogCache {
  readonly clock: () => number;
  readonly ttlMs: number;
  readonly timeoutMs: number;
  readonly cleanupMs: number;
  readonly entries = new Map<string, CatalogCacheEntry>();

  constructor({ clock = Date.now, ttlMs = 60_000, timeoutMs = 15_000, cleanupMs = 3_500 } = {}) {
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.timeoutMs = timeoutMs;
    this.cleanupMs = cleanupMs;
  }

  isCurrent(read: NativeSettingsCatalogRead): boolean {
    return this.entries.get(settingsFingerprint(read.context))?.generation === read.generation;
  }

  peek(context: NativeSettingsContext): NativeSettingsCatalogRead {
    return (
      this.entries.get(settingsFingerprint(context))?.result ?? {
        context,
        state: 'unavailable',
        schemaRevision: null,
        fields: [],
        snapshot: null,
        generation: 0,
      }
    );
  }

  /**
   * Сброс использует последний каталог только для ответа, без обращения к CLI.
   * Удаление сохранённого выбора остаётся доступным при исчезнувшем профиле или бинаре.
   */
  peekProvider(providerId: string): NativeSettingsCatalogRead {
    const latest = [...this.entries.values()]
      .filter((entry) => entry.result?.context.providerId === providerId)
      .sort((left, right) => right.at - left.at)[0]?.result;

    return (
      latest ??
      this.peek({
        providerId,
        binaryIdentity: 'unknown',
        profileFingerprint: 'unknown',
        transport: 'unknown',
        mode: 'unknown',
        cwdRealpath: '',
      })
    );
  }

  /**
   * Одно чтение источника обслуживает одновременные запросы одного контекста.
   * Свежий результат заменяет кэш только своего поколения.
   */
  async read(
    capability: Pick<NativeSettingsCapability, 'discover'>,
    context: NativeSettingsContext,
    { refresh = false } = {},
  ): Promise<NativeSettingsCatalogRead> {
    const key = settingsFingerprint(context);
    const previous = this.entries.get(key);

    if (!refresh && previous?.pending) {
      return previous.pending;
    }

    if (!refresh && previous?.result && this.clock() - previous.at < this.ttlMs) {
      return previous.result;
    }

    const entry: CatalogCacheEntry = {
      at: this.clock(),
      generation: (previous?.generation ?? 0) + 1,
      result: previous?.result,
    };

    this.entries.set(key, entry);
    entry.pending = this.discover(capability, context, entry, refresh);

    return entry.pending;
  }

  /**
   * Ограниченный probe не использует чатовый runtime. Сбой не доказывает удаление
   * настроек и оставляет последний успешный снимок с состоянием stale.
   */
  private async discover(
    capability: Pick<NativeSettingsCapability, 'discover'>,
    context: NativeSettingsContext,
    entry: CatalogCacheEntry,
    refresh: boolean,
  ): Promise<NativeSettingsCatalogRead> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => {
          reject(new Error('Источник настроек не завершил проверку вовремя'));
        },
        { once: true },
      );
    });
    let result: NativeSettingsCatalogRead;
    let discovery: Promise<NativeSettingsSnapshot> | undefined;

    try {
      discovery = capability.discover(context, { signal: controller.signal, refresh });

      const snapshot = await Promise.race([discovery, aborted]);
      const fields = snapshot.areas.flatMap((area) =>
        (area.format === 'schemastery' ? normalizeSchemastery : normalizeJsonSchema)(area.schema, {
          ...area,
          ownership: snapshot.ownership,
        }),
      );

      result = {
        context,
        state: snapshot.source.coverage.every((area) => area.coverage === 'complete') ? 'ready' : 'partial',
        schemaRevision: settingsFingerprint({
          context,
          areas: snapshot.areas.map(({ base: _base, ...area }) => area),
          ownership: snapshot.ownership,
          coverage: snapshot.source.coverage,
          fields: fields.map(fieldRevision),
        }),
        fields,
        snapshot,
        generation: entry.generation,
      };
    } catch {
      result = entry.result?.snapshot
        ? {
            ...entry.result,
            state: 'stale',
            generation: entry.generation,
          }
        : {
            context,
            state: 'unavailable',
            schemaRevision: null,
            fields: [],
            snapshot: null,
            generation: entry.generation,
          };
    } finally {
      clearTimeout(timeout);
      controller.abort();

      if (discovery) {
        // Reader освобождает свой процесс в finally. Следующий refresh после отказа
        // не запускается поверх ещё живого CLI; неисправный reader имеет предел cleanup.
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

        try {
          await Promise.race([
            discovery.catch(() => {}),
            new Promise<void>((resolve) => {
              cleanupTimer = setTimeout(resolve, this.cleanupMs);
            }),
          ]);
        } finally {
          clearTimeout(cleanupTimer);
        }
      }
    }

    if (this.entries.get(settingsFingerprint(context)) === entry) {
      entry.result = result;
      entry.at = this.clock();
      entry.pending = undefined;
    }

    return result;
  }
}
