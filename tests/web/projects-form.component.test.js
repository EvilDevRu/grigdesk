// Форма паспорта проекта: правки, проверка путей, сохранение и отказы сервера.
//
// Форма живёт на странице и работает с черновиком из стора: правку она отдаёт
// операциям раздела, а не ходит в сеть сама. Здесь проверяется то, что видит
// человек: какая кнопка активна, где появилась подсказка и куда встал фокус.
import assert from 'node:assert/strict';
import test from 'node:test';

import { installUiBrowser } from './helpers/ui-components.js';
import { compileModule, compileVue, webFile } from './helpers/compile-vue.js';

const VIEW = webFile('src/views/ProjectsView.vue');
const draftModule = await compileModule(webFile('src/views/projects/projectDraft.ts'));

const UI_STUB = `
export { default as UiPaneHeader } from '${webFile('src/components/composites/UiPaneHeader.vue')}';
export { default as UiButton } from '${webFile('src/components/primitives/UiButton.vue')}';
export { default as UiIconButton } from '${webFile('src/components/primitives/UiIconButton.vue')}';
export { default as UiInput } from '${webFile('src/components/primitives/UiInput.vue')}';
export { default as UiRadio } from '${webFile('src/components/primitives/UiRadio.vue')}';
export { default as UiSelect } from '${webFile('src/components/primitives/UiSelect.vue')}';
export { default as UiTextarea } from '${webFile('src/components/primitives/UiTextarea.vue')}';
export { default as UiPressable } from '${webFile('src/components/primitives/UiPressable.vue')}';
export { default as UiSearchInput } from '${webFile('src/components/composites/UiSearchInput.vue')}';
export { default as UiField } from '${webFile('src/components/composites/UiField.vue')}';
export { default as UiFormActions } from '${webFile('src/components/composites/UiFormActions.vue')}';
export { default as UiInlineMessage } from '${webFile('src/components/feedback/UiInlineMessage.vue')}';
export { default as UiSpinner } from '${webFile('src/components/primitives/UiSpinner.vue')}';
export { default as UiTooltip } from '${webFile('src/components/overlays/UiTooltip.vue')}';
export const alertDialog = async () => true;
export const confirmDialog = async () => globalThis.__projectsFormHarness.confirmed;
export const promptDialog = async () => null;
`;

const ACTIONS_STUB = `
export const useProjectsStore = () => globalThis.__projectsFormHarness.store;
export const watchProjects = () => {};
export const loadProjects = async () => {};
export const loadProject = async () => {};
export const saveProject = async (id, draft, options) => {
  globalThis.__projectsFormHarness.calls.push(['save', id, JSON.parse(JSON.stringify(draft)), options]);
  return globalThis.__projectsFormHarness.saveResult;
};
export const checkRepositories = async (dirs, options) => {
  globalThis.__projectsFormHarness.calls.push(['check', dirs, options]);
};
export const loadDependencies = async (id) => {
  globalThis.__projectsFormHarness.calls.push(['dependencies', id]);
};
export const archiveProject = async (id, options) => {
  globalThis.__projectsFormHarness.calls.push(['archive', id, options]);
  return globalThis.__projectsFormHarness.lifecycleResult;
};
export const restoreProject = async (id, options) => {
  globalThis.__projectsFormHarness.calls.push(['restore', id, options]);
  return globalThis.__projectsFormHarness.lifecycleResult;
};
`;

const ROUTER_STUB = `
export const useRoute = () => globalThis.__projectsFormHarness.route;
export const useRouter = () => globalThis.__projectsFormHarness.router;
export const onBeforeRouteLeave = () => {};
export const onBeforeRouteUpdate = () => {};
`;

const CONTEXT_STUB = `
export const useUiContextSource = () => ({ update: () => {}, focus: () => {}, blur: () => {} });
`;

const REPOS = [
  { key: 'be', dir: '/srv/demo/be', exists: true },
  { key: 'fe', dir: '/srv/demo/fe', exists: false },
];

const DETAIL = {
  id: 'demo',
  title: 'Демо-проект',
  description: 'Описание проекта',
  tags: ['конвейер'],
  repos: REPOS,
  defaultRepoKey: 'be',
  archivedAt: null,
  revision: 3,
  updatedAt: '2026-09-22T10:00:00.000Z',
  profile: {
    present: false,
    pathsSource: 'passport',
    readable: null,
    repos: [],
    capabilities: [],
    mismatch: [],
  },
  importStatus: 'none',
  routes: ['hunt'],
  warnings: [],
  createdAt: '2026-09-22T09:00:00.000Z',
  import: { status: 'none', fingerprint: null, at: null, error: null, candidates: null },
};

/** Профильный проект: пути задаёт профиль фабрики, строки репозиториев read-only. */
function profileDetail() {
  return {
    ...DETAIL,
    profile: {
      present: true,
      pathsSource: 'profile',
      readable: true,
      repos: REPOS.map(({ key, dir }) => ({ key, dir })),
      capabilities: ['triage'],
      mismatch: [],
    },
  };
}

/**
 * Страница монтируется с открытым паспортом: форма получает черновик из стора,
 * а операции раздела подменены — проверяется поведение формы, а не сеть.
 */
async function mountForm(t, {
  detail = DETAIL,
  draft = null,
  saveResult = { ok: true, fieldErrors: [] },
  dependencies = null,
  lifecycleResult = { ok: true, error: '', message: '' },
  confirmed = true,
} = {}) {
  const browser = await installUiBrowser(t, 'http://grigdesk.test/#/projects/demo');
  const { reactive } = await import('../../web/node_modules/vue/index.mjs');
  const route = reactive({ path: '/projects/demo', params: { id: 'demo' }, query: {} });
  const store = reactive({
    items: [],
    opened: detail,
    draft: draft ?? draftModule.createDraft(detail),
    conflict: null,
    loading: false,
    error: '',
    checks: {},
    dependencies,
  });
  const harness = {
    confirmed,
    calls: [],
    lifecycleResult,
    pushes: [],
    saveResult,
    store,
    route,
    router: {
      async push(target) {
        harness.pushes.push(target);
      },
    },
  };

  globalThis.__projectsFormHarness = harness;
  Object.defineProperty(browser.window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });

  const component = await compileVue(VIEW, {
    stubs: {
      '../stores/chat.js': 'export const useChatStore = () => ({ _load: async () => {} });',
      '../actions/projects': ACTIONS_STUB,
      '../../actions/projects': ACTIONS_STUB,
      '../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      '../../ui': (UI_STUB) +
        "\nexport { vTooltip } from \"./src/services/tooltipDirective.ts\";",
      '../composables/useUiContextSource.ts': CONTEXT_STUB,
      'vue-router': ROUTER_STUB,
    },
  });
  const { mount, flushPromises } = await import(
    '../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const wrapper = mount(component, { attachTo: browser.document.querySelector('#mount') });

  t.after(() => {
    wrapper.unmount();
    delete globalThis.__projectsFormHarness;
  });

  await flushPromises();

  return { wrapper, harness };
}

function saveButton(wrapper) {
  return wrapper.find('[data-role="project-save"]');
}

function repoKeys(wrapper) {
  return wrapper.findAll('[data-role="project-repo-row"]').map((row) => row.attributes('data-repo-key'));
}

test('Сохранить неактивна без изменений и активна после правки title', async (t) => {
  const { wrapper } = await mountForm(t);

  assert.ok(saveButton(wrapper).attributes('disabled') !== undefined);
  assert.equal(wrapper.find('[data-role="project-title"]').element.value, 'Демо-проект');

  await wrapper.find('[data-role="project-title"]').setValue('Другое название');

  assert.equal(saveButton(wrapper).attributes('disabled'), undefined);
});

test('отправка с относительным путём показывает ошибку у поля и ставит фокус на него', async (t) => {
  const { wrapper, harness } = await mountForm(t);

  await wrapper.find('[data-role="project-repo-dir"]').setValue('srv/demo/be');
  harness.calls.length = 0;
  await saveButton(wrapper).trigger('click');

  assert.deepEqual(harness.calls.filter(([name]) => name === 'save'), []);
  assert.match(wrapper.find('[data-role="project-repo-row"]').text(), /абсолютн/i);
  // Сравнивается скаляр, а не DOM-узел: упавший assert с узлом happy-dom съедает память.
  assert.equal(
    document.activeElement?.getAttribute('data-role'),
    'project-repo-dir',
    'фокус встаёт на первое ошибочное поле',
  );
});

test('добавление, удаление, Выше/Ниже и переименование ключа с переносом defaultRepoKey', async (t) => {
  const { wrapper, harness } = await mountForm(t);

  await wrapper.find('[data-role="project-repo-add"]').trigger('click');
  assert.equal(harness.store.draft.repos.length, 3);
  assert.deepEqual(repoKeys(wrapper), ['be', 'fe', '']);

  await wrapper.findAll('[data-role="project-repo-remove"]')[2].trigger('click');
  assert.equal(harness.store.draft.repos.length, 2);

  await wrapper.findAll('[data-role="project-repo-down"]')[0].trigger('click');
  assert.deepEqual(repoKeys(wrapper), ['fe', 'be']);

  await wrapper.findAll('[data-role="project-repo-up"]')[1].trigger('click');
  assert.deepEqual(repoKeys(wrapper), ['be', 'fe']);

  await wrapper.findAll('[data-role="project-repo-key"]')[0].setValue('backend');

  assert.deepEqual(repoKeys(wrapper), ['backend', 'fe']);
  assert.equal(harness.store.draft.defaultRepoKey, 'backend');
});

test('удаление выбранного репозитория при оставшихся строках блокирует отправку до выбора', async (t) => {
  const { wrapper, harness } = await mountForm(t);

  await wrapper.findAll('[data-role="project-repo-remove"]')[0].trigger('click');

  assert.deepEqual(repoKeys(wrapper), ['fe']);
  assert.equal(harness.store.draft.defaultRepoKey, null);
  assert.ok(saveButton(wrapper).attributes('disabled') !== undefined);
  assert.match(wrapper.text(), /выберите репозиторий по умолчанию/i);

  await wrapper
    .find('[data-role="project-repo-default"][data-repo-key="fe"]')
    .setValue(true);

  assert.equal(harness.store.draft.defaultRepoKey, 'fe');
  assert.equal(saveButton(wrapper).attributes('disabled'), undefined);
});

test('серверные fieldErrors раскладываются по полям', async (t) => {
  const { wrapper, harness } = await mountForm(t, {
    saveResult: {
      ok: false,
      fieldErrors: [{ path: 'title', message: 'Название уже занято другим проектом' }],
    },
  });

  await wrapper.find('[data-role="project-title"]').setValue('Занятое название');
  await saveButton(wrapper).trigger('click');

  assert.equal(harness.calls.filter(([name]) => name === 'save').length, 1);

  const titleField = wrapper.findAll('.ui-field').find((field) => (
    field.find('[data-role="project-title"]').exists()
  ));

  assert.match(titleField.text(), /Название уже занято другим проектом/);
});

test('профильный проект: строки репозиториев заблокированы, остальные поля активны', async (t) => {
  const { wrapper } = await mountForm(t, { detail: profileDetail() });

  assert.ok(wrapper.find('[data-role="project-repo-dir"]').attributes('disabled') !== undefined);
  assert.ok(wrapper.find('[data-role="project-repo-key"]').attributes('disabled') !== undefined);
  // Весь список репозиториев профильного проекта — чтение: ни строк, ни порядка.
  assert.ok(wrapper.find('[data-role="project-repo-add"]').attributes('disabled') !== undefined);
  assert.ok(wrapper.find('[data-role="project-repo-remove"]').attributes('disabled') !== undefined);
  assert.equal(wrapper.find('[data-role="project-title"]').attributes('disabled'), undefined);
  assert.match(wrapper.text(), /Пути задаёт профиль фабрики/);
});

test('текст о границе доверия на месте, удаления в «Управлении» пока нет', async (t) => {
  const { wrapper } = await mountForm(t);

  assert.match(
    wrapper.find('[data-role="project-trust"]').text(),
    /Права чатов и попыток фабрики/,
  );

  const manage = wrapper.find('[data-role="project-manage"]');

  assert.ok(manage.exists());
  assert.ok(manage.find('[data-role="project-archive"]').exists());
  // Удаление — шаг C1.3: пока у него нет ни ручки, ни кнопки.
  assert.equal(manage.text().includes('Удалить'), false);
});

test('раздел «Управление» предлагает архив активному проекту и возврат — архивному', async (t) => {
  const active = await mountForm(t);

  assert.ok(active.wrapper.find('[data-role="project-archive"]').exists());
  assert.equal(active.wrapper.find('[data-role="project-restore"]').exists(), false);

  const archived = await mountForm(t, {
    detail: { ...DETAIL, archivedAt: '2026-09-22T11:00:00.000Z' },
  });

  assert.ok(archived.wrapper.find('[data-role="project-restore"]').exists());
  assert.equal(archived.wrapper.find('[data-role="project-archive"]').exists(), false);
  assert.match(archived.wrapper.text(), /в архиве/i);
});

test('блокер архива показан со ссылкой на правило, кнопка архива выключена', async (t) => {
  const { wrapper, harness } = await mountForm(t, {
    dependencies: {
      items: [
        { kind: 'telegram', label: 'Правила Telegram', count: 2, items: ['Правило A', 'Правило B'] },
        { kind: 'ssh', label: 'Профили SSH', count: 1, items: ['prod'] },
      ],
      archivable: false,
      deletable: false,
      reasons: ['Правила Telegram: 2. Пока они ссылаются на проект, архив запрещён.'],
    },
  });

  const manage = wrapper.find('[data-role="project-manage"]');

  assert.match(manage.text(), /Правила Telegram/);
  assert.match(manage.text(), /Правило A/);
  assert.match(manage.text(), /Профили SSH/);
  assert.ok(wrapper.find('[data-role="project-archive"]').attributes('disabled') !== undefined);

  await wrapper.find('[data-role="project-rule-link-telegram"]').trigger('click');

  assert.deepEqual(harness.pushes, ['/telegram']);
});

test('архивация и восстановление зовут операции с ревизией и показывают отказ текстом', async (t) => {
  const { wrapper, harness } = await mountForm(t, {
    dependencies: { items: [], archivable: true, deletable: false, reasons: [] },
  });

  await wrapper.find('[data-role="project-archive"]').trigger('click');

  assert.deepEqual(harness.calls.filter(([name]) => name === 'archive'), [
    ['archive', 'demo', { expectedRevision: 3 }],
  ]);

  harness.lifecycleResult = {
    ok: false,
    error: 'active_rules',
    message: 'Правила Telegram: 1. Пока они ссылаются на проект, архив запрещён.',
  };
  await wrapper.find('[data-role="project-archive"]').trigger('click');
  await new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

  assert.match(wrapper.find('[data-role="project-manage-failure"]').text(), /Правила Telegram/);

  const archived = await mountForm(t, {
    detail: { ...DETAIL, archivedAt: '2026-09-22T11:00:00.000Z' },
  });

  await archived.wrapper.find('[data-role="project-restore"]').trigger('click');

  assert.deepEqual(archived.harness.calls.filter(([name]) => name === 'restore'), [
    ['restore', 'demo', { expectedRevision: 3 }],
  ]);
});
