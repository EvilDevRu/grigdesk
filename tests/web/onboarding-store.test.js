import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

import {
  atProject, names, repository, waitState, wizardBrowser, fillProject,
} from './helpers/onboardingFixture.js';

/**
 * Проверяется настоящий Pinia через публичные действия формы, без выдуманных методов стора.
 * Управляемый ACK отделяет очередь autosave от скорости HTTP или браузера.
 */
function requireStore() {
  assert.ok(existsSync(new URL('../../web/src/stores/onboarding.ts', import.meta.url)),
    'Нет серверного стора ответов мастера');
}

test('ONB-CLIENT-01: очередь сохраняет свежий draft до перехода, новая Pinia читает его', async (t) => {
  requireStore();

  const f = await wizardBrowser(t);

  await atProject(f, 'manual');

  const dir = await repository(f.root);
  const page = await f.newPage({ route: '#/onboarding' });

  await fillProject(page, [dir]);
  await waitState(f, (state) => state.active.draft.repositories[0].source === dir);

  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let held = false;
  let advancing;

  f.controls.intercept = async (_route, call) => {
    if (call.method === 'PATCH' && !held) {
      held = true;
      entered();
      await gate;
    }

    return false;
  };
  await page.getByRole('textbox', { name: names.title }).fill('Первая правка');

  try {
    await Promise.race([started, new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Autosave не начался')), 4000).unref();
    })]);
    await page.getByRole('textbox', { name: names.title }).fill('Свежая правка');
    advancing = page.getByRole('button', { name: names.next }).click();
    assert.equal(f.calls.some((call) => call.url.endsWith('/advance')
      && call.body?.sessionId), false, 'Переход ждёт неподтверждённую запись');
  } finally {
    release();
  }

  await advancing;

  const state = await waitState(f, (value) => value.active.step === 'workspace');

  assert.equal(state.active.draft.title, 'Свежая правка');
  assert.equal((await f.app.projects.read(state.active.projectId)).title, 'Свежая правка');
  await page.getByRole('radio', { name: /Прямо в моей папке|Directly in my folder/i }).check();
  await waitState(f, (value) => value.active.draft.workspace.mode === 'shared');

  const second = await f.newPage({ route: '#/onboarding' });

  assert.equal(await second.getByRole('radio', {
    name: /Прямо в моей папке|Directly in my folder/i,
  }).isChecked(), true);
});

for (const status of [409, 500]) {
  test(`ONB-CLIENT-02: отказ ${status} сохраняет локальные ответы и не проходит шаг`, async (t) => {
    requireStore();

    const f = await wizardBrowser(t);

    await atProject(f, 'manual');

    const page = await f.newPage({ route: '#/onboarding' });
    const dir = await repository(f.root);

    await fillProject(page, [dir]);
    await waitState(f, (state) => state.active.draft.repositories[0].baseBranch === 'main');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) =>
      /^(Далее|Продолжить)$/.test(button.innerText.trim()) && !button.disabled));

    f.controls.intercept = async (route, call) => {
      if (call.method !== 'PATCH') {
        return false;
      }

      await route.fulfill({ status, json: {
        error: status === 409 ? 'revision_conflict' : 'write_failed',
        message: 'Ответы не сохранены',
        currentRevision: 99,
      } });

      return true;
    };
    await page.getByRole('textbox', { name: names.title }).fill('Моя несохранённая правка');
    await page.getByText(/не удалось сохранить|не сохранены|could not save|save failed/i).first().waitFor();
    assert.equal(await page.getByRole('textbox', { name: names.title }).inputValue(),
      'Моя несохранённая правка');
    assert.equal((await waitState(f, (state) => state.active.step === 'project')).active.step, 'project');
    assert.equal(f.calls.filter((call) => call.url.endsWith('/advance')).length, 0);
    assert.equal(await page.getByRole('button', { name: names.next }).isDisabled(), true);
  });
}

test('ONB-CLIENT-02: поздний ACK и SSE прежнего scope не восстанавливают ответы', async (t) => {
  requireStore();

  const f = await wizardBrowser(t);

  await atProject(f, 'manual');

  const page = await f.newPage({ route: '#/onboarding' });
  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let heldRequest;

  f.controls.intercept = async (route, call) => {
    if (call.method === 'PATCH') {
      heldRequest = route.request();
      entered();
      await gate;
    }

    return false;
  };

  await page.getByRole('textbox', { name: names.title }).fill('Чужой поздний ответ');

  try {
    await Promise.race([started, new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Autosave не начался')), 4000).unref();
    })]);
    await page.evaluate(() => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const auth = pinia._s.get('auth');

      auth.authenticated = false;
      auth.clientScope = 'другой-владелец';
    });
  } finally {
    release();
  }

  const acknowledged = await heldRequest.response();

  await acknowledged?.finished();
  await f.publish();

  const serialized = await page.evaluate(() => {
    const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;

    return JSON.stringify(pinia._s.get('onboarding')?.$state || {});
  });

  assert.equal(serialized.includes('Чужой поздний ответ'), false);
  assert.equal(f.calls.filter((call) => call.url.endsWith('/advance')).length, 0);
});
