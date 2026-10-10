import { constants } from 'node:crypto';
import type { Server } from 'node:https';
import type { Duplex } from 'node:stream';
import type { TLSSocket } from 'node:tls';

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';

import { MobileInputError } from './errors.ts';
import { OperationJournal } from './idempotency.ts';
import type { OperationProof, OperationResult } from './idempotency.ts';
import { registerOperationGuard } from './operations.ts';
import type { PairingCodes } from './pairing.ts';
import type { Device, DeviceStore } from './store.ts';

export type MobileApp = FastifyInstance<Server>;

declare module 'fastify' {
  interface FastifyRequest {
    mobileDevice: Device | null;
    mobileFingerprint: string;
  }
}

/**
 * Запускает отдельный HTTPS-вход только на loopback без основного API.
 * Сертификат неизвестного телефона допускает hello/pair, остальные права проверяет HTTP guard.
 */
export async function startMobileServer(options: {
  identity: {
    keyPem: string;
    certPem: string;
  };
  deviceStore: DeviceStore;
  pairing: PairingCodes;
  directory: string;
  port: number;
  serverName?: string;
  version?: string;
  log?: (event: string) => void;
  registerRoutes?: (app: MobileApp) => void | Promise<void>;
  recoverOperation?: (device: string, proof: OperationProof) => Promise<OperationResult | null>;
}) {
  const { deviceStore, pairing } = options;
  const journal = new OperationJournal(options.directory, { recover: options.recoverOperation });
  const sockets = new Set<Duplex>();
  const devices = new Map<string, Set<TLSSocket>>();
  let requestsInWindow = 0;

  const app: MobileApp = Fastify({
    logger: false,
    bodyLimit: 256 * 1024,
    requestTimeout: 60000,
    connectionTimeout: 60000,
    keepAliveTimeout: 30000,
    https: {
      key: options.identity.keyPem,
      cert: options.identity.certPem,
      requestCert: true,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
      handshakeTimeout: 5000,
      secureOptions: constants.SSL_OP_NO_TICKET,
      sessionTimeout: 1,
    },
  });
  const rateWindow = setInterval(() => {
    requestsInWindow = 0;
  }, 60000);

  rateWindow.unref();
  app.decorateRequest('mobileDevice', null);
  app.decorateRequest('mobileFingerprint', '');

  app.server.on('connection', (socket) => {
    if (sockets.size >= 256) {
      socket.destroy();

      return;
    }

    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  app.server.on('newSession', (_id, _data, callback) => callback());
  app.server.on('resumeSession', (_id, callback) => callback(null, null));
  app.server.on('secureConnection', (socket) => {
    const fp =
      socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase() ?? '';
    const own = devices.get(fp) ?? new Set<TLSSocket>();

    if (own.size >= 8) {
      socket.destroy();

      return;
    }

    own.add(socket);
    devices.set(fp, own);
    socket.once('close', () => {
      own.delete(socket);

      if (!own.size) {
        devices.delete(fp);
      }
    });
  });

  app.addHook('onRequest', async (request, reply) => {
    requestsInWindow += 1;

    if (requestsInWindow > 6000) {
      throw new MobileInputError('rate_limited', 'Слишком много запросов. Повторите позже.', 429);
    }

    const socket = request.raw.socket as TLSSocket;
    const fp =
      socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase() ?? '';
    const device = fp ? await deviceStore.findByFp(fp) : null;
    const url = request.url.split('?')[0];

    request.mobileFingerprint = fp;
    request.mobileDevice = device;

    if (device && device.revokedAt !== null) {
      throw new MobileInputError('device_revoked', 'Телефон отозван в кокпите.', 403);
    }

    const publicRequest =
      (request.method === 'GET' && url === '/api/mobile/v1/hello') ||
      (request.method === 'POST' && url === '/api/mobile/v1/pair');

    if (!device && !publicRequest) {
      throw new MobileInputError('device_unknown', 'Телефон ещё не привязан к кокпиту.', 401);
    }

    if (device) {
      await deviceStore.touch(device.id);
    }
  });

  registerOperationGuard(app, {
    journal,
    currentDevice: (fp) => deviceStore.findByFp(fp),
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MobileInputError) {
      return reply.code(error.status).send({
        error: error.code,
        message: error.message,
      });
    }

    const candidate = (error as { statusCode?: number }).statusCode;
    const status = candidate && candidate < 500 ? candidate : 503;

    return reply.code(status).send({
      error: 'mobile_error',
      message: 'Запрос мобильного доступа не выполнен.',
    });
  });

  app.get('/api/mobile/v1/hello', async (request) => ({
    api: 1,
    features: app.hasRoute({ method: 'GET', url: '/api/mobile/v1/chat-options' })
      ? ['chat-controls', 'attention'] : [],
    minApp: '0.1.0',
    serverTime: Date.now(),
    server: {
      name: request.mobileDevice ? (options.serverName ?? 'Кокпит') : 'Кокпит',
      version: options.version ?? '0.1.0',
    },
    device: request.mobileDevice
      ? {
          id: request.mobileDevice.id,
          name: request.mobileDevice.name,
        }
      : null,
  }));
  app.post<{
    Body: {
      code?: unknown;
      name?: unknown;
    };
  }>('/api/mobile/v1/pair', async (request) => {
    if (!request.mobileFingerprint) {
      throw new MobileInputError('no_client_cert', 'Телефон не предъявил сертификат.');
    }

    if (typeof request.body?.code !== 'string' || request.body.code.length > 100) {
      throw new MobileInputError('pair_code_invalid', 'Код привязки недействителен.', 401);
    }

    const device = await pairing.pair(
      request.body.code,
      request.mobileFingerprint,
      request.body.name,
    );

    return {
      device: {
        id: device.id,
        name: device.name,
      },
    };
  });
  app.get<{ Params: { key: string } }>('/api/mobile/v1/operations/:key', (request) =>
    journal.get(request.mobileDevice!.id, request.params.key),
  );

  try {
    await options.registerRoutes?.(app);
    await app.listen({
      host: '127.0.0.1',
      port: options.port,
    });
  } catch (error) {
    clearInterval(rateWindow);
    await app.close();

    throw error;
  }

  return {
    app,
    port: (app.server.address() as { port: number }).port,
    disconnectDevice(fp: string) {
      for (const socket of devices.get(fp) ?? []) {
        socket.destroy();
      }
    },
    async close() {
      clearInterval(rateWindow);

      for (const socket of sockets) {
        socket.destroy();
      }

      await app.close();
    },
  };
}
