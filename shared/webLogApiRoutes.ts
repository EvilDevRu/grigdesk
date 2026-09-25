// Шаблоны /api для журнала окна. Каталог приходит из живой таблицы маршрутов
// сервера, поэтому в записи попадает `/api/tasks/:id/graph`, а не реальный id.

const TEMPLATE_PATTERN = /^\/api(?:\/[A-Za-z0-9._~:*?()^$+-]+)*$/u;

type CompiledRoute = {
  template: string;
  segments: string[];
};

/**
 * Шаблон — путь /api без query, hash и управляющих символов, ограниченной длины.
 * Форма не доказывает, что сервер знает шаблон: это проверяет живой каталог.
 */
export function isApiRouteTemplate(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && TEMPLATE_PATTERN.test(value);
}

/**
 * Оценка совпадения повторяет приоритет роутера: статический сегмент важнее
 * параметра, параметр важнее `*`. Несовпадение возвращает null.
 */
function matchScore(route: CompiledRoute, parts: string[]): number | null {
  let score = 0;

  for (let index = 0; index < route.segments.length; index += 1) {
    const segment = route.segments[index]!;
    const part = parts[index];

    if (segment === '*') {
      return score;
    }
    if (segment.includes(':')) {
      const optionalTail = segment.endsWith('?') && index === route.segments.length - 1;

      if (part === undefined && optionalTail) {
        return score;
      }
      if (!part) {
        return null;
      }

      score += 1;
      continue;
    }
    if (part !== segment) {
      return null;
    }

    score += 100;
  }

  return parts.length === route.segments.length ? score : null;
}

/**
 * Возвращает сопоставитель реального пути с самым точным шаблоном каталога.
 * Неизвестный путь становится `other`: его сегменты в журнал не попадают.
 */
export function createApiRouteMatcher(templates: readonly string[]): (path: string) => string {
  const routes: CompiledRoute[] = templates
    .filter(isApiRouteTemplate)
    .map((template) => ({
      template,
      segments: template.split('/').slice(1),
    }));

  return (path) => {
    const clean = path.replace(/^https?:\/\/[^/]+/u, '').split(/[?#]/u, 1)[0] ?? '';
    const parts = clean.split('/').slice(1);
    let best: { template: string; score: number } | null = null;

    for (const route of routes) {
      const score = matchScore(route, parts);

      if (score !== null && (!best || score > best.score)) {
        best = {
          template: route.template,
          score,
        };
      }
    }

    return best?.template ?? 'other';
  };
}
