// Сводка для чипа «Доска» в навигации.
// Новыми считаются задачи из основного списка «Мои задачи», которых не было
// в снимке при последнем просмотре доски.

function normalizedId(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

export function boardTaskIds(tasks = []) {
  return [...new Set((Array.isArray(tasks) ? tasks : [])
    .map((task) => normalizedId(task?.id))
    .filter(Boolean))];
}

export function boardActivity(dashboard, seenTaskIds = []) {
  const tasks = Array.isArray(dashboard?.tasks) ? dashboard.tasks : [];
  const seen = new Set((Array.isArray(seenTaskIds) ? seenTaskIds : [])
    .map(normalizedId)
    .filter(Boolean));

  // Чип отвечает на вопрос «что выполняется прямо сейчас», поэтому начатые,
  // но поставленные на паузу задачи сюда не входят. После остановки B24 может
  // оставить старый activeTimer, поэтому источник истины — живой флаг задачи.
  const activeTimerCount = tasks.filter((task) => !!task?.timerRunning).length;

  const unseenTaskIds = boardTaskIds(tasks).filter((id) => !seen.has(id));

  return {
    activeTimerCount,
    unseenCount: unseenTaskIds.length,
    unseenTaskIds,
  };
}
