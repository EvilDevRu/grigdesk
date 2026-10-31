import { defineStore } from 'pinia';
import { useBoardStore } from './board.ts';

import type { TrackerCatalog } from '../../../shared/trackers/contracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';
import { api, ApiError } from '../shared/apiClient.ts';
import { LEGACY_TRACKER_CAPABILITIES, trackerCapabilities } from '../shared/trackerCapabilities.ts';

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
      externalId: string | null;
      settings: Record<string, Record<string, unknown>>;
      expectedRevision: number;
    }) {
      const board = useBoardStore();
      const token = board.beginSourceChange();

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
    async load(force = false) {
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

        this.catalog = raw as unknown as TrackerCatalog;
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
      this.epoch += 1;
      this.catalog = null;
      this.legacy = false;
      this.loading = false;
    },
    mutationOptions() {
      return this.catalog ? {
        headers: { 'x-grigdesk-tracker-generation': String(this.catalog.revision) },
      } : {};
    },
  },
});
