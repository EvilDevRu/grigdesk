import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDraft } from '../fixtures/routes-editor.mjs';
import { capabilities, roleCatalog } from '../fixtures/routes-stage-wizard.mjs';
import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

test('Настоящий диалог добавления этапа', async (suite) => {
  const browser = await installUiBrowser(suite, 'http://grigdesk.test/#/routes');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const catalog = await roleCatalog();
  const Component = await compileVue(webFile('src/views/routes/RouteStageWorkspace.vue'), {
    stubs: {
      './RouteStageList.vue': 'export default { render: () => null };',
      './RouteStageWizard.vue': 'export default { render: () => null };',
      '../../shared/routesApi.ts': `
export const routesApi = {
  stageRoles(profile) { return globalThis.__routeAddApi(profile); },
};`,
    },
  });
  const doc = browser.document;

  /**
   * Ждёт асинхронную загрузку или окончание настоящего Transition ограниченное время.
   * Ошибка содержит только скалярный результат, DOM-объекты не сравниваются.
   */
  async function until(predicate) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await flushPromises();


      if (predicate()) {
        return;
      }


      await new Promise((resolve) => setTimeout(resolve, 10));
    }


    assert.fail('Ожидаемое состояние диалога не наступило за 1 с');
  }

  /**
   * Каждый сценарий получает свой reactive документ, но остаётся в одном DOM.
   * API возвращает reactive роли, чтобы команда действительно проходила UI-границу.
   */
  async function setup(t, { empty = false, fetchRoles = null, noCommands = false } = {}) {
    const draft = makeDraft();


    if (empty) {
      draft.routes.quick.route.nodes = [];
      draft.routes.quick.route.entry = null;
      draft.routes.quick.route.sequence = { main: [], tail: [] };
      draft.routes.quick.prompts = {};
    }


    const document = reactive(draft);
    const profiles = [];


    globalThis.__routeAddApi = async (profile) => {
      profiles.push(profile);


      return fetchRoles ? fetchRoles() : reactive(catalog);
    };


    const wrapper = mount(Component, {
      attachTo: doc.querySelector('#mount'),
      props: {
        document,
        profile: 'sample',
        scope: { kind: 'route', routeId: 'quick' },
        capabilities: reactive({ ...capabilities, commands: noCommands ? [] : capabilities.commands }),
      },
      global: { stubs: { transition: false } },
    });


    t.after(async () => {
      wrapper.unmount();
      await flushPromises();
    });

    return {
      wrapper,
      profiles,
      document
    };
  }

  /**
   * Открывает диалог через настоящий control и сохраняет точный элемент возврата.
   * Наличие телепортированного узла проверяется в общем document.
   */
  async function open(wrapper) {
    const trigger = wrapper.get('[data-test="canvas-add-stage"]').element;


    trigger.focus();
    trigger.click();
    await until(() => Boolean(doc.querySelector('[data-test="route-add-dialog"]')));

    return trigger;
  }

  /**
   * Активирует реальный control после проверки его наличия.
   * Ожидает очередь Vue перед чтением emitted и состояния диалога.
   */
  async function click(selector) {
    const element = doc.querySelector(selector);


    assert.equal(Boolean(element), true, selector);
    element.click();
    await flushPromises();
  }

  await suite.test('RE-G5-04: реальный диалог добавляет human из reactive каталога', async (t) => {
    const f = await setup(t);


    await open(f.wrapper);
    await until(() => Boolean(doc.querySelector('[data-test="add-role-human"]')));
    await click('[data-test="add-role-human"]');


    const changes = f.wrapper.emitted('change') ?? [];


    assert.equal(changes.length, 1);
    assert.equal(changes[0][0].routes.quick.route.nodes
      .filter((node) => node.executor === 'gate').length, 2);
    assert.deepEqual(f.profiles, ['sample']);
    await until(() => !doc.querySelector('[data-test="route-add-dialog"]'));
  });

  await suite.test('RE-G5-11: custom в пустом reactive маршруте сохраняет текст', async (t) => {
    const f = await setup(t, { empty: true });


    await open(f.wrapper);
    await until(() => Boolean(doc.querySelector('[data-test="add-role-custom"]')));
    await click('[data-test="add-role-custom"]');


    const input = doc.querySelector('[data-test="add-custom-description"]');


    input.value = 'Мой полный текст\nс новой строкой';
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
    await flushPromises();
    await click('[data-test="add-custom-confirm"]');


    const changes = f.wrapper.emitted('change') ?? [];


    assert.equal(changes.length, 1);


    const bundle = changes[0][0].routes.quick;


    assert.equal(Object.values(bundle.prompts).includes('Мой полный текст\nс новой строкой'), true);
  });

  await suite.test('RE-G5-12: Escape закрывает верхний диалог и возвращает фокус', async (t) => {
    const f = await setup(t);
    const trigger = await open(f.wrapper);


    await until(() => Boolean(doc.querySelector('[data-test="add-role-human"]')));


    const dialog = doc.querySelector('[data-test="route-add-dialog"]');


    await until(() => dialog.contains(doc.activeElement));
    assert.equal(Boolean(doc.querySelector('#mount').inert), true);


    const buttons = [...dialog.querySelectorAll('button:not([disabled])')];


    buttons.at(-1).focus();
    buttons.at(-1).dispatchEvent(new browser.KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true,
    }));
    await flushPromises();
    assert.equal(doc.activeElement === buttons[0], true);
    doc.activeElement.dispatchEvent(new browser.KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true,
    }));
    await until(() => !doc.querySelector('[data-test="route-add-dialog"]'));
    assert.equal(doc.activeElement === trigger, true);
    assert.equal((f.wrapper.emitted('change') ?? []).length, 0);
  });

  await suite.test('RE-G5-13: loading → error → retry → empty без изменения документа', async (t) => {
    let reject;
    let calls = 0;
    const held = new Promise((_, fail) => {
      reject = fail;
    });
    const f = await setup(t, { fetchRoles: () => (++calls === 1 ? held : { roles: [] }) });


    await open(f.wrapper);
    assert.equal(Boolean(doc.querySelector('[data-test="add-roles-loading"]')), true);
    reject(new Error('fixture failure'));
    await until(() => Boolean(doc.querySelector('[data-test="add-roles-retry"]')));
    await click('[data-test="add-roles-retry"]');
    await until(() => Boolean(doc.querySelector('[data-test="add-roles-empty"]')));
    assert.equal((f.wrapper.emitted('change') ?? []).length, 0);
    await click('[data-test="add-close"]');
    await until(() => !doc.querySelector('[data-test="route-add-dialog"]'));
  });

  await suite.test('RE-G5-14: роли без команд disabled; закрытие отсекает поздний ответ', async (t) => {
    const f = await setup(t, { noCommands: true });


    await open(f.wrapper);
    await until(() => Boolean(doc.querySelector('[data-test="add-role-review"]')));
    assert.equal(doc.querySelector('[data-test="add-role-review"]').disabled, true);
    assert.equal(doc.querySelector('[data-test="add-role-command"]').disabled, true);
    await click('[data-test="add-close"]');
    await until(() => !doc.querySelector('[data-test="route-add-dialog"]'));

    let resolve;


    globalThis.__routeAddApi = () => new Promise((done) => {
      resolve = done;
    });
    await open(f.wrapper);
    await click('[data-test="add-close"]');
    resolve(reactive(catalog));
    await until(() => !doc.querySelector('[data-test="route-add-dialog"]'));
    assert.equal((f.wrapper.emitted('change') ?? []).length, 0);
  });
});
