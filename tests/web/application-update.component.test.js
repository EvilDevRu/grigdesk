import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

/**
 * Монтирует production dialog и production store, заменяя только shell transport.
 * Ответы long-poll меняют реактивный снимок; action стора не подставляется готовым результатом.
 */
async function mountedUpdates(t, browser) {
  const { mount } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const { reactive, nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const { createPinia, setActivePinia } = await import('../../web/node_modules/pinia/dist/pinia.mjs');
  const pinia = createPinia();
  const calls = [];
  const snapshot = reactive({
    channel: 'dev',
    running: '0.2.0',
    targetVersion: '0.3.0-dev.42',
    notes: { ru: 'Исправлена загрузка', en: 'Download fixed' },
    scope: 'pair',
    checkState: 'available',
    checkedAt: null,
    error: null,
    job: null,
  });
  const shell = reactive({
    capabilities: ['appUpdates'],
    snapshot: { applicationUpdate: snapshot },
    refresh: async () => {},
  });

  globalThis.__applicationUpdateUi = {
    shell,
    action: async (method, url, body) => {
      calls.push({
        method,
        url,
        body,
      });

      if (url === '/updates/prepare') {
        snapshot.job = {
          id: 'сохранённое-задание',
          version: snapshot.targetVersion,
          scope: snapshot.scope,
          stage: 'downloading',
          downloadedBytes: 50,
          totalBytes: 100,
          nextAction: null,
        };

        if (globalThis.__applicationUpdateUi.loseResponse) {
          throw new Error('Ответ потерян после создания задания');
        }
      }
    },
  };
  setActivePinia(pinia);

  const component = await compileVue(webFile('src/shared/ApplicationUpdateDialog.vue'), {
    stubs: {
      './shell.ts': 'export const useShellStore = () => globalThis.__applicationUpdateUi.shell;',
      '../shared/shellClient.ts': 'export const shellAction = (...args) => '
        + 'globalThis.__applicationUpdateUi.action(...args);',
    },
  });
  const wrapper = mount(component, { attachTo: browser.document.body, global: { plugins: [pinia] } });
  const store = pinia._s.get('applicationUpdate');

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__applicationUpdateUi;
  });
  store.open = true;
  await nextTick();

  return {
    browser,
    wrapper,
    store,
    shell,
    snapshot,
    calls,
    nextTick,
  };
}

test('Обновление приложения в production dialog/store', async (t) => {
  const browser = await installUiBrowser(t);

  await t.test('UI-CONTENT/PROGRESS/LATER/REOPEN: store сохраняет одно задание', async (t) => {
    const view = await mountedUpdates(t, browser);
    const text = () => view.browser.document.body.textContent ?? '';

    assert.match(text(), /0\.2\.0/);
    assert.match(text(), /0\.3\.0-dev\.42/);
    assert.match(text(), /dev/);
    assert.match(text(), /Исправлена загрузка/);

    globalThis.__applicationUpdateUi.loseResponse = true;

    const prepare = [...view.browser.document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Обновить'));

    assert.ok(prepare);
    prepare.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await view.nextTick();
    assert.match(text(), /50%/);
    assert.equal(view.store.progress, 50);

    view.store.open = false;
    await view.nextTick();
    view.store.open = true;
    await view.nextTick();
    assert.equal(view.store.snapshot.job.id, 'сохранённое-задание');
    assert.equal(view.calls.filter((call) => call.url === '/updates/prepare').length, 1);

    view.snapshot.job.stage = 'preparing';
    await view.nextTick();
    assert.equal(view.store.progress, null);
    assert.doesNotMatch(text(), /50%/);
    view.snapshot.job.stage = 'ready';
    await view.nextTick();

    const later = [...view.browser.document.querySelectorAll('button')]
      .find((button) => button.textContent.includes('Позже'));

    assert.ok(later);
    later.click();
    await view.nextTick();
    assert.equal(view.store.open, false);
    assert.equal(view.store.snapshot.job.stage, 'ready');
    assert.equal(view.calls.filter((call) => call.url === '/updates/apply').length, 0);
  });

  await t.test('UI-REMOTE: desktop и CLI-инструкция, ошибки и nextAction без server mutation', async (t) => {
    const view = await mountedUpdates(t, browser);

    view.snapshot.scope = 'desktop';
    view.snapshot.notes = null;
    view.snapshot.checkState = 'error';
    view.snapshot.error = 'release_signature_invalid';
    view.snapshot.job = {
      id: 'ошибка',
      stage: 'failed',
      scope: 'desktop',
      version: '0.3.0-dev.42',
      nextAction: 'resume-update',
      recoverable: true,
    };
    await view.nextTick();

    const text = view.browser.document.body.textContent ?? '';

    assert.match(text, /grigdesk-ctl/);
    assert.match(text, /release_signature_invalid/);
    assert.match(text, /описан|описани/i);
    assert.equal(view.browser.document.querySelector('[role="progressbar"]'), null);
    await view.store.action('resume');
    assert.deepEqual(view.calls, [{
      method: 'POST',
      url: '/updates/resume',
      body: {},
    }]);
  });

});
