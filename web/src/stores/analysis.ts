// Кеш триажа задач: оценки сложности/риска для бейджей доски и статусы очереди.
// Стор хранит только состояние: запросы, поллинг и разбор отказов живут в операциях
// раздела (web/src/actions/analysis/), а сюда приходит уже проверенный контрактом снимок.
import { defineStore } from 'pinia';

import type { AnalysisRow } from '../../../shared/analysisContracts.ts';
import { usePluginsStore } from './plugins.js';

export interface AnalysisStoreState {
  byTask: Record<string, AnalysisRow>;
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
    active: (state) => Object.values(state.byTask)
      .some((row) => ACTIVE_STATES.includes(String(row.status?.state))),
    /**
     * Требуют внимания человека: прерваны рестартом сервера или упали. Авто-перезапуска
     * нет намеренно — решение перезапускать принимает человек.
     */
    issues(state): AnalysisRow[] {
      if (this.disabled) {
        return [];
      }

      return Object.values(state.byTask)
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

      for (const row of rows) {
        map[String(row.task)] = row;
      }

      this.byTask = map;
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
    markQueued(id: string | number) {
      const key = String(id);
      const current = this.byTask[key] || {
        task: Number(id),
        analysis: null,
        status: null,
      };

      this.byTask = {
        ...this.byTask,
        [key]: {
          ...current,
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

    /** Скрыть статус, оставив саму оценку: человек решил не перезапускать разбор. */
    dropStatus(id: string | number) {
      const key = String(id);
      const { [key]: row, ...rest } = this.byTask;

      this.byTask = row?.analysis
        ? {
          ...rest,
          [key]: {
            task: row.task,
            analysis: row.analysis,
            status: null,
          },
        }
        : rest;
    },
  },
});
