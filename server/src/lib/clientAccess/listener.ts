import { constants } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo, Socket } from 'node:net';
import tls from 'node:tls';

import type { FastifyInstance } from 'fastify';

import { API_VERSION } from '../../../../shared/client/apiVersion.ts';
import type { DeviceStore } from '../mobile/store.ts';
import type { ClientListenAddress } from './config.ts';
import { bindDevice, markRevoked } from './principal.ts';

export interface ClientListenerState {
  state: 'disabled' | 'online' | 'error';
  addresses: string[];
  error: string | null;
}

export interface ClientListener {
  state(): ClientListenerState;
  disconnect(fp: string): void;
  close(): Promise<void>;
}

interface ListenerOptions {
  addresses: ClientListenAddress[];
  identity: { keyPem: string; certPem: string } | null;
  devices: DeviceStore;
  app: FastifyInstance;
  bootstrap: FastifyInstance;
  error?: string | null;
  log?: { warn(fields: Record<string, unknown>, message: string): void };
}

/**
 * Отказ происходит до передачи HTTP-приложению, поэтому ответ формируется самим входом.
 * Заголовок версии сохраняется и здесь, чтобы труба могла проверить совместимость.
 */
function denySocket(socket: tls.TLSSocket, error: string): void {
  const body = JSON.stringify({ error });

  const deadline = setTimeout(() => socket.destroy(), 1000);

  deadline.unref();
  socket.once('close', () => clearTimeout(deadline));
  socket.end([
    'HTTP/1.1 403 Forbidden',
    'Connection: close',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(body)}`,
    `X-GrigDesk-Api: ${API_VERSION.major}.${API_VERSION.minor}`,
    '',
    body,
  ].join('\r\n'));
}

/**
 * Отдельный TLS-вход передаёт расшифрованные соединения готовым HTTP-приложениям.
 * Сокеты принадлежат входу и закрываются им даже после передачи основному Fastify.
 */
export async function startClientListener(options: ListenerOptions): Promise<ClientListener> {
  const servers: tls.Server[] = [];
  const sockets = new Set<Socket>();
  const unpairedSockets = new Set<tls.TLSSocket>();
  const deviceSockets = new Map<string, Set<tls.TLSSocket>>();
  const addresses: string[] = [];
  const handshakes = new Map<string, Set<number>>();
  let state: ClientListenerState['state'] = options.error ? 'error' : 'disabled';
  let error = options.error ?? null;

  /**
   * Сертификат проверяется по durable реестру до передачи сокета основному API.
   * Пока идёт чтение, сокет приостановлен, чтобы первые HTTP-байты не потерялись.
   */
  async function routeSocket(socket: tls.TLSSocket): Promise<void> {
    socket.pause();

    const fp = socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase() ?? '';
    const device = fp ? await options.devices.findByFp(fp) : null;

    if (socket.destroyed) {
      return;
    }

    if (device && (device.scope !== 'client' || device.revokedAt !== null)) {
      denySocket(socket, device.revokedAt !== null ? 'device_revoked' : 'device_scope_forbidden');

      return;
    }

    if (fp) {
      const own = deviceSockets.get(fp) ?? new Set<tls.TLSSocket>();

      if (own.size >= 24) {
        denySocket(socket, 'connection_limit');

        return;
      }

      own.add(socket);
      deviceSockets.set(fp, own);
      socket.once('close', () => {
        own.delete(socket);

        if (!own.size) {
          deviceSockets.delete(fp);
        }
      });
    }

    if (device?.scope === 'client' && device.revokedAt === null) {
      bindDevice(socket, {
        deviceId: device.id,
        fp,
      });
      void options.devices.touch(device.id).catch(() => {
        options.log?.warn({ event: 'client_last_seen_failed' },
          'Не удалось сохранить время входа устройства.');
      });
      options.app.server.emit('connection', socket);
    } else {
      if (unpairedSockets.size >= 16) {
        denySocket(socket, 'connection_limit');

        return;
      }

      unpairedSockets.add(socket);

      const deadline = setTimeout(() => socket.destroy(), 10000);
      const idle = () => socket.destroy();

      deadline.unref();
      socket.setTimeout(3000, idle);
      socket.once('close', () => {
        clearTimeout(deadline);
        unpairedSockets.delete(socket);
      });
      options.bootstrap.server.emit('connection', socket);
      socket.setTimeout(3000);
    }

    socket.resume();
  }

  /**
   * Один неверный bind откатывает все сокеты этого входа, сохраняя основной HTTP-сервер.
   * Та же очистка применяется при обычном shutdown и безопасна при повторном вызове.
   */
  async function close(): Promise<void> {
    for (const socket of sockets) {
      socket.destroy();
    }

    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    servers.length = 0;
    addresses.length = 0;

    if (state !== 'error') {
      state = 'disabled';
    }
  }

  /**
   * Каждый адрес получает отдельный TLS-сервер, но общий реестр соединений.
   * Сертификаты собеседников требуют полного рукопожатия, поэтому сессии не возобновляются.
   */
  async function listen(address: ClientListenAddress): Promise<void> {
    if (!options.identity) {
      throw new Error('identity_unavailable');
    }

    const server = tls.createServer({
      key: options.identity.keyPem,
      cert: options.identity.certPem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      handshakeTimeout: 5000,
      secureOptions: constants.SSL_OP_NO_TICKET,
      sessionTimeout: 1,
    }, (socket) => {
      handshakes.get(socket.remoteAddress || '')?.delete(socket.remotePort || 0);
      void routeSocket(socket).catch(() => socket.destroy());
    });

    servers.push(server);
    server.on('tlsClientError', (_error, socket) => socket.destroy());
    server.on('connection', (socket) => {
      const ip = socket.remoteAddress || '';
      const port = socket.remotePort || 0;
      const pending = handshakes.get(ip) ?? new Set<number>();

      if (sockets.size >= 256 || pending.size >= 16) {
        socket.destroy();

        return;
      }

      sockets.add(socket);
      pending.add(port);
      handshakes.set(ip, pending);
      socket.on('error', () => {});
      socket.once('close', () => {
        sockets.delete(socket);
        pending.delete(port);

        if (!pending.size && handshakes.get(ip) === pending) {
          handshakes.delete(ip);
        }
      });
    });
    server.on('newSession', (_id, _data, callback) => callback());
    server.on('resumeSession', (_id, callback) => callback(null, null));
    server.listen(address.port, address.host);
    await once(server, 'listening');

    const bound = server.address() as AddressInfo;

    addresses.push(`${bound.address}:${bound.port}`);
  }

  if (!error) {
    try {
      if (options.addresses.length) {
        await options.devices.list();
      }

      for (const address of options.addresses) {
        await listen(address);
      }

      state = addresses.length ? 'online' : 'disabled';
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException).code ?? 'client_start_failed';

      state = 'error';
      error = `Клиентский вход не запущен (${code}).`;
      await close();
      options.log?.warn({ event: 'client_start_failed', code }, error);
    }
  }

  return {
    state: () => ({
      state,
      addresses: [...addresses],
      error,
    }),
    disconnect(fp) {
      markRevoked(fp);

      for (const socket of deviceSockets.get(fp) ?? []) {
        socket.destroy();
      }
    },
    close,
  };
}
