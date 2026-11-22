import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { verifyCandidate } from '../../server/src/lib/mobile/relayDeployment/candidate.ts';
import { channelFixture } from './helpers/relayDeploymentChannel.js';
import { prepareDeployment, setupInput, startDeployment, waitDeployment } from './helpers/relayDeployment.js';
import { freePort } from './helpers/pluginBootFixture.js';

// Durable-recovery заменил немедленный shell-откат: отказ доказательства после публикации
// не возвращает прежние байты VPS, а сохраняет pin для resume. Локальный маршрут защищён
// CAS и не меняется без подтверждённого promotion; ожидание сети отличает vpn от прочего.
for (const fault of ['proof', 'vpn', 'ssh']) {
  test(`RD-RECOVERY: прежний маршрут сохранён после смены порта и отказа ${fault}`, {
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
    const nextPort = await freePort();
    const next = await prepareDeployment(f, setupInput(f, {
      requestId: `recovery-${fault}`,
      mode: 'restore',
      name: undefined,
      relayId: ready.relayId,
      ssh,
      public: { host: '127.0.0.1', port: nextPort },
    }), { password: f.ssh.password });

    await startDeployment(f, next);

    const expectedState = fault === 'vpn' ? 'waiting_vpn' : 'recovery_required';
    const failed = await waitDeployment(f, next.id, [expectedState], 15000);

    assert.deepEqual(await f.mobile.relay(ready.relayId), before);
    assert.equal(failed.error.code, fault === 'vpn' ? 'waiting_vpn' : 'relay_resume_required');
    assert.equal(failed.steps.find((step) => step.name === 'install').state, 'completed');

    const channel = failed.steps.find((step) => step.name === 'channel');

    assert.equal(channel.state, fault === 'vpn' ? 'running' : 'failed');

    const envFile = path.join(f.ssh.root, 'etc/grigdesk-relay', ready.relayId, 'relay.env');
    const env = await readFile(envFile, 'utf8');

    assert.equal(Number(/^RELAY_PORT=(\d+)/mu.exec(env)?.[1]), nextPort);
  });
}
