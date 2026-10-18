// Выбор маршрута по оценке триажа. Разделены два разных вопроса, которые раньше были
// слиты в одно поле route_guess: РОД работы («новое поведение», «сломано», «медленно»)
// называет модель по смыслу задачи, а ГЛУБИНУ («полный маршрут», «средний», «лёгкий»)
// считает эта политика по числам самой же оценки.
//
// Причина разделения — измеренная: из 126 сохранённых оценок модель назвала «trivial»
// три раза, тогда как по её собственным complexity/risk/diff_size лёгкими были 44.
// Модель хорошо отвечает на вопрос «что это за работа» и плохо — на «сколько проверок
// она заслуживает»: второй вопрос требует одинаковой линейки, а не настроения захода.
//
// Соответствие «род:глубина → маршрут» знает ТОЛЬКО профиль (PROFILE_TRIAGE_ROUTES):
// имена маршрутов проектные, и в GrigDesk их быть не должно.

export type RouteDepth = 'light' | 'mid' | 'full';

export interface RouteMap {
  byKey: Map<string, string>;
  kinds: string[];
}

export interface DepthDecision {
  depth: RouteDepth;
  reason: string;
}

export interface RouteDecision extends DepthDecision {
  route: string | null;
  kind: string | null;
}

export interface RouteContext {
  routeMap?: string;
  routes?: string[];
}

// Оценка триажа приходит из файла на диске: политика читает у неё только числа и
// признаки, по которым считает глубину, и не требует остальных полей.
export interface RouteAnalysis {
  complexity?: unknown;
  risk?: unknown;
  diff_size?: unknown;
  confidence?: unknown;
  questions?: unknown;
  needs_clarification?: unknown;
  route_kind?: unknown;
  route_guess?: unknown;
}

/** Ступени глубины от самой лёгкой к полной. */
export const DEPTHS: readonly RouteDepth[] = Object.freeze(['light', 'mid', 'full']);

const DEPTH_SET = new Set<string>(DEPTHS);
const KIND_RE = /^[a-z][a-z0-9-]{0,40}$/;
const ROUTE_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;

/**
 * Разбирает карту профиля вида «feature:light=trivial feature:full=feature».
 * Разделитель — любой пробел или перевод строки; повтор ключа игнорируется (первый
 * побеждает), мусорные пары отбрасываются молча: профиль правит человек, и одна
 * опечатка в нём не должна лишать триаж всей маршрутизации.
 */
export function parseRouteMap(raw: unknown): RouteMap {
  const byKey = new Map<string, string>();
  const kinds: string[] = [];
  for (const pair of String(raw || '').split(/\s+/).filter(Boolean)) {
    const match = /^([a-z0-9-]+):([a-z]+)=([a-z0-9_-]+)$/.exec(pair);
    if (!match) {
      continue;
    }
    const [, kind = '', depth = '', route = ''] = match;
    if (!KIND_RE.test(kind) || !DEPTH_SET.has(depth) || !ROUTE_RE.test(route)) {
      continue;
    }
    const key = `${kind}:${depth}`;
    if (byKey.has(key)) {
      continue;
    }
    byKey.set(key, route);
    if (!kinds.includes(kind)) {
      kinds.push(kind);
    }
  }
  return { byKey, kinds };
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : null;
}

/**
 * Глубина маршрута по оценке. Пороги подобраны на архиве оценок и держат ровно одно
 * правило: понижать глубину можно только тогда, когда триаж уверен и в постановке не
 * осталось открытых вопросов. Нерешённый вопрос дороже сэкономленных минут — ответ на
 * него меняет и объём, и сам маршрут.
 */
export function resolveDepth(analysis: RouteAnalysis | null | undefined): DepthDecision {
  const complexity = numeric(analysis?.complexity);
  const risk = numeric(analysis?.risk);
  const size = String(analysis?.diff_size || '').toUpperCase();
  const confidence = String(analysis?.confidence || '').toLowerCase();
  const questions = Array.isArray(analysis?.questions) ? analysis.questions.length : 0;
  const needsClarification = analysis?.needs_clarification === true;

  if (complexity === null || risk === null) {
    return { depth: 'full', reason: 'оценка неполна — полный маршрут' };
  }
  if (risk >= 4) {
    return { depth: 'full', reason: `риск ${risk} — цена ошибки требует полного маршрута` };
  }
  if (complexity >= 4) {
    return { depth: 'full', reason: `сложность ${complexity} — нужен план и его критика` };
  }
  const compact = complexity <= 2 && ['S', 'M'].includes(size);
  if (compact && risk <= 2 && size === 'S' && confidence === 'high'
      && !needsClarification && questions === 0) {
    return {
      depth: 'light',
      reason: `сложность ${complexity}, риск ${risk}, размер S, уверенность высокая, вопросов нет`,
    };
  }
  if (compact && risk <= 3) {
    const blocker = needsClarification || questions > 0
      ? 'есть открытые вопросы, поэтому не лёгкий'
      : `уверенность ${confidence || 'не указана'}`;
    return {
      depth: 'mid',
      reason: `сложность ${complexity}, риск ${risk}, размер ${size} — план не нужен (${blocker})`,
    };
  }
  return {
    depth: 'full',
    reason: `сложность ${complexity}, риск ${risk}, размер ${size || 'не указан'} — полный маршрут`,
  };
}

/**
 * Род работы: берём то, что назвала модель, но принимаем только объявленный профилем
 * (или, если карты нет, существующий в опубликованном каталоге) идентификатор.
 */
function resolveKind(
  analysis: RouteAnalysis | null | undefined,
  { kinds, routes }: { kinds: string[]; routes: string[] },
): string | null {
  const named = String(analysis?.route_kind || analysis?.route_guess || '').trim().toLowerCase();
  if (!named || !KIND_RE.test(named)) {
    return null;
  }
  if (kinds.length) {
    return kinds.includes(named) ? named : null;
  }
  return routes.includes(named) ? named : null;
}

/**
 * Итоговая рекомендация маршрута для формы запуска.
 * Ступень, которой у рода нет, штатно поднимается до full: «лёгкой версии не бывает» —
 * это ответ профиля, а не ошибка. Маршрут, отсутствующий в опубликованном каталоге,
 * не предлагается вовсе: обещать то, чего движок не примет, нельзя.
 */
export function resolveRoute(
  analysis: RouteAnalysis | null | undefined,
  { routeMap = '', routes = [] }: RouteContext = {},
): RouteDecision {
  const { byKey, kinds } = parseRouteMap(routeMap);
  const available = Array.isArray(routes) ? routes : [];
  const { depth, reason } = resolveDepth(analysis);
  const kind = resolveKind(analysis, { kinds, routes: available });
  if (!kind) {
    return { route: null, kind: null, depth, reason };
  }

  const candidates: { route: string | undefined; depth: RouteDepth; reason: string }[] = [
    { route: byKey.get(`${kind}:${depth}`), depth, reason },
    {
      route: byKey.get(`${kind}:full`),
      depth: 'full',
      reason: `${reason}; у рода «${kind}» этой ступени нет — полный маршрут`,
    },
    // Профиль без карты: род и есть идентификатор маршрута каталога. Глубина в этом
    // случае остаётся справочной — понижать её нечем.
    { route: kind, depth, reason },
  ];
  for (const candidate of candidates) {
    if (candidate.route && available.includes(candidate.route)) {
      return { ...candidate, route: candidate.route, kind };
    }
  }
  return { route: null, kind, depth, reason };
}
