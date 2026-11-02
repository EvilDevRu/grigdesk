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

      if (url === '/api/grigdesk-tasks/projects') {
        return { projects };
      }

      if (url === '/api/tasks') {
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
    async post(url, payload) {
      posts.push({ url, payload });

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
  const project = dialog.find('select');

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

test('LOCAL-BOARD-01: без Б24 форма доступна, сохранённая задача видна и открывается', async (t) => {
  const fx = await fixture(t);

  assert.equal(fx.wrapper.find('.tracker-board .tracker-setup-banner').exists(), true);
  await openForm(fx);
  await fillForm(fx);
  await submit(fx);
  assert.equal(fx.posts.length, 1);
  assert.equal(fx.posts[0].url, '/api/grigdesk-tasks');
  assert.deepEqual(fx.posts[0].payload, {
    title: 'Своя задача',
    description: LOCAL_TASK.description,
    projectId: 'beta',
    clientOrigin: fx.browser.location.origin,
  });
  assert.match(fx.wrapper.text(), /Своя задача/);
  assert.match(fx.wrapper.text(), /Проект Бета/);
  assert.equal(fx.wrapper.get('.own-tasks').isVisible(), true);
  assert.equal(fx.wrapper.get('.own-tasks').attributes('aria-label'), 'Задачи GrigDesk');
  assert.equal(fx.wrapper.find('.task-internal-flag').exists(), false);
  assert.equal(fx.wrapper.find('[role="tablist"]').exists(), false);
  assert.equal(fx.wrapper.find('li.trow').exists(), false);
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
  assert.equal(fx.wrapper.get('.own-tasks').isVisible(), true);
  assert.equal(fx.wrapper.find('[role="tabpanel"]').exists(), false);
  assert.equal(fx.wrapper.find('.own-tasks .tracker-setup-banner').exists(), false);
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
  assert.equal(fx.wrapper.get('#board-tracker-panel .own-tasks').isVisible(), true);
  assert.equal(fx.wrapper.find('.board-heading [role="tablist"]').exists(), false);
  assert.equal(fx.wrapper.find('.tracker-setup-banner').exists(), false);
  await fillForm(fx);
  await submit(fx);
  assert.equal(fx.wrapper.get('.own-tasks').text().includes(LOCAL_TASK.title), true);
  assert.equal(fx.wrapper.get('.own-tasks .task-internal-flag').text(), 'Внутренняя');
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

test('LOCAL-BOARD: секция внутренних завершает доску трекера, все строки имеют флаг', async (t) => {
  const newer = {
    ...LOCAL_TASK,
    id: '100000000002',
    title: 'Более новая задача',
    createdAt: '2026-10-25T00:00:00.000Z',
  };
  const sameDate = {
    ...LOCAL_TASK,
    id: '100000000003',
    title: 'Задача с тем же временем',
    createdAt: newer.createdAt,
  };
  const fx = await fixture(t, {
    configured: true,
    initialTasks: [LOCAL_TASK, newer, sameDate],
    pipelineTasks: [{ task: newer.id, daemonAlive: true }],
    boardError: null,
  });
  const board = fx.wrapper.get('#board-tracker-panel');
  const internal = board.get('.own-tasks');
  const rows = internal.findAll('li');

  assert.equal(internal.isVisible(), true);
  assert.equal(internal.attributes('aria-label'), 'Внутренние');
  assert.equal(internal.get('h3').text(), 'Внутренние');
  assert.equal(board.get('.board-pages').element.lastElementChild === internal.element, true);
  assert.equal(board.findAll('li.trow').length, 2);
  assert.equal(fx.wrapper.find('.tracker-setup-banner').exists(), false);
  assert.deepEqual(rows.map((row) => row.get('button .mono').text()), [
    `#${sameDate.id}`,
    `#${newer.id}`,
    `#${LOCAL_TASK.id}`,
  ]);
  assert.deepEqual(rows.map((row) => row.get('.task-internal-flag').text()), [
    'Внутренняя',
    'Внутренняя',
    'Внутренняя',
  ]);
  assert.equal(rows.every((row) => row.text().includes(LOCAL_TASK.projectTitle)), true);
  assert.match(rows[1].text(), /На конвейере/u);
  assert.equal(board.find('li.trow .task-internal-flag').exists(), false);
  assert.equal(fx.wrapper.find('[role="tablist"]').exists(), false);
  assert.equal(board.attributes('role'), undefined);
  assert.equal(board.attributes('aria-labelledby'), undefined);
  assert.equal(internal.attributes('aria-labelledby'), undefined);
  assert.equal(fx.wrapper.find('#board-internal-panel').exists(), false);
  assert.equal(fx.wrapper.find('#board-internal-tab, #board-tracker-tab').exists(), false);
  await rows[0].get('button').trigger('click');
  assert.deepEqual(fx.calls.opened, [sameDate.id]);
  await openForm(fx);
  assert.equal(fx.wrapper.get('[role="dialog"]').isVisible(), true);
});

for (const configured of [true, false]) {
  test(`LOCAL-BOARD: пустая секция видна при trackerConfigured=${configured}`, async (t) => {
    const fx = await fixture(t, { configured, boardError: null });
    const internal = fx.wrapper.get('.own-tasks');

    assert.equal(internal.isVisible(), true);
    assert.equal(internal.get('p.muted').text(),
      'Внутренних задач пока нет. Создайте первую задачу для своего проекта.');
    assert.equal(internal.findAll('li').length, 0);
  });
}

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
  assert.match(fx.wrapper.text(), /Своя задача/);
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
    id: '1000000000001',
    title: 'Название без служебного префикса',
  };
  const fx = await fixture(t, {
    configured: true,
    initialTasks: [task],
    pipelineTasks: [{ task: task.id, daemonAlive: true }],
    boardError: null,
  });
  const row = fx.wrapper.get('.own-tasks-list li');

  assert.equal(row.find('.own-task-title .task-name').exists(), true);
  assert.equal(row.get('.own-task-title .task-name').text(), task.title);
  assert.equal(row.get('.own-task-meta .mono').text(), `#${task.id}`);
  assert.match(row.get('.own-task-meta').text(), /Проект Бета/u);
  assert.match(row.get('.own-task-details').text(), /На конвейере/u);

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
  const titleColor = css('.own-task-title .task-name').color;

  assert.notEqual(titleColor, '');
  assert.equal(titleColor, css('.tasks .task-name').color);
  assert.notEqual(titleColor, css('.own-task-meta').color);
  assert.equal(css('.own-task-title .task-name').fontSize, '15px');
  assert.equal(css('.own-task-meta').fontSize, '12px');
  assert.equal(css('.own-task-title').minHeight, '44px');

  await row.get('.own-task-title').trigger('click');
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
  assert.equal(fx.browser.getComputedStyle(title).fontSize, '17px');
});
