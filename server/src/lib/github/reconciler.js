// Bounded recovery GitHub Issues. Один вызов одинаково подходит startup,
// periodic tick и ручной проверке; таймеры и lifecycle живут уровнем выше.

import { listRepositoryIssuesPage } from './api.js';
import { githubIssueSemanticKey } from './archive-store.js';
import { normalizeOpenedIssue } from './normalize.js';

const MAX_PAGES_LIMIT = 100;
const MAX_ROWS_LIMIT = 10_000;
const API_OPTION_KEYS = new Set([
  'fetchImpl',
  'timeoutMs',
  'maxResponseBytes',
  'maxRequestBytes',
]);

export class GitHubReconcileError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GitHubReconcileError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(message, extra = {}) {
  throw new GitHubReconcileError('github_reconcile_invalid', message, extra);
}

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} должен быть объектом.`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} не задан.`);
  return value;
}

function positiveInt(value, label, max) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    fail(`${label} должен быть целым от 1 до ${max}.`);
  }
  return value;
}

function repositoryIdentity(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text) || !Number.isSafeInteger(Number(text))) {
    fail('repositoryId должен быть положительным safe integer GitHub.');
  }
  return { text, number: Number(text) };
}

function providerTimestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    fail(`${label} должен быть точным UTC timestamp GitHub.`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) {
    fail(`${label} содержит невозможную дату.`);
  }
  return value;
}

function issueIdentity(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} должен быть положительным safe integer.`);
  return String(value);
}

function boundaryOf(value) {
  if (value === null || value === undefined) return null;
  plainObject(value, 'boundary');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'createdAt' || keys[1] !== 'issueId') {
    fail('boundary должна содержать только createdAt и issueId.');
  }
  if (typeof value.issueId !== 'string' || !/^[1-9]\d*$/u.test(value.issueId)) {
    fail('boundary.issueId должен быть canonical decimal string.');
  }
  return {
    createdAt: providerTimestamp(value.createdAt, 'boundary.createdAt'),
    issueId: value.issueId,
  };
}

function positionOf(row, index) {
  plainObject(row, `issues[${index}]`);
  return {
    createdAt: providerTimestamp(row.created_at, `issues[${index}].created_at`),
    issueId: issueIdentity(row.id, `issues[${index}].id`),
  };
}

function sameBoundary(left, right) {
  return left !== null && right !== null
    && left.createdAt === right.createdAt
    && left.issueId === right.issueId;
}

function apiOptionsOf(value) {
  if (value === undefined) return {};
  plainObject(value, 'apiOptions');
  for (const key of Object.keys(value)) {
    if (!API_OPTION_KEYS.has(key)) fail(`apiOptions.${key} не разрешён reconciliation contract.`);
  }
  return { ...value };
}

function archiveOf(value) {
  plainObject(value, 'archive');
  if (typeof value.head !== 'function' || typeof value.append !== 'function') {
    fail('archive должен реализовывать head() и append().');
  }
  return value;
}

function duplicateAppend(result) {
  return result === false
    || result?.duplicate === true
    || result?.inserted === false
    || result?.appended === false
    || result?.status === 'duplicate';
}

function syntheticOpenedPayload({ owner, repo, repositoryId, issue }) {
  return {
    action: 'opened',
    repository: {
      id: repositoryId,
      full_name: `${owner}/${repo}`,
    },
    issue,
    sender: null,
  };
}

/**
 * Выполняет один bounded reconciliation run.
 *
 * Boundary принадлежит вызывающему durable state store. Результат никогда не
 * продвигает её, пока прежняя exact row не встретилась; уже append-нутые строки
 * при retry безопасно проходят semantic dedupe archive store.
 */
export async function run({
  token,
  owner,
  repo,
  repositoryId,
  accountRef,
  archive,
  boundary = null,
  maxPages = 5,
  maxRows = 500,
  apiOptions,
} = {}) {
  const trustedOwner = nonEmptyString(owner, 'owner');
  const trustedRepo = nonEmptyString(repo, 'repo');
  const trustedAccountRef = nonEmptyString(accountRef, 'accountRef');
  const trustedRepository = repositoryIdentity(repositoryId);
  const previousBoundary = boundaryOf(boundary);
  const pageLimit = positiveInt(maxPages, 'maxPages', MAX_PAGES_LIMIT);
  const rowLimit = positiveInt(maxRows, 'maxRows', MAX_ROWS_LIMIT);
  const providerOptions = apiOptionsOf(apiOptions);
  const targetArchive = archiveOf(archive);

  const archiveHeadBefore = await targetArchive.head();
  const initialBaseline = previousBoundary === null;
  const visitedPaths = new Set();

  let pages = 0;
  let rows = 0;
  let issues = 0;
  let pullRequests = 0;
  let appended = 0;
  let duplicates = 0;
  let candidateBoundary = null;
  let boundaryReached = false;
  let exhausted = false;
  let limitReached = false;
  let nextPath = null;
  let firstPage = true;

  while (pages < pageLimit && rows < rowLimit) {
    const pageOptions = firstPage
      ? { ...providerOptions, page: 1, perPage: Math.min(100, rowLimit) }
      : { ...providerOptions, nextPath };
    firstPage = false;

    const page = await listRepositoryIssuesPage(
      token,
      trustedOwner,
      trustedRepo,
      pageOptions,
    );
    pages += 1;

    let consumedPage = true;
    for (const [pageIndex, row] of page.issues.entries()) {
      if (rows >= rowLimit) {
        consumedPage = false;
        limitReached = true;
        break;
      }
      const position = positionOf(row, rows);
      rows += 1;
      if (candidateBoundary === null) candidateBoundary = position;

      if (Object.hasOwn(row, 'pull_request')) {
        pullRequests += 1;
      } else {
        issues += 1;
        const payload = syntheticOpenedPayload({
          owner: trustedOwner,
          repo: trustedRepo,
          repositoryId: trustedRepository.number,
          issue: row,
        });
        const message = normalizeOpenedIssue(payload, {
          accountRef: trustedAccountRef,
          expectedRepositoryId: trustedRepository.text,
        });
        const appendResult = await targetArchive.append({
          transport: {
            kind: 'rest',
            id: `rest:${trustedRepository.text}:${message.id}`,
          },
          repositoryId: trustedRepository.text,
          issueId: message.id,
          semanticKey: githubIssueSemanticKey(trustedRepository.text, message.id),
          occurredAt: message.occurredAt,
          snapshot: row,
        });
        if (duplicateAppend(appendResult)) duplicates += 1;
        else appended += 1;
      }

      if (sameBoundary(position, previousBoundary)) {
        boundaryReached = true;
        break;
      }

      // Номер нужен только в сообщениях ошибок positionOf; не даём линтеру и
      // читателю принять pageIndex за provider cursor.
      void pageIndex;
    }

    if (boundaryReached) break;
    nextPath = page.nextPath;
    if (!consumedPage) break;
    if (nextPath === null) {
      exhausted = true;
      break;
    }
    if (visitedPaths.has(nextPath)) {
      throw new GitHubReconcileError(
        'github_reconcile_link_cycle',
        'GitHub pagination Link зациклился.',
      );
    }
    visitedPaths.add(nextPath);
    if (pages >= pageLimit || rows >= rowLimit) {
      limitReached = true;
      break;
    }
  }

  if (!boundaryReached && !exhausted && (pages >= pageLimit || rows >= rowLimit)) {
    limitReached = true;
  }

  let degraded = null;
  let nextBoundary = previousBoundary;
  let baselineTruncated = false;
  if (initialBaseline) {
    nextBoundary = candidateBoundary;
    baselineTruncated = limitReached;
  } else if (boundaryReached) {
    nextBoundary = candidateBoundary || previousBoundary;
  } else if (limitReached) {
    degraded = 'reconcile_truncated';
  } else {
    degraded = 'reconcile_boundary_missing';
  }

  const archiveHead = await targetArchive.head();
  return {
    boundary: nextBoundary,
    advanced: !sameBoundary(nextBoundary, previousBoundary)
      && !(nextBoundary === null && previousBoundary === null),
    degraded,
    diagnostics: {
      initialBaseline,
      baselineTruncated,
      boundaryReached: initialBaseline ? null : boundaryReached,
      exhausted,
      limitReached,
      pages,
      rows,
      issues,
      pullRequests,
      appended,
      duplicates,
      archiveHeadBefore,
      archiveHead,
    },
  };
}

export const runGitHubReconciliation = run;
