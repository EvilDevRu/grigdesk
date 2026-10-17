// Telegram activation boundary: local serialized ingestion seq + provider time.

import { isPlainRecord } from '../../../../shared/lib/objects.ts';

type Payload = Record<string, unknown>;

// Граница приёма канала. `afterSeq` — локальная сериализованная позиция архива,
// `afterOccurredAt` — время провайдера: секундного разрешения Bot API мало, и
// одной только даты для однозначной границы не хватает.
export interface TelegramActivationMarker {
  schema: 1;
  afterSeq: number;
  afterOccurredAt: number;
}

export interface TelegramActivationWindow {
  epoch: number;
  startMarker: TelegramActivationMarker;
  endMarker: TelegramActivationMarker | null;
}

export class TelegramActivationError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'TelegramActivationError';
    this.code = code;
  }
}

// Явная аннотация типа обязательна: без неё TypeScript не считает вызов обрывом
// потока, и после проверки значение остаётся прежним.
const fail: (code: string, message: string) => never = (code, message) => {
  throw new TelegramActivationError(code, message);
};

function exact(value: unknown, keys: string[], where: string): void {
  if (!isPlainRecord(value)) fail('telegram_activation_invalid', `${where}: ожидался объект.`);

  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail('telegram_activation_invalid', `${where}: поля не совпадают с activation schema v1.`);
  }
}

function nonNegative(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail('telegram_activation_invalid', `${where}: ожидалось неотрицательное целое.`);
  }

  return value as number;
}

function marker(source: unknown, where: string): TelegramActivationMarker {
  exact(source, ['schema', 'afterSeq', 'afterOccurredAt'], where);

  const value = source as Payload;

  if (value.schema !== 1) {
    fail('telegram_activation_invalid', `${where}: поддерживается только schema 1.`);
  }

  return {
    schema: 1,
    afterSeq: nonNegative(value.afterSeq, `${where}.afterSeq`),
    afterOccurredAt: nonNegative(value.afterOccurredAt, `${where}.afterOccurredAt`),
  };
}

export const telegramActivationCodec = Object.freeze({
  encode(value: unknown) { return marker(value, 'Telegram marker'); },
  decode(value: unknown) { return marker(value, 'Telegram marker'); },
});

/** `occurredAt` можно дать из reconciled provider cursor; default — server now. */
export function telegramActivationMarker({
  afterSeq,
  occurredAt = null,
  nowMs = Date.now(),
}: {
  afterSeq?: unknown;
  occurredAt?: number | null;
  nowMs?: number;
} = {}): TelegramActivationMarker {
  nonNegative(nowMs, 'nowMs');
  const providerBoundary = occurredAt === null
    ? Math.floor(nowMs / 1000)
    : nonNegative(occurredAt, 'occurredAt');
  return telegramActivationCodec.encode({
    schema: 1,
    afterSeq: nonNegative(afterSeq, 'afterSeq'),
    afterOccurredAt: providerBoundary,
  });
}

export function validateTelegramActivationWindows(windows: unknown): TelegramActivationWindow[] {
  if (!Array.isArray(windows)) {
    fail('telegram_activation_invalid', 'activationWindows должен быть массивом.');
  }

  let previousEnd: TelegramActivationMarker | null | undefined;

  return (windows as Payload[]).map((window, index) => {
    exact(window, ['epoch', 'startMarker', 'endMarker'], `activationWindows[${index}]`);
    if (!Number.isSafeInteger(window.epoch) || window.epoch !== index + 1) {
      fail('telegram_activation_invalid', `activationWindows[${index}].epoch идёт не с 1 без дыр.`);
    }
    if (index > 0 && previousEnd === null) {
      fail('telegram_activation_invalid', 'После открытой activation epoch не может быть следующей.');
    }
    const startMarker = telegramActivationCodec.decode(window.startMarker);
    const endMarker = window.endMarker === null
      ? null
      : telegramActivationCodec.decode(window.endMarker);
    if (endMarker && (endMarker.afterSeq < startMarker.afterSeq
      || endMarker.afterOccurredAt < startMarker.afterOccurredAt)) {
      fail('telegram_activation_invalid', `activationWindows[${index}] имеет обратную границу.`);
    }
    if (index > 0 && previousEnd && (startMarker.afterSeq < previousEnd.afterSeq
      || startMarker.afterOccurredAt < previousEnd.afterOccurredAt)) {
      fail('telegram_activation_invalid', `activationWindows[${index}] пересекается с предыдущей.`);
    }
    previousEnd = endMarker;

    return { epoch: window.epoch as number, startMarker, endMarker };
  });
}

/** Строки архива без Inbox sequence всегда остаются history. */
export function telegramActivationEpochFor(
  position: unknown,
  activationWindows: unknown,
): number | null {
  const windows = validateTelegramActivationWindows(activationWindows);

  if (!isPlainRecord(position)) {
    fail('telegram_activation_invalid', 'Telegram archive position не является объектом.');
  }
  if (position.seq === null || position.seq === undefined) return null;

  const seq = nonNegative(position.seq, 'position.seq');
  const occurredAt = nonNegative(position.occurredAt, 'position.occurredAt');
  let matched: number | null = null;
  for (const window of windows) {
    // seq сериализован с marker и однозначно определяет сторону local boundary.
    // Bot API date имеет разрешение в секунду: strict `occurredAt > marker`
    // навсегда потерял бы сообщение, append которого случился после marker, но в
    // ту же секунду. Provider time остаётся дополнительным lower/upper guard
    // против late delivery; exact seq boundary по-прежнему является history.
    const afterStart = seq > window.startMarker.afterSeq
      && occurredAt >= window.startMarker.afterOccurredAt;
    const throughEnd = window.endMarker === null || (
      seq <= window.endMarker.afterSeq
      && occurredAt <= window.endMarker.afterOccurredAt
    );
    if (!afterStart || !throughEnd) continue;
    if (matched !== null) {
      fail('telegram_activation_ambiguous', 'Telegram message попало в несколько activation epochs.');
    }
    matched = window.epoch;
  }
  return matched;
}

export function telegramActivationBounds(activationWindows: unknown) {
  const windows = validateTelegramActivationWindows(activationWindows);

  if (windows.length === 0) return null;

  return {
    windows,
    afterSeq: Math.min(...windows.map((window) => window.startMarker.afterSeq)),
    throughSeq: windows.some((window) => window.endMarker === null)
      ? null
      : Math.max(...windows.map((window) => Number(window.endMarker?.afterSeq))),
  };
}
