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
  constructor(message) {
    super(message);
    this.name = 'AnalyticsExactJsonError';
    this.code = 'analytics_exact_json_invalid';
  }
}

const fail = (message) => {
  throw new AnalyticsExactJsonError(message);
};

class ExactJsonNumber {
  constructor(raw) {
    Object.defineProperty(this, NUMBER_TOKEN, { value: raw });
    Object.freeze(this);
  }
}

function validateUnicode(value, where) {
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

function checkedLimits(overrides) {
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
export function parseExactJson(text, overrides = {}) {
  if (typeof text !== 'string') fail('Exact JSON input обязан быть строкой.');
  const limits = checkedLimits(overrides);
  if (Buffer.byteLength(text, 'utf8') > limits.bytes) {
    fail(`Exact JSON превышает bytes limit ${limits.bytes}.`);
  }

  let offset = 0;
  let values = 0;

  const skipWhitespace = () => {
    while (offset < text.length && /[\u0009\u000a\u000d\u0020]/.test(text[offset])) offset += 1;
  };

  const consumeValue = (depth) => {
    values += 1;
    if (values > limits.values) fail(`Exact JSON превышает values limit ${limits.values}.`);
    if (depth > limits.depth) fail(`Exact JSON превышает depth limit ${limits.depth}.`);
  };

  const parseString = () => {
    if (text[offset] !== '"') fail(`Ожидалась JSON string на offset ${offset}.`);
    offset += 1;
    let out = '';
    while (offset < text.length) {
      const character = text[offset];
      offset += 1;
      if (character === '"') return validateUnicode(out, 'JSON string');
      if (character === '\\') {
        if (offset >= text.length) fail('Незавершённый JSON escape.');
        const escaped = text[offset];
        offset += 1;
        const simple = {
          '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f',
          n: '\n', r: '\r', t: '\t',
        };
        if (Object.hasOwn(simple, escaped)) {
          out += simple[escaped];
          continue;
        }
        if (escaped !== 'u') fail(`Неизвестный JSON escape \\${escaped}.`);
        const hex = text.slice(offset, offset + 4);
        if (!HEX4_RE.test(hex)) fail('Невалидный JSON unicode escape.');
        out += String.fromCharCode(Number.parseInt(hex, 16));
        offset += 4;
        continue;
      }
      if (character.charCodeAt(0) < 0x20) fail('Control character в JSON string запрещён.');
      out += character;
    }
    fail('Незавершённая JSON string.');
  };

  const parseNumber = () => {
    const match = NUMBER_RE.exec(text.slice(offset));
    if (!match) fail(`Невалидный JSON number на offset ${offset}.`);
    const raw = match[0];
    const parts = NUMBER_PARTS_RE.exec(raw);
    const digitCount = (parts[2] + (parts[3] ?? '')).length;
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

  const parseValue = (depth = 0) => {
    skipWhitespace();
    consumeValue(depth);
    const character = text[offset];
    if (character === '"') return parseString();
    if (character === '-' || (character >= '0' && character <= '9')) return parseNumber();
    if (text.startsWith('true', offset)) {
      offset += 4;
      return true;
    }
    if (text.startsWith('false', offset)) {
      offset += 5;
      return false;
    }
    if (text.startsWith('null', offset)) {
      offset += 4;
      return null;
    }
    if (character === '[') {
      offset += 1;
      const array = [];
      skipWhitespace();
      if (text[offset] === ']') {
        offset += 1;
        return array;
      }
      while (true) {
        array.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[offset] === ']') {
          offset += 1;
          return array;
        }
        if (text[offset] !== ',') fail(`Ожидалась запятая JSON array на offset ${offset}.`);
        offset += 1;
      }
    }
    if (character === '{') {
      offset += 1;
      const object = Object.create(null);
      skipWhitespace();
      if (text[offset] === '}') {
        offset += 1;
        return object;
      }
      while (true) {
        skipWhitespace();
        const key = parseString();
        if (Object.hasOwn(object, key)) fail(`Duplicate JSON object key ${JSON.stringify(key)}.`);
        skipWhitespace();
        if (text[offset] !== ':') fail(`Ожидалось двоеточие JSON object на offset ${offset}.`);
        offset += 1;
        object[key] = parseValue(depth + 1);
        skipWhitespace();
        if (text[offset] === '}') {
          offset += 1;
          return object;
        }
        if (text[offset] !== ',') fail(`Ожидалась запятая JSON object на offset ${offset}.`);
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

export function exactJsonNumber(value) {
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, NUMBER_TOKEN)) {
    fail('Ожидался exact JSON number token.');
  }
  return value[NUMBER_TOKEN];
}

/** Преобразует JSON number lexeme в canonical non-negative decimal без округления. */
export function decimalFromJsonNumber(value, {
  significantDigits = 120,
  maxScale = 100,
  maxWholeDigits = 120,
} = {}) {
  const raw = exactJsonNumber(value);
  const match = NUMBER_PARTS_RE.exec(raw);
  const [, sign, whole, fraction = '', exponentRaw = '0'] = match;
  if (sign === '-') fail('Expected non-negative JSON number.');
  const exponent = Number(exponentRaw);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > DEFAULT_LIMITS.exponent) {
    fail('JSON number exponent выходит за границы.');
  }

  const combined = `${whole}${fraction}`;
  const leading = combined.match(/^0*/)[0].length;
  let digits = combined.slice(leading);
  if (digits.length === 0) return '0';
  let decimalPosition = whole.length + exponent - leading;

  let encoded;
  if (decimalPosition <= 0) encoded = `0.${'0'.repeat(-decimalPosition)}${digits}`;
  else if (decimalPosition >= digits.length) encoded = `${digits}${'0'.repeat(decimalPosition - digits.length)}`;
  else encoded = `${digits.slice(0, decimalPosition)}.${digits.slice(decimalPosition)}`;
  encoded = encoded.replace(/(?:\.([0-9]*?))0+$/, (_, kept) => kept ? `.${kept}` : '');

  const [encodedWhole, encodedFraction = ''] = encoded.split('.');
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

export function exactUnsignedInteger(value, options) {
  const decimal = decimalFromJsonNumber(value, options);
  if (decimal.includes('.')) fail('Expected exact unsigned integer.');
  return decimal;
}
