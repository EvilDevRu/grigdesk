// Каноническая граница между channel marker и общим Inbox state.
// Marker остаётся server-only, но всё равно считается недоверенными persisted data:
// codec обязан воспроизводить его без aliases, а canonical JSON ограничен 4096 байтами.

export const MAX_ACTIVATION_MARKER_BYTES = 4096;

export class InboxActivationMarkerError extends Error {
  code: string;

  statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = 'InboxActivationMarkerError';
    this.code = 'invalid_activation_marker';
    this.statusCode = 500;
  }
}

// Кодек канала: он переводит свою границу приёма в canonical JSON и обратно.
// Обе стороны обязаны быть синхронными — маркер закрывается внутри одной аренды.
export interface ActivationCodec {
  encode: (marker: unknown) => unknown;
  decode: (persisted: unknown) => unknown;
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (message: string) => never = (message) => {
  throw new InboxActivationMarkerError(message);
};

// Чужая ошибка кодека своего типа не обещает: текст читается мягко, а форма
// маркера всё равно проверяется отдельно.
function failureMessage(error: unknown): string {
  const message = error !== null && typeof error === 'object'
    ? (error as { message?: unknown }).message
    : undefined;

  return typeof message === 'string' && message ? message : String(error);
}

function normalizeJson(value: unknown, where = 'marker'): unknown {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) fail(`${where}: число не является canonical JSON.`);
    return value;
  }
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (keys.length !== value.length || keys.some((key, i) => key !== String(i))) {
      fail(`${where}: sparse array или дополнительные поля запрещены.`);
    }
    return (value as unknown[]).map((item, i) => normalizeJson(item, `${where}[${i}]`));
  }
  if (value === null || typeof value !== 'object') fail(`${where}: значение не является JSON-safe.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${where}: допускается только plain JSON object.`);
  const source = value as Record<string, unknown>;

  return Object.fromEntries(Object.keys(source).sort().map((key) => [
    key,
    normalizeJson(source[key], `${where}.${key}`),
  ]));
}

function canonical(value: unknown): { normalized: unknown; json: string } {
  const normalized = normalizeJson(value);
  const json = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_ACTIVATION_MARKER_BYTES) {
    fail(`Activation marker превышает ${MAX_ACTIVATION_MARKER_BYTES} байт canonical JSON.`);
  }
  return { normalized, json };
}

function assertCodec(codec: unknown): asserts codec is ActivationCodec {
  const value = (codec ?? {}) as Partial<ActivationCodec>;

  if (!codec || typeof value.encode !== 'function' || typeof value.decode !== 'function') {
    fail('activationCodec обязан иметь синхронные encode(marker) и decode(persisted).');
  }
}

function callSync(
  fn: (value: unknown) => unknown,
  value: unknown,
  method: string,
): unknown {
  let result: unknown;
  try {
    result = fn(value);
  } catch (err) {
    if (err instanceof InboxActivationMarkerError) throw err;
    fail(`activationCodec.${method} отклонил marker: ${failureMessage(err)}.`);
  }
  if (result && typeof (result as { then?: unknown }).then === 'function') {
    fail(`activationCodec.${method} обязан быть синхронным.`);
  }
  return result;
}

/** Runtime marker → canonical persisted marker с обязательным decode/re-encode. */
export function encodeActivationMarker(codec: unknown, marker: unknown): unknown {
  assertCodec(codec);
  const encoded = canonical(callSync(codec.encode.bind(codec), marker, 'encode'));
  const decoded = callSync(codec.decode.bind(codec), structuredClone(encoded.normalized), 'decode');
  const repeated = canonical(callSync(codec.encode.bind(codec), decoded, 'encode'));
  if (encoded.json !== repeated.json) fail('Activation marker codec допускает неканонический alias.');
  return encoded.normalized;
}

/** Persisted marker → runtime marker с обязательным re-encode byte equivalence. */
export function decodeActivationMarker(codec: unknown, persisted: unknown): unknown {
  assertCodec(codec);
  const encoded = canonical(persisted);
  const decoded = callSync(codec.decode.bind(codec), structuredClone(encoded.normalized), 'decode');
  const repeated = canonical(callSync(codec.encode.bind(codec), decoded, 'encode'));
  if (encoded.json !== repeated.json) fail('Persisted activation marker имеет неканонический alias.');
  return decoded;
}

/** Простейший codec для каналов, чей marker уже является canonical JSON value. */
export const canonicalJsonActivationCodec = Object.freeze({
  encode(marker: unknown) { return normalizeJson(marker); },
  decode(persisted: unknown) { return normalizeJson(persisted); },
});
