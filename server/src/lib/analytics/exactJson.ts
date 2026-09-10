// Строгий разбор JSON с сохранением исходных числовых лексем для аналитики.
const DEFAULT_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  depth: 64,
  values: 100_000,
  numericDigits: 512,
  exponent: 1_000,
});

const NUMBER_RE = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const NUMBER_PARTS_RE = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
const HEX4_RE = /^[0-9a-fA-F]{4}$/;
const NUMBER_TOKEN = Symbol('analytics.exact-json-number');

export class AnalyticsExactJsonError extends Error {
  readonly code = 'analytics_exact_json_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsExactJsonError';
  }
}

/**
 * Отказ разбора. Объявлен функцией, а не стрелкой в const: только у объявления
 * компилятор считает `never` признаком «дальше кода нет» и сужает по нему тип.
 */
function fail(message: string): never {
  throw new AnalyticsExactJsonError(message);
}

/**
 * Число из JSON, сохранённое ЛЕКСЕМОЙ. Обычный разбор превратил бы его в IEEE-754 и
 * молча потерял точность на первой же цене с восемнадцатью знаками. Лексема лежит под
 * символом: посторонний объект не может выдать себя за неё.
 */
class ExactJsonNumber {
  constructor(raw: string) {
    Object.defineProperty(this, NUMBER_TOKEN, { value: raw });
    Object.freeze(this);
  }
}

// Что вернул строгий разбор. Числа остаются лексемами, объекты — без прототипа:
// `__proto__` из чужого JSON не должен становиться наследованием.
export type ExactJsonValue =
  | null
  | boolean
  | string
  | ExactJsonNumber
  | ExactJsonValue[]
  | { [key: string]: ExactJsonValue };

// Границы разбора: они защищают от чужого раздувшегося ввода, а не от своей ошибки.
export interface ExactJsonLimits {
  bytes?: number;
  depth?: number;
  values?: number;
  numericDigits?: number;
  exponent?: number;
}

/** Непарные суррогаты запрещены: такая строка не имеет канонического представления. */
function validateUnicode(value: string, where: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${where}: lone high surrogate запрещён.`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${where}: lone low surrogate запрещён.`);
    }
  }
  return value;
}

function checkedLimits(overrides: ExactJsonLimits): Required<ExactJsonLimits> {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      fail(`${name}: exact JSON limit обязан быть positive safe integer.`);
    }
  }
  return limits;
}

/**
 * JSON parser, который намеренно не преобразует JSON numbers в IEEE-754 Number.
 * Object keys с дублями и невалидный Unicode отвергаются fail-closed.
 */
export function parseExactJson(text: unknown, overrides: ExactJsonLimits = {}): ExactJsonValue {
  if (typeof text !== 'string') fail('Exact JSON input обязан быть строкой.');

  const source: string = text;
  const limits = checkedLimits(overrides);
  if (Buffer.byteLength(text, 'utf8') > limits.bytes) {
    fail(`Exact JSON превышает bytes limit ${limits.bytes}.`);
  }

  let offset = 0;
  let values = 0;

  const skipWhitespace = (): void => {
    while (offset < source.length && /[\u0009\u000a\u000d\u0020]/.test(source[offset] ?? '')) {
      offset += 1;
    }
  };

  const consumeValue = (depth: number): void => {
    values += 1;
    if (values > limits.values) fail(`Exact JSON превышает values limit ${limits.values}.`);
    if (depth > limits.depth) fail(`Exact JSON превышает depth limit ${limits.depth}.`);
  };

  /** JSON-строка со всеми escape: результат проверяется на парность суррогатов. */
  const parseString = (): string => {
    if (source[offset] !== '"') fail(`Ожидалась JSON string на offset ${offset}.`);
    offset += 1;
    let out = '';
    while (offset < source.length) {
      const character = source[offset];
      offset += 1;
      if (character === '"') return validateUnicode(out, 'JSON string');
      if (character === '\\') {
        if (offset >= source.length) fail('Незавершённый JSON escape.');
        const escaped = source[offset];
        offset += 1;
        const simple: Record<string, string> = {
          '"': '"',
          '\\': '\\',
          '/': '/',
          b: '\b',
          f: '\f',
          n: '\n',
          r: '\r',
          t: '\t',
        };

        if (escaped !== undefined && Object.hasOwn(simple, escaped)) {
          out += simple[escaped];
          continue;
        }
        if (escaped !== 'u') fail(`Неизвестный JSON escape \\${escaped}.`);
        const hex = source.slice(offset, offset + 4);
        if (!HEX4_RE.test(hex)) fail('Невалидный JSON unicode escape.');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
        continue;
      }
      if (character === undefined) fail('Незавершённая JSON string.');
      if (character.charCodeAt(0) < 0x20) fail('Control character в JSON string запрещён.');
      out += character;
    }
    fail('Незавершённая JSON string.');
  };

  /** Число сохраняется лексемой: превращать его в IEEE-754 здесь нельзя. */
  const parseNumber = (): ExactJsonNumber => {
    const match = NUMBER_RE.exec(source.slice(offset));
    if (!match) fail(`Невалидный JSON number на offset ${offset}.`);
    const raw = match[0];
    const parts = NUMBER_PARTS_RE.exec(raw);

    if (!parts) fail(`Невалидный JSON number на offset ${offset}.`);

    const digitCount = `${parts[2] ?? ''}${parts[3] ?? ''}`.length;
    if (digitCount > limits.numericDigits) {
      fail(`JSON number превышает numericDigits limit ${limits.numericDigits}.`);
    }
    const exponent = Number(parts[4] ?? '0');
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > limits.exponent) {
      fail(`JSON number превышает exponent limit ${limits.exponent}.`);
    }
    offset += raw.length;
    return new ExactJsonNumber(raw);
  };

  const parseValue = (depth = 0): ExactJsonValue => {
    skipWhitespace();
    consumeValue(depth);
    // Конец ввода тоже «символ»: пустая строка не совпадёт ни с одной веткой ниже
    // и доедет до общего отказа с понятным смещением.
    const character = source[offset] ?? '';

    if (character === '"') return parseString();
    if (character === '-' || (character >= '0' && character <= '9')) return parseNumber();
    if (source.startsWith('true', offset)) {
      offset += 4;
      return true;
    }
    if (source.startsWith('false', offset)) {
      offset += 5;
      return false;
    }
    if (source.startsWith('null', offset)) {
      offset += 4;
      return null;
    }
    if (character === '[') {
      offset += 1;
      const array: ExactJsonValue[] = [];
      skipWhitespace();
      if (source[offset] === ']') {
        offset += 1;
        return array;
      }
      while (true) {
        array.push(parseValue(depth + 1));
        skipWhitespace();
        if (source[offset] === ']') {
          offset += 1;
          return array;
        }
        if (source[offset] !== ',') fail(`Ожидалась запятая JSON array на offset ${offset}.`);
        offset += 1;
      }
    }
    if (character === '{') {
      offset += 1;
      const object: Record<string, ExactJsonValue> = Object.create(null);
      skipWhitespace();
      if (source[offset] === '}') {
        offset += 1;
        return object;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (Object.hasOwn(object, key)) fail(`Duplicate JSON object key ${JSON.stringify(key)}.`);
        skipWhitespace();
        if (source[offset] !== ':') fail(`Ожидалось двоеточие JSON object на offset ${offset}.`);
        offset += 1;
        object[key] = parseValue(depth + 1);
        skipWhitespace();
        if (source[offset] === '}') {
          offset += 1;
          return object;
        }
        if (source[offset] !== ',') fail(`Ожидалась запятая JSON object на offset ${offset}.`);
        offset += 1;
      }
    }
    fail(`Невалидное JSON значение на offset ${offset}.`);
  };

  const value = parseValue(0);
  skipWhitespace();
  if (offset !== text.length) fail(`Garbage после JSON значения на offset ${offset}.`);
  return value;
}

/** Достаёт исходную лексему числа. Посторонний объект сюда не проходит. */
export function exactJsonNumber(value: unknown): string {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, NUMBER_TOKEN)) {
    fail('Ожидался exact JSON number token.');
  }

  return (value as Record<symbol, string>)[NUMBER_TOKEN] as string;
}

/** Преобразует JSON number lexeme в canonical non-negative decimal без округления. */
export function decimalFromJsonNumber(value: unknown, {
  significantDigits = 120,
  maxScale = 100,
  maxWholeDigits = 120,
}: { significantDigits?: number; maxScale?: number; maxWholeDigits?: number } = {}): string {
  const raw = exactJsonNumber(value);
  const match = NUMBER_PARTS_RE.exec(raw);

  if (!match) fail('JSON number lexeme не разбирается.');

  const [, sign, whole = '', fraction = '', exponentRaw = '0'] = match;
  if (sign === '-') fail('Expected non-negative JSON number.');
  const exponent = Number(exponentRaw);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > DEFAULT_LIMITS.exponent) {
    fail('JSON number exponent выходит за границы.');
  }

  const combined = `${whole}${fraction}`;
  const leading = (combined.match(/^0*/)?.[0] ?? '').length;
  let digits = combined.slice(leading);
  if (digits.length === 0) return '0';
  let decimalPosition = whole.length + exponent - leading;

  let encoded;
  if (decimalPosition <= 0) encoded = `0.${'0'.repeat(-decimalPosition)}${digits}`;
  else if (decimalPosition >= digits.length) encoded = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  else encoded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  encoded = encoded.replace(/(?:\.([0-9]*?))0+$/, (_, kept) => kept ? `.${kept}` : '');

  const [encodedWhole = '', encodedFraction = ''] = encoded.split('.');
  const significant = `${encodedWhole}${encodedFraction}`.replace(/^0+/, '').length;
  if (!Number.isSafeInteger(significantDigits) || significantDigits < 1
      || !Number.isSafeInteger(maxScale) || maxScale < 0
      || !Number.isSafeInteger(maxWholeDigits) || maxWholeDigits < 1) {
    fail('Некорректные exact decimal limits.');
  }
  if (significant > significantDigits
      || encodedFraction.length > maxScale
      || encodedWhole.length > maxWholeDigits) {
    fail('Exact decimal выходит за числовые границы.');
  }
  return encoded;
}

export function exactUnsignedInteger(
  value: unknown,
  options?: { significantDigits?: number; maxScale?: number; maxWholeDigits?: number },
): string {
  const decimal = decimalFromJsonNumber(value, options);
  if (decimal.includes('.')) fail('Expected exact unsigned integer.');
  return decimal;
}
