interface BoardTask {
  id?: unknown;
  timerRunning?: unknown;
}

// Сводка новых задач для навигации и списка; активные таймеры нужны топбару.
// Новой считается задача из основного списка «Мои задачи», которую ещё не открывали:
// отметки просмотра приходят с сервера (`/api/tracker/task-seen`), поэтому просмотр
// на одном устройстве гасит метку на всех.

function normalizedId(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }

  return String(value).trim();
}

/**
 * Нормализует идентификаторы задач в прежнем порядке без повторов и пустых значений.
 * Этот список одинаково используется навигацией и отметками просмотра доски.
 */
export function boardTaskIds(tasks: BoardTask[] = []): string[] {
  return [...new Set((Array.isArray(tasks) ? tasks : [])
    .map((task) => normalizedId(task?.id))
    .filter(Boolean))];
}

/**
 * Разделяет живые таймеры и новые задачи: остановленный таймер не считается активным.
 * До загрузки отметок просмотра сводка новых задач остаётся пустой.
 */
export function boardActivity(
  dashboard: { tasks?: BoardTask[] } | null | undefined,
  seenTaskIds: unknown[] = [],
  { ready = true }: { ready?: boolean } = {},
): {
  activeTimerCount: number;
  unseenCount: number;
  unseenTaskIds: string[];
} {
  const tasks = Array.isArray(dashboard?.tasks) ? dashboard.tasks : [];
  const seen = new Set((Array.isArray(seenTaskIds) ? seenTaskIds : [])
    .map(normalizedId)
    .filter(Boolean));

  // Сводка таймеров отвечает на вопрос «что выполняется прямо сейчас», поэтому начатые,
  // но поставленные на паузу задачи сюда не входят. После остановки B24 может
  // оставить старый activeTimer, поэтому источник истины — живой флаг задачи.
  const activeTimerCount = tasks.filter((task) => !!task?.timerRunning).length;

  // Без базовой линии отметок «новых» не бывает вовсе: пустой набор означает
  // «ещё не знаем», а не «ни одной задачи не смотрели».
  const unseenTaskIds = ready ? boardTaskIds(tasks).filter((id) => !seen.has(id)) : [];

  return {
    activeTimerCount,
    unseenCount: unseenTaskIds.length,
    unseenTaskIds,
  };
}
