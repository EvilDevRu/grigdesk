import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyBrandMove, backBrandMove, dropBrandLinks, planBrandMove } from './brandMoveCore.ts';
import type { BrandContext } from './brandMoveCore.ts';
import { inside } from './brandMoveFiles.ts';
import { brandRuntimeDeps } from './brandMoveRuntime.ts';

/**
 * Сначала проверяет все тестовые аргументы лексически, не открывая файлов.
 * Канонические пути проверяются только после этой границы и не могут выйти из /tmp.
 */
export function parseBrandRequest(args: string[], env: NodeJS.ProcessEnv): {
  context: BrandContext;
  mode: 'plan' | 'apply' | 'back' | 'drop-links';
} {
  let mode: 'plan' | 'apply' | 'back' | 'drop-links' = 'plan';
  const paths: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === '--code-root' || arg === '--home') {
      const value = args[++index];

      if (!value || !path.isAbsolute(value) || !inside(os.tmpdir(), value) || paths[arg]) {
        throw new Error('Тестовые пути должны находиться внутри os.tmpdir() и не повторяться.');
      }

      paths[arg] = value;
    } else if (mode === 'plan' && ['--apply', '--back', '--drop-links'].includes(arg)) {
      mode = arg.slice(2) as typeof mode;
    } else {
      throw new Error(`Неверный аргумент: ${arg}`);
    }
  }

  if (Boolean(paths['--code-root']) !== Boolean(paths['--home'])) {
    throw new Error('Тестовые --code-root и --home задаются только вместе.');
  }

  if (env.CLAUDECODE !== undefined) {
    throw new Error('Команду запускает владелец из обычной консоли.');
  }

  const testing = Boolean(paths['--home']);

  if (!testing && (env.HOME !== os.userInfo().homedir || process.env.NODE_TEST_CONTEXT !== undefined)) {
    throw new Error('Для запуска нужен настоящий HOME владельца или временная тестовая раскладка.');
  }

  for (const value of Object.values(paths)) {
    if (!inside(fs.realpathSync(os.tmpdir()), fs.realpathSync(value))) {
      throw new Error('Тестовая ссылка выходит за os.tmpdir().');
    }
  }

  const context: BrandContext = {
    codeRoot: paths['--code-root'] ?? fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, ''),
    userHome: paths['--home'] ?? os.homedir(),
    env,
  };

  return { context, mode };
}

/**
 * Режим без флага только печатает план; зависимости создаются после проверки аргументов.
 * Все изменения выполняет ядро с проверками занятости и журналом восстановления.
 */
async function main(): Promise<number> {
  let request: ReturnType<typeof parseBrandRequest>;

  try {
    request = parseBrandRequest(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Ошибка аргументов.');

    return 2;
  }

  const operations = {
    plan: planBrandMove,
    apply: applyBrandMove,
    back: backBrandMove,
    'drop-links': dropBrandLinks,
  };
  const result = await operations[request.mode](request.context, brandRuntimeDeps());

  for (const message of result.messages) {
    console.log(message);
  }

  if ('actions' in result) {
    const plan = result as Awaited<ReturnType<typeof planBrandMove>>;

    for (const message of [...plan.actions, ...plan.kept]) {
      console.log(message);
    }
  }

  return result.code;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
