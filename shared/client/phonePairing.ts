import { PairingPayloadError } from './pairingPayload.ts';

export interface PhoneAddress {
  host: string;
  port: number;
}

export interface PhoneRelay extends PhoneAddress {
  id: string;
  name: string;
  fp: string;
  token: string;
  protocol: 2;
}

export interface PhonePairing {
  v: 2;
  server: { name: string; fp: string };
  direct: PhoneAddress[];
  pair: { code: string; exp: number };
  relay?: PhoneRelay;
}

const PREFIX = 'GRIGDESK:PHONE:2:';

/**
 * Телефон получает только конкретный IPv4 либо DNS без URL и встроенных секретов.
 * Loopback и wildcard относятся к компьютеру телефона и не являются адресом сервера.
 */
export function validPhoneHost(host: unknown): host is string {
  if (typeof host !== 'string' || !/^[a-z0-9.-]{1,253}$/.test(host)
    || host === 'localhost' || host.endsWith('.localhost')) {
    return false;
  }

  if (/^[0-9.]+$/.test(host)) {
    const parts = host.split('.');
    const first = Number(parts[0]);

    return parts.length === 4 && parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part)
      && Number(part) <= 255) && first > 0 && first !== 127 && first < 224;
  }

  return host.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
}

/**
 * Канонический base64url отвергает padding и ненулевые хвостовые биты.
 * Реализация работает одинаково в Node и в браузере без платформенного Buffer.
 */
function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * Декодирование проверяет также каноничность хвоста, а не только допустимый алфавит.
 * Повреждённый код никогда не нормализуется в другой действующий секрет.
 */
function unbase64(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new PairingPayloadError();
  }

  const bytes = Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));

  if (base64(bytes) !== text) {
    throw new PairingPayloadError();
  }

  return bytes;
}

// RegExp.test приводит массив к строке, поэтому тип pin проверяется явно.
function pin(value: unknown): boolean {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

function address(value: PhoneAddress): boolean {
  return !!value && validPhoneHost(value.host) && Number.isInteger(value.port)
    && value.port > 0 && value.port <= 65535;
}

/**
 * Новый конверт имеет собственную версию и не меняет формат настольных клиентов.
 * Валидация выполняется полностью до любого сетевого обращения оболочки.
 */
function validate(value: PhonePairing): void {
  if (!value || value.v !== 2 || !value.server || typeof value.server.name !== 'string'
    || !value.server.name.trim() || !pin(value.server.fp)
    || !Array.isArray(value.direct) || value.direct.length > 8 || !value.direct.every(address)
    || (!value.direct.length && !value.relay) || !value.pair
    || typeof value.pair.exp !== 'number' || !Number.isFinite(value.pair.exp)
    || typeof value.pair.code !== 'string' || unbase64(value.pair.code).length !== 24) {
    throw new PairingPayloadError();
  }

  const relay = value.relay;

  if (relay && (!address(relay) || typeof relay.id !== 'string' || !relay.id
    || typeof relay.name !== 'string' || !relay.name || relay.protocol !== 2
    || !pin(relay.fp) || typeof relay.token !== 'string'
    || unbase64(relay.token).length !== 32)) {
    throw new PairingPayloadError();
  }
}

/**
 * Выдача сохраняет порядок полей JSON для общих векторов TS и Android.
 * Ограничение относится к полной строке, которую должен вместить сканер и QR.
 */
export function encodePhonePairing(value: PhonePairing): string {
  validate(value);

  const text = PREFIX + base64(new TextEncoder().encode(JSON.stringify(value)));

  if (text.length > 4096) {
    throw new PairingPayloadError('qr_too_large');
  }

  return text;
}

/**
 * Разбор принимает только отдельный телефонный префикс и строгий UTF-8.
 * Исходный текст и его секреты не включаются в диагностическое исключение.
 */
export function decodePhonePairing(text: string): PhonePairing {
  try {
    if (typeof text !== 'string' || text.length > 4096 || !text.startsWith(PREFIX)) {
      throw new PairingPayloadError();
    }

    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true })
      .decode(unbase64(text.slice(PREFIX.length)))) as PhonePairing;

    validate(value);

    return value;
  } catch {
    throw new PairingPayloadError();
  }
}
