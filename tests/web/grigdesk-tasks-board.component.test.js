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
    activeIds: ['own', 'alpha-board', 'beta-board', 'readonly-board'],
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

test('NEW-TASK: выбор содержит GrigDesk и обе доски, начальная цель — сохранённый дефолт', async (t) => {
  const fx = await fixture(t, {
    catalog: multiBoardCatalog(),
    externalGet,
    projects: [],
  });

  await openForm(fx);

  const board = fx.wrapper.get('#grigdesk-task-board-native');

  assert.deepEqual(board.findAll('option').map((option) => option.element.value),
    ['own', 'alpha-board', 'beta-board']);
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
  assert.deepEqual(fx.calls.openedReferences, [{ id: '42', source: `alpha-board@${'a'.repeat(64)}` }]);
  assert.equal(fx.rows.length, 0);
  assert.ok(fx.calls.boardLoad.includes(true));
});

test('NEW-TASK: возврат к GrigDesk использует внутренний проект и собственный API', async (t) => {
  const fx = await fixture(t, { catalog: multiBoardCatalog(), externalGet });

  await openForm(fx);
  await fx.wrapper.get('#grigdesk-task-board-native').setValue('own');
  await fx.flushPromises();
  await fillForm(fx);
  await submit(fx);
  assert.equal(fx.posts[0].url, '/api/grigdesk-tasks?sources=1');
  assert.equal(fx.posts[0].payload.projectId, 'beta');
  assert.deepEqual(fx.calls.openedReferences, [{ id: LOCAL_TASK.id, source: 'grigdesk' }]);
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

test('LOCAL-BOARD-01: без Б24 форма доступна, сохранённая задача видна и открывается', async (t) => {
  const fx = await fixture(t);

  assert.equal(fx.wrapper.find('.tracker-board .tracker-setup-banner').exists(), true);
  await openForm(fx);
  await fillForm(fx);
  await submit(fx);
  assert.equal(fx.posts.length, 1);
  assert.equal(fx.posts[0].url, '/api/grigdesk-tasks?sources=1');
  assert.deepEqual(fx.posts[0].payload, {
    title: 'Своя задача',
    description: LOCAL_TASK.description,
    projectId: 'beta',
    clientOrigin: fx.browser.location.origin,
  });
  assert.match(fx.wrapper.text(), /Своя задача/);
  assert.match(fx.wrapper.text(), /Проект Бета/);
  assert.equal(fx.wrapper.get('.col.primary').isVisible(), true);
  assert.equal(fx.wrapper.find('.own-tasks').exists(), false);
  assert.equal(fx.wrapper.find('.task-internal-flag').exists(), true);
  assert.equal(fx.wrapper.find('[role="tablist"]').exists(), false);
  assert.equal(fx.wrapper.find('li.trow').exists(), true);
  assert.equal(fx.wrapper.find('[data-role="board-snapshot-status"]').exists(), false);
  assert.deepEqual(fx.calls.opened, [LOCAL_TASK.id]);
  assert.equal(fx.posts.some((entry) => entry.url.endsWith('/analyze')), false);
});

test('LOCAL-BOARD: баннер настройки виден вместе со списком внутренних задач', async (t) => {
  const fx = await fixture(t);
  const banner = fx.wrapper.get('.tracker-board .tracker-setup-banner');

  assert.equal(banner.get('p').text(),
    'Внешний трекер не подключён — задачи трекера не показываются.');
  assert.equal(banner.get('button').text(), 'Настроить трекер');
  assert.equal(banner.isVisible(), true);
  assert.equal(fx.wrapper.get('.col.primary').isVisible(), true);
  assert.equal(fx.wrapper.find('[role="tabpanel"]').exists(), false);
  assert.equal(fx.wrapper.find('.col.primary .tracker-setup-banner').exists(), false);
  await banner.get('button').trigger('click');
  await fx.flushPromises();
  assert.equal(fx.wrapper.find('[data-testid="tracker-settings-dialog"]').exists(), true);
});

test('LOCAL-BOARD: шестерёнка в шапке доступна при загрузке и без трекера', async (t) => {
  const fx = await fixture(t, { pending: true });
  const settings = fx.wrapper.get('.board-heading button[aria-label="Настройки трекеров"]');

  assert.equal(settings.text(), '');
  assert.equal(settings.find('svg').exists(), true);
  assert.equal(fx.wrapper.find('.tracker-setup-banner').exists(), false);
  await settings.trigger('click');
  await fx.flushPromises();
  assert.equal(fx.wrapper.find('[data-testid="tracker-settings-dialog"]').exists(), true);
  fx.finishLoading();
  await fx.flushPromises();
  assert.equal(settings.isVisible(), true);
  assert.equal(fx.wrapper.find('.tracker-setup-banner').exists(), true);
});

test('LOCAL-BOARD: ошибка трекера оставляет внутренние задачи и создание на общей доске', async (t) => {
  const fx = await fixture(t, { configured: true });

  await openForm(fx);
  assert.equal(fx.wrapper.get('#board-tracker-panel .col.primary').isVisible(), true);
  assert.equal(fx.wrapper.find('.board-heading [role="tablist"]').exists(), false);
  assert.equal(fx.wrapper.find('.tracker-setup-banner').exists(), false);
  await fillForm(fx);
  await submit(fx);
  assert.equal(fx.wrapper.get('.col.primary').text().includes(LOCAL_TASK.title), true);
  assert.equal(fx.wrapper.get('.tasks .task-internal-flag').text(), 'GrigDesk');
  assert.equal(fx.wrapper.get('#board-tracker-panel').isVisible(), true);
  assert.equal(fx.wrapper.get('.board-tracker-error').text().includes('Не удалось обновить'), true);
  assert.equal(fx.wrapper.find('.board-tracker-error-details').exists(), false);
  await fx.wrapper.get('.board-tracker-error .ui-disclosure-button').trigger('click');
  await fx.flushPromises();
  assert.equal(fx.wrapper.get('.board-tracker-error-details').text(), 'Ошибка B24 → Настройки');
  await fx.wrapper.get('.board-heading button[aria-label="Настройки трекеров"]').trigger('click');
  await fx.flushPromises();
  assert.equal(fx.wrapper.find('[data-testid="tracker-settings-dialog"]').exists(), true);
});

test('LOCAL-BOARD: общий список стабилен по датам, флаг есть только у GrigDesk', async (t) => {
  const newer = {
    ...LOCAL_TASK,
    id: '100000000002',
    createdAt: '2026-10-25T00:00:00.000Z'
  };
  const sameDate = { ...newer, id: '100000000003' };
  const fx = await fixture(t, {
    configured: true,
    initialTasks: [LOCAL_TASK, newer, sameDate],
    boardError: null,
    pipelineTasks: [{
      task: newer.id,
      source: 'grigdesk',
      daemonAlive: true
    }],
  });
  const rows = fx.wrapper.findAll('.col.primary .trow');

  assert.equal(fx.wrapper.find('.own-tasks').exists(), false);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.get('.task-id').text()),
    [newer, sameDate, LOCAL_TASK].map((task) => `#${task.id}`));
  assert.equal(rows.slice(0, 3).every((row) => row.get('.task-internal-flag').text() === 'GrigDesk'), true);
  assert.equal(rows[3].find('.task-internal-flag').exists(), false);
  assert.match(rows[0].text(), /Конвейер идёт/u);
  await rows[0].get('[data-role="task-title"]').trigger('click');
  assert.deepEqual(fx.calls.opened, [newer.id]);
});

test('LOCAL-BOARD-02: невалидный ввод и отказ сохраняют черновик, оценка не запускается', async (t) => {
  const fx = await fixture(t);

  await openForm(fx);
  await fillForm(fx, '   ');
  await submit(fx);
  assert.equal(fx.posts.length, 0);
  await fillForm(fx);
  fx.refuse(true);
  await submit(fx);
  assert.equal(fx.rows.length, 0);
  assert.equal(fx.wrapper.find('textarea').element.value, LOCAL_TASK.description);
  fx.refuse(false);
  await submit(fx);
  assert.equal(fx.rows.length, 1);
  assert.equal(fx.posts.some((entry) => entry.url.endsWith('/analyze')), false);
});

test('LOCAL-BOARD-02: без доступного проекта задача не сохраняется', async (t) => {
  const fx = await fixture(t, { projects: [] });

  await openForm(fx);
  await submit(fx);
  assert.equal(fx.posts.length, 0);
  assert.equal(fx.rows.length, 0);
});

test('LOCAL-BOARD-03: событие и reconnect обновляют список, unmount снимает подписку', async (t) => {
  const fx = await fixture(t);

  assert.ok(fx.reads.includes('/api/grigdesk-tasks'), 'Доска читает собственный список при открытии');
  fx.rows.push(LOCAL_TASK);

  for (const listener of fx.listeners) {
    listener('grigdesk-tasks-changed', { revision: 1 });
  }

  await fx.flushPromises();
  assert.match(fx.wrapper.text(), /Своя задача/);

  const before = fx.reads.filter((url) => url === '/api/grigdesk-tasks').length;

  for (const listener of fx.listeners) {
    listener('hello', {});
  }

  await fx.flushPromises();
  assert.ok(fx.reads.filter((url) => url === '/api/grigdesk-tasks').length > before);
  fx.wrapper.unmount();
  assert.equal(fx.listeners.size, 0);
});

test('LOCAL-BOARD-03: старый GET не откатывает POST, событие в полёте дочитывается', async (t) => {
  let release;
  let reads = 0;
  let active = 0;
  let peak = 0;
  const second = {
    ...LOCAL_TASK,
    id: '100000000002',
    title: 'Задача другой вкладки'
  };
  const fx = await mountBoardView(t, {
    prefix: 'local-board-order',
    ownApi: {
      /**
       * Первое чтение удерживается до ответа POST и события другой вкладки.
       * Активные чтения считаются для проверки сериализации и trailing-прохода.
       */
      async get(url) {
        if (url === '/api/grigdesk-tasks/projects') {
          return { projects: [{ id: 'beta', title: 'Проект Бета' }] };
        }

        if (url !== '/api/grigdesk-tasks') {
          return { tasks: [] };
        }

        reads += 1;
        active += 1;
        peak = Math.max(peak, active);

        if (reads === 1) {
          return new Promise((resolve) => {
            release = (value) => {
              active -= 1;
              resolve(value);
            };
          });
        }

        active -= 1;

        return {
          tasks: [second, LOCAL_TASK],
          revision: 2,
          trackerConfigured: false
        };
      },
      async post() {
        return { task: LOCAL_TASK, revision: 1 };
      },
    },
  });

  await openForm(fx);
  await fillForm(fx);

  for (const listener of fx.listeners) {
    listener('grigdesk-tasks-changed', { revision: 2 });
  }

  await submit(fx);
  release({
    tasks: [],
    revision: 0,
    trackerConfigured: true
  });
  await fx.flushPromises();
  assert.match(fx.wrapper.text(), /Своя задача/);
  assert.match(fx.wrapper.text(), /Задача другой вкладки/);
  assert.equal(fx.wrapper.find('.tracker-board .tracker-setup-banner').exists(), true);
  assert.equal(peak, 1);
  assert.equal(reads, 2);
});

test('BOARD-HIERARCHY: название первым, полный номер и проект в метаданных, одно открытие', async (t) => {
  const task = {
    ...LOCAL_TASK,
    id: '100000000099',
    title: 'Название без служебного префикса',
  };
  const fx = await fixture(t, {
    configured: true,
    initialTasks: [task],
    pipelineTasks: [{
      task: task.id,
      source: 'grigdesk',
      daemonAlive: true
    }],
    boardError: null,
  });
  const row = fx.wrapper.get('.col.primary .trow');

  assert.equal(row.find('.ttext .task-name').exists(), true);
  assert.equal(row.get('.ttext .task-name').text(), task.title);
  assert.equal(row.get('.task-meta .mono').text(), `#${task.id}`);
  assert.match(row.get('.task-meta').text(), /Проект Бета/u);
  assert.match(row.get('.task-meta').text(), /Конвейер идёт/u);

  const { browser, wrapper } = fx;
  const source = await readFile(webFile('src/views/BoardView.vue'), 'utf8');
  const layers = ['tokens', 'base', 'components/foundation', 'components/actions'];
  const cssText = (await Promise.all(layers.map((name) =>
    readFile(webFile(`src/styles/${name}.css`), 'utf8')))).join('\n')
    + '\n' + source.match(/<style scoped>([\s\S]*?)<\/style>/u)[1];
  const style = browser.document.createElement('style');

  browser.happyDOM.setWindowSize({ width: 390, height: 844 });
  browser.document.documentElement.setAttribute('data-ui-touch', '');
  style.textContent = cssText;
  browser.document.head.append(style);
  t.after(() => style.remove());

  const css = (selector) => browser.getComputedStyle(wrapper.get(selector).element);
  const titleColor = css('.ttext .task-name').color;

  assert.notEqual(titleColor, '');
  assert.equal(titleColor, css('.tasks .task-name').color);
  assert.notEqual(titleColor, css('.task-meta').color);
  assert.equal(css('.ttext .task-name').fontSize, '15px');
  assert.equal(css('.task-meta').fontSize, '12px');
  assert.equal(css('.ttext').minHeight, '44px');

  await row.get('.ttext').trigger('click');
  assert.deepEqual(fx.calls.opened, [task.id]);
});

test('PHONE-HEADER: реальная форма создания наследует общую шапку, desktop сохраняется', async (t) => {
  const fx = await fixture(t);

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
