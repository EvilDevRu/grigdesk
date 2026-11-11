import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEW_KEY, OLD_KEY, activate, addProfile, profileFixture, profiles,
} from '../helpers/accessProfiles.js';
import { consumer } from '../helpers/accessConsumers.js';

test('AP19_all_consumers: каждый entrypoint использует выбранный доступ', async (t) => {
  const names = ['chat', 'service', 'modelText', 'inbox', 'meeting', 'showcase',
    'analysis', 'analysis-arbiter', 'factory-arbiter'];

  for (const name of names) {
    await t.test(name, async (t) => {
      const f = await profileFixture(t);

      f.adapters.get('synthetic-access').scopedWorkspace = true;
      await profiles(f);

      const second = await addProfile(f);
      const invoke = await consumer(f, name);

      await invoke();
      assert.ok(f.calls.length > 0, `${name} достиг внешней модельной границы`);
      assert.ok(f.calls.every((call) => call.env.DEEPSEEK_API_KEY === OLD_KEY));

      const count = f.calls.length;

      await activate(f, second);
      await invoke();
      assert.ok(f.calls.length > count, `${name} действительно запущен второй раз`);
      assert.ok(f.calls.slice(count).every((call) => call.env.DEEPSEEK_API_KEY === NEW_KEY));

      if (['service', 'modelText', 'inbox', 'meeting', 'showcase'].includes(name)) {
        assert.ok(f.calls.every((call) => !call.workspaceAccess), 'model-only не получил coding workspace');
      }
    });
  }
});
