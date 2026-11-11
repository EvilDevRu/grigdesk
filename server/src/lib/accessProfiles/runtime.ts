import { AsyncLocalStorage } from 'node:async_hooks';

const environments = new AsyncLocalStorage<{
  env: NodeJS.ProcessEnv;
  keys?: readonly string[];
  current?: () => Promise<boolean>;
}>();

/**
 * Окружение принадлежит одному снимку и следует только за его async-вызовами.
 * Никакое чтение профиля не изменяет process.env соседнего запуска.
 */
export function withAccessEnvironment<T>(env: NodeJS.ProcessEnv, action: () => T,
  current?: () => Promise<boolean>, keys?: readonly string[]): T {
  return environments.run({
    env,
    current,
    keys,
  }, action);
}

/**
 * Адаптер читает окружение своего async-снимка, не глобальное состояние сервера.
 * В старом вызове без профильного контекста сохраняется прежнее окружение.
 */
export function accessEnvironment(): NodeJS.ProcessEnv {
  return environments.getStore()?.env ?? process.env;
}

/**
 * Безопасное чтение после refresh сверяет актуальность до следующего HTTP-запроса.
 * Отозванный снимок не запускает продолжение цепочки со старым токеном.
 */
export async function accessIsCurrent(): Promise<boolean> {
  return await environments.getStore()?.current?.() ?? true;
}

/**
 * Shell может экспортировать другой ключ; access overlay применяется последним.
 * Удалённый из снимка секрет не возвращается из окружения пользовательского терминала.
 */
export function applyAccessEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const selected = environments.getStore();
  const env = { ...base };

  for (const key of selected?.keys ?? []) {
    delete env[key];

    if (selected?.env[key] !== undefined) {
      env[key] = selected.env[key];
    }
  }

  return env;
}
