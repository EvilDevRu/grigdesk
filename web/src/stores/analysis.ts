import { isTaskSourceId, taskReferenceKey } from '../../../shared/tasks/taskReference.ts';
// Кеш триажа задач: оценки сложности/риска для бейджей доски и статусы очереди.
// Стор хранит только состояние: запросы, поллинг и разбор отказов живут в операциях
// раздела (web/src/actions/analysis/), а сюда приходит уже проверенный контрактом снимок.
import { defineStore } from 'pinia';

import type { AnalysisRow } from '../../../shared/pipeline/analysisContracts.ts';
import { usePluginsStore } from './plugins.ts';

export interface AnalysisStoreState {
  byTask: Record<string, AnalysisRow>;
  byReference: Record<string, AnalysisRow>;
  loadedAt: number;
  error: string | null;
}

interface AnalysisPluginsSource {
  byId(id: string): { enabled?: boolean } | null | undefined;
}

const ACTIVE_STATES = ['queued', 'running'];
const ATTENTION_STATES = ['interrupted', 'failed'];

export const useAnalysisStore = defineStore('analysis', {
  state: (): AnalysisStoreState => ({
    byTask: {},
    byReference: {},
    loadedAt: 0,
    error: null,
  }),
  getters: {
    /**
     * Плагин выключен человеком. Это не отказ и не ошибка: раздел молчит, поллинг
     * не идёт, а прошлый снимок остаётся на экране до перезагрузки страницы.
     */
    disabled(): boolean {
      const plugins = usePluginsStore() as unknown as AnalysisPluginsSource;
      const manifest = plugins.byId?.('analysis');

      return manifest ? manifest.enabled === false : false;
    },
    active: (state) => Object.values({ ...state.byTask, ...state.byReference })
      .some((row) => ACTIVE_STATES.includes(String(row.status?.state))),
    /**
     * Требуют внимания человека: прерваны рестартом сервера или упали. Авто-перезапуска
     * нет намеренно — решение перезапускать принимает человек.
     */
    issues(state): AnalysisRow[] {
      if (this.disabled) {
        return [];
      }

      return Object.values({ ...state.byTask, ...state.byReference })
        .filter((row) => ATTENTION_STATES.includes(String(row.status?.state)))
        .sort((a, b) => b.task - a.task);
    },
  },
  actions: {
    /**
     * Свежая сводка целиком. Список приходит массивом, а раздел ищет по номеру задачи:
     * карта строится здесь, чтобы бейдж строки не перебирал весь ответ.
     */
    setRows(rows: AnalysisRow[]) {
      const map: Record<string, AnalysisRow> = {};
      const references: Record<string, AnalysisRow> = {};

      for (const row of rows) {
        if (row.source) {
          references[taskReferenceKey({ id: row.task, source: row.source })] = row;
        } else {
          map[String(row.task)] = row;
        }
      }

      this.byTask = map;
      this.byReference = references;
      this.loadedAt = Date.now();
      this.error = null;
    },

    setError(message: string | null) {
      this.error = message;
    },

    /**
     * Задача принята очередью. Статус показывается сразу, не дожидаясь опроса: между
     * нажатием и первым ответом сервера человек иначе видит кнопку без последствий.
     */
    markQueued(id: string | number, source?: string) {
      const map = source ? 'byReference' : 'byTask';
      const key = source ? taskReferenceKey({ id, source }) : String(id);
      const current = this[map][key] || {
        task: Number(id),
        analysis: null,
        status: null,
      };

      this[map] = {
        ...this[map],
        [key]: {
          ...current,
          ...(isTaskSourceId(source) ? { source } : {}),
          status: {
            task: Number(id),
            state: 'queued',
            queuedAt: Date.now(),
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            error: null,
            note: null,
          },
        },
      };
    },

    /**
     * Скрытие статуса сохраняет оценку той же пары источника и номера.
     * Соседняя доска с одинаковым номером не меняется.
     */
    dropStatus(id: string | number, source?: string) {
      const map = source ? 'byReference' : 'byTask';
      const key = source ? taskReferenceKey({ id, source }) : String(id);
      const { [key]: row, ...rest } = this[map];

      this[map] = row?.analysis
        ? {
          ...rest,
          [key]: {
            task: row.task,
            source: row.source,
            analysis: row.analysis,
            status: null,
          },
        }
        : rest;
    },
  },
});
