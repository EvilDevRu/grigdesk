import type { TaskPersonalSource } from '../../../shared/tasks/taskReference.ts';
import type { TrackerReadOptions } from './trackers/contract.ts';
import { TrackerError } from './trackers/contract.ts';
import { trackerAccountScope } from './trackers/accountScope.ts';
import type { TrackerIdentity } from './trackers/accountScope.ts';
import type { TrackerContext } from './trackers/facade.ts';

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

/**
 * Scope всегда выводится из учётной записи внешнего драйвера.
 * Внешняя identity проверяется в захваченном контексте до допуска локальной записи.
 */
export async function resolvePersonalScope(
  tracker: PersonalIdentitySource,
  options: PersonalScopeOptions = {},
  readOptions: TrackerReadOptions = {},
): Promise<string> {
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
 * Проверка исполняется внутри очереди записи, после всех асинхронных ожиданий сервиса.
 * Смена трекера не позволяет старой мутации записать метку в уже покинутую доску.
 */
export function personalWriteGuard(tracker: PersonalIdentitySource, options: PersonalScopeOptions) {
  tracker = options.driverId ? tracker.forDriver!(options.driverId) : tracker;

  const context = tracker.captureContext?.();

  return () => {
    if (context) {
      tracker.assertContext?.(context);
    }
  };
}

/**
 * Заголовок поколения ограничивает новую внешнюю мутацию текущим подключением.
 * Клиент не выбирает scope: он подтверждает только поколение подключения.
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
