import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Имя каталога проекта в хранилище сессий DSH (`projectKey` session-persistence-jsonl):
 * разделители — `-`, небезопасные символы — `~XXXX`, рамка `--…--`, до 251 символа.
 */
export function sessionProjectKey(cwd: string): string {
  let readable = '';
  let separatorRun = false;

  for (const char of cwd) {
    if (char === '/' || char === '\\' || char === ':') {
      readable += separatorRun ? '' : '-';
      separatorRun = true;
    } else if (char !== '~' && /^[A-Za-z0-9._-]$/u.test(char)) {
      readable += char;
      separatorRun = false;
    } else {
      for (let index = 0; index < char.length; index += 1) {
        readable += `~${char.charCodeAt(index).toString(16).toUpperCase().padStart(4, '0')}`;
      }

      separatorRun = false;
    }
  }

  const slug = readable.replace(/^-+/u, '') || 'root';

  return `--${slug.slice(0, 251)}--`;
}

/**
 * Журнал принадлежит конкретному chat home, cwd и безопасному server-owned sessionId.
 * Недопустимый id не превращается в путь к чужому каталогу.
 */
export function sessionJournalDirectory(home: string, cwd: string, sessionId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw new TypeError('Некорректный id журнала сессии');
  }

  return path.join(home, 'sessions', sessionProjectKey(cwd), sessionId);
}

export type SessionJournalInspection = { state: 'missing' } | {
  state: 'readable' | 'incompatible';
  version: number;
  file: string;
};

/**
 * Номер самой новой canonical generation определяет возможность resume текущим бинарником.
 * Проверка не читает и не переписывает содержимое журнала.
 */
export async function inspectSessionJournal(
  home: string,
  cwd: string,
  sessionId: string,
  readVersions?: readonly number[],
): Promise<SessionJournalInspection> {
  const directory = sessionJournalDirectory(home, cwd, sessionId);
  let names: string[];

  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' };
    }

    throw error;
  }

  const generations = names.flatMap((name) => {
    const match = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/u.exec(name);

    if (!match) {
      return [];
    }

    const version = match[1] === undefined ? 0 : Number(match[1]);

    return Number.isSafeInteger(version) ? [{ version, file: path.join(directory, name) }] : [];
  });
  const latest = generations.sort((left, right) => right.version - left.version)[0];

  if (!latest) {
    return { state: 'missing' };
  }

  return {
    ...latest,
    state: !readVersions || readVersions.includes(latest.version) ? 'readable' : 'incompatible',
  };
}
