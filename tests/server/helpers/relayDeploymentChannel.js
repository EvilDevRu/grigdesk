import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import tls from 'node:tls';
import net from 'node:net';

import { createHostKeyStore } from '../../../server/src/lib/ssh/hostKeys.ts';
import { normalizeRelayIp } from '../../../server/src/lib/mobile/relayLink.ts';
import mobileModule from '../../../server/src/modules/mobile/index.ts';
import { managedRelayFixture, makeCert, temporary } from '../../relay/helpers.js';
import { phoneFixture, phoneAdmin } from './phoneAccess.js';
import { freePort } from './pluginBootFixture.js';
import { relayRelease } from './relayDeploymentRelease.js';
import { relayDeploymentSsh } from './relayDeploymentSsh.js';
import { legacyRelay } from './legacyRelay.js';
import { fixtureGo } from '../../helpers/goBuildFixture.mts';

/**
 * Публичный TEST-NET адрес сохраняется до production VPN-проверки.
 * Только на границе TCP он направляется в loopback; TLS и pin остаются настоящими.
 */
export function publicRelayRoute(t) {
  const host = '203.0.113.10';
  const connect = net.Socket.prototype.connect;
  let dials = 0;

  assert.equal(normalizeRelayIp(host).private, false);
  t.mock.method(net.Socket.prototype, 'connect', function (options, ...args) {
    if (options?.host !== host) {
      return Reflect.apply(connect, this, [options, ...args]);
    }

    dials += 1;

    return Reflect.apply(connect, this, [{ ...options, host: '127.0.0.1' }, ...args]);
  });

  return { host, dialCount: () => dials };
}

/**
 * Служба фикстуры читает установленный production installer env, затем запускает настоящий relay.
 * Подменяется systemd VPS: ни owner, ни SSH, ни SFTP, ни stores, ни оба TLS не подменены.
 */
export async function channelFixture(t, options = {}) {
  const directory = options.directory ?? await temporary(t);
  const ssh = options.sshFixture ?? await relayDeploymentSsh(t, options.ssh);
  const release = options.native ? await nativeRelease() : relayRelease();
  const hostKeys = await createHostKeyStore({ file: path.join(directory, 'known-hosts.json') });
  const port = options.port ?? await freePort();
  const services = new Map();
  const generations = new Map();
  const errors = [];
  const route = options.publicRoute ? publicRelayRoute(t) : null;
  const vpnChecks = [];
  let polling = false;
  let closed = false;

  const f = await phoneFixture(t, {
    directory,
    mobileOptions: {
      vpnGate: async (ip) => {
        vpnChecks.push(ip);

        return options.vpn !== false;
      },
      relayDeployment: {
        transport: ssh.transport,
        hostKeys,
        release: release.release,
        ...options.deployment,
      },
    },
    registerAdmin: async (app, { mobile }) => app.register(mobileModule, { service: mobile }),
  });

  await phoneAdmin(f, 'GET', '/api/devices/access');
  await f.mobile.start();

  const timer = setInterval(async () => {
    if (polling || closed) {
      return;
    }

    polling = true;

    try {
      const state = JSON.parse(await readFile(path.join(ssh.root, 'var/lib/os-state.json'), 'utf8'));

      for (const [unit, status] of Object.entries(state.units)) {
        const generation = state.generations?.[unit] ?? 0;

        if (services.has(unit) && (!status.active || generations.get(unit) !== generation)) {
          await services.get(unit).close();
          services.delete(unit);
        }

        if (!status.active || services.has(unit)) {
          continue;
        }

        const id = unit.slice('grigdesk-relay-'.length, -'.service'.length);
        const text = await readFile(path.join(ssh.root, 'etc/grigdesk-relay', id, 'relay.env'), 'utf8');
        const env = Object.fromEntries(text.trim().split('\n').map((line) => {
          const index = line.indexOf('=');

          return [line.slice(0, index), line.slice(index + 1)];
        }));
        let relay;
        const servicePort = Number(env.RELAY_PORT);

        if (options.native) {
          relay = nativeRelay(ssh, id, env);
        } else if (options.peer === 'legacy') {
          const stored = (await f.mobile.relays.list()).find((item) => item.id === id);

          relay = legacyRelay({
            key: Buffer.from(env.RELAY_TLS_KEY_B64, 'base64'),
            cert: Buffer.from(env.RELAY_TLS_CERT_B64, 'base64'),
            brainToken: stored.brainToken,
            deviceToken: stored.deviceToken,
          });
        } else if (options.peer) {
          const stranger = options.peer === 'wrong-pin' ? await makeCert(ssh.root, 'wrong-relay') : null;

          relay = failingPeer(env, options.peer, stranger);
        } else {
          const proof = path.join(ssh.root, 'opt/grigdesk-relay', id, 'proof.json');

          relay = {
            async listen(host, port) {
              const fixture = await managedRelayFixture(t, env, host, port, proof);

              this.close = async () => {
                fixture.child.kill('SIGTERM');
                await fixture.exited;
              };
            },
          };
        }

        await relay.listen(options.listenHost ?? '127.0.0.1', servicePort);

        services.set(unit, relay);
        generations.set(unit, generation);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        errors.push(error.message);
      }
    } finally {
      polling = false;
    }
  }, 10);

  /**
   * Выключение VPS останавливает наблюдатель прежде закрытия его relay-сокетов.
   * Поэтому прежний A не воскресает, когда тест уже восстанавливает доступ на B.
   */
  const stopVps = async () => {
    closed = true;
    clearInterval(timer);

    while (polling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    await Promise.all([...services.values()].map((service) => service.close()));
    services.clear();
  };

  t.after(stopVps);

  return {
    ...f,
    ssh,
    hostKeys,
    release,
    port,
    services,
    stopVps,
    serviceErrors: errors,
    publicHost: route?.host ?? '127.0.0.1',
    vpnChecks,
    dialCount: () => route?.dialCount() ?? 0,
  };
}

/**
 * Подписывает собранный ELF и точную версию из независимого Go runtime-info.
 * Тот же файл будет запущен из физических /opt и /proc временного VPS.
 */
async function nativeRelease() {
  const file = fixtureGo('grigdesk-relay');
  const info = JSON.parse(execFileSync(file, ['--runtime-info', '--json'], { encoding: 'utf8' }));

  return relayRelease({
    binary: await readFile(file),
    version: info.version,
  });
}

/**
 * Запускает установленную службу по физическому пути в namespace фикстуры.
 * Готовность наступает после открытия listener, teardown ждёт выхода bwrap.
 */
function nativeRelay(ssh, id, env) {
  let process;
  let exit;

  return {
    listen: async () => {
      process = ssh.runService(id, env);
      exit = once(process, 'exit');

      let output = '';

      process.stdout.on('data', (chunk) => output += chunk);

      const deadline = Date.now() + 4000;

      while (!output.includes('"ev":"listening"')) {
        if (process.exitCode !== null || Date.now() >= deadline) {
          process.kill('SIGKILL');
          await exit;

          throw new Error(`Fixture Go relay failed: ${output}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: async () => {
      process.kill('SIGKILL');
      await exit;
    },
  };
}

/**
 * Отрицательный peer отвечает health, но не предоставляет сквозной канал данных.
 * Домашний candidate остаётся production-кодом и обязан обнаружить этот отказ.
 */
function failingPeer(env, mode, stranger) {
  const sockets = new Set();
  const server = tls.createServer({
    key: stranger?.keyPem ?? Buffer.from(env.RELAY_TLS_KEY_B64, 'base64'),
    cert: stranger?.certPem ?? Buffer.from(env.RELAY_TLS_CERT_B64, 'base64'),
    minVersion: 'TLSv1.3',
  }, (socket) => {
    sockets.add(socket);
    socket.on('error', () => { });
    socket.on('close', () => sockets.delete(socket));

    let pending = '';

    socket.on('data', (bytes) => {
      pending += bytes;

      if (!pending.includes('\n')) {
        return;
      }

      const hello = JSON.parse(pending.slice(0, pending.indexOf('\n')));

      pending = '';

      if (hello.role === 'health') {
        socket.end('{"ok":true}\n');
      } else if (hello.role === 'brain-control' && mode === 'no-data') {
        socket.write('{"ok":true,"capabilities":["client-v2"]}\n');
      } else if (hello.t === 'ping') {
        socket.write('{"t":"pong"}\n');
      } else {
        socket.end('{"ok":false,"error":"brain_offline"}\n');
      }
    });
  });

  return {
    listen: (host, port) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    }),
    close: () => {
      sockets.forEach((socket) => socket.destroy());

      return new Promise((resolve) => server.close(resolve));
    },
  };
}
