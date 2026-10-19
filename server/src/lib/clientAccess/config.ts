import { isIP } from 'node:net';

export interface ClientListenAddress {
  host: string;
  port: number;
}

export interface ClientConfig {
  state: 'disabled' | 'configured' | 'error';
  addresses: ClientListenAddress[];
  address: string | null;
  reason: string | null;
}

/**
 * Ошибка отдельного клиентского входа не должна запрещать запуск основного сервера.
 * Возвращаем диагностическое состояние вместо исключения при неверных переменных машины.
 */
export function readClientConfig(env: Record<string, string | undefined> = process.env): ClientConfig {
  try {
    const listen = (env.GRIGDESK_CLIENT_LISTEN ?? '').trim();
    const addressText = (env.GRIGDESK_CLIENT_ADDRESS ?? '').trim();
    const address = addressText ? parseAddress(addressText, false) : null;
    const addresses = listen ? listen.split(',').map((item) => parseAddress(item.trim(), true)) : [];

    return {
      state: addresses.length ? 'configured' : 'disabled',
      addresses,
      address: address ? `${address.host}:${address.port}` : null,
      reason: null,
    };
  } catch (error) {
    return {
      state: 'error',
      addresses: [],
      address: null,
      reason: (error as Error).message,
    };
  }
}

/**
 * Listen принимает только IPv4, а публикуемый адрес допускает также имя машины.
 * В ошибку попадает имя настройки без её значения, чтобы не раскрывать адрес в журнале.
 */
function parseAddress(value: string, listening: boolean): ClientListenAddress {
  const match = /^([a-z0-9.-]{1,253}):(\d+)$/.exec(value);
  const host = match?.[1] ?? '';
  const port = Number(match?.[2]);

  if (!match || (listening && isIP(host) !== 4) || port < 1 || port > 65535) {
    const setting = listening ? 'GRIGDESK_CLIENT_LISTEN' : 'GRIGDESK_CLIENT_ADDRESS';

    throw new Error(`${setting}: укажите ${listening ? 'IPv4' : 'имя или IPv4'} и порт 1–65535.`);
  }

  return { host, port };
}
