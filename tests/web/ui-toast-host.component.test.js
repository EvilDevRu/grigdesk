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

  /**
   * Жест проходит через DOM-обработчики реальной карточки, а не вызовы её методов.
   * Явный pointerId позволяет проверить отмену и чужие касания без настоящего устройства.
   */
  async function pointer(node, type, x, y = 20, extra = {}) {
    node.element.dispatchEvent(new browser.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 7,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      clientX: x,
      clientY: y,
      ...extra,
    }));
    await new Promise(setImmediate);
  }

  for (const direction of [-1, 1]) {
    await t.test(`свайп ${direction} закрывает свой тост без выполнения действия`, async (scenario) => {
      const timers = fakeTimers();
      const { wrapper, toasts } = mountHost(scenario, timers);
      const reasons = [];
      let calls = 0;

      toasts.subscribeDismissals((toast, reason) => reasons.push([toast.id, reason]));
      toasts.show({ id: 'other', title: 'Другой' });
      toasts.show({
        id: 'swipe',
        title: 'Свайп',
        actions: [{
          id: 'open',
          label: 'Открыть',
          run: () => {
            calls += 1;
          },
        }],
      });
      await wrapper.vm.$nextTick();

      const card = wrapper.get('[data-toast-id="swipe"]');

      await pointer(card, 'pointerdown', 150);
      assert.equal(timers.active.size, 1, 'таймер касаемого тоста приостановлен');
      await pointer(card, 'pointermove', 150 + 120 * direction);
      assert.equal(card.element.style.getPropertyValue('--ui-toast-swipe-x'), `${120 * direction}px`);
      await pointer(card, 'pointerup', 150 + 120 * direction);
      await wrapper.vm.$nextTick();

      assert.deepEqual(toasts.list().map((toast) => toast.id), ['other']);
      assert.deepEqual(reasons, [['swipe', 'user']]);
      assert.equal(calls, 0);
    });
  }

  for (const target of ['.ui-toast__title', '.ui-toast__body', '.ui-toast__icon svg']) {
    await t.test(`передача неявного захвата от ${target} сохраняет свайп`, async (scenario) => {
      const timers = fakeTimers();
      const { wrapper, toasts } = mountHost(scenario, timers);

      toasts.show({
        id: 'a',
        title: 'Ответ',
        body: 'Текст уведомления',
      });
      await wrapper.vm.$nextTick();

      const card = wrapper.get('.ui-toast');
      const child = card.get(target);

      // Touch сначала неявно захватывает дочерний элемент. При передаче захвата
      // карточке браузер отправляет старому владельцу всплывающий lostpointercapture.
      await pointer(child, 'pointerdown', 100);
      await pointer(child, 'pointermove', 120);
      await pointer(child, 'lostpointercapture', 120);
      await pointer(card, 'gotpointercapture', 120);
      assert.equal(card.attributes('data-swiping'), 'true');
      assert.equal(timers.active.size, 0);

      await pointer(card, 'pointermove', 240);
      await pointer(card, 'pointerup', 240);
      await wrapper.vm.$nextTick();
      assert.equal(toasts.list().length, 0);
    });
  }

  for (const ending of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    await t.test(`${ending}: незавершённый жест возвращает тост и таймер`, async (scenario) => {
      const timers = fakeTimers();
      const { wrapper, toasts } = mountHost(scenario, timers);

      toasts.show({ id: 'a', title: 'A' });
      await wrapper.vm.$nextTick();

      const card = wrapper.get('.ui-toast');

      await pointer(card, 'pointerdown', 100);
      await pointer(card, 'pointermove', 120);
      assert.equal(timers.active.size, 0);
      await pointer(card, ending, 120);

      assert.equal(toasts.list().length, 1);
      assert.equal(card.element.style.getPropertyValue('--ui-toast-swipe-x'), '0px');
      assert.equal(card.attributes('data-swiping'), undefined);
      assert.equal(timers.active.size, 1);
    });
  }

  await t.test('вертикальный жест и посторонний палец не закрывают тост', async (scenario) => {
    const { wrapper, toasts } = mountHost(scenario, fakeTimers());

    toasts.show({ id: 'a', title: 'A' });
    await wrapper.vm.$nextTick();

    const card = wrapper.get('.ui-toast');

    await pointer(card, 'pointerdown', 100);
    await pointer(card, 'pointermove', 104, 80);
    await pointer(card, 'pointermove', 250, 80);
    await pointer(card, 'pointerup', 250, 80);
    assert.equal(toasts.list().length, 1);
    assert.equal(card.element.style.getPropertyValue('--ui-toast-swipe-x'), '0px');

    await pointer(card, 'pointerdown', 100);
    await pointer(card, 'pointermove', 250, 20, { pointerId: 8 });
    await pointer(card, 'pointerup', 250, 20, { pointerId: 8 });
    assert.equal(toasts.list().length, 1);
    await pointer(card, 'pointercancel', 100);
  });

  await t.test('кнопки и подробности не начинают свайп, обычное нажатие работает', async (scenario) => {
    const { wrapper, toasts } = mountHost(scenario, fakeTimers());
    let calls = 0;

    toasts.show({
      id: 'a',
      title: 'A',
      detail: 'Полная команда',
      actions: [{
        id: 'open',
        label: 'Открыть',
        run: () => {
          calls += 1;
        },
      }],
    });
    await wrapper.vm.$nextTick();

    const card = wrapper.get('.ui-toast');
    const action = card.get('.ui-toast__actions button');

    for (const target of [card.get('pre'), action]) {
      await pointer(target, 'pointerdown', 100);
      await pointer(card, 'pointermove', 240);
      await pointer(card, 'pointerup', 240);
      assert.equal(toasts.list().length, 1);
    }

    await action.trigger('click', { detail: 1 });
    assert.equal(calls, 0, 'движение по кнопке не превращается в подтверждение');
    await pointer(action, 'pointerdown', 100);
    await pointer(action, 'pointerup', 100);
    await action.trigger('click', { detail: 1 });
    assert.equal(calls, 1);
    assert.equal(toasts.list().length, 0);
  });

  await t.test('случайный клик после жеста подавлен, следующее нажатие разрешено', async (scenario) => {
    const { wrapper, toasts } = mountHost(scenario, fakeTimers());
    let calls = 0;

    toasts.show({
      id: 'a',
      title: 'A',
      actions: [{
        id: 'open',
        label: 'Открыть',
        run: () => {
          calls += 1;
        },
      }],
    });
    await wrapper.vm.$nextTick();

    const card = wrapper.get('.ui-toast');
    const action = card.get('.ui-toast__actions button');

    await pointer(card, 'pointerdown', 100);
    await pointer(card, 'pointermove', 120);
    await pointer(card, 'pointerup', 120);
    await action.trigger('click', { detail: 1 });
    assert.equal(calls, 0);

    await pointer(action, 'pointerdown', 100);
    await action.trigger('click', { detail: 1 });
    assert.equal(calls, 1);
  });

  await t.test('обновление того же id отменяет старый свайп', async (scenario) => {
    const { wrapper, toasts } = mountHost(scenario, fakeTimers());

    toasts.show({ id: 'a', title: 'Прежний' });
    await wrapper.vm.$nextTick();

    const card = wrapper.get('.ui-toast');

    await pointer(card, 'pointerdown', 100);
    await pointer(card, 'pointermove', 240);
    toasts.show({ id: 'a', title: 'Обновлённый' });
    await wrapper.vm.$nextTick();
    await pointer(card, 'pointerup', 240);

    assert.equal(toasts.list().length, 1);
    assert.equal(card.get('.ui-toast__title').text(), 'Обновлённый');
    assert.equal(card.element.style.getPropertyValue('--ui-toast-swipe-x'), '0px');
  });

  await t.test('уход указателя не запускает таймер при фокусе внутри', async (scenario) => {
    const timers = fakeTimers();
    const { wrapper, toasts } = mountHost(scenario, timers);

    toasts.show({ id: 'a', title: 'A' });
    await wrapper.vm.$nextTick();

    const card = wrapper.get('.ui-toast');

    await card.trigger('focusin');
    await card.trigger('pointerleave');
    assert.equal(timers.active.size, 0);
    await card.trigger('focusout', { relatedTarget: browser.document.body });
    assert.equal(timers.active.size, 1);
  });

  for (const elapsed of [100, 500]) {
    await t.test(`короткий бросок за ${elapsed} мс учитывает скорость`, async (scenario) => {
      const { wrapper, toasts } = mountHost(scenario, fakeTimers());

      toasts.show({ id: 'a', title: 'A' });
      await wrapper.vm.$nextTick();

      const card = wrapper.get('.ui-toast');

      for (const [type, x, timeStamp] of [
        ['pointerdown', 100, 0],
        ['pointermove', 148, 50],
        ['pointerup', 148, elapsed],
      ]) {
        const event = new browser.PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          isPrimary: true,
          pointerId: 7,
          pointerType: 'touch',
          button: 0,
          clientX: x,
          clientY: 20,
        });

        Object.defineProperty(event, 'timeStamp', { value: timeStamp });
        card.element.dispatchEvent(event);
        await wrapper.vm.$nextTick();
      }

      assert.equal(toasts.list().length, elapsed === 100 ? 0 : 1);
    });
  }

  await t.test('мышь не начинает свайп, вытесненный тост освобождает паузу', async (scenario) => {
    const timers = fakeTimers();
    const { wrapper, toasts } = mountHost(scenario, timers);

    toasts.show({ id: 'a', title: 'A' });
    await wrapper.vm.$nextTick();

    const card = wrapper.get('.ui-toast');

    await pointer(card, 'pointerdown', 100, 20, { pointerType: 'mouse' });
    await pointer(card, 'pointermove', 240, 20, { pointerType: 'mouse' });
    await pointer(card, 'pointerup', 240, 20, { pointerType: 'mouse' });
    assert.equal(toasts.list().length, 1);
    assert.equal(card.element.style.getPropertyValue('--ui-toast-swipe-x'), '0px');

    await pointer(card, 'pointerdown', 100);
    assert.equal(timers.active.size, 0);

    for (const id of ['b', 'c', 'd']) {
      toasts.show({ id, title: id });
    }

    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('[data-toast-id="a"]').exists(), false);
    assert.equal(timers.active.size, 4, 'невидимый тост не остаётся на паузе навсегда');
  });
});
