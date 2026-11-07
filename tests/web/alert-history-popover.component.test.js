import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const ALERTS_STUB = [
  'const h = () => globalThis.__historyHarness;',
  'export const subscribeAlertHistory = (listener) => {',
  '  h().listener = listener;',
  '  listener(h().entries);',
  '  return () => {};',
  '};',
  'export const markAlertHistorySeen = (key) => {',
  '  h().seen.push(key ?? "*");',
  '};',
  'export const clearAlertHistory = () => {',
  '  h().cleared += 1;',
  '};',
  'export const openAlertHistoryEntry = (key) => {',
  '  h().opened.push(key);',
  '  return true;',
  '};',
].join('\n');

/**
 * Запись истории в том виде, в каком её отдаёт alerts.ts: колокольчик читает только
 * снимок и не знает, откуда взялось событие.
 */
function entry(key, state, extra = {}) {
  return Object.freeze({
    key,
    id: key,
    scope: '',
    tone: 'accent',
    title: `Событие ${key}`,
    body: '',
    target: null,
    at: Date.now(),
    state,
    ...extra,
  });
}

test('AlertHistoryPopover', async (t) => {
  const browser = await installUiBrowser(t);
  const [{ mount }, AlertHistoryPopover] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileVue(webFile('src/features/alerts/AlertHistoryPopover.vue'), {
      stubs: {
        '../../shared/alerts.ts': ALERTS_STUB,
      },
    }),
  ]);

  /**
   * Свежая история и свежий монтаж на сценарий: колокольчик подписывается при монтировании,
   * а всплывашка живёт в body, поэтому её ищем в документе, а не в обёртке.
   */
  function mountBell(scenario, entries) {
    // Закрытая всплывашка уходит с анимацией и в happy-dom задерживается в body:
    // без чистки следующий сценарий читал бы текст предыдущего.
    browser.document.body.innerHTML = '<div id="mount"></div>';
    globalThis.__historyHarness = {
      entries: Object.freeze(entries),
      seen: [],
      cleared: 0,
      opened: [],
      listener: null,
    };

    const wrapper = mount(AlertHistoryPopover, {
      attachTo: browser.document.querySelector('#mount'),
    });

    scenario.after(() => {
      wrapper.unmount();
      delete globalThis.__historyHarness;
    });

    return wrapper;
  }

  function popoverText() {
    return browser.document.querySelector('.alert-history')?.textContent || '';
  }

  await t.test('значок считает только пропущенные', async (scenario) => {
    const wrapper = mountBell(scenario, [
      entry('a', 'missed'),
      entry('b', 'seen'),
      entry('c', 'live'),
    ]);

    await wrapper.vm.$nextTick();
    assert.equal(wrapper.get('.alert-bell-badge').text(), '1');
    assert.match(wrapper.get('.alert-bell').attributes('aria-label'), /пропущено: 1/);
  });

  await t.test('без пропущенных значка нет', async (scenario) => {
    const wrapper = mountBell(scenario, [entry('a', 'seen')]);

    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('.alert-bell-badge').exists(), false);
  });

  for (const touch of [true, false]) {
    await t.test(`счётчик не обрезается подписью, touch=${touch}`, async (scenario) => {
      // Свежие DOM и style исключают кэш Happy DOM после смены корневого атрибута.
      // Проверяем настоящий компонент и CSS, отдельно для каждого режима устройства.
      browser.happyDOM.setWindowSize({ width: touch ? 390 : 1280, height: 844 });
      scenario.after(() => browser.document.documentElement.removeAttribute('data-ui-touch'));

      const wrapper = mountBell(scenario,
        Array.from({ length: 100 }, (_, index) => entry(String(index), 'missed')));
      const source = await readFile(webFile('src/features/alerts/AlertHistoryPopover.vue'), 'utf8');
      const layers = ['tokens', 'base', 'components/foundation', 'components/actions'];
      const cssText = (await Promise.all(layers.map((name) =>
        readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n')
        + '\n' + source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];
      const style = browser.document.createElement('style');

      browser.document.documentElement.toggleAttribute('data-ui-touch', touch);
      style.textContent = cssText;
      browser.document.head.append(style);
      scenario.after(() => style.remove());

      const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);

      assert.equal(wrapper.get('.alert-bell-badge').text(), '99+');
      assert.equal(css('.alert-bell').position, 'relative');
      assert.equal(css('.alert-bell .ui-button__label').overflow, 'visible');
      assert.equal(css('.alert-bell-badge').top, touch ? '2px' : '-3px');
      assert.equal(css('.alert-bell-badge').right, touch ? '2px' : '-4px');
      assert.match(wrapper.get('.alert-bell').attributes('aria-label'), /пропущено: 100/u);
    });
  }

  await t.test('открытие показывает пропущенное и отмечает просмотр', async (scenario) => {
    const wrapper = mountBell(scenario, [
      entry('a', 'missed', {
        target: {
          kind: 'chat',
          chatId: 'c1',
        },
      }),
      entry('b', 'resolved'),
    ]);

    await wrapper.get('.alert-bell').trigger('click');
    await wrapper.vm.$nextTick();

    assert.match(popoverText(), /Событие a/);
    assert.match(popoverText(), /пропущено/);
    assert.match(popoverText(), /разобрано/);
    assert.deepEqual(globalThis.__historyHarness.seen, ['*']);

    const open = [...browser.document.querySelectorAll('.alert-history button')]
      .find((button) => button.textContent.trim() === 'Открыть');

    assert.equal(Boolean(open), true);
    open.click();
    await wrapper.vm.$nextTick();
    assert.deepEqual(globalThis.__historyHarness.opened, ['a']);
  });

  await t.test('плашка появляется после ухода тоста и исчезает после просмотра', async (scenario) => {
    const bridge = [
      `import { createAlertHistory } from ${JSON.stringify(webFile('src/shared/alertHistory.ts'))};`,
      'const history = createAlertHistory();',
      'globalThis.__historyIntegration = history;',
      'export const subscribeAlertHistory = history.subscribe;',
      'export const markAlertHistorySeen = history.markSeen;',
      'export const clearAlertHistory = history.clear;',
      'export const openAlertHistoryEntry = () => false;',
    ].join('\n');
    const LiveHistoryPopover = await compileVue(webFile('src/features/alerts/AlertHistoryPopover.vue'), {
      stubs: { '../../shared/alerts.ts': bridge },
    });

    browser.document.body.innerHTML = '<div id="mount"></div>';

    const wrapper = mount(LiveHistoryPopover, {
      attachTo: browser.document.querySelector('#mount'),
    });
    const history = globalThis.__historyIntegration;

    scenario.after(() => {
      wrapper.unmount();
      delete globalThis.__historyIntegration;
    });

    history.record({ id: 'test', title: 'Проверка оповещения' });
    await wrapper.vm.$nextTick();
    assert.equal(wrapper.find('.alert-bell-badge').exists(), false);

    history.toastGone('test', 'timeout');
    await wrapper.vm.$nextTick();
    assert.equal(wrapper.get('.alert-bell-badge').text(), '1');
    assert.match(wrapper.get('.alert-bell').attributes('aria-label'), /пропущено: 1/u);

    await wrapper.get('.alert-bell').trigger('click');
    await wrapper.vm.$nextTick();
    assert.equal(history.list()[0].state, 'seen');
    assert.equal(wrapper.find('.alert-bell-badge').exists(), false);
    assert.doesNotMatch(wrapper.get('.alert-bell').attributes('aria-label'), /пропущено/u);
  });

  await t.test('пустая история объясняет себя и не предлагает очистку', async (scenario) => {
    const wrapper = mountBell(scenario, []);

    await wrapper.get('.alert-bell').trigger('click');
    await wrapper.vm.$nextTick();

    assert.match(popoverText(), /Пока пусто/);
    assert.doesNotMatch(popoverText(), /Очистить/);
  });
});
