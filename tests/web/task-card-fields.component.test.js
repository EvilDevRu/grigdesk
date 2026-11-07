import assert from 'node:assert/strict';
import test from 'node:test';

import { mountTrackerCard, STOCK_CAPS } from './helpers/trackerCard.js';
import { formatDateTime } from '../../web/src/shared/format.ts';

process.env.NODE_ENV = 'test';

for (const presentation of ['dialog', 'document']) {
  test(`${presentation}: полная карточка REST, дерево, page-данные и безопасные аватары`, async (t) => {
    const deadline = '2020-11-05T19:00:00+07:00';
    const card = await mountTrackerCard(t, {
      presentation,
      capabilities: {
        ...STOCK_CAPS,
        checklist: false,
        tags: false,
        review: false,
      },
      detail: {
        statusText: 'Статус REST',
        status_label: 'Старый статус',
        priority: '2',
        deadline,
        creator: { name: 'Постановщик задачи', icon: 'https://avatar.fixture/creator.png' },
        responsible: {
          id: 7,
          name: 'Исполнитель задачи',
          icon: 'https://avatar.fixture/person.png',
        },
        accomplicesData: [{ name: 'Коллега 1' }, { name: 'Коллега 2' }],
        auditorsData: { 3: { name: 'Наблюдатель' } },
        parentId: '41',
        replicate: 'Y',
        checklist: {
          2: {
            id: 2,
            parentId: '1',
            title: 'Проверить',
            sortIndex: 20,
            isComplete: 'Y',
          },
          1: {
            id: 1,
            parentId: 0,
            title: 'Подготовка',
            sortIndex: 10,
            isImportant: 'Y',
          },
        },
      },
      boardFields: { deadline: '2099-01-01T00:00:00Z' },
      pageData: {
        tags: ['Версия', 'Команда'],
        subtasks: [{
          id: 43,
          title: 'Дочерняя задача',
          statusText: 'Ждёт выполнения',
        }],
      },
    });
    const { wrapper } = card;
    const meta = wrapper.find('.meta');

    assert.equal(meta.text().includes('Статус REST'), true);
    assert.equal(meta.text().includes('Старый статус'), false);
    assert.equal(meta.text().includes('Высокий'), true);
    assert.equal(meta.text().includes(formatDateTime(deadline)), true);
    assert.equal(meta.find('.over').text().includes('🔥 Просрочена'), true);
    assert.equal(meta.text().includes('Постановщик задачи'), true);
    assert.equal(meta.text().includes('Коллега 1, Коллега 2'), true);
    assert.equal(meta.text().includes('Регулярная'), true);

    const avatars = meta.findAll('img');

    assert.equal(avatars.length, 2);
    assert.ok(avatars.every((avatar) => avatar.attributes('referrerpolicy') === 'no-referrer'));
    await avatars[0].trigger('error');
    assert.equal(avatars[0].element.hidden, true);

    const checklist = wrapper.find('[data-role="task-checklist"]');
    const checkboxes = checklist.findAll('input[type="checkbox"]');

    assert.equal(checklist.get('h5').text(), 'Чек-лист · 1 из 1');
    assert.equal(checklist.get('[data-role="checklist-list-progress"]').text(), '1 из 1');
    assert.equal(checklist.get('[data-checklist-id="1"]').find('input[type="checkbox"]').exists(), false);
    assert.equal(checklist.text().includes('★'), true);
    assert.deepEqual(checkboxes.map((box) => box.element.checked), [true]);
    assert.ok(checkboxes.every((box) => box.element.disabled));
    assert.equal(checklist.findAll('li')[1].element.style.marginInlineStart, '0px');
    assert.equal(wrapper.find('[data-role="task-tags"]').text().includes('Версия'), true);
    assert.equal(wrapper.find('[data-role="task-subtasks"]').text().includes('Ждёт выполнения'), true);
    await wrapper.find('[data-task-section="comments"]').trigger('click');
    await card.flushPromises();
    assert.equal(card.calls.filter((call) => call.url?.endsWith('/comments')).length, 1);
    await wrapper.find('[data-role="task-subtasks"] button').trigger('click');
    assert.equal(card.calls.some((call) => call.method === 'OPEN' && call.id === '43'), true);
  });
}

test('Родительская карточка открывается общим ui.openTask', async (t) => {
  const card = await mountTrackerCard(t, { detail: { parentId: 41 } });

  await card.wrapper.find('[data-role="task-parent"]').trigger('click');
  assert.equal(card.calls.some((call) => call.method === 'OPEN' && call.id === '41'), true);
});

test('Старый DTO сохраняет метки, пустые расширения скрыты; null снимает срок доски', async (t) => {
  const { wrapper } = await mountTrackerCard(t, {
    detail: {
      status_label: 'Старый статус',
      priority_label: 'Особый приоритет',
      group_name: 'Проект',
      responsible: { name: 'Имя', icon: 'http://avatar.fixture/person.png' },
      deadline: null,
      checklist: {},
    },
    boardFields: { deadline: '2020-01-01T00:00:00Z' },
  });

  for (const text of ['Старый статус', 'Особый приоритет', 'Проект', 'Имя']) {
    assert.equal(wrapper.find('.meta').text().includes(text), true);
  }

  assert.equal(wrapper.find('.meta').text().includes('Просрочена'), false);
  assert.equal(wrapper.find('.meta img').exists(), false);

  for (const role of ['task-checklist', 'task-tags', 'task-subtasks', 'task-parent']) {
    assert.equal(wrapper.find(`[data-role="${role}"]`).exists(), false);
  }
});

test('Own-задача сохраняет проект и описание без внешнего page-запроса', async (t) => {
  const { wrapper, calls } = await mountTrackerCard(t, {
    id: '100000000001',
    detail: {
      id: '100000000001',
      source: 'grigdesk',
      projectId: 'project',
      projectTitle: 'Свой проект',
      description: 'Своя постановка',
      sourceUrl: 'https://task.fixture/own',
      createdAt: '2026-01-01T00:00:00Z',
    },
  });

  assert.equal(wrapper.text().includes('Свой проект'), true);
  assert.equal(wrapper.find('.desc').text(), 'Своя постановка');
  assert.equal(calls.some((call) => call.url?.endsWith('/comments')), false);
});

for (const deadline of [null, '2026-11-05T19:00:34+07:00']) {
  test(`Редактор передаёт только изменённый deadline: исходный ${deadline}`, async (t) => {
    const card = await mountTrackerCard(t, { detail: { deadline } });

    await card.wrapper.find('[data-role="task-edit-open"]').trigger('click');
    await card.flushPromises();

    const input = card.wrapper.find('[data-role="task-edit-deadline"]');

    assert.equal(input.attributes('type'), 'datetime-local');
    await input.setValue(deadline ? '' : '2026-11-06T15:30');
    await card.wrapper.find('[data-role="task-edit-save"]').trigger('click');
    await card.flushPromises();
    assert.deepEqual(card.calls.find((call) => call.method === 'PUT').payload, {
      deadline: deadline ? null : new Date('2026-11-06T15:30').toISOString(),
    });
  });
}

test('Нетронутый срок с секундами не уходит при редактировании заголовка', async (t) => {
  const card = await mountTrackerCard(t, { detail: { deadline: '2026-11-05T19:00:34+07:00' } });

  await card.wrapper.find('[data-role="task-edit-open"]').trigger('click');
  await card.flushPromises();
  await card.wrapper.find('[data-role="task-edit-title"]').setValue('Новое название');
  await card.wrapper.find('[data-role="task-edit-save"]').trigger('click');
  await card.flushPromises();
  assert.deepEqual(card.calls.find((call) => call.method === 'PUT').payload, { title: 'Новое название' });
});


test('Сегодняшний срок берётся с доски при отсутствии deadline в detail', async (t) => {
  const now = new Date(2026, 10, 5, 10).getTime();
  const deadline = new Date(2026, 10, 5, 19).toISOString();

  t.mock.method(Date, 'now', () => now);

  const { wrapper } = await mountTrackerCard(t, {
    detail: { priority: 0 },
    boardFields: { deadline },
  });
  const meta = wrapper.find('.meta');

  assert.equal(meta.text().includes(formatDateTime(deadline)), true);
  assert.equal(meta.text().includes('🔥 Срочно'), true);
  assert.equal(meta.text().includes('Низкий'), true);
  assert.equal(meta.find('.over').exists(), false);
});

test('Поздний page-ответ старого драйвера не показывает его теги и подзадачи', async (t) => {
  const card = await mountTrackerCard(t, { pageMode: 'held' });

  assert.equal(card.calls.some((call) => call.url?.endsWith('/comments')), true);

  for (const listener of card.listeners) {
    listener('trackers-changed', { revision: 2 });
  }

  await card.flushPromises();
  card.heldPage.resolve({
    comments: [],
    tags: ['Старый драйвер'],
    subtasks: [{ id: 43, title: 'Старая подзадача' }],
  });
  await card.flushPromises();
  assert.equal(card.wrapper.find('[data-role="task-tags"]').exists(), false);
  assert.equal(card.wrapper.find('[data-role="task-subtasks"]').exists(), false);
});


test('Готовая подпись срока старого драйвера сохраняется без ISO в деталях', async (t) => {
  const { wrapper } = await mountTrackerCard(t, {
    boardFields: { deadline: '05.11.2026', overdue: true },
  });
  const meta = wrapper.find('.meta');

  assert.equal(meta.text().includes('05.11.2026'), true);
  assert.equal(meta.find('.over').text().includes('Просрочена'), true);
});
