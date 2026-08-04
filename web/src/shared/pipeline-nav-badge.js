// Сводка для составного чипа «Конвейер» в сайдбаре. Категории обязаны быть
// взаимоисключающими: один и тот же ход может одновременно числиться живым и молчащим,
// а задача на воротах — ещё и иметь аварийный флаг. В круге она должна занимать ровно
// один сектор, с приоритетом аварии над воротами и ворот над обычной работой.

function taskIds(items) {
  return new Set((items || []).map((x) => String(x.task)));
}

/**
 * @param {{waiting?: Array, stalled?: Array, silent?: Array, running?: Array}} state
 * @returns {{errorCount: number, waitingCount: number, runningCount: number,
 *   attentionCount: number, totalCount: number, errorEnd: number, waitingEnd: number}}
 */
export function pipelineBadgeSummary(state = {}) {
  const errors = taskIds([...(state.stalled || []), ...(state.silent || [])]);
  const waiting = taskIds(state.waiting);
  const running = taskIds(state.running);

  errors.forEach((id) => {
    waiting.delete(id);
    running.delete(id);
  });
  waiting.forEach((id) => running.delete(id));

  const errorCount = errors.size;
  const waitingCount = waiting.size;
  const runningCount = running.size;
  const attentionCount = errorCount + waitingCount;
  const totalCount = attentionCount + runningCount;

  return {
    errorCount,
    waitingCount,
    runningCount,
    attentionCount,
    totalCount,
    errorEnd: totalCount ? (errorCount / totalCount) * 100 : 0,
    waitingEnd: totalCount ? ((errorCount + waitingCount) / totalCount) * 100 : 0,
  };
}
