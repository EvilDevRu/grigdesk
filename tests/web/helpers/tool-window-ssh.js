import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { compileVue, webFile } from './compile-vue.js';
import { installUiBrowser } from './ui-components.js';

const PANEL_PATH = webFile('src/views/ssh/SshPanel.vue');

/**
 * Настоящая SSH-панель получает управляемые server-owned сессии.
 * Xterm не соединяется с машиной владельца, выбор вкладок остаётся настоящим.
 */
export async function mountSshPanel(t, { pending = {}, store: storeOverrides = {}, props = {} } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/ssh');
  const { reactive } = await import('../../../web/node_modules/vue/index.mjs');
  const savedConnections = [];
  const store = reactive({

    connections: [],

    projects: [
      { id: 'grigdesk', factory: false },
      { id: 'factory-project', factory: true },
    ],

    files: [],

    audit: [],

    remotePath: '.',

    sessions: [
      {

        id: 'session-a',

        projectId: 'grigdesk',

        label: 'Боевой код',

        role: 'code',

        agentAllowed: true,

      },
      {

        id: 'session-b',

        projectId: 'grigdesk',

        label: 'База',

        role: 'db',

        agentAllowed: false,

      },
    ],

    activeId: 'session-a',

    approvals: [],

    async load() { },

    async loadProjects() { },

    async saveConnection(connection) {
      savedConnections.push(connection);
    },

    async closeSession() { },

    async setAgentAccess() { },

    async listFiles() { },

    async uploadFile() { },

    downloadUrl: (path) => `/api/ssh/download?path=${path}`,

    activate(id) {
      this.activeId = id;
    },

    bindTerminal() { },

    sendInput() { },

    resize() { },

    detach() { },

    ...storeOverrides,

  });
  const answers = [];
  const chatStore = {
    pending,
    answerPerm(...args) {
      answers.push(args);
    },
  };

  globalThis.__sshPanelStore = store;
  globalThis.__sshPanelChatStore = chatStore;
  globalThis.__sshPanelTerminals = [];
  globalThis.__chatPermissionPrompt = async () => null;

  let component;

  try {
    component = await compileVue(PANEL_PATH, {
      stubs: {

        '../../actions/ssh': `
          // Порты принадлежат этому mount, даже если следующий mount сменит globals.
          // Старый unmount обязан снять свой клиент после очистки общей фикстуры.
          const store = globalThis.__sshPanelStore;
          const bridge = () => store;
          export const useSshStore = bridge;
          export const loadSsh = (...args) => bridge().load(...args);
          export const loadSshProjects = (...args) => bridge().loadProjects(...args);
          export const saveSshConnection = (...args) => bridge().saveConnection(...args);
          export const probeSshHostKey = (...args) => bridge().probeHostKey(...args);
          export const decideSshHostKey = (...args) => bridge().decideHostKey(...args);
          export const connectSshSession = (...args) => bridge().connect(...args);
          export const closeSshSession = (...args) => bridge().closeSession(...args);
          export const setSshAgentAccess = (...args) => bridge().setAgentAccess(...args);
          export const listSshFiles = (...args) => bridge().listFiles(...args);
          export const uploadSshFile = (...args) => bridge().uploadFile(...args);
          export const sshDownloadUrl = (...args) => bridge().downloadUrl(...args);
          export const activateSshSession = (...args) => bridge().activate(...args);
          export const bindSshTerminal = (...args) => bridge().bindTerminal(...args);
          export const sendSshInput = (...args) => bridge().sendInput(...args);
          export const resizeSshTerminal = (...args) => bridge().resize(...args);
          export const detachSshTerminal = (...args) => bridge().detach(...args);
          export const watchSsh = () => {};
        `,

        '../../shared/chatApprovals.ts': (
          'export const useChatApprovals = () => globalThis.__sshPanelChatStore;'
        ),

        './services/dialogs': `
          export const promptDialog = (options) => globalThis.__chatPermissionPrompt(options);
          export const confirmDialog = () => Promise.resolve(false);
          export const alertDialog = () => Promise.resolve();
        `,

        '@xterm/xterm': `
          export class Terminal {
            constructor() {
              this.cols = 100;
              this.rows = 30;
              globalThis.__sshPanelTerminals.push(this);
            }
            loadAddon() {}
            open() {}
            dispose() {}
            write() {}
            focus() {}
            onData() { return { dispose() {} }; }
          }
        `,

        '@xterm/addon-fit': 'export class FitAddon { fit() {} }',

      },
    });
  } catch(error) {
    assert.fail(`панель SSH ещё не реализована: ${error.message}`);
  }

  const { mount, flushPromises } = await import(
    '../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    attachTo: browser.document.querySelector('#mount'),
    props,
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__sshPanelStore;
    delete globalThis.__sshPanelChatStore;
    delete globalThis.__sshPanelTerminals;
    delete globalThis.__chatPermissionPrompt;
  });
  await flushPromises();

  return {
    wrapper,
    store,
    chatStore,
    answers,
    savedConnections,
    flushPromises

  };
}

