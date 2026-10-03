import { promises as fs } from 'node:fs';
import path from 'node:path';

import { glmAccessError } from './env.ts';

// id сессии DSH без экранирования: только безопасные символы имени каталога.
const SESSION_ID = /^[A-Za-z0-9._-]+$/u;

/**
 * Имя каталога проекта в хранилище сессий DSH (`projectKey` session-persistence-jsonl):
 * разделители — `-`, небезопасные символы — `~XXXX`, рамка `--…--`, до 251 символа.
 */
export function glmProjectKey(cwd: string): string {
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
 * Каталог журнала сессии в home чата: `sessions/<projectKey(cwd)>/<id>`.
 * Небезопасный id не превращается в путь — это отказ.
 */
export function glmSessionJournalDir(home: string, cwd: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw glmAccessError('glm_session_missing', 'Сессия GLM не найдена; сбрось память чата.');
  }

  return path.join(home, 'sessions', glmProjectKey(cwd), sessionId);
}

/**
 * Resume только существующей сессии этого чата и этой папки: DSH на неизвестный id молча
 * создал бы новую сессию. Нет журнала — `glm_session_missing` с советом сбросить память.
 */
export async function assertGlmSessionJournal(home: string, cwd: string, sessionId: string): Promise<void> {
  const directory = glmSessionJournalDir(home, cwd, sessionId);
  const entries = await fs.readdir(directory).catch(() => [] as string[]);

  if (!entries.some((name) => /^session\.v\d+\.jsonl(?:\.zstd)?$/u.test(name))) {
    throw glmAccessError('glm_session_missing', 'Журнал сессии GLM не найден; сбрось память чата.');
  }
}

/**
 * Повреждённый журнал DSH сообщает при resume как внутреннюю ошибку создания сессии.
 * Такой отказ — тоже отсутствие памяти, а не сбой запуска.
 */
export function isGlmSessionCorrupt(message: string): boolean {
  return /failed to (?:create|observe) session|corrupt .*session log|session log/iu.test(message);
}
