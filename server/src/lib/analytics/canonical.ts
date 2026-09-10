// Каноническая сериализация JSON и SHA-256 для контрактов аналитики.
import { createHash } from 'node:crypto';

const DEFAULT_LIMITS = Object.freeze({
  bytes: 2 * 1024 * 1024,
  depth: 64,
  values: 100_000,
});

export class AnalyticsCanonicalError extends Error {
  readonly code = 'analytics_canonical_invalid';

  constructor(message: string) {
    super(message);
    this.name = 'AnalyticsCanonicalError';
  }
}

/**
 * Отказ сериализации. Объявлен функцией, а не стрелкой в const: только у объявления
 * компилятор считает `never` признаком «дальше кода нет» и сужает по нему тип.
 */
function fail(message: string): never {
  throw new AnalyticsCanonicalError(message);
}

// Что вообще может стать каноническим JSON: без дробных чисел, дат и классов.
// Decimal, счётчики и деньги передаются каноническими СТРОКАМИ — иначе точность
// теряется молча, а хеш перестаёт совпадать между процессами.
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

// Границы разбора: они защищают от чужого раздувшегося ввода, а не от своей ошибки.
export interface CanonicalLimits {
  bytes?: number;
  depth?: number;
  values?: number;
}

interface NormalizeState {
  limits: Required<CanonicalLimits>;
  seen: Set<object>;
  values: number;
}

/** RFC 8785 запрещает непарные суррогаты: такая строка не имеет канонической формы. */
function assertUnicode(value: string, where: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        fail(`${where}: unpaired high surrogate запрещён RFC 8785.`);
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      fail(`${where}: unpaired low surrogate запрещён RFC 8785.`);
    }
  }
}

/**
 * Приводит значение к канонической форме и попутно проверяет его допустимость.
 * Отказ здесь честнее молчаливого приведения: хеш от «почти того же» значения
 * не совпадёт с чужим, и расхождение всплывёт уже в сверке журналов.
 */
function normalize(
  value: unknown,
  state: NormalizeState,
  where: string,
  depth: number,
): CanonicalValue {
  state.values += 1;
  if (state.values > state.limits.values) {
    fail(`Canonical JSON превышает ${state.limits.values} значений.`);
  }
  if (depth > state.limits.depth) {
    fail(`Canonical JSON превышает глубину ${state.limits.depth}.`);
  }

  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertUnicode(value, where);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      fail(`${where}: допускаются только safe integer JSON numbers без -0.`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
      fail(`${where}: sparse array и дополнительные свойства запрещены.`);
    }
    if (state.seen.has(value)) fail(`${where}: циклическая ссылка запрещена.`);
    state.seen.add(value);
    const out = value.map(
      (item: unknown, index: number) => normalize(item, state, `${where}[${index}]`, depth + 1),
    );
    state.seen.delete(value);
    return out;
  }
  if (value === null || typeof value !== 'object') {
    fail(`${where}: значение не является JSON-safe.`);
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    fail(`${where}: допускается только plain JSON object.`);
  }
  if (state.seen.has(value)) fail(`${where}: циклическая ссылка запрещена.`);
  state.seen.add(value);
  const source = value as Record<string, unknown>;
  const out: Record<string, CanonicalValue> = {};

  // Array#sort без comparator использует UTF-16 code units — именно порядок RFC 8785.
  for (const key of Object.keys(source).sort()) {
    assertUnicode(key, `${where} key`);
    out[key] = normalize(source[key], state, `${where}.${key}`, depth + 1);
  }
  state.seen.delete(value);
  return out;
}

/**
 * RFC 8785 для analytics schemas: строки/boolean/null/safe integers/arrays/plain objects.
 * Decimal, monotonic counters и money намеренно передаются canonical strings.
 */
export function canonicalJson(value: unknown, limits: CanonicalLimits = {}): string {
  const normalizedLimits = {
    bytes: limits.bytes ?? DEFAULT_LIMITS.bytes,
    depth: limits.depth ?? DEFAULT_LIMITS.depth,
    values: limits.values ?? DEFAULT_LIMITS.values,
  };
  for (const [key, amount] of Object.entries(normalizedLimits)) {
    if (!Number.isSafeInteger(amount) || amount < 1) fail(`Некорректный limit ${key}.`);
  }
  const normalized = normalize(value, {
    limits: normalizedLimits,
    seen: new Set(),
    values: 0,
  }, '$', 0);
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > normalizedLimits.bytes) {
    fail(`Canonical JSON превышает ${normalizedLimits.bytes} байт.`);
  }
  return json;
}

export function sha256Canonical(value: unknown, limits?: CanonicalLimits): string {
  return createHash('sha256').update(canonicalJson(value, limits), 'utf8').digest('hex');
}

/** eventHash не входит в preimage; завершающий LF добавляется только в segment line. */
export function lifecycleEventHash(event: unknown): string {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    fail('Lifecycle event обязан быть объектом.');
  }
  if (!Object.hasOwn(event, 'eventHash')) fail('Lifecycle event не содержит eventHash.');

  const preimage = { ...(event as Record<string, unknown>) };

  delete preimage.eventHash;

  return sha256Canonical(preimage, { bytes: 64 * 1024 });
}

// Запечатанное событие: его хеш посчитан от него самого без поля хеша.
export type SealedLifecycleEvent = Readonly<Record<string, unknown> & { eventHash: string }>;

/**
 * Проставляет событию его собственный хеш. Поле сначала обнуляется, а не удаляется:
 * состав ключей входит в канонический вид, и удаление дало бы другой хеш.
 */
export function sealLifecycleEvent(event: Record<string, unknown>): SealedLifecycleEvent {
  const sealed = { ...event, eventHash: '' };

  sealed.eventHash = lifecycleEventHash(sealed);

  return Object.freeze(sealed);
}
