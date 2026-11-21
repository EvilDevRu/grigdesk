import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

const names = new Set([
  'tracker', 'routes', 'pipeline', 'voice',
  'grigdesk-relay', 'grigdesk-ctl', 'grigdesk-maintenance',
]);

/**
 * Возвращает физический тестовый executable в указанном каталоге сборки.
 * Плохая настройка стенда прерывает тест до проверки поведения команды.
 */
export function goCandidate(name: string): string {
  const dir = process.env.GRIGDESK_GO_UTILITIES_TEST_BIN_DIR ?? '';

  if (!names.has(name) || !path.isAbsolute(dir)) {
    throw new Error('Требуется абсолютный тестовый каталог Go и известное имя команды');
  }

  const root = realpathSync(dir);

  if (root !== dir) {
    throw new Error('Тестовый каталог должен быть физическим путём');
  }

  const entry = path.join(root, name.replace(/^grigdesk-/, ''));
  const file = statSync(entry);

  if (realpathSync(entry) !== entry || !file.isFile() || (file.mode & 0o100) === 0) {
    throw new Error('Неверный тестовый Go executable ' + name);
  }

  return entry;
}
