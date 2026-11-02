import assert from 'node:assert/strict';
import test from 'node:test';

import { cardButton, mountTrackerCard, STOCK_CAPS } from './helpers/trackerCard.js';
import { taskChecklistItem } from './helpers/task-modal.js';

process.env.NODE_ENV = 'test';

/**
 * Ответы мутаций меняют только серверный снимок фикстуры, затем карточка его перечитывает.
 * Счётчики запросов отличают подтверждённое отображение от оптимистичной подмены DOM.
 */
async function interactiveCard(t, overrides = {}) {
  return mountTrackerCard(t, {
    capabilities: STOCK_CAPS,
    detail: {
      checklist: {
        10: {
          id: 10,
          title: 'Список',
          parentId: 0,
          isComplete: 'N',
        },
        11: {
          id: 11,
          title: 'Проверить',
          parentId: 10,
          isComplete: 'N',
        },
      },
    },
    pageData: { tags: ['Первый', 'Второй'] },
    mutation: async ({ method, url, payload, task, pageData }) => {
      if (url.endsWith('/tags')) {
        pageData.tags = [...payload.tags];
      } else if (url.endsWith('/approve')) {
        task.status = 5;
      } else if (url.endsWith('/disapprove') || url.endsWith('/renew')) {
        task.status = 2;
      } else if (url.endsWith('/checklist')) {
        const id = Math.max(0, ...Object.keys(task.checklist).map(Number)) + 1;

        task.checklist[id] = {
          id,
          parentId: payload.parentId || 0,
          title: payload.title,
          isComplete: 'N',
        };
      } else if (url.includes('/checklist/')) {
        const itemId = url.split('/').at(-1);

        if (method === 'DELETE') {
          const removing = [itemId];

          while (removing.length) {
            const parent = removing.pop();

            removing.push(...Object.keys(task.checklist)
              .filter((id) => String(task.checklist[id].parentId) === parent));
            delete task.checklist[parent];
          }
        } else {
          Object.assign(task.checklist[itemId], {
            ...(payload.title ? { title: payload.title } : {}),
            ...(Object.hasOwn(payload, 'complete') ? { isComplete: payload.complete ? 'Y' : 'N' } : {}),
          });
        }
      }

      return structuredClone(task);
    },
    ...overrides,
  });
}

/**
 * Каждая запись использует поколение подключения из настоящего trackers store.
 * Проверка чтения после записи доказывает источник показанного нового состояния.
 */
function assertMutation(card, method, suffix, payload) {
  const index = card.calls.findLastIndex((call) => call.method === method && call.url.endsWith(suffix));
  const call = card.calls[index];

  assert.equal(Boolean(call), true);
  assert.deepEqual(call.payload, payload);
  assert.equal(call.options.headers['x-grigdesk-tracker-generation'], '1');
  assert.equal(card.calls.slice(index + 1).some((entry) => entry.method === 'GET'), true);
}

for (const presentation of ['dialog', 'document']) {
  test(`${presentation}: чекбокс переключается в обе стороны с перечитыванием деталей`, async (t) => {
    const card = await interactiveCard(t, { presentation });
    const checkbox = () => taskChecklistItem(card.wrapper, 11).get('input[type="checkbox"]');

    await checkbox().setValue(true);
    await card.flushPromises();
    assertMutation(card, 'PUT', '/checklist/11', { complete: true });
    assert.equal(checkbox().element.checked, true);
    await checkbox().setValue(false);
    await card.flushPromises();
    assertMutation(card, 'PUT', '/checklist/11', { complete: false });
    assert.equal(checkbox().element.checked, false);
  });
}

test('Корень — заголовок без чекбокса, прогресс учитывает только его пункты', async (t) => {
  const card = await interactiveCard(t, { detail: { checklist: {
    10: {
      id: 10,
      parentId: 0,
      title: 'Первый список',
      isComplete: 'Y',
    },
    11: {
      id: 11,
      parentId: 10,
      title: 'Готовый пункт',
      isComplete: 'Y',
    },
    12: {
      id: 12,
      parentId: 11,
      title: 'Вложенный пункт',
      isComplete: 'N',
    },
    20: {
      id: 20,
      parentId: 0,
      title: 'Второй список',
      isComplete: 'N',
    },
    21: {
      id: 21,
      parentId: 20,
      title: 'Другой пункт',
      isComplete: 'Y',
    },
    30: {
      id: 30,
      parentId: 0,
      title: 'Пустой список',
      isComplete: 'Y',
    },
  } } });

  for (const [id, title, progress] of [
    [10, 'Первый список', '1 из 2'],
    [20, 'Второй список', '1 из 1'],
    [30, 'Пустой список', '0 из 0'],
  ]) {
    const row = taskChecklistItem(card.wrapper, id);

    assert.equal(row.find('input[type="checkbox"]').exists(), false);
    assert.equal(row.get('h6').text().includes(title), true);
    assert.equal(row.get('[data-role="checklist-list-progress"]').text(), progress);
    assert.equal(card.wrapper.get(`[data-checklist-list="${id}"]`).text().includes(title), true);
  }

  assert.equal(card.wrapper.get('[data-checklist-list="10"]').text().includes('Вложенный пункт'), true);
  assert.equal(card.wrapper.get('[data-checklist-list="20"]').text().includes('Вложенный пункт'), false);

  assert.equal(card.wrapper.get('[data-role="task-checklist"] h5').text(), 'Чек-лист · 2 из 3');
  await taskChecklistItem(card.wrapper, 12).get('input[type="checkbox"]').setValue(true);
  await card.flushPromises();

  const progress = taskChecklistItem(card.wrapper, 10).get('[data-role="checklist-list-progress"]');

  assert.equal(progress.text(), '2 из 2');
  assert.equal(card.wrapper.get('[data-role="task-checklist"] h5').text(), 'Чек-лист · 3 из 3');
});

for (const empty of [false, true]) {
  test(`Новый чек-лист создаётся кнопкой и Enter без parentId; пустая секция: ${empty}`, async (t) => {
    const card = await interactiveCard(t, empty ? { detail: { checklist: {} } } : {});

    assert.equal(card.wrapper.find('[data-checklist-parent=""]').exists(), false);
    assert.equal(card.wrapper.find('[data-role="checklist-list-input"]').exists(), false);

    for (const [title, keyboard] of [['Новый список', false], ['Следующий список', true]]) {
      const before = new Set(Object.keys(card.task.checklist));

      await card.wrapper.get('[data-role="checklist-add-list"]').trigger('click');

      const input = card.wrapper.get('[data-role="checklist-list-input"]');
      const create = card.wrapper.get('[data-role="checklist-create"]');

      assert.equal(create.element.disabled, true);
      await input.setValue('   ');
      assert.equal(create.element.disabled, true);
      await input.setValue(` ${title} `);
      await (keyboard ? input.trigger('keydown', { key: 'Enter' }) : create.trigger('click'));
      await card.flushPromises();
      assertMutation(card, 'POST', '/checklist', { title });
      assert.equal(card.wrapper.find('[data-role="checklist-list-input"]').exists(), false);

      const id = Object.keys(card.task.checklist).find((key) => !before.has(key));
      const list = taskChecklistItem(card.wrapper, id);

      assert.equal(list.get('h6').text().includes(title), true);
      assert.equal(list.find('input[type="checkbox"]').exists(), false);
      assert.equal(card.wrapper.find(`[data-checklist-parent="${id}"]`).exists(), true);
    }
  });
}

test('Отмена и Esc закрывают создание списка без записи и очищают имя', async (t) => {
  const card = await interactiveCard(t);

  for (const keyboard of [false, true]) {
    await card.wrapper.get('[data-role="checklist-add-list"]').trigger('click');

    const input = card.wrapper.get('[data-role="checklist-list-input"]');

    assert.equal(input.element.value, '');
    await input.setValue('Черновик списка');
    await (keyboard ? input.trigger('keydown', { key: 'Escape' })
      : card.wrapper.get('[data-role="checklist-create-cancel"]').trigger('click'));
    assert.equal(card.wrapper.find('[data-role="checklist-list-input"]').exists(), false);
    assert.equal(card.wrapper.find('[data-role="checklist-add-list"]').exists(), true);
  }

  assert.equal(card.calls.some((call) => call.method === 'POST'), false);
  assert.equal(card.ui.taskId, '42');
});

for (const presentation of ['dialog', 'document']) {
  test(`${presentation}: Сохранить и Enter записывают текущий пункт без добавления следующего`, async (t) => {
    const card = await interactiveCard(t, { presentation });

    assert.equal(card.wrapper.find('[data-role="checklist-add-input"]').exists(), false);
    assert.equal(taskChecklistItem(card.wrapper, 11).text().includes('Добавить пункт'), false);

    for (const [parent, keyboard] of [['10', false], ['11', true]]) {
      if (parent === '11') {
        await taskChecklistItem(card.wrapper, 11).get('[data-task-action="checklist-add-child"]')
          .trigger('click');
      } else {
        await card.wrapper.get('[data-checklist-parent="10"] [data-role="checklist-add-item"]')
          .trigger('click');
      }

      const form = card.wrapper.get(`[data-checklist-parent="${parent}"]`);
      const input = form.get('input');
      const save = form.get('[data-role="checklist-add"]');
      const postsBefore = card.calls.filter((call) => call.method === 'POST').length;

      assert.equal(input.attributes('placeholder'), 'Название пункта');
      assert.equal(input.element.ownerDocument.activeElement === input.element, true);
      assert.equal(save.text(), 'Сохранить');
      assert.equal(save.element.disabled, true);
      assert.equal(form.get('[data-role="checklist-item-cancel"]').text(), 'Отмена');
      await input.setValue(` Пункт ${parent} `);
      assert.equal(card.calls.filter((call) => call.method === 'POST').length, postsBefore);
      await (keyboard ? input.trigger('keydown', { key: 'Enter' }) : save.trigger('click'));
      await card.flushPromises();
      assertMutation(card, 'POST', '/checklist', {
        title: `Пункт ${parent}`,
        parentId: parent,
      });
      assert.equal(card.calls.filter((call) => call.method === 'POST').length, postsBefore + 1);
      assert.equal(card.wrapper.find('[data-role="checklist-add-input"]').exists(), false);
      assert.equal(card.wrapper.get('[data-role="checklist-item-saved"]').text(),
        `Пункт «Пункт ${parent}» сохранён`);

      const saved = Object.values(card.tasks.details['42'].data.checklist)
        .find((item) => item.title === `Пункт ${parent}`);

      assert.equal(Boolean(saved), true);
      assert.equal(taskChecklistItem(card.wrapper, saved.id).find('input[type="checkbox"]').exists(), true);
    }
  });
}

test('Отмена и Esc закрывают ввод нового пункта без записи и очищают текст', async (t) => {
  const card = await interactiveCard(t);

  for (const keyboard of [false, true]) {
    await card.wrapper.get('[data-checklist-parent="10"] [data-role="checklist-add-item"]')
      .trigger('click');

    const input = card.wrapper.get('[data-role="checklist-add-input"]');

    assert.equal(input.element.value, '');
    await input.setValue('Черновик пункта');
    await (keyboard ? input.trigger('keydown', { key: 'Escape' })
      : card.wrapper.get('[data-role="checklist-item-cancel"]').trigger('click'));
    await card.flushPromises();
    assert.equal(card.wrapper.find('[data-role="checklist-add-input"]').exists(), false);
    assert.equal(card.ui.taskId, '42');
  }

  assert.equal(card.calls.some((call) => call.method === 'POST'), false);
});

test('Ошибка оставляет ввод пункта, повторный Enter во время сохранения блокируется', async (t) => {
  const pending = Promise.withResolvers();
  const card = await interactiveCard(t, { mutation: () => pending.promise });

  await card.wrapper.get('[data-checklist-parent="10"] [data-role="checklist-add-item"]').trigger('click');

  const input = card.wrapper.get('[data-role="checklist-add-input"]');

  await input.setValue('Не терять этот пункт');
  await card.wrapper.get('[data-role="checklist-add"]').trigger('click');
  assert.equal(input.element.disabled, true);
  assert.equal(card.wrapper.get('[data-role="checklist-add"]').element.disabled, true);
  assert.equal(card.wrapper.get('[data-role="checklist-item-cancel"]').element.disabled, true);
  await input.trigger('keydown', { key: 'Enter' });
  await input.trigger('keydown', { key: 'Escape' });
  assert.equal(card.calls.filter((call) => call.method === 'POST').length, 1);
  pending.reject(new Error('Не удалось сохранить пункт'));
  await card.flushPromises();
  assert.equal(input.element.value, 'Не терять этот пункт');
  assert.equal(input.element.disabled, false);
  assert.equal(card.wrapper.find('[data-role="checklist-item-saved"]').exists(), false);
  assert.equal(card.wrapper.text().includes('Не удалось сохранить пункт'), true);
});

test('Удаление родителя открытой формы не блокирует добавление в оставшийся список', async (t) => {
  const card = await interactiveCard(t);

  await card.wrapper.get('[data-role="checklist-add-list"]').trigger('click');
  await card.wrapper.get('[data-role="checklist-list-input"]').setValue('Другой список');
  await card.wrapper.get('[data-role="checklist-create"]').trigger('click');
  await card.flushPromises();
  await card.wrapper.get('[data-checklist-parent="10"] [data-role="checklist-add-item"]').trigger('click');
  await taskChecklistItem(card.wrapper, 10).get('[data-task-action="checklist-delete"]').trigger('click');
  await card.flushPromises();

  const remaining = card.wrapper.get('[data-role="checklist-add-item"]');

  assert.equal(remaining.element.disabled, false);
  await remaining.trigger('click');
  assert.equal(card.wrapper.get('[data-role="checklist-add-input"]').element.value, '');
});

test('Переименование и удаление пункта используют inline-редактор и общий confirmDialog', async (t) => {
  const confirmations = [];
  const card = await interactiveCard(t, { confirm: async (...args) => {
    confirmations.push(args);

    return true;
  } });

  await taskChecklistItem(card.wrapper, 11).get('[data-task-action="checklist-rename"]').trigger('click');
  await card.wrapper.get('[data-role="checklist-rename-input"]').setValue('Новое имя');
  await card.wrapper.get('[data-role="checklist-rename-input"]').trigger('keydown', { key: 'Enter' });
  await card.flushPromises();
  assertMutation(card, 'PUT', '/checklist/11', { title: 'Новое имя' });
  assert.equal(taskChecklistItem(card.wrapper, 11).text().includes('Новое имя'), true);
  await taskChecklistItem(card.wrapper, 11).get('[data-task-action="checklist-delete"]').trigger('click');
  await card.flushPromises();
  assertMutation(card, 'DELETE', '/checklist/11', undefined);
  assert.equal(card.wrapper.find('[data-checklist-id="11"]').exists(), false);
  assert.equal(confirmations[0][0].includes('Новое имя'), true);
  assert.equal(confirmations[0][1].danger, true);
});

test('Список переименовывается с явными Сохранить/Отмена и удаляется вместе с пунктами', async (t) => {
  const confirmations = [];
  const card = await interactiveCard(t, { confirm: async (...args) => {
    confirmations.push(args);

    return true;
  } });

  for (const keyboard of [false, true]) {
    await taskChecklistItem(card.wrapper, 10).get('[data-task-action="checklist-rename"]').trigger('click');
    await card.wrapper.get('[data-role="checklist-rename-input"]').setValue('Не сохранять');
    assert.equal(card.calls.some((call) => call.method === 'PUT'), false);
    await (keyboard ? card.wrapper.get('[data-role="checklist-rename-input"]')
      .trigger('keydown', { key: 'Escape' })
      : card.wrapper.get('[data-role="checklist-rename-cancel"]').trigger('click'));
    assert.equal(taskChecklistItem(card.wrapper, 10).get('h6').text().includes('Список'), true);
  }

  await taskChecklistItem(card.wrapper, 10).get('[data-task-action="checklist-rename"]').trigger('click');
  await card.wrapper.get('[data-role="checklist-rename-input"]').setValue('Новое имя списка');
  await card.wrapper.get('[data-role="checklist-rename-save"]').trigger('click');
  await card.flushPromises();
  assertMutation(card, 'PUT', '/checklist/10', { title: 'Новое имя списка' });
  assert.equal(taskChecklistItem(card.wrapper, 10).get('h6').text().includes('Новое имя списка'), true);
  await taskChecklistItem(card.wrapper, 10).get('[data-task-action="checklist-delete"]').trigger('click');
  await card.flushPromises();
  assertMutation(card, 'DELETE', '/checklist/10', undefined);
  assert.equal(card.wrapper.find('[data-checklist-id="10"]').exists(), false);
  assert.equal(card.wrapper.find('[data-checklist-id="11"]').exists(), false);
  assert.equal(confirmations[0][0], 'Удалить список «Новое имя списка» вместе с пунктами?');
  assert.equal(confirmations[0][1].danger, true);
});

for (const id of [10, 11]) {
  test(`Отмена удаления ${id} не отправляет мутацию`, async (t) => {
    const card = await interactiveCard(t, { confirm: async () => false });

    await taskChecklistItem(card.wrapper, id).get('[data-task-action="checklist-delete"]').trigger('click');
    await card.flushPromises();
    assert.equal(card.calls.some((call) => call.method === 'DELETE'), false);
    assert.equal(card.wrapper.find(`[data-checklist-id="${id}"]`).exists(), true);
  });
}

test('Ошибка создания сохраняет имя списка, блокировка не допускает повторной записи', async (t) => {
  const pending = Promise.withResolvers();
  const card = await interactiveCard(t, { mutation: () => pending.promise });

  await card.wrapper.get('[data-role="checklist-add-list"]').trigger('click');
  await card.wrapper.get('[data-role="checklist-list-input"]').setValue('Черновик списка');
  await card.wrapper.get('[data-role="checklist-create"]').trigger('click');
  assert.equal(card.wrapper.get('[data-role="checklist-create"]').element.disabled, true);
  await card.wrapper.get('[data-role="checklist-list-input"]').trigger('keydown', { key: 'Enter' });
  assert.equal(card.calls.filter((call) => call.method === 'POST').length, 1);
  pending.reject(new Error('Список не создан'));
  await card.flushPromises();
  assert.equal(card.wrapper.get('[data-role="checklist-list-input"]').element.value, 'Черновик списка');
  assert.equal(card.wrapper.text().includes('Список не создан'), true);
  assert.equal(card.wrapper.findAll('[data-role="checklist-list-progress"]').length, 1);
});

test('Теги добавляются кнопкой и Enter с очисткой и фокусом, снимаются прежним чипом', async (t) => {
  const card = await interactiveCard(t);
  const input = card.wrapper.get('[data-role="task-tag-input"]');
  const button = card.wrapper.get('[data-role="task-tag-add"]');

  assert.equal(button.text(), 'Добавить');
  assert.equal(button.element.disabled, true);
  await input.setValue('  ');
  assert.equal(button.element.disabled, true);

  for (const [tag, keyboard, tags] of [
    ['Новый', false, ['Первый', 'Второй', 'Новый']],
    ['Ещё', true, ['Первый', 'Второй', 'Новый', 'Ещё']],
  ]) {
    await input.setValue(` ${tag} `);
    button.element.focus();
    await (keyboard ? input.trigger('keydown', { key: 'Enter' }) : button.trigger('click'));
    await card.flushPromises();
    assertMutation(card, 'PUT', '/tags', { tags });
    assert.equal(card.wrapper.get('[data-role="task-tags"]').text().includes(tag), true);
    assert.equal(input.element.value, '');
    assert.equal(button.element.disabled, true);
    assert.equal(input.element.ownerDocument.activeElement === input.element, true);
  }

  for (const tags of [['Второй', 'Новый', 'Ещё'], ['Новый', 'Ещё'], ['Ещё'], []]) {
    await card.wrapper.get('[data-task-action="task-tag-remove"]').trigger('click');
    await card.flushPromises();
    assertMutation(card, 'PUT', '/tags', { tags });
  }

  assert.equal(card.wrapper.findAll('[data-task-action="task-tag-remove"]').length, 0);
});

for (const [action, status] of [['approve', 5], ['disapprove', 2]]) {
  test(`Статус 4: ${action} заменяет завершение и обновляет карточку с доской`, async (t) => {
    const card = await interactiveCard(t, { status: 4 });

    assert.equal(cardButton(card.wrapper, 'Завершить') === undefined, true);
    assert.equal(card.wrapper.find('[data-role="task-approve"]').exists(), true);
    assert.equal(card.wrapper.find('[data-role="task-disapprove"]').exists(), true);
    await card.wrapper.get(`[data-role="task-${action}"]`).trigger('click');
    await card.flushPromises();
    assertMutation(card, 'POST', `/${action}`, undefined);
    assert.equal(card.tasks.details['42'].data.status, status);
    assert.equal(card.calls.some((call) => call.method === 'BOARD'), true);
    assert.equal(card.wrapper.find('[data-role="task-approve"]').exists(), false);
  });
}

test('Возобновление завершённого stock перечитывает статус и сохраняет карточку открытой', async (t) => {
  const card = await interactiveCard(t, { status: 5 });

  await cardButton(card.wrapper, 'Возобновить').trigger('click');
  await card.flushPromises();
  assertMutation(card, 'POST', '/renew', undefined);
  assert.equal(card.tasks.details['42'].data.status, 2);
  assert.equal(cardButton(card.wrapper, 'Завершить') !== undefined, true);
});

for (const mode of ['unsupported', 'legacy', 'own']) {
  test(`${mode}: интерактивные контролы скрыты`, async (t) => {
    const card = await interactiveCard(t, {
      status: 4,
      ...(mode === 'unsupported' ? {
        capabilities: {
          ...STOCK_CAPS,
          checklist: false,
          tags: false,
          review: false,
        },
      } : {}),
      ...(mode === 'legacy' ? { metadataMode: 'legacy' } : {}),
      ...(mode === 'own' ? {
        id: '100000000001',
        detail: {
          source: 'grigdesk',
          projectId: 'own',
          projectTitle: 'Проект',
          createdAt: '2026-01-01T00:00:00Z',
        },
      } : {}),
    });

    for (const role of ['checklist-add-input', 'checklist-add-list', 'checklist-create', 'checklist-add-item',
      'task-tag-input', 'task-tag-add', 'task-approve', 'task-disapprove']) {
      assert.equal(card.wrapper.find(`[data-role="${role}"]`).exists(), false, role);
    }

    for (const action of ['checklist-rename', 'checklist-delete', 'task-tag-remove']) {
      assert.equal(card.wrapper.find(`[data-task-action="${action}"]`).exists(), false, action);
    }
  });
}

test('Участники из REST-карты выбраны; полное снятие передаёт пустую строку', async (t) => {
  const card = await interactiveCard(t, {
    users: [{ id: 7, name: 'Соисполнитель' }, { id: 9, name: 'Наблюдатель' }],
    detail: {
      accomplicesData: { 7: { name: 'Соисполнитель' } },
      auditorsData: { 9: { name: 'Наблюдатель' } },
    },
  });

  await card.wrapper.get('[data-role="task-edit-open"]').trigger('click');
  await card.flushPromises();

  for (const key of ['accomplices', 'auditors']) {
    const field = card.wrapper.get(`[data-role="task-edit-${key}"]`);

    assert.equal(field.findAll('[aria-selected="true"]').length, 1);
    await field.get('[aria-selected="true"]').trigger('click');
  }

  await card.wrapper.get('[data-role="task-edit-save"]').trigger('click');
  await card.flushPromises();
  assert.deepEqual(card.calls.find((call) => call.method === 'PUT').payload, {
    accomplices: '',
    auditors: '',
  });
});

test('Пункт заблокирован во время записи; ошибка сохраняет исходную отметку и общий err', async (t) => {
  const pending = Promise.withResolvers();
  const card = await interactiveCard(t, { mutation: () => pending.promise });
  const checkbox = () => taskChecklistItem(card.wrapper, 11).get('input[type="checkbox"]');

  await checkbox().setValue(true);
  assert.equal(checkbox().element.disabled, true);
  assert.equal(checkbox().element.checked, false);
  assert.equal(card.tasks.details['42'].data.checklist[11].isComplete, 'N');
  pending.reject(new Error('Портал отказал в изменении'));
  await card.flushPromises();
  assert.equal(checkbox().element.disabled, false);
  assert.equal(checkbox().element.checked, false);
  assert.equal(card.wrapper.text().includes('Портал отказал в изменении'), true);
});

test('Отказ изменения тегов сохраняет чипы и черновик для повторной попытки', async (t) => {
  const card = await interactiveCard(t, { mutation: async () => {
    throw new Error('Теги недоступны');
  } });

  await card.wrapper.get('[data-role="task-tag-input"]').setValue('Черновик');
  await card.wrapper.get('[data-role="task-tag-input"]').trigger('keydown', { key: 'Enter' });
  await card.flushPromises();
  assert.equal(card.wrapper.get('[data-role="task-tag-input"]').element.value, 'Черновик');
  assert.equal(card.wrapper.get('[data-role="task-tags"]').text().includes('Первый'), true);
  assert.equal(card.wrapper.text().includes('Теги недоступны'), true);
});

test('Поздняя мутация после смены трекера не перечитывает задачу другого подключения', async (t) => {
  const pending = Promise.withResolvers();
  const card = await interactiveCard(t, { mutation: () => pending.promise });

  await taskChecklistItem(card.wrapper, 11).get('input[type="checkbox"]').setValue(true);

  for (const listener of card.listeners) {
    listener('trackers-changed', { revision: 2 });
  }

  await card.flushPromises();

  const before = card.calls.length;

  pending.resolve({ ok: true });
  await card.flushPromises();
  assert.equal(card.calls.slice(before).some((call) => call.url === '/api/tracker/task/42'), false);
  assert.deepEqual(card.tasks.details, {});
});

test('Выбор нескольких участников отправляет массив id и сохраняет нетронутую роль', async (t) => {
  const card = await interactiveCard(t, {
    users: [{ id: 7, name: 'Первый' }, { id: 9, name: 'Второй' }],
  });

  await card.wrapper.get('[data-role="task-edit-open"]').trigger('click');
  await card.flushPromises();

  const options = card.wrapper.get('[data-role="task-edit-accomplices"]').findAll('[role="option"]');

  await options[0].trigger('click');
  await options[1].trigger('click');
  await card.wrapper.get('[data-role="task-edit-save"]').trigger('click');
  await card.flushPromises();
  assert.deepEqual(card.calls.find((call) => call.method === 'PUT').payload, { accomplices: [7, 9] });
});


test('Ошибка чтения тегов блокирует полную замену неизвестного списка', async (t) => {
  const card = await interactiveCard(t, { pageMode: 'error' });
  const input = card.wrapper.get('[data-role="task-tag-input"]');

  assert.equal(input.element.disabled, true);
  assert.equal(card.wrapper.get('[data-role="task-tag-add"]').element.disabled, true);
  assert.equal(card.wrapper.text().includes('Не удалось загрузить теги'), true);
  await input.trigger('keydown', { key: 'Enter' });
  await card.flushPromises();
  assert.equal(card.calls.some((call) => call.method === 'PUT' && call.url.endsWith('/tags')), false);
});
