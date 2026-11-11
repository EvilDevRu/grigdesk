import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  NEW_KEY, OLD_KEY, activate, addProfile, apiMethod, base, createAttempt, operationId,
  profileFixture, profiles, serverWorker, settled, submit, syntheticAdapter,
} from '../helpers/accessProfiles.js';

test('AP13_commit_recovery: отказ до durable commit сохраняет прежний активный доступ', async (t) => {
  for (const boundary of ['write', 'fsync', 'rename']) {
    await t.test(boundary, async (t) => {
      let armed = false;
      const f = await profileFixture(t, {
        fault(point) {
          if (armed && point === boundary) {
            throw Object.assign(new Error('Искусственный отказ диска'), { code: 'EIO' });
          }
        },
      });
      const before = await profiles(f);
      const method = apiMethod(before);
      const attempt = await createAttempt(f, 'synthetic-access', method);

      armed = true;
      await submit(f, 'synthetic-access', attempt, {
        [method.fields.find((item) => item.kind === 'secret').id]: NEW_KEY,
      });

      const result = await settled(f, 'synthetic-access', attempt);

      assert.notEqual(result.state, 'saved', 'ошибка диска не становится успехом login');
      armed = false;
      await f.restart();
      assert.equal((await profiles(f)).activeProfileId, before.activeProfileId);
      assert.equal(await fs.readFile(f.config.envPath, 'utf8'), `DEEPSEEK_API_KEY=${OLD_KEY}\n`);
    });
  }
});

test('AP14_lost_ack_and_delete: операция узнаётся чтением, stale окна и используемый профиль защищены',
  async (t) => {
    const f = await profileFixture(t);
    const before = await profiles(f);
    const second = await addProfile(f);
    const op = operationId();
    const activationRevision = (await profiles(f)).revision;

    await activate(f, second, 'synthetic-access', {
      operationId: op,
      expectedRevision: activationRevision,
    });
    await f.restart();

    const outcome = await f.request('GET', `${base()}/operations/${op}`);

    assert.equal(outcome.state, 'completed');
    assert.equal((await profiles(f)).activeProfileId, second.id);
    await activate(f, second, 'synthetic-access', {
      operationId: op,
      expectedRevision: activationRevision,
    });
    await activate(f, before.profiles[0], 'synthetic-access', {
      expectedRevision: before.revision,
    }, 409);
    await f.request('DELETE', `${base()}/${second.id}`, {
      operationId: operationId(),
      expectedRevision: second.revision,
    }, 409);
    assert.equal((await profiles(f)).activeProfileId, second.id);
  });

test('S8: старый POST не обходит профили, адаптер без capability сохраняет прежний маршрут', async (t) => {
  const f = await profileFixture(t);

  await profiles(f);

  const original = await fs.readFile(f.config.envPath, 'utf8');
  const refusal = await f.request('POST', '/api/providers/synthetic-access/credentials', {
    values: { DEEPSEEK_API_KEY: NEW_KEY },
  }, 409);

  assert.equal(refusal.error, 'profile_access_required');
  assert.equal(await fs.readFile(f.config.envPath, 'utf8'), original);
});

test('S8_barrier_legacy_credentials: без capability прежний ввод ключа остаётся рабочим', async (t) => {
  const legacy = {
    ...syntheticAdapter(),
    id: 'legacy-api',
    accessProfiles: undefined
  };
  const fallback = await profileFixture(t, { adapters: [legacy] });

  await fallback.request('POST', '/api/providers/legacy-api/credentials', {
    values: { DEEPSEEK_API_KEY: NEW_KEY },
  });
  assert.equal(fallback.env.DEEPSEEK_API_KEY, NEW_KEY);
});

test('AP13_commit_recovery: авария после manifest commit узнаётся без второго POST', async (t) => {
  const f = await profileFixture(t);
  const before = await profiles(f);
  const method = apiMethod(before);
  const attempt = await createAttempt(f, 'synthetic-access', method);
  const op = operationId();
  const worker = await serverWorker(t, f);

  assert.equal((await worker('boot', { faultPoint: 'after-manifest-commit' })).ready, true);
  await assert.rejects(() => worker('submit', {
    attempt,
    operationId: op,
    input: { [method.fields.find((field) => field.kind === 'secret').id]: NEW_KEY },
  }), /worker завершился/u);
  await f.restart();

  const result = await f.request('GET', `${base()}/operations/${op}`);
  const after = await profiles(f);

  assert.equal(result.state, 'completed');
  assert.equal(after.profiles.length, before.profiles.length + 1);
  assert.equal(after.activeProfileId, before.activeProfileId);
  assert.equal(f.vendor.calls.filter((call) => call.authorization === `Bearer ${NEW_KEY}`).length, 1);
});
