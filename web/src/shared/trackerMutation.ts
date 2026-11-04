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
export function trackerMutationOptions(): { headers?: Record<string, string> } {
  return generation === null ? {} : {
    headers: { 'x-grigdesk-tracker-generation': String(generation) },
  };
}
