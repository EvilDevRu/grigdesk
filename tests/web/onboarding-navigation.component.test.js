import assert from 'node:assert/strict';
import test from 'node:test';

import { atProject, atWorkspace, repository, request, token } from '../server/helpers/onboardingFixture.js';
import { mountOnboarding, onboardingButton, waitOnboarding } from './helpers/onboardingMounted.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

/**
 * Настоящие host, router, store, шаги, controls и сервер проверяются одним сценарием.
 * Готовность влияет на цвет, а возврат сохраняет введённое название после ACK.
 */
test('ONB-NAV-UI: цвет готовности, единые кнопки и возврат после ACK без потери ввода', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, {
    providers: [
      {
        id: 'codex',
        name: 'Codex',
        available: true,
        installed: true,
        color: '#10a37f',
      },
      {
        id: 'claude',
        name: 'Claude',
        available: false,
        installed: true,
        color: '#d97757',
      },
      {
        id: 'tripo',
        name: 'Tripo',
        available: true,
        installed: true,
        chatEnabled: false,
      },
    ],
  });
  const button = (label) => onboardingButton(f, label);
  const icons = f.wrapper.findAll('.provider-icon');

  assert.equal(icons[0].element.style.color, '#10a37f');
  assert.equal(icons[1].element.style.color, '');
  assert.equal(icons[2].get('path').attributes('fill'), 'currentColor');
  assert.equal(Boolean(button('Назад')), false);
  assert.equal(button('Пропустить шаг').attributes('data-variant'), 'outline');
  assert.equal(button('Пропустить настройку').attributes('data-variant'), 'outline');

  await button('Пропустить шаг').trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');
  assert.equal(button('Назад').attributes('data-variant'), 'outline');
  assert.equal(button('Пропустить настройку').attributes('data-variant'), 'outline');

  const gate = Promise.withResolvers();

  globalThis.__onboardingMounted.intercept = async (call) => {
    if (call.patch) {
      await gate.promise;
    }
  };

  try {
    await f.wrapper.get('input').setValue('Название перед возвратом');
    await button('Назад').trigger('click');
    assert.equal(f.effects.some((call) => call.suffix === '/back'), false,
      'Возврат ждёт последнего PATCH');
    assert.equal(f.store.snapshot.active.step, 'project');
  } finally {
    gate.resolve();
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'ai');
  }

  assert.equal(f.store.draft.title, 'Название перед возвратом');
  assert.equal(f.wrapper.find('.onboarding-step-skipped').exists(), false);

  await button('Далее').trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');
  assert.equal(f.wrapper.get('input').element.value, 'Название перед возвратом');
  f.store.error = 'save';
  await f.flushPromises();
  assert.equal(button('Назад').element.disabled, true);
});

test('ONB-NAV-SIDEBAR: шкала сохраняет ввод и позволяет открыть режим до проекта', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, { providers: [] });
  const steps = () => f.wrapper.findAll('[data-context="onboarding-step"]');

  assert.equal(steps()[0].element.disabled, true);
  assert.equal(steps()[1].element.disabled, false);
  assert.equal(steps()[2].element.disabled, false);
  assert.ok(steps().slice(3).every((step) => step.element.disabled));

  await steps()[1].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');
  assert.equal(f.store.snapshot.active.aiSkipped, true);
  assert.equal(steps()[2].element.disabled, false);

  const gate = Promise.withResolvers();

  globalThis.__onboardingMounted.intercept = async (call) => {
    if (call.patch) {
      await gate.promise;
    }
  };

  try {
    await f.wrapper.get('input').setValue('Название перед нажатием шкалы');
    await steps()[0].trigger('click');
    assert.equal(f.store.snapshot.active.step, 'project');
    assert.equal(f.effects.some((call) => call.suffix === '/back'), false);
    assert.ok(steps().every((step) => step.element.disabled));
    assert.equal(onboardingButton(f, 'Пропустить настройку').element.disabled, true);
  } finally {
    gate.resolve();
    await waitOnboarding(f, () => f.store.snapshot.active.step === 'ai');
  }

  await steps()[1].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');
  assert.equal(f.wrapper.get('input').element.value, 'Название перед нажатием шкалы');
  assert.equal((await f.backend.app.projects.list()).length, 0);
});

test('ONB-NAV-SIDEBAR: третий шаг открывается с пустым проектом и сохраняет выбранный режим', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, {
    prepare: (backend) => atProject(backend, 'manual'),
  });
  const steps = () => f.wrapper.findAll('[data-context="onboarding-step"]');

  await steps()[2].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'workspace');
  assert.equal(f.store.snapshot.active.projectSaved, false);
  assert.equal(f.wrapper.findAll('.onboarding-steps li')[1].classes('is-complete'), false);
  assert.equal(Boolean(onboardingButton(f, 'Далее')), false);
  assert.equal(Boolean(onboardingButton(f, 'Добавьте проект')), true);
  await f.wrapper.get('[role="radio"][aria-checked="false"]').trigger('click');
  await waitOnboarding(f, () => !f.store.dirty && !f.store.saving);
  assert.equal((await request(f.backend.app)).active.draft.workspace.mode, 'shared');
  assert.equal((await f.backend.app.projects.list()).length, 0);

  await f.store.close();
  await f.store.open('manual');
  await waitOnboarding(f, () => f.wrapper.find('[role="radio"]').exists());
  assert.equal(f.store.snapshot.active.step, 'workspace');
  await onboardingButton(f, 'Добавьте проект').trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'project');
  assert.equal(f.wrapper.get('input').element.value, '');
  assert.equal(f.wrapper.get('input').element.disabled, false);
  assert.equal(f.store.draft.workspace.mode, 'shared');
});

test('ONB-NAV-SIDEBAR: с ИИ можно сразу выбрать третий шаг без создания паспорта', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, { providers: [] });

  await f.wrapper.findAll('[data-context="onboarding-step"]')[2].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'workspace');
  assert.equal(f.store.snapshot.active.aiSkipped, true);
  assert.equal((await f.backend.app.projects.list()).length, 0);
  await onboardingButton(f, 'Пропустить настройку').trigger('click');
  await waitOnboarding(f, () => !f.store.isOpen);
  assert.equal(f.store.snapshot.active.status, 'dismissed');
});

test('ONB-NAV-SIDEBAR: переход с итога через ИИ к режиму задач сохраняет один паспорт', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, {
    prepare: async (backend) => {
      const state = await atWorkspace(backend, 'manual');

      await request(backend.app, 'POST', '/advance', token(state));
    },
  });
  const steps = () => f.wrapper.findAll('[data-context="onboarding-step"]');
  const projectId = f.store.snapshot.active.projectId;

  await steps()[0].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'ai');
  assert.equal(f.store.snapshot.active.status, 'active');
  await steps()[2].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'workspace');
  assert.equal(f.store.snapshot.active.projectId, projectId);
  assert.equal((await f.backend.app.projects.list()).length, 1);
  assert.equal(f.router.currentRoute.value.fullPath, '/chats?view=agents');
});

test('ONB-NAV-SIDEBAR: заполненный проект сохраняется перед выбором режима задач', async (t) => {
  const browser = await installUiBrowser(t);
  const f = await mountOnboarding(t, browser, {
    prepare: (backend) => atProject(backend, 'manual'),
  });
  const dir = await repository(f.backend.root);

  await f.wrapper.findAll('input')[0].setValue('Проект по шкале');
  await f.wrapper.findAll('input')[1].setValue(dir);
  await f.wrapper.findAll('input')[1].trigger('blur');
  await waitOnboarding(f, () => !onboardingButton(f, 'Далее').element.disabled);
  await f.wrapper.findAll('[data-context="onboarding-step"]')[2].trigger('click');
  await waitOnboarding(f, () => f.store.snapshot.active.step === 'workspace');
  assert.equal(f.store.snapshot.active.projectSaved, true);
  assert.equal((await f.backend.app.projects.list()).length, 1);

  globalThis.__onboardingMounted.intercept = async (call) => {
    if (call.suffix === '/back') {
      throw new Error('Отказ перехода фикстуры');
    }
  };

  await f.wrapper.findAll('[data-context="onboarding-step"]')[0].trigger('click');
  await waitOnboarding(f, () => f.store.error === 'save' && !f.store.busy);
  assert.equal(f.store.snapshot.active.step, 'workspace');
  assert.ok(f.wrapper.findAll('[data-context="onboarding-step"]').every((step) => step.element.disabled));
});
