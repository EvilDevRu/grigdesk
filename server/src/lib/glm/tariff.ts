import {
  formatUtcOffset,
  localClock,
  localDateTime,
  localFormatter,
  momentLabel,
  TARIFF_WEEKDAYS,
  timeZoneOffsetMinutes,
  transitionLabel,
} from '../usageTariffTime.ts';
import type { GlmPricingStatus } from './pricingWatch.ts';

// Источники: overview и usage-revision Z.ai, проверено 21.10.2026.
// Все часы и расходы принадлежат тарифу; сторож сравнивает факты с этими же константами.
export const GLM_PRICING_URL = 'https://docs.z.ai/devpack/overview';
export const GLM_PRICING_SOURCES = {
  overview: `${GLM_PRICING_URL}.md`,
  revision: 'https://docs.z.ai/devpack/notice/usage-revision.md',
} as const;
export const GLM_PEAK_WEEKDAYS: readonly number[] = [1, 2, 3, 4, 5];
export const GLM_PEAK_WINDOW_UTC = { start: 360, end: 600 } as const;
export const GLM_SOURCE_OFFSET_MINUTES = 480;
export const GLM_WEEKENDS_OFF_PEAK = true;
export const GLM_USAGE_RATES = {
  credits: { offPeak: 0.5, peak: 1 },
  'GLM-5.3': { offPeak: 1, peak: 3 },
  'GLM-5.3-Flash': { offPeak: 0.4, peak: 1.2 },
} as const;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const PRICING_STALE_MS = 7 * DAY_MS;

export interface GlmTariffPhase {
  peak: boolean;
  until: number;
}

/**
 * Считает полуоткрытое окно по UTC: сингапурское окно целиком лежит в той же UTC-дате.
 * Выходные пропускаются, календарь праздников не применяется к подписке Z.ai.
 */
export function glmTariffPhase(now: number): GlmTariffPhase {
  if (!Number.isFinite(now)) {
    throw new TypeError('Момент расчёта тарифа GLM должен быть конечным числом.');
  }

  const current = new Date(now);
  const midnight = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const start = midnight + GLM_PEAK_WINDOW_UTC.start * MINUTE_MS;
  const end = midnight + GLM_PEAK_WINDOW_UTC.end * MINUTE_MS;

  if (GLM_PEAK_WEEKDAYS.includes(current.getUTCDay()) && now >= start && now < end) {
    return { peak: true, until: end };
  }

  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = start + offset * DAY_MS;

    if (candidate > now && GLM_PEAK_WEEKDAYS.includes(new Date(candidate).getUTCDay())) {
      return { peak: false, until: candidate };
    }
  }

  throw new RangeError('Не найдено ближайшее пиковое окно GLM.');
}

function clock(minutes: number): string {
  const hours = String(Math.floor(minutes / 60)).padStart(2, '0');
  const remainder = String(minutes % 60).padStart(2, '0');

  return `${hours}:${remainder}`;
}

/**
 * Переводит окно и дни его начала в зону сервера на текущую UTC-дату.
 * В западных зонах начало бывает накануне, а конец — на следующий местный день.
 */
function localPeakSchedule(now: number, formatter: Intl.DateTimeFormat): string {
  const current = new Date(now);
  const midnight = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
  const start = localDateTime(midnight + GLM_PEAK_WINDOW_UTC.start * MINUTE_MS, formatter);
  const end = localDateTime(midnight + GLM_PEAK_WINDOW_UTC.end * MINUTE_MS, formatter);
  const startDate = Date.UTC(start.year, start.month - 1, start.day);
  const endDate = Date.UTC(end.year, end.month - 1, end.day);
  const shift = (startDate - midnight) / DAY_MS;
  const weekdays = GLM_PEAK_WEEKDAYS.map((day) => TARIFF_WEEKDAYS[(day + shift + 7) % 7]);
  const range = `${weekdays[0]}–${weekdays[weekdays.length - 1]}`;
  const nextDay = endDate > startDate ? ' (окончание на следующий день)' : '';

  return `${range} ${localClock(start)}–${localClock(end)}${nextDay}`;
}

/**
 * Оба поколения подписки показываются вместе: level не определяет способ расчёта квоты.
 * Исходные расходы и отношение пика выводятся из констант, которые проверяет сторож.
 */
function ratesDescription(): string {
  const credits = GLM_USAGE_RATES.credits;
  const legacy = ['GLM-5.3', 'GLM-5.3-Flash'] as const;
  const models = legacy.map((model) => {
    const rates = GLM_USAGE_RATES[model];
    const peakRatio = (rates.peak / rates.offPeak).toLocaleString('ru-RU');

    return `${model}: ${rates.offPeak}× вне пика и ${rates.peak}× в пик (пик ×${peakRatio})`;
  });

  return `Новые планы на кредитах: ${credits.offPeak}× вне пика и ${credits.peak}× в пик `
    + `(пик ×${credits.peak / credits.offPeak}). Прежние планы: ${models.join('; ')}.`;
}

/**
 * Подробности расхождения попадут и во всплывашку через тон bad.
 * Технические статусы добавляются только без расхождения, чтобы остаться в настройках.
 */
function pricingRemark(
  pricing: GlmPricingStatus | null,
  now: number,
  formatter: Intl.DateTimeFormat,
): {
  lead: string;
  tail: string;
  bad: boolean;
} {
  if (!pricing) {
    return {
      lead: '',
      tail: '',
      bad: false,
    };
  }

  if (pricing.kind === 'mismatch') {
    return {
      lead: `Документация Z.ai говорит другое: ${pricing.details.join('; ')}. `
        + 'Расписание в GrigDesk устарело. ',
      tail: '',
      bad: true,
    };
  }

  const remarks = Object.entries(pricing.sources).map(([source, status]) => {
    const staleRemark = status.at !== null && now - status.at > PRICING_STALE_MS
      ? `; тарифы не сверялись с сайтом с ${momentLabel(now, status.at, formatter)}`
      : '';

    if (status.kind === 'unreachable') {
      return `${source}: сайт тарифов недоступен, расписание не сверено${staleRemark}`;
    }

    if (status.kind === 'unparsed') {
      return `${source}: страница тарифов переверстана, не удалось разобрать расписание${staleRemark}`;
    }

    if (status.at === null) {
      return `${source}: расписание не сверено`;
    }

    const at = momentLabel(now, status.at, formatter);

    return now - status.at > PRICING_STALE_MS
      ? `${source}: тарифы не сверялись с сайтом с ${at}`
      : `${source}: сверено с сайтом ${at}`;
  });

  return {
    lead: '',
    tail: ` · ${remarks.join(' · ')}`,
    bad: false,
  };
}

/**
 * Возвращает обычный текстовый ресурс usage для успешного Coding Plan.
 * Фаза не зависит от состояния документации, а подтверждённые изменения делают ресурс бедой.
 */
export function glmTariffResource({
  now,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  pricing = null,
}: {
  now: number;
  timeZone?: string;
  pricing?: GlmPricingStatus | null;
}): Record<string, unknown> {
  const phase = glmTariffPhase(now);
  const formatter = localFormatter(timeZone);
  const transition = transitionLabel(now, phase.until, formatter);
  const summary = `${phase.peak ? 'пик' : 'вне пика'} до ${transition}`;
  const local = localPeakSchedule(now, formatter);
  const offset = formatUtcOffset(timeZoneOffsetMinutes(now, formatter));
  const utcStart = GLM_PEAK_WINDOW_UTC.start;
  const utcEnd = GLM_PEAK_WINDOW_UTC.end;
  const sourceStart = clock(utcStart + GLM_SOURCE_OFFSET_MINUTES);
  const sourceEnd = clock(utcEnd + GLM_SOURCE_OFFSET_MINUTES);
  const sourceOffset = formatUtcOffset(GLM_SOURCE_OFFSET_MINUTES);
  const remark = pricingRemark(pricing, now, formatter);
  const note = `${remark.lead}Пик в местных часах: ${local} (${offset}). `
    + `Исходное расписание: пн–пт ${sourceStart}–${sourceEnd} по Сингапуру (${sourceOffset}), `
    + `${clock(utcStart)}–${clock(utcEnd)} UTC. Выходные по Сингапуру целиком вне пика. `
    + ratesDescription() + remark.tail;

  return {
    key: 'tariff',
    label: 'Тариф',
    summary,
    note,
    tone: remark.bad ? 'bad' : (phase.peak ? 'warn' : 'ok'),
    controls: [{
      id: 'pricing',
      kind: 'link',
      label: 'Тарифы Z.ai',
      href: GLM_PRICING_URL,
    }],
  };
}
