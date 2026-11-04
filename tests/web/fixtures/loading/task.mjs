import assert from 'node:assert/strict';

import { compileVue, webFile } from '../../helpers/compile-vue.js';
import { compileTaskModal } from '../../helpers/task-modal.js';
import { trackerMetadata } from '../../helpers/trackerCard.js';
import { installUiBrowser } from '../../helpers/ui-components.js';

let serial = 0;

/**
 * Настоящая карточка получает синтетическую задачу и независимые удержанные справочники.
 * Единственные разрешённые сетевые адреса перечислены явно; живые данные не читаются.
 */
export async function mountLoadingTask(t, area = 'options') {
  await installUiBrowser(t);

  const { createPinia, defineStore } = await import('../../../../web/node_modules/pinia/dist/pinia.mjs');
  const { mount, flushPromises } = await import(
    '../../../../web/node_modules/@vue/test-utils/dist/vue-test-utils.esm-bundler.mjs'
  );
  const prefix = `__loadingTask${serial += 1}`;
  const detail = Promise.withResolvers();
  const comments = Promise.withResolvers();
  let users = Promise.withResolvers();
  let groups = Promise.withResolvers();
  const calls = [];
  const task = {
    id: 42,
    title: 'Синтетическая задача',
    description: '<p>Синтетическое описание</p>',
    priority: 0,
    group_id: 7,
    group_name: 'Проект',
    responsible: {
      id: 17,
      name: 'Исполнитель'
    },
  };

  globalThis[`${prefix}Api`] = {
    /**
     * Справочники и комментарии остаются независимыми управляемыми запросами.
     * Любой адрес вне сценария считается ошибкой фикстуры.
     */
    get(url) {
      calls.push(url);

      if (url === '/api/trackers') {
        return Promise.resolve(trackerMetadata('fixture-driver'));
      }

      if (url.endsWith('/clarifications')) {
        return Promise.resolve({ text: '' });
      }

      if (url === '/api/tasks') {
        return Promise.resolve({ tasks: [] });
      }

      if (url === '/api/tracker/users') {
        return users.promise;
      }

      if (url === '/api/tracker/groups') {
        return groups.promise;
      }

      if (url === '/api/tracker/task/42/comments') {
        return comments.promise;
      }

      assert.fail(`Неожиданный API карточки: ${url}`);
    },
  };
  globalThis[`${prefix}UiStore`] = defineStore(`${prefix}-ui`, {
    state: () => ({
      taskId: 42,
      launchRequested: false
    }),
    actions: {
      close() {},
      consumeTaskLaunch() {}
    },
  });
  globalThis[`${prefix}TasksStore`] = defineStore(`${prefix}-tasks`, {
    actions: {
      load: async () => area === 'description' ? detail.promise : task,
    },
  });
  globalThis[`${prefix}BoardStore`] = defineStore(`${prefix}-board`, {
    state: () => ({ data: {
        tasks: [],
        toReview: [],
        created: [],
        accomplice: [],
        auditor: []
    } }),
    actions: { async load() {} },
  });
  globalThis[`${prefix}AnalysisStore`] = defineStore(`${prefix}-analysis`, {
    actions: { async detail() {
        return {};
    } },
  });
  globalThis[`${prefix}FavoritesStore`] = defineStore(`${prefix}-favorites`, {
    state: () => ({
        taskIds: [],
        loaded: true,
        loading: false,
        error: null,
        pending: {}
    }),
    getters: {
      isFavorite: () => () => false,
      isPending: () => () => false
    },
    actions: { async load() {} },
  });
  globalThis[`${prefix}SeenStore`] = defineStore(`${prefix}-seen`, {
    state: () => ({
        loaded: true,
        initialized: true,
        error: null
    }),
    getters: {
      ready: () => true,
      isSeen: () => () => true
    },
    actions: { async markSeen() {
        return true;
    } },
  });

  const modal = await compileTaskModal(prefix);
  let component = modal;

  if (area === 'window') {
    globalThis[`${prefix}Component`] = modal;
    component = await compileVue(webFile('src/views/TaskWindowPage.vue'), { stubs: {
      './TaskModal.vue': `export default globalThis.${prefix}Component;`,
      '../stores/ui.ts': `export const useUiStore = globalThis.${prefix}UiStore;`,
      '../stores/auth.ts': 'export const useAuthStore = () => ({ authenticated: false });',
      '../stores/chat.ts': 'export const useChatStore = () => ({ syncSpeech() {} });',
      '../composables/useSse.ts': 'export const sseSubscribe = () => () => {};',
    } });
  }

  const wrapper = mount(component, {
    props: area === 'window' ? {
      target: {
      kind: 'task',
      id: '42'
    },
      ready: false
    }
      : { presentation: 'document' },
    attachTo: document.body,
    global: {
      plugins: [createPinia()],
      stubs: { teleport: true }
    },
  });

  t.after(() => {
    wrapper.unmount();

    for (const suffix of [
            'Api', 'UiStore', 'TasksStore', 'BoardStore', 'AnalysisStore', 'FavoritesStore', 'SeenStore',
            'Component',
        ]) {
      delete globalThis[`${prefix}${suffix}`];
    }
  });
  await flushPromises();
  await flushPromises();

  if (area === 'options') {
    await wrapper.get('[data-role="task-edit-open"]').trigger('click');
  }

  if (area === 'comments') {
    await wrapper.get('#task-tab-comments').trigger('click');
  }

  return {
    wrapper,
    calls,
    detail,
    comments,
    task,
    flush: flushPromises,
    failOptions() {
      users.reject(new Error('Синтетический отказ справочника'));
      groups.reject(new Error('Синтетический отказ справочника'));
    },
    resetOptions() {
      users = Promise.withResolvers();
      groups = Promise.withResolvers();
    },
    resolveOptions() {
      users.resolve({ users: [{
        id: 17,
        name: 'Исполнитель'
      }] });
      groups.resolve({ groups: [{
        id: 7,
        name: 'Проект'
      }] });
    },
  };
}
