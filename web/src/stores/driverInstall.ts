import { defineStore } from 'pinia';

import { api, ApiError, failureText } from '../shared/apiClient.ts';
import {
  decodeDriverInstallChecks, decodeDriverInstallResponse, decodeDriverRemoval, decodeDriverSources,
} from '../shared/driverInstallApi.ts';
import type { DriverInstallJob } from '../shared/driverInstallApi.ts';
import { decodeInstallVersions, decodeStoredRollback } from '../shared/pluginInstallApi.ts';
import type { PluginInstallInfo, PluginVersionRef } from '../../../shared/plugins/pluginInstallContracts.ts';
import { useTrackersStore } from './trackers.ts';

const ROLLBACK_KEY = 'grigdesk-driver-install-rollback';

type RollbackIntent = ReturnType<typeof decodeStoredRollback>;

export const useDriverInstallStore = defineStore('driver-install', {
  state: () => ({
    job: null as DriverInstallJob | null,
    installed: {} as Record<string, PluginInstallInfo>,
    versions: [] as PluginVersionRef[],
    versionsEmpty: false,
    sources: [] as { title: string; url: string }[],
    sourcesLoading: false,
    sourcesError: '',
    busy: false,
    error: '',
    recoveryError: '',
    previousUnavailable: false,
    restartRequired: false,
    pendingRollback: null as RollbackIntent | null,
    restored: false,
    url: '',
    tag: '',
  }),
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
    async run(operation: () => Promise<void>) {
      if (this.busy) {
        return;
      }

      this.busy = true;
      this.error = '';
      this.previousUnavailable = false;

      try {
        await operation();
      } catch (error) {
        this.error = failureText(error);
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

      this.job = response.job;
      this.restartRequired = response.restartRequired;
      this.recoveryError = response.recoveryError;

      if (response.job?.status === 'done') {
        await this.readInstalled();

        const trackers = useTrackersStore();

        trackers.invalidate();
        await trackers.load(true);
      }
    },
    /**
     * Управляемые копии читаются отдельным driver API, включая previous и доступность отката.
     * Признак рестарта не выводится из статуса done: новый ещё не загруженный пакет его не требует.
     */
    async readInstalled() {
      this.installed = decodeDriverInstallChecks(await api.post('/api/driver-installs/check', {}));
      this.restartRequired = Object.values(this.installed).some((record) => record.restartRequired);
    },
    check() {
      return this.run(() => this.readInstalled());
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
          this.restored = true;
        }

        if (this.pendingRollback) {
          await this.replayRollback();
        } else {
          await this.accept(await api.get('/api/driver-installs/jobs/current'));
        }
      });
    },
    versionsForSource() {
      return this.run(async () => {
        this.versions = [];
        this.versionsEmpty = false;
        this.versions = decodeInstallVersions(await api.post('/api/driver-installs/versions', {
          url: this.url,
        })).versions;
        this.versionsEmpty = this.versions.length === 0;
      });
    },
    /**
     * Удаление подтверждается сервером и перечитывает каталог с сохранённой tombstone-пометкой.
     * Сброс выбранного источника приходит тем же SSE, что обычная смена настройки доски.
     */
    remove(id: string) {
      return this.run(async () => {
        const result = decodeDriverRemoval(await api.post(`/api/driver-installs/drivers/${id}/remove`, {}));

        if (this.job?.driverId === result.id) {
          this.job = null;
        }

        await this.readInstalled();
        this.restartRequired ||= result.restartRequired;

        const trackers = useTrackersStore();

        trackers.invalidate();
        await trackers.load(true);
      });
    },
    prepare() {
      if (this.pendingRollback) {
        return this.current();
      }

      return this.run(async () => {
        this.versionsEmpty = false;
        await this.accept(await api.post('/api/driver-installs/jobs', {
          url: this.url,
          version: this.tag.replace(/^v/u, ''),
        }));
      });
    },
    apply() {
      if (this.job?.status !== 'ready' || !this.job.reviewToken || this.recoveryError) {
        return;
      }

      const { id, reviewToken } = this.job;

      return this.run(async () => {
        await this.accept(await api.post(`/api/driver-installs/jobs/${id}/apply`, { reviewToken }));
      });
    },
    cancel() {
      const id = this.job?.id;

      if (id) {
        return this.run(async () => {
          await this.accept(await api.post(`/api/driver-installs/jobs/${id}/cancel`, {}));
        });
      }
    },
    update(id?: string) {
      const driverId = id ?? this.job?.driverId;

      if (driverId && !this.pendingRollback) {
        return this.run(async () => {
          await this.accept(await api.post(`/api/driver-installs/drivers/${driverId}/update`, {}));
        });
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
        }

        throw error;
      }
    },
    /**
     * Откат фиксирует CAS и requestId до POST, а не после потенциальной публикации.
     * Второй клик закрыт общим busy ещё во время чтения управляемых установок.
     */
    rollback(id?: string) {
      const driverId = id ?? this.job?.driverId;

      if (!driverId) {
        return;
      }

      return this.run(async () => {
        if (!this.pendingRollback) {
          await this.readInstalled();

          const record = this.installed[driverId];

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
        }

        await this.replayRollback();
      });
    },
  },
});
