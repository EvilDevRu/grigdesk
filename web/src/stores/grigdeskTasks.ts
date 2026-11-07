import { grigdeskPersonalStateVersion } from '../shared/grigdeskPersonalState.ts';
import { useTaskSeenStore } from './taskSeen.ts';
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
    loaded: false,
    personalStateVersion: null as 1 | null,
    baselineIds: null as string[] | null,
    epoch: 0,
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
      this.loaded = true;
      this.personalStateVersion = snapshot.personalStateVersion ?? null;
      grigdeskPersonalStateVersion.value = this.personalStateVersion;

      if (this.baselineIds === null) {
        this.baselineIds = snapshot.tasks.map((task) => task.id);
      }

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

      const epoch = this.epoch;
      const state: PendingRead = { promise: Promise.resolve(), queued: false };

      this.loading = true;
      state.promise = (async () => {
        do {
          state.queued = false;

          try {
            const snapshot = decodeGrigdeskTasksSnapshot(await api.get('/api/grigdesk-tasks'));

            if (epoch !== this.epoch) {
              return;
            }

            this.applySnapshot(snapshot);
            void this.markBaselineSeen();
            this.error = '';
          } catch (error) {
            if (epoch === this.epoch) {
              this.error = failureText(error);
            }
          }
        } while (state.queued);
      })().finally(() => {
        if (pendingReads.get(this) === state) {
          pendingReads.delete(this);
          this.loading = false;
        }
      });
      pendingReads.set(this, state);

      return state.promise;
    },

    /**
     * Первый успешный снимок заморожен до создания и повторяется неизменным после отказа.
     * Части baseline сервер собирает атомарно; готовность публикуется только последней частью.
     */
    async markBaselineSeen(): Promise<boolean> {
      if (!this.loaded || this.personalStateVersion !== 1 || this.baselineIds === null) {
        return false;
      }

      const epoch = this.epoch;
      const seen = useTaskSeenStore().own;

      await seen.load();

      if (epoch !== this.epoch || !seen.loaded || seen.initialized) {
        return seen.ready;
      }

      const ids = [...this.baselineIds];
      const baselineId = crypto.randomUUID();

      for (let offset = 0; offset < Math.max(1, ids.length); offset += 1000) {
        const complete = offset + 1000 >= ids.length;
        const ok = await seen.markSeen(ids.slice(offset, offset + 1000), {
          baseline: complete,
          baselineId,
        });

        if (!ok || epoch !== this.epoch) {
          return false;
        }
      }

      return seen.ready;
    },

    /**
     * Смена установки удаляет собственный список и замороженную базовую линию.
     * Растущая эпоха запрещает применение ответов прежней авторизации.
     */
    clear() {
      this.epoch += 1;
      pendingReads.delete(this);
      this.tasks = [];
      this.projects = [];
      this.revision = -1;
      this.trackerConfigured = null;
      this.personalStateVersion = null;
      grigdeskPersonalStateVersion.value = null;
      this.baselineIds = null;
      this.loaded = false;
      this.loading = false;
      this.error = '';
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
      if (!this.loaded) {
        await this.load();
      }

      if (!this.loaded) {
        throw new Error(this.error);
      }

      const epoch = this.epoch;
      const result = decodeGrigdeskTaskCreated(await api.post('/api/grigdesk-tasks?sources=1', input));

      if (epoch !== this.epoch) {
        throw new DOMException('', 'AbortError');
      }

      void this.markBaselineSeen();

      if (result.revision >= this.revision) {
        this.tasks = [result.task, ...this.tasks.filter((task) => task.id !== result.task.id)];
        this.revision = result.revision;
      }

      return result.task;
    },
  },
});
