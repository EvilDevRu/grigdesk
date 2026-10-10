import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import tls from 'node:tls';
import type { Socket } from 'node:net';
import type { TLSSocket } from 'node:tls';

import type { RelayConfig } from './config.ts';
import { createIpLimiter } from './limits.ts';
import { createLineReader, encodeReply, parseHello, ProtocolError } from './protocol.ts';

type Pending = {
  socket: TLSSocket;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * Ретранслирует только байты внутреннего TLS, не зная HTTP и содержания сообщений.
 * Учёт начинается с TCP accept, а control-поколение владеет только своими ожиданиями.
 */
export function createRelayServer(config: RelayConfig, { log }: { log: (event: string) => void }) {
  const sockets = new Set<Socket>();
  const handshakes = new Map<string, ReturnType<typeof setTimeout>>();
  const pending = new Map<string, Pending>();
  const limiter = createIpLimiter(config);
  const server = tls.createServer({
    key: config.key,
    cert: config.cert,
    minVersion: 'TLSv1.3',
    handshakeTimeout: config.helloTimeoutMs,
  });
  let control: TLSSocket | null = null;
  let closing = false;

  const sweep = setInterval(() => limiter.sweep(), Math.min(config.banWindowMs, 60000));

  sweep.unref();

  function socketKey(socket: Socket) {
    return `${socket.remoteAddress}:${socket.remotePort}`;
  }

  /**
   * Завершает ошибку одним фиксированным кодом протокола.
   * В журнал не попадает ни адрес, ни строка клиента.
   */
  function fail(socket: TLSSocket, error: string) {
    socket.end(
      encodeReply({
        ok: false,
        error,
      }),
    );

    const timer = setTimeout(() => socket.destroy(), 1000);

    timer.unref();
    socket.once('close', () => clearTimeout(timer));
  }

  /**
   * Снимает ожидание до отправки результата, сохраняя одноразовость id.
   * Поздний brain-data никогда не получает уже закрытую пару.
   */
  function cancelPending(id: string, error?: string) {
    const entry = pending.get(id);

    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    pending.delete(id);

    if (error) {
      fail(entry.socket, error);
    }
  }

  server.on('connection', (socket) => {
    if (closing || sockets.size >= config.maxConnections) {
      socket.destroy();

      return;
    }

    const slot = limiter.acquire(socket.remoteAddress ?? 'unknown');

    if (!slot) {
      socket.destroy();

      return;
    }

    const key = socketKey(socket);
    const timer = setTimeout(() => socket.destroy(), config.helloTimeoutMs);

    handshakes.set(key, timer);
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => {
      clearTimeout(timer);
      handshakes.delete(key);
      sockets.delete(socket);
      slot.release();
    });
  });

  server.on('tlsClientError', () => log('tls_error'));

  server.on('secureConnection', (socket) => {
    clearTimeout(handshakes.get(socketKey(socket)));
    handshakes.delete(socketKey(socket));
    socket.setKeepAlive(true, 30000);
    socket.setNoDelay(true);
    socket.on('error', () => {});

    if (limiter.banned(socket.remoteAddress ?? 'unknown')) {
      fail(socket, 'banned');

      return;
    }

    let phase: 'hello' | 'control' | 'pending' | 'paired' = 'hello';
    const reader = createLineReader();
    const helloTimer = setTimeout(() => socket.destroy(), config.helloTimeoutMs);
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let deadTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Обновляет контроль жизни после каждой допустимой строки control.
     * Таймер принадлежит сокету и снимается при его закрытии.
     */
    function refreshControl() {
      clearTimeout(deadTimer);
      deadTimer = setTimeout(() => socket.destroy(), config.deadMs);
    }

    /**
     * Склеивает потоки после постановки reply первым в обе очереди записи.
     * pipe обеспечивает backpressure без дополнительного неограниченного буфера.
     */
    function pair(device: TLSSocket) {
      phase = 'paired';
      socket.pause();
      device.pause();
      socket.removeAllListeners('data');
      device.removeAllListeners('data');
      socket.write(encodeReply({ ok: true }));
      device.write(encodeReply({ ok: true }));

      const closePair = () => {
        socket.destroy();
        device.destroy();
      };

      socket.once('close', closePair);
      device.once('close', closePair);
      socket.once('error', closePair);
      device.once('error', closePair);
      socket.setTimeout(config.idleMs, closePair);
      device.setTimeout(config.idleMs, closePair);
      socket.pipe(device);
      device.pipe(socket);
      log('paired');
    }

    /**
     * Проверяет роль и токен до изменения control или ожиданий.
     * Неправильный токен учитывается только по метаданным TCP-адреса.
     */
    function acceptHello(line: string) {
      const hello = parseHello(line);

      if (hello.role === 'health') {
        socket.end(encodeReply({ ok: true }));

        return;
      }

      const hash = createHash('sha256').update(hello.token!).digest();
      const expected = hello.role === 'device' ? config.deviceHash : config.brainHash;

      if (!timingSafeEqual(hash, expected)) {
        limiter.failure(socket.remoteAddress ?? 'unknown');
        fail(socket, 'unauthorized');

        return;
      }

      if (hello.role === 'brain-control') {
        const previous = control;

        control = socket;
        previous?.destroy();

        for (const id of pending.keys()) {
          cancelPending(id, 'brain_offline');
        }

        phase = 'control';
        socket.write(encodeReply({ ok: true }));
        refreshControl();
        pingTimer = setInterval(() => socket.write('{"t":"ping"}\n'), config.pingMs);
        log('control_online');

        return;
      }

      if (hello.role === 'device') {
        if (!control || control.destroyed) {
          fail(socket, 'brain_offline');

          return;
        }

        if (pending.size >= config.maxPending) {
          fail(socket, 'busy');

          return;
        }

        phase = 'pending';

        const id = randomBytes(16).toString('hex');
        const timer = setTimeout(() => cancelPending(id, 'brain_timeout'), config.brainTimeoutMs);

        pending.set(id, {
          socket,
          timer,
        });
        socket.once('close', () => cancelPending(id));
        control.write(
          `${JSON.stringify({
            t: 'incoming',
            id,
          })}\n`,
        );

        return;
      }

      const entry = pending.get(hello.id!);

      if (!entry) {
        fail(socket, 'unknown_id');

        return;
      }

      cancelPending(hello.id!);
      pair(entry.socket);
    }

    socket.on('data', (chunk: Buffer) => {
      if (phase === 'pending') {
        fail(socket, 'bad_hello');

        return;
      }

      let rest = chunk;

      try {
        while (rest.length) {
          const result = reader.push(rest);

          if (!result) {
            return;
          }

          rest = result.rest;

          if (phase === 'hello') {
            if (rest.length) {
              throw new ProtocolError('bad_hello');
            }

            clearTimeout(helloTimer);
            acceptHello(result.line);
          } else if (phase === 'control') {
            const message = JSON.parse(result.line) as { t?: unknown } | null;

            if (!message || !['ping', 'pong'].includes(String(message.t))) {
              socket.destroy();

              return;
            }

            refreshControl();

            if (message.t === 'ping') {
              socket.write('{"t":"pong"}\n');
            }
          }
        }
      } catch (error) {
        if (phase === 'hello') {
          fail(socket, error instanceof ProtocolError ? error.code : 'bad_hello');
        } else {
          socket.destroy();
        }
      }
    });

    socket.once('close', () => {
      clearTimeout(helloTimer);
      clearTimeout(deadTimer);
      clearInterval(pingTimer);

      if (control === socket) {
        control = null;

        for (const id of pending.keys()) {
          cancelPending(id, 'brain_offline');
        }

        log('control_offline');
      }
    });
  });

  return {
    listen(host = '0.0.0.0'): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, host, () => {
          server.off('error', reject);
          resolve((server.address() as { port: number }).port);
        });
      });
    },
    /**
     * Shutdown отменяет таймеры и все принадлежащие посреднику сокеты.
     * Незавершённые пары освобождаются до завершения listener.
     */
    async close(): Promise<void> {
      closing = true;
      clearInterval(sweep);

      for (const id of pending.keys()) {
        cancelPending(id);
      }

      for (const socket of sockets) {
        socket.destroy();
      }

      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  };
}
