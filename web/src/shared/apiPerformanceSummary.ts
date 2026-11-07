import type { ApiSummary } from '../../../shared/web-log/surfacePerformance.ts';

type Input = {
  method?: unknown;
  path?: unknown;
  ms?: unknown;
  headersMs?: unknown;
  bodyMs?: unknown;
  parseMs?: unknown;
  serverMs?: unknown;
  pipeMs?: unknown;
};

/**
 * От нештатного события принимаются только конечные неотрицательные числа.
 * Верхний предел совпадает с пределом общей схемы числовых полей журнала.
 */
function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(value, 1_000_000_000) : 0;
}

/**
 * Числа объединяются без удержания исходных событий, request-id и контекста данных.
 * Поля серверного/мостового времени имеют собственное число доступных наблюдений.
 */
function merge(target: ApiSummary, source: ApiSummary): void {
  for (const key of ['count', 'totalMs', 'headersMs', 'bodyMs', 'parseMs', 'serverMs',
    'serverCount', 'pipeMs', 'pipeCount'] as const) {
    target[key] = Math.min(1_000_000_000, target[key] + source[key]);
  }

  target.maxMs = Math.max(target.maxMs, source.maxMs);
}

/**
 * Память ограничена 128 группами, выход — 15 группами и одной сводкой остальных.
 * Даже переполнение каталога не теряет суммарное число попыток и длительность.
 */
export function createApiPerformanceSummary(options: {
  now: () => number;
  emit: (data: ApiSummary) => void;
}) {
  const groups = new Map<string, ApiSummary>();
  let started = options.now();

  /**
   * Пустая строка содержит только имя метода и уже нормализованный путь.
   * Период назначается при flush по фактической длительности окна.
   */
  function empty(method = 'other', path = 'other'): ApiSummary {
    return {
      method,
      path,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      headersMs: 0,
      bodyMs: 0,
      parseMs: 0,
      serverMs: 0,
      serverCount: 0,
      pipeMs: 0,
      pipeCount: 0,
      periodMs: 0,
    };
  }

  return {
    /**
     * Суммирует одну попытку в ограниченном каталоге групп.
     * Переполнение сохраняет числа в общей строке без исходных событий.
     */
    add(data: Input): void {
      const method = typeof data.method === 'string' ? data.method : 'other';
      const path = typeof data.path === 'string' ? data.path : 'other';
      let key = `${method}:${path}`;

      if (!groups.has(key) && groups.size >= 127) {
        key = 'other';
      }

      const row = groups.get(key) ?? (key === 'other' ? empty() : empty(method, path));
      const sample = empty();

      sample.count = 1;
      sample.totalMs = number(data.ms);
      sample.maxMs = sample.totalMs;
      sample.headersMs = number(data.headersMs);
      sample.bodyMs = number(data.bodyMs);
      sample.parseMs = number(data.parseMs);
      sample.serverMs = number(data.serverMs);
      sample.serverCount = typeof data.serverMs === 'number' && Number.isFinite(data.serverMs) ? 1 : 0;
      sample.pipeMs = number(data.pipeMs);
      sample.pipeCount = typeof data.pipeMs === 'number' && Number.isFinite(data.pipeMs) ? 1 : 0;
      merge(row, sample);
      groups.set(key, row);
    },
    /**
     * Завершает текущее окно и объединяет хвост в одну строку.
     * Следующий период начинается без сохранённых request-id и старых счётчиков.
     */
    flush(): void {
      const periodMs = Math.max(0, options.now() - started);
      const rest = groups.get('other') ?? empty();

      groups.delete('other');

      const rows = [...groups.values()].sort((a, b) => b.count - a.count);
      const output = rows.slice(0, 15);

      rows.slice(15).forEach((row) => merge(rest, row));

      if (rest.count > 0) {
        output.push(rest);
      }

      groups.clear();
      started = options.now();
      output.forEach((row) => options.emit({ ...row, periodMs }));
    },
    clear(): void {
      groups.clear();
      started = options.now();
    },
  };
}
