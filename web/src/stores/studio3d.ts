// Pinia хранит только проверенные DTO. Подписка принадлежит оболочке вкладки.
// Таймеры, controllers и coalescing promises лежат в closure вне reactive state.
import { computed, ref, toRaw } from 'vue';
import { defineStore } from 'pinia';
import { studio3dApi } from '../features/studio3d/studio3dApi.ts';
import type { StudioInput, StudioRunInput } from '../features/studio3d/studio3dApi.ts';
import { createPendingIntentController } from '../features/studio3d/pendingIntentController.ts';
import { studioPending, studioFingerprint } from '../features/studio3d/pendingIntents.ts';
import type { PendingStudioIntent } from '../features/studio3d/pendingIntents.ts';
import { sseSubscribe } from '../composables/useSse.ts';
import type { SseEventName } from '../composables/useSse.ts';
import { alertUser, dismissAlertScope } from '../shared/alerts.ts';
import { studioErrorMessage } from '../features/studio3d/presentation.ts';
import { parseStudio3d, VERSION_STATUSES } from '../../../shared/studio3d/studio3dContracts.ts';
import type { Studio3dState, Studio3dModel, Studio3dModelDetail, Studio3dOffer,
  Studio3dUpload, Studio3dTaskRow, VersionStatus } from '../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues } from '../../../shared/studio3d/studio3dOperations.ts';

type Tasks = ReturnType<typeof parseStudio3d.tasks>;
type Quoted = ReturnType<typeof parseStudio3d.quote>;
type RunResult = ReturnType<typeof parseStudio3d.run>
  | { priceChanged: ReturnType<typeof parseStudio3d.price> };
type Lane = 'state' | 'models' | 'detail' | 'offers' | 'quote' | 'tasks';

/**
 * Closure изолирована для каждой Pinia и живёт до stop/logout, не до ухода с route.
 * Поколения запросов и библиотеки запрещают позднему ответу менять новый экран.
 */
export const useStudio3dStore = defineStore('studio3d', () => {
  const state = ref<Studio3dState | null>(null);
  const models = ref<Studio3dModel[]>([]);
  const total = ref(0);
  const query = ref('');
  const filters = ref<Record<string, string>>({});
  const detail = ref<Studio3dModelDetail | null>(null);
  const offers = ref<Studio3dOffer[]>([]);
  const quoted = ref<Quoted | null>(null);
  const tasks = ref<Tasks | null>(null);
  const uploads = ref<Studio3dUpload[]>([]);
  const pending = ref<PendingStudioIntent[]>([]);
  const busy = ref(0);
  const error = ref<string | null>(null);
  const broken = ref<string[]>([]);
  const selectedVersion = ref('');
  const openedModel = ref('');
  const viewingModel = ref('');
  const setViewingModel = (id: string) => {
    viewingModel.value = id;
  };
  const active = computed(() => tasks.value?.active.length ?? state.value?.active ?? 0);
  const libraryId = computed(() => state.value?.libraryId ?? '');
  let epoch = 0;
  let owner = '';
  let started = false;
  let off: (() => void) | null = null;
  let changedTimer: ReturnType<typeof setTimeout> | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let quoteTimer: ReturnType<typeof setTimeout> | null = null;
  let delayedSearch: ((value: unknown) => void) | null = null;
  let delayedQuote: ((value: Quoted | null) => void) | null = null;
  const lanes = new Map<Lane, { revision: number; controller: AbortController }>();
  // Карта отправок принадлежит одному контроллеру на весь lifetime экземпляра Pinia.
  // Stop меняет сессию, но не отменяет принятый POST и не очищает незавершённые отправки.
  const pendingController = createPendingIntentController({
    storage: studioPending,
    api: {
      run: studio3dApi.run,
      retry: studio3dApi.retry,
      batchRun: studio3dApi.batchRun,
      job: studio3dApi.job,
    },
    fingerprint: studioFingerprint,
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    session: () => ({
      owner,
      libraryId: libraryId.value,
      generation: epoch,
      started,
      libraryOk: Boolean(state.value?.library.ok),
    }),
    pending: {
      list: () => toRaw(pending.value),
      add: (record) => {
        if (!pending.value.some((item) => item.key === record.key)) {
          pending.value.push(record);
        }
      },
      replace: (record) => {
        pending.value = pending.value.map((item) => item.key === record.key ? record : item);
      },
      remove: (key) => {
        pending.value = pending.value.filter((item) => item.key !== key);
      },
      reset: (records) => {
        pending.value = records;
      },
    },
    busy: {
      begin: () => {
        busy.value += 1;
      },
      end: () => {
        busy.value = Math.max(0, busy.value - 1);
      },
    },
    // Контроллер уже проверил поколение и marker ответа до внешних обновлений.
    // Существующие refs и функции обновления остаются в этом экземпляре Pinia.
    onSent: (result) => {
      void loadModels();
      void loadTasks();

      const modelId = 'model' in result ? result.model?.id : null;

      if (modelId && modelId === openedModel.value) {
        void openModel(modelId, selectedVersion.value);
      }
    },
    onError: (cause) => rememberError(cause),
    onDropped: (record, text) => {
      alertUser({
        id: `studio-expired-${record.key}`,
        scope: `studio-expired:${record.key}`,
        tone: 'danger',
        title: text,
      });
    },
  });
  const uploading = new Set<AbortController>();
  const seen = new Set<string>();

  /**
   * Показанные исходы принадлежат текущему входу и переживают перезагрузку окна.
   * Чтение перед тостом учитывает уведомления другой вкладки; хранилище ограничено 500 ключами.
   */
  const syncSeen = () => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`cockpit-studio3d-seen:${owner}`) ?? '[]');

      if (Array.isArray(saved)) {
        for (const key of saved.slice(-500)) {
          if (typeof key === 'string') {
            seen.add(key);
          }
        }
      }
    } catch {
      // Недоступное хранилище оставляет дедупликацию в памяти текущей вкладки.
    }
  };

  /**
   * Ограниченный список сохраняется после регистрации исхода, до показа уведомления.
   * Ошибка localStorage не мешает обновлению модели и очереди заказов.
   */
  const persistSeen = () => {
    while (seen.size > 500) {
      seen.delete(seen.values().next().value!);
    }

    try {
      localStorage.setItem(`cockpit-studio3d-seen:${owner}`, JSON.stringify([...seen]));
    } catch {
      // При запрете записи остаётся ограниченный список в памяти.
    }
  };

  /**
   * Ошибка отменённого или прежнего запроса не заменяет актуальный отказ формы.
   * Некорректный DTO сохраняет сообщение декодера, HTTP — безопасный текст сервера.
   */
  const rememberError = (cause: unknown) => {
    if ((cause as { name?: string })?.name !== 'AbortError') {
      error.value = studioErrorMessage(cause);
    }
  };

  /**
   * Смена библиотеки отзывает requests и все зависимые DTO до загрузки нового root.
   * Durable намерения сохраняются и показывают блокировку вместо новой оплаты.
   */
  const invalidate = () => {
    epoch += 1;
    
    for (const lane of lanes.values()) {
      lane.controller.abort();
    }
    for (const controller of uploading) {
      controller.abort();
    }
    
    uploading.clear();
    lanes.clear();
    
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    if (quoteTimer) {
      clearTimeout(quoteTimer);
    }
    
    delayedSearch?.(null);
    delayedQuote?.(null);
    delayedSearch = null;
    delayedQuote = null;
    searchTimer = null;
    quoteTimer = null;
    models.value = [];
    detail.value = null;
    offers.value = [];
    quoted.value = null;
    tasks.value = null;
    uploads.value = [];
    total.value = 0;
    selectedVersion.value = '';
    busy.value = 0;
  };

  /**
   * Каждый lane отменяет прежний fetch и дополнительно сверяет revision после await.
   * Проверка libraryId выполняется даже если transport проигнорировал abort.
   */
  const read = async <T extends { libraryId: string }>(lane: Lane,
    work: (signal: AbortSignal) => Promise<T>, apply: (value: T) => void): Promise<T | null> => {
    const previous = lanes.get(lane);
    
    previous?.controller.abort();
    
    const current = { revision: (previous?.revision ?? 0) + 1, controller: new AbortController() };
    const generation = epoch;
    const expectedLibrary = libraryId.value;
    
    lanes.set(lane, current);
    busy.value += 1;
    
    try {
      const value = await work(current.controller.signal);
      
      if (generation !== epoch || lanes.get(lane) !== current || current.controller.signal.aborted) {
        return null;
      }
      if (lane !== 'state' && expectedLibrary && value.libraryId !== expectedLibrary) {
        return null;
      }
      
      apply(value);
      
      return value;
    } catch (cause) {
      if (generation === epoch && lanes.get(lane) === current && !current.controller.signal.aborted) {
        rememberError(cause);
      }
      
      return null;
    } finally {
      if (generation === epoch) {
        busy.value = Math.max(0, busy.value - 1);
      }
    }
  };

  /**
   * State обновляет marker и очищает старые проекции при transactional root switch.
   * Недоступная библиотека остаётся видимой с причиной и не разрешает запуск.
   */
  const loadState = () => read('state', studio3dApi.state, (value) => {
    if (state.value && state.value.libraryId !== value.libraryId) {
      invalidate();
    }
    
    state.value = value;
  });

  /**
   * Поиск и фильтры собираются в один запрос, пагинация дополняет только его поколение.
   * Broken manifests отображаются отдельно от честного общего числа моделей.
   */
  const loadModels = (append = false) => read('models', (signal) => studio3dApi.models({
    ...filters.value,
    q: query.value,
    offset: append ? models.value.length : 0,
    limit: 50
  }, signal), (value) => {
    models.value = append ? [...models.value, ...value.models] : value.models;
    total.value = value.total;
    broken.value = value.broken;
  });

  /**
   * Ввод сразу делает прежний поиск устаревшим; HTTP ждёт 300 мс тишины.
   * Все superseded promises завершаются, stop не оставляет висящего ожидания.
   */
  const search = (value: string) => {
    query.value = value;
    lanes.get('models')?.controller.abort();
    
    if (searchTimer) {
      clearTimeout(searchTimer);
    }
    
    delayedSearch?.(null);
    
    return new Promise((resolve) => {
      delayedSearch = resolve;
      searchTimer = setTimeout(() => {
        searchTimer = null;
        delayedSearch = null;
        void loadModels().then(resolve);
      }, 300);
    });
  };

  /**
   * Selection меняется до HTTP, поэтому старая модель не видна под новым id.
   * Чтение новой модели не переиспользует offers и цену прежней версии.
   */
  const openModel = (modelId: string, versionId = '') => {
    if (openedModel.value !== modelId || selectedVersion.value !== versionId) {
      detail.value = null;
      offers.value = [];
      quoted.value = null;
      lanes.get('offers')?.controller.abort();
      lanes.get('quote')?.controller.abort();
    }
    
    openedModel.value = modelId;
    selectedVersion.value = versionId;
    dismissAlertScope(`studio:${modelId}`);
    
    return read('detail', (signal) => studio3dApi.model(modelId, signal), (value) => {
      detail.value = value;
      
      if (!value.versions.some((version) => version.id === selectedVersion.value)) {
        selectedVersion.value = value.model.mainVersion ?? value.versions[0]?.id ?? '';
      }
    });
  };

  /**
   * Предложения выводятся только для текущего снимка входа и версии.
   * Поздний ответ прежней карточки отменяется отдельным lane.
   */
  const loadOffers = (input: StudioInput = {}) => read('offers', (signal) =>
    studio3dApi.offers({ libraryId: libraryId.value, ...input }, signal), (value) => {
      offers.value = value.offers;
    });

  /**
   * Любое изменение формы немедленно сбрасывает цену до нового расчёта.
   * Дебаунс не позволяет старой цене активировать кнопку новой формы.
   */
  const quote = (input: {
    provider: string;
    operation: string;
    values: FieldValues
  } & StudioInput) => {
    quoted.value = null;
    lanes.get('quote')?.controller.abort();
    
    if (quoteTimer) {
      clearTimeout(quoteTimer);
    }
    
    delayedQuote?.(null);
    
    const snapshot = JSON.parse(JSON.stringify(input)) as typeof input;
    
    return new Promise<Quoted | null>((resolve) => {
      delayedQuote = resolve;
      quoteTimer = setTimeout(() => {
        delayedQuote = null;
        quoteTimer = null;
        void read('quote', (signal) => studio3dApi.quote({ libraryId: libraryId.value, ...snapshot }, signal),
          (value) => {
            quoted.value = value;
          }).then(resolve);
      }, 300);
    });
  };

  /**
   * Терминальный исход dedup по intent/child/status совпадает у SSE и reconnect.
   * Открытая модель получает обновление на месте без отвлекающего тоста.
   */
  const terminal = (row: Pick<Studio3dTaskRow, 'intentId' | 'childId' | 'modelId' | 'versionId'
    | 'status' | 'label' | 'modelName' | 'error'>) => {
    if (!['ready', 'failed'].includes(row.status) || !row.modelId || !row.versionId) {
      return;
    }
    
    const key = `${libraryId.value}:${row.intentId}:${row.childId}:${row.status}`;

    syncSeen();
    
    if (seen.has(key)) {
      return;
    }
    
    seen.add(key);
    persistSeen();

    if (viewingModel.value === row.modelId) {
      return;
    }
    
    alertUser({
      id: `studio-${row.versionId}`,
      scope: `studio:${row.modelId}`,
      tone: row.status === 'ready' ? 'accent' : 'danger',
      sticky: row.status === 'failed',
      title: row.status === 'ready'
        ? `Модель «${row.modelName ?? row.label}» готова` : `Не получилось: «${row.modelName ?? row.label}»`,
      body: row.error?.message ?? undefined,
      target: {
        kind: 'studio',
        modelId: row.modelId,
        versionId: row.versionId
      }
    });
  };

  /**
   * Reconnect включает recent, поэтому пропущенный terminal signal не теряет уведомление.
   * Unknown расход остаётся неизвестным даже после прекращения ожидания.
   */
  const loadTasks = (refresh = false) => read('tasks', (signal) => studio3dApi.tasks(refresh,
    signal), (value) => {
    tasks.value = value;
    
    for (const row of value.recent) {
      terminal(row);
    }
  });

  const submit = pendingController.submit;

  const run = (input: StudioRunInput, key?: string) =>
    submit('run', input, key) as Promise<RunResult>;
  const retry = (modelId: string, versionId: string, expectedPrice: number, key?: string) =>
    submit('retry', { expectedPrice }, key, modelId, versionId) as Promise<RunResult>;
  const batchRun = (input: Record<string, unknown>, key?: string) =>
    submit('batch', input, key) as ReturnType<typeof studio3dApi.batchRun>;
  const batchQuote = (rows: Record<string, unknown>[]) =>
    studio3dApi.batchQuote({ libraryId: libraryId.value, rows });

  const recoverPending = pendingController.recoverPending;

  /**
   * Событие принимается лишь текущей библиотекой; частый progress не делает HTTP.
   * Серия changed сворачивается в одно чтение после 300 мс.
   */
  const onEvent = (name: SseEventName, raw: unknown) => {
    if (!started) {
      return;
    }
    if (name === 'hello' || name === 'providers-update') {
      void refresh();
      
      return;
    }
    
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    
    if (value.libraryId !== libraryId.value) {
      return;
    }
    if (name === 'studio-progress') {
      const currentDetail = detail.value;
      
      if (!currentDetail || currentDetail.model.id !== value.modelId) {
        return;
      }
      
      const version = currentDetail.versions.find((item) => item.id === value.versionId);
      
      if (!version || !VERSION_STATUSES.includes(value.status as VersionStatus)
        || typeof value.progress !== 'number' || !Number.isFinite(value.progress)
        || value.progress < 0 || value.progress > 100) {
          return;
        }
      
      version.status = value.status as VersionStatus;
      version.progress = value.progress;
      version.etaSeconds = typeof value.etaSeconds === 'number' ? value.etaSeconds : null;
    }
    if (name === 'studio-changed') {
      if (changedTimer) {
        clearTimeout(changedTimer);
      }
      
      changedTimer = setTimeout(() => {
        changedTimer = null;
        void refresh();
      }, 300);
    }
  };

  /**
   * Reconnect восстанавливает список, задачи и текущую модель из server truth.
   * Запросы прошлого marker отменяются loadState до следующих чтений.
   */
  const refresh = async () => {
    if (!started) {
      return;
    }
    
    const identity = owner;
    const freshState = await loadState();
    
    if (!freshState || owner !== identity || !started || !state.value?.library.ok) {
      return;
    }
    
    await Promise.all([loadModels(), loadTasks(), openedModel.value
      ? openModel(openedModel.value, selectedVersion.value) : Promise.resolve()]);
  };

  /**
   * Оболочка запускает единственного подписчика, повторный start ничего не удваивает.
   * Owner связывает browser pending с текущим входом, без чтения cookie или секретов.
   */
  const start = async (identity = '') => {
    if (started && owner === identity) {
      return;
    }
    if (started) {
      stop();
    }
    
    owner = identity;
    started = true;
    error.value = null;
    off = sseSubscribe(onEvent);
    
    const generation = epoch;
    
    await refresh();
    
    if (started && generation === epoch && owner === identity) {
      await recoverPending().catch(rememberError);
    }
  };

  /**
   * Logout и disable снимают шину, таймеры и запросы, очищая экран старого владельца.
   * IndexedDB сохраняет неизвестные исходы; уход с /3d этот метод не вызывает.
   */
  const stop = () => {
    started = false;
    off?.();
    off = null;
    
    if (changedTimer) {
      clearTimeout(changedTimer);
    }
    
    changedTimer = null;
    invalidate();
    state.value = null;
    error.value = null;
    pending.value = [];
    openedModel.value = '';
    viewingModel.value = '';
    seen.clear();
    owner = '';
  };

  /**
   * Файловая загрузка может быть отменена при logout или смене библиотеки.
   * Сохранённая upload identity принадлежит только текущему marker.
   */
  const upload = async (file: File) => {
    const generation = epoch;
    const controller = new AbortController();
    
    uploading.add(controller);
    
    try {
      const result = await studio3dApi.upload(libraryId.value, file, controller.signal);
      
      if (generation !== epoch || result.libraryId !== libraryId.value) {
        throw new Error('Библиотека изменилась.');
      }
      
      uploads.value.push(result);
      
      return result;
    } finally {
      uploading.delete(controller);
    }
  };

  /**
   * Любая mutation обновляет UI только в своём поколении и текущем marker.
   * Сервер остаётся владельцем принадлежности model/version и последнего допуска.
   */
  const mutation = async <T extends { libraryId: string }>(work: Promise<T>) => {
    const generation = epoch;
    
    busy.value += 1;
    
    try {
      const result = await work;
      
      if (generation !== epoch || result.libraryId !== libraryId.value) {
        throw new Error('Библиотека изменилась.');
      }
      
      await Promise.all([loadModels(), loadTasks(), openedModel.value
        ? openModel(openedModel.value, selectedVersion.value) : Promise.resolve()]);
      
      return result;
    } catch (cause) {
      if (generation === epoch) {
        rememberError(cause);
      }
      
      throw cause;
    } finally { if (generation === epoch) {
      busy.value = Math.max(0, busy.value - 1);
    } }
  };

  const patchModel = (model: string, patch: Record<string, unknown>) =>
    mutation(studio3dApi.patchModel(model, { ...patch, libraryId: libraryId.value }));
  const deleteModel = (model: string) => mutation(studio3dApi.deleteModel(model, libraryId.value));
  const deleteVersion = (model: string, vid: string) => mutation(studio3dApi.deleteVersion(model,
    vid, libraryId.value));
  const lighten = (model: string, vid: string, force = false) =>
    mutation(studio3dApi.lighten(model, vid, { libraryId: libraryId.value, force }));
  const redownload = (model: string, vid: string) =>
    mutation(studio3dApi.redownload(model, vid, { libraryId: libraryId.value }));
  const save = (model: string, vid: string, input: Record<string, unknown>) =>
    mutation(studio3dApi.save(model, vid, { ...input, libraryId: libraryId.value }));
  const addFromFile = (model: string, input: Record<string, unknown>) =>
    mutation(studio3dApi.fromFile(model, { ...input, libraryId: libraryId.value }));
  const createFromFile = (input: Record<string, unknown>) =>
    mutation(studio3dApi.createModel({ ...input, libraryId: libraryId.value }));
  const importExternal = (provider: string, taskId: string) =>
    mutation(studio3dApi.importTask(provider, taskId, libraryId.value));
  const scan = () => mutation(studio3dApi.scan(libraryId.value));
  const loadJob = (id: string) => studio3dApi.job(id, libraryId.value);
  const reconcileChild = (intent: string, child: string, taskId: string) =>
    mutation(studio3dApi.reconcile(intent, child, { libraryId: libraryId.value, taskId }));
  const closeUnknownChild = (intent: string, child: string) =>
    mutation(studio3dApi.closeUnknown(intent, child, { libraryId: libraryId.value }));

  return {
    state,
    models,
    total,
    query,
    filters,
    detail,
    offers,
    quoted,
    tasks,
    uploads,
    busy,
    error,
    broken,
    selectedVersion,
    openedModel,
    viewingModel,
    setViewingModel,
    active,
    libraryId,
    pending,
    loadState,
    loadModels,
    search,
    openModel,
    loadOffers,
    quote,
    run,
    retry,
    batchQuote,
    batchRun,
    upload,
    patchModel,
    deleteModel,
    deleteVersion,
    lighten,
    redownload,
    save,
    addFromFile,
    createFromFile,
    loadTasks,
    importExternal,
    scan,
    loadJob,
    reconcileChild,
    closeUnknownChild,
    start,
    stop,
    refresh,
    recoverPending
  };
});
