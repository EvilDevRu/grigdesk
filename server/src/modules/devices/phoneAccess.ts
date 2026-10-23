import type { FastifyInstance } from 'fastify';
import qrcode from 'qrcode-generator';

import type { PhoneAddress, PhonePairing } from '../../../../shared/client/phonePairing.ts';
import { encodePhonePairing } from '../../../../shared/client/phonePairing.ts';
import { PairingPayloadError } from '../../../../shared/client/pairingPayload.ts';
import { phoneRelayStatus } from '../../lib/clientAccess/phoneRelay.ts';
import { createPhoneAccess } from '../../lib/clientAccess/phoneAccess.ts';
import { deviceName, MobileInputError } from '../../lib/mobile/errors.ts';
import type { DevicesOptions } from './index.ts';

/**
 * Все телефонные операции наследуют session-only guard модуля устройств.
 * Единственный секретный ответ выдачи помечен no-store тем же общим hook.
 */
export function registerPhoneAccess(app: FastifyInstance, options: DevicesOptions) {
  if (!options.access) {
    return;
  }

  const owner = createPhoneAccess(options.access, async () => {
    const identity = await options.identity();

    return identity as {
      fp: string;
      keyPem: string;
      certPem: string;
    };
  });

  app.get('/api/devices/access', () => owner.status());
  app.put('/api/devices/access/direct', (request) => owner.configure(request.body));
  app.get<{ Params: { attemptId: string } }>('/api/devices/phone-pairing/:attemptId', (request) =>
    options.pairing.phoneProgress(request.params.attemptId));
  app.patch<{ Params: { id: string }; Body: { name?: unknown } }>('/api/devices/:id', async (request) => {
    const device = await options.devices.rename(request.params.id, deviceName(request.body?.name));

    return { device: { id: device.id, name: device.name } };
  });
  app.post<{ Body: { direct?: PhoneAddress[]; relayId?: string } }>(
    '/api/devices/phone-pairing', async (request) => {
      const direct = await owner.candidates(request.body?.direct);
      const mobile = options.access!.mobile;
      const status = await mobile.status();
      const records = (await mobile.relays.list()).filter((relay) => relay.enabled);
      const eligible = records.filter((relay) => status.relays.some((item) => item.id === relay.id
        && phoneRelayStatus(item).phoneEligible));
      const relayId = request.body?.relayId;
      const relay = relayId ? eligible.find((item) => item.id === relayId)
        : eligible.length === 1 ? eligible[0] : undefined;

      if (relayId && !relay) {
        throw new MobileInputError('relay_unavailable',
          'Настройте или обновите ретранслятор этого сервера.', 409);
      }

      if (!relayId && eligible.length > 1) {
        throw new MobileInputError('choose_relay', 'Выберите ретранслятор этого сервера.', 409);
      }

      if (!direct.length && (!relay || !status.relays.some((item) => item.id === relay.id
        && item.link.state === 'online'))) {
        throw new MobileInputError('access_unavailable',
          'Включите прямой доступ или настройте ретранслятор.', 409);
      }

      const issued = options.pairing.issuePhone();
      const payload: PhonePairing = {
        v: 2,
        server: { name: options.name, fp: (await options.identity()).fp },
        direct,
        pair: { code: issued.code, exp: issued.exp },
        ...(relay ? { relay: {
          id: relay.id,
          name: relay.name,
          host: relay.host.toLowerCase(),
          port: relay.port,
          fp: relay.fp,
          token: relay.deviceToken,
          protocol: 2 as const,
        } } : {}),
      };
      let text: string;
      const qr = qrcode(0, 'M');

      try {
        text = encodePhonePairing(payload);
      } catch (failure) {
        options.pairing.cancelPhone(issued.code);

        if (!(failure instanceof PairingPayloadError) || failure.code !== 'qr_too_large') {
          throw new MobileInputError('invalid_pairing',
            'Данные привязки недействительны. Проверьте адреса и настройки ретранслятора.');
        }

        throw new MobileInputError('qr_too_large', 'Сократите количество или длину адресов для QR.');
      }

      try {
        qr.addData(text, 'Byte');
        qr.make();
      } catch {
        options.pairing.cancelPhone(issued.code);

        throw new MobileInputError('qr_too_large', 'Сократите количество или длину адресов для QR.');
      }

      const size = qr.getModuleCount();
      const rows = Array.from({ length: size }, (_, y) => Array.from({ length: size }, (_, x) =>
        qr.isDark(y, x) ? '1' : '0').join(''));

      return {
        text,
        includedRelayId: relay?.id ?? null,
        expiresAt: issued.exp,
        expiresInMs: 600000,
        attemptId: issued.attemptId,
        qr: { size, rows },
        svg: qr.createSvgTag(4, 4),
      };
    });
}
