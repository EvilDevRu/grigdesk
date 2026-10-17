/**
 * Проверяет границу UTF-16, которая разделяет старший и младший surrogate.
 * Края строки и одиночные surrogate не считаются разрезанной парой.
 */
export function splitsUtf16Character(text: string, at: number): boolean {
  if (at <= 0 || at >= text.length) {
    return false;
  }

  const before = text.charCodeAt(at - 1);
  const after = text.charCodeAt(at);

  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

/**
 * Сравнивает строки по правилам операторов JS, без локали и числовой сортировки.
 * Такой порядок стабилен для ключей и не зависит от языка процесса.
 */
export function lexical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Обрезает пробелы только у строки, не преобразуя остальные значения.
 * Отсутствующее или неверно типизированное значение даёт пустую строку.
 */
export function trimmedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Сохраняет строку как есть, включая пустую строку и пробелы.
 * Запасное значение применяется только к входу другого типа.
 */
export function textOr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Декодирует компонент URI, сохраняя повреждённую строку без потерь.
 * Плюс остаётся плюсом: это не декодер form-urlencoded.
 */
export function decodeUriComponentOrOriginal(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Экранирует один сегмент JSON Pointer в порядке, заданном форматом.
 * Уже экранированный текст не считается готовым сегментом и экранируется повторно.
 */
export function jsonPointerPart(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
