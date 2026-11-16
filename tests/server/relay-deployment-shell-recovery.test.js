import assert from 'node:assert/strict';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { deploymentFixture, prepareDeployment, setupInput, startDeployment, waitDeployment }
  from './helpers/relayDeployment.js';
import { relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';

test('RD-ROLLBACK: неудачный shell rollback оставляет old-* и достоверный recovery_required', {
  timeout: 45000,
}, async (t) => {
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
    public: { host: '127.0.0.1', port: 4443 },
  });
  const first = await prepareDeployment(f, input, { password: ssh.password });

  await startDeployment(f, first);

  const ready = await waitDeployment(f, first.id, ['ready'], 15000);
  const before = await f.mobile.relay(ready.relayId);
  const next = await prepareDeployment(f, {
    ...input,
    requestId: 'restart-and-rollback-stop-failed',
    mode: 'restore',
    name: undefined,
    relayId: ready.relayId,
    public: { host: '127.0.0.1', port: 5443 },
  }, { password: ssh.password });

  await ssh.setPlatform({ failCommand: 'restart', failStop: true });
  await startDeployment(f, next);

  const failed = await waitDeployment(f, next.id, ['recovery_required', 'failed'], 15000);

  assert.equal(failed.state, 'recovery_required');
  assert.equal(failed.error.code, 'remote_rollback_failed');
  assert.equal(failed.service.state, 'unknown');
  assert.deepEqual(await f.mobile.relay(ready.relayId), before);

  const stages = await readdir(path.join(ssh.root, 'tmp'));
  const backup = stages.find((entry) => entry.startsWith('grigdesk-relay-'));

  assert.ok(backup, 'Неподтверждённый rollback не удаляет staging с резервной копией');
  assert.ok((await stat(path.join(ssh.root, 'tmp', backup, 'old-env'))).size > 0);
});
