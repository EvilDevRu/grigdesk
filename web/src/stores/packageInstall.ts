import { defineStore } from 'pinia';
import { ref, onScopeDispose } from 'vue';

import { api, failureText } from '../shared/apiClient.ts';
import { isActiveInstallJob, isTerminalInstallJob } from '../shared/pluginInstall.ts';
import {
  decodeInstallVersions,
  decodeInstallCurrent,
  decodeInstallJobResponse,
  decodeInstallChecks,
  decodeStoredRollback,
  decodeInstallRemoval,
  PluginInstallProtocolError,
} from '../shared/pluginInstallApi.ts';
import type { PluginVersionRef, PluginInstallJob } from '../../../shared/plugins/pluginInstallContracts.ts';
import type { PluginInstallInfo } from '../../../shared/plugins/pluginInstallContracts.ts';

export interface InstallSubject {
  compatibility?: {
    status: string;
    code: string | null;
    reason: string | null;
  };
  id: string;
  name: string;
  install?: PluginInstallInfo | null;
}

interface PackageInstallPreset {
  storeId: string;
  basePath: string;
  itemSegment: string;
  rollbackKey: string;
  viewedKey: string;
  refresh: () => Promise<unknown>;
}

interface RollbackIntent {
  pluginId: string;
  body: {
    requestId: string;
    expectedRevision: number;
    expectedPreviousDigest: string;
  };
}

interface PendingRequest {
  kind: 'start' | 'apply' | 'cancel' | 'rollback';
  jobId?: string;
}

/**
 * Известный HTTP отказ отличается от потери ответа после серверного commit.
 * Unknown transport не считается доказательством неуспешной файловой замены.
 */
function httpStatus(cause: unknown): number | null {
  if (cause !== null && typeof cause === 'object' && 'status' in cause
    && typeof cause.status === 'number' && Number.isInteger(cause.status)) {
    return cause.status;
  }

  return null;
}

/**
 * Общий store сохраняет polling и согласование неизвестных исходов для обоих родов.
 * Preset разделяет API, Pinia и browser storage, не меняя протокол установки.
 */
export function createPackageInstallStore(preset: PackageInstallPreset) {
  const { basePath, itemSegment, rollbackKey: ROLLBACK_KEY, viewedKey: VIEWED_KEY } = preset;

  return defineStore(preset.storeId, () => {
  const job = ref<PluginInstallJob | null>(null);
  const versions = ref<PluginVersionRef[]>([]);
  const versionsUrl = ref('');
  const versionsInputKey = ref('');
  const versionsLoading = ref(false);
  const versionsError = ref<string | null>(null);
  const busy = ref(false);
  const checking = ref(false);
  const error = ref<string | null>(null);
  const recoveryError = ref<{ code: string; message: string } | null>(null);
  const reconciling = ref(false);
  const pendingAction = ref<string | null>(null);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let jobEpoch = 0;
  let versionsEpoch = 0;
  let pendingRollback: RollbackIntent | null = null;
  let pendingRequest: PendingRequest | null = null;
  let pollFlight: Promise<void> | null = null;
  let checkFlight: Promise<void> | null = null;
  let pollDelay = 1000;
  let authStopped = false;
  let storageError: { code: string; message: string } | null = null;
  const controllers = new Set<AbortController>();
  const refreshed = new Set<string>();
  const unavailableOutcomes = new Set<string>();
  const viewed = new Set<string>();

  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(VIEWED_KEY);
    const values: unknown = raw ? JSON.parse(raw) : [];

    if (Array.isArray(values)) {
      for (const value of values.slice(-32)) {
        if (typeof value === 'string') {
          viewed.add(value);
        }
      }
    }
  } catch {
    // Отметка прочитанного — UI предпочтение и не является разрешением мутации.
  }

  try {
    const saved = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(ROLLBACK_KEY);

    if (saved) {
      pendingRollback = decodeStoredRollback(JSON.parse(saved));
      pendingRequest = { kind: 'rollback' };
      pendingAction.value = 'rollback';
      reconciling.value = true;
    }
  } catch (cause: unknown) {
    storageError = {
      code: 'protocol_error',
      message: failureText(cause, 'Не удалось прочитать сохранённое намерение отката.'),
    };
    recoveryError.value = storageError;
  }

  /**
   * Подтверждённый commit обновляет каталог один раз для данного job и revision.
   * Повторный GET outcome не запускает discovery или сброс пользовательских prefs.
   */
  async function acceptJob(next: PluginInstallJob | null): Promise<void> {
    if (disposed || next && job.value?.id === next.id && next.revision < job.value.revision) {
      return;
    }

    const key = next ? `${next.id}:${next.revision}` : '';

    job.value = isTerminalInstallJob(next) && viewed.has(key) ? null : next;

    if (next?.status === 'done') {
      if (!refreshed.has(key)) {
        refreshed.add(key);
        await preset.refresh();
      }
    }
  }

  /**
   * Один timeout создаётся после ответа, чтобы медленная сеть не копила polling.
   * Таймер относится только к этому экземпляру Pinia и не живёт в reactive state.
   */
  function schedulePoll(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }

    if (!disposed && !authStopped && !pendingRollback
      && (isActiveInstallJob(job.value) || reconciling.value)) {
      timer = setTimeout(() => {
        timer = null;
        void pollJob();
      }, pollDelay);
    }
  }

  /**
   * Current восстанавливает публичное задание и отдельную причину блокировки.
   * Ошибка чтения показывается человеку, затем активное задание продолжает polling.
   */
  async function pollJob(): Promise<void> {
    if (disposed) {
      return;
    }

    if (pollFlight) {
      return pollFlight;
    }

    pollFlight = readCurrent().finally(() => {
      pollFlight = null;
    });

    return pollFlight;
  }

  /**
   * Один read владеет своим AbortController и фиксирует поколение до сети.
   * Dispose и более новая мутация лишают поздний ответ права изменить store.
   */
  async function readCurrent(): Promise<void> {
    if (pendingAction.value === 'remove') {
      return;
    }

    if (reconciling.value && pendingRequest && pendingRequest.kind !== 'rollback') {
      await reconcile();
      schedulePoll();

      return;
    }

    const epoch = jobEpoch;
    const boundId = pendingRequest?.jobId;
    const controller = new AbortController();

    controllers.add(controller);

    try {
      const path = boundId ? `${basePath}/jobs/${boundId}` : `${basePath}/jobs/current`;
      const result = decodeInstallCurrent(await api.get(path, {
        retry: false,
        signal: controller.signal,
      }));

      if (boundId && result.job?.id !== boundId) {
        throw new PluginInstallProtocolError();
      }

      if (!disposed && epoch === jobEpoch) {
        await acceptJob(result.job);
        recoveryError.value = storageError ?? result.recoveryError;
        pollDelay = 1000;
        error.value = null;
      }
    } catch (cause: unknown) {
      if (!disposed && epoch === jobEpoch) {
        error.value = failureText(cause, 'Не удалось прочитать состояние установки.');
        pollDelay = Math.min(10000, pollDelay * 2);
        authStopped = [401, 403].includes(httpStatus(cause) ?? 0);

        if (cause instanceof PluginInstallProtocolError) {
          recoveryError.value = { code: 'protocol_error', message: error.value };
        }
      }
    } finally {
      controllers.delete(controller);
      schedulePoll();
    }
  }

  /**
   * Открытие диалога читает серверное состояние перед выбором нового источника.
   * Закрытие диалога не отменяет polling уже запущенного задания.
   */
  async function loadJob(): Promise<void> {
    if (pendingRollback && reconciling.value) {
      await replayRollback();

      return;
    }

    await pollJob();
  }

  /**
   * Подготовка отправляет источник и выбранную версию без файлового apply.
   * ExpectedId нужен только при явной привязке ручного пакета к источнику.
   */
  async function startInstall(
    url: string,
    version: string,
    replaceModified = false,
    expectedId?: string,
    expectedSha?: string,
  ): Promise<void> {
    const input = url.trim();

    if (versionsInputKey.value && (!versionsUrl.value || versionsLoading.value || !versions.value.length
      || input !== versionsInputKey.value && input !== versionsUrl.value)) {
      versionsError.value = 'Сначала найдите версии для текущего адреса.';

      return;
    }

    await postJob(`${basePath}/jobs`, {
      url: versionsUrl.value || url.trim(),
      ...(version ? { version } : {}),
      ...(replaceModified ? { replaceModified } : {}),
      ...(expectedId ? { expectedId } : {}),
      ...(expectedSha ? { expectedSha } : {}),
    });
  }

  /**
   * Одновременные clicks допускают только одну мутацию и один принятый job.
   * Ошибка транспорта остаётся отдельной от предыдущего проверенного snapshot.
   */
  async function postJob(
    path: string,
    body: unknown,
    request: PendingRequest = { kind: 'start' },
  ): Promise<boolean> {
    if (busy.value || reconciling.value || recoveryError.value || disposed) {
      return false;
    }

    busy.value = true;
    error.value = null;
    pendingRequest = request;
    pendingAction.value = request.kind;
    jobEpoch += 1;

    const controller = new AbortController();

    controllers.add(controller);

    try {
      const next = decodeInstallJobResponse(await api.post(path, body, { signal: controller.signal }));

      if (disposed) {
        return false;
      }

      await acceptJob(next);

      if (!disposed) {
        pendingRequest = null;
        pendingAction.value = null;
      }

      return true;
    } catch (cause: unknown) {
      if (!disposed) {
        error.value = failureText(cause, 'Не удалось начать установку.');

        const status = httpStatus(cause);

        if (status !== null && status >= 400 && status < 500) {
          pendingRequest = null;
          pendingAction.value = null;
          authStopped = [401, 403].includes(status);

          return true;
        } else {
          reconciling.value = true;

          return request.kind === 'rollback' ? false : await reconcile();
        }
      }

      return false;
    } finally {
      controllers.delete(controller);

      if (!disposed) {
        busy.value = false;
      }

      schedulePoll();
    }
  }

  /**
   * Потерянный ответ сверяется по исходному job id, даже если current уже другой.
   * Read не повторяет файловую мутацию и держит capability закрытой до известного outcome.
   */
  async function reconcile(): Promise<boolean> {
    if (pendingRollback) {
      return replayRollback();
    }

    const request = pendingRequest;

    if (!request || disposed) {
      return false;
    }

    const controller = new AbortController();

    controllers.add(controller);

    try {
      const path = request.jobId ? `${basePath}/jobs/${request.jobId}`
        : `${basePath}/jobs/current`;
      const result = decodeInstallCurrent(await api.get(path, {
        retry: false,
        signal: controller.signal,
      }));

      if (disposed || pendingRequest !== request) {
        return false;
      }

      recoveryError.value = storageError ?? result.recoveryError;

      if (!result.job || request.jobId && result.job.id !== request.jobId) {
        return false;
      }

      await acceptJob(result.job);

      if (request.kind === 'start' || !isActiveInstallJob(result.job)) {
        pendingRequest = null;
        pendingAction.value = null;
        reconciling.value = false;
        error.value = null;

        return true;
      }

      return false;
    } catch (cause: unknown) {
      if (!disposed) {
        error.value = failureText(cause, 'Не удалось уточнить исход операции.');
        pollDelay = Math.min(10000, pollDelay * 2);
        authStopped = [401, 403].includes(httpStatus(cause) ?? 0);

        if (httpStatus(cause) === 404 && request.jobId) {
          error.value = 'Результат операции больше недоступен. Каталог обновлён; повтор не выполнялся.';

          if (!unavailableOutcomes.has(request.jobId)) {
            unavailableOutcomes.add(request.jobId);
            await preset.refresh();
          }
        }
      }

      return false;
    } finally {
      controllers.delete(controller);
    }
  }

  /**
   * Replay повторяет только durable rollback body, чей UUID уже известен серверу.
   * Потерянный ответ не создаёт новый intent и не разрешает второй откат по другой revision.
   */
  async function replayRollback(): Promise<boolean> {
    const intent = pendingRollback;

    if (!intent || disposed || busy.value) {
      return false;
    }

    busy.value = true;
    reconciling.value = true;
    pendingAction.value = 'rollback';
    jobEpoch += 1;

    const controller = new AbortController();

    controllers.add(controller);

    try {
      const result = decodeInstallJobResponse(await api.post(
        `${basePath}/${itemSegment}/${encodeURIComponent(intent.pluginId)}/rollback`,
        intent.body,
        { signal: controller.signal },
      ));

      if (disposed) {
        return false;
      }

      await acceptJob(result);
      clearRollback();
      error.value = null;

      return true;
    } catch (cause: unknown) {
      if (!disposed) {
        error.value = failureText(cause, 'Не удалось уточнить исход отката.');

        if (httpStatus(cause) === 409) {
          clearRollback();
          await preset.refresh();

          return true;
        }
      }

      return false;
    } finally {
      controllers.delete(controller);

      if (!disposed) {
        busy.value = false;
      }
    }
  }

  /**
   * Известный rollback outcome снимает durable намерение и запирающий UI флаг.
   * Серверный receipt остаётся источником истины при возможном повторе старой вкладки.
   */
  function clearRollback(): void {
    sessionStorage.removeItem(ROLLBACK_KEY);
    pendingRollback = null;
    pendingRequest = null;
    pendingAction.value = null;
    reconciling.value = false;
  }

  /**
   * Обновление привязано к установленному id и не меняет источник пользователя.
   * Version и force относятся к этой подготовке и не меняют ручные prefs каталога.
   */
  async function startUpdate(
    id: string,
    version: string,
    replaceModified = false,
    expectedSha?: string,
  ): Promise<void> {
    await postJob(`${basePath}/${itemSegment}/${encodeURIComponent(id)}/update`, {
      ...(version ? { version } : {}),
      replaceModified,
      ...(expectedSha ? { expectedSha } : {}),
    });
  }

  /**
   * Применение требует проверенного job и подтверждённого reviewToken.
   * Известный отказ не подменяет прежнюю ready карточку и позволяет увидеть причину.
   */
  async function apply(): Promise<void> {
    const current = job.value;

    if (current?.status !== 'ready' || !current.reviewToken) {
      return;
    }

    await postJob(`${basePath}/jobs/${current.id}/apply`, {
      reviewToken: current.reviewToken,
    }, { kind: 'apply', jobId: current.id });
  }

  /**
   * Отмена принадлежит текущему job и сохраняет серверный terminal outcome.
   * Поздний polling не должен вернуть отменённый job в running.
   */
  async function cancel(): Promise<void> {
    const current = job.value;

    if (!current || !['running', 'ready', 'awaiting_restart'].includes(current.status)) {
      return;
    }

    await postJob(`${basePath}/jobs/${current.id}/cancel`, {}, {
      kind: 'cancel',
      jobId: current.id,
    });
  }

  /**
   * Откат использует snapshot plugin вместо принятия InstallInfo как job.
   * Намерение записано до POST и снимается лишь после известного серверного исхода.
   */
  async function rollback(plugin: InstallSubject): Promise<void> {
    if (busy.value || reconciling.value || recoveryError.value || disposed || !plugin.install?.previous
      || !plugin.install.rollbackAvailable) {
      return;
    }

    pendingRollback = {
      pluginId: plugin.id,
      body: {
        requestId: crypto.randomUUID(),
        expectedRevision: plugin.install.revision,
        expectedPreviousDigest: plugin.install.previous.payloadDigest,
      },
    };

    try {
      sessionStorage.setItem(ROLLBACK_KEY, JSON.stringify(pendingRollback));
    } catch (cause: unknown) {
      error.value = failureText(cause, 'Не удалось сохранить намерение отката.');
      pendingRollback = null;

      return;
    }

    const known = await postJob(`${basePath}/${itemSegment}/${encodeURIComponent(plugin.id)}/rollback`,
      pendingRollback.body, { kind: 'rollback' });

    if (known) {
      clearRollback();
    }
  }

  /**
   * Удаление занимает тот же допуск, что установка; повторный POST не запускается.
   * После потери ответа перечитывается каталог, но успех без подтверждения не объявляется.
   */
  async function remove(id: string): Promise<boolean> {
    if (busy.value || reconciling.value || recoveryError.value || pendingAction.value || disposed
      || isActiveInstallJob(job.value) || job.value?.status === 'ready'
      || job.value?.status === 'awaiting_restart'
      || job.value?.status === 'recovery_required') {
      return false;
    }

    busy.value = true;
    pendingAction.value = 'remove';
    error.value = null;
    jobEpoch += 1;

    const controller = new AbortController();
    let removed = false;

    controllers.add(controller);

    try {
      decodeInstallRemoval(await api.post(
        `${basePath}/${itemSegment}/${encodeURIComponent(id)}/remove`,
        {},
        { signal: controller.signal },
      ), id);

      if (disposed) {
        return false;
      }

      if (job.value?.pluginId === id) {
        job.value = null;
      }

      removed = true;
    } catch (cause: unknown) {
      if (!disposed) {
        error.value = failureText(cause);
      }
    } finally {
      controllers.delete(controller);

      if (!disposed) {
        try {
          await preset.refresh();
        } catch (cause: unknown) {
          error.value = failureText(cause);
        } finally {
          pendingAction.value = null;
          busy.value = false;
        }
      }
    }

    return removed && !disposed;
  }

  /**
   * Проверка всех источников обновляет каталог после серверного результата.
   * Отдельный флаг checking не подменяет job подготовки или применения.
   */
  async function checkUpdates(): Promise<void> {
    if (checkFlight) {
      return checkFlight;
    }

    if (recoveryError.value || reconciling.value || disposed) {
      return;
    }

    checkFlight = performCheck().finally(() => {
      checkFlight = null;
    });

    return checkFlight;
  }

  /**
   * Проверка источников владеет controller, как другие reads этого экземпляра.
   * После dispose ответ больше не публикуется и не запускает каталог из чужого lifecycle.
   */
  async function performCheck(): Promise<void> {
    checking.value = true;
    error.value = null;

    const controller = new AbortController();

    controllers.add(controller);

    try {
      decodeInstallChecks(await api.post(`${basePath}/check`, {}, { signal: controller.signal }));
    } catch (cause: unknown) {
      if (!disposed) {
        error.value = failureText(cause, 'Не удалось проверить обновления.');
      }
    } finally {
      controllers.delete(controller);

      if (!disposed) {
        checking.value = false;
        await preset.refresh();
      }
    }
  }

  /**
   * Явно прочитанный результат можно скрыть без удаления серверной истории.
   * Active и ready не исчезают из-за закрытия диалога.
   */
  function forgetJob(): boolean {
    const current = job.value;

    if (!current || !isTerminalInstallJob(current) || busy.value || reconciling.value) {
      return false;
    }

    viewed.add(`${current.id}:${current.revision}`);

    try {
      sessionStorage.setItem(VIEWED_KEY, JSON.stringify([...viewed].slice(-32)));
    } catch {
      // Без browser storage отметка сохраняется до уничтожения экземпляра store.
    }

    job.value = null;

    return true;
  }

  onScopeDispose(() => {
    disposed = true;
    jobEpoch += 1;

    for (const controller of controllers) {
      controller.abort();
    }

    if (timer !== null) {
      clearTimeout(timer);
    }
  });

  /**
   * Поиск принимает только новый проверенный список для конкретного ввода.
   * Канонический адрес сохраняется отдельно, чтобы нормализация не ломала input key.
   */
  async function listVersions(url: string): Promise<void> {
    if (disposed) {
      return;
    }

    invalidateVersions(url);
    versionsLoading.value = true;

    const epoch = versionsEpoch;
    const controller = new AbortController();

    controllers.add(controller);

    try {
      const result = decodeInstallVersions(await api.post(`${basePath}/versions`, {
        url: versionsInputKey.value,
      }, { signal: controller.signal }));

      if (!disposed && epoch === versionsEpoch) {
        versions.value = result.versions;
        versionsUrl.value = result.source.url;
      }
    } catch (error: unknown) {
      if (!disposed && epoch === versionsEpoch) {
        versionsError.value = failureText(error, 'Не удалось получить версии.');
      }
    } finally {
      controllers.delete(controller);

      if (!disposed && epoch === versionsEpoch) {
        versionsLoading.value = false;
      }
    }
  }

  /**
   * Изменившийся ввод лишает прежний список права начать подготовку.
   * Сам текст сохраняется отдельно от канонического source из ответа сервера.
   */
  function invalidateVersions(url: string): void {
    versionsEpoch += 1;
    versionsInputKey.value = url.trim();
    versions.value = [];
    versionsUrl.value = '';
    versionsError.value = null;
    versionsLoading.value = false;
  }

  return {
    job,
    versions,
    versionsUrl,
    versionsInputKey,
    versionsLoading,
    versionsError,
    busy,
    checking,
    error,
    recoveryError,
    reconciling,
    pendingAction,
    listVersions,
    invalidateVersions,
    loadJob,
    pollJob,
    startInstall,
    startUpdate,
    apply,
    cancel,
    rollback,
    remove,
    checkUpdates,
    forgetJob,
    reconcile,
  };
});
}
