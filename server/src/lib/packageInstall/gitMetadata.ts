import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { normalizeGitUrl } from './gitUrl.ts';

/**
 * Каталог и каждый предок проверяются без следования по символическим ссылкам.
 * Повреждённая metadata не получает права запустить Git с чужой конфигурацией.
 */
async function realDirectory(directory: string): Promise<boolean> {
  const absolute = path.resolve(directory);
  let current = path.parse(absolute).root;

  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);

    const info = await lstat(current);

    if (!info.isDirectory() || info.isSymbolicLink()) {
      return false;
    }
  }

  return true;
}

/**
 * Собственный clone содержит только известные core/remote/branch поля.
 * Includes, filters и исполняемые настройки отвергаются до первого вызова Git.
 */
function knownCloneConfig(text: string): boolean {
  let section = '';

  for (const raw of text.split('\n')) {
    const line = raw.trim();

    if (!line || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }

    if (line.startsWith('[')) {
      if (/^\[(core|extensions)\]$/iu.test(line)) {
        section = line.slice(1, -1).toLowerCase();
      } else if (line === '[remote "origin"]') {
        section = 'remote';
      } else if (/^\[branch "[^"\\]+"\]$/u.test(line)) {
        section = 'branch';
      } else {
        return false;
      }

      continue;
    }

    const match = /^([A-Za-z]+)\s*=\s*(.*)$/u.exec(line);

    if (!match) {
      return false;
    }

    const key = (match[1] ?? '').toLowerCase();
    const value = match[2] ?? '';

    if (section === 'core') {
      const valid = key === 'repositoryformatversion' && /^[01]$/u.test(value)
        || key === 'filemode' && /^(true|false)$/u.test(value)
        || key === 'bare' && value === 'false'
        || key === 'logallrefupdates' && value === 'true';

      if (!valid) {
        return false;
      }
    } else if (section === 'extensions') {
      if (key !== 'objectformat' || value !== 'sha256') {
        return false;
      }
    } else if (section === 'remote') {
      if (key === 'url') {
        try {
          normalizeGitUrl(value.startsWith('"') ? JSON.parse(value) : value);
        } catch {
          return false;
        }
      } else if (key !== 'fetch' || value !== '+refs/heads/*:refs/remotes/origin/*') {
        return false;
      }
    } else if (section === 'branch') {
      if (key === 'remote' ? value !== 'origin' : key !== 'merge' || !value.startsWith('refs/heads/')) {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

/**
 * Config digest привязан к реальной .git и ограниченному обычному файлу.
 * Gitlinks/worktree/alternates и сторонние config entries не получают subprocess.
 */
export async function safeGitConfigDigest(directory: string): Promise<string | null> {
  try {
    const gitDir = path.join(directory, '.git');

    if (!await realDirectory(gitDir)) {
      return null;
    }

    for (const relative of ['config.worktree', 'commondir', 'objects/info/alternates',
      'objects/info/http-alternates', 'info/grafts', 'info/attributes']) {
      if (await lstat(path.join(gitDir, relative)).catch(() => null)) {
        return null;
      }
    }

    const config = path.join(gitDir, 'config');
    const info = await lstat(config);

    if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) {
      return null;
    }

    const bytes = await readFile(config);

    if (!knownCloneConfig(bytes.toString('utf8'))) {
      return null;
    }

    return createHash('sha256').update(bytes).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Ignored файлы также являются ручными изменениями вне известных generated npmDirs.
 * Обход не следует по ссылкам; только доказанная корневая .git пропускается целиком.
 */
export async function installedPayloadFiles(directory: string, npmDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  const generated = new Set(npmDirs.map((dir) => path.posix.join(dir, 'node_modules')));

  while (pending.length > 0) {
    const relative = pending.pop() ?? '';

    for (const entry of await readdir(path.join(directory, relative))) {
      const file = path.posix.join(relative, entry);

      if (file === '.git' || generated.has(file)) {
        continue;
      }

      const info = await lstat(path.join(directory, file));

      if (info.isDirectory() && !info.isSymbolicLink()) {
        pending.push(file);
      } else {
        files.push(file);
      }
    }
  }

  return files;
}
