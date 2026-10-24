import { isRecord } from '../../../shared/lib/objects.ts';
import { decodeGrigdeskTask } from '../../../shared/tasks/grigdeskTaskContracts.ts';
// Кеш деталей B24 и действия через GrigDesk без открытия стороннего портала.
// Подтверждённые мутации обновляют доску прежним порядком.
import { defineStore } from 'pinia';
import { api, ApiError } from '../shared/apiClient.ts';
import { useBoardStore } from './board.ts';
import {
  decodeTaskDetail, decodeTaskLaunchOptions, decodeTaskLaunchResult,
} from '../shared/boardContracts.ts';
import type { TaskDetail } from '../shared/boardContracts.ts';

type TaskId = string | number;

interface CachedTask {
  data: TaskDetail;
  loadedAt: number;
}

export const useTasksStore = defineStore('tasks', {
  state: () => ({ details: {} as Record<string, CachedTask> }),

  actions: {
    /**
     * Детали используют прежний кеш на тридцать секунд с принудительным обновлением.
     * Номера вне диапазона собственных задач читаются прежним запросом Б24.
     * Внутри диапазона источник подтверждает запись; ответ проверяется до замены кеша.
     */
    async load(id: TaskId, force = false): Promise<TaskDetail> {
      const cached = this.details[id];

      if (cached && !force && Date.now() - cached.loadedAt < 30000) {
        return cached.data;
      }

      let response: unknown;
      let portal = !/^[1-9]\d{11}$/u.test(String(id));

      if (!portal) {
        try {
          response = await api.get(`/api/grigdesk-tasks/${id}`);
        } catch (error) {
          if (!(error instanceof ApiError) || error.status !== 404
            || !isRecord(error.data) || error.data.error !== 'grigdesk_task_not_found') {
            throw error;
          }

          portal = true;
        }
      }

      const data = portal
        ? decodeTaskDetail(await api.get(`/api/b24/task/${id}`))
        : decodeTaskDetail(decodeGrigdeskTask(response, String(id)));

      this.details[id] = { data, loadedAt: Date.now() };

      return data;
    },

    title(id: TaskId) {
      return this.details[id]?.data?.title || null;
    },

    /**
     * Поля задачи сохраняются сервером, затем проверенная карточка заменяет кеш.
     * Доска перечитывается только после подтверждённого ответа обновления.
     */
    async update(id: TaskId, fields: Record<string, unknown>): Promise<TaskDetail> {
      const data = decodeTaskDetail(await api.put(`/api/b24/task/${id}`, fields));

      this.details[id] = { data, loadedAt: Date.now() };
      await useBoardStore().load(true);

      return data;
    },

    async timer(id: TaskId, action: string) {
      await api.post(`/api/b24/task/${id}/timer/${action}`);
      await useBoardStore().load(true);
    },

    /**
     * После подтверждения завершения старая карточка перестаёт считаться свежей.
     * Заголовок остаётся доступным конвейеру до следующего чтения деталей.
     */
    async complete(id: TaskId) {
      await api.post(`/api/b24/task/${id}/complete`);

      if (this.details[id]) {
        this.details[id].loadedAt = 0;
      }

      await useBoardStore().load(true);
    },

    /**
     * Ответ возобновления не содержит новый статус задачи.
     * Прежний снимок помечается устаревшим перед обновлением доски.
     */
    async renew(id: TaskId) {
      await api.post(`/api/b24/task/${id}/renew`);

      if (this.details[id]) {
        this.details[id].loadedAt = 0;
      }

      await useBoardStore().load(true);
    },

    async comment(id: TaskId, text: string) {
      await api.post(`/api/b24/task/${id}/comment`, { text });
    },

    async launchOptions(id: TaskId, profile = '') {
      const query = profile ? `?profile=${encodeURIComponent(profile)}` : '';

      return decodeTaskLaunchOptions(await api.get(`/api/tasks/${id}/launch-options${query}`));
    },

    async launch(id: TaskId, payload: unknown) {
      return decodeTaskLaunchResult(await api.post(`/api/tasks/${id}/launch`, payload));
    },

    async setStageRunner(id: TaskId, stage: string, primary: string) {
      return api.post(`/api/tasks/${id}/runner/override`, { stage, primary });
    },

    async resume(id: TaskId) {
      return api.post(`/api/tasks/${id}/resume`);
    },
  },
});
