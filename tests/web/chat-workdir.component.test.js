import assert from 'node:assert/strict';
import test from 'node:test';

import { createUiBrowser } from './helpers/ui-components.js';
import { compileVue, webFile } from './helpers/compile-vue.js';

// Окно на весь файл: Vue запоминает `document` при первом импорте runtime-dom, и
// Teleport диалога из второго окна ушёл бы в body первого, уже закрытого.
let shared = null;

async function browserHarness() {
  shared ||= await createUiBrowser();
  shared.document.body.innerHTML = '<div id="mount"></div>';

  return shared;
}

/**
 * Монтирует ChatWorkdir с поддельным стором окна; стор задаёт тест.
 * Сеть компонента — только каталог проектов для выбора.
 */
async function mountWorkdir(t, browser, store) {
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );

  globalThis.__workdirChat = store;

  const Component = await compileVue(webFile('src/views/chat/ChatWorkdir.vue'), {
    stubs: {
      '../../stores/chat.js': 'export const useChatStore = () => globalThis.__workdirChat;',
      '../../shared/apiClient.ts': 'export const api = { get: async () => ({ projects: [] }) };',
    }
  });
  const wrapper = mount(Component, {
    props: { sid: 'chat' },
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__workdirChat;
  });
  await flushPromises();

  return { wrapper, flushPromises };
}

function buttonByText(browser, text) {
  return [...browser.document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text);
}

/**
 * Чат без задачи в Кокпите с уже известным предпросмотром сервера.
 * Состояние реактивное: компонент видит изменения стора так же, как в окне.
 */
async function workdirSession(extra = {}) {
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');

  return reactive({
    id: 'chat',
    taskId: null,
    workdir: { kind: 'cockpit' },
    workdirPreview: {
      target: {
        cwd: '/workspace/current',
        source: 'cockpit',
        copies: [],
        warnings: []
      }
    },
    ...extra,
  });
}

test('папка открывается одним кликом, выбор и диалог переноса работают через общий UI', async (t) => {
  const browser = await browserHarness();
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const session = await workdirSession();
  const calls = [];
  const { wrapper, flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    recentWorkdirs: [],
    previewWorkdir: async () => session.workdirPreview,
    async proposeWorkdir(id, candidate, remember) {
      calls.push({
        id,
        candidate,
        remember
      });
      session.workdirProposal = {
        preview: { target: { cwd: candidate.workdir.path }, summaryAvailable: true },
      };
    },
    commitWorkdir: async (id, transfer) => calls.push({ id, transfer }),
  });

  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();
  assert.match(browser.document.querySelector('.workdir-path').textContent, /\/workspace\/current/u);

  const field = browser.document.querySelector('input[placeholder="Абсолютный путь"]');

  assert.ok(field, 'popover открыт, поле папки доступно');
  field.value = '/workspace/next';
  field.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  buttonByText(browser, 'Выбрать папку').click();
  await flushPromises();
  assert.deepEqual(calls[0], {
    id: 'chat',
    candidate: { taskId: null, workdir: { kind: 'path', path: '/workspace/next' } },
    remember: true,
  });

  const reset = buttonByText(browser, 'Перейти без выжимки');

  assert.ok(reset);
  assert.equal(wrapper.get('[data-context="chat-workdir"]').attributes('aria-expanded'), 'false',
    'выбор папки закрыт перед диалогом переноса');
  reset.click();
  await flushPromises();
  assert.deepEqual(calls[1], { id: 'chat', transfer: 'reset' });
});

test('относительный путь объясняется на месте и не уходит на сервер', async (t) => {
  const browser = await browserHarness();
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const session = await workdirSession();
  const proposed = [];
  const { wrapper, flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    recentWorkdirs: [],
    previewWorkdir: async () => session.workdirPreview,
    async proposeWorkdir(_id, candidate) {
      proposed.push(candidate);
    },
    commitWorkdir: async () => false,
  });

  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();

  const field = browser.document.querySelector('input[placeholder="Абсолютный путь"]');

  field.value = '~/projects/demo';
  field.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  buttonByText(browser, 'Выбрать папку').click();
  await flushPromises();
  assert.deepEqual(proposed, []);
  assert.match(browser.document.body.textContent, /Нужен абсолютный путь/u);
});

test('после обрыва связи окно предлагает повторить тот же переход, а не выбрать заново', async (t) => {
  const browser = await browserHarness();
  const session = await workdirSession({
    error: 'Failed to fetch',
    workdirProposal: {
      transfer: 'resume',
      preview: {
        target: { cwd: '/workspace/next' },
        summaryAvailable: true,
        transfer: 'resume'
      },
    },
  });
  const calls = [];
  const { flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    recentWorkdirs: [],
    previewWorkdir: async () => session.workdirPreview,
    proposeWorkdir: async () => false,
    commitWorkdir: async (id, transfer) => calls.push({ id, transfer }),
  });

  assert.match(browser.document.body.textContent, /Failed to fetch/u);
  // Узел happy-dom в assert не передаётся: упавшее сравнение печатает весь граф окна и съедает ОЗУ.
  assert.equal(Boolean(buttonByText(browser, 'Сжать разговор и перейти')), false);
  assert.equal(Boolean(buttonByText(browser, 'Перейти без выжимки')), false);
  buttonByText(browser, 'Повторить').click();
  await flushPromises();
  assert.deepEqual(calls, [{ id: 'chat', transfer: 'resume' }]);
});
