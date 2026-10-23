import { validPhoneHost } from '../../../../shared/client/phonePairing.ts';

interface RelayStatus {
  enabled: boolean;
  host: string;
  link: {
    state: string;
    compatibility?: string;
  };
}

/**
 * Пригодность телефонного пути вычисляется из того же DTO, который видит диалог.
 * Старый relay может поддерживать IPv6, хотя телефонный конверт принимает только IPv4/DNS.
 */
export function phoneRelayStatus(relay: RelayStatus) {
  let phoneError: string | null = null;

  if (!validPhoneHost(relay.host.toLowerCase())) {
    phoneError = 'unsupported_address';
  } else if (!relay.enabled) {
    phoneError = 'disabled';
  } else if (relay.link.state !== 'online') {
    phoneError = relay.link.state;
  } else if (relay.link.compatibility !== 'supported') {
    phoneError = relay.link.compatibility === 'unsupported' ? 'incompatible' : 'unknown';
  }

  return { phoneEligible: phoneError === null, phoneError };
}
