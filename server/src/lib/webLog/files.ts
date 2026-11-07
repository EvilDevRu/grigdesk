import { readdir } from 'node:fs/promises';

import { logParts } from '../../../../shared/node/logArchives.ts';

/**
 * Проверяет календарный UTC-день, прежде чем использовать его в имени файла.
 * Другие файлы каталога не принадлежат журналу и не читаются при экспорте.
 */
export function validUtcDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/**
 * Для каждого дня возвращает закрытые части по порядку, затем активный файл.
 * Прежний YYYY-MM-DD.ndjson остаётся совместимым без миграции содержимого.
 */
export async function webLogFiles(dir: string): Promise<Map<string, string[]>> {
  const names = await readdir(dir);
  const days = [...new Set(names.map((name) => name.slice(0, 10)).filter(validUtcDay))].sort();
  const result = new Map<string, string[]>();

  for (const day of days) {
    const base = `${day}.ndjson`;
    const files = logParts(names, base).map((part) => part.name);

    if (names.includes(base)) {
      files.push(base);
    }

    if (files.length) {
      result.set(day, files);
    }
  }

  return result;
}
