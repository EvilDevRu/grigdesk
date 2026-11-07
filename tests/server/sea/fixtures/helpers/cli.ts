// Фикстура helper-а: экспортируемый main, совместимое имя и прямой запуск исходника.
import { appendFileSync, readFileSync } from 'node:fs';
import { isDirectRun } from '../../../../../server/src/lib/helperEntry.ts';

export interface HelperDeps {
  readStdin?: () => string;
}

/**
 * Одна операция helper-а: читает stdin, пишет argv/input, считает запуски.
 * Возвращает код выхода, который точка входа переносит в process.exitCode.
 * Чтение stdin подменяемо: библиотечный вызов не имеет права ждать чужой поток.
 */
export function main(argv: string[], deps: HelperDeps = {}): number {
  const input = (deps.readStdin ?? (() => readFileSync(0, 'utf8')))();
  const counter = process.env.HELPER_COUNTER;

  if (counter) {
    appendFileSync(counter, 'run\n');
  }

  process.stdout.write(JSON.stringify({
    argv,
    input
  }));

  if (argv.includes('--fail')) {
    process.stderr.write('expected failure\n');

    return 3;
  }

  return 0;
}

export const legacyMain = main;

if (isDirectRun(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
