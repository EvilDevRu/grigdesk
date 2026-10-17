// Состояние карточек сохраняется при v-show, а запросы изолированы по provider.
// Таймеры и очереди находятся вне подписываемого состояния Pinia.

import { defineStore } from 'pinia';
import { reactive } from 'vue';
import { providerSettingsApi } from '../shared/providerSettingsApi.ts';
import type { ProviderSettingsApi } from '../shared/providerSettingsApi.ts';
import type { JsonValue, ProviderSettingsCatalog } from '../../../shared/chat/providerSettingsContracts.ts';
import type { ProviderSettingsOverrideRequest } from '../../../shared/chat/providerSettingsContracts.ts';

export interface NativeSettingsPanelState {
  catalog: ProviderSettingsCatalog | null;
  loading: boolean;
  saving: boolean;
  error: string;
  message: string;
  drafts: Record<string, JsonValue>;
  errors: Record<string, string>;
}

/**
 * Зависимости API и времени внедряются без копии логики в тесте.
 * Каждый сценарий получает свежую Pinia, карточки остаются в одном общем store.
 */
export function defineProviderSettingsStore(
  client: ProviderSettingsApi = providerSettingsApi,
  clock = Date.now,
) {
  return defineStore('providerSettings', () => {
    const entries = reactive<Record<string, NativeSettingsPanelState>>({});
    const loads = new Map<string, Promise<void>>();
    const checkedAt = new Map<string, number>();
    const generations = new Map<string, number>();
    const writes = new Map<string, Promise<void>>();
    const writeEpochs = new Map<string, number>();
    const writeCounts = new Map<string, number>();

    function panel(id: string): NativeSettingsPanelState {
      entries[id] ??= {
        catalog: null,
        loading: false,
        saving: false,
        error: '',
        message: '',
        drafts: {},
        errors: {},
      };

      return entries[id];
    }

    /**
     * Одно открытие не запускает несколько чтений. Refresh инвалидирует предыдущий
     * запрос, но не стирает ввод человека, даже если источник временно недоступен.
     */
    async function load(id: string, refresh = false): Promise<void> {
      const state = panel(id);

      if (!refresh && loads.has(id)) {
        return loads.get(id);
      }

      if (!refresh && state.catalog && clock() - (checkedAt.get(id) ?? 0) < 60_000) {
        return;
      }

      const generation = (generations.get(id) ?? 0) + 1;

      generations.set(id, generation);
      state.loading = true;

      const pending = (async () => {
        try {
          const catalog = await client.catalog(id, refresh);

          if (generations.get(id) === generation) {
            state.catalog = catalog;
            state.error = '';
            checkedAt.set(id, clock());
          }
        } catch (error) {
          if (generations.get(id) === generation) {
            state.error = error instanceof Error ? error.message : 'Не удалось получить настройки';
          }
        } finally {
          if (generations.get(id) === generation) {
            state.loading = false;
            loads.delete(id);
          }
        }
      })();

      loads.set(id, pending);

      return pending;
    }

    /**
     * Ревизия принадлежит provider целиком, поэтому поля сохраняются по очереди.
     * Каталог заменяется только ответом сервера, введённый черновик переживает отказ.
     */
    function mutate(
      id: string,
      fieldId: string,
      operation: 'set' | 'unset',
      value?: JsonValue,
    ): Promise<void> {
      const state = panel(id);

      if (operation === 'set' && value !== undefined) {
        state.drafts[fieldId] = value;
      }

      const chosenDraft = JSON.stringify(operation === 'set' ? value : state.drafts[fieldId]);
      const previous = writes.get(id) ?? Promise.resolve();
      const epoch = writeEpochs.get(id) ?? 0;

      writeCounts.set(id, (writeCounts.get(id) ?? 0) + 1);
      state.saving = true;

      const pending = previous.then(async () => {
        try {
          if (epoch !== (writeEpochs.get(id) ?? 0)) {
            state.errors[fieldId] = 'Запись отменена из-за конфликта; проверьте и повторите выбор';

            return;
          }

          const catalog = state.catalog;

          if (!catalog || (operation === 'set' && (catalog.schemaRevision === null || value === undefined))) {
            throw new Error('Сначала перечитайте каталог настроек');
          }

          const request: ProviderSettingsOverrideRequest =
            operation === 'set'
              ? {
                  fieldId,
                  operation,
                  value: value!,
                  revision: catalog.revision,
                  schemaRevision: catalog.schemaRevision!,
                }
              : {
                  fieldId,
                  operation,
                  revision: catalog.revision,
                  schemaRevision: catalog.schemaRevision,
                };
          const response = await client.override(id, request);

          generations.set(id, (generations.get(id) ?? 0) + 1);
          loads.delete(id);
          state.loading = false;
          state.catalog = response.catalog;
          checkedAt.set(id, clock());
          state.errors[fieldId] = '';
          state.message = 'Сохранено для следующего запуска';

          if (JSON.stringify(state.drafts[fieldId]) === chosenDraft) {
            delete state.drafts[fieldId];
          }
        } catch (error) {
          state.errors[fieldId] = error instanceof Error ? error.message : 'Не удалось сохранить настройку';

          const status =
            (error as { status?: unknown; statusCode?: unknown } | null)?.status ??
            (error as { statusCode?: unknown } | null)?.statusCode;

          if (status === 409) {
            writeEpochs.set(id, epoch + 1);
            await load(id, true);
          }
        } finally {
          writeCounts.set(id, (writeCounts.get(id) ?? 1) - 1);
          state.saving = (writeCounts.get(id) ?? 0) > 0;
        }
      });

      writes.set(id, pending);
      void pending.finally(() => {
        if (writes.get(id) === pending) {
          writes.delete(id);
        }
      });

      return pending;
    }

    const save = (id: string, fieldId: string, value: JsonValue) => mutate(id, fieldId, 'set', value);
    const reset = (id: string, fieldId: string) => mutate(id, fieldId, 'unset');
    const draft = (id: string, fieldId: string, value: JsonValue) => {
      panel(id).drafts[fieldId] = value;
    };

    return {
      entries,
      panel,
      load,
      save,
      reset,
      draft,
    };
  });
}

export const useProviderSettingsStore = defineProviderSettingsStore();
