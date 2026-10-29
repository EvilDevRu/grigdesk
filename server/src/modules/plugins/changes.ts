import type { PluginAdmission } from './lifecycle.ts';

import type { PluginChange, PluginTransition } from '../../../../packages/plugin-types/src/server.ts';

export type { PluginChange, PluginTransition } from '../../../../packages/plugin-types/src/server.ts';

const CHANGE_TIMEOUT_MS = 5000;

/**
 * Ошибки проверки настроек имеют отдельные коды и безопасные тексты для человека.
 * Неизвестное исключение авторского кода не раскрывается через HTTP.
 */
export function changeError(code = 'plugin_change_rejected', message =
  'Плагин отклонил изменения настроек.'): Error & { code: string; statusCode: number } {
  return Object.assign(new Error(message), { code, statusCode: 409 });
}

/**
 * Известный отказ автора с кодом и статусом сохраняет понятное объяснение.
 * Остальные исключения заменяются общей причиной без внутренних данных плагина.
 */
function publicChangeError(error: unknown): unknown {
  const source = error as {
    statusCode?: number;
    code?: string;
    message?: string;
  } | null;

  if (source?.statusCode && source.statusCode >= 400 && source.statusCode < 500
    && typeof source.code === 'string' && /^[a-z_]+$/.test(source.code)
    && typeof source.message === 'string') {
    return error;
  }

  return changeError();
}

/**
 * Неверный transition обнаруживается до записи настроек и вызова commit.
 * Методы обязательны вместе: иначе ядро не сможет подтвердить применение и откат.
 */
function validateTransition(value: unknown): PluginTransition | undefined {
  if (value === undefined) {
    return undefined;
  }

  const transition = value as PluginTransition | null;

  if (!transition || typeof transition.commit !== 'function' || typeof transition.rollback !== 'function'
    || typeof transition.afterCommit !== 'function') {
    throw changeError();
  }

  return transition;
}

/**
 * Ожидание ограничивает HTTP, сохраняя само обещание для последующего cleanup.
 * Таймер очищается и при быстром успехе, и при отказе авторского кода.
 */
async function bounded<Result>(task: Promise<Result>): Promise<Result> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      task,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(changeError('plugin_change_timeout',
          'Проверка настроек плагина не завершилась за пять секунд.')), CHANGE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Откат освобождает reservation только после подтверждения cleanup.
 * Если автор не смог вернуть ресурсы, новые изменения остаются закрыты до рестарта.
 */
async function rollback(value: unknown, release: () => void, warn: () => void): Promise<void> {
  try {
    const transition = value as Partial<PluginTransition> | null;

    if (typeof transition?.rollback === 'function') {
      await transition.rollback();
    }

    release();
  } catch {
    warn();
  }
}

/**
 * Подготовка и замена одного runtime взаимно исключены до завершения cleanup.
 * Запись свежих prefs и commit не уступают управление; уведомление следует за ними.
 */
export async function writeUserPluginChange(gate: PluginAdmission | undefined, change: PluginChange,
  write: () => void, committed: () => void, warn: () => void): Promise<void> {
  if (!gate || gate.obsolete) {
    write();

    return;
  }

  const release = gate.beginChange();
  const controller = new AbortController();
  const hook = gate.options.lifecycle.prepareChange;
  const task = Promise.resolve().then(() => hook?.(structuredClone(change), controller.signal));
  let prepared: unknown;
  let transition: PluginTransition | undefined;

  try {
    prepared = await bounded(task);
    transition = validateTransition(prepared);
  } catch (error) {
    controller.abort();

    if ((error as { code?: string })?.code === 'plugin_change_timeout') {
      void task.then((late) => rollback(late, release, warn), () => release()).catch(warn);
    } else {
      await rollback(prepared, release, warn);
    }

    throw publicChangeError(error);
  }

  try {
    write();
  } catch (error) {
    await rollback(transition, release, warn);

    throw error;
  }

  transition?.commit();
  committed();

  const cleanup = Promise.resolve().then(() => transition?.afterCommit());

  void cleanup.then(release, () => {
    warn();
    release();
  });

  try {
    await bounded(cleanup);
  } catch {
    warn();
  }
}
