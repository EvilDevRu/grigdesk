import { NO_TRACKER_CAPABILITIES } from '../../../shared/trackers/contracts.ts';
import type { TrackerCapabilities } from '../../../shared/trackers/contracts.ts';
import { isRecord } from '../../../shared/lib/objects.ts';

export const LEGACY_TRACKER_CAPABILITIES: TrackerCapabilities = Object.fromEntries(
  Object.keys(NO_TRACKER_CAPABILITIES).map((key) => [
    key,
    !['delete', 'checklist', 'tags', 'review'].includes(key),
  ]),
) as unknown as TrackerCapabilities;

/**
 * Явная metadata разрешает только объявленные булевы возможности.
 * Отсутствующие поля закрыты, а legacy fallback включается отдельно после HTTP 404.
 */
export function trackerCapabilities(value: unknown): TrackerCapabilities {
  const result = { ...NO_TRACKER_CAPABILITIES };

  if (isRecord(value)) {
    for (const key of Object.keys(result) as Array<keyof TrackerCapabilities>) {
      result[key] = value[key] === true;
    }
  }

  return result;
}

/**
 * Новая доска скрывает таймер по явной metadata возможностей.
 * Отсутствие поля в старом снимке сохраняет прежнее отображение его таймеров.
 */
export function boardSupportsTimer(data: Record<string, unknown> | null): boolean {
  return data?.capabilities === undefined ? true : trackerCapabilities(data.capabilities).timer;
}
