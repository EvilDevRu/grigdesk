import { defineStore } from 'pinia';
import { api, failureText } from '../shared/apiClient.ts';
import { ACTIVE_UPDATE_STATES, grigDeskUpdateTone } from '../shared/grigdeskUpdate.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import type {
  CheckoutState,
  LatestRelease,
  ReleaseStatus,
  RunningRelease,
  UpdateJob,
} from '../../../shared/runtime/grigDeskUpdateContracts.ts';

export * from '../shared/grigdeskUpdate.ts';

type ReleaseSnapshot = Omit<Partial<ReleaseStatus>, 'checkout' | 'running' | 'latest'> & {
  checkout?: Partial<CheckoutState>;
  running?: Partial<RunningRelease>;
  latest?: Partial<LatestRelease> | null;
};

const t = localeTranslator(uiLocalePort);

let pollTimer: ReturnType<typeof setInterval> | null = null;
let statusTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Частичный ответ старого сервера сохраняет отсутствие необязательных полей.
 * Существующие поля версии проверяются до замены последнего удачного снимка.
 */
function isReleaseSnapshot(value: unknown): value is ReleaseSnapshot {
  if (!isRecord(value) || !isJobEnvelope(value)) {
    return false;
  }

  for (const key of ['checkout', 'running', 'latest']) {
    const part = value[key];

    if (part == null) {
      continue;
    }
    if (!isRecord(part)) {
      return false;
    }

    const textFields = ['sha', 'tag', 'version', 'stableVersion', 'exactTag', 'productVersion',
      'instanceId', 'startedAt', 'url', 'branch'];

    for (const field of textFields) {
      if (part[field] != null && typeof part[field] !== 'string') {
        return false;
      }
    }

    if (!['versionTagMismatch', 'dirty', 'detached']
      .every((field) => part[field] == null || typeof part[field] === 'boolean')) {
      return false;
    }
  }

  const flagFields = ['checkoutChanged', 'updateAvailable', 'canApplyCheckout',
    'canInstallRelease', 'targetDescendsFromCheckout'];

  for (const key of flagFields) {
    if (value[key] != null && typeof value[key] !== 'boolean') {
      return false;
    }
  }
  for (const key of ['applyBlockReasons', 'installBlockReasons', 'blockReasons']) {
    const reasons = value[key];

    if (reasons != null && (!Array.isArray(reasons) || !reasons.every((item) => typeof item === 'string'))) {
      return false;
    }
  }

  if (!['checkoutRelation', 'checkedAt']
    .every((key) => value[key] == null || typeof value[key] === 'string')) {
    return false;
  }
  if (value.checkError != null && (!isRecord(value.checkError)
    || typeof value.checkError.code !== 'string' || typeof value.checkError.message !== 'string')) {
    return false;
  }
  if (value.packageUpdate != null && (!isRecord(value.packageUpdate)
    || typeof value.packageUpdate.version !== 'string'
    || typeof value.packageUpdate.archiveSha256 !== 'string')) {
    return false;
  }
  if (value.updateCapability != null) {
    const capability = value.updateCapability;

    if (!isRecord(capability) || (capability.kind !== 'source' && capability.kind !== 'package')
      || (capability.kind === 'package' && typeof capability.message !== 'string')) {
      return false;
    }
  }

  return true;
}

/**
 * Ответ отдельного задания не подменяет состояние, если его статус повреждён.
 * Нулевое задание допустимо и по-прежнему завершает быстрый опрос.
 */
function isJobEnvelope(value: unknown): value is Record<string, unknown> & { job?: UpdateJob | null } {
  if (!isRecord(value)) {
    return false;
  }
  if (value.job == null) {
    return true;
  }

  const job = value.job;

  if (!isRecord(job) || typeof job.id !== 'string' || typeof job.status !== 'string') {
    return false;
  }

  const textFields = ['kind', 'stage', 'targetSha', 'targetVersion', 'previousRunningInstanceId',
    'expectedRuntimeBuildId', 'expectedDeepSeekBinary', 'previousRuntimeBuildId',
    'publicationStage', 'completedAt'];

  if (!textFields.every((key) => job[key] == null || typeof job[key] === 'string')) {
    return false;
  }
  if (job.progress != null && (!isRecord(job.progress)
    || typeof job.progress.downloadedBytes !== 'number'
    || typeof job.progress.totalBytes !== 'number'
    || !Number.isFinite(job.progress.downloadedBytes)
    || !Number.isFinite(job.progress.totalBytes)
    || job.progress.downloadedBytes < 0 || job.progress.totalBytes < 0)) {
    return false;
  }
  if (job.error != null && (!isRecord(job.error)
    || !['code', 'message'].every((key) => isRecord(job.error)
      && (job.error[key] == null || typeof job.error[key] === 'string')))) {
    return false;
  }

  return job.backups == null || (isRecord(job.backups)
    && Object.values(job.backups).every((item) => item === null || typeof item === 'string'));
}

/**
 * Сужает снимок без копирования и без заполнения отсутствующих полей.
 * Штатная ветка отказа стора сохраняет прежнюю версию при неверном JSON.
 */
function releaseSnapshot(value: unknown): ReleaseSnapshot {
  if (!isReleaseSnapshot(value)) {
    throw new Error(t('core.invalidUpdateStatus'));
  }

  return value;
}

export const useGrigDeskUpdateStore = defineStore('grigdesk-update', {
  state: () => ({
    status: null as ReleaseSnapshot | null,
    loading: false,
    checking: false,
    actionBusy: false,
    error: '',
    initialized: false,
  }),
  getters: {
    /**
     * Процент доступен только при известном размере скачиваемого архива.
     * Округление вниз не показывает завершение до получения последнего байта.
     */
    packageProgress(state) {
      const progress = state.status?.job?.progress;

      if (!progress || !progress.totalBytes) {
        return null;
      }

      return Math.floor((progress.downloadedBytes / progress.totalBytes) * 100);
    },

    tone: (state) => grigDeskUpdateTone(state.status),
    active: (state) => ACTIVE_UPDATE_STATES.has(state.status?.job?.status ?? ''),
  },
  actions: {
    /**
     * Редкая локальная проверка не создаёт второй таймер при повторном старте.
     * Она замечает изменение checkout без удалённой проверки релизов.
     */
    start() {
      this.load();

      if (statusTimer) {
        return;
      }

      statusTimer = setInterval(() => {
        this.load({ quiet: true });
      }, 60_000);
    },

    /**
     * Публикует только проверенную версию и включает опрос активного задания.
     * Тихий отказ оставляет прежний текст ошибки и последний удачный снимок.
     */
    async load({ quiet = false } = {}): Promise<ReleaseSnapshot | null> {
      if (!quiet) {
        this.loading = true;
      }

      try {
        this.status = releaseSnapshot(await api.get('/api/system/version'));
        this.error = '';
        this.initialized = true;

        if (this.active) {
          this.startJobPolling();
        }

        return this.status;
      } catch (error) {
        if (!quiet) {
          this.error = failureText(error);
        }

        return null;
      } finally {
        if (!quiet) {
          this.loading = false;
        }
      }
    },

    /**
     * Проверяет релиз одним запросом, сохраняя блокировку до его завершения.
     * Неверный ответ не заменяет показанную версию.
     */
    async check(): Promise<ReleaseSnapshot | null> {
      if (this.checking) {
        return this.status;
      }

      this.checking = true;
      this.error = '';

      try {
        this.status = releaseSnapshot(await api.post('/api/system/version/check', {}));

        return this.status;
      } catch (error) {
        this.error = failureText(error);

        return null;
      } finally {
        this.checking = false;
      }
    },

    /**
     * Применяет только показанный checkout с прежним запретом грязного дерева.
     * Параллельное действие обновления не запускается.
     */
    async applyCheckout() {
      const sha = this.status?.checkout?.sha;

      if (!sha || this.actionBusy) {
        return null;
      }

      return this._start('/api/system/apply', { expectedCheckoutSha: sha, allowDirty: false });
    },

    /**
     * Устанавливает выбранный релиз относительно подтверждённого checkout.
     * При отсутствии версии запрос не отправляется.
     */
    async installRelease() {
      const tag = this.status?.latest?.tag;
      const sha = this.status?.checkout?.sha;

      if (!tag || !sha || this.actionBusy) {
        return null;
      }

      return this._start('/api/system/update', { targetTag: tag, expectedCheckoutSha: sha });
    },

    /**
     * Обновление пакета запускается только с показанной и подтверждённой записью канала.
     * Параллельное действие остаётся заблокированным на время запроса.
     */
    async installPackage() {
      const target = this.status?.packageUpdate;

      if (!target || this.actionBusy) {
        return null;
      }

      return this._start('/api/system/package-update', {
        expectedVersion: target.version,
        expectedArchiveSha256: target.archiveSha256,
      });
    },

    /**
     * Запуск команды не повторяется при неизвестном исходе подтверждения.
     * Прежний тихий GET после отказа уточняет состояние сервера.
     */
    async _start(endpoint: string, body: Record<string, unknown>): Promise<UpdateJob | null | undefined> {
      this.actionBusy = true;
      this.error = '';

      try {
        const result = await api.post(endpoint, body);

        if (!isJobEnvelope(result)) {
          throw new Error(t('core.invalidUpdateJob'));
        }

        this.status = { ...this.status, job: result.job };
        this.startJobPolling();

        return result.job;
      } catch (error) {
        this.error = failureText(error);
        await this.load({ quiet: true });

        return null;
      } finally {
        this.actionBusy = false;
      }
    },

    startJobPolling() {
      if (pollTimer) {
        return;
      }

      pollTimer = setInterval(() => {
        this.pollJob();
      }, 1000);
    },

    /**
     * Быстрый опрос прекращается только после проверенного завершения задания.
     * Сетевой отказ при рестарте сервера оставляет цепочку ожидания живой.
     */
    async pollJob(): Promise<UpdateJob | null | undefined> {
      try {
        const result = await api.get('/api/system/update-job');

        if (!isJobEnvelope(result)) {
          throw new Error(t('core.invalidUpdateJob'));
        }
        if (this.status) {
          this.status = { ...this.status, job: result.job };
        } else {
          await this.load({ quiet: true });
        }
        if (!ACTIVE_UPDATE_STATES.has(result.job?.status ?? '')) {
          this.stopJobPolling();
          await this.load({ quiet: true });
        }

        return result.job;
      } catch {
        return null;
      }
    },

    stopJobPolling() {
      if (pollTimer) {
        clearInterval(pollTimer);
      }

      pollTimer = null;
    },

    stop() {
      this.stopJobPolling();

      if (statusTimer) {
        clearInterval(statusTimer);
      }

      statusTimer = null;
    },
  },
});
