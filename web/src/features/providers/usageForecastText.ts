import { formatNumber, intlLocale } from '../../../../shared/i18n/formats.ts';
import { localeTranslator, type LocaleSource } from '../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../shared/i18n/catalogs.ts';
// Слова для блока прогноза во всплывашке исполнителя. Чистые функции от снимка и
// «сейчас»: шаблон не должен считать даты, а тест — монтировать компонент ради строки.
import type { UsageBarForecast } from '../../../../shared/chat/usageForecastContracts.ts';

// Тон строки: тем же словарём пользуются классы `is-*` состояний всплывашки.
export type ForecastTone = 'ok' | 'warn' | 'bad' | 'muted';

export interface ForecastLine {
  text: string;
  tone: ForecastTone;
}

// Месяцы своим списком по той же причине, что и у полос: ширина строки фиксирована,
// а сокращения ICU гуляют по длине.
const MONTHS = [
  t("core.jan"), t("core.feb"), t("core.mar"), t("core.apr"), t("core.may"), t("core.jun"),
  t("core.jul"), t("core.aug"), t("core.sep"), t("core.oct"), t("core.nov"), t("core.dec"),
];

function clockOf(date: Date, locale: LocaleSource = 'ru'): string {
  if (intlLocale(locale) !== 'ru-RU') {
    return new Intl.DateTimeFormat(intlLocale(locale), { hour: 'numeric', minute: '2-digit' }).format(date);
  }

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
 * «12 сен 15:09». Прогноз из последнего снимка может устареть до нового замера.
 */
export function momentOf(iso: string | null, now = Date.now(),
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  const at = iso ? new Date(iso).getTime() : Number.NaN;

  if (!Number.isFinite(at)) {
    return '';
  }

  const date = new Date(at);
  const time = clockOf(date, locale);
  const days = calendarDaysBetween(now, at);

  if (days === 0) {
    return t("core.today2", { time: time });
  }
  if (days === -1) {
    return t("core.yesterday", { time: time });
  }
  if (days === 1) {
    return t("core.tomorrow", { time: time });
  }

  if (intlLocale(locale) !== 'ru-RU') {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

// Тот же порог «расход стоит», что и на сервере: текущий темп ниже него словом, не цифрой.
const IDLE_RATE = 0.1;

/**
 * Темп сохраняет прежнее округление и русский контракт прямого helper.
 * Реактивный UI форматирует дробь на выбранном языке без изменения самого прогноза.
 */
function rateOf(value: number,
  locale: LocaleSource = 'ru',
): string {
  const t = localeTranslator(locale);

  const digits = value < 10 ? 1 : 0;
  const formatted = locale === 'ru' ? value < 10 ? value.toFixed(1) : Math.round(value)
    : formatNumber(value, locale, { minimumFractionDigits: digits, maximumFractionDigits: digits });

  return t("core.h", { value1: formatted });
}

// Ряд блока: подпись слева, значение справа — как у полос всплывашки. Подстрока под
// рядом раскрывает значение: момент 100 % и вердикт, природа сброса.
export interface ForecastRow {
  key: string;
  label: string;
  value: string;
  tone: ForecastTone;
  sub?: ForecastLine & { label: string } | null;
}

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
export function barRowOf(bar: UsageBarForecast, now = Date.now(),
  locale: LocaleSource = 'ru',
): ForecastRow | null {
  const t = localeTranslator(locale);

  if (bar.basis === 'average' && bar.averagePerHour !== null && bar.projectedPct !== null) {
    const tight = bar.verdict === 'enough' && bar.projectedPct >= TIGHT_PROJECTED_PCT;
    const tone: ForecastTone = tight ? 'warn' : VERDICT_TONES[bar.verdict];
    const current = bar.ratePerHour === null
      ? ''
      : t("core.now", {
        value1: bar.ratePerHour < IDLE_RATE ? t("core.idle") : rateOf(bar.ratePerHour, locale),
      });

    return {
      key: bar.barKey,
      label: bar.label,
      value: t("core.average", { value1: rateOf(bar.averagePerHour, locale) }),
      tone,
      sub: {
        label: t("core.atReset", { value1: Math.round(bar.projectedPct), current: current }),
        text: tight ? t("core.justEnough") : bar.verdict === 'enough' ? t('core.enoughUntilReset')
        : bar.verdict === 'short' ? t('core.notEnoughUntilReset') : '',
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
    value: rateOf(bar.ratePerHour, locale),
    tone,
    sub: {
      label: `100 % — ${momentOf(bar.exhaustAt, now, locale)}`,
      text: bar.verdict === 'enough' ? t('core.enoughUntilReset')
        : bar.verdict === 'short' ? t('core.notEnoughUntilReset') : '',
      tone,
    },
  };
}

// Общий ряд, когда ни одна полоса не расходуется: вердикта нет, но блок живой —
// иначе пустое место под заголовком читалось бы как «прогноз не работает».
export function idleRow(
  locale: LocaleSource = 'ru',
): ForecastRow {
  const t = localeTranslator(locale);

  return {
    key: 'idle',
    get label() {
    return t("core.rate");
  },
    value: t("core.usageIdle"),
    tone: 'muted',
    sub: null,
  };
}
