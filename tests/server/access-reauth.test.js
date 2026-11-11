import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEW_KEY, OLD_KEY, UNKNOWN_WARNING, activate, active, addProfile, apiAdapters, apiMethod,
  base, createAttempt, deferred, operationId, profileFixture, profiles, saveChat, serverWorker,
  settled, submit, vendorServer,
} from '../helpers/accessProfiles.js';
import { oauthFixture, replaceOauth } from '../helpers/accessOauthFixture.js';

/**
 * Верификацию выполняет production API-driver с настоящей схемой поставщика.
 * Меняется лишь HTTP-транспорт, идентичность и commit тест не вычисляет.
 */
async function apiFixture(t, provider) {
  const vendor = await vendorServer(t);
  const env = provider === 'deepseek'
    ? { DEEPSEEK_API_KEY: OLD_KEY }
    : { GRIGDESK_GLM_API_MODE: 'api', ZAI_API_KEY: OLD_KEY };

  vendor.control.customers = { [OLD_KEY]: 'C-1', [NEW_KEY]: 'C-1' };

  const f = await profileFixture(t, {
    env,
    vendor,
    adapters: apiAdapters(env, vendor)
  });
  const list = await profiles(f, provider);

  await saveChat(f, provider);

  return {
    f,
    list,
    profile: active(list),
    method: apiMethod(list, provider === 'glm' ? 'api' : undefined)
  };
}

/**
 * Повторный ключ попадает только в текущий шаг уже существующего профиля.
 * Чтения результата не повторяют submit и не подменяют evidence поставщика.
 */
async function reauthenticate(f, provider, profile, method) {
  const attempt = await createAttempt(f, provider, method, { profileId: profile.id });

  await submit(f, provider, attempt, {
    [method.fields.find((field) => field.kind === 'secret').id]: NEW_KEY,
  });

  return settled(f, provider, attempt);
}

async function history(f) {
  return (await f.request('GET', '/api/chat/store/chat/access-chat')).chat.messages;
}

/**
 * Заголовок поставщика проверяется у реального loopback-получателя.
 * Ни spy снимка, ни локальная копия ключа не считаются доказательством выбранного доступа.
 */
async function assertSelectedKey(f, provider, key) {
  f.vendor.calls.length = 0;
  await f.request('GET', '/api/providers/usage');

  const requests = f.vendor.calls.filter((call) => provider === 'deepseek'
    ? call.path === '/user/balance' : call.path.startsWith('/api/'));
  const authorization = provider === 'deepseek' ? `Bearer ${key}` : key;

  assert.ok(requests.length > 0, 'снимок проверяется настоящим сетевым чтением');
  assert.ok(requests.every((call) => call.authorization === authorization));
}

test('AP15_deepseek_unknown_requires_confirmation: проверенный ключ не заменяется до выбора', async (t) => {
  const { f, profile, method } = await apiFixture(t, 'deepseek');
  const messages = await history(f);
  const candidate = await reauthenticate(f, 'deepseek', profile, method);

  assert.equal(candidate.step.kind, 'choice');
  assert.equal(candidate.step.message, UNKNOWN_WARNING);
  assert.notEqual(candidate.state, 'saved');
  assert.deepEqual(active(await profiles(f, 'deepseek')), profile);
  assert.deepEqual(await history(f), messages);
  await assertSelectedKey(f, 'deepseek', OLD_KEY);

  const confirmId = operationId();

  await submit(f, 'deepseek', candidate, { choice: 'confirm' }, confirmId);

  const result = await settled(f, 'deepseek', candidate);
  const after = active(await profiles(f, 'deepseek'));

  assert.equal(result.state, 'saved');
  assert.equal(after.id, profile.id);
  assert.ok(after.revision > profile.revision);
  assert.ok(after.accountGeneration > profile.accountGeneration);
  assert.deepEqual(await history(f), messages);
  await submit(f, 'deepseek', candidate, { choice: 'confirm' }, confirmId);
  assert.deepEqual(active(await profiles(f, 'deepseek')), after);
  await assertSelectedKey(f, 'deepseek', NEW_KEY);
  assert.equal(JSON.stringify(result).includes(NEW_KEY), false);
  assert.equal(JSON.stringify(result).includes('secretRef'), false);
});

test('AP15_deepseek_cancel_and_late_confirm: отмена необратима для позднего результата', async (t) => {
  const { f, profile, method } = await apiFixture(t, 'deepseek');
  const before = await profiles(f, 'deepseek');
  const messages = await history(f);
  const candidate = await reauthenticate(f, 'deepseek', profile, method);

  assert.equal(candidate.step.kind, 'choice');
  await f.request('POST', `${base('deepseek')}/attempts/${candidate.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: candidate.revision,
  });
  await submit(f, 'deepseek', candidate, { choice: 'confirm' }, operationId(), 409);
  await f.restart();
  assert.deepEqual(await profiles(f, 'deepseek'), before);
  assert.deepEqual(await history(f), messages);
  await assertSelectedKey(f, 'deepseek', OLD_KEY);
});

test('AP15_deepseek_confirm_keeps_inactive: повторный вход P не активирует его вместо Q', async (t) => {
  const { f, profile, method } = await apiFixture(t, 'deepseek');
  const other = await addProfile(f, 'deepseek', 'synthetic-other-profile-key');

  await activate(f, other, 'deepseek');

  const candidate = await reauthenticate(f, 'deepseek', profile, method);

  assert.equal(candidate.step.kind, 'choice');
  await submit(f, 'deepseek', candidate, { choice: 'confirm' });
  assert.equal((await settled(f, 'deepseek', candidate)).state, 'saved');

  const after = await profiles(f, 'deepseek');

  assert.equal(after.activeProfileId, other.id);
  assert.equal(after.profiles.find((item) => item.id === profile.id).id, profile.id);
  await assertSelectedKey(f, 'deepseek', 'synthetic-other-profile-key');
});

test('AP15_glm_same_account_refresh: customerNumber сохраняет аккаунт при замене ключа', async (t) => {
  const { f, profile, method } = await apiFixture(t, 'glm');
  const messages = await history(f);
  const result = await reauthenticate(f, 'glm', profile, method);
  const after = active(await profiles(f, 'glm'));

  assert.equal(result.state, 'saved');
  assert.equal(after.id, profile.id);
  assert.equal(after.accountGeneration, profile.accountGeneration);
  assert.ok(after.revision > profile.revision);
  assert.deepEqual(await history(f), messages);
  await assertSelectedKey(f, 'glm', NEW_KEY);
  assert.equal(JSON.stringify(result).includes('C-1'), false);
  assert.equal(JSON.stringify(result).includes(NEW_KEY), false);
});

test('AP15_glm_revoked_legacy: отказ старого ключа требует выбора, но не блокирует новый', async (t) => {
  const { f, profile, method } = await apiFixture(t, 'glm');
  const messages = await history(f);

  f.app.accessProfiles.options.fetchImpl = (url, init) => {
    if (new Headers(init.headers).get('authorization') === OLD_KEY) {
      return Promise.resolve(new Response('{}', { status: 401 }));
    }

    return f.vendor.fetchImpl(url, init);
  };

  const candidate = await reauthenticate(f, 'glm', profile, method);

  assert.equal(candidate.step.kind, 'choice');
  assert.equal(candidate.step.reason, 'account_unknown');
  assert.deepEqual(active(await profiles(f, 'glm')), profile);
  await submit(f, 'glm', candidate, { choice: 'confirm' });
  assert.equal((await settled(f, 'glm', candidate)).state, 'saved');
  assert.equal(active(await profiles(f, 'glm')).id, profile.id);
  assert.deepEqual(await history(f), messages);
  await assertSelectedKey(f, 'glm', NEW_KEY);
});

test('AP15_glm_account_mismatch: C-1 и C-2 различаются до commit, отмена сохраняет C-1', async (t) => {
  const { f, profile, method } = await apiFixture(t, 'glm');
  const messages = await history(f);

  f.vendor.control.customers[NEW_KEY] = 'C-2';

  const candidate = await reauthenticate(f, 'glm', profile, method);

  assert.equal(candidate.step.kind, 'choice');
  assert.equal(candidate.step.reason, 'account_mismatch');
  assert.deepEqual(active(await profiles(f, 'glm')), profile);
  await f.request('POST', `${base('glm')}/attempts/${candidate.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: candidate.revision,
  });
  assert.deepEqual(active(await profiles(f, 'glm')), profile);

  const retry = await reauthenticate(f, 'glm', profile, method);

  await submit(f, 'glm', retry, { choice: 'confirm' });
  assert.equal((await settled(f, 'glm', retry)).state, 'saved');

  const after = active(await profiles(f, 'glm'));

  assert.equal(after.id, profile.id);
  assert.ok(after.accountGeneration > profile.accountGeneration);
  assert.deepEqual(await history(f), messages);
  await assertSelectedKey(f, 'glm', NEW_KEY);
});

test('AP16_refresh_serialization: общий профиль обновляется один раз двумя процессами', async (t) => {
  const f = await oauthFixture(t);

  const before = active(await profiles(f, 'claude'));
  const left = await serverWorker(t, f);
  const right = await serverWorker(t, f);

  await Promise.all([
    left('boot', { provider: 'claude' }),
    right('boot', { provider: 'claude' }),
  ]);
  await Promise.all([
    left('usage', { provider: 'claude' }),
    right('usage', { provider: 'claude' }),
  ]);

  assert.equal(f.vendor.calls.filter((call) => call.path === '/v1/oauth/token').length, 1);

  const after = active(await profiles(f, 'claude'));

  assert.equal(after.id, before.id);
  assert.equal(after.accountGeneration, before.accountGeneration);
  assert.ok(after.revision > before.revision);
  assert.equal(f.calls.length, 0, 'refresh не запускает полный ход агента');
});

test('AP16_refresh_serialization: поздний exchange не затирает новую credential revision', async (t) => {
  const hold = deferred();
  const entered = deferred();

  t.after(() => hold.resolve());

  const f = await oauthFixture(t);
  const before = active(await profiles(f, 'claude'));
  const answer = f.vendor.control.answer;

  f.vendor.control.answer = async (call) => {
    if (call.path === '/v1/oauth/token') {
      entered.resolve();
      await hold.promise;

      return {
        access_token: 'synthetic-obsolete-refresh-access',
        refresh_token: 'synthetic-obsolete-refresh-token',
        expires_in: 3600,
      };
    }

    return answer(call);
  };

  const oldRefresh = f.request('GET', '/api/providers/usage');

  await Promise.race([entered.promise, oldRefresh.then(() => assert.fail('refresh не начался'))]);

  const replaced = await replaceOauth(f, before);

  assert.ok(replaced.revision > before.revision);
  hold.resolve();
  await oldRefresh;
  assert.deepEqual(active(await profiles(f, 'claude')), replaced);
  await f.restart();
  await f.request('GET', '/api/providers/usage');

  const reads = f.vendor.calls.filter((call) => call.path !== '/v1/oauth/token');

  assert.ok(reads.some((call) => call.authorization === 'Bearer synthetic-cli-secret-token'));
  assert.equal(reads.some((call) => call.authorization === 'Bearer synthetic-obsolete-refresh-access'),
    false);
  assert.equal(f.vendor.calls.filter((call) => call.path === '/v1/oauth/token').length, 1);
  assert.deepEqual(active(await profiles(f, 'claude')), replaced);
  assert.equal(f.calls.length, 0, 'неизвестный результат exchange не повторяет ход');
});

test('AP16_refresh_serialization: revoked требует вход, сеть временна, другой профиль не запускается',
  async (t) => {
    for (const revoked of [true, false]) {
      await t.test(revoked ? 'revoked' : 'network', async (t) => {
        const f = await oauthFixture(t);
        const before = await profiles(f, 'claude');

        await saveChat(f, 'claude');
        f.vendor.control.status = revoked ? 400 : 200;
        f.vendor.control.network = !revoked;
        f.vendor.control.answer = () => ({ error: 'invalid_grant' });

        const result = await f.request('GET', '/api/providers/usage');

        assert.equal(result.usage.claude.state, revoked ? 'auth_required' : 'unavailable');
        assert.equal((await profiles(f, 'claude')).activeProfileId, before.activeProfileId);
        assert.equal(f.calls.length, 0);
        assert.ok((await history(f)).length > 0);
      });
    }
  });
