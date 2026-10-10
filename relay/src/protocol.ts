export const ERRORS = {
  badHello: 'bad_hello',
  badVersion: 'bad_version',
  badRole: 'bad_role',
  unauthorized: 'unauthorized',
  brainOffline: 'brain_offline',
  brainTimeout: 'brain_timeout',
  busy: 'busy',
  unknownId: 'unknown_id',
  banned: 'banned',
} as const;

export type Hello = {
  v: 1;
  role: 'brain-control' | 'brain-data' | 'device' | 'health';
  token?: string;
  id?: string;
};

export class ProtocolError extends Error {
  code: string;

  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/**
 * Разбирает только начальную строку протокола v1.
 * Неизвестные роли и неполные данные никогда не переходят к склейке сокетов.
 */
export function parseHello(line: string): Hello {
  let input: unknown;

  try {
    input = JSON.parse(line);
  } catch {
    throw new ProtocolError(ERRORS.badHello);
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ProtocolError(ERRORS.badHello);
  }

  const value = input as Record<string, unknown>;

  if (value.v !== 1) {
    throw new ProtocolError(ERRORS.badVersion);
  }

  if (!['brain-control', 'brain-data', 'device', 'health'].includes(String(value.role))) {
    throw new ProtocolError(ERRORS.badRole);
  }

  if (value.role !== 'health' && (typeof value.token !== 'string' || value.token.length > 512)) {
    throw new ProtocolError(ERRORS.badHello);
  }

  if (
    value.role === 'brain-data' &&
    (typeof value.id !== 'string' || !/^[a-f0-9]{32}$/.test(value.id))
  ) {
    throw new ProtocolError(ERRORS.badHello);
  }

  return value as Hello;
}

/**
 * Собирает одну ограниченную UTF-8 строку и возвращает её непрочитанный хвост.
 * Хвост reply может быть началом TLS; его нельзя декодировать как JSON.
 */
export function createLineReader(maxBytes = 2048) {
  let saved = Buffer.alloc(0);

  return {
    /**
     * Reader накапливает только ограниченную первую строку, даже при дроблении TCP.
     * Байты после newline остаются нетронутыми для следующего TLS-слоя.
     */
    push(chunk: Buffer): {
      line: string;
      rest: Buffer;
    } | null {
      const newline = chunk.indexOf(10);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);

      if (saved.length + part.length > maxBytes) {
        throw new ProtocolError(ERRORS.badHello);
      }

      saved = Buffer.concat([saved, part]);

      if (newline < 0) {
        return null;
      }

      let line: string;

      try {
        line = new TextDecoder('utf-8', { fatal: true }).decode(saved);
      } catch {
        throw new ProtocolError(ERRORS.badHello);
      }

      saved = Buffer.alloc(0);

      return {
        line,
        rest: chunk.subarray(newline + 1),
      };
    },
  };
}

/**
 * Ответ посредника всегда заканчивается newline и имеет фиксированную форму JSON.
 * Телефон получает ровно один ACK до начала пересылки внутреннего TLS.
 */
export function encodeReply(
  reply:
    | { ok: true }
    | {
        ok: false;
        error: string;
      },
): string {
  return `${JSON.stringify(reply)}\n`;
}
