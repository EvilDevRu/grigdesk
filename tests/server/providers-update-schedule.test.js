import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import test from 'node:test';

import { completed, installFixture, start } from './helpers/providerInstallFixture.js';

/**
 * Асинхронная проверка таймера завершается цепочкой микрозадач настоящего модуля.
 * setImmediate не замокан: продвигается IO, но не само расписание проверки версий.
 */
async function settle() {
  for (let index = 0; index < 10; index += 1) {
    await tick();
  }
}

test('проверки через 30 секунд и 6 часов не запускают установку', async (t) => {
  const fixture = await installFixture(t);
  let checks = 0;

  fixture.provider.latestVersion = async () => {
    checks += 1;

    return checks === 1 ? '2.0.0' : null;
  };
  // Модуль создаёт таймеры при регистрации: отдельный mock нужен до регистрации.
  await fixture.app.close();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => t.mock.timers.reset());

  const next = await installFixture(t, { adapters: fixture.adapters });

  t.mock.timers.tick(29_999);
  await settle();
  assert.equal(checks, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(checks, 1);

  const first = (await next.app.inject('/api/providers')).json().providers[0];

  assert.equal(first.latest, '2.0.0');
  assert.equal(first.updateAvailable, true);
  t.mock.timers.tick(6 * 60 * 60 * 1000 - 30_000);
  await settle();
  assert.equal(checks, 2);

  const manual = await next.app.inject({
    method: 'POST',
    url: '/api/providers/check-updates'
  });

  assert.equal(manual.statusCode, 200);
  assert.equal(checks, 3);
  assert.equal(manual.json().updates[0].latest, first.latest);
  assert.equal(next.calls.commands.length, 0);
  await assert.rejects(access(fixture.marker), { code: 'ENOENT' });
});

/**
 * Перепроверка после установки идёт в сеть, а сеть флапает: без ответа реестра индикатор
 * сравнивает свежую версию CLI с последней известной, а не оставляет прежний «устарел».
 */
test('успешное обновление гасит индикатор и без ответа реестра', async (t) => {
  const fixture = await installFixture(t);
  const before = await fixture.app.inject({ method: 'POST', url: '/api/providers/check-updates' });

  assert.equal(before.json().updates[0].outdated, true);

  fixture.provider.latestVersion = async () => null;

  const response = await start(fixture.app, 'claude', 'update');

  assert.equal(response.statusCode, 202, response.body);
  fixture.gate.resolve();
  assert.equal((await completed(fixture.app)).recent.claude.status, 'succeeded');

  const card = (await fixture.app.inject('/api/providers')).json().providers[0];

  assert.equal(card.updateAvailable, false);
  assert.equal(card.latest, '2.0.0');
});

// Первая установка тоже перепроверяет версии: свежий CLI без ответа реестра не получает индикатор.
test('первая установка не оставляет индикатор обновления', async (t) => {
  const fixture = await installFixture(t, { installed: false });

  await fixture.app.inject({ method: 'POST', url: '/api/providers/check-updates' });
  fixture.provider.latestVersion = async () => null;

  const response = await start(fixture.app, 'claude', 'install');

  assert.equal(response.statusCode, 202, response.body);
  fixture.gate.resolve();
  assert.equal((await completed(fixture.app)).recent.claude.status, 'succeeded');

  const card = (await fixture.app.inject('/api/providers')).json().providers[0];

  assert.equal(card.installed, true);
  assert.equal(card.updateAvailable, false);
});
