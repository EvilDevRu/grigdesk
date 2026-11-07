/**
 * Каждый ресурс получает собственный счётчик перечитывания, без общей гонки страниц.
 * Ответ старого экрана после смены generation не может восстановить очищенные данные.
 */
export function createLatest() {
  let revision = 0;

  return {
    invalidate() {
      revision += 1;
    },
    async run<T>(load: () => Promise<T>, apply: (value: T) => void) {
      const captured = ++revision;
      const value = await load();

      if (captured === revision) {
        apply(value);
      }
    },
  };
}
