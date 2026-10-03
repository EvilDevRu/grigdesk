// Серверная account-scoped полка. Durable entries меняются только подтверждёнными
// PUT/DELETE, а rows — локальная проекция существующих board/analysis/pipeline stores.
import { markRaw, watch } from 'vue';
import { defineStore } from 'pinia';
import { api } from '../shared/apiClient.ts';
import { alertUser } from '../shared/alerts.ts';
import { shelfApi } from '../shared/shelfApi.ts';
import taskShelfDecision, { isShelfTaskCompleted } from '../shared/taskShelfDecision.ts';
import type {
  ShelfDecision,
  ShelfEventSource,
  ShelfObservedSnapshot,
} from '../shared/taskShelfDecision.ts';
import { parseShelfState } from '../../../shared/shelfContracts.ts';
import type { ShelfEntry, ShelfReason } from '../../../shared/shelfContracts.ts';
import { sseSubscribe } from '../composables/useSse.ts';
import { useAnalysisStore } from './analysis.ts';
import { useNotifyWatchStore } from './notify-watch.js';
import { useBoardStore } from './board.js';
import { usePluginsStore } from './plugins.js';

// Триаж уже на TypeScript, и полка читает его настоящий стор: собственная копия
// формы разошлась бы с ним молча. Остальные соседи ещё на JavaScript, поэтому для
// них полка объявляет ровно то, что читает, — это её контракт чтения, а не догадка
// по подсказке редактора, и расширять его без причины нельзя.
type ShelfAnalysisSource = ReturnType<typeof useAnalysisStore>;

interface ShelfLivePipeline {
  attempt?: string | null;
  daemon?: string | null;
  result?: string | null;
  stall?: string | null;
  gateKnown?: boolean;
  gate?: string | null;
  progress?: {
    done?: unknown;
    total?: unknown;
  } | null;
  stage?: {
    label?: string | null;
    state?: string | null;
  } | null;
}

interface ShelfPipelineSource {
  loadedAt: number;
  error: unknown;
  observedByTask?: Record<string, ShelfLivePipeline | undefined>;
}

interface ShelfBoardTask {
  id: unknown;
  title?: string | null;
  status?: string | null;
  statusKind?: string | null;
  statusText?: string | null;
  statusLabel?: string | null;
  unread?: unknown;
  group?: string | null;
  responsible?: string | null;
  deadline?: string | null;
  overdue?: boolean;
}

interface ShelfBoardSource {
  loadedAt: number;
  error: unknown;
  data?: Record<string, ShelfBoardTask[] | undefined> | null;
}

interface ShelfPluginsSource {
  loaded: boolean;
  enabled?(id: string): boolean;
  byId?(id: string): { values?: Record<string, unknown> } | null | undefined;
}

interface ShelfTaskDetail {
  title?: unknown;
  group_name?: unknown;
  group_id?: unknown;
}

interface ShelfController {
  analysis: ShelfAnalysisSource;
  pipeline: ShelfPipelineSource;
  board: ShelfBoardSource;
  plugins: ShelfPluginsSource;
  detailScope: string;
  detailByTask: Map<string, { data: ShelfTaskDetail; loadedAt: number }>;
  detailLoads: Map<string, Promise<unknown>>;
  detailFailures: Map<string, number>;
  started: boolean;
  enabled: boolean;
  stops: (() => void)[];
}

// Место прогона в маршруте: total === 0 значит «прогон идёт, а разбора графа ещё нет» —
// такую полосу карточка показывает неопределённой, долю по ней не считают.
export interface ShelfActivityProgress {
  done: number;
  total: number;
}

export interface ShelfActivity {
  kind: 'analysis' | 'pipeline' | 'b24';
  label: string;
  value: string;
  tone: string;
  progress?: ShelfActivityProgress | null;
}

export interface ShelfRowDetails {
  title: string;
  project: string;
  responsible: string;
  deadline: string;
  overdue: boolean;
  unread: number;
  activities: ShelfActivity[];
}

export interface ShelfRow extends Omit<ShelfEntry, 'snapshot' | 'title'>, ShelfDecision {
  title: string;
  completed: boolean;
  needsHuman: boolean;
  details: ShelfRowDetails;
}

interface ShelfRuntimeEntry {
  state: 'lit' | 'neutral';
  source: ShelfEventSource;
  message: string;
  fingerprint: string;
  snapshot: ShelfObservedSnapshot;
  entryVersion: string;
  primed: string[];
}

export interface TaskShelfState {
  scope: string;
  revision: number;
  entries: ShelfEntry[];
  rows: ShelfRow[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  sourceIssues: string[];
  pending: Record<string, boolean>;
  _runtime: Record<string, ShelfRuntimeEntry>;
  _epoch: number;
  _requestSeq: number;
  _scopeRequestSeq: number;
  _reloadQueued: boolean;
  _reloadSilent: boolean;
}

// Вспомогательным функциям нужны от собственного стора только эти поля: так они
// обходятся без ссылки на тип, который сами же и достраивают.
interface ShelfStoreAccess {
  scope: string;
  entries: ShelfEntry[];
  _epoch: number;
  reconcile(options?: { silent?: boolean }): void;
}

const controllers = new WeakMap<object, ShelfController>();
const BOARD_LISTS = ['tasks', 'toReview', 'created', 'accomplice', 'auditor'];
// Подписи терминальных состояний: идущий заход называет сама строка активности,
// потому что его имя зависит ещё и от наличия прошлой оценки.
const ANALYSIS_LABELS: Record<string, string> = {
  done: 'Готова',
  finished: 'Готова',
  failed: 'Завершилась с ошибкой',
  interrupted: 'Прервана',
};
const ANALYSIS_TONES: Record<string, string> = {
  queued: 'neutral',
  running: 'accent',
  done: 'good',
  finished: 'good',
  failed: 'bad',
  interrupted: 'warn',
};
const B24_TONES: Record<string, string> = {
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

function taskKey(value: unknown): string {
  return String(value ?? '').trim();
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function emptySnapshot(): ShelfObservedSnapshot {
  return {
    analysis: null,
    pipeline: null,
    b24: null,
  };
}

/**
 * Нереактивная обвязка полки живёт рядом со стором, а не в его состоянии: соседние
 * сторы, кэш карточек и отписки не должны попадать в реактивность и в снимок вкладки.
 */
function ensureController(store: object): ShelfController {
  let controller = controllers.get(store);

  if (controller) {
    return controller;
  }

  controller = {
    // Соседние сторы объявлены собственным контрактом чтения выше: пока они на
    // JavaScript, вывод типов из них не был бы проверенным знанием.
    analysis: useAnalysisStore(),
    pipeline: useNotifyWatchStore() as unknown as ShelfPipelineSource,
    board: useBoardStore() as unknown as ShelfBoardSource,
    plugins: usePluginsStore() as unknown as ShelfPluginsSource,
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

/**
 * Кэш карточек B24 принадлежит одной портальной области. Смена аккаунта обнуляет его
 * целиком: чужие названия и проекты не имеют права пережить смену области.
 */
function resetTaskDetails(controller: ShelfController, scope = ''): void {
  controller.detailScope = scope;
  controller.detailByTask.clear();
  controller.detailLoads.clear();
  controller.detailFailures.clear();
}

/**
 * Убирает из кэша карточки задач, которых на полке уже нет. Летящие запросы не трогает:
 * они снимут себя сами и проверят актуальность записи по возвращении.
 */
function pruneTaskDetails(controller: ShelfController, entries: ShelfEntry[]): void {
  const active = new Set(entries.map((entry) => entry.taskId));

  for (const taskId of controller.detailByTask.keys()) {
    if (!active.has(taskId)) {
      controller.detailByTask.delete(taskId);
    }
  }
  for (const taskId of controller.detailFailures.keys()) {
    if (!active.has(taskId)) {
      controller.detailFailures.delete(taskId);
    }
  }
}

function cachedTaskDetail(controller: ShelfController, taskId: string): ShelfTaskDetail | null {
  return controller.detailByTask.get(taskId)?.data || null;
}

/**
 * Название проекта задачи. Если у портала есть только идентификатор группы, показывается
 * он — это честнее, чем пустое место там, где человек ждёт принадлежность задачи.
 */
function detailProject(detail: ShelfTaskDetail | null): string {
  const name = typeof detail?.group_name === 'string' ? detail.group_name.trim() : '';

  if (name) {
    return name;
  }

  const id = Number(detail?.group_id);

  return Number.isSafeInteger(id) && id > 0 ? `Проект #${id}` : '';
}

/**
 * Догружает карточку задачи, которой нет на текущей доске. Свежий кэш и недавний отказ
 * запрос не повторяют, а ответ применяется только если область и состав полки не сменились.
 */
async function hydrateTaskDetail(
  store: ShelfStoreAccess,
  controller: ShelfController,
  taskId: string,
): Promise<void> {
  const now = Date.now();
  const cached = controller.detailByTask.get(taskId);
  const failedAt = controller.detailFailures.get(taskId) || 0;

  if (cached && now - cached.loadedAt < TASK_DETAIL_REFRESH_MS) {
    return;
  }
  if (controller.detailLoads.has(taskId) || now - failedAt < TASK_DETAIL_RETRY_MS) {
    return;
  }

  const scope = store.scope;
  const epoch = store._epoch;
  const request: Promise<unknown> = api.get(`/api/b24/task/${encodeURIComponent(taskId)}`);

  controller.detailLoads.set(taskId, request);

  try {
    const detail = await request;
    const entryExists = store.entries.some((entry) => entry.taskId === taskId);

    if (store._epoch !== epoch || store.scope !== scope || !entryExists) {
      return;
    }

    const data = detail !== null && typeof detail === 'object' ? detail as ShelfTaskDetail : {};

    controller.detailByTask.set(taskId, { data, loadedAt: Date.now() });
    controller.detailFailures.delete(taskId);
    store.reconcile({ silent: true });
  } catch {
    if (store._epoch === epoch && store.scope === scope) {
      controller.detailFailures.set(taskId, Date.now());
    }
  } finally {
    if (controller.detailLoads.get(taskId) === request) {
      controller.detailLoads.delete(taskId);
    }
  }
}

/**
 * Карточка догружается только для задач, которых нет на прочитанной доске. Пока доска
 * не загружена или отвечает ошибкой, отсутствие задачи ничего не значит.
 */
function hydrateMissingTaskDetails(store: ShelfStoreAccess, controller: ShelfController): void {
  if (!enabled(controller) || !store.scope || controller.board.loadedAt <= 0
    || controller.board.error || !controller.board.data) {
    return;
  }

  for (const entry of store.entries) {
    if (!boardTask(controller, entry.taskId)?.group) {
      void hydrateTaskDetail(store, controller, entry.taskId);
    }
  }
}

function enabled(controller: ShelfController): boolean {
  return controller.plugins.enabled?.('shelf') === true;
}

function setting(controller: ShelfController, key: string, fallback: unknown = true): unknown {
  return controller.plugins.byId?.('shelf')?.values?.[key] ?? fallback;
}

/**
 * Ищет задачу во всех списках доски: полка не знает, в какой роли человек её видит,
 * а статус и метаданные одинаково нужны из любого списка.
 */
function boardTask(controller: ShelfController, taskId: string): ShelfBoardTask | null {
  for (const name of BOARD_LISTS) {
    const task = (controller.board.data?.[name] || [])
      .find((item) => taskKey(item.id) === taskId);

    if (task) {
      return task;
    }
  }

  return null;
}

/**
 * Собирает то, что источники говорят о задаче прямо сейчас. Недоступный источник даёт
 * null, а не пустой снимок: «не знаю» и «ничего нет» решатель различает.
 */
function observedTask(controller: ShelfController, taskId: string): ShelfObservedSnapshot {
  let analysis = null;

  if (controller.analysis.loadedAt > 0 && !controller.analysis.error) {
    const row = controller.analysis.byTask?.[taskId];

    if (row?.status?.state) {
      analysis = {
        state: row.status.state,
        queuedAt: row.status.queuedAt,
        startedAt: row.status.startedAt,
        finishedAt: row.status.finishedAt,
        generatedAt: text(row.analysis?.generated_at) || null,
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
      : {
        present: false,
        status: null,
        statusKind: null,
        unread: 0,
      };
  }

  return {
    analysis,
    pipeline: pipeline as ShelfObservedSnapshot['pipeline'],
    b24,
  };
}

function availableSources(observed: ShelfObservedSnapshot): string[] {
  const sources = (['analysis', 'pipeline'] as const)
    .filter((source) => observed[source] !== null) as string[];

  if (observed.b24 !== null) {
    sources.push('b24', 'comments');
  }

  return sources;
}

function scale(value: unknown): number | null {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : null;
}

/**
 * Сворачивает живой триаж в одну строку карточки. Оценки сложности и риска
 * показываются только при валидной шкале, чтобы повреждённый ответ не выглядел фактом.
 */
function analysisActivity(
  controller: ShelfController,
  entry: ShelfEntry,
  snapshot: ShelfObservedSnapshot['analysis'],
): ShelfActivity | null {
  const row = controller.analysis.byTask?.[entry.taskId] || null;
  const analysis = row?.analysis || null;
  const state = row?.status?.state || snapshot?.state || (analysis ? 'done' : null);

  if (!state && entry.reason !== 'analysis') {
    return null;
  }

  // Пока заход идёт, прошлых цифр в строке нет вовсе: карточка задачи и бейдж доски
  // прячут их так же, а три экрана про одно состояние обязаны говорить одинаково.
  // Первый заход по задаче называется разведкой, повторный — переоценкой: человеку
  // важно, сгорит ли уже показанная оценка.
  if (state === 'queued' || state === 'running') {
    const again = Boolean(analysis);
    const started = state === 'running';

    return {
      kind: 'analysis',
      label: 'Оценка',
      value: again
        ? (started ? 'Переоценка идёт' : 'Переоценка в очереди')
        : (started ? 'Разведка идёт' : 'В очереди'),
      tone: ANALYSIS_TONES[state] || 'neutral',
    };
  }

  const parts = [ANALYSIS_LABELS[String(state)] || 'Состояние неизвестно'];
  const complexity = scale(analysis?.complexity);
  const risk = scale(analysis?.risk);

  if (complexity) {
    parts.push(`сложность ${complexity}/5`);
  }
  if (risk) {
    parts.push(`риск ${risk}/5`);
  }
  if (typeof analysis?.diff_size === 'string' && analysis.diff_size) {
    parts.push(`дифф ${analysis.diff_size}`);
  }

  const needsClarification = analysis?.needs_clarification === true
    || analysis?.confidence === 'low';

  if (needsClarification) {
    parts.push('нужно уточнение');
  }

  const terminal = state === 'failed' || state === 'interrupted';
  const terminalTone = terminal ? ANALYSIS_TONES[state] : null;

  return {
    kind: 'analysis',
    label: 'Оценка',
    value: parts.join(' · '),
    tone: terminalTone
      || (needsClarification ? 'warn' : ANALYSIS_TONES[String(state)] || 'neutral'),
  };
}

/**
 * Цифры для полосы берутся только у живого прогона: durable снимок места в маршруте не
 * хранит, и полоса «по памяти» показывала бы узел, которого прогон уже не занимает.
 * Идущий прогон без разобранного графа отдаёт нулевой total — карточка покажет движение,
 * а не выдуманную долю.
 */
function pipelineProgress(current: ShelfLivePipeline | null): ShelfActivityProgress | null {
  if (!current) {
    return null;
  }

  const done = Number(current.progress?.done);
  const total = Number(current.progress?.total);

  if (Number.isSafeInteger(done) && Number.isSafeInteger(total) && total > 0) {
    return { done: Math.min(Math.max(done, 0), total), total };
  }

  return current.daemon === 'running' ? { done: 0, total: 0 } : null;
}

/**
 * Называет фактическое место прогона по уже прочитанному вотчером графу. При
 * недоступном графе остаётся последний durable снимок, но без выдуманного прогресса.
 */
function pipelineActivity(
  entry: ShelfEntry,
  current: ShelfLivePipeline | null,
  snapshot: ShelfObservedSnapshot['pipeline'],
): ShelfActivity | null {
  const pipeline: ShelfLivePipeline | null = current || snapshot;

  if (!pipeline && entry.reason !== 'pipeline') {
    return null;
  }
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
    const done = Number(progress?.done);
    const total = Number(progress?.total);
    const count = Number.isSafeInteger(done) && Number.isSafeInteger(total) && total > 0
      ? `${done}/${total}`
      : 'Идёт';

    value = pipeline.stage?.label ? `${count} · ${pipeline.stage.label}` : count;
    tone = pipeline.stage?.state === 'wait' || pipeline.stage?.state === 'premature'
      ? 'warn'
      : 'accent';
  } else if (pipeline.attempt) {
    value = 'Прогон остановлен';
  }

  return {
    kind: 'pipeline',
    label: 'Конвейер',
    value,
    tone,
    progress: pipelineProgress(current),
  };
}

/**
 * Отвечает на вопрос «эта задача ждёт МЕНЯ?». Ворота и затык держат прогон до решения
 * человека, и это состояние, а не событие: огонёк снимается первым же acknowledge,
 * а открытые ворота остаются. Без отдельного признака такая задача уезжала в тихую
 * группу «В ожидании» — туда же, где лежат те, за кем никаких действий не числится.
 */
function needsHumanNow(
  observed: ShelfObservedSnapshot,
  snapshot: ShelfObservedSnapshot,
): boolean {
  const pipeline = observed.pipeline || snapshot.pipeline;

  return Boolean(pipeline?.attempt && (pipeline.gate || pipeline.stall));
}

/**
 * Добавляет статус портальной задачи и полезные метаданные из текущей доски.
 * Сохранённый снимок используется только как fallback, если задача ушла из списка.
 */
function b24Activity(
  task: ShelfBoardTask | null,
  snapshot: ShelfObservedSnapshot['b24'],
): ShelfActivity | null {
  if (task) {
    return {
      kind: 'b24',
      label: 'Битрикс24',
      value: task.statusText || task.statusLabel || 'На доске',
      tone: B24_TONES[String(task.statusKind)] || 'neutral',
    };
  }
  if (!snapshot) {
    return null;
  }

  return {
    kind: 'b24',
    label: 'Битрикс24',
    value: snapshot.present ? 'Последний статус сохранён' : 'Не видна на текущей доске',
    tone: B24_TONES[String(snapshot.statusKind)] || 'neutral',
  };
}

/**
 * Собирает только отображаемую проекцию карточки. Она не попадает в durable snapshot
 * и поэтому может безопасно содержать живые поля доски и подробный прогресс графа.
 */
function presentation(
  controller: ShelfController,
  entry: ShelfEntry,
  observed: ShelfObservedSnapshot,
  snapshot: ShelfObservedSnapshot,
  task: ShelfBoardTask | null,
): ShelfRowDetails {
  const detail = cachedTaskDetail(controller, entry.taskId);
  const activities = [
    b24Activity(task, snapshot.b24),
    analysisActivity(controller, entry, snapshot.analysis),
    pipelineActivity(entry, observed.pipeline, snapshot.pipeline),
  ].filter((activity): activity is ShelfActivity => activity !== null);
  const unread = Number(task?.unread);

  return {
    title: text(task?.title) || text(detail?.title) || entry.title,
    project: text(task?.group) || detailProject(detail),
    responsible: text(task?.responsible),
    deadline: text(task?.deadline),
    overdue: task?.overdue === true,
    unread: Number.isSafeInteger(unread) && unread > 0 ? unread : 0,
    activities,
  };
}

/**
 * Перечисляет источники, которым сейчас нельзя верить. Выключенный триаж молчит
 * намеренно и предупреждением не считается.
 */
function sourceIssues(controller: ShelfController): string[] {
  const issues = [];

  if (controller.board.error) {
    issues.push('Статусы Битрикс24 могут быть устаревшими');
  }
  if (controller.analysis.error && controller.analysis.disabled !== true) {
    issues.push('Состояние оценки может быть устаревшим');
  }
  if (controller.pipeline.error) {
    issues.push('Состояние конвейера может быть устаревшим');
  }

  return issues;
}

/**
 * Текст отказа для человека. Общий клиент кладёт формулировку сервера в message,
 * а обрыв сети приходит без неё — тогда вызывающая сторона подставляет свою.
 */
function errorText(error: unknown): string {
  const message = error !== null && typeof error === 'object'
    ? (error as { message?: unknown }).message
    : undefined;

  return typeof message === 'string' ? message : '';
}

export const useTaskShelfStore = defineStore('taskShelf', {
  state: (): TaskShelfState => ({
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
    isOnShelf: (state) => (id: unknown) => (
      state.entries.some((entry) => entry.taskId === taskKey(id))
    ),
    isPending: (state) => (id: unknown) => !!state.pending[taskKey(id)],
  },
  actions: {
    /**
     * Принимает подтверждённый сервером снимок. Поздний ответ по чужой области и
     * снимок с меньшей ревизией отбрасываются: они старее уже показанного.
     */
    applySnapshot(value: unknown, requestSeq: number | null = null, { silent = false } = {}) {
      const snapshot = parseShelfState(value);
      const seq = requestSeq ?? ++this._requestSeq;

      if (snapshot.scope !== this.scope && seq < this._scopeRequestSeq) {
        return false;
      }
      if (snapshot.scope === this.scope && snapshot.revision < this.revision) {
        return false;
      }

      const controller = ensureController(this);

      if (controller.detailScope !== snapshot.scope) {
        resetTaskDetails(controller, snapshot.scope);
      }

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

    /**
     * Читает полку целиком. Одновременное чтение не запускается: пришедший во время
     * запроса повод перечитать превращается в один trailing-заход после текущего.
     */
    async load(force = false, { silent = false } = {}) {
      const controller = ensureController(this);

      if (!enabled(controller)) {
        return false;
      }
      if (this.loading) {
        if (force) {
          this._reloadQueued = true;
          this._reloadSilent = this._reloadSilent || silent;
        }

        return false;
      }
      if (this.loaded && !force) {
        return true;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.loading = true;
      this.error = null;

      try {
        const snapshot = await shelfApi.list();

        if (epoch !== this._epoch) {
          return false;
        }

        this.applySnapshot(snapshot, requestSeq, { silent });

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorText(error) || 'Полка недоступна';
        }

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

      const nextRuntime: Record<string, ShelfRuntimeEntry> = {};
      const rows: ShelfRow[] = [];

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

        for (const source of availableSources(observed)) {
          primed.add(source);
        }

        if (!silent && previous?.state === 'neutral' && decision.state === 'lit'
          && sourceWasPrimed && setting(controller, 'browserNotifications', true)) {
          alertUser({
            id: `task-shelf-${entry.taskId}-${decision.fingerprint}`,
            scope: `task:${entry.taskId}`,
            tone: 'accent',
            title: `Полка — задача #${entry.taskId}`,
            body: decision.message,
            target: { kind: 'task', taskId: String(entry.taskId) },
          });
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
        const completed = isShelfTaskCompleted(observed.b24 || decision.snapshot.b24);

        rows.push({
          ...entry,
          ...decision,
          title: details.title,
          completed,
          needsHuman: needsHumanNow(observed, decision.snapshot),
          details,
        });
      }

      this._runtime = nextRuntime;
      this.rows = rows;
    },

    /**
     * Единственная запись на сервер. Снимок берётся у решателя, а не у карточки: на
     * полку кладут то, что видно сейчас, и именно это станет базой следующего события.
     */
    async _put(id: unknown, options: {
      reason: ShelfReason;
      createIfMissing: boolean;
      resetRuntime?: boolean;
    }) {
      const { reason, createIfMissing, resetRuntime = false } = options;
      const controller = ensureController(this);
      const key = taskKey(id);

      if (!key || !enabled(controller) || this.pending[key]) {
        return false;
      }

      const existing = this.entries.find((entry) => entry.taskId === key) || null;
      const observed = observedTask(controller, key);
      const snapshot = taskShelfDecision({
        snapshot: existing?.snapshot || emptySnapshot(),
        observed,
        reason,
      }).snapshot;
      const task = boardTask(controller, key);
      const title = existing?.title || text(task?.title) || `Задача #${key}`;
      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.pending = { ...this.pending, [key]: true };
      this.error = null;

      try {
        const response = await shelfApi.put(key, {
          title,
          reason,
          snapshot,
          createIfMissing,
        });

        if (epoch !== this._epoch) {
          return false;
        }
        if (resetRuntime) {
          const { [key]: _dropped, ...runtime } = this._runtime;

          this._runtime = runtime;
        }

        this.applySnapshot(response, requestSeq);

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorText(error) || 'Не удалось изменить полку';
        }

        return false;
      } finally {
        if (epoch === this._epoch) {
          const { [key]: _dropped, ...rest } = this.pending;

          this.pending = rest;
        }
      }
    },

    /**
     * Снимает задачу с полки. Оборванная мутация не повторяется: неизвестно, дошла ли
     * первая, а состояние всё равно приедет подтверждённым снимком сервера.
     */
    async remove(id: unknown) {
      const controller = ensureController(this);
      const key = taskKey(id);

      if (!key || !enabled(controller) || this.pending[key]) {
        return false;
      }

      const epoch = this._epoch;
      const requestSeq = ++this._requestSeq;

      this.pending = { ...this.pending, [key]: true };
      this.error = null;

      try {
        const response = await shelfApi.remove(key);

        if (epoch !== this._epoch) {
          return false;
        }

        this.applySnapshot(response, requestSeq);

        return true;
      } catch (error) {
        if (epoch === this._epoch) {
          this.error = errorText(error) || 'Не удалось убрать задачу';
        }

        return false;
      } finally {
        if (epoch === this._epoch) {
          const { [key]: _dropped, ...rest } = this.pending;

          this.pending = rest;
        }
      }
    },

    toggle(id: unknown) {
      return this.isOnShelf(id)
        ? this.remove(id)
        : this._put(id, { reason: 'manual', createIfMissing: true });
    },

    autoAdd(id: unknown) {
      const controller = ensureController(this);

      if (!enabled(controller) || !setting(controller, 'autoAddOnAnalysis', true)) {
        return false;
      }

      return this._put(id, { reason: 'analysis', createIfMissing: true });
    },

    acknowledge(id: unknown) {
      if (!this.isOnShelf(id)) {
        return false;
      }

      const entry = this.entries.find((item) => item.taskId === taskKey(id));

      return this._put(id, {
        reason: entry?.reason || 'manual',
        createIfMissing: false,
        resetRuntime: true,
      });
    },

    /**
     * Подписывается на события сервера и на живые источники. Включение плагина
     * перечитывает полку молча: накопленный за время выключения огонь не оповещает.
     */
    start() {
      const controller = ensureController(this);

      if (controller.started) {
        return;
      }

      controller.started = true;
      controller.stops.push(sseSubscribe((name: string) => {
        if (name === 'task-shelf-changed' && enabled(controller)) {
          void this.load(true);
        }
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

    /**
     * Снимает все подписки разом. Кэш карточек остаётся: остановка не меняет ни область,
     * ни состав полки, и после повторного start перечитывать его незачем.
     */
    stop() {
      const controller = controllers.get(this);

      if (!controller?.started) {
        return;
      }

      for (const stop of controller.stops.splice(0)) {
        stop?.();
      }

      controller.started = false;
      controller.enabled = false;
    },

    /**
     * Забывает полку целиком при смене человека. Растущий epoch отсекает ответы,
     * которые улетели до выхода: их данные принадлежат уже другой области.
     */
    clear() {
      const controller = controllers.get(this);

      if (controller) {
        resetTaskDetails(controller);
      }

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
