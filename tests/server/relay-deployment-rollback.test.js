import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { verifyCandidate } from '../../server/src/lib/mobile/relayDeployment/candidate.ts';
import { dialRelay } from '../../server/src/lib/mobile/transport.ts';
import { channelFixture } from './helpers/relayDeploymentChannel.js';
import { prepareDeployment, setupInput, startDeployment, waitDeployment } from './helpers/relayDeployment.js';
import { freePort } from './helpers/pluginBootFixture.js';

/**
 * TLS проверяет фактический возврат прежнего endpoint, а не только содержимое env на VPS.
 * Наблюдатель временного systemd применяет восстановление службы асинхронно.
 */
async function waitPreviousEndpoint(relay) {
  const deadline = Date.now() + 5000;

  while (true) {
    try {
      const socket = await dialRelay({
        ip: '127.0.0.1',
        port: relay.port,
        fp: relay.fp,
      });

      socket.destroy();

      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

for (const fault of ['proof', 'vpn', 'ssh']) {
  test(`RD-ROLLBACK: прежний VPS после смены порта и отказа ${fault}`, {
    timeout: 45000,
  }, async (t) => {
    let proofs = 0;
    const f = await channelFixture(t, {
      deployment: {
        verifyCandidate: async (options) => {
          proofs += 1;

          if (proofs === 1) {
            return verifyCandidate(options);
          }

          if (fault === 'ssh') {
            f.ssh.disconnect();
          }

          throw new Error(fault === 'vpn' ? 'waiting_vpn' : 'RD_PROOF_FAILURE');
        },
      },
    });
    const ssh = {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root',
    };
    const first = await prepareDeployment(f, setupInput(f, {
      ssh,
      public: { host: '127.0.0.1', port: f.port },
    }), { password: f.ssh.password });

    await startDeployment(f, first);

    const ready = await waitDeployment(f, first.id, ['ready'], 15000);
    const before = await f.mobile.relay(ready.relayId);
    const next = await prepareDeployment(f, setupInput(f, {
      requestId: `rollback-${fault}`,
      mode: 'restore',
      name: undefined,
      relayId: ready.relayId,
      ssh,
      public: { host: '127.0.0.1', port: await freePort() },
    }), { password: f.ssh.password });

    await startDeployment(f, next);

    const failed = await waitDeployment(f, next.id, ['recovery_required'], 15000);

    assert.deepEqual(await f.mobile.relay(ready.relayId), before);
    assert.equal(failed.error.code,
      fault === 'ssh' ? 'remote_rollback_failed' : 'previous_installation_restored');
    assert.equal(failed.steps.find((step) => step.name === 'rollback').state,
      fault === 'ssh' ? 'failed' : 'completed');

    if (fault === 'ssh') {
      assert.equal(failed.service.state, 'unknown');

      const stages = await readdir(path.join(f.ssh.root, 'tmp'));

      assert.ok(stages.some((entry) => entry.startsWith('grigdesk-relay-')),
        'Неподтверждённый откат не уничтожает резервные файлы');
    } else {
      const envFile = path.join(f.ssh.root, 'etc/grigdesk-relay', ready.relayId, 'relay.env');
      const env = await readFile(envFile, 'utf8');

      assert.equal(Number(/^RELAY_PORT=(\d+)/mu.exec(env)?.[1]), before.port);
      await waitPreviousEndpoint(before);
    }
  });
}
