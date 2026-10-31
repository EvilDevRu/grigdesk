interface BoardTask {
  id: string | number;
  title?: unknown;
  group?: unknown;
  responsible?: unknown;
}

interface AnalysisRow {
  analysis?: {
    risk?: number | null;
    complexity?: number | null;
    diff_size?: string | null;
    generated_at?: string | null;
    needs_clarification?: boolean | null;
    confidence?: string | null;
  } | null;
}

type AnalysisByTask = Record<string, AnalysisRow | null | undefined>;

interface ResetOptions {
  query?: unknown;
  onlyUnrated?: boolean;
  onlyNeedsInfo?: boolean;
  favoriteOnly?: boolean;
  newOnly?: boolean;
  sortBy?: string;
  taskCount?: unknown;
}

interface BoardSelection<T> extends ResetOptions {
  tasks?: T[];
  analysisByTask?: AnalysisByTask;
  favoriteTaskIds?: Array<string | number>;
  seenTaskIds?: Array<string | number>;
}

// Чистая логика основного списка доски. Не зависит от Vue/Pinia и поэтому отдельно
// фиксирует поиск, сочетание фильтров и сохранение трекера-порядка.
const SIZE_ORDER: Record<string, number> = {
  S: 1,
  M: 2,
  L: 3,
  XL: 4,
};

function normalizeSearch(value: unknown): string {
  return String(value ?? '').toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').replaceAll('#', '');
}

/**
 * Слова запроса могут относиться к разным полям задачи. Номер со знаком # и «е/ё»
 * находятся одинаково; тот же поиск используется в списках контроля и поручений.
 */
export function matchesBoardTask(task: BoardTask, query: unknown): boolean {
  const terms = normalizeSearch(query).trim().split(/\s+/).filter(Boolean);
  const text = normalizeSearch([task.id, task.title, task.group, task.responsible].join(' '));

  return terms.every((term) => text.includes(term));
}

function triageRow(analysisByTask: AnalysisByTask, task: BoardTask) {
  return analysisByTask?.[task.id] || analysisByTask?.[String(task.id)] || null;
}

/**
 * Сортирует только по известной оценке, сохраняя прежнее место задач без разбора.
 * Значения трекера не переписываются: вычисляется отдельная числовая метрика.
 */
function metric(task: BoardTask, sortBy: string, analysisByTask: AnalysisByTask): number {
  const analysis = triageRow(analysisByTask, task)?.analysis;

  if (!analysis) {
    return -1;
  }
  if (sortBy === 'risk') {
    return analysis.risk || 0;
  }
  if (sortBy === 'complexity') {
    return analysis.complexity || 0;
  }
  if (sortBy === 'size') {
    return SIZE_ORDER[analysis.diff_size!] || 0;
  }
  if (sortBy === 'fresh') {
    return Date.parse((analysis.generated_at || 0) as string) || 0;
  }

  return 0;
}

/**
 * Совмещает фильтры без потери полей задач и порядка исходного списка трекера.
 * Сортировка создаёт копию, чтобы вызывающий сохранил исходную последовательность.
 */
export function selectBoardTasks<T extends BoardTask = BoardTask>({
  tasks = [],
  analysisByTask = {},
  query = '',
  sortBy = 'tracker',
  onlyUnrated = false,
  onlyNeedsInfo = false,
  favoriteOnly = false,
  favoriteTaskIds = [],
  newOnly = false,
  seenTaskIds = [],
}: BoardSelection<T> = {}): T[] {
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
  if (sortBy !== 'tracker') {
    list = [...list].sort(
      (left, right) => metric(right, sortBy, analysisByTask)
        - metric(left, sortBy, analysisByTask),
    );
  }

  return list;
}

/**
 * Объединяет только параметры, при изменении которых список начинает показ сначала.
 * Прежние преобразования строк и чисел сохраняют устойчивость ключа между рендерами.
 */
export function boardTaskListResetKey({
  query = '',
  onlyUnrated = false,
  onlyNeedsInfo = false,
  favoriteOnly = false,
  newOnly = false,
  sortBy = 'tracker',
  taskCount = 0,
}: ResetOptions = {}): string {
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
