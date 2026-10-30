import assert from 'node:assert/strict';
import test from 'node:test';

import {
  names, projectInput, reopenWizard, request, waitState, wizardBrowser,
} from './helpers/onboardingFixture.js';

test('ONB-MODAL-01: мастер сохраняет раздел, блокирует фон и возвращает фокус после Escape', async (t) => {
  const f = await wizardBrowser(t);

  await f.app.projects.create(projectInput('demo'));

  const page = await f.newPage({ route: '#/board' });
  const originalUrl = page.url();

  await page.evaluate(() => {
    window.__wizardBackground = document.querySelector('.shell .content').firstElementChild;
  });
  await reopenWizard(page);

  const modal = page.locator('[data-role="onboarding-modal"]');

  await modal.getByRole('heading', { name: /Подключите исполнителя/ }).waitFor();
  assert.equal(page.url(), originalUrl);
  assert.equal(await modal.getAttribute('aria-modal'), 'true');
  assert.equal(await page.evaluate(() => Boolean(window.__wizardBackground.closest('[inert]'))), true);
  await page.keyboard.press('Tab');

  const focusedInModal = await page.evaluate(() => Boolean(document.activeElement
    .closest('[data-role="onboarding-modal"]')));

  assert.equal(focusedInModal, true);
  await page.keyboard.press('Escape');
  await modal.waitFor({ state: 'hidden' });
  assert.equal(page.url(), originalUrl);
  assert.equal(await page.evaluate(() => document.querySelector('.shell .content').firstElementChild
    === window.__wizardBackground), true);

  const returnedFocus = await page.evaluate(() => document.activeElement.getAttribute('aria-label'));

  assert.equal(returnedFocus, 'Мастер настройки');
  assert.equal(f.calls.filter((call) => call.url.endsWith('/dismiss')).length, 0);
});

test('ONB-MODAL-02: крестик ждёт сохранения, повторное открытие продолжает прежний шаг', async (t) => {
  const f = await wizardBrowser(t);

  await f.app.projects.create(projectInput('demo'));

  const page = await f.newPage({ route: '#/projects' });

  await reopenWizard(page);
  await page.getByRole('button', { name: names.skip }).click();
  await page.getByRole('textbox', { name: names.title }).waitFor();

  const state = await request(f.app);
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });

  f.controls.intercept = async (_route, call) => {
    if (call.method === 'PATCH') {
      entered();
      await gate;
    }

    return false;
  };

  const modal = page.locator('[data-role="onboarding-modal"]');

  try {
    await page.getByRole('textbox', { name: names.title }).fill('Сохранённый проект');
    await started;
    await modal.getByRole('button', { name: 'Закрыть', exact: true }).click();
    assert.equal(await modal.isVisible(), true);
  } finally {
    release();
  }

  await modal.waitFor({ state: 'hidden' });
  await waitState(f, (value) => value.active.draft.title === 'Сохранённый проект');
  await reopenWizard(page);
  assert.equal(await page.getByRole('textbox', { name: names.title }).inputValue(), 'Сохранённый проект');
  assert.equal((await request(f.app)).active.id, state.active.id);
});
