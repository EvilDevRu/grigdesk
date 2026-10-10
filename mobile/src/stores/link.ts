import { defineStore } from 'pinia';
import { markRaw, ref, shallowRef } from 'vue';

import { ApiClient } from '../api/client.ts';
import { LinkEvents } from '../api/events.ts';
import { getLink } from '../link/index.ts';
import type { CockpitLink, LinkState } from '../link/types.ts';
import { parseQr } from '../link/qr.ts';
import { isNewer } from '../api/version.ts';

const clearers = new Set<() => void>();
const signals = new Set<(name: string, value: any) => void>();

/**
 * Stores регистрируют очистку данных на lock, независимо от открытого экрана.
 * Callback не удаляет durable очередь, которой владеет native.
 */
export const onClear = (callback: () => void) => {
  clearers.add(callback);
};
/**
 * Подписка экрана использует общий owner SSE и имеет явное удаление.
 * Размонтированный route не получает повторную сверку по событию.
 */
export const onSignal = (callback: (name: string, value: any) => void) => {
  signals.add(callback);

  return () => signals.delete(callback);
};

/**
 * Корневой стор владеет unlock state и единым потоком событий всей вкладки.
 * Lock/revoke очищает продуктовые stores раньше любого позднего сетевого callback.
 */
export const useLinkStore = defineStore('link', () => {
  const state = ref<LinkState | null>(null);
  const bridge = shallowRef<CockpitLink | null>(null);
  const api = shallowRef<ApiClient | null>(null);
  const error = ref('');
  const busy = ref(false);
  const minApp = ref('0.1.0');
  const features = ref<string[]>([]);
  const network = ref('offline');
  let events: LinkEvents | null = null;

  /**
   * Отказ доступа немедленно закрывает поток и видимые данные, не удаляя durable intents.
   * Отзыв отображается отдельно от обычного истечения окна разблокировки.
   */
  function fatal(code: string) {
    features.value = [];

    if (state.value) {
      state.value = {
        ...state.value,
        unlocked: false,
        revoked: code === 'device_revoked' || state.value.revoked,
        generation: state.value.generation,
      };
    }
    if (code === 'contract') {
      error.value = 'Обновите приложение: ответ Кокпита не поддерживается.';
    } else if (code === 'pin_mismatch') {
      error.value = 'Сертификат посредника или Кокпита изменился. Проверьте запись посредника.';
    } else if (code === 'device_unknown') {
      error.value = 'Кокпит не узнаёт этот телефон. Проверьте привязку в настройках.';
    }

    clearers.forEach((clear) => clear());
    void bridge.value?.stopEvents();
  }

  /**
   * Refresh сверяет native generation и масштаб; приложение не хранит вечный unlocked boolean.
   * Разблокированная сессия проверяет minApp и получает один SSE owner.
   */
  async function refresh() {
    const link = bridge.value || (await getLink());

    bridge.value = markRaw(link);

    const fresh = await link.getState();

    if (state.value && state.value.generation !== fresh.generation) {
      clearers.forEach((clear) => clear());
    }

    state.value = fresh;
    document.documentElement.style.fontSize = `${16 * Math.max(0.5, Math.min(3, fresh.fontScale || 1))}px`;

    if (!api.value) {
      api.value = markRaw(
        new ApiClient(link, {
          fatal,
          canMutate: () => !isNewer(minApp.value, import.meta.env.VITE_APP_VERSION || '0.1.0'),
        }),
      );
    }
    if (!events) {
      events = new LinkEvents(link, () => state.value?.generation ?? -1);
      await events.listen(
        (name, value) => {
          if (name === 'ready') {
            network.value = 'online';
            void ready(value);

            return;
          }

          signals.forEach((callback) => callback(name, value));
        },
        (update) => {
          if (
            update.generation !== undefined &&
            update.generation < (state.value?.generation ?? 0)
          ) {
            return;
          }
          if (update.state) {
            network.value = update.state;
          }
          if (
            update.unlocked === false ||
            ['locked', 'revoked', 'contract'].includes(update.state || '')
          ) {
            if (state.value && update.generation !== undefined) {
              state.value.generation = update.generation;
            }

            fatal(
              update.state === 'revoked' || update.revoked
                ? 'device_revoked'
                : update.state || 'locked',
            );
          } else if (state.value && update.generation !== undefined) {
            if (state.value.generation !== update.generation) {
              clearers.forEach((clear) => clear());
            }

            state.value.generation = update.generation;
          }
        },
        false,
      );
    }
    if (fresh.unlocked) {
      try {
        const hello = await api.value.getHello();

        minApp.value = hello.minApp;
        features.value = hello.features || [];
        await link.startEvents();
      } catch (failure) {
        error.value = failure instanceof Error ? failure.message : 'Нет связи с Кокпитом.';
      }
    }
  }

  /**
   * Новый ready сначала сверяет версию мозга, затем разрешает экранам восстановить очередь.
   * Перезапуск сервера с новым minApp не отправляет прежние команды несовместимым клиентом.
   */
  async function ready(value: unknown) {
    try {
      const hello = await api.value!.getHello();

      minApp.value = hello.minApp;
      features.value = hello.features || [];
      signals.forEach((callback) => callback('ready', value));
    } catch (failure) {
      error.value =
        failure instanceof Error ? failure.message : 'Не удалось проверить версию Кокпита.';
    }
  }

  /**
   * Действие блокирует повторное нажатие и возвращает понятную native ошибку.
   * После успешного изменения перечитывается identity, вместо ручной правки списка.
   */
  async function perform(action: () => Promise<void>) {
    if (busy.value) {
      return;
    }

    busy.value = true;
    error.value = '';

    try {
      await action();
      await refresh();
    } catch (failure) {
      error.value = failure instanceof Error ? failure.message : 'Действие не выполнено.';
    } finally {
      busy.value = false;
    }
  }

  const unlock = () => perform(() => bridge.value!.unlock());
  const add = (text: string) =>
    perform(async () => {
      parseQr(text);
      await bridge.value!.addFromText({ text });
    });
  const select = (id: string) => perform(() => bridge.value!.selectRelay({ id }));
  const remove = (id: string) => perform(() => bridge.value!.removeRelay({ id }));
  const reset = () =>
    perform(async () => {
      fatal('locked');
      await events?.close();
      events = null;
      await bridge.value!.resetDevice();
    });

  return {
    state,
    bridge,
    api,
    error,
    busy,
    minApp,
    features,
    network,
    refresh,
    unlock,
    add,
    select,
    remove,
    reset,
    fatal,
  };
});
