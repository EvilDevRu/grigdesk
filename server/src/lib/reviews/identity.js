// Устойчивая идентичность GitHub-замечаний.
//
// Числового номера PR или databaseId комментария недостаточно: они повторяются
// между репозиториями и разными видами комментариев. Поэтому ключ включает все
// GitHub node ID, а версия дополнительно привязана к содержимому и head SHA.
import { createHash } from 'node:crypto';

export const REMARK_KINDS = Object.freeze([
  'review_body',
  'thread_comment',
  'issue_comment',
]);

export const REMARK_STATES = Object.freeze([
  'open',
  'resolved',
  'outdated',
  'closed',
]);

function requiredId(value, field) {
  if (typeof value !== 'string' || !value || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`${field} должен быть непустым GitHub node ID`);
  }
  return value;
}

function optionalId(value, field) {
  if (value == null || value === '') return null;
  return requiredId(value, field);
}

function normalizeDate(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new TypeError(`${field} должен быть ISO timestamp`);
  return new Date(timestamp).toISOString();
}

function encode(parts) {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/**
 * Каноническая форма ключа. Возвращаем и составляющие, и сериализованный key:
 * составляющие полезны для диагностики, key — для безопасного Map/JSON index.
 */
export function createRemarkIdentity(input) {
  const repoNodeId = requiredId(input?.repoNodeId, 'repoNodeId');
  const prNodeId = requiredId(input?.prNodeId, 'prNodeId');
  const kind = String(input?.kind || '');
  if (!REMARK_KINDS.includes(kind)) {
    throw new TypeError(`kind должен быть одним из: ${REMARK_KINDS.join(', ')}`);
  }
  const threadNodeId = optionalId(input?.threadNodeId, 'threadNodeId');
  if (kind === 'thread_comment' && !threadNodeId) {
    throw new TypeError('threadNodeId обязателен для thread_comment');
  }
  if (kind !== 'thread_comment' && threadNodeId) {
    throw new TypeError('threadNodeId разрешён только для thread_comment');
  }
  const commentNodeId = requiredId(input?.commentNodeId, 'commentNodeId');
  const parts = [repoNodeId, prNodeId, kind, threadNodeId, commentNodeId];
  return Object.freeze({
    repoNodeId,
    prNodeId,
    kind,
    threadNodeId,
    commentNodeId,
    key: `remark:v1:${encode(parts)}`,
  });
}

export function serializeRemarkIdentity(input) {
  return createRemarkIdentity(input).key;
}

export function snapshotKey(repoNodeId, prNodeId) {
  return `pr:v1:${encode([
    requiredId(repoNodeId, 'repoNodeId'),
    requiredId(prNodeId, 'prNodeId'),
  ])}`;
}

export function createRemarkVersion(input) {
  const identity = createRemarkIdentity(input);
  const headSha = requiredId(input?.headSha, 'headSha');
  const state = String(input?.state || '').toLowerCase();
  if (!REMARK_STATES.includes(state)) {
    throw new TypeError(`state должен быть одним из: ${REMARK_STATES.join(', ')}`);
  }
  const updatedAt = normalizeDate(input?.updatedAt, 'updatedAt');
  if (typeof input?.body !== 'string') throw new TypeError('body должен быть строкой');
  const bodyHash = sha256(input.body);
  const digest = sha256(JSON.stringify([
    identity.key,
    headSha,
    state,
    updatedAt,
    bodyHash,
  ]));
  return Object.freeze({
    ...identity,
    headSha,
    state,
    updatedAt,
    bodyHash,
    versionId: `remark-version:v1:${digest}`,
  });
}

function canonical(value, ignoredKeys = new Set()) {
  if (Array.isArray(value)) return value.map((item) => canonical(item, ignoredKeys));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !ignoredKeys.has(key))
        .sort()
        .map((key) => [key, canonical(value[key], ignoredKeys)]),
    );
  }
  return value;
}

/**
 * Смысловой digest снимка. syncedAt и уже вычисленный digest намеренно не входят:
 * очередной успешный опрос без изменений не должен будить анализатор.
 */
export function snapshotDigest(snapshot) {
  const normalized = canonical(snapshot, new Set(['syncedAt', 'digest']));
  return `review-snapshot:v1:${sha256(JSON.stringify(normalized))}`;
}

export function sameRemarkVersion(left, right) {
  return !!left?.versionId && left.versionId === right?.versionId;
}
