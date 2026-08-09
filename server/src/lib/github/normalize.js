// GitHub Issues payload/REST row -> общий InboxMessage v1. Функция чистая и
// принимает trusted account/repository снаружи: provider payload их не назначает.

export class GitHubNormalizeError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'GitHubNormalizeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

function fail(code, message, extra = {}) {
  throw new GitHubNormalizeError(code, message, extra);
}

function trustedText(value, label) {
  if (typeof value !== 'string' || !value) fail('github_normalize_context', `${label} не задан.`);
  return value;
}

function expectedDecimal(value, label) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) fail('github_normalize_context', `${label} некорректен.`);
  return text;
}

function providerId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('github_payload_invalid', `${label} в GitHub payload некорректен.`);
  }
  return String(value);
}

function providerTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    fail('github_created_at_invalid', 'GitHub issue.created_at должен быть UTC timestamp точностью до секунды.');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) {
    fail('github_created_at_invalid', 'GitHub issue.created_at некорректен.');
  }
  return milliseconds / 1000;
}

function issueText(issue) {
  if (typeof issue.title !== 'string' || !issue.title) {
    fail('github_payload_invalid', 'В GitHub issue нет title.');
  }
  if (issue.body !== null && issue.body !== undefined && typeof issue.body !== 'string') {
    fail('github_payload_invalid', 'GitHub issue.body должен быть строкой или null.');
  }
  return typeof issue.body === 'string' && issue.body.length
    ? `${issue.title}\n\n${issue.body}`
    : issue.title;
}

function authorOf(issue) {
  const user = issue.user;
  if (user === null || user === undefined) return { id: null, name: '' };
  if (typeof user !== 'object' || Array.isArray(user)) {
    fail('github_payload_invalid', 'GitHub issue.user должен быть объектом или null.');
  }
  const id = user.id === null || user.id === undefined ? null : providerId(user.id, 'issue.user.id');
  if (typeof user.login !== 'string') fail('github_payload_invalid', 'GitHub issue.user.login некорректен.');
  return { id, name: user.login };
}

/**
 * Нормализует только событие `issues/opened`. Поля sender/updated_at намеренно
 * игнорируются: автор — `issue.user`, provider occurrence time — `created_at`.
 */
export function normalizeOpenedIssue(payload, { accountRef, expectedRepositoryId } = {}) {
  const trustedAccountRef = trustedText(accountRef, 'accountRef');
  const trustedRepositoryId = expectedDecimal(expectedRepositoryId, 'expectedRepositoryId');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('github_payload_invalid', 'GitHub payload должен быть объектом.');
  }
  if (payload.action !== 'opened') {
    fail('github_action_ignored', 'Нормализуются только GitHub issues/opened.', {
      action: payload.action ?? null,
    });
  }

  const repository = payload.repository;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    fail('github_payload_invalid', 'В GitHub payload нет repository.');
  }
  const repositoryId = providerId(repository.id, 'repository.id');
  if (repositoryId !== trustedRepositoryId) {
    fail('github_repository_mismatch', 'GitHub payload относится к другому repository.', {
      repositoryId,
    });
  }
  if (typeof repository.full_name !== 'string' || !repository.full_name) {
    fail('github_payload_invalid', 'В GitHub repository нет full_name.');
  }

  const issue = payload.issue;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    fail('github_payload_invalid', 'В GitHub payload нет issue.');
  }
  if (Object.hasOwn(issue, 'pull_request')) {
    fail('github_pull_request_ignored', 'Pull request не входит в канал GitHub Issues v1.');
  }
  const issueId = providerId(issue.id, 'issue.id');

  return {
    schema: 1,
    channel: 'github',
    accountRef: trustedAccountRef,
    source: {
      id: repositoryId,
      title: repository.full_name,
      threadId: issueId,
    },
    id: issueId,
    parentId: null,
    groupId: null,
    occurredAt: providerTime(issue.created_at),
    editedAt: null,
    author: authorOf(issue),
    text: issueText(issue),
    attachments: [],
    service: false,
  };
}
