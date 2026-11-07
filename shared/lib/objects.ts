/**
 * Принимает любой объект, кроме null и массива; экземпляры классов допустимы.
 * Поля остаются unknown, пока вызывающая область не проверит их контракт.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Ограничивает объект обычным или отсутствующим прототипом.
 * Ошибки proxy не скрывает: проверка недоверенного объекта остаётся явной.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/**
 * Сохраняет любой объект по ссылке, включая массивы и экземпляры классов.
 * Для остальных входов создаёт новый пустой объект, не разделяемый между вызовами.
 */
export function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/**
 * Сохраняет объект без массива, иначе создаёт новый пустой объект.
 * В отличие от objectOrEmpty массив не становится словарём числовых ключей.
 */
export function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Возвращает объект без массива либо явное отсутствие значения.
 * Ссылка и прототип принятого объекта сохраняются без копирования.
 */
export function recordOrNull(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
