import { compareSequences, DateTimeout } from './monacoDiffAdapter';

export type DiffDetail = 'line' | 'word' | 'char';
export type DiffWhitespace = 'all' | 'trim' | 'ignore-all';
export type DiffSide = 'old' | 'new';
export type DiffPreferences = {
  version: 1;
  collapse: boolean;
  context: '3' | '10' | 'all';
  detail: DiffDetail;
  whitespace: DiffWhitespace;
  renderWhitespace: boolean;
  sync: boolean;
  align: boolean;
};
export type SourceRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};
export type DiffHunk = {
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  oldRanges: SourceRange[];
  newRanges: SourceRange[];
};
export type UnifiedLine = {
  oldLine?: number;
  newLine?: number;
  kind: 'context' | DiffSide;
};
export type DiffResult = {
  hunks: DiffHunk[];
  unified: string;
  mapping: UnifiedLine[];
};
type NormalLine = {
  text: string;
  line: number;
  columns: number[];
};
type Token = {
  text: string;
  start: number;
  end: number;
};
type TokenSource = { tokens: Token[]; positions: { line: number; column: number }[] };

/**
 * Нормализует только сравнение и сохраняет координаты каждого исходного символа.
 * Модели редактора остаются сырыми, включая пробелы, табуляцию и пустые строки.
 */
function normalizedLines(content: string, mode: DiffWhitespace): NormalLine[] {
  return content.split('\n').flatMap((raw, index) => {
    const columns: number[] = [];
    let text = '';
    const start = mode === 'trim' ? raw.length - raw.trimStart().length : 0;
    const end = mode === 'trim' ? raw.trimEnd().length : raw.length;

    for (let column = start; column < end; column += 1) {
      const character = raw[column]!;

      if (mode !== 'ignore-all' || !/\s/u.test(character)) {
        text += character;
        columns.push(column + 1);
      }
    }

    columns.push(end + 1);

    return mode === 'ignore-all' && !text ? [] : [{
      text,
      line: index + 1,
      columns,
    }];
  });
}

/**
 * Привязывает токены слова или кодовой точки к исходным UTF-16 координатам.
 * Вставленный перевод строки соединяет несколько строк одного изменённого блока.
 */
function tokenize(lines: NormalLine[], detail: DiffDetail): TokenSource {
  let text = '';
  const positions: TokenSource['positions'] = [];

  for (const [index, line] of lines.entries()) {
    if (index) {
      text += '\n';

      const previous = lines[index - 1]!;

      positions.push({ line: previous.line, column: previous.columns.at(-1)! });
    }

    text += line.text;
    positions.push(...line.text.split('').map((_, column) => ({
      line: line.line,
      column: line.columns[column]!,
    })));
  }

  const last = lines.at(-1);

  positions.push({ line: last?.line || 1, column: last?.columns.at(-1) || 1 });

  const pattern = detail === 'word' ? /[\p{L}\p{N}_]+|[^\p{L}\p{N}_]/gu : /[\s\S]/gu;
  const tokens = [...text.matchAll(pattern)].map((match) => ({
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));

  return { tokens, positions };
}

/**
 * Возвращает непустой исходный диапазон для изменённых токенов одной стороны.
 * Отсутствующая сторона вставки не получает выдуманное выделение соседнего символа.
 */
function tokenRange(source: TokenSource, start: number, end: number): SourceRange[] {
  if (start === end) {
    return [];
  }

  const first = source.positions[source.tokens[start]!.start]!;
  const last = source.positions[source.tokens[end - 1]!.end]!;

  return [{
    startLineNumber: first.line,
    startColumn: first.column,
    endLineNumber: last.line,
    endColumn: last.column,
  }];
}

function sourceBoundary(lines: NormalLine[], offset: number, count: number): number {
  return lines[offset]?.line ?? count + 1;
}

/**
 * Строит единую колонку из сырых сторон и карту обоих исходных номеров.
 * Любое выделение или переход из обзора переводится обратно через эту карту.
 */
function unifiedModel(oldLines: string[], newLines: string[], hunks: DiffHunk[]): Pick<DiffResult,
  'unified' | 'mapping'> {
  const text: string[] = [];
  const mapping: UnifiedLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  for (const hunk of hunks) {
    while (newLine < hunk.newStart) {
      text.push(newLines[newLine - 1]!);
      mapping.push({
        oldLine,
        newLine,
        kind: 'context',
      });
      oldLine += 1;
      newLine += 1;
    }

    oldLine = hunk.oldStart;

    while (oldLine < hunk.oldEnd) {
      text.push(oldLines[oldLine - 1]!);
      mapping.push({ oldLine, kind: 'old' });
      oldLine += 1;
    }

    while (newLine < hunk.newEnd) {
      text.push(newLines[newLine - 1]!);
      mapping.push({ newLine, kind: 'new' });
      newLine += 1;
    }
  }

  while (newLine <= newLines.length) {
    text.push(newLines[newLine - 1]!);
    mapping.push({
      oldLine: Math.min(oldLine, oldLines.length),
      newLine,
      kind: 'context',
    });
    oldLine += 1;
    newLine += 1;
  }

  return { unified: text.join('\n'), mapping };
}

/**
 * Вычисляет точные блоки и детализацию с единым ограничением времени на весь файл.
 * Нормализация влияет на различия, а возвращаемые диапазоны адресуют исходные строки.
 */
export function computeCodeDiff(
  oldContent: string,
  newContent: string,
  preferences: Pick<DiffPreferences, 'detail' | 'whitespace'>,
): DiffResult {
  const timeout = new DateTimeout(2_000);
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const left = normalizedLines(oldContent, preferences.whitespace);
  const right = normalizedLines(newContent, preferences.whitespace);
  const changes = compareSequences(left.map((line) => line.text), right.map((line) => line.text), timeout);
  const hunks = changes.map((change): DiffHunk => {
    const oldPart = left.slice(change.oldStart, change.oldEnd);
    const newPart = right.slice(change.newStart, change.newEnd);
    const hunk: DiffHunk = {
      oldStart: sourceBoundary(left, change.oldStart, oldLines.length),
      oldEnd: oldPart.at(-1)?.line ? oldPart.at(-1)!.line + 1 :
        sourceBoundary(left, change.oldStart, oldLines.length),
      newStart: sourceBoundary(right, change.newStart, newLines.length),
      newEnd: newPart.at(-1)?.line ? newPart.at(-1)!.line + 1 :
        sourceBoundary(right, change.newStart, newLines.length),
      oldRanges: [],
      newRanges: [],
    };

    if (preferences.detail !== 'line') {
      const oldTokens = tokenize(oldPart, preferences.detail);
      const newTokens = tokenize(newPart, preferences.detail);
      const details = compareSequences(
        oldTokens.tokens.map((token) => token.text),
        newTokens.tokens.map((token) => token.text),
        timeout,
      );

      for (const detail of details) {
        hunk.oldRanges.push(...tokenRange(oldTokens, detail.oldStart, detail.oldEnd));
        hunk.newRanges.push(...tokenRange(newTokens, detail.newStart, detail.newEnd));
      }
    }

    return hunk;
  });

  return { hunks, ...unifiedModel(oldLines, newLines, hunks) };
}

/**
 * Оставляет заданный контекст вокруг блоков, не удаляя строки исходной модели.
 * Monaco скрывает только промежутки между объединёнными видимыми диапазонами.
 */
export function hiddenDiffLines(
  count: number,
  changes: { start: number; end: number }[],
  preferences: Pick<DiffPreferences, 'collapse' | 'context'>,
): SourceRange[] {
  if (!preferences.collapse || preferences.context === 'all' || !changes.length) {
    return [];
  }

  const context = Number(preferences.context);
  const hidden: SourceRange[] = [];
  let visibleEnd = 0;

  for (const change of changes) {
    const start = Math.max(1, change.start - context);

    if (start > visibleEnd + 1) {
      hidden.push({
        startLineNumber: visibleEnd + 1,
        endLineNumber: start - 1,
        startColumn: 1,
        endColumn: 1,
      });
    }

    visibleEnd = Math.max(visibleEnd, change.end - 1 + context);
  }

  if (visibleEnd < count) {
    hidden.push({
      startLineNumber: visibleEnd + 1,
      endLineNumber: count,
      startColumn: 1,
      endColumn: 1,
    });
  }

  return hidden;
}
