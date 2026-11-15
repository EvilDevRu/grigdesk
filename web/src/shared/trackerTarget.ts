import { localeTranslator } from '../../../shared/i18n/catalogs.ts';
import { uiLocalePort } from './uiLocalePort.ts';
import { isTaskSourceId } from '../../../shared/tasks/taskReference.ts';
import type { TaskSourceId } from '../../../shared/tasks/taskReference.ts';
import { api } from './apiClient.ts';
import type { RequestOptions } from './apiClient.ts';
import type { TrackerCatalog } from '../../../shared/trackers/contracts.ts';
import { trackerMutationOptions } from './trackerMutation.ts';

const t = localeTranslator(uiLocalePort);

export interface TrackerTarget {
  prefix: string;
  source?: TaskSourceId;
  options: { headers?: Record<string, string> };
}

/**
 * Источник подтверждается полностью до чтения или записи по адресу драйвера.
 * Signal принадлежит только читателю; прежние мутации вызывают функцию без него.
 */
export async function resolveTrackerTarget(
  source?: TaskSourceId, client: Pick<typeof api, 'get'> = api,
  catalog?: TrackerCatalog | null,
  readOptions: Pick<RequestOptions, 'signal' | 'retry' | 'timeoutMs'> = {},
): Promise<TrackerTarget> {
  readOptions.signal?.throwIfAborted();

  if (!source) {
    return { prefix: '/api/tracker', options: trackerMutationOptions() };
  }
  if (!isTaskSourceId(source)) {
    throw new Error(t('core.taskSourceUnsupported'));
  }

  const metadata = catalog === undefined
    ? await client.get('/api/trackers', readOptions) as TrackerCatalog : catalog;

  readOptions.signal?.throwIfAborted();

  if (!metadata?.enabledIds) {
    const context = await client.get('/api/tracker/dashboard', readOptions) as { source?: string };

    readOptions.signal?.throwIfAborted();

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
  const context = await client.get(`${prefix}/context`, readOptions) as {
    source?: string;
    generation?: number;
  };

  readOptions.signal?.throwIfAborted();

  if (context.source !== source || !Number.isSafeInteger(context.generation)) {
    throw new Error(t('core.taskSourceMismatch'));
  }

  return {
    prefix,
    source,
    options: { headers: { 'x-grigdesk-tracker-generation': String(context.generation) } },
  };
}
