import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const PANEL_PATH = webFile('src/views/ssh/SshPanel.vue');

async function mountPanel(t, { pending = {} } = {}) {
  const browser = await installUiBrowser(t, 'http://cockpit.test/#/ssh');
  const store = {
    sessions: [
      { id: 'session-a', label: 'Боевой код', role: 'code', agentAllowed: true },
      { id: 'session-b', label: 'База', role: 'db', agentAllowed: false },
    ],
    activeId: 'session-a',
    approvals: [],
    async load() {},
    activate(id) { this.activeId = id; },
    detach() {},
  };
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
        '../../stores/ssh.js': 'export const useSshStore = () => globalThis.__sshPanelStore;',
        '../../stores/chat.js': 'export const useChatStore = () => globalThis.__sshPanelChatStore;',
        './services/dialogs': `
          export const promptDialog = (options) => globalThis.__chatPermissionPrompt(options);
          export const confirmDialog = () => Promise.resolve(false);
          export const alertDialog = () => Promise.resolve();
        `,
        '@xterm/xterm': `
          export class Terminal {
            constructor() { globalThis.__sshPanelTerminals.push(this); }
            open() {}
            dispose() {}
            write() {}
          }
        `,
        '@xterm/addon-fit': 'export class FitAddon { fit() {} }',
      },
    });
  } catch (error) {
    assert.fail(`панель SSH ещё не реализована: ${error.message}`);
  }
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });
  t.after(() => {
    wrapper.unmount();
    delete globalThis.__sshPanelStore;
    delete globalThis.__sshPanelChatStore;
    delete globalThis.__sshPanelTerminals;
    delete globalThis.__chatPermissionPrompt;
  });
  await flushPromises();
  return { wrapper, store, chatStore, answers, flushPromises };
}

test('две server-owned сессии показаны вкладками при одном xterm', async (t) => {
  const { wrapper } = await mountPanel(t);

  assert.deepEqual({
    tabs: wrapper.findAll('[role="tab"]').map((entry) => entry.text()),
    terminals: globalThis.__sshPanelTerminals.length,
    terminalHosts: wrapper.findAll('[data-ssh-terminal-host]').length,
  }, {
    tabs: ['Боевой код', 'База'],
    terminals: 1,
    terminalHosts: 1,
  });
});

test('переключение внутренней вкладки переиспользует тот же xterm', async (t) => {
  const { wrapper, store, flushPromises } = await mountPanel(t);
  await wrapper.findAll('[role="tab"]')[1].trigger('click');
  await flushPromises();

  assert.deepEqual({ activeId: store.activeId, terminals: globalThis.__sshPanelTerminals.length }, {
    activeId: 'session-b',
    terminals: 1,
  });
});

test('SSH-панель показывает карточку из общего chat.pending', async (t) => {
  const command = `sudo printf '${'x'.repeat(2_000)}'`;
  const pending = {
    'ssh-pid-1': {
      pid: 'ssh-pid-1',
      origin: 'ssh',
      kind: 'perm',
      chatKey: 'chat-a',
      tool: 'supervised_ssh',
      server: { label: 'Боевой код', host: 'server.internal', port: 22 },
      user: 'root',
      isRoot: true,
      usesSudo: true,
      command,
    },
  };
  const { wrapper } = await mountPanel(t, { pending });

  assert.deepEqual({
    cards: wrapper.findAll('[data-ssh-approval]').length,
    server: wrapper.find('[data-ssh-server]').text(),
    command: wrapper.find('[data-ssh-command]').text(),
  }, {
    cards: 1,
    server: 'Боевой код — server.internal:22',
    command,
  });
});

test('SSH-панель отвечает через ту же chat.answerPerm', async (t) => {
  const pending = {
    'ssh-pid-1': {
      pid: 'ssh-pid-1',
      origin: 'ssh',
      kind: 'perm',
      chatKey: 'chat-a',
      tool: 'supervised_ssh',
      server: { label: 'Боевой код', host: 'server.internal', port: 22 },
      user: 'deploy',
      command: 'id',
    },
  };
  const { wrapper, answers } = await mountPanel(t, { pending });
  const allow = wrapper.findAll('button').find((entry) => entry.text() === 'Разрешить');
  if (allow) {
    await allow.trigger('click');
  }

  assert.deepEqual({ button: !!allow, answers }, {
    button: true,
    answers: [['ssh-pid-1', true, false, '', '']],
  });
});
