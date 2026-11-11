import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEW_KEY, apiMethod, base, createAttempt, deferred, operationId,
  profileFixture, profiles, settled, submit,
} from '../helpers/accessProfiles.js';

test('AP07_duplicate_and_stale: одна попытка, один ввод, старый шаг не меняет результат', async (t) => {
  const f = await profileFixture(t);
  const list = await profiles(f);
  const method = apiMethod(list);
  const createId = operationId();
  const attempts = await Promise.all([
    createAttempt(f, 'synthetic-access', method, { operationId: createId }),
    createAttempt(f, 'synthetic-access', method, { operationId: createId }),
  ]);

  assert.equal(attempts[0].id, attempts[1].id);
  assert.equal(attempts[0].step.id, attempts[1].step.id);
  assert.ok(Date.parse(attempts[0].expiresAt) > Date.now());

  const input = { [method.fields.find((field) => field.kind === 'secret').id]: NEW_KEY };
  const submitId = operationId();
  const before = f.vendor.calls.length;

  await submit(f, 'synthetic-access', attempts[0], input, submitId);

  const done = await settled(f, 'synthetic-access', attempts[0]);
  const reads = f.vendor.calls.length;

  assert.ok(reads > before, 'ключ проверен поставщиком');
  await submit(f, 'synthetic-access', attempts[0], input, submitId);
  assert.equal(f.vendor.calls.length, reads, 'повтор доставки не повторяет проверку');
  await submit(f, 'synthetic-access', attempts[0], input, operationId(), 409);
  assert.deepEqual(await f.request('GET', `${base()}/attempts/${done.id}`), done);
  assert.equal((await profiles(f)).profiles.length, list.profiles.length + 1);
});

test('AP08_auth_and_restart: права проверяются на чтении, повторе и после рестарта', async (t) => {
  const f = await profileFixture(t, { auth: true });
  const list = await profiles(f);
  const method = apiMethod(list);
  const attempt = await createAttempt(f, 'synthetic-access', method);

  await f.request('GET', base(), undefined, 401, false);
  await f.request('GET', `${base()}/attempts/${attempt.id}`, undefined, 401, false);
  await f.restart();

  const restored = await f.request('GET', `${base()}/attempts/${attempt.id}`);

  assert.equal(restored.id, attempt.id);
  assert.ok(['interrupted', 'saved'].includes(restored.state));
  assert.equal(JSON.stringify(restored).includes(NEW_KEY), false);
  f.revoke();
  await f.request('GET', `${base()}/attempts/${attempt.id}`, undefined, 401);
  await f.request('POST', `${base()}/attempts/${attempt.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: restored.revision,
  }, 401);
});

test('AP07_duplicate_and_stale: истёкший шаг не применяется, retry получает новый срок', async (t) => {
  let now = Date.now();
  const f = await profileFixture(t, { now: () => now });
  const list = await profiles(f);
  const method = apiMethod(list);
  const attempt = await createAttempt(f, 'synthetic-access', method);

  now = Date.parse(attempt.expiresAt) + 1;

  const expired = await f.request('GET', `${base()}/attempts/${attempt.id}`);

  assert.equal(expired.state, 'expired');
  await submit(f, 'synthetic-access', attempt, { code: 'expired-code' }, operationId(), 409);

  const retry = await f.request('POST', `${base()}/attempts/${attempt.id}/retry`, {
    operationId: operationId(),
    expectedRevision: expired.revision,
  });

  assert.notEqual(retry.id, attempt.id);
  assert.ok(Date.parse(retry.expiresAt) > now);
  assert.equal((await profiles(f)).activeProfileId, list.activeProfileId);
});

test('AP08_auth_and_restart: поздний успех поставщика после cancel не публикует профиль', async (t) => {
  const f = await profileFixture(t);
  const before = await profiles(f);
  const method = apiMethod(before);
  const attempt = await createAttempt(f, 'synthetic-access', method);

  f.vendor.control.hold = deferred();
  f.vendor.control.entered = deferred();

  const submitting = submit(f, 'synthetic-access', attempt, {
    [method.fields.find((field) => field.kind === 'secret').id]: NEW_KEY,
  });

  await f.vendor.control.entered.promise;

  const verifying = await f.request('GET', `${base()}/attempts/${attempt.id}`);

  await f.request('POST', `${base()}/attempts/${attempt.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: verifying.revision,
  });
  f.vendor.control.hold.resolve();
  await submitting;

  const result = await f.request('GET', `${base()}/attempts/${attempt.id}`);

  assert.equal(result.state, 'cancelled');
  assert.deepEqual(await profiles(f), before);
  await f.restart();
  assert.equal((await f.request('GET', `${base()}/attempts/${attempt.id}`)).state, 'cancelled');
});

test('AP07_duplicate_and_stale: команда, home и env не задаются пользователем', async (t) => {
  const f = await profileFixture(t);
  const list = await profiles(f);
  const method = apiMethod(list);

  for (const extra of [
    { command: '/bin/sh' },
    { home: '/outside-profile' },
    { env: { DEEPSEEK_API_KEY: 'synthetic-forged-key' } },
  ]) {
    await f.request('POST', `${base()}/attempts`, {
      operationId: operationId(),
      name: 'Неподдерживаемые поля',
      methodId: method.id,
      ...extra,
    }, 400);
  }

  assert.equal(f.vendor.calls.length, 0, 'отказ до внешнего эффекта');
});

test('AP07_operation_id: свойства прототипа не принимаются за идентификатор операции', async (t) => {
  const f = await profileFixture(t);
  const list = await profiles(f);

  for (const operationId of ['__proto__', 'constructor', 'toString']) {
    await f.request('POST', `${base()}/attempts`, {
      operationId,
      methodId: apiMethod(list).id,
      name: 'Не создаётся',
    }, 400);
    await f.request('GET', `${base()}/operations/${operationId}`, undefined, 404);
  }

  const response = await f.request('GET', `${base()}/attempts`);

  assert.equal(response.attempts.length, 0);
});
