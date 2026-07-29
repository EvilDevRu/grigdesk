// Read-only GitHub adapter для inbox ревью.
//
// Все сетевые обращения идут через инъецируемый runner. Production runner
// вызывает `gh api graphql` только через execFile: shell и интерполяция текста
// комментариев в командную строку не используются.
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createRemarkIdentity, createRemarkVersion, snapshotDigest } from './identity.js';

const execFileAsync = promisify(nodeExecFile);

const QUERIES = Object.freeze({
  OPEN_PULL_REQUESTS: `
    query OpenPullRequests($owner: String!, $name: String!, $first: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        id
        nameWithOwner
        pullRequests(states: OPEN, first: $first, after: $cursor, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            id number title url state updatedAt headRefOid headRefName
            headRepository { id nameWithOwner sshUrl }
            author { login }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
      rateLimit { remaining resetAt }
    }
  `,
  PULL_REQUEST_ANCHOR: `
    query PullRequestAnchor($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        id
        pullRequest(number: $number) {
          id number title url state updatedAt headRefOid headRefName
          headRepository { id nameWithOwner sshUrl }
          author { login }
        }
      }
      rateLimit { remaining resetAt }
    }
  `,
  PULL_REQUEST_REVIEWS: `
    query PullRequestReviews($owner: String!, $name: String!, $number: Int!, $first: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviews(first: $first, after: $cursor) {
            nodes { id body state submittedAt updatedAt url authorAssociation author { login } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      rateLimit { remaining resetAt }
    }
  `,
  PULL_REQUEST_ISSUE_COMMENTS: `
    query PullRequestIssueComments($owner: String!, $name: String!, $number: Int!, $first: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          comments(first: $first, after: $cursor) {
            nodes { id body createdAt updatedAt url authorAssociation author { login } }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      rateLimit { remaining resetAt }
    }
  `,
  PULL_REQUEST_THREADS: `
    query PullRequestThreads($owner: String!, $name: String!, $number: Int!, $first: Int!, $cursor: String) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          reviewThreads(first: $first, after: $cursor) {
            nodes {
              id isResolved isOutdated path line originalLine
              comments(first: $first) {
                nodes { id body createdAt updatedAt url authorAssociation author { login } isOutdated }
                pageInfo { hasNextPage endCursor }
              }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      rateLimit { remaining resetAt }
    }
  `,
  PULL_REQUEST_THREAD_COMMENTS: `
    query PullRequestThreadComments($threadNodeId: ID!, $first: Int!, $cursor: String) {
      node(id: $threadNodeId) {
        ... on PullRequestReviewThread {
          comments(first: $first, after: $cursor) {
            nodes { id body createdAt updatedAt url authorAssociation author { login } isOutdated }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
      rateLimit { remaining resetAt }
    }
  `,
});

export class GitHubReviewError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'GitHubReviewError';
    this.code = code;
    Object.assign(this, details);
  }
}

function commandValue(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function responseParts(stdout) {
  const source = String(stdout || '');
  let body = source;
  let headers = {};
  // При proxy/redirect gh может напечатать несколько HTTP-блоков. Берём
  // метаданные последнего ответа, JSON начинается после последнего блока.
  while (/^HTTP\/\S+\s+\d+/i.test(body)) {
    const separator = body.match(/\r?\n\r?\n/);
    if (!separator) return { body: source, headers: {} };
    const boundary = separator.index + separator[0].length;
    const headerText = body.slice(0, separator.index);
    const current = {};
    for (const line of headerText.split(/\r?\n/).slice(1)) {
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      current[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    headers = current;
    body = body.slice(boundary);
  }
  return { body, headers };
}

function rateMetadata(headers = {}) {
  const remaining = Number(headers['x-ratelimit-remaining']);
  const resetSeconds = Number(headers['x-ratelimit-reset']);
  const retrySeconds = Number(headers['retry-after']);
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    rateLimitResetAt: Number.isFinite(resetSeconds) && resetSeconds > 0
      ? resetSeconds * 1000
      : null,
    retryAfterMs: Number.isFinite(retrySeconds) && retrySeconds > 0
      ? retrySeconds * 1000
      : null,
  };
}

export function createGhRunner({
  execFileImpl = null,
  env = process.env,
  maxBuffer = 64 * 1024 * 1024,
  maxDiffBytes = 4 * 1024 * 1024,
  timeoutMs = 60_000,
} = {}) {
  const execute = execFileImpl
    ? (file, args, options) => Promise.resolve(execFileImpl(file, args, options))
    : (file, args, options) => execFileAsync(file, args, options);
  return Object.freeze({
    async runGraphQL({ query, variables = {} }) {
      const args = ['api', '--include', 'graphql', '-f', `query=${query}`];
      for (const [key, value] of Object.entries(variables)) {
        if (value == null) continue;
        // `--field` умеет @file и мог бы прочитать локальный файл из
        // пользовательского owner/name. Для строк нужен только raw-field.
        args.push(typeof value === 'string' ? '-f' : '-F', `${key}=${commandValue(value)}`);
      }
      let output;
      try {
        output = await execute('gh', args, {
          env: { ...env },
          encoding: 'utf8',
          maxBuffer,
          timeout: Math.max(1_000, Number(timeoutMs) || 60_000),
          killSignal: 'SIGKILL',
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        const { headers } = responseParts(error?.stdout);
        const rate = rateMetadata(headers);
        const rateLimited = rate.remaining === 0
          || rate.retryAfterMs > 0
          || /secondary rate limit|rate limit exceeded/i.test(String(error?.stderr || ''));
        throw new GitHubReviewError(
          rateLimited ? 'RATE_LIMITED' : 'GH_COMMAND_FAILED',
          'GitHub CLI не смог выполнить read-only запрос',
          {
            retryable: true,
            exitCode: Number.isInteger(error?.code) ? error.code : null,
            rateLimited,
            retryAfterMs: rate.retryAfterMs,
            rateLimitResetAt: rate.rateLimitResetAt,
          },
        );
      }
      try {
        const { body, headers } = responseParts(
          typeof output === 'string' ? output : output.stdout,
        );
        const payload = JSON.parse(body);
        payload._responseMeta = rateMetadata(headers);
        return payload;
      } catch {
        throw new GitHubReviewError('GH_INVALID_JSON', 'GitHub CLI вернул некорректный JSON');
      }
    },
    async runPullRequestDiff({ owner, name, number }) {
      const slug = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
      if (!slug.test(String(owner || ''))) throw new TypeError('Некорректный GitHub owner');
      if (!slug.test(String(name || ''))) throw new TypeError('Некорректное имя GitHub repository');
      if (!Number.isInteger(Number(number)) || Number(number) <= 0) {
        throw new TypeError('Некорректный номер PR');
      }
      let output;
      try {
        output = await execute('gh', [
          'api',
          '--include',
          `repos/${owner}/${name}/pulls/${Number(number)}`,
          '-H',
          'Accept: application/vnd.github.v3.diff',
        ], {
          env: { ...env },
          encoding: 'utf8',
          maxBuffer,
          timeout: Math.max(1_000, Number(timeoutMs) || 60_000),
          killSignal: 'SIGKILL',
          shell: false,
          windowsHide: true,
        });
      } catch (error) {
        const { headers } = responseParts(error?.stdout);
        const rate = rateMetadata(headers);
        const rateLimited = rate.remaining === 0
          || rate.retryAfterMs > 0
          || /secondary rate limit|rate limit exceeded/i.test(String(error?.stderr || ''));
        throw new GitHubReviewError(
          rateLimited ? 'RATE_LIMITED' : 'GH_DIFF_FAILED',
          'GitHub CLI не смог получить PR diff',
          {
            retryable: true,
            exitCode: Number.isInteger(error?.code) ? error.code : null,
            rateLimited,
            retryAfterMs: rate.retryAfterMs,
            rateLimitResetAt: rate.rateLimitResetAt,
          },
        );
      }
      const { body, headers } = responseParts(
        typeof output === 'string' ? output : output.stdout,
      );
      const rate = rateMetadata(headers);
      if (rate.remaining === 0) {
        throw new GitHubReviewError('RATE_LIMITED', 'Исчерпан GitHub API rate limit', {
          retryable: true,
          rateLimited: true,
          retryAfterMs: rate.retryAfterMs,
          rateLimitResetAt: rate.rateLimitResetAt,
        });
      }
      if (Buffer.byteLength(body, 'utf8') > Math.max(1, Number(maxDiffBytes) || 1)) {
        throw new GitHubReviewError(
          'SNAPSHOT_LIMIT_EXCEEDED',
          'PR diff превышает безопасный лимит; сохранена предыдущая версия',
          { retryable: false, limit: Math.max(1, Number(maxDiffBytes) || 1) },
        );
      }
      return body;
    },
  });
}

function connectionValue(value, name) {
  if (!value || !Array.isArray(value.nodes) || !value.pageInfo) {
    throw new GitHubReviewError('INVALID_GRAPHQL_SHAPE', `В ответе отсутствует connection ${name}`);
  }
  return value;
}

function normalizedAnchor(raw) {
  if (!raw?.id || !raw?.headRefOid || !raw?.updatedAt) {
    throw new GitHubReviewError('INVALID_GRAPHQL_SHAPE', 'GitHub не вернул якорь PR');
  }
  return {
    prNodeId: raw.id,
    number: raw.number,
    title: raw.title || '',
    url: raw.url || '',
    state: String(raw.state || '').toLowerCase(),
    updatedAt: new Date(raw.updatedAt).toISOString(),
    headSha: raw.headRefOid,
    headRefName: raw.headRefName || '',
    headRepositoryNodeId: raw.headRepository?.id || null,
    headRepositoryNameWithOwner: raw.headRepository?.nameWithOwner || null,
    headRepositoryUrl: raw.headRepository?.sshUrl || null,
    author: raw.author?.login || null,
  };
}

function anchorsEqual(left, right) {
  return left.prNodeId === right.prNodeId
    && left.headSha === right.headSha
    && left.updatedAt === right.updatedAt
    && left.state === right.state
    && left.headRefName === right.headRefName
    && left.headRepositoryNodeId === right.headRepositoryNodeId
    && left.headRepositoryUrl === right.headRepositoryUrl;
}

function dateOf(raw, fallback) {
  const source = raw?.updatedAt || raw?.submittedAt || raw?.createdAt || fallback;
  const timestamp = Date.parse(source);
  if (!Number.isFinite(timestamp)) {
    throw new GitHubReviewError('INVALID_GRAPHQL_SHAPE', 'У замечания нет корректного updatedAt');
  }
  return new Date(timestamp).toISOString();
}

function makeRemark({
  repoNodeId,
  pullRequest,
  kind,
  raw,
  thread = null,
  state = 'open',
}) {
  const identity = createRemarkIdentity({
    repoNodeId,
    prNodeId: pullRequest.prNodeId,
    kind,
    threadNodeId: thread?.id || null,
    commentNodeId: raw.id,
  });
  const body = typeof raw.body === 'string' ? raw.body : '';
  const updatedAt = dateOf(raw, pullRequest.updatedAt);
  const version = createRemarkVersion({
    ...identity,
    headSha: pullRequest.headSha,
    state,
    updatedAt,
    body,
  });
  return {
    ...identity,
    ...version,
    body,
    actionable: state === 'open',
    author: raw.author?.login || null,
    authorAssociation: String(raw.authorAssociation || 'UNKNOWN').toUpperCase(),
    url: raw.url || '',
    createdAt: raw.createdAt || raw.submittedAt || updatedAt,
    path: thread?.path || null,
    line: thread?.line ?? null,
    originalLine: thread?.originalLine ?? null,
    reviewState: raw.state ? String(raw.state).toLowerCase() : null,
  };
}

export class GitHubReviewAdapter {
  constructor({
    runner,
    pageSize = 50,
    consistencyRetries = 1,
    maxPullRequests = 200,
    maxConnectionNodes = 2_000,
    maxRemarksPerPull = 2_000,
    maxSnapshotBytes = 32 * 1024 * 1024,
    clock = Date.now,
    log = null,
  } = {}) {
    if (!runner?.runGraphQL) throw new TypeError('GitHubReviewAdapter требует runner.runGraphQL');
    this.runner = runner;
    this.pageSize = Math.min(100, Math.max(1, Number(pageSize) || 50));
    this.consistencyRetries = Math.max(0, Number(consistencyRetries) || 0);
    this.maxPullRequests = Math.max(1, Number(maxPullRequests) || 200);
    this.maxConnectionNodes = Math.max(1, Number(maxConnectionNodes) || 2_000);
    this.maxRemarksPerPull = Math.max(1, Number(maxRemarksPerPull) || 2_000);
    this.maxSnapshotBytes = Math.max(1024, Number(maxSnapshotBytes) || 32 * 1024 * 1024);
    this.clock = typeof clock === 'function' ? clock : () => clock.now();
    this.log = log;
  }

  async syncRepository({ owner, name, repoNodeId = null }) {
    if (!owner || !name) throw new TypeError('Нужны owner и name GitHub-репозитория');
    const rawPullRequests = [];
    let repository = null;
    let repositoryIdentity = null;
    const seenPullRequests = new Set();
    let cursor = null;
    do {
      const payload = await this.#call('OPEN_PULL_REQUESTS', {
        owner,
        name,
        first: this.pageSize,
        cursor,
      });
      repository = payload.data?.repository;
      if (!repository?.id || !repository.nameWithOwner) {
        throw new GitHubReviewError('REPOSITORY_NOT_FOUND', 'GitHub-репозиторий не найден');
      }
      if (!repositoryIdentity) {
        repositoryIdentity = {
          id: repository.id,
          nameWithOwner: repository.nameWithOwner,
        };
      } else if (
        repositoryIdentity.id !== repository.id
        || repositoryIdentity.nameWithOwner !== repository.nameWithOwner
      ) {
        throw new GitHubReviewError(
          'REPOSITORY_CHANGED_DURING_SYNC',
          'GitHub сменил repository identity во время pagination',
          { retryable: true },
        );
      }
      if (repoNodeId && repoNodeId !== repository.id) {
        throw new GitHubReviewError('REPOSITORY_ID_MISMATCH', 'GitHub repository node ID изменился');
      }
      const connection = connectionValue(repository.pullRequests, 'pullRequests');
      for (const pullRequest of connection.nodes) {
        if (!pullRequest?.id || seenPullRequests.has(pullRequest.id)) {
          throw new GitHubReviewError(
            'DUPLICATE_GRAPHQL_NODE',
            'GitHub pagination вернула повторный или пустой PR node ID',
            { retryable: true },
          );
        }
        seenPullRequests.add(pullRequest.id);
        rawPullRequests.push(pullRequest);
        if (rawPullRequests.length > this.maxPullRequests) {
          throw new GitHubReviewError(
            'SNAPSHOT_LIMIT_EXCEEDED',
            'Слишком много открытых PR для одного безопасного снимка',
            { retryable: false, limit: this.maxPullRequests },
          );
        }
      }
      cursor = this.#nextCursor(connection.pageInfo, cursor, 'pullRequests');
    } while (cursor);

    const pullRequests = [];
    for (const raw of rawPullRequests) {
      pullRequests.push(await this.#consistentPullRequest({
        owner,
        name,
        repoNodeId: repository.id,
        raw,
      }));
    }
    pullRequests.sort((left, right) => left.number - right.number);
    const snapshot = {
      schemaVersion: 1,
      repoNodeId: repositoryIdentity.id,
      nameWithOwner: repositoryIdentity.nameWithOwner,
      syncedAt: new Date(this.clock()).toISOString(),
      pullRequests,
    };
    if (Buffer.byteLength(JSON.stringify(snapshot), 'utf8') > this.maxSnapshotBytes) {
      throw new GitHubReviewError(
        'SNAPSHOT_LIMIT_EXCEEDED',
        'Полный снимок GitHub превышает безопасный лимит; сохранена предыдущая версия',
        { retryable: false, limit: this.maxSnapshotBytes },
      );
    }
    snapshot.digest = snapshotDigest(snapshot);
    return snapshot;
  }

  async #consistentPullRequest(context) {
    let lastBefore = null;
    let lastAfter = null;
    for (let attempt = 0; attempt <= this.consistencyRetries; attempt += 1) {
      const before = await this.#anchor(context.owner, context.name, context.raw);
      lastBefore = before;
      const diff = this.runner.runPullRequestDiff
        ? await this.runner.runPullRequestDiff({
          owner: context.owner,
          name: context.name,
          number: before.number,
        })
        : '';
      const remarks = await this.#remarks({ ...context, pullRequest: before });
      const after = await this.#anchor(context.owner, context.name, context.raw);
      lastAfter = after;
      if (anchorsEqual(before, after)) return { ...after, diff, remarks };
      this.log?.warn?.({
        repoNodeId: context.repoNodeId,
        prNodeId: before.prNodeId,
        code: 'PR_CHANGED_DURING_SYNC',
        attempt: attempt + 1,
      }, 'PR изменился во время синхронизации, снимок отброшен');
    }
    throw new GitHubReviewError('PR_CHANGED_DURING_SYNC', 'PR изменился во время pagination', {
      retryable: true,
      prNodeId: lastAfter?.prNodeId || lastBefore?.prNodeId || context.raw?.id,
    });
  }

  async #anchor(owner, name, raw) {
    const payload = await this.#call('PULL_REQUEST_ANCHOR', {
      owner,
      name,
      number: raw.number,
      prNodeId: raw.id,
    });
    const repository = payload.data?.repository;
    if (!repository?.pullRequest) {
      throw new GitHubReviewError('PR_NOT_OPEN', 'PR закрыт или недоступен во время синхронизации');
    }
    return normalizedAnchor(repository.pullRequest);
  }

  async #remarks({ owner, name, repoNodeId, pullRequest }) {
    const common = {
      owner,
      name,
      number: pullRequest.number,
      prNodeId: pullRequest.prNodeId,
      first: this.pageSize,
    };
    const reviews = await this.#allPages(
      'PULL_REQUEST_REVIEWS',
      common,
      (payload) => payload.data?.repository?.pullRequest?.reviews,
    );
    const issueComments = await this.#allPages(
      'PULL_REQUEST_ISSUE_COMMENTS',
      common,
      (payload) => payload.data?.repository?.pullRequest?.comments,
    );
    const threads = await this.#allPages(
      'PULL_REQUEST_THREADS',
      common,
      (payload) => payload.data?.repository?.pullRequest?.reviewThreads,
    );

    const remarks = [];
    let remarkCount = reviews.filter((review) => review?.id && review.body).length
      + issueComments.filter((comment) => comment?.id).length;
    if (remarkCount > this.maxRemarksPerPull) {
      throw new GitHubReviewError(
        'SNAPSHOT_LIMIT_EXCEEDED',
        'Слишком много замечаний в одном PR; сохранена предыдущая полная версия',
        { retryable: false, limit: this.maxRemarksPerPull },
      );
    }
    for (const review of reviews) {
      if (!review?.id || !review.body) continue;
      const reviewState = String(review.state || '').toUpperCase();
      remarks.push(makeRemark({
        repoNodeId,
        pullRequest,
        kind: 'review_body',
        raw: review,
        state: reviewState === 'DISMISSED' ? 'closed' : 'open',
      }));
    }
    for (const comment of issueComments) {
      if (!comment?.id) continue;
      remarks.push(makeRemark({
        repoNodeId,
        pullRequest,
        kind: 'issue_comment',
        raw: comment,
      }));
    }
    for (const thread of threads) {
      if (!thread?.id) continue;
      const firstPage = connectionValue(thread.comments, `comments:${thread.id}`);
      const comments = [...firstPage.nodes];
      if (
        comments.length > this.maxConnectionNodes
        || remarkCount + comments.length > this.maxRemarksPerPull
      ) {
        throw new GitHubReviewError(
          'SNAPSHOT_LIMIT_EXCEEDED',
          'Слишком много комментариев в review threads',
          { retryable: false, limit: this.maxRemarksPerPull },
        );
      }
      let cursor = this.#nextCursor(firstPage.pageInfo, null, `comments:${thread.id}`);
      while (cursor) {
        const payload = await this.#call('PULL_REQUEST_THREAD_COMMENTS', {
          threadNodeId: thread.id,
          first: this.pageSize,
          cursor,
        });
        const connection = connectionValue(payload.data?.node?.comments, `comments:${thread.id}`);
        if (
          comments.length + connection.nodes.length > this.maxConnectionNodes
          || remarkCount + comments.length + connection.nodes.length > this.maxRemarksPerPull
        ) {
          throw new GitHubReviewError(
            'SNAPSHOT_LIMIT_EXCEEDED',
            'Слишком много комментариев в review threads',
            { retryable: false, limit: this.maxRemarksPerPull },
          );
        }
        comments.push(...connection.nodes);
        cursor = this.#nextCursor(connection.pageInfo, cursor, `comments:${thread.id}`);
      }
      remarkCount += comments.length;
      for (const comment of comments) {
        if (!comment?.id) continue;
        const state = thread.isResolved
          ? 'resolved'
          : (thread.isOutdated || comment.isOutdated ? 'outdated' : 'open');
        remarks.push(makeRemark({
          repoNodeId,
          pullRequest,
          kind: 'thread_comment',
          raw: comment,
          thread,
          state,
        }));
      }
    }
    const seen = new Set();
    for (const remark of remarks) {
      if (seen.has(remark.key)) {
        throw new GitHubReviewError(
          'DUPLICATE_GRAPHQL_NODE',
          'GitHub pagination вернула повторный comment node ID',
          { retryable: true },
        );
      }
      seen.add(remark.key);
    }
    if (remarks.length > this.maxRemarksPerPull) {
      throw new GitHubReviewError(
        'SNAPSHOT_LIMIT_EXCEEDED',
        'Слишком много замечаний в одном PR; сохранена предыдущая полная версия',
        { retryable: false, limit: this.maxRemarksPerPull },
      );
    }
    return remarks;
  }

  async #allPages(operation, variables, select) {
    const nodes = [];
    let nestedComments = 0;
    let cursor = null;
    do {
      const payload = await this.#call(operation, { ...variables, cursor });
      const connection = connectionValue(select(payload), operation);
      if (operation === 'PULL_REQUEST_THREADS') {
        for (const thread of connection.nodes) {
          const nested = connectionValue(thread?.comments, `comments:${thread?.id || '?'}`);
          nestedComments += nested.nodes.length;
        }
        if (nestedComments > this.maxRemarksPerPull) {
          throw new GitHubReviewError(
            'SNAPSHOT_LIMIT_EXCEEDED',
            'Начальные страницы review threads превышают безопасный лимит',
            { retryable: false, limit: this.maxRemarksPerPull },
          );
        }
      }
      nodes.push(...connection.nodes);
      if (nodes.length > this.maxConnectionNodes) {
        throw new GitHubReviewError(
          'SNAPSHOT_LIMIT_EXCEEDED',
          `GitHub connection ${operation} превышает безопасный лимит`,
          { retryable: false, limit: this.maxConnectionNodes },
        );
      }
      cursor = this.#nextCursor(connection.pageInfo, cursor, operation);
    } while (cursor);
    return nodes;
  }

  #nextCursor(pageInfo, previous, operation) {
    if (!pageInfo?.hasNextPage) return null;
    if (!pageInfo.endCursor || pageInfo.endCursor === previous) {
      throw new GitHubReviewError(
        'INVALID_PAGINATION_CURSOR',
        `GitHub вернул зацикленный cursor для ${operation}`,
      );
    }
    return pageInfo.endCursor;
  }

  async #call(operation, variables) {
    let payload;
    try {
      payload = await this.runner.runGraphQL({
        operation,
        query: QUERIES[operation],
        variables,
      });
    } catch (error) {
      if (error instanceof GitHubReviewError) throw error;
      throw new GitHubReviewError(
        error?.code || 'GITHUB_REQUEST_FAILED',
        'Не удалось получить данные GitHub',
        {
          retryable: error?.retryable !== false,
          retryAfterMs: error?.retryAfterMs,
          rateLimitResetAt: error?.rateLimitResetAt,
        },
      );
    }
    if (!payload || typeof payload !== 'object') {
      throw new GitHubReviewError('INVALID_GRAPHQL_SHAPE', 'GitHub вернул пустой ответ');
    }
    if (Array.isArray(payload.errors) && payload.errors.length) {
      const graphRate = payload.data?.rateLimit;
      const headerRate = payload._responseMeta || {};
      const rateLimited = payload.errors.some((error) => (
        ['RATE_LIMITED', 'RATE_LIMITED_SECONDARY'].includes(error?.type)
      )) || Number(graphRate?.remaining) === 0 || headerRate.remaining === 0;
      throw new GitHubReviewError(
        'PARTIAL_GRAPHQL_ERRORS',
        'GitHub вернул частичные GraphQL errors; снимок не применён',
        {
          retryable: true,
          rateLimited,
          rateLimitResetAt: graphRate?.resetAt || headerRate.rateLimitResetAt || null,
          retryAfterMs: headerRate.retryAfterMs || null,
        },
      );
    }
    const graphRate = payload.data?.rateLimit;
    const headerRate = payload._responseMeta || {};
    const remaining = Number.isFinite(Number(graphRate?.remaining))
      ? Number(graphRate.remaining)
      : headerRate.remaining;
    if (remaining === 0) {
      throw new GitHubReviewError('RATE_LIMITED', 'Исчерпан GitHub API rate limit', {
        retryable: true,
        rateLimited: true,
        rateLimitResetAt: graphRate?.resetAt || headerRate.rateLimitResetAt || null,
        retryAfterMs: headerRate.retryAfterMs || null,
      });
    }
    return payload;
  }
}
