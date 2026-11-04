import assert from 'node:assert/strict';
import test from 'node:test';

import { atProject, atWorkspace, repository, request, token } from '../server/helpers/onboardingFixture.js';
import { mountOnboarding, onboardingButton, waitOnboarding } from './helpers/onboardingMounted.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

/**
 * Итог получен публичными переходами с настоящими Git-папками и созданным паспортом.
 * Сценарий не выставляет вручную step/status, иначе мог бы скрыть ошибку действия.
 */
async function atSummary(backend) {
  const state = await atWorkspace(backend, 'manual');

  await request(backend.app, 'POST', '/advance', token(state));
}

test('ONB-ACTIONS: подпись каждой кнопки соответствует её полному эффекту', async (t) => {
  const browser = await installUiBrowser(t);

  for (const [step, prepare] of [
    ['ai', null],
    ['project', (backend) => atProject(backend, 'manual')],
    ['workspace', (backend) => atWorkspace(backend, 'manual')],
  ]) {
    await t.test(`пропуск настройки с ${step} закрывает мастер и сохраняет исходную страницу`, async (t) => {
      const f = await mountOnboarding(t, browser, { prepare });
      const original = f.router.currentRoute.value.fullPath;

      await onboardingButton(f, 'Пропустить настройку').trigger('click');
      await waitOnboarding(f, () => !f.store.isOpen && !f.store.busy);

      assert.equal(f.store.snapshot.active.status, 'dismissed');
      assert.equal(f.router.currentRoute.value.fullPath, original);
      assert.deepEqual(f.effects.filter((effect) => effect.kind !== 'request'), []);
    });
  }

  await t.test('пропуск со второго шага ждёт ввода без обязательных папки и ветки', async (t) => {
    const f = await mountOnboarding(t, browser, { providers: [] });

    await onboardingButton(f, 'Пропустить шаг').trigger('click');
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');

    const gate = Promise.withResolvers();

    globalThis.__onboardingMounted.intercept = async (call) => {
      if (call.patch) {
        await gate.promise;
      }
    };

    try {
      await f.wrapper.get('input').setValue('Незаконченный проект');
      await onboardingButton(f, 'Пропустить настройку').trigger('click');
      assert.equal(f.store.isOpen, true);
      assert.equal(f.effects.some((call) => call.suffix === '/dismiss'), false);
    } finally {
      gate.resolve();
      await waitOnboarding(f, () => !f.store.isOpen && !f.store.busy);
    }

    const saved = await request(f.backend.app);

    assert.equal(saved.active.status, 'dismissed');
    assert.equal(saved.active.draft.title, 'Незаконченный проект');
    assert.equal(saved.autoOpenDisabled, true);
    assert.equal((await f.backend.app.projects.list()).length, 0);
    assert.equal(f.router.currentRoute.value.fullPath, '/chats?view=agents');
  });

  await t.test('на итоге остаются завершение, возврат и новый проект без действия пропуска', async (t) => {
    const f = await mountOnboarding(t, browser, { prepare: atSummary });

    assert.equal(Boolean(onboardingButton(f, 'Пропустить настройку')), false);

    const projectId = f.store.snapshot.active.projectId;

    await onboardingButton(f, 'Готово').trigger('click');
    await waitOnboarding(f, () => !f.store.isOpen
      && f.router.currentRoute.value.path === `/projects/${projectId}`);
    assert.equal(f.store.snapshot.active.status, 'completed');
  });

  await t.test('Далее проходит три шага, создаёт один проект и завершает тот же проход', async (t) => {
    const f = await mountOnboarding(t, browser);
    const dir = await repository(f.backend.root);
    const initialId = f.store.snapshot.active.id;

    await onboardingButton(f, 'Далее').trigger('click');
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');
    assert.equal(f.store.snapshot.active.aiSkipped, false);
    await f.wrapper.findAll('input')[0].setValue('Проект после Далее');
    await f.wrapper.findAll('input')[1].setValue(dir);
    await f.wrapper.findAll('input')[1].trigger('blur');
    await waitOnboarding(f, () => !onboardingButton(f, 'Далее').element.disabled);
    await onboardingButton(f, 'Далее').trigger('click');
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'workspace');
    assert.equal((await f.backend.app.projects.list()).length, 1);
    await f.wrapper.get('[role="radio"][aria-checked="false"]').trigger('click');
    await onboardingButton(f, 'Далее').trigger('click');
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'summary');
    assert.equal(f.store.snapshot.active.id, initialId);
    assert.equal(f.store.snapshot.active.status, 'completed');
    assert.equal(f.store.snapshot.active.draft.workspace.mode, 'shared');
    assert.equal(f.router.currentRoute.value.fullPath, '/chats?view=agents');
  });

  await t.test('Назад с итога проходит прежние шаги без создания копии проекта', async (t) => {
    const f = await mountOnboarding(t, browser, { prepare: atSummary });
    const initialId = f.store.snapshot.active.id;

    for (const step of ['workspace', 'project', 'ai']) {
      await onboardingButton(f, 'Назад').trigger('click');
      await waitOnboarding(f, () => f.store.snapshot.active.step === step);
      assert.equal(f.store.snapshot.active.id, initialId);
    }

    assert.equal((await f.backend.app.projects.list()).length, 1);
    assert.equal(f.router.currentRoute.value.fullPath, '/chats?view=agents');
  });

  await t.test('Настроить ещё проект начинает новый проход и сохраняет готовый паспорт', async (t) => {
    const f = await mountOnboarding(t, browser, { prepare: atSummary });
    const initialId = f.store.snapshot.active.id;

    await onboardingButton(f, 'Настроить ещё проект').trigger('click');
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'ai');
    assert.notEqual(f.store.snapshot.active.id, initialId);
    assert.equal(f.store.draft.title, '');
    assert.equal((await f.backend.app.projects.list()).length, 1);
    assert.equal(f.router.currentRoute.value.fullPath, '/chats?view=agents');
  });

  await t.test('крестик сохраняет ответы и закрывает окно без пропуска прохода', async (t) => {
    const f = await mountOnboarding(t, browser, {
      prepare: (backend) => atProject(backend, 'manual'),
    });
    const gate = Promise.withResolvers();

    globalThis.__onboardingMounted.intercept = async (call) => {
      if (call.patch) {
        await gate.promise;
      }
    };

    try {
      await f.wrapper.get('input').setValue('Название перед закрытием');
      await f.wrapper.get('button[aria-label="Закрыть"]').trigger('click');
      assert.equal(f.store.isOpen, true);
    } finally {
      gate.resolve();
      await waitOnboarding(f, () => !f.store.isOpen);
    }

    const saved = await request(f.backend.app);

    assert.equal(saved.active.status, 'active');
    assert.equal(saved.active.draft.title, 'Название перед закрытием');
    assert.equal(f.effects.some((effect) => effect.suffix === '/dismiss'), false);
    assert.equal(f.router.currentRoute.value.fullPath, '/chats?view=agents');
    await f.store.open('manual');
    await waitOnboarding(f, () => f.wrapper.find('input').exists());
    assert.equal(f.wrapper.get('input').element.value, 'Название перед закрытием');
  });

  await t.test('возврат блокирует остальные действия ещё во время сохранения', async (t) => {
    const f = await mountOnboarding(t, browser, {
      prepare: (backend) => atProject(backend, 'manual'),
    });
    const gate = Promise.withResolvers();

    t.after(() => gate.resolve());
    globalThis.__onboardingMounted.intercept = async (call) => {
      if (call.patch) {
        await gate.promise;
      }
    };
    await f.wrapper.get('input').setValue('Название перед возвратом');
    await onboardingButton(f, 'Назад').trigger('click');

    try {
      assert.equal(f.store.busy, true);
      assert.equal(onboardingButton(f, 'Пропустить настройку').element.disabled, true);
      assert.equal(await f.store.transition('/dismiss'), false,
        'Повторный переход отвергается даже при прямом вызове стора');
    } finally {
      gate.resolve();
      await waitOnboarding(f, () => f.store.snapshot.active.step === 'ai');
    }

    assert.equal(f.store.draft.title, 'Название перед возвратом');
  });

  await t.test('после ошибки пропуск не выглядит доступным без результата', async (t) => {
    const f = await mountOnboarding(t, browser);

    globalThis.__onboardingMounted.intercept = async () => {
      throw new Error('Отказ записи фикстуры');
    };
    await onboardingButton(f, 'Пропустить настройку').trigger('click');
    await waitOnboarding(f, () => f.store.error === 'save' && !f.store.busy);
    assert.equal(f.store.isOpen, true);
    assert.equal(onboardingButton(f, 'Пропустить настройку').element.disabled, true);
    globalThis.__onboardingMounted.intercept = null;
    await onboardingButton(f, 'Перечитать').trigger('click');
    await waitOnboarding(f, () => !f.store.error);
    assert.equal(onboardingButton(f, 'Пропустить настройку').element.disabled, false);
  });
});
