export interface JobDownloadQueuePorts {
  run(intentId: string, childId: string): Promise<void>;
  isStopped(): boolean;
}

/**
 * Очередь дедуплицирует intent/child и разделяет запуск с постановкой в ожидание.
 * Флаг остановки и сама работа принадлежат Jobs, одновременно активны не больше двух.
 */
export function createJobDownloadQueue(ports: JobDownloadQueuePorts) {
  const downloading = new Map<string, Promise<void>>();
  const waiting: { intentId: string; childId: string }[] = [];
  const downloadKey = (intentId: string, childId: string) => `${intentId}:${childId}`;

  /**
   * Очередь CDN дедуплицируется по intent/child и ограничена двумя потоками.
   * Tick продолжает poll, даже когда загрузка другой модели занимает минуты.
   */
  const enqueue = (intentId: string, childId: string): void => {
    const key = downloadKey(intentId, childId);

    if (!downloading.has(key) && !waiting.some((item) =>
      downloadKey(item.intentId, item.childId) === key)) {
      waiting.push({ intentId, childId });
    }
  };

  /**
   * Завершение освобождает слот и запускает ожидающего, в том числе после отказа.
   * Catch сохраняет отказ для settle, но закрывает unhandled rejection без наблюдателя.
   */
  const pump = (): void => {
    while (!ports.isStopped() && downloading.size < 2 && waiting.length) {
      const item = waiting.shift()!;
      const key = downloadKey(item.intentId, item.childId);
      const promise = ports.run(item.intentId, item.childId).finally(() => {
        downloading.delete(key);
        pump();
      });

      downloading.set(key, promise);
      void promise.catch(() => {});
    }
  };

  /**
   * Ожидание сохраняет прежний цикл pump и Promise.all с распространением отказа.
   * Для stopped с waiting этот цикл не применяется; остановка очищает ожидающих отдельно.
   */
  const settle = async (): Promise<void> => {
    while (downloading.size || waiting.length) {
      pump();
      await Promise.all([...downloading.values()]);
    }
  };

  const clearWaiting = (): void => {
    waiting.length = 0;
  };

  /**
   * Остановка ждёт текущие работы через allSettled и не распространяет их отказ.
   * Снимок активных берётся в прежней точке после ожидания текущего tick.
   */
  const waitActive = async (): Promise<void> => {
    await Promise.allSettled([...downloading.values()]);
  };

  return {
    enqueue,
    pump,
    activeCount: () => downloading.size,
    settle,
    clearWaiting,
    waitActive,
  };
}
