import assert from 'node:assert/strict';
import test from 'node:test';

import { compileVue, webFile } from './helpers/compile-vue.js';
import { installUiBrowser } from './helpers/ui-components.js';

const CONTAINERS = webFile('src/views/docker/DockerContainers.vue');

// Элементы управления остаются настоящими. Подменяем только решение человека
// в диалоге и внешние данные, чтобы проверять действия самой панели.
const UI_STUB = `
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiCheckbox } from '${webFile('src/components/primitives/UiCheckbox.vue')}';
export { default as UiIconButton } from '${webFile('src/components/primitives/UiIconButton.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export { default as UiSearchInput } from '${webFile('src/components/composites/UiSearchInput.vue')}';
export const confirmDialog = async (text, options) => {
  globalThis.__dockerContainersHarness.confirmations.push({ text, options });
  return globalThis.__dockerContainersHarness.confirmed;
};
`;

const INVENTORY = [
  {
    id: 'web',
    name: 'demo-web-1',
    image: 'nginx:stable',
    state: 'running',
    status: 'Up 2 hours',
    health: 'healthy',
    ports: [{ published: 8088, target: 80, protocol: 'tcp' }],
    compose: { project: 'demo', service: 'web', workingDir: '/workspace/demo' },
  },
  {
    id: 'worker',
    name: 'demo-worker-1',
    image: 'node:22',
    state: 'running',
    status: 'Up 1 hour',
    health: '',
    ports: [],
    compose: { project: 'demo', service: 'worker', workingDir: '/workspace/demo' },
  },
  {
    id: 'database',
    name: 'demo-database-1',
    image: 'postgres:17',
    state: 'exited',
    status: 'Exited (0)',
    health: '',
    ports: [{ published: null, target: 5432, protocol: 'tcp' }],
    compose: { project: 'demo', service: 'database', workingDir: '/workspace/demo' },
  },
  {
    id: 'standalone',
    name: 'standalone',
    image: 'example/tool:latest',
    state: 'running',
    status: 'Up 3 hours',
    health: '',
    ports: [{ published: 9001, target: 9000, protocol: 'tcp' }],
    compose: null,
  },
];

/**
 * Стор фиксирует запросы панели без настоящего Docker. Полный состав проекта
 * содержит и скрытый поиском сервис, и остановленный контейнер для проверки границ действий.
 */
async function mountContainers(t, { values = {}, stats = {}, busyIds = [] } = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/docker');
  const containerCalls = [];
  const projectCalls = [];
  const removalCalls = [];
  const logsCalls = [];
  const execCalls = [];
  const containers = structuredClone(INVENTORY);
  const harness = {
    store: {
      containers,
      loading: false,
      isBusy: (id) => busyIds.includes(id),
      async containerAction(id, action) {
        containerCalls.push({ id, action });

        return { ok: true };
      },
      async projectAction(project, action) {
        projectCalls.push({ project, action });

        return { ok: true };
      },
      async removeContainer(id, options) {
        removalCalls.push({ id, options });

        return { ok: true };
      },
    },
    plugins: { byId: () => ({ id: 'docker', values }) },
    confirmed: true,
    confirmations: [],
  };

  globalThis.__dockerContainersHarness = harness;

  const component = await compileVue(CONTAINERS, {
    stubs: {
      '../../stores/docker': (
        'export const useDockerStore = () => globalThis.__dockerContainersHarness.store;'
      ),
      '../../stores/plugins.ts': (
        'export const usePluginsStore = () => globalThis.__dockerContainersHarness.plugins;'
      ),
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, {
    props: {
      stats,
      onLogs: (container) => logsCalls.push(container),
      onExec: (container) => execCalls.push(container),
    },
    attachTo: browser.document.querySelector('#mount'),
  });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__dockerContainersHarness;
  });

  await flushPromises();

  return {
    browser,
    wrapper,
    flushPromises,
    harness,
    containers,
    containerCalls,
    projectCalls,
    removalCalls,
    logsCalls,
    execCalls,
  };
}

test('поиск находит опубликованный и внутренний порт с учётом показа незапущенных', async (t) => {
  const { wrapper } = await mountContainers(t);
  const search = wrapper.get('input[type="search"]');

  await search.setValue('8088');

  assert.equal(wrapper.findAll('.docker-row').length, 1);
  assert.equal(wrapper.get('.docker-row__name strong').text(), 'web');
  assert.equal(wrapper.get('.docker-port').attributes('href'), 'http://grigdesk.test:8088/');
  assert.match(wrapper.get('.docker-containers__caption').text(), /1 из 4/u);

  await search.setValue('5432');

  assert.equal(wrapper.findAll('.docker-row').length, 0);
  assert.match(wrapper.text(), /Контейнеры не найдены/u);

  await wrapper.get('input[type="checkbox"]').setValue(true);

  assert.equal(wrapper.findAll('.docker-row').length, 1);
  assert.equal(wrapper.get('.docker-row__name strong').text(), 'database');
  assert.equal(wrapper.find('a.docker-port').exists(), false, 'внутренний порт не открывается ссылкой');
  assert.equal(wrapper.get('.docker-port').text(), '5432/tcp');
});

test('счётчик и остановка проекта включают скрытые поиском и незапущенные контейнеры', async (t) => {
  const { wrapper, harness, projectCalls, flushPromises } = await mountContainers(t);

  await wrapper.get('input[type="search"]').setValue('8088');

  assert.equal(wrapper.findAll('.docker-row').length, 1);
  assert.match(wrapper.get('.docker-group__count').text(), /2 \/ 3 работают/u);

  harness.confirmed = false;
  await wrapper.get('button[aria-label="Остановить проект demo"]').trigger('click');
  await flushPromises();

  assert.equal(projectCalls.length, 0, 'отказ человека не останавливает проект');
  assert.match(harness.confirmations[0].text, /«demo» — 3 контейнер/u);
  assert.equal(harness.confirmations[0].options.danger, true);

  harness.confirmed = true;
  await wrapper.get('button[aria-label="Остановить проект demo"]').trigger('click');
  await flushPromises();

  assert.deepEqual(projectCalls, [{ project: 'demo', action: 'stop' }]);
  assert.match(wrapper.text(), /demo остановлен/u);
});

test('удаление требует подтверждения и передаёт принудительную остановку работающего', async (t) => {
  const { wrapper, harness, removalCalls, flushPromises } = await mountContainers(t);
  const remove = wrapper.get('button[aria-label="Удалить контейнер demo-web-1"]');

  harness.confirmed = false;
  await remove.trigger('click');
  await flushPromises();

  assert.equal(removalCalls.length, 0);
  assert.match(harness.confirmations[0].text, /demo-web-1/u);
  assert.match(harness.confirmations[0].text, /остановлен принудительно/u);
  assert.equal(harness.confirmations[0].options.danger, true);

  harness.confirmed = true;
  await remove.trigger('click');
  await flushPromises();

  assert.deepEqual(removalCalls, [{ id: 'web', options: { force: true } }]);

  await wrapper.get('input[type="checkbox"]').setValue(true);
  await wrapper.get('button[aria-label="Удалить контейнер demo-database-1"]').trigger('click');
  await flushPromises();

  assert.deepEqual(removalCalls.at(-1), { id: 'database', options: { force: false } });
  assert.doesNotMatch(harness.confirmations.at(-1).text, /принудительно/u);
});

test('сворачивание проекта обновляет aria и скрывает содержимое с сохранением строк', async (t) => {
  const { browser, wrapper } = await mountContainers(t);
  const toggle = wrapper.get('button[aria-label="Свернуть проект demo"]');
  const targetId = toggle.attributes('aria-controls');
  const target = browser.document.getElementById(targetId);

  assert.ok(target, 'aria-controls указывает на существующий блок проекта');
  assert.equal(toggle.attributes('aria-expanded'), 'true');
  assert.equal(target.querySelectorAll('.docker-row').length, 2);
  assert.notEqual(target.style.display, 'none');

  await toggle.trigger('click');

  assert.equal(toggle.attributes('aria-expanded'), 'false');
  assert.equal(toggle.attributes('aria-label'), 'Развернуть проект demo');
  assert.equal(target.style.display, 'none');
  assert.equal(target.querySelectorAll('.docker-row').length, 2, 'v-show сохраняет строки проекта');

  await toggle.trigger('click');

  assert.equal(toggle.attributes('aria-expanded'), 'true');
  assert.notEqual(target.style.display, 'none');
  assert.equal(browser.document.getElementById(targetId) === target, true);
});

test('выключенный настройкой терминал не открывается даже у работающего контейнера', async (t) => {
  const { wrapper, execCalls } = await mountContainers(t, { values: { allowExec: false } });
  const terminal = wrapper.get('button[aria-label="Терминал в контейнере demo-web-1"]');

  assert.equal(terminal.attributes('disabled'), '');
  assert.match(terminal.attributes('data-ui-tooltip'), /выключен в настройках/u);

  await terminal.trigger('click');

  assert.deepEqual(execCalls, []);
});

test('логи и терминал передают выбранный контейнер, запуск — его id и действие', async (t) => {
  const fixture = await mountContainers(t);
  const { wrapper, containers, containerCalls, logsCalls, execCalls, flushPromises } = fixture;

  await wrapper.get('button[aria-label="Логи demo-web-1"]').trigger('click');
  await wrapper.get('button[aria-label="Терминал в контейнере demo-web-1"]').trigger('click');

  assert.deepEqual(logsCalls, [containers[0]]);
  assert.deepEqual(execCalls, [containers[0]]);

  await wrapper.get('input[type="checkbox"]').setValue(true);

  const stoppedTerminal = wrapper.get('button[aria-label="Терминал в контейнере demo-database-1"]');

  assert.equal(stoppedTerminal.attributes('disabled'), '');

  await stoppedTerminal.trigger('click');
  await wrapper.get('button[aria-label="Запустить demo-database-1"]').trigger('click');
  await wrapper.get('button[aria-label="Перезапустить demo-web-1"]').trigger('click');
  await flushPromises();

  assert.equal(execCalls.length, 1, 'остановленный контейнер не открывает оболочку');
  assert.deepEqual(containerCalls, [
    { id: 'database', action: 'start' },
    { id: 'web', action: 'restart' },
  ]);
});

test('старая статистика остановленного контейнера скрыта, работающий показывает актуальную', async (t) => {
  const { wrapper } = await mountContainers(t, {
    stats: {
      web: { cpuPercent: 12.4, memoryUsed: 128 * 1024 ** 2 },
      database: { cpuPercent: 73.8, memoryUsed: 512 * 1024 ** 2 },
    },
  });

  await wrapper.get('input[type="checkbox"]').setValue(true);

  const running = wrapper.findAll('.docker-row')
    .find((row) => row.find('button[aria-label="Логи demo-web-1"]').exists());
  const stopped = wrapper.findAll('.docker-row')
    .find((row) => row.find('button[aria-label="Логи demo-database-1"]').exists());

  assert.match(running.get('.docker-row__cpu').text(), /12%/u);
  assert.match(running.get('.docker-row__memory').text(), /128 МБ/u);
  assert.match(stopped.get('.docker-row__cpu').text(), /—/u);
  assert.match(stopped.get('.docker-row__memory').text(), /—/u);
  assert.doesNotMatch(stopped.text(), /74%|512 МБ/u);
});

test('занятый проект блокирует повторные изменения входящих в него контейнеров', async (t) => {
  const { wrapper, containerCalls, projectCalls, removalCalls } = await mountContainers(t, {
    busyIds: ['demo'],
  });
  const labels = [
    'Перезапустить demo-web-1',
    'Остановить demo-web-1',
    'Удалить контейнер demo-web-1',
    'Остановить проект demo',
  ];

  for (const label of labels) {
    const button = wrapper.get(`button[aria-label="${label}"]`);

    assert.equal(button.attributes('disabled'), '');
    await button.trigger('click');
  }

  assert.deepEqual(containerCalls, []);
  assert.deepEqual(projectCalls, []);
  assert.deepEqual(removalCalls, []);
});

test('занятый контейнер блокирует действия проекта, даже когда поиск скрыл его строку', async (t) => {
  const { wrapper, harness, projectCalls, flushPromises } = await mountContainers(t, {
    busyIds: ['worker'],
  });

  await wrapper.get('input[type="search"]').setValue('8088');

  assert.equal(wrapper.findAll('.docker-row').length, 1);
  assert.equal(wrapper.get('.docker-row__name strong').text(), 'web');
  assert.equal(wrapper.find('button[aria-label="Логи demo-worker-1"]').exists(), false);

  const actions = wrapper.findAll('.docker-group__actions button');

  assert.equal(actions.length, 2, 'проект предлагает перезапуск и остановку');

  for (const button of actions) {
    assert.equal(button.attributes('disabled'), '', 'занятость считается по полному составу проекта');
    await button.trigger('click');
  }

  await flushPromises();

  assert.deepEqual(projectCalls, []);
  assert.deepEqual(harness.confirmations, [], 'занятый проект не начинает подтверждение остановки');
});
