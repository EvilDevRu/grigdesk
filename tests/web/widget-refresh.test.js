import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { compileModule, webFile } from './helpers/compile-vue.js';

/**
 * Оболочка APK объявляет capability widget; каждый тест компилирует свежий модуль,
 * поэтому внутренний throttle не наследуется между тестами.
 */
async function fixture(t, { capabilities = ['widget'], fetchImpl } = {}) {
  const calls = [];

  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  globalThis.__widgetShell = { capabilities };
  t.after(() => {
    delete globalThis.__widgetShell;
  });

  t.mock.method(globalThis, 'fetch', fetchImpl || (async (url, options) => {
    calls.push({ url, options });

    return new Response(JSON.stringify({ ok: true }));
  }));

  const api = await compileModule(webFile('src/shared/widgetRefresh.ts'), {
    stubs: {
      '../stores/shell.ts': 'export const useShellStore = () => globalThis.__widgetShell;',
      pinia: 'export const getActivePinia = () => ({});',
    },
  });

  t.after(() => api.disposePipelineWidgetRefresh());

  return { api, calls };
}

test('оболочка с виджетом получает запрос не чаще 10 секунд', async (t) => {
  const { api, calls } = await fixture(t);

  api.refreshPipelineWidget();
  t.mock.timers.tick(2000);
  api.refreshPipelineWidget();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/__shell/widget-refresh');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[0].options.body, '{}');

  t.mock.timers.tick(8000); // trailing срабатывает без третьего события

  assert.equal(calls.length, 2);
});

test('оболочка без capability не отправляет запрос', async (t) => {
  const { api, calls } = await fixture(t, { capabilities: ['scan'] });

  api.refreshPipelineWidget();

  assert.equal(api.pipelineWidgetSupported(), false);
  assert.equal(calls.length, 0);
});

test('отказ трубы не ломает обработчик событий', async (t) => {
  const { api } = await fixture(t, {
    fetchImpl: async () => {
      throw new Error('труба закрыта');
    },
  });

  api.refreshPipelineWidget();
  await Promise.resolve();
  await Promise.resolve();
});

test('AppShell зовёт обновление виджета на событии конвейера и на старте', async () => {
  const source = await readFile(webFile('src/shared/layout/AppShell.vue'), 'utf8');

  assert.match(source,
    /if \(name === 'state-change'\) \{\s*notifyWatch\.check\(\);\s*refreshPipelineWidget\(\);/);
  assert.match(source, /notifyWatch\.start\(\);\s*refreshPipelineWidget\(\);/);
  assert.match(source,
    /import \{ refreshPipelineWidget, disposePipelineWidgetRefresh \} from '\.\.\/widgetRefresh\.ts';/);
});
