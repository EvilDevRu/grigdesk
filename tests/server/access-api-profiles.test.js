import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CODING_KEY, NEW_KEY, OLD_KEY, activate, active, addProfile, apiAdapters, apiMethod,
  createAttempt, profileFixture, profiles, settled, submit, vendorServer,
} from '../helpers/accessProfiles.js';

test('AP09_api_modes: GLM API и Coding сохраняют разные ключи, маршруты и активный доступ', async (t) => {
  const vendor = await vendorServer(t);
  const env = {
    GRIGDESK_GLM_API_MODE: 'api',
    ZAI_API_KEY: OLD_KEY,
    DEEPSEEK_API_KEY: NEW_KEY
  };
  const f = await profileFixture(t, {
    env,
    vendor,
    adapters: apiAdapters(env, vendor)
  });
  const initial = await profiles(f, 'glm');
  const api = active(initial);
  const coding = await addProfile(f, 'glm', CODING_KEY, 'coding-plan');

  assert.equal((await profiles(f, 'glm')).activeProfileId, api.id);
  await activate(f, coding, 'glm');
  vendor.calls.length = 0;
  await f.request('GET', '/api/providers/usage');

  assert.ok(vendor.calls.some((call) => call.path.endsWith('/quota/limit')));
  assert.ok(vendor.calls.filter((call) => call.path.startsWith('/api/'))
    .every((call) => call.authorization === CODING_KEY));
  assert.equal(JSON.stringify(vendor.calls).includes(OLD_KEY), false);
  assert.equal(JSON.stringify(vendor.calls.filter((call) => call.path.startsWith('/api/')))
    .includes(NEW_KEY), false);
  await activate(f, api, 'glm');
  vendor.calls.length = 0;
  await f.request('GET', '/api/providers/usage');
  assert.ok(vendor.calls.some((call) => call.path.endsWith('/zaiUserInfo')));
  assert.ok(vendor.calls.filter((call) => call.path.startsWith('/api/'))
    .every((call) => call.authorization === OLD_KEY));
  assert.equal((await profiles(f, 'glm')).profiles.length, 2);
});

test('AP10_api_failures: отказ, квота, частота, сеть и неизвестный режим различаются', async (t) => {
  const cases = [
    {
      label: '401',
      status: 401,
      state: 'auth_required'
    },
    {
      label: '403',
      status: 403,
      state: 'auth_required'
    },
    {
      label: 'нулевой баланс',
      total: '0.00',
      state: 'saved'
    },
    {
      label: 'частота',
      status: 429,
      state: 'rate_limited'
    },
    {
      label: 'сеть',
      network: true,
      state: 'unavailable'
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.label, async (t) => {
      const vendor = await vendorServer(t);
      const env = { DEEPSEEK_API_KEY: OLD_KEY };
      const f = await profileFixture(t, {
        env,
        vendor,
        adapters: apiAdapters(env, vendor)
      });
      const list = await profiles(f, 'deepseek');
      const method = apiMethod(list);
      const attempt = await createAttempt(f, 'deepseek', method);

      Object.assign(vendor.control, scenario);
      await submit(f, 'deepseek', attempt, {
        [method.fields.find((field) => field.kind === 'secret').id]: NEW_KEY,
      });

      const result = await settled(f, 'deepseek', attempt);

      assert.equal(result.state === 'saved' ? result.state : result.error?.code, scenario.state);
      assert.equal((await profiles(f, 'deepseek')).activeProfileId, list.activeProfileId);
      assert.equal(JSON.stringify(result).includes(NEW_KEY), false);
      assert.ok(vendor.calls.length <= 4, 'повторяются лишь ограниченные безопасные чтения');
    });
  }

  await t.test('неподдерживаемый способ не начинает login', async (t) => {
    const f = await profileFixture(t);

    await profiles(f);
    await f.request('POST', '/api/providers/synthetic-access/access-profiles/attempts', {
      operationId: 'unsupported-method',
      name: 'Неизвестный режим',
      methodId: 'not-declared',
    }, 400);
    assert.equal(f.vendor.calls.length, 0);
  });
});
