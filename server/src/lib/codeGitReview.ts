import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';
import { CodeGitError, worktreeChanges } from './git.ts';
import type { CodeComparison, CodeGitEntry } from '../../../shared/plugins/code/codeContracts.ts';

const exec = promisify(execFile);

export interface RawSide {
  presence: boolean;
  mode: string;
  bytes: Buffer;
}

/**
 * Запускает только Git с буквальными путями и без необязательных записей индекса.
 * Буфер сохраняет исходные байты бинарных файлов и окончания строк.
 */
export async function reviewGit(root: string, args: string[], index?: string): Promise<Buffer> {
  const result = await exec('git', ['-C', root, '--literal-pathspecs', ...args], {
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      ...(index ? { GIT_INDEX_FILE: index } : {}),
    },
  });

  return result.stdout;
}

/**
 * Отсутствует только ENOENT. Другие ошибки чтения остаются ошибками,
 * чтобы недоступная сторона не выглядела пустым файлом.
 */
export async function diskSide(root: string, file: string): Promise<RawSide> {
  try {
    const absolute = path.join(root, file);
    const stat = await fs.lstat(absolute);

    if (!stat.isFile()) {
      throw new CodeGitError('bad_path', 'Просмотр ссылок и специальных файлов недоступен.', 400);
    }

    return {
      presence: true,
      mode: stat.mode & 0o111 ? '100755' : '100644',
      bytes: await fs.readFile(absolute),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }

    return {
      presence: false,
      mode: '',
      bytes: Buffer.alloc(0),
    };
  }
}

/**
 * Читает проверенную запись дерева или стадию индекса через её object id.
 * Отсутствие записи определяется метаданными, а сбой cat-file не подавляется.
 */
export async function objectSide(root: string, file: string, revision: string): Promise<RawSide> {
  let metadata = '';

  if (revision.startsWith(':')) {
    const stage = revision.slice(1) || '0';
    const records = (await reviewGit(root, ['ls-files', '--stage', '-z', '--', file]))
      .toString().split('\0');

    metadata = records.find((line) => line.split('\t')[0]?.endsWith(` ${stage}`)) || '';
  } else {
    const exists = await reviewGit(root, ['rev-parse', '--verify', revision]).catch(() => null);

    if (exists) {
      metadata = (await reviewGit(root, ['ls-tree', '-z', revision, '--', file])).toString();
    }
  }

  if (!metadata) {
    return {
      presence: false,
      mode: '',
      bytes: Buffer.alloc(0),
    };
  }

  const fields = metadata.split('\t')[0]!.split(' ');
  const hash = revision.startsWith(':') ? fields[1]! : fields[2]!;

  return {
    presence: true,
    mode: fields[0]!,
    bytes: await reviewGit(root, ['cat-file', 'blob', hash]),
  };
}

/**
 * Связывает две сырые стороны с группой и старым именем переименования.
 * Fingerprint учитывает наличие и режим, даже если текст или счётчики совпадают.
 */
export async function rawComparison(root: string, comparison: CodeComparison, entry: CodeGitEntry) {
  const oldPath = entry.oldPath || entry.path;
  const original = comparison.group === 'work' ? ':' : comparison.base || 'HEAD';
  const modified = comparison.group === 'staged' ? ':' : comparison.to || 'HEAD';
  const [old, next] = await Promise.all([
    entry.status === 'A'
      ? {
        presence: false,
        mode: '',
        bytes: Buffer.alloc(0),
      }
      : objectSide(root, oldPath, entry.status === 'U' ? ':2' : original),
    comparison.group === 'work' || comparison.work
      ? diskSide(root, entry.path)
      : objectSide(root, entry.path, modified),
  ]);
  const fingerprint = sha256(JSON.stringify([
    entry.status,
    oldPath,
    [old.presence, old.mode, sha256(old.bytes)],
    [next.presence, next.mode, sha256(next.bytes)],
  ]));

  return {
    old,
    next,
    fingerprint,
  };
}

/**
 * Возвращает четыре независимые версии только актуального unmerged-файла.
 * Просмотр не меняет стадии индекса и не помечает конфликт разрешённым.
 */
export async function readConflict(root: string, file: string) {
  const changes = await worktreeChanges(root, { withContent: false });

  if (!changes.files.some((entry) => entry.path === file && entry.status === 'U')) {
    throw new CodeGitError('no_conflict', 'Актуальный конфликт не найден.', 409);
  }

  const sides = await Promise.all([
    objectSide(root, file, ':1'),
    objectSide(root, file, ':2'),
    objectSide(root, file, ':3'),
    diskSide(root, file),
  ]);
  const [base, ours, theirs, work] = sides.map((side) => {
    const binary = side.bytes.includes(0);
    const tooBig = side.bytes.length > 1_500_000;

    return {
      presence: side.presence,
      binary,
      tooBig,
      content: binary || tooBig ? '' : side.bytes.toString(),
      fingerprint: sha256(JSON.stringify([side.presence, side.mode, sha256(side.bytes)])),
    };
  });

  return {
    path: file,
    base: base!,
    ours: ours!,
    theirs: theirs!,
    work: work!,
  };
}
