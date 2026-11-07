// Разбор блока usage из `meta.env` прогона для карточки «Попытки запуска».
//
// `meta.env` пишет ЛОНЧЕР ДВИЖКА — это диагностическое зеркало запуска, а не источник
// правды: каталог прогона доступен провайдеру на запись, поэтому `SOURCE=runtime` и
// `META_COMPLETE=1` сами по себе ничего не доказывают. Здесь файл читается ровно для
// показа фактических токенов уже завершившейся попытки.
//
// Числа приходят строками и складываются в BigInt: токены прогона легко выходят за 2^53,
// а `COST_USD` может иметь до 18 знаков — прогон через `Number` молча терял бы точность.
// Отсутствие поля означает «провайдер не сообщил» и НЕ превращается в ноль.

const UINT_RE = /^(?:0|[1-9][0-9]{0,29})$/u;
const LEGACY_COST_RE = /^(?:0|[1-9][0-9]{0,11})(?:\.[0-9]{1,18})?$/u;
// Каноническая неотрицательная десятичная строка: без экспоненты, знака и хвостовых нулей.
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;
const MAX_SIGNIFICANT_DIGITS = 30;
const MAX_SCALE = 18;

// `meta.env` — плоская карта строк: лончер движка пишет её как обычный env-файл.
export type MetaEnv = Record<string, string | undefined>;

// Разобранный расход попытки. Числа остаются СТРОКАМИ: токены выходят за 2^53, а у
// стоимости до 18 знаков после точки — прогон через `number` молча терял бы точность.
// `null` означает «провайдер не сообщил» и в ноль не превращается.
export interface MetaUsage {
  in: string | null;
  out: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
  cacheWrite5m: string | null;
  cacheWrite1h: string | null;
  cacheWriteUnknown: string | null;
  costUsd: string | null;
  completeness: 'complete' | 'partial';
  // exact — атомарное зеркало schema 2; approximate — история старых прогонов.
  provenance: 'exact' | 'approximate';
}

function uint(value: unknown): string | null {
  return typeof value === 'string' && UINT_RE.test(value) ? value : null;
}

/** Валидирует каноническую десятичную строку; нормализовать нельзя — alias запрещён. */
function canonicalDecimal(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) return null;
  const [whole = '', fraction = ''] = value.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/u, '') || '0';
  if (digits.length > MAX_SIGNIFICANT_DIGITS || fraction.length > MAX_SCALE) return null;
  return value;
}

/** Сумма канонических целых строк. Точная: слагаемые уже проверены `uint()`. */
function addUints(...values: string[]): string {
  return values.reduce((sum, value) => sum + BigInt(value), 0n).toString();
}

function legacyCost(value: unknown): string | null {
  if (typeof value !== 'string' || !LEGACY_COST_RE.test(value)) return null;

  const [whole = '', fraction = ''] = value.split('.');
  const trimmed = fraction.replace(/0+$/u, '');
  return trimmed.length > 0 ? `${whole}.${trimmed}` : whole;
}

/** Атомарное зеркало запуска: лончер пишет его целиком после завершения процесса. */
function schema2(meta: MetaEnv): MetaUsage | null {
  const complete = meta.USAGE_COMPLETE;

  if (meta.META_COMPLETE !== '1' || meta.USAGE_SCHEMA !== '2'
      || (complete !== '0' && complete !== '1')) return null;

  // Поля читаются по одному: пропуск любого означает не «ноль», а неполное зеркало,
  // и такую запись показывать как расход нельзя.
  const tokensIn = uint(meta.TOKENS_IN);
  const tokensOut = uint(meta.TOKENS_OUT);
  const cacheRead = uint(meta.TOKENS_CACHE_READ);
  const cacheWrite5m = uint(meta.TOKENS_CACHE_WRITE_5M);
  const cacheWrite1h = uint(meta.TOKENS_CACHE_WRITE_1H);
  const cacheWriteUnknown = uint(meta.TOKENS_CACHE_WRITE_UNKNOWN);

  if (tokensIn === null || tokensOut === null || cacheRead === null
      || cacheWrite5m === null || cacheWrite1h === null || cacheWriteUnknown === null) {
    return null;
  }

  const costUsd = Object.hasOwn(meta, 'COST_USD') ? canonicalDecimal(meta.COST_USD) : null;

  if (Object.hasOwn(meta, 'COST_USD') && costUsd === null) return null;

  return Object.freeze({
    in: tokensIn,
    out: tokensOut,
    cacheRead,
    cacheWrite5m,
    cacheWrite1h,
    cacheWriteUnknown,
    // 5m и 1h держатся отдельно: у них разный тариф, и смешивать их нельзя.
    // Сумма нужна только для одной компактной строки карточки.
    cacheWrite: addUints(cacheWrite5m, cacheWrite1h, cacheWriteUnknown),
    costUsd,
    completeness: complete === '1' ? 'complete' : 'partial',
    provenance: 'exact',
  });
}

/** Прежний формат: остаётся только ради истории и честно помечается приблизительным. */
function schema1(meta: MetaEnv): MetaUsage | null {
  const fields = {
    in: uint(meta.TOKENS_IN),
    out: uint(meta.TOKENS_OUT),
    cacheRead: uint(meta.TOKENS_CACHE_READ),
    cacheWrite: uint(meta.TOKENS_CACHE_WRITE),
  };
  const present = Object.values(fields).some((value) => value !== null);
  const costUsd = Object.hasOwn(meta, 'COST_USD') ? legacyCost(meta.COST_USD) : null;
  if (!present && costUsd === null) return null;
  return Object.freeze({
    ...fields,
    cacheWrite5m: null,
    cacheWrite1h: null,
    cacheWriteUnknown: fields.cacheWrite,
    costUsd,
    completeness: Object.values(fields).every((value) => value !== null)
      ? 'complete' : 'partial',
    provenance: 'approximate',
  });
}

/**
 * Модель показа для карточки прогона. Schema 2 — атомарное зеркало, которое лончер
 * пишет целиком после завершения процесса; schema 1 остаётся только для истории
 * старых прогонов и честно помечается `provenance: 'approximate'`.
 */
export function normalizedMetaUsage(value: unknown): MetaUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const meta = value as MetaEnv;

  if (meta.SCHEMA === '2') return schema2(meta);
  if (meta.SCHEMA === '1') return schema1(meta);

  return null;
}
