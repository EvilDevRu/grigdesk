import { changeLifecycle } from './changeLifecycle';
import type { ProjectLifecycleResult } from './changeLifecycle';

/**
 * Вернуть проект из архива: ревизия та же, проект снова доступен разделам, а о
 * пропавших путях скажут предупреждения паспорта.
 */
export function restoreProject(
  id: string,
  { expectedRevision }: { expectedRevision: number },
): Promise<ProjectLifecycleResult> {
  return changeLifecycle(id, expectedRevision, 'restore');
}
