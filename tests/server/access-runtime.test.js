import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEW_KEY, OLD_KEY, activate, addProfile, deferred, profileFixture, profiles,
  runChat, saveChat, serverWorker,
} from '../helpers/accessProfiles.js';

test('AP06_snapshot_boundary: неизвестный адаптер получает неизменный снимок до spawn', async (t) => {
  const f = await profileFixture(t);
  const before = await profiles(f);
  const second = await addProfile(f);

  await saveChat(f);
  f.control.hold = deferred();
  f.control.entered = deferred();
  f.control.beforeSpawn = () => {
    f.env.DEEPSEEK_API_KEY = 'synthetic-env-mutated-before-spawn';
  };

  const running = runChat(f, {
    profileId: second.id,
    env: { DEEPSEEK_API_KEY: 'synthetic-forged-request-key' },
  });
  const first = await f.control.entered.promise;

  assert.equal(first.env.DEEPSEEK_API_KEY, OLD_KEY);
  assert.equal(first.snapshot.profileId, before.activeProfileId);

  const worker = await serverWorker(t, f);

  assert.equal((await worker('boot')).ready, true);

  const isolated = await worker('start', { poisonEnvironment: true });

  assert.equal(isolated.env.DEEPSEEK_API_KEY, OLD_KEY, 'process.env меняется до spawn в отдельном процессе');
  await worker('finish');
  f.control.hold.resolve();
  await running;
  await activate(f, second);
  f.control.hold = null;
  f.control.beforeSpawn = null;
  await runChat(f);

  const next = f.calls.at(-1);

  assert.equal(next.env.DEEPSEEK_API_KEY, NEW_KEY);
  assert.equal(next.snapshot.profileId, second.id);
  assert.equal(first.snapshot.profileId, before.activeProfileId, 'поздний результат остаётся ответом A');
  assert.equal(first.env.ZAI_API_KEY, undefined);
  assert.equal(first.env.ZAI_CODING_API_KEY, undefined);
  assert.equal(JSON.stringify(f.events).includes(OLD_KEY), false);
  assert.equal(JSON.stringify(f.events).includes(NEW_KEY), false);
});
