/**
 * Читает только строковый код объекта, не требуя instanceof Error.
 * Ошибки getter не скрываются, а примитивы и функции дают пустую строку.
 */
export function errorCode(error: unknown): string {
  const code = error !== null && typeof error === 'object'
    ? (error as { code?: unknown }).code : undefined;

  return typeof code === 'string' ? code : '';
}

/**
 * Возвращает непустое строковое сообщение объекта либо явный запасной текст.
 * Чужой объект не преобразуется в строку, и пустое сообщение не подавляет fallback.
 */
export function errorMessage(error: unknown, fallback: string): string {
  const message = error !== null && typeof error === 'object'
    ? (error as { message?: unknown }).message : undefined;

  return typeof message === 'string' && message ? message : fallback;
}

/**
 * Сохраняет message настоящего Error, включая пустую строку.
 * Остальные значения преобразует через String с исходными ошибками преобразования.
 */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
