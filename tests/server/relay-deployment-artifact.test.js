import assert from 'node:assert/strict';
import { chmod, readFile } from 'node:fs/promises';
import test from 'node:test';

import { verifyReleaseEnvelope } from '../../shared/node/releaseTrust.ts';
import { extractReleaseArtifact } from '../../shared/node/releaseArchive.ts';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  deploymentFixture, deploymentRequest, fileSnapshot, prepareDeployment, setupInput,
  startDeployment, waitDeployment,
} from './helpers/relayDeployment.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';
import { executedOsCommands, relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';

test('RD-BIN-01: подписанный server archive выбирает только relay с точным digest', async (t) => {
  const release = relayRelease();
  const ssh = await relayDeploymentSsh(t);
  const archive = path.join(ssh.root, 'server.tar.gz');
  const unpacked = path.join(ssh.root, 'unpacked');

  verifyReleaseEnvelope(release.envelope, release.publicKeyPem);
  await writeFile(archive, release.archive);
  await extractReleaseArtifact(archive, unpacked, release.artifact);
  assert.deepEqual(await readFile(path.join(unpacked, 'bin/grigdesk-relay')), release.relay);

  const f = await deploymentFixture(t, {
    transport: ssh.transport, deployment: { release: release.release },
  });
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    }
  }), { password: ssh.password });

  assert.equal(job.state, 'awaiting_confirmation');
  assert.equal(job.preview.artifact.digest,
    release.artifact.files.find((file) => file.path === 'bin/grigdesk-relay').sha256);
  assert.equal(ssh.writes.length, 0);
  await startDeployment(f, job);
});

for (const failure of ['badSignature', 'badHash', 'badSize', 'extraEntry', 'missingRelay', 'timeout']) {
  test(`RD-BIN-02: ${failure} не допускает installation или unsigned fallback`, async (t) => {
    const release = relayRelease({ [failure]: true });
    const ssh = await relayDeploymentSsh(t);
    const f = await deploymentFixture(t, {
      transport: ssh.transport, deployment: { release: release.release },
    });
    const job = await prepareDeployment(f, setupInput(f, {
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        user: 'root',
      }
    }), { password: ssh.password });

    assert.equal(job.state, 'failed');
    assert.equal(ssh.writes.length, 0);
    assert.equal((await executedOsCommands(ssh)).some(({ command, args }) => command === 'useradd'
      || command === 'systemctl' && args.some((arg) => ['start', 'enable'].includes(arg))), false);
    assert.ok(release.requests.length > 0, 'Должна быть проверена реальная граница источника');
    assert.equal(release.requests.every((request) => request.redirect === 'error'), true);
  });
}

test('RD-BIN-02: повреждённый cache повторно проверяется перед transfer', async (t) => {
  const release = relayRelease();
  const ssh = await relayDeploymentSsh(t);
  const f = await deploymentFixture(t, {
    transport: ssh.transport, deployment: { release: release.release },
  });
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    }
  }), { password: ssh.password });
  const cache = await fileSnapshot(f.directory);
  const targets = Object.entries(cache).filter(([, bytes]) => {
    const actual = Buffer.from(bytes, 'base64');

    return actual.equals(release.archive) || actual.equals(release.relay);
  });

  assert.ok(targets.length > 0, 'Preview закрепляет проверенные bytes в собственном cache');

  for (const [name] of targets) {
    await chmod(path.join(f.directory, name), 0o600);
    await writeFile(path.join(f.directory, name), 'Повреждение проверенного cache');
  }

  const result = await deploymentRequest(f, 'POST', `/${job.id}/start`, {
    requestId: 'corrupt-cache-start',
    revision: job.revision,
    previewDigest: job.preview.digest,
  });

  assert.ok([202, 409, 503].includes(result.statusCode), result.body);

  if (result.statusCode === 202) {
    await waitDeployment(f, job.id, ['failed']);
  }

  assert.equal(ssh.writes.length, 0);
});

for (const channel of ['release', 'dev']) {
  test(`RD-BIN-03: ${channel} и повтор используют закреплённые bytes preview`, async (t) => {
    const release = relayRelease({ channel });
    const ssh = await relayDeploymentSsh(t);
    const f = await deploymentFixture(t, {
      transport: ssh.transport,
      deployment: { release: release.release, receipt: channel === 'dev' ? { channel } : undefined },
    });
    const job = await prepareDeployment(f, setupInput(f, {
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        user: 'root',
      }
    }), { password: ssh.password });

    assert.equal(job.state, 'awaiting_confirmation');
    assert.equal(job.preview.artifact.version, release.identity.version);
    assert.ok(release.requests.some((request) => request.url.endsWith(`/${channel}.json`)));
    await startDeployment(f, job, 'same-start-request');
    await startDeployment(f, job, 'same-start-request');
    assert.equal(release.requests.filter((request) => request.url.endsWith('.tar.gz')).length, 1);
  });
}
