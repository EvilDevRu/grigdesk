import { changeLifecycle } from './changeLifecycle';
import type { ProjectLifecycleResult } from './changeLifecycle';

/**
 * Убрать проект в архив: активные правила, ссылающиеся на него, архив не пропустят,
 * а причина вернётся текстом для показа рядом с кнопкой.
 */
export function archiveProject(
  id: string,
  { expectedRevision }: { expectedRevision: number },
): Promise<ProjectLifecycleResult> {
  return changeLifecycle(id, expectedRevision, 'archive');
}
