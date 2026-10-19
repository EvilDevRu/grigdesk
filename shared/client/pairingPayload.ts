export interface PairingPayload {
  host: string;
  port: number;
  fp: string;
  code: string;
}

const PREFIX = 'GRIGDESK:PAIR:1:';
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const HOST = /^[a-z0-9.-]{1,253}$/;

export class PairingPayloadError extends Error {
  readonly code: string;

  constructor(code = 'invalid_pairing') {
    super(code === 'unsupported_address' ? 'Этот тип адреса пока не поддерживается.'
      : 'Строка привязки недействительна.');
    this.code = code;
  }
}

/**
 * Кодирует байты алфавитом с длиной символа в целое число бит.
 * Остаток дополняется нулями без знаков padding, как требует формат строки привязки.
 */
function encodeBase(bytes: Uint8Array, alphabet: string, bits: number): string {
  let result = '';
  let value = 0;
  let available = 0;

  for (const byte of bytes) {
    value = (value << 8) | byte;
    available += 8;

    while (available >= bits) {
      available -= bits;
      result += alphabet[(value >>> available) & ((1 << bits) - 1)];
    }

    value &= (1 << available) - 1;
  }

  if (available) {
    result += alphabet[value << (bits - available)];
  }

  return result;
}

/**
 * Допускает только каноническую запись без лишних символов и ненулевых хвостовых битов.
 * Общий механизм нужен base32 конверту и base64url одноразового кода одинаково.
 */
function decodeBase(text: string, alphabet: string, bits: number): Uint8Array {
  const bytes: number[] = [];
  let value = 0;
  let available = 0;

  for (const character of text) {
    const digit = alphabet.indexOf(character);

    if (digit < 0) {
      throw new PairingPayloadError();
    }

    value = (value << bits) | digit;
    available += bits;

    if (available >= 8) {
      available -= 8;
      bytes.push((value >>> available) & 255);
    }

    value &= (1 << available) - 1;
  }

  const result = Uint8Array.from(bytes);

  if (encodeBase(result, alphabet, bits) !== text) {
    throw new PairingPayloadError();
  }

  return result;
}

/**
 * Строка переносит адрес, пин сервера и одноразовый код между оболочками.
 * В браузере и Node используется один формат без платформенных зависимостей.
 */
export function encodePairing(payload: PairingPayload): string {
  if (!HOST.test(payload.host) || !Number.isInteger(payload.port) || payload.port < 1
    || payload.port > 65535 || !/^[a-f0-9]{64}$/.test(payload.fp)
    || !/^[A-Za-z0-9_-]{32}$/.test(payload.code)) {
    throw new PairingPayloadError();
  }

  const parts = payload.host.split('.');
  const ipv4 = parts.length === 4
    && parts.every((part) => String(Number(part)) === part && Number(part) >= 0 && Number(part) <= 255);
  const address = ipv4 ? [4, ...parts.map(Number)]
    : [0x48, payload.host.length, ...Array.from(payload.host, (character) => character.charCodeAt(0))];
  const fp = Array.from({ length: 32 }, (_, index) =>
    parseInt(payload.fp.slice(index * 2, index * 2 + 2), 16));
  const bytes = Uint8Array.from([
    ...address,
    payload.port >>> 8,
    payload.port & 255,
    ...fp,
    ...decodeBase(payload.code, BASE64, 6),
  ]);

  return PREFIX + encodeBase(bytes, BASE32, 5);
}

/**
 * Непроверенный текст не становится сетевым адресом до полной проверки формата.
 * Отдельный код ошибки позволяет оболочке дать понятное сообщение человеку.
 */
export function decodePairing(text: string): PairingPayload {
  if (typeof text !== 'string' || text.length > 1024) {
    throw new PairingPayloadError();
  }

  const normalized = text.trim().toUpperCase();

  if (!normalized.startsWith(PREFIX)) {
    throw new PairingPayloadError();
  }

  const bytes = decodeBase(normalized.slice(PREFIX.length), BASE32, 5);
  let offset = 0;
  let host: string;

  if (bytes[0] === 4) {
    host = Array.from(bytes.slice(1, 5)).join('.');
    offset = 5;
  } else if (bytes[0] === 0x48) {
    const length = bytes[1] ?? 0;

    host = String.fromCharCode(...bytes.slice(2, 2 + length));
    offset = 2 + length;
  } else {
    throw new PairingPayloadError(bytes[0] === 0x06 ? 'unsupported_address' : 'invalid_pairing');
  }

  const port = ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);

  if (!HOST.test(host) || bytes.length !== offset + 58 || port === 0) {
    throw new PairingPayloadError();
  }

  return {
    host,
    port,
    fp: Array.from(bytes.slice(offset + 2, offset + 34), (byte) =>
      byte.toString(16).padStart(2, '0')).join(''),
    code: encodeBase(bytes.slice(offset + 34), BASE64, 6),
  };
}
