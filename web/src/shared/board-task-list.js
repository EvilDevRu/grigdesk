// Чистая логика основного списка доски. Не зависит от Vue/Pinia и поэтому отдельно
// фиксирует поиск, сочетание фильтров и сохранение B24-порядка.
const SIZE_ORDER = { S: 1, M: 2, L: 3, XL: 4 };

function normalizeSearch(value) {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replaceAll('#', '');
}

/**
 * Слова запроса могут относиться к разным полям задачи. Номер со знаком # и «е/ё»
 * находятся одинаково; тот же поиск используется в списках контроля и поручений.
 */
export function matchesBoardTask(task, query) {
  const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const text = normalizeSearch([task.id, task.title, task.group, task.responsible].join(' '));

  return terms.every((term) => text.includes(term));
}

function triageRow(analysisByTask, task) {
  return analysisByTask?.[task.id] || analysisByTask?.[String(task.id)] || null;
}

function metric(task, sortBy, analysisByTask) {
  const analysis = triageRow(analysisByTask, task)?.analysis;
  if (!analysis) return -1;
  if (sortBy === 'risk') return analysis.risk || 0;
  if (sortBy === 'complexity') return analysis.complexity || 0;
  if (sortBy === 'size') return SIZE_ORDER[analysis.diff_size] || 0;
  if (sortBy === 'fresh') return Date.parse(analysis.generated_at || 0) || 0;
  return 0;
}

export function selectBoardTasks({
  tasks = [],
  analysisByTask = {},
  query = '',
  sortBy = 'b24',
  onlyUnrated = false,
  onlyNeedsInfo = false,
  favoriteOnly = false,
  favoriteTaskIds = [],
  newOnly = false,
  seenTaskIds = [],
} = {}) {
  let list = Array.isArray(tasks) ? tasks : [];
  if (String(query).trim()) {
    list = list.filter((task) => matchesBoardTask(task, query));
  }

  if (favoriteOnly) {
    const favorites = new Set((favoriteTaskIds || []).map(String));
    list = list.filter((task) => favorites.has(String(task.id)));
  }
  // Новая — та, которую ещё не открывали. Отметки приходят с сервера, поэтому
  // фильтр включается только с их загруженной базовой линией (см. BoardView).
  if (newOnly) {
    const seen = new Set((seenTaskIds || []).map(String));
    list = list.filter((task) => !seen.has(String(task.id)));
  }
  if (onlyUnrated) {
    list = list.filter((task) => !triageRow(analysisByTask, task)?.analysis);
  }
  if (onlyNeedsInfo) {
    list = list.filter((task) => {
      const analysis = triageRow(analysisByTask, task)?.analysis;
      return !!analysis && (analysis.needs_clarification || analysis.confidence === 'low');
    });
  }
  if (sortBy !== 'b24') {
    list = [...list].sort(
      (left, right) => metric(right, sortBy, analysisByTask)
        - metric(left, sortBy, analysisByTask),
    );
  }
  return list;
}

export function boardTaskListResetKey({
  query = '',
  onlyUnrated = false,
  onlyNeedsInfo = false,
  favoriteOnly = false,
  newOnly = false,
  sortBy = 'b24',
  taskCount = 0,
} = {}) {
  return JSON.stringify([
    String(query),
    !!onlyUnrated,
    !!onlyNeedsInfo,
    !!favoriteOnly,
    !!newOnly,
    String(sortBy),
    Number(taskCount) || 0,
  ]);
}
