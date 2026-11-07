import tls from 'node:tls';
import type { TLSSocket } from 'node:tls';

/**
 * Устанавливает внешний TLS с пином до отправки hello.
 * Переданный числовой IP уже проверен VPN-воротами и повторно не разрешается через DNS.
 */
export function dialRelay(options: {
  ip: string;
  port: number;
  fp: string;
  signal?: AbortSignal;
}): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: options.ip,
      port: options.port,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });
    const timer = setTimeout(() => socket.destroy(new Error('relay_connect_timeout')), 10000);
    const abort = () => socket.destroy(new Error('relay_cancelled'));

    options.signal?.addEventListener('abort', abort, { once: true });
    socket.once('close', () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      clearTimeout(timer);

      const fp = socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase();

      if (fp !== options.fp) {
        socket.destroy(new Error('relay_pin_mismatch'));

        return;
      }

      socket.setNoDelay(true);
      socket.setKeepAlive(true, 30000);
      socket.pause();
      resolve(socket);
    });

    if (options.signal?.aborted) {
      abort();
    }
  });
}

/**
 * Читает ограниченную строку и оставляет coalesced-начало туннеля в сокете.
 * Потребитель выбирает момент resume после постановки новых слушателей.
 */
export function relayLine(socket: TLSSocket, timeoutMs = 60000): Promise<string> {
  return new Promise((resolve, reject) => {
    let saved = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('relay_line_timeout')), timeoutMs);

    /**
     * Снимает все слушатели этой строки, сохраняя остаток без декодирования.
     * Ошибка закрытия не оставляет висящую promise.
     */
    function finish(error: Error | null, line = '', rest: Buffer = Buffer.alloc(0)) {
      clearTimeout(timer);
      socket.pause();
      socket.off('data', receive);
      socket.off('error', failure);
      socket.off('close', closed);

      if (error) {
        reject(error);
      } else {
        if (rest.length) {
          socket.unshift(rest);
        }

        resolve(line);
      }
    }

    function failure(error: Error) {
      finish(error);
    }

    function closed() {
      finish(new Error('relay_closed'));
    }

    /**
     * Ограничивает UTF-8 строку до 2048 байт даже при фрагментированной передаче.
     * Невалидная кодировка отвергается до JSON-разбора.
     */
    function receive(chunk: Buffer) {
      const newline = chunk.indexOf(10);
      const part = newline < 0 ? chunk : chunk.subarray(0, newline);

      if (saved.length + part.length > 2048) {
        finish(new Error('relay_bad_reply'));

        return;
      }

      saved = Buffer.concat([saved, part]);

      if (newline >= 0) {
        try {
          finish(
            null,
            new TextDecoder('utf-8', { fatal: true }).decode(saved),
            chunk.subarray(newline + 1),
          );
        } catch {
          finish(new Error('relay_bad_reply'));
        }
      }
    }

    socket.on('data', receive);
    socket.once('error', failure);
    socket.once('close', closed);
    socket.resume();
  });
}

/**
 * Передаёт hello только по уже проверенному сокету и проверяет ограниченный reply.
 * Неподтверждённое соединение не передаётся локальному мобильному серверу.
 */
export async function relayHello(socket: TLSSocket, hello: object): Promise<{
  ok: true;
  capabilities?: string[];
}> {
  const answer = relayLine(socket, 15000);

  socket.write(`${JSON.stringify(hello)}\n`);

  const result = JSON.parse(await answer) as {
    ok?: unknown;
    error?: unknown;
    capabilities?: unknown;
  };

  if (result.ok !== true) {
    throw new Error('relay_rejected');
  }

  return { ok: true, capabilities: Array.isArray(result.capabilities)
    ? result.capabilities.filter((value): value is string => typeof value === 'string') : [] };
}
