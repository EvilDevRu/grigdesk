import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import type {
  WorkflowResult,
  WorkflowRunGraph,
  WorkflowRow,
} from '../../../shared/pipeline/graphWorkflowContracts.ts';
import { api, ApiError } from '../shared/apiClient.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import { sseSubscribe } from '../composables/useSse.ts';

const t = localeTranslator(uiLocalePort);
const PREFIX = '/api/graph-workflows';

export interface WorkflowTemplateHeader {
  id: string;
  revision: string;
  builtIn: boolean;
  title: string;
  inputKind: string;
  requiresModel: boolean;
}

export interface WorkflowRunHeader {
  id: string;
  title: string;
  inputKind: string;
  status: string;
  createdAt: number;
  revision: number;
  errorCode?: string;
}

export interface WorkflowReviewTarget {
  id: string;
  title: string;
  deliversFeedback: boolean;
}

export interface WorkflowNodeDetails {
  id: string;
  generation: number;
  revision: number;
  status: string;
  rows: WorkflowRow[];
  attempts: number;
  inputs: Array<{ key: string; name: string }>;
  errorCode?: string;
  approval?: {
    state: 'pending' | 'approved' | 'rejected';
    comment?: string;
    reviewActions?: {
      approve: boolean;
      rejectMode: 'return' | 'close';
      targets: WorkflowReviewTarget[];
    };
  };
}

export interface WorkflowModelChoice {
  provider: string;
  model: string;
  label: string;
}

export interface WorkflowInputSource {
  key: string;
  name: string;
  text: string;
  segments?: Array<{
    line: number;
    timeMs: number;
    text: string;
  }>;
}

/**
 * Разбирает DTO схемы прогона на границе стора.
 * Подменённый корень или список узлов — это отказ, а не пустое полотно.
 */
function parseRunGraph(value: unknown): WorkflowRunGraph {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.revision !== 'number'
    || typeof value.status !== 'string' || !Array.isArray(value.nodes)) {
    throw new ApiError(t('core.workflowBadResponse'), 0, null);
  }

  return value as unknown as WorkflowRunGraph;
}

/**
 * Проверяет контейнеры страницы результата до слияния с открытой панелью.
 * Строки и списки missing/approvals обязательны, курсор может быть null.
 */
function parseResult(value: unknown): WorkflowResult {
  if (!isRecord(value) || typeof value.revision !== 'number' || !Array.isArray(value.rows)
    || !Array.isArray(value.missing) || !Array.isArray(value.approvals)) {
    throw new ApiError(t('core.workflowBadResponse'), 0, null);
  }

  return value as unknown as WorkflowResult;
}

/**
 * Проверяет DTO выбранного узла: строки, поколение и ревизия обязательны.
 * Поздний ответ другого прогона отсекается вызывающим по текущему ID.
 */
function parseNodeDetails(value: unknown): WorkflowNodeDetails {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.generation !== 'number'
    || typeof value.revision !== 'number' || !Array.isArray(value.rows)) {
    throw new ApiError(t('core.workflowBadResponse'), 0, null);
  }

  return value as unknown as WorkflowNodeDetails;
}

/**
 * Состояние графовых маршрутов: каталог, история, открытый прогон и его результат.
 * Ответы принимаются только для текущего ID с монотонной ревизией; SSE — инвалидация.
 */
export const useGraphWorkflowsStore = defineStore('graphWorkflows', () => {
  const templates = ref<WorkflowTemplateHeader[]>([]);
  const templatesCursor = ref<string | null>(null);
  const runs = ref<WorkflowRunHeader[]>([]);
  const runsCursor = ref<string | null>(null);
  const admissionPausedUntil = ref<number | null>(null);
  const currentId = ref<string | null>(null);
  const run = ref<WorkflowRunGraph | null>(null);
  const details = ref<WorkflowNodeDetails | null>(null);
  const result = ref<WorkflowResult | null>(null);
  const resultRevision = ref(0);
  const resultLoading = ref(false);
  const resultNotice = ref<string | null>(null);
  const loading = ref(false);
  const pending = ref(false);
  const error = ref<string | null>(null);
  const models = ref<WorkflowModelChoice[]>([]);
  const source = ref<WorkflowInputSource | null>(null);

  let requestSeq = 0;
  let inflight: { id: string; request: Promise<void> } | undefined;
  let nodeRequestSeq = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | undefined;

  const liveLeaves = computed(() => (run.value?.nodes ?? []).filter((node) =>
    (node.kind === 'agent' || node.kind === 'meetingTasks')
    && (node.status === 'ready' || node.status === 'running')).length);

  /**
   * Дедупликация страниц каталога и истории по ID.
   * Порядок последнего принятого ответа сохраняется без дублей.
   */
  function mergeById<T extends { id: string }>(list: T[], page: T[]): T[] {
    const map = new Map(list.map((item) => [item.id, item]));

    for (const item of page) {
      map.set(item.id, item);
    }

    return [...map.values()];
  }

  /**
   * Каталог шаблонов читается страницами по 30 с opaque-курсором.
   * Первая страница заменяет список, последующие дочитывают по ID.
   */
  async function loadTemplates(cursor?: string | null): Promise<void> {
    let pageCursor = cursor;
    let items = cursor ? templates.value : [];
    const seen = new Set<string>();

    do {
      const query = pageCursor ? `?cursor=${encodeURIComponent(pageCursor)}` : '';
      const value = await api.get(`${PREFIX}/templates${query}`) as {
        templates: WorkflowTemplateHeader[];
        nextCursor: string | null;
      };

      items = mergeById(items, value.templates);
      pageCursor = value.nextCursor;

      if (pageCursor && seen.has(pageCursor)) {
        throw new ApiError(t('core.workflowBadResponse'), 0, null);
      }
      if (pageCursor) {
        seen.add(pageCursor);
      }
    } while (pageCursor);

    templates.value = items;
    templatesCursor.value = null;
  }

  /**
   * История прогонов приходит заголовками в обратном порядке создания.
   * Повреждённый прогон остаётся видимым деградированным заголовком.
   */
  async function loadRuns(cursor?: string | null): Promise<void> {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const value = await api.get(`${PREFIX}/runs${query}`) as {
      runs: WorkflowRunHeader[];
      nextCursor: string | null;
      admissionPausedUntil?: number;
    };

    runs.value = cursor ? mergeById(runs.value, value.runs) : value.runs;
    runsCursor.value = value.nextCursor;
    admissionPausedUntil.value = value.admissionPausedUntil ?? null;
  }

  /**
   * J06: один таймер на открытую карточку, следующий заводится после GET.
   * Терминальное состояние без живых листьев останавливает опрос.
   */
  function schedulePoll(): void {
    clearTimeout(pollTimer);
    pollTimer = undefined;

    const active = currentId.value && run.value
      && (run.value.status === 'running' || liveLeaves.value > 0);

    if (!active) {
      return;
    }

    pollTimer = setTimeout(() => {
      void refreshCurrent().finally(schedulePoll);
    }, 2000);
  }

  /**
   * Один ожидающий GET на SSE и таймер: ревизия и текущий ID защищают ответ.
   * Поздний снимок меньшей ревизии не перекрывает принятый.
   */
  function refreshCurrent(force = false): Promise<void> {
    const id = currentId.value;

    if (!force && inflight && inflight.id === id) {
      return inflight.request;
    }

    if (!id) {
      return Promise.resolve();
    }

    const seq = ++requestSeq;

    const request = (async () => {
      try {
        const value = parseRunGraph(await api.get(`${PREFIX}/runs/${id}`));

        if (seq !== requestSeq || currentId.value !== id) {
          return;
        }

        if (!run.value || run.value.id !== id || value.revision >= run.value.revision) {
          run.value = value;
        }

        error.value = null;
      } catch (caught) {
        if (seq === requestSeq && currentId.value === id) {
          error.value = caught instanceof ApiError ? caught.message : t('core.workflowBadResponse');
        }
      } finally {
        if (seq === requestSeq) {
          inflight = undefined;
        }
      }
    })();

    inflight = { id, request };

    return request;
  }

  /**
   * Открытие прогона сбрасывает панель и результат прежнего выбора.
   * Первый снимок читается сразу, дальше работают SSE и таймер.
   */
  async function openRun(id: string): Promise<void> {
    clearTimeout(pollTimer);
    inflight = undefined;
    nodeRequestSeq += 1;
    currentId.value = id;
    run.value = null;
    details.value = null;
    result.value = null;
    resultNotice.value = null;
    source.value = null;

    await refreshCurrent();
    schedulePoll();
  }

  /**
   * Закрытие карточки снимает таймер и ожидающие панели.
   * Новые запросы не заводятся: стор остаётся без открытого прогона.
   */
  function closeRun(): void {
    inflight = undefined;
    requestSeq += 1;
    nodeRequestSeq += 1;
    currentId.value = null;
    run.value = null;
    details.value = null;
    result.value = null;
    source.value = null;

    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  /**
   * Деталь узла принимается только для текущего прогона и не меньшей ревизии.
   * Поздний ответ прежнего поколения не перекрывает новую ошибку.
   */
  async function openNode(nodeId: string): Promise<void> {
    const id = currentId.value;

    if (!id) {
      return;
    }

    const seq = ++nodeRequestSeq;
    const value = parseNodeDetails(await api.get(`${PREFIX}/runs/${id}/nodes/${encodeURIComponent(nodeId)}`));

    if (currentId.value !== id || seq !== nodeRequestSeq || value.id !== nodeId) {
      return;
    }

    if (details.value && details.value.id === value.id && value.generation < details.value.generation) {
      return;
    }

    if (run.value && value.revision < run.value.revision) {
      return;
    }

    details.value = value;
  }

  /**
   * Источник читается по точному inputKey открытого прогона.
   * Произвольные пути не принимаются: ключ назначил движок при старте.
   */
  async function openInput(inputKey: string): Promise<void> {
    const id = currentId.value;

    if (!id) {
      return;
    }

    const value = await api.get(
      `${PREFIX}/runs/${id}/inputs/${encodeURIComponent(inputKey)}`,
    ) as WorkflowInputSource;

    if (currentId.value === id) {
      source.value = value;
    }
  }

  /**
   * Первая страница результата открывает панель и фиксирует ревизию.
   * Заголовки inputs/missing/approvals остаются из этой страницы.
   */
  async function openResult(runId: string): Promise<void> {
    const value = parseResult(await api.get(`${PREFIX}/runs/${runId}/result`));

    if (currentId.value !== runId) {
      return;
    }

    result.value = value;
    resultRevision.value = value.revision;
    resultNotice.value = null;
  }

  /**
   * Страницы дочитываются только при совпадении ID, курсора и обеих ревизий.
   * 409 result_changed заменяет накопленное первой страницей с пояснением.
   */
  async function loadMoreResult(): Promise<void> {
    const visible = result.value;
    const id = currentId.value;

    if (!visible || !id || !visible.nextCursor || resultLoading.value) {
      return;
    }

    const cursor = visible.nextCursor;
    const revision = resultRevision.value;

    resultLoading.value = true;

    try {
      const value = parseResult(await api.get(
        `${PREFIX}/runs/${id}/result?cursor=${encodeURIComponent(cursor)}`,
      ));

      if (currentId.value !== id || resultRevision.value !== revision
        || result.value?.nextCursor !== cursor) {
        return;
      }

      result.value = {
        ...visible,
        rows: [...visible.rows, ...value.rows],
        nextCursor: value.nextCursor,
      };
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409 && currentId.value === id) {
        await openResult(id);
        resultNotice.value = t('core.workflowResultChanged');

        return;
      }

      resultNotice.value = t('core.workflowResultPageFailed');
    } finally {
      resultLoading.value = false;
    }
  }

  /**
   * Действие по экземпляру или пауза идут под ожидаемой ревизией снимка.
   * После приёма перечитываются карточка и список; 409 обрабатывает контроллер.
   */
  async function act(payload: Record<string, unknown>): Promise<void> {
    const id = currentId.value;

    if (!id) {
      return;
    }

    pending.value = true;

    try {
      await api.post(`${PREFIX}/runs/${id}/action`, payload);
      await refreshCurrent(true);
      await loadRuns();
    } finally {
      pending.value = false;
    }
  }

  /**
   * Ручной старт принимает UUID клиента и редакцию шаблона.
   * Принятый прогон сразу открывается, список истории обновляется.
   */
  async function startRun(payload: Record<string, unknown>): Promise<string> {
    pending.value = true;

    try {
      const value = await api.post(`${PREFIX}/runs`, payload) as { id: string };

      await Promise.all([openRun(value.id), loadRuns().catch(() => {})]);

      return value.id;
    } finally {
      pending.value = false;
    }
  }

  /**
   * Сохранение редакции возвращает новый хеш канонических байтов.
   * Конфликт ревизии пробрасывается контроллеру без потери локальных правок.
   * Копия встроенного шаблона приходит без ID: новый UUID создаётся здесь,
   * потому что Go принимает только UUID и не подставляет builtin-идентификаторы.
   */
  async function saveTemplate(payload: Record<string, unknown>): Promise<WorkflowTemplateHeader> {
    const body = payload.id === null || payload.id === undefined
      ? { ...payload, id: crypto.randomUUID() }
      : payload;
    const value = await api.post(`${PREFIX}/templates/save`, body) as WorkflowTemplateHeader;

    await loadTemplates();

    return value;
  }

  /** Полный документ шаблона читается точечным GET перед открытием и копированием. */
  async function loadTemplateDocument(id: string): Promise<{
    id: string;
    revision: string;
    builtIn: boolean;
    document: unknown;
  }> {
    return await api.get(`${PREFIX}/templates/${encodeURIComponent(id)}`) as {
      id: string;
      revision: string;
      builtIn: boolean;
      document: unknown;
    };
  }

  /** Список совместимых моделей фильтруется сервером по закрытому model-only порту. */
  async function loadModels(): Promise<void> {
    const value = await api.get(`${PREFIX}/models`) as { models: WorkflowModelChoice[] };

    models.value = value.models;
  }

  /**
   * Общая лента инвалидаций: адресный сигнал перечитывает открытую карточку,
   * scope runs — список и открытую запись; hello восстанавливает после обрыва.
   */
  function subscribe(): void {
    if (unsubscribe) {
      return;
    }

    unsubscribe = sseSubscribe((name, value) => {
      if (name === 'hello') {
        void loadRuns().catch(() => {});
        void refreshCurrent();

        return;
      }

      if (name !== 'graph-workflow-change') {
        return;
      }

      const signal = (isRecord(value) ? value : {}) as {
        id?: string;
        scope?: string;
        templateId?: string;
      };

      if (signal.templateId) {
        void loadTemplates().catch(() => {});

        return;
      }

      void loadRuns().catch(() => {});

      if (signal.scope === 'runs' || (signal.id && signal.id === currentId.value)) {
        void refreshCurrent();
      }
    });
  }

  /**
   * Снятие подписки и таймера при закрытии раздела.
   * Один SSE на вкладку остаётся общим, стор владеет только своим listener.
   */
  function dispose(): void {
    unsubscribe?.();
    unsubscribe = undefined;

    clearTimeout(pollTimer);
    pollTimer = undefined;
  }

  return {
    templates,
    templatesCursor,
    runs,
    runsCursor,
    admissionPausedUntil,
    currentId,
    run,
    details,
    result,
    resultRevision,
    resultLoading,
    resultNotice,
    loading,
    pending,
    error,
    models,
    source,
    liveLeaves,
    loadTemplates,
    loadRuns,
    openRun,
    closeRun,
    refreshCurrent,
    openNode,
    openInput,
    openResult,
    loadMoreResult,
    act,
    startRun,
    saveTemplate,
    loadTemplateDocument,
    loadModels,
    subscribe,
    dispose,
  };
});