export type UnifiedDiffLineKind = 'context' | 'add' | 'del' | 'meta';

export interface UnifiedDiffLine {
  kind: UnifiedDiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface UnifiedDiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: UnifiedDiffLine[];
}

export interface UnifiedDiffFile {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R';
  binary: boolean;
  hunks: UnifiedDiffHunk[];
}

interface PendingHunk extends UnifiedDiffHunk {
  oldExpected: number;
  newExpected: number;
  oldConsumed: number;
  newConsumed: number;
  oldCursor: number;
  newCursor: number;
}

interface PendingFile extends UnifiedDiffFile {
  sourcePath: string;
  targetPath: string;
  renamed: boolean;
}

/**
 * Убирает префикс стороны Git и простые кавычки из заголовка патча.
 * `/dev/null` означает отсутствующую сторону нового или удалённого файла.
 */
function cleanPatchPath(value: string): string {
  let path = value.trim();

  if (path === '/dev/null') {
    return '';
  }

  if (path.startsWith('"') && path.endsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      path = path.slice(1, -1);
    }
  }

  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path;
}

function newFile(oldPath = '', newPath = ''): PendingFile {
  return {
    path: newPath || oldPath,
    sourcePath: oldPath,
    targetPath: newPath,
    status: 'M',
    binary: false,
    hunks: [],
    renamed: false,
  };
}

/**
 * Разбирает unified diff без предположения, что последний буфер полный. Незавершённый
 * хунк отбрасывается, зато уже принятые файлы и хунки остаются пригодны для обзора.
 */
export function parseUnifiedDiff(text: string): UnifiedDiffFile[] {
  if (!text.trim()) {
    return [];
  }

  const files: UnifiedDiffFile[] = [];
  let file: PendingFile | null = null;
  let hunk: PendingHunk | null = null;

  const finishHunk = () => {
    if (file && hunk
      && hunk.oldConsumed === hunk.oldExpected
      && hunk.newConsumed === hunk.newExpected) {
      const {
        oldExpected: _oldExpected,
        newExpected: _newExpected,
        oldConsumed: _oldConsumed,
        newConsumed: _newConsumed,
        oldCursor: _oldCursor,
        newCursor: _newCursor,
        ...complete
      } = hunk;

      file.hunks.push(complete);
    }

    hunk = null;
  };

  /**
   * Финализирует файл даже при обрезанном последнем хунке: заголовок и бинарная
   * метка полезны сами по себе, а незавершённые номера строк в ответ не попадают.
   */
  const finishFile = () => {
    finishHunk();

    if (!file) {
      return;
    }

    const path = file.targetPath || file.sourcePath || file.path;
    const status = file.renamed ? 'R'
      : !file.sourcePath ? 'A'
        : !file.targetPath ? 'D'
          : file.status;

    files.push({
      path,
      ...(file.renamed && file.sourcePath ? { oldPath: file.sourcePath } : {}),
      status,
      binary: file.binary,
      hunks: file.hunks,
    });
    file = null;
  };

  for (const line of text.split('\n')) {
    const boundary = line.match(/^diff --git a\/(.+) b\/(.+)$/u);

    if (boundary) {
      finishFile();
      file = newFile(cleanPatchPath(boundary[1] || ''), cleanPatchPath(boundary[2] || ''));

      continue;
    }

    const header = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);

    if (header && file) {
      finishHunk();

      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);

      hunk = {
        header: line,
        oldStart,
        newStart,
        oldExpected: header[2] === undefined ? 1 : Number(header[2]),
        newExpected: header[4] === undefined ? 1 : Number(header[4]),
        oldConsumed: 0,
        newConsumed: 0,
        oldCursor: oldStart,
        newCursor: newStart,
        lines: [],
      };

      continue;
    }

    if (hunk) {
      if (line.startsWith('\\ No newline at end of file')) {
        hunk.lines.push({
          kind: 'meta',
          text: line,
          oldLine: null,
          newLine: null,
        });

        continue;
      }

      const marker = line[0];

      if (marker === ' ' || marker === '+' || marker === '-') {
        const context = marker === ' ';
        const addition = marker === '+';
        const oldLine = addition ? null : hunk.oldCursor;
        const newLine = marker === '-' ? null : hunk.newCursor;

        hunk.lines.push({
          kind: context ? 'context' : addition ? 'add' : 'del',
          text: line.slice(1),
          oldLine,
          newLine,
        });

        if (!addition) {
          hunk.oldCursor += 1;
          hunk.oldConsumed += 1;
        }
        if (marker !== '-') {
          hunk.newCursor += 1;
          hunk.newConsumed += 1;
        }

        continue;
      }
    }

    if (!file) {
      continue;
    }
    if (line.startsWith('rename from ')) {
      file.sourcePath = cleanPatchPath(line.slice('rename from '.length));
      file.renamed = true;
    } else if (line.startsWith('rename to ')) {
      file.targetPath = cleanPatchPath(line.slice('rename to '.length));
      file.path = file.targetPath;
      file.renamed = true;
    } else if (line.startsWith('new file mode ')) {
      file.sourcePath = '';
      file.status = 'A';
    } else if (line.startsWith('deleted file mode ')) {
      file.targetPath = '';
      file.status = 'D';
    } else if (line.startsWith('--- ')) {
      file.sourcePath = cleanPatchPath(line.slice(4));
    } else if (line.startsWith('+++ ')) {
      file.targetPath = cleanPatchPath(line.slice(4));
      file.path = file.targetPath || file.sourcePath;
    } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
      file.binary = true;
    }
  }

  finishFile();

  return files;
}
