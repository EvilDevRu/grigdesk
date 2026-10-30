import assert from 'node:assert/strict';
import test from 'node:test';

import { LOCAL_TASK, mountLocalCard } from './helpers/grigdesk-task-card.js';

for (const presentation of ['dialog', 'document']) {
  test(`LOCAL-CARD-01: ${presentation} показывает свой текст без действий и ошибок Б24`, async (t) => {
    const { wrapper, personal, reads } = await mountLocalCard(t, { presentation });
    const text = wrapper.text();

    assert.match(text, /Задача GrigDesk/);
    assert.match(text, /Своя задача/);
    assert.match(text, /Проект Бета/);
    assert.ok(text.includes(LOCAL_TASK.description));
    assert.doesNotMatch(text, /Задача Битрикс24|Чужая ошибка|Завершить|Возобновить/);
    assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), false);
    assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
    assert.equal(wrapper.find('[data-role="task-comment"]').exists(), false);
    assert.equal(wrapper.find('[data-role="task-shelf-toggle"]').exists(), false);
    assert.equal(wrapper.find('.stub-modal-fav').exists(), false);
    assert.deepEqual(personal, []);
    assert.equal(reads.some((url) => url.startsWith('/api/b24/')), false);
    assert.ok(wrapper.find('[data-role="task-launch-open"]').exists());
    assert.match(text, /Оценка|Триаж|Сложность/i);
  });
}

test('LOCAL-CARD-02: refresh и поздний ответ предыдущей карточки не смешивают источники', async (t) => {
  let releasePortal;
  let releaseUnknown;
  const { wrapper, ui, flushPromises } = await mountLocalCard(t, {
    load: async (id) => {
      if (String(id) === '42') {
        return new Promise((resolve) => {
          releasePortal = resolve;
        });
      }
      if (String(id) === '100000000002') {
        return new Promise((resolve) => {
          releaseUnknown = resolve;
        });
      }

      return { ...LOCAL_TASK };
    },
  });

  await wrapper.get('[aria-label="Обновить задачу"]').trigger('click');
  await flushPromises();
  assert.match(wrapper.text(), /Задача GrigDesk/);
  ui.taskId = '42';
  await flushPromises();
  assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
  assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), true);

  ui.taskId = '100000000002';
  await flushPromises();
  assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
  assert.equal(wrapper.find('[aria-label="Учёт времени"]').exists(), false);
  ui.taskId = LOCAL_TASK.id;
  await flushPromises();
  releaseUnknown({ ...LOCAL_TASK, id: '100000000002' });
  releasePortal({
    id: 42,
    title: 'Поздняя задача Б24',
    description: '<p>Чужое</p>'
  });
  await flushPromises();
  assert.match(wrapper.text(), /Своя задача/);
  assert.match(wrapper.text(), /Задача GrigDesk/);
  assert.doesNotMatch(wrapper.text(), /Поздняя задача Б24|Чужое/);
  assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);

  ui.taskId = '42';
  await flushPromises();
  releasePortal({
    id: 42,
    title: 'Задача портала',
    description: '<p>Портальная постановка</p>',
  });
  await flushPromises();
  assert.match(wrapper.text(), /Задача Битрикс24/);
  assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), true);
  ui.taskId = LOCAL_TASK.id;
  await flushPromises();
  assert.match(wrapper.text(), /Задача GrigDesk/);
  assert.equal(wrapper.find('[data-role="task-edit-open"]').exists(), false);
});

test('LOCAL-CARD-03: plain text сохранён, ответы уходят одним batch и одной переоценкой', async (t) => {
  const { wrapper, flushPromises, posts, analyzed } = await mountLocalCard(t);

  assert.ok(wrapper.text().includes(LOCAL_TASK.description));

  // happy-dom воспринимает кириллический селектор тега как универсальный.
  // Проверяем имена реальных элементов, чтобы экранированный текст не давал ложный отказ.
  const descriptionTags = wrapper.get('.brief-scroll').findAll('*').map((node) => node.element.localName);

  assert.equal(descriptionTags.includes('текст'), false);

  const fields = wrapper.findAll('[data-role="task-clarification"]');

  for (const [index, field] of fields.entries()) {
    await field.setValue(index ? 'Назвать «Проверить»' : 'Оставить ручной');
  }

  const submit = wrapper.findAll('button').find((button) => button.text().includes('Уточнить и переоценить'));

  assert.ok(submit);
  await submit.trigger('click');
  await flushPromises();
  assert.equal(posts.filter((entry) => entry.url.endsWith('/clarifications')).length, 1);
  assert.equal(posts.find((entry) => entry.url.endsWith('/clarifications')).body.answers.length, 2);
  assert.deepEqual(analyzed, [LOCAL_TASK.id]);
});

test('LOCAL-CARD-03: пустое описание не превращается в ожидание загрузки портала', async (t) => {
  const { wrapper } = await mountLocalCard(t, { task: { ...LOCAL_TASK, description: '' } });

  assert.doesNotMatch(wrapper.text(), /Постановка пока не загружена/);
  assert.match(wrapper.text(), /описани[ея][\s\S]*(пуст|не задан|не добавлен|отсутств)|нет описания/i);
});

test('LOCAL-LAUNCH-FORM-01: свой проект передаётся initial/refresh, явный выбор сильнее', async (t) => {
  const profiles = [];
  const { wrapper, flushPromises, listeners } = await mountLocalCard(t, {
    launchOptions: async (_id, profile) => {
      profiles.push(profile);

      return {
        profiles: ['alpha', 'beta'],
        profile: profile || 'alpha',
        routes: ['feature'],
        defaultRoute: 'feature',
        routeOptions: { feature: { deliveryMode: 'disabled', instrumentationRequired: false } },
        repositories: [],
      };
    },
  });

  await wrapper.get('[data-role="task-launch-open"]').trigger('click');
  await flushPromises();
  assert.equal(profiles[0], 'beta');

  const initialReads = profiles.length;

  for (const listener of listeners) {
    listener('projects-changed', {
      kind: 'updated',
      id: 'beta',
      revision: 2,
    });
  }

  await flushPromises();
  assert.ok(profiles.length > initialReads, 'Событие перечитывает параметры запуска');
  assert.equal(profiles.at(-1), 'beta');
  assert.equal(wrapper.get('#launch-profile-native').element.value, 'beta');
  await wrapper.get('#launch-profile-native').setValue('alpha');
  await flushPromises();

  const selectedReads = profiles.length;

  for (const listener of listeners) {
    listener('projects-changed', {
      kind: 'updated',
      id: 'beta',
      revision: 3,
    });
  }

  await flushPromises();
  assert.ok(profiles.length > selectedReads, 'Явный выбор сохраняется после нового чтения');
  assert.equal(profiles.at(-1), 'alpha');
  assert.equal(wrapper.get('#launch-profile-native').element.value, 'alpha');
});
