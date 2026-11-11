import assert from 'node:assert/strict';
import test from 'node:test';

import deepseek from '../../server/src/lib/executors/deepseek.ts';
import {
  NEW_KEY, OLD_KEY, activate, active, addProfile, apiMethod, base, createAttempt,
  operationId, profileFixture, profiles, runChat, saveChat, settled, submit,
} from '../helpers/accessProfiles.js';
import { liveAdapter } from '../helpers/accessLiveAdapter.js';

test('AP17_chat_memory: unknown-confirm сохраняет историю и начинает новую сессию', async (t) => {
  const control = {};
  const adapter = await liveAdapter(t, control);
  const f = await profileFixture(t, { adapters: [adapter] });
  const list = await profiles(f);
  const profile = active(list);

  await saveChat(f);
  await runChat(f);

  const original = (await f.request('GET', '/api/chat/store/chat/access-chat')).chat;
  const firstSession = control.handles[0].spec.sessionId;
  const method = apiMethod(list);
  const attempt = await createAttempt(f, 'synthetic-access', method, { profileId: profile.id });

  await submit(f, 'synthetic-access', attempt, {
    [method.fields.find((item) => item.kind === 'secret').id]: NEW_KEY,
  });

  const candidate = await settled(f, 'synthetic-access', attempt);

  assert.equal(candidate.step.kind, 'choice');
  assert.equal(control.environments[0].DEEPSEEK_API_KEY, OLD_KEY);
  await submit(f, 'synthetic-access', candidate, { choice: 'confirm' });
  assert.equal((await settled(f, 'synthetic-access', candidate)).state, 'saved');
  await runChat(f);

  const after = (await f.request('GET', '/api/chat/store/chat/access-chat')).chat;

  assert.equal(control.handles[0].alive, false);
  assert.equal(control.handles.length, 2);
  assert.equal(control.handles[1].spec.sessionId, null, 'не обещается перенос памяти по auth-файлу');
  assert.equal(control.environments[1].DEEPSEEK_API_KEY, NEW_KEY);
  assert.deepEqual(after.messages.slice(0, original.messages.length), original.messages);
  assert.match(JSON.stringify(after.messages), /нов.{0,20}сесси|памят/iu);
  assert.equal((await profiles(f)).activeProfileId, profile.id);
  assert.equal(firstSession, null);
});

test('AP17_chat_memory: cancel reauth сохраняет прежнюю память, switch B объясняет новую', async (t) => {
  const control = {};
  const f = await profileFixture(t, { adapters: [await liveAdapter(t, control)] });
  const list = await profiles(f);
  const second = await addProfile(f);

  await saveChat(f);
  await runChat(f);

  const method = apiMethod(list);
  const attempt = await createAttempt(f, 'synthetic-access', method, { profileId: list.activeProfileId });

  await submit(f, 'synthetic-access', attempt, {
    [method.fields.find((item) => item.kind === 'secret').id]: NEW_KEY,
  });

  const candidate = await settled(f, 'synthetic-access', attempt);

  await f.request('POST', `${base()}/attempts/${candidate.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: candidate.revision,
  });
  await runChat(f);
  assert.equal(control.handles.length, 1, 'отмена не ротирует живую память');
  await activate(f, second);
  await runChat(f);
  assert.equal(control.handles[0].alive, false);
  assert.equal(control.handles[1].spec.sessionId, null);
});

test('AP18_work_lifecycle: needs-auth сохраняет историю и вход в GrigDesk без повтора хода', async (t) => {
  const f = await profileFixture(t, { auth: true });

  await profiles(f);
  await saveChat(f);
  await addProfile(f);

  const before = (await f.request('GET', '/api/chat/store/chat/access-chat')).chat;

  f.adapters.get('synthetic-access').usage = deepseek.usage;
  f.vendor.control.status = 401;
  await f.request('GET', '/api/providers/usage');

  const response = await f.app.inject({
    method: 'POST',
    url: '/api/chat',
    headers: { cookie: 'grigdesk_sid=access-test-session' },
    payload: {
      chatKey: 'access-chat',
      modelRef: { provider: 'synthetic-access', model: 'fixture-model' },
      message: 'Ход без входа',
    },
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error, /auth/u);
  assert.equal(f.calls.length, 0);

  const after = (await f.request('GET', '/api/chat/store/chat/access-chat')).chat;

  assert.deepEqual(after.messages, before.messages);
  assert.equal(active(await profiles(f)).authState, 'needs-auth');
});

test('AP18_work_auth_failure: отказ обычного хода блокирует следующий до входа', async (t) => {
  const f = await profileFixture(t);

  await profiles(f);
  await saveChat(f);

  f.control.error = Object.assign(new Error('Требуется вход'), { code: 'auth_required' });
  await runChat(f, {}, 500);

  assert.equal(active(await profiles(f)).authState, 'needs-auth');
  assert.equal(f.calls.length, 1);
  await runChat(f, {}, 409);
  assert.equal(f.calls.length, 1, 'неизвестный результат хода не повторяется');
});
