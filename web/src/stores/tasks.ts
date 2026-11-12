import type { TrackerTarget } from '../shared/trackerTarget.ts';
import { resolveTrackerTarget } from '../shared/trackerTarget.ts';
import { taskReferenceKey } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
// Кеш деталей B24 и действия через GrigDesk без открытия стороннего портала.
// Подтверждённые мутации обновляют доску прежним порядком.
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { useBoardStore } from './board.ts';
import { useTrackersStore } from './trackers.ts';
import {
  decodeTaskDetail, decodeTaskLaunchOptions, decodeTaskLaunchResult,
} from '../shared/boardContracts.ts';
import type { TaskDetail } from '../shared/boardContracts.ts';
import { decodeStageRunnerOptions } from '../../../shared/pipeline/stageRunnerSettings.ts';
import type { StageRunnerApply, StageRunnerIdentity } from '../../../shared/pipeline/stageRunnerSettings.ts';

const t = localeTranslator(uiLocalePort);

type TaskId = string | number;

interface CachedTask {
  data: TaskDetail;
  loadedAt: number;
  target?: TrackerTarget;
}

export const useTasksStore = defineStore('tasks', {
  state: () => ({
    details: {} as Record<string, CachedTask>,
    epoch: 0,
  }),

  actions: {
    invalidate() {
      this.epoch += 1;
      this.details = {};
    },
    /**
     * Детали используют прежний кеш на тридцать секунд с принудительным обновлением.
     * Все номера читаются через внешний трекер; ответ проверяется до замены кеша.
     */
    async load(id: TaskId, force = false, signal?: AbortSignal, source?: TaskSourceId): Promise<TaskDetail> {
      const epoch = this.epoch;
      const key = source ? taskReferenceKey({ id, source }) : String(id);
      const cached = this.details[key];

      const board = useBoardStore();
      const catalog = useTrackersStore().catalog;
      const legacySource = source && board.data?.source === source
        && !board.data?.multiSource && !catalog?.enabledIds;

      if (cached?.target?.prefix === '/api/tracker' && source
        && !catalog?.enabledIds && board.data?.source !== source) {
        throw new Error(t('core.taskSourceMismatch'));
      }

      const target = (!source || legacySource) ? {
        prefix: '/api/tracker',
        source,
        options: useTrackersStore().mutationOptions(),
      } : await resolveTrackerTarget(source, api, catalog ?? undefined);

      if (cached && !force && Date.now() - cached.loadedAt < 30000) {
        return cached.data;
      }

      const data = decodeTaskDetail(await api.get(`${target.prefix}/task/${id}`, {
        signal, ...target.options,
      }));

      signal?.throwIfAborted();

      if (epoch !== this.epoch) {
        throw new DOMException('', 'AbortError');
      }

      this.details[key] = {
        data,
        loadedAt: Date.now(),
        ...(target ? { target } : {}),
      };

      return data;
    },

    title(id: TaskId, source?: TaskSourceId) {
      return this.details[source ? taskReferenceKey({ id, source }) : id]?.data?.title || null;
    },

    /**
     * Поля задачи сохраняются сервером, затем проверенная карточка заменяет кеш.
     * Доска перечитывается только после подтверждённого ответа обновления.
     */
    async target(id: TaskId, source?: TaskSourceId): Promise<TrackerTarget> {
      const cached = source ? this.details[taskReferenceKey({ id, source })] : undefined;

      if (cached?.target && source) {
        const driver = useTrackersStore().catalog?.drivers.find((entry) => entry.id === source.split('@')[0]);
        const generation = cached.target.options.headers?.['x-grigdesk-tracker-generation'];

        if (driver?.generation !== undefined && String(driver.generation) !== generation) {
          throw new Error(t('core.boardSourceChanged'));
        }

        return cached.target;
      }

      if (!source) {
        return { prefix: '/api/tracker', options: useTrackersStore().mutationOptions() };
      }

      return resolveTrackerTarget(source, api);
    },

    /**
     * Поля записываются в захваченное подключение карточки.
     * Ответ заменяет кеш той же пары до обновления общей ленты.
     */
    async update(id: TaskId, fields: Record<string, unknown>, source?: TaskSourceId): Promise<TaskDetail> {
      const target = await this.target(id, source);
      const key = source ? taskReferenceKey({ id, source }) : String(id);
      const data = decodeTaskDetail(await api.put(
        `${target.prefix}/task/${id}`, fields, target.options,
      ));

      this.details[key] = {
        data,
        loadedAt: Date.now(),
        ...(target ? { target } : {}),
      };
      await useBoardStore().load(true);

      return data;
    },

    /**
     * Подтверждённая пауза адресована источнику и не считается случайным пропуском CRM.
     * Ошибка POST и поздний ответ прежнего владельца не меняют состояние удержания.
     */
    async timer(id: TaskId, action: string, source?: TaskSourceId) {
      const target = await this.target(id, source);
      const board = useBoardStore();
      const epoch = board.sourceEpoch;
      const timerSource = source ?? board.data?.source;

      await api.post(
        `${target.prefix}/task/${id}/timer/${action}`, undefined, target.options,
      );
      board.confirmTimerAction(id, action, timerSource, epoch);
      await board.load(true);
    },

    /**
     * После подтверждения завершения старая карточка перестаёт считаться свежей.
     * Заголовок остаётся доступным конвейеру до следующего чтения деталей.
     */
    async complete(id: TaskId, source?: TaskSourceId) {
      const target = await this.target(id, source);
      const key = source ? taskReferenceKey({ id, source }) : String(id);

      await api.post(`${target.prefix}/task/${id}/complete`, undefined, target.options);

      if (this.details[key]) {
        this.details[key].loadedAt = 0;
      }

      await useBoardStore().load(true);
    },

    /**
     * Удалённая задача сразу исключается из кеша, затем доска перечитывается.
     * Заголовок поколения защищает удаление при смене подключения трекера.
     */
    async deleteTask(id: TaskId, source?: TaskSourceId) {
      const target = await this.target(id, source);
      const key = source ? taskReferenceKey({ id, source }) : String(id);

      await api.del(`${target.prefix}/task/${id}`, undefined, target.options);

      delete this.details[key];
      await useBoardStore().load(true);
    },

    /**
     * Ответ возобновления не содержит новый статус задачи.
     * Прежний снимок помечается устаревшим перед обновлением доски.
     */
    async renew(id: TaskId, source?: TaskSourceId) {
      const target = await this.target(id, source);
      const key = source ? taskReferenceKey({ id, source }) : String(id);

      await api.post(`${target.prefix}/task/${id}/renew`, undefined, target.options);

      if (this.details[key]) {
        this.details[key].loadedAt = 0;
      }

      await useBoardStore().load(true);
    },

    /**
     * Фиксирует поколение перед записью и не начинает чтение другого трекера после её ответа.
     * Общая граница используется новыми мутациями карточки без оптимистичной замены кеша.
     */
    async mutateCard(
      id: TaskId, path: string, method: 'post' | 'put' | 'del',
      payload?: unknown, source?: TaskSourceId,
    ) {
      const epoch = this.epoch;
      const target = await this.target(id, source);

      if (epoch !== this.epoch) {
        throw new DOMException('', 'AbortError');
      }

      await api[method](`${target.prefix}/task/${id}/${path}`, payload, target.options);

      if (epoch !== this.epoch) {
        throw new DOMException('', 'AbortError');
      }
    },

    /**
     * Чек-лист перечитывается только после подтверждённого добавления пункта.
     * Ответ мутации не подмешивается в кеш деталей и не предсказывает структуру дерева.
     */
    async addChecklistItem(id: TaskId, input: { title: string; parentId?: string }, source?: TaskSourceId) {
      await this.mutateCard(id, 'checklist', 'post', input, source);

      return this.load(id, true, undefined, source);
    },

    /**
     * Переименование и отметка передаются как частичное изменение пункта.
     * После успеха авторитетной остаётся полная карточка драйвера.
     */
    async updateChecklistItem(id: TaskId, itemId: string, input: { title?: string; complete?: boolean },
      source?: TaskSourceId) {
      await this.mutateCard(id, `checklist/${itemId}`, 'put', input, source);

      return this.load(id, true, undefined, source);
    },

    /**
     * Удаление не вырезает пункт из локального дерева до ответа сервера.
     * Повторное чтение учитывает портальное поведение вложенных пунктов.
     */
    async deleteChecklistItem(id: TaskId, itemId: string, source?: TaskSourceId) {
      await this.mutateCard(id, `checklist/${itemId}`, 'del', undefined, source);

      return this.load(id, true, undefined, source);
    },

    /**
     * Теги заменяются полным списком, затем читаются из прежнего page-ответа.
     * Пустой список значим: особую REST-сериализацию выполняет внешний пакет.
     */
    async updateTaskTags(id: TaskId, tags: string[], source?: TaskSourceId) {
      const target = await this.target(id, source);

      await this.mutateCard(id, 'tags', 'put', { tags }, source);

      return api.get(`${target.prefix}/task/${id}/comments`);
    },

    /**
     * Приёмка и возврат обновляют детали и доску после подтверждённой мутации.
     * Новый статус берётся чтением, чтобы кеш не зависел от формата ответа операции.
     */
    async reviewTask(id: TaskId, action: 'approve' | 'disapprove', source?: TaskSourceId) {
      await this.mutateCard(id, action, 'post', undefined, source);

      const data = await this.load(id, true, undefined, source);

      await useBoardStore().load(true);

      return data;
    },

    async approveTask(id: TaskId, source?: TaskSourceId) {
      return this.reviewTask(id, 'approve', source);
    },

    async disapproveTask(id: TaskId, source?: TaskSourceId) {
      return this.reviewTask(id, 'disapprove', source);
    },

    async comment(id: TaskId, text: string, source?: TaskSourceId) {
      const target = await this.target(id, source);

      await api.post(`${target.prefix}/task/${id}/comment`, { text }, target.options);
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

    /**
     * Ленивый каталог принадлежит exact узлу, а не общей телеметрии графа.
     * Параметры передаются без изменения идентификаторов и без собственного SSE.
     */
    async getStageRunnerOptions(
      task: TaskId, fields: Omit<StageRunnerIdentity, 'task'> & { provider?: string },
    ) {
      const { provider, ...identity } = fields;
      const query = new URLSearchParams(identity);

      if (provider !== undefined) {
        query.set('provider', provider);
      }

      return decodeStageRunnerOptions(await api.get(`/api/tasks/${task}/runner/options?${query}`));
    },

    /**
     * Выбор человека сохраняется одной согласованной мутацией всей связки.
     * Receipt подтверждает отдельно сохранение и результат возможного перезапуска.
     */
    async applyStageRunnerSettings(task: TaskId, payload: StageRunnerApply) {
      return decodeStageRunnerOptions(await api.post(`/api/tasks/${task}/runner/settings`, payload));
    },

    async resume(id: TaskId) {
      return api.post(`/api/tasks/${id}/resume`);
    },
  },
});
