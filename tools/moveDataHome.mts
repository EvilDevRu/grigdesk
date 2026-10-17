import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { dataHome } from '../shared/runtime/dataHome.ts';
import { applyMove, assertSafeContext, backMove, dropLinks, inside, planMove } from './moveDataHomeCore.ts';
import type { MoveContext } from './moveDataHomeCore.ts';
import { moveRuntimeDeps } from './moveDataHomeRuntime.ts';

type MoveMode = 'plan' | 'apply' | 'back' | 'drop-links';

/**
 * Сначала разбирает режим и тестовую границу, не читая ни одного файла данных.
 * Режимы изменения допускаются только после проверки домашнего каталога и признака агента.
 */
function request(args: string[], env: NodeJS.ProcessEnv): { context: MoveContext; mode: MoveMode } {
  let mode: MoveMode = 'plan';
  let codeRoot: string | undefined;
  let userHome: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--code-root' || arg === '--home') {
      const value = args[++index];
      // Ссылка из временного каталога на настоящий репозиторий не должна пройти проверку.
      const real = value && existsSync(value) ? realpathSync(value) : value;

      if (!value || !real || !path.isAbsolute(value) || !inside(realpathSync(os.tmpdir()), real)) {
        throw new Error('Тестовые пути должны быть абсолютными и находиться внутри os.tmpdir().');
      }

      if (arg === '--code-root' && codeRoot === undefined) {
        codeRoot = value;
      } else if (arg === '--home' && userHome === undefined) {
        userHome = value;
      } else {
        throw new Error('Тестовая опция повторена.');
      }
    } else if (['--apply', '--back', '--drop-links'].includes(arg ?? '') && mode === 'plan') {
      mode = arg!.slice(2) as MoveMode;
    } else {
      throw new Error(`Неверный аргумент: ${arg}`);
    }
  }

  if (Boolean(codeRoot) !== Boolean(userHome)) {
    throw new Error('Тестовые --code-root и --home задаются только вместе.');
  }

  const testing = Boolean(codeRoot && userHome);
  // Без конечной «/»: с ней не совпала бы строка EnvironmentFile установленного юнита.
  const repositoryRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
  const context: MoveContext = {
    codeRoot: codeRoot ?? repositoryRoot,
    userHome: userHome ?? os.homedir(),
    home: dataHome({ env, home: userHome ?? os.homedir() }),
    env,
  };

  if (mode !== 'plan' && process.getuid?.() === 0) {
    throw new Error('Перенос от root запрещён: запустите команду от своего пользователя.');
  }

  if (mode !== 'plan' && (env.CLAUDECODE !== undefined || (!testing
    && (env.HOME !== os.userInfo().homedir || inside(os.tmpdir(), context.home))))) {
    throw new Error('Перенос выполняется человеком из обычной консоли с его HOME.');
  }

  if (testing && !inside(os.tmpdir(), context.home)) {
    throw new Error('Папка данных теста должна находиться внутри os.tmpdir().');
  }

  assertSafeContext(context, {
    testing: env.NODE_TEST_CONTEXT !== undefined,
    tempDir: os.tmpdir(),
    repositoryRoot,
  });

  return { context, mode };
}

/**
 * Отдельно сообщает ошибку аргументов и отказ условий размещения.
 * До прохождения обеих проверок ядро переноса не вызывается.
 */
async function main(): Promise<number> {
  let parsed: ReturnType<typeof request>;

  try {
    parsed = request(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return 2;
  }

  const { context } = parsed;

  if (inside(context.codeRoot, context.home) || inside(context.home, context.codeRoot)
    || path.resolve(context.home) === path.resolve(context.userHome)) {
    console.error('Папка данных не должна совпадать с HOME или пересекаться с корнем кода.');

    return 1;
  }

  const deps = moveRuntimeDeps();
  const operations = {
    plan: planMove,
    apply: applyMove,
    back: backMove,
    'drop-links': dropLinks,
  };

  try {
    const result = await operations[parsed.mode](context, deps);

    for (const line of result.messages) {
      console.log(line);
    }

    if ('steps' in result) {
      const plan = result as Awaited<ReturnType<typeof planMove>>;

      for (const line of [...plan.steps, ...plan.warnings]) {
        console.log(line);
      }
    }

    return result.code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));

    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
