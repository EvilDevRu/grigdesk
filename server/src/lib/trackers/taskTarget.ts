import { readGrigdeskTask } from '../grigdeskTasks/store.ts';
import type { GrigdeskTasksConfig } from '../grigdeskTasks/numbers.ts';
import { TrackerError } from './contract.ts';
import type { TrackerFacade, TrackerContext } from './facade.ts';
import { isTaskSourceId } from '../../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../../shared/tasks/taskReference.ts';

export interface TaskTargetOptions {
  source?: TaskSourceId;
  generation?: number;
  legacyFallback?: boolean;
  rootOnly?: boolean;
}

export interface TaskTarget {
  source?: TaskSourceId;
  tracker?: TrackerFacade;
  context?: TrackerContext;
}

/**
 * Проверяет явный источник на входе транспорта, сохраняя отсутствие поля.
 * Неверная адресация никогда не превращается в запрос к основной доске.
 */
export function taskSource(value: unknown): TaskSourceId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isTaskSourceId(value)) {
    throw new TrackerError('bad_task_source', 'Неверный источник задачи', 400);
  }

  return value;
}

/**
 * Собственная запись имеет приоритет номера; внешняя цель подтверждает владельца.
 * Адресный фасад фиксирует поколение именно выбранной доски до первого чтения задачи.
 */
export async function resolveTaskTarget(
  config: GrigdeskTasksConfig,
  tracker: TrackerFacade | null | undefined,
  id: string | number,
  options: TaskTargetOptions = {},
): Promise<TaskTarget> {
  const source = taskSource(options.source);
  const own = await readGrigdeskTask(config, id);

  if (own) {
    if (source !== undefined && source !== 'grigdesk') {
      throw new TrackerError('task_source_mismatch', 'Номер принадлежит собственной задаче', 409);
    }

    return { source: 'grigdesk' };
  }
  if (source === 'grigdesk') {
    throw new TrackerError('grigdesk_task_not_found', 'Собственная задача не найдена', 404);
  }
  if (!tracker?.forDriver || !tracker.context) {
    if (source) {
      throw new TrackerError('tracker_context_changed', 'Адресный трекер недоступен', 409);
    }

    return { tracker: tracker || undefined };
  }

  const driverId = source?.split('@')[0] || tracker.captureContext().trackerId;

  if (!driverId) {
    return { tracker };
  }

  const addressed = tracker.forDriver(driverId);
  const context = addressed.captureContext();

  if (options.generation !== undefined) {
    addressed.assertContext(options.generation);
  }

  const owner = await addressed.context();

  if (source && source !== owner.source) {
    throw new TrackerError('tracker_context_changed', 'Владелец доски изменился', 409);
  }

  addressed.assertContext(context);

  return {
    source: taskSource(owner.source),
    tracker: addressed,
    context,
  };
}
