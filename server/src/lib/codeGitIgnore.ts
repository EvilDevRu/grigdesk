import fs from 'node:fs/promises';
import path from 'node:path';

import { sha256 } from '../../../shared/node/hash.ts';
import { readTextOrNull } from '../../../shared/node/files.ts';
import type { CodeIgnoreOptions } from '../../../shared/plugins/code/codeContracts.ts';
import { CodeGitError } from './git.ts';
import { diskSide, reviewGit } from './codeGitReview.ts';
import type { HiddenPolicy } from './codeGitSelection.ts';

/**
 * Экранирует одно anchored правило без шаблонов и управляющих символов.
 * Слеш остаётся границей каталога, пробелы и метасимволы всегда буквальные.
 */
function literalRule(file: string, directory: boolean) {
  if (/[\x00-\x1f\x7f]/u.test(file)) {
    throw new CodeGitError('bad_path', 'Управляющие символы в ignore-пути недоступны.', 400);
  }

  return '/' + file.replace(/[\\*?\[\]!# ]/gu, '\\$&') + (directory ? '/' : '');
}

/**
 * Выбирает только общий .gitignore или Git-resolved exclude текущего репозитория.
 * Ссылки правил запрещены, tracked-файлы не снимаются с индекса неявно.
 */
export async function previewIgnore(root: string, options: CodeIgnoreOptions, hidden: HiddenPolicy) {
  if (!['shared', 'local'].includes(options.target) || (!!options.paths === !!options.directory)
    || (options.paths && (!options.paths.length || options.paths.length > 500))) {
    throw new CodeGitError('bad_ignore', 'Выбери назначение и точные новые пути.', 400);
  }

  const paths = [...new Set(options.directory ? [options.directory] : options.paths!)];
  const tracked = (await reviewGit(root, ['ls-files', '--cached', '-z']))
    .toString().split('\0').filter(Boolean);
  const states: unknown[] = [];

  for (const file of paths) {
    if (tracked.some((item) => item === file || item.startsWith(`${file}/`))) {
      throw new CodeGitError('tracked_path', 'Отслеживаемый путь нельзя скрыть этим действием.', 409);
    }

    const absolute = path.join(root, file);
    const stat = await fs.lstat(absolute);

    if (hidden(absolute) || stat.isSymbolicLink()) {
      throw new CodeGitError('bad_path', 'Путь недоступен для игнорирования.', 400);
    }

    if (options.directory) {
      if (!stat.isDirectory()) {
        throw new CodeGitError('bad_path', 'Ожидалась папка.', 400);
      }

      states.push([file, (await fs.readdir(absolute)).sort()]);
    } else {
      const side = await diskSide(root, file);

      states.push([file, sha256(side.bytes)]);
    }
  }

  const filename = options.target === 'shared' ? path.join(root, '.gitignore')
    : path.resolve(root, (await reviewGit(root, ['rev-parse', '--git-path', 'info/exclude']))
      .toString().trim());
  const common = path.resolve(root, (await reviewGit(root, ['rev-parse', '--git-common-dir']))
    .toString().trim());

  if (options.target === 'local' && filename !== path.join(common, 'info/exclude')) {
    throw new CodeGitError('bad_path', 'Git вернул неподдерживаемый exclude.', 400);
  }

  const stat = await fs.lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') {
      throw error;
    }

    return null;
  });

  if (stat && !stat.isFile()) {
    throw new CodeGitError('bad_path', 'Файл правил должен быть обычным файлом.', 409);
  }

  const content = await readTextOrNull(filename) || '';
  const rules = paths.map((file) => literalRule(file, !!options.directory));
  const token = sha256(JSON.stringify([root, options.target, paths, states, content]));

  return {
    token,
    target: options.target,
    rules,
    paths,
    filename,
    content,
  };
}

/**
 * Записывает правила под собственным lock с повторным чтением перед публикацией.
 * Чужие байты и окончания строк сохраняются, одинаковые правила не дублируются.
 */
export async function appendIgnoreRules(root: string, options: CodeIgnoreOptions, hidden: HiddenPolicy) {
  const preview = await previewIgnore(root, options, hidden);

  if (preview.token !== options.token) {
    throw new CodeGitError('stale_changes', 'Правила или выбранные файлы изменились.', 409);
  }

  const lock = `${preview.filename}.lock`;
  let handle;

  await fs.mkdir(path.dirname(preview.filename), { recursive: true });

  try {
    handle = await fs.open(lock, 'wx', 0o600);
  } catch {
    throw new CodeGitError('git_busy', 'Файл правил занят другим процессом.', 409);
  }

  try {
    const latest = await previewIgnore(root, options, hidden);

    if (latest.token !== preview.token) {
      throw new CodeGitError('stale_changes', 'Файл правил изменился перед записью.', 409);
    }

    const existing = new Set(preview.content.split(/\r?\n/u));
    const additions = preview.rules.filter((rule) => !existing.has(rule));

    if (additions.length) {
      const eol = preview.content.includes('\r\n') ? '\r\n' : '\n';
      const prefix = preview.content && !preview.content.endsWith('\n') ? eol : '';

      await handle.writeFile(preview.content + prefix + additions.join(eol) + eol);
      await handle.sync();

      if ((await readTextOrNull(preview.filename) || '') !== preview.content) {
        throw new CodeGitError('stale_changes', 'Файл правил изменился во время записи.', 409);
      }

      await fs.rename(lock, preview.filename);
    }

    return { ok: true as const, changed: additions.length };
  } finally {
    await handle.close();
    await fs.unlink(lock).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    });
  }
}
