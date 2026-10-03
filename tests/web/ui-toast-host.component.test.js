import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pathToFileURL
} from 'node:url';

import {
  compileVue,
  webFile
} from './helpers/compile-vue.js';
import {
  installUiBrowser
} from './helpers/ui-components.js';

const TOASTS_URL = pathToFileURL(webFile('src/services/toasts.ts')).href;
const TOASTS_STUB = [
  'const center = () => globalThis.__toastCenter;',
  'export const subscribeToasts = (listener) => center().subscribe(listener);',
  'export const dismissToast = (...args) => center().dismiss(...args);',
  'export const dismissAllToasts = (...args) => center().dismissAll(...args);',
  'export const pauseToast = (id) => center().pause(id);',
  'export const resumeToast = (id) => center().resume(id);',
  'export const setToastsVisible = (visible) => center().setDocumentVisible(visible);',
  'export const runToastAction = (toastId, actionId) => center().runAction(toastId, actionId);',
].join('\n');

/**
 * Ручные таймеры дают сценарию самому выбирать момент истечения.
 * Проверяется взвод и отмена, без зависимости от скорости машины.
 */
function fakeTimers() {
  let sequence = 0;
  const active = new Map();

  return {

    active,

    set(callback, ms) {
      sequence += 1;
      active.set(sequence, {
        callback,
        ms
      });

      return sequence;
    },

    clear(handle) {
      active.delete(handle);
    },

    fireAll() {
      const due = [...active.values()];

      active.clear();
      due.forEach((timer) => timer.callback());
    },

  };
}

test('UiToastHost', async (t) => {
  const browser = await installUiBrowser(t);
  const [{
    mount
  }, {
    createToastCenter
  }, UiToastHost] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import(TOASTS_URL),
    compileVue(webFile('src/components/feedback/UiToastHost.vue'), {
      stubs: {
        '../../services/toasts': TOASTS_STUB,
      },
    }),
  ]);

  /**
   * Свежий центр и свежий монтаж на сценарий: состояние центра не должно протекать
   * между подтестами, а хост подписывается на центр при монтировании.
   */
  function mountHost(scenario, timers) {
    globalThis.__toastCenter = createToastCenter(timers);

    const wrapper = mount(UiToastHost, {
      attachTo: browser.document.querySelector('#mount'),
    });

    scenario.after(() => {
      wrapper.unmount();
    });

    return {
      wrapper,
      toasts: globalThis.__toastCenter
    };
  }

  await t.test('H1: пустой список ничего не рисует', async (scenario) => {
    const {
      wrapper
    } = mountHost(scenario, fakeTimers());

    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('.ui-toast-host').exists(), false);
  });

  await t.test('H2/H3: три новейших в слое toast и счётчик остатка', async (scenario) => {
    const {
      wrapper,
      toasts
    } = mountHost(scenario, fakeTimers());

    for (const id of ['a', 'b', 'c', 'd']) {
      toasts.show({
        id,
        title: id
      });
    }

    await wrapper.vm.$nextTick();
    assert.equal(wrapper.findAll('.ui-toast').length, 3);
    assert.deepEqual(wrapper.findAll('.ui-toast__title').map((node) => node.text()), ['d',
      'c', 'b'
    ]);
    assert.equal(wrapper.get('.ui-toast-host').attributes('data-ui-layer'), 'toast');
    assert.match(wrapper.get('.ui-toast-host__more').text(), /Ещё 1/);
  });

  await t.test('H3: скрыть все очищает центр', async (scenario) => {
    const {
      wrapper,
      toasts
    } = mountHost(scenario, fakeTimers());

    for (const id of ['a', 'b', 'c', 'd']) {
      toasts.show({
        id,
        title: id
      });
    }

    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('.ui-toast-host__more button').exists(), true);
    await wrapper.get('.ui-toast-host__more button').trigger('click');
    await wrapper.vm.$nextTick();
    assert.equal(wrapper.findAll('.ui-toast').length, 0);
    assert.equal(toasts.list().length, 0);
  });

  await t.test('H4: тон задаёт роль, полный текст остаётся виден', async (scenario) => {
    const {
      wrapper,
      toasts
    } = mountHost(scenario, fakeTimers());

    toasts.show({
      id: 'a',
      title: 'Ответ',
      tone: 'accent'
    });
    toasts.show({
      id: 'b',
      title: 'Вопрос',
      tone: 'warning',
      detail: 'Список файлов\nls -la'
    });
    toasts.show({
      id: 'c',
      title: 'Ошибка',
      tone: 'danger',
      body: 'Проблема'
    });
    await wrapper.vm.$nextTick();
    assert.deepEqual(wrapper.findAll('.ui-toast').map((node) => node.attributes('role')),
      ['alert', 'alert', 'status']);
    assert.equal(wrapper.get('pre.ui-toast__detail').text(), 'Список файлов\nls -la');
    assert.equal(wrapper.get('[data-toast-id="a"]').find('.ui-toast__body').exists(), false);
  });

  await t.test('H4: крестик снимает только свой тост', async (scenario) => {
    const {
      wrapper,
      toasts
    } = mountHost(scenario, fakeTimers());

    toasts.show({
      id: 'a',
      title: 'A'
    });
    toasts.show({
      id: 'b',
      title: 'B'
    });

    const reasons = [];

    toasts.subscribeDismissals((toast, reason) => {
      reasons.push(`${toast.id}:${reason}`);
    });
    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('[aria-label="Закрыть оповещение"]').exists(), true);
    await wrapper.get('[data-toast-id="a"] [aria-label="Закрыть оповещение"]').trigger(
      'click');
    await wrapper.vm.$nextTick();
    assert.deepEqual(toasts.list().map((toast) => toast.id), ['b']);
    // Крестик — решение человека: история не должна считать такой тост пропущенным.
    assert.deepEqual(reasons, ['a:user']);
  });

  await t.test('H5: действие выполняется один раз после снятия', async (scenario) => {
    const {
      wrapper,
      toasts
    } = mountHost(scenario, fakeTimers());
    let calls = 0;

    toasts.show({
      id: 'a',
      title: 'A',
      actions: [{

        id: 'allow',

        label: 'Разрешить',

        run() {
          calls += 1;
        },

      }]
    });
    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('.ui-toast__actions button').exists(), true);
    await wrapper.get('.ui-toast__actions button').trigger('click');
    await new Promise(setImmediate);
    await wrapper.vm.$nextTick();
    assert.equal(calls, 1);
    assert.equal(toasts.list().length, 0);
  });

  await t.test('H6: наведение останавливает таймер', async (scenario) => {
    const timers = fakeTimers();
    const {
      wrapper,
      toasts
    } = mountHost(scenario, timers);

    toasts.show({
      id: 'a',
      title: 'A'
    });
    await wrapper.vm.$nextTick();
    await wrapper.get('.ui-toast').trigger('pointerenter');
    assert.equal(timers.active.size, 0);
    await wrapper.get('.ui-toast').trigger('pointerleave');
    assert.equal(timers.active.size, 1);
  });

  await t.test('H7: скрытый документ сохраняет тост', async (scenario) => {
    const timers = fakeTimers();
    const {
      wrapper,
      toasts
    } = mountHost(scenario, timers);

    toasts.show({
      id: 'a',
      title: 'A'
    });
    await wrapper.vm.$nextTick();
    Object.defineProperty(browser.document, 'visibilityState', {
      value: 'hidden',
      configurable: true
    });
    browser.document.dispatchEvent(new browser.Event('visibilitychange'));
    assert.equal(timers.active.size, 0);
    Object.defineProperty(browser.document, 'visibilityState', {
      value: 'visible',
      configurable: true
    });
    browser.document.dispatchEvent(new browser.Event('visibilitychange'));
    assert.equal(timers.active.size, 1);
  });

  // SCENARIOS
});
