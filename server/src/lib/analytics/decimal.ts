// Точные неотрицательные десятичные значения для аналитики: разбор, арифметика и округление.
const DECIMAL_RE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const DEFAULT_LIMITS = Object.freeze({ significantDigits: 30, scale: 18 });

export class AnalyticsDecimalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnalyticsDecimalError';
    this.code = 'analytics_decimal_invalid';
  }
}

const fail = (message) => {
  throw new AnalyticsDecimalError(message);
};

function parse(value, {
  significantDigits = DEFAULT_LIMITS.significantDigits,
  maxScale = DEFAULT_LIMITS.scale,
  where = 'decimal',
} = {}) {
  if (typeof value !== 'string' || !DECIMAL_RE.test(value)) {
    fail(`${where}: ожидалась canonical non-negative decimal string.`);
  }
  const [whole, fraction = ''] = value.split('.');
  const digits = `${whole}${fraction}`.replace(/^0+/, '') || '0';
  if (digits.length > significantDigits || fraction.length > maxScale) {
    fail(`${where}: decimal выходит за числовые границы.`);
  }
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function power10(scale) {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100) {
    fail('Некорректный decimal scale.');
  }
  return 10n ** BigInt(scale);
}

function encode(coefficient, scale) {
  if (coefficient < 0n) fail('Negative analytics decimal запрещён.');
  if (coefficient === 0n) return '0';
  let digits = coefficient.toString();
  if (scale > 0) {
    if (digits.length <= scale) digits = `${'0'.repeat(scale + 1 - digits.length)}${digits}`;
    const split = digits.length - scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
    digits = digits.replace(/0+$/, '').replace(/\.$/, '');
  }
  return digits;
}

function roundQuotient(numerator, denominator) {
  if (denominator <= 0n || numerator < 0n) fail('Некорректная decimal fraction.');
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  const doubled = remainder * 2n;
  if (doubled < denominator) return quotient;
  if (doubled > denominator) return quotient + 1n;
  return quotient % 2n === 0n ? quotient : quotient + 1n;
}

/** Возвращает null вместо normalization: aliases в persisted/API contract запрещены. */
export function canonicalDecimal(value, options) {
  try {
    parse(value, options);
    return value;
  } catch (err) {
    if (err instanceof AnalyticsDecimalError) return null;
    throw err;
  }
}

export function assertDecimal(value, options) {
  parse(value, options);
  return value;
}

export function addDecimals(...values) {
  if (values.length === 0) return '0';
  const parsed = values.map((value, index) => parse(value, {
    significantDigits: 120,
    maxScale: 100,
    where: `values[${index}]`,
  }));
  const scale = Math.max(...parsed.map((item) => item.scale));
  const coefficient = parsed.reduce(
    (sum, item) => sum + item.coefficient * power10(scale - item.scale),
    0n,
  );
  return encode(coefficient, scale);
}

export function roundDecimal(value, scale) {
  const item = parse(value, { significantDigits: 120, maxScale: 100 });
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 100) fail('Некорректный target scale.');
  if (item.scale <= scale) return encode(item.coefficient * power10(scale - item.scale), scale);
  const divisor = power10(item.scale - scale);
  return encode(roundQuotient(item.coefficient, divisor), scale);
}

/** quantity * price / denominator, один half-even round до заданного USD scale. */
export function multiplyDivideDecimal(quantity, price, denominator, { scale = 18 } = {}) {
  const q = parse(quantity, { significantDigits: 30, maxScale: 9, where: 'quantity' });
  const p = parse(price, { significantDigits: 30, maxScale: 18, where: 'price' });
  if (typeof denominator !== 'string' || !/^[1-9][0-9]{0,8}$/.test(denominator)) {
    fail('rateDenominator: ожидалась canonical positive integer string <= 1e9.');
  }
  const numerator = q.coefficient * p.coefficient * power10(scale);
  const divisor = BigInt(denominator) * power10(q.scale + p.scale);
  return encode(roundQuotient(numerator, divisor), scale);
}
