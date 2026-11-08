import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from '../shared/uiLocalePort.ts';
import { setTrackerMutationGeneration, setTrackerDriverGenerations } from '../shared/trackerMutation.ts';
import { defineStore } from 'pinia';
import { useBoardStore } from './board.ts';

import type { TrackerCatalog } from '../../../shared/trackers/contracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { api, ApiError } from '../shared/apiClient.ts';
import { LEGACY_TRACKER_CAPABILITIES, trackerCapabilities } from '../shared/trackerCapabilities.ts';

const catalogJobs = new WeakMap<object, Promise<void>>();

export const useTrackersStore = defineStore('trackers', {
  state: () => ({
    catalog: null as TrackerCatalog | null,
    loading: false,
    legacy: false,
    error: '',
    epoch: 0,
  }),
  getters: {
    capabilities: (state) => {
      if (state.legacy) {
        return LEGACY_TRACKER_CAPABILITIES;
      }

      const driver = state.catalog?.drivers.find((entry) => entry.id === state.catalog?.externalId);

      if (driver?.status === 'unavailable' || driver?.status === 'restartRequired') {
        return trackerCapabilities(undefined);
      }

      return trackerCapabilities(driver?.capabilities);
    },
  },
  actions: {
    /**
     * Запись настроек закрывает старые снимки до отправки POST и любого его исхода.
     * Пауза принадлежит своей эпохе; SSE или более новая запись не разблокируются поздним finally.
     */
    async saveSettings(input: {
      externalId?: string | null;
      drivers?: string[];
      default?: string | null;
      settings: Record<string, Record<string, unknown>>;
      expectedRevision: number;
    }) {
      const board = useBoardStore();
      const token = board.beginSourceChange(input.settings);

      try {
        const result = await api.post('/api/trackers/settings', input) as { revision: number };

        this.invalidate();
        await this.load(true);

        return result;
      } finally {
        await board.finishSourceChange(token);
      }
    },
    /**
     * Metadata читается независимо от details и зеркала доски.
     * Только подтверждённый 404 старого API разрешает прежние custom-действия.
     */
    load(force = false): Promise<void> {
      const active = catalogJobs.get(this);

      if (active && this.loading) {
        return active;
      }

      const job = this.loadCatalog(force);

      catalogJobs.set(this, job);
      void job.finally(() => {
        if (catalogJobs.get(this) === job) {
          catalogJobs.delete(this);
        }
      });

      return job;
    },
    /**
     * Один запрос каталога подтверждает возможности всех ожидающих читателей.
     * Эпоха исключает публикацию metadata после смены подключения.
     */
    async loadCatalog(force = false) {
      if (this.loading || (!force && (this.catalog || this.legacy))) {
        return;
      }

      const epoch = this.epoch;

      this.loading = true;

      try {
        const raw = await api.get('/api/trackers');

        if (epoch !== this.epoch) {
          return;
        }

        if (!isRecord(raw) || !Array.isArray(raw.drivers)
          || !raw.drivers.every((entry) => isRecord(entry) && typeof entry.id === 'string'
            && isRecord(entry.capabilities))
          || !Array.isArray(raw.activeIds) || !raw.activeIds.every((id) => typeof id === 'string')
          || (raw.externalId !== null && typeof raw.externalId !== 'string')
          || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) {
          throw new Error('Некорректные возможности трекера');
        }

        const descriptors = raw.drivers;

        if (raw.enabledIds !== undefined && (!Array.isArray(raw.enabledIds)
          || !raw.enabledIds.every((id) => typeof id === 'string' && id !== 'own'
            && descriptors.some((entry) => isRecord(entry) && entry.id === id))
          || (raw.default !== null && !raw.enabledIds.includes(raw.default)))) {
          throw new Error(localeTranslator(uiLocalePort)('core.invalidBoardSnapshot'));
        }

        this.catalog = raw as unknown as TrackerCatalog;
        setTrackerMutationGeneration(this.catalog.revision);
        setTrackerDriverGenerations(this.catalog.drivers);
        this.legacy = false;
        this.error = '';
      } catch (error) {
        if (epoch === this.epoch) {
          this.catalog = null;
          this.legacy = error instanceof ApiError && error.status === 404;
          this.error = this.legacy ? '' : String((error as Error).message);
        }
      } finally {
        if (epoch === this.epoch) {
          this.loading = false;
        }
      }
    },
    /**
     * Событие смены подключения немедленно закрывает старые возможности.
     * Поздний ответ предыдущего запроса не возвращает их после смены поколения.
     */
    invalidate() {
      setTrackerMutationGeneration(null);
      this.epoch += 1;
      this.catalog = null;
      this.legacy = false;
      this.loading = false;
    },
    /**
     * Адресная мутация получает поколение только своей доски.
     * Старый маршрут продолжает использовать ревизию общего выбора.
     */
    mutationOptions(driverId?: string) {
      if (driverId && this.catalog?.enabledIds) {
        const driver = this.catalog.drivers.find((entry) => entry.id === driverId);

        return driver?.generation == null ? {} : {
          headers: { 'x-grigdesk-tracker-generation': String(driver.generation) },
        };
      }

      return this.catalog ? {
        headers: { 'x-grigdesk-tracker-generation': String(this.catalog.revision) },
      } : {};
    },
  },
});
