import type { LookupFunction } from 'node:net';
import { Agent, EnvHttpProxyAgent } from 'undici';
import type { Dispatcher } from 'undici';

import { isolatedLookup } from './isolatedDns.ts';
import { envHttpProxyEnabled } from './isolatedNetworkWorker.ts';

// Соединитель получает адреса в исходном порядке и сохраняет штатную IPv4/IPv6 стратегию.
const lookup: LookupFunction = (hostname, options, callback) => {
  void isolatedLookup(hostname, { ...options, all: true }).then((addresses) => {
    const first = addresses[0];

    if (!first) {
      callback(Object.assign(new Error('DNS не вернул адрес.'), { code: 'ENOTFOUND' }), '');

      return;
    }

    callback(null, options.all ? addresses : first.address, first.family);
  }, (error: Error & { cause?: { code?: string } }) => {
    const code = error.name === 'TimeoutError' ? 'ETIMEDOUT' : error.cause?.code;

    callback(Object.assign(new Error(error.message, { cause: error }), { code }), '');
  });
};

const connect = { lookup };
let dispatcher: Dispatcher | undefined;

/**
 * Разрешает имена с жёстким сроком, оставляя нативному fetch TLS, редиректы и потоки.
 * Отдельный dispatcher ограничивает изменение теми серверными входами, которые его выбрали.
 */
export const fetchWithIsolatedDns: typeof fetch = (input, init) => {
  if (init && 'dispatcher' in init && init.dispatcher) {
    return globalThis.fetch(input, init);
  }

  dispatcher ??= envHttpProxyEnabled
    ? new EnvHttpProxyAgent({
      connect,
      proxyTls: connect,
      requestTls: connect,
    })
    : new Agent({ connect });

  const options = { ...init, dispatcher };

  return globalThis.fetch(input, options);
};
