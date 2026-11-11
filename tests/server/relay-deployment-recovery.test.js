import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createDeployment, deploymentFixture, deploymentRequest, fileSnapshot, prepareDeployment,
  readDeployment, setupInput, startDeployment, waitDeployment,
} from './helpers/relayDeployment.js';
import { relayRelease } from './helpers/relayDeploymentRelease.js';
import { relayDeploymentSsh } from './helpers/relayDeploymentSsh.js';
import { temporary } from '../relay/helpers.js';
import { channelFixture } from './helpers/relayDeploymentChannel.js';

test('RD-RECOVER-01: потерянный create ACK, два клиента и повтор не выпускают две identity', async (t) => {
  const f = await deploymentFixture(t);
  const input = setupInput(f);

  await deploymentRequest(f, 'POST', '', input);

  const [first, repeat] = await Promise.all([createDeployment(f, input), createDeployment(f, input)]);

  assert.equal(first.id, repeat.id);
  assert.deepEqual(await readDeployment(f, first.id), repeat);
  assert.equal((await f.mobile.relays.list()).length, 0);

  const competing = await deploymentRequest(f, 'POST', '', { ...input, requestId: 'different-client' });

  assert.equal(competing.statusCode, 409);
});

test('RD-RECOVER-01: закрытие HTTP-клиента после 202 не отменяет server-owned worker', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const release = relayRelease();
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

  await f.app.listen({ host: '127.0.0.1', port: 0 });

  const origin = `http://127.0.0.1:${f.app.server.address().port}`;
  const response = await fetch(`${origin}/api/mobile/deployments/${job.id}/start`, {
    method: 'POST',
    headers: { cookie: 'grigdesk_sid=first', 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: 'closed-client-start',
      revision: job.revision,
      previewDigest: job.preview.digest,
    }),
  });

  assert.equal(response.status, 202);
  await response.body.cancel();

  const next = await waitDeployment(f, job.id,
    ['verifying', 'ready', 'failed', 'awaiting_dns', 'waiting_vpn', 'recovery_required']);
  const second = await deploymentRequest(f, 'GET', `/${job.id}`, undefined,
    { cookie: 'grigdesk_sid=second' });

  assert.equal(second.statusCode, 200);
  assert.ok(next.steps.some((step) => step.state === 'completed' || step.state === 'succeeded'));
  assert.ok(ssh.writes.length > 0, 'Сервер продолжил принятую установку без клиента');
});

test('RD-RECOVER-02: новый owner читает тот же journal без SSH и ложного ready', async (t) => {
  const f = await deploymentFixture(t);
  const relay = await f.mobile.addRelay({
    name: 'Дом',
    host: '127.0.0.1',
    port: 443
  });
  const job = await createDeployment(f, setupInput(f, {
    mode: 'restore',
    relayId: relay.id,
    name: undefined
  }));
  const before = await fileSnapshot(path.join(f.directory, 'relays'));

  await f.mobile.close();

  const restarted = await deploymentFixture(t, { directory: f.directory });
  const recovered = await readDeployment(restarted, job.id);

  assert.notEqual(recovered.state, 'ready');
  assert.equal(restarted.calls.length, 0, 'Boot не возобновляет SSH без нового секрета');
  assert.deepEqual(await fileSnapshot(path.join(f.directory, 'relays')), before);
  assert.equal((await restarted.mobile.relays.list())[0].id, relay.id);
});

test('RD-RECOVER-03: restart/TTL требуют новый секрет, unauthorized retry не вызывает SSH', async (t) => {
  let now = Date.now();
  const ssh = await relayDeploymentSsh(t);
  const release = relayRelease();
  const f = await deploymentFixture(t, {
    transport: ssh.transport,
    deployment: { release: release.release, now: () => now },
  });
  const job = await prepareDeployment(f, setupInput(f, {
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root',
    }
  }), { password: ssh.password });

  now += 300001;

  const expired = await deploymentRequest(f, 'POST', `/${job.id}/start`, {
    requestId: 'expired-start',
    revision: job.revision,
    previewDigest: job.preview.digest,
  });

  assert.equal(expired.statusCode, 409);
  assert.equal(ssh.writes.length, 0);
  await f.mobile.close();

  const restarted = await deploymentFixture(t, { directory: f.directory });
  const retry = await deploymentRequest(restarted, 'POST', `/${job.id}/retry`, {
    requestId: 'unauthorized-retry', revision: job.revision,
  }, { cookie: 'grigdesk_sid=revoked' });

  assert.equal(retry.statusCode, 401);
  assert.equal(restarted.calls.length, 0);

  const disk = Object.values(await fileSnapshot(f.directory))
    .map((value) => Buffer.from(value, 'base64').toString()).join('\n');

  for (const secret of [ssh.password, ssh.privateKey, ssh.passphrase]) {
    assert.equal(disk.includes(secret), false);
    assert.equal(JSON.stringify([f.events, f.logs]).includes(secret), false);
  }
});

test('RD-RECOVER-04: SSH-обрыв не очищает старый маршрут и показывает interrupted/recovery', async (t) => {
  const ssh = await relayDeploymentSsh(t);
  const release = relayRelease();
  const f = await deploymentFixture(t, {
    transport: ssh.transport, deployment: { release: release.release },
  });
  const relay = await f.mobile.addRelay({
    name: 'Старый доступ',
    host: '127.0.0.1',
    port: 8443
  });
  const before = await fileSnapshot(path.join(f.directory, 'relays'));
  const env = await f.mobile.relayEnv(relay.id);
  const job = await prepareDeployment(f, setupInput(f, {
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    ssh: {
      host: '127.0.0.1',
      port: ssh.port,
      user: 'root'
    },
  }), { password: ssh.password });

  await startDeployment(f, job);
  ssh.disconnect();

  const failed = await waitDeployment(f, job.id, ['interrupted', 'recovery_required', 'failed']);

  assert.notEqual(failed.state, 'ready');
  assert.equal(await f.mobile.relayEnv(relay.id), env);
  assert.deepEqual(await fileSnapshot(path.join(f.directory, 'relays')), before);
  assert.equal((await f.mobile.relays.list())[0].port, 8443);

  const journal = await readFile(path.join(f.directory, 'relay-deployments.json'), 'utf8');

  assert.equal(journal.includes(ssh.password), false);
});

for (const pauseCommand of ['useradd', 'mv', 'daemon-reload', 'start']) {
  test(`RD-RECOVER-02: boot из durable снимка на remote-границе ${pauseCommand}`, async (t) => {
    const ssh = await relayDeploymentSsh(t, { platform: { pauseCommand } });
    const release = relayRelease();
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

    await startDeployment(f, job);
    await waitRemoteBarrier(ssh);

    const copy = await temporary(t);

    await cp(f.directory, copy, { recursive: true });

    const keys = await fileSnapshot(path.join(copy, 'relays'));
    const restarted = await deploymentFixture(t, { directory: copy });
    const recovered = await readDeployment(restarted, job.id);

    assert.ok(['interrupted', 'recovery_required'].includes(recovered.state), JSON.stringify(recovered));
    assert.equal(restarted.calls.length, 0, 'Пароль утрачен: boot не возобновляет SSH');
    assert.deepEqual(await fileSnapshot(path.join(copy, 'relays')), keys);
    assert.ok(recovered.steps.length > 0, 'Журнал сохраняет выполненные и неопределённые шаги');
    await ssh.release();
  });
}

/**
 * Снимок снимается только после наблюдаемой OS-границы в настоящем SSH installer.
 * Новый owner читает копию private-каталога; рабочее дерево и исходные данные не откатываются.
 */
async function waitRemoteBarrier(ssh) {
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    const reached = await readFile(path.join(ssh.root, 'barrier'), 'utf8').catch(() => '');

    if (reached) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  assert.fail('Production installer не достиг ожидаемой remote-границы');
}

// Конкурирующее значение появляется до promotion; rollback не имеет права его затереть.
// Это проверяет CAS на уровне настоящего private store и работающего канала кандидата.
test('RD-RECOVER-04: третье CAS-значение сохраняется при recovery_required', {
  timeout: 45000,
}, async (t) => {
  const f = await channelFixture(t, { ssh: { platform: { pauseCommand: 'start' } } });
  const relay = await f.mobile.addRelay({
    name: 'Старый маршрут',
    host: '127.0.0.1',
    port: 8443
  });
  const job = await prepareDeployment(f, setupInput(f, {
    mode: 'restore',
    name: undefined,
    relayId: relay.id,
    ssh: {
      host: '127.0.0.1',
      port: f.ssh.port,
      user: 'root'
    },
    public: { host: '127.0.0.1', port: f.port },
  }), { password: f.ssh.password });

  await startDeployment(f, job);
  await waitRemoteBarrier(f.ssh);

  const document = JSON.parse(await readFile(f.mobile.relays.file, 'utf8'));
  const third = {
    ...document.relays[0],
    host: '127.0.0.3',
    port: 9443
  };

  document.relays[0] = third;
  await writeFile(f.mobile.relays.file, JSON.stringify(document));
  await f.ssh.release();
  await waitDeployment(f, job.id, ['recovery_required'], 15000);
  assert.deepEqual((await f.mobile.relays.list())[0], third);
});

for (const phase of ['before', 'after']) {
  test(`RD-RECOVER-02: boot ${phase} durable CAS не выдаёт ложный ready`, {
    timeout: 45000,
  }, async (t) => {
    let release;
    let reached;
    const pause = new Promise((resolve) => release = resolve);
    const barrier = new Promise((resolve) => reached = resolve);

    t.after(() => release());

    const f = await channelFixture(t);
    const rename = fs.rename.bind(fs);

    t.mock.method(fs, 'rename', async (source, target) => {
      const data = target === f.mobile.relays.file
        ? JSON.parse(await readFile(source, 'utf8')) : null;

      if (!data?.relays?.some((relay) => relay.enabled)) {
        return rename(source, target);
      }

      if (phase === 'after') {
        await rename(source, target);
      }

      reached();
      await pause;

      if (phase === 'before') {
        await rename(source, target);
      }
    });

    const job = await prepareDeployment(f, setupInput(f, {
      ssh: {
        host: '127.0.0.1',
        port: f.ssh.port,
        user: 'root'
      },
      public: { host: '127.0.0.1', port: f.port },
    }), { password: f.ssh.password });

    await startDeployment(f, job);
    await Promise.race([barrier, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Не достигнут durable CAS')), 10000);

      timer.unref();
    })]);

    const copy = await temporary(t);

    await cp(f.directory, copy, { recursive: true });

    const keys = await fileSnapshot(path.join(copy, 'relays'));
    const restarted = await deploymentFixture(t, { directory: copy });
    const recovered = await readDeployment(restarted, job.id);

    assert.ok(['interrupted', 'recovery_required'].includes(recovered.state), JSON.stringify(recovered));
    assert.equal(restarted.calls.length, 0);
    assert.deepEqual(await fileSnapshot(path.join(copy, 'relays')), keys);
    release();
  });
}

test('RD-RECOVER-01: потерянный retry ACK не повторяет worker и не меняет receipt', async (t) => {
  const release = relayRelease();
  const f = await deploymentFixture(t, { deployment: { release: release.release } });
  const failed = await prepareDeployment(f, setupInput(f), { password: 'RD_RETRY_SECRET_SENTINEL' });

  assert.equal(failed.state, 'failed');

  const input = { requestId: 'retry-lost-ack', revision: failed.revision };
  const first = await deploymentRequest(f, 'POST', `/${failed.id}/retry`, input);
  const repeated = await deploymentRequest(f, 'POST', `/${failed.id}/retry`, input);

  assert.ok([200, 202].includes(first.statusCode), first.body);
  assert.equal(repeated.statusCode, first.statusCode);
  assert.deepEqual(repeated.json(), first.json());
  assert.equal((await f.mobile.relays.list()).length, 0);

  const conflict = await deploymentRequest(f, 'POST', `/${failed.id}/retry`, {
    ...input, revision: failed.revision + 1,
  });

  assert.equal(conflict.statusCode, 409);
});
