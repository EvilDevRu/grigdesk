/**
 * Полосы одного ведра лимитов идут в ответе подряд, и различить их можно только по
 * подписи — «Неделя (7д)» и «Неделя · gpt-reserve» выглядят одним плоским списком.
 * Разделитель ставится там, где сменилось поле `group`. Считаем его здесь, а не в
 * шаблоне: `v-for` не должен знать про соседа, а правило одно на всех исполнителей.
 *
 * Полоса без `group` линии НЕ порождает: черта — это утверждение «дальше другое ведро»,
 * а исполнитель, который вёдра не назвал, такого не сообщал. У Ollama полосы вовсе не
 * лимиты (видеопамять и ОЗУ машины), и разделять там нечего. Поэтому сравниваем с
 * последним НАЗВАННЫМ ведром: неназванная полоса не рвёт группу и не начинает свою.
 */
function withGroupBreaks(bars) {
  let previous = null;

  return bars.map((bar) => {
    const group = bar.group || '';
    const separated = Boolean(group) && Boolean(previous) && group !== previous;

    previous = group || previous;

    return { ...bar, separated };
  });
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
export function resetIn(iso, now = Date.now()) {
  if (!iso) return '';

  const ms = new Date(iso).getTime() - now;
  if (!(ms > 0)) return '';

  const minutes = Math.max(1, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  if (hours >= 48) return `сброс через ${Math.round(hours / 24)}д`;
  if (hours >= 24) return `сброс через ${hours}ч`;
  if (hours >= 1) return rest ? `сброс через ${hours}ч ${rest}м` : `сброс через ${hours}ч`;

  return `сброс через ${rest}м`;
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
function vendorFaultDetail(status) {
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
export function providerStatusHint(provider = {}, usage = {}) {
  const url = String(provider?.statusPage || '');

  if (!url || !VENDOR_FAULT_STATES.has(usage?.state)) {
    return null;
  }

  let host = '';

  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  const vendor = provider?.vendor || provider?.name || 'вендора';
  const status = usage?.vendorStatus;
  const detail = status ? vendorFaultDetail(status) : '';

  if (status?.state === 'ok') {
    return {
      url,
      host,
      text: detail
        ? `${vendor} о сбое не сообщает (${detail}):`
        : `${vendor} о сбое не сообщает:`,
    };
  }

  if (status?.state === 'degraded' || status?.state === 'down') {
    return {
      url,
      host,
      text: detail
        ? `${vendor} сообщает о сбое: ${detail} —`
        : `${vendor} сообщает о сбое —`,
    };
  }

  return {
    url,
    host,
    text: `Причина может быть на стороне ${vendor} — состояние сервиса:`,
  };
}

// Представление серверного контракта лимитов. Всплывашка всегда получает текст,
// даже пока данные грузятся или CLI не предоставляет API потребления.
export function providerUsageView(entry, provider = {}) {
  if (!entry || typeof entry !== 'object') {
    return {
      state: 'loading',
      bars: [],
      resources: [],
      message: 'Данные о лимитах ещё не получены.',
      tone: 'muted',
      action: null,
    };
  }

  const tone = {
    ok: 'ok',
    auth_required: 'bad',
    blocked: 'bad',
    rate_limited: 'warn',
    unavailable: 'warn',
    unsupported: 'muted',
  }[entry.state] || 'muted';

  const fallback = entry.state === 'ok'
    ? ''
    : `Статус лимитов ${provider.name || 'исполнителя'} недоступен.`;

  return {
    ...entry,
    bars: withGroupBreaks(Array.isArray(entry.bars) ? entry.bars : []),
    resources: Array.isArray(entry.resources) ? entry.resources : [],
    message: entry.message || fallback,
    tone,
    action: entry.action || null,
  };
}
