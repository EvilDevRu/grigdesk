import assert from 'node:assert/strict';
import test from 'node:test';

import { installBrowser } from './helpers/board-view.js';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { multiCatalog, SOURCE_A, SOURCE_B } from './helpers/trackerMultiView.js';

process.env.NODE_ENV = 'test';

/**
 * Проверяет реальные обработчики AttentionAlerts и настоящий чип источника.
 * Panel открыт постоянно: тест не зависит от hover/телепорта верхней панели.
 */
async function attentionFixture(t, { hold = false } = {}) {
  const browser = await installBrowser(t);
  const calls = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const issues = [SOURCE_A, SOURCE_B].map((source) => ({
    task: 42,
    source,
    analysis: null,
    status: { task: 42, state: 'interrupted' },
  }));

  globalThis.__attentionSources = {
    store: { disabled: false, issues },
    trackers: { catalog: multiCatalog() },
    async restart(...args) {
      calls.push(['restart', ...args]);

      if (hold) {
        await gate;
      }
    },
    async dismiss(...args) {
      calls.push(['dismiss', ...args]);
    },
  };

  const component = await compileVue(webFile('src/features/analysis/AttentionAlerts.vue'), {
    stubs: {
      '../../actions/analysis': `
        export const useAnalysisStore = () => globalThis.__attentionSources.store;
        export const analyzeTask = (...args) => globalThis.__attentionSources.restart(...args);
        export const dismissAnalysis = (...args) => globalThis.__attentionSources.dismiss(...args);
        export const startAnalysisPolling = () => {};
      `,
      '../stores/trackers.ts':
        'export const useTrackersStore = () => globalThis.__attentionSources.trackers;',
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.body,
    global: {
      stubs: {
        teleport: true,
        UiTopbarPanel: { template: '<div><slot name="trigger"/><slot/><slot name="footer"/></div>' },
      },
    },
  });

  t.after(async () => {
    release();
    await flushPromises();
    wrapper.unmount();
    delete globalThis.__attentionSources;
  });
  await flushPromises();

  return {
    wrapper,
    calls,
    release,
    flushPromises,
  };
}

/**
 * Пара проверяется по полному source независимо от принятой формы optional argument.
 * Номер обязан оставаться первым аргументом существующих actions.
 */
function assertPair(call, operation, source) {
  assert.equal(call[0], operation);
  assert.equal(String(call[1]), '42');
  assert.ok(JSON.stringify(call.slice(2)).includes(source), `Операция потеряла ${source}`);
}

test('SOURCE-ATTENTION-01: строки различимы и busy блокирует только свою пару', async (t) => {
  const fx = await attentionFixture(t, { hold: true });
  const rows = fx.wrapper.findAll('.attention-row');

  assert.equal(rows.length, 2);
  await rows[0].findAll('button')[0].trigger('click');
  await fx.flushPromises();

  assert.equal(rows[0].findAll('button')[0].element.disabled, true);
  assert.equal(rows[1].findAll('button')[0].element.disabled, false,
    'Ожидание A42 не блокирует B42');
  assertPair(fx.calls[0], 'restart', SOURCE_A);
  assert.ok(rows[0].find('.task-source-chip').exists());
  assert.ok(rows[1].find('.task-source-chip').exists());
  assert.match(rows[0].text(), /Альфа/);
  assert.match(rows[1].text(), /Бета/);
});

test('SOURCE-ATTENTION-01: restart и dismiss каждой строки сохраняют source', async (t) => {
  const fx = await attentionFixture(t);
  const rows = fx.wrapper.findAll('.attention-row');

  for (const [index, source] of [SOURCE_A, SOURCE_B].entries()) {
    await rows[index].findAll('button')[0].trigger('click');
    await fx.flushPromises();
    await rows[index].findAll('button')[1].trigger('click');
    await fx.flushPromises();
    assertPair(fx.calls[index * 2], 'restart', source);
    assertPair(fx.calls[index * 2 + 1], 'dismiss', source);
  }
});

test('SOURCE-ATTENTION-01: существующие массовые операции передают обе пары по очереди', async (t) => {
  for (const operation of ['restart', 'dismiss']) {
    await t.test(operation, async (st) => {
      const fx = await attentionFixture(st);
      const label = operation === 'restart' ? /[Пп]ерезапустить все/ : /[Сс]крыть все/;
      const button = fx.wrapper.findAll('button').find((candidate) => label.test(candidate.text()));

      assert.ok(button, 'Существующая массовая кнопка доступна');
      await button.trigger('click');
      await fx.flushPromises();
      assert.equal(fx.calls.length, 2);
      assertPair(fx.calls[0], operation, SOURCE_A);
      assertPair(fx.calls[1], operation, SOURCE_B);
    });
  }
});
