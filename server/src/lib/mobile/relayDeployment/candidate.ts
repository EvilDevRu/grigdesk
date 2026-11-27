import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { isolatedLookup } from '../../isolatedDns.ts';
import { RelayLink, normalizeRelayIp } from '../relayLink.ts';
import type { Relay } from '../store.ts';
import { dialRelay, relayHello, relayLine } from '../transport.ts';

export interface DeploymentProof {
  relayId: string;
  releaseId: string;
  artifactSha: string;
  secret: string;
}

export interface CandidateOptions {
  relay: Relay;
  serverFp: string;
  vpnGate: (ip: string) => Promise<boolean>;
  clientTarget?: () => Promise<number>;
  existing?: boolean;
  address?: string;
  proof?: DeploymentProof;
}

/**
 * Разрешает адрес до TLS и пропускает публичное соединение только через штатные VPN-ворота.
 * Возвращённый числовой адрес закрепляется на всё доказательство кандидата.
 */
export async function candidateAddress(host: string, gate: CandidateOptions['vpnGate']): Promise<string> {
  const address = normalizeRelayIp(net.isIP(host) ? host : (await isolatedLookup(host)).address);

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
  const address = options.address ?? await candidateAddress(options.relay.host, options.vpnGate);

  if (options.proof) {
    await probeDeployment(options.relay, address, options.proof);
  }

  const link = options.existing ? null : new RelayLink({
    relay: { ...options.relay, host: address },
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
 * Запрашивает доказательство установленного поколения по тому же числовому адресу и TLS pin.
 * Подписанные поля связывают ответ с этим запросом и проверенным архивом.
 */
async function probeDeployment(relay: Relay, address: string, proof: DeploymentProof): Promise<void> {
  const socket = await dialRelay({
    ip: address,
    port: relay.port,
    fp: relay.fp,
  });
  const challenge = randomBytes(32).toString('base64url');
  const sign = (value: string) => createHmac('sha256', Buffer.from(proof.secret, 'base64url'))
    .update(value).digest();

  try {
    const answer = relayLine(socket, 5000);
    const mac = sign(`grigdesk relay check v1\n${challenge}`).toString('base64url');

    socket.write(`${JSON.stringify({
      v: 1,
      role: 'health',
      deploymentProof: {
        schema: 1,
        challenge,
        mac,
      },
    })}\n`);

    const reply = JSON.parse(await answer);
    const value = reply?.deploymentProof;

    if (reply?.ok !== true || value?.schema !== 1 || value.challenge !== challenge
      || value.relayId !== proof.relayId || value.releaseId !== proof.releaseId
      || value.artifactSha !== proof.artifactSha || typeof value.mac !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(value.mac)) {
      throw new Error('relay_proof_required');
    }

    const observed = Buffer.from(value.mac, 'base64url');
    const expected = sign(['grigdesk relay proof v1', challenge,
      proof.relayId, proof.releaseId, proof.artifactSha].join('\n'));

    if (observed.length !== expected.length || observed.toString('base64url') !== value.mac
      || !timingSafeEqual(observed, expected)) {
      throw new Error('relay_proof_required');
    }
  } finally {
    socket.destroy();
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
