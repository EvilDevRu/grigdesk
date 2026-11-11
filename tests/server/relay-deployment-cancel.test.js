import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createDeployment, deploymentFixture, deploymentRequest, prepareDeployment, readDeployment,
  setupInput, startDeployment, waitDeployment,
} from './helpers/relayDeployment.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';
import { relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';

for (const stage of ['draft', 'awaiting_host_key', 'awaiting_credentials']) {
  test(`RD-CANCEL-01: отмена ${stage}, lost ACK и новый VPS сохраняют прежний relay`, async (t) => {
    const f = await deploymentFixture(t);
    const relay = await f.mobile.addRelay({
      name: 'Сохранённый доступ',
      host: '127.0.0.1',
      port: 443,
    });
    const env = await f.mobile.relayEnv(relay.id);
    const input = setupInput(f, {
      mode: 'restore',
      name: undefined,
      relayId: relay.id,
      public: { host: '127.0.0.1', port: 443 },
    });
    let job = await createDeployment(f, input);

    if (stage !== 'draft') {
      const probe = await deploymentRequest(f, 'POST', `/${job.id}/probe`, {
        revision: job.revision,
      });

      assert.equal(probe.statusCode, 200, probe.body);
      job = probe.json();
    }

    if (stage === 'awaiting_credentials') {
      const trusted = await deploymentRequest(f, 'POST', `/${job.id}/host-key`, {
        revision: job.revision,
        challengeId: job.hostKey.challengeId,
        decision: 'trust',
      });

      assert.equal(trusted.statusCode, 200, trusted.body);
      job = trusted.json();
    }

    assert.equal(job.state, stage);

    const cancel = { revision: job.revision, requestId: 'cancel-waiting' };
    const response = await deploymentRequest(f, 'POST', `/${job.id}/cancel`, cancel);
    const replay = await deploymentRequest(f, 'POST', `/${job.id}/cancel`, cancel);

    assert.equal(response.statusCode, 202, response.body);
    assert.equal(replay.statusCode, 202, replay.body);
    assert.deepEqual(replay.json(), response.json());
    assert.equal(response.json().state, 'interrupted');
    assert.equal(response.json().error.code, 'deployment_cancelled');

    const next = await createDeployment(f, {
      ...input,
      requestId: 'restore-new-vps',
      ssh: {
        host: 'new-vps.example.invalid',
        port: 22,
        user: 'root',
      },
    });

    assert.equal(next.state, 'draft');
    assert.equal(next.relayId, relay.id);
    assert.equal((await f.mobile.relays.list()).length, 1);
    assert.equal(await f.mobile.relayEnv(relay.id), env);
    assert.equal(f.calls.some(([method]) => method === 'connect'), false);
  });
}

test('RD-CANCEL-02: отмена preview закрывает SSH и запрещает старое подтверждение', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const release = relayRelease();
  const f = await deploymentFixture(t, {
    transport: ssh.transport,
    deployment: { release: release.release },
  });
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    },
    public: { host: '127.0.0.1', port: 443 },
  }), { password: ssh.password });

  assert.equal(job.state, 'awaiting_confirmation');

  const response = await deploymentRequest(f, 'POST', `/${job.id}/cancel`, {
    revision: job.revision,
    requestId: 'cancel-preview',
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.json().preview, undefined);

  const staleStart = await deploymentRequest(f, 'POST', `/${job.id}/start`, {
    revision: job.revision,
    requestId: 'start-cancelled-preview',
    previewDigest: job.preview.digest,
  });

  assert.equal(staleStart.statusCode, 409, staleStart.body);
  assert.equal((await readDeployment(f, job.id)).state, 'interrupted');
  assert.equal(ssh.writes.length, 0);
  assert.equal((await f.mobile.relays.list()).length, 0);
});

test('RD-CANCEL-02: принятое installing нельзя отменить или заменить новым заданием', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const release = relayRelease();
  const f = await deploymentFixture(t, {
    transport: ssh.transport,
    deployment: {
      release: release.release,
      verifyCandidate: async () => ({ verified: true, address: '127.0.0.1' }),
    },
  });
  const input = setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    },
    public: { host: '127.0.0.1', port: 443 },
  });
  const preview = await prepareDeployment(f, input, { password: ssh.password });

  await ssh.setPlatform({ pauseCommand: 'useradd' });
  await startDeployment(f, preview);

  const deadline = Date.now() + 5000;
  let barrier = '';

  while (Date.now() < deadline && !barrier) {
    barrier = await readFile(path.join(ssh.root, 'barrier'), 'utf8').catch(() => '');

    if (!barrier) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  assert.equal(barrier, 'useradd');

  const installing = await readDeployment(f, preview.id);
  const cancelled = await deploymentRequest(f, 'POST', `/${preview.id}/cancel`, {
    revision: installing.revision,
    requestId: 'cannot-cancel-accepted-install',
  });
  const competing = await deploymentRequest(f, 'POST', '', {
    ...input,
    requestId: 'cannot-replace-accepted-install',
  });

  assert.equal(cancelled.statusCode, 409, cancelled.body);
  assert.equal(competing.statusCode, 409, competing.body);
  assert.equal((await readDeployment(f, preview.id)).state, 'installing');
  await ssh.release();
  await waitDeployment(f, preview.id, ['ready'], 15000);
});
