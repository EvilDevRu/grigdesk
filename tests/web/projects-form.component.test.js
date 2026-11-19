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
export * from './src/ui.ts';
export { default as UiLoadingState } from './src/components/feedback/UiLoadingState.vue';
export { t, resolveUiText, messageRef } from '${webFile('src/services/locale.ts')}';
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
  iconRead = null,
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
    setDraft(value) {
      this.draft = value;
    },
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
  globalThis.__projectIconRead = iconRead;
  Object.defineProperty(browser.window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
  });

  const component = await compileVue(VIEW, {
    stubs: {
      ...(iconRead ? {
        './projectIconFile.ts': `
          export { PROJECT_ICON_FILE_ACCEPT } from './src/views/projects/projectIconFile.ts';
          export const projectIconFile = globalThis.__projectIconRead;
        `,
      } : {}),
      '../stores/chat.ts': `export const useChatStore = () => ({
        loaded: true,
        loading: false,
        loadError: null,
        loadErrorMessage: null,
        retryLoad() {},
        newSession: () => 'chat-id',
        _load: async () => {},
      });`,
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
    delete globalThis.__projectIconRead;
  });

  await flushPromises();

  return { wrapper, harness, flushPromises };
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

test('новой рабочей папке достаточно пути, а введённая метка сохраняется при смене папки', async (t) => {
  const { wrapper, harness } = await mountForm(t);

  await wrapper.find('[data-role="project-repo-add"]').trigger('click');
  const added = wrapper.findAll('[data-role="project-repo-row"]').at(-1);
  const path = added.get('[data-role="project-repo-dir"]');
  const key = added.get('[data-role="project-repo-key"]');

  assert.equal(document.activeElement?.getAttribute('data-role'), 'project-repo-dir');
  await path.setValue('/srv/other/be/');
  assert.equal(key.element.value, 'be-2');
  await added.get('[data-role="project-repo-default"]').setValue(true);
  await path.setValue('/srv/Готовые заметки');
  assert.equal(key.element.value, 'gotovye-zametki');
  assert.equal(harness.store.draft.defaultRepoKey, 'gotovye-zametki');
  await key.setValue('notes');
  await path.setValue('/srv/docs');
  assert.equal(key.element.value, 'notes');
  await key.setValue('');
  assert.equal(key.element.value, 'docs');
  await saveButton(wrapper).trigger('click');
  assert.ok(harness.calls.some(([name]) => name === 'save'));
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

test('в проекте фабрики можно добавить рабочую папку рядом с защищёнными строками', async (t) => {
  const { wrapper, harness } = await mountForm(t, { detail: profileDetail() });
  const add = wrapper.find('[data-role="project-repo-add"]');

  assert.ok(wrapper.find('[data-role="project-repo-dir"]').attributes('disabled') !== undefined);
  assert.ok(wrapper.find('[data-role="project-repo-key"]').attributes('disabled') !== undefined);
  assert.equal(add.attributes('disabled'), undefined);
  assert.ok(wrapper.find('[data-role="project-repo-remove"]').attributes('disabled') !== undefined);
  assert.equal(wrapper.find('[data-role="project-title"]').attributes('disabled'), undefined);
  assert.match(wrapper.text(), /Пути из профиля фабрики доступны для чтения/);

  await add.trigger('click');
  const row = wrapper.findAll('[data-role="project-repo-row"]').at(-1);
  const key = row.find('[data-role="project-repo-key"]');

  await key.setValue('be');
  assert.equal(key.attributes('disabled'), undefined);
  await key.setValue('notes');
  await row.find('[data-role="project-repo-dir"]').setValue('/srv/рабочие заметки');
  assert.notEqual(row.find('[data-role="project-repo-up"]').attributes('disabled'), undefined);
  await saveButton(wrapper).trigger('click');

  const [, , draft] = harness.calls.find(([name]) => name === 'save');

  assert.deepEqual(draft.repos.at(-1), { key: 'notes', dir: '/srv/рабочие заметки' });
});

test('Git виден внутри поля пути и у основной строки профиля, и у дополнительной папки', async (t) => {
  const detail = profileDetail();
  detail.profile.repos = detail.profile.repos.slice(0, 1);
  const { wrapper, harness, flushPromises } = await mountForm(t, { detail });
  const [primary, extra] = wrapper.findAll('[data-role="project-repo-row"]');
  const primaryPath = primary.get('[data-role="project-repo-dir"]');
  const extraPath = extra.get('[data-role="project-repo-dir"]');
  const icon = '[data-role="project-repo-git"]';

  assert.deepEqual(harness.calls.filter(([name]) => name === 'check').map(([, dirs]) => dirs), [
    ['/srv/demo/be', '/srv/demo/fe'],
  ]);
  assert.notEqual(primaryPath.attributes('disabled'), undefined);

  harness.store.checks = {
    '/srv/demo/be': { state: 'git', message: 'Рабочая копия git' },
    '/srv/demo/fe': { state: 'worktree', message: 'Связанная рабочая копия' },
  };
  await flushPromises();

  const primaryIcon = primary.get(icon);
  assert.equal(primaryIcon.element.closest('.ui-input-frame') === primaryPath.element.parentElement, true);
  assert.equal(primaryPath.attributes('aria-describedby'), primaryIcon.attributes('id'));
  assert.equal(primaryIcon.attributes('data-ui-tooltip'), 'Рабочая копия Git');
  assert.equal(extra.get(icon).attributes('data-ui-tooltip'), 'Связанная рабочая копия Git');
  assert.equal(wrapper.find('.path-problem').exists(), false);

  await extraPath.setValue('/srv/demo/notes');
  assert.equal(extra.find(icon).exists(), false);
  assert.deepEqual(harness.calls.filter(([name]) => name === 'check').at(-1)[1], [
    '/srv/demo/be', '/srv/demo/notes',
  ]);

  harness.store.checks['/srv/demo/notes'] = { state: 'dir', message: 'Каталог без .git' };
  await flushPromises();
  assert.equal(extra.find(icon).exists(), false);
  assert.equal(extra.find('.path-problem').exists(), false);

  harness.store.checks['/srv/demo/notes'] = { state: 'missing', message: 'Каталога нет' };
  await flushPromises();
  assert.equal(extra.get('.path-problem').text(), 'Каталога нет');
});

test('контурная кнопка раскрывает доступ к папкам, удаления в «Управлении» пока нет', async (t) => {
  const { wrapper } = await mountForm(t);
  const access = wrapper.get('.source-row button');
  const note = wrapper.get('[data-role="project-trust"]');

  assert.equal(access.attributes('data-variant'), 'outline');
  assert.equal(access.attributes('aria-controls'), note.attributes('id'));
  assert.equal(access.attributes('aria-expanded'), 'false');
  assert.equal(note.isVisible(), false);

  await access.trigger('click');
  assert.equal(access.attributes('aria-expanded'), 'true');
  assert.equal(note.isVisible(), true);
  assert.match(note.text(), /доступны в чатах проекта с учётом разрешений исполнителя/);

  await access.trigger('click');
  assert.equal(access.attributes('aria-expanded'), 'false');
  assert.equal(note.isVisible(), false);

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

const PROJECT_PNG = 'data:image/png;base64,'
  + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6WQAAAAASUVORK5CYII=';

test('ICON-FORM-REMOVE: удаление иконки — отменяемая правка формы', async (t) => {
  const { wrapper, harness } = await mountForm(t, { detail: { ...DETAIL, icon: PROJECT_PNG } });
  const picker = () => wrapper.get('[data-project-icon-picker]');

  assert.equal(wrapper.find('[data-project-icon-image]').exists(), true);
  const formats = picker().get('input[type="file"]').attributes('accept').split(',');

  assert.ok(formats.includes('image/svg+xml'));
  assert.ok(formats.includes('.svg'));
  assert.match(picker().get('button').text(), /Заменить иконку/);

  await wrapper.find('[data-project-icon-remove]').trigger('click');

  assert.equal(harness.store.draft.icon, null);
  assert.equal(wrapper.find('[data-project-icon-image]').exists(), false);
  assert.match(picker().get('button').text(), /Загрузить иконку/);
  assert.equal(saveButton(wrapper).attributes('disabled'), undefined);

  await wrapper.find('[data-role="project-cancel"]').trigger('click');

  assert.equal(harness.store.draft.icon, PROJECT_PNG);
});

test('ICON-FORM-FALLBACK: сломанное изображение показывает букву', async (t) => {
  const { wrapper } = await mountForm(t, { detail: { ...DETAIL, icon: PROJECT_PNG } });

  await wrapper.find('[data-project-icon-image]').trigger('error');

  assert.equal(wrapper.find('[data-project-icon-image]').exists(), false);
  assert.equal(wrapper.find('[data-project-initial]').text(), 'Д');
});

test('ICON-FORM-ERROR: ошибка чтения сменяет подсказку, повтор обновляет превью', async (t) => {
  const { wrapper, flushPromises } = await mountForm(t, {
    iconRead: async (file) => {
      if (file.name === 'broken.png') {
        throw new Error();
      }

      return PROJECT_PNG;
    },
  });
  const editor = wrapper.get('[data-project-icon-editor]');
  const input = editor.get('input[type="file"]');

  async function selectFile(name) {
    Object.defineProperty(input.element, 'files', {
      configurable: true,
      value: [new window.File(['image'], name, { type: 'image/png' })],
    });
    await input.trigger('change');
    await flushPromises();
  }

  await selectFile('broken.png');
  assert.match(editor.get('[role="alert"]').text(), /Не удалось прочитать иконку/);
  assert.equal(editor.find('.icon-hint').exists(), false);
  assert.equal(editor.find('[data-project-initial]').exists(), true);

  await selectFile('valid.png');
  assert.equal(editor.find('[role="alert"]').exists(), false);
  assert.match(editor.get('.icon-hint').text(), /PNG/);
  assert.equal(editor.get('[data-project-icon-image]').attributes('src'), PROJECT_PNG);
});

test('ICON-FORM-RACE: отмена инвалидирует поздний decode', async (t) => {
  let release;
  const iconRead = () => new Promise((resolve) => {
    release = resolve;
  });
  const { wrapper, harness } = await mountForm(t, { iconRead });
  const input = wrapper.find('[data-project-icon-picker] input[type="file"]');

  assert.equal(input.exists(), true);
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: [new window.File(['image'], 'icon.png', { type: 'image/png' })],
  });
  await input.trigger('change');

  assert.equal(saveButton(wrapper).attributes('disabled') !== undefined, true);

  // Ввести другую правку, чтобы существующая кнопка отмены была видна.
  await wrapper.find('[data-role="project-title"]').setValue('Правка');
  await wrapper.find('[data-role="project-cancel"]').trigger('click');
  release(PROJECT_PNG);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.store.draft.icon ?? null, null);
  assert.equal(harness.store.draft.title, DETAIL.title);
  await wrapper.find('[data-role="project-title"]').setValue('Правка после отмены');
  assert.equal(saveButton(wrapper).attributes('disabled'), undefined);
});
