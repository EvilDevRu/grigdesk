import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createGhRunner,
  GitHubReviewAdapter,
  GitHubReviewError,
} from '../../server/src/lib/reviews/github.js';

const SHA = 'a'.repeat(40);
const LONG_BODY = `Начало\n${'очень длинный текст '.repeat(2000)}\nКонец`;

function connection(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function pullRequest(id, number) {
  return {
    id,
    number,
    title: `PR ${number}`,
    url: `https://github.invalid/example/repo/pull/${number}`,
    state: 'OPEN',
    updatedAt: '2026-07-29T10:00:00.000Z',
    headRefOid: SHA,
    headRefName: `feature-${number}`,
    headRepository: {
      id: 'R_head',
      nameWithOwner: 'example/repo',
      sshUrl: 'git@github.com:example/repo.git',
    },
    author: { login: 'developer' },
  };
}

function fakeRunner(handler) {
  const calls = [];
  return {
    calls,
    async runGraphQL(request) {
      calls.push(structuredClone(request));
      return handler(request, calls);
    },
  };
}

test('SYNC-01: adapter дочитывает все страницы и все виды замечаний без обрезания', async () => {
  const runner = fakeRunner(({ operation, variables }) => {
    if (operation === 'OPEN_PULL_REQUESTS') {
      const nodes = variables.cursor ? [pullRequest('PR_2', 2)] : [pullRequest('PR_1', 1)];
      return { data: { repository: {
        id: 'R_repo',
        nameWithOwner: 'example/repo',
        pullRequests: connection(nodes, variables.cursor
          ? {}
          : { hasNextPage: true, endCursor: 'prs-page-2' }),
      } } };
    }
    if (operation === 'PULL_REQUEST_ANCHOR') {
      return { data: { repository: {
        id: 'R_repo',
        pullRequest: pullRequest(variables.prNodeId, variables.prNodeId === 'PR_1' ? 1 : 2),
      } } };
    }
    if (operation === 'PULL_REQUEST_REVIEWS') {
      const reviews = variables.prNodeId === 'PR_1' && !variables.cursor
        ? [{
          id: 'RV_1',
          body: LONG_BODY,
          state: 'CHANGES_REQUESTED',
          submittedAt: '2026-07-29T09:00:00.000Z',
          updatedAt: '2026-07-29T09:01:00.000Z',
          url: 'https://github.invalid/review/1',
          authorAssociation: 'MEMBER',
          author: { login: 'reviewer' },
        }]
        : variables.prNodeId === 'PR_1'
          ? [{
            id: 'RV_2',
            body: 'Второй review body',
            state: 'COMMENTED',
            submittedAt: '2026-07-29T09:02:00.000Z',
            updatedAt: '2026-07-29T09:02:00.000Z',
            url: 'https://github.invalid/review/2',
            author: { login: 'reviewer' },
          }]
          : [];
      return { data: { repository: { pullRequest: {
        reviews: connection(reviews, variables.prNodeId === 'PR_1' && !variables.cursor
          ? { hasNextPage: true, endCursor: 'review-page-2' }
          : {}),
      } } } };
    }
    if (operation === 'PULL_REQUEST_ISSUE_COMMENTS') {
      return { data: { repository: { pullRequest: {
        comments: connection(variables.prNodeId === 'PR_1' ? [{
          id: 'IC_1',
          body: 'Обычный комментарий к PR',
          createdAt: '2026-07-29T09:03:00.000Z',
          updatedAt: '2026-07-29T09:03:00.000Z',
          url: 'https://github.invalid/issue-comment/1',
          author: { login: 'reviewer' },
        }] : []),
      } } } };
    }
    if (operation === 'PULL_REQUEST_THREADS') {
      return { data: { repository: { pullRequest: {
        reviewThreads: connection(variables.prNodeId === 'PR_1' ? [{
          id: 'T_1',
          isResolved: false,
          isOutdated: false,
          path: 'src/file.js',
          line: 12,
          originalLine: 11,
          comments: connection([{
            id: 'TC_1',
            body: 'Первый inline',
            createdAt: '2026-07-29T09:04:00.000Z',
            updatedAt: '2026-07-29T09:04:00.000Z',
            url: 'https://github.invalid/thread-comment/1',
            author: { login: 'reviewer' },
            isOutdated: false,
          }], { hasNextPage: true, endCursor: 'thread-comments-2' }),
        }] : []),
      } } } };
    }
    if (operation === 'PULL_REQUEST_THREAD_COMMENTS') {
      return { data: { node: { comments: connection([{
        id: 'TC_2',
        body: 'Ответ в inline thread',
        createdAt: '2026-07-29T09:05:00.000Z',
        updatedAt: '2026-07-29T09:05:00.000Z',
        url: 'https://github.invalid/thread-comment/2',
        author: { login: 'developer' },
        isOutdated: false,
      }]) } } };
    }
    throw new Error(`Неизвестная операция ${operation}`);
  });
  runner.runPullRequestDiff = async ({ owner, name, number }) => (
    `diff --git a/pr-${owner}-${name}-${number} b/file.js`
  );
  const adapter = new GitHubReviewAdapter({ runner, pageSize: 1 });
  const snapshot = await adapter.syncRepository({ owner: 'example', name: 'repo' });

  assert.equal(snapshot.pullRequests.length, 2);
  const remarks = snapshot.pullRequests[0].remarks;
  assert.deepEqual(remarks.map((item) => item.kind), [
    'review_body',
    'review_body',
    'issue_comment',
    'thread_comment',
    'thread_comment',
  ]);
  assert.equal(remarks[0].body, LONG_BODY);
  assert.equal(remarks[0].authorAssociation, 'MEMBER');
  assert.equal(remarks[1].authorAssociation, 'UNKNOWN');
  assert.equal(remarks[4].threadNodeId, 'T_1');
  assert.equal(snapshot.pullRequests[0].headRepositoryUrl, 'git@github.com:example/repo.git');
  assert.match(snapshot.pullRequests[0].diff, /diff --git/);
  assert.equal(runner.calls.filter((call) => call.operation === 'OPEN_PULL_REQUESTS').length, 2);
  assert.equal(runner.calls.filter((call) => call.operation === 'PULL_REQUEST_REVIEWS').length, 3);
});

test('SEC-AUTO-05: oversized GitHub pagination отбрасывается целиком', async () => {
  const runner = fakeRunner(({ operation }) => {
    if (operation !== 'OPEN_PULL_REQUESTS') throw new Error('До PR details доходить нельзя');
    return { data: { repository: {
      id: 'R_repo',
      nameWithOwner: 'example/repo',
      pullRequests: connection([
        pullRequest('PR_1', 1),
        pullRequest('PR_2', 2),
      ]),
    } } };
  });
  const adapter = new GitHubReviewAdapter({ runner, maxPullRequests: 1 });
  await assert.rejects(
    adapter.syncRepository({ owner: 'example', name: 'repo' }),
    (error) => (
      error instanceof GitHubReviewError
      && error.code === 'SNAPSHOT_LIMIT_EXCEEDED'
      && error.retryable === false
    ),
  );
  assert.equal(runner.calls.length, 1);
});

test('SYNC-02: resolved/outdated сохраняются, но нормализуются как неактивные', async () => {
  const runner = fakeRunner(({ operation, variables }) => {
    if (operation === 'OPEN_PULL_REQUESTS') {
      return { data: { repository: {
        id: 'R_repo', nameWithOwner: 'example/repo',
        pullRequests: connection([pullRequest('PR_1', 1)]),
      } } };
    }
    if (operation === 'PULL_REQUEST_ANCHOR') {
      return { data: { repository: { id: 'R_repo', pullRequest: pullRequest('PR_1', 1) } } };
    }
    if (operation === 'PULL_REQUEST_REVIEWS') {
      return { data: { repository: { pullRequest: { reviews: connection([]) } } } };
    }
    if (operation === 'PULL_REQUEST_ISSUE_COMMENTS') {
      return { data: { repository: { pullRequest: { comments: connection([]) } } } };
    }
    if (operation === 'PULL_REQUEST_THREADS') {
      return { data: { repository: { pullRequest: { reviewThreads: connection([{
        id: 'T_resolved',
        isResolved: true,
        isOutdated: false,
        path: 'src/a.js',
        line: 1,
        comments: connection([{
          id: 'C_resolved', body: 'Готово', updatedAt: '2026-07-29T09:00:00.000Z',
        }]),
      }, {
        id: 'T_outdated',
        isResolved: false,
        isOutdated: true,
        path: 'src/b.js',
        line: null,
        comments: connection([{
          id: 'C_outdated', body: 'Старая строка', updatedAt: '2026-07-29T09:00:00.000Z',
        }]),
      }]) } } } };
    }
    if (operation === 'PULL_REQUEST_THREAD_COMMENTS') throw new Error('Нет следующей страницы');
    throw new Error(`Неизвестная операция ${operation} ${variables.cursor}`);
  });

  const snapshot = await new GitHubReviewAdapter({ runner }).syncRepository({
    owner: 'example',
    name: 'repo',
  });
  assert.deepEqual(snapshot.pullRequests[0].remarks.map((item) => item.state), [
    'resolved',
    'outdated',
  ]);
  assert.equal(snapshot.pullRequests[0].remarks.some((item) => item.actionable), false);
});

test('SYNC-08: изменение head SHA между страницами отбрасывает кандидата и повторяет PR', async () => {
  let anchorCalls = 0;
  const changed = 'b'.repeat(40);
  const runner = fakeRunner(({ operation }) => {
    if (operation === 'OPEN_PULL_REQUESTS') {
      return { data: { repository: {
        id: 'R_repo', nameWithOwner: 'example/repo',
        pullRequests: connection([pullRequest('PR_1', 1)]),
      } } };
    }
    if (operation === 'PULL_REQUEST_ANCHOR') {
      anchorCalls += 1;
      const pr = pullRequest('PR_1', 1);
      // Первая попытка: before=a, after=b. Вторая: before/after=b.
      if (anchorCalls >= 2) pr.headRefOid = changed;
      return { data: { repository: { id: 'R_repo', pullRequest: pr } } };
    }
    if (operation === 'PULL_REQUEST_REVIEWS') {
      return { data: { repository: { pullRequest: { reviews: connection([]) } } } };
    }
    if (operation === 'PULL_REQUEST_ISSUE_COMMENTS') {
      return { data: { repository: { pullRequest: { comments: connection([]) } } } };
    }
    if (operation === 'PULL_REQUEST_THREADS') {
      return { data: { repository: { pullRequest: { reviewThreads: connection([]) } } } };
    }
    throw new Error(`Неизвестная операция ${operation}`);
  });
  const snapshot = await new GitHubReviewAdapter({
    runner,
    consistencyRetries: 1,
  }).syncRepository({ owner: 'example', name: 'repo' });

  assert.equal(snapshot.pullRequests[0].headSha, changed);
  assert.equal(anchorCalls, 4);
});

test('SYNC-09: partial GraphQL errors отклоняются вместе с data', async () => {
  const runner = fakeRunner(() => ({
    data: { repository: { id: 'R_repo', pullRequests: connection([]) } },
    errors: [{ type: 'FORBIDDEN', message: 'Часть данных недоступна' }],
  }));

  await assert.rejects(
    new GitHubReviewAdapter({ runner }).syncRepository({ owner: 'example', name: 'repo' }),
    (error) => error instanceof GitHubReviewError && error.code === 'PARTIAL_GRAPHQL_ERRORS',
  );
});

test('WATCH-RATE-02: GraphQL rateLimit=0 передаёт точный resetAt watcher-у', async () => {
  const resetAt = '2026-07-29T10:15:00.000Z';
  const runner = fakeRunner(() => ({
    data: {
      repository: {
        id: 'R_repo',
        nameWithOwner: 'example/repo',
        pullRequests: connection([]),
      },
      rateLimit: { remaining: 0, resetAt },
    },
  }));

  await assert.rejects(
    new GitHubReviewAdapter({ runner }).syncRepository({ owner: 'example', name: 'repo' }),
    (error) => (
      error.code === 'RATE_LIMITED'
      && error.rateLimitResetAt === resetAt
      && error.rateLimited === true
    ),
  );
});

test('production gh runner использует execFile без shell и не помещает токен в аргументы', async () => {
  let invocation;
  const runner = createGhRunner({
    env: { PATH: '/usr/bin', GH_TOKEN: 'secret-must-stay-in-env' },
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: '{"data":{"viewer":{"login":"fixture"}}}', stderr: '' };
    },
  });
  const result = await runner.runGraphQL({
    operation: 'Viewer',
    query: 'query Viewer { viewer { login } }',
    variables: {},
  });

  assert.equal(result.data.viewer.login, 'fixture');
  assert.equal(invocation.file, 'gh');
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.args.includes('secret-must-stay-in-env'), false);
  assert.equal(invocation.options.env.GH_TOKEN, 'secret-must-stay-in-env');
});

test('ANALYZE-01: production runner получает полный PR diff безопасным execFile', async () => {
  let invocation;
  const runner = createGhRunner({
    execFileImpl: async (file, args, options) => {
      invocation = { file, args, options };
      return { stdout: 'diff --git a/a.js b/a.js\n+fixture\n', stderr: '' };
    },
  });
  const diff = await runner.runPullRequestDiff({
    owner: 'example',
    name: 'repo',
    number: 7,
  });

  assert.match(diff, /fixture/);
  assert.equal(invocation.file, 'gh');
  assert.deepEqual(invocation.args.slice(0, 3), [
    'api',
    '--include',
    'repos/example/repo/pulls/7',
  ]);
  assert.equal(invocation.options.shell, false);
  await assert.rejects(
    runner.runPullRequestDiff({ owner: '--hostname', name: 'repo', number: 7 }),
    /owner/,
  );
});

test('WATCH-RATE-02: production runner извлекает Retry-After и reset из headers без утечки body', async () => {
  const runner = createGhRunner({
    execFileImpl: async () => {
      const error = new Error('command failed');
      error.code = 1;
      error.stdout = [
        'HTTP/2.0 403 Forbidden',
        'retry-after: 90',
        'x-ratelimit-remaining: 0',
        'x-ratelimit-reset: 1785320100',
        '',
        '{"message":"private response must not leak"}',
      ].join('\n');
      error.stderr = 'secondary rate limit';
      throw error;
    },
  });

  await assert.rejects(
    runner.runGraphQL({ operation: 'Fixture', query: 'query { viewer { login } }' }),
    (error) => (
      error.code === 'RATE_LIMITED'
      && error.retryAfterMs === 90_000
      && error.rateLimitResetAt === 1_785_320_100_000
      && !error.message.includes('private response')
    ),
  );
});

test('WATCH-RATE-02: PR diff передаёт тот же exact cooldown вместо GH_DIFF_FAILED', async () => {
  const runner = createGhRunner({
    execFileImpl: async () => {
      const error = new Error('command failed');
      error.code = 1;
      error.stdout = [
        'HTTP/2.0 403 Forbidden',
        'retry-after: 45',
        'x-ratelimit-reset: 1785320100',
        '',
        '{"message":"rate limited"}',
      ].join('\n');
      error.stderr = 'secondary rate limit';
      throw error;
    },
  });

  await assert.rejects(
    runner.runPullRequestDiff({ owner: 'example', name: 'repo', number: 7 }),
    (error) => (
      error.code === 'RATE_LIMITED'
      && error.retryAfterMs === 45_000
      && error.rateLimitResetAt === 1_785_320_100_000
    ),
  );
});
