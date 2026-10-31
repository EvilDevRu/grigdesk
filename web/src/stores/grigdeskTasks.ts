import { defineStore } from 'pinia';

import {
  decodeGrigdeskTaskCreated, decodeGrigdeskTaskProjects, decodeGrigdeskTasksSnapshot,
} from '../../../shared/tasks/grigdeskTaskContracts.ts';
import type {
  GrigdeskTaskProject, GrigdeskTaskSummary, GrigdeskTasksSnapshot,
} from '../../../shared/tasks/grigdeskTaskContracts.ts';
import { api, failureText } from '../shared/apiClient.ts';

interface PendingRead {
  promise: Promise<void>;
  queued: boolean;
}

const pendingReads = new WeakMap<object, PendingRead>();

export const useGrigdeskTasksStore = defineStore('grigdesk-tasks', {
  state: () => ({
    tasks: [] as GrigdeskTaskSummary[],
    projects: [] as GrigdeskTaskProject[],
    revision: -1,
    trackerConfigured: null as boolean | null,
    error: '',
    loading: false,
  }),
  actions: {
    /**
     * Старое чтение не может откатить уже подтверждённый POST или свежее событие.
     * Готовность портала относится к той же ревизии, что и собственный список.
     */
    applySnapshot(snapshot: GrigdeskTasksSnapshot) {
      if (snapshot.revision < this.revision) {
        return;
      }

      this.tasks = snapshot.tasks;
      this.revision = snapshot.revision;
      this.trackerConfigured = snapshot.trackerConfigured;
    },

    /**
     * События во время GET требуют один последовательный повтор, а не второй запрос в полёте.
     * Список и readiness заменяются только целым проверенным снимком.
     */
    load(): Promise<void> {
      const pending = pendingReads.get(this);

      if (pending) {
        pending.queued = true;

        return pending.promise;
      }

      const state: PendingRead = { promise: Promise.resolve(), queued: false };

      this.loading = true;
      state.promise = (async () => {
        do {
          state.queued = false;

          try {
            this.applySnapshot(decodeGrigdeskTasksSnapshot(await api.get('/api/grigdesk-tasks')));
            this.error = '';
          } catch (error) {
            this.error = failureText(error);
          }
        } while (state.queued);
      })().finally(() => {
        pendingReads.delete(this);
        this.loading = false;
      });
      pendingReads.set(this, state);

      return state.promise;
    },

    /**
     * Список проектов независим от готовности Б24 и включения оценки.
     * Ошибка остаётся у формы, чтобы её черновик можно было отправить повторно.
     */
    async loadProjects() {
      this.projects = decodeGrigdeskTaskProjects(await api.get('/api/grigdesk-tasks/projects'));
    },

    /**
     * POST сразу добавляет подтверждённую сервером задачу, не ожидая SSE или следующего GET.
     * Сохранение не обращается к анализатору и не добавляет личные метки портала.
     */
    async create(input: {
      title: string;
      description: string;
      projectId: string;
      clientOrigin: string;
    }) {
      const result = decodeGrigdeskTaskCreated(await api.post('/api/grigdesk-tasks', input));

      if (result.revision >= this.revision) {
        this.tasks = [result.task, ...this.tasks.filter((task) => task.id !== result.task.id)];
        this.revision = result.revision;
      }

      return result.task;
    },
  },
});
