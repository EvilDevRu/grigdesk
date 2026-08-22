// Точный показ канонических десятичных строк без `Number`.
//
// Зачем не `Intl.NumberFormat` и не обычная арифметика: величины из телеметрии прогонов
// (токены, стоимость) могут превышать 2^53, а денежные значения приходят строками с
// произвольным числом знаков. Прогон через `Number` молча теряет точность, поэтому здесь
// всё считается в BigInt, а округление — round-half-to-even ровно один раз.
//
// Разделители — только для показа: полученный текст нельзя отправлять обратно в API.

const CANONICAL_DECIMAL_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const CANONICAL_INTEGER_RE = /^-?(?:0|[1-9][0-9]*)$/;

export class ExactNumberFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExactNumberFormatError';
    this.code = 'exact_number_format_invalid';
  }
}

const fail = (message) => {
  throw new ExactNumberFormatError(message);
};

function fractionDigits(value, where) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
    fail(`${where}: ожидается целое от 0 до 100.`);
  }
  return value;
}

function parseDecimal(value) {
  if (typeof value === 'bigint') return { coefficient: value, scale: 0 };
  if (typeof value !== 'string' || !CANONICAL_DECIMAL_RE.test(value) || value === '-0') {
    fail('Ожидается каноническая десятичная строка или BigInt; Number запрещён.');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}

function encodeDecimal(coefficient, scale) {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();
  if (scale > 0) {
    if (digits.length <= scale) digits = `${'0'.repeat(scale + 1 - digits.length)}${digits}`;
    const split = digits.length - scale;
    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
    digits = digits.replace(/0+$/, '').replace(/\.$/, '');
  }
  if (digits === '0') return '0';
  return negative ? `-${digits}` : digits;
}

function halfEvenQuotient(coefficient, divisor) {
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const doubled = remainder * 2n;
  if (doubled > divisor || (doubled === divisor && quotient % 2n !== 0n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function groupWhole(whole, separator) {
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const head = digits.length % 3 || 3;
  const groups = [digits.slice(0, head)];
  for (let at = head; at < digits.length; at += 3) groups.push(digits.slice(at, at + 3));
  return `${negative ? '-' : ''}${groups.join(separator)}`;
}

/** Округлить каноническую десятичную строку ОДИН раз, round-half-to-even. */
export function roundExactDecimal(value, scale) {
  const targetScale = fractionDigits(scale, 'scale');
  const parsed = parseDecimal(value);
  if (parsed.scale <= targetScale) return encodeDecimal(parsed.coefficient, parsed.scale);
  const divisor = 10n ** BigInt(parsed.scale - targetScale);
  return encodeDecimal(halfEvenQuotient(parsed.coefficient, divisor), targetScale);
}

export function formatExactDecimal(value, {
  minimumFractionDigits = 0,
  maximumFractionDigits = 2,
  group = false,
  groupSeparator = ' ',
  decimalSeparator = '.',
} = {}) {
  const minimum = fractionDigits(minimumFractionDigits, 'minimumFractionDigits');
  const maximum = fractionDigits(maximumFractionDigits, 'maximumFractionDigits');
  if (minimum > maximum) fail('minimumFractionDigits не может превышать maximumFractionDigits.');
  if (typeof groupSeparator !== 'string' || typeof decimalSeparator !== 'string'
      || !groupSeparator || !decimalSeparator) {
    fail('Разделители показа обязаны быть непустыми строками.');
  }
  const rounded = roundExactDecimal(value, maximum);
  const [wholeRaw, fractionRaw = ''] = rounded.split('.');
  const fraction = fractionRaw.padEnd(minimum, '0');
  const whole = group ? groupWhole(wholeRaw, groupSeparator) : wholeRaw;
  return fraction ? `${whole}${decimalSeparator}${fraction}` : whole;
}

export function formatExactInteger(value, { groupSeparator = ' ' } = {}) {
  const encoded = typeof value === 'bigint' ? value.toString() : value;
  if (typeof encoded !== 'string' || !CANONICAL_INTEGER_RE.test(encoded) || encoded === '-0') {
    fail('Ожидается каноническая целая строка или BigInt; Number запрещён.');
  }
  if (typeof groupSeparator !== 'string' || !groupSeparator) {
    fail('groupSeparator обязан быть непустым.');
  }
  return groupWhole(encoded, groupSeparator);
}

export function formatExactUsd(value, {
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
  currency = '$',
  ...options
} = {}) {
  if (typeof currency !== 'string') fail('currency обязан быть строкой.');
  return `${currency}${formatExactDecimal(value, {
    minimumFractionDigits,
    maximumFractionDigits,
    ...options,
  })}`;
}
