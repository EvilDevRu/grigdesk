import {
  appendBalanceLog,
  balanceForecastResource,
  formatDeepSeekMoney,
} from '../deepseek/balance.ts';
import { usagePercentOrNull } from '../providerUsage.ts';
import { parseGlmAccessMode, selectGlmServiceKey } from './contract.ts';
import type { GlmAccessMode } from './contract.ts';
import { glmPricingStatus, watchGlmPricing } from './pricingWatch.ts';
import type { GlmPricingStatus } from './pricingWatch.ts';
import { glmTariffResource } from './tariff.ts';

// Состояние счёта Z.ai берётся из тех же адресов, что и личный кабинет: открытого API баланса
// у Z.ai нет, но адреса кабинета принимают ключ API как есть (без Bearer). Ответы проверяются
// строго: изменившийся адрес даёт «недоступно» со словом Z.ai, а не выдуманный ноль.
const ZAI_API = 'https://api.z.ai/api';
export const GLM_BILLING_URL = 'https://z.ai/manage-apikey/billing';
export const GLM_CODING_PLAN_URL = 'https://z.ai/manage-apikey/coding-plan/personal/my-plan';

// Сеть до Z.ai рвёт TLS-рукопожатие: сорванный запрос повторяется сразу, без паузы.
const NETWORK_ATTEMPTS = 8;
const TIMEOUT_MS = 10_000;
const CURRENCY = 'USD';

// Типы счетов кабинета: наличные, бонус и кредитная линия.
const ACCOUNT_CASH = 10;
const ACCOUNT_BONUS = 11;
const ACCOUNT_CREDIT = 12;

type GlmEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface GlmUsageOptions {
  env: GlmEnv;
  runtimeHome: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Envelope {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

interface CallFailure {
  ok: false;
  state: 'auth_required' | 'rate_limited' | 'unavailable';
  message: string;
}

type CallResult = { ok: true; data: Record<string, unknown> } | CallFailure;

function failed(state: CallFailure['state'], message: string): CallFailure {
  return {
    ok: false,
    state,
    message,
  };
}

/**
 * Код причины сетевого срыва без текста исключения: сообщение может нести URL и заголовки.
 * Достаточно кода сокета или имени ошибки, чтобы человек отличил таймаут от обрыва.
 */
function networkCause(error: unknown): string {
  const code = (error as { cause?: { code?: unknown } })?.cause?.code;

  return String(code || (error as Error)?.name || 'сеть');
}

/**
 * Запрос к адресу кабинета с повтором только сетевого срыва; ответ сервера не повторяется.
 * Возвращает ответ или код причины последнего срыва.
 */
async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response | string> {
  let cause = 'сеть';

  for (let attempt = 0; attempt < NETWORK_ATTEMPTS; attempt += 1) {
    try {
      return await fetchImpl(url, {
        ...init,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      cause = networkCause(error);
    }
  }

  return cause;
}

/**
 * Один вызов адреса кабинета Z.ai. Отказ ключа — auth_required, просьба реже — rate_limited,
 * конверт с кодом не 200 — unavailable со словом самого Z.ai.
 */
async function callZai(
  fetchImpl: typeof fetch,
  key: string,
  route: string,
  body?: Record<string, unknown>,
): Promise<CallResult> {
  const response = await fetchWithRetry(fetchImpl, `${ZAI_API}/${route}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: key,
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (typeof response === 'string') {
    return failed('unavailable', `Z.ai не ответил (${response}).`);
  }

  if (response.status === 401 || response.status === 403) {
    return failed('auth_required', 'Z.ai отклонил ключ выбранного режима.');
  }

  if (response.status === 429) {
    return failed('rate_limited', 'Z.ai попросил проверять счёт реже.');
  }

  const envelope = await response.json().catch(() => null) as Envelope | null;
  const data = envelope?.data;

  if (!response.ok || envelope?.code !== 200 || !data || typeof data !== 'object') {
    const said = typeof envelope?.msg === 'string' && envelope.msg ? `: ${envelope.msg.slice(0, 120)}` : '';

    return failed('unavailable', `Кабинет Z.ai не отдал данные (${response.status}${said}).`);
  }

  return {
    ok: true,
    data: data as Record<string, unknown>,
  };
}

function usageFailure(result: CallFailure): Record<string, unknown> {
  return {
    state: result.state,
    bars: [],
    resources: [],
    message: result.message,
  };
}

/**
 * Сумма из ответа кабинета: число или непустая десятичная строка. Пустота и мусор —
 * отсутствие данных, а не ноль долларов.
 */
function money(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) {
    return null;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Ресурс баланса: итог счёта, наличные, бонус и кредит (если есть), ссылка на пополнение.
 * Нулевой или отрицательный итог подсвечен: ходы Z.ai отклонит до пополнения.
 */
function balanceResource(total: number, accounts: Record<string, unknown>[]): Record<string, unknown> {
  const amountOf = (type: number) => money(accounts.find((entry) => entry?.type === type)?.balance);
  const credit = amountOf(ACCOUNT_CREDIT);
  const note = [
    `наличные ${formatDeepSeekMoney(amountOf(ACCOUNT_CASH) ?? 0, CURRENCY)}`,
    `бонус ${formatDeepSeekMoney(amountOf(ACCOUNT_BONUS) ?? 0, CURRENCY)}`,
    ...(credit !== null ? [`кредит ${formatDeepSeekMoney(credit, CURRENCY)}`] : []),
  ].join(' · ');

  return {
    key: 'balance-usd',
    label: `Баланс ${CURRENCY}`,
    summary: formatDeepSeekMoney(total, CURRENCY),
    kind: 'balance',
    balance: {
      amount: total,
      currency: CURRENCY,
    },
    note,
    tone: total <= 0 ? 'bad' : 'ok',
    controls: [{
      id: 'top-up',
      kind: 'link',
      label: 'Пополнить счёт',
      href: GLM_BILLING_URL,
    }],
  };
}

/**
 * Режим «Обычный API»: номер клиента по ключу, затем баланс по номеру — как в кабинете.
 * Наружу уходят только суммы: номер клиента и почта остаются внутри функции.
 */
async function apiUsage(
  key: string,
  { runtimeHome, fetchImpl, now }: Required<Omit<GlmUsageOptions, 'env'>>,
): Promise<Record<string, unknown>> {
  const user = await callZai(fetchImpl, key, 'biz/customerService/zaiUserInfo');

  if (!user.ok) {
    return usageFailure(user);
  }

  const customerId = user.data.customerNumber;

  if (typeof customerId !== 'string' || !customerId) {
    return usageFailure(failed('unavailable', 'Кабинет Z.ai не назвал номер клиента.'));
  }

  const account = await callZai(fetchImpl, key, 'platform-charge-zai/business/accountBalance', {
    customerId,
  });

  if (!account.ok) {
    return usageFailure(account);
  }

  const total = money(account.data.totalBalance);

  if (total === null) {
    return usageFailure(failed('unavailable', 'Кабинет Z.ai вернул баланс без суммы.'));
  }

  const list = account.data.accountList;
  const accounts = Array.isArray(list) ? list as Record<string, unknown>[] : [];
  const at = now();
  const samples = await appendBalanceLog(runtimeHome, [{
    at,
    currency: CURRENCY,
    total,
  }], at);

  return {
    state: 'ok',
    bars: [],
    resources: [
      balanceResource(total, accounts),
      balanceForecastResource(samples, CURRENCY, at),
    ],
  };
}

function resetIso(value: unknown): string | null {
  const ms = money(value);

  return ms !== null && ms > 0 ? new Date(ms).toISOString() : null;
}

/**
 * Окно моделей Coding Plan по unit/number кабинета: 5 часов, неделя или незнакомое окно,
 * которое показывается своими числами, а не прячется.
 */
function modelWindow(limit: Record<string, unknown>): Record<string, unknown> {
  if (limit.unit === 3 && limit.number === 5) {
    return {
      key: 'zai:5h',
      label: '5 часов',
      windowMinutes: 300,
    };
  }

  if (limit.unit === 6 && limit.number === 1) {
    return {
      key: 'zai:week',
      label: 'Неделя',
      windowMinutes: 10_080,
    };
  }

  return {
    key: `zai:${String(limit.unit)}-${String(limit.number)}`,
    label: 'Окно токенов',
    windowMinutes: null,
  };
}

/**
 * Строка лимита Coding Plan в общую полоску: кредитные/токенные окна и месячная квота MCP.
 * Строки других типов пропускаются: их смысл кабинет не объявляет.
 */
function quotaBar(limit: Record<string, unknown>): Record<string, unknown> | null {
  const pct = usagePercentOrNull(money(limit.percentage));

  if (pct === null) {
    return null;
  }

  const resetsAt = resetIso(limit.nextResetTime);

  if (limit.type === 'TIME_LIMIT') {
    return {
      key: 'zai:mcp',
      group: 'zai',
      label: 'MCP за месяц',
      pct,
      resetsAt,
      windowMinutes: null,
    };
  }

  if (limit.type !== 'TOKENS_LIMIT' && limit.type !== 'CREDIT_LIMIT') {
    return null;
  }

  return {
    ...modelWindow(limit),
    group: 'zai',
    pct,
    resetsAt,
  };
}

/**
 * Режим Coding Plan: окна лимитов и уровень из кабинета, тариф из публичной документации.
 * Сторож запускается только после успешных квот и не превращает их в отказ при своей ошибке.
 */
async function codingPlanUsage(
  key: string,
  { runtimeHome, fetchImpl, now }: Required<Omit<GlmUsageOptions, 'env'>>,
): Promise<Record<string, unknown>> {
  const quota = await callZai(fetchImpl, key, 'monitor/usage/quota/limit');

  if (!quota.ok) {
    return usageFailure(quota);
  }

  const list = quota.data.limits;
  const limits = Array.isArray(list) ? list as Record<string, unknown>[] : [];
  const level = quota.data.level;
  const at = now();
  let pricing: GlmPricingStatus;

  try {
    pricing = glmPricingStatus(await watchGlmPricing({
      runtimeHome,
      fetchImpl,
      now: at,
    }));
  } catch {
    pricing = glmPricingStatus(null);
  }

  return {
    state: 'ok',
    bars: limits.flatMap((limit) => {
      const bar = limit && typeof limit === 'object' ? quotaBar(limit) : null;

      return bar ? [bar] : [];
    }),
    resources: [{
      key: 'plan',
      label: 'Coding Plan',
      summary: typeof level === 'string' && level ? level : 'план не назван',
      note: 'окна лимитов — по данным кабинета Z.ai',
      tone: 'ok',
      controls: [{
        id: 'plan',
        kind: 'link',
        label: 'Подписка',
        href: GLM_CODING_PLAN_URL,
      }],
    }, glmTariffResource({ now: at, pricing })],
  };
}

/**
 * Состояние счёта или подписки GLM для общего контракта usage — по выбранному режиму:
 * «Обычный API» показывает баланс и прогноз, Coding Plan — окна лимитов. Без режима или
 * ключа запросов нет: карточка просит задать их в «Ключах доступа».
 */
export async function glmUsage({
  env,
  runtimeHome,
  fetchImpl = fetch,
  now = Date.now,
}: GlmUsageOptions): Promise<Record<string, unknown>> {
  const mode: GlmAccessMode | null = parseGlmAccessMode(env.GRIGDESK_GLM_API_MODE);

  if (!mode) {
    return usageFailure(failed('auth_required', 'Выбери режим доступа Z.ai в «Ключах доступа».'));
  }

  const key = selectGlmServiceKey(mode, env);

  if (!key) {
    const name = mode === 'api' ? 'ZAI_API_KEY' : 'ZAI_CODING_API_KEY';

    return usageFailure(failed('auth_required', `Для режима ${mode} нужен ${name}.`));
  }

  if (mode === 'coding-plan') {
    return codingPlanUsage(key, {
      runtimeHome,
      fetchImpl,
      now,
    });
  }

  return apiUsage(key, {
    runtimeHome,
    fetchImpl,
    now,
  });
}
