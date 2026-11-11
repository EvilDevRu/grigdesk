import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEW_KEY, OLD_KEY, activate, addProfile, operationId, profileFixture, profiles,
  runChat, saveChat, serverWorker,
} from '../helpers/accessProfiles.js';
import { liveAdapter } from '../helpers/accessLiveAdapter.js';

test('AP03_launch_switch_race: два процесса допускают запуск и переключение в одном порядке', async (t) => {
  const f = await profileFixture(t);

  await profiles(f);

  const second = await addProfile(f);
  const revision = (await profiles(f)).revision;
  const left = await serverWorker(t, f);
  const right = await serverWorker(t, f);

  assert.equal((await left('boot')).ready, true);
  assert.equal((await right('boot')).ready, true);

  const [launch, switching] = await Promise.all([
    left('start'),
    right('activate', {
      profileId: second.id,
      revision,
      operationId: operationId()
    }),
  ]);

  assert.equal(launch.started, true, launch.error);
  assert.ok([200, 409].includes(switching.status), JSON.stringify(switching));

  if (switching.status === 200) {
    assert.equal(launch.env.DEEPSEEK_API_KEY, NEW_KEY, 'переключение завершилось до допуска запуска');
  } else {
    assert.equal(launch.env.DEEPSEEK_API_KEY, OLD_KEY, 'reservation сохранила A до конца работы');
    assert.notEqual((await profiles(f)).activeProfileId, second.id);
  }

  await left('finish');
  await activate(f, second);
  assert.equal((await profiles(f)).activeProfileId, second.id);
});

test('AP04_busy_matrix: running, permission, background, sleep и service запрещают switch', async (t) => {
  for (const state of ['running', 'permission', 'background', 'sleep']) {
    await t.test(state, async (t) => {
      const control = {};
      const adapter = await liveAdapter(t, control);
      const f = await profileFixture(t, { adapters: [adapter] });

      control.fixture = f;

      const before = await profiles(f);
      const second = await addProfile(f);

      await saveChat(f);
      await runChat(f);
      await control.enter(state);

      const refusal = await activate(f, second, 'synthetic-access', {}, 409);

      assert.ok(refusal.message, 'сервер объясняет запрет переключения');
      assert.equal((await profiles(f)).activeProfileId, before.activeProfileId);
      assert.equal(control.handles[0].alive, true, 'занятый процесс не убивается ради switch');
      await control.leave();
      await activate(f, second);
    });
  }

  await t.test('service в другом процессе', async (t) => {
    const f = await profileFixture(t);

    await profiles(f);

    const second = await addProfile(f);
    const worker = await serverWorker(t, f);

    await worker('boot');
    assert.equal((await worker('service')).started, true);
    await activate(f, second, 'synthetic-access', {}, 409);
    await worker('finish');
    await activate(f, second);
  });
});

test('AP05_idle_child: ACK переключения приходит после выхода собственного старого CLI', async (t) => {
  const control = {};
  const adapter = await liveAdapter(t, control);
  const f = await profileFixture(t, { adapters: [adapter] });

  await profiles(f);

  const second = await addProfile(f);

  await saveChat(f);
  await runChat(f);

  const previous = control.handles[0];

  assert.equal(previous.alive, true);
  await activate(f, second);
  assert.equal(previous.alive, false, 'свободный CLI старого профиля завершён до ACK');
  assert.throws(() => process.kill(previous.pid, 0), { code: 'ESRCH' });
  await runChat(f);
  assert.equal(control.handles.length, 2);
  assert.equal(control.environments[1].DEEPSEEK_API_KEY, NEW_KEY);
});
