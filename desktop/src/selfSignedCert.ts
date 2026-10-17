import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

export type DeviceCertificate = {
  key: string;
  cert: string;
};

const DAY_MS = 86_400_000;

/**
 * Длина DER: короткая форма до 127 байт, дальше длинная с числом байтов длины.
 * Другие формы самоподписанному сертификату устройства не нужны.
 */
function derLength(size: number): Buffer {
  if (size < 0x80) {
    return Buffer.from([size]);
  }

  const bytes: number[] = [];

  for (let rest = size; rest > 0; rest >>= 8) {
    bytes.unshift(rest & 0xff);
  }

  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}

function sequence(...items: Buffer[]): Buffer {
  return tlv(0x30, Buffer.concat(items));
}

function set(...items: Buffer[]): Buffer {
  return tlv(0x31, Buffer.concat(items));
}

/**
 * OID по X.690: первые две дуги в одном байте, остальные — base-128.
 * У каждого байта дуги, кроме последнего, поднят старший бит.
 */
function objectId(text: string): Buffer {
  const parts = text.split('.').map(Number);
  const bytes = [40 * parts[0]! + parts[1]!];

  for (const part of parts.slice(2)) {
    const chunk: number[] = [];

    for (let rest = part; ; rest = Math.floor(rest / 128)) {
      chunk.unshift((rest & 0x7f) | (chunk.length ? 0x80 : 0));

      if (rest < 128) {
        break;
      }
    }

    bytes.push(...chunk);
  }

  return tlv(0x06, Buffer.from(bytes));
}

/**
 * INTEGER без лишних нулей впереди. Ведущий ноль добавляется, когда старший бит
 * поднят: иначе DER прочитает число отрицательным.
 */
function positiveInteger(value: Buffer): Buffer {
  let bytes = value;

  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1]! & 0x80)) {
    bytes = bytes.subarray(1);
  }

  if (bytes[0]! & 0x80) {
    bytes = Buffer.concat([Buffer.from([0]), bytes]);
  }

  return tlv(0x02, bytes);
}

// UTCTime годен до 2049 года; сертификат на 10 лет от 2026 года в него укладывается.
function utcTime(date: Date): Buffer {
  return tlv(0x17, Buffer.from(date.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
}

function commonName(text: string): Buffer {
  return sequence(set(sequence(objectId('2.5.4.3'), tlv(0x0c, Buffer.from(text, 'utf8')))));
}

/**
 * Самоподписанный сертификат устройства: EC P-256, ECDSA-SHA256, CN — имя устройства.
 * Мобильный вход узнаёт устройство по отпечатку, поэтому цепочка и расширения не нужны.
 */
export function selfSignedCertificate(
  name: string,
  now = new Date(),
  days = 3650,
): DeviceCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const serial = randomBytes(16);
  const algorithm = sequence(objectId('1.2.840.10045.4.3.2'));

  serial[0] = serial[0]! & 0x7f;

  const tbs = sequence(
    tlv(0xa0, positiveInteger(Buffer.from([2]))),
    positiveInteger(serial),
    algorithm,
    commonName(name),
    sequence(
      utcTime(new Date(now.getTime() - 60_000)),
      utcTime(new Date(now.getTime() + days * DAY_MS)),
    ),
    commonName(name),
    publicKey.export({
      type: 'spki',
      format: 'der',
    }),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body = der.toString('base64').match(/.{1,64}/g)!.join('\n');

  return {
    key: String(
      privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    ),
    cert: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
  };
}
