import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import { isTaskSourceId } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { api } from './apiClient.ts';
import type { TrackerCatalog } from '../../../shared/trackers/contracts.ts';
import { trackerMutationOptions } from './trackerMutation.ts';

const t = localeTranslator(uiLocalePort);

export interface TrackerTarget {
  prefix: string;
  source?: TaskSourceId;
  options: { headers?: Record<string, string> };
}

/**
 * Явная ссылка подтверждает весь источник, включая владельца аккаунта.
 * Отказ адресного API никогда не отправляет действие на другую доску.
 */
export async function resolveTrackerTarget(
  source?: TaskSourceId, client: Pick<typeof api, 'get'> = api,
  catalog?: TrackerCatalog | null,
): Promise<TrackerTarget> {
  if (!source) {
    return { prefix: '/api/tracker', options: trackerMutationOptions() };
  }
  if (!isTaskSourceId(source) || source === 'grigdesk') {
    throw new Error(t('core.taskSourceUnsupported'));
  }

  const metadata = catalog === undefined ? await client.get('/api/trackers') as TrackerCatalog : catalog;

  if (!metadata?.enabledIds) {
    const context = await client.get('/api/tracker/dashboard') as { source?: string };

    if (context.source !== source) {
      throw new Error(t('core.taskSourceMismatch'));
    }

    return {
      prefix: '/api/tracker',
      source,
      options: trackerMutationOptions(),
    };
  }

  const id = source.split('@')[0]!;
  const prefix = `/api/tracker/${encodeURIComponent(id)}`;
  const context = await client.get(`${prefix}/context`) as { source?: string; generation?: number };

  if (context.source !== source || !Number.isSafeInteger(context.generation)) {
    throw new Error(t('core.taskSourceMismatch'));
  }

  return {
    prefix,
    source,
    options: { headers: { 'x-grigdesk-tracker-generation': String(context.generation) } },
  };
}
