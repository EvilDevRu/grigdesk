import { desktopText } from './locale.ts';

export type LocalConnection = {
  kind: 'local';
  origin: string;
};

export type Connection = LocalConnection;

export const DEFAULT_ORIGIN = 'http://127.0.0.1:8140';

const ADDRESS_ERROR = 'desktop.addressError';

type ArgumentOrigin = { origin: string } | { error: string } | null;
type ResolvedConnection = {
  connection: Connection;
  fromArgs: boolean;
} | { error: string };

/**
 * Принимает только явный адрес локального сервера без нормализации лишних частей.
 * Возвращаемый origin нужен для одинаковой границы подключения и разрешений окна.
 */
export function localOrigin(text: unknown): string | null {
  if (typeof text !== 'string' || text.length > 100) {
    return null;
  }

  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(text);

  if (!match || match[0] !== text || Number(match[1]) > 65535) {
    return null;
  }

  return new URL(text).origin;
}

/**
 * Получает эффективный порт из уже проверенного канонического origin.
 * URL скрывает стандартный порт HTTP, поэтому пустой port означает 80.
 */
export function localPort(origin: string): number {
  return Number(new URL(origin).port || 80);
}

/**
 * Ищет ключ подключения во всём argv, включая аргументы запуска Electron в dev.
 * Ошибка явного ключа должна сохраняться независимо от наличия настройки.
 */
export function originFromArgs(argv: readonly string[]): ArgumentOrigin {
  const args = argv.filter((arg) => arg === '--grigdesk-url' || arg.startsWith('--grigdesk-url='));

  if (args.length === 0) {
    return null;
  }

  if (args.length !== 1 || args[0] === '--grigdesk-url') {
    return { error: desktopText(ADDRESS_ERROR) };
  }

  const origin = localOrigin(args[0]?.slice('--grigdesk-url='.length));

  return origin ? { origin } : { error: desktopText(ADDRESS_ERROR) };
}

/**
 * Сохранённое подключение принимает только уже канонический origin.
 * Исключение без явного порта относится исключительно к стандартному HTTP-порту 80.
 */
function savedOrigin(saved: unknown): string | null {
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
    return null;
  }

  const value = saved as Record<string, unknown>;

  if (value.kind !== 'local' || typeof value.origin !== 'string') {
    return null;
  }

  return value.origin === 'http://127.0.0.1' || localOrigin(value.origin) === value.origin
    ? value.origin
    : null;
}

/**
 * Выбирает подключение по приоритету аргумента, установки, сохранённого адреса и default.
 * Неизвестный формат настройки не расширяет локальную границу доверия.
 */
export function resolveConnection(input: {
  argv: readonly string[];
  saved: unknown;
  installed?: string | null;
}): ResolvedConnection {
  const argument = originFromArgs(input.argv);

  if (argument && 'error' in argument) {
    return argument;
  }

  const installed = savedOrigin({
    kind: 'local',
    origin: input.installed,
  });

  return {
    connection: {
      kind: 'local',
      origin: argument?.origin ?? installed ?? savedOrigin(input.saved) ?? DEFAULT_ORIGIN,
    },
    fromArgs: argument !== null,
  };
}
