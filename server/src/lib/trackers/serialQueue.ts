/**
 * Одна очередь обслуживает экземпляр сессии и восстанавливается после отказа.
 * Хвост поглощает reject только для следующего допуска; вызывающий получает свою ошибку.
 */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();

  return <T>(operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation, operation);

    tail = result.catch(() => undefined);

    return result;
  };
}
