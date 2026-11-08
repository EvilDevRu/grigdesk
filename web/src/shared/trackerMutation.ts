const drivers = new Map<string, number>();

let generation: number | null = null;

/**
 * Публикует только подтверждённое поколение текущего каталога трекеров.
 * Сброс запрещает повторное использование заголовка прежнего подключения.
 */
export function setTrackerMutationGeneration(value: number | null): void {
  generation = value;
}

/**
 * Локальные метки используют то же подтверждённое поколение, что действия карточки.
 * Модуль не загружает stores и не запускает чтение внешнего драйвера.
 */
export function trackerMutationOptions(driverId?: string): { headers?: Record<string, string> } {
  const current = driverId ? drivers.get(driverId) : generation;

  return current == null ? {} : {
    headers: { 'x-grigdesk-tracker-generation': String(current) },
  };
}

/**
 * Адресные записи используют поколение своего пакета.
 * Изменение соседней доски не закрывает подтверждённую цель.
 */
export function setTrackerDriverGenerations(values: Array<{ id: string; generation?: number }>): void {
  drivers.clear();

  for (const value of values) {
    if (Number.isSafeInteger(value.generation)) {
      drivers.set(value.id, value.generation!);
    }
  }
}
