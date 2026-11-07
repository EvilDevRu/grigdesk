// Построчный дифф для правок агента (шаг Edit в ленте чата).
// Нужен, чтобы правка выглядела как в VS Code — «убрано / добавлено» с подсветкой,
// а не двумя простынями «было»/«стало». Алгоритм — LCS по строкам; на больших
// кусках вырождается в «всё убрали, всё добавили» (дешевле, чем считать O(n²) зря).
interface DiffRow {
  t: 'ctx' | 'del' | 'add';
  text: string;
}

interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
}

const MAX_LINES = 400;

/**
 * Сопоставляет строки через LCS и сохраняет общий контекст между изменениями.
 * Большие входы показываются целиком без квадратичной таблицы сравнения.
 */
export function lineDiff(oldText: unknown, newText: unknown): DiffResult {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return {
      rows: [...a.map((text) => ({ t: 'del' as const, text })),
        ...b.map((text) => ({ t: 'add' as const, text }))],
      removed: a.length,
      added: b.length,
    };
  }

  // Таблица длин LCS.
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      // Индексы ограничены размерами строк и дополнительным рядом таблицы LCS.
      dp[i]![j] = a[i] === b[j]
        ? dp[i + 1]![j + 1]! + 1
        : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ t: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ t: 'del', text: a[i]! });
      removed++;
      i++;
    } else {
      rows.push({ t: 'add', text: b[j]! });
      added++;
      j++;
    }
  }

  while (i < n) {
    rows.push({ t: 'del', text: a[i++]! });
    removed++;
  }

  while (j < m) {
    rows.push({ t: 'add', text: b[j++]! });
    added++;
  }

  return {
    rows,
    added,
    removed,
  };
}

// Сервер режет длинный patch посередине и оставляет между половинами эту строку
// без знака стороны. В ленте она обязана остаться видимым разрывом: иначе конец
// одного фрагмента склеивается с началом другого, и правка читается как бессмыслица.
const CUT_MARKER = '… сокращено …';

/**
 * Содержимое файла целиком как дифф одной стороны: у созданного файла все строки
 * добавлены, у удалённого — все убраны. Так хранятся ленты, записанные до того, как
 * сервер стал разворачивать `add`/`delete` Codex в patch: в их `diff` лежит сам файл,
 * и разбор его как patch давал «+0 −0» с одинаковыми колонками.
 */
function wholeFileDiff(content: unknown, kind: string): DiffResult {
  const t = kind === 'delete' ? 'del' : 'add';
  const text = String(content ?? '');

  if (!text) {
    return {
      rows: [],
      added: 0,
      removed: 0,
    };
  }

  const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
  const rows = lines.map<DiffRow>((line) => (
    line === CUT_MARKER ? { t: 'ctx', text: CUT_MARKER } : { t, text: line }
  ));
  const changed = rows.length - rows.filter((row) => row.t === 'ctx').length;

  return {
    rows,
    added: t === 'add' ? changed : 0,
    removed: t === 'del' ? changed : 0,
  };
}

/**
 * Разбирает unified patch одного файла в тот же нейтральный набор строк, который
 * возвращает lineDiff. Заголовки файла и границы hunks не являются строками кода;
 * между несколькими hunks оставляем контекстный разделитель, чтобы splitRows не
 * склеил удаление из одного фрагмента с добавлением из следующего.
 * Для `add`/`delete` текст без hunks — не patch, а сам файл (см. wholeFileDiff).
 *
 */
export function unifiedDiff(patch: unknown, kind = 'update'): DiffResult {
  const lines = String(patch ?? '').split('\n').map((line) => (
    line.endsWith('\r') ? line.slice(0, -1) : line
  ));
  const hasHunks = lines.some((line) => line.startsWith('@@'));

  if (!hasHunks && (kind === 'add' || kind === 'delete')) {
    return wholeFileDiff(patch, kind);
  }


  const rows: DiffRow[] = [];
  let inHunk = !hasHunks;
  let added = 0;
  let removed = 0;

  for (const line of lines) {
    if (line.startsWith('@@')) {
      if (inHunk && rows.length && rows.at(-1)?.text !== '…') {
        rows.push({ t: 'ctx', text: '…' });
      }

      inHunk = true;
      continue;
    }
    if (line === CUT_MARKER) {
      rows.push({ t: 'ctx', text: CUT_MARKER });
      continue;
    }
    if (!inHunk || line === '\\ No newline at end of file') {
      continue;
    }

    // У patch без @@ всё ещё могут присутствовать стандартные заголовки файла.
    if (!hasHunks && (
      line.startsWith('diff --git ')
      || line.startsWith('index ')
      || line.startsWith('new file mode ')
      || line.startsWith('deleted file mode ')
      || line.startsWith('similarity index ')
      || line.startsWith('rename from ')
      || line.startsWith('rename to ')
      || line.startsWith('--- ')
      || line.startsWith('+++ ')
    )) {
      continue;
    }

    if (line.startsWith('-')) {
      rows.push({ t: 'del', text: line.slice(1) });
      removed++;
    } else if (line.startsWith('+')) {
      rows.push({ t: 'add', text: line.slice(1) });
      added++;
    } else if (line.startsWith(' ')) {
      rows.push({ t: 'ctx', text: line.slice(1) });
    }
  }

  return {
    rows,
    added,
    removed,
  };
}

/**
 * Те же строки, но парами для показа в две колонки: слева убранное, справа добавленное.
 * Идущие подряд del/add ставятся друг напротив друга (как в split-виде дифф-просмотрщиков),
 * лишние строки одной из сторон получают пустого соседа.
 */
export function splitRows(rows: DiffRow[]): Array<{ l: DiffRow | null; r: DiffRow | null }> {
  const out: Array<{ l: DiffRow | null; r: DiffRow | null }> = [];

  for (let i = 0; i < rows.length;) {
    const r = rows[i]!;

    if (r.t === 'ctx') {
      out.push({ l: r, r });
      i++;

      continue;
    }

    // Собираем блок изменений целиком: сначала все убранные, потом все добавленные.
    const dels = [];
    const adds = [];

    while (i < rows.length && rows[i]!.t === 'del') {
      dels.push(rows[i++]!);
    }

    while (i < rows.length && rows[i]!.t === 'add') {
      adds.push(rows[i++]!);
    }

    for (let k = 0; k < Math.max(dels.length, adds.length); k++) {
      out.push({ l: dels[k] || null, r: adds[k] || null });
    }
  }

  return out;
}
