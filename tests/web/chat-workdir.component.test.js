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
      '../../stores/chat.ts': 'export const useChatStore = () => globalThis.__workdirChat;',
      '../../shared/apiClient.ts': `export const api = { get: async () => ({
        projects: globalThis.__workdirProjects || [],
      }) };`,
    }
  });
  const wrapper = mount(Component, {
    props: { sid: 'chat' },
    attachTo: browser.document.querySelector('#mount'),
    global: { stubs: { transition: false } },
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__workdirChat;
    delete globalThis.__workdirProjects;
  });
  await flushPromises();

  return { wrapper, flushPromises };
}

function buttonByText(browser, text) {
  return [...browser.document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text);
}

/**
 * Чат без задачи в GrigDesk с уже известным предпросмотром сервера.
 * Состояние реактивное: компонент видит изменения стора так же, как в окне.
 */
async function workdirSession(extra = {}) {
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');

  return reactive({
    id: 'chat',
    taskId: null,
    workdir: { kind: 'grigdesk' },
    workdirPreview: {
      target: {
        cwd: '/workspace/current',
        source: 'grigdesk',
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
  const session = await workdirSession({ workdirState: { committed: { cwd: '/workspace/current' } } });
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

  assert.equal(wrapper.get('[data-context="chat-workdir"]').text(), 'current');
  assert.equal(wrapper.get('[data-context="chat-workdir"]').attributes('data-ui-tooltip'),
    'Работаем в: /workspace/current');
  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();
  assert.match(browser.document.querySelector('.workdir-path').textContent, /\/workspace\/current/u);

  buttonByText(browser, 'По пути').click();
  await flushPromises();

  const field = browser.document.querySelector('input[placeholder="/home/user/project"]');

  assert.ok(field, 'диалог открыт, поле папки доступно');
  assert.equal(browser.document.activeElement === field, true, 'ручной ввод получает фокус по запросу');
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

  session.workdirPreview.target.cwd = '/workspace/next';
  await flushPromises();
  assert.equal(wrapper.get('[data-context="chat-workdir"]').text(), 'current',
    'предпросмотр перехода не заменяет текущий каталог');

  const reset = buttonByText(browser, 'Перейти без выжимки');

  assert.ok(reset);
  assert.equal(wrapper.get('[data-context="chat-workdir"]').attributes('aria-expanded'), 'false',
    'выбор папки закрыт перед диалогом переноса');
  reset.click();
  await flushPromises();
  assert.deepEqual(calls[1], { id: 'chat', transfer: 'reset' });

  session.workdirState.committed.cwd = '/workspace/next/';
  await flushPromises();
  assert.equal(wrapper.get('[data-context="chat-workdir"]').text(), 'next');
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

  buttonByText(browser, 'По пути').click();
  await flushPromises();

  const field = browser.document.querySelector('input[placeholder="/home/user/project"]');

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

test('каталог объединяет проекты и недавние без повторов, поиск сохраняет реальный выбор', async (t) => {
  const browser = await browserHarness();
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const project = {
    kind: 'project',
    projectId: 'demo',
    repoKey: null,
  };
  const session = await workdirSession({ workdir: project });
  const calls = [];

  globalThis.__workdirProjects = [
    { id: 'demo', title: 'Демо' },
    { id: 'other', title: 'Второй проект' },
    {
      id: 'archived',
      title: 'Архивный',
      archivedAt: '2026-01-01',
    },
  ];

  const { wrapper, flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    recentWorkdirs: [project, { kind: 'path', path: '/workspace/other' }, { kind: 'grigdesk' }],
    previewWorkdir: async () => session.workdirPreview,
    proposeWorkdir: async (...args) => {
      calls.push(args);

      return true;
    },
  });

  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();

  const dialog = browser.document.querySelector('[data-role="workdir-picker"]');

  assert.equal(Boolean(dialog.closest('[data-mobile-sheet]')), true);
  assert.equal(dialog.querySelectorAll('.workdir-choice').length, 4);
  assert.equal(dialog.querySelectorAll('.is-selected').length, 1);
  assert.match(dialog.textContent, /Папки на подключённом компьютере/u);
  assert.match(dialog.textContent, /Папка приложения GrigDesk/u);
  assert.doesNotMatch(dialog.textContent, /Архивный/u);

  const search = dialog.querySelector('input[type="search"]');

  search.value = 'ВТОРОЙ';
  search.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  assert.equal(dialog.querySelectorAll('.workdir-choice').length, 1);
  dialog.querySelector('.ui-selectable-row__primary').click();
  await flushPromises();
  assert.deepEqual(calls, [['chat', {
    taskId: null,
    workdir: {
      kind: 'project',
      projectId: 'other',
      repoKey: null,
    },
  }, true]]);
  assert.equal(wrapper.get('[data-context="chat-workdir"]').attributes('aria-expanded'), 'false');
});

test('пустой поиск и отказ сервера остаются в диалоге, новый вход очищает поиск', async (t) => {
  const browser = await browserHarness();
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const session = await workdirSession();
  const { wrapper, flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    recentWorkdirs: [{ kind: 'path', path: '/workspace/missing' }],
    previewWorkdir: async () => session.workdirPreview,
    proposeWorkdir: async () => {
      session.error = 'Каталог не найден';

      return false;
    },
  });

  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();

  const search = browser.document.querySelector('input[type="search"]');

  search.value = 'unknown';
  search.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  assert.match(browser.document.querySelector('[role="status"]').textContent, /Ничего не найдено/u);
  buttonByText(browser, 'По пути').click();
  await flushPromises();

  const field = browser.document.querySelector('input[placeholder="/home/user/project"]');

  field.value = '/workspace/missing';
  field.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  field.closest('form').dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true }));
  await flushPromises();
  assert.equal(wrapper.get('[data-context="chat-workdir"]').attributes('aria-expanded'), 'true');
  assert.match(browser.document.querySelector('[data-role="workdir-picker"]').textContent,
    /Каталог не найден/u);
  browser.document.querySelector('[data-role="workdir-picker"] button[aria-label="Закрыть"]').click();
  await flushPromises();
  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();
  assert.equal(browser.document.querySelector('input[type="search"]').value, '');
  assert.equal(Boolean(browser.document.querySelector('form')), false);
});

test('возврат из ручного ввода сохраняет фильтр, черновик пути и фокус действия', async (t) => {
  const browser = await browserHarness();
  const { nextTick } = await import('../../web/node_modules/vue/index.mjs');
  const session = await workdirSession();
  const { wrapper, flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    recentWorkdirs: [{ kind: 'path', path: '/workspace/example' }],
    previewWorkdir: async () => session.workdirPreview,
  });

  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();

  const search = browser.document.querySelector('input[type="search"]');

  search.value = 'example';
  search.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  buttonByText(browser, 'По пути').click();
  await flushPromises();

  const field = browser.document.querySelector('input[placeholder="/home/user/project"]');

  field.value = '/workspace/draft';
  field.dispatchEvent(new browser.Event('input', { bubbles: true }));
  await nextTick();
  buttonByText(browser, 'К проектам и папкам').click();
  await flushPromises();
  assert.equal(browser.document.querySelector('input[type="search"]').value, 'example');
  assert.equal(browser.document.querySelectorAll('.workdir-choice').length, 1);
  assert.equal(browser.document.activeElement === buttonByText(browser, 'По пути'), true);
  buttonByText(browser, 'По пути').click();
  await flushPromises();
  assert.equal(browser.document.querySelector('input[placeholder="/home/user/project"]').value,
    '/workspace/draft');
});

test('папка задачи доступна для просмотра без каталога и ручного ввода', async (t) => {
  const browser = await browserHarness();
  const session = await workdirSession({ taskId: 'task' });
  const { wrapper, flushPromises } = await mountWorkdir(t, browser, {
    workdirProtocol: 1,
    sessions: [session],
    archived: [],
    previewWorkdir: async () => session.workdirPreview,
  });

  await wrapper.get('[data-context="chat-workdir"]').trigger('click');
  await flushPromises();
  assert.match(browser.document.querySelector('[data-role="workdir-picker"]').textContent,
    /Папка определяется задачей/u);
  assert.equal(Boolean(browser.document.querySelector('input')), false);
});
