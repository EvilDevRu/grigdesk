import { sessionJournalDirectory, inspectSessionJournal } from '../deepseek/journal.ts';

import { glmAccessError } from './env.ts';

// id сессии DSH без экранирования: только безопасные символы имени каталога.
const SESSION_ID = /^[A-Za-z0-9._-]+$/u;

export { sessionProjectKey as glmProjectKey } from '../deepseek/journal.ts';

/**
 * Каталог журнала сессии в home чата: `sessions/<projectKey(cwd)>/<id>`.
 * Небезопасный id не превращается в путь — это отказ.
 */
export function glmSessionJournalDir(home: string, cwd: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId) || sessionId === '.' || sessionId === '..') {
    throw glmAccessError('glm_session_missing', 'Сессия GLM не найдена; сбрось память чата.');
  }

  return sessionJournalDirectory(home, cwd, sessionId);
}

/**
 * Resume только существующей сессии этого чата и этой папки: DSH на неизвестный id молча
 * создал бы новую сессию. Нет журнала — `glm_session_missing` с советом сбросить память.
 */
export async function assertGlmSessionJournal(home: string, cwd: string, sessionId: string): Promise<void> {
  glmSessionJournalDir(home, cwd, sessionId);

  const journal = await inspectSessionJournal(home, cwd, sessionId)
    .catch(() => ({ state: 'missing' as const }));

  if (journal.state === 'missing' || journal.version === 0) {
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
