// Отпечатки зависят от семантики значений, а не времени опроса или порядка ключей.
// Порядок массивов, включая enum, остаётся значимым.

import { createHash } from 'node:crypto';

/**
 * Каноническая запись рекурсивно упорядочивает только ключи объектов.
 * Она используется внутри сервера и не публикует приватное содержимое.
 */
export function canonicalSettingsJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalSettingsJson).join(',')}]`;
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));

    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSettingsJson(item)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value) ?? 'null';
}

/**
 * Короткий отпечаток скрывает значения от публичных ревизий.
 * Случайные идентификаторы и пути временного профиля сюда не передаются.
 */
export function settingsFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalSettingsJson(value)).digest('hex');
}
