import { BOARD_TIMER_ROLES, type TimerRole, type TimerRoles } from './boardTimerTasks.ts';
import type { BoardTask } from './boardContracts.ts';
import { taskReferenceKey } from '../../../shared/tasks/taskReference.ts';

/**
 * Первый отрицательный ответ удерживает только поля таймера; второй снимает признак.
 * Свежая роль и остальные поля сохраняются. Подтверждённая пауза не сглаживается.
 */
export function stabilizeTimerRoles(
  previous: TimerRoles | null | undefined, next: TimerRoles, held: ReadonlySet<string>,
  confirmedStops: ReadonlySet<string> = new Set(),
): { roles: TimerRoles; held: Set<string> } {
  const roles: TimerRoles = {};

  for (const role of BOARD_TIMER_ROLES) {
    roles[role] = [...(next[role] ?? [])];
  }

  const resultHeld = new Set<string>();

  if (!previous) {
    return { roles, held: resultHeld };
  }

  const before = indexRoles(previous);
  const after = indexRoles(roles);

  for (const [key, entry] of before) {
    const fresh = after.get(key);

    if (entry.task.timerRunning !== true || fresh?.task.timerRunning === true
      || held.has(key) || confirmedStops.has(String(entry.task.id))) {
      continue;
    }

    if (fresh) {
      roles[fresh.role]![fresh.index] = {
        ...fresh.task,
        timerRunning: true,
        timerStartedAt: entry.task.timerStartedAt,
        timerElapsed: entry.task.timerElapsed,
      };
    } else {
      roles[entry.role]!.push({ ...entry.task });
    }

    resultHeld.add(key);
  }

  return { roles, held: resultHeld };
}

/**
 * Индексирует первое вхождение по полной ссылке задачи, сохраняя реальную роль и индекс.
 * Два линейных обхода избегают повторного поиска по всем спискам для каждого таймера.
 */
function indexRoles(roles: TimerRoles) {
  const result = new Map<string, {
    task: BoardTask;
    role: TimerRole;
    index: number
  }>();

  for (const role of BOARD_TIMER_ROLES) {
    for (const [index, task] of (roles[role] ?? []).entries()) {
      const key = taskReferenceKey(task);

      if (!result.has(key)) {
        result.set(key, {
          task,
          role,
          index
        });
      }
    }
  }

  return result;
}
