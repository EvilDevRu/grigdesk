import assert from 'node:assert/strict';
import { readFile, readdir, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  deploymentFixture, deploymentRequest, fileSnapshot, prepareDeployment, readDeployment,
  setupInput, startDeployment, waitDeployment,
} from './helpers/relayDeployment.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';
import { executedOsCommands, relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';
import { channelFixture } from './helpers/relayDeploymentChannel.js';
import { freePort } from './helpers/pluginBootFixture.js';

/**
 * Fixture меняет только внешний канал проверки другого шага, не installer или stores.
 * Системные файлы и systemctl-эффекты появляются от выполненного production shell по SSH.
 */
async function preview(t, options = {}) {
  const ssh = await relayDeploymentSsh(t, options);
  const release = relayRelease();
  const f = await deploymentFixture(t, {
    transport: ssh.transport,
    deployment: {
      release: release.release,
      verifyCandidate: async () => ({ verified: true, address: '127.0.0.1' }),
    },
  });
  const old = options.restore ? await f.mobile.addRelay({
    name: 'Старый доступ',
    host: '127.0.0.1',
    port: 443,
  }) : null;
  const job = await prepareDeployment(f, setupInput(f, {
    ...(old ? {
      mode: 'restore',
      name: undefined,
      relayId: old.id
    } : {}),
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    },
    public: { host: '127.0.0.1', port: options.publicPort ?? 443 }
  }), { password: ssh.password });

  assert.equal(job.state, 'awaiting_confirmation');

  return {
    f,
    ssh,
    release,
    job
  };
}

/**
 * Ожидается устойчивое окончание удалённого шага, а не раннее создание каталога.
 * Отдельный deadline ограничивает поломанный worker собственным тестом.
 */
async function installed(f, ssh, id) {
  const job = await waitDeployment(f, id,
    ['verifying', 'ready', 'failed', 'waiting_vpn', 'awaiting_dns', 'recovery_required']);
  const relayId = job.relayId;

  assert.equal(typeof relayId, 'string');

  const env = path.join(ssh.root, 'etc/grigdesk-relay', relayId, 'relay.env');
  const binary = path.join(ssh.root, 'opt/grigdesk-relay', relayId, 'grigdesk-relay');
  const unit = path.join(ssh.root, 'etc/systemd/system', `grigdesk-relay-${relayId}.service`);

  return {
    job,
    env,
    binary,
    unit
  };
}

test('RD-INSTALL-01: preview не пишет; start создаёт ELF/env0600/non-root unit и autostart', async (t) => {
  const { f, ssh, release, job } = await preview(t);

  assert.deepEqual(await readdir(path.join(ssh.root, 'opt')), []);
  assert.equal(ssh.writes.length, 0);
  await startDeployment(f, job);

  const files = await installed(f, ssh, job.id);
  const env = await readFile(files.env, 'utf8');
  const unit = await readFile(files.unit, 'utf8');

  assert.deepEqual(await readFile(files.binary), release.relay);
  assert.equal((await stat(files.env)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(files.env))).mode & 0o777, 0o700);
  assert.equal((await stat(files.binary)).mode & 0o777, 0o755);
  assert.match(env, /^RELAY_PORT=443$/mu, 'SSH-порт не становится портом relay');
  assert.match(unit, /^User=grigdesk-relay-/mu);
  assert.doesNotMatch(unit, /^User=root$/mu);

  for (const directive of [
    'NoNewPrivileges=true', 'PrivateTmp=true', 'PrivateDevices=true',
    'ProtectSystem=strict', 'ProtectHome=true', 'RestrictSUIDSGID=true',
    'Restart=on-failure', 'WantedBy=multi-user.target',
    'CapabilityBoundingSet=CAP_NET_BIND_SERVICE', 'AmbientCapabilities=CAP_NET_BIND_SERVICE',
  ]) {
    assert.ok(unit.includes(directive), directive);
  }

  const state = JSON.parse(await readFile(path.join(ssh.root, 'var/lib/os-state.json'), 'utf8'));

  assert.equal(state.users.length, 1);
  assert.deepEqual(Object.values(state.units), [{ active: true, enabled: true }]);
  assert.equal((await executedOsCommands(ssh)).some(({ command }) =>
    ['apt', 'apt-get', 'npm', 'docker', 'ufw', 'iptables'].includes(command)), false);
});

test('RD-INSTALL-02: replay потерянного start ACK создаёт одну службу и identity', async (t) => {
  const { f, ssh, job } = await preview(t);

  await Promise.all([
    startDeployment(f, job, 'lost-start-ack'),
    startDeployment(f, job, 'lost-start-ack'),
  ]);

  await installed(f, ssh, job.id);

  const before = await fileSnapshot(path.join(ssh.root, 'opt'));

  await startDeployment(f, job, 'lost-start-ack');
  assert.deepEqual(await fileSnapshot(path.join(ssh.root, 'opt')), before);
  assert.equal((await f.mobile.relays.list()).length, 1);

  const state = JSON.parse(await readFile(path.join(ssh.root, 'var/lib/os-state.json'), 'utf8'));

  assert.equal(state.users.length, 1);
  assert.equal(Object.keys(state.units).length, 1);
});

for (const conflict of ['port', 'marker', 'symlink', 'user', 'unit']) {
  test(`RD-INSTALL-02: чужой ${conflict} после preview не присваивается`, async (t) => {
    const { f, ssh, job } = await preview(t, { restore: true });
    const id = (await f.mobile.relays.list())[0].id;
    const foreign = path.join(ssh.root, 'opt/grigdesk-relay', id);

    await mkdir(path.dirname(foreign), { recursive: true });

    if (conflict === 'port') {
      await ssh.setPlatform({ portBusy: true });
    } else if (conflict === 'user') {
      await writeFile(path.join(ssh.root, 'var/lib/os-state.json'), JSON.stringify({
        users: [`grigdesk-relay-${id}`], units: {},
      }));
    } else if (conflict === 'unit') {
      await writeFile(path.join(ssh.root, 'etc/systemd/system', `grigdesk-relay-${id}.service`),
        '[Service]\nUser=nobody\nExecStart=/usr/bin/true\n');
    } else if (conflict === 'symlink') {
      await mkdir(path.join(ssh.root, 'foreign'));
      await symlink('/fixture/foreign', foreign);
    } else {
      await mkdir(foreign);
      await writeFile(path.join(foreign, 'foreign-owner'), 'Чужие данные');
    }

    const before = await fileSnapshot(path.join(ssh.root, 'opt'));

    await startDeployment(f, job);

    const failed = await waitDeployment(f, job.id, ['failed', 'recovery_required']);

    assert.notEqual(failed.state, 'ready');
    assert.deepEqual(await fileSnapshot(path.join(ssh.root, 'opt')), before);
    assert.equal(ssh.writes.length, 0, 'Повторная предпроверка должна отказать до upload');
  });
}

for (const command of ['upload', 'mv', 'install', 'daemon-reload', 'start']) {
  test(`RD-INSTALL-03: сбой ${command} оставляет точный rollback либо recovery_required`, async (t) => {
    const { f, ssh, job } = await preview(t, { failUpload: command === 'upload' });
    const before = await f.mobile.relays.list();

    await ssh.setPlatform({ failCommand: command });
    await startDeployment(f, job);

    const failed = await waitDeployment(f, job.id, ['failed', 'recovery_required']);

    assert.equal(failed.state === 'failed' || failed.state === 'recovery_required', true);
    assert.ok(failed.steps.some((step) => step.state === 'failed'));
    assert.deepEqual((await f.mobile.relays.list()).filter((relay) => relay.enabled), before);
    assert.notEqual((await readDeployment(f, job.id)).state, 'ready');
  });
}

// Откат свежей установки убирает owner, пользователя и пустые каталоги того же relay:
// повтор с новым секретом обязан проходить без ручной чистки VPS.
test('RD-INSTALL-04: повтор после сбоя первой установки проходит без чистки VPS', {
  timeout: 45000,
}, async (t) => {
  const { f, ssh, job } = await preview(t);

  await ssh.setPlatform({ failCommand: 'start' });
  await startDeployment(f, job);

  const failed = await waitDeployment(f, job.id, ['failed', 'recovery_required']);
  const draftReply = await deploymentRequest(f, 'POST', `/${job.id}/retry`, {
    requestId: 'retry-after-rollback',
    revision: failed.revision,
  });

  assert.ok([200, 202].includes(draftReply.statusCode), draftReply.body);

  const probe = await deploymentRequest(f, 'POST', `/${job.id}/probe`, {
    revision: draftReply.json().revision,
  });

  assert.ok([200, 202].includes(probe.statusCode), probe.body);

  const awaiting = await waitDeployment(f, job.id, ['awaiting_credentials']);
  const supplied = await deploymentRequest(f, 'POST', `/${job.id}/credentials`,
    Buffer.from(JSON.stringify({
      revision: awaiting.revision,
      attemptId: 'retry-after-rollback',
      password: ssh.password,
    })), { 'content-type': 'application/octet-stream' });

  assert.ok([200, 202].includes(supplied.statusCode), supplied.body);

  const confirmed = await waitDeployment(f, job.id, ['awaiting_confirmation']);

  await ssh.setPlatform({ failCommand: null });
  await startDeployment(f, confirmed, 'start-after-rollback');

  const ready = await waitDeployment(f, job.id, ['ready'], 15000);
  const binary = path.join(ssh.root, 'opt/grigdesk-relay', ready.relayId, 'grigdesk-relay');

  assert.equal((await stat(binary)).mode & 0o777, 0o755);
  assert.equal(ready.relayId, failed.relayId, 'Повтор использует прежний relay id');
});

// Первая установка работает через настоящий relay; отказ второй не вправе потерять её bytes.
// Прерванный reload может потребовать recovery, но не делает пустую конфигурацию допустимой.
test('RD-INSTALL-03: неудачная замена сохраняет прежние bytes/modes и active+enabled', {
  timeout: 45000,
}, async (t) => {
  const f = await channelFixture(t);
  const first = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root'
    },
    public: { host: '127.0.0.1', port: f.port },
  }), { password: f.ssh.password });

  await startDeployment(f, first);

  const ready = await waitDeployment(f, first.id, ['ready'], 15000);
  const locations = [
    `opt/grigdesk-relay/${ready.relayId}/grigdesk-relay`,
    `etc/grigdesk-relay/${ready.relayId}/relay.env`,
    `etc/systemd/system/grigdesk-relay-${ready.relayId}.service`,
  ];
  const before = await Promise.all(locations.map(async (file) => ({
    bytes: await readFile(path.join(f.ssh.root, file)),
    mode: (await stat(path.join(f.ssh.root, file))).mode & 0o777,
  })));
  const second = await prepareDeployment(f, setupInput(f, {
    requestId: 'restore-existing-vps',
    mode: 'restore',
    name: undefined,
    relayId: ready.relayId,
    ssh: {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root'
    },
    public: { host: '127.0.0.1', port: await freePort() },
  }), { password: f.ssh.password });

  await f.ssh.setPlatform({ failCommand: 'daemon-reload' });
  await startDeployment(f, second);
  await waitDeployment(f, second.id, ['failed', 'recovery_required']);

  const after = await Promise.all(locations.map(async (file) => ({
    bytes: await readFile(path.join(f.ssh.root, file)),
    mode: (await stat(path.join(f.ssh.root, file))).mode & 0o777,
  })));

  assert.deepEqual(after, before);

  const state = JSON.parse(await readFile(path.join(f.ssh.root, 'var/lib/os-state.json'), 'utf8'));

  assert.equal(state.units[`grigdesk-relay-${ready.relayId}.service`].active, true);
  assert.equal(state.units[`grigdesk-relay-${ready.relayId}.service`].enabled, true);
});

test('RD-INSTALL-01: непривилегированный порт не получает CAP_NET_BIND_SERVICE', async (t) => {
  const { f, ssh, job } = await preview(t, { publicPort: 16443 });

  await startDeployment(f, job);

  const files = await installed(f, ssh, job.id);
  const unit = await readFile(files.unit, 'utf8');
  const env = await readFile(files.env, 'utf8');

  assert.match(env, /^RELAY_PORT=16443$/mu);
  assert.match(unit, /^User=grigdesk-relay-/mu);
  assert.match(unit, /^CapabilityBoundingSet=\s*$/mu);
  assert.doesNotMatch(unit, /CAP_NET_BIND_SERVICE/u);
});
