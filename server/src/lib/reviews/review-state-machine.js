// Durable-автомат review-запуска. Он намеренно не знает о task pipeline:
// reviewRunId живёт в отдельном namespace и никогда не превращается в t<N>.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireKernelFileLock } from './kernel-lock.js';

export const REVIEW_RUN_SCHEMA = 1;

export const REVIEW_RUN_STATES = Object.freeze({
  AWAITING_SCOPE: 'awaiting_scope',
  APPROVED: 'approved',
  PROVISIONING: 'provisioning',
  BUILDING: 'building',
  BUILT: 'built',
  VERIFYING: 'verifying',
  VERIFIED: 'verified',
  VERIFICATION_FAILED: 'verification_failed',
  ACCEPTED: 'accepted',
  PUBLISHING: 'publishing',
  PUBLICATION_UNKNOWN: 'publication_unknown',
  PUBLISHED: 'published',
  STALE: 'stale',
  BLOCKED: 'blocked',
  FAILED: 'failed',
});

const RUN_ID = /^rr-[a-z0-9][a-z0-9._-]{2,127}$/;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const HEAD_REF = /^refs\/heads\/(?![./])(?!.*(?:\.\.|\/\/|@\{|\\|[\x00-\x20\x7f~^:?*[]))(?!.*\/$).+$/;

export class ReviewStateError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'ReviewStateError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new ReviewStateError(code, message, details);
}

function clone(value) {
  return structuredClone(value);
}

function at(now) {
  const value = typeof now === 'function' ? now() : now;
  const timestamp = Number(value ?? Date.now());
  if (!Number.isFinite(timestamp) || timestamp < 0) fail('TIME_INVALID', 'Некорректное время');
  return Math.trunc(timestamp);
}

function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('DIGEST_VALUE_INVALID', 'Digest не поддерживает NaN/Infinity');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonical(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => value[key] !== undefined)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  fail('DIGEST_VALUE_INVALID', `Digest не поддерживает тип ${typeof value}`);
}

export function canonicalDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function reviewCriterionId(item) {
  const itemKey = requireString(
    item?.itemKey ?? item?.key,
    'SCOPE_ITEM_INVALID',
    'Ключ замечания',
  );
  const itemVersion = requireString(
    item?.itemVersion ?? item?.versionId,
    'SCOPE_ITEM_INVALID',
    'Версия замечания',
  );
  const instruction = String(item?.instruction ?? '').trim();
  return `criterion-${canonicalDigest({ itemKey, itemVersion, instruction }).slice(0, 24)}`;
}

function requireString(value, code, label) {
  const result = String(value ?? '').trim();
  if (!result) fail(code, `${label} не задан`);
  return result;
}

function hasHttpCredentials(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.username || url.password);
  } catch {
    return false;
  }
}

export function isSafeHeadRepoUrl(value) {
  const remote = String(value || '').trim();
  if (!remote || remote.startsWith('-') || /[\r\n]/.test(remote) || hasHttpCredentials(remote)) {
    return false;
  }
  if (path.isAbsolute(remote)) return true;
  if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/i.test(remote)) {
    return true;
  }
  try {
    const url = new URL(remote);
    if (url.protocol === 'file:') return path.isAbsolute(url.pathname);
    if (!['https:', 'ssh:'].includes(url.protocol)
        || url.hostname.toLowerCase() !== 'github.com'
        || url.search
        || url.hash) {
      return false;
    }
    return /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(url.pathname)
      && (url.protocol !== 'ssh:' || !url.username || url.username === 'git');
  } catch {
    return false;
  }
}

function normalizeScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) fail('SCOPE_EMPTY', 'Не выбран ни один пункт');
  const keys = new Set();
  const normalized = scope.map((item) => {
    const itemKey = requireString(item?.itemKey ?? item?.key, 'SCOPE_ITEM_INVALID', 'Ключ замечания');
    const itemVersion = requireString(
      item?.itemVersion ?? item?.versionId,
      'SCOPE_ITEM_INVALID',
      'Версия замечания',
    );
    if (item?.action !== 'fix') {
      fail('SCOPE_NOT_WRITABLE', `Пункт ${itemKey} не утверждён для исправления`);
    }
    if (keys.has(itemKey)) fail('SCOPE_ITEM_DUPLICATE', `Пункт ${itemKey} выбран дважды`);
    keys.add(itemKey);
    return {
      ...clone(item),
      key: itemKey,
      versionId: itemVersion,
      itemKey,
      itemVersion,
      action: 'fix',
      instruction: String(item?.instruction ?? '').trim(),
    };
  });
  normalized.sort((a, b) => a.itemKey.localeCompare(b.itemKey));
  return normalized;
}

export function scopeDigest(stateOrInput) {
  const snapshot = stateOrInput.snapshot;
  const scope = normalizeScope(stateOrInput.scope);
  const scopeVersion = requireString(
    stateOrInput.scopeVersion ?? stateOrInput.scopeApproval?.version,
    'SCOPE_VERSION_INVALID',
    'Версия scope',
  );
  return canonicalDigest({
    snapshot: {
      digest: snapshot?.digest,
      version: snapshot?.version,
      headSha: snapshot?.headSha,
    },
    scopeVersion,
    scope,
    reviewRouteRevision: stateOrInput.reviewRoute?.revision || null,
    verificationPolicy: stateOrInput.verificationPolicy || null,
  });
}

export function verifyDigest(report) {
  const copy = clone(report ?? {});
  delete copy.digest;
  return canonicalDigest(copy);
}

export function acceptanceDigest(state) {
  if (!state?.scopeApproval || !state?.candidate || !state?.verify) {
    fail('ACCEPTANCE_INPUT_INCOMPLETE', 'Для приёмки не хватает scope, кандидата или VERIFY');
  }
  return canonicalDigest({
    snapshot: {
      digest: state.snapshot.digest,
      version: state.snapshot.version,
      headSha: state.snapshot.headSha,
    },
    scope: state.scope,
    scopeApproval: {
      version: state.scopeApproval.version,
      digest: state.scopeApproval.digest,
    },
    reviewRoute: state.reviewRoute || null,
    verificationPolicy: state.verificationPolicy || null,
    candidate: {
      commit: state.candidate.commit,
      tree: state.candidate.tree,
    },
    verify: {
      digest: verifyDigest(state.verify.report),
    },
  });
}

export function createReviewRunState(input, { now = Date.now } = {}) {
  const reviewRunId = requireString(input?.reviewRunId, 'RUN_ID_INVALID', 'reviewRunId');
  if (!RUN_ID.test(reviewRunId) || /^rr-\d+$/.test(reviewRunId)) {
    fail('RUN_ID_INVALID', 'reviewRunId должен находиться в отдельном rr-* namespace');
  }
  const projectId = requireString(input.projectId, 'PROJECT_ID_INVALID', 'Проект');
  const repositoryId = requireString(input.repositoryId, 'REPOSITORY_ID_INVALID', 'Репозиторий');
  if (!SAFE_ID.test(projectId) || !SAFE_ID.test(repositoryId)) {
    fail('RUN_BINDING_INVALID', 'Идентификатор проекта или репозитория небезопасен');
  }
  const prNumber = Number(input.prNumber);
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    fail('PR_NUMBER_INVALID', 'Некорректный номер PR');
  }
  const snapshot = {
    digest: requireString(input.snapshot?.digest, 'SNAPSHOT_INVALID', 'Digest снимка'),
    version: requireString(input.snapshot?.version, 'SNAPSHOT_INVALID', 'Версия снимка'),
    headSha: requireString(input.snapshot?.headSha, 'SNAPSHOT_INVALID', 'SHA снимка').toLowerCase(),
  };
  const binding = {
    repoPath: requireString(input.binding?.repoPath, 'RUN_BINDING_INVALID', 'Путь репозитория'),
    headRepoUrl: requireString(
      input.binding?.headRepoUrl,
      'RUN_BINDING_INVALID',
      'Head-репозиторий',
    ),
    headRef: requireString(input.binding?.headRef, 'RUN_BINDING_INVALID', 'Head ref'),
    headSha: requireString(input.binding?.headSha, 'RUN_BINDING_INVALID', 'Head SHA').toLowerCase(),
  };
  if (!path.isAbsolute(binding.repoPath)
      || !isSafeHeadRepoUrl(binding.headRepoUrl)
      || !HEAD_REF.test(binding.headRef)
      || !SHA.test(binding.headSha)
      || !SHA.test(snapshot.headSha)
      || binding.headSha !== snapshot.headSha) {
    fail('RUN_BINDING_INVALID', 'Привязка запуска к Git/ref/SHA некорректна');
  }
  const createdAt = at(now);
  const reviewRoute = input.reviewRoute == null ? null : clone(input.reviewRoute);
  if (reviewRoute && (
    reviewRoute.schemaVersion !== 1
    || reviewRoute.source !== 'factory-profile'
    || !SAFE_ID.test(String(reviewRoute.profileId || ''))
    || !SAFE_ID.test(String(reviewRoute.routeId || ''))
    || !Array.isArray(reviewRoute.stages)
    || !reviewRoute.stages.includes('BUILD')
    || !reviewRoute.stages.includes('GATE_ACCEPT')
    || !/^factory-review-route:v1:[a-f0-9]{64}$/.test(String(reviewRoute.revision || ''))
  )) {
    fail('REVIEW_ROUTE_INVALID', 'Некорректный immutable Factory review route');
  }
  const verificationPolicy = input.verificationPolicy == null
    ? null
    : clone(input.verificationPolicy);
  if (verificationPolicy && (
    !Array.isArray(verificationPolicy.commands)
    || verificationPolicy.commands.length === 0
    || verificationPolicy.commands.length > 20
    || verificationPolicy.commands.some((command) => (
      typeof command !== 'string' || !command.trim() || command.length > 4_096
    ))
    || verificationPolicy.coversAllCriteria !== true
  )) {
    fail('VERIFY_POLICY_INVALID', 'Некорректная immutable политика проверок');
  }
  return {
    schemaVersion: REVIEW_RUN_SCHEMA,
    revision: 0,
    reviewRunId,
    projectId,
    repositoryId,
    prNumber,
    status: REVIEW_RUN_STATES.AWAITING_SCOPE,
    snapshot,
    binding,
    reviewRoute,
    verificationPolicy,
    scope: null,
    scopeApproval: null,
    candidate: null,
    verify: null,
    acceptance: null,
    publication: null,
    recovery: null,
    lease: null,
    fencingCounter: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

export function approveScopeState(state, {
  scope,
  scopeVersion,
  actor,
}, { now = Date.now } = {}) {
  if (![REVIEW_RUN_STATES.AWAITING_SCOPE, REVIEW_RUN_STATES.APPROVED].includes(state?.status)) {
    fail('SCOPE_STATE_INVALID', `Scope нельзя утвердить из состояния ${state?.status}`);
  }
  const normalized = normalizeScope(scope);
  const version = requireString(scopeVersion, 'SCOPE_VERSION_INVALID', 'Версия scope');
  const approvedBy = requireString(actor, 'ACTOR_REQUIRED', 'Автор решения');
  const next = clone(state);
  next.scope = normalized;
  next.scopeApproval = {
    version,
    actor: approvedBy,
    digest: scopeDigest({
      snapshot: next.snapshot,
      scope: normalized,
      scopeVersion: version,
      reviewRoute: next.reviewRoute,
      verificationPolicy: next.verificationPolicy,
    }),
    approvedAt: at(now),
  };
  next.candidate = null;
  next.verify = null;
  next.acceptance = null;
  next.publication = null;
  next.status = REVIEW_RUN_STATES.APPROVED;
  next.updatedAt = at(now);
  return next;
}

function assertScopeApproval(state) {
  if (!state.scopeApproval || !state.scope) {
    fail('SCOPE_APPROVAL_REQUIRED', 'Нужно явное утверждение scope');
  }
  const actual = scopeDigest({
    snapshot: state.snapshot,
    scope: state.scope,
    scopeVersion: state.scopeApproval.version,
    reviewRoute: state.reviewRoute,
    verificationPolicy: state.verificationPolicy,
  });
  if (actual !== state.scopeApproval.digest) {
    fail('SCOPE_APPROVAL_STALE', 'Scope или снимок изменился после утверждения');
  }
}

export function startBuildState(state, { now = Date.now } = {}) {
  if (state?.status !== REVIEW_RUN_STATES.APPROVED) {
    if (!state?.scopeApproval) fail('SCOPE_APPROVAL_REQUIRED', 'BUILD требует утверждённый scope');
    fail('BUILD_STATE_INVALID', `BUILD нельзя начать из состояния ${state?.status}`);
  }
  assertScopeApproval(state);
  const next = clone(state);
  next.status = REVIEW_RUN_STATES.BUILDING;
  next.updatedAt = at(now);
  return next;
}

export function completeBuildState(state, {
  candidateCommit,
  candidateTree,
  diff,
  buildEvidence,
  worktreePath,
  candidateBranch,
}, { now = Date.now } = {}) {
  if (state?.status !== REVIEW_RUN_STATES.BUILDING) {
    fail('BUILD_STATE_INVALID', `Результат BUILD нельзя принять из ${state?.status}`);
  }
  const commit = requireString(candidateCommit, 'CANDIDATE_INVALID', 'Candidate commit').toLowerCase();
  const tree = requireString(candidateTree, 'CANDIDATE_INVALID', 'Candidate tree').toLowerCase();
  if (!SHA.test(commit) || !SHA.test(tree)) fail('CANDIDATE_INVALID', 'Некорректный Git object ID');
  const next = clone(state);
  next.candidate = {
    commit,
    tree,
    branch: candidateBranch || next.binding.candidateBranch || null,
    worktreePath: worktreePath || next.binding.worktreePath || null,
    diff: clone(diff ?? { files: [], stat: '' }),
    buildEvidence: clone(buildEvidence ?? null),
    completedAt: at(now),
  };
  if (worktreePath) next.binding.worktreePath = worktreePath;
  if (candidateBranch) next.binding.candidateBranch = candidateBranch;
  next.verify = null;
  next.acceptance = null;
  next.publication = null;
  next.status = REVIEW_RUN_STATES.BUILT;
  next.updatedAt = at(now);
  return next;
}

export function startVerifyState(state, { now = Date.now } = {}) {
  if (![REVIEW_RUN_STATES.BUILT, REVIEW_RUN_STATES.VERIFICATION_FAILED].includes(state?.status)
      || !state.candidate) {
    fail('VERIFY_STATE_INVALID', `VERIFY нельзя начать из состояния ${state?.status}`);
  }
  const next = clone(state);
  next.status = REVIEW_RUN_STATES.VERIFYING;
  next.acceptance = null;
  next.publication = null;
  next.updatedAt = at(now);
  return next;
}

export function completeVerifyState(state, { report }, { now = Date.now } = {}) {
  if (state?.status !== REVIEW_RUN_STATES.VERIFYING || !state.candidate) {
    fail('VERIFY_STATE_INVALID', `Результат VERIFY нельзя принять из ${state?.status}`);
  }
  if (!report || report.candidateCommit !== state.candidate.commit
      || report.candidateTree !== state.candidate.tree) {
    fail('VERIFY_CANDIDATE_MISMATCH', 'VERIFY относится не к текущему candidate');
  }
  const commands = Array.isArray(report.commands) ? report.commands : [];
  const required = commands.filter((item) => item.required !== false);
  const commandPassed = (item) => (
    item?.effectiveOk === undefined ? item?.ok === true : item.effectiveOk === true
  );
  const commandIds = commands.map((item) => String(item?.id || ''));
  const commandsUnique = commandIds.every(Boolean)
    && new Set(commandIds).size === commandIds.length;
  const commandById = new Map(commands.map((item) => [String(item?.id || ''), item]));
  const requiredPassed = required.length > 0
    && commandsUnique
    && required.every(commandPassed);
  const criteria = Array.isArray(report.criteria) ? report.criteria : [];
  const criterionById = new Map(criteria.map((item) => [String(item?.id || ''), item]));
  const requiredScopeCriteria = (state.scope || [])
    .filter((item) => String(item?.instruction || '').trim());
  const criteriaPassed = requiredScopeCriteria.every((scopeItem) => {
    const expectedId = reviewCriterionId(scopeItem);
    const criterion = criterionById.get(expectedId);
    if (!criterion
        || criterion.required !== true
        || criterion.status !== 'passed'
        || criterion.itemKey !== scopeItem.itemKey
        || criterion.itemVersion !== scopeItem.itemVersion
        || criterion.acceptanceCriterion !== scopeItem.instruction
        || !Array.isArray(criterion.commandIds)
        || criterion.commandIds.length === 0) {
      return false;
    }
    return criterion.commandIds.every((id) => commandPassed(commandById.get(String(id))));
  });
  const passed = report.passed === true
    && report.worktreeClean === true
    && requiredPassed
    && criteriaPassed;
  const normalized = {
    ...clone(report),
    passed,
  };
  normalized.digest = verifyDigest(normalized);
  const next = clone(state);
  next.verify = {
    report: normalized,
    digest: normalized.digest,
    passed,
    completedAt: at(now),
  };
  next.acceptance = null;
  next.publication = null;
  next.status = passed
    ? REVIEW_RUN_STATES.VERIFIED
    : REVIEW_RUN_STATES.VERIFICATION_FAILED;
  next.updatedAt = at(now);
  return next;
}

export function acceptReviewRunState(state, { actor }, { now = Date.now } = {}) {
  if (state?.status !== REVIEW_RUN_STATES.VERIFIED || state.verify?.passed !== true) {
    fail('VERIFY_REQUIRED', 'Приёмка разрешена только после зелёного VERIFY');
  }
  assertScopeApproval(state);
  const acceptedBy = requireString(actor, 'ACTOR_REQUIRED', 'Автор приёмки');
  const next = clone(state);
  next.acceptance = {
    actor: acceptedBy,
    digest: acceptanceDigest(next),
    acceptedAt: at(now),
  };
  next.status = REVIEW_RUN_STATES.ACCEPTED;
  next.updatedAt = at(now);
  return next;
}

export function validateReadyToPublish(state, { acceptanceDigest: suppliedDigest } = {}) {
  if (!state?.acceptance || ![
    REVIEW_RUN_STATES.ACCEPTED,
    REVIEW_RUN_STATES.PUBLISHING,
    REVIEW_RUN_STATES.PUBLICATION_UNKNOWN,
    REVIEW_RUN_STATES.PUBLISHED,
  ].includes(state.status)) {
    fail('ACCEPTANCE_REQUIRED', 'Публикация требует действующую приёмку');
  }
  if (state.verify?.passed !== true) fail('VERIFY_REQUIRED', 'VERIFY не зелёный');
  try {
    assertScopeApproval(state);
  } catch (error) {
    if (error?.code === 'SCOPE_APPROVAL_STALE') {
      fail('ACCEPTANCE_STALE', 'Scope или снимок изменился после приёмки');
    }
    throw error;
  }
  const actual = acceptanceDigest(state);
  if (actual !== state.acceptance.digest
      || (suppliedDigest !== undefined && suppliedDigest !== state.acceptance.digest)) {
    fail('ACCEPTANCE_STALE', 'Приёмка больше не соответствует candidate');
  }
  return true;
}

export function startPublicationState(state, {
  operationId,
  acceptanceDigest: suppliedDigest,
  actor,
}, { now = Date.now } = {}) {
  validateReadyToPublish(state, { acceptanceDigest: suppliedDigest });
  if (state.status === REVIEW_RUN_STATES.PUBLISHED || state.publication) return clone(state);
  const id = requireString(operationId, 'PUBLICATION_ID_INVALID', 'ID публикации');
  if (!SAFE_ID.test(id)) fail('PUBLICATION_ID_INVALID', 'Некорректный ID публикации');
  const next = clone(state);
  next.publication = {
    id,
    status: 'running',
    actor: requireString(actor, 'ACTOR_REQUIRED', 'Автор публикации'),
    acceptanceDigest: next.acceptance.digest,
    expectedRemoteSha: next.binding.headSha,
    candidateCommit: next.candidate.commit,
    headRepoUrl: next.binding.headRepoUrl,
    headRef: next.binding.headRef,
    startedAt: at(now),
  };
  next.status = REVIEW_RUN_STATES.PUBLISHING;
  next.updatedAt = at(now);
  return next;
}

export function completePublicationState(state, {
  operationId,
  status,
  reason = null,
  remoteSha = null,
  reconciled = false,
  error = null,
}, { now = Date.now } = {}) {
  if (!state?.publication || state.publication.id !== operationId) {
    fail('PUBLICATION_OPERATION_STALE', 'Результат относится к другой операции публикации');
  }
  const statuses = {
    published: REVIEW_RUN_STATES.PUBLISHED,
    stale: REVIEW_RUN_STATES.STALE,
    unknown: REVIEW_RUN_STATES.PUBLICATION_UNKNOWN,
    blocked: REVIEW_RUN_STATES.BLOCKED,
  };
  if (!statuses[status]) fail('PUBLICATION_RESULT_INVALID', 'Некорректный результат публикации');
  const next = clone(state);
  next.publication = {
    ...next.publication,
    status,
    reason,
    remoteSha,
    reconciled: Boolean(reconciled),
    error: error ? String(error).slice(0, 2_000) : null,
    finishedAt: at(now),
  };
  next.status = statuses[status];
  next.updatedAt = at(now);
  return next;
}

export function acquireLeaseState(state, {
  owner,
  now = Date.now,
  ttlMs = 30_000,
}) {
  const ownerId = requireString(owner, 'LEASE_OWNER_INVALID', 'Владелец lease');
  const timestamp = at(now);
  const ttl = Number(ttlMs);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) fail('LEASE_TTL_INVALID', 'Некорректный TTL lease');
  if (state.lease && state.lease.expiresAt > timestamp) {
    fail('LEASE_BUSY', `Запуск уже выполняет ${state.lease.owner}`);
  }
  const next = clone(state);
  const fencingToken = Number(next.fencingCounter || 0) + 1;
  next.fencingCounter = fencingToken;
  next.lease = {
    owner: ownerId,
    fencingToken,
    acquiredAt: timestamp,
    expiresAt: timestamp + ttl,
  };
  next.updatedAt = timestamp;
  return next;
}

export function renewLeaseState(state, {
  owner,
  fencingToken,
  now = Date.now,
  ttlMs = 30_000,
}) {
  const timestamp = at(now);
  assertFencingToken(state, { owner, fencingToken, now: timestamp });
  const ttl = Number(ttlMs);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) fail('LEASE_TTL_INVALID', 'Некорректный TTL lease');
  const next = clone(state);
  next.lease.expiresAt = timestamp + ttl;
  next.updatedAt = timestamp;
  return next;
}

export function releaseLeaseState(state, { owner, fencingToken, now = Date.now }) {
  assertFencingToken(state, { owner, fencingToken, now });
  const next = clone(state);
  next.lease = null;
  next.updatedAt = at(now);
  return next;
}

export function assertFencingToken(state, { owner, fencingToken, now } = {}) {
  if (!state?.lease
      || state.lease.owner !== owner
      || state.lease.fencingToken !== fencingToken
      || state.fencingCounter !== fencingToken) {
    fail('FENCING_TOKEN_STALE', 'Запоздавший worker больше не владеет запуском');
  }
  if (now !== undefined && state.lease.expiresAt <= at(now)) {
    fail('LEASE_EXPIRED', 'Lease уже истёк');
  }
  return true;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Некоторые FS не поддерживают fsync каталога. Реальные I/O ошибки нельзя
    // маскировать успешным durable commit.
    if (!['EINVAL', 'ENOTSUP', 'EBADF'].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function atomicJsonWrite(file, value, {
  assertHeld = () => {},
  assertCanCommit = () => {},
  expectedRevision,
  expectedAbsent = false,
  expectedValue,
} = {}) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    assertHeld();
    if (expectedAbsent) {
      let exists = false;
      try {
        await fs.access(file);
        exists = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (exists) {
        fail('STATE_CAS_MISMATCH', `Файл ${file} появился после потери lock`);
      }
    } else if (expectedRevision !== undefined || expectedValue !== undefined) {
      let current;
      try {
        current = JSON.parse(await fs.readFile(file, 'utf8'));
      } catch {
        fail('STATE_CAS_MISMATCH', `Файл ${file} изменился после потери lock`);
      }
      if ((expectedRevision !== undefined && current?.revision !== expectedRevision)
          || (expectedValue !== undefined
            && JSON.stringify(current) !== JSON.stringify(expectedValue))) {
        fail('STATE_CAS_MISMATCH', `Файл ${file} изменился после потери lock`);
      }
    }
    assertHeld();
    assertCanCommit();
    await fs.rename(temporary, file);
    assertHeld();
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

/**
 * Файловое хранилище с межпроцессным mutex, atomic rename и fencing token.
 * Lock защищает compare-and-swap; lease защищает долгую внешнюю работу.
 */
export class ReviewStateStore {
  constructor({
    stateDir,
    now = Date.now,
    lockTimeoutMs = 5_000,
    lockStaleMs = 30_000,
    lockBinary = 'flock',
  }) {
    if (!path.isAbsolute(String(stateDir || ''))) {
      fail('STATE_DIR_INVALID', 'stateDir должен быть абсолютным');
    }
    this.root = path.join(stateDir, 'review-runs');
    this.now = now;
    this.lockTimeoutMs = lockTimeoutMs;
    // Принимаем старую настройку для обратной совместимости, но kernel flock
    // не нуждается в небезопасном stale-delete по wall clock.
    void lockStaleMs;
    this.lockBinary = String(lockBinary || '');
    if (!this.lockBinary) fail('STATE_LOCK_INVALID', 'Не задан системный flock');
  }

  pathFor(reviewRunId) {
    if (!RUN_ID.test(String(reviewRunId || ''))) fail('RUN_ID_INVALID', 'Некорректный reviewRunId');
    return path.join(this.root, reviewRunId, 'state.json');
  }

  async #withPathLock(lock, action) {
    const held = await acquireKernelFileLock({
      lockPath: lock,
      timeoutMs: this.lockTimeoutMs,
      binary: this.lockBinary,
      timeoutCode: 'STATE_LOCK_TIMEOUT',
      unavailableCode: 'STATE_LOCK_UNAVAILABLE',
      lostCode: 'STATE_LOCK_LOST',
      label: lock,
      errorFactory: (code, message) => new ReviewStateError(code, message),
    });
    try {
      const result = await action(held.assertHeld);
      held.assertHeld();
      return result;
    } finally {
      await held.release();
    }
  }

  async #withLock(reviewRunId, action) {
    const statePath = this.pathFor(reviewRunId);
    const lock = path.join(path.dirname(statePath), '.state.lock');
    return this.#withPathLock(lock, (assertHeld) => action(statePath, assertHeld));
  }

  async #withRootLock(name, action) {
    if (!SAFE_ID.test(name)) fail('STATE_LOCK_INVALID', 'Некорректное имя root lock');
    return this.#withPathLock(path.join(this.root, `.${name}.lock`), action);
  }

  async #read(file) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') fail('RUN_NOT_FOUND', 'Review-запуск не найден');
      throw error;
    }
    try {
      const state = JSON.parse(raw);
      if (state?.schemaVersion !== REVIEW_RUN_SCHEMA || !RUN_ID.test(state?.reviewRunId || '')) {
        fail('STATE_CORRUPT', 'Некорректная схема состояния');
      }
      return state;
    } catch (error) {
      if (error instanceof ReviewStateError) throw error;
      fail('STATE_CORRUPT', 'Файл состояния повреждён');
    }
  }

  async create(state) {
    if (state?.schemaVersion !== REVIEW_RUN_SCHEMA || !RUN_ID.test(state?.reviewRunId || '')) {
      fail('STATE_INVALID', 'Нельзя сохранить некорректное состояние');
    }
    return this.#withLock(state.reviewRunId, async (file, assertHeld) => {
      try {
        await fs.access(file);
        fail('RUN_EXISTS', `Запуск ${state.reviewRunId} уже существует`);
      } catch (error) {
        if (error instanceof ReviewStateError) throw error;
        if (error?.code !== 'ENOENT') throw error;
      }
      const saved = clone(state);
      saved.revision = 0;
      await atomicJsonWrite(file, saved, { assertHeld, expectedAbsent: true });
      return saved;
    });
  }

  /**
   * Атомарно резервирует активную попытку для одного ProjectRepository/PR.
   * Индекс — ускоритель и crash-journal; при расхождении он сверяется с run state.
   */
  async createExclusive(state) {
    const identity = `${state?.projectId}/${state?.repositoryId}#${state?.prNumber}`;
    const terminal = new Set([
      REVIEW_RUN_STATES.VERIFICATION_FAILED,
      REVIEW_RUN_STATES.PUBLISHED,
      REVIEW_RUN_STATES.STALE,
      REVIEW_RUN_STATES.BLOCKED,
      REVIEW_RUN_STATES.FAILED,
    ]);
    return this.#withRootLock('active-runs', async (assertHeld) => {
      const indexPath = path.join(this.root, 'active-index.json');
      let index = { schemaVersion: 1, runs: {} };
      let indexExists = false;
      try {
        index = JSON.parse(await fs.readFile(indexPath, 'utf8'));
        indexExists = true;
        if (index?.schemaVersion !== 1 || !index.runs || typeof index.runs !== 'object') {
          fail('ACTIVE_INDEX_CORRUPT', 'Индекс активных review-запусков повреждён');
        }
      } catch (error) {
        if (error instanceof ReviewStateError) throw error;
        if (error?.code !== 'ENOENT') fail('ACTIVE_INDEX_CORRUPT', 'Индекс активных запусков повреждён');
      }
      const originalIndex = clone(index);

      const indexedId = index.runs[identity];
      if (indexedId) {
        let indexed;
        try {
          indexed = await this.load(indexedId);
        } catch {
          fail('ACTIVE_RUN_UNKNOWN', `Не удаётся проверить активный запуск ${indexedId}`);
        }
        if (!terminal.has(indexed.status)) {
          fail('ACTIVE_RUN_EXISTS', `Для PR уже существует активный запуск ${indexedId}`, {
            reviewRunId: indexedId,
          });
        }
        delete index.runs[identity];
      }

      // Закрывает crash после state create, но до записи active-index.
      for (const candidate of await this.list()) {
        if (candidate.status === 'corrupt') continue;
        if (candidate.projectId === state.projectId
            && candidate.repositoryId === state.repositoryId
            && candidate.prNumber === state.prNumber
            && !terminal.has(candidate.status)) {
          index.runs[identity] = candidate.reviewRunId;
          await atomicJsonWrite(indexPath, index, {
            assertHeld,
            ...(indexExists ? { expectedValue: originalIndex } : { expectedAbsent: true }),
          });
          fail('ACTIVE_RUN_EXISTS', `Для PR уже существует активный запуск ${candidate.reviewRunId}`, {
            reviewRunId: candidate.reviewRunId,
          });
        }
      }

      const created = await this.create(state);
      index.runs[identity] = created.reviewRunId;
      await atomicJsonWrite(indexPath, index, {
        assertHeld,
        ...(indexExists ? { expectedValue: originalIndex } : { expectedAbsent: true }),
      });
      return created;
    });
  }

  async load(reviewRunId) {
    return this.#read(this.pathFor(reviewRunId));
  }

  async update(reviewRunId, mutator, {
    expectedRevision,
    owner,
    fencingToken,
  } = {}) {
    if (typeof mutator !== 'function') fail('STATE_MUTATOR_INVALID', 'Нужна функция обновления');
    return this.#withLock(reviewRunId, async (file, assertHeld) => {
      const current = await this.#read(file);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        fail('STATE_REVISION_STALE', 'Состояние уже изменилось');
      }
      if (owner !== undefined || fencingToken !== undefined) {
        assertFencingToken(current, { owner, fencingToken, now: this.now });
      } else if (current.lease && current.lease.expiresAt > at(this.now)) {
        fail('LEASE_BUSY', `Запуск уже выполняет ${current.lease.owner}`);
      }
      const proposed = await mutator(clone(current));
      // Mutator обычно синхронный, но контракт допускает Promise. Истёкший во
      // время await lease не получает право на поздний commit только потому,
      // что lock не успел перейти конкуренту.
      if (owner !== undefined || fencingToken !== undefined) {
        assertFencingToken(current, { owner, fencingToken, now: this.now });
      }
      if (!proposed || proposed.reviewRunId !== current.reviewRunId
          || proposed.schemaVersion !== REVIEW_RUN_SCHEMA) {
        fail('STATE_INVALID', 'Mutator вернул некорректное состояние');
      }
      const next = clone(proposed);
      next.revision = current.revision + 1;
      await atomicJsonWrite(file, next, {
        assertHeld,
        assertCanCommit: owner !== undefined || fencingToken !== undefined
          ? () => assertFencingToken(current, {
            owner,
            fencingToken,
            now: this.now,
          })
          : undefined,
        expectedRevision: current.revision,
      });
      return next;
    });
  }

  async acquireLease(reviewRunId, options) {
    return this.#withLock(reviewRunId, async (file, assertHeld) => {
      const current = await this.#read(file);
      const next = acquireLeaseState(current, options);
      next.revision = current.revision + 1;
      await atomicJsonWrite(file, next, {
        assertHeld,
        expectedRevision: current.revision,
      });
      return next;
    });
  }

  async renewLease(reviewRunId, options) {
    return this.update(
      reviewRunId,
      (state) => renewLeaseState(state, options),
      { owner: options.owner, fencingToken: options.fencingToken },
    );
  }

  async releaseLease(reviewRunId, options) {
    return this.update(
      reviewRunId,
      (state) => releaseLeaseState(state, options),
      { owner: options.owner, fencingToken: options.fencingToken },
    );
  }

  async list() {
    let ids;
    try {
      ids = await fs.readdir(this.root);
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const results = [];
    for (const id of ids.sort()) {
      if (!RUN_ID.test(id)) continue;
      try {
        results.push(await this.load(id));
      } catch (error) {
        results.push({
          reviewRunId: id,
          status: 'corrupt',
          error: error.code || 'STATE_CORRUPT',
        });
      }
    }
    return results;
  }
}
