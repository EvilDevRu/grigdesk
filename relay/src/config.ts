import { createPrivateKey, X509Certificate } from 'node:crypto';

export type RelayConfig = {
  key: string;
  cert: string;
  brainHash: Buffer;
  deviceHash: Buffer;
  port: number;
  helloTimeoutMs: number;
  brainTimeoutMs: number;
  deadMs: number;
  pingMs: number;
  idleMs: number;
  maxConnections: number;
  maxPerIp: number;
  banThreshold: number;
  banWindowMs: number;
  maxPending: number;
  watchdogMs: number;
};

const NUMBERS = {
  port: [7443, 65535],
  helloTimeoutMs: [5000, 60000],
  brainTimeoutMs: [10000, 60000],
  deadMs: [60000, 300000],
  pingMs: [20000, 60000],
  idleMs: [1800000, 7200000],
  maxConnections: [256, 4096],
  maxPerIp: [32, 256],
  banThreshold: [20, 1000],
  banWindowMs: [600000, 3600000],
  maxPending: [32, 256],
  watchdogMs: [10000, 60000],
} as const;

/**
 * Декодирует PEM строго, чтобы ошибка настройки не изменила личность посредника.
 * В текст ошибки попадает только имя переменной, без её содержимого.
 */
function pem(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];

  if (
    !value ||
    value.length > 65536 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`Некорректная настройка ${name}`);
  }

  const decoded = Buffer.from(value, 'base64').toString('utf8');

  try {
    if (name === 'RELAY_TLS_KEY_B64') {
      createPrivateKey(decoded);
    } else {
      new X509Certificate(decoded);
    }
  } catch {
    throw new Error(`Некорректная настройка ${name}`);
  }

  return decoded;
}

/**
 * Проверяет конфигурацию без чтения файлов и запуска сети.
 * Верхние пределы не дают настройкой выключить защиту памяти и соединений.
 */
export function readConfig(env: Record<string, string | undefined>): RelayConfig {
  const key = pem(env, 'RELAY_TLS_KEY_B64');
  const cert = pem(env, 'RELAY_TLS_CERT_B64');
  const hashes: Buffer[] = [];

  for (const name of ['RELAY_BRAIN_TOKEN_SHA256', 'RELAY_DEVICE_TOKEN_SHA256']) {
    const value = env[name];

    if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) {
      throw new Error(`Некорректная настройка ${name}`);
    }

    hashes.push(Buffer.from(value, 'hex'));
  }

  const numbers = {} as Pick<RelayConfig, keyof typeof NUMBERS>;

  for (const [field, [fallback, maximum]] of Object.entries(NUMBERS)) {
    const name = `RELAY_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
    const raw = env[name];
    const value = raw === undefined ? fallback : Number(raw);

    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new Error(`Некорректная настройка ${name}`);
    }

    numbers[field as keyof typeof NUMBERS] = value;
  }

  return {
    key,
    cert,
    brainHash: hashes[0]!,
    deviceHash: hashes[1]!,
    ...numbers,
  };
}
