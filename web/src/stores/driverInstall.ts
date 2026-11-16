import { defineStore } from 'pinia';
import { toRaw } from 'vue';

import { isRecord } from '../../../shared/lib/objects.ts';
import { api, ApiError, failureText } from '../shared/apiClient.ts';
import {
  decodeDriverInstallChecks, decodeDriverInstallResponse, decodeDriverRemoval, decodeDriverSources,
} from '../shared/driverInstallApi.ts';
import type { DriverInstallJob } from '../shared/driverInstallApi.ts';
import { decodeInstallVersions, decodeStoredRollback } from '../shared/pluginInstallApi.ts';
import type { PluginInstallInfo, PluginVersionRef } from '../../../shared/plugins/pluginInstallContracts.ts';
import { useTrackersStore } from './trackers.ts';
import { confirmDialog, messageRef } from '../ui.ts';

const ROLLBACK_KEY = 'grigdesk-driver-install-rollback';
const ACKNOWLEDGED_KEY = 'grigdesk-driver-install-acknowledged';

type RollbackIntent = ReturnType<typeof decodeStoredRollback>;
export type DriverInstallRequest =
  | { kind: 'install' | 'resume' }
  | { kind: 'update' | 'version' | 'restore' | 'rollback'; id: string };

type InstallScreen = 'idle' | 'source' | 'version' | 'review' | 'progress' | 'result' | 'rollback';

export const useDriverInstallStore = defineStore('driver-install', {
  state: () => ({
    screen: 'idle' as InstallScreen,
    flow: 'install' as 'install' | 'update' | 'rollback',
    loading: true,
    acknowledgedJobId: '',
    updateDriverId: null as string | null,
    rollbackPreview: null as { id: string; record: PluginInstallInfo } | null,
    selectedSource: undefined as string | null | undefined,
    customUrl: '',
    manualVersion: false,
    replaceModified: false,
    unknownOutcome: false,
    refreshError: '',
    errorCode: '',
    pendingRemoval: null as string | null,
    jobRestartRequired: false,
    job: null as DriverInstallJob | null,
    installed: {} as Record<string, PluginInstallInfo>,
    versions: [] as PluginVersionRef[],
    versionsEmpty: false,
    sources: [] as { title: string; url: string }[],
    sourcesLoading: false,
    sourcesError: '',
    busy: false,
    removing: false,
    error: '',
    recoveryError: '',
    previousUnavailable: false,
    restartRequired: false,
    pendingRollback: null as RollbackIntent | null,
    restored: false,
    url: '',
    tag: '',
  }),
  getters: {
    active: (state) => !!state.job && ['running', 'ready', 'applying'].includes(state.job.status),
    blocked(): boolean {
      return this.busy || this.active || this.unknownOutcome
        || !!this.pendingRollback || !!this.recoveryError;
    },
  },
  actions: {
    /**
     * Открытие диалога читает только локальный каталог, без проверки репозиториев.
     * Ошибка каталога сохраняет ручной ввод и не становится rejected promise lifecycle.
     */
    async loadSources() {
      if (this.sourcesLoading) {
        return;
      }

      this.sourcesLoading = true;
      this.sourcesError = '';

      try {
        this.sources = decodeDriverSources(await api.get('/api/trackers/sources'));
      } catch (error) {
        this.sourcesError = failureText(error);
      } finally {
        this.sourcesLoading = false;
      }
    },
    /**
     * Один допуск охватывает подготовку CAS и сам POST, включая повтор неизвестного исхода.
     * Ошибка сохраняет черновик, job и намерение отката для следующего открытия диалога.
     */
    async run(operation: () => Promise<void>, mutation = false): Promise<boolean> {
      if (this.busy) {
        return false;
      }

      this.busy = true;
      this.error = '';
      this.errorCode = '';
      this.previousUnavailable = false;

      try {
        await operation();

        return true;
      } catch (error) {
        this.error = failureText(error);
        this.errorCode = error instanceof ApiError && isRecord(error.data)
          ? String(error.data.error ?? '') : '';

        if (mutation && !(error instanceof ApiError && error.status >= 400 && error.status < 500)) {
          this.unknownOutcome = true;
          this.screen = 'progress';
        } else if (this.job?.status === 'ready') {
          this.screen = 'review';
        }

        return false;
      } finally {
        this.busy = false;
      }
    },
    /**
     * Ответы одного job принимаются по монотонной ревизии; старый polling не меняет исход.
     * После публикации каталог и restart flag перечитываются из серверных записей установки.
     */
    async accept(raw: unknown) {
      const response = decodeDriverInstallResponse(raw);

      if (this.job && response.job?.id === this.job.id && response.job.revision < this.job.revision) {
        return;
      }

      if (response.job?.id === this.acknowledgedJobId
        && !['running', 'ready', 'applying'].includes(response.job.status)) {
        this.recoveryError = response.recoveryError;

        if (this.unknownOutcome) {
          this.unknownOutcome = false;
          this.screen = 'version';
        }

        return;
      }

      this.job = response.job;
      this.jobRestartRequired = response.restartRequired;
      this.restartRequired ||= response.restartRequired;
      this.recoveryError = response.recoveryError;

      const wasUnknown = this.unknownOutcome;

      this.unknownOutcome = false;

      if (!response.job && wasUnknown) {
        this.screen = 'version';
      }

      if (response.job && response.job.id !== this.acknowledgedJobId) {
        this.flow = response.job.kind;
        this.url = response.job.source.url;
        this.tag = response.job.target?.tag ?? this.tag;
        this.screen = response.job.status === 'applying' ? 'progress'
          : ['running', 'ready'].includes(response.job.status) ? 'review' : 'result';
      }

      if (response.job?.status === 'done') {
        await this.refreshAfterMutation();
      }
    },
    /**
     * Управляемые копии читаются отдельным driver API, включая previous и доступность отката.
     * Признак рестарта не выводится из статуса done: новый ещё не загруженный пакет его не требует.
     */
    async readInstalled() {
      this.installed = decodeDriverInstallChecks(await api.get('/api/driver-installs/installed'));
      this.restartRequired = Object.values(this.installed).some((record) => record.restartRequired)
        || !!useTrackersStore().catalog?.drivers.some((driver) => driver.status === 'restartRequired');
    },
    check() {
      return this.run(async () => {
        this.installed = decodeDriverInstallChecks(await api.post('/api/driver-installs/check', {}));
      });
    },
    /**
     * Подтверждённая публикация не становится отказом при ошибке обновления интерфейса.
     * Повторное чтение не повторяет уже выполненную мутацию.
     */
    async refreshAfterMutation() {
      const trackers = useTrackersStore();

      this.refreshError = '';
      trackers.invalidate();
      await trackers.load(true);

      try {
        await this.readInstalled();
        this.refreshError = trackers.error;
      } catch (error) {
        this.refreshError = failureText(error);
      }
    },
    /**
     * Намерение восстанавливается до первого чтения current, чтобы потеря ответа не создала новый requestId.
     * Хранилище имеет независимый driver namespace; decoder проверяет общую форму CAS.
     */
    async current() {
      return this.run(async () => {
        if (!this.restored) {
          const saved = window.sessionStorage.getItem(ROLLBACK_KEY);

          this.pendingRollback = saved ? decodeStoredRollback(JSON.parse(saved)) : null;
          this.acknowledgedJobId = window.sessionStorage.getItem(ACKNOWLEDGED_KEY) ?? '';
          this.restored = true;
        }

        if (this.pendingRollback) {
          await this.replayRollback();
        } else if (this.pendingRemoval) {
          await this.refreshAfterMutation();

          const driver = useTrackersStore().catalog?.drivers
            .find((entry) => entry.id === this.pendingRemoval);

          if (!this.refreshError && (!driver || driver.deleted)) {
            this.pendingRemoval = null;
            this.unknownOutcome = false;
            this.screen = 'idle';
          }
        } else {
          const endpoint = this.unknownOutcome && this.job
            ? `/api/driver-installs/jobs/${this.job.id}` : '/api/driver-installs/jobs/current';

          await this.accept(await api.get(endpoint));
        }
      });
    },
    versionsForSource() {
      return this.run(async () => {
        const url = this.url;

        this.versions = [];
        this.versionsEmpty = false;

        const result = decodeInstallVersions(await api.post('/api/driver-installs/versions', { url }));

        if (this.url !== url) {
          return;
        }

        this.versions = result.versions;
        this.versionsEmpty = this.versions.length === 0;

        if (!this.versions.some((version) => version.tag === this.tag)) {
          this.tag = this.versions[0]?.tag ?? '';
        }
      });
    },
    /**
     * Удаление выбранного пакета проходит общее подтверждение в настройках драйвера.
     * Повторный клик блокируется до ответа человека и завершения серверной операции.
     */
    async confirmRemove(id: string, name: string) {
      if (this.removing || this.blocked) {
        return;
      }

      this.removing = true;

      try {
        const accepted = await confirmDialog(messageRef('core.trackerRemoveConfirmation', { name }), {
          title: messageRef('core.trackerRemoveTitle'),
          okText: messageRef('core.trackerRemove'),
          danger: true,
        });

        if (accepted) {
          return await this.remove(id);
        }
      } finally {
        this.removing = false;
      }
    },
    /**
     * Удаление подтверждается сервером и перечитывает каталог с сохранённой tombstone-пометкой.
     * Сброс выбранного источника приходит тем же SSE, что обычная смена настройки доски.
     */
    remove(id: string) {
      if (this.blocked) {
        return;
      }

      return this.run(async () => {
        this.pendingRemoval = id;

        const result = decodeDriverRemoval(await api.post(`/api/driver-installs/drivers/${id}/remove`, {}));

        this.pendingRemoval = null;

        if (this.job?.driverId === result.id) {
          this.job = null;
        }

        this.restartRequired ||= result.restartRequired;
        await this.refreshAfterMutation();
      }, true).then((success) => {
        if (!this.unknownOutcome) {
          this.pendingRemoval = null;
        }

        return success;
      });
    },
    prepare() {
      if (this.blocked) {
        return;
      }

      this.screen = 'review';

      return this.run(async () => {
        this.versionsEmpty = false;

        const version = this.tag.trim().replace(/^v/u, '');
        const payload = { version, ...(this.replaceModified ? { replaceModified: true } : {}) };
        const raw = this.updateDriverId
          ? await api.post(`/api/driver-installs/drivers/${this.updateDriverId}/update`, payload)
          : await api.post('/api/driver-installs/jobs', { url: this.url, ...payload });

        await this.accept(raw);
      }, true).then((success) => {
        if (!success && !this.unknownOutcome) {
          this.screen = 'version';
        }

        return success;
      });
    },
    /**
     * Применение использует только показанный человеку prepared кандидат.
     * Неизвестный исход запрещает повтор до чтения состояния сервера.
     */
    apply() {
      if (this.busy || this.unknownOutcome || this.job?.status !== 'ready'
        || !this.job.reviewToken || this.recoveryError) {
        return;
      }

      const { id, reviewToken } = this.job;

      this.screen = 'progress';

      return this.run(async () => {
        await this.accept(await api.post(`/api/driver-installs/jobs/${id}/apply`, { reviewToken }));
      }, true);
    },
    cancel() {
      const id = this.job?.id;

      if (id && ['running', 'ready'].includes(this.job!.status)) {
        return this.run(async () => {
          await this.accept(await api.post(`/api/driver-installs/jobs/${id}/cancel`, {}));
        }, true);
      }
    },
    update(id?: string) {
      const driverId = id ?? this.job?.driverId;

      if (driverId && !this.blocked) {
        this.acknowledge();
        this.flow = 'update';
        this.replaceModified = false;
        this.updateDriverId = driverId;
        this.url = this.installed[driverId]?.source.url ?? this.url;
        this.screen = 'review';

        return this.run(async () => {
          await this.accept(await api.post(`/api/driver-installs/drivers/${driverId}/update`, {}));
        }, true);
      }
    },
    /**
     * Повтор использует сохранённый requestId и тот же серверный previous digest.
     * Сетевой отказ оставляет намерение; известный HTTP отказ или подтверждённый исход снимают его.
     */
    async replayRollback() {
      const intent = this.pendingRollback;

      if (!intent) {
        return;
      }

      try {
        const raw = await api.post(`/api/driver-installs/drivers/${intent.pluginId}/rollback`, {
          ...intent.body,
        });

        await this.accept(raw);
        window.sessionStorage.removeItem(ROLLBACK_KEY);
        this.pendingRollback = null;
      } catch (error) {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
          window.sessionStorage.removeItem(ROLLBACK_KEY);
          this.pendingRollback = null;
          this.unknownOutcome = false;
          this.screen = this.rollbackPreview ? 'rollback' : 'idle';
        } else {
          this.unknownOutcome = true;
          this.screen = 'progress';
        }

        throw error;
      }
    },
    /**
     * Откат фиксирует CAS и requestId до POST, а не после потенциальной публикации.
     * Второй клик закрыт общим busy ещё во время чтения управляемых установок.
     */
    rollback() {
      const preview = this.rollbackPreview;
      const driverId = preview?.id;

      if (!driverId || !preview?.record.previous || this.blocked) {
        return;
      }

      return this.run(async () => {
        if (!this.pendingRollback) {
          const record = preview.record;

          if (!record?.previous || !record.rollbackAvailable) {
            this.previousUnavailable = true;

            return;
          }

          const intent = {
            pluginId: driverId,
            body: {
              requestId: crypto.randomUUID(),
              expectedRevision: record.revision,
              expectedPreviousDigest: record.previous.payloadDigest,
            },
          };

          window.sessionStorage.setItem(ROLLBACK_KEY, JSON.stringify(intent));
          this.pendingRollback = intent;
          this.screen = 'progress';
        }

        await this.replayRollback();
      });
    },
    /**
     * Подтверждение отката фиксирует именно показанный current/previous без сетевого Git.
     * Серверный CAS отвергнет изменившийся снимок вместо подмены выбранной версии.
     */
    openRollback(id: string) {
      if (this.blocked) {
        return;
      }

      return this.run(async () => {
        await this.readInstalled();

        const record = this.installed[id];

        if (!record?.previous || !record.rollbackAvailable) {
          this.previousUnavailable = true;

          return;
        }

        this.acknowledge();
        this.rollbackPreview = { id, record: structuredClone(toRaw(record)) };
        this.flow = 'rollback';
        this.screen = 'rollback';
      });
    },
    /**
     * Завершённый исход подтверждается отдельно от server-owned job.
     * Повторное открытие окна не возвращает уже просмотренный результат.
     */
    acknowledge() {
      if (this.job && !this.active) {
        this.acknowledgedJobId = this.job.id;
        window.sessionStorage.setItem(ACKNOWLEDGED_KEY, this.job.id);
        this.job = null;
      }

      this.error = '';
      this.errorCode = '';
      this.refreshError = '';
    },
  },
});
