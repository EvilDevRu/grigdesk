import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { channelFixture } from './helpers/relayDeploymentChannel.js';
import { prepareDeployment, setupInput, startDeployment, waitDeployment } from './helpers/relayDeployment.js';

test('RD-GO-01: фактический Go ELF из подписанного пакета выдаёт proof по TLS', {
  timeout: 65000,
}, async (t) => {
  const f = await channelFixture(t, { native: true });
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root',
    },
    public: { host: '127.0.0.1', port: f.port },
  }), { password: f.ssh.password });

  assert.equal(job.state, 'awaiting_confirmation');
  await startDeployment(f, job);

  const ready = await waitDeployment(f, job.id, ['ready', 'recovery_required', 'failed'], 55000);

  assert.equal(ready.state, 'ready', f.serviceErrors.join('\n') || JSON.stringify(ready));
  assert.equal(ready.channel.state, 'verified');

  const base = path.join(f.ssh.root, 'opt/grigdesk-relay', ready.relayId);
  const gate = JSON.parse(await readFile(path.join(base, 'gate.json'), 'utf8'));

  assert.equal(gate.status, 'approved');
  assert.equal(gate.targetSha, f.release.artifact.files[1].sha256);
});
