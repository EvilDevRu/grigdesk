import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  CODING_KEY, NEW_KEY, OLD_KEY, activate, addProfile, apiAdapters, deferred, eventually,
  active, profileFixture, profiles, resolvedAdapter, syntheticAdapter, vendorServer,
} from '../helpers/accessProfiles.js';
import { oauthFixture, replaceOauth } from '../helpers/accessOauthFixture.js';
import { getExecutors } from '../../server/src/lib/executors/index.ts';
import { getModelsRegistry } from '../../server/src/lib/modelsRegistry.ts';
import { accessEnvironment } from '../../server/src/lib/accessProfiles/runtime.ts';

/**
 * Читаются лишь журналы текущего временного каталога, без знания их физического layout.
 * Сэмплы старого доступа не должны оказаться в файлах scope нового профиля.
 */
async function journals(directory) {
  const result = [];

  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      result.push(...await journals(file));
    } else if (entry.name === 'balance-log.json') {
      result.push({ file, body: JSON.parse(await fs.readFile(file, 'utf8')) });
    }
  }

  return result;
}

test('AP21_model_cache: переключение отзывает готовый и запоздалый каталог аккаунта', async (t) => {
  const f = await profileFixture(t, { modelsRegistry: getModelsRegistry });
  const executors = await getExecutors();
  const original = new Map(executors);
  const entered = deferred();
  const release = deferred();
  let hold = false;

  t.after(() => {
    release.resolve();
    executors.clear();

    for (const [id, executor] of original) {
      executors.set(id, executor);
    }
  });

  f.adapters.get('synthetic-access').catalog = async () => {
    const account = accessEnvironment().DEEPSEEK_API_KEY === OLD_KEY ? 'a' : 'b';

    if (hold) {
      hold = false;
      entered.resolve();
      await release.promise;
    }

    return [{ id: `account-${account}-model`, efforts: [] }];
  };
  executors.clear();
  executors.set('synthetic-access', await resolvedAdapter(f));
  await profiles(f);

  const second = await addProfile(f);
  const first = await f.request('GET', '/api/providers?wait=1');

  assert.equal(first.providers[0].models[0].id, 'account-a-model');
  hold = true;

  const late = getModelsRegistry(f.config, { refresh: true });

  await entered.promise;
  await activate(f, second);
  release.resolve();

  assert.equal((await late)['synthetic-access'][0].id, 'account-b-model');

  const changed = await f.request('GET', '/api/providers?wait=1');

  assert.equal(changed.providers[0].accessProfiles.activeProfile.id, second.id);
  assert.equal(changed.providers[0].models[0].id, 'account-b-model');
  assert.equal(JSON.parse(await fs.readFile(f.config.modelsPath, 'utf8'))
    ['synthetic-access'][0].id, 'account-b-model');

  const file = JSON.parse(await fs.readFile(f.config.modelsPath, 'utf8'));

  file['synthetic-access'][0].modelRefAliases = ['previous-model-id'];
  await fs.writeFile(f.config.modelsPath, JSON.stringify(file));

  const selected = await f.app.accessProfiles.select('synthetic-access', false);

  await f.app.accessProfiles.observe('synthetic-access', selected.snapshot, {}, true);

  const refreshed = await getModelsRegistry(f.config);

  assert.deepEqual(refreshed['synthetic-access'][0].modelRefAliases, ['previous-model-id'],
    'same-account refresh сохраняет алиасы моделей старых чатов');
});

test('AP21_late_account_results: задержанный ответ A не меняет баланс, журнал и SSE профиля B', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_793_911_111_111 });

  for (const failure of [false, true]) {
    await t.test(failure ? 'поздняя ошибка A' : 'поздний успех A', async (t) => {
      const vendor = await vendorServer(t);
      const env = { DEEPSEEK_API_KEY: OLD_KEY };
      const neighbor = {
        ...syntheticAdapter(),
        id: 'usage-neighbor',
        accessProfiles: undefined,
        usage: async () => ({
          state: 'rate_limited',
          message: 'Пауза соседнего исполнителя',
          bars: [{
            key: 'neighbor',
            label: 'Сосед',
            pct: 73
          }],
        }),
      };
      const f = await profileFixture(t, {
        env,
        vendor,
        adapters: [...apiAdapters(env, vendor), neighbor],
      });

      await profiles(f, 'deepseek');

      const second = await addProfile(f, 'deepseek', NEW_KEY);

      vendor.control.hold = deferred();
      vendor.control.entered = deferred();
      vendor.control.total = '111.00';
      vendor.control.status = failure ? 429 : 200;

      const oldRead = f.request('GET', '/api/providers/usage');

      await vendor.control.entered.promise;

      const oldHold = vendor.control.hold;

      vendor.control.hold = null;
      vendor.control.total = '222.00';
      vendor.control.status = 200;
      await activate(f, second, 'deepseek');
      oldHold.resolve();
      await oldRead;

      const current = await eventually(
        () => f.request('GET', '/api/providers/usage'),
        (value) => value.usage.deepseek?.resources?.some((resource) => resource.balance?.amount === 222),
        'баланс выбранного B',
      );

      assert.equal(current.usage.deepseek.resources.some((resource) =>
        resource.balance?.amount === 111), false);
      assert.equal(current.usage['usage-neighbor'].state, 'rate_limited');
      assert.equal(current.usage['usage-neighbor'].bars[0].pct, 73);

      const scoped = (await journals(f.root)).filter((item) => item.file.includes(second.id));

      assert.ok(scoped.length > 0, 'постоянный журнал имеет scope выбранного профиля');
      assert.ok(scoped.every((item) => item.body.samples.every((sample) => sample.total !== 111)));
      assert.equal(JSON.stringify(f.events).includes(OLD_KEY), false);
      assert.equal(JSON.stringify(f.events).includes(NEW_KEY), false);
    });
  }
});

test('AP21_late_account_results: поздний API GLM не подмешивает баланс в Coding Plan', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_793_911_111_111 });

  const vendor = await vendorServer(t);
  const env = { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: OLD_KEY };
  const f = await profileFixture(t, {
    env,
    vendor,
    adapters: apiAdapters(env, vendor)
  });

  await profiles(f, 'glm');

  const coding = await addProfile(f, 'glm', CODING_KEY, 'coding-plan');

  vendor.control.hold = deferred();
  vendor.control.entered = deferred();
  vendor.control.total = '111.00';

  const oldRead = f.request('GET', '/api/providers/usage');

  await vendor.control.entered.promise;

  const held = vendor.control.hold;

  vendor.control.hold = null;
  await activate(f, coding, 'glm');
  held.resolve();
  await oldRead;

  const current = await f.request('GET', '/api/providers/usage');

  assert.ok(vendor.calls.some((call) => call.path.endsWith('/quota/limit')
    && call.authorization === CODING_KEY));
  assert.equal(current.usage.glm.resources.some((item) => item.balance?.amount === 111), false);
});

test('AP21_late_account_results: поздние auth и catalog A не возвращаются в карточку B', async (t) => {
  for (const kind of ['auth', 'catalog']) {
    await t.test(kind, async (t) => {
      const held = deferred();
      const entered = deferred();

      t.after(() => held.resolve());

      let holdNext = false;
      let f;
      const oldMarker = `obsolete-profile-a-${kind}`;
      const currentMarker = `selected-profile-b-${kind}`;
      const adapter = syntheticAdapter();

      adapter[kind] = async () => {
        const obsolete = holdNext;

        if (obsolete) {
          holdNext = false;
          entered.resolve();
          await held.promise;
        }

        return kind === 'auth'
          ? {
            mode: 'env',
            available: !obsolete,
            label: obsolete ? oldMarker : currentMarker,
          }
          : [{ id: obsolete ? oldMarker : currentMarker, efforts: [] }];
      };
      f = await profileFixture(t, {
        adapters: [adapter],
        modelsRegistry: async (config) => ({
          [adapter.id]: await (await resolvedAdapter(f)).catalog(config),
        }),
      });
      await profiles(f);

      const second = await addProfile(f);

      holdNext = true;

      const oldRead = f.request('GET', '/api/providers?wait=1');

      await Promise.race([entered.promise, oldRead.then(() => assert.fail(`${kind} не вызван`))]);
      await activate(f, second);

      const eventStart = f.events.length;

      held.resolve();
      await oldRead;

      const current = await eventually(
        () => f.request('GET', '/api/providers?wait=1'),
        (value) => JSON.stringify(value).includes(currentMarker),
        `карточка B после позднего ${kind} A`,
      );
      const card = current.providers.find((item) => item.id === adapter.id);

      assert.equal(JSON.stringify(card).includes(oldMarker), false);
      assert.equal(card.available, true);
      assert.equal(JSON.stringify(f.events.slice(eventStart)).includes(oldMarker), false);
      assert.equal((await profiles(f)).activeProfileId, second.id);
    });
  }
});

test('AP21_late_account_results: refresh A после выбора B не меняет его auth, лимиты и SSE', async (t) => {
  const held = deferred();
  const entered = deferred();

  t.after(() => held.resolve());

  const f = await oauthFixture(t);
  const first = active(await profiles(f, 'claude'));
  const second = await replaceOauth(f);
  const answer = f.vendor.control.answer;

  f.vendor.control.answer = async (call) => {
    if (call.path === '/v1/oauth/token') {
      entered.resolve();
      await held.promise;

      return {
        access_token: 'synthetic-obsolete-a-refresh',
        refresh_token: 'synthetic-obsolete-a-refresh-token',
        expires_in: 3600,
      };
    }

    return answer(call);
  };

  const oldRead = f.request('GET', '/api/providers/usage');

  await Promise.race([entered.promise, oldRead.then(() => assert.fail('refresh A не начался'))]);
  await activate(f, second, 'claude');

  const selected = active(await profiles(f, 'claude'));
  const eventStart = f.events.length;
  const callStart = f.vendor.calls.length;

  held.resolve();
  await oldRead;
  await f.request('GET', '/api/providers/usage');
  await f.restart();

  const usage = await f.request('GET', '/api/providers/usage');

  const newReads = f.vendor.calls.slice(callStart).filter((call) => call.path !== '/v1/oauth/token');

  assert.notEqual(selected.id, first.id);
  assert.deepEqual(active(await profiles(f, 'claude')), selected);
  assert.ok(newReads.some((call) => call.authorization === 'Bearer synthetic-cli-secret-token'));
  assert.equal(newReads.some((call) => call.authorization === 'Bearer synthetic-obsolete-a-refresh'), false);
  assert.equal(JSON.stringify(f.events.slice(eventStart)).includes('synthetic-obsolete-a-refresh'), false);
  assert.equal(usage.usage.claude.state, 'ok');
  assert.ok(usage.usage.claude.bars.some((bar) => bar.key === 'session' && bar.pct === 12));
  assert.equal(usage.usage.claude.bars.some((bar) => bar.pct === 91), false);
  assert.equal(f.calls.length, 0);
});
