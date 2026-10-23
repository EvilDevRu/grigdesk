import type { PhoneAddress } from '../../../../shared/client/phonePairing.ts';
import { validPhoneHost } from '../../../../shared/client/phonePairing.ts';
import { MobileInputError } from '../mobile/errors.ts';

export interface PhoneAccessConfig {
  version: 1;
  direct: {
    enabled: boolean;
    addresses: PhoneAddress[];
    advertised?: PhoneAddress[];
  };
}

/**
 * Durable-файл и административная команда проходят одну проверку структуры.
 * Произвольный bind дополнительно сверяется с интерфейсами текущего сервера владельцем.
 */
export function parsePhoneConfig(input: unknown): PhoneAccessConfig['direct'] {
  const value = input as PhoneAccessConfig['direct'];

  if (!value || typeof value.enabled !== 'boolean'
    || (value.enabled && (!Array.isArray(value.addresses) || !value.addresses.length))) {
    throw new MobileInputError('bad_direct_config', 'Выберите сеть и порт прямого доступа.');
  }

  for (const address of [...(value.addresses ?? []), ...(value.advertised ?? [])]) {
    if (!address || !validPhoneHost(address.host) || !Number.isInteger(address.port)
      || address.port < 1 || address.port > 65535) {
      throw new MobileInputError('bad_client_address', 'Укажите сетевой IPv4 или имя и порт 1–65535.');
    }
  }

  return {
    enabled: value.enabled,
    addresses: value.enabled ? value.addresses : [],
    ...(value.advertised ? { advertised: value.advertised } : {}),
  };
}
