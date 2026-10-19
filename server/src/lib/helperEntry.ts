import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Различает прямой запуск исходника и вызов из собранного helper-а.
 *
 * После esbuild `import.meta.url` исходника равен URL helper-а, поэтому обычный
 * guard сработал бы второй раз. Сгенерированный вход ставит маркер до динамического
 * импорта модуля; тогда CLI выполняет ровно один явный вызов main.
 */

const MARKER = '__grigdeskHelperEntry';

type MarkedGlobal = typeof globalThis & {
  __grigdeskHelperEntry?: string;
};

/**
 * Ставит маркер собранного helper-а до импорта модуля с main.
 * Повторный вызов с другим id допустим: каждый helper живёт отдельным процессом.
 */
export function markHelperEntry(id: string): void {
  (globalThis as MarkedGlobal)[MARKER] = id;
}

/**
 * Проверяет, что файл запущен напрямую, а не загружен сгенерированным entry.
 * Пустой argv[1] и собранный helper дают false; исходник под Node — true.
 */
export function isDirectRun(moduleUrl: string): boolean {
  if ((globalThis as MarkedGlobal)[MARKER]) {
    return false;
  }

  const entry = process.argv[1];

  if (!entry) {
    return false;
  }

  return path.resolve(entry) === fileURLToPath(moduleUrl);
}
