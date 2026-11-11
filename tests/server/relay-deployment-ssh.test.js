import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createDeployment, deploymentFixture, deploymentRequest, fileSnapshot, prepareDeployment, setupInput,
} from './helpers/relayDeployment.js';
import { executedOsCommands, relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';
import { createHostKeyStore } from '../../server/src/lib/ssh/hostKeys.ts';
import { temporary } from '../relay/helpers.js';
import { readDeployment, waitDeployment } from './helpers/relayDeployment.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';

test('RD-SSH-04: error после ready закрывает preview без необработанного исключения', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const release = relayRelease();
  let connected;
  const f = await deploymentFixture(t, {
    transport: {
      probe: ssh.transport.probe,
      connect: async (input) => {
        connected = await ssh.transport.connect(input);

        return connected;
      },
    },
    deployment: { release: release.release },
  });
  const preview = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    },
  }), { password: ssh.password });

  assert.equal(preview.state, 'awaiting_confirmation');
  assert.doesNotThrow(() => connected.client.emit('error', new Error('RD_RESET_SENTINEL')));

  const interrupted = await waitDeployment(f, preview.id, ['interrupted']);

  assert.equal(interrupted.preview, undefined);
  assert.equal(interrupted.error.code, 'credentials_required');
  assert.equal(JSON.stringify(interrupted).includes('RD_RESET_SENTINEL'), false);
});

for (const encrypted of [false, true]) {
  test(`RD-SSH-01: настоящий SSH принимает ${encrypted ? 'зашифрованный' : 'обычный'} ключ`, async (t) => {
    const ssh = await relayDeploymentSsh(t, { keyOnly: true });
    let connection;

    await assert.doesNotReject(async () => {
      connection = await ssh.transport.connect({
        ...ssh.input,
        password: undefined,
        privateKey: encrypted ? ssh.encryptedKey : ssh.privateKey,
        ...(encrypted ? { passphrase: ssh.passphrase } : {}),
      });
    }, 'Transport обязан передать privateKey/passphrase работающему key-only SSH');

    try {
      assert.ok(ssh.authentications.some((attempt) => attempt.method === 'publickey'));
      assert.equal(ssh.authentications.some((attempt) => attempt.method === 'password'), false);
    } finally {
      // Клиент завершается до after-hook VPS, который обрывает оставшиеся сокеты.
      // Ожидание close исключает поздний EPIPE от одновременного закрытия обеих сторон.
      await new Promise((resolve) => {
        connection.once('close', resolve);
        connection.close();
      });
    }
  });
}

test('RD-SSH-02: отрицательный verifier закрывает SSH до передачи пароля', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const before = ssh.authentications.length;

  await assert.rejects(() => ssh.transport.connect({ ...ssh.input, hostVerifier: () => false }));
  assert.equal(ssh.authentications.length, before);
  assert.equal(ssh.commands.length, 0);
  assert.equal(ssh.writes.length, 0);
});

test('RD-SSH-02: challenge привязан к job/revision, reject и повтор не открывают credentials', async (t) => {
  const f = await deploymentFixture(t);
  const job = await createDeployment(f);
  const probe = await deploymentRequest(f, 'POST', `/${job.id}/probe`, { revision: job.revision });

  assert.ok([200, 202].includes(probe.statusCode), probe.body);

  const challenge = probe.json().hostKey ?? probe.json();
  const decision = {
    revision: challenge.revision ?? job.revision,
    challengeId: challenge.challengeId,
    decision: 'reject'
  };
  const rejected = await deploymentRequest(f, 'POST', `/${job.id}/host-key`, decision);

  assert.ok([200, 202].includes(rejected.statusCode), rejected.body);
  assert.equal((await deploymentRequest(f, 'POST', `/${job.id}/host-key`, decision)).statusCode, 409);
  assert.equal(f.calls.filter(([method]) => method === 'connect').length, 0);
});

for (const [name, platform] of Object.entries({
  ubuntu: {},
  debian: { id: 'debian', glibc: '2.28' },
  oldGlibc: { glibc: '2.27' },
  musl: { glibc: 'musl' },
  wrongOs: { id: 'fedora' },
  arm: { arch: 'aarch64' },
  missingLibrary: { missingLibrary: 'libstdc++.so.6' },
  noSystemd: { systemd: false },
  noSudo: { root: false, sudoDenied: true },
  busyPort: { portBusy: true },
})) {
  test(`RD-SSH-03: read-only preflight ${name} до любых системных изменений`, async (t) => {
    const ssh = await relayDeploymentSsh(t, { platform });
    const bytes = Buffer.from('#!/bin/sh\necho '
      + `"grigdesk-relay 0.3.0 (Node ${process.versions.node}, linux x64)"\n`);
    const file = path.join(ssh.root, 'artifact');

    await writeFile(file, bytes, { mode: 0o755 });

    const f = await deploymentFixture(t, {
      transport: ssh.transport,
      deployment: {
        resolveArtifact: async () => ({
          file,
          digest: createHash('sha256').update(bytes).digest('hex'),
        version: '0.3.0',
        })
      },
    });
    const before = await fileSnapshot(path.join(ssh.root, 'opt'));
    const job = await prepareDeployment(f, setupInput(f, {
      ssh: {
        host: '127.0.0.1',
        port: ssh.port,
        user: 'root',
      }
    }), { password: ssh.password });

    assert.equal(job.state, ['ubuntu', 'debian'].includes(name) ? 'awaiting_confirmation' : 'failed');
    assert.ok(ssh.commands.length > 0, 'Платформа действительно проверена через SSH');
    assert.equal(ssh.writes.length, 0, 'Предпроверка не устанавливает файлы');
    assert.deepEqual(await fileSnapshot(path.join(ssh.root, 'opt')), before);
    assert.equal((await executedOsCommands(ssh)).some(({ command, args }) => command === 'useradd'
      || command === 'systemctl' && args.some((arg) => ['start', 'enable'].includes(arg))), false);

    if (job.state === 'failed') {
      assert.equal(typeof job.error?.code, 'string', 'Отказ имеет безопасный код и следующий шаг');
    } else {
      assert.ok(job.preview.digest);
      assert.ok(job.preview.changes.length);
    }
  });
}

test('RD-SSH-04: binary credentials не появляются в DTO, файлах, SSE и ошибках', async (t) => {
  const f = await deploymentFixture(t);
  const job = await createDeployment(f);
  const secret = 'RD_SSH_PRIVATE_SECRET_SENTINEL';
  const response = await deploymentRequest(f, 'POST', `/${job.id}/credentials`,
    Buffer.from(JSON.stringify({ attemptId: 'credential-secret-01', password: secret })),
    { 'content-type': 'application/octet-stream' });
  const disk = Object.values(await fileSnapshot(f.directory))
    .map((value) => Buffer.from(value, 'base64').toString()).join('\n');

  assert.equal(response.body.includes(secret), false);
  assert.equal(disk.includes(secret), false);
  assert.equal(JSON.stringify([f.events, f.logs]).includes(secret), false);
  assert.equal(f.calls.filter(([method]) => method === 'connect').length, 0);
});

test('RD-SSH-03/04: неверный пароль даёт безопасный отказ без мутаций и утечек', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const f = await deploymentFixture(t, { transport: ssh.transport });
  const secret = 'RD_WRONG_PASSWORD_SENTINEL';
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    }
  }), { password: secret });

  assert.equal(job.state, 'failed');
  assert.equal(job.error.code, 'ssh_auth_failed');
  assert.equal(ssh.commands.length, 0);
  assert.equal(ssh.writes.length, 0);

  const disk = Object.values(await fileSnapshot(f.directory))
    .map((value) => Buffer.from(value, 'base64').toString()).join('\n');

  for (const value of [disk, JSON.stringify(job), JSON.stringify(f.events), JSON.stringify(f.logs)]) {
    assert.equal(value.includes(secret), false);
  }
});

test('RD-SSH-02: смена host key после trust блокирует auth до нового replace', async (t) => {
  const ssh = await relayDeploymentSsh(t);

  t.mock.method(ssh.transport, 'probe', async (input) => ({
    host: input.host,
    port: input.port,
    algorithm: 'ssh-rsa',
    fingerprint: 'SHA256:previous-server',
  }));

  const f = await deploymentFixture(t, { transport: ssh.transport });
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    }
  }), { password: ssh.password });

  assert.equal(job.state, 'failed');
  assert.equal(ssh.authentications.length, 0, 'Изменившийся SSH key отвергается до передачи credentials');
  assert.equal(ssh.writes.length, 0);
});

test('RD-SSH-02: истёкший challenge не принимает trust или секрет', async (t) => {
  const directory = await temporary(t);
  let now = Date.now();
  const hostKeys = await createHostKeyStore({
    file: path.join(directory, 'known-hosts.json'),
    now: () => now,
    challengeTtlMs: 50,
  });
  const f = await deploymentFixture(t, { directory, deployment: { hostKeys, now: () => now } });
  const job = await createDeployment(f);

  await deploymentRequest(f, 'POST', `/${job.id}/probe`, { revision: job.revision });

  const challenged = await waitDeployment(f, job.id, ['awaiting_host_key']);
  const challenge = challenged.hostKey ?? challenged.challenge;

  now += 51;

  const decision = await deploymentRequest(f, 'POST', `/${job.id}/host-key`, {
    revision: challenged.revision,
    challengeId: challenge.challengeId,
    decision: 'trust',
  });

  assert.equal(decision.statusCode, 409);
  assert.notEqual((await readDeployment(f, job.id)).state, 'awaiting_credentials');
  assert.equal(f.calls.filter(([method]) => method === 'connect').length, 0);
});

test('RD-SSH-04: oversized binary body и forwarded transport не принимают credentials', async (t) => {
  const f = await deploymentFixture(t);
  const job = await createDeployment(f);
  const huge = await deploymentRequest(f, 'POST', `/${job.id}/credentials`, Buffer.alloc(65537, 1), {
    'content-type': 'application/octet-stream',
  });

  assert.equal(huge.statusCode, 413);

  const secret = 'RD_FORWARDED_PASSWORD_SENTINEL';
  const forwarded = await deploymentRequest(f, 'POST', `/${job.id}/credentials`,
    Buffer.from(JSON.stringify({ attemptId: 'forwarded-attempt', password: secret })), {
    'content-type': 'application/octet-stream', 'x-forwarded-for': '192.0.2.1',
  });

  assert.ok(forwarded.statusCode >= 400 && forwarded.statusCode < 500);
  assert.equal(forwarded.body.includes(secret), false);
  assert.equal(f.calls.filter(([method]) => method === 'connect').length, 0);
});
