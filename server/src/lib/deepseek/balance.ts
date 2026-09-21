import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir } from './env.ts';
import {
  type DeepSeekPricingStatus,
  deepSeekPricingStatus,
  watchDeepSeekPricing,
} from './pricingWatch.ts';
import { deepSeekTariffResource } from './tariff.ts';

// DeepSeek продаёт API по предоплате: окон лимитов и «процента от подписки» у него нет,
// поэтому всплывашка показывает состояние счёта, тарифную фазу и темп расхода по снимкам.
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
export const DEEPSEEK_TOP_UP_URL = 'https://platform.deepseek.com/top_up';

// Снимки баланса держатся неделю: сутки нужны темпу, остальное — запас на выходные без ходов.
const LOG_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOG_MAX_SAMPLES = 2_500;
const FORECAST_WINDOW_MS = 24 * 60 * 60_000;
const FORECAST_MIN_COVERAGE_MS = 2 * 60 * 60_000;
// Меньше цента за окно — не расход, а шум округления вендора.
const SPEND_EPSILON = 0.005;

export interface DeepSeekBalanceInfo {
  currency: string;
  total: number;
  granted: number;
  toppedUp: number;
}

export interface DeepSeekBalance {
  available: boolean;
  balances: DeepSeekBalanceInfo[];
}

export type DeepSeekBalanceResult =
  | { ok: true; balance: DeepSeekBalance }
  | { ok: false; state: 'auth_required' | 'rate_limited' | 'unavailable'; message: string };

export interface DeepSeekBalanceSample {
  at: number;
  currency: string;
  total: number;
}

export type DeepSeekSpendForecast =
  | { kind: 'insufficient'; hoursObserved: number }
  | { kind: 'stalled'; hoursObserved: number }
  | { kind: 'rate'; hoursObserved: number; spentPerDay: number; daysLeft: number };

function money(value: unknown): number {
  const parsed = Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Ответ вендора приводится к числам один раз и без догадок: неизвестная валюта или
 * пустой список балансов остаются как есть, а не превращаются в ноль долларов.
 */
export function parseDeepSeekBalance(payload: unknown): DeepSeekBalance | null {
  const source = payload as { is_available?: unknown; balance_infos?: unknown } | null;
  if (!source || typeof source !== 'object' || !Array.isArray(source.balance_infos)) return null;

  const balances = (source.balance_infos as Array<Record<string, unknown>>)
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.currency === 'string')
    .map((entry) => ({
      currency: String(entry.currency).toUpperCase(),
      total: money(entry.total_balance),
      granted: money(entry.granted_balance),
      toppedUp: money(entry.topped_up_balance),
    }));

  return { available: source.is_available !== false, balances };
}

/**
 * Один GET к API счёта с ключом службы. Отказы переводятся в состояния общего
 * контракта usage: неверный ключ — auth_required, «стучитесь реже» — rate_limited,
 * всё остальное — unavailable с повтором на следующем тике.
 */
export async function fetchDeepSeekBalance({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<DeepSeekBalanceResult> {
  let response: Response;
  try {
    response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // В текст идёт только код причины: сообщение исключения может нести URL и заголовки.
    const cause = (error as { cause?: { code?: unknown } })?.cause?.code;
    const reason = String(cause || (error as Error)?.name || 'сеть');
    return { ok: false, state: 'unavailable', message: `API DeepSeek не ответил (${reason}).` };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, state: 'auth_required', message: 'DeepSeek отклонил ключ API службы.' };
  }
  if (response.status === 429) {
    return { ok: false, state: 'rate_limited', message: 'DeepSeek попросил проверять счёт реже.' };
  }
  if (!response.ok) {
    return { ok: false, state: 'unavailable', message: `API DeepSeek ответил ${response.status}.` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, state: 'unavailable', message: 'API DeepSeek вернул не JSON.' };
  }
  const balance = parseDeepSeekBalance(payload);
  if (!balance) {
    return { ok: false, state: 'unavailable', message: 'API DeepSeek вернул ответ без балансов.' };
  }
  return { ok: true, balance };
}

export function balanceLogPath(runtimeHome: string): string {
  return path.join(runtimeHome, 'balance-log.json');
}

export async function readBalanceLog(runtimeHome: string): Promise<DeepSeekBalanceSample[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(balanceLogPath(runtimeHome), 'utf8')) as {
      samples?: unknown;
    };
    if (!Array.isArray(parsed?.samples)) return [];
    return (parsed.samples as DeepSeekBalanceSample[]).filter((sample) => (
      sample && Number.isFinite(sample.at) && typeof sample.currency === 'string'
      && Number.isFinite(sample.total)
    ));
  } catch {
    return [];
  }
}

/**
 * Дописывает свежие снимки и обрезает журнал по сроку и размеру. Файл приватный: в нём
 * нет ключа, но остаток счёта — тоже не публичные данные.
 */
export async function appendBalanceLog(
  runtimeHome: string,
  samples: DeepSeekBalanceSample[],
  now = Date.now(),
): Promise<DeepSeekBalanceSample[]> {
  const previous = await readBalanceLog(runtimeHome);
  const kept = [...previous, ...samples]
    .filter((sample) => now - sample.at <= LOG_RETENTION_MS)
    .sort((a, b) => a.at - b.at)
    .slice(-LOG_MAX_SAMPLES);

  await ensurePrivateDir(runtimeHome);
  const file = balanceLogPath(runtimeHome);
  await fs.writeFile(file, JSON.stringify({ samples: kept }), { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return kept;
}

/**
 * Темп расхода за последние сутки по снимкам одной валюты. Считается только убыль между
 * соседними снимками: пополнение поднимает баланс и не должно ни обнулять, ни занижать
 * темп. Пока наблюдений меньше двух часов, прогноз честно отсутствует.
 */
export function forecastDeepSeekSpend(
  samples: DeepSeekBalanceSample[],
  currency: string,
  now = Date.now(),
): DeepSeekSpendForecast {
  const window = samples
    .filter((sample) => sample.currency === currency && now - sample.at <= FORECAST_WINDOW_MS)
    .sort((a, b) => a.at - b.at);
  const hoursObserved = window.length
    ? Math.round(((window[window.length - 1]!.at - window[0]!.at) / 3_600_000) * 10) / 10
    : 0;

  if (window.length < 2 || hoursObserved * 3_600_000 < FORECAST_MIN_COVERAGE_MS) {
    return { kind: 'insufficient', hoursObserved };
  }

  let spent = 0;
  for (let index = 1; index < window.length; index += 1) {
    spent += Math.max(0, window[index - 1]!.total - window[index]!.total);
  }
  if (spent < SPEND_EPSILON) return { kind: 'stalled', hoursObserved };

  const spentPerDay = (spent / hoursObserved) * 24;
  const latest = window[window.length - 1]!.total;
  return {
    kind: 'rate',
    hoursObserved,
    spentPerDay,
    daysLeft: Math.max(0, latest) / spentPerDay,
  };
}

export function formatDeepSeekMoney(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function forecastTone(forecast: DeepSeekSpendForecast): string {
  if (forecast.kind !== 'rate') return 'muted';
  if (forecast.daysLeft < 3) return 'bad';
  if (forecast.daysLeft < 14) return 'warn';
  return 'ok';
}

function forecastSummary(forecast: DeepSeekSpendForecast): string {
  if (forecast.kind === 'insufficient') return 'темп появится после двух часов наблюдений';
  if (forecast.kind === 'stalled') return 'расход стоит';
  if (forecast.daysLeft < 1) return `хватит на ~${Math.max(1, Math.round(forecast.daysLeft * 24))} ч`;
  return `хватит на ~${Math.round(forecast.daysLeft)} дн.`;
}

function forecastNote(forecast: DeepSeekSpendForecast, currency: string): string {
  const observed = forecast.hoursObserved > 0
    ? `наблюдений ${forecast.hoursObserved} ч`
    : 'первый снимок';
  if (forecast.kind !== 'rate') return `${observed} · по снимкам баланса каждые пять минут`;
  return `за сутки −${formatDeepSeekMoney(forecast.spentPerDay, currency)} · ${observed}`;
}

/**
 * Ресурсы всплывашки: строки валют счёта, текущий тариф и прогноз по первой валюте с
 * деньгами. Проценты баланса не выдумываются — у предоплаты нет «окна» для их расчёта.
 */
export function deepSeekBalanceResources(
  balance: DeepSeekBalance,
  samples: DeepSeekBalanceSample[],
  now = Date.now(),
  {
    timeZone,
    pricing = null,
  }: {
    timeZone?: string;
    pricing?: DeepSeekPricingStatus | null;
  } = {},
): Array<Record<string, unknown>> {
  const resources: Array<Record<string, unknown>> = [];

  for (const entry of balance.balances) {
    const empty = entry.total <= 0;
    resources.push({
      key: `balance-${entry.currency.toLowerCase()}`,
      label: `Баланс ${entry.currency}`,
      summary: formatDeepSeekMoney(entry.total, entry.currency),
      note: `пополнение ${formatDeepSeekMoney(entry.toppedUp, entry.currency)}`
        + ` · бонус ${formatDeepSeekMoney(entry.granted, entry.currency)}`
        + (balance.available ? '' : ' · вендор считает счёт недостаточным для запросов'),
      tone: !balance.available || empty ? 'bad' : 'ok',
      controls: [{
        id: 'top-up',
        kind: 'link',
        label: 'Пополнить счёт',
        href: DEEPSEEK_TOP_UP_URL,
      }],
    });
  }

  resources.push(deepSeekTariffResource({ now, timeZone, pricing }));

  const primary = balance.balances.find((entry) => entry.total > 0) || balance.balances[0];
  if (primary) {
    const forecast = forecastDeepSeekSpend(samples, primary.currency, now);
    resources.push({
      key: 'forecast',
      label: 'Прогноз',
      summary: forecastSummary(forecast),
      note: forecastNote(forecast, primary.currency),
      tone: forecastTone(forecast),
    });
  }

  return resources;
}

/**
 * Сверка страницы цен — вспомогательная: её сбой (сеть, запись файла) не отнимает у
 * всплывашки баланс и тариф, а лишь оставляет ресурс без приписки о сверке.
 */
async function pricingStatusSafely(
  runtimeHome: string,
  fetchImpl: typeof fetch,
  now: number,
): Promise<DeepSeekPricingStatus | null> {
  try {
    return deepSeekPricingStatus(await watchDeepSeekPricing({ runtimeHome, fetchImpl, now }));
  } catch {
    return null;
  }
}

/**
 * Состояние счёта DeepSeek для общего контракта usage: без ключа — auth_required,
 * с ключом — запрос баланса, снимок в приватный журнал, суточная сверка страницы цен
 * и ресурсы для всплывашки.
 */
export async function deepSeekUsage({
  config,
  env = process.env,
  fetchImpl = fetch,
  now = Date.now,
  timeZone,
}: {
  config: { deepseekRuntimeHome: string };
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeZone?: string;
}): Promise<Record<string, unknown>> {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return {
      state: 'auth_required',
      bars: [],
      resources: [],
      message: 'Для DeepSeek нужен DEEPSEEK_API_KEY в окружении службы.',
    };
  }

  const result = await fetchDeepSeekBalance({ apiKey, fetchImpl });
  if (!result.ok) {
    return { state: result.state, bars: [], resources: [], message: result.message };
  }

  const at = now();
  const samples = await appendBalanceLog(
    config.deepseekRuntimeHome,
    result.balance.balances.map((entry) => ({ at, currency: entry.currency, total: entry.total })),
    at,
  );
  const pricing = await pricingStatusSafely(config.deepseekRuntimeHome, fetchImpl, at);
  return {
    state: 'ok',
    bars: [],
    resources: deepSeekBalanceResources(result.balance, samples, at, { timeZone, pricing }),
  };
}
