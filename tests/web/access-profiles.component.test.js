import assert from 'node:assert/strict';
import test from 'node:test';

import { accessBrowser, openProfiles } from './helpers/accessBrowserFixture.js';

test('AP22_settings_topbar: список и CRUD синхронизируются через SSE', async (t) => {
  const f = await accessBrowser(t);

  await openProfiles(f);
  assert.equal(await f.page.getByText('Основной аккаунт', { exact: true }).count() > 0, true);
  assert.equal(await f.page.getByText('Запасной аккаунт', { exact: true }).count() > 0, true);

  const secondContext = await f.browser.newContext({ viewport: { width: 390, height: 844 } });
  const other = await secondContext.newPage();

  t.after(() => secondContext.close());
  await openProfiles(f, other);

  const row = f.page.getByText('Запасной аккаунт', { exact: true }).locator('..');

  f.control.busy = true;
  await row.getByRole('button', { name: /Активировать|Использовать/u }).click();
  await f.page.getByText('Исполнитель ожидает подтверждения', { exact: true }).waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-a');
  f.control.busy = false;
  await row.getByRole('button', { name: /Активировать|Использовать/u }).click();
  await other.getByText(/Запасной аккаунт/u).first().waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-b');
  await row.getByRole('button', { name: /Переименовать/u }).click();
  await f.page.getByRole('textbox', { name: /Имя профиля/u }).fill('Рабочее подключение');
  await f.page.getByRole('button', { name: /Сохранить/u, exact: true }).click();
  await other.getByText('Рабочее подключение', { exact: true }).waitFor();

  const oldRow = f.page.getByText('Основной аккаунт', { exact: true }).locator('..');

  await oldRow.getByRole('button', { name: /Удалить/u }).click();
  await f.page.getByRole('button', { name: /Удалить/u, exact: true }).last().click();
  assert.equal(f.snapshot.profiles.some((item) => item.id === 'profile-a'), false);
  assert.equal(f.control.connections, 2, 'один SSE на каждую открытую вкладку');
});

test('AP22_settings_topbar: отказ списка допускает повтор, пустота не выдаётся за ошибку', async (t) => {
  const f = await accessBrowser(t);

  await openProfiles(f);
  f.control.listStatus = 503;
  f.broadcast();
  await f.page.getByText(/Временный отказ списка/u).waitFor();
  f.control.listStatus = 200;
  f.snapshot.profiles = [];
  f.snapshot.activeProfileId = null;
  await f.page.getByRole('button', { name: /Повторить/u }).click();
  await f.page.getByText(/Нет сохранённых профилей|Профилей пока нет/u).waitFor();
  assert.equal(await f.page.getByRole('button', { name: 'Добавить профиль', exact: true }).isEnabled(), true);
});

test('AP22_settings_topbar: верхнее меню показывает имя и меняет активный профиль', async (t) => {
  const f = await accessBrowser(t);

  await openProfiles(f);
  await f.page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await f.page.locator('[data-context="provider-status"]').click();

  const activeName = f.page.getByRole('button', { name: 'Основной аккаунт', exact: true })
    .locator('..').locator(':scope > span');

  await activeName.waitFor();
  assert.equal(await activeName.textContent(), 'Основной аккаунт');
  await f.page.getByRole('button', { name: /Запасной аккаунт/u }).click();
  await activeName.filter({ hasText: 'Запасной аккаунт' }).waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-b');
});
