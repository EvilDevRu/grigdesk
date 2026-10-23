import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';

const PANEL = webFile('src/views/db/DbPanel.vue');
const DB_ACTIONS_STUB = `
  const bridge = () => globalThis.__dbPanelStore;
  export const useDbStore = bridge;
  export const loadDb = (...args) => bridge().load(...args);
  export const loadDbProjects = (...args) => bridge().loadProjects?.(...args);
  export const loadDbSshSessions = (...args) => bridge().loadSshSessions?.(...args);
  export const loadDbSchema = (...args) => bridge().loadSchema?.(...args);
  export const openDbSession = (...args) => bridge().openSession?.(...args);
  export const closeDbSession = (...args) => bridge().closeSession?.(...args);
  export const setDbAgentAccess = (...args) => bridge().setAgentAccess?.(...args);
  export const saveDbProfile = (...args) => bridge().saveProfile?.(...args);
  export const runDbQuery = (...args) => bridge().runQuery?.(...args);
  export const cancelDbQuery = (...args) => bridge().cancelQuery?.(...args);
  export const watchDb = () => {};
`;

/**
 * Настоящая БД-панель получает только подмену внешних действий.
 * Выбор вкладок и редактор SQL остаются продуктовыми.
 */
export async function mountDbPanel(t, store, props = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/db');

  globalThis.__dbPanelStore = store;

  const component = await compileVue(PANEL, {
    stubs: {
      // Заглушка сопоставляется по точной строке импорта: панель зовёт операции
      // раздела, а состояние берёт из того же реактивного объекта.
      '../../actions/db': DB_ACTIONS_STUB,
    },
  });
  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dbPanelStore;
  });
  await flushPromises();

  return { wrapper, flushPromises };
}

