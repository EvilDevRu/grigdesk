import { intlLocale } from '../../../../shared/i18n/formats.ts';
import { type LocaleSource, localeTranslator, translator } from '../../../../shared/i18n/catalogs.ts';
import { translate as t } from '../../../../shared/i18n/catalogs.ts';
import { localizeUsageAmount, localizeUsageResourceText } from './usageResourceText.ts';
import { localizeProviderAction } from './providerLocale.ts';
import { providerUsageFreshness } from '../../../../shared/chat/providerUsageFreshness.ts';

import type { UsageEntry, UsageBar, UsageResource } from './contracts.ts';

interface ProviderView {
  id?: string;
  statusPage?: string;
  vendor?: string;
  name?: string;
  usagePresentation?: { freshness: boolean; spentLabel: boolean };
}

type ResourceConfirmation = NonNullable<import('./contracts.ts').UsageControl['confirm']>;

type VendorStatus = NonNullable<UsageEntry['vendorStatus']>;

/**
 * Полосы одного ведра лимитов идут в ответе подряд, и различить их можно только по
 * подписи — «Неделя (7д)» и «Неделя · gpt-reserve» выглядят одним плоским списком.
 * Разделитель ставится там, где сменилось поле `group`. Считаем его здесь, а не в
 * шаблоне: `v-for` не должен знать про соседа, а правило одно на всех исполнителей.
 *
 * Полоса без `group` линии НЕ порождает: черта — это утверждение «дальше другое ведро»,
 * а исполнитель, который вёдра не назвал, такого не сообщал. Поэтому сравниваем с
 * последним НАЗВАННЫМ ведром: неназванная полоса не рвёт группу и не начинает свою.
 */
function withGroupBreaks(bars: UsageBar[]) {
  let previous: string | null = null;

  return bars.map((bar) => {
    const group = bar.group || '';
    const separated = Boolean(group) && Boolean(previous) && group !== previous;

    previous = group || previous;

    return { ...bar, separated };
  });
}

/**
 * Месяц подписи — своим списком, а не через Intl: у полосы фиксированная ширина, и
 * сокращения ICU («сент.») то длиннее на букву с точкой, то короче, а в урезанной сборке
 * локаль вовсе подменяется чужой. Три буквы одинаковой длины держат строку на месте.
 */
const RESET_MONTHS = [
  t("core.jan"), t("core.feb"), t("core.mar"), t("core.apr"), t("core.may"), t("core.jun"),
  t("core.jul"), t("core.aug"), t("core.sep"), t("core.oct"), t("core.nov"), t("core.dec"),
];

/**
 * Местное время в 24-часовом формате едино для сброса и времени замера квоты.
 * Перевод часового пояса делает браузер, а AM/PM не попадает в русский интерфейс.
 */
export function clockOf(date: Date, locale: LocaleSource = 'ru'): string {
  if (intlLocale(locale) !== 'ru-RU') {
    return new Intl.DateTimeFormat(intlLocale(locale), { hour: 'numeric', minute: '2-digit' }).format(date);
  }

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

// Сколько местных полуночей между двумя моментами: «завтра» — это следующая дата
// календаря, а не «через 24 часа».
function calendarDaysBetween(from: number, to: number): number {
  const start = new Date(from);
  const end = new Date(to);

  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

/**
 * «сброс через 2ч 25м» из ISO-даты сброса лимита. Пока до сброса меньше суток, минуты
 * значат ровно столько же, сколько часы: короткое окно сессии (5ч) иначе почти час
 * подряд показывает одно и то же «через 2ч». Дальше минуты — шум, поэтому на сутках и
 * больше остаются часы, а после двух суток — дни.
 *
 * Часы и минуты берутся из одного округления: считать их порознь нельзя — на границе
 * получилось бы «2ч 60м».
 */
export function resetIn(iso: string | number | null | undefined, now = Date.now(),
  locale: LocaleSource = 'ru',
) {
  const t = localeTranslator(locale);

  if (!iso) {
    return '';
  }

  const ms = new Date(iso).getTime() - now;

  if (!(ms > 0)) {
    return '';
  }

  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours >= 48) {
    return t("core.resetsInD", { value1: Math.round(hours / 24) });
  }

  if (hours >= 24) {
    return t("core.resetsInH", { hours });
  }

  if (hours >= 1) {
    return rest ? t("core.resetsInHM", { hours, rest }) : t("core.resetsInH", { hours });
  }

  return t("core.resetsInM", { rest: rest });
}

/**
 * Календарный момент сброса: «сегодня 17:33», «завтра 03:00», «15 сен 03:00».
 * Обратный отсчёт отвечает на «скоро ли», но не на «во сколько»: по «сброс через 4д»
 * планировать работу нельзя, а по дате — можно. Поэтому подпись полосы говорит и то,
 * и другое, и вторая половина не заменяет первую.
 *
 * «Сегодня» и «завтра» считаются по местной полуночи, а не по суткам вперёд: сброс
 * через 20 часов может прийтись и на завтра, и на послезавтра, и человек читает
 * календарь, а не длительность.
 */
export function resetAt(iso: string | number | null | undefined, now = Date.now(),
  locale: LocaleSource = 'ru',
) {
  const t = localeTranslator(locale);

  if (!iso) {
    return '';
  }

  const at = new Date(iso).getTime();

  if (!Number.isFinite(at) || at <= now) {
    return '';
  }

  const date = new Date(at);
  const time = clockOf(date, locale);
  const days = calendarDaysBetween(now, at);

  if (days <= 0) {
    return t("core.today2", { time });
  }

  if (days === 1) {
    return t("core.tomorrow", { time });
  }

  if (intlLocale(locale) !== 'ru-RU') {
    return new Intl.DateTimeFormat(intlLocale(locale), {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  return `${date.getDate()} ${RESET_MONTHS[date.getMonth()]} ${time}`;
}

/**
 * Состояния лимитов, у которых причина может лежать на стороне вендора. Локальные
 * беды сюда НЕ входят: при `auth_required` надо логиниться, при `unsupported` —
 * обновлять CLI, и ссылка на страницу состояния там только сбивает с толку.
 */
const VENDOR_FAULT_STATES = new Set(['unavailable', 'blocked', 'rate_limited']);

/**
 * Что именно сказала страница состояния вендора. Компоненты и заголовок инцидента —
 * его слова, поэтому идут как пришли: свой перевод чужого сбоя врал бы уверенно.
 */
function vendorFaultDetail(status: VendorStatus): string {
  return [
    status.summary,
    status.components?.length ? status.components.join(', ') : '',
    status.incident ? `«${status.incident}»` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * Подсказка о стороне вендора для беды лимитов. Домен объявляет сам адаптер исполнителя
 * (`statusPage`), прочитанное состояние приносит сервер (`vendorStatus`), поэтому здесь
 * нет ни одного имени вендора и ни одной догадки о причине: пока страница не прочитана,
 * подсказка честно зовёт посмотреть её глазами.
 */
export function providerStatusHint(provider: ProviderView = {}, usage: UsageEntry = {},
  locale: LocaleSource = 'ru',
) {
  const t = localeTranslator(locale);

  const url = String(provider?.statusPage || '');

  if (!url || !VENDOR_FAULT_STATES.has(usage?.state!)) {
    return null;
  }

  let host = '';

  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  const vendor = provider?.vendor || provider?.name || t("core.theVendor");
  const status = usage?.vendorStatus;
  const detail = status ? vendorFaultDetail(status) : '';

  if (status?.state === 'ok') {
    return {
      url,
      host,
      text: detail
        ? t("core.reportsNoOutage", { vendor: vendor, detail: detail })
        : t("core.reportsNoOutage2", { vendor: vendor }),
    };
  }

  if (status?.state === 'degraded' || status?.state === 'down') {
    return {
      url,
      host,
      text: detail
        ? t("core.reportsAnOutage", { vendor: vendor, detail: detail })
        : t("core.reportsAnOutage2", { vendor: vendor }),
    };
  }

  return {
    url,
    host,
    text: t("core.theIssueMayBeWithServiceStatus", { vendor: vendor }),
  };
}

// Представление серверного контракта лимитов. Всплывашка всегда получает текст,
// даже пока данные грузятся или CLI не предоставляет API потребления.
export function providerUsageView(entry: UsageEntry | null | undefined, provider: ProviderView = {},
  locale: LocaleSource = 'ru',
  context: { now?: number; deliveryStale?: boolean } = {},
) {
  const t = localeTranslator(locale);

  if (!entry || typeof entry !== 'object') {
    return {
      state: 'loading',
      bars: [],
      resources: [],
      message: t("core.limitDataHasNotBeenReceivedYet"),
      tone: 'muted',
      action: null,
      measuredAt: null,
    };
  }

  const tone = ({
    ok: 'ok',
    auth_required: 'bad',
    blocked: 'bad',
    rate_limited: 'warn',
    unavailable: 'warn',
    unsupported: 'muted',
  } as Record<string, string>)[entry.state!] || 'muted';

  const fallback = entry.state === 'ok'
    ? ''
    : t("core.limitStatusForIsUnavailable", { value1: provider.name || t("core.provider") });

  return {
    ...entry,
    ...(provider.usagePresentation?.freshness ? providerUsageFreshness(entry,
      context.now ?? Date.now(), context.deliveryStale, true) : {}),
    bars: withGroupBreaks((Array.isArray(entry.bars) ? entry.bars : [])
      .map((bar) => localizeUsageBar(provider.id, bar, locale))),
    resources: (Array.isArray(entry.resources) ? entry.resources : [])
      .map((resource) => localizeUsageResource(provider.id!, resource, locale)),
    message: entry.message || fallback,
    tone,
    action: entry.action ? localizeProviderAction(provider.id!, entry.action, locale) : null,
  };
}

/**
 * Подпись собственного окна определяется ID источника и длительностью из данных.
 * Суффикс имени ведра остаётся исходным; порядок, проценты и даты не меняются.
 * @param {import('../../../../shared/i18n/catalogs.ts').LocaleSource} [locale]
 */
export function localizeUsageBar<T extends UsageBar>(
  providerId: string | undefined, bar: T, locale: LocaleSource = 'ru',
): T {
  const id = typeof locale === 'string' ? locale : locale.value;
  const key = String(bar.key || '');
  const kimiWindow = providerId === 'kimi' && ['kimi:monthTotal', 'kimi:1:5:hour', 'kimi:0:1:week']
    .includes(key);
  const owned = providerId === 'codex' || providerId === 'glm' && key.startsWith('zai:')
    || kimiWindow
    || providerId === 'claude' && ['session', 'weekly_all', 'weekly_scoped']
      .some((kind) => key.startsWith(kind));

  if (id === 'ru' || !owned) {
    return bar;
  }

  const t = localeTranslator(locale);
  const minutes = bar.windowMinutes ?? (kimiWindow && key.endsWith(':5:hour') ? 300
    : kimiWindow && key.endsWith(':1:week') ? 10080 : undefined);
  const label = kimiWindow && key === 'kimi:monthTotal' ? t('core.usageMonth')
    : key === 'zai:mcp' ? t('core.usageMonthlyMcp')
    : minutes === 300 ? t('core.usageSession') : minutes === 10080 ? t('core.usageWeek')
    : Number.isFinite(minutes) && minutes! > 0 ? t('core.usageMinutes', { count: minutes! })
      : providerId === 'glm' ? t('core.usageTokenWindow') : t('core.limits');
  const suffix = String(bar.label || '').split(' · ').slice(1).join(' · ');

  return { ...bar, label: suffix ? `${label} · ${suffix}` : label };
}

/**
 * Собственные подписи ресурсов и подтверждений проецируются по provider/key/control ID.
 * Денежные значения, команды и внешние сводки остаются данными, исходный DTO не мутируется.
 * @param {import('../../../../shared/i18n/catalogs.ts').LocaleSource} [locale]
 */
export function localizeUsageResource<T extends UsageResource>(
  providerId: string, resource: T, locale: LocaleSource = 'ru',
): T {
  const id = typeof locale === 'string' ? locale : locale.value;

  if (id === 'ru' || !['claude', 'codex', 'kimi', 'deepseek', 'glm', 'tripo'].includes(providerId)) {
    return resource;
  }

  // Денежный кошелёк Kimi сохраняет прежнее представление до миграции его текстов.
  // Здесь переводятся новые справочные состояния, которые не содержат баланса.
  if (providerId === 'kimi' && resource.kind === 'balance') {
    return resource;
  }

  const prefix = `core.usageResources.${providerId}.${resource.key}`;
  const toggle = resource.controls?.find((control) => control.id === 'extra-usage-toggle');
  const cap = toggle?.confirm?.on?.text?.match(/Месячный потолок (.+)\.$/)?.[1];
  const text = (key: string, fallback: string | undefined) => translator.t(id, key, {
    value: '{value}',
    unit: '{unit}',
    cap: cap ? localizeUsageAmount(cap, locale) : '',
  }, fallback);
  const balanceCurrency = /^balance-[a-z]{3}$/.test(resource.key!)
    ? resource.key!.slice(8).toUpperCase() : '';

  /**
   * Шаблон подтверждения сохраняет именованные параметры для существующего action helper.
   * Язык не меняет payload, сторону toggle или подтверждённое значение.
   */
  function confirmation(
    value: ResourceConfirmation | undefined, key: string,
  ): ResourceConfirmation | undefined {
    if (!value || typeof value !== 'object') {
      return value;
    }

    return {
      ...value,
      ...typeof value.text === 'string' ? { text: text(`${key}.text`, value.text) } : {},
      ...typeof value.label === 'string' ? { label: text(`${key}.label`, value.label) } : {},
      ...value.on ? { on: confirmation(value.on, `${key}.on`) } : {},
      ...value.off ? { off: confirmation(value.off, `${key}.off`) } : {},
    };
  }

  return {
    ...resource,
    ...localizeUsageResourceText(
      providerId, resource as Parameters<typeof localizeUsageResourceText>[1], locale,
    ),
    label: balanceCurrency ? translator.t(id, 'core.usageBalance', { currency: balanceCurrency })
      : text(`${prefix}.label`, resource.label),
    controls: resource.controls?.map((control) => ({
      ...control,
      label: control.id === 'top-up' ? translator.t(id, 'core.topUpAccount')
        : control.id === 'extra-usage-toggle'
        ? translator.t(id, control.value ? 'core.extraUsageEnabled' : 'core.extraUsageDisabled')
        : text(`${prefix}.controls.${control.id}.label`, control.label),
      confirm: confirmation(control.confirm, `${prefix}.controls.${control.id}.confirm`),
    })),
  };
}
