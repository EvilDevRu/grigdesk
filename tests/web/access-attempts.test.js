import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PRIVATE_INPUT, WARNING, accessBrowser, openProfiles, openWizard,
} from './helpers/accessBrowserFixture.js';
import { selectUiOption } from './helpers/selectUiOption.ts';

/**
 * Проверка читает только клиентское состояние синтетического приложения.
 * Приватный ввод не должен попасть ни в Pinia, ни в постоянные хранилища браузера.
 */
async function assertPrivate(page) {
  const serialized = await page.evaluate(() => JSON.stringify({
    pinia: document.querySelector('#app').__vue_app__.config.globalProperties.$pinia.state.value,
    local: { ...localStorage },
    session: { ...sessionStorage },
  }));

  assert.equal(serialized.includes(PRIVATE_INPUT), false);
}

test('AP23_reconcile_secret: двойной submit, lost ACK и reload узнают исход без второго ключа', async (t) => {
  const f = await accessBrowser(t);

  await openWizard(f);
  await f.page.getByRole('textbox', { name: /Имя профиля/u }).fill('Новое подключение');
  await f.page.getByRole('button', { name: /Продолжить/u, exact: true }).click();
  await f.page.getByLabel('API-ключ', { exact: true }).fill(PRIVATE_INPUT);
  await assertPrivate(f.page);
  f.control.dropAck = true;
  await f.page.getByRole('button', { name: /Продолжить|Проверить/u }).dblclick();
  await f.page.getByText(WARNING, { exact: true }).waitFor();

  const posts = f.calls.filter((call) => call.method === 'POST');
  const secretPosts = posts.filter((call) => JSON.stringify(call.body).includes(PRIVATE_INPUT));

  assert.equal(secretPosts.length, 1);
  assert.ok(secretPosts[0].body.operationId);
  assert.ok(f.calls.some((call) => call.method === 'GET' && call.path.includes('/operations/')));
  assert.equal(f.snapshot.activeProfileId, 'profile-a');
  await f.page.reload();
  await openProfiles(f);
  await f.page.getByText(WARNING, { exact: true }).waitFor();
  assert.equal(f.calls.filter((call) => call.method === 'POST').length, posts.length);
  await assertPrivate(f.page);
  await f.page.getByRole('button', { name: 'Подтвердить замену', exact: true }).click();
  await f.page.getByText(/Сохранён|Сохранен/u).waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-a', 'сохранение inactive не активирует профиль');
});

test('AP23_reconcile_secret: направления кода, ожидание, проверка и auth-lost имеют разные UI', async (t) => {
  const f = await accessBrowser(t);

  await openWizard(f);
  await f.page.getByRole('textbox', { name: /Имя профиля/u }).fill('CLI подключение');
  await f.page.getByRole('button', { name: /Продолжить/u, exact: true }).click();

  for (const step of [
    {
      id: 'url',
      kind: 'open-url',
      url: 'https://provider.example.test/login'
    },
    {
      id: 'display',
      kind: 'display-code',
      code: 'CLI-SITE-1234',
      url: 'https://provider.example.test/device'
    },
    { id: 'waiting', kind: 'waiting' },
    { id: 'verifying', kind: 'verifying' },
    {
      id: 'enter',
      kind: 'enter-code',
      label: 'Код с сайта'
    },
  ]) {
    f.control.attempt.step = step;
    f.control.attempt.revision += 1;
    f.broadcast();

    if (step.kind === 'display-code') {
      await f.page.getByText('CLI-SITE-1234', { exact: true }).waitFor();
      assert.equal(await f.page.getByRole('textbox').count(), 0, 'код CLI надо показать, а не запросить');
    } else if (step.kind === 'enter-code') {
      await f.page.getByLabel('Код с сайта', { exact: true }).fill(PRIVATE_INPUT);
    } else if (step.kind === 'open-url') {
      const link = f.page.getByRole('link', { name: /Авторизоваться/u })
        .or(f.page.getByRole('button', { name: /Авторизоваться/u }));

      await link.waitFor();
      assert.equal(await link.count(), 1);
      assert.notEqual(f.control.attempt.state, 'saved');
    } else {
      await f.page.getByText(step.kind === 'waiting' ? /Ожида/u : /Провер/u).first().waitFor();
    }

    assert.equal(await f.page.getByText(/Профиль сохран[её]н/u).count(), 0,
      'ссылка, ожидание и проверка не показывают преждевременный успех');
  }

  await assertPrivate(f.page);
  f.control.unauthorized = true;
  await f.page.getByRole('button', { name: /Продолжить/u, exact: true }).click();
  await f.page.waitForFunction(() => ![...document.querySelectorAll('input')]
    .some((input) => input.value.includes('synthetic-browser-private-access-code')));
  await assertPrivate(f.page);
});

test('AP23_reconcile_secret: EN и отмена подтверждения неизвестного аккаунта', async (t) => {
  const f = await accessBrowser(t);

  await openProfiles(f);
  await f.page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await f.page.getByRole('button', { name: 'Настройки', exact: true }).click();
  await f.page.evaluate(() => {
    document.querySelector('#app').__vue_app__.config.globalProperties.$pinia
      ._s.get('settings').selectPage('interface.behavior');
  });
  await selectUiOption(f.page, f.page.getByRole('combobox', { name: 'Язык интерфейса', exact: true }), 'en');
  await f.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await f.page.locator('[data-role="settings-modal"]').waitFor({ state: 'hidden' });
  await openWizard(f);
  await f.page.getByRole('textbox', { name: /Profile name/u }).fill('New access');
  await f.page.getByRole('button', { name: /Continue/u, exact: true }).click();
  await f.page.getByLabel('API-ключ', { exact: true }).fill(PRIVATE_INPUT);
  await f.page.getByRole('button', { name: /Continue|Verify/u }).click();
  await f.page.getByText(/account.*(?:identified|determine)|(?:identify|determine).*account/iu).waitFor();
  assert.equal(await f.page.getByText(WARNING, { exact: true }).count(), 0);
  await f.page.getByRole('button', { name: /Cancel/u, exact: true }).last().click();
  assert.equal(f.control.attempt.state, 'cancelled');
  assert.equal(f.snapshot.activeProfileId, 'profile-a');
  await assertPrivate(f.page);
});
