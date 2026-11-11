import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  createDeployment, deploymentFixture, deploymentRequest, fileSnapshot, setupInput,
} from './helpers/relayDeployment.js';

const reservation = { id: 'r12345678', enabled: false };
const input = {
  name: 'Дом',
  host: '127.0.0.1',
  port: 443
};

test('RD-ID-01: повтор reserved add сохраняет одну запись, PEM и токены', async (t) => {
  const f = await deploymentFixture(t);
  const first = await f.mobile.relays.add(input, reservation);
  const before = await fileSnapshot(f.directory);
  const repeat = await f.mobile.relays.add(input, reservation);

  assert.equal(first.id, reservation.id);
  assert.equal(first.enabled, false);
  assert.deepEqual(repeat, first);
  assert.equal((await f.mobile.relays.list()).length, 1);
  assert.deepEqual(await fileSnapshot(f.directory), before);
});

test('RD-ID-02: ошибка публикации списка повторно использует законченную identity', async (t) => {
  const f = await deploymentFixture(t);

  const rename = fs.rename.bind(fs);
  const fault = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === f.mobile.relays.file) {
      throw Object.assign(new Error('fixture_list_commit_failed'), { code: 'EIO' });
    }

    return rename(source, target);
  });

  await assert.rejects(() => f.mobile.relays.add(input, reservation));
  fault.mock.restore();

  const directory = path.join(f.directory, 'relays', reservation.id);
  const before = await fileSnapshot(directory).catch((error) => {
    assert.equal(error.code, 'ENOENT');

    return null;
  });

  assert.ok(before, 'reservation должна быть durable до публикации списка');

  const relay = await f.mobile.relays.add(input, reservation);

  assert.equal(relay.id, reservation.id);

  const pemOnly = (snapshot) => Object.fromEntries(Object.entries(snapshot)
    .filter(([name]) => name.endsWith('.pem')));

  assert.deepEqual(pemOnly(await fileSnapshot(directory)), pemOnly(before));

  const certFile = path.join(directory, 'relay-cert.pem');
  const cert = await readFile(certFile);

  await rm(path.join(directory, 'relay-key.pem'));
  await assert.rejects(() => f.mobile.relays.add(input, reservation));
  assert.deepEqual(await readFile(certFile), cert, 'partial identity не ротируется');
});

test('RD-ID-03: restore без старого VPS переиспользует домашний env', async (t) => {
  const f = await deploymentFixture(t);
  const relay = await f.mobile.addRelay(input);
  const env = await f.mobile.relayEnv(relay.id);
  const before = await fileSnapshot(path.join(f.directory, 'relays'));
  const job = await createDeployment(f, setupInput(f, {
    mode: 'restore',
    relayId: relay.id,
    name: undefined,
  }));

  assert.equal(job.relayId, relay.id);
  assert.equal(await f.mobile.relayEnv(relay.id), env);
  assert.deepEqual(await fileSnapshot(path.join(f.directory, 'relays')), before);
  assert.equal(f.calls.length, 0, 'старый VPS не нужен для чтения сохранённой identity');
});

test('RD-ID-04: удаление relay активного restore даёт busy без потери ключей', async (t) => {
  const f = await deploymentFixture(t);
  const relay = await f.mobile.addRelay(input);

  await createDeployment(f, setupInput(f, {
    mode: 'restore',
    relayId: relay.id,
    name: undefined
  }));

  const before = await fileSnapshot(path.join(f.directory, 'relays'));
  const result = await f.app.inject({
    method: 'DELETE',
    url: `/api/mobile/relays/${relay.id}`,
    headers: { cookie: 'grigdesk_sid=first' },
  });

  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error, 'deployment_busy');
  assert.equal((await f.mobile.relays.list()).length, 1);
  assert.deepEqual(await fileSnapshot(path.join(f.directory, 'relays')), before);

  const repeat = await deploymentRequest(f, 'GET');

  assert.equal(repeat.statusCode, 200);
});
