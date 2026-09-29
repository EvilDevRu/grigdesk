// Прогноз лимитов исполнителей — `GET /api/usage-forecast` и SSE `usage-forecast`.
// Сервер копит снимки полос лимитов, которые и так приносит фоновый тик, и отвечает
// на вопрос, хватит ли окна до сброса при текущем темпе. Журнал замеченных сбросов
// сохраняется в контракте; всплывашка показывает только прогноз по полосам.
// Форма объявлена здесь, чтобы у веба и сервера не было двух копий одного DTO.
//
// Раздел выпиливаемый: вместе с ним уходят этот файл, `server/src/lib/usage-forecast/`,
// `server/src/modules/usage-forecast/`, стор и компонент веба и по строке в
// `app.ts`, `config.ts`, `useSse.ts` и `AppShell.vue`.
import { contractDecoders } from './contractDecoders.ts';

export class UsageForecastContractError extends Error {
  constructor(path: string) {
    super(`Некорректный ответ прогноза лимитов: поле ${path}`);
    this.name = 'UsageForecastContractError';
  }
}

const {
  listOf,
  nullable,
  numeric,
  objectOf,
  oneOf,
  text,
  wholeNumber,
} = contractDecoders((path) => {
  throw new UsageForecastContractError(path);
});

// Вердикт по одной полосе. `unknown` — данных ещё мало, `idle` — расход нулевой,
// `enough`/`short` — окна хватит или не хватит до сброса.
export const BAR_VERDICTS = ['unknown', 'idle', 'enough', 'short'] as const;

export type BarVerdict = typeof BAR_VERDICTS[number];

// На чём стоит вердикт: `current` — темп последних часов, растянутый до сброса (короткие
// окна), `average` — средний темп с начала окна, в который уже вшиты ночи и выходные
// (окна от суток). Человек не работает круглосуточно, и неделю по двум часам не судят.
export const FORECAST_BASES = ['current', 'average'] as const;

export type ForecastBasis = typeof FORECAST_BASES[number];

// Откуда взялся сброс: `scheduled` — окно истекло само, `own` — за минуты до него в
// кокпите нажали «Использовать сброс лимита», `external` — всё остальное, то есть
// вендор сбросил сам.
export const RESET_ORIGINS = ['scheduled', 'own', 'external'] as const;

export type ResetOrigin = typeof RESET_ORIGINS[number];

const barForecast = objectOf({
  providerId: text,
  barKey: text,
  label: text,
  pct: numeric,
  resetsAt: nullable(text),
  windowMinutes: nullable(numeric),
  // Текущий темп: пунктов в час за окно усреднения, и сколько минут замеров в нём.
  ratePerHour: nullable(numeric),
  spanMinutes: wholeNumber,
  // Средний темп с начала окна и ожидаемый процент к сбросу при нём.
  averagePerHour: nullable(numeric),
  projectedPct: nullable(numeric),
  exhaustAt: nullable(text),
  basis: nullable(oneOf(...FORECAST_BASES)),
  verdict: oneOf(...BAR_VERDICTS),
  sampledAt: text,
});

const observedReset = objectOf({
  providerId: text,
  barKey: text,
  label: text,
  at: text,
  fromPct: numeric,
  toPct: numeric,
  origin: oneOf(...RESET_ORIGINS),
});

const snapshot = objectOf({
  generatedAt: text,
  bars: listOf(barForecast),
  resets: listOf(observedReset),
});

export type UsageBarForecast = ReturnType<typeof barForecast>;
export type ObservedReset = ReturnType<typeof observedReset>;
export type UsageForecastSnapshot = ReturnType<typeof snapshot>;

export function parseUsageForecastSnapshot(value: unknown): UsageForecastSnapshot {
  return snapshot(value, 'snapshot');
}
