import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';
import { webFile } from './helpers/compile-vue.js';
import { LOCAL_TASK } from './helpers/grigdesk-task-card.js';

/**
 * Управляемая сеть отвечает списком и проектами, а POST возвращает серверный номер.
 * Реальные store, форма и доска связываются через обычный api, без подмены сохранения в компоненте.
 */
async function fixture(t, {
  projects = [{ id: 'beta', title: 'Проект Бета' }],
  configured = false,
  pending = false,
  initialTasks = [],
  pipelineTasks = [],
  boardError = 'Ошибка B24 → Настройки',
  catalog = {
    drivers: [],
    activeIds: ['own'],
    externalId: null,
    revision: 1,
  },
  externalGet,
  externalPost,
} = {}) {
  const rows = [...initialTasks];
  const posts = [];
  const reads = [];
  const initialRead = Promise.withResolvers();
  let refuse = false;

  if (!pending) {
    initialRead.resolve();
  }

  t.after(() => initialRead.resolve());

  const api = {
    /**
     * Возвращает независимые снимки списка и проектов, как HTTP-транспорт.
     * Портальные запросы не меняют собственное хранилище фикстуры.
     */
    async get(url) {
      reads.push(url);

      if (url === '/api/trackers') {
        return structuredClone(catalog);
      }

      if (url.startsWith('/api/tracker/') && externalGet) {
        return externalGet(url);
      }

      if (url === '/api/grigdesk-tasks/projects') {
        return { projects };
      }

      if (url === '/api/tasks?sources=1') {
        return { tasks: pipelineTasks };
      }

      if (url === '/api/grigdesk-tasks') {
        await initialRead.promise;

        return {
          tasks: [...rows],
          revision: rows.length,
          trackerConfigured: configured
        };
      }

      return { tasks: [] };
    },
    /**
     * Отказ происходит до записи и сохраняет серверный список пустым.
     * Успех публикует ровно одну серверную запись с новым номером.
     */
    async post(url, payload, options) {
      posts.push({
        url,
        payload,
        options,
      });

      if (url.startsWith('/api/tracker/') && externalPost) {
        return externalPost(url, payload);
      }

      if (refuse) {
        throw new Error('Сохранение отклонено');
      }

      rows.push(LOCAL_TASK);

      return { task: LOCAL_TASK, revision: rows.length };
    },
  };
  const mounted = await mountBoardView(t, {
    prefix: 'local-board',
    boardError,
    ownApi: api,
    componentStubs: {
      TrackerSettingsDialog: {
        props: ['open'],
        template: '<div v-if="open" data-testid="tracker-settings-dialog"></div>',
      },
    },
  });

  return {
    ...mounted,
    rows,
    posts,
    reads,
    catalog,
    finishLoading: initialRead.resolve,
    refuse: (value) => {
      refuse = value;
    },
  };
}

/**
 * Поиск идёт по пользовательскому тексту кнопки, чтобы до реализации падало утверждение.
 * Поля выбираются по типу control: внутренняя разметка формы не является контрактом.
 */
async function openForm(fx) {
  const button = fx.wrapper.findAll('.board-heading button')
    .find((entry) => entry.text() === 'Новая задача');

  assert.ok(button, 'На доске доступна кнопка «Новая задача»');
  assert.equal(button.isVisible(), true);
  await button.trigger('click');
  await fx.flushPromises();
}

/**
 * Реальные controls формы сохраняют ввод через DOM-события.
 * Название поля допускает обе принятые в приложении подписи title.
 */
async function fillForm(fx, title = 'Своя задача') {
  const dialog = fx.wrapper.find('[role="dialog"]').exists()
    ? fx.wrapper.get('[role="dialog"]')
    : fx.wrapper;
  const input = dialog.find('input:not([type="hidden"])');
  const description = dialog.find('textarea');
  const project = dialog.find('#grigdesk-task-project-native');

  assert.ok(input.exists(), 'Форма содержит название');
  assert.ok(description.exists(), 'Форма содержит описание');
  assert.ok(project.exists(), 'Форма содержит выбор проекта');
  await input.setValue(title);
  await description.setValue(LOCAL_TASK.description);
  await project.setValue('beta');
}

/**
 * Кнопка находится по видимому действию, сохраняя реальный submit формы.
 * Отсутствие интерфейса — RED по поведению, а не ошибка обращения к пустому wrapper.
 */
async function submit(fx) {
  const button = fx.wrapper.findAll('button').find((entry) => entry.text().trim() === 'Создать');

  assert.ok(button, 'Форма содержит действие «Создать»');
  await button.trigger('click');
  await fx.flushPromises();
}

/**
 * Две включённые доски имеют разные проекты, поколения и источники аккаунтов.
 * Выключенный пакет и пакет без создания не должны стать целью новой задачи.
 */
function multiBoardCatalog() {
  const drivers = ['alpha-board', 'beta-board', 'disabled-board', 'readonly-board'].map((id) => ({
    id,
    name: id === 'alpha-board' ? 'Доска Альфа' : 'Доска Бета',
    status: 'active',
    configured: true,
    generation: id === 'alpha-board' ? 7 : 8,
    capabilities: { create: id !== 'readonly-board', projects: true },
  }));

  return {
    drivers,
    activeIds: ['alpha-board', 'beta-board', 'readonly-board'],
    enabledIds: ['alpha-board', 'beta-board', 'readonly-board'],
    default: 'beta-board',
    externalId: 'beta-board',
    revision: 3,
  };
}

/**
 * Ответ context фиксирует конкретный аккаунт перед чтением его проектов.
 * Одинаковый номер создаваемой задачи не должен стирать различие двух источников.
 */
function externalGet(url) {
  const alpha = url.includes('/alpha-board/');

  return url.endsWith('/context') ? {
    source: `${alpha ? 'alpha-board' : 'beta-board'}@${(alpha ? 'a' : 'b').repeat(64)}`,
    generation: alpha ? 7 : 8,
  } : { groups: [{ id: alpha ? 91 : 92, name: alpha ? 'Внешний Альфа' : 'Внешний Бета' }] };
}

test('OWN-REMOVED-CREATE: только включённые внешние create-цели, начальный выбор default B', async (t) => {
  const fx = await fixture(t, {
    catalog: multiBoardCatalog(),
    externalGet,
    projects: [],
  });

  await openForm(fx);

  const board = fx.wrapper.get('#grigdesk-task-board-native');

  assert.deepEqual(board.findAll('option').map((option) => option.element.value),
    ['alpha-board', 'beta-board']);
  assert.equal(board.element.value, 'beta-board');
  assert.deepEqual(fx.wrapper.get('#grigdesk-task-project-native').findAll('option')
    .map((option) => option.text()), ['Выберите проект', 'Внешний Бета']);
  assert.ok(fx.reads.includes('/api/tracker/beta-board/context'));
  assert.ok(fx.reads.includes('/api/tracker/beta-board/groups'));
});

test('NEW-TASK: выбранная доска получает POST и её источник открывает созданную карточку', async (t) => {
  const fx = await fixture(t, {
    catalog: multiBoardCatalog(),
    externalGet,
    externalPost: async () => ({ ok: true, id: 42 }),
    projects: [],
  });

  await openForm(fx);
  await fx.wrapper.get('#grigdesk-task-board-native').setValue('alpha-board');
  await fx.flushPromises();
  await fx.wrapper.get('#grigdesk-task-title').setValue('Задача Альфа');
  await fx.wrapper.get('textarea').setValue('Описание внешней задачи');
  await fx.wrapper.get('#grigdesk-task-project-native').setValue('91');
  await submit(fx);
  assert.deepEqual(fx.posts, [{
    url: '/api/tracker/alpha-board/tasks',
    payload: {
      title: 'Задача Альфа',
      description: 'Описание внешней задачи',
      groupId: 91,
    },
    options: { headers: { 'x-grigdesk-tracker-generation': '7' } },
  }]);
  assert.equal(fx.catalog.default, 'beta-board');
  assert.equal(fx.posts.some((entry) => entry.url.includes('/settings')), false);
  assert.deepEqual(fx.calls.openedReferences, [{ id: '42', source: `alpha-board@${'a'.repeat(64)}` }]);
  assert.equal(fx.rows.length, 0);
  assert.ok(fx.calls.boardLoad.includes(true));
});

test('NEW-TASK: поздний справочник прежней доски не заменяет проекты текущей', async (t) => {
  const groups = Promise.withResolvers();
  const fx = await fixture(t, {
    catalog: multiBoardCatalog(),
    externalGet: (url) => url === '/api/tracker/alpha-board/groups' ? groups.promise : externalGet(url),
  });

  await openForm(fx);
  await fx.wrapper.get('#grigdesk-task-board-native').setValue('alpha-board');
  await fx.flushPromises();
  assert.equal(fx.wrapper.get('#grigdesk-task-project-native').element.disabled, true);
  await submit(fx);
  assert.equal(fx.posts.length, 0);
  await fx.wrapper.get('#grigdesk-task-board-native').setValue('beta-board');
  await fx.flushPromises();
  groups.resolve({ groups: [{ id: 91, name: 'Поздний проект Альфа' }] });
  await fx.flushPromises();
  assert.deepEqual(fx.wrapper.get('#grigdesk-task-project-native').findAll('option')
    .map((option) => option.text()), ['Выберите проект', 'Внешний Бета']);
  assert.equal(fx.wrapper.get('#grigdesk-task-project-native').element.disabled, false);
});

test('NEW-TASK: отказ внешней доски сохраняет черновик без повтора и подмены цели', async (t) => {
  const fx = await fixture(t, {
    catalog: multiBoardCatalog(),
    externalGet,
    externalPost: async () => {
      throw new Error('Доска отклонила создание');
    },
  });

  await openForm(fx);
  await fx.wrapper.get('#grigdesk-task-title').setValue('Черновик');
  await fx.wrapper.get('textarea').setValue('Сохранённое описание');
  await submit(fx);
  assert.equal(fx.posts.length, 0, 'Проект внешней доски обязателен');
  await fx.wrapper.get('#grigdesk-task-project-native').setValue('92');
  await submit(fx);
  assert.equal(fx.posts.length, 1);
  assert.equal(fx.posts[0].url, '/api/tracker/beta-board/tasks');
  assert.match(fx.wrapper.text(), /Доска отклонила создание/u);
  assert.equal(fx.wrapper.get('#grigdesk-task-title').element.value, 'Черновик');
  assert.equal(fx.wrapper.get('textarea').element.value, 'Сохранённое описание');
  assert.equal(fx.wrapper.get('#grigdesk-task-board-native').element.value, 'beta-board');
  assert.deepEqual(fx.calls.openedReferences, []);
});

test('NEW-TASK: доска без справочника проектов создаёт по названию без groupId', async (t) => {
  const catalog = multiBoardCatalog();

  catalog.drivers[1].capabilities.projects = false;

  const fx = await fixture(t, {
    catalog,
    externalGet,
    externalPost: async () => ({ ok: true, id: 42 }),
  });

  await openForm(fx);
  assert.equal(fx.wrapper.find('#grigdesk-task-project-native').exists(), false);
  await fx.wrapper.get('#grigdesk-task-title').setValue('Без проекта');
  await submit(fx);
  assert.deepEqual(fx.posts[0].payload, { title: 'Без проекта', description: '' });
  assert.equal(fx.reads.includes('/api/tracker/beta-board/groups'), false);
});

test('PHONE-HEADER: реальная форма создания наследует общую шапку, desktop сохраняется', async (t) => {
  const fx = await fixture(t, { catalog: multiBoardCatalog(), externalGet });

  fx.browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  fx.browser.document.documentElement.setAttribute('data-ui-touch', '');
  await fx.flushPromises();
  await openForm(fx);

  const source = await readFile(webFile('src/views/board/NewGrigdeskTaskDialog.vue'), 'utf8');
  const layers = ['tokens', 'base', 'components/foundation', 'components/actions',
    'components/patterns', 'components/overlays'];
  const cssText = (await Promise.all(layers.map((name) =>
    readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n')
    + '\n' + source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];
  const style = fx.browser.document.createElement('style');

  style.textContent = cssText;
  fx.browser.document.head.append(style);
  t.after(() => style.remove());

  const title = fx.wrapper.get('.new-task-title').element;

  assert.equal(fx.browser.getComputedStyle(title).fontSize, '12px');
  assert.equal(fx.browser.getComputedStyle(title).fontWeight, '500');
  fx.browser.happyDOM.setWindowSize({ width: 1280, height: 900 });
  style.textContent = cssText;
  assert.equal(fx.browser.getComputedStyle(title).fontSize, '13px');
});

for (const state of ['empty', 'readonly', 'offline']) {
  test(`OWN-REMOVED-CREATE: ${state} не создаёт own и не подменяет цель`, async (t) => {
    const catalog = multiBoardCatalog();

    if (state === 'empty') {
      catalog.drivers = [];
      catalog.enabledIds = [];
      catalog.activeIds = [];
      catalog.default = null;
      catalog.externalId = null;
    } else if (state === 'readonly') {
      for (const driver of catalog.drivers) {
        driver.capabilities.create = false;
      }
    } else {
      for (const driver of catalog.drivers) {
        driver.status = 'unavailable';
        driver.configured = false;
      }
    }

    const fx = await fixture(t, { catalog, externalGet });

    await openForm(fx);

    const board = fx.wrapper.find('#grigdesk-task-board-native');
    const options = board.exists() ? board.findAll('option') : [];

    assert.equal(options.some((option) => option.element.value === 'own'), false);
    assert.equal(options.some((option) => option.element.value
      && !option.element.disabled && option.element.selected), false);

    const save = fx.wrapper.findAll('button').find((button) => button.text().trim() === 'Создать');

    assert.ok(save);
    assert.equal(save.element.disabled, true);
    await save.trigger('click');
    await fx.flushPromises();
    assert.deepEqual(fx.posts, []);

    if (state === 'empty') {
      assert.match(fx.wrapper.text(), /подключ|настро[йи]/iu);
    }
  });
}
