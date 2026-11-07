import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';
import type { CodeActionOptions, CodeGitEntry } from '../../../shared/plugins/code/codeContracts.ts';
import {
  cleanUntracked,
  CodeGitError,
  discardWorktreeChanges,
  stageWorktreeChanges,
  unstageWorktreeChanges,
  worktreeChanges,
} from './git.ts';
import { diskSide, reviewGit } from './codeGitReview.ts';

export type HiddenPolicy = (absolute: string) => boolean;

/**
 * Обходит только обычные каталоги, не раскрывая служебные имена и ссылки.
 * Полный состав включает неизменённые и игнорируемые файлы, которых нет в diff.
 */
export async function inspectNewDirectory(root: string, directory: string, hidden: HiddenPolicy) {
  const untracked = new Set((await reviewGit(root, ['ls-files', '--others', '--exclude-standard', '-z']))
    .toString().split('\0').filter(Boolean));
  const tracked = (await reviewGit(root, ['ls-files', '--cached', '-z']))
    .toString().split('\0').filter(Boolean);

  if (tracked.some((file) => file === directory || file.startsWith(`${directory}/`))) {
    throw new CodeGitError('protected_directory', 'В папке есть отслеживаемые файлы.', 409);
  }

  const inventory: string[] = [];

  /**
   * Входит только в разрешённые обычные каталоги.
   * Любой неизвестный leaf запрещает удаление всей папки до первого эффекта.
   */
  const visit = async (relative: string): Promise<void> => {
    const absolute = path.join(root, relative);

    if (hidden(absolute)) {
      throw new CodeGitError('protected_directory', 'Папка содержит служебные данные.', 409);
    }

    const stat = await fs.lstat(absolute);

    if (stat.isSymbolicLink()) {
      throw new CodeGitError('protected_directory', 'Папка содержит символическую ссылку.', 409);
    }

    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(absolute)).sort()) {
        await visit(`${relative}/${name}`);
      }
    } else if (stat.isFile() && untracked.has(relative)) {
      inventory.push(relative);
    } else {
      throw new CodeGitError(
        'protected_directory',
        'В папке есть игнорируемое или служебное содержимое.',
        409,
      );
    }
  };

  await visit(directory);

  return inventory;
}

/**
 * Снимок затрагивает только выбранные пути, без глобального хеша индекса.
 * Индексирование первой порции поэтому не инвалидирует независимую вторую.
 */
async function selectionToken(root: string, options: CodeActionOptions, files: CodeGitEntry[]) {
  const paths = files.flatMap((file) => file.oldPath ? [file.oldPath, file.path] : [file.path]).sort();
  const stages = paths.length
    ? (await reviewGit(root, ['ls-files', '--stage', '-z', '--', ...paths])).toString() : '';
  const sides = await Promise.all(paths.map(async (file) => {
    const side = await diskSide(root, file);

    return [file, side.presence, side.mode, sha256(side.bytes)];
  }));

  return sha256(JSON.stringify([
    root, options.action, options.group, options.directory, options.paths, stages, sides,
  ]));
}

/**
 * Отбирает точные допустимые leaf-пути в свежей Git-группе.
 * Исключения возвращаются с причинами; destructive действия не подменяют друг друга.
 */
export async function previewGitAction(root: string, options: CodeActionOptions, hidden: HiddenPolicy) {
  const actions = ['stage', 'unstage', 'discard', 'clean-new', 'delete-new-dir'];

  if (!actions.includes(options.action)
    || options.group !== (options.action === 'unstage' ? 'staged' : 'work')
    || (!!options.directory === !!options.paths)
    || (options.paths && (!options.paths.length || options.paths.length > 500))) {
    throw new CodeGitError('bad_action', 'Некорректная область Git-действия.', 400);
  }

  const changes = await worktreeChanges(root, { withContent: false });
  const files = options.group === 'work' ? changes.files : changes.staged;
  const scope = options.action === 'delete-new-dir'
    ? await inspectNewDirectory(root, options.directory || '', hidden)
    : options.paths || files.filter((file) => file.path.startsWith(`${options.directory}/`))
      .map((file) => file.path);
  const eligible: CodeGitEntry[] = [];
  const excluded: { path: string; reason: string }[] = [];
  const tracked = new Set((await reviewGit(root, ['ls-files', '--cached', '-z']))
    .toString().split('\0').filter(Boolean));

  for (const file of new Set(scope)) {
    const entry = files.find((item) => item.path === file);
    let reason = '';

    if (hidden(path.join(root, file))) {
      reason = 'Служебный путь недоступен.';
    } else if (!entry) {
      reason = 'Изменение отсутствует в выбранной группе.';
    } else if (options.action === 'discard' && (entry.status === 'U' || !tracked.has(file))) {
      reason = 'Откат не затрагивает конфликты и новые файлы.';
    } else if (['clean-new', 'delete-new-dir'].includes(options.action) && tracked.has(file)) {
      reason = 'Удалять можно только неотслеживаемые файлы.';
    }

    if (reason) {
      excluded.push({ path: file, reason });
    } else if (entry) {
      eligible.push(entry);
    }
  }

  return {
    token: await selectionToken(root, options, eligible),
    eligible,
    excluded,
  };
}

/**
 * Удаляет только опустевшие каталоги внутри явно выбранной папки.
 * Непустой каталог сохраняется, никакого рекурсивного rm здесь нет.
 */
async function pruneDirectories(root: string, directory: string, files: string[]) {
  const parents = new Set<string>([directory]);

  for (const file of files) {
    let parent = path.posix.dirname(file);

    while (parent === directory || parent.startsWith(`${directory}/`)) {
      parents.add(parent);
      parent = path.posix.dirname(parent);
    }
  }

  for (const parent of [...parents].sort((a, b) => b.length - a.length)) {
    try {
      await fs.rmdir(path.join(root, parent));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')) {
        throw error;
      }
    }
  }
}

/**
 * Пересверяет preview до первой записи и выполняет порции последовательно.
 * При сбое сохраняет честный ledger, уже выполненные порции не повторяются.
 */
export async function executeGitAction(root: string, options: CodeActionOptions, hidden: HiddenPolicy) {
  const preview = await previewGitAction(root, options, hidden);

  if (preview.token !== options.token) {
    throw new CodeGitError(
      'stale_changes',
      'Состав или содержимое изменились. Подтверди свежий список.',
      409,
    );
  }

  const completed: { path: string }[] = [];
  const failed: { path: string; reason: string }[] = [];
  let unattempted: { path: string }[] = [];
  const paths = preview.eligible.map((file) => file.path);

  for (let offset = 0; offset < paths.length; offset += 500) {
    const batch = paths.slice(offset, offset + 500);

    try {
      if (options.action === 'stage') {
        await stageWorktreeChanges(root, { paths: batch });
      } else if (options.action === 'unstage') {
        await unstageWorktreeChanges(root, { paths: batch });
      } else if (options.action === 'discard') {
        await discardWorktreeChanges(root, { paths: batch });
      } else {
        await cleanUntracked(root, { paths: batch });
      }

      completed.push(...batch.map((file) => ({ path: file })));
    } catch {
      failed.push(...batch.map((file) => ({ path: file, reason: 'Git отклонил операцию.' })));
      unattempted = paths.slice(offset + 500).map((file) => ({ path: file }));
      break;
    }
  }

  if (options.action === 'delete-new-dir' && !failed.length) {
    await pruneDirectories(root, options.directory!, paths);
  }

  return {
    ok: !failed.length,
    completed,
    failed,
    unattempted,
  };
}
