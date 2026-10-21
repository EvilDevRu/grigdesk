import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
// Сводка для счётчика внимания «Конвейер» в сайдбаре и popover в топбаре.
// Категории обязаны быть взаимоисключающими: один ход может одновременно числиться
// живым и молчащим, а задача на воротах — ещё и иметь аварийный флаг. В обоих
// местах задача должна занимать ровно одно место: авария важнее ворот, ворота важнее
// обычной работы.

import { trimmedText } from '../../../shared/lib/text.ts';

const PIPELINE_GROUPS = [
  {
    source: 'stalled',
    kind: 'error',
    messageKey: 'core.stalled',
    detail: 'title',
  },
  {
    source: 'silent',
    kind: 'error',
    messageKey: 'core.silent',
    detail: 'text',
  },
  {
    source: 'waiting',
    kind: 'waiting',
    messageKey: 'core.awaitingDecision2',
    detail: 'text',
  },
  {
    source: 'running',
    kind: 'running',
    messageKey: 'core.running',
    detail: null,
  },
];

/**
 * Один приоритетный список питает и цифры, и данные popover. Повтор задачи в более
 * слабой категории отбрасываем, чтобы их знаменатель никогда не разошёлся.
 */
function classifiedTasks(state = {}, locale = 'ru') {
  const t = localeTranslator(locale);
  const tasks = new Map();

  for (const group of PIPELINE_GROUPS) {
    for (const entry of state[group.source] || []) {
      const task = String(entry?.task ?? '').trim();

      if (!task || tasks.has(task)) {
        continue;
      }

      tasks.set(task, {
        task,
        entry,
        ...group,
        label: t(group.messageKey),
      });
    }
  }

  return [...tasks.values()];
}

/**
 * @param {{waiting?: Array, stalled?: Array, silent?: Array, running?: Array}} state
 * @returns {{errorCount: number, waitingCount: number, runningCount: number,
 *   attentionCount: number, totalCount: number, errorEnd: number, waitingEnd: number}}
 */
export function pipelineBadgeSummary(state = {}) {
  const tasks = classifiedTasks(state);
  const errorCount = tasks.filter((task) => task.kind === 'error').length;
  const waitingCount = tasks.filter((task) => task.kind === 'waiting').length;
  const runningCount = tasks.filter((task) => task.kind === 'running').length;
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

/**
 * Добавляет к тому же дедуплицированному списку уже загруженные название, текущий
 * этап и прогресс. Функция не делает запросов и не выдумывает отсутствующие поля.
 */
export function pipelineTopbarItems(state = {}, locale = 'ru') {
  return classifiedTasks(state, locale).map((item) => {
    const observed = state.observedByTask?.[item.task] || {};
    const progress = observed.progress;
    const validProgress = Number.isSafeInteger(progress?.done)
      && Number.isSafeInteger(progress?.total)
      && progress.done >= 0
      && progress.total >= 0;

    return {
      task: item.task,
      title: trimmedText(item.entry.taskTitle),
      kind: item.kind,
      stateLabel: item.label,
      detail: item.detail ? trimmedText(item.entry[item.detail]) : '',
      stage: trimmedText(observed.stage?.label),
      progress: validProgress
        ? { done: progress.done, total: progress.total }
        : null,
    };
  });
}
