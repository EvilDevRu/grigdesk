import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';

import { api, ApiError, type ApiClient } from '../shared/apiClient.ts';
import {
  decodeCatalogResponse, decodeCatalogDetail,
  type CatalogDetail, type CatalogIndexResponse,
} from '../../../shared/plugins/pluginCatalogContracts.ts';
import { detailMatchesIndex } from '../../../shared/plugins/pluginCatalogPolicy.ts';

/**
 * Store получает один same-origin транспорт; dependency injection нужен только fixture.
 * Controllers и epochs принадлежат экземпляру Pinia и не попадают в сериализуемый state.
 */
export function definePluginCatalogStore(transport: Pick<ApiClient, 'get'>, id = 'pluginCatalog') {
  return defineStore(id, () => {
    const snapshot = shallowRef<CatalogIndexResponse | null>(null);
    const detail = shallowRef<CatalogDetail | null>(null);
    const selectedId = ref('');
    const loading = ref(false);
    const detailLoading = ref(false);
    const error = ref(false);
    const detailError = ref(false);
    const index = computed(() => snapshot.value?.catalog ?? null);
    const state = computed(() => snapshot.value?.state ?? 'unavailable');
    const applicationVersion = computed(() => snapshot.value?.applicationVersion ?? '0.0.0');
    let indexEpoch = 0;
    let detailEpoch = 0;
    let disposed = false;
    let catalogApi: 1 | 2 = 2;
    let indexController: AbortController | null = null;
    let detailController: AbortController | null = null;
    let indexFlight: Promise<void> | null = null;

    /**
     * Refresh может заменить старое чтение; его ответ не получает права откатить снимок.
     * Protocol/network failure сохраняет данные только как stale, а не fresh.
     */
    async function readIndex(force: boolean): Promise<void> {
      const epoch = ++indexEpoch;

      indexController?.abort();
      detailController?.abort();
      detailEpoch += 1;
      detailLoading.value = false;

      const controller = new AbortController();

      indexController = controller;
      loading.value = true;
      error.value = false;

      try {
        let nextApi = catalogApi;
        let raw: unknown;

        try {
          raw = await requestIndex(nextApi, force, controller.signal);
        } catch (failure) {
          if (!(failure instanceof ApiError) || failure.status !== 400 || nextApi !== 2
            || disposed || epoch !== indexEpoch || controller.signal.aborted) {
            throw failure;
          }

          nextApi = 1;
          raw = await requestIndex(nextApi, force, controller.signal);
        }

        const next = decodeCatalogResponse(raw, nextApi);

        if (disposed || epoch !== indexEpoch || controller.signal.aborted) {
          return;
        }

        catalogApi = nextApi;
        snapshot.value = next;

        if (!next.catalog || detail.value
          && !detailMatchesIndex(next.catalog, detail.value, selectedId.value)) {
          detail.value = null;
        }
      } catch {
        if (!disposed && epoch === indexEpoch) {
          error.value = true;

          if (snapshot.value) {
            snapshot.value = {
              ...snapshot.value,
              state: snapshot.value.catalog ? 'stale' : 'unavailable',
            };
          }
        }
      } finally {
        if (!disposed && epoch === indexEpoch) {
          loading.value = false;

          // Карточка, сброшенная новым снимком или прерванная этим чтением, не исчезает
          // молча: панель просит обновить каталог. Новое чтение карточки сбросит ошибку.
          if (selectedId.value && !detail.value && !detailLoading.value) {
            detailError.value = true;
          }
        }
      }
    }

    /**
     * Согласование меняет только query и бюджет чтения через общий same-origin транспорт.
     * Повтор старого запроса сохраняет signal и явное намерение обновить каталог.
     */
    function requestIndex(mode: 1 | 2, force: boolean, signal: AbortSignal) {
      const query = mode === 2 ? `?api=2${force ? '&refresh=1' : ''}` : force ? '?refresh=1' : '';

      return transport.get(`/api/plugin-catalog${query}`, {
        signal,
        retry: false,
        timeoutMs: mode === 2 ? 25000 : 15000,
      });
    }

    /**
     * Повтор обычного чтения разделяет flight; явный refresh инвалидирует прежний ответ.
     * Старый finally не очищает ссылку на более новый выполняющийся запрос.
     */
    async function loadIndex(force = false): Promise<void> {
      if (disposed) {
        return;
      }

      if (indexFlight && !force) {
        return indexFlight;
      }

      const flight = readIndex(force);

      indexFlight = flight;

      try {
        await flight;
      } finally {
        if (indexFlight === flight) {
          indexFlight = null;
        }
      }
    }

    /**
     * Выбор ID меняется синхронно, а карточка публикуется лишь после полного decode.
     * Другой выбор, новый index или dispose лишают поздний ответ права менять UI.
     */
    async function loadDetail(id: string): Promise<void> {
      if (disposed) {
        return;
      }

      const epoch = ++detailEpoch;
      const openingIndex = indexEpoch;
      const openingApi = catalogApi;
      const snapshot = index.value;

      detailController?.abort();
      selectedId.value = id;
      detail.value = null;
      detailError.value = false;

      if (!snapshot?.plugins.some((item) => item.id === id)) {
        detailError.value = true;
        detailLoading.value = false;

        return;
      }

      detailController = new AbortController();
      detailLoading.value = true;

      try {
        const path = `/api/plugin-catalog/${encodeURIComponent(id)}${openingApi === 2 ? '?api=2' : ''}`;
        const next = decodeCatalogDetail(await transport.get(path, {
          signal: detailController.signal,
          retry: false,
          timeoutMs: 15000,
        }), openingApi);

        if (disposed || epoch !== detailEpoch || openingIndex !== indexEpoch) {
          return;
        }

        // Снимок сменился под ещё выбранной карточкой: это ошибка карточки, а не пустой выбор.
        if (index.value !== snapshot || !detailMatchesIndex(snapshot, next, id)) {
          throw new TypeError('Каталог: карточка другого снимка');
        }

        detail.value = next;
      } catch {
        if (!disposed && epoch === detailEpoch && openingIndex === indexEpoch) {
          detailError.value = true;
        }
      } finally {
        if (!disposed && epoch === detailEpoch) {
          detailLoading.value = false;
        }
      }
    }

    onScopeDispose(() => {
      disposed = true;
      indexEpoch += 1;
      detailEpoch += 1;
      indexController?.abort();
      detailController?.abort();
    });

    return {
      snapshot,
      index,
      state,
      applicationVersion,
      detail,
      selectedId,
      loading,
      detailLoading,
      error,
      detailError,
      loadIndex,
      loadDetail,
    };
  });
}

export const usePluginCatalogStore = definePluginCatalogStore(api);
