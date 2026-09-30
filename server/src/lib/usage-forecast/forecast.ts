// Математика прогноза лимитов: ряды снимков по полосам, обнаружение сброса окна и
// оценка «хватит ли до сброса». Ввода-вывода здесь нет — модуль кормит эти функции
// снимками с фонового тика и сам решает, что сохранить и что разослать.
import type {
  ObservedReset,
  ResetOrigin,
  UsageBarForecast,
} from '../../../../shared/usageForecastContracts.ts';

// Один замер полосы: момент чтения у вендора, процент и срок сброса окна (epoch ms).
export interface UsageSample {
  at: number;
  pct: number;
  resetsAt: number | null;
}

// Ряд замеров одной полосы одного исполнителя. Длина окна приходит с полосой; у старых
// записей на диске её нет — тогда ряд ведёт себя как короткое окно.
export interface BarSeries {
  providerId: string;
  barKey: string;
  label: string;
  windowMinutes?: number | null;
  samples: UsageSample[];
}

// Всё, что раздел хранит между перезапусками.
export interface ForecastState {
  version: 1;
  series: BarSeries[];
  resets: ObservedReset[];
}

// Полоса в том виде, в каком её отдаёт исполнитель (`ProviderUsage.bars` — unknown[]).
interface UsageBarLike {
  key?: unknown;
  label?: unknown;
  pct?: unknown;
  resetsAt?: unknown;
  windowMinutes?: unknown;
}

// Снимок лимитов исполнителя — ровно те поля общего контракта, что нужны ряду.
interface ProviderUsageLike {
  bars?: unknown;
  dataCheckedAt?: unknown;
}

export interface IngestOptions {
  now: number;
  // Момент последнего нажатия «Использовать сброс лимита» по исполнителю.
  ownActions?: ReadonlyMap<string, number>;
  keepMs?: number;
}

export interface ForecastOptions {
  now: number;
  windowMs?: number;
  minSpanMs?: number;
}

// Сколько держим замеров: двух суток хватает и на окно усреднения, и на «вчера».
export const KEEP_SAMPLES_MS = 48 * 60 * 60_000;
// Окно усреднения темпа: два часа сглаживают рывки субагентов, но не прячут разгон.
export const RATE_WINDOW_MS = 2 * 60 * 60_000;
// Меньше двадцати минут замеров — темп ещё шум, а не тенденция.
export const MIN_SPAN_MS = 20 * 60_000;
// Падение процента, которое считается сбросом, а не погрешностью округления вендора.
export const RESET_DROP_PCT = 5;
// Нажатие «сброс лимита» за это время до падения делает сброс «своим».
export const OWN_RESET_WINDOW_MS = 15 * 60_000;
// Темп ниже — окно фактически стоит: прогноз «через 40 дней» человеку не нужен.
export const IDLE_RATE_PER_HOUR = 0.1;
// Окно от суток судят по среднему темпу: в него уже вшиты ночи и выходные.
export const LONG_WINDOW_MS = 24 * 60 * 60_000;
// Средний темп берётся, когда прошла хотя бы четырнадцатая часть окна, но не меньше шести
// часов: в первый час недели два процента дали бы «к сбросу 336 %».
export const MIN_AVERAGE_ELAPSED_MS = 6 * 60 * 60_000;
// Потолки хранения: журнал сбросов и число рядов не растут бесконечно.
const MAX_RESETS = 200;
const MAX_SERIES = 64;

export function emptyForecastState(): ForecastState {
  return { version: 1, series: [], resets: [] };
}

function epochOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && value) {
    const parsed = Date.parse(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Полоса становится замером, только если у неё есть ключ и числовой процент: полосы
 * без процента (справка, ошибки) прогнозу ни о чём не говорят. Момент замера —
 * `dataCheckedAt` снимка, а не «сейчас»: при паузе вендора кэш отдаёт прошлый снимок,
 * и по его штампу повтор отличается от нового чтения.
 */
interface ParsedBar {
  key: string;
  label: string;
  windowMinutes: number | null;
  sample: UsageSample;
}

function sampleOf(bar: unknown, checkedAt: number): ParsedBar | null {
  const raw = (bar && typeof bar === 'object' ? bar : null) as UsageBarLike | null;
  const key = String(raw?.key || '');
  const pct = Number(raw?.pct);

  if (!raw || !key || !Number.isFinite(pct)) {
    return null;
  }

  const windowMinutes = Number(raw.windowMinutes);

  return {
    key,
    label: String(raw.label || key),
    windowMinutes: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes : null,
    sample: {
      at: checkedAt,
      pct: Math.max(0, Math.min(100, pct)),
      resetsAt: epochOf(raw.resetsAt),
    },
  };
}

/**
 * Природа сброса читается по срокам, а не по словам вендора: если прежний срок сброса
 * уже наступил — окно истекло само; если за четверть часа до падения в кокпите нажали
 * «Использовать сброс лимита» — это наш сброс; иначе окно открыл вендор.
 */
function originOf(
  previous: UsageSample,
  current: UsageSample,
  ownActionAt: number | undefined,
): ResetOrigin {
  if (previous.resetsAt !== null && previous.resetsAt <= current.at) {
    return 'scheduled';
  }
  const sinceOwn = ownActionAt === undefined ? Number.NaN : current.at - ownActionAt;

  if (sinceOwn >= 0 && sinceOwn <= OWN_RESET_WINDOW_MS) {
    return 'own';
  }

  return 'external';
}

// Сброс — это падение процента при окне, которое при этом уехало вперёд или пропало.
function isReset(previous: UsageSample, current: UsageSample): boolean {
  const dropped = current.pct <= previous.pct - RESET_DROP_PCT;
  const windowMoved = current.resetsAt === null
    || previous.resetsAt === null
    || current.resetsAt > previous.resetsAt + 60_000;

  return dropped && windowMoved;
}

/**
 * Приём снимка лимитов всех исполнителей. Возвращает новое состояние и список
 * сбросов, замеченных именно этим приёмом, — модуль по нему решает, что рассылать.
 * Повтор того же снимка (тот же `dataCheckedAt`) ряд не удлиняет: иначе пауза
 * вендора выглядела бы как ровное плато и глушила темп.
 */
export function ingestUsage(
  state: ForecastState,
  usage: Record<string, unknown>,
  options: IngestOptions,
): { state: ForecastState; resets: ObservedReset[] } {
  const keepMs = options.keepMs ?? KEEP_SAMPLES_MS;
  const series = state.series.map((row) => ({ ...row, samples: [...row.samples] }));
  const resets: ObservedReset[] = [];

  for (const [providerId, entry] of Object.entries(usage)) {
    const snapshot = (entry && typeof entry === 'object' ? entry : null) as ProviderUsageLike | null;
    const bars = Array.isArray(snapshot?.bars) ? snapshot.bars : [];
    const checkedAt = epochOf(snapshot?.dataCheckedAt) ?? options.now;

    for (const bar of bars) {
      const parsed = sampleOf(bar, checkedAt);

      if (!parsed) {
        continue;
      }

      let row = series.find((item) => item.providerId === providerId && item.barKey === parsed.key);

      if (!row) {
        if (series.length >= MAX_SERIES) {
          continue;
        }
        row = {
          providerId,
          barKey: parsed.key,
          label: parsed.label,
          windowMinutes: parsed.windowMinutes,
          samples: [],
        };
        series.push(row);
      }
      row.label = parsed.label;
      row.windowMinutes = parsed.windowMinutes ?? row.windowMinutes ?? null;

      const previous = row.samples.at(-1);

      if (previous && previous.at >= parsed.sample.at) {
        continue;
      }
      if (previous && isReset(previous, parsed.sample)) {
        resets.push({
          providerId,
          barKey: parsed.key,
          label: parsed.label,
          at: new Date(parsed.sample.at).toISOString(),
          fromPct: previous.pct,
          toPct: parsed.sample.pct,
          origin: originOf(previous, parsed.sample, options.ownActions?.get(providerId)),
        });
      }
      row.samples.push(parsed.sample);
      row.samples = row.samples.filter((sample) => sample.at >= options.now - keepMs);
    }
  }

  const kept = [...state.resets, ...resets].slice(-MAX_RESETS);

  return {
    state: { version: 1, series: series.filter((row) => row.samples.length), resets: kept },
    resets,
  };
}

/**
 * Оценка одной полосы. Текущий темп — по замерам последнего окна усреднения; если внутри
 * него был сброс, темп считается только после него — иначе падение на сто пунктов дало
 * бы «отрицательный расход» и вердикт «хватит».
 *
 * Вердикт для окна от суток стоит на СРЕДНЕМ темпе с начала окна: человек не работает
 * круглосуточно, и темп двух рабочих часов, растянутый на трое суток до сброса, обещал
 * бы «не хватит» тому, кто ночью спит. Начало окна известно из его длины и срока
 * сброса. Короткое окно (сессия) судят по текущему темпу — там пять часов подряд как
 * раз и бывают. Вердикт без срока сброса не выносится: «хватит» значит «до сброса».
 */
export function forecastSeries(series: BarSeries, options: ForecastOptions): UsageBarForecast {
  const windowMs = options.windowMs ?? RATE_WINDOW_MS;
  const minSpanMs = options.minSpanMs ?? MIN_SPAN_MS;
  const last = series.samples.at(-1);
  const recent = series.samples.filter((sample) => sample.at >= options.now - windowMs);

  let start = 0;

  for (let index = 1; index < recent.length; index += 1) {
    const previous = recent[index - 1];
    const current = recent[index];

    if (previous && current && isReset(previous, current)) {
      start = index;
    }
  }

  const window = recent.slice(start);
  const first = window[0];
  const spanMs = first && last ? last.at - first.at : 0;
  const hasRate = Boolean(first && last) && window.length >= 2 && spanMs >= minSpanMs;
  const ratePerHour = hasRate && first && last
    ? Math.max(0, Math.round(((last.pct - first.pct) / (spanMs / 3_600_000)) * 100) / 100)
    : null;
  const average = last ? averageSince(series, last) : null;
  const base = {
    providerId: series.providerId,
    barKey: series.barKey,
    label: series.label,
    pct: last?.pct ?? 0,
    resetsAt: last?.resetsAt ? new Date(last.resetsAt).toISOString() : null,
    windowMinutes: series.windowMinutes ?? null,
    sampledAt: new Date(last?.at ?? options.now).toISOString(),
    spanMinutes: Math.round(spanMs / 60_000),
    ratePerHour,
    averagePerHour: average?.perHour ?? null,
    projectedPct: average?.projectedPct ?? null,
  };

  if (average && last) {
    const exhaustAt = average.perHour >= IDLE_RATE_PER_HOUR
      ? new Date(last.at + ((100 - last.pct) / average.perHour) * 3_600_000).toISOString()
      : null;

    return {
      ...base,
      exhaustAt,
      basis: 'average',
      verdict: average.projectedPct >= 100 ? 'short' : 'enough',
    };
  }

  if (ratePerHour === null || !last) {
    return { ...base, exhaustAt: null, basis: null, verdict: 'unknown' };
  }
  if (ratePerHour < IDLE_RATE_PER_HOUR) {
    return { ...base, exhaustAt: null, basis: 'current', verdict: 'idle' };
  }

  const exhaustAtMs = last.at + ((100 - last.pct) / ratePerHour) * 3_600_000;
  const exhaustAt = new Date(exhaustAtMs).toISOString();

  if (last.resetsAt === null) {
    return { ...base, exhaustAt, basis: 'current', verdict: 'unknown' };
  }

  return {
    ...base,
    exhaustAt,
    basis: 'current',
    verdict: exhaustAtMs >= last.resetsAt ? 'enough' : 'short',
  };
}

/**
 * Средний темп с начала окна и ожидаемый процент к сбросу при нём. Только для окна от
 * суток с известными длиной и сроком сброса, и только когда окно прожило достаточно,
 * чтобы среднее что-то значило.
 */
function averageSince(
  series: BarSeries,
  last: UsageSample,
): { perHour: number; projectedPct: number } | null {
  const windowMs = (series.windowMinutes ?? 0) * 60_000;

  if (windowMs < LONG_WINDOW_MS || last.resetsAt === null) {
    return null;
  }

  const elapsedMs = last.at - (last.resetsAt - windowMs);
  const minElapsedMs = Math.max(MIN_AVERAGE_ELAPSED_MS, windowMs / 14);

  if (elapsedMs < minElapsedMs) {
    return null;
  }

  const perHour = Math.round((last.pct / (elapsedMs / 3_600_000)) * 100) / 100;
  const remainingHours = Math.max(0, last.resetsAt - last.at) / 3_600_000;

  return {
    perHour,
    projectedPct: Math.round(last.pct + perHour * remainingHours),
  };
}

/**
 * Прогноз по всем живым рядам: ряд, чей последний замер старше окна хранения,
 * принадлежит исполнителю, которого больше нет в реестре, и в ответ не попадает.
 */
export function forecastAll(state: ForecastState, options: ForecastOptions): UsageBarForecast[] {
  return state.series
    .filter((row) => (row.samples.at(-1)?.at ?? 0) >= options.now - KEEP_SAMPLES_MS)
    .map((row) => forecastSeries(row, options));
}
