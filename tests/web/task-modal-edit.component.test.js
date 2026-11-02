// Редактор задачи внутри TaskModal: поля заполняются фактическим DTO портала,
// а в store уезжают только изменения, подтверждённые человеком.
import assert from 'node:assert/strict';
import test from 'node:test';

import { trackerMetadata } from './helpers/trackerCard.js';

import { compileTaskModal } from './helpers/task-modal.js';

process.env.NODE_ENV = 'test';

let nonce = 0;

/**
 * Монтирует карточку с живыми UI-primitives и управляемыми B24-справочниками.
 * Представление dialog или document выбирает тест, остальные подмены общие.
 */
async function mountEditor(t, presentation = 'dialog') {
  nonce += 1;
  const prefix = `__taskModalEdit${nonce}`;
  const { Window } = await import('../../web/node_modules/happy-dom/lib/index.js');
  const browser = new Window({ url: 'http://grigdesk.test/#/board' });
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    location: browser.location,
    FormData: browser.FormData,
    Node: browser.Node,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    SVGElement: browser.SVGElement,
    Event: browser.Event,
    CustomEvent: browser.CustomEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
  })) {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  browser.document.body.innerHTML = '<div id="mount"></div>';

  const [{ mount, flushPromises }, { createPinia, defineStore }] = await Promise.all([
    import('../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'),
    import('../../web/node_modules/pinia/dist/pinia.mjs'),
  ]);
  let task = {
    id: 42,
    title: 'Старая постановка',
    description: '<p>Исходное описание<br>со второй строкой</p>',
    priority: 0,
    priority_label: 'Низкий',
    group_id: 7,
    group_name: 'Старый проект',
    responsible: { id: 17, name: 'Старый исполнитель' },
  };
  const updates = [];
  const reads = [];

  globalThis[`${prefix}Api`] = {
    /**
     * Справочники и комментарии читаются через прежние публичные адреса.
     * Счётчик отделяет ленивую загрузку обсуждения от простого переключения областей.
     */
    async get(url) {
      reads.push(url);

      if (url === '/api/trackers') {
        return trackerMetadata();
      }

      if (url.endsWith('/comments')) {
        return { comments: [{
          mid: 1,
          author: 'Автор',
          text: 'Комментарий',
          time: '10:00',
        }] };
      }
      if (url.endsWith('/clarifications')) return { text: '' };
      if (url === '/api/tasks') return { tasks: [] };
      if (url === '/api/tracker/users') {
        return {
          users: [
            { id: 17, name: 'Старый исполнитель' },
            { id: 23, name: 'Новый исполнитель' },
          ],
        };
      }
      if (url === '/api/tracker/groups') {
        return {
          groups: [
            { id: 7, name: 'Старый проект' },
            { id: 9, name: 'Новый проект' },
          ],
        };
      }
      return {};
    },
    async post() { return {}; },
    async upload() { return {}; },
  };
  globalThis[`${prefix}UiStore`] = defineStore(`task-modal-edit-ui-${nonce}`, {
    state: () => ({ taskId: 42, launchRequested: false }),
    actions: { close() {}, consumeTaskLaunch() {} },
  });
  globalThis[`${prefix}TasksStore`] = defineStore(`task-modal-edit-tasks-${nonce}`, {
    actions: {
      async load() { return task; },
      async update(id, fields) {
        updates.push({ id: String(id), fields });
        task = {
          ...task,
          ...(Object.hasOwn(fields, 'title') ? { title: fields.title } : {}),
          ...(Object.hasOwn(fields, 'description') ? { description: fields.description } : {}),
          ...(Object.hasOwn(fields, 'priority') ? { priority: fields.priority } : {}),
          ...(Object.hasOwn(fields, 'groupId') ? { group_id: fields.groupId || 0 } : {}),
          ...(Object.hasOwn(fields, 'responsibleId')
            ? { responsible: { id: fields.responsibleId, name: 'Новый исполнитель' } }
            : {}),
        };
        return task;
      },
      async timer() {},
      async complete() {},
      async comment() {},
      async launch() { return {}; },
    },
  });
  globalThis[`${prefix}BoardStore`] = defineStore(`task-modal-edit-board-${nonce}`, {
    state: () => ({
      data: { tasks: [], toReview: [], created: [], accomplice: [], auditor: [] },
    }),
    actions: { async load() {} },
  });
  globalThis[`${prefix}AnalysisStore`] = defineStore(`task-modal-edit-analysis-${nonce}`, {
    actions: { async detail() { return {}; }, async analyze() {} },
  });
  globalThis[`${prefix}FavoritesStore`] = defineStore(`task-modal-edit-favorites-${nonce}`, {
    state: () => ({ taskIds: [], loaded: true, loading: false, error: null, pending: {} }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false,
    },
    actions: { async load() {}, async toggle() { return true; } },
  });
  globalThis[`${prefix}SeenStore`] = defineStore(`task-modal-edit-seen-${nonce}`, {
    state: () => ({ loaded: true, initialized: true, error: null }),
    getters: { ready: () => true, isSeen: () => () => true },
    actions: { async markSeen() { return true; } },
  });

  const TaskModal = await compileTaskModal(prefix);
  const wrapper = mount(TaskModal, {
    props: { presentation },
    attachTo: browser.document.querySelector('#mount'),
    global: { plugins: [createPinia()], stubs: { teleport: true } },
  });
  t.after(() => {
    wrapper.unmount();
    browser.close();
    for (const suffix of [
      'Api',
      'UiStore',
      'TasksStore',
      'BoardStore',
      'AnalysisStore',
      'FavoritesStore',
      'SeenStore',
    ]) {
      delete globalThis[`${prefix}${suffix}`];
    }
  });
  await flushPromises();
  await flushPromises();

  return {
    wrapper,
    flushPromises,
    updates,
    reads,
  };
}

test('TaskModal редактирует все основные поля и умеет очистить описание и проект', async (t) => {
  const { wrapper, flushPromises, updates } = await mountEditor(t);

  await wrapper.get('[data-role="task-edit-open"]').trigger('click');
  await flushPromises();
  assert.equal(wrapper.get('[data-role="task-edit-title"]').element.value, 'Старая постановка');
  assert.match(
    wrapper.get('[data-role="task-edit-description"]').element.value,
    /Исходное описание\nсо второй строкой/,
  );
  assert.equal(wrapper.get('[data-role="task-edit-responsible"]').element.value, '17');
  assert.equal(wrapper.get('[data-role="task-edit-group"]').element.value, '7');
  assert.equal(wrapper.get('[data-role="task-edit-priority"]').element.value, '0');

  await wrapper.get('[data-role="task-edit-title"]').setValue('Новая постановка');
  await wrapper.get('[data-role="task-edit-description"]').setValue('');
  await wrapper.get('[data-role="task-edit-responsible"]').setValue('23');
  await wrapper.get('[data-role="task-edit-group"]').setValue('');
  await wrapper.get('[data-role="task-edit-priority"]').setValue('2');
  await wrapper.get('[data-role="task-edit-save"]').trigger('click');
  await flushPromises();

  assert.deepEqual(updates, [{
    id: '42',
    fields: {
      title: 'Новая постановка',
      description: '',
      groupId: null,
      responsibleId: 23,
      priority: 2,
    },
  }]);
  assert.equal(wrapper.find('[data-role="task-edit-title"]').exists(), false);
  assert.match(wrapper.text(), /Изменения сохранены\./);
  assert.match(wrapper.text(), /Новая постановка/);
});

test('TaskModal не перезаписывает нетронутые поля очищенным представлением', async (t) => {
  const { wrapper, flushPromises, updates } = await mountEditor(t);

  await wrapper.get('[data-role="task-edit-open"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-role="task-edit-title"]').setValue('Только новый заголовок');
  await wrapper.get('[data-role="task-edit-save"]').trigger('click');
  await flushPromises();

  assert.deepEqual(updates, [{
    id: '42',
    fields: { title: 'Только новый заголовок' },
  }]);
});

test('TF-01: та же карточка редактируется как документ без модального backdrop', async (t) => {
  const { wrapper, flushPromises, updates } = await mountEditor(t, 'document');

  assert.equal(wrapper.find('.task-card-document').exists(), true);
  assert.equal(wrapper.find('[aria-modal="true"]').exists(), false);
  await wrapper.get('[data-role="task-edit-open"]').trigger('click');
  await flushPromises();
  await wrapper.get('[data-role="task-edit-title"]').setValue('Заголовок отдельного окна');
  await wrapper.get('[data-role="task-edit-save"]').trigger('click');
  await flushPromises();
  assert.deepEqual(updates, [{ id: '42', fields: { title: 'Заголовок отдельного окна' } }]);
  assert.match(wrapper.text(), /Изменения сохранены/);
});

for (const presentation of ['dialog', 'document']) {
  test(`Разделы карточки сохраняют черновики и используют один page-запрос: ${presentation}`, async (t) => {
    const { wrapper, flushPromises, reads, updates } = await mountEditor(t, presentation);
    const section = (name) => wrapper.get(`[data-task-section="${name}"]`);

    assert.equal(wrapper.get('.task-detail').attributes('data-pane'), 'description');
    assert.equal(reads.filter((url) => url.endsWith('/comments')).length, 1);
    assert.equal(section('description').attributes('aria-selected'), 'true');
    section('description').element.focus();
    await section('description').trigger('keydown', { key: 'ArrowRight' });
    assert.equal(section('triage').attributes('aria-selected'), 'true');
    await section('triage').trigger('keydown', { key: 'ArrowLeft' });
    assert.equal(section('description').attributes('aria-selected'), 'true');
    await wrapper.get('[data-role="task-edit-open"]').trigger('click');
    await flushPromises();
    await wrapper.get('[data-role="task-edit-title"]').setValue('Несохранённая постановка');

    const editor = wrapper.get('[data-role="task-edit-title"]').element;

    await section('triage').trigger('click');
    assert.equal(wrapper.get('.task-detail').attributes('data-pane'), 'work');
    assert.equal(section('triage').attributes('aria-selected'), 'true');
    await section('comments').trigger('click');
    await flushPromises();
    assert.equal(reads.filter((url) => url.endsWith('/comments')).length, 1);
    await wrapper.get('[data-role="task-comment"]').setValue('Несохранённый комментарий');

    const composer = wrapper.get('[data-role="task-comment"]').element;

    await section('description').trigger('click');
    assert.equal(wrapper.get('[data-role="task-edit-title"]').element === editor, true);
    assert.equal(editor.value, 'Несохранённая постановка');
    await section('comments').trigger('click');
    await flushPromises();
    assert.equal(wrapper.get('[data-role="task-comment"]').element === composer, true);
    assert.equal(composer.value, 'Несохранённый комментарий');
    assert.equal(reads.filter((url) => url.endsWith('/comments')).length, 1);
    assert.deepEqual(updates, []);
  });
}
