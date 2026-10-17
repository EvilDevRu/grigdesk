// CDN не получает Bearer и не может перенаправить скачивание в локальную сеть.
// Соединение закреплено за проверенным DNS-ответом; каждый redirect проверяется заново.
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import { isBlockedEgressIp, normalizeEgressHost } from '../kimi/egressPolicy.ts';

interface Address {
  address: string;
  family: number;
}

export interface PublicDownloadDeps {
  lookupAll?: (host: string) => Promise<Address[]>;
  connect?: (url: URL, options: RequestInit, address: Address) => Promise<Response>;
}

/**
 * IPv6 нормализуется до проверки, включая длинную запись loopback и mapped IPv4.
 * Блокируются также deprecated compatible/site-local адреса, не пригодные для CDN.
 */
function blocked(address: string): boolean {
  const normalized = isIP(address) === 6
    ? new URL(`https://[${address}]/`).hostname.slice(1, -1) : address;

  return isBlockedEgressIp(normalized) || (normalized.startsWith('::') && !normalized.startsWith('::ffff:'))
    || /^fe[c-f]/i.test(normalized);
}

/**
 * HTTPS запрос подключается к уже проверенному адресу через собственный lookup.
 * Все DNS-ответы должны быть публичными; Node не выполняет повторный DNS при connect.
 */
async function pinnedResponse(url: URL, options: RequestInit, chosen: Address): Promise<Response> {
  if (options.signal?.aborted) {
    throw new Error('download_aborted');
  }

  return new Promise((resolve, reject) => {
    const outgoing = request(url, {
      method: 'GET',
      agent: false,
      headers: Object.fromEntries(new Headers(options.headers)),
      signal: options.signal ?? undefined,
      family: chosen.family,
      lookup: (_hostname, _options, callback) => callback(null, chosen.address, chosen.family),
    }, (incoming) => {
      const responseHeaders = new Headers();

      for (const [name, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) {
          responseHeaders.set(name, Array.isArray(value) ? value.join(', ') : value);
        }
      }

      resolve(new Response(Readable.toWeb(incoming) as ReadableStream<Uint8Array>, {
        status: incoming.statusCode ?? 502,
        headers: responseHeaders
      }));
    });

    outgoing.once('error', reject);
    outgoing.end();
  });
}

/**
 * Публичное скачивание следует максимум трём redirect, сохраняя срок и Range.
 * Политика не является параметром API: localhost допускается только заменой fetch в тесте.
 */
export function createPublicDownload(deps: PublicDownloadDeps = {}): typeof fetch {
  return async (input, options = {}) => {
    let url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);

    for (let redirects = 0; ; redirects += 1) {
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
        throw new Error('unsafe_download_url');
      }

      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const literal = isIP(hostname);
      const host = literal ? hostname : normalizeEgressHost(hostname);
      const records = literal ? [{ address: host, family: literal }]
        : await (deps.lookupAll ?? ((name) => lookup(name, { all: true, verbatim: true })))(host);

      if (!records.length || records.some((entry) => blocked(entry.address))) {
        throw new Error('unsafe_download_address');
      }

      const headers = new Headers(options.headers);

      headers.delete('authorization');
      headers.delete('cookie');

      const response = await (deps.connect ?? pinnedResponse)(url, { ...options, headers }, records[0]!);

      if (![301, 302, 303, 307, 308].includes(response.status)) {
        return response;
      }

      const location = response.headers.get('location');

      void response.body?.cancel().catch(() => {});

      if (!location || redirects >= 3) {
        throw new Error('unsafe_download_redirect');
      }

      url = new URL(location, url);
    }
  };
}

export const fetchPublicDownload = createPublicDownload();
