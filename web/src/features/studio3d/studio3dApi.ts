// Сеть раздела использует общий cookie transport и закрытые декодеры ответов.
// Ни внешний API, ни ключ исполнителя не доступны этому клиенту.
import { api, ApiError } from '../../shared/apiClient.ts';
import type { ApiClient } from '../../shared/apiClient.ts';
import { parseStudio3d } from '../../../../shared/studio3d/studio3dContracts.ts';
import type { FieldValues } from '../../../../shared/studio3d/studio3dOperations.ts';
import { studioErrorMessage } from './presentation.ts';

import type { StudioRetryRequest, StudioBatchRunRequest } from './pendingIntentTypes.ts';

export interface StudioInput {
  modelId?: string;
  versionId?: string;
  uploads?: { role: string; uploadId: string }[];
}

export interface StudioRunInput extends StudioInput {
  provider: string;
  operation: string;
  values: FieldValues;
  expectedPrice: number;
  name?: string;
  project?: string | null;
  category?: string | null;
}

export interface StudioRunRequest extends StudioRunInput {
  libraryId: string;
  idempotencyKey: string;
}

export class Studio3dApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: Record<string, unknown>;

  constructor(status: number, code: string, body: Record<string, unknown>) {
    super(studioErrorMessage(typeof body.message === 'string' ? body.message : code));
    this.name = 'Studio3dApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

/**
 * Декодер выполняется для каждого успешного JSON; неправильная форма не проходит в Pinia.
 * Общая HTTP ошибка сохраняет status и closed server payload для решения человеком.
 */
async function decode<T>(work: Promise<unknown>, decoder: (raw: unknown) => T): Promise<T> {
  try {
    return decoder(await work);
  } catch (error) {
    if (error instanceof ApiError) {
      const body = error.data && typeof error.data === 'object' ? error.data as Record<string, unknown> : {};
      
      throw new Studio3dApiError(error.status, typeof body.error === 'string' ? body.error : '', body);
    }
    
    throw error;
  }
}

/**
 * Отсутствующий фильтр не превращается в строку undefined или null.
 * Имена и значения кодируются отдельно, абсолютные пути остаются только в POST body.
 */
function query(values: Record<string, unknown>): string {
  const search = new URLSearchParams();
  
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, String(value));
    }
  }
  
  return search.toString();
}

/**
 * Factory даёт offline тестам тот же API без подмены глобального fetch.
 * Каждый метод выбирает свой HTTP адрес и decoder, файлы остаются двоичными.
 */
export function createStudio3dApi(client: ApiClient = api) {
  const base = '/api/studio3d';
  const id = encodeURIComponent;
  const version = (model: string, vid: string) => `${base}/models/${id(model)}/versions/${id(vid)}`;
  const post = <T>(url: string, body: unknown, decoder: (raw: unknown) => T, signal?: AbortSignal) =>
    decode(client.post(url, body, { signal, retry: false }), decoder);
  const get = <T>(url: string, decoder: (raw: unknown) => T, signal?: AbortSignal) =>
    decode(client.get(url, { signal, retry: false }), decoder);

  return {
    state: (signal?: AbortSignal) => get(`${base}/state`, parseStudio3d.state, signal),
    models: (filters: Record<string, unknown> = {}, signal?: AbortSignal) =>
      get(`${base}/models?${query(filters)}`, parseStudio3d.models, signal),
    model: (modelId: string, signal?: AbortSignal) =>
      get(`${base}/models/${id(modelId)}`, parseStudio3d.model, signal),
    patchModel: (modelId: string, body: Record<string, unknown>) =>
      decode(client.patch(`${base}/models/${id(modelId)}`, body), parseStudio3d.model),
    createModel: (body: Record<string, unknown>) => post(`${base}/models`, body, parseStudio3d.createdModel),
    deleteModel: (modelId: string, libraryId: string) =>
      decode(client.del(`${base}/models/${id(modelId)}?${query({ libraryId })}`), parseStudio3d.ok),
    deleteVersion: (modelId: string, vid: string, libraryId: string) =>
      decode(client.del(`${version(modelId, vid)}?${query({ libraryId })}`), parseStudio3d.ok),
    lighten: (modelId: string, vid: string, body: Record<string, unknown>) =>
      post(`${version(modelId, vid)}/lighten`, body, parseStudio3d.lighten),
    redownload: (modelId: string, vid: string, body: Record<string, unknown>) =>
      post(`${version(modelId, vid)}/redownload`, body, parseStudio3d.version),
    retry: (modelId: string, vid: string, body: StudioRetryRequest) =>
      post(`${version(modelId, vid)}/retry`, body, parseStudio3d.run),
    preview: (modelId: string, vid: string, libraryId: string, image: Blob) =>
      decode(client.postBytes(`${version(modelId, vid)}/preview?${query({ libraryId })}`, image,
        { headers: { 'Content-Type': image.type } }), parseStudio3d.version),
    save: (modelId: string, vid: string, body: Record<string, unknown>) =>
      post(`${version(modelId, vid)}/save`, body, parseStudio3d.save),
    fromFile: (modelId: string, body: Record<string, unknown>) =>
      post(`${base}/models/${id(modelId)}/versions/from-file`, body, parseStudio3d.version),
    file: (modelId: string, vid: string, name: string) =>
      decode(client.getBlob(`${base}/files/${id(modelId)}/${id(vid)}/${id(name)}`), (value) => value as Blob),
    offers: (body: Record<string, unknown>, signal?: AbortSignal) =>
      post(`${base}/offers`, body, parseStudio3d.offers, signal),
    quote: (body: Record<string, unknown>, signal?: AbortSignal) =>
      post(`${base}/quote`, body, parseStudio3d.quote, signal),
    run: (body: StudioRunRequest) => post(`${base}/run`, body, parseStudio3d.run),
    job: (intentId: string, libraryId: string, signal?: AbortSignal) =>
      get(`${base}/jobs/${id(intentId)}?${query({ libraryId })}`, parseStudio3d.job, signal),
    reconcile: (intentId: string, childId: string, body: Record<string, unknown>) =>
      post(`${base}/jobs/${id(intentId)}/children/${id(childId)}/reconcile`, body, parseStudio3d.job),
    closeUnknown: (intentId: string, childId: string, body: Record<string, unknown>) =>
      post(`${base}/jobs/${id(intentId)}/children/${id(childId)}/close-unknown`, body, parseStudio3d.job),
    batchQuote: (body: Record<string, unknown>) =>
      post(`${base}/batches/quote`, body, parseStudio3d.batchQuote),
    batchRun: (body: StudioBatchRunRequest) => post(`${base}/batches/run`, body, parseStudio3d.batchRun),
    upload: (libraryId: string, file: File, signal?: AbortSignal) => {
      const form = new FormData();
      
      form.append('libraryId', libraryId);
      form.append('file', file);
      
      return decode(client.upload(`${base}/uploads`, form, { signal }), parseStudio3d.upload);
    },
    tasks: (refresh = false, signal?: AbortSignal) =>
      get(`${base}/tasks${refresh ? '?refresh=1' : ''}`, parseStudio3d.tasks, signal),
    importTask: (provider: string, taskId: string, libraryId: string) =>
      post(`${base}/tasks/${id(provider)}/${id(taskId)}/import`, { libraryId }, parseStudio3d.imported),
    scan: (libraryId: string) => post(`${base}/scan`, { libraryId }, parseStudio3d.scan),
    resolve: (body: Record<string, unknown>, signal?: AbortSignal) =>
      post(`${base}/viewer/resolve`, body, parseStudio3d.viewer, signal),
    viewerFile: (token: string, name: string) => decode(
      client.getBlob(`${base}/viewer/file/${id(token)}/${id(name)}`), (value) => value as Blob),
  };
}

export const studio3dApi = createStudio3dApi();
