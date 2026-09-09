// GitHub Issues payload/REST row -> общий InboxMessage v1. Функция чистая и
// принимает trusted account/repository снаружи: provider payload их не назначает.

export class GitHubNormalizeError extends Error {
  code: string;

  constructor(code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'GitHubNormalizeError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// Автор обращения. GitHub разрешает удалённого пользователя, и тогда остаётся
// только пустое имя: подставлять сюда отправителя события нельзя — это разные люди.
export interface InboxAuthor {
  id: string | null;
  name: string;
}

// Общее сообщение Inbox v1, каким его видит канал GitHub.
export interface InboxMessage {
  schema: 1;
  channel: 'github';
  accountRef: string;
  source: {
    id: string;
    title: string;
    threadId: string;
  };
  id: string;
  parentId: string | null;
  groupId: string | null;
  occurredAt: number;
  editedAt: number | null;
  author: InboxAuthor;
  text: string;
  attachments: never[];
  service: boolean;
}

export interface NormalizeContext {
  accountRef?: unknown;
  expectedRepositoryId?: unknown;
}

type Payload = Record<string, unknown>;

function fail(code: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new GitHubNormalizeError(code, message, extra);
}

function trustedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) fail('github_normalize_context', `${label} не задан.`);
  return value;
}

function expectedDecimal(value: unknown, label: string): string {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/u.test(text)) fail('github_normalize_context', `${label} некорректен.`);
  return text;
}

function providerId(value: unknown, label: string): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    fail('github_payload_invalid', `${label} в GitHub payload некорректен.`);
  }
  return String(value);
}

function providerTime(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    fail('github_created_at_invalid', 'GitHub issue.created_at должен быть UTC timestamp точностью до секунды.');
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value.replace('Z', '.000Z')) {
    fail('github_created_at_invalid', 'GitHub issue.created_at некорректен.');
  }
  return milliseconds / 1000;
}

function issueText(issue: Payload): string {
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

function authorOf(issue: Payload): InboxAuthor {
  const raw = issue.user;
  if (raw === null || raw === undefined) return { id: null, name: '' };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('github_payload_invalid', 'GitHub issue.user должен быть объектом или null.');
  }
  const user = raw as Payload;
  const id = user.id === null || user.id === undefined ? null : providerId(user.id, 'issue.user.id');
  if (typeof user.login !== 'string') fail('github_payload_invalid', 'GitHub issue.user.login некорректен.');
  return { id, name: user.login };
}

/**
 * Нормализует только событие `issues/opened`. Поля sender/updated_at намеренно
 * игнорируются: автор — `issue.user`, provider occurrence time — `created_at`.
 */
export function normalizeOpenedIssue(
  payload: unknown,
  { accountRef, expectedRepositoryId }: NormalizeContext = {},
): InboxMessage {
  const trustedAccountRef = trustedText(accountRef, 'accountRef');
  const trustedRepositoryId = expectedDecimal(expectedRepositoryId, 'expectedRepositoryId');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('github_payload_invalid', 'GitHub payload должен быть объектом.');
  }
  if ((payload as Payload).action !== 'opened') {
    fail('github_action_ignored', 'Нормализуются только GitHub issues/opened.', {
      action: (payload as Payload).action ?? null,
    });
  }

  const body = payload as Payload;
  const repository = body.repository as Payload | undefined;
  if (!repository || typeof repository !== 'object' || Array.isArray(repository)) {
    fail('github_payload_invalid', 'В GitHub payload нет repository.');
  }
  const repositoryFacts = repository as Payload;
  const repositoryId = providerId(repositoryFacts.id, 'repository.id');
  if (repositoryId !== trustedRepositoryId) {
    fail('github_repository_mismatch', 'GitHub payload относится к другому repository.', {
      repositoryId,
    });
  }
  if (typeof repositoryFacts.full_name !== 'string' || !repositoryFacts.full_name) {
    fail('github_payload_invalid', 'В GitHub repository нет full_name.');
  }

  const issue = body.issue as Payload | undefined;
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) {
    fail('github_payload_invalid', 'В GitHub payload нет issue.');
  }
  if (Object.hasOwn(issue as Payload, 'pull_request')) {
    fail('github_pull_request_ignored', 'Pull request не входит в канал GitHub Issues v1.');
  }
  const openedIssue = issue as Payload;
  const issueId = providerId(openedIssue.id, 'issue.id');

  return {
    schema: 1,
    channel: 'github',
    accountRef: trustedAccountRef,
    source: {
      id: repositoryId,
      title: repositoryFacts.full_name,
      threadId: issueId,
    },
    id: issueId,
    parentId: null,
    groupId: null,
    occurredAt: providerTime(openedIssue.created_at),
    editedAt: null,
    author: authorOf(openedIssue),
    text: issueText(openedIssue),
    attachments: [],
    service: false,
  };
}
