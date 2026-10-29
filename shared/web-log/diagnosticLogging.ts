import type { WebLogEntry, WebLogEvent } from './webLogContracts.ts';

export const DIAGNOSTIC_LEVELS = ['off', 'errors', 'decisions', 'verbose'] as const;
export const DIAGNOSTIC_TIMER_LIMIT_MS = 2_147_483_647;

export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];

const RANK: Record<DiagnosticLevel, number> = {
  off: 0,
  errors: 1,
  decisions: 2,
  verbose: 3,
};

// Требуемый уровень назначен виду события, а не его визуальной важности `lvl`.
// Ошибки и ручная отметка нужны уже в режиме ошибок; переходы и UI-слои
// остаются в предыстории при режиме решений.
const WEB_LOG_THRESHOLD: Record<WebLogEvent, Exclude<DiagnosticLevel, 'off'>> = {
  'app.start': 'decisions',
  'app.pagehide': 'decisions',
  'page.show': 'decisions',
  'page.visibility': 'verbose',
  'page.freeze': 'decisions',
  'page.resume': 'decisions',
  'net.online': 'decisions',
  'net.offline': 'decisions',
  'vue.error': 'errors',
  'js.error': 'errors',
  'js.rejection': 'errors',
  'res.error': 'errors',
  'router.nav': 'decisions',
  'router.error': 'errors',
  'api.fail': 'errors',
  'api.slow': 'verbose',
  'sse.open': 'decisions',
  'sse.hello': 'decisions',
  'sse.error': 'errors',
  'auth.change': 'decisions',
  'sw.updatefound': 'decisions',
  'sw.controllerchange': 'decisions',
  'sw.needRefresh': 'decisions',
  'store.error': 'errors',
  'ui.layer': 'decisions',
  'ui.focus': 'verbose',
  'perf.ready': 'verbose',
  'perf.operation': 'verbose',
  'perf.block': 'verbose',
  mark: 'errors',
  'log.transport': 'errors',
  'log.loss': 'errors',
  'log.suppressed': 'errors',
};

/**
 * Принимаем только уровни общего контракта, в том числе от сервера и storage.
 * Любое другое значение означает «уровень неизвестен».
 */
export function diagnosticLevel(value: unknown): DiagnosticLevel | null {
  return typeof value === 'string' && Object.hasOwn(RANK, value)
    ? value as DiagnosticLevel
    : null;
}

/**
 * Одна матрица порогов используется ядром окна и серверным приёмником.
 * Неизвестный уровень не разрешает ни одного события.
 */
export function allowsWebLogEvent(level: DiagnosticLevel | null, event: WebLogEvent): boolean {
  return level !== null && RANK[level] >= RANK[WEB_LOG_THRESHOLD[event]];
}

/**
 * При смене уровня удаляем запрещённые записи и из плоского дампа.
 * Ключ (page, seq) принятой записи не меняется, даже если её дамп сократился.
 */
export function filterWebLogEntry(
  level: DiagnosticLevel | null,
  entry: WebLogEntry,
): WebLogEntry | null {
  if (!allowsWebLogEvent(level, entry.ev)) {
    return null;
  }
  if (!entry.dump) {
    return entry;
  }

  const entries = entry.dump.entries.filter((item) => allowsWebLogEvent(level, item.ev));
  const omitted = entry.dump.omitted + entry.dump.entries.length - entries.length;

  return {
    ...entry,
    dump: {
      entries,
      omitted,
      from: entries[0]?.t ?? null,
      to: entries.at(-1)?.t ?? null,
    },
  };
}
