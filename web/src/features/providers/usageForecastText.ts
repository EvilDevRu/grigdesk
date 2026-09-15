// Слова для блока прогноза во всплывашке исполнителя. Чистые функции от снимка и
// «сейчас»: шаблон не должен считать даты, а тест — монтировать компонент ради строки.
import type {
  ExternalResetSignal,
  ObservedReset,
  UsageBarForecast,
} from '../../../../shared/usageForecastContracts.ts';

// Тон строки: тем же словарём пользуются классы `is-*` состояний всплывашки.
export type ForecastTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface ForecastLine {
  text: string;
  tone: ForecastTone;
}

// Месяцы своим списком по той же причине, что и у полос: ширина строки фиксирована,
// а сокращения ICU гуляют по длине.
const MONTHS = [
  'янв', 'фев', 'мар', 'апр', 'мая', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

const ORIGIN_WORDS: Record<ObservedReset['origin'], string> = {
  scheduled: 'окно истекло само',
  own: 'ваш сброс',
  external: 'сбросил вендор',
};

function clockOf(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Сколько местных полуночей между моментами: «вчера» — предыдущая дата календаря,
// а не «24 часа назад».
function calendarDaysBetween(from: number, to: number): number {
  const start = new Date(from);
  const end = new Date(to);

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * Календарный момент в обе стороны: «сегодня 14:20», «вчера 18:30», «завтра 03:00»,
 * «12 сен 15:09». Помощник полос знает только будущее, а сброс — всегда в прошлом.
 */
export function momentOf(iso: string | null, now = Date.now()): string {
  const at = iso ? new Date(iso).getTime() : Number.NaN;

  if (!Number.isFinite(at)) {
    return '';
  }

  const date = new Date(at);
  const time = clockOf(date);
  const days = calendarDaysBetween(now, at);

  if (days === 0) {
    return `сегодня ${time}`;
  }
  if (days === -1) {
    return `вчера ${time}`;
  }
  if (days === 1) {
    return `завтра ${time}`;
  }

  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

/**
 * Давность одним словом: минуты до часа, часы до двух суток, дальше дни. Точность
 * убывает с давностью — «3 дня назад» читается, «4392 минуты назад» нет.
 */
export function agoOf(iso: string | null, now = Date.now()): string {
  const at = iso ? new Date(iso).getTime() : Number.NaN;

  if (!Number.isFinite(at)) {
    return '';
  }

  const minutes = Math.max(0, Math.round((now - at) / 60_000));

  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  if (minutes < 48 * 60) {
    return `${Math.round(minutes / 60)} ч назад`;
  }

  return `${Math.round(minutes / 1_440)} дн назад`;
}

// Тот же порог «расход стоит», что и на сервере: текущий темп ниже него словом, не цифрой.
const IDLE_RATE = 0.1;

function rateOf(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} %/ч`;
}

// Ряд блока: подпись слева, значение справа — как у полос всплывашки. Подстрока под
// рядом раскрывает значение (момент 100 %, природа сброса, шанс), примечание — мелкое.
export interface ForecastRow {
  key: string;
  label: string;
  value: string;
  tone: ForecastTone;
  href?: string;
  sub?: ForecastLine & { label: string } | null;
  note?: string;
}

const VERDICT_WORDS: Record<UsageBarForecast['verdict'], string> = {
  unknown: '',
  idle: '',
  enough: 'до сброса хватит',
  short: 'до сброса не хватит',
};

const VERDICT_TONES: Record<UsageBarForecast['verdict'], ForecastTone> = {
  unknown: 'muted',
  idle: 'muted',
  enough: 'ok',
  short: 'bad',
};

// Ожидаемые к сбросу 90 % и выше — «впритык»: формально хватит, но запаса нет.
const TIGHT_PROJECTED_PCT = 90;

/**
 * Ряд полосы. Окно от суток стоит на среднем темпе: справа «в среднем 0.6 %/ч», под ним
 * ожидаемый процент к сбросу, текущий темп справочно и вердикт. Короткое окно — по
 * текущему темпу: справа темп, под ним момент 100 % и вердикт. Полоса без темпа ряда
 * не даёт — стоящие полосы сливаются в общий ряд «расход стоит», чтобы три полосы
 * Codex не давали три одинаковые строки.
 */
export function barRowOf(bar: UsageBarForecast, now = Date.now()): ForecastRow | null {
  if (bar.basis === 'average' && bar.averagePerHour !== null && bar.projectedPct !== null) {
    const tight = bar.verdict === 'enough' && bar.projectedPct >= TIGHT_PROJECTED_PCT;
    const tone: ForecastTone = tight ? 'warn' : VERDICT_TONES[bar.verdict];
    const current = bar.ratePerHour === null
      ? ''
      : ` · сейчас ${bar.ratePerHour < IDLE_RATE ? 'стоит' : rateOf(bar.ratePerHour)}`;

    return {
      key: bar.barKey,
      label: bar.label,
      value: `в среднем ${rateOf(bar.averagePerHour)}`,
      tone,
      sub: {
        label: `к сбросу ~${Math.round(bar.projectedPct)} %${current}`,
        text: tight ? 'впритык' : VERDICT_WORDS[bar.verdict],
        tone,
      },
    };
  }
  if (bar.ratePerHour === null || !bar.exhaustAt || bar.verdict === 'idle') {
    return null;
  }

  const tone = VERDICT_TONES[bar.verdict];

  return {
    key: bar.barKey,
    label: bar.label,
    value: rateOf(bar.ratePerHour),
    tone,
    sub: {
      label: `100 % — ${momentOf(bar.exhaustAt, now)}`,
      text: VERDICT_WORDS[bar.verdict],
      tone,
    },
  };
}

// Общий ряд, когда ни одна полоса не расходуется: вердикта нет, но блок живой —
// иначе пустое место под заголовком читалось бы как «прогноз не работает».
export function idleRow(): ForecastRow {
  return {
    key: 'idle',
    label: 'Темп',
    value: 'расход стоит',
    tone: 'muted',
    sub: null,
  };
}

// Последний замеченный сброс окна: когда, чьими руками и с какого процента на какой.
// Природа сброса названа словами, потому что «12 сен 18:30» без неё не отвечает,
// ждать ли следующего.
export function resetRowOf(reset: ObservedReset, now = Date.now()): ForecastRow {
  return {
    key: 'reset',
    label: 'Сброс окна',
    value: momentOf(reset.at, now),
    tone: 'muted',
    sub: {
      label: `«${reset.label}» · ${ORIGIN_WORDS[reset.origin]}`,
      text: `${Math.round(reset.fromPct)} % → ${Math.round(reset.toPct)} %`,
      tone: 'muted',
    },
  };
}

/**
 * Ряд внешнего сигнала: подпись — ссылка на источник, справа последний подтверждённый
 * сброс, под ним чужая оценка шанса с именем горизонта. Без свежих данных остаётся
 * прошлый ответ с давностью в примечании, а без данных вовсе — причина, почему их нет.
 */
export function externalRowOf(signal: ExternalResetSignal, now = Date.now()): ForecastRow {
  const base = {
    key: 'external',
    label: signal.source,
    href: signal.homepage,
  };

  if (!signal.lastReset && signal.chance24h === null) {
    return {
      ...base,
      value: 'нет данных',
      tone: 'muted',
      sub: null,
      ...(signal.error && { note: signal.error }),
    };
  }

  const tone: ForecastTone = signal.stale ? 'muted' : 'ok';
  const chances = signal.chance24h !== null && signal.chance48h !== null
    ? `${Math.round(signal.chance24h)} % / ${Math.round(signal.chance48h)} %`
    : '';

  return {
    ...base,
    value: signal.lastReset ? `сброс ${momentOf(signal.lastReset.at, now)}` : '—',
    tone,
    sub: chances
      ? {
        label: 'шанс сброса за 24 ч / 48 ч',
        text: chances,
        tone,
      }
      : null,
    ...(signal.stale && { note: `данные ${agoOf(signal.fetchedAt, now) || 'устарели'}` }),
  };
}
