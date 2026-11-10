import type { BoardDashboard, BoardTask } from './boardContracts.ts';
import { taskReferenceKey } from '../../../shared/tasks/taskReference.ts';

const TIMER_ROLES = ['tasks', 'toReview', 'created', 'accomplice', 'auditor'] as const;

export type TimerRole = (typeof TIMER_ROLES)[number];

export type TimerRoles = Partial<Record<TimerRole, BoardTask[]>>;

/**
 * Порядок ролей повторяет поиск карточки задачи: сначала мои, затем контроль,
 * поставленные, соисполнение и наблюдение. Первый экземпляр задачи побеждает.
 */
export const BOARD_TIMER_ROLES: readonly TimerRole[] = TIMER_ROLES;

/**
 * Собирает задачи всех ролей снимка доски без повторов по ссылке задачи.
 * Отсутствующая роль и null-снимок дают пустой список, а не отказ.
 */
export function boardAllRoleTasks(data: BoardDashboard | null | undefined): BoardTask[] {
  const seen = new Set<string>();
  const result: BoardTask[] = [];

  for (const role of BOARD_TIMER_ROLES) {
    const list = data?.[role];

    if (!Array.isArray(list)) {
      continue;
    }

    for (const task of list) {
      const key = taskReferenceKey({
        id: task.id,
        source: task.source,
        driverId: task.driverId
      });

      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      result.push(task);
    }
  }

  return result;
}

/**
 * Выборка строк учёта для топбара: идущие задачи всех ролей плюс строки, поставленные
 * на паузу из этого окна, чтобы кнопку продолжения учёта не приходилось искать заново.
 */
export function selectTopbarTimerTasks(
  data: BoardDashboard | null | undefined, pausedKeys: ReadonlySet<string> = new Set(),
): BoardTask[] {
  return boardAllRoleTasks(data).filter((task) => {
    const key = taskReferenceKey({
      id: task.id,
      source: task.source,
      driverId: task.driverId
    });

    return task.timerRunning === true || pausedKeys.has(key);
  });
}
