import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';
import { readTextOrNull, withWorkDirectory } from '../../../shared/node/files.ts';
import type { CodePartialOptions } from '../../../shared/plugins/code/codeContracts.ts';
import { CodeGitError, worktreeChanges } from './git.ts';
import { rawComparison, reviewGit } from './codeGitReview.ts';

interface PartialHunk {
  id: string;
  oldStart: number;
  newStart: number;
  atoms: Atom[];
}

interface Atom {
  id: string;
  oldLine: number | null;
  newLine: number | null;
  oldText: string;
  newText: string;
}

/**
 * Просит Git построить исходный patch по точным байтам во временном каталоге.
 * Код 1 означает найденные различия; остальные отказы не превращаются в пустой diff.
 */
async function bytePatch(root: string, old: Buffer, next: Buffer): Promise<string> {
  return withWorkDirectory(os.tmpdir(), async (directory) => {
    const before = path.join(directory, 'old');
    const after = path.join(directory, 'new');

    await fs.writeFile(before, old);
    await fs.writeFile(after, next);

    try {
      return (await reviewGit(root, [
        'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--unified=3', '--', before, after,
      ])).toString();
    } catch (error) {
      const failure = error as { code?: number; stdout?: Buffer };

      if (failure.code === 1 && failure.stdout) {
        return failure.stdout.toString();
      }

      throw error;
    }
  });
}

/**
 * Разбирает исходные координаты Git. Соседние удаление и вставка одной строки
 * образуют общий атом, поэтому замена никогда не переносится половиной пары.
 */
function patchAtoms(patch: string) {
  const hunks: PartialHunk[] = [];
  const lines = patch.split('\n');
  let oldLine = 0;
  let newLine = 0;
  let removed: { line: number; text: string }[] = [];
  let added: { line: number; text: string }[] = [];

  /**
   * Замыкает одну непрерывную группу удалений и вставок.
   * Пустая сторона пары обозначается отсутствующей исходной координатой.
   */
  const flush = () => {
    const hunk = hunks.at(-1);

    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      const old = removed[index];
      const next = added[index];

      hunk?.atoms.push({
        id: `${hunks.length}:${old?.line || 0}:${next?.line || 0}`,
        oldLine: old?.line ?? null,
        newLine: next?.line ?? null,
        oldText: old?.text || '',
        newText: next?.text || '',
      });
    }

    removed = [];
    added = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);

    if (header) {
      flush();
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunks.push({
        id: String(hunks.length + 1),
        oldStart: oldLine,
        newStart: newLine,
        atoms: [],
      });
    } else if (hunks.length && (line.startsWith('-') || line.startsWith('+'))) {
      const text = line.slice(1) + (lines[index + 1]?.startsWith('\\') ? '' : '\n');

      if (line.startsWith('-')) {
        removed.push({ line: oldLine++, text });
      } else {
        added.push({ line: newLine++, text });
      }
    } else if (hunks.length && line.startsWith(' ')) {
      flush();
      oldLine += 1;
      newLine += 1;
    }
  }

  flush();

  return hunks;
}

/**
 * Получает только свежий текстовый diff рабочей группы или индекса.
 * Токен связывает байты обеих сторон, HEAD, пути и режимы с каноническими атомами.
 */
export async function readPartialDiff(root: string, group: string, file: string) {
  if (group !== 'work' && group !== 'staged') {
    throw new CodeGitError('bad_group', 'Частичный индекс доступен только текущим изменениям.', 400);
  }

  const changes = await worktreeChanges(root, { withContent: false });
  const entries = group === 'work' ? changes.files : changes.staged;
  const entry = entries.find((item) => item.path === file);

  if (!entry || entry.status === 'U' || entry.binary) {
    throw new CodeGitError('partial_unavailable', 'Частичный индекс для этого файла недоступен.', 409);
  }

  const raw = await rawComparison(root, { group, path: file }, entry);

  if ([raw.old, raw.next].some((side) => side.bytes.includes(0) || side.bytes.length > 1_500_000)) {
    throw new CodeGitError('partial_unavailable', 'Файл бинарный или превышает лимит просмотра.', 409);
  }

  const head = (await reviewGit(root, ['rev-parse', '--verify', 'HEAD']).catch(() => Buffer.alloc(0)))
    .toString().trim();
  const patch = await bytePatch(root, raw.old.bytes, raw.next.bytes);
  const token = sha256(JSON.stringify([root, group, file, entry.oldPath, head, raw.fingerprint]));

  return {
    path: file,
    group,
    token,
    fingerprint: raw.fingerprint,
    patch,
    hunks: patchAtoms(patch),
    raw,
  };
}

/**
 * Применяет выбранные атомы к исходным строкам без нормализации текста.
 * Для снятия из индекса направление меняется, а координаты остаются показанными человеку.
 */
function selectedBytes(diff: Awaited<ReturnType<typeof readPartialDiff>>, ids: Set<string>) {
  const staged = diff.group === 'staged';
  const source = (staged ? diff.raw.next : diff.raw.old).bytes.toString();
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) || [];
  const edits = diff.hunks.flatMap((hunk) => hunk.atoms).filter((atom) => ids.has(atom.id));
  let offset = 0;

  for (const atom of edits) {
    const line = staged ? atom.newLine : atom.oldLine;
    const replacement = staged ? atom.oldText : atom.newText;
    let position: number;

    if (line !== null) {
      position = line - 1 + offset;
    } else {
      const other = staged ? atom.oldLine : atom.newLine;

      position = (other || 1) - 1;
    }

    lines.splice(position, line === null ? 0 : 1, ...(replacement ? [replacement] : []));
    offset += (replacement ? 1 : 0) - (line === null ? 0 : 1);
  }

  return Buffer.from(lines.join(''));
}

/**
 * Держит настоящий index.lock до атомарной публикации частного индекса.
 * До rename любой отказ оставляет индекс и рабочие файлы побайтно прежними.
 */
export async function applyPartialIndex(root: string, options: CodePartialOptions) {
  const index = path.resolve(root, (await reviewGit(root, ['rev-parse', '--git-path', 'index']))
    .toString().trim());
  const lock = `${index}.lock`;
  let handle;

  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new CodeGitError('git_busy', 'Индекс заблокирован другим Git-процессом.', 409);
    }

    throw error;
  }

  try {
    const diff = await readPartialDiff(root, options.group, options.path);
    const atoms = diff.hunks.flatMap((hunk) => hunk.atoms);
    const ids = new Set(options.atomIds);

    if (diff.token !== options.token || !ids.size || [...ids].some((id) => !atoms.some((a) => a.id === id))) {
      throw new CodeGitError('stale_changes', 'Выбранные строки устарели. Обнови сравнение.', 409);
    }

    const desired = selectedBytes(diff, ids);
    const current = options.group === 'staged' ? diff.raw.next : diff.raw.old;
    const targetPresent = desired.length > 0
      || (ids.size === atoms.length && (options.group === 'staged'
        ? diff.raw.old.presence : diff.raw.next.presence));

    await withWorkDirectory(path.dirname(index), async (directory) => {
      const privateIndex = path.join(directory, 'index');
      const original = await readTextOrNull(index);

      if (original !== null) {
        await fs.copyFile(index, privateIndex);
      } else {
        await reviewGit(root, ['read-tree', '--empty'], privateIndex);
      }

      const rawPatch = await bytePatch(root, current.bytes, desired);
      const body = rawPatch.slice(rawPatch.indexOf('@@'));
      const name = JSON.stringify(`a/${options.path}`);
      const nextName = JSON.stringify(`b/${options.path}`);
      const headers = [
        `diff --git ${name} ${nextName}`,
        ...(!current.presence ? ['new file mode 100644'] : []),
        ...(!targetPresent ? [`deleted file mode ${current.mode || '100644'}`] : []),
        `--- ${current.presence ? name : '/dev/null'}`,
        `+++ ${targetPresent ? nextName : '/dev/null'}`,
      ];
      const patchFile = path.join(directory, 'selection.patch');

      await fs.writeFile(patchFile, headers.join('\n') + '\n' + body);
      await reviewGit(root, ['apply', '--cached', '--check', patchFile], privateIndex);
      await reviewGit(root, ['apply', '--cached', patchFile], privateIndex);

      if ((await readPartialDiff(root, options.group, options.path)).token !== options.token) {
        throw new CodeGitError('stale_changes', 'Содержимое изменилось во время применения.', 409);
      }

      await handle!.writeFile(await fs.readFile(privateIndex));
      await handle!.sync();
      await fs.rename(lock, index);
    });

    return { ok: true as const, changed: 1 };
  } finally {
    await handle.close();
    await fs.unlink(lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}
