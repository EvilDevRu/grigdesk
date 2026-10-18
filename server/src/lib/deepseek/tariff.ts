import type { DeepSeekPricingStatus } from './pricingWatch.ts';

// Источник: https://api-docs.deepseek.com/quick_start/pricing/; проверено 21.09.2026.
export const DEEPSEEK_PRICING_URL = 'https://api-docs.deepseek.com/quick_start/pricing/';

// Источник: https://api-docs.deepseek.com/quick_start/pricing/; проверено 21.09.2026.
export const DEEPSEEK_PEAK_WINDOWS_UTC = [
  { start: 60, end: 240 },
  { start: 360, end: 600 },
] as const;

// Источник: https://api-docs.deepseek.com/quick_start/pricing/; проверено 21.09.2026.
export const DEEPSEEK_PEAK_MULTIPLIER = 2;

type HolidayRange = readonly [start: string, end: string];

// Источник: https://www.gov.cn/gongbao/2025/issue_12406/material/gwygb202532.pdf;
// уведомление Госсовета КНР 国办发明电〔2025〕7号, проверено 21.09.2026.
export const DEEPSEEK_CN_HOLIDAYS: Readonly<Record<string, readonly HolidayRange[]>> = {
  2026: [
    ['2026-01-01', '2026-01-03'],
    ['2026-02-15', '2026-02-23'],
    ['2026-04-04', '2026-04-06'],
    ['2026-05-01', '2026-05-05'],
    ['2026-06-19', '2026-06-21'],
    ['2026-09-25', '2026-09-27'],
    ['2026-10-01', '2026-10-07'],
  ],
};

// Источник: https://www.gov.cn/gongbao/2025/issue_12406/material/gwygb202532.pdf;
// граница опубликованного календаря, проверено 21.09.2026.
export const DEEPSEEK_HOLIDAY_CALENDAR_COVERED_THROUGH = '2026-12-31';

// Скидка в процентах и окна пика в UTC выводятся из констант: их сверяет сторож страницы
// цен, и продублированная строкой цифра пережила бы правку константы незамеченной.
export const DEEPSEEK_OFF_PEAK_DISCOUNT_PERCENT = Math.round(100 - 100 / DEEPSEEK_PEAK_MULTIPLIER);
// Неделя без удачной сверки со страницей цен — уже повод сказать об этом в настройках.
const PRICING_STALE_MS = 7 * 24 * 60 * 60_000;

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_PEAK_SEARCH_DAYS = 370;

const TARIFF_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
const TARIFF_MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
] as const;

interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface DeepSeekTariffPhase {
  peak: boolean;
  until: number;
  holiday: boolean;
  calendarCovered: boolean;
}

function utcDateKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function holidayCalendarCovered(date: string): boolean {
  const year = date.slice(0, 4);

  return date <= DEEPSEEK_HOLIDAY_CALENDAR_COVERED_THROUGH
    && Object.hasOwn(DEEPSEEK_CN_HOLIDAYS, year);
}

function isChineseHoliday(date: string): boolean {
  if (!holidayCalendarCovered(date)) return false;

  const ranges = DEEPSEEK_CN_HOLIDAYS[date.slice(0, 4)] ?? [];
  return ranges.some(([start, end]) => date >= start && date <= end);
}

function isPeakDay(at: number): boolean {
  const day = new Date(at).getUTCDay();

  return day !== 0 && day !== 6 && !isChineseHoliday(utcDateKey(at));
}

/**
 * Ищет ближайшее начало пика строго после заданного момента. Субботы, воскресенья и
 * известные праздники пропускаются целиком; за покрытием календаря остаётся правило будней.
 */
function nextPeakStart(now: number): number {
  const current = new Date(now);
  const midnight = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );

  for (let offset = 0; offset <= MAX_PEAK_SEARCH_DAYS; offset += 1) {
    const dayStart = midnight + offset * DAY_MS;
    if (!isPeakDay(dayStart)) continue;

    for (const window of DEEPSEEK_PEAK_WINDOWS_UTC) {
      const start = dayStart + window.start * MINUTE_MS;
      if (start > now) return start;
    }
  }

  throw new RangeError('Не найдено ближайшее пиковое окно DeepSeek.');
}

/**
 * Определяет тариф только по UTC: оба пиковых окна принадлежат одной UTC-дате, а
 * перенесённые рабочие выходные не отменяют правила «weekends in full».
 */
export function deepSeekTariffPhase(now: number): DeepSeekTariffPhase {
  if (!Number.isFinite(now)) {
    throw new TypeError('Момент расчёта тарифа DeepSeek должен быть конечным числом.');
  }

  const current = new Date(now);
  const date = utcDateKey(now);
  const calendarCovered = holidayCalendarCovered(date);
  const holiday = isChineseHoliday(date);
  const midnight = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );
  const sinceMidnight = now - midnight;
  const window = isPeakDay(now)
    ? DEEPSEEK_PEAK_WINDOWS_UTC.find((candidate) => (
      sinceMidnight >= candidate.start * MINUTE_MS
      && sinceMidnight < candidate.end * MINUTE_MS
    ))
    : undefined;

  if (window) {
    return {
      peak: true,
      until: midnight + window.end * MINUTE_MS,
      holiday,
      calendarCovered,
    };
  }

  return {
    peak: false,
    until: nextPeakStart(now),
    holiday,
    calendarCovered,
  };
}

/**
 * Разбирает один момент через Intl с явно заданной зоной. Числовая локаль нужна только
 * как стабильный способ получить части даты; русские подписи берутся из своих списков.
 */
function localDateTime(at: number, formatter: Intl.DateTimeFormat): LocalDateTime {
  const values: Record<string, string> = {};

  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function localFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
}

function localClock(value: LocalDateTime): string {
  const hour = String(value.hour).padStart(2, '0');
  const minute = String(value.minute).padStart(2, '0');

  return `${hour}:${minute}`;
}

function localCalendarDay(value: LocalDateTime): number {
  return Date.UTC(value.year, value.month - 1, value.day) / DAY_MS;
}

/**
 * Подписывает абсолютный момент по местным календарным датам. Ровно через семь дат уже
 * показывается число и месяц: сокращение дня недели там выглядело бы как ближайшая неделя.
 */
function transitionLabel(
  now: number,
  until: number,
  formatter: Intl.DateTimeFormat,
): string {
  const current = localDateTime(now, formatter);
  const target = localDateTime(until, formatter);
  const days = localCalendarDay(target) - localCalendarDay(current);
  const clock = localClock(target);

  if (days <= 0) return clock;
  if (days === 1) return `завтра ${clock}`;

  if (days < 7) {
    const weekday = new Date(
      Date.UTC(target.year, target.month - 1, target.day),
    ).getUTCDay();

    return `${TARIFF_WEEKDAYS[weekday]} ${clock}`;
  }

  return `${target.day} ${TARIFF_MONTHS[target.month - 1]} ${clock}`;
}

/**
 * Подписывает прошедший момент по местным датам: сверка со страницей цен случается раз в
 * сутки, и «вчера 09:00» отвечает на «давно ли», не заставляя читать полную дату.
 */
function momentLabel(now: number, at: number, formatter: Intl.DateTimeFormat): string {
  const current = localDateTime(now, formatter);
  const target = localDateTime(at, formatter);
  const days = localCalendarDay(target) - localCalendarDay(current);
  const clock = localClock(target);

  if (days === 0) return `сегодня ${clock}`;
  if (days === -1) return `вчера ${clock}`;

  return `${target.day} ${TARIFF_MONTHS[target.month - 1]} ${clock}`;
}

function utcClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function utcPeakSchedule(): string {
  return DEEPSEEK_PEAK_WINDOWS_UTC
    .map((window) => `${utcClock(window.start)}–${utcClock(window.end)}`)
    .join(' и ');
}

/**
 * Слова сверки со страницей цен. Расхождение — беда: тон `bad` делает note видимым и во
 * всплывашке, где иначе остаётся одна сводка. Остальные исходы — тихая приписка для
 * настроек: переверстанная или недоступная страница не меняет самого тарифа.
 */
function pricingRemark(
  pricing: DeepSeekPricingStatus | null | undefined,
  now: number,
  formatter: Intl.DateTimeFormat,
): { lead: string; tail: string; bad: boolean } {
  if (!pricing) return { lead: '', tail: '', bad: false };

  if (pricing.kind === 'mismatch') {
    return {
      lead: `Страница тарифов DeepSeek говорит другое: ${pricing.details.join('; ')} — `
        + 'расписание в GrigDesk устарело, поправьте константы в '
        + 'server/src/lib/deepseek/tariff.ts. ',
      tail: '',
      bad: true,
    };
  }
  if (pricing.kind === 'unparsed') {
    return { lead: '', tail: ' · страница тарифов переверстана, расписание не сверить', bad: false };
  }
  if (pricing.kind === 'unreachable') {
    return { lead: '', tail: ' · сайт тарифов недоступен, расписание не сверено', bad: false };
  }

  const tail = now - pricing.at > PRICING_STALE_MS
    ? ` · тарифы не сверялись с сайтом с ${momentLabel(now, pricing.at, formatter)}`
    : ` · сверено с сайтом ${momentLabel(now, pricing.at, formatter)}`;
  return { lead: '', tail, bad: false };
}

/**
 * Переводит обе пары UTC-границ в местные часы на текущей UTC-дате. Так IANA-зона,
 * включая полученное из неё летнее время, остаётся единственным источником смещения.
 */
function localPeakSchedule(now: number, formatter: Intl.DateTimeFormat): string {
  const current = new Date(now);
  const midnight = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );

  return DEEPSEEK_PEAK_WINDOWS_UTC.map((window) => {
    const start = localClock(localDateTime(midnight + window.start * MINUTE_MS, formatter));
    const end = localClock(localDateTime(midnight + window.end * MINUTE_MS, formatter));

    return `${start}–${end}`;
  }).join(' и ');
}

/**
 * Смещение считается из тех же местных частей даты, а не из хардкода зоны. Округление
 * до минуты сохраняет зоны с получасовым и четвертьчасовым смещением.
 */
function timeZoneOffsetMinutes(
  now: number,
  formatter: Intl.DateTimeFormat,
): number {
  const local = localDateTime(now, formatter);
  const representedAsUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  const wholeSecondNow = Math.floor(now / 1_000) * 1_000;

  return Math.round((representedAsUtc - wholeSecondNow) / MINUTE_MS);
}

function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;

  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

/**
 * Собирает ресурс общего usage-контракта: сводка остаётся пригодной для readonly-
 * всплывашки, а полное расписание и ссылка доступны в настройках исполнителя.
 */
export function deepSeekTariffResource({
  now,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  pricing = null,
}: {
  now: number;
  timeZone?: string;
  pricing?: DeepSeekPricingStatus | null;
}): Record<string, unknown> {
  const phase = deepSeekTariffPhase(now);
  const formatter = localFormatter(timeZone);
  const transition = transitionLabel(now, phase.until, formatter);
  const discount = `скидка ${DEEPSEEK_OFF_PEAK_DISCOUNT_PERCENT} %`;
  const summary = phase.peak
    ? `пик ×${DEEPSEEK_PEAK_MULTIPLIER} до ${transition}`
    : `${discount} до ${transition}`;
  const localSchedule = localPeakSchedule(now, formatter);
  const utcOffset = formatUtcOffset(timeZoneOffsetMinutes(now, formatter));
  const remark = pricingRemark(pricing, now, formatter);
  let note = `${remark.lead}Пик по будням ${localSchedule} (${utcPeakSchedule()} UTC), кроме `
    + 'праздников КНР: вход и выход вдвое дороже; остальное время, выходные и праздники — '
    + `${discount}. Часы местные (${utcOffset}).`;

  if (phase.holiday) {
    note += ' · сейчас праздник КНР';
  } else if (!phase.calendarCovered) {
    const year = new Date(now).getUTCFullYear();
    note += ` · календарь праздников КНР на ${year} не внесён, `
      + 'праздники считаются рабочими днями';
  }
  note += remark.tail;

  return {
    key: 'tariff',
    label: 'Тариф',
    summary,
    note,
    tone: remark.bad ? 'bad' : (phase.peak ? 'warn' : 'ok'),
    controls: [{
      id: 'pricing',
      kind: 'link',
      label: 'Тарифы DeepSeek',
      href: DEEPSEEK_PRICING_URL,
    }],
  };
}
