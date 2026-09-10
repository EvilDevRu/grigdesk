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
  readonly code = 'exact_number_format_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'ExactNumberFormatError';
  }
}

// Разобранное десятичное: целое значение и позиция точки. `Number` здесь не появляется
// ни разу — в этом весь смысл модуля.
interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

// Настройки показа. Разделители — только для человека: полученный текст нельзя
// отправлять обратно в API.
interface DecimalFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  group?: boolean;
  groupSeparator?: string;
  decimalSeparator?: string;
}

/**
 * Объявленный `never` обязателен: после `fail(...)` сужение продолжается, и проверенные
 * выше строки не приходится страховать второй раз. Стрелочная константа этого не даёт —
 * только объявление функции.
 */
function fail(message: string): never {
  throw new ExactNumberFormatError(message);
}

function fractionDigits(value: unknown, where: string): number {
  // `Number.isSafeInteger` не сужает тип, поэтому приводим один раз и проверяем уже число.
  const parsed = value as number;

  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
    fail(`${where}: ожидается целое от 0 до 100.`);
  }

  return parsed;
}

/**
 * Каноническая строка или BigInt → целое значение и позиция точки. Всё, что не прошло
 * проверку формы, отвергается сразу: молчаливое приведение через `Number` — ровно та
 * потеря точности, ради которой этот модуль и написан.
 */
function parseDecimal(value: unknown): ExactDecimal {
  if (typeof value === 'bigint') {
    return { coefficient: value, scale: 0 };
  }

  if (typeof value !== 'string' || !CANONICAL_DECIMAL_RE.test(value) || value === '-0') {
    fail('Ожидается каноническая десятичная строка или BigInt; Number запрещён.');
  }

  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole = '', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);

  return { coefficient: negative ? -coefficient : coefficient, scale: fraction.length };
}

/**
 * Обратная операция к разбору: целое и позиция точки → каноническая строка.
 * Хвостовые нули срезаются, а «-0» не появляется вовсе — ноль у нас один.
 */
function encodeDecimal(coefficient: bigint, scale: number): string {
  const negative = coefficient < 0n;
  let digits = (negative ? -coefficient : coefficient).toString();

  if (scale > 0) {
    if (digits.length <= scale) {
      digits = `${'0'.repeat(scale + 1 - digits.length)}${digits}`;
    }

    const split = digits.length - scale;

    digits = `${digits.slice(0, split)}.${digits.slice(split)}`;
    digits = digits.replace(/0+$/, '').replace(/\.$/, '');
  }

  if (digits === '0') {
    return '0';
  }

  return negative ? `-${digits}` : digits;
}

/**
 * Деление с округлением «половина к чётному» — единственное место, где значение
 * теряет знаки. Ровная половина уходит к чётному, чтобы сумма многих округлений
 * не смещалась вверх, как это делает привычное «половина вверх».
 */
function halfEvenQuotient(coefficient: bigint, divisor: bigint): bigint {
  const negative = coefficient < 0n;
  const absolute = negative ? -coefficient : coefficient;
  let quotient = absolute / divisor;
  const remainder = absolute % divisor;
  const doubled = remainder * 2n;

  if (doubled > divisor || (doubled === divisor && quotient % 2n !== 0n)) {
    quotient += 1n;
  }

  return negative ? -quotient : quotient;
}

/**
 * Разряды по три, считая справа. Знак отделяется заранее: иначе минус попал бы
 * в первую группу и сдвинул бы всю разбивку на символ.
 */
function groupWhole(whole: string, separator: string): string {
  const negative = whole.startsWith('-');
  const digits = negative ? whole.slice(1) : whole;
  const head = digits.length % 3 || 3;
  const groups = [digits.slice(0, head)];

  for (let at = head; at < digits.length; at += 3) {
    groups.push(digits.slice(at, at + 3));
  }

  return `${negative ? '-' : ''}${groups.join(separator)}`;
}

/**
 * Округлить каноническую десятичную строку ОДИН раз. Один — принципиально: повторное
 * округление уже округлённого копит ошибку, поэтому весь показ идёт через этот вход.
 */
export function roundExactDecimal(value: unknown, scale: unknown): string {
  const targetScale = fractionDigits(scale, 'scale');
  const parsed = parseDecimal(value);

  if (parsed.scale <= targetScale) {
    return encodeDecimal(parsed.coefficient, parsed.scale);
  }

  const divisor = 10n ** BigInt(parsed.scale - targetScale);

  return encodeDecimal(halfEvenQuotient(parsed.coefficient, divisor), targetScale);
}

/**
 * Показ десятичного значения человеку: округление ровно один раз, добивка нулями до
 * минимума и, по просьбе, разряды. Результат предназначен ГЛАЗАМ — отправлять его
 * обратно в API нельзя, разделители не являются частью значения.
 */
export function formatExactDecimal(value: unknown, {
  minimumFractionDigits = 0,
  maximumFractionDigits = 2,
  group = false,
  groupSeparator = ' ',
  decimalSeparator = '.',
}: DecimalFormatOptions = {}): string {
  const minimum = fractionDigits(minimumFractionDigits, 'minimumFractionDigits');
  const maximum = fractionDigits(maximumFractionDigits, 'maximumFractionDigits');

  if (minimum > maximum) {
    fail('minimumFractionDigits не может превышать maximumFractionDigits.');
  }

  if (typeof groupSeparator !== 'string' || typeof decimalSeparator !== 'string'
      || !groupSeparator || !decimalSeparator) {
    fail('Разделители показа обязаны быть непустыми строками.');
  }

  const rounded = roundExactDecimal(value, maximum);
  const [wholeRaw = '', fractionRaw = ''] = rounded.split('.');
  const fraction = fractionRaw.padEnd(minimum, '0');
  const whole = group ? groupWhole(wholeRaw, groupSeparator) : wholeRaw;

  return fraction ? `${whole}${decimalSeparator}${fraction}` : whole;
}

/**
 * Показ целого с разрядами. Отдельный вход, а не частный случай десятичного:
 * у токенов не бывает дробной части, и лишний путь округления им не нужен.
 */
export function formatExactInteger(value: unknown, {
  groupSeparator = ' ',
}: { groupSeparator?: string } = {}): string {
  const encoded = typeof value === 'bigint' ? value.toString() : value;

  if (typeof encoded !== 'string' || !CANONICAL_INTEGER_RE.test(encoded) || encoded === '-0') {
    fail('Ожидается каноническая целая строка или BigInt; Number запрещён.');
  }

  if (typeof groupSeparator !== 'string' || !groupSeparator) {
    fail('groupSeparator обязан быть непустым.');
  }

  return groupWhole(encoded, groupSeparator);
}

/**
 * Деньги: знак валюты плюс то же самое десятичное. Число знаков задаёт вызывающий —
 * у стоимости хода их четыре, у итога за месяц два, и решать это здесь неправильно.
 */
export function formatExactUsd(value: unknown, {
  minimumFractionDigits = 2,
  maximumFractionDigits = 2,
  currency = '$',
  ...options
}: DecimalFormatOptions & { currency?: string } = {}): string {
  if (typeof currency !== 'string') {
    fail('currency обязан быть строкой.');
  }

  return `${currency}${formatExactDecimal(value, {
    minimumFractionDigits,
    maximumFractionDigits,
    ...options,
  })}`;
}
