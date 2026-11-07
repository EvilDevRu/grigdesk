import { sseSubscribe } from '../../composables/useSse.ts';
import { inboxApi, inboxPluginDisabled } from '../../shared/inboxApi.ts';
import { useInboxStore } from '../../stores/inbox.ts';
import { runtimeOf } from './inboxRuntime.ts';

// Bundles Telegram созревают по времени, без нового сообщения. Поэтому сводка
// перепроверяется раз в минуту, хотя у GitHub выдержка нулевая и событие приходит сразу.
const RECHECK_INTERVAL_MS = 60_000;

/**
 * Свежий счётчик очереди. Одновременных чтений не бывает: пока одно идёт, второе
 * лишь помечается — иначе всплеск событий превратился бы в очередь одинаковых
 * запросов, а показать они всё равно могут только последнее значение.
 */
export async function refreshInboxSummary(): Promise<void> {
  const store = useInboxStore();

  if (store.loading) {
    store.setRefreshQueued(true);

    return;
  }

  const generation = store.generation;

  store.setLoading(true);
  store.setRefreshQueued(false);

  try {
    const summary = await inboxApi.summary();

    if (!store.started || generation !== store.generation) {
      return;
    }

    // Запасной счёт держит прежнюю цифру в коротком окне, когда свежий веб-бандл
    // уже загружен, а сервер ещё ждёт перезапуска и поля reviewCount не знает.
    const legacyCount = summary.newCount + summary.mixedCount;

    store.setReviewCount(summary.reviewCount ?? legacyCount);
  } catch (error) {
    if (store.started && generation === store.generation && inboxPluginDisabled(error)) {
      stopInboxSummary();
    }
  } finally {
    store.setLoading(false);

    if (store.started && store.refreshQueued) {
      store.setRefreshQueued(false);
      queueMicrotask(() => void refreshInboxSummary());
    }
  }
}

/**
 * Начало наблюдения за очередью. Подписка и таймер заводятся один раз: оболочка
 * зовёт запуск при каждом монтировании, а второй таймер удвоил бы опрос.
 */
export function startInboxSummary(): void {
  const store = useInboxStore();
  const runtime = runtimeOf(store);

  store.start();

  if (!runtime.off) {
    runtime.off = sseSubscribe((name: string) => {
      if (name === 'inbox-changed') {
        void refreshInboxSummary();
      }
    });
  }

  if (!runtime.timer) {
    // Таймер не должен держать процесс живым: в браузере это ничего не значит, а в
    // проверке под Node висящий интервал не дал бы ей завершиться.
    runtime.timer = setInterval(() => void refreshInboxSummary(), RECHECK_INTERVAL_MS);
    (runtime.timer as { unref?: () => void }).unref?.();
  }

  void refreshInboxSummary();
}

/**
 * Остановка. Счётчик по умолчанию гасится: выключенный плагин не должен оставлять
 * в шапке цифру очереди, которой человек уже не увидит.
 */
export function stopInboxSummary({ clear = true }: { clear?: boolean } = {}): void {
  const store = useInboxStore();
  const runtime = runtimeOf(store);

  store.stop();
  runtime.off?.();
  runtime.off = null;

  if (runtime.timer) {
    clearInterval(runtime.timer);
  }

  runtime.timer = null;

  if (clear) {
    store.clear();
  }
}
