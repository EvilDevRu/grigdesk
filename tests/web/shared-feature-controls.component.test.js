// Перенесённые shared-контролы сохраняют доменные действия поверх public UI facade.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  compileVue,
  webFile,
} from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

process.env.NODE_ENV = 'test';

const PROJECT_SWITCHER_PATH = webFile(
  'src/features/projects/ProjectSwitcher.vue',
);
const ATTENTION_ALERTS_PATH = webFile(
  'src/features/analysis/AttentionAlerts.vue',
);
const DIALOG_SERVICE_STUB = `
  export const promptDialog = (options) => globalThis.__projectPrompt(options);
  export const alertDialog = (text, options) => globalThis.__projectAlert(text, options);
  export const confirmDialog = () => Promise.resolve(false);
`;
const API_STUB = `
  export const api = {
    post: (...args) => globalThis.__projectPost(...args),
  };
`;
const ANALYSIS_STUB = `
  export const useAnalysisStore = () => globalThis.__attentionAnalysis;
  export const analyzeTask = (...args) => globalThis.__attentionAnalysis.analyze(...args);
  export const dismissAnalysis = (...args) => globalThis.__attentionAnalysis.dismiss(...args);
  export const startAnalysisPolling = () => globalThis.__attentionAnalysis.startPolling?.();
`;

let projectSwitcherPromise;
let attentionAlertsPromise;

function compileProjectSwitcher() {
  projectSwitcherPromise ||= compileVue(PROJECT_SWITCHER_PATH, {
    stubs: {
      './services/dialogs': DIALOG_SERVICE_STUB,
      '../../shared/apiClient.ts': API_STUB,
    },
  });

  return projectSwitcherPromise;
}

function compileAttentionAlerts() {
  attentionAlertsPromise ||= compileVue(ATTENTION_ALERTS_PATH, {
    stubs: {
      '../../actions/analysis': ANALYSIS_STUB,
    },
  });

  return attentionAlertsPromise;
}

function button(wrapper, label) {
  return wrapper.findAll('button').find((entry) => entry.text() === label);
}

test('ProjectSwitcher переключает профиль и создаёт новый через UI-диалог', async (t) => {
  const browser = await installUiBrowser(t);
  const requests = [];
  let promptOptions;

  globalThis.__projectPrompt = async (options) => {
    promptOptions = options;

    return 'new_project';
  };
  globalThis.__projectAlert = async () => {};
  globalThis.__projectPost = async (...args) => {
    requests.push(args);

    return { profiles: ['alpha', 'beta', 'new_project'] };
  };

  const [{ mount, flushPromises }, ProjectSwitcher] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileProjectSwitcher(),
  ]);
  const wrapper = mount(ProjectSwitcher, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      profiles: ['alpha', 'beta'],
      modelValue: 'alpha',
    },
  });

  t.after(() => wrapper.unmount());

  await button(wrapper, 'beta').trigger('click');
  await wrapper.get('[aria-label="Новый проект"]').trigger('click');
  await flushPromises();

  assert.deepEqual(wrapper.emitted('update:modelValue'), [['beta']]);
  assert.equal(promptOptions.title, 'Новый проект');
  assert.deepEqual(requests, [[
    '/api/profiles',
    { id: 'new_project' },
  ]]);
  assert.deepEqual(wrapper.emitted('created'), [[{
    id: 'new_project',
    profiles: ['alpha', 'beta', 'new_project'],
  }]]);
});

test('ProjectSwitcher не отправляет недопустимый идентификатор', async (t) => {
  const browser = await installUiBrowser(t);
  const alerts = [];
  let postCount = 0;

  globalThis.__projectPrompt = async () => 'Bad project';
  globalThis.__projectAlert = async (...args) => {
    alerts.push(args);
  };
  globalThis.__projectPost = async () => {
    postCount += 1;

    return { profiles: [] };
  };

  const [{ mount, flushPromises }, ProjectSwitcher] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileProjectSwitcher(),
  ]);
  const wrapper = mount(ProjectSwitcher, {
    attachTo: browser.document.querySelector('#mount'),
    props: {
      profiles: ['alpha'],
      modelValue: 'alpha',
    },
  });

  t.after(() => wrapper.unmount());

  await wrapper.get('[aria-label="Новый проект"]').trigger('click');
  await flushPromises();

  assert.equal(postCount, 0);
  assert.match(alerts[0][0], /a–z/);
  assert.equal(wrapper.emitted('created'), undefined);
});

test('AttentionAlerts запускает и скрывает оценки через общие actions', async (t) => {
  const browser = await installUiBrowser(t);
  const analyzed = [];
  const dismissed = [];
  let pollingStarts = 0;

  globalThis.__attentionAnalysis = {
    issues: [
      {
        task: 17,
        status: {
          state: 'interrupted',
        },
      },
      {
        task: 23,
        status: {
          state: 'failed',
          error: 'таймаут',
        },
      },
    ],
    startPolling() {
      pollingStarts += 1;
    },
    async analyze(id) {
      analyzed.push(id);
    },
    async dismiss(id) {
      dismissed.push(id);
    },
  };

  const [{ mount, flushPromises }, AttentionAlerts] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileAttentionAlerts(),
  ]);
  const wrapper = mount(AttentionAlerts, {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      stubs: {
        UiPopover: {
          template: '<section><slot name="trigger" /><slot /></section>',
        },
      },
    },
  });

  t.after(() => wrapper.unmount());

  assert.equal(pollingStarts, 1);
  assert.match(wrapper.text(), /#17/);
  assert.match(wrapper.text(), /таймаут/);

  await button(wrapper, '↻ Перезапустить все (2)').trigger('click');
  await flushPromises();
  await wrapper.get('[aria-label="Скрыть оценку #23"]').trigger('click');
  await flushPromises();

  assert.deepEqual(analyzed, [17, 23]);
  assert.deepEqual(dismissed, [23]);
});

test('AttentionAlerts не опрашивает и не показывает ошибки выключенного триажа', async (t) => {
  const browser = await installUiBrowser(t);
  let pollingStarts = 0;

  globalThis.__attentionAnalysis = {
    disabled: true,
    issues: [{
      task: 23,
      status: { state: 'failed', error: 'старый таймаут' },
    }],
    startPolling() {
      pollingStarts += 1;
    },
    async analyze() {},
    async dismiss() {},
  };

  const [{ mount }, AttentionAlerts] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    compileAttentionAlerts(),
  ]);
  const wrapper = mount(AttentionAlerts, {
    attachTo: browser.document.querySelector('#mount'),
    global: {
      stubs: {
        UiPopover: {
          template: '<section><slot name="trigger" /><slot /></section>',
        },
      },
    },
  });
  t.after(() => wrapper.unmount());

  assert.deepEqual({
    pollingStarts,
    staleIssueVisible: wrapper.text().includes('старый таймаут'),
  }, {
    pollingStarts: 0,
    staleIssueVisible: false,
  });
});
