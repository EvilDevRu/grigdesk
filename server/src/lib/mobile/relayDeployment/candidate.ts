import { lookup } from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';

import { RelayLink, normalizeRelayIp } from '../relayLink.ts';
import type { Relay } from '../store.ts';
import { dialRelay, relayHello } from '../transport.ts';

export interface CandidateOptions {
  relay: Relay;
  serverFp: string;
  vpnGate: (ip: string) => Promise<boolean>;
  clientTarget?: () => Promise<number>;
  existing?: boolean;
}

/**
 * Разрешает адрес до TLS и пропускает публичное соединение только через штатные VPN-ворота.
 * Возвращённый числовой адрес закрепляется на всё доказательство кандидата.
 */
export async function candidateAddress(host: string, gate: CandidateOptions['vpnGate']): Promise<string> {
  const address = normalizeRelayIp(net.isIP(host) ? host : (await lookup(host)).address);

  if (!address.private && !await gate(address.ip)) {
    throw new Error('waiting_vpn');
  }

  return address.ip;
}

/**
 * Проверяет control/client-v2 и проход данных до домашнего pinned TLS без привязки устройства.
 * Кандидат живёт отдельно от рабочего хаба и закрывается перед переключением маршрута.
 */
export async function verifyCandidate(
  options: CandidateOptions,
): Promise<{ verified: true; address: string }> {
  const address = await candidateAddress(options.relay.host, options.vpnGate);
  const link = options.existing ? null : new RelayLink({
    relay: { ...options.relay, host: address },
    mobilePort: 0,
    clientTarget: options.clientTarget,
    vpnGate: options.vpnGate,
  });

  link?.start();

  try {
    if (link) {
      const deadline = Date.now() + 6000;

      while (link.status().state !== 'online') {
        if (Date.now() > deadline || link.status().state === 'error') {
          throw new Error('relay_channel_unavailable');
        }

        await new Promise((resolve) => setTimeout(resolve, 40));
      }

      if (link.status().compatibility !== 'supported') {
        throw new Error('relay_upgrade_required');
      }
    }

    await probePrivateTls(options, address);

    return { verified: true, address };
  } finally {
    link?.stop();
  }
}

/**
 * Self-probe предъявляет токен только внешнему проверенному relay, а HTTP — внутреннему pin.
 * Bootstrap hello с device=null не подтверждает подключение реального телефона.
 */
async function probePrivateTls(options: CandidateOptions, address: string): Promise<void> {
  const outer = await dialRelay({
    ip: address,
    port: options.relay.port,
    fp: options.relay.fp,
  });
  let inner: tls.TLSSocket | undefined;
  const timer = setTimeout(() => outer.destroy(new Error('relay_probe_timeout')), 7000);

  try {
    await relayHello(outer, {
      v: 2,
      role: 'device',
      target: 'client',
      token: options.relay.deviceToken,
    });
    inner = tls.connect({
      socket: outer,
      rejectUnauthorized: false,
      minVersion: 'TLSv1.3',
    });

    const socket = inner;

    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve);
      socket.once('error', reject);
    });

    const fp = socket.getPeerX509Certificate()?.fingerprint256.replaceAll(':', '').toLowerCase();

    if (fp !== options.serverFp) {
      throw new Error('server_pin_mismatch');
    }

    const agent = new https.Agent({ maxCachedSessions: 0 });

    agent.createConnection = () => socket;

    try {
      await new Promise<void>((resolve, reject) => {
        const request = https.get({
          hostname: '127.0.0.1',
          path: '/api/client/hello',
          agent,
        }, (response) => {
          let body = '';

          response.on('data', (bytes: Buffer) => {
            body += bytes;

            if (body.length > 16_384) {
              request.destroy(new Error('relay_bad_hello'));
            }
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const hello = JSON.parse(body) as {
                product?: string;
                fp?: string;
                device?: unknown;
              };

              if (response.statusCode !== 200 || hello.product !== 'grigdesk'
                || hello.fp !== options.serverFp || hello.device !== null) {
                throw new Error('relay_bad_hello');
              }

              resolve();
            } catch {
              reject(new Error('relay_bad_hello'));
            }
          });
        });

        request.setTimeout(6000, () => request.destroy(new Error('relay_probe_timeout')));
        request.once('error', reject);
      });
    } finally {
      agent.destroy();
    }
  } finally {
    clearTimeout(timer);
    inner?.destroy();
    outer.destroy();
  }
}
