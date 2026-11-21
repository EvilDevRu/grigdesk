import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  deploymentRequest, fileSnapshot, prepareDeployment, retrySetup, setupInput, startDeployment, waitDeployment,
} from './helpers/relayDeployment.js';
import { channelFixture } from './helpers/relayDeploymentChannel.js';
import { issuePhone, phoneAdmin } from './helpers/phoneAccess.js';
import { relayRequest } from './helpers/phoneRelay.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';
import { freePort } from './helpers/pluginBootFixture.js';

test('RD-FORWARD-01: отказ после rename оставляет проверенный B и исходную identity', {
  timeout: 60000,
}, async (t) => {
  const keys = generateKeyPairSync('ed25519');
  let latest = relayRelease({ keys, version: '0.3.0' });
  let rejectProof = false;
  let f;
  let latestReads = 0;
  const deployment = {
    release: {
      publicKeyPem: latest.publicKeyPem,
      fetch: (...args) => {
        latestReads += 1;

        return latest.release.fetch(...args);
      },
    },
    verifyCandidate: async ({ relay }) => {
      if (rejectProof) {
        f.ssh.disconnect();

        throw new Error('RD_PROOF_INTERRUPTED');
      }

      return {
        verified: true,
        address: relay.host,
      };
    },
  };

  f = await channelFixture(t, { deployment });

  const { relay } = await deploy(f);
  const ssh = {
    host: '127.0.0.1',
    port: f.ssh.port,
    user: 'root',
  };
  const binary = path.join(f.ssh.root, 'opt/grigdesk-relay', relay.id, 'grigdesk-relay');
  const installedDigest = async () => createHash('sha256').update(await readFile(binary)).digest('hex');

  assert.equal(await installedDigest(), latest.artifact.files[1].sha256);

  latest = relayRelease({ keys, version: '0.4.0' });
  rejectProof = true;

  const job = await prepareDeployment(f, setupInput(f, {
    requestId: randomUUID(),
    ssh,
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    public: { host: '127.0.0.1', port: await freePort() },
  }), { password: f.ssh.password });

  await startDeployment(f, job);

  const suspended = await waitDeployment(f, job.id, ['recovery_required'], 20000);
  const pinned = latest.artifact.files[1].sha256;
  const writes = f.ssh.writes.length;
  const cert = await f.mobile.relayEnv(relay.id);

  assert.equal(await installedDigest(), pinned, 'После rename остаётся B');
  assert.deepEqual(await f.mobile.relay(relay.id), relay);
  assert.equal(suspended.error.code, 'relay_resume_required');
  await assert.rejects(() => f.mobile.removeRelay(relay.id), { code: 'deployment_busy' });

  const challenge = await f.hostKeys.check({
    ...ssh,
    algorithm: 'ssh-ed25519',
    fingerprint: 'SHA256:replacement-fixture',
  });

  await assert.rejects(
    () => f.hostKeys.decide(challenge.challengeId, 'replace'), { code: 'deployment_busy' },
  );
  await f.mobile.close();
  await f.stopVps();

  rejectProof = false;

  const reads = latestReads;

  latest = relayRelease({ keys, version: '0.5.0' });
  f = await channelFixture(t, {
    directory: f.directory,
    sshFixture: f.ssh,
    deployment,
  });

  const restored = await retrySetup(f, suspended);

  assert.equal(restored.preview.artifact.digest, pinned);
  await startDeployment(f, restored, randomUUID());
  await waitDeployment(f, job.id, ['ready'], 20000);
  assert.equal(latestReads, reads, 'Повтор не смотрит latest C');
  assert.equal(f.ssh.writes.length, writes, 'Полный B не загружается повторно');
  assert.equal(await installedDigest(), pinned);
  assert.equal(await f.mobile.relayEnv(relay.id), cert);

  latest = relayRelease({ keys, version: '0.3.0' });

  const declined = await prepareDeployment(f, setupInput(f, {
    requestId: randomUUID(),
    ssh,
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
  }), { password: f.ssh.password });

  assert.equal(declined.state, 'failed');
  assert.equal(declined.error.code, 'relay_release_floor');
  assert.equal(f.ssh.writes.length, writes);
});

/**
 * Публичный маршрут и адрес кандидата ведут на один изолированный VPS теста.
 * SSH использует loopback; публичный TEST-NET перенаправляется только на границе TCP.
 * После start ожидается proof владельца задания, а не результат отдельного healthcheck.
 */
async function deploy(f, extra = {}) {
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root'
    },
    public: { host: f.publicHost, port: f.port },
    candidateHost: f.publicHost,
    ...extra,
  }), { password: f.ssh.password });

  assert.equal(job.state, 'awaiting_confirmation');
  await startDeployment(f, job);

  const ready = await waitDeployment(f, job.id, ['ready'], 15000);
  const relay = (await f.mobile.relays.list()).find((item) => item.id === ready.relayId);

  assert.equal(f.serviceErrors.length, 0, f.serviceErrors.join('\n'));
  assert.ok(relay);

  return { job: ready, relay };
}

test('RD-CHANNEL-01: owner → SSH/install → control/data → private TLS; телефон отдельно', {
  timeout: 30000,
}, async (t) => {
  const f = await channelFixture(t, { publicRoute: true });
  const { job, relay } = await deploy(f);

  assert.equal(job.channel.state, 'verified');
  assert.equal((await f.devices.list()).length, 0, 'Self-probe не является телефоном');

  const qr = await issuePhone(f, { relayId: relay.id });
  const progress = () => phoneAdmin(f, 'GET', `/api/devices/phone-pairing/${qr.attemptId}`);

  assert.equal(qr.payload.relay.id, relay.id);
  assert.equal(qr.payload.relay.fp, relay.fp);
  assert.equal(qr.payload.relay.host, f.publicHost);
  assert.ok(f.vpnChecks.includes(f.publicHost), 'Публичный маршрут прошёл настоящий VPN guard');
  assert.ok(f.dialCount() > 0, 'Публичный маршрут перенаправлен только на границе TCP');
  assert.equal((await progress()).json().status, 'pending');

  const paired = await relayRequest(f, relay, '/api/client/pair', { code: qr.payload.pair.code });

  assert.equal(paired.status, 200);
  assert.equal((await progress()).json().status, 'pending');

  const hello = await relayRequest(f, relay, '/api/client/hello');

  assert.equal(hello.status, 200);
  assert.equal(hello.body.device.id, paired.body.device.id);
  assert.equal((await progress()).json().status, 'connected');
});

test('RD-CHANNEL-02: удалённый A заменён B на прежнем endpoint без нового pair', {
  timeout: 45000,
}, async (t) => {
  const first = await channelFixture(t, { publicRoute: true });
  const { relay } = await deploy(first);
  const qr = await issuePhone(first, { relayId: relay.id });
  const pair = await relayRequest(first, relay, '/api/client/pair', { code: qr.payload.pair.code });
  const before = await fileSnapshot(path.join(first.directory, 'relays'));

  await first.mobile.close();
  await first.stopVps();

  const next = await channelFixture(t, {
    directory: first.directory,
    port: first.port,
    publicRoute: true,
  });
  const restored = await deploy(next, {
    requestId: randomUUID(),
    mode: 'restore',
    name: undefined,
    relayId: relay.id
  });

  assert.deepEqual(await fileSnapshot(path.join(first.directory, 'relays')), before);
  assert.equal(restored.relay.fp, relay.fp);
  assert.equal(restored.relay.brainToken, relay.brainToken);
  assert.equal(restored.relay.deviceToken, relay.deviceToken);

  const hello = await relayRequest(next, restored.relay, '/api/client/hello', undefined, first.client);

  assert.equal(hello.status, 200);
  assert.equal(hello.body.device.id, pair.body.device.id);
  assert.equal((await next.devices.list()).length, 1);
});

test('RD-CHANNEL-03: новый endpoint после proof сохраняет сертификат и deviceId', {
  timeout: 45000,
}, async (t) => {
  const first = await channelFixture(t, { publicRoute: true });
  const { relay } = await deploy(first);
  const issued = await issuePhone(first, { relayId: relay.id });
  const pair = await relayRequest(first, relay, '/api/client/pair', { code: issued.payload.pair.code });

  await first.mobile.close();

  const next = await channelFixture(t, { directory: first.directory, publicRoute: true });
  const restored = await deploy(next, {
    requestId: randomUUID(),
    mode: 'restore',
    name: undefined,
    relayId: relay.id
  });
  const qr = await issuePhone(next, { relayId: relay.id });
  const repeat = await relayRequest(next, restored.relay, '/api/client/pair',
    { code: qr.payload.pair.code }, first.client);

  assert.notEqual(restored.relay.port, relay.port);
  assert.equal(restored.relay.fp, relay.fp);
  assert.equal(qr.payload.relay.host, next.publicHost);
  assert.equal(qr.payload.relay.port, next.port);
  assert.equal(repeat.body.device.id, pair.body.device.id);
  assert.equal((await next.devices.list()).length, 1);
});

test('RD-CHANNEL-04: VPN guard не публикует ready и сохраняет прежний route', {
  timeout: 45000,
}, async (t) => {
  const f = await channelFixture(t, { vpn: false, publicRoute: true });
  const relay = await f.mobile.addRelay({
    name: 'Прежний',
    host: f.publicHost,
    port: f.port
  });
  const before = await fileSnapshot(path.join(f.directory, 'relays'));

  assert.equal((await f.mobile.status()).relays[0].link.state, 'waiting_vpn');
  assert.ok(f.vpnChecks.includes(f.publicHost), 'Фикстура проверяет публичный маршрут до запуска job');
  assert.equal(f.dialCount(), 0);

  const job = await prepareDeployment(f, setupInput(f, {
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    ssh: {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root'
    },
    public: { host: f.publicHost, port: f.port },
    candidateHost: f.publicHost,
  }), { password: f.ssh.password });

  await startDeployment(f, job);

  // Проверка VPN следует после настоящих SSH, SFTP и установки службы во временном VPS.
  // Даём им 30 с при параллельном прогоне; требование задачи не задаёт скорость установки.
  const waiting = await waitDeployment(f, job.id, ['waiting_vpn'], 30000);

  assert.notEqual(waiting.state, 'ready');
  assert.deepEqual(await fileSnapshot(path.join(f.directory, 'relays')), before);
  assert.equal((await f.mobile.status()).relays[0].link.state, 'waiting_vpn');
  assert.ok(f.vpnChecks.includes(f.publicHost), 'Публичный адрес проверен настоящим VPN guard');
  assert.equal(f.dialCount(), 0, 'VPN guard проверяется до любого публичного TCP dial');

  const writes = f.ssh.writes.length;

  await f.mobile.close();
  await f.stopVps();

  const restarted = await channelFixture(t, {
    directory: f.directory,
    sshFixture: f.ssh,
    port: f.port,
    publicRoute: true,
  });
  const recovery = await waitDeployment(restarted, job.id, ['waiting_vpn']);

  await waitListener(restarted);

  const check = await deploymentRequest(restarted, 'POST', `/${job.id}/check`, {
    requestId: randomUUID(),
    revision: recovery.revision,
  });

  assert.equal(check.statusCode, 202, check.body);
  await waitDeployment(restarted, job.id, ['ready'], 15000);
  assert.equal(restarted.ssh.writes.length, writes);
  assert.equal((await restarted.mobile.relay(relay.id)).fp, relay.fp);
});

/**
 * Ждёт того же слушателя после создания нового владельца домашней части.
 * Мастер не управляет запуском VPS на этой ветке.
 */
async function waitListener(fixture) {
  const deadline = Date.now() + 5000;

  while (fixture.services.size === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.ok(fixture.services.size > 0, fixture.serviceErrors.join('\n'));
}

for (const peer of ['health-only', 'no-data', 'wrong-pin', 'legacy']) {
  test(`RD-CHANNEL-01/04: ${peer} не заменяет доказательство канала`, {
    timeout: 30000,
  }, async (t) => {
    const f = await channelFixture(t, { peer });
    const job = await prepareDeployment(f, setupInput(f, {
      ssh: {
        host: '127.0.0.1',
        port: f.ssh.port,
        user: 'root'
      },
      public: { host: '127.0.0.1', port: f.port },
    }), { password: f.ssh.password });

    await startDeployment(f, job);

    const failed = await waitDeployment(f, job.id, ['failed', 'recovery_required'], 20000);

    assert.notEqual(failed.channel.state, 'verified');
    assert.notEqual(failed.state, 'ready');
    assert.equal((await f.devices.list()).length, 0);
    assert.equal((await f.mobile.relays.list()).filter((relay) => relay.enabled).length, 0);
  });
}

// Два loopback-адреса моделируют прежний DNS, всё ещё ведущий на живой A, и новый B.
// На обоих VPS один pin: проверка только сертификата старого A дала бы ложный ready.
test('RD-CHANNEL-04: старый A с тем же pin не доказывает установку B', {
  timeout: 45000,
}, async (t) => {
  const first = await channelFixture(t);
  const { job: firstJob, relay } = await deploy(first);
  const env = await first.mobile.relayEnv(relay.id);

  await first.mobile.close();

  const next = await channelFixture(t, {
    directory: first.directory,
    port: first.port,
    listenHost: '127.0.0.2',
  });
  const before = await next.mobile.relays.list();
  const restoreInput = setupInput(next, {
    requestId: randomUUID(),
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    ssh: {
      host: '127.0.0.1',
      port: next.ssh.port,
      user: 'root'
    },
    public: { host: '127.0.0.1', port: relay.port },
    candidateHost: '127.0.0.2',
  });
  // Квитанция setup переживает смену владельца: другой смысл прежнего ID запрещён.
  // Независимое восстановление получает новый ID и доходит до проверки нового VPS.
  const conflict = await deploymentRequest(next, 'POST', '', {
    ...restoreInput,
    requestId: firstJob.requestId,
  });

  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().error, 'request_conflict');
  assert.deepEqual(await next.mobile.relays.list(), before);

  const job = await prepareDeployment(next, restoreInput, { password: next.ssh.password });

  assert.notEqual(job.id, firstJob.id);
  assert.notEqual(job.requestId, firstJob.requestId);

  await startDeployment(next, job);

  const waiting = await waitDeployment(next, job.id, ['awaiting_dns'], 15000);

  assert.notEqual(waiting.state, 'ready');
  assert.deepEqual(await next.mobile.relays.list(), before);
  assert.equal(await next.mobile.relayEnv(relay.id), env);
});
