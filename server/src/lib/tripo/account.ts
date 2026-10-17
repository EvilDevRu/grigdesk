import { isRecord } from '../../../../shared/lib/objects.ts';

import { normalizeProviderUsage } from '../providerUsage.ts';
import type { ProviderUsage } from '../providerUsage.ts';

const REGIONS = {
  ov: {
    api: 'https://openapi.tripo3d.ai',
    billing: 'https://developers.tripo3d.ai/billing',
    label: 'Международный',
  },
  cn: {
    api: 'https://openapi.tripo3d.com',
    billing: 'https://developers.tripo3d.com/billing/recharge',
    label: 'Китай',
  },
};

const AUTH_MESSAGE = 'Tripo не принял авторизацию: проверьте ключ и регион.';
const ACCESS_MESSAGE = 'Tripo запретил доступ: проверьте ключ, права и регион.';
const RATE_MESSAGE = 'Tripo временно ограничил проверку баланса. Повторим проверку позже.';
const INVALID_MESSAGE = 'Не удалось получить корректный баланс Tripo. Повторим проверку автоматически.';
const NETWORK_MESSAGE = 'Не удалось связаться с Tripo: сеть или таймаут. Повторим проверку автоматически.';

export interface TripoAccountDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Берёт согласованную пару ключа и региона до первого ожидания сети.
 * Неподдерживаемый регион читается как международный для совместимости CLI.
 */
export function tripoAccess(env: NodeJS.ProcessEnv) {
  const key = (env.TRIPO_API_KEY || '').trim();
  const region = (env.TRIPO_REGION || '').trim() === 'cn' ? 'cn' : 'ov';

  return { key, ...REGIONS[region] };
}

/**
 * Округляет только для показа и склоняет слово по отображённому числу.
 * Дробный кредит и резерв не превращаются в валюту или дополнительное списание.
 */
function creditSummary(value: number): string {
  const text = new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: 2,
    useGrouping: false,
  }).format(Object.is(value, -0) ? 0 : value);
  const displayed = Math.abs(Number(text.replace(',', '.')));
  const last = displayed % 10;
  const hundred = displayed % 100;
  let word = 'кредитов';

  if (!Number.isInteger(displayed)) {
    word = 'кредита';
  } else if (hundred < 11 || hundred > 14) {
    if (last === 1) {
      word = 'кредит';
    } else if (last >= 2 && last <= 4) {
      word = 'кредита';
    }
  }

  return `${Number(text.replace(',', '.')) === 0 ? '0' : text} ${word}`;
}

/**
 * Принимает только будущий безопасный срок, не передавая наружу заголовки API.
 * Retry-After имеет приоритет; запасной reset задан в Unix seconds.
 */
function retryAt(headers: Headers, now: number): number | undefined {
  const raw = headers.get('Retry-After')?.trim() || '';
  const seconds = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const httpDate = /^(?:[A-Za-z]+,|[A-Za-z]{3} [A-Za-z]{3} )/.test(raw);
  const date = httpDate ? Date.parse(raw) : NaN;
  const asked = Number.isFinite(seconds) ? now + seconds * 1000 : date;

  if (Number.isSafeInteger(asked) && asked > now && asked <= 8_640_000_000_000_000) {
    return asked;
  }

  const reset = headers.get('X-RateLimit-Reset')?.trim() || '';
  const fallback = /^\d+(?:\.\d+)?$/.test(reset) ? Number(reset) * 1000 : NaN;

  return Number.isSafeInteger(fallback) && fallback > now && fallback <= 8_640_000_000_000_000
    ? fallback : undefined;
}

/**
 * Преобразует только проверенные поля v3 в ресурс кредитов.
 * Недоверенные сообщения и идентификаторы ответа никогда не участвуют в результате.
 */
function parseBalance(payload: unknown, billing: string) {
  if (!isRecord(payload) || typeof payload.code !== 'number' || !Number.isFinite(payload.code)) {
    return { state: 'unavailable', message: INVALID_MESSAGE };
  }

  if ([1000, 1001].includes(payload.code)) {
    return { state: 'auth_required', message: AUTH_MESSAGE };
  }

  if ([1002, 1005].includes(payload.code)) {
    return { state: 'auth_required', message: 'Проверьте доступ Tripo: ключ, права и регион.' };
  }

  if ([1007, 2000].includes(payload.code)) {
    return { state: 'rate_limited', message: RATE_MESSAGE };
  }

  const data = payload.data;

  if (payload.code !== 0 || !isRecord(data)
    || typeof data.balance !== 'number' || !Number.isFinite(data.balance)
    || typeof data.frozen !== 'number' || !Number.isFinite(data.frozen) || data.frozen < 0) {
    return { state: 'unavailable', message: INVALID_MESSAGE };
  }

  const reserved = data.frozen > 0
    ? ` · ${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(data.frozen)} в резерве`
    : '';

  return {
    state: 'ok',
    bars: [],
    resources: [{
      key: 'credits',
      label: 'Кредиты',
      summary: `${creditSummary(data.balance)}${reserved}`,
      tone: data.balance <= 0 ? 'bad' : 'ok',
      controls: [{
        id: 'top-up',
        kind: 'link',
        label: 'Пополнить',
        href: billing
      }],
    }],
  };
}

/**
 * Ограничивает fetch вместе с чтением body одной попыткой и отменяет запрос по сроку.
 * Известный HTTP-отказ классифицируется сразу; тело и редирект не меняют его смысл.
 */
async function attempt(
  access: ReturnType<typeof tripoAccess>,
  timeoutMs: number,
  deps: Required<Omit<TripoAccountDeps, 'env' | 'sleep'>>,
) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = deps.setTimer(() => {
      reject(new Error('tripo_timeout'));
      controller.abort();
    }, timeoutMs);
  });
  /**
   * Чтение тела остаётся частью той же отменяемой операции, что и получение headers.
   * HTTP-отказ завершает её без доверия к содержимому ответа.
   */
  const request = async () => {
    const response = await deps.fetchImpl(`${access.api}/v3/account/balance`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${access.key}`, Accept: 'application/json' },
      signal: controller.signal,
    });

    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => {});

      const state = response.status === 401 || response.status === 403 ? 'auth_required'
        : response.status === 429 ? 'rate_limited' : 'unavailable';
      const message = response.status === 401 ? AUTH_MESSAGE : response.status === 403 ? ACCESS_MESSAGE
        : response.status === 429 ? RATE_MESSAGE : INVALID_MESSAGE;

      return {
        state,
        message,
        ...(state === 'rate_limited' ? { retryAt: retryAt(response.headers, deps.now()) } : {}),
      };
    }

    const body = await response.text();
    let payload: unknown;

    try {
      payload = JSON.parse(body);
    } catch {
      return { state: 'unavailable', message: INVALID_MESSAGE };
    }

    const usage = parseBalance(payload, access.billing);

    return usage.state === 'rate_limited'
      ? { ...usage, retryAt: retryAt(response.headers, deps.now()) }
      : usage;
  };

  try {
    return await Promise.race([request(), deadline]);
  } finally {
    if (timer !== undefined) {
      deps.clearTimer(timer);
    }
  }
}

/**
 * Читает только баланс: до трёх попыток при сетевом срыве в общем пределе 25 секунд.
 * Секрет остаётся в заголовке, исключения не публикуются и не журналируются.
 */
export async function readTripoBalance(options: TripoAccountDeps = {}): Promise<ProviderUsage> {
  const env = options.env ?? process.env;
  const access = tripoAccess(env);
  const deps = {
    fetchImpl: options.fetchImpl ?? fetch,
    now: options.now ?? Date.now,
    setTimer: options.setTimer ?? setTimeout,
    clearTimer: options.clearTimer ?? clearTimeout,
  };
  const checkedAt = deps.now();
  const result = (usage: unknown) => normalizeProviderUsage(usage, { providerName: 'Tripo', checkedAt });

  if (!access.key) {
    return result({ state: 'auth_required', message: 'Задайте ключ Tripo и регион в настройках.' });
  }

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => deps.setTimer(resolve, ms)));

  for (let index = 0; index < 3; index += 1) {
    const remaining = 25_000 - (deps.now() - checkedAt);

    if (remaining <= 0) {
      break;
    }

    try {
      return result(await attempt(access, Math.min(8_000, remaining), deps));
    } catch {
      if (index < 2) {
        const pause = Math.min(250 * (index + 1), Math.max(0, 25_000 - (deps.now() - checkedAt)));

        if (pause > 0) {
          await sleep(pause);
        }
      }
    }
  }

  return result({ state: 'unavailable', message: NETWORK_MESSAGE });
}
