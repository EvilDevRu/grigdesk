import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDeployment, deploymentFixture, deploymentRequest, readDeployment, setupInput,
} from './helpers/relayDeployment.js';

test('RD-API-01: draft/read/replay, requestId не меняет смысл после потерянного ответа', async (t) => {
  const f = await deploymentFixture(t);
  const empty = await deploymentRequest(f, 'GET');

  assert.equal(empty.statusCode, 200, empty.body);
  assert.equal(empty.headers['cache-control'], 'no-store');
  assert.deepEqual(empty.json(), { jobs: [] }, 'ctl и desktop читают список из поля jobs');

  const input = setupInput(f);
  const first = await createDeployment(f, input);
  const repeat = await createDeployment(f, input);

  assert.equal(repeat.id, first.id);
  assert.equal(repeat.revision, first.revision);
  assert.deepEqual(await readDeployment(f, first.id), repeat);
  assert.equal((await f.mobile.relays.list()).length, 0, 'draft не выпускает identity');
  assert.equal(f.calls.length, 0, 'draft не подключается к VPS');

  const conflict = await deploymentRequest(f, 'POST', '', {
    ...input,
    public: { ...input.public, port: 8443 },
  });

  assert.equal(conflict.statusCode, 409, conflict.body);

  const found = await deploymentRequest(f, 'GET', `?requestId=${input.requestId}`);

  assert.equal(found.statusCode, 200);
  assert.deepEqual(found.json(), { jobs: [first] });

  const listed = await deploymentRequest(f, 'GET');
  const absent = await deploymentRequest(f, 'GET', '?requestId=unknown-request-0001');

  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json(), { jobs: [first] });
  assert.equal(absent.statusCode, 200, absent.body);
  assert.deepEqual(absent.json(), { jobs: [] });
});

test('RD-API-02: два клиента видят одну revision и один admission', async (t) => {
  const f = await deploymentFixture(t);
  const input = setupInput(f);
  const [one, two] = await Promise.all([createDeployment(f, input), createDeployment(f, input)]);

  assert.equal(one.id, two.id);

  const second = await deploymentRequest(f, 'GET', `/${one.id}`, undefined,
    { cookie: 'grigdesk_sid=second' });

  assert.equal(second.statusCode, 200);
  assert.equal(second.json().job?.revision ?? second.json().revision, one.revision);

  const competing = await deploymentRequest(f, 'POST', '', {
    ...input,
    requestId: 'different-request-0002',
    name: 'Конкурирующий доступ',
  });

  assert.equal(competing.statusCode, 409, competing.body);
  assert.ok(competing.body.includes(one.id));
  assert.equal((await f.mobile.relays.list()).length, 0);
});

test('RD-API-03: session-only и expectedServerFp проверяются до SSH', async (t) => {
  const f = await deploymentFixture(t);

  for (const headers of [
    { cookie: '' },
    { cookie: '', 'x-grigdesk-token': 'fixture-cli' },
    { cookie: '', 'x-grigdesk-internal': 'fixture-internal' },
    { cookie: 'grigdesk_sid=revoked' },
  ]) {
    const result = await deploymentRequest(f, 'POST', '', setupInput(f), headers);

    assert.equal(result.statusCode, headers['x-grigdesk-token'] || headers['x-grigdesk-internal']
      ? 403 : 401, result.body);
  }

  const wrong = await deploymentRequest(f, 'POST', '', setupInput(f, {
    expectedServerFp: 'f'.repeat(64),
  }));

  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.equal(f.calls.length, 0);
});

test('RD-API-03: ctl и desktop получают owner из сертификата домашнего сервера', async (t) => {
  const f = await deploymentFixture(t);
  const response = await f.app.inject({
    method: 'GET',
    url: '/api/mobile/status',
    headers: { cookie: 'grigdesk_sid=first' },
  });

  assert.equal(response.statusCode, 200, response.body);

  const { server } = response.json();

  // MobileService.start читает ensureBrainIdentity из того же временного directory.
  // Здесь нужен pin домашнего сертификата, которым затем проверяется expectedServerFp.
  assert.equal(server.fp, f.identity.fp, 'status должен отдавать owner обоим клиентам мастера');

  const job = await createDeployment(f, setupInput(f, { expectedServerFp: server.fp }));

  assert.equal(job.expectedServerFp, f.identity.fp);
  assert.equal(f.calls.length, 0, 'получение owner и создание draft не требуют SSH');
});

test('RD-API-03: чтение и все мутации требуют session до поиска job и SSH', async (t) => {
  const f = await deploymentFixture(t);
  const job = await createDeployment(f);

  for (const [method, suffix] of [
    ['GET', ''], ['GET', `/${job.id}`],
    ...['probe', 'host-key', 'credentials', 'start', 'retry', 'check']
      .map((action) => ['POST', `/${job.id}/${action}`]),
  ]) {
    for (const headers of [
      { cookie: '' },
      { cookie: '', 'x-grigdesk-token': 'fixture-cli' },
      { cookie: '', 'x-grigdesk-internal': 'fixture-internal' },
    ]) {
      const result = await deploymentRequest(f, method, suffix,
        method === 'GET' ? undefined : {}, headers);

      assert.equal(result.statusCode, Object.keys(headers).length === 1 ? 401 : 403,
        `${method} ${suffix}: ${result.body}`);
    }
  }

  assert.equal(f.calls.length, 0);
});
