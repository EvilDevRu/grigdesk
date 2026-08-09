// Каноническая граница между channel marker и общим Inbox state.
// Marker остаётся server-only, но всё равно считается недоверенными persisted data:
// codec обязан воспроизводить его без aliases, а canonical JSON ограничен 4096 байтами.

export const MAX_ACTIVATION_MARKER_BYTES = 4096;

export class InboxActivationMarkerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InboxActivationMarkerError';
    this.code = 'invalid_activation_marker';
    this.statusCode = 500;
  }
}

const fail = (message) => {
  throw new InboxActivationMarkerError(message);
};

function normalizeJson(value, where = 'marker') {
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
    return value.map((item, i) => normalizeJson(item, `${where}[${i}]`));
  }
  if (value === null || typeof value !== 'object') fail(`${where}: значение не является JSON-safe.`);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) fail(`${where}: допускается только plain JSON object.`);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [
    key,
    normalizeJson(value[key], `${where}.${key}`),
  ]));
}

function canonical(value) {
  const normalized = normalizeJson(value);
  const json = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MAX_ACTIVATION_MARKER_BYTES) {
    fail(`Activation marker превышает ${MAX_ACTIVATION_MARKER_BYTES} байт canonical JSON.`);
  }
  return { normalized, json };
}

function assertCodec(codec) {
  if (!codec || typeof codec.encode !== 'function' || typeof codec.decode !== 'function') {
    fail('activationCodec обязан иметь синхронные encode(marker) и decode(persisted).');
  }
}

function callSync(fn, value, method) {
  let result;
  try {
    result = fn(value);
  } catch (err) {
    if (err instanceof InboxActivationMarkerError) throw err;
    fail(`activationCodec.${method} отклонил marker: ${err?.message || String(err)}.`);
  }
  if (result && typeof result.then === 'function') {
    fail(`activationCodec.${method} обязан быть синхронным.`);
  }
  return result;
}

/** Runtime marker → canonical persisted marker с обязательным decode/re-encode. */
export function encodeActivationMarker(codec, marker) {
  assertCodec(codec);
  const encoded = canonical(callSync(codec.encode.bind(codec), marker, 'encode'));
  const decoded = callSync(codec.decode.bind(codec), structuredClone(encoded.normalized), 'decode');
  const repeated = canonical(callSync(codec.encode.bind(codec), decoded, 'encode'));
  if (encoded.json !== repeated.json) fail('Activation marker codec допускает неканонический alias.');
  return encoded.normalized;
}

/** Persisted marker → runtime marker с обязательным re-encode byte equivalence. */
export function decodeActivationMarker(codec, persisted) {
  assertCodec(codec);
  const encoded = canonical(persisted);
  const decoded = callSync(codec.decode.bind(codec), structuredClone(encoded.normalized), 'decode');
  const repeated = canonical(callSync(codec.encode.bind(codec), decoded, 'encode'));
  if (encoded.json !== repeated.json) fail('Persisted activation marker имеет неканонический alias.');
  return decoded;
}

/** Простейший codec для каналов, чей marker уже является canonical JSON value. */
export const canonicalJsonActivationCodec = Object.freeze({
  encode(marker) { return normalizeJson(marker); },
  decode(persisted) { return normalizeJson(persisted); },
});
