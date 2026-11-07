// Реестр сбоев хода: ядро знает только ОБЩИЕ признаки ошибки (HTTP-статус, слова
// поставщика), а вендорные коды объявляет сам адаптер через `turnFailureRules`.
// Поэтому здесь нет ни одного имени исполнителя: классификация, паузы и бюджет
// продолжаемых видов одинаковы для всех, кто подтвердил контракт turnRecovery.

export const TURN_FAILURE_KINDS = Object.freeze([
  'auth',
  'usage_limit',
  'context_overflow',
  'policy',
  'bad_request',
  'rate_limited',
  'overloaded',
  'server_error',
  'network',
] as const);

export type TurnFailureKind = typeof TURN_FAILURE_KINDS[number];

// Что можно продолжать автоматически: сбой временный и повтор той же сессии осмыслен.
export type ContinuableKind = 'rate_limited' | 'overloaded' | 'server_error' | 'network';

// Сигнал сбоя от адаптера. Пустые поля не кладутся: отсутствие кода — это отсутствие
// знания, а не код, поэтому правила проверяют признаки по отдельности.
export interface TurnFailureSignal {
  code?: string;
  status?: number;
  message: string;
}

// Признак прогресса и разрешение продолжать — РАЗНЫЕ вещи. canContinue true только
// после окончательного исхода принятой попытки в сохранённом разговоре; madeProgress —
// монотонный положительный признак работы текущей попытки, а не доказательство её отсутствия.
export interface TurnRecovery {
  canContinue: boolean;
  madeProgress: boolean;
}

// Правило совпадает по ЛЮБОМУ объявленному признаку. Флаги g/y у pattern запрещены:
// RegExp.test с ними помнит lastIndex и пропускает совпадения на чётных вызовах.
export interface TurnFailureRule {
  id: string;
  kind: TurnFailureKind;
  codes?: readonly string[];
  statuses?: readonly number[];
  pattern?: RegExp;
}

export interface TurnFailureVerdict {
  kind: TurnFailureKind | 'unknown';
  ruleId: string;
  continuable: boolean;
}

export const AUTO_CONTINUE_MAX_PER_TURN = 10;

// Паузы перед продолжением: индекс — номер неуспешной попытки подряд без продвижения.
// Значения растут, чтобы временный сбой поставщика успел пройти, а не долбить его сразу.
export const AUTO_CONTINUE_DELAYS_MS: Readonly<Record<ContinuableKind, readonly number[]>> =
  Object.freeze({
    network: Object.freeze([10_000, 60_000, 180_000]),
    server_error: Object.freeze([30_000, 120_000, 300_000]),
    overloaded: Object.freeze([60_000, 180_000, 300_000]),
    rate_limited: Object.freeze([60_000, 180_000, 300_000]),
  });

// Подписи для ленты и итога. Вид `unknown` не продолжают: причина не распознана,
// и повтор может повторить уже случившийся внешний эффект.
export const TURN_FAILURE_LABELS: Readonly<Record<TurnFailureKind | 'unknown', string>> =
  Object.freeze({
    auth: 'поставщик не принял вход или ключ',
    usage_limit: 'исчерпан лимит использования',
    context_overflow: 'контекст разговора переполнен',
    policy: 'поставщик отказал по своей политике',
    bad_request: 'поставщик отклонил запрос',
    rate_limited: 'поставщик ограничил частоту запросов',
    overloaded: 'модель перегружена',
    server_error: 'сбой на стороне поставщика',
    network: 'оборвалась связь с моделью',
    unknown: 'причина не распознана',
  });

const CONTINUABLE = new Set<string>(['rate_limited', 'overloaded', 'server_error', 'network']);

// Длинная простыня поставщика не должна ни тормозить регулярки, ни прятать фамильную
// часть сообщения за пределом обзора — поэтому частичный текст не разрешает продолжение.
const MESSAGE_LIMIT = 4000;

// Длинные шаблоны собираются из кусков строкой: одна строка исходника ограничена
// по длине, а читать признак целиком в одном месте всё равно удобнее.
const AUTH_WORDS = new RegExp([
  String.raw`\bunauthori[sz]ed\b`,
  String.raw`\bauthentication[\s_-](?:failed|error|required)\b`,
  String.raw`\binvalid[\s_-]api[\s_-]key\b`,
].join('|'), 'i');

const QUOTA_WORDS = new RegExp([
  String.raw`\binsufficient[\s_-]+(?:quota|balance|credits?)\b`,
  String.raw`\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b`,
  String.raw`\bhit your (?:[\w-]+ )?limit\b`,
  String.raw`\bcredit balance is too low\b`,
  String.raw`\bspend limit\b`,
  String.raw`\bout of credits\b`,
].join('|'), 'i');

const CONTEXT_WORDS = new RegExp([
  String.raw`\bcontext[\s_-]?(?:length|window)[\s_-]?(?:exceeded|overflow)`,
  String.raw`\bprompt is too long\b`,
  String.raw`\bmaximum context length\b`,
  String.raw`\bout of room in the model'?s context window\b`,
].join('|'), 'i');

const BAD_REQUEST_WORDS = new RegExp([
  String.raw`\bbad request\b`,
  String.raw`\binvalid_request_error\b`,
].join('|'), 'i');

const RATE_WORDS = new RegExp([
  String.raw`\brate[\s_-]?limit(?:ed|[\s_-]exceeded|_error)?\b`,
  String.raw`\btoo many requests\b`,
].join('|'), 'i');

const OVERLOADED_WORDS = new RegExp([
  String.raw`\boverloaded\b`,
  String.raw`\bat capacity\b`,
].join('|'), 'i');

const SERVER_WORDS = new RegExp([
  String.raw`\binternal server error\b`,
  String.raw`\bbad gateway\b`,
  String.raw`\bservice unavailable\b`,
  String.raw`\bgateway time-?out\b`,
].join('|'), 'i');

const NETWORK_WORDS = new RegExp([
  String.raw`\b(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EPIPE)\b`,
  String.raw`\b(?:EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH)\b`,
  String.raw`\bUND_ERR_[A-Z_]+\b`,
  String.raw`socket hang up`,
  String.raw`stream disconnected`,
  String.raw`connection (?:error|closed|reset|refused|lost)`,
  String.raw`network error`,
  String.raw`fetch failed`,
  String.raw`timed out`,
  String.raw`error decoding response body`,
  String.raw`transport error`,
  String.raw`unexpected eof`,
].join('|'), 'i');

// Правило без pattern (только статусы) не должно тянуть за собой пустое поле: сборщик
// читает признаки по наличию, а `undefined` в таблице мешал бы сериализации снимков.
function statusRule(id: string, kind: TurnFailureKind, statuses: number[]): TurnFailureRule {
  return {
    id,
    kind,
    statuses: Object.freeze(statuses),
  };
}

function wordRule(id: string, kind: TurnFailureKind, pattern: RegExp): TurnFailureRule {
  return {
    id,
    kind,
    pattern,
  };
}

// Общие признаки: их понимает ядро без знания вендора. Паттерны намеренно без флагов g/y
// (см. TurnFailureRule) и без учёта регистра — поставщики пишут причину по-разному.
export const COMMON_TURN_FAILURE_RULES: readonly TurnFailureRule[] = Object.freeze([
  statusRule('common.http-auth', 'auth', [401, 403]),
  wordRule('common.auth-words', 'auth', AUTH_WORDS),
  statusRule('common.http-payment', 'usage_limit', [402]),
  wordRule('common.quota-words', 'usage_limit', QUOTA_WORDS),
  statusRule('common.http-too-large', 'context_overflow', [413]),
  wordRule('common.context-words', 'context_overflow', CONTEXT_WORDS),
  statusRule('common.http-bad-request', 'bad_request', [400, 404, 422]),
  wordRule('common.bad-request-words', 'bad_request', BAD_REQUEST_WORDS),
  statusRule('common.http-rate-limit', 'rate_limited', [429]),
  wordRule('common.rate-words', 'rate_limited', RATE_WORDS),
  statusRule('common.http-overloaded', 'overloaded', [529]),
  wordRule('common.overloaded-words', 'overloaded', OVERLOADED_WORDS),
  statusRule('common.http-server', 'server_error', [500, 502, 503, 504]),
  wordRule('common.server-words', 'server_error', SERVER_WORDS),
  wordRule('common.network-words', 'network', NETWORK_WORDS),
]);

/**
 * Совпадает ли правило с сигналом: достаточно любого объявленного признака.
 * Текст обрезается — длинная простыня поставщика не должна тормозить регулярки.
 */
function ruleMatches(rule: TurnFailureRule, signal: TurnFailureSignal): boolean {
  if (signal.code && rule.codes?.includes(signal.code)) {
    return true;
  }

  if (signal.status !== undefined && rule.statuses?.includes(signal.status)) {
    return true;
  }

  return Boolean(rule.pattern && signal.message
    && rule.pattern.test(signal.message.slice(0, MESSAGE_LIMIT)));
}

/**
 * Вид сбоя по сигналу адаптера. Проверяются все правила — сначала адаптера, затем общие;
 * из совпавших побеждает вид левее в TURN_FAILURE_KINDS, ruleId — первое правило этого вида.
 * Пустой сигнал и отсутствие совпадений дают unknown: такое чат сам не продолжает.
 */
export function classifyTurnFailure(
  signal: Partial<TurnFailureSignal> | null | undefined,
  adapterRules: readonly TurnFailureRule[] | null | undefined = [],
): TurnFailureVerdict {
  const normalized: TurnFailureSignal = {
    ...(typeof signal?.code === 'string' && signal.code ? { code: signal.code } : {}),
    ...(Number.isInteger(signal?.status) ? { status: signal?.status } : {}),
    message: String(signal?.message ?? ''),
  };
  let best: TurnFailureRule | null = null;

  for (const rule of [...(adapterRules || []), ...COMMON_TURN_FAILURE_RULES]) {
    if (!ruleMatches(rule, normalized)) {
      continue;
    }

    if (!best || TURN_FAILURE_KINDS.indexOf(rule.kind) < TURN_FAILURE_KINDS.indexOf(best.kind)) {
      best = rule;
    }
  }

  if (!best) {
    return {
      kind: 'unknown',
      ruleId: '',
      continuable: false,
    };
  }

  if (normalized.message.length > MESSAGE_LIMIT && CONTINUABLE.has(best.kind)) {
    return {
      kind: 'unknown',
      ruleId: '',
      continuable: false,
    };
  }

  return {
    kind: best.kind,
    ruleId: best.id,
    continuable: CONTINUABLE.has(best.kind),
  };
}

/**
 * Пауза перед следующим продолжением: вид, номер неуспешной попытки подряд и необязательные
 * переопределения (тесты и настройки стенда). Не продолжаемый вид и выход за таблицу — null.
 */
export function autoContinueDelay(
  kind: TurnFailureKind | 'unknown',
  streak: number,
  overrides: Partial<Record<ContinuableKind, readonly number[]>> = {},
): number | null {
  if (!CONTINUABLE.has(kind)) {
    return null;
  }

  const delays = overrides[kind as ContinuableKind] ?? AUTO_CONTINUE_DELAYS_MS[kind as ContinuableKind];

  return delays[streak] ?? null;
}

/**
 * Сколько продолжений подряд допускает вид без подтверждённого продвижения.
 * Ноль означает «этот вид не продолжаем»; общий потолок на ход считает петля.
 */
export function autoContinueBudget(
  kind: TurnFailureKind | 'unknown',
  overrides: Partial<Record<ContinuableKind, readonly number[]>> = {},
): number {
  if (!CONTINUABLE.has(kind)) {
    return 0;
  }

  const delays = overrides[kind as ContinuableKind] ?? AUTO_CONTINUE_DELAYS_MS[kind as ContinuableKind];

  return delays.length;
}
