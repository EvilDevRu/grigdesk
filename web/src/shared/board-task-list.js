// Чистая логика основного списка доски. Не зависит от Vue/Pinia и поэтому отдельно
// фиксирует поиск, сочетание фильтров и сохранение B24-порядка.
const SIZE_ORDER = { S: 1, M: 2, L: 3, XL: 4 };

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
} = {}) {
  let list = Array.isArray(tasks) ? tasks : [];
  const search = String(query).trim().toLowerCase();
  if (search) {
    list = list.filter((task) => String(task.id).includes(search)
      || String(task.title || '').toLowerCase().includes(search)
      || String(task.group || '').toLowerCase().includes(search));
  }

  if (favoriteOnly) {
    const favorites = new Set((favoriteTaskIds || []).map(String));
    list = list.filter((task) => favorites.has(String(task.id)));
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
  sortBy = 'b24',
  taskCount = 0,
} = {}) {
  return JSON.stringify([
    String(query),
    !!onlyUnrated,
    !!onlyNeedsInfo,
    !!favoriteOnly,
    String(sortBy),
    Number(taskCount) || 0,
  ]);
}
