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

  const row = f.page.locator('[data-profile-id="profile-b"]');

  f.control.busy = true;
  await row.getByRole('button', { name: /Активировать|Использовать/u }).click();
  await f.page.getByText('Исполнитель ожидает подтверждения', { exact: true }).waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-a');
  f.control.busy = false;
  f.broadcast('chat-done');
  await row.getByRole('button', { name: /Активировать|Использовать/u }).click();
  await other.getByText(/Запасной аккаунт/u).first().waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-b');
  await row.getByRole('button', { name: /Переименовать/u }).click();
  await f.page.getByRole('textbox', { name: /Имя профиля/u }).fill('Рабочее подключение');
  await f.page.getByRole('button', { name: /Сохранить/u, exact: true }).click();
  await other.getByText('Рабочее подключение', { exact: true }).waitFor();

  const oldRow = f.page.locator('[data-profile-id="profile-a"]');

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

  const rail = f.page.locator('[data-profile-switcher]');
  const activeName = rail.getByRole('button', {
    name: 'Основной аккаунт',
    exact: true,
    pressed: true,
  });

  await activeName.waitFor();
  assert.equal(await activeName.isEnabled(), true);
  assert.equal(await activeName.getAttribute('aria-disabled'), null);
  assert.equal(await rail.locator('.ui-segmented-control').count(), 1);
  assert.equal(await activeName.getAttribute('data-tone'), 'neutral');
  await activeName.click();
  assert.equal(f.calls.some((call) => call.path.endsWith('/activate')), false);
  await rail.getByRole('button', { name: 'Запасной аккаунт', exact: true }).click();
  await rail.getByRole('button', {
    name: 'Запасной аккаунт',
    exact: true,
    pressed: true,
  }).waitFor();
  assert.equal(f.snapshot.activeProfileId, 'profile-b');

  assert.equal(await f.page.getByRole('button', {
    name: 'Управление подключениями',
    exact: true,
  }).count(), 0);
  await f.page.locator('[data-context="topbar-popover-settings"]').click();
  await f.page.locator('[data-provider-page="fixture"][data-ready="true"]').waitFor();

  const accessTab = f.page.getByRole('tab', { name: 'Доступ', exact: true });

  await accessTab.click();
  await f.page.locator('[data-profile-id="profile-b"]').waitFor();
});

test('ряд подключений появляется только при нескольких учётках и обновляется через SSE', async (t) => {
  const f = await accessBrowser(t);
  const second = f.snapshot.profiles.pop();

  await openProfiles(f);
  await f.page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await f.page.locator('[data-context="provider-status"]').click();

  const rail = f.page.locator('[data-profile-switcher]');
  const footer = f.page.locator('.ui-topbar-panel__footer');

  assert.equal(await rail.count(), 0);
  assert.equal(await footer.isVisible(), false, 'У единственной учётки нет пустого разделителя');
  f.snapshot.profiles.push(second);
  f.broadcast();
  await rail.getByRole('button', { name: second.name, exact: true }).waitFor();
  f.snapshot.profiles.pop();
  f.broadcast();
  await rail.waitFor({ state: 'hidden' });
  assert.equal(await footer.isVisible(), false);
  f.snapshot.profiles = [];
  f.snapshot.activeProfileId = null;
  f.broadcast();
  await footer.waitFor({ state: 'hidden' });
  assert.equal(await rail.count(), 0);
});

test('кнопки подключений находятся снизу, а лишние доступны через «…»', async (t) => {
  const f = await accessBrowser(t, { viewport: { width: 390, height: 844 } });

  for (let index = 0; index < 7; index += 1) {
    f.snapshot.profiles.push({
      ...f.snapshot.profiles[1],
      id: `extra-${index}`,
      name: `Дополнительное подключение ${index}`,
    });
  }

  await openProfiles(f);
  await f.page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await f.page.locator('[data-context="provider-status"]').click();

  const rail = f.page.locator('[data-profile-switcher]');
  const footer = f.page.locator('.ui-topbar-panel__footer');

  await rail.getByRole('button', { name: 'Другие подключения', exact: true }).waitFor();
  assert.equal(await footer.locator('[data-profile-switcher]').count(), 1);
  assert.equal(await rail.getByRole('button', { name: 'Дополнительное подключение 6' }).count(), 0);
  await rail.getByRole('button', { name: 'Другие подключения', exact: true }).click();
  await f.page.getByRole('button', { name: 'Дополнительное подключение 6', exact: true }).click();
  await rail.getByRole('button', {
    name: 'Дополнительное подключение 6',
    exact: true,
    pressed: true,
  }).waitFor();
  assert.equal(f.snapshot.activeProfileId, 'extra-6');

  const fits = await rail.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);

  assert.equal(fits, true, 'Кнопки не выходят за ширину всплывашки');
  await rail.evaluate((element) => {
    element.parentElement.style.width = '160px';
  });
  await rail.getByRole('button', { name: 'Дополнительное подключение 6', exact: true })
    .waitFor({ state: 'hidden' });
  await rail.getByRole('button', { name: 'Другие подключения', exact: true }).click();
  await f.page.getByRole('button', { name: 'Дополнительное подключение 6', exact: true }).waitFor();
});

test('активная работа блокирует переключение в настройках и нижних кнопках', async (t) => {
  const f = await accessBrowser(t);

  f.control.busy = true;
  await openProfiles(f);

  const activate = f.page.getByRole('button', { name: 'Активировать', exact: true });

  assert.equal(await activate.isEnabled(), false);
  await f.page.getByText(/Переключение доступно после завершения/u).waitFor();
  await f.page.getByRole('button', { name: 'Отмена', exact: true }).click();
  await f.page.locator('[data-context="provider-status"]').click();

  const second = f.page.locator('[data-profile-switcher]')
    .getByRole('button', { name: 'Запасной аккаунт', exact: true });

  await second.waitFor();
  assert.equal(await second.isEnabled(), false);
  assert.equal(f.calls.some((call) => call.path.endsWith('/activate')), false);
  f.control.busy = false;
  f.broadcast('chat-done');
  await second.click();
  assert.equal(f.snapshot.activeProfileId, 'profile-b');
});

test('карточки доступа сохраняют действия и длинные имена в узком окне', async (t) => {
  const f = await accessBrowser(t, { viewport: { width: 390, height: 844 } });

  f.snapshot.profiles[0].name = 'Рабочее подключение с длинным названием '.repeat(3);
  f.snapshot.profiles[0].authState = 'needs-auth';
  await openProfiles(f);

  const active = f.page.locator('[data-profile-id="profile-a"]');

  await active.getByText('Требуется вход', { exact: true }).waitFor();
  assert.equal(await active.getByRole('button', { name: 'Удалить', exact: true }).count(), 0);
  assert.equal(await active.getByRole('button', { name: 'Активировать', exact: true }).count(), 0);
  assert.equal(await active.getByRole('button', { name: 'Переименовать', exact: true }).isVisible(), true);

  const geometry = await active.evaluate((element) => {
    const bounds = element.getBoundingClientRect();

    return {
      left: bounds.left,
      right: bounds.right,
      viewport: window.innerWidth,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    };
  });

  assert.ok(geometry.left >= 0 && geometry.right <= geometry.viewport);
  assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1, 'Действия не расширяют карточку');
});
