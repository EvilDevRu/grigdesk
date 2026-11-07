// Очередь задач по ключу внутри процесса: задачи с одним ключом (обычно путём) идут строго
// друг за другом, с разными — параллельно. Ею пользуются правка env-файлов и снимки триажа.

const locks = new Map<string, Promise<unknown>>();

/**
 * Выполняет задачу после всех ранее поставленных задач с тем же ключом. Ошибка одной
 * задачи не ломает очередь: следующая всё равно дождётся завершения предыдущей.
 */
export async function withPathLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => undefined);

  locks.set(key, tail);

  try {
    return await run;
  } finally {
    if (locks.get(key) === tail) {
      locks.delete(key);
    }
  }
}
