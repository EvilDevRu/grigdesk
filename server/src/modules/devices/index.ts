import type { FastifyInstance } from 'fastify';
import qrcode from 'qrcode-generator';

import { API_VERSION } from '../../../../shared/client/apiVersion.ts';
import { encodePairing } from '../../../../shared/client/pairingPayload.ts';
import { readClientConfig } from '../../lib/clientAccess/config.ts';
import type { PhoneAccessOptions } from '../../lib/clientAccess/phoneAccess.ts';
import { registerPhoneAccess } from './phoneAccess.ts';
import type { ClientListener } from '../../lib/clientAccess/listener.ts';
import { markRevoked } from '../../lib/clientAccess/principal.ts';
import { deviceName, MobileInputError } from '../../lib/mobile/errors.ts';
import type { PairingCodes } from '../../lib/mobile/pairing.ts';
import type { DeviceStore } from '../../lib/mobile/store.ts';

export interface DevicesOptions {
  access?: PhoneAccessOptions;
  devices: DeviceStore;
  pairing: PairingCodes;
  listener: () => ClientListener | null;
  identity: () => { fp: string } | Promise<{ fp: string }>;
  address: string | null;
  name: string;
  disconnectMobile: (fp: string) => void;
}

/**
 * Управление привязками принадлежит действующей сессии человека, включая устройство.
 * Отдельные CLI/internal-токены не дают права выпускать и отзывать сертификаты.
 */
export default async function devicesModule(app: FastifyInstance, options: DevicesOptions): Promise<void> {
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');

    if (request.authKind !== 'session') {
      return reply.code(403).send({ error: 'session_required' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof MobileInputError) {
      return reply.code(error.status).send({ error: error.code, message: error.message });
    }

    const candidate = error as { statusCode?: number };

    if (candidate.statusCode && candidate.statusCode >= 400 && candidate.statusCode < 500) {
      return reply.send(error);
    }

    return reply.code(503).send({ error: 'client_unavailable', message: 'Доступ устройств недоступен.' });
  });
  registerPhoneAccess(app, options);
  app.get('/api/client/hello', async (request) => {
    const device = request.authPrincipal?.kind === 'device'
      ? (await options.devices.list()).find((item) => item.id === request.authPrincipal?.deviceId) : null;

    if (device) {
      options.pairing.confirmPhone(device.id);
    }

    return {
      product: 'grigdesk',
      name: options.name,
      fp: (await options.identity()).fp,
      api: API_VERSION,
      device: device ? { id: device.id, name: device.name } : null,
    };
  });
  app.get('/api/devices', async (request) => ({
    currentDeviceId: request.authPrincipal?.kind === 'device' ? request.authPrincipal.deviceId : null,
    listener: {
      ...(options.listener()?.state() ?? {
        state: 'disabled',
        addresses: [],
        error: null,
      }),
      address: options.address,
    },
    devices: (await options.devices.list()).map((device) => ({
      id: device.id,
      name: device.name,
      scope: device.scope,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      revokedAt: device.revokedAt,
    })),
  }));
  app.post<{ Body: { name?: unknown; address?: unknown } }>('/api/devices/pairing', async (request) => {
    const state = options.listener()?.state();

    if (state?.state !== 'online') {
      throw new MobileInputError('client_listener_off',
        'Откройте «Доступ к серверу» и включите прямой доступ.', 409);
    }

    const candidates = state.addresses.filter((address) => !address.startsWith('0.0.0.0:'));
    const address = request.body?.address ?? options.address
      ?? (candidates.length === 1 ? candidates[0] : null);

    if (!address) {
      throw new MobileInputError('client_address_unknown', 'Укажите адрес машины для привязки.', 409);
    }

    const parsed = typeof address === 'string'
      ? readClientConfig({ GRIGDESK_CLIENT_ADDRESS: address }) : null;

    if (!parsed?.address || parsed.state === 'error') {
      throw new MobileInputError('bad_client_address', 'Укажите имя или IPv4 и порт 1–65535.');
    }

    const [host, port] = parsed.address.split(':');
    const identity = await options.identity();
    const issued = options.pairing.issue({ scope: 'client', name: deviceName(request.body?.name) });
    const text = encodePairing({
      host: host!,
      port: Number(port),
      fp: identity.fp,
      code: issued.code,
    });
    const qr = qrcode(0, 'M');

    qr.addData(text, 'Alphanumeric');
    qr.make();

    const size = qr.getModuleCount();
    const rows = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
      qr.isDark(y, x) ? '1' : '0').join(''));

    return {
      text,
      expiresAt: issued.exp,
      expiresInMs: 600000,
      address: parsed.address,
      qr: { size, rows },
      svg: qr.createSvgTag(4, 4),
    };
  });
  app.post<{ Params: { id: string } }>('/api/devices/:id/revoke', async (request) => {
    const device = await options.devices.revoke(request.params.id);

    markRevoked(device.fp);
    options.listener()?.disconnect(device.fp);
    options.disconnectMobile(device.fp);

    return { ok: true };
  });
}
