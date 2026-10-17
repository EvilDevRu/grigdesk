import { canonicalJson } from './intents.ts';
import { JobError } from './jobErrors.ts';
import { LIBRARY_UUID_RE } from './library.ts';
import { isSafeName } from './safePath.ts';
import type { RunRequest } from './intents.ts';
import type { Quote } from '../../../../shared/studio3d/studio3dOperations.ts';

const runKeys = new Set([
  'libraryId', 'idempotencyKey', 'provider', 'operation', 'values', 'expectedPrice',
  'modelId', 'versionId', 'uploads', 'name', 'project', 'category',
]);

/**
 * Только синтаксис нормализуется до fingerprint. Replay не зависит от каталога,
 * upload TTL или прежнего parent; лишние поля не обходят закрытый HTTP контракт.
 */
export function validateRunRequest(value: unknown): RunRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !runKeys.has(key))) {
    throw new JobError('invalid_request');
  }

  const request = value as RunRequest;

  if (!LIBRARY_UUID_RE.test(request.libraryId) || !LIBRARY_UUID_RE.test(request.idempotencyKey)
    || !isSafeName(request.provider) || !isSafeName(request.operation)
    || !request.values || typeof request.values !== 'object' || Array.isArray(request.values)
    || !Number.isFinite(request.expectedPrice) || request.expectedPrice < 0
    || (request.name !== undefined && (typeof request.name !== 'string' || !request.name.trim()
      || request.name.length > 200))
    || (request.modelId !== undefined && !isSafeName(request.modelId))
    || (request.versionId !== undefined && !isSafeName(request.versionId))
    || (request.project !== undefined && request.project !== null && !isSafeName(request.project))
    || (request.category !== undefined && request.category !== null
      && !['character', 'prop', 'part', 'scene'].includes(request.category))) {
    throw new JobError('invalid_request');
  }

  if (request.uploads !== undefined && (!Array.isArray(request.uploads) || request.uploads.length > 4
    || request.uploads.some((item) => !item || typeof item !== 'object'
      || Object.keys(item).some((key) => !['uploadId', 'role'].includes(key))
      || !isSafeName(item.uploadId) || !['primary', 'front', 'left', 'back', 'right'].includes(item.role)))) {
    throw new JobError('invalid_request');
  }

  if (Buffer.byteLength(canonicalJson(request)) > 256 * 1024) {
    throw new JobError('invalid_request');
  }

  return structuredClone(request);
}

/**
 * Сотые единицы сравниваются целыми числами; null и Infinity не становятся нулём.
 * Quote содержит нормализованную цену текущего исполнителя и текущего контекста.
 */
export function requirePrice(quote: Quote, expected: number): number {
  if (quote.total === null || !Number.isFinite(quote.total) || quote.total < 0
    || !Number.isSafeInteger(Math.round(quote.total * 100))) {
    throw new JobError('price_unknown', { quote });
  }

  if (Math.round(quote.total * 100) !== Math.round(expected * 100)) {
    throw new JobError('price_changed', { quote });
  }

  return quote.total;
}
