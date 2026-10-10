export type QrPayload = {
  v: 1;
  brain: {
    name: string;
    fp: string;
  };
  relay: {
    id: string;
    name: string;
    host: string;
    port: number;
    fp: string;
    token: string;
  };
  pair?: {
    code: string;
    exp: number;
  };
};

/**
 * Канонический base64url не принимает мусор, padding или скрытую повторную кодировку.
 * Проверка одинакова для внешнего QR и 32-байтного токена посредника.
 */
function decode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Код QR повреждён.');
  }

  const bytes = atob(value.replaceAll('-', '+').replaceAll('_', '/'));

  if (btoa(bytes).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '') !== value) {
    throw new Error('Код QR повреждён.');
  }

  return Uint8Array.from(bytes, (character) => character.charCodeAt(0));
}

/**
 * QR проверяется до вызова моста, но native повторяет проверку на собственной границе.
 * Текст ограничен 4096 байтами и не является произвольным URL для WebView.
 */
export function parseQr(source: string): QrPayload {
  try {
    if (!source.startsWith('cockpitlink:1:') || new TextEncoder().encode(source).length > 4096) {
      throw new Error('bad_prefix');
    }

    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(decode(source.slice(14))),
    );
    const { brain, relay, pair } = value;
    const name = (item: unknown) => typeof item === 'string' && item.trim() && item.length <= 200;

    if (
      value.v !== 1 ||
      !name(brain?.name) ||
      !/^[a-f0-9]{64}$/.test(brain?.fp || '') ||
      !name(relay?.id) ||
      !name(relay?.name) ||
      typeof relay?.host !== 'string' ||
      !/^[A-Za-z0-9.:-]{1,253}$/.test(relay.host) ||
      !Number.isInteger(relay.port) ||
      relay.port < 1 ||
      relay.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(relay.fp || '') ||
      typeof relay.token !== 'string' ||
      decode(relay.token).length !== 32 ||
      (pair !== undefined &&
        (!/^[A-Za-z0-9_-]{16,100}$/.test(pair.code) ||
          decode(pair.code).length !== 24 ||
          !Number.isSafeInteger(pair.exp) ||
          pair.exp <= 0))
    ) {
      throw new Error('bad_shape');
    }

    return value as QrPayload;
  } catch {
    throw new Error('Неверный код привязки. Возьмите QR в настройках Кокпита.');
  }
}
