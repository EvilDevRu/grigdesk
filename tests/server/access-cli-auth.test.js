import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import {
  base, createAttempt, deferred, eventually, operationId, profiles, settled, submit,
} from '../helpers/accessProfiles.js';
import { cliFixture, cliRecords, cliStep } from '../helpers/accessCliFixture.js';
import { liveAdapter } from '../helpers/accessLiveAdapter.js';

test('AP11_cli_steps: код CLI вводится на сайте, открытая ссылка ещё не означает вход', async (t) => {
  for (const provider of ['codex', 'kimi']) {
    await t.test(provider, async (t) => {
      const f = await cliFixture(t, provider);
      const attempt = await createAttempt(f, provider, f.method, { client: { remote: true } });
      const displayed = await cliStep(f, attempt, 'display-code');

      assert.equal(displayed.step.code, 'CLI-SITE-1234');
      assert.equal(new URL(displayed.step.url).protocol, 'https:');
      assert.doesNotMatch(displayed.step.url, /localhost|127\.0\.0\.1/u);
      assert.notEqual(displayed.state, 'saved');
      assert.equal((await profiles(f, provider)).activeProfileId, f.list.activeProfileId);
      await fs.writeFile(path.join(f.root, 'complete'), 'Владелец завершил вход');

      const result = await settled(f, provider, attempt);
      const records = await cliRecords(f);

      assert.equal(result.state, 'saved');

      if (provider === 'codex') {
        assert.ok(records.some((call) => call.method === 'account/read'),
          'успех подтверждён программным чтением аккаунта');
      } else {
        assert.ok(records.some((call) => call.args?.[0] === 'login'));
        assert.equal(records.some((call) => call.input), false, 'device-code не отправляется в stdin');
      }

      assert.equal((await profiles(f, provider)).activeProfileId, f.list.activeProfileId);
      assert.equal(await fs.readFile(f.credentialFile, 'utf8'), f.credentialBytes);
      assert.equal(JSON.stringify(f.events).includes('synthetic-cli-secret-token'), false);
    });
  }
});

test('AP11_cli_steps: код сайта отправляется ровно ожидающему Claude, не другому login', async (t) => {
  const f = await cliFixture(t, 'claude');
  const first = await createAttempt(f, 'claude', f.method);
  const waiting = await cliStep(f, first, 'enter-code');
  const op = operationId();

  await submit(f, 'claude', waiting, { code: 'SITE-CLI-5678#fixture-state' }, op);
  assert.equal((await settled(f, 'claude', first)).state, 'saved');
  await submit(f, 'claude', waiting, { code: 'SITE-CLI-5678#fixture-state' }, op);

  const inputs = (await cliRecords(f)).filter((entry) => entry.input);

  assert.deepEqual(inputs.map((entry) => entry.input), ['SITE-CLI-5678#fixture-state']);
  assert.ok((await cliRecords(f)).some((entry) => entry.args?.includes('/login')),
    'ручной код в этой версии принимает TUI /login, не callback-only auth login');
  assert.equal(JSON.stringify(f.events).includes('SITE-CLI-5678#fixture-state'), false);
  assert.equal(await fs.readFile(f.credentialFile, 'utf8'), f.credentialBytes);
});

test('AP12_cli_cancel: terminal не освобождает доступ до выхода процесса login', async (t) => {
  const f = await cliFixture(t, 'codex');
  const attempt = await createAttempt(f, 'codex', f.method);
  const waiting = await cliStep(f, attempt, 'display-code');
  const driver = f.app.accessProfiles.drivers.get(attempt.id);
  const entered = deferred();
  const release = deferred();
  const originalCancel = driver.cancel.bind(driver);

  t.after(() => release.resolve());
  driver.cancel = async () => {
    entered.resolve();
    await release.promise;
    await originalCancel();
  };

  const cancellation = f.request('POST', `${base('codex')}/attempts/${attempt.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: waiting.revision,
  });

  await entered.promise;

  try {
    await assert.rejects(() => f.app.accessProfiles.select('codex'), { code: 'access_busy' });
    await f.request('POST', `${base('codex')}/${f.list.activeProfileId}/activate`, {
      operationId: operationId(),
      expectedRevision: f.list.revision,
    }, 409);
  } finally {
    release.resolve();
    await cancellation;
  }

  const selected = await f.app.accessProfiles.select('codex');

  assert.ok(selected);
  await selected.release();
});

test('AP12_cli_cancel_starting: отмена подготовки не оставляет поздний процесс login', async (t) => {
  const f = await cliFixture(t, 'codex', { holdVersion: true });
  const releaseFile = path.join(f.root, 'release-version');

  t.after(() => fs.writeFile(releaseFile, 'Продолжить').catch(() => {}));

  const creating = createAttempt(f, 'codex', f.method);

  await eventually(() => cliRecords(f).catch(() => []),
    (records) => records.some((record) => record.args?.includes('--version')),
    'подготовка CLI до spawn login');

  const { attempts } = await f.request('GET', `${base('codex')}/attempts`);
  const current = attempts[0];

  await f.request('POST', `${base('codex')}/attempts/${current.id}/cancel`, {
    operationId: operationId(),
    expectedRevision: current.revision,
  });
  await assert.rejects(() => f.app.accessProfiles.select('codex'), { code: 'access_busy' });
  await fs.writeFile(releaseFile, 'Продолжить');
  assert.equal((await creating).state, 'cancelled');

  const selected = await f.app.accessProfiles.select('codex');

  assert.ok(selected, 'допуск возвращается после остановки позднего child');
  await selected.release();
  assert.equal((await profiles(f, 'codex')).profiles.length, f.list.profiles.length);
});

test('AP12_cli_isolation: login B не меняет A, неизвестный протокол не принимает сырой ввод', async (t) => {
  for (const provider of ['codex', 'claude', 'kimi']) {
    await t.test(provider, async (t) => {
      const f = await cliFixture(t, provider, { unknown: true, version: '999.0.0' });
      const attempt = await createAttempt(f, provider, f.method);
      const result = await settled(f, provider, attempt);

      assert.equal(result.state, 'failed');
      assert.equal(result.error.code, 'unsupported');
      assert.equal((await profiles(f, provider)).activeProfileId, f.list.activeProfileId);
      assert.equal(await fs.readFile(f.credentialFile, 'utf8'), f.credentialBytes);
      assert.equal((await cliRecords(f)).some((entry) => entry.input), false);
      assert.equal(JSON.stringify(result).includes('synthetic-cli-secret-token'), false);
      assert.equal(JSON.stringify(f.events).includes('\u001b'), false);
    });
  }
});

test('AP12_cli_isolation: занятый основной CLI допускает добавление только при доказанной изоляции',
  async (t) => {
    const f = await cliFixture(t, 'codex');
    const control = {};
    const live = await liveAdapter(t, control);
    const adapter = f.adapters.get('codex');

    adapter.session = live.session;
    adapter.run = live.run;
    adapter.sessionBinding = live.sessionBinding;
    await f.request('PUT', '/api/chat/store/chat', {
      chat: {
        id: 'access-chat',
        revision: 0,
        modelRef: { provider: 'codex', model: 'fixture-model' },
        messages: [],
      },
    });
    await f.request('POST', '/api/chat', {
      chatKey: 'access-chat',
      modelRef: { provider: 'codex', model: 'fixture-model' },
      message: 'Начать разговор',
    });
    control.handles[0].spec.hooks.onBackgroundTasks([{
      id: 'waiting',
      kind: 'subagent',
      description: 'Ожидает',
    }]);

    const isolated = f.method.isolation === 'isolated';
    const response = await f.app.inject({
      method: 'POST',
      url: `${base('codex')}/attempts`,
      payload: {
        operationId: operationId(),
        name: 'Второй вход',
        methodId: f.method.id
      },
    });

    assert.equal(response.statusCode, isolated ? 200 : 409, response.body);
    assert.equal(await fs.readFile(f.credentialFile, 'utf8'), f.credentialBytes);
    assert.equal(control.handles[0].alive, true);
    control.handles[0].spec.hooks.onBackgroundTasks([]);
  });
