import type { TaskPersonalSource } from '../../../shared/tasks/taskReference.ts';
import type { TrackerReadOptions } from './trackers/contract.ts';
import { TrackerError } from './trackers/contract.ts';
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { TrackerContext } from './trackers/facade.ts';
import { parseTrackerTaskId } from './trackers/taskId.ts';

export const GRIGDESK_PERSONAL_SCOPE = 'grigdesk';

export interface PersonalIdentitySource {
  forDriver?(id: string): PersonalIdentitySource;
  accountIdentity(options?: TrackerReadOptions): Promise<TrackerIdentity | null>;
  captureContext?(): TrackerContext;
  assertContext?(context: TrackerContext | number): void;
}

export interface PersonalScopeOptions {
  source?: TaskPersonalSource;
  driverId?: string;
  generation?: number;
}

export interface OwnTaskReader {
  list(): Promise<{ tasks: Array<{ id: string }> }>;
}

/**
 * Собственный scope не обращается к драйверу и не зависит от его поколения.
 * Внешняя identity проверяется в захваченном контексте до допуска локальной записи.
 */
export async function resolvePersonalScope(
  tracker: PersonalIdentitySource,
  options: PersonalScopeOptions = {},
  readOptions: TrackerReadOptions = {},
): Promise<string> {
  if (options.source === 'grigdesk') {
    return GRIGDESK_PERSONAL_SCOPE;
  }

  tracker = options.driverId ? tracker.forDriver!(options.driverId) : tracker;

  const context = tracker.captureContext?.();

  if (options.generation !== undefined) {
    tracker.assertContext?.(options.generation);
  }

  const identity = await tracker.accountIdentity(readOptions);

  if (context) {
    tracker.assertContext?.(context);
  }

  return trackerAccountScope(identity);
}

/**
 * Диапазон проверяет форму own-номера, а один снимок доказывает существование записей.
 * Удаление висячей метки обходится без чтения собственного хранилища.
 */
export async function validateOwnPersonalTasks(
  ids: unknown[],
  reader: OwnTaskReader | undefined,
  requireExisting = true,
): Promise<void> {
  const normalized = ids.map(parseTrackerTaskId);

  if (normalized.some((id) => !id || !/^[1-9]\d{11}$/.test(id))) {
    throw new TrackerError('bad_task_id', 'Некорректный номер задачи GrigDesk', 400);
  }
  if (!requireExisting) {
    return;
  }
  if (!reader) {
    throw new TrackerError('grigdesk_tasks_unavailable', 'Хранилище задач недоступно', 503);
  }

  const snapshot = await reader.list();
  const known = new Set(snapshot.tasks.map((task) => task.id));

  if (normalized.some((id) => !known.has(id!))) {
    throw new TrackerError('grigdesk_task_not_found', 'Задача GrigDesk не найдена', 404);
  }
}

/**
 * Проверка исполняется внутри очереди записи, после всех асинхронных ожиданий сервиса.
 * Смена трекера не позволяет старой мутации записать метку в уже покинутую доску.
 */
export function personalWriteGuard(tracker: PersonalIdentitySource, options: PersonalScopeOptions) {
  tracker = options.driverId ? tracker.forDriver!(options.driverId) : tracker;

  const context = options.source === 'grigdesk' ? undefined : tracker.captureContext?.();

  return () => {
    if (context) {
      tracker.assertContext?.(context);
    }
  };
}

/**
 * Заголовок поколения ограничивает новую внешнюю мутацию текущим подключением.
 * Own-обработчики выбирают своё пространство константой и этот parser не вызывают.
 */
export function trackerPersonalRequestOptions(
  headers: Record<string, unknown>,
  driverId?: string,
): PersonalScopeOptions {
  const generation = headers['x-grigdesk-tracker-generation'];

  if (generation !== undefined && (typeof generation !== 'string' || !/^\d+$/.test(generation)
    || !Number.isSafeInteger(Number(generation)))) {
    throw new TrackerError('tracker_context_changed', 'Некорректное поколение трекера', 409);
  }

  return {
    source: 'tracker',
    driverId,
    ...(generation !== undefined ? { generation: Number(generation) } : {}),
  };
}
