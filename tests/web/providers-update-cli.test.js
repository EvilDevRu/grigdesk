import assert from 'node:assert/strict';
import { after, test } from 'node:test';

import { clientFixture, closeClientBrowser, card, job, snapshot } from './helpers/providerInstallFixture.js';

after(closeClientBrowser);

test('удачная установка называет обе версии и перечитывает реестр', async (t) => {
  const { providers, store, calls } = await clientFixture(t);

  await providers.updateCli(card.id);
  assert.equal(providers.updating, 'claude');
  store.applySnapshot(snapshot(null, 2, {
    claude: job({
      status: 'succeeded',
      after: '2.0.0',
      outcome: 'updated',
      finishedAt: 1_700_000_001_000
    }),
  }));
  await new Promise((resolve) => setImmediate(resolve));

  const result = providers.updateResults.claude;

  assert.equal(result.type, 'ok');
  assert.equal(result.changed, true);
  assert.match(result.text, /1\.0\.0.*2\.0\.0/u);
  assert.equal(providers.updating, '');
  assert.ok(calls.gets.includes('/api/providers?refresh=1'));
  assert.equal(calls.posts.length, 1);
  assert.equal(calls.posts[0].url, '/api/providers/claude/update/start');
});

test('чужая установка не начинается поверх идущей', async (t) => {
  const { providers, calls } = await clientFixture(t);

  await providers.updateCli('claude');
  assert.equal(providers.updating, 'claude');
  await providers.updateCli('codex');
  assert.equal(calls.posts.length, 1, 'Вторая установка ушла поверх серверного active');
  assert.equal(providers.updating, 'claude');
});

test('отказ установки доезжает текстом, а не молчанием', async (t) => {
  const { providers, store } = await clientFixture(t);

  await providers.updateCli('claude');
  store.applySnapshot(snapshot(null, 2, {
    claude: job({
      status: 'failed',
      error: {
        code: 'command_failed',
        message: 'npm ERR! code EACCES'
      },
      outputTail: 'npm ERR! code EACCES',
      finishedAt: 1_700_000_001_000,
    }),
  }));

  const result = providers.updateResults.claude;

  assert.equal(result.type, 'err');
  assert.match(result.text, /npm ERR! code EACCES/u);
  assert.equal(result.changed, false);
});

test('упавший запрос не оставляет исполнителя в состоянии установки', async (t) => {
  const { providers, calls, store } = await clientFixture(t, {
    post: async () => {
      throw new Error('сеть недоступна');
    },
    get: async () => snapshot(),
  });

  await providers.updateCli('claude');
  assert.ok(calls.gets.includes('/api/providers/installations/current'), 'Исход POST не сверили с сервером');
  assert.equal(providers.updating, '');
  assert.equal(store.snapshot.active, null);
  assert.equal(calls.posts.length, 1, 'Потерянный запрос повторён автоматически');
});
