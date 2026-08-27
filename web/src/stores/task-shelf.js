// Серверная account-scoped полка. Durable entries меняются только подтверждёнными
// PUT/DELETE, а rows — локальная проекция существующих board/analysis/pipeline stores.
import { markRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import { api } from '../shared/api-client.js';
import { notify } from '../shared/notify.js';
import taskShelfDecision from '../shared/task-shelf.js';
import { sseSubscribe } from '../composables/useSse.js';
import { useAnalysisStore } from './analysis.js';
import { useNotifyWatchStore } from './notify-watch.js';
import { useBoardStore } from './board.js';
import { usePluginsStore } from './plugins.js';

const controllers = new WeakMap();
const BOARD_LISTS = ['tasks', 'toReview', 'created', 'accomplice', 'auditor'];
const ANALYSIS_LABELS = {
  queued: 'В очереди',
  running: 'Идёт',
  done: 'Готова',
  finished: 'Готова',
  failed: 'Завершилась с ошибкой',
  interrupted: 'Прервана',
};
const ANALYSIS_TONES = {
  queued: 'neutral',
  running: 'accent',
  done: 'good',
  finished: 'good',
  failed: 'bad',
  interrupted: 'warn',
};
const B24_TONES = {
  todo: 'warn',
  running: 'good',
  in_progress: 'accent',
  await_acceptance: 'accent',
  my_review: 'warn',
  done: 'good',
  completed: 'good',
  declined: 'bad',
};
const TASK_DETAIL_REFRESH_MS = 60_000;
const TASK_DETAIL_RETRY_MS = 60_000;

function taskKey(value) {
  return String(value ?? '').trim();
}

function emptySnapshot() {
  return { analysis: null, pipeline: null, b24: null };
}

function normalizedSnapshot(value) {
  const scope = String(value?.scope || '');
  const revision = Number(value?.revision);
  if (!scope || !Number.isSafeInteger(revision) || revision < 0 || !Array.isArray(value?.entries)) {
    throw new Error('Сервер вернул некорректную полку');
  }

  const entries = value.entries.map((entry) => {
    const taskId = taskKey(entry?.taskId);
    if (!taskId || typeof entry?.title !== 'string' || !entry.title
      || typeof entry?.addedAt !== 'string' || typeof entry?.reason !== 'string') {
      throw new Error('Сервер вернул некорректную запись полки');
    }
    return {
      taskId,
      title: entry.title,
      addedAt: entry.addedAt,
      reason: entry.reason,
      snapshot: structuredClone(entry.snapshot || emptySnapshot()),
    };
  });
  return { scope, revision, entries };
}

function ensureController(store) {
  let controller = controllers.get(store);
  if (controller) return controller;
  controller = {
    analysis: useAnalysisStore(),
    pipeline: useNotifyWatchStore(),
    board: useBoardStore(),
    plugins: usePluginsStore(),
    detailScope: '',
    detailByTask: new Map(),
    detailLoads: new Map(),
    detailFailures: new Map(),
    started: false,
    enabled: false,
    stops: [],
  };
  controllers.set(store, controller);
  return controller;
}

function resetTaskDetails(controller, scope = '') {
  controller.detailScope = scope;
  controller.detailByTask.clear();
  controller.detailLoads.clear();
  controller.detailFailures.clear();
}

function pruneTaskDetails(controller, entries) {
  const active = new Set(entries.map((entry) => entry.taskId));
  for (const taskId of controller.detailByTask.keys()) {
    if (!active.has(taskId)) controller.detailByTask.delete(taskId);
  }
  for (const taskId of controller.detailFailures.keys()) {
    if (!active.has(taskId)) controller.detailFailures.delete(taskId);
  }
}

function cachedTaskDetail(controller, taskId) {
  return controller.detailByTask.get(taskId)?.data || null;
}

function detailProject(detail) {
  const name = typeof detail?.group_name === 'string' ? detail.group_name.trim() : '';
  if (name) return name;
  const id = Number(detail?.group_id);
  return Number.isSafeInteger(id) && id > 0 ? `Проект #${id}` : '';
}

async function hydrateTaskDetail(store, controller, taskId) {
  const now = Date.now();
  const cached = controller.detailByTask.get(taskId);
  const failedAt = controller.detailFailures.get(taskId) || 0;
  if (cached && now - cached.loadedAt < TASK_DETAIL_REFRESH_MS) return;
  if (controller.detailLoads.has(taskId) || now - failedAt < TASK_DETAIL_RETRY_MS) return;

  const scope = store.scope;
  const epoch = store._epoch;
  const request = api.get(`/api/b24/task/${encodeURIComponent(taskId)}`);
  controller.detailLoads.set(taskId, request);
  try {
    const detail = await request;
    const entryExists = store.entries.some((entry) => entry.taskId === taskId);
    if (store._epoch !== epoch || store.scope !== scope || !entryExists) return;
    controller.detailByTask.set(taskId, { data: detail || {}, loadedAt: Date.now() });
    controller.detailFailures.delete(taskId);
    store.reconcile({ silent: true });
  } catch {
    if (store._epoch === epoch && store.scope === scope) {
      controller.detailFailures.set(taskId, Date.now());
    }
  } finally {
    if (controller.detailLoads.get(taskId) === request) controller.detailLoads.delete(taskId);
  }
}

function hydrateMissingTaskDetails(store, controller) {
  if (!enabled(controller) || !store.scope || controller.board.loadedAt <= 0
    || controller.board.error || !controller.board.data) return;
  for (const entry of store.entries) {
    if (!boardTask(controller, entry.taskId)?.group) {
      void hydrateTaskDetail(store, controller, entry.taskId);
    }
  }
}

function enabled(controller) {
  return controller.plugins.enabled?.('shelf') === true;
}

function setting(controller, key, fallback = true) {
  return controller.plugins.byId?.('shelf')?.values?.[key] ?? fallback;
}

function boardTask(controller, taskId) {
  for (const name of BOARD_LISTS) {
    const task = (controller.board.data?.[name] || [])
      .find((item) => taskKey(item.id) === taskId);
    if (task) return task;
  }
  return null;
}

function observedTask(controller, taskId) {
  let analysis = null;
  if (controller.analysis.loadedAt > 0 && !controller.analysis.error) {
    const row = controller.analysis.byTask?.[taskId];
    if (row?.status?.state) {
      analysis = {
        state: row.status.state,
        queuedAt: row.status.queuedAt || null,
        startedAt: row.status.startedAt || null,
        finishedAt: row.status.finishedAt || null,
        generatedAt: row.analysis?.generated_at || row.analysis?.generatedAt || null,
      };
    }
  }

  const pipeline = controller.pipeline.loadedAt > 0 && !controller.pipeline.error
    ? controller.pipeline.observedByTask?.[taskId] || null
    : null;

  let b24 = null;
  if (controller.board.loadedAt > 0 && !controller.board.error && controller.board.data) {
    const task = boardTask(controller, taskId);
    b24 = task
      ? {
        present: true,
        status: task.status || null,
        statusKind: task.statusKind || null,
        unread: Number(task.unread) || 0,
      }
      : { present: false, status: null, statusKind: null, unread: 0 };
  }

  return { analysis, pipeline, b24 };
}

function availableSources(observed) {
  const sources = ['analysis', 'pipeline'].filter((source) => observed[source] !== null);
  if (observed.b24 !== null) sources.push('b24', 'comments');
  return sources;
}

function scale(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : null;
}

/**
 * Сворачивает живой триаж в одну строку карточки. Оценки сложности и риска
 * показываются только при валидной шкале, чтобы повреждённый ответ не выглядел фактом.
 */
function analysisActivity(controller, entry, snapshot) {
  const row = controller.analysis.byTask?.[entry.taskId] || null;
  const analysis = row?.analysis || null;
  const state = row?.status?.state || snapshot?.state || (analysis ? 'done' : null);
  if (!state && entry.reason !== 'analysis') return null;

  const parts = [ANALYSIS_LABELS[state] || 'Состояние неизвестно'];
  const complexity = scale(analysis?.complexity);
  const risk = scale(analysis?.risk);
  if (complexity) parts.push(`сложность ${complexity}/5`);
  if (risk) parts.push(`риск ${risk}/5`);
  if (typeof analysis?.diff_size === 'string' && analysis.diff_size) {
    parts.push(`дифф ${analysis.diff_size}`);
  }
  const needsClarification = analysis?.needs_clarification === true
    || analysis?.confidence === 'low';
  if (needsClarification) parts.push('нужно уточнение');

  const terminalTone = ['failed', 'interrupted'].includes(state) ? ANALYSIS_TONES[state] : null;
  return {
    kind: 'analysis',
    label: 'Оценка',
    value: parts.join(' · '),
    tone: terminalTone || (needsClarification ? 'warn' : ANALYSIS_TONES[state] || 'neutral'),
  };
}

/**
 * Называет фактическое место прогона по уже прочитанному вотчером графу. При
 * недоступном графе остаётся последний durable снимок, но без выдуманного прогресса.
 */
function pipelineActivity(entry, current, snapshot) {
  const pipeline = current || snapshot;
  if (!pipeline && entry.reason !== 'pipeline') return null;
  if (!pipeline) {
    return {
      kind: 'pipeline',
      label: 'Конвейер',
      value: 'Данные ещё не получены',
      tone: 'neutral',
    };
  }
  if (!current && snapshot && !snapshot.result) {
    return {
      kind: 'pipeline',
      label: 'Конвейер',
      value: 'Последний прогон сейчас не виден',
      tone: 'neutral',
    };
  }

  let value = 'Состояние неизвестно';
  let tone = 'neutral';
  if (pipeline.gate) {
    value = `Нужно решение · ${pipeline.gate}`;
    tone = 'warn';
  } else if (pipeline.stall) {
    value = `Остановлен · ${pipeline.stall}`;
    tone = 'bad';
  } else if (pipeline.result) {
    value = pipeline.result === 'completed' ? 'Завершён' : `Завершён · ${pipeline.result}`;
    tone = pipeline.result === 'completed' ? 'good' : 'warn';
  } else if (pipeline.daemon === 'running') {
    const progress = pipeline.progress;
    const count = Number.isSafeInteger(progress?.done)
      && Number.isSafeInteger(progress?.total) && progress.total > 0
      ? `${progress.done}/${progress.total}`
      : 'Идёт';
    value = pipeline.stage?.label ? `${count} · ${pipeline.stage.label}` : count;
    tone = pipeline.stage?.state === 'wait' || pipeline.stage?.state === 'premature'
      ? 'warn'
      : 'accent';
  } else if (pipeline.attempt) {
    value = 'Прогон остановлен';
  }

  return { kind: 'pipeline', label: 'Конвейер', value, tone };
}

/**
 * Добавляет статус портальной задачи и полезные метаданные из текущей доски.
 * Сохранённый снимок используется только как fallback, если задача ушла из списка.
 */
function b24Activity(task, snapshot) {
  if (task) {
    return {
      kind: 'b24',
      label: 'Битрикс24',
      value: task.statusText || task.statusLabel || 'На доске',
      tone: B24_TONES[task.statusKind] || 'neutral',
    };
  }
  if (!snapshot) return null;

  return {
    kind: 'b24',
    label: 'Битрикс24',
    value: snapshot.present ? 'Последний статус сохранён' : 'Не видна на текущей доске',
    tone: B24_TONES[snapshot.statusKind] || 'neutral',
  };
}

/**
 * Собирает только отображаемую проекцию карточки. Она не попадает в durable snapshot
 * и поэтому может безопасно содержать живые поля доски и подробный прогресс графа.
 */
function presentation(controller, entry, observed, snapshot, task) {
  const detail = cachedTaskDetail(controller, entry.taskId);
  const activities = [
    b24Activity(task, snapshot.b24),
    analysisActivity(controller, entry, snapshot.analysis),
    pipelineActivity(entry, observed.pipeline, snapshot.pipeline),
  ].filter(Boolean);

  return {
    title: task?.title || detail?.title || entry.title,
    project: task?.group || detailProject(detail),
    responsible: task?.responsible || '',
    deadline: task?.deadline || '',
    overdue: task?.overdue === true,
    unread: Number.isSafeInteger(Number(task?.unread)) && Number(task.unread) > 0
      ? Number(task.unread)
      : 0,
    activities,
  };
}

function sourceIssues(controller) {
  const issues = [];
  if (controller.board.error) issues.push('Статусы Битрикс24 могут быть устаревшими');
  if (controller.analysis.error) issues.push('Состояние оценки может быть устаревшим');
  if (controller.pipeline.error) issues.push('Состояние конвейера может быть устаревшим');
  return issues;
}

export const useTaskShelfStore = defineStore('taskShelf', {
  state: () => ({
    scope: '',
    revision: -1,
    entries: [],
    rows: [],
    loaded: false,
    loading: false,
    error: null,
    sourceIssues: [],
    pending: {},
    _runtime: {},
    _epoch: 0,
    _requestSeq: 0,
    _scopeRequestSeq: 0,
    _reloadQueued: false,
    _reloadSilent: false,
  }),
  getters: {
    totalCount: (state) => state.rows.length,
    litCount: (state) => state.rows.filter((row) => row.state === 'lit').length,
    isOnShelf: (state) => (id) => state.entries.some((entry) => entry.taskId === taskKey(id)),
    isPending: (state) => (id) => !!state.pending[taskKey(id)],
  },
  actions: {
    applySnapshot(value, requestSeq = null, { silent = false } = {}) {
      const snapshot = normalizedSnapshot(value);
      const seq = requestSeq ?? ++this._requestSeq;
      if (snapshot.scope !== this.scope && seq < this._scopeRequestSeq) return false;
      if (snapshot.scope === this.scope && snapshot.revision < this.revision) return false;

      const controller = ensureController(this);
      if (controller.detailScope !== snapshot.scope) resetTaskDetails(controller, snapshot.scope);
      this.scope = snapshot.scope;
      this.revision = snapshot.revision;
      this.entries = markRaw(snapshot.entries);
      pruneTaskDetails(controller, snapshot.entries);
      this.loaded = true;
      this._scopeRequestSeq = Math.max(this._scopeRequestSeq, seq);
      this.reconcile({ silent });
      hydrateMissingTaskDetails(this, controller);
      return true;
    },

    async load(force = false, { silent = false } = {}) {
      const controller = ensureController(this);
      if (!enabled(controller)) return false;
      if (this.loading) {
        if (force) {
          this._reloadQueued = true;
          this._reloadSilent = this._reloadSilent || silent;
        }
        return false;
      }
      if (this.loaded && !force) return true;

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;
      this.loading = true;
      this.error = null;
      try {
        const snapshot = await api.get('/api/b24/task-shelf');
        if (epoch !== this._epoch) return false;
        this.applySnapshot(snapshot, requestSeq, { silent });
        return true;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Полка недоступна';
        return false;
      } finally {
        if (epoch === this._epoch) {
          this.loading = false;
          if (this._reloadQueued) {
            const trailingSilent = this._reloadSilent;
            this._reloadQueued = false;
            this._reloadSilent = false;
            void this.load(true, { silent: trailingSilent });
          }
        }
      }
    },

    /**
     * Пересобирает rows из трёх уже загруженных источников. Runtime latch отделён
     * от durable entries: событие не пишет на сервер и не может удалить запись.
     */
    reconcile({ silent = false } = {}) {
      const controller = ensureController(this);
      if (!enabled(controller)) {
        this.rows = [];
        this.sourceIssues = [];
        this._runtime = {};
        return;
      }

      this.sourceIssues = sourceIssues(controller);
      const nextRuntime = {};
      const rows = [];
      for (const entry of this.entries) {
        const observed = observedTask(controller, entry.taskId);
        const entryVersion = JSON.stringify([
          this.scope,
          entry.addedAt,
          entry.reason,
          entry.snapshot,
        ]);
        const savedRuntime = this._runtime[entry.taskId] || null;
        const previous = savedRuntime?.entryVersion === entryVersion ? savedRuntime : null;
        const decision = taskShelfDecision({
          snapshot: previous?.snapshot || entry.snapshot,
          observed,
          reason: entry.reason,
          latched: previous,
        });
        const primed = new Set(previous?.primed || []);
        const sourceWasPrimed = decision.source ? primed.has(decision.source) : false;
        for (const source of availableSources(observed)) primed.add(source);

        if (!silent && previous?.state === 'neutral' && decision.state === 'lit'
          && sourceWasPrimed && setting(controller, 'browserNotifications', true)) {
          void notify(
            `Полка — задача #${entry.taskId}`,
            decision.message,
            `task-shelf-${entry.taskId}-${decision.fingerprint}`,
          );
        }
        nextRuntime[entry.taskId] = {
          state: decision.state,
          source: decision.source,
          message: decision.message,
          fingerprint: decision.fingerprint,
          snapshot: decision.snapshot,
          entryVersion,
          primed: [...primed],
        };
        const task = boardTask(controller, entry.taskId);
        const details = presentation(controller, entry, observed, decision.snapshot, task);
        rows.push({ ...entry, ...decision, title: details.title, details });
      }
      this._runtime = nextRuntime;
      this.rows = rows;
    },

    async _put(id, { reason, createIfMissing, resetRuntime = false }) {
      const controller = ensureController(this);
      const key = taskKey(id);
      if (!key || !enabled(controller) || this.pending[key]) return false;
      const existing = this.entries.find((entry) => entry.taskId === key) || null;
      const observed = observedTask(controller, key);
      const snapshot = taskShelfDecision({
        snapshot: existing?.snapshot || emptySnapshot(),
        observed,
        reason,
      }).snapshot;
      const task = boardTask(controller, key);
      const title = existing?.title || task?.title || `Задача #${key}`;
      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;
      this.pending = { ...this.pending, [key]: true };
      this.error = null;
      try {
        const response = await api.put(`/api/b24/task-shelf/${encodeURIComponent(key)}`, {
          title,
          reason,
          snapshot,
          createIfMissing,
        });
        if (epoch !== this._epoch) return false;
        if (resetRuntime) {
          const { [key]: _, ...runtime } = this._runtime;
          this._runtime = runtime;
        }
        this.applySnapshot(response, requestSeq);
        return true;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Не удалось изменить полку';
        return false;
      } finally {
        if (epoch === this._epoch) {
          const { [key]: _, ...rest } = this.pending;
          this.pending = rest;
        }
      }
    },

    async remove(id) {
      const controller = ensureController(this);
      const key = taskKey(id);
      if (!key || !enabled(controller) || this.pending[key]) return false;
      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;
      this.pending = { ...this.pending, [key]: true };
      this.error = null;
      try {
        const response = await api.del(`/api/b24/task-shelf/${encodeURIComponent(key)}`);
        if (epoch !== this._epoch) return false;
        this.applySnapshot(response, requestSeq);
        return true;
      } catch (error) {
        if (epoch === this._epoch) this.error = error?.message || 'Не удалось убрать задачу';
        return false;
      } finally {
        if (epoch === this._epoch) {
          const { [key]: _, ...rest } = this.pending;
          this.pending = rest;
        }
      }
    },

    toggle(id) {
      return this.isOnShelf(id)
        ? this.remove(id)
        : this._put(id, { reason: 'manual', createIfMissing: true });
    },

    autoAdd(id) {
      const controller = ensureController(this);
      if (!enabled(controller) || !setting(controller, 'autoAddOnAnalysis', true)) return false;
      return this._put(id, { reason: 'analysis', createIfMissing: true });
    },

    acknowledge(id) {
      if (!this.isOnShelf(id)) return false;
      return this._put(id, { reason: this.entries.find((entry) => (
        entry.taskId === taskKey(id)
      ))?.reason || 'manual', createIfMissing: false, resetRuntime: true });
    },

    start() {
      const controller = ensureController(this);
      if (controller.started) return;
      controller.started = true;
      controller.stops.push(sseSubscribe((name) => {
        if (name === 'task-shelf-changed' && enabled(controller)) void this.load(true);
      }));
      controller.stops.push(watch(
        () => [controller.plugins.loaded, enabled(controller)],
        ([, isEnabled]) => {
          if (!isEnabled) {
            controller.enabled = false;
            this.rows = [];
            this.sourceIssues = [];
            this._runtime = {};
            resetTaskDetails(controller);
            return;
          }
          if (!controller.enabled) {
            controller.enabled = true;
            this._runtime = {};
            void this.load(true, { silent: true });
          } else {
            this.reconcile();
          }
        },
        { immediate: true },
      ));
      controller.stops.push(watch(
        () => [
          controller.analysis.loadedAt,
          controller.analysis.error,
          controller.analysis.byTask,
          controller.pipeline.loadedAt,
          controller.pipeline.error,
          controller.pipeline.observedByTask,
          controller.board.loadedAt,
          controller.board.error,
          controller.board.data,
        ],
        () => {
          this.reconcile();
          hydrateMissingTaskDetails(this, controller);
        },
        { deep: true },
      ));
    },

    stop() {
      const controller = controllers.get(this);
      if (!controller?.started) return;
      for (const stop of controller.stops.splice(0)) stop?.();
      controller.started = false;
      controller.enabled = false;
    },

    clear() {
      const controller = controllers.get(this);
      if (controller) resetTaskDetails(controller);
      this._epoch += 1;
      this._requestSeq += 1;
      this._scopeRequestSeq = this._requestSeq;
      this.scope = '';
      this.revision = -1;
      this.entries = [];
      this.rows = [];
      this.loaded = false;
      this.loading = false;
      this.error = null;
      this.sourceIssues = [];
      this.pending = {};
      this._runtime = {};
      this._reloadQueued = false;
      this._reloadSilent = false;
    },
  },
});
