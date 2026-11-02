import assert from 'node:assert/strict';
import test from 'node:test';

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
