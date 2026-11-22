import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { deploymentFixture, prepareDeployment, setupInput, startDeployment, waitDeployment }
  from './helpers/relayDeployment.js';
import { relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';

// Durable-recovery: сбой remote-команды при замене не выдаёт ложный ready и не откатывает
// байты shell-скриптом. Прежний маршрут защищён CAS, а staging не переживает попытку —
// резерв поколения хранится в durable pin, а не в old-* файлах временного каталога.
test('RD-RECOVERY: сбой remote-команды оставляет достоверный recovery_required', {
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
    requestId: 'restore-remote-command-failed',
    mode: 'restore',
    name: undefined,
    relayId: ready.relayId,
    public: { host: '127.0.0.1', port: 5443 },
  }, { password: ssh.password });

  await ssh.setPlatform({ failCommand: 'daemon-reload' });
  await startDeployment(f, next);

  const failed = await waitDeployment(f, next.id, ['recovery_required'], 15000);

  assert.equal(failed.state, 'recovery_required');
  assert.equal(failed.error.code, 'relay_resume_required');
  assert.equal(failed.service.state, 'unknown');
  assert.deepEqual(await f.mobile.relay(ready.relayId), before);

  const stages = await readdir(path.join(ssh.root, 'tmp'));

  assert.equal(stages.some((entry) => entry.startsWith('grigdesk-relay-')), false,
    'Staging не переживает попытку: резерв поколения хранится в durable pin');
});
