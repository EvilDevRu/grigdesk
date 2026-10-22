const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export const TARIFF_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'] as const;
const TARIFF_MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
] as const;

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Разбирает один момент через Intl с явно заданной зоной. Числовая локаль нужна только
 * как стабильный способ получить части даты; русские подписи берутся из своих списков.
 */
export function localDateTime(at: number, formatter: Intl.DateTimeFormat): LocalDateTime {
  const values: Record<string, string> = {};

  for (const part of formatter.formatToParts(at)) {
    if (part.type !== 'literal') {
      values[part.type] = part.value;
    }
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

/**
 * Задаёт числовые части даты для выбранной IANA-зоны.
 * Часы в формате h23 сохраняют полночь как 00:00 во всех локалях.
 */
export function localFormatter(timeZone: string): Intl.DateTimeFormat {
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

/**
 * Собирает часы из уже переведённых в местную зону частей даты.
 * Одинаковый формат нужен короткой сводке и расписанию в настройках.
 */
export function localClock(value: LocalDateTime): string {
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
export function transitionLabel(
  now: number,
  until: number,
  formatter: Intl.DateTimeFormat,
): string {
  const current = localDateTime(now, formatter);
  const target = localDateTime(until, formatter);
  const days = localCalendarDay(target) - localCalendarDay(current);
  const clock = localClock(target);

  if (days <= 0) {
    return clock;
  }

  if (days === 1) {
    return `завтра ${clock}`;
  }


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
export function momentLabel(now: number, at: number, formatter: Intl.DateTimeFormat): string {
  const current = localDateTime(now, formatter);
  const target = localDateTime(at, formatter);
  const days = localCalendarDay(target) - localCalendarDay(current);
  const clock = localClock(target);

  if (days === 0) {
    return `сегодня ${clock}`;
  }

  if (days === -1) {
    return `вчера ${clock}`;
  }


  return `${target.day} ${TARIFF_MONTHS[target.month - 1]} ${clock}`;
}

/**
 * Смещение считается из тех же местных частей даты, а не из хардкода зоны. Округление
 * до минуты сохраняет зоны с получасовым и четвертьчасовым смещением.
 */
export function timeZoneOffsetMinutes(
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

/**
 * Подписывает смещение зоны относительно UTC без потери неполного часа.
 * Знак и минуты берутся из рассчитанного смещения, а не из названия зоны.
 */
export function formatUtcOffset(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;

  return `UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

