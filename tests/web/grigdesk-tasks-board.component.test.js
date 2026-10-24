import assert from 'node:assert/strict';
import test from 'node:test';

import { mountBoardView } from './helpers/board-view.js';
import { LOCAL_TASK } from './helpers/grigdesk-task-card.js';

/**
 * Управляемая сеть отвечает списком и проектами, а POST возвращает серверный номер.
 * Реальные store, форма и доска связываются через обычный api, без подмены сохранения в компоненте.
 */
async function fixture(t, { projects = [{ id: 'beta', title: 'Проект Бета' }], configured = false } = {}) {
  const rows = [];
  const posts = [];
  const reads = [];
  let refuse = false;
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

      if (url === '/api/grigdesk-tasks') {
        return {
          tasks: [...rows],
          revision: rows.length,
          b24Configured: configured
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
    boardError: 'Ошибка B24 → Настройки',
    ownApi: api,
  });

  return {
    ...mounted,
    rows,
    posts,
    reads,
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
  const button = fx.wrapper.findAll('button').find((entry) => entry.text().includes('Новая задача'));

  assert.ok(button, 'На доске доступна кнопка «Новая задача»');
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

  assert.match(fx.wrapper.text(), /Б24 не подключён/);
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
  assert.deepEqual(fx.calls.opened, [LOCAL_TASK.id]);
  assert.equal(fx.posts.some((entry) => entry.url.endsWith('/analyze')), false);
});

test('LOCAL-BOARD-01: ошибка подключённого портала оставляет собственную группу доступной', async (t) => {
  const fx = await fixture(t, { configured: true });

  await openForm(fx);
  assert.match(fx.wrapper.text(), /Ошибка B24/);
  assert.doesNotMatch(fx.wrapper.text(), /Б24 не подключён/);
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
          b24Configured: false
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
    b24Configured: true
  });
  await fx.flushPromises();
  assert.match(fx.wrapper.text(), /Своя задача/);
  assert.match(fx.wrapper.text(), /Задача другой вкладки/);
  assert.match(fx.wrapper.text(), /Б24 не подключён/);
  assert.equal(peak, 1);
  assert.equal(reads, 2);
});
